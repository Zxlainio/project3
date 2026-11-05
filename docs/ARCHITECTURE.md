# 架构与代码入口

## 当前链路

PLC -> RS485/Modbus -> ESP32-S3 Upload0913 -> 本地 EMQX。
EMQX 分别向浏览器 MQTT WebSocket 和 Node.js 历史服务 MQTT TCP 提供数据。
历史服务写 SQLite，网页通过 HTTP API 查询历史；关闭浏览器不影响仍在运行的历史服务。

- topic：device/esp32-s3/property；payload：params.<字段>.value。
- TCP 1883；WebSocket 8083；EMQX Dashboard 18083。
- 现场电脑与 ESP32 使用同一局域网；当前电脑为 `192.168.1.119`，IP、串口和监听状态每次联调重新确认。
- 约 1 秒完整发布；5 秒无有效数据离线，连续 2 条有效数据恢复。
- SQLite 默认 `data/project2.sqlite`（历史兼容文件名）；服务默认 `127.0.0.1:8787`。
- Node.js 26.3.0 / node:sqlite；前端 Vite、原生 JavaScript、ECharts、Lucide、MQTT.js、fflate。
- 浏览器实时和服务器历史各有数据来源，不用样例数据掩盖通信失败。

## 定位入口

| 工作内容 | 首先检查 |
| --- | --- |
| 页面与实时 MQTT | src/main.js |
| 状态与批次规则 | src/businessRules.js |
| 历史 API 客户端 | src/historyApi.js |
| IO 名称目录 | src/liveCatalog.js |
| 布局 | src/style.css |
| MQTT 历史采集 | server/index.js、server/telemetryProcessor.js |
| SQLite 与持久状态 | server/database.js |
| HTTP 路由与配置 | server/api.js、server/config.js |
| 规则与历史测试 | tests/businessRules.test.mjs、tests/historyService.test.mjs |

## 历史统计约定

- metadata、batches、hourly_production、speed_samples、alarm_events 五张表。
- 首条有效报文建基线；不伪造采集前或停机缺口中的历史。
- HD40 有效正向增量累计小时产量；连续两条零确认批次切换。
- 批次可跨日，重启恢复批次和报警边沿状态。
- M9 的 1->0、T 的 0->1 为报警触发；持续报警不重复写入。
- 速度每分钟最后一个有效 HD62；批次/小时/报警保留 365 天，速度 90 天。
- 启动及每 6 小时清理；日历按 Asia/Shanghai，时间戳用 UTC ISO。
- API 健康状态、筛选参数、配置、启动与备份操作以 [README](../README.md) 为唯一详细操作说明。
- 以上为现有实施记录中的约定，不替代代码审查和现场验收。
