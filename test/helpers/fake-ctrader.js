// A stand-in for cTrader's Open API (JSON over WebSocket) and OAuth endpoints, for tests and demos.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PT } from '../../server/ctrader/client.js';

const DAY = 24 * 3600_000;

export function fakeData(now = Date.now()) {
  const symbols = [
    { symbolId: 1, symbolName: 'EURUSD', lotSize: 10_000_000 },
    { symbolId: 2, symbolName: 'XAUUSD', lotSize: 10_000 },
    { symbolId: 3, symbolName: 'GBPUSD', lotSize: 10_000_000 },
  ];
  const accounts = [
    { ctidTraderAccountId: 101, traderLogin: 5123456, brokerTitleShort: 'IC Markets', isLive: false, balance: 1_012_345, deposit: 'USD' },
    { ctidTraderAccountId: 102, traderLogin: 3987001, brokerTitleShort: 'Pepperstone', isLive: false, balance: 498_210, deposit: 'EUR' },
    { ctidTraderAccountId: 900, traderLogin: 7777777, brokerTitleShort: 'Live Broker', isLive: true, balance: 100, deposit: 'USD' },
  ];
  const positions = {
    101: [
      { positionId: 1, tradeData: { symbolId: 1, volume: 1_000_000, tradeSide: 1, openTimestamp: now - 3 * 3600_000, label: 'TrendFollower' }, price: 1.0841, pnl: 2450 },
      { positionId: 2, tradeData: { symbolId: 3, volume: 2_000_000, tradeSide: 2, openTimestamp: now - 5 * 3600_000, label: 'TrendFollower' }, price: 1.2712, pnl: -830 },
      { positionId: 3, tradeData: { symbolId: 2, volume: 1_000, tradeSide: 1, openTimestamp: now - 3600_000, label: 'GridScalper' }, price: 2391.4, pnl: 1220 },
    ],
    102: [
      { positionId: 4, tradeData: { symbolId: 1, volume: 500_000, tradeSide: 2, openTimestamp: now - 2 * 3600_000, label: '' }, price: 1.0852, pnl: -410 },
    ],
  };
  // Closed trades spread over 60 days: an opening deal and a closing deal per position.
  const deals = { 101: [], 102: [] };
  const orders = { 101: [], 102: [] };
  let id = 1000;
  for (const acc of [101, 102]) {
    for (let i = 0; i < 40; i++) {
      const pos = id++;
      const opened = now - (60 - i * 1.5) * DAY;
      const label = acc === 101 ? (i % 2 ? 'GridScalper' : 'TrendFollower, "v2"') : '=SUM(A1)';
      orders[acc].push({ orderId: pos * 10, positionId: pos, closingOrder: false, tradeData: { label, comment: '' } });
      orders[acc].push({ orderId: pos * 10 + 1, positionId: pos, closingOrder: true, tradeData: { label: '' } });
      deals[acc].push({ dealId: pos * 10, orderId: pos * 10, positionId: pos, symbolId: 1, filledVolume: 1_000_000, volume: 1_000_000, tradeSide: 1, executionTimestamp: opened, executionPrice: 1.08, dealStatus: 2, commission: -35, moneyDigits: 2 });
      deals[acc].push({ dealId: pos * 10 + 1, orderId: pos * 10 + 1, positionId: pos, symbolId: 1, filledVolume: 1_000_000, volume: 1_000_000, tradeSide: 2, executionTimestamp: opened + 3600_000, executionPrice: 1.081, dealStatus: 2, commission: -35, moneyDigits: 2,
        closePositionDetail: { entryPrice: 1.08, grossProfit: 1000 + i, swap: -10, commission: -70, balance: 1_000_000 + i * 100, moneyDigits: 2 } });
    }
    deals[acc].push({ dealId: 1, orderId: 1, positionId: 1, symbolId: 1, volume: 1, tradeSide: 1, executionTimestamp: now - DAY, dealStatus: 4 }); // rejected: must be skipped
  }
  // One trade closed today.
  deals[101].push({ dealId: 77, orderId: 77, positionId: 77, symbolId: 2, filledVolume: 1000, tradeSide: 2, executionTimestamp: now - 60_000, executionPrice: 2400, dealStatus: 2, commission: -50, moneyDigits: 2,
    closePositionDetail: { entryPrice: 2390, grossProfit: 10_000, swap: 0, commission: -100, balance: 1_012_345, moneyDigits: 2 } });
  return { symbols, accounts, positions, deals, orders, registeredAt: now - 90 * DAY };
}

