export const DISPLAY_EMPTY = '--';

export const PLC_FIELDS = [
  'HSD0', 'HD4', 'HD6', 'HD8', 'HD10',
  'HSD4', 'HD16', 'HD20', 'HD50', 'HD52',
  'HSD8', 'HD24', 'HD26', 'HD28', 'HD30', 'HD54', 'HD56',
  'HSD12', 'HD32', 'HD34', 'HD36', 'HD38',
  'HD40', 'HD42', 'HD44', 'HD46', 'HD60', 'HD62', 'HD66', 'HD900',
  'M9', 'M48', 'M110',
  'X11', 'X12', 'X15',
  'Y12', 'Y13', 'Y14', 'Y16', 'Y20', 'Y22', 'Y24', 'Y25', 'Y26',
  'Y10004', 'Y10006', 'Y10010', 'Y10116', 'Y10117',
  'T100', 'T101', 'T102', 'T103', 'T104', 'T105', 'T106', 'T107', 'T108', 'T109',
  'T110', 'T111', 'T112', 'T113', 'T114', 'T115', 'T116', 'T117', 'T118', 'T119',
  'T120', 'T121', 'T122', 'T123', 'T124', 'T125', 'T126', 'T127', 'T128'
];

export function readTelemetryValue(payload, field) {
  const source = payload?.params?.[field] ?? payload?.[field];
  if (source && typeof source === 'object' && 'value' in source) {
    if (source.value == null) return null;
    const value = Number(source.value);
    return Number.isFinite(value) ? value : null;
  }
  if (source == null) return null;
  const value = Number(source);
  return Number.isFinite(value) ? value : null;
}

export function parseTelemetryValues(payload, fields = PLC_FIELDS) {
  const values = Object.fromEntries(fields.map(field => [field, readTelemetryValue(payload, field)]));
  const hasAnyValue = Object.values(values).some(value => Number.isFinite(value));
  return { values, hasAnyValue };
}

export function valueOrNull(values, field) {
  const value = values[field];
  return Number.isFinite(value) ? value : null;
}

export function getMachineStatus(values, online) {
  if (!online) return 'offline';
  const hasActiveTimerAlarm = Object.entries(values)
    .some(([field, value]) => /^T\d+$/.test(field) && value === 1);
  if (valueOrNull(values, 'M9') === 0 || hasActiveTimerAlarm) return 'alarm';
  if (valueOrNull(values, 'M48') === 1) return 'clearing';
  if (valueOrNull(values, 'M110') === 1) return 'running';
  return 'stopped';
}

export function calculateBatchMetrics(hd40, hd42) {
  if (!Number.isFinite(hd40) || !Number.isFinite(hd42)) {
    return { completion: null, remaining: null };
  }
  return {
    completion: hd42 > 0 ? (hd40 / hd42) * 100 : null,
    remaining: Math.max(hd42 - hd40, 0)
  };
}

export function applyHd40BatchRule(batchState, hd40, compactDate) {
  if (!Number.isFinite(hd40)) {
    return { ...batchState, changed: false };
  }

  const next = { ...batchState, changed: false };
  next.lastPositiveHd40 = next.lastPositiveHd40 ?? (next.previousHd40 > 0 ? next.previousHd40 : 0);
  if (!next.currentBatchId) {
    next.currentBatchId = `${compactDate}-01`;
    next.batchSequence = 1;
  }

  if (next.lastPositiveHd40 > 0 && hd40 === 0) {
    next.zeroConfirmCount += 1;
    if (next.zeroConfirmCount === 2) {
      next.todayOutputOffset += next.lastPositiveHd40;
      next.batchSequence += 1;
      next.currentBatchId = `${compactDate}-${String(next.batchSequence).padStart(2, '0')}`;
      next.lastPositiveHd40 = 0;
      next.changed = true;
    }
  } else if (hd40 > 0) {
    next.lastPositiveHd40 = hd40;
    next.zeroConfirmCount = 0;
  }

  next.previousHd40 = hd40;
  return next;
}
