import './style.css';
import mqtt from 'mqtt';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import {
  Activity,
  ArrowRight,
  Boxes,
  Camera,
  ChevronRight,
  CircleCheck,
  CircleCheckBig,
  ClipboardList,
  createIcons,
  Factory,
  FileSpreadsheet,
  Gauge,
  LayoutDashboard,
  LockKeyhole,
  Maximize2,
  PackageCheck,
  RadioTower,
  RotateCcw,
  Settings2,
  Square,
  Timer,
  TriangleAlert,
  WifiOff,
  Wrench
} from 'lucide';
import {
  PLC_FIELDS,
  applyHd40BatchRule,
  calculateBatchMetrics,
  getMachineStatus,
  parseTelemetryValues,
  valueOrNull
} from './businessRules.js';
import { ioSignals } from './liveCatalog.js';
import {
  getAlarmHistory,
  getBatches,
  getDailyHistory,
  getHistoryHealth,
  getHourlyHistory,
  getSpeedHistory
} from './historyApi.js';

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const icons = {
  Activity,
  ArrowRight,
  Boxes,
  Camera,
  ChevronRight,
  CircleCheck,
  CircleCheckBig,
  ClipboardList,
  Factory,
  FileSpreadsheet,
  Gauge,
  LayoutDashboard,
  LockKeyhole,
  Maximize2,
  PackageCheck,
  RadioTower,
  RotateCcw,
  Settings2,
  Square,
  Timer,
  TriangleAlert,
  WifiOff,
  Wrench
};

const app = document.querySelector('#app');

const state = {
  page: 'overview',
  parameterTab: 'motor',
  machineStatus: 'offline',
  mode: '--',
  online: false,
  mqttConnection: 'connecting',
  mqttLastMessageAt: null,
  mqttLastPayloadId: '--',
  mqttRecoveryCount: 0,
  livePlcValues: {
    HSD0: null,
    HD4: null,
    HD6: null,
    HD8: null,
    HD10: null,
    HSD4: null,
    HD16: null,
    HD20: null,
    HD50: null,
    HD52: null,
    HSD8: null,
    HD24: null,
    HD26: null,
    HD28: null,
    HD30: null,
    HD54: null,
    HD56: null,
    HSD12: null,
    HD32: null,
    HD34: null,
    HD36: null,
    HD38: null,
    HD40: null,
    HD42: null,
    HD44: null,
    HD46: null,
    HD60: null,
    HD62: null,
    HD66: null,
    HD900: null,
    M9: null,
    M48: null,
    M110: null,
    X11: null,
    X12: null,
    X15: null,
    Y12: null,
    Y13: null,
    Y14: null,
    Y16: null,
    Y20: null,
    Y22: null,
    Y24: null,
    Y25: null,
    Y26: null,
    Y10004: null,
    Y10006: null,
    Y10010: null,
    Y10116: null,
    Y10117: null,
    T100: null,
    T101: null,
    T102: null,
    T103: null,
    T104: null,
    T105: null,
    T106: null,
    T107: null,
    T108: null,
    T109: null,
    T110: null,
    T111: null,
    T112: null,
    T113: null,
    T114: null,
    T115: null,
    T116: null,
    T117: null,
    T118: null,
    T119: null,
    T120: null,
    T121: null,
    T122: null,
    T123: null,
    T124: null,
    T125: null,
    T126: null,
    T127: null,
    T128: null
  },
  batchCount: null,
  batchTarget: null,
  batchBadCount: null,
  batchSequence: 0,
  currentBatchId: null,
  previousHd40: null,
  lastPositiveHd40: 0,
  zeroConfirmCount: 0,
  todayOutputOffset: 0,
  todayCount: null,
  actualSpeed: null,
  stateSeconds: 0,
  activeAlarms: [],
  alarmHistory: [],
  selectedRecord: null,
  hourlyLabels: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}时`),
  hourlyOutput: Array(24).fill(null),
  hourlySpeed: Array(24).fill(null),
  activeAlarmCodes: new Set(),
  pendingRecoveryValues: null,
  historyService: { status: 'checking', available: false, historyStartedAt: null, error: null },
  historyDaily: [],
  historyLoadedDate: null
};

const statusConfig = {
  running: { label: '运行', tone: 'success', icon: 'activity' },
  clearing: { label: '清料', tone: 'info', icon: 'rotate-ccw' },
  stopped: { label: '停止', tone: 'neutral', icon: 'square' },
  alarm: { label: '报警', tone: 'danger', icon: 'triangle-alert' },
  offline: { label: '离线', tone: 'neutral', icon: 'wifi-off' }
};

const defaultMqttWsUrl = `ws://${window.location.hostname || '127.0.0.1'}:8083/mqtt`;
const cameraWebUrl = import.meta.env.VITE_CAMERA_WEB_URL || 'http://192.168.1.118:8000/';
const mqttConfig = {
  // Use the host serving the dashboard so LAN clients do not connect to their own localhost.
  url: import.meta.env.VITE_MQTT_WS_URL || defaultMqttWsUrl,
  topic: 'device/esp32-s3/property',
  username: import.meta.env.VITE_MQTT_USERNAME || '',
  password: import.meta.env.VITE_MQTT_PASSWORD || '',
  staleMs: 5000,
  recoveryMessages: 2
};

const livePlcGroups = [
  {
    name: '转盘伺服参数',
    monitor: ['HSD0', '脉冲监控'],
    items: [
      ['HD4', '工位脉冲'],
      ['HD6', '定位速度'],
      ['HD8', '位置补偿'],
      ['HD10', '加减速度']
    ]
  },
  {
    name: '上下伺服参数',
    monitor: ['HSD4', '脉冲监控'],
    items: [
      ['HD50', '原点位置'],
      ['HD16', '定位速度'],
      ['HD52', '动点位置'],
      ['HD20', '加减速度']
    ]
  },
  {
    name: '六位步进参数',
    monitor: ['HSD8', '脉冲监控'],
    items: [
      ['HD54', '原点位置'],
      ['HD26', '定位速度'],
      ['HD56', '动点位置'],
      ['HD30', '加减速度'],
      ['HD28', '不良位置']
    ]
  },
  {
    name: '载带步进参数',
    monitor: ['HSD12', '脉冲监控'],
    items: [
      ['HD32', '上料速度'],
      ['HD36', '定位速度'],
      ['HD38', '位置补偿'],
      ['HD34', '定位距离']
    ]
  }
];

const liveProductionParameters = [
  ['HD40', '产能计数'],
  ['HD42', '预设产能'],
  ['HD44', '载带空跑数量'],
  ['HD46', '载带空跑计数'],
  ['HD60', '产能周期计时'],
  ['HD62', 'UP每H'],
  ['HD66', '不良计数'],
  ['HD900', '气缸报警延时']
];

