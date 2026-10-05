import path from 'node:path';

// Load settings from a .env file next to where the dashboard is started, if there is one.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on real environment variables and defaults.
}

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || './data');

export const config = Object.freeze({
  port: Number(env.PORT) || 3000,
  host: env.HOST || '127.0.0.1',
  dataDir,
  // Bind-mount sources must be host paths, which differ from dataDir when the
  // dashboard itself runs in a container that talks to the host's Docker daemon.
  hostDataDir: env.HOST_DATA_DIR ? path.resolve(env.HOST_DATA_DIR) : dataDir,
  runner: (env.RUNNER || 'auto').toLowerCase(),
  dockerBin: env.DOCKER_BIN || 'docker',
  ctraderImage: env.CTRADER_IMAGE || 'ghcr.io/spotware/ctrader-console:latest',
  dashboardPassword: env.DASHBOARD_PASSWORD || '',
  // cTrader Open API (read-only account monitor). Demo server only.
  openApiUrl: env.OPENAPI_URL || 'wss://demo.ctraderapi.com:5036',
  openApiAuthBase: env.OPENAPI_AUTH_BASE || 'https://id.ctrader.com',
  openApiTokenUrl: env.OPENAPI_TOKEN_URL || 'https://openapi.ctrader.com/apps/token',
  maxLogLines: 1000,
  maxBotUploadBytes: 50 * 1024 * 1024,
});

export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
