const baseUrl = (import.meta.env.VITE_HISTORY_API_BASE || '/api').replace(/\/$/, '');

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `历史服务返回 HTTP ${response.status}`);
  return body;
}

export function getHistoryHealth() {
  return request('/health');
}

export function getDailyHistory(from, to) {
  return request(`/daily?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}

export function getBatches(date) {
  return request(`/batches?date=${encodeURIComponent(date)}`);
}

export function getHourlyHistory(date) {
  return request(`/hourly?date=${encodeURIComponent(date)}`);
}

export function getSpeedHistory(from, to) {
  return request(`/speeds?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}

export function getAlarmHistory({ date = '', from = '', to = '', station = '', code = '' } = {}) {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  else if (from && to) {
    params.set('from', from);
    params.set('to', to);
  }
  if (station) params.set('station', station);
  if (code) params.set('code', code);
  return request(`/alarms?${params}`);
}

export function getApiBaseUrl() {
  return baseUrl;
}
