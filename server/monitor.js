import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OpenApiClient, OpenApiError, PT } from './ctrader/client.js';
import { authorizeUrl, exchangeCode, refreshTokens } from './ctrader/oauth.js';
import { EquityHistory } from './equity.js';
import { accountHistory, toCsv } from './history.js';
import { newId } from './store.js';

const PNL_POLL_MS = 5_000;
const FULL_REFRESH_MS = 60_000;
const EQUITY_SAMPLE_MS = 5 * 60_000;
const STATS_REFRESH_MS = 10 * 60_000;
const REFRESH_TOKEN_BEFORE_MS = 3 * 24 * 3600_000;
const LOGIN_WINDOW_MS = 10 * 60_000;
const TOKEN_ERRORS = /TOKEN|ACCESS_DENIED|NOT_AUTHORIZED|UNAUTHORIZED/i;
const RELOGIN_MESSAGE = 'cTrader asked this login to sign in again. Remove it and add it again.';

const round2 = (n) => Math.round(n * 100) / 100;
const money = (value, digits) => (Number(value) || 0) / 10 ** digits;
const isBuy = (side) => side === 1 || side === 'BUY';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Read-only live view of the user's cTrader demo accounts through the official
 * cTrader Open API. Sees every position on the account, including ones opened
 * by cBots running in cTrader Desktop or cTrader Cloud. Supports several
 * cTrader ID logins, each with its own access token. Emits 'update'.
 */
export class Monitor extends EventEmitter {
  constructor({ file, config }) {
    super();
    this.file = file;
    this.config = config;
    this.metaFile = path.join(path.dirname(file), 'account-names.json');
    this.meta = {}; // account id -> { name, algorithm }
    this.history = new EquityHistory(path.join(path.dirname(file), 'history'));
    this.stats = new Map(); // account id -> all-time performance (start, peak, max drawdown)
    this.settings = {};
    this.state = 'not_configured';
    this.error = null;
    this.accounts = new Map();
    this.hiddenLiveAccounts = 0;
    this.client = null;
    this.timers = [];
    this.retryDelay = 5_000;
    this.pendingLogin = 0;
    this.stopped = true;
  }

  // --- settings & login ----------------------------------------------------