const liveIoSignals = ioSignals.map(([station, name, address, type]) => ({
  station, name, address, type
}));

const plcAlarmCatalog = [
  ['T122', '工位六', '工位六下压气缸原点报警'],
  ['T123', '工位六', '工位六下压气缸动点报警'],
  ['T126', '载带', '双重下降气缸原点报警'],
  ['T127', '载带', '双重下降气缸动点报警']
].map(([code, station, content]) => ({ code, station, content }));
const m9Alarm = { code: 'M9', station: '整机', content: '主安全/驱动条件异常' };
const plcTimerCodes = PLC_FIELDS.filter(field => /^T\d+$/.test(field));

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-block">
        <div class="brand-mark" aria-hidden="true"><i data-lucide="factory"></i></div>
        <div>
          <h1>全自动按键组装机生产看板</h1>
          <div class="machine-id">设备编号：按键组装机-01</div>
        </div>
      </div>
      <div class="live-meta">
        <div id="header-status" class="status-badge"></div>
        <div id="connection-status" class="connection-badge"></div>
        <div class="clock-block">
          <strong id="current-time">--:--:--</strong>
          <span id="current-date">----</span>
        </div>
        <button class="icon-button" id="fullscreen-button" type="button" title="全屏" aria-label="进入全屏">
          <i data-lucide="maximize-2"></i>
        </button>
      </div>
    </header>

    <nav class="main-nav" aria-label="看板页面">
      <button class="nav-item active" data-page="overview" type="button"><i data-lucide="layout-dashboard"></i><span>生产总览</span></button>
      <button class="nav-item" data-page="alarms" type="button"><i data-lucide="triangle-alert"></i><span>报警记录</span><span id="nav-alarm-count" class="nav-count hidden">0</span></button>
      <button class="nav-item" data-page="parameters" type="button"><i data-lucide="settings-2"></i><span>参数查看</span></button>
      <button class="nav-item" data-page="records" type="button"><i data-lucide="clipboard-list"></i><span>生产记录</span></button>
    </nav>

    <main id="main-content" tabindex="-1">
      <section id="page-overview" class="page active-page" aria-labelledby="overview-heading">
        <h2 id="overview-heading" class="sr-only">生产总览</h2>
        <div class="metric-grid">
          <article class="metric-card accent-blue">
            <div class="metric-header"><span>当前批次</span><i data-lucide="package-check"></i></div>
            <div class="metric-primary"><strong id="batch-count">--</strong><span>件</span></div>
            <div class="metric-details batch-details"><span>目标 <b id="batch-target">--</b></span><span>完成率 <b id="batch-rate">--</b></span><span>剩余 <b id="batch-remaining">--</b></span><span>不良 <b id="batch-bad">--</b></span></div>
          </article>
          <article class="metric-card accent-green">
            <div class="metric-header"><span>今日产量</span><i data-lucide="boxes"></i></div>
            <div class="metric-primary"><strong id="today-count">--</strong><span>件</span></div>
            <div class="metric-details"><span>自然日累计</span><span id="current-batch-id">批次 --</span></div>
          </article>
          <article class="metric-card accent-amber">
            <div class="metric-header"><span>生产速度</span><i data-lucide="gauge"></i></div>
            <div class="metric-primary"><strong id="actual-speed">--</strong><span>UP/H</span></div>
            <div class="metric-details"><span>来源 <b id="speed-source">HD62</b></span><span>周期 <b id="cycle-time">--</b></span></div>
          </article>
          <article class="metric-card accent-charcoal">
            <div class="metric-header"><span>设备时间</span><i data-lucide="timer"></i></div>
            <div class="time-pairs compact-time"><span>当前状态 <b id="state-duration">--</b></span><span>数据间隔 <b id="data-age">--</b></span></div>
          </article>
        </div>

        <div class="overview-grid">
          <div class="chart-stack">
            <article class="panel chart-panel">
              <div class="panel-heading"><div><span class="eyebrow">当日统计</span><h3>每小时产量</h3></div><span class="unit-label">单位：件</span></div>
              <div id="output-chart" class="chart" role="img" aria-label="当天每小时产量柱状图"></div>
            </article>
            <article class="panel chart-panel">
              <div class="panel-heading"><div><span class="eyebrow">最近 5 分钟均速</span><h3>实际速度趋势</h3></div><span class="unit-label">单位：UP/H</span></div>
              <div id="speed-chart" class="chart" role="img" aria-label="当天实际速度趋势折线图"></div>
            </article>
            <article class="panel camera-panel">
              <div class="panel-heading"><div><span class="eyebrow">实时检测</span><h3>MaixCAM 检测画面</h3></div><i data-lucide="camera"></i></div>
              <div class="camera-frame">
                <iframe id="camera-web" class="camera-web" title="MaixCAM 实时检测" loading="lazy"></iframe>
                <div id="camera-unavailable" class="camera-unavailable" role="status" hidden>摄像头暂不可用</div>
              </div>
            </article>
          </div>

          <aside class="status-column" aria-label="设备状态和报警">
            <article id="machine-status-panel" class="panel machine-status-panel">
              <div class="panel-heading"><div><span class="eyebrow">实时状态</span><h3>当前设备状态</h3></div><i data-lucide="radio-tower"></i></div>
              <div id="status-hero" class="status-hero"></div>
              <dl class="status-facts">
                <div><dt>运行模式</dt><dd id="machine-mode">--</dd></div>
                <div><dt>状态持续</dt><dd id="status-duration-detail">--</dd></div>
                <div><dt>数据更新</dt><dd id="last-update">--:--:--</dd></div>
              </dl>
            </article>
            <article class="panel alarm-summary-panel">
              <div class="panel-heading"><div><span class="eyebrow">设备异常</span><h3>当前报警</h3></div><span id="active-alarm-count" class="count-chip">0 条</span></div>
              <div id="overview-current-alarms" class="alarm-list"></div>
              <div class="subsection-heading"><span>最近报警</span><button class="text-button" type="button" data-go-alarms>查看全部 <i data-lucide="arrow-right"></i></button></div>
              <div id="recent-alarms" class="recent-alarm-list"></div>
              <div class="today-alarm-total"><span>今日报警</span><strong id="today-alarm-count">0</strong><span>次</span></div>
            </article>
          </aside>
        </div>
      </section>

      <section id="page-alarms" class="page" aria-labelledby="alarms-heading">
        <div class="page-heading"><div><span class="eyebrow">Alarm records</span><h2 id="alarms-heading">报警记录</h2></div><div class="page-heading-meta"><span class="history-service-status">历史服务检查中</span><p>设备当前报警与历史触发记录</p></div></div>
        <div class="alarm-kpi-row">
          <article><span>当前报警</span><strong id="alarm-page-active">0</strong><small>条</small></article>
          <article><span>今日报警</span><strong id="alarm-page-today">0</strong><small>次</small></article>
          <article><span>历史记录</span><strong id="alarm-page-total">0</strong><small>条</small></article>
        </div>
        <article class="panel current-alarm-panel">
          <div class="panel-heading"><div><span class="eyebrow">Active</span><h3>当前报警</h3></div></div>
          <div id="alarm-page-current-list" class="current-alarm-grid"></div>
        </article>
        <article class="panel data-panel">
          <div class="panel-heading"><div><span class="eyebrow">History</span><h3>历史报警</h3></div></div>
          <div class="filter-bar">
            <label><span>日期</span><input id="alarm-date-filter" type="date" /></label>
            <label><span>工位</span><select id="alarm-station-filter"><option value="">全部工位</option><option>工位一</option><option>工位二</option><option>工位三</option><option>工位四</option><option>工位五</option><option>工位六</option></select></label>
            <label><span>报警代码</span><select id="alarm-code-filter"><option value="">全部代码</option></select></label>
            <button id="alarm-filter-reset" class="secondary-button" type="button"><i data-lucide="rotate-ccw"></i>重置</button>
          </div>
          <div class="table-wrap"><table><thead><tr><th>触发日期</th><th>触发时间</th><th>所属工位</th><th>报警内容</th><th>报警代码</th><th>计数</th></tr></thead><tbody id="alarm-history-body"></tbody></table></div>
        </article>
      </section>

      <section id="page-parameters" class="page" aria-labelledby="parameters-heading">
        <div class="page-heading"><div><span class="eyebrow">Read only</span><h2 id="parameters-heading">参数查看</h2></div><span class="readonly-badge"><i data-lucide="lock-keyhole"></i>只读</span></div>
        <div class="segmented-tabs" role="tablist" aria-label="参数分类">
          <button class="active" type="button" role="tab" data-param-tab="motor">电机参数</button>
          <button type="button" role="tab" data-param-tab="process">基本参数</button>
          <button type="button" role="tab" data-param-tab="io">IO 诊断</button>
        </div>
        <div id="parameter-content"></div>
      </section>

      <section id="page-records" class="page" aria-labelledby="records-heading">
        <div class="page-heading records-heading"><div><span class="eyebrow">Production history</span><h2 id="records-heading">生产记录</h2></div><div class="page-heading-meta"><span class="history-service-status">历史服务检查中</span><button id="export-record-button" class="primary-button" type="button"><i data-lucide="file-spreadsheet"></i>导出当前日期</button></div></div>
        <article class="panel data-panel">
          <div class="panel-heading"><div><span class="eyebrow">Daily summary</span><h3>每日汇总</h3></div></div>
          <div class="table-wrap"><table class="selectable-table"><thead><tr><th>日期</th><th>总产量</th><th>平均速度</th><th>报警次数</th><th></th></tr></thead><tbody id="daily-record-body"></tbody></table></div>
        </article>
        <div class="record-detail-grid">
          <article class="panel data-panel">
            <div class="panel-heading"><div><span class="eyebrow" id="selected-record-date">----</span><h3>当天批次</h3></div><span id="selected-record-output" class="count-chip">0 件</span></div>
            <div class="table-wrap"><table><thead><tr><th>批次编号</th><th>目标数量</th><th>实际数量</th><th>状态</th></tr></thead><tbody id="batch-record-body"></tbody></table></div>
          </article>
          <article class="panel record-chart-panel">
            <div class="panel-heading"><div><span class="eyebrow">Hourly detail</span><h3>当天生产明细</h3></div></div>
            <div id="record-detail-chart" class="chart" role="img" aria-label="选中日期的产量与速度图表"></div>
          </article>
        </div>
      </section>
    </main>

    <footer class="app-footer"><span id="footer-source">数据源：等待 MQTT 数据</span><span id="history-footer-status">历史服务：检查中</span><span id="footer-update">最后更新：--:--:--</span></footer>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
