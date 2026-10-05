import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth, sameOrigin } from './auth.js';
import { config, isLoopback } from './config.js';
import { Manager } from './manager.js';
import { Monitor } from './monitor.js';
import { createApi, createOAuthCallback } from './routes.js';
import { DockerRunner } from './runners/docker.js';
import { SimulationRunner } from './runners/simulation.js';
import { Store } from './store.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function pickRunner() {
  if (config.runner === 'simulation') return new SimulationRunner();
  const dockerReady = await DockerRunner.isAvailable(config);
  if (dockerReady) return new DockerRunner(config);
  if (config.runner === 'docker') {
    throw new Error('RUNNER=docker but Docker is not available. Install/start Docker or use RUNNER=simulation.');
  }
  console.warn('Docker not found: running in SIMULATION mode. No real cBots will run.');
  return new SimulationRunner();
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`Node.js ${process.versions.node} is too old. Install the current LTS version from https://nodejs.org (22 or newer).`);
  }
  if (!config.dashboardPassword && !isLoopback(config.host)) {
    throw new Error('Set DASHBOARD_PASSWORD before making the dashboard reachable from other machines (HOST is not 127.0.0.1).');
  }

  await fs.mkdir(path.join(config.dataDir, 'bots'), { recursive: true });
  await fs.mkdir(path.join(config.dataDir, 'secrets'), { recursive: true, mode: 0o700 });

  const store = new Store(path.join(config.dataDir, 'db.json'));
  await store.load();
  const runner = await pickRunner();
  const manager = new Manager({ store, runner, maxLogLines: config.maxLogLines });
  await manager.init();
  const monitor = new Monitor({ file: path.join(config.dataDir, 'openapi.json'), config });
  await monitor.load();
  monitor.start();

  const auth = createAuth({ password: config.dashboardPassword });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', sameOrigin, createApi({ store, manager, monitor, config, auth }));
  app.get('/oauth/callback', createOAuthCallback({ monitor, auth }));
  app.use(express.static(publicDir));

  const server = app.listen(config.port, config.host, () => {
    console.log(`cTrader dashboard running at http://${config.host}:${config.port} (runner: ${runner.name})`);
  });

  const shutdown = async () => {
    server.close();
    monitor.stop();
    await manager.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