export async function startFakeCtrader({ data = fakeData(), maxPerPage = 15 } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/my/settings/openapi/grantingaccess/') {
      res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=good-code` });
      return res.end();
    }
    if (url.pathname === '/apps/token') {
      const p = url.searchParams;
      const ok = p.get('client_secret') === 'secret-123' && (p.get('code') === 'good-code' || p.get('refresh_token') === 'refresh-1');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ok
        ? { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 2_628_000, tokenType: 'bearer' }
        : { errorCode: 'ACCESS_DENIED', description: 'Bad code' }));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      log.push(msg.payloadType);
      const p = msg.payload || {};
      const reply = (payloadType, payload) => ws.send(JSON.stringify({ clientMsgId: msg.clientMsgId, payloadType, payload }));
      const acc = data.accounts.find((a) => a.ctidTraderAccountId === p.ctidTraderAccountId);
      const inRange = (t) => t >= p.fromTimestamp && t <= p.toTimestamp;
      switch (msg.payloadType) {
        case PT.HEARTBEAT_EVENT: return;
        case PT.APPLICATION_AUTH_REQ:
          return p.clientSecret === 'secret-123' ? reply(PT.APPLICATION_AUTH_RES, {}) : reply(PT.ERROR_RES, { errorCode: 'CH_CLIENT_AUTH_FAILURE', description: 'Bad app' });
        case PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ:
          return reply(PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES, { ctidTraderAccount: data.accounts.map(({ balance, deposit, ...a }) => a) });
        case PT.ACCOUNT_AUTH_REQ:
          return reply(PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: p.ctidTraderAccountId });
        case PT.ASSET_LIST_REQ:
          return reply(PT.ASSET_LIST_RES, { asset: [{ assetId: 1, name: 'USD', displayName: 'USD' }, { assetId: 2, name: 'EUR', displayName: 'EUR' }] });
        case PT.SYMBOLS_LIST_REQ:
          return reply(PT.SYMBOLS_LIST_RES, { symbol: data.symbols.map(({ symbolId, symbolName }) => ({ symbolId, symbolName })) });
        case PT.SYMBOL_BY_ID_REQ:
          return reply(PT.SYMBOL_BY_ID_RES, { symbol: data.symbols.filter((s) => p.symbolId.includes(s.symbolId)).map((s) => ({ symbolId: s.symbolId, lotSize: s.lotSize, digits: 5 })) });
        case PT.TRADER_REQ:
          return reply(PT.TRADER_RES, { trader: { ctidTraderAccountId: acc.ctidTraderAccountId, balance: acc.balance, moneyDigits: 2, depositAssetId: acc.deposit === 'USD' ? 1 : 2, registrationTimestamp: data.registeredAt } });
        case PT.RECONCILE_REQ:
          return reply(PT.RECONCILE_RES, { position: (data.positions[acc.ctidTraderAccountId] || []).map(({ pnl, ...pos }) => ({ ...pos, moneyDigits: 2 })) });
        case PT.GET_POSITION_UNREALIZED_PNL_REQ:
          return reply(PT.GET_POSITION_UNREALIZED_PNL_RES, { moneyDigits: 2, positionUnrealizedPnL: (data.positions[acc.ctidTraderAccountId] || []).map((pos) => ({ positionId: pos.positionId, grossUnrealizedPnL: pos.pnl, netUnrealizedPnL: pos.pnl })) });
        case PT.DEAL_LIST_REQ: {
          const items = (data.deals[acc.ctidTraderAccountId] || []).filter((d) => inRange(d.executionTimestamp));
          return reply(PT.DEAL_LIST_RES, { deal: items.slice(0, maxPerPage), hasMore: items.length > maxPerPage });
        }
        case PT.ORDER_LIST_REQ: {
          const items = (data.orders[acc.ctidTraderAccountId] || []).filter((o) => {
            const deal = data.deals[acc.ctidTraderAccountId].find((d) => d.orderId === o.orderId);
            return deal && inRange(deal.executionTimestamp);
          });
          return reply(PT.ORDER_LIST_RES, { order: items.slice(0, maxPerPage), hasMore: items.length > maxPerPage });
        }
        default:
          return reply(PT.ERROR_RES, { errorCode: 'UNSUPPORTED', description: `Fake server does not support ${msg.payloadType}` });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    log,
    config: {
      openApiUrl: `ws://127.0.0.1:${port}`,
      openApiAuthBase: `http://127.0.0.1:${port}`,
      openApiTokenUrl: `http://127.0.0.1:${port}/apps/token`,
    },
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(r); }),
  };
}
