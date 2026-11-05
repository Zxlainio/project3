import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profileDir = path.join(os.tmpdir(), 'project2-edge-cdp-profile');
const port = 9234;
const dashboardUrl = process.env.DASHBOARD_URL || 'http://127.0.0.1:5173/';
const viewportWidth = Number(process.env.VIEWPORT_WIDTH || 1920);
const viewportHeight = Number(process.env.VIEWPORT_HEIGHT || 1080);

await mkdir(profileDir, { recursive: true });

const browser = spawn(edgePath, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  `--window-size=${viewportWidth},${viewportHeight}`,
  '--disable-gpu',
  'about:blank'
], { detached: false, stdio: 'ignore' });

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, attempts = 20) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw lastError ?? new Error(`Unable to fetch ${url}`);
}

function connectCdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const opened = new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  return {
    opened,
    send(method, params = {}, sessionId) {
      return new Promise(resolve => {
        const requestId = ++id;
        pending.set(requestId, resolve);
        ws.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
  };
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);
  if (response.error) throw new Error(response.error.message);
  return response.result.result.value;
}

async function waitForApp(cdp, sessionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await evaluate(cdp, sessionId, "Boolean(document.querySelector('h1') && document.querySelector('#connection-status'))");
    if (ready) return;
    await wait(250);
  }
  throw new Error('Dashboard app did not render in time');
}

async function pageReport(cdp, sessionId, page, clickExpression) {
  if (clickExpression) {
    await evaluate(cdp, sessionId, clickExpression);
    await wait(900);
  }
  return evaluate(cdp, sessionId, `(() => ({
    page: ${JSON.stringify(page)},
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    headerStatus: document.querySelector('#header-status')?.textContent.trim(),
    connection: document.querySelector('#connection-status')?.textContent.trim(),
    batch: document.querySelector('#batch-count')?.textContent.trim(),
    target: document.querySelector('#batch-target')?.textContent.trim(),
    bad: document.querySelector('#batch-bad')?.textContent.trim(),
    speed: document.querySelector('#actual-speed')?.textContent.trim(),
    activeAlarm: document.querySelector('#active-alarm-count')?.textContent.trim(),
    parameterText: document.querySelector('#parameter-content')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 260),
    alarmText: document.querySelector('#page-alarms')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 260),
    recordText: document.querySelector('#page-records')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 260)
  }))()`);
}

try {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = connectCdp(version.webSocketDebuggerUrl);
  await cdp.opened;
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  await cdp.send('Page.navigate', { url: dashboardUrl }, sessionId);
  await waitForApp(cdp, sessionId);
  await wait(7000);

  const reports = [];
  reports.push(await pageReport(cdp, sessionId, 'overview'));
  reports.push(await pageReport(cdp, sessionId, 'parameters-motor', "document.querySelector('[data-page=parameters]').click()"));
  reports.push(await pageReport(cdp, sessionId, 'parameters-io', "document.querySelector('[data-param-tab=io]').click()"));
  reports.push(await pageReport(cdp, sessionId, 'alarms', "document.querySelector('[data-page=alarms]').click()"));
  reports.push(await pageReport(cdp, sessionId, 'records', "document.querySelector('[data-page=records]').click()"));

  console.log(JSON.stringify(reports, null, 2));
  await cdp.send('Browser.close');
} finally {
  if (!browser.killed) browser.kill();
}
