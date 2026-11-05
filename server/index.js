import mqtt from 'mqtt';
import { createApiServer } from './api.js';
import { config, mqttUrl } from './config.js';
import { HistoryDatabase } from './database.js';
import { TelemetryProcessor } from './telemetryProcessor.js';

const database = new HistoryDatabase(config.databasePath);
const processor = new TelemetryProcessor(database);
const service = {
  startedAt: new Date().toISOString(),
  mqtt: 'connecting',
  lastMessageAt: null,
  messageCount: 0,
  lastError: null
};

database.cleanup({ ...config.retention });

const mqttOptions = {
  clientId: `project2_history_${Math.random().toString(16).slice(2)}`,
  reconnectPeriod: config.mqtt.reconnectPeriod,
  connectTimeout: 5000,
  clean: true
};
if (config.mqtt.username) mqttOptions.username = config.mqtt.username;
if (config.mqtt.password) mqttOptions.password = config.mqtt.password;

const mqttClient = mqtt.connect(mqttUrl(), mqttOptions);
mqttClient.on('connect', () => {
  service.mqtt = 'connected';
  mqttClient.subscribe(config.mqtt.topic, error => {
    if (error) service.lastError = error.message;
  });
});
mqttClient.on('reconnect', () => { service.mqtt = 'reconnecting'; });
mqttClient.on('close', () => { service.mqtt = 'offline'; });
mqttClient.on('error', error => {
  service.mqtt = 'error';
  service.lastError = error.message;
});
mqttClient.on('message', (topic, message) => {
  if (topic !== config.mqtt.topic) return;
  try {
    const payload = JSON.parse(message.toString());
    processor.processPayload(payload);
    service.lastMessageAt = new Date().toISOString();
    service.messageCount += 1;
    service.lastError = null;
  } catch (error) {
    service.lastError = `报文处理失败：${error.message}`;
  }
});

const apiServer = createApiServer({
  database,
  serviceStatus: () => ({
    startedAt: service.startedAt,
    mqtt: service.mqtt,
    topic: config.mqtt.topic,
    lastMessageAt: service.lastMessageAt,
    messageCount: service.messageCount,
    lastError: service.lastError,
    processor: processor.status()
  })
});

apiServer.listen(config.http.port, config.http.host, () => {
  console.log(`project2 history service listening at http://${config.http.host}:${config.http.port}`);
  console.log(`MQTT: ${mqttUrl()} topic=${config.mqtt.topic}`);
  console.log(`SQLite: ${database.databasePath}`);
});

const cleanupTimer = setInterval(() => {
  try {
    const result = database.cleanup({ ...config.retention });
    if (Object.values(result).some(count => count > 0)) console.log('history cleanup', result);
  } catch (error) {
    service.lastError = `清理失败：${error.message}`;
  }
}, config.retention.cleanupIntervalMs);

function shutdown(signal) {
  console.log(`收到 ${signal}，正在停止历史服务`);
  clearInterval(cleanupTimer);
  mqttClient.end(true);
  apiServer.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
