import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { HistoryDatabase } from '../server/database.js';
import { createApiServer } from '../server/api.js';
import { TelemetryProcessor } from '../server/telemetryProcessor.js';

const baseValues = {
  HD42: 100,
  HD62: 9000,
  HD66: 0,
  M9: 1,
  M48: 0,
  M110: 1,
  T122: 0,
  T123: 0,
  T126: 0,
  T127: 0
};

function payload(values = {}) {
  return {
    id: `test-${Math.random()}`,
    params: Object.fromEntries(Object.entries({ HD40: 0, ...baseValues, ...values }).map(([key, value]) => [key, { value }]))
  };
}

function at(second, day = '2026-09-09') {
  return new Date(`${day}T00:00:${String(second).padStart(2, '0')}Z`);
}

function createProcessor() {
  const database = new HistoryDatabase(':memory:');
  const processor = new TelemetryProcessor(database, { now: () => at(0) });
  return { database, processor };
}

{
  const { database, processor } = createProcessor();
  assert.equal(processor.processPayload(payload({ HD40: 10 }), at(0)).baseline, true);
  assert.equal(database.queryHourly('2026-09-09').length, 0);
  assert.equal(database.querySpeeds('2026-09-09', '2026-09-09').length, 0);
  assert.equal(database.queryAlarms({ from: '2026-09-09', to: '2026-09-09' }).length, 0);
  database.close();
}

{
  const { database, processor } = createProcessor();
  processor.processPayload(payload({ HD40: 10 }), at(0));
  processor.processPayload(payload({ HD40: 13, HD62: 8800 }), at(1));
  processor.processPayload(payload({ HD40: 18, HD62: 8700 }), at(2));
  assert.deepEqual(database.queryHourly('2026-09-09'), [{ date: '2026-09-09', hour: 8, output: 8 }]);
  assert.equal(database.querySpeeds('2026-09-09', '2026-09-09').length, 1);
  assert.equal(database.querySpeeds('2026-09-09', '2026-09-09')[0].speed, 8700);
  database.close();
}

{
  const { database, processor } = createProcessor();
  processor.processPayload(payload({ HD40: 12 }), at(0));
  assert.equal(processor.processPayload(payload({ HD40: 0 }), at(1)).output.batchChanged, false);
  assert.equal(processor.processPayload(payload({ HD40: 0 }), at(2)).output.batchChanged, true);
  assert.equal(processor.processPayload(payload({ HD40: 0 }), at(3)).output.batchChanged, false);
  assert.equal(database.getLatestBatch().batch_id, '20260909-02');
  assert.equal(database.counts().batches, 2);
  database.close();
}

{
  const { database, processor } = createProcessor();
  processor.processPayload(payload({ HD40: 12 }), at(0));
  const restarted = new TelemetryProcessor(database, { now: () => at(3) });
  restarted.processPayload(payload({ HD40: 0, T122: 0 }), at(3));
  restarted.processPayload(payload({ HD40: 0, T122: 0 }), at(4));
  assert.equal(database.counts().batches, 2);
  database.close();
}

{
  const { database, processor } = createProcessor();
  processor.processPayload(payload({ HD40: 5 }), at(0));
  processor.processPayload(payload({ HD40: 6, T122: 0, M9: 1 }), at(1));
  processor.processPayload(payload({ HD40: 7, T122: 1, M9: 1 }), at(2));
  processor.processPayload(payload({ HD40: 8, T122: 1, M9: 1 }), at(3));
  processor.processPayload(payload({ HD40: 9, T122: 0, M9: 1 }), at(4));
  processor.processPayload(payload({ HD40: 10, T122: 1, M9: 1 }), at(5));
  processor.processPayload(payload({ HD40: 11, T122: 0, M9: 0 }), at(6));
  processor.processPayload(payload({ HD40: 12, T122: 0, M9: 0 }), at(7));
  processor.processPayload(payload({ HD40: 13, T122: 0, M9: 1 }), at(8));
  assert.deepEqual(database.queryAlarms({ from: '2026-09-09', to: '2026-09-09' }).map(item => [item.code, item.count]), [
    ['M9', 1],
    ['T122', 2],
    ['T122', 1]
  ]);
  assert.equal(database.queryAlarms({ code: 'M9' }).length, 1);
  database.close();
}

{
  const { database, processor } = createProcessor();
  processor.processPayload(payload({ HD40: 5 }), at(0),);
  processor.processPayload(payload({ HD40: 6 }), at(1, '2026-09-10'));
  assert.equal(database.getLatestBatch().batch_id, '20260909-01');
  assert.deepEqual(database.queryHourly('2026-09-10'), [{ date: '2026-09-10', hour: 8, output: 1 }]);
  database.close();
}

{
  const { database } = createProcessor();
  const old = '2024-01-01T00:00:00.000Z';
  database.createBatch({ batchId: '20240101-01', startedAt: old, targetQuantity: 1, actualQuantity: 1 });
  database.addHourlyProduction('2024-01-01', 8, 1, old);
  database.upsertSpeedSample('2024-01-01T08:00:00+08:00', 100, old);
  database.addAlarmEvent({ code: 'T122', triggeredAt: old, localDate: '2024-01-01', triggerCount: 1 });
  const result = database.cleanup({ now: new Date('2026-09-09T00:00:00Z'), longDays: 365, speedDays: 90 });
  assert.deepEqual(result, { batches: 1, hourly: 1, alarms: 1, speeds: 1 });
  database.close();
}

{
  const { database } = createProcessor();
  const api = createApiServer({ database, serviceStatus: () => ({ mqtt: 'test' }) });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const port = api.address().port;
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(response => response.json());
  assert.equal(health.ok, true);
  const invalid = await fetch(`http://127.0.0.1:${port}/api/daily?from=bad&to=2026-09-09`);
  assert.equal(invalid.status, 400);
  const invalidRange = await fetch(`http://127.0.0.1:${port}/api/speeds?from=2026-09-10&to=2026-09-09`);
  assert.equal(invalidRange.status, 400);
  api.close();
  database.close();
}

console.log('history service ok');
