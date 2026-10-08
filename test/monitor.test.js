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
  assert.equal(saved.logins[0].accessToken, 'access-1');
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

test('several cTrader ID logins show all their demo accounts', async (t) => {
  const { monitor, dir } = await setup(t);
  await connect(monitor);
  monitor.beginLogin('x');
  await monitor.finishLogin({ code: 'code-2', redirectUri: 'x' });
  let snap = await waitFor(monitor, (s) => s.state === 'connected' && s.accounts.length === 3 && s.accounts.every((a) => a.updatedAt));
  assert.equal(snap.logins.length, 2);
  assert.deepEqual(snap.logins[1].accounts, [7001234]);
  assert.equal(snap.accounts.find((a) => a.login === 7001234).bots[0].name, 'GoldBot');
  assert.ok(!JSON.stringify(snap).includes('access-'), 'tokens never leave the server');

  // Logging in again with the same cTrader ID does not duplicate it.
  monitor.beginLogin('x');
  await monitor.finishLogin({ code: 'code-2', redirectUri: 'x' });
  snap = await waitFor(monitor, (s) => s.state === 'connected' && s.logins.length === 2 && s.accounts.length === 3);

  await monitor.removeLogin(snap.logins[1].id);
  snap = await waitFor(monitor, (s) => s.state === 'connected' && s.accounts.length === 2);
  assert.ok(!snap.accounts.some((a) => a.login === 7001234));
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'openapi.json'), 'utf8'));
  assert.equal(saved.logins.length, 1);
});

test('upgrades a single-login settings file from the previous version', async (t) => {
  const fake = await startFakeCtrader();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctdash-mon-'));
  const file = path.join(dir, 'openapi.json');
  await fs.writeFile(file, JSON.stringify({ clientId: 'app-1', clientSecret: 'secret-123', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 1e9 }));
  const monitor = new Monitor({ file, config: fake.config });
  t.after(async () => { monitor.stop(); await fake.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await monitor.load();
  monitor.start();
  const snap = await waitFor(monitor, (s) => s.state === 'connected' && s.accounts.length === 2);
  assert.equal(snap.logins.length, 1);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).accessToken, undefined);
});

test('accounts can be named, and names reach the CSV', async (t) => {
  const { monitor, dir } = await setup(t);
  await connect(monitor);
  await monitor.setAccountMeta('101', { name: 'Gold scalper test', algorithm: 'GridScalper v2' });
  const snap = await waitFor(monitor, (s) => s.accounts.find((a) => a.id === '101')?.name === 'Gold scalper test');
  assert.equal(snap.accounts.find((a) => a.id === '101').algorithm, 'GridScalper v2');
  const csv = await monitor.exportHistoryCsv('101');
  assert.ok(csv.split('\r\n')[1].includes(',Gold scalper test,GridScalper v2,'));
  // Names survive a restart.
  const again = new Monitor({ file: path.join(dir, 'openapi.json'), config: {} });
  await again.load();
  assert.equal(again.meta['101'].name, 'Gold scalper test');
  await monitor.setAccountMeta('101', { name: '', algorithm: '' });
  assert.equal(monitor.meta['101'], undefined);
  await assert.rejects(monitor.setAccountMeta('999', { name: 'x', algorithm: '' }), /not found/);
});

test('chart data combines cTrader balance history with recorded equity', async (t) => {
  const { monitor } = await setup(t);
  await connect(monitor);
  await new Promise((r) => setTimeout(r, 50)); // let the first equity sample land
  const data = await monitor.chart('101', 'all');
  assert.equal(data.currency, 'USD');
  assert.ok(data.balance.length >= 40, 'balance history reaches back through closed trades');
  assert.equal(data.balance.at(-1)[1], 10123.45);
  assert.ok(data.equity.length >= 1);
  assert.equal(data.equity.at(-1)[1], 10151.85);
});

