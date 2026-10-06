import fs from 'node:fs/promises';
import path from 'node:path';
import { accountStart, fetchDeals, throttled } from './history.js';

const MAX_POINTS = 600;
export const RANGES = { '1d': 86_400_000, '1w': 7 * 86_400_000, '1m': 30 * 86_400_000, '3m': 91 * 86_400_000, all: Infinity };

const money = (value, digits) => (Number(value) || 0) / 10 ** digits;

/**
 * Balance & equity history per account.
 * - Balance comes from cTrader itself: every closing deal reports the balance after it,
 *   so the curve goes back to the day the account was opened. Cached and topped up.
 * - Equity is not stored by cTrader, so the dashboard samples it while running.
 */
export class EquityHistory {
  constructor(dir) {
    this.dir = dir;
    this.loading = new Map(); // accountId -> in-flight balance refresh
  }

  file(accountId, kind) {
    return path.join(this.dir, `${String(accountId).replace(/\W/g, '')}-${kind}`);
  }

  /** Appends one equity sample ("time,balance,equity"). */
  async record(accountId, t, balance, equity) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.file(accountId, 'equity.csv'), `${t},${balance},${equity}\n`);
  }

  async samples(accountId) {
    let text;
    try {
      text = await fs.readFile(this.file(accountId, 'equity.csv'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of text.split('\n')) {
      const [t, b, e] = line.split(',').map(Number);
      if (Number.isFinite(t) && Number.isFinite(b) && Number.isFinite(e)) out.push([t, b, e]);
    }
    return out;
  }

  /** Balance after every closed trade, fetched from cTrader once and then topped up. */
  balancePoints(acc, rawRequest, now = Date.now()) {
    const running = this.loading.get(acc.id);
    if (running) return running;
    const task = (async () => {
      const file = this.file(acc.id, 'balance.json');
      let cache = { through: 0, points: [] };
      try {
        cache = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const from = cache.through ? cache.through + 1 : accountStart(acc, now);
      const deals = await fetchDeals(throttled(rawRequest), acc, from, now);
      const seen = new Set(cache.points.map((p) => p[0]));
      for (const d of deals) {
        const cpd = d.closePositionDetail;
        if (!cpd || cpd.balance === undefined || seen.has(d.executionTimestamp)) continue;
        cache.points.push([d.executionTimestamp, money(cpd.balance, cpd.moneyDigits ?? d.moneyDigits ?? acc.moneyDigits ?? 2)]);
      }
      cache.points.sort((a, b) => a[0] - b[0]);
      cache.through = now;
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(cache));
      return cache.points;
    })().finally(() => this.loading.delete(acc.id));
    this.loading.set(acc.id, task);
    return task;
  }

  /** Builds both curves for a time range, downsampled for drawing. */
  async chart(acc, rawRequest, range = 'all', now = Date.now()) {
    const span = RANGES[range] ?? Infinity;
    const [dealPoints, samples] = await Promise.all([this.balancePoints(acc, rawRequest, now), this.samples(acc.id)]);
    const balance = mergeByTime([...dealPoints, ...samples.map(([t, b]) => [t, b]), [now, acc.balance]]);
    const equity = [...samples.map(([t, , e]) => [t, e]), [now, acc.equity]];
    const start = span === Infinity ? Math.min(balance[0]?.[0] ?? now, equity[0]?.[0] ?? now) : now - span;
    return {
      currency: acc.currency || '',
      from: start,
      to: now,
      equitySince: samples[0]?.[0] ?? null,
      balance: downsample(clip(balance, start, true), MAX_POINTS, 'last'),
      equity: downsample(clip(equity, start, false), MAX_POINTS, 'minmax'),
    };
  }
}

function mergeByTime(points) {
  const sorted = points.filter((p) => Number.isFinite(p[1])).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const p of sorted) {
    if (out.length && out[out.length - 1][0] === p[0]) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Points inside the range; a step series also keeps its value at the range start. */
function clip(points, start, carryIn) {
  const inside = points.filter((p) => p[0] >= start);
  if (carryIn) {
    const before = points.filter((p) => p[0] < start).pop();
    if (before) inside.unshift([start, before[1]]);
  }
  return inside;
}

/** Thins a series to about `max` points, keeping each bucket's last value (or its low and high). */
export function downsample(points, max, mode) {
  if (points.length <= max) return points;
  const perBucket = mode === 'minmax' ? max / 2 : max;
  const t0 = points[0][0];
  const width = (points[points.length - 1][0] - t0) / perBucket || 1;
  const buckets = new Map();
  for (const p of points) {
    const key = Math.min(Math.floor((p[0] - t0) / width), perBucket - 1);
    const b = buckets.get(key);
    if (!b) buckets.set(key, { min: p, max: p, last: p });
    else {
      if (p[1] < b.min[1]) b.min = p;
      if (p[1] > b.max[1]) b.max = p;
      b.last = p;
    }
  }
  const out = [];
  for (const b of buckets.values()) {
    if (mode === 'minmax') out.push(...(b.min[0] <= b.max[0] ? [b.min, b.max] : [b.max, b.min]));
    else out.push(b.last);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return mergeByTime(out);
}
