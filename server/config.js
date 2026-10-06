import path from 'node:path';

// Load settings from a .env file next to where the dashboard is started, if there is one.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on real environment variables and defaults.
}

const env = process.env;
// Hosted on Railway (railway.com): storage, web address and proxy are detected automatically.
const hosted = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME);
const dataDir = path.resolve(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || './data');

export const config = Object.freeze({
  port: Number(env.PORT) || 3000,
  host: env.HOST || '127.0.0.1',
  dataDir,
  // Bind-mount sources must be host paths, which differ from dataDir when the
  // dashboard itself runs in a container that talks to the host's Docker daemon.
  hostDataDir: env.HOST_DATA_DIR ? path.resolve(env.HOST_DATA_DIR) : dataDir,
  // 'none' hides the "Run bots" part (cBots then run elsewhere, e.g. cTrader Cloud).
  runner: (env.RUNNER || (hosted ? 'none' : 'auto')).toLowerCase(),
  hosted,
  // Behind a hosting proxy (HTTPS ends at the proxy), trust its X-Forwarded-* headers.
  trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || (hosted ? 'true' : '')),
  // Public address of the dashboard, used for cTrader's login redirect.
  publicUrl: (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, ''),
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
