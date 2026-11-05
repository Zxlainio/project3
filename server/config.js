import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, '..');

function text(name, fallback) {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const config = {
  projectRoot,
  timezone: 'Asia/Shanghai',
  mqtt: {
    host: text('MQTT_HOST', '127.0.0.1'),
    port: integer('MQTT_PORT', 1883),
    topic: text('MQTT_TOPIC', 'device/esp32-s3/property'),
    username: text('MQTT_USERNAME', ''),
    password: text('MQTT_PASSWORD', ''),
    reconnectPeriod: integer('MQTT_RECONNECT_PERIOD_MS', 3000)
  },
  http: {
    host: text('HISTORY_HOST', '127.0.0.1'),
    port: integer('HISTORY_PORT', 8787)
  },
  databasePath: path.resolve(projectRoot, text('HISTORY_DB_PATH', path.join('data', 'project2.sqlite'))),
  retention: {
    longDays: integer('HISTORY_LONG_RETENTION_DAYS', 365),
    speedDays: integer('HISTORY_SPEED_RETENTION_DAYS', 90),
    cleanupIntervalMs: integer('HISTORY_CLEANUP_INTERVAL_MS', 6 * 60 * 60 * 1000)
  }
};

export function mqttUrl(settings = config.mqtt) {
  return `mqtt://${settings.host}:${settings.port}`;
}