`;

createIcons({ icons });

let outputChart;
let speedChart;
let recordChart;

function formatNumber(value) {
  return Math.round(value).toLocaleString('zh-CN');
}

function formatLiveValue(value) {
  return Number.isFinite(value) ? formatNumber(value) : '--';
}

function formatMetricValue(value, suffix = '') {
  return Number.isFinite(value) ? `${formatNumber(value)}${suffix}` : '--';
}

function formatDuration(totalSeconds, compact = false) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (compact) return `${hours}时${String(minutes).padStart(2, '0')}分`;
  if (hours > 0) return `${hours}时${String(minutes).padStart(2, '0')}分`;
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

function localDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    compactDate: `${parts.year}${parts.month}${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    hour: Number(parts.hour)
  };
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateParts(date).date;
}

function formatAlarmText(alarm) {
  return alarm.content || alarm.code;
}

function apiAlarmToUi(alarm) {
  const triggeredAt = alarm.triggeredAt ? new Date(alarm.triggeredAt) : null;
  const parts = triggeredAt && !Number.isNaN(triggeredAt.getTime()) ? localDateParts(triggeredAt) : null;
  return {
    id: alarm.id,
    code: alarm.code,
    station: alarm.station || '--',
    content: alarm.content || null,
    plcAddress: alarm.plcAddress || alarm.code,
    date: alarm.date || parts?.date || '--',
    time: parts?.time || '--',
    count: alarm.count
  };
}

function updateHistoryServiceDisplay() {
  const labels = {
    checking: '历史服务检查中',
    available: 'SQLite 历史在线',
    unavailable: '历史服务不可用'
  };
  const status = state.historyService.status;
  document.querySelectorAll('.history-service-status').forEach(node => {
    node.textContent = labels[status] || labels.checking;
    node.className = `history-service-status ${status}`;
  });
  const footer = document.querySelector('#history-footer-status');
  if (footer) footer.textContent = `历史服务：${status === 'available' ? 'SQLite 在线' : status === 'unavailable' ? '不可用' : '检查中'}`;
}

function recordFromApi(date, daily, batches, hourly) {
  const summary = daily?.find(item => item.date === date);
  if (!summary && batches.length === 0 && hourly.length === 0) return null;
  const sortedHourly = [...hourly].sort((a, b) => a.hour - b.hour);
  return {
    date,
    output: summary?.output ?? sortedHourly.reduce((total, item) => total + item.output, 0),
    averageSpeed: summary?.averageSpeed ?? 0,
    alarms: summary?.alarms ?? 0,
    batches: batches.map(item => [item.batchId, item.targetQuantity, item.actualQuantity, item.status]),
    hours: sortedHourly.map(item => `${String(item.hour).padStart(2, '0')}时`),
    outputs: sortedHourly.map(item => item.output),
    speeds: sortedHourly.map(() => null)
  };
}

