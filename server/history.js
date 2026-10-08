import { PT } from './ctrader/client.js';

const WINDOW_MS = 30 * 24 * 3600_000;
const MIN_WINDOW_MS = 60_000;
const HISTORICAL_GAP_MS = 250; // cTrader allows ~5 historical requests per second
const FALLBACK_HISTORY_MS = 5 * 365 * 24 * 3600_000;
const FILLED = new Set([2, 3, 'FILLED', 'PARTIALLY_FILLED']);

export const CSV_COLUMNS = [
  'Account', 'Account name', 'Algorithm', 'Broker', 'Currency', 'Time', 'Deal ID', 'Position ID', 'Order ID', 'Symbol',
  'Direction', 'Action', 'Lots', 'Units', 'Price', 'Entry price', 'Gross profit', 'Swap',
  'Commission', 'Net profit', 'Balance after', 'cBot label', 'Comment',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (value, digits) => (Number(value) || 0) / 10 ** digits;
const round = (n, digits = 2) => (n === null || n === undefined ? '' : Number(n.toFixed(digits)));

/** Spaces requests out to stay inside cTrader's historical-data rate limit. */
export function throttled(rawRequest) {
  let last = 0;
  return async (type, payload) => {
    const wait = last + HISTORICAL_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return rawRequest(type, payload);
  };
}

/** Fetches every deal of an account between two timestamps. */
export async function fetchDeals(request, acc, from, to) {
  const deals = [];
  await fetchRange(request, PT.DEAL_LIST_REQ, 'deal', { ctidTraderAccountId: acc.numericId }, from, to, deals);
  return deals;
}

export function accountStart(acc, now = Date.now()) {
  return acc.registeredAt || now - FALLBACK_HISTORY_MS;
}

/** Fetches every item in [from, to], halving windows that report hasMore. */
const MAX_REQUESTS_PER_RANGE = 600;

async function fetchRange(request, payloadType, listKey, base, from, to, out) {
  const budget = { left: MAX_REQUESTS_PER_RANGE };
  for (let start = from; start < to; start += WINDOW_MS) {
    await fetchWindow(request, payloadType, listKey, base, start, Math.min(start + WINDOW_MS, to), out, budget);
  }
}

async function fetchWindow(request, payloadType, listKey, base, from, to, out, budget) {
  if (--budget.left < 0) throw new Error(`cTrader kept reporting more history than expected (${listKey} list); stopped after ${MAX_REQUESTS_PER_RANGE} requests.`);
  const res = await request(payloadType, { ...base, fromTimestamp: from, toTimestamp: to, ...(listKey === 'deal' ? { maxRows: 10_000 } : {}) });
  const items = res[listKey] || [];
  // Only split when the window really was cut short; some servers set hasMore loosely.
  if (res.hasMore && items.length > 0 && to - from > MIN_WINDOW_MS) {
    const mid = Math.floor((from + to) / 2);
    await fetchWindow(request, payloadType, listKey, base, from, mid, out, budget);
    await fetchWindow(request, payloadType, listKey, base, mid, to, out, budget);
    return;
  }
  out.push(...items);
}

/**
 * Downloads the complete deal history of one account and turns it into CSV rows.
 * @param {(type: number, payload: object) => Promise<object>} rawRequest  Open API request function
 * @param {object} acc  monitor account ({ numericId, login, broker, currency, moneyDigits, registeredAt, symbols, symbolNames })
 */
export async function accountHistory(rawRequest, acc, { now = Date.now(), onProgress } = {}) {
  const request = throttled(rawRequest);
  const base = { ctidTraderAccountId: acc.numericId };
  const from = accountStart(acc, now);

  const orders = [];
  onProgress?.(`Loading deals for account ${acc.login}...`);
  const deals = await fetchDeals(request, acc, from, now);
  onProgress?.(`Loading orders for account ${acc.login}...`);
  await fetchRange(request, PT.ORDER_LIST_REQ, 'order', base, from, now, orders);

  // The cBot label lives on the order that opened a position; carry it to every deal of that position.
  const orderInfo = new Map();
  const positionInfo = new Map();
  for (const o of orders) {
    const info = { label: o.tradeData?.label || '', comment: o.tradeData?.comment || '' };
    orderInfo.set(String(o.orderId), info);
    if (!o.closingOrder && o.positionId !== undefined && !positionInfo.has(String(o.positionId))) {
      positionInfo.set(String(o.positionId), info);
    }
  }

  const filled = deals.filter((d) => FILLED.has(d.dealStatus));
  const missing = [...new Set(filled.map((d) => d.symbolId))].filter((id) => !acc.symbols.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const { symbol = [] } = await rawRequest(PT.SYMBOL_BY_ID_REQ, { ...base, symbolId: missing.slice(i, i + 100) });
    for (const s of symbol) acc.symbols.set(s.symbolId, { lotSize: Number(s.lotSize) || 0, digits: s.digits, pipPosition: s.pipPosition });
  }

  const seen = new Set();
  return filled
    .filter((d) => !seen.has(d.dealId) && seen.add(d.dealId))
    .sort((a, b) => a.executionTimestamp - b.executionTimestamp)
    .map((d) => {
      const digits = d.moneyDigits ?? acc.moneyDigits ?? 2;
      const cpd = d.closePositionDetail;
      const lotSize = acc.symbols.get(d.symbolId)?.lotSize;
      const volume = Number(d.filledVolume ?? d.volume) || 0;
      const info = positionInfo.get(String(d.positionId)) || orderInfo.get(String(d.orderId)) || {};
      const row = {
        Account: acc.login,
        'Account name': acc.meta?.name || '',
        Algorithm: acc.meta?.algorithm || '',
        Broker: acc.broker,
        Currency: acc.currency,
        Time: new Date(d.executionTimestamp).toISOString(),
        'Deal ID': d.dealId,
        'Position ID': d.positionId,
        'Order ID': d.orderId,
        Symbol: acc.symbolNames?.get(d.symbolId) || `#${d.symbolId}`,
        Direction: d.tradeSide === 1 || d.tradeSide === 'BUY' ? 'Buy' : 'Sell',
        Action: cpd ? 'Close' : 'Open',
        Lots: lotSize ? round(volume / lotSize, 4) : '',
        Units: round(volume / 100, 2),
        Price: d.executionPrice ?? '',
        'Entry price': cpd?.entryPrice ?? '',
        'Gross profit': '',
        Swap: '',
        Commission: round(money(d.commission, digits)),
        'Net profit': '',
        'Balance after': '',
        'cBot label': info.label || '',
        Comment: info.comment || '',
      };
      if (cpd) {
        const cd = cpd.moneyDigits ?? digits;
        const gross = money(cpd.grossProfit, cd);
        const swap = money(cpd.swap, cd);
        const commission = money(cpd.commission, cd);
        const fee = money(cpd.pnlConversionFee, cd);
        Object.assign(row, {
          'Gross profit': round(gross),
          Swap: round(swap),
          Commission: round(commission),
          'Net profit': round(gross + swap + commission + fee),
          'Balance after': round(money(cpd.balance, cd)),
        });
      }
      return row;
    });
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Stop spreadsheet apps from treating text such as "=cmd()" as a formula.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel opens it as UTF-8
}
