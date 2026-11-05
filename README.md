# 全自动按键组装机生产看板

`project3` 是信捷 `XD5-60T10-E` 全自动按键组装机的二维只读生产看板（由 project2 复制维护）。第 05 阶段增加了独立的 Node.js 历史数据服务：服务直接订阅本地 EMQX TCP，将统计结果保存到 SQLite；浏览器通过 MQTT over WebSocket 显示实时数据，并通过 HTTP API 读取历史数据。

## 架构

```text
PLC -> RS485/Modbus -> ESP32-S3 Upload0821 -> EMQX TCP 1883
                                                   |-> server/index.js -> SQLite
                                                   |-> browser MQTT WebSocket 8083 -> 实时看板
                                                   `-> browser HTTP /api -> 历史看板
```

网页只读，不包含 PLC 写入、启动、停止、清零或参数控制。

## 安装和运行

当前 Node.js 版本建议为 `26.3.0`，使用 Node 自带的 `node:sqlite`，不需要额外安装原生 SQLite 包。

### PowerShell 窗口 1：历史服务

```powershell
cd "D:\Wrokspace\科教项目\project3"
npm install
$env:MQTT_HOST="192.168.1.119"
$env:MQTT_PORT="1883"
$env:MQTT_TOPIC="device/esp32-s3/property"
$env:MQTT_USERNAME="你的EMQX用户名"
$env:MQTT_PASSWORD="你的EMQX密码"
npm run start:history
```

服务默认地址为 `http://127.0.0.1:8787`，数据库为：

`D:\Wrokspace\科教项目\project3\data\project2.sqlite`

电脑本机运行 EMQX 时，`MQTT_HOST=127.0.0.1` 即可；如果 EMQX 只监听电脑热点 IPv4，则把它改为当前 IPv4。账号和密码只通过环境变量传入，不写入源码。

### PowerShell 窗口 2：Vite 网页

```powershell
cd "D:\Wrokspace\科教项目\project3"
$env:VITE_MQTT_WS_URL="ws://192.168.1.119:8083/mqtt"
$env:VITE_MQTT_USERNAME="你的EMQX用户名"
$env:VITE_MQTT_PASSWORD="你的EMQX密码"
npm run dev -- --host 0.0.0.0 --port 5174
```

浏览器打开终端输出的地址，通常为 `http://localhost:5173/`。如果历史服务端口被改动，Vite 开发代理可使用：

```powershell
$env:HISTORY_PORT="8787"
npm run dev
```

网页 MQTT 地址默认根据网页所在主机生成 `ws://网页主机:8083/mqtt`。局域网访问或热点 IP 变化时，在启动 Vite 前设置：

```powershell
$env:VITE_MQTT_WS_URL="ws://电脑当前IPv4:8083/mqtt"
$env:VITE_MQTT_USERNAME="你的EMQX用户名"
$env:VITE_MQTT_PASSWORD="你的EMQX密码"
npm run dev -- --host 0.0.0.0 --port 5174
```

电脑重启后需要重新启动 EMQX、历史服务和 Vite；ESP32 如保持供电会自行重连，否则需要重新上电。停止服务时在对应窗口按 `Ctrl+C`。

## HTTP API

所有接口只支持 `GET`，返回 JSON。日期均按 `Asia/Shanghai` 自然日解释；数据库时间戳为 UTC ISO 字符串，分钟桶使用带 `+08:00` 的本地时间字符串。

| 接口 | 参数 | 作用 |
| --- | --- | --- |
| `GET /api/health` | 无 | 服务、MQTT、数据库计数、历史开始时间 |
| `GET /api/meta` | 无 | 时区、数据库路径、历史开始记录时间 |
| `GET /api/daily?from=YYYY-MM-DD&to=YYYY-MM-DD` | 必填 | 日期范围每日产量、平均速度、报警次数 |
| `GET /api/batches?date=YYYY-MM-DD` | 必填 | 指定日期批次 |
| `GET /api/hourly?date=YYYY-MM-DD` | 必填 | 指定日期每小时产量 |
| `GET /api/speeds?from=YYYY-MM-DD&to=YYYY-MM-DD` | 必填 | 日期范围分钟速度采样 |
| `GET /api/alarms` | `date` 或 `from/to`，可选 `station`、`code` | 报警历史筛选 |

