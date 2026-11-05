import assert from 'node:assert/strict';
import {
  applyHd40BatchRule,
  calculateBatchMetrics,
  getMachineStatus,
  parseTelemetryValues
} from '../src/businessRules.js';

const payload = {
  id: 'test-1',
  params: {
    HD40: { value: 120 },
    HD42: { value: 100 },
    HD66: { value: null },
    X11: { value: 0 },
    Y12: { value: 1 },
    M9: { value: 1 },
    M48: { value: 0 },
    M110: { value: 1 }
  }
};

const parsed = parseTelemetryValues(payload, ['HD40', 'HD42', 'HD66', 'X11', 'Y12', 'M9', 'M48', 'M110', 'T100']);
assert.equal(parsed.hasAnyValue, true);
assert.equal(parsed.values.HD40, 120);
assert.equal(parsed.values.HD66, null);
assert.equal(parsed.values.T100, null);
assert.equal(parsed.values.X11, 0);
assert.equal(parsed.values.Y12, 1);

assert.deepEqual(calculateBatchMetrics(120, 100), { completion: 120, remaining: 0 });
assert.deepEqual(calculateBatchMetrics(null, 100), { completion: null, remaining: null });

assert.equal(getMachineStatus(parsed.values, true), 'running');
assert.equal(getMachineStatus({ M9: 1, M48: 1, M110: 1, T122: 1 }, true), 'alarm');
assert.equal(getMachineStatus({ M9: 1, M48: 1, M110: 1, T122: 0 }, true), 'clearing');
assert.equal(getMachineStatus({ M9: 1, M48: 0, M110: 1, T122: 0 }, true), 'running');
assert.equal(getMachineStatus({ M9: 0, M48: 0, M110: 1, T122: 0 }, true), 'alarm');
assert.equal(getMachineStatus({ M9: 1, M48: 1, M110: 1 }, true), 'clearing');
assert.equal(getMachineStatus({ M9: 1, M48: 0, M110: 0 }, true), 'stopped');
assert.equal(getMachineStatus(parsed.values, false), 'offline');

let batch = {
  previousHd40: null,
  lastPositiveHd40: 0,
  zeroConfirmCount: 0,
  todayOutputOffset: 0,
  batchSequence: 1,
  currentBatchId: '20260902-01'
};
batch = applyHd40BatchRule(batch, 12, '20260902');
assert.equal(batch.changed, false);
assert.equal(batch.currentBatchId, '20260902-01');
batch = applyHd40BatchRule(batch, 0, '20260902');
assert.equal(batch.changed, false);
assert.equal(batch.zeroConfirmCount, 1);
batch = applyHd40BatchRule(batch, 0, '20260902');
assert.equal(batch.changed, true);
assert.equal(batch.currentBatchId, '20260902-02');
assert.equal(batch.todayOutputOffset, 12);
batch = applyHd40BatchRule(batch, 0, '20260902');
assert.equal(batch.changed, false);
assert.equal(batch.currentBatchId, '20260902-02');

const crossDay = applyHd40BatchRule(
  { ...batch, previousHd40: 35, zeroConfirmCount: 0, currentBatchId: '20260902-02' },
  36,
  '20260903'
);
assert.equal(crossDay.currentBatchId, '20260902-02');

console.log('business rules ok');
