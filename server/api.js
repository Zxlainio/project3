import http from 'node:http';
import { URL } from 'node:url';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATIONS = new Set(['整机', '工位一', '工位二', '工位三', '工位四', '工位五', '工位六', '载带']);
const CODE_PATTERN = /^(?:M9|T(?:10\d|11\d|12[0-8]))$/;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validDate(value, name) {
  if (!value || !DATE_PATTERN.test(value)) throw badRequest(`${name} 必须是 YYYY-MM-DD`);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw badRequest(`${name} 不是有效日期`);
  }
  return value;
}

function dateRange(searchParams, { required = false } = {}) {
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (required && (!from || !to)) throw badRequest('必须同时提供 from 和 to');
  if (!from && !to) return { from: null, to: null };
  if (!from || !to) throw badRequest('from 和 to 必须同时提供');
  validDate(from, 'from');
  validDate(to, 'to');
  if (from > to) throw badRequest('from 不能晚于 to');
  return { from, to };
}

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  response.end(text);
}

export function createApiServer({ database, serviceStatus = () => ({}) }) {
  return http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: '只支持 GET 请求' });
      return;
    }

    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          service: serviceStatus(),
          database: { path: database.databasePath, ...database.counts() },
          historyStartedAt: database.getMeta('history_started_at')
        });
        return;
      }
      if (url.pathname === '/api/meta') {
        sendJson(response, 200, {
          timezone: 'Asia/Shanghai',
          historyStartedAt: database.getMeta('history_started_at'),
          databasePath: database.databasePath
        });
        return;
      }
      if (url.pathname === '/api/daily') {
        const { from, to } = dateRange(url.searchParams, { required: true });
        sendJson(response, 200, { from, to, items: database.queryDaily(from, to) });
        return;
      }
      if (url.pathname === '/api/batches') {
        const date = validDate(url.searchParams.get('date'), 'date');
        sendJson(response, 200, { date, items: database.queryBatches(date) });
        return;
      }
      if (url.pathname === '/api/hourly') {
        const date = validDate(url.searchParams.get('date'), 'date');
        sendJson(response, 200, { date, items: database.queryHourly(date) });
        return;
      }
      if (url.pathname === '/api/speeds') {
        const { from, to } = dateRange(url.searchParams, { required: true });
        sendJson(response, 200, { from, to, items: database.querySpeeds(from, to) });
        return;
      }
      if (url.pathname === '/api/alarms') {
        const date = url.searchParams.get('date');
        const range = date ? { from: null, to: null } : dateRange(url.searchParams);
        if (date) validDate(date, 'date');
        const station = url.searchParams.get('station') || null;
        const code = url.searchParams.get('code') || null;
        if (station && !STATIONS.has(station)) throw badRequest('station 不是已知工位');
        if (code && !CODE_PATTERN.test(code)) throw badRequest('code 不是有效报警代码');
        sendJson(response, 200, { items: database.queryAlarms({ date, ...range, station, code }) });
        return;
      }
      sendJson(response, 404, { error: '接口不存在' });
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { error: error.message || '服务内部错误' });
    }
  });
}