function applyApiSpeedToCharts(samples, date) {
  const sums = Array(24).fill(0);
  const counts = Array(24).fill(0);
  samples.forEach(sample => {
    const parts = localDateParts(new Date(sample.sampledAt));
    if (parts.date !== date) return;
    sums[parts.hour] += sample.speed;
    counts[parts.hour] += 1;
  });
  state.hourlySpeed = sums.map((sum, index) => counts[index] ? Math.round(sum / counts[index]) : null);
}

async function loadSelectedHistoryRecord(date) {
  const [batchResponse, hourlyResponse, speedResponse] = await Promise.all([
    getBatches(date),
    getHourlyHistory(date),
    getSpeedHistory(date, date)
  ]);
  const record = recordFromApi(date, state.historyDaily, batchResponse.items, hourlyResponse.items);
  if (!record) {
    state.selectedRecord = null;
    state.historyLoadedDate = date;
    if (date === localDateParts().date) {
      state.hourlyOutput = Array(24).fill(null);
      state.hourlySpeed = Array(24).fill(null);
    }
    return;
  }
  const speedSums = {};
  const speedCounts = {};
  speedResponse.items.forEach(sample => {
    const hour = localDateParts(new Date(sample.sampledAt)).hour;
    speedSums[hour] = (speedSums[hour] || 0) + sample.speed;
    speedCounts[hour] = (speedCounts[hour] || 0) + 1;
  });
  record.speeds = record.hours.map(label => {
    const hour = Number.parseInt(label, 10);
    return speedCounts[hour] ? Math.round(speedSums[hour] / speedCounts[hour]) : null;
  });
  state.selectedRecord = record;
  state.historyLoadedDate = date;
  if (date === localDateParts().date) {
    state.hourlyOutput = Array(24).fill(null);
    hourlyResponse.items.forEach(item => { state.hourlyOutput[item.hour] = item.output; });
    applyApiSpeedToCharts(speedResponse.items, date);
  }
}

async function refreshAlarmHistory(filters = {}) {
  if (!state.historyService.available) return;
  try {
    const response = await getAlarmHistory(filters);
    state.alarmHistory = response.items.map(apiAlarmToUi);
    updateAlarmFilterOptions();
    renderAlarmHistory();
    updateAlarmDisplays();
  } catch (error) {
    state.historyService.error = error.message;
    state.historyService.status = 'unavailable';
    state.historyService.available = false;
    updateHistoryServiceDisplay();
  }
}

async function loadHistoryData() {
  try {
    const health = await getHistoryHealth();
    const today = localDateParts().date;
    const daily = await getDailyHistory(dateDaysAgo(365), today);
    state.historyDaily = daily.items;
  state.historyService = {
      status: 'available',
      available: true,
      historyStartedAt: health.historyStartedAt,
      error: null
    };
    await loadSelectedHistoryRecord(state.historyDaily[0]?.date || today);
    await refreshAlarmHistory({ from: dateDaysAgo(365), to: today });
    updateHistoryServiceDisplay();
    renderDailyRecords();
    updateAll();
  } catch (error) {
    state.historyService = { status: 'unavailable', available: false, historyStartedAt: null, error: error.message };
    updateHistoryServiceDisplay();
    renderDailyRecords();
    updateAll();
  }
}

function updateClock() {
  const now = localDateParts();
  document.querySelector('#current-date').textContent = now.date;
  document.querySelector('#current-time').textContent = now.time;
}

function statusBadgeMarkup(config) {
  return `<i data-lucide="${config.icon}"></i><span>${config.label}</span>`;
}

function updateMachineDisplay() {
  const effectiveStatus = state.online ? state.machineStatus : 'offline';
  if (state.machineStatus !== effectiveStatus && effectiveStatus !== 'offline') state.machineStatus = effectiveStatus;
  const config = statusConfig[effectiveStatus];
  const headerStatus = document.querySelector('#header-status');
  const statusHero = document.querySelector('#status-hero');
  headerStatus.className = `status-badge tone-${config.tone}`;
  headerStatus.innerHTML = statusBadgeMarkup(config);
  statusHero.className = `status-hero tone-${config.tone}`;
  const sourceLabel = !state.online && state.mqttLastMessageAt
    ? '最后数据'
    : state.online
      ? state.mode
      : '等待 MQTT 数据';
  statusHero.innerHTML = `<i data-lucide="${config.icon}"></i><div><strong>${config.label}</strong><span>${sourceLabel}</span></div>`;

  const connection = document.querySelector('#connection-status');
  const connectionLabels = {
    connected: 'MQTT 在线',
    waiting: 'MQTT 已连接，等待数据',
    connecting: 'MQTT 连接中',
    reconnecting: 'MQTT 重连中',
    stale: '数据超时',
    offline: '数据离线'
  };
  const connectionState = state.mqttConnection === 'connected' && !state.mqttLastMessageAt
    ? 'waiting'
    : state.mqttConnection;
  connection.className = `connection-badge ${connectionState}`;
  connection.innerHTML = `<span class="connection-dot"></span>${connectionLabels[connectionState] || '数据未知'}`;
  document.querySelector('#machine-mode').textContent = sourceLabel;
  document.querySelector('#machine-status-panel').className = `panel machine-status-panel state-${config.tone}`;
  createIcons({ icons });
}

