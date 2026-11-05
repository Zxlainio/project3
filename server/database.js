import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function toJson(value) {
  return JSON.stringify(value);
}

function fromJson(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class HistoryDatabase {
  constructor(databasePath, { now = () => new Date() } = {}) {
    this.databasePath = databasePath;
    this.now = now;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.createSchema();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        target_quantity INTEGER,
        actual_quantity INTEGER NOT NULL DEFAULT 0,
        bad_quantity INTEGER,
        status TEXT NOT NULL CHECK (status IN ('生产中', '已完成')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hourly_production (
        local_date TEXT NOT NULL,
        local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
        output_quantity INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (local_date, local_hour)
      );

      CREATE TABLE IF NOT EXISTS speed_samples (
        minute_bucket TEXT PRIMARY KEY,
        sampled_at TEXT NOT NULL,
        speed INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alarm_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        triggered_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        station TEXT,
        content TEXT,
        plc_address TEXT NOT NULL,
        trigger_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_batches_started_at ON batches(started_at);
      CREATE INDEX IF NOT EXISTS idx_hourly_date ON hourly_production(local_date);
      CREATE INDEX IF NOT EXISTS idx_speed_sampled_at ON speed_samples(sampled_at);
      CREATE INDEX IF NOT EXISTS idx_alarm_date ON alarm_events(local_date);
      CREATE INDEX IF NOT EXISTS idx_alarm_code ON alarm_events(code);
    `);
  }

  timestamp(date = this.now()) {
    return new Date(date).toISOString();
  }

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return row?.value ?? fallback;
  }

  setMeta(key, value, timestamp = this.timestamp()) {
    this.db.prepare(`
      INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, timestamp);
  }

  getJsonMeta(key, fallback) {
    return fromJson(this.getMeta(key), fallback);
  }

  setJsonMeta(key, value, timestamp = this.timestamp()) {
    this.setMeta(key, toJson(value), timestamp);
  }

  ensureHistoryStartedAt(timestamp = this.timestamp()) {
    const existing = this.getMeta('history_started_at');
    if (existing) return existing;
    this.setMeta('history_started_at', timestamp, timestamp);
    return timestamp;
  }

  getBatch(batchId) {
    return this.db.prepare('SELECT * FROM batches WHERE batch_id = ?').get(batchId) ?? null;
  }

  getLatestBatch() {
    return this.db.prepare('SELECT * FROM batches ORDER BY id DESC LIMIT 1').get() ?? null;
  }

  createBatch({ batchId, startedAt, targetQuantity, actualQuantity = 0, badQuantity = 0, status = '生产中' }) {
    const now = this.timestamp(startedAt);
    this.db.prepare(`
      INSERT INTO batches
        (batch_id, started_at, target_quantity, actual_quantity, bad_quantity, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(batchId, this.timestamp(startedAt), targetQuantity, actualQuantity, badQuantity, status, now, now);
  }

  updateBatch(batchId, { endedAt, targetQuantity, actualQuantity, badQuantity, status } = {}, timestamp = this.now()) {
    const current = this.getBatch(batchId);
    if (!current) return;
    this.db.prepare(`
      UPDATE batches
      SET ended_at = COALESCE(?, ended_at),
          target_quantity = COALESCE(?, target_quantity),
          actual_quantity = COALESCE(?, actual_quantity),
          bad_quantity = COALESCE(?, bad_quantity),
          status = COALESCE(?, status),
          updated_at = ?
      WHERE batch_id = ?
    `).run(
      endedAt ? this.timestamp(endedAt) : null,
      targetQuantity ?? null,
      actualQuantity ?? null,
      badQuantity ?? null,
      status ?? null,
      this.timestamp(timestamp),
      batchId
    );
  }

  addHourlyProduction(localDate, localHour, quantity, timestamp = this.now()) {
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    this.db.prepare(`
      INSERT INTO hourly_production (local_date, local_hour, output_quantity, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(local_date, local_hour) DO UPDATE SET
        output_quantity = hourly_production.output_quantity + excluded.output_quantity,
        updated_at = excluded.updated_at
    `).run(localDate, localHour, quantity, this.timestamp(timestamp));
  }

  upsertSpeedSample(minuteBucket, speed, sampledAt = this.now()) {
    if (!Number.isFinite(speed) || speed < 0) return;
    const timestamp = this.timestamp(sampledAt);
    this.db.prepare(`
      INSERT INTO speed_samples (minute_bucket, sampled_at, speed, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(minute_bucket) DO UPDATE SET
        sampled_at = excluded.sampled_at,
        speed = excluded.speed
    `).run(minuteBucket, timestamp, Math.round(speed), timestamp);
  }

  nextAlarmCount(code) {
    const row = this.db.prepare('SELECT MAX(trigger_count) AS max_count FROM alarm_events WHERE code = ?').get(code);
    return Number(row?.max_count ?? 0) + 1;
  }

  addAlarmEvent({ code, triggeredAt, localDate, station = null, content = null, plcAddress = code, triggerCount }) {
    const timestamp = this.timestamp(triggeredAt);
    this.db.prepare(`
      INSERT INTO alarm_events
        (code, triggered_at, local_date, station, content, plc_address, trigger_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      timestamp,
      localDate,
      station,
      content,
      plcAddress,
      triggerCount ?? this.nextAlarmCount(code),
      timestamp
    );
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cleanup({ longDays = 365, speedDays = 90, now = this.now() } = {}) {
    const current = new Date(now);
    const longCutoff = new Date(current.getTime() - longDays * 24 * 60 * 60 * 1000).toISOString();
    const speedCutoff = new Date(current.getTime() - speedDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.transaction(() => ({
      batches: this.db.prepare('DELETE FROM batches WHERE COALESCE(ended_at, updated_at) < ?').run(longCutoff).changes,
      hourly: this.db.prepare('DELETE FROM hourly_production WHERE local_date < ?').run(longCutoff.slice(0, 10)).changes,
      alarms: this.db.prepare('DELETE FROM alarm_events WHERE triggered_at < ?').run(longCutoff).changes,
      speeds: this.db.prepare('DELETE FROM speed_samples WHERE sampled_at < ?').run(speedCutoff).changes
    }));
    return result;
  }

  queryDaily(from, to) {
    return this.db.prepare(`
      SELECT
        dates.local_date AS date,
        COALESCE((SELECT SUM(output_quantity) FROM hourly_production WHERE local_date = dates.local_date), 0) AS output,
        (SELECT ROUND(AVG(speed), 0) FROM speed_samples WHERE substr(minute_bucket, 1, 10) = dates.local_date) AS average_speed,
        (SELECT COUNT(*) FROM alarm_events alarms WHERE alarms.local_date = dates.local_date) AS alarms
      FROM (
        SELECT local_date FROM hourly_production WHERE local_date BETWEEN ? AND ?
        UNION
        SELECT local_date FROM alarm_events WHERE local_date BETWEEN ? AND ?
        UNION
        SELECT substr(minute_bucket, 1, 10) FROM speed_samples WHERE substr(minute_bucket, 1, 10) BETWEEN ? AND ?
        UNION
        SELECT substr(datetime(started_at, '+8 hours'), 1, 10) FROM batches WHERE substr(datetime(started_at, '+8 hours'), 1, 10) BETWEEN ? AND ?
      ) dates
      GROUP BY dates.local_date
      ORDER BY dates.local_date DESC
    `).all(from, to, from, to, from, to, from, to).map(row => ({
      date: row.date,
      output: Number(row.output ?? 0),
      averageSpeed: row.average_speed == null ? null : Number(row.average_speed),
      alarms: Number(row.alarms ?? 0)
    }));
  }

  queryBatches(date) {
    return this.db.prepare(`
      SELECT batch_id AS batchId, started_at AS startedAt, ended_at AS endedAt,
        target_quantity AS targetQuantity, actual_quantity AS actualQuantity,
        bad_quantity AS badQuantity, status
      FROM batches
      WHERE substr(datetime(started_at, '+8 hours'), 1, 10) = ?
         OR substr(datetime(COALESCE(ended_at, updated_at), '+8 hours'), 1, 10) = ?
      ORDER BY started_at
    `).all(date, date);
  }

  queryHourly(date) {
    return this.db.prepare(`
      SELECT local_date AS date, local_hour AS hour, output_quantity AS output
      FROM hourly_production
      WHERE local_date = ?
      ORDER BY local_hour
    `).all(date).map(row => ({ date: row.date, hour: Number(row.hour), output: Number(row.output) }));
  }

  querySpeeds(from, to) {
    return this.db.prepare(`
      SELECT minute_bucket AS minuteBucket, sampled_at AS sampledAt, speed
      FROM speed_samples
      WHERE substr(minute_bucket, 1, 10) BETWEEN ? AND ?
      ORDER BY minute_bucket
    `).all(from, to).map(row => ({ ...row, speed: Number(row.speed) }));
  }

  queryAlarms({ date, from, to, station, code } = {}) {
    const clauses = [];
    const params = [];
    if (date) {
      clauses.push('local_date = ?');
      params.push(date);
    } else if (from && to) {
      clauses.push('local_date BETWEEN ? AND ?');
      params.push(from, to);
    }
    if (station) {
      clauses.push('station = ?');
      params.push(station);
    }
    if (code) {
      clauses.push('code = ?');
      params.push(code);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT id, code, triggered_at AS triggeredAt, local_date AS date,
        station, content, plc_address AS plcAddress, trigger_count AS count
      FROM alarm_events ${where}
      ORDER BY triggered_at DESC
    `).all(...params);
  }

  counts() {
    return {
      batches: Number(this.db.prepare('SELECT COUNT(*) AS count FROM batches').get().count),
      hourly: Number(this.db.prepare('SELECT COUNT(*) AS count FROM hourly_production').get().count),
      speeds: Number(this.db.prepare('SELECT COUNT(*) AS count FROM speed_samples').get().count),
      alarms: Number(this.db.prepare('SELECT COUNT(*) AS count FROM alarm_events').get().count)
    };
  }

  close() {
    this.db.close();
  }
}