test('account cards carry live growth and drawdown figures', async (t) => {
  const { monitor } = await setup(t);
  await connect(monitor);
  const snap = await waitFor(monitor, (s) => s.accounts.find((a) => a.id === '101')?.performance?.growthPct !== null);
  const perf = snap.accounts.find((a) => a.id === '101').performance;
  assert.equal(perf.floatingPct, 0.28); // 28.40 on 10,123.45
  assert.equal(perf.closedTodayPct, 0.99); // 99 on a 10,024.45 balance before it = 0.988%
  assert.ok(perf.peakEquity >= 10151.85);
  assert.ok(perf.maxDrawdownPct >= perf.currentDrawdownPct);
  assert.equal(typeof perf.growthPct, 'number');
  // Trade quality: 40 history trades (every 4th a loser) + 1 closed today, all longs.
  assert.equal(perf.trades.count, 41);
  assert.equal(perf.trades.winRatePct, 75.61); // 31 of 41
  assert.equal(typeof perf.trades.profitFactor, 'number');
  assert.equal(perf.trades.shortPF, null);
  assert.equal(typeof perf.trades.avgPips, 'number');
  assert.ok('value' in perf.sharpe);
});

test('figures are calculated for logins added while a calculation is running', async (t) => {
  const { monitor } = await setup(t);
  await connect(monitor);
  // Add the second login immediately, while the first round of figures is still being worked out.
  monitor.beginLogin('x');
  await monitor.finishLogin({ code: 'code-2', redirectUri: 'x' });
  const snap = await waitFor(monitor, (s) => s.accounts.length === 3 && s.accounts.every((a) => a.performance?.trades), 15000);
  assert.ok(snap.accounts.every((a) => a.performance.trades.count >= 0));
});

test('a failing figures calculation is reported instead of "Calculating…" forever', async (t) => {
  const { monitor, fake } = await setup(t);
  await connect(monitor);
  // Make cTrader refuse deal history from now on.
  monitor.history.loading.clear();
  const original = monitor.client.request.bind(monitor.client);
  monitor.client.request = (type, payload) => (type === 2133 ? Promise.reject(new Error('Deal history refused')) : original(type, payload));
  await fs.rm(path.join(path.dirname(monitor.file), 'history'), { recursive: true, force: true });
  monitor.stats.clear();
  monitor.refreshStats();
  const snap = await waitFor(monitor, (s) => s.accounts.find((a) => a.id === '101')?.performance?.statsError);
  const acc = snap.accounts.find((a) => a.id === '101');
  assert.equal(acc.performance.statsError, 'Deal history refused');
  assert.equal(acc.performance.growthPct, null);
  void fake;
});

test('stays within cTrader\'s history rate limit, so figures calculate for every account', async (t) => {
  const fake = await startFakeCtrader({ rateLimit: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctdash-rl-'));
  const monitor = new Monitor({ file: path.join(dir, 'openapi.json'), config: fake.config });
  t.after(async () => { monitor.stop(); await fake.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await monitor.load();
  await connect(monitor);
  monitor.beginLogin('x');
  await monitor.finishLogin({ code: 'code-2', redirectUri: 'x' });
  // Meanwhile the regular refresh also reads today's deals for every account at once.
  monitor.refreshAll();
  const snap = await waitFor(monitor, (s) => s.accounts.length === 3 && s.accounts.every((a) => a.performance?.trades), 30000);
  assert.ok(snap.accounts.every((a) => !a.performance.statsError));
  assert.ok(!fake.log.includes('rate-limited'), 'never went over the limit');
});

test('live market chart: candles from cTrader, updated by live ticks, with open trades marked', async (t) => {
  const { monitor } = await setup(t);
  await connect(monitor);
  monitor.beginLogin('x');
  await monitor.finishLogin({ code: 'code-2', redirectUri: 'x' });
  await waitFor(monitor, (s) => s.state === 'connected' && s.accounts.length === 3);
  // Wait for the first live tick.
  await new Promise((resolve) => monitor.once('price', resolve));
  const view = await monitor.marketView('m15');
  assert.equal(view.symbol, 'AUDCAD');
  assert.equal(view.digits, 5);
  assert.ok(view.candles.length >= 100);
  const [time, open, high, low, close] = view.candles.at(-1);
  assert.ok(high >= Math.max(open, close) && low <= Math.min(open, close), 'valid OHLC');
  assert.equal(close, view.bid, 'last candle follows the live bid');
  assert.ok(time <= Date.now());
  assert.deepEqual(view.positions.map((p) => [p.side, p.price, p.label]), [['Sell', 0.9903, 'MRZ_Short']]);
  await assert.rejects(monitor.marketView('m7'), /Unknown timeframe/);
});