function updateMetrics() {
  const { completion, remaining } = calculateBatchMetrics(state.batchCount, state.batchTarget);
  const now = localDateParts();
  document.querySelector('#batch-count').textContent = formatMetricValue(state.batchCount);
  document.querySelector('#batch-target').textContent = formatMetricValue(state.batchTarget);
  document.querySelector('#batch-rate').textContent = Number.isFinite(completion) ? `${completion.toFixed(1)}%` : '--';
  document.querySelector('#batch-remaining').textContent = formatMetricValue(remaining);
  document.querySelector('#batch-bad').textContent = formatMetricValue(state.batchBadCount);
  document.querySelector('#today-count').textContent = formatMetricValue(state.todayCount);
  document.querySelector('#current-batch-id').textContent = `批次 ${state.currentBatchId || '--'}`;
  document.querySelector('#actual-speed').textContent = formatMetricValue(state.actualSpeed);
  document.querySelector('#speed-source').textContent = 'HD62';
  document.querySelector('#cycle-time').textContent = formatLiveValue(state.livePlcValues.HD60);
  const hasTelemetry = Boolean(state.mqttLastMessageAt);
  document.querySelector('#state-duration').textContent = hasTelemetry ? formatDuration(state.stateSeconds) : '--';
  document.querySelector('#status-duration-detail').textContent = hasTelemetry ? formatDuration(state.stateSeconds) : '--';
  const telemetryTime = state.mqttLastMessageAt ? localDateParts(state.mqttLastMessageAt).time : now.time;
  const ageSeconds = state.mqttLastMessageAt ? Math.max(0, Math.floor((Date.now() - state.mqttLastMessageAt.getTime()) / 1000)) : null;
  document.querySelector('#data-age').textContent = ageSeconds != null ? `${ageSeconds}秒` : '--';
  document.querySelector('#last-update').textContent = telemetryTime;
  document.querySelector('#footer-source').textContent = state.online && hasTelemetry
    ? `数据源：本地 EMQX 实时 · ${mqttConfig.topic}`
    : hasTelemetry
      ? `数据源：最后数据 · ${mqttConfig.topic}`
      : `数据源：等待 MQTT 数据 · ${mqttConfig.topic}`;
  document.querySelector('#footer-update').textContent = hasTelemetry
    ? `最后报文：${telemetryTime} · id ${state.mqttLastPayloadId}`
    : '最后报文：--';
}

function renderAlarmItems(items, emptyLabel) {
  if (!items.length) return `<div class="empty-state"><i data-lucide="circle-check-big"></i><strong>${emptyLabel}</strong><span>${state.online ? '当前未检测到报警' : '等待设备数据'}</span></div>`;
  return items.map(alarm => `<article class="alarm-item"><div class="alarm-icon"><i data-lucide="triangle-alert"></i></div><div><strong>${formatAlarmText(alarm)}</strong><span>${alarm.station || '--'} · ${alarm.code}</span></div><time>${alarm.time}</time></article>`).join('');
}

function updateAlarmDisplays() {
  const current = state.activeAlarms.slice(0, 3);
  const recent = state.alarmHistory.slice(0, 3);
  const today = localDateParts().date;
  const todayCount = state.alarmHistory.filter(item => item.date === today).length;
  document.querySelector('#overview-current-alarms').innerHTML = renderAlarmItems(current, '当前无报警');
  document.querySelector('#recent-alarms').innerHTML = recent.length
    ? recent.map(item => `<div class="recent-alarm"><span class="alarm-time">${item.time}</span><div><strong>${formatAlarmText(item)}</strong><span>${item.station || '--'} · ${item.code}</span></div></div>`).join('')
    : '<div class="table-empty">暂无历史报警记录</div>';
  document.querySelector('#active-alarm-count').textContent = `${state.activeAlarms.length} 条`;
  document.querySelector('#today-alarm-count').textContent = todayCount;
  document.querySelector('#nav-alarm-count').textContent = state.activeAlarms.length;
  document.querySelector('#nav-alarm-count').classList.toggle('hidden', !state.activeAlarms.length);
  document.querySelector('#alarm-page-active').textContent = state.activeAlarms.length;
  document.querySelector('#alarm-page-today').textContent = todayCount;
  document.querySelector('#alarm-page-total').textContent = state.alarmHistory.length;
  document.querySelector('#alarm-page-current-list').innerHTML = renderAlarmItems(state.activeAlarms, '当前无报警');
  renderAlarmHistory();
  createIcons({ icons });
}

function renderAlarmHistory() {
  const date = document.querySelector('#alarm-date-filter').value;
  const station = document.querySelector('#alarm-station-filter').value;
  const code = document.querySelector('#alarm-code-filter').value;
  const filtered = state.alarmHistory.filter(item => (!date || item.date === date) && (!station || item.station === station) && (!code || item.code === code));
  const emptyLabel = state.historyService.available
    ? '没有符合条件的报警记录'
    : '历史服务不可用，无法读取历史报警';
  document.querySelector('#alarm-history-body').innerHTML = filtered.length
    ? filtered.map(item => `<tr><td>${item.date}</td><td class="numeric">${item.time}</td><td>${item.station || '--'}</td><td>${formatAlarmText(item)}</td><td><code>${item.code}</code></td><td class="numeric">${item.count}</td></tr>`).join('')
    : `<tr><td colspan="6"><div class="table-empty">${emptyLabel}</div></td></tr>`;
}

