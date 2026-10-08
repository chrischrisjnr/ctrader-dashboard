import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downsample, EquityHistory, performanceStats } from '../server/equity.js';

test('downsample keeps the end point and extremes', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => [i * 1000, Math.sin(i / 50) * 100 + (i === 2500 ? -900 : 0)]);
  const out = downsample(pts, 600, 'minmax');
  assert.ok(out.length <= 602);
  assert.deepEqual(out.at(-1), pts.at(-1));
  assert.ok(out.some((p) => p[1] < -800), 'a sharp drawdown must survive thinning');
  const last = downsample(pts, 100, 'last');
  assert.ok(last.length <= 101);
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] > out[i - 1][0], 'times strictly increase');
});

test('balance comes from closing deals, equity from samples, both clipped to the range', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctdash-eq-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const now = Date.UTC(2026, 9, 6);
  const day = 86_400_000;
  let calls = 0;
  const deals = [
    { executionTimestamp: now - 40 * day, moneyDigits: 2, closePositionDetail: { balance: 100_000, grossProfit: 2_500, swap: -100, commission: -400, moneyDigits: 2 } },
    { executionTimestamp: now - 20 * day, moneyDigits: 2 }, // opening deal: no balance
    { executionTimestamp: now - 10 * day, moneyDigits: 2, closePositionDetail: { balance: 105_000, moneyDigits: 2 } },
  ];
  const request = async (_type, p) => {
    calls += 1;
    return { deal: deals.filter((d) => d.executionTimestamp >= p.fromTimestamp && d.executionTimestamp <= p.toTimestamp), hasMore: false };
  };
  const acc = { id: '7', numericId: 7, registeredAt: now - 60 * day, balance: 1060, equity: 1072.5, currency: 'USD', moneyDigits: 2 };
  const eq = new EquityHistory(dir);
  await eq.record('7', now - 2 * day, 1050, 1040);
  await eq.record('7', now - day, 1060, 1081);

  const all = await eq.chart(acc, request, 'all', now);
  // Starts at the opening deposit: 1000 after the first trade minus its +20 result.
  assert.deepEqual(all.balance.map((p) => p[1]), [980, 1000, 1050, 1050, 1060, 1060]);
  assert.deepEqual(all.balance[0], [now - 60 * day, 980]);
  assert.equal(all.stats.startValue, 980);
  // Performance uses balance before equity recording, then equity: 980 ... 1050 | 1040, 1081, 1072.5
  assert.equal(all.stats.peak.v, 1081);
  assert.equal(all.stats.growthPct, 9.44); // 1072.5 / 980 - 1
  assert.equal(all.stats.maxDrawdownPct, 0.95); // 1050 -> 1040
  assert.equal(all.stats.currentDrawdownPct, 0.79); // 1081 -> 1072.5
  assert.equal(all.balance.at(-1)[1], 1060);
  assert.deepEqual(all.equity, [[now - 2 * day, 1040], [now - day, 1081], [now, 1072.5]]);
  assert.equal(all.equitySince, now - 2 * day);

  const week = await eq.chart(acc, request, '1w', now);
  assert.deepEqual(week.balance[0], [now - 7 * day, 1050], 'step value carried into the range');
  assert.equal(week.from, now - 7 * day);

  // Second load only fetches new deals (from the cached point onwards).
  const before = calls;
  await eq.chart(acc, request, '1m', now + 1000);
  assert.ok(calls - before <= 1);
});

test('performance stats: growth, peak and drawdowns', () => {
  const st = performanceStats([[1, 100], [2, 120], [3, 90], [4, 130], [5, 117]]);
  assert.equal(st.growthPct, 17);
  assert.deepEqual(st.peak, { t: 4, v: 130 });
  assert.equal(st.maxDrawdownPct, 25); // 120 -> 90
  assert.deepEqual(st.maxDrawdown, { peak: { t: 2, v: 120 }, trough: { t: 3, v: 90 } });
  assert.equal(st.currentDrawdownPct, 10); // 130 -> 117
  assert.equal(performanceStats([]), null);
  const flat = performanceStats([[1, 50], [2, 50]]);
  assert.equal(flat.maxDrawdownPct, 0);
  assert.equal(flat.maxDrawdown, null);
});

test('trade stats: profit factor (overall, long, short), win rate and pips', async () => {
  const { tradeStats, dailySharpe } = await import('../server/equity.js');
  const symbols = new Map([[1, { pipPosition: 4 }]]);
  // [time, net, closedLong, symbol, entry, exit]
  const closes = [
    [1, 100, 1, 1, 1.0800, 1.0810], // long +10 pips
    [2, -50, 1, 1, 1.0800, 1.0795], // long -5 pips
    [3, 200, 0, 1, 1.0900, 1.0880], // short +20 pips
    [4, -25, 0, 1, 1.0900, 1.0905], // short -5 pips
  ];
  const st = tradeStats(closes, symbols);
  assert.equal(st.count, 4);
  assert.equal(st.winRatePct, 50);
  assert.equal(st.profitFactor, 4); // 300 / 75
  assert.equal(st.longPF, 2); // 100 / 50
  assert.equal(st.shortPF, 8); // 200 / 25
  assert.equal(st.avgPips, 5); // (10 - 5 + 20 - 5) / 4
  assert.equal(tradeStats([[1, 10, 1, 1, 1, 1]]).profitFactor, '∞');
  assert.equal(tradeStats([]).profitFactor, null);

  // Sharpe from weekday closes: a steady rise with small wobbles gives a high positive Sharpe.
  const day = 86_400_000;
  const monday = Date.UTC(2026, 8, 7);
  const pts = [];
  let v = 100;
  for (let i = 0; i < 21; i++) {
    v *= 1 + 0.002 + (i % 2 ? 0.001 : -0.001);
    pts.push([monday + i * day + 20 * 3600_000, v]);
  }
  const sharpe = dailySharpe(pts);
  assert.equal(sharpe.days, 14); // 15 weekdays -> 14 daily changes; weekends ignored
  assert.ok(sharpe.value > 10);
  assert.equal(dailySharpe(pts.slice(0, 4)).value, null, 'too few days');
});

test('live ticks extend the current candle or start a new one', async () => {
  const { updateBars } = await import('../server/market.js');
  const bars = [[0, 1.0, 1.1, 0.9, 1.05]];
  updateBars(bars, 60_000, 30_000, 1.2); // same minute: new high, close moves
  assert.deepEqual(bars, [[0, 1.0, 1.2, 0.9, 1.2]]);
  updateBars(bars, 60_000, 30_000, 0.8); // new low
  assert.deepEqual(bars[0], [0, 1.0, 1.2, 0.8, 0.8]);
  updateBars(bars, 60_000, 185_000, 0.85); // three minutes later: new candle at its period start
  assert.deepEqual(bars[1], [180_000, 0.85, 0.85, 0.85, 0.85]);
  updateBars(bars, 60_000, 10_000, 5); // a stale tick is ignored
  assert.equal(bars.length, 2);
  assert.equal(bars[1][2], 0.85);
});
