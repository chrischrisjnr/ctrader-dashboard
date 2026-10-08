import fs from 'node:fs/promises';
import path from 'node:path';
import { PT } from './ctrader/client.js';
import { accountStart, fetchDeals, throttled } from './history.js';

const MAX_POINTS = 600;
const CACHE_VERSION = 3;
const TRADING_DAYS_PER_YEAR = 252;
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
      let cache = { version: CACHE_VERSION, through: 0, start: null, points: [], closes: [] };
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (saved.version === CACHE_VERSION) cache = saved; // older caches lack newer fields: rebuild
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const from = cache.through ? cache.through + 1 : accountStart(acc, now);
      const deals = await fetchDeals(throttled(rawRequest), acc, from, now);
      const seen = new Set(cache.points.map((p) => p[0]));
      const closes = deals
        .filter((d) => d.closePositionDetail?.balance !== undefined && !seen.has(d.executionTimestamp))
        .sort((a, b) => a.executionTimestamp - b.executionTimestamp);
      for (const d of closes) {
        const cpd = d.closePositionDetail;
        const digits = cpd.moneyDigits ?? d.moneyDigits ?? acc.moneyDigits ?? 2;
        const after = money(cpd.balance, digits);
        if (cache.start === null && !cache.points.length) {
          // Starting balance = balance after the first closed trade minus that trade's result.
          const net = money((Number(cpd.grossProfit) || 0) + (Number(cpd.swap) || 0) + (Number(cpd.commission) || 0) + (Number(cpd.pnlConversionFee) || 0), digits);
          cache.start = Math.round((after - net) * 100) / 100;
        }
        cache.points.push([d.executionTimestamp, after]);
        // One closed trade: [time, net result, 1 if it closed a long, symbol, entry price, exit price]
        const net = money((Number(cpd.grossProfit) || 0) + (Number(cpd.swap) || 0) + (Number(cpd.commission) || 0) + (Number(cpd.pnlConversionFee) || 0), digits);
        const closedLong = d.tradeSide === 2 || d.tradeSide === 'SELL' ? 1 : 0; // a sell closes a long
        cache.closes.push([d.executionTimestamp, Math.round(net * 100) / 100, closedLong, d.symbolId, Number(cpd.entryPrice), Number(d.executionPrice)]);
      }
      cache.points.sort((a, b) => a[0] - b[0]);
      cache.through = now;
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(cache));
      return cache;
    })().finally(() => this.loading.delete(acc.id));
    this.loading.set(acc.id, task);
    return task;
  }

  /** Builds both curves for a time range, downsampled for drawing. */
  async chart(acc, rawRequest, range = 'all', now = Date.now()) {
    const span = RANGES[range] ?? Infinity;
    const [cache, samples] = await Promise.all([this.balancePoints(acc, rawRequest, now), this.samples(acc.id)]);
    await this.loadPipSizes(acc, cache.closes, rawRequest);
    const dealPoints = cache.points;
    // The account starts at its first deposit, just before the first closed trade.
    const opening = cache.start !== null && dealPoints.length
      ? [[Math.min(acc.registeredAt || dealPoints[0][0] - 1, dealPoints[0][0] - 1), cache.start]]
      : [];
    const balance = mergeByTime([...opening, ...dealPoints, ...samples.map(([t, b]) => [t, b]), [now, acc.balance]]);
    const equity = mergeByTime([...samples.map(([t, , e]) => [t, e]), [now, acc.equity]]);
    const equitySince = samples[0]?.[0] ?? null;
    const start = span === Infinity ? Math.min(balance[0]?.[0] ?? now, equity[0]?.[0] ?? now) : now - span;

    // Performance is measured on equity where it was recorded, and on balance before that.
    const performance = mergeByTime([...balance.filter((p) => equitySince === null || p[0] < equitySince), ...equity]);
    return {
      currency: acc.currency || '',
      from: start,
      to: now,
      equitySince,
      balance: downsample(clip(balance, start, true), MAX_POINTS, 'last'),
      equity: downsample(clip(equity, start, false), MAX_POINTS, 'minmax'),
      stats: performanceStats(clip(performance, start, true)),
      trades: tradeStats(cache.closes.filter((c) => c[0] >= start), acc.symbols),
      sharpe: dailySharpe(clip(performance, start, true)),
    };
  }

  /** Pip size per traded symbol (needed for pips per trade). */
  async loadPipSizes(acc, closes, rawRequest) {
    if (!acc.symbols) return;
    const missing = [...new Set(closes.map((c) => c[3]))].filter((id) => id !== undefined && acc.symbols.get(id)?.pipPosition === undefined);
    for (let i = 0; i < missing.length; i += 100) {
      try {
        const { symbol = [] } = await rawRequest(PT.SYMBOL_BY_ID_REQ, { ctidTraderAccountId: acc.numericId, symbolId: missing.slice(i, i + 100) });
        for (const s of symbol) {
          acc.symbols.set(s.symbolId, { ...acc.symbols.get(s.symbolId), lotSize: Number(s.lotSize) || 0, digits: s.digits, pipPosition: s.pipPosition });
        }
      } catch {
        return; // pips are optional; everything else still works
      }
    }
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

/**
 * Growth, peak and drawdowns of a value series (full resolution, oldest first).
 * Drawdown = fall from the highest value reached so far, as a percentage of that high.
 */
export function performanceStats(points) {
  if (!points.length) return null;
  const [t0, startValue] = points[0];
  const [, endValue] = points[points.length - 1];
  let peak = { t: t0, v: startValue };
  let runningPeak = peak;
  let maxDd = { pct: 0, peak: null, trough: null };
  for (const [t, v] of points) {
    if (v > runningPeak.v) runningPeak = { t, v };
    if (v > peak.v) peak = { t, v };
    const dd = runningPeak.v > 0 ? (runningPeak.v - v) / runningPeak.v : 0;
    if (dd > maxDd.pct) maxDd = { pct: dd, peak: runningPeak, trough: { t, v } };
  }
  const pct = (n) => Math.round(n * 10_000) / 100; // fraction -> percent with 2 decimals
  return {
    startValue,
    endValue,
    growthPct: startValue > 0 ? pct(endValue / startValue - 1) : null,
    peak,
    currentDrawdownPct: runningPeak.v > 0 ? pct((runningPeak.v - endValue) / runningPeak.v) : 0,
    maxDrawdownPct: pct(maxDd.pct),
    maxDrawdown: maxDd.peak ? { peak: maxDd.peak, trough: maxDd.trough } : null,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

function profitFactor(trades) {
  let won = 0;
  let lost = 0;
  for (const t of trades) {
    if (t[1] > 0) won += t[1];
    else lost -= t[1];
  }
  if (!trades.length) return null;
  return lost === 0 ? (won > 0 ? '∞' : null) : round2(won / lost); // '∞' = no losing trades yet
}

/** Profit factor, win rate and pips from closed trades (each partial close counts as a trade). */
export function tradeStats(closes, symbols = new Map()) {
  if (!closes.length) return { count: 0, winRatePct: null, profitFactor: null, longPF: null, shortPF: null, longCount: 0, shortCount: 0, avgPips: null };
  const longs = closes.filter((c) => c[2] === 1);
  const shorts = closes.filter((c) => c[2] !== 1);
  let pipsTotal = 0;
  let pipsCount = 0;
  for (const [, , isLong, symbolId, entry, exit] of closes) {
    const pipPosition = symbols.get?.(symbolId)?.pipPosition;
    if (pipPosition === undefined || !Number.isFinite(entry) || !Number.isFinite(exit)) continue;
    pipsTotal += ((isLong ? exit - entry : entry - exit) * 10 ** pipPosition);
    pipsCount += 1;
  }
  return {
    count: closes.length,
    winRatePct: round2((closes.filter((c) => c[1] > 0).length / closes.length) * 100),
    profitFactor: profitFactor(closes),
    longPF: profitFactor(longs),
    shortPF: profitFactor(shorts),
    longCount: longs.length,
    shortCount: shorts.length,
    avgPips: pipsCount ? Math.round((pipsTotal / pipsCount) * 10) / 10 : null,
  };
}

/**
 * Sharpe ratio from daily changes of the value series (end-of-day values, UTC, weekdays only),
 * annualised with 252 trading days and a 0% risk-free rate. Needs at least 5 daily changes.
 */
export function dailySharpe(points) {
  const endOfDay = new Map();
  for (const [t, v] of points) {
    const day = new Date(t);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    endOfDay.set(day.toISOString().slice(0, 10), v);
  }
  const values = [...endOfDay.values()];
  const returns = [];
  for (let i = 1; i < values.length; i++) if (values[i - 1] > 0) returns.push(values[i] / values[i - 1] - 1);
  if (returns.length < 5) return { value: null, days: returns.length };
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  return { value: sd > 0 ? round2((mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR)) : null, days: returns.length };
}
