import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CSV_COLUMNS } from '../server/history.js';
import { Monitor } from '../server/monitor.js';
import { startFakeCtrader } from './helpers/fake-ctrader.js';

async function setup(t) {
  const fake = await startFakeCtrader();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctdash-mon-'));
  const monitor = new Monitor({ file: path.join(dir, 'openapi.json'), config: fake.config });
  await monitor.load();
  t.after(async () => {
    monitor.stop();
    await fake.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { fake, dir, monitor };
}

function waitFor(monitor, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; state=${monitor.state} error=${monitor.error}`)), timeoutMs);
    const check = () => {
      const snap = monitor.snapshot();
      if (predicate(snap)) {
        clearTimeout(timer);
        monitor.off('update', check);
        resolve(snap);
      }
    };
    monitor.on('update', check);
    check();
  });
}

async function connect(monitor) {
  await monitor.saveCredentials({ clientId: 'app-1', clientSecret: 'secret-123' });
  assert.equal(monitor.state, 'needs_login');
  const url = new URL(monitor.beginLogin('http://127.0.0.1:3000/oauth/callback'));
  assert.equal(url.searchParams.get('scope'), 'accounts', 'must request read-only access');
  await monitor.finishLogin({ code: 'good-code', redirectUri: 'http://127.0.0.1:3000/oauth/callback' });
  return waitFor(monitor, (s) => s.state === 'connected' && s.accounts.every((a) => a.updatedAt));
}

test('setup flow: credentials, login, then live account data', async (t) => {
  const { monitor, dir } = await setup(t);
  assert.equal(monitor.state, 'not_configured');
  const snap = await connect(monitor);

  assert.equal(snap.accounts.length, 2, 'only demo accounts are shown');
  assert.equal(snap.hiddenLiveAccounts, 1);
  const ic = snap.accounts.find((a) => a.login === 5123456);
  assert.equal(ic.currency, 'USD');
  assert.equal(ic.balance, 10123.45);
  assert.equal(ic.floating, 28.4);
  assert.equal(ic.equity, 10151.85);
  assert.deepEqual(ic.closedToday, { pnl: 99, count: 1 });
  assert.deepEqual(ic.bots.map((b) => [b.name, b.trades]), [['TrendFollower', 2], ['GridScalper', 1]]);
  const eur = ic.positions.find((p) => p.symbol === 'EURUSD');
  assert.equal(eur.lots, 0.1);
  assert.equal(eur.side, 'Buy');

  const saved = JSON.parse(await fs.readFile(path.join(dir, 'openapi.json'), 'utf8'));
  assert.equal(saved.accessToken, 'access-1');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'openapi.json'))).mode & 0o777, 0o600);
});

test('login fails cleanly with a bad code or without starting login first', async (t) => {
  const { monitor } = await setup(t);
  await monitor.saveCredentials({ clientId: 'app-1', clientSecret: 'secret-123' });
  await assert.rejects(monitor.finishLogin({ code: 'good-code', redirectUri: 'x' }), /Login expired/);
  monitor.beginLogin('x');
  await assert.rejects(monitor.finishLogin({ code: 'bad', redirectUri: 'x' }), /Bad code/);
});

test('exports full trade history as CSV with cBot labels', async (t) => {
  const { monitor, fake } = await setup(t);
  await connect(monitor);
  const csv = await monitor.exportHistoryCsv('101');
  assert.ok(csv.startsWith('\uFEFF'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  // 40 positions x (open + close) + 1 closed today; the rejected deal is skipped. Pagination forced window splitting.
  assert.equal(lines.length - 1, 81);
  assert.ok(fake.log.filter((t2) => t2 === 2133).length > 3, 'should page through history');
  const closes = lines.filter((l) => l.includes(',Close,'));
  assert.equal(closes.length, 41);
  assert.ok(lines.some((l) => l.includes('"TrendFollower, ""v2"""')), 'labels with commas/quotes are escaped');
  assert.ok(lines.some((l) => l.includes(',GridScalper,')));
  const times = lines.slice(1).map((l) => l.split(',')[3]);
  assert.deepEqual([...times].sort(), times, 'rows are in time order');

  const all = await monitor.exportHistoryCsv('all');
  assert.ok(all.includes("'=SUM(A1)"), 'formula-looking text is neutralised');
  assert.equal(all.trim().split('\r\n').length - 1, 161);
});

test('reconnects after the connection drops', async (t) => {
  const { monitor, fake } = await setup(t);
  await connect(monitor);
  monitor.retryDelay = 50;
  monitor.client.ws.close();
  await waitFor(monitor, (s) => s.state === 'connected' && fake.log.filter((x) => x === 2100).length >= 2);
  assert.ok(monitor.client && !monitor.client.closed);
});