例如：

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/api/health"
Invoke-RestMethod "http://127.0.0.1:8787/api/daily?from=2026-09-09&to=2026-09-09"
Invoke-RestMethod "http://127.0.0.1:8787/api/alarms?date=2026-09-09&code=T122"
```

非法日期、反向日期范围、未知工位和非法报警代码返回 HTTP `400`，SQL 查询使用参数化语句。

## SQLite 保存规则

数据库逻辑位于 `server/database.js`，统计处理位于 `server/telemetryProcessor.js`，HTTP 路由位于 `server/api.js`。

- `metadata`：历史开始时间、批次状态、报警边沿和触发计数，用于服务重启恢复。
- `batches`：批次编号、起止时间、目标、实际、不良和状态。
- `hourly_production`：本地日期、小时和该小时新增产量。
- `speed_samples`：分钟桶、采样时间和 HD62；同一分钟采用最后一个有效值。
- `alarm_events`：代码、触发时间、工位、已核准中文内容、PLC 地址和该代码触发计数。

不保存每秒完整原始 MQTT 报文。批次、小时产量、报警保存 1 年；速度保存 90 天。服务启动时和每 6 小时自动清理超期数据。`data/` 中的数据库、WAL 临时文件和日志已加入 `.gitignore`，正式备份时停止服务后复制整个 `data/` 目录。

首条有效 MQTT 报文只建立 HD40、报警和速度基线，不回填启动前历史。服务启动前发生的产量变化、速度和报警不会被编造。接口中的 `historyStartedAt` 是本机开始持续记录历史的时间。

HD40 规则沿用第 04 阶段：首次只建基线；正数后连续两条 `0` 才切换一次批次；重复 `0` 不重复建批次；离线期间不判断；当前批次可以跨自然日。小时产量只累计 HD40 的有效正向增量，不重复累加累计值。M9 仅在 `1 -> 0` 触发，T 报警仅在 `0 -> 1` 触发；报警保持期间不重复写入。

## 检查和测试

```powershell
cd "D:\Wrokspace\科教项目\project3"
npm run test:history
npm run test:rules
npm run build
```

`test:history` 使用内存 SQLite 和测试 payload，不依赖 PLC、ESP32 或 EMQX；覆盖批次、小时产量、分钟速度、报警边沿、重启恢复、跨日、清理和 API 参数校验。

确认 MQTT 正在写入数据库：

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/api/health"
Invoke-RestMethod "http://127.0.0.1:8787/api/daily?from=2026-09-09&to=2026-09-09"
```

健康接口中的 `service.mqtt` 应为 `connected`，`messageCount` 应持续增加；每日接口或速度接口出现新数据后，说明统计已经写入 SQLite。`mqtt=offline/error` 时先检查 EMQX、端口、防火墙、热点 IPv4 和账号密码。

## 前端数据行为

浏览器 MQTT 负责当前报警、实时生产指标和当前状态。SQLite API 负责生产记录、历史报警、每日/每小时图表和速度历史。历史服务停止或 API 不可用时，网页不会白屏，会显示“历史服务不可用”，历史表格显示无法读取；没有收到 MQTT 报文时，实时指标显示 `--`，不会生成占位数据。

## 验证边界

- 代码验证：历史服务测试、原有业务规则测试和生产构建通过。
- 测试数据验证：测试 payload 已写入临时 SQLite，并通过重启后的服务和 HTTP API 读回批次、小时产量、速度和 T122 报警。
- 页面验证：1920x1080、1366x768 四个页面均可打开，无横向溢出；历史服务停止时仍可显示看板并明确提示。
- 真实设备现场验证：本阶段未宣称完成。真实 EMQX、ESP32、PLC 的持续运行、账号配置和长期数据质量仍需在现场启动服务后复核。


