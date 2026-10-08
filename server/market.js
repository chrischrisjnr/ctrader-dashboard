import { EventEmitter } from 'node:events';
import { PT } from './ctrader/client.js';

const PRICE_SCALE = 100_000; // cTrader prices are integers in 1/100000 of a unit
const BARS = 300;

// cTrader trendbar periods (ProtoOATrendbarPeriod) and how far back to ask for ~300 bars.
export const PERIODS = {
  m1: { code: 1, ms: 60_000, lookbackMs: 2 * 86_400_000 },
  m5: { code: 5, ms: 300_000, lookbackMs: 5 * 86_400_000 },
  m15: { code: 7, ms: 900_000, lookbackMs: 14 * 86_400_000 },
  h1: { code: 9, ms: 3_600_000, lookbackMs: 35 * 86_400_000 },
  h4: { code: 10, ms: 14_400_000, lookbackMs: 120 * 86_400_000 },
  d1: { code: 12, ms: 86_400_000, lookbackMs: 400 * 86_400_000 },
};

/**
 * Live prices and candles for one symbol (AUDCAD by default), taken from one of the
 * connected cTrader accounts so they match what the cBots trade on. Emits 'price'.
 */
export class MarketFeed extends EventEmitter {
  constructor({ symbol = 'AUDCAD' } = {}) {
    super();
    this.symbol = symbol.toUpperCase();
    this.reset();
  }

  reset() {
    this.client = null;
    this.account = null;
    this.symbolId = null;
    this.digits = 5;
    this.bid = null;
    this.ask = null;
    this.lastTick = null;
    this.candles = new Map(); // period -> { at, bars: [[t, o, h, l, c]] }
    this.error = null;
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }

  /** Picks the first account that offers the symbol and subscribes to its live prices. */
  async attach(client, accounts) {
    this.reset();
    this.client = client;
    for (const acc of accounts) {
      if (!acc.symbolNames) continue;
      for (const [id, name] of acc.symbolNames) {
        if (String(name).toUpperCase() === this.symbol) {
          this.account = acc;
          this.symbolId = id;
          break;
        }
      }
      if (this.account) break;
    }
    if (!this.account) {
      this.error = `None of your accounts offers ${this.symbol}.`;
      return;
    }
    const base = { ctidTraderAccountId: this.account.numericId };
    try {
      const { symbol = [] } = await client.request(PT.SYMBOL_BY_ID_REQ, { ...base, symbolId: [this.symbolId] });
      if (symbol[0]?.digits !== undefined) this.digits = symbol[0].digits;
      await client.request(PT.SUBSCRIBE_SPOTS_REQ, { ...base, symbolId: [this.symbolId], subscribeToSpotTimestamp: true });
    } catch (err) {
      this.error = `Live prices unavailable: ${err.message}`;
    }
  }

  /** Called for every ProtoOASpotEvent. */
  onSpot(p) {
    if (!this.account || Number(p.symbolId) !== Number(this.symbolId)) return;
    if (p.bid !== undefined) this.bid = Number(p.bid) / PRICE_SCALE;
    if (p.ask !== undefined) this.ask = Number(p.ask) / PRICE_SCALE;
    const t = Number(p.timestamp) || Date.now();
    this.lastTick = t;
    if (this.bid !== null) {
      for (const [period, cache] of this.candles) updateBars(cache.bars, PERIODS[period].ms, t, this.bid);
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.emit('price', this.quote());
      }, 250);
    }
  }

  quote() {
    return { symbol: this.symbol, bid: this.bid, ask: this.ask, digits: this.digits, t: this.lastTick };
  }

  /** Candles for a period (bid prices), fetched from cTrader and kept up to date by live ticks. */
  async getCandles(period) {
    const spec = PERIODS[period];
    if (!spec) throw new Error('Unknown timeframe.');
    if (!this.client || !this.account) throw new Error(this.error || 'Not connected to cTrader yet.');
    const cached = this.candles.get(period);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.bars;
    const now = Date.now();
    const res = await this.client.request(PT.GET_TRENDBARS_REQ, {
      ctidTraderAccountId: this.account.numericId,
      symbolId: this.symbolId,
      period: spec.code,
      fromTimestamp: now - spec.lookbackMs,
      toTimestamp: now,
      count: BARS,
    });
    const bars = (res.trendbar || [])
      .map((b) => {
        const low = Number(b.low) || 0;
        return [
          Number(b.utcTimestampInMinutes) * 60_000,
          (low + (Number(b.deltaOpen) || 0)) / PRICE_SCALE,
          (low + (Number(b.deltaHigh) || 0)) / PRICE_SCALE,
          low / PRICE_SCALE,
          (low + (Number(b.deltaClose) || 0)) / PRICE_SCALE,
        ];
      })
      .filter((b) => b[0] > 0 && b[3] > 0)
      .sort((a, b) => a[0] - b[0])
      .slice(-BARS);
    if (this.bid !== null && this.lastTick) updateBars(bars, spec.ms, this.lastTick, this.bid);
    this.candles.set(period, { at: Date.now(), bars });
    return bars;
  }
}

/** Applies one tick to a candle list: extends the last candle or starts a new one. */
export function updateBars(bars, periodMs, t, price) {
  const last = bars[bars.length - 1];
  if (!last) return;
  if (t >= last[0] + periodMs) {
    const start = last[0] + Math.floor((t - last[0]) / periodMs) * periodMs;
    bars.push([start, price, price, price, price]);
    if (bars.length > BARS) bars.shift();
  } else if (t >= last[0]) {
    last[2] = Math.max(last[2], price);
    last[3] = Math.min(last[3], price);
    last[4] = price;
  }
}