function chartBaseOptions() {
  return {
    animationDuration: 280,
    backgroundColor: 'rgba(10, 38, 62, 0.42)',
    textStyle: { fontFamily: 'Inter, Microsoft YaHei, sans-serif', color: '#c4d8e5' },
    grid: { left: 56, right: 24, top: 24, bottom: 38 },
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(7, 31, 52, .94)', borderColor: '#287eb4', borderWidth: 1, textStyle: { color: '#e9f7ff' } },
    xAxis: { type: 'category', axisLine: { lineStyle: { color: '#416b86' } }, axisTick: { show: false }, axisLabel: { color: '#a9c2d4' } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#244860' } }, axisLabel: { color: '#a9c2d4' } }
  };
}

function initOverviewCharts() {
  outputChart = echarts.init(document.querySelector('#output-chart'));
  speedChart = echarts.init(document.querySelector('#speed-chart'));
  updateOverviewCharts();
}

function updateOverviewCharts() {
  if (!outputChart || !speedChart) return;
  outputChart.setOption({
    ...chartBaseOptions(),
    xAxis: { ...chartBaseOptions().xAxis, data: state.hourlyLabels },
    series: [{ type: 'bar', data: state.hourlyOutput, barMaxWidth: 34, itemStyle: { color: '#1769a6', borderRadius: [3, 3, 0, 0] }, emphasis: { itemStyle: { color: '#0f4f82' } } }]
  });
  speedChart.setOption({
    ...chartBaseOptions(),
    xAxis: { ...chartBaseOptions().xAxis, data: state.hourlyLabels },
    yAxis: { ...chartBaseOptions().yAxis, min: 0, max: 10000 },
    legend: { top: 0, right: 20, itemWidth: 18, textStyle: { color: '#c4d8e5' } },
    grid: { left: 62, right: 24, top: 34, bottom: 38 },
    series: [
      { name: '实际速度', type: 'line', data: state.hourlySpeed, smooth: 0.25, symbolSize: 7, lineStyle: { width: 3, color: '#39d39b', shadowBlur: 8, shadowColor: '#39d39b' }, itemStyle: { color: '#63f0ba' }, areaStyle: { color: 'rgba(18,128,92,.16)' } }
    ]
  });
}

function renderParameterContent() {
  const container = document.querySelector('#parameter-content');
  if (state.parameterTab === 'motor') {
    const liveCards = livePlcGroups.map(group => {
      const [monitorField, monitorLabel] = group.monitor;
      const monitorValue = state.livePlcValues[monitorField];
      const tiles = group.items.map(([field, label]) => {
        const value = state.livePlcValues[field];
        return `<div class="motor-param-tile"><span>${label}</span><strong>${formatLiveValue(value)}</strong><code>${field}</code></div>`;
      }).join('');
      return `<article class="panel parameter-card live-plc-card"><div class="panel-heading"><div><h3>${group.name}</h3><span>${group.items.length} 项参数</span></div><span class="readonly-badge">EMQX 实时</span></div><div class="motor-monitor-row"><div><span>${monitorLabel}</span><code>${monitorField}</code></div><strong>${formatLiveValue(monitorValue)}</strong></div><div class="motor-param-grid">${tiles}</div><table class="motor-param-table"><thead><tr><th>字段</th><th>说明</th><th>当前值</th></tr></thead><tbody>${group.items.map(([field, label]) => {
      const value = state.livePlcValues[field];
      return `<tr><td><code>${field}</code></td><td>${label}</td><td class="numeric strong">${formatLiveValue(value)}</td></tr>`;
    }).join('')}</tbody></table></article>`;
    }).join('');
    container.innerHTML = `<div class="parameter-group-grid live-parameter-grid">${liveCards}</div>`;
  } else if (state.parameterTab === 'process') {
    const liveRows = liveProductionParameters.map(([field, name], index) => {
      const value = state.livePlcValues[field];
      return `<tr><td class="numeric muted">${String(index + 1).padStart(2, '0')}</td><td>${name}</td><td><code>${field}</code></td><td class="numeric strong">${formatLiveValue(value)}</td></tr>`;
    }).join('');
    container.innerHTML = `<article class="panel data-panel"><div class="panel-heading"><div><span class="eyebrow">Real PLC</span><h3>生产参数</h3></div><span class="readonly-badge">只读</span></div><div class="table-wrap"><table><thead><tr><th>序号</th><th>参数名称</th><th>PLC 字段</th><th>当前值</th></tr></thead><tbody>${liveRows}</tbody></table></div></article>`;
  } else {
    container.innerHTML = `<article class="panel data-panel"><div class="panel-heading"><div><span class="eyebrow">IO 诊断</span><h3>输入与输出信号</h3></div><div class="legend"><span><i class="legend-dot on"></i>接通</span><span><i class="legend-dot off"></i>断开</span></div></div><div class="table-wrap"><table><thead><tr><th>所属工位</th><th>信号名称</th><th>PLC 地址</th><th>类型</th><th>当前状态</th></tr></thead><tbody>${liveIoSignals.map(({ station, name, address, type }) => {
      const liveValue = state.livePlcValues[address];
      const isLive = Number.isFinite(liveValue);
      const on = liveValue === 1;
      const label = isLive ? (on ? '接通' : '断开') : '--';
      return `<tr><td>${station}</td><td>${name}</td><td><code>${address}</code></td><td>${type}</td><td><span class="io-state ${isLive ? (on ? 'on' : 'off') : 'unknown'}"><i></i>${label}</span></td></tr>`;
    }).join('')}</tbody></table></div></article>`;
  }
}

function renderDailyRecords() {
  const records = state.historyService.available
    ? state.historyDaily.map(item => ({ ...item, averageSpeed: item.averageSpeed ?? null }))
    : [];
  document.querySelector('#daily-record-body').innerHTML = records.length
    ? records.map(record => `<tr class="record-row ${state.selectedRecord?.date === record.date ? 'selected' : ''}" data-record-date="${record.date}" tabindex="0"><td>${record.date}</td><td class="numeric strong">${formatNumber(record.output)}</td><td class="numeric">${record.averageSpeed == null ? '--' : `${formatNumber(record.averageSpeed)} UP/H`}</td><td class="numeric">${record.alarms}</td><td><i data-lucide="chevron-right"></i></td></tr>`).join('')
    : `<tr><td colspan="5"><div class="table-empty">${state.historyService.available ? '服务已连接，暂时没有历史生产记录' : '历史服务不可用，无法读取历史记录'}</div></td></tr>`;
  renderSelectedRecord();
  createIcons({ icons });
}

function renderSelectedRecord() {
  const record = state.selectedRecord;
  if (!record) {
    document.querySelector('#selected-record-date').textContent = '----';
    document.querySelector('#selected-record-output').textContent = '-- 件';
    document.querySelector('#batch-record-body').innerHTML = `<tr><td colspan="4"><div class="table-empty">当天没有生产记录</div></td></tr>`;
    updateRecordChart();
    return;
  }
  document.querySelector('#selected-record-date').textContent = record.date;
  document.querySelector('#selected-record-output').textContent = `${formatNumber(record.output)} 件`;
  document.querySelector('#batch-record-body').innerHTML = record.batches.length
    ? record.batches.map(([id, target, actual, status]) => `<tr><td><code>${id}</code></td><td class="numeric">${formatNumber(target)}</td><td class="numeric strong">${formatNumber(actual)}</td><td><span class="record-status ${status === '生产中' ? 'active' : ''}">${status}</span></td></tr>`).join('')
    : `<tr><td colspan="4"><div class="table-empty">当天没有生产记录</div></td></tr>`;
  updateRecordChart();
}

function updateRecordChart() {
  if (!recordChart) return;
  const record = state.selectedRecord;
  const hours = record?.hours || [];
  const outputs = record?.outputs || [];
  const speeds = record?.speeds || [];
  recordChart.setOption({
    ...chartBaseOptions(),
    legend: { top: 0, right: 16, itemWidth: 18 },
    grid: { left: 56, right: 58, top: 38, bottom: 38 },
    xAxis: { ...chartBaseOptions().xAxis, data: hours },
    yAxis: [
      { type: 'value', name: '产量', splitLine: { lineStyle: { color: '#244860' } }, axisLabel: { color: '#a9c2d4' } },
      { type: 'value', name: 'UP/H', min: 0, max: 10000, splitLine: { show: false }, axisLabel: { color: '#a9c2d4' } }
    ],
    series: [
      { name: '每小时产量', type: 'bar', data: outputs, barMaxWidth: 28, itemStyle: { color: '#1769a6', borderRadius: [3, 3, 0, 0] } },
      { name: '实际速度', type: 'line', yAxisIndex: 1, data: speeds, smooth: 0.2, lineStyle: { width: 3, color: '#39d39b', shadowBlur: 8, shadowColor: '#39d39b' }, itemStyle: { color: '#63f0ba' } }
    ]
  }, true);
}

function switchPage(page) {
  state.page = page;
  document.querySelectorAll('.page').forEach(node => node.classList.toggle('active-page', node.id === `page-${page}`));
  document.querySelectorAll('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.page === page));
  if (page === 'overview') setTimeout(() => { outputChart?.resize(); speedChart?.resize(); }, 0);
  if (page === 'records') {
    if (!recordChart) recordChart = echarts.init(document.querySelector('#record-detail-chart'));
    renderDailyRecords();
    setTimeout(() => recordChart?.resize(), 0);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function liveValue(field) {
  return valueOrNull(state.livePlcValues, field);
}

function applyProductionTelemetry() {
  const now = localDateParts();

  const hd40 = liveValue('HD40');
  const hd42 = liveValue('HD42');
  const hd62 = liveValue('HD62');
  const hd66 = liveValue('HD66');

  if (hd40 != null) {
    const nextBatch = applyHd40BatchRule({
      previousHd40: state.previousHd40,
      lastPositiveHd40: state.lastPositiveHd40,
      zeroConfirmCount: state.zeroConfirmCount,
      todayOutputOffset: state.todayOutputOffset,
      batchSequence: state.batchSequence,
      currentBatchId: state.currentBatchId
    }, hd40, now.compactDate);
    state.previousHd40 = nextBatch.previousHd40;
    state.lastPositiveHd40 = nextBatch.lastPositiveHd40;
    state.zeroConfirmCount = nextBatch.zeroConfirmCount;
    state.todayOutputOffset = nextBatch.todayOutputOffset;
    state.batchSequence = nextBatch.batchSequence;
    state.currentBatchId = nextBatch.currentBatchId;

    state.batchCount = hd40;
    state.todayCount = state.todayOutputOffset + hd40;
  } else {
    state.batchCount = null;
    state.todayCount = null;
  }

  state.batchTarget = hd42;
  state.actualSpeed = hd62;
  state.batchBadCount = hd66;

}

function applyMachineStatusTelemetry() {
  if (liveValue('M9') == null && liveValue('M48') == null && liveValue('M110') == null
    && !plcTimerCodes.some(code => liveValue(code) != null)) return;
  const nextStatus = getMachineStatus(state.livePlcValues, true);
  if (state.machineStatus !== nextStatus) {
    state.machineStatus = nextStatus;
    state.stateSeconds = 0;
  }
  state.mode = nextStatus === 'clearing' ? '清料过程' : '自动模式';
}

function updateAlarmFilterOptions() {
  const select = document.querySelector('#alarm-code-filter');
  const selected = select.value;
  const codes = [...new Set([...plcTimerCodes, 'M9', ...state.alarmHistory.map(item => item.code)])].sort();
  select.innerHTML = `<option value="">全部代码</option>${codes.map(code => `<option${code === selected ? ' selected' : ''}>${code}</option>`).join('')}`;
}

function applyAlarmTelemetry() {
  if (liveValue('M9') == null && !plcTimerCodes.some(code => liveValue(code) != null)) return;
  const now = localDateParts();
  const active = plcTimerCodes
    .filter(code => liveValue(code) === 1)
    .map(code => {
      const definition = plcAlarmCatalog.find(item => item.code === code);
      return { ...(definition || { code, station: '--', content: null }), id: code, date: now.date, time: now.time, count: 1 };
    });
  if (liveValue('M9') === 0) active.unshift({ ...m9Alarm, id: 'M9', date: now.date, time: now.time, count: 1 });

  const nextCodes = new Set(active.map(item => item.code));
  active.forEach(item => {
    if (!state.activeAlarmCodes.has(item.code)) {
      state.alarmHistory.unshift({ ...item, id: `${item.code}-${Date.now()}` });
    }
  });

  state.activeAlarmCodes = nextCodes;
  state.activeAlarms = active;
  updateAlarmFilterOptions();
}

function applyMqttPayload(payload) {
  const { values: nextValues, hasAnyValue } = parseTelemetryValues(payload, PLC_FIELDS);

  if (!hasAnyValue) return false;

  const wasRecovering = !state.online;
  state.mqttRecoveryCount += 1;
  state.mqttLastMessageAt = new Date();
  state.mqttLastPayloadId = payload?.id ?? '--';
  state.pendingRecoveryValues = nextValues;

  if (wasRecovering && state.mqttRecoveryCount < mqttConfig.recoveryMessages) {
    state.mqttConnection = 'reconnecting';
    updateAll(false);
    return true;
  }

  state.online = true;
  state.mqttConnection = 'connected';
  state.livePlcValues = nextValues;
  state.pendingRecoveryValues = null;
  state.mqttRecoveryCount = mqttConfig.recoveryMessages;
  applyProductionTelemetry();
  applyMachineStatusTelemetry();
  applyAlarmTelemetry();

  if (state.parameterTab === 'motor' || state.parameterTab === 'process' || state.parameterTab === 'io') {
    renderParameterContent();
  }
  updateAll();
  return true;
}

function checkMqttFreshness() {
  if (!state.mqttLastMessageAt) return;
  const age = Date.now() - state.mqttLastMessageAt.getTime();
  if (age <= mqttConfig.staleMs) return;
  state.online = false;
  state.mqttRecoveryCount = 0;
  state.mqttConnection = 'stale';
  updateAll(false);
}

function connectMqttTelemetry() {
  const client = mqtt.connect(mqttConfig.url, {
    clientId: `project2_dashboard_${Math.random().toString(16).slice(2)}`,
    username: mqttConfig.username,
    password: mqttConfig.password,
    clean: true,
    connectTimeout: 5000,
    reconnectPeriod: 3000
  });

  client.on('connect', () => {
    state.mqttConnection = 'connected';
    client.subscribe(mqttConfig.topic, error => {
      if (error) {
        state.mqttConnection = 'offline';
        state.online = false;
        updateAll(false);
      }
    });
    updateAll(false);
  });

  client.on('reconnect', () => {
    state.mqttConnection = 'reconnecting';
    updateAll(false);
  });

  client.on('close', () => {
    state.mqttConnection = 'offline';
    state.online = false;
    updateAll(false);
  });

  client.on('error', () => {
    state.mqttConnection = 'offline';
    updateAll(false);
  });

  client.on('message', (topic, message) => {
    if (topic !== mqttConfig.topic) return;
    try {
      applyMqttPayload(JSON.parse(message.toString()));
    } catch {
      showToast('收到无法解析的 MQTT 报文', 'danger');
    }
  });
}

let chartUpdateQueued = false;
function scheduleOverviewCharts() {
  if (chartUpdateQueued) return;
  chartUpdateQueued = true;
  window.setTimeout(() => {
    chartUpdateQueued = false;
    updateOverviewCharts();
  }, 220);
}

function updateAll(updateAlarms = true) {
  updateClock();
  updateMetrics();
  updateMachineDisplay();
  if (updateAlarms) updateAlarmDisplays();
  scheduleOverviewCharts();
}

let toastTimer;
function showToast(message, tone = 'success') {
  const toast = document.querySelector('#toast');
  toast.className = `toast visible ${tone}`;
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function excelColumnName(index) {
  let result = '';
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function buildWorksheetXml(columns, rows) {
  const columnSettings = columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`).join('');
  const allRows = [Object.fromEntries(columns.map(column => [column.key, column.header])), ...rows];
  const sheetRows = allRows.map((row, rowIndex) => {
    const cells = columns.map((column, columnIndex) => {
      const reference = `${excelColumnName(columnIndex)}${rowIndex + 1}`;
      const value = row[column.key] ?? '';
      if (rowIndex > 0 && typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${reference}"><v>${value}</v></c>`;
      }
      return `<c r="${reference}" t="inlineStr" s="${rowIndex === 0 ? 1 : 0}"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="22" customHeight="1"' : ''}>${cells}</row>`;
  }).join('');
  const lastColumn = excelColumnName(columns.length - 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
      <cols>${columnSettings}</cols>
      <sheetData>${sheetRows}</sheetData>
      <autoFilter ref="A1:${lastColumn}${Math.max(1, allRows.length)}"/>
    </worksheet>`;
}

function buildWorkbookFiles(sheets) {
  const contentOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const workbookRelations = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${contentOverrides}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelations}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF286FB4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = buildWorksheetXml(sheet.columns, sheet.rows);
  });
  return files;
}

async function exportSelectedRecord() {
  const button = document.querySelector('#export-record-button');
  if (!state.selectedRecord) {
    showToast('当前没有可导出的生产记录', 'danger');
    return;
  }
  button.disabled = true;
  const record = state.selectedRecord;
  const summary = [{
    日期: record.date,
    总产量: record.output,
    平均速度_UP每H: record.averageSpeed,
    报警次数: record.alarms
  }];
  const batchRows = record.batches.map(([id, target, actual, status]) => ({ 批次编号: id, 目标数量: target, 实际数量: actual, 状态: status }));
  const hourlyRows = record.hours.map((hour, index) => ({ 时间: hour, 产量: record.outputs[index], 实际速度_UP每H: record.speeds[index] }));
  try {
    const { strToU8, zipSync } = await import('fflate');
    const sheets = [
      {
        name: '每日汇总',
        columns: [
          { header: '日期', key: '日期', width: 16 },
          { header: '总产量', key: '总产量', width: 14 },
          { header: '平均速度 UP/H', key: '平均速度_UP每H', width: 18 },
          { header: '报警次数', key: '报警次数', width: 14 }
        ],
        rows: summary
      },
      {
        name: '批次记录',
        columns: [
          { header: '批次编号', key: '批次编号', width: 20 },
          { header: '目标数量', key: '目标数量', width: 14 },
          { header: '实际数量', key: '实际数量', width: 14 },
          { header: '状态', key: '状态', width: 14 }
        ],
        rows: batchRows
      },
      {
        name: '每小时明细',
        columns: [
          { header: '时间', key: '时间', width: 14 },
          { header: '产量', key: '产量', width: 14 },
          { header: '实际速度 UP/H', key: '实际速度_UP每H', width: 18 }
        ],
        rows: hourlyRows
      }
    ];
    const workbookFiles = buildWorkbookFiles(sheets);
    const zippedFiles = Object.fromEntries(Object.entries(workbookFiles).map(([path, content]) => [path, strToU8(content)]));
    const buffer = zipSync(zippedFiles, { level: 6 });
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `按键组装机生产记录_${record.date}.xlsx`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出 ${record.date} 生产记录`);
  } catch {
    showToast('导出失败，请重新尝试', 'danger');
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => switchPage(button.dataset.page)));
document.querySelectorAll('[data-go-alarms]').forEach(button => button.addEventListener('click', () => switchPage('alarms')));
document.querySelectorAll('[data-param-tab]').forEach(button => button.addEventListener('click', () => {
  state.parameterTab = button.dataset.paramTab;
  document.querySelectorAll('[data-param-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
  renderParameterContent();
}));
['alarm-date-filter', 'alarm-station-filter', 'alarm-code-filter'].forEach(id => document.querySelector(`#${id}`).addEventListener('change', () => {
  if (!state.historyService.available) {
    renderAlarmHistory();
    return;
  }
  refreshAlarmHistory({
    date: document.querySelector('#alarm-date-filter').value,
    station: document.querySelector('#alarm-station-filter').value,
    code: document.querySelector('#alarm-code-filter').value
  });
}));
document.querySelector('#alarm-filter-reset').addEventListener('click', () => {
  document.querySelector('#alarm-date-filter').value = '';
  document.querySelector('#alarm-station-filter').value = '';
  document.querySelector('#alarm-code-filter').value = '';
  refreshAlarmHistory();
});
document.querySelector('#export-record-button').addEventListener('click', exportSelectedRecord);
document.querySelector('#daily-record-body').addEventListener('click', event => {
  const row = event.target.closest('[data-record-date]');
  if (!row) return;
  const date = row.dataset.recordDate;
  loadSelectedHistoryRecord(date).then(renderDailyRecords).catch(error => {
    showToast(`读取历史明细失败：${error.message}`, 'danger');
  });
});
document.querySelector('#daily-record-body').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('[data-record-date]');
  if (row) row.click();
});
document.querySelector('#fullscreen-button').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch {
    showToast('浏览器未允许进入全屏', 'danger');
  }
});

window.addEventListener('resize', () => {
  outputChart?.resize();
  speedChart?.resize();
  recordChart?.resize();
});

updateAlarmFilterOptions();
updateHistoryServiceDisplay();

renderParameterContent();
renderDailyRecords();
initOverviewCharts();
const cameraWeb = document.querySelector('#camera-web');
const cameraUnavailable = document.querySelector('#camera-unavailable');
const showCameraUnavailable = () => {
  cameraUnavailable.hidden = false;
};
cameraWeb.addEventListener('load', () => {
  cameraUnavailable.hidden = true;
});
cameraWeb.addEventListener('error', showCameraUnavailable);
cameraWeb.src = cameraWebUrl;
updateAlarmDisplays();
updateAll(false);
connectMqttTelemetry();
loadHistoryData();
setInterval(updateClock, 1000);
setInterval(checkMqttFreshness, 1000);
setInterval(() => {
  if (state.historyService.available) loadHistoryData();
}, 30000);
