import { PLC_FIELDS, parseTelemetryValues } from '../src/businessRules.js';

const TIMER_CODES = PLC_FIELDS.filter(field => /^T\d+$/.test(field));

function localParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(date)).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    compactDate: `${parts.year}${parts.month}${parts.day}`,
    hour: Number(parts.hour),
    minuteBucket: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`
  };
}

function defaultAlarmDefinition(code) {
  return { code, station: null, content: null, plcAddress: code };
}

export const APPROVED_ALARMS = {
  M9: { code: 'M9', station: '整机', content: '主安全/驱动条件异常', plcAddress: 'M9' },
  T122: { code: 'T122', station: '工位六', content: '工位六下压气缸原点报警', plcAddress: 'X10000' },
  T123: { code: 'T123', station: '工位六', content: '工位六下压气缸动点报警', plcAddress: 'X10001' },
  T126: { code: 'T126', station: '载带', content: '双重下降气缸原点报警', plcAddress: 'X10014' },
  T127: { code: 'T127', station: '载带', content: '双重下降气缸动点报警', plcAddress: 'X10015' }
};

export class TelemetryProcessor {
  constructor(database, { now = () => new Date(), alarmCatalog = APPROVED_ALARMS } = {}) {
    this.database = database;
    this.now = now;
    this.alarmCatalog = alarmCatalog;
    this.state = database.getJsonMeta('processor_state', {
      initialized: false,
      previousHd40: null,
      lastPositiveHd40: 0,
      zeroConfirmCount: 0,
      currentBatchId: null,
      batchSequence: 0,
      alarmStates: {},
      alarmCounts: {}
    });
    this.historyStartedAt = database.ensureHistoryStartedAt(database.timestamp(this.now()));
  }

  processPayload(payload, observedAt = this.now()) {
    const { values, hasAnyValue } = parseTelemetryValues(payload, PLC_FIELDS);
    if (!hasAnyValue) return { accepted: false, reason: 'empty-payload' };

    const timestamp = new Date(observedAt);
    const parts = localParts(timestamp);
    const result = this.database.transaction(() => {
      if (!this.state.initialized) {
        this.initializeBaseline(values, timestamp, parts);
        this.persistState(timestamp);
        return { accepted: true, baseline: true, localDate: parts.date };
      }

      const output = this.processProduction(values, timestamp, parts);
      const speed = this.processSpeed(values, timestamp, parts);
      const alarms = this.processAlarms(values, timestamp, parts);
      this.persistState(timestamp);
      return { accepted: true, baseline: false, output, speed, alarms, localDate: parts.date };
    });
    return result;
  }

  initializeBaseline(values, timestamp, parts) {
    const hd40 = values.HD40;
    this.state.initialized = true;
    this.state.previousHd40 = Number.isFinite(hd40) ? hd40 : null;
    this.state.lastPositiveHd40 = Number.isFinite(hd40) && hd40 > 0 ? hd40 : 0;
    this.state.zeroConfirmCount = 0;
    if (!this.state.currentBatchId) {
      this.state.batchSequence = Math.max(1, this.state.batchSequence || 1);
      this.state.currentBatchId = `${parts.compactDate}-${String(this.state.batchSequence).padStart(2, '0')}`;
      this.database.createBatch({
        batchId: this.state.currentBatchId,
        startedAt: timestamp,
        targetQuantity: values.HD42,
        actualQuantity: Number.isFinite(hd40) ? hd40 : 0,
        badQuantity: values.HD66
      });
    }
    if (Number.isFinite(values.HD42) || Number.isFinite(hd40) || Number.isFinite(values.HD66)) {
      this.database.updateBatch(this.state.currentBatchId, {
        targetQuantity: values.HD42,
        actualQuantity: Number.isFinite(hd40) ? hd40 : undefined,
        badQuantity: values.HD66
      }, timestamp);
    }
    this.setAlarmBaselines(values);
  }

  processProduction(values, timestamp, parts) {
    const hd40 = values.HD40;
    if (!Number.isFinite(hd40)) return { delta: 0, batchChanged: false };

    let delta = 0;
    let batchChanged = false;
    if (hd40 === 0 && this.state.lastPositiveHd40 > 0) {
      this.state.zeroConfirmCount += 1;
      if (this.state.zeroConfirmCount >= 2) {
        this.database.updateBatch(this.state.currentBatchId, {
          endedAt: timestamp,
          actualQuantity: this.state.lastPositiveHd40,
          badQuantity: values.HD66,
          status: '已完成'
        }, timestamp);
        this.state.batchSequence += 1;
        this.state.currentBatchId = `${parts.compactDate}-${String(this.state.batchSequence).padStart(2, '0')}`;
        this.database.createBatch({
          batchId: this.state.currentBatchId,
          startedAt: timestamp,
          targetQuantity: values.HD42,
          actualQuantity: 0,
          badQuantity: values.HD66
        });
        this.state.lastPositiveHd40 = 0;
        this.state.zeroConfirmCount = 0;
        batchChanged = true;
      }
    } else if (hd40 > 0) {
      if (Number.isFinite(this.state.previousHd40) && hd40 > this.state.previousHd40) {
        delta = hd40 - this.state.previousHd40;
        this.database.addHourlyProduction(parts.date, parts.hour, delta, timestamp);
      }
      this.state.lastPositiveHd40 = hd40;
      this.state.zeroConfirmCount = 0;
    }

    this.state.previousHd40 = hd40;
    this.database.updateBatch(this.state.currentBatchId, {
      targetQuantity: values.HD42,
      actualQuantity: batchChanged ? 0 : (hd40 > 0 ? hd40 : undefined),
      badQuantity: values.HD66
    }, timestamp);
    return { delta, batchChanged };
  }

  processSpeed(values, timestamp, parts) {
    if (!Number.isFinite(values.HD62) || values.HD62 < 0) return false;
    this.database.upsertSpeedSample(parts.minuteBucket, values.HD62, timestamp);
    return true;
  }

  setAlarmBaselines(values) {
    const codes = ['M9', ...TIMER_CODES];
    codes.forEach(code => {
      const value = values[code];
      if (!Number.isFinite(value)) return;
      this.state.alarmStates[code] = code === 'M9' ? value === 0 : value === 1;
    });
  }

  processAlarms(values, timestamp, parts) {
    const recorded = [];
    const codes = ['M9', ...TIMER_CODES];
    codes.forEach(code => {
      const value = values[code];
      if (!Number.isFinite(value)) return;
      const active = code === 'M9' ? value === 0 : value === 1;
      const previous = this.state.alarmStates[code];
      if (previous === false && active) {
        const definition = this.alarmCatalog[code] ?? defaultAlarmDefinition(code);
        const count = (this.state.alarmCounts[code] ?? 0) + 1;
        this.state.alarmCounts[code] = count;
        this.database.addAlarmEvent({
          ...definition,
          triggeredAt: timestamp,
          localDate: parts.date,
          triggerCount: count
        });
        recorded.push(code);
      }
      this.state.alarmStates[code] = active;
    });
    return recorded;
  }

  persistState(timestamp) {
    this.database.setJsonMeta('processor_state', this.state, this.database.timestamp(timestamp));
  }

  status() {
    return {
      initialized: this.state.initialized,
      currentBatchId: this.state.currentBatchId,
      historyStartedAt: this.historyStartedAt
    };
  }
}
