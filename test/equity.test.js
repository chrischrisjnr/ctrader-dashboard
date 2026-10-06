import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downsample, EquityHistory } from '../server/equity.js';

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
    { executionTimestamp: now - 40 * day, moneyDigits: 2, closePositionDetail: { balance: 100_000, moneyDigits: 2 } },
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
  assert.deepEqual(all.balance.map((p) => p[1]), [1000, 1050, 1050, 1060, 1060]);
  assert.deepEqual(all.balance[0], [now - 40 * day, 1000]);
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