  async load() {
    try {
      this.settings = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // Older versions stored a single login's tokens at the top level.
    if (this.settings.accessToken) {
      const { accessToken, refreshToken, expiresAt, ...rest } = this.settings;
      this.settings = { ...rest, logins: [{ id: newId(), accessToken, refreshToken, expiresAt }] };
      await this.persist();
    }
    this.settings.logins ||= [];
    try {
      this.meta = JSON.parse(await fs.readFile(this.metaFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this.state = this.baseState();
  }

  async persist() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  baseState() {
    if (!this.settings.clientId || !this.settings.clientSecret) return 'not_configured';
    if (!this.settings.logins?.length) return 'needs_login';
    return 'connecting';
  }

  async saveCredentials({ clientId, clientSecret }) {
    this.stop();
    // Tokens belong to the old app, so changing the app means logging in again.
    this.settings = { clientId, clientSecret, logins: [] };
    this.accounts.clear();
    await this.persist();
    this.setState(this.baseState(), null);
  }

  beginLogin(redirectUri) {
    if (!this.settings.clientId) throw new Error('Save your Open API Client ID and Secret first.');
    this.pendingLogin = Date.now();
    return authorizeUrl({ authBase: this.config.openApiAuthBase, clientId: this.settings.clientId, redirectUri });
  }

  async finishLogin({ code, redirectUri }) {
    if (!this.pendingLogin || Date.now() - this.pendingLogin > LOGIN_WINDOW_MS) {
      throw new Error('Login expired. Press "Connect cTrader" again.');
    }
    this.pendingLogin = 0;
    const tokens = await exchangeCode({
      tokenUrl: this.config.openApiTokenUrl,
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      redirectUri,
      code,
    });
    this.settings.logins.push({ id: newId(), ...tokens, addedAt: Date.now() });
    await this.persist();
    this.start();
  }

  /** Your own name and algorithm description for an account (stored only on this computer). */
  async setAccountMeta(accountId, { name, algorithm }) {
    if (!this.accounts.has(String(accountId)) && !this.meta[accountId]) throw new Error('Account not found.');
    if (name || algorithm) this.meta[accountId] = { name, algorithm };
    else delete this.meta[accountId];
    const tmp = `${this.metaFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.meta, null, 2));
    await fs.rename(tmp, this.metaFile);
    this.emitSoon();
  }

  async removeLogin(loginId) {
    const before = this.settings.logins.length;
    this.settings.logins = this.settings.logins.filter((l) => l.id !== loginId);
    if (this.settings.logins.length === before) throw new Error('Login not found.');
    await this.persist();
    for (const [id, acc] of this.accounts) if (acc.loginId === loginId) this.accounts.delete(id);
    this.start();
  }

  async disconnect() {
    this.stop();
    this.settings.logins = [];
    await this.persist();
    this.accounts.clear();
    this.setState(this.baseState(), null);
  }

  login(loginId) {
    return this.settings.logins.find((l) => l.id === loginId);
  }

  async refreshTokensIfNeeded(login, force = false) {
    const { refreshToken, expiresAt } = login;
    if (!refreshToken || (!force && expiresAt - Date.now() > REFRESH_TOKEN_BEFORE_MS)) return;
    const tokens = await refreshTokens({
      tokenUrl: this.config.openApiTokenUrl,
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      refreshToken,
    });
    Object.assign(login, tokens);
    await this.persist();
  }

  /**
   * Logging in twice with the same cTrader ID (or restoring a backup) can leave two copies
   * of one login. Keep one: a working copy beats one with an error, then the newest wins.
   */
  async dropDuplicateLogins() {
    const best = new Map(); // account set -> index of login to keep
    this.settings.logins.forEach((login, i) => {
      const key = login.accountLogins?.length ? [...login.accountLogins].sort().join(',') : null;
      if (!key) return;
      const current = best.get(key);
      if (current === undefined) return best.set(key, i);
      const other = this.settings.logins[current];
      if ((other.error && !login.error) || (!other.error === !login.error)) best.set(key, i);
    });
    const keep = this.settings.logins.filter((login, i) => {
      const key = login.accountLogins?.length ? [...login.accountLogins].sort().join(',') : null;
      return !key || best.get(key) === i;
    });
    if (keep.length !== this.settings.logins.length) {
      this.settings.logins = keep;
      await this.persist();
    }
  }

  /** Lists one login's accounts, refreshing its token once if cTrader rejects it. */
  async accountsForLogin(client, login) {
    const list = () => client.request(PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, { accessToken: login.accessToken });
    try {
      await this.refreshTokensIfNeeded(login);
      return (await list()).ctidTraderAccount || [];
    } catch (err) {
      if (!(err instanceof OpenApiError && TOKEN_ERRORS.test(String(err.code)))) throw err;
      await this.refreshTokensIfNeeded(login, true);
      return (await list()).ctidTraderAccount || [];
    }
  }

  // --- connection lifecycle -------------------------------------------------

  start() {
    this.stop();
    if (this.baseState() !== 'connecting') {
      this.setState(this.baseState(), null);
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = null;
    client?.close();
  }

  async connect() {
    this.setState('connecting', null);
    let client;
    try {
      client = new OpenApiClient(this.config.openApiUrl);
      await client.connect();
      if (this.stopped) return client.close();
      this.client = client;
      client.on('message', (msg) => this.onEvent(msg));
      client.on('close', () => this.onDisconnected(client));

      await client.request(PT.APPLICATION_AUTH_REQ, {
        clientId: this.settings.clientId,
        clientSecret: this.settings.clientSecret,
      });
      // Each cTrader ID login has its own token; one connection serves them all.
      const demo = [];
      const liveIds = new Set();
      for (const login of this.settings.logins) {
        try {
          const list = await this.accountsForLogin(client, login);
          login.error = null;
          login.accountLogins = list.filter((a) => !a.isLive).map((a) => a.traderLogin);
          for (const a of list) {
            if (a.isLive) liveIds.add(a.ctidTraderAccountId);
            else if (!demo.some((d) => d.ctidTraderAccountId === a.ctidTraderAccountId)) demo.push({ ...a, loginId: login.id });
          }
        } catch (err) {
          if (client.closed) throw err;
          login.error = err instanceof OpenApiError || /login failed|Bad code|token/i.test(err.message) ? RELOGIN_MESSAGE : err.message;
        }
      }
      this.hiddenLiveAccounts = liveIds.size;
      await this.dropDuplicateLogins();

      const ids = new Set(demo.map((a) => String(a.ctidTraderAccountId)));
      for (const id of this.accounts.keys()) if (!ids.has(id)) this.accounts.delete(id);
      for (const a of demo) {
        const id = String(a.ctidTraderAccountId);
        const existing = this.accounts.get(id);
        this.accounts.set(id, {
          ...(existing || { positions: [], symbols: new Map(), balance: 0, moneyDigits: 2, closedToday: { pnl: 0, count: 0 } }),
          id,
          loginId: a.loginId,
          numericId: a.ctidTraderAccountId,
          login: a.traderLogin,
          broker: a.brokerTitleShort || '',
        });
      }
      await Promise.all([...this.accounts.values()].map((acc) => this.initAccount(acc)));
      this.retryDelay = 5_000;
      this.setState('connected', null);
      this.timers.push(setInterval(() => this.pollPnl(), PNL_POLL_MS));
      this.timers.push(setInterval(() => this.refreshAll(), FULL_REFRESH_MS));
      this.timers.push(setInterval(() => this.recordEquity(), EQUITY_SAMPLE_MS));
      this.timers.push(setInterval(() => this.refreshStats(), STATS_REFRESH_MS));
      this.recordEquity();
      this.refreshStats();
    } catch (err) {
      client?.close();
      await this.handleFailure(err);
    }
  }

  async handleFailure(err) {
    if (this.stopped) return;
    if (err instanceof OpenApiError && /CLIENT_AUTH/i.test(String(err.code))) {
      err.message = `cTrader rejected the app (${err.message}). Check that the app is Active and the Client ID/Secret are right.`;
    }
    this.scheduleReconnect(err.message);
  }

  onDisconnected(client) {
    if (client !== this.client || this.stopped) return;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.client = null;
    this.scheduleReconnect('Connection to cTrader lost.');
  }

  scheduleReconnect(reason) {
    if (this.stopped) return;
    const seconds = Math.round(this.retryDelay / 1000);
    this.setState('error', `${reason} Retrying in ${seconds}s.`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 120_000);
  }

  // --- account data ---------------------------------------------------------

  async initAccount(acc) {
    const client = this.client;
    try {
      await client.request(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: acc.numericId, accessToken: this.login(acc.loginId)?.accessToken });
      const [{ asset = [] }, { symbol = [] }] = await Promise.all([
        client.request(PT.ASSET_LIST_REQ, { ctidTraderAccountId: acc.numericId }),
        client.request(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: acc.numericId }),
      ]);
      acc.assets = new Map(asset.map((a) => [a.assetId, a.displayName || a.name]));
      acc.symbolNames = new Map(symbol.map((s) => [s.symbolId, s.symbolName]));
      await this.refreshAccount(acc);
    } catch (err) {
      acc.error = err instanceof OpenApiError && TOKEN_ERRORS.test(String(err.code)) ? RELOGIN_MESSAGE : err.message;
      this.emitSoon();
    }
  }

  async refreshAccount(acc) {
    const client = this.client;
    if (!client) return;
    const ctidTraderAccountId = acc.numericId;
    const [{ trader }, reconcile, deals] = await Promise.all([
      client.request(PT.TRADER_REQ, { ctidTraderAccountId }),
      client.request(PT.RECONCILE_REQ, { ctidTraderAccountId }),
      client.request(PT.DEAL_LIST_REQ, { ctidTraderAccountId, fromTimestamp: startOfToday(), toTimestamp: Date.now(), maxRows: 1000 }),
    ]);
    this.applyTrader(acc, trader);

    const raw = reconcile.position || [];
    const missing = [...new Set(raw.map((p) => p.tradeData.symbolId))].filter((id) => !acc.symbols.has(id));
    if (missing.length) {
      const { symbol = [] } = await client.request(PT.SYMBOL_BY_ID_REQ, { ctidTraderAccountId, symbolId: missing });
      for (const s of symbol) acc.symbols.set(s.symbolId, { lotSize: Number(s.lotSize) || 0, digits: s.digits, pipPosition: s.pipPosition });
    }
    const previous = new Map(acc.positions.map((p) => [p.id, p]));
    acc.positions = raw.map((p) => {
      const td = p.tradeData;
      const lotSize = acc.symbols.get(td.symbolId)?.lotSize;
      return {
        id: String(p.positionId),
        symbol: acc.symbolNames?.get(td.symbolId) || `#${td.symbolId}`,
        side: isBuy(td.tradeSide) ? 'Buy' : 'Sell',
        lots: lotSize ? Number(td.volume) / lotSize : null,
        units: Number(td.volume) / 100,
        openPrice: p.price,
        stopLoss: p.stopLoss ?? null,
        takeProfit: p.takeProfit ?? null,
        openedAt: td.openTimestamp,
        label: td.label || '',
        comment: td.comment || '',
        netPnl: previous.get(String(p.positionId))?.netPnl ?? 0,
      };
    });

    let pnl = 0;
    let count = 0;
    for (const deal of deals.deal || []) {
      const cpd = deal.closePositionDetail;
      if (!cpd) continue;
      const digits = cpd.moneyDigits ?? deal.moneyDigits ?? acc.moneyDigits;
      pnl += money((Number(cpd.grossProfit) || 0) + (Number(cpd.swap) || 0) + (Number(cpd.commission) || 0) + (Number(cpd.pnlConversionFee) || 0), digits);
      count += 1;
    }
    acc.closedToday = { pnl, count };
    acc.error = null;
    await this.fetchPnl(acc);
  }

  applyTrader(acc, trader) {
    if (!trader) return;
    acc.moneyDigits = trader.moneyDigits ?? acc.moneyDigits ?? 2;
    acc.balance = money(trader.balance, acc.moneyDigits);
    acc.currency = acc.assets?.get(trader.depositAssetId) || '';
    if (trader.registrationTimestamp) acc.registeredAt = Number(trader.registrationTimestamp);
    acc.updatedAt = Date.now();
    this.emitSoon();
  }

  async fetchPnl(acc) {
    if (!this.client) return;
    if (!acc.positions.length) {
      acc.updatedAt = Date.now();
      this.emitSoon();
      return;
    }
    const res = await this.client.request(PT.GET_POSITION_UNREALIZED_PNL_REQ, { ctidTraderAccountId: acc.numericId });
    const digits = res.moneyDigits ?? acc.moneyDigits;
    const byId = new Map((res.positionUnrealizedPnL || []).map((u) => [String(u.positionId), money(u.netUnrealizedPnL, digits)]));
    for (const p of acc.positions) if (byId.has(p.id)) p.netPnl = byId.get(p.id);
    acc.updatedAt = Date.now();
    this.emitSoon();
  }

  pollPnl() {
    for (const acc of this.accounts.values()) {
      if (!acc.error) this.fetchPnl(acc).catch(() => {});
    }
  }

  refreshAll() {
    for (const acc of this.accounts.values()) {
      const task = acc.error ? this.initAccount(acc) : this.refreshAccount(acc);
      task.catch((err) => {
        acc.error = err.message;
        this.emitSoon();
      });
    }
  }

  onEvent(msg) {
    const p = msg.payload || {};
    const acc = p.ctidTraderAccountId !== undefined ? this.accounts.get(String(p.ctidTraderAccountId)) : undefined;
    switch (msg.payloadType) {
      case PT.EXECUTION_EVENT:
        if (acc) {
          clearTimeout(acc.refreshTimer);
          acc.refreshTimer = setTimeout(() => this.refreshAccount(acc).catch(() => {}), 500);
        }
        break;
      case PT.TRADER_UPDATE_EVENT:
        if (acc) this.applyTrader(acc, p.trader);
        break;
      case PT.ACCOUNT_DISCONNECT_EVENT:
        if (acc) this.initAccount(acc).catch(() => {});
        break;
      case PT.ACCOUNTS_TOKEN_INVALIDATED_EVENT: {
        const affected = new Set((p.ctidTraderAccountIds || []).map((id) => this.accounts.get(String(id))?.loginId).filter(Boolean));
        Promise.allSettled(this.settings.logins.filter((l) => affected.has(l.id)).map((l) => this.refreshTokensIfNeeded(l, true)))
          .then(() => this.start());
        break;
      }
      case PT.CLIENT_DISCONNECT_EVENT:
        this.client?.close();
        break;
      default:
    }
  }

  // --- balance & equity curves ------------------------------------------------

  equityOf(acc) {
    return acc.balance + acc.positions.reduce((sum, p) => sum + p.netPnl, 0);
  }

  recordEquity() {
    const now = Date.now();
    for (const acc of this.accounts.values()) {
      if (acc.error || !acc.updatedAt || now - acc.updatedAt > 2 * 60_000) continue;
      this.history.record(acc.id, now, round2(acc.balance), round2(this.equityOf(acc))).catch(() => {});
    }
  }

  /** All-time growth, peak and drawdown per account, refreshed in the background. */
  async refreshStats() {
    if (this.statsRunning) {
      // A run is in progress (e.g. from before a reconnect); do another full pass right after it.
      this.statsAgain = true;
      return;
    }
    this.statsRunning = true;
    this.statsAgain = false;
    try {
      for (const acc of [...this.accounts.values()]) {
        if (acc.error || !this.client) continue;
        try {
          const data = await this.chart(acc.id, 'all');
          if (data.stats) this.stats.set(acc.id, { ...data.stats, trades: data.trades, sharpe: data.sharpe });
          this.emitSoon();
        } catch {
          // Try again on the next round.
        }
      }
    } finally {
      this.statsRunning = false;
    }
    if (this.statsAgain) await this.refreshStats();
  }

  /** Combines stored all-time stats with the live equity so the numbers move in real time. */
  livePerformance(acc, equity, floating) {
    const pct = (n) => Math.round(n * 10_000) / 100;
    const base = acc.balance > 0 ? acc.balance : null;
    const closedBase = acc.balance - acc.closedToday.pnl;
    const out = {
      floatingPct: base ? pct(floating / base) : null,
      closedTodayPct: closedBase > 0 ? pct(acc.closedToday.pnl / closedBase) : null,
      growthPct: null,
      peakEquity: null,
      peakAt: null,
      currentDrawdownPct: null,
      maxDrawdownPct: null,
      trades: null,
      sharpe: null,
    };
    const st = this.stats.get(acc.id);
    if (!st) return out;
    const peak = equity > st.peak.v ? { t: Date.now(), v: equity } : st.peak;
    const currentDd = peak.v > 0 ? (peak.v - equity) / peak.v : 0;
    return {
      ...out,
      growthPct: st.startValue > 0 ? pct(equity / st.startValue - 1) : null,
      peakEquity: peak.v,
      peakAt: peak.t,
      currentDrawdownPct: pct(currentDd),
      maxDrawdownPct: Math.max(st.maxDrawdownPct, pct(currentDd)),
      trades: st.trades ?? null,
      sharpe: st.sharpe ?? null,
    };
  }

  async chart(accountId, range) {
    if (this.state !== 'connected' || !this.client) throw new Error('Connect cTrader first.');
    const acc = this.accounts.get(String(accountId));
    if (!acc) throw new Error('Account not found.');
    const client = this.client;
    return this.history.chart({ ...acc, equity: this.equityOf(acc) }, (type, payload) => client.request(type, payload), range);
  }

  // --- trade history export -------------------------------------------------

  /** @param {string} accountId  one account id, or 'all' */
  async exportHistoryCsv(accountId) {
    if (this.state !== 'connected' || !this.client) throw new Error('Connect cTrader first.');
    if (this.exporting) throw new Error('A download is already being prepared. Please wait for it to finish.');
    const accounts = accountId === 'all' ? [...this.accounts.values()] : [this.accounts.get(String(accountId))].filter(Boolean);
    if (!accounts.length) throw new Error('Account not found.');
    this.exporting = true;
    try {
      const rows = [];
      for (const acc of accounts) {
        const client = this.client;
        if (!client) throw new Error('Connection to cTrader lost. Try again in a moment.');
        acc.meta = this.meta[acc.id];
        rows.push(...(await accountHistory((type, payload) => client.request(type, payload), acc)));
      }
      rows.sort((a, b) => a.Time.localeCompare(b.Time));
      return toCsv(rows);
    } finally {
      this.exporting = false;
    }
  }

  /** Reloads settings, names and logins from disk (after a backup was restored) and reconnects. */
  async reload() {
    this.stop();
    this.accounts.clear();
    this.stats.clear();
    await this.load();
    this.start();
  }

  // --- output ---------------------------------------------------------------

  setState(state, error) {
    this.state = state;
    this.error = error;
    this.emitSoon();
  }

  emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('update', this.snapshot());
    }, 300);
  }

  snapshot() {
    const accounts = [...this.accounts.values()]
      .sort((a, b) => String(a.login).localeCompare(String(b.login)))
      .map((acc) => {
        const floating = acc.positions.reduce((sum, p) => sum + p.netPnl, 0);
        const groups = new Map();
        for (const p of acc.positions) {
          const key = p.label || p.comment || '';
          const g = groups.get(key) || { name: key, trades: 0, floating: 0, symbols: new Set() };
          g.trades += 1;
          g.floating += p.netPnl;
          g.symbols.add(p.symbol);
          groups.set(key, g);
        }
        return {
          id: acc.id,
          loginId: acc.loginId,
          login: acc.login,
          name: this.meta[acc.id]?.name || '',
          algorithm: this.meta[acc.id]?.algorithm || '',
          broker: acc.broker,
          currency: acc.currency || '',
          balance: acc.balance,
          equity: acc.balance + floating,
          floating,
          performance: this.livePerformance(acc, acc.balance + floating, floating),
          closedToday: acc.closedToday,
          positions: acc.positions,
          bots: [...groups.values()]
            .map((g) => ({ ...g, symbols: [...g.symbols].sort() }))
            .sort((a, b) => b.trades - a.trades),
          error: acc.error || null,
          updatedAt: acc.updatedAt || null,
        };
      });
    return {
      state: this.state,
      error: this.error,
      clientId: this.settings.clientId || '',
      hiddenLiveAccounts: this.hiddenLiveAccounts,
      logins: this.settings.logins.map((l, i) => ({
        id: l.id,
        name: `Login ${i + 1}`,
        accounts: l.accountLogins || [],
        error: l.error || null,
      })),
      accounts,
    };
  }
}
