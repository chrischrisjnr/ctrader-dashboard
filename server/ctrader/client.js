import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/** cTrader Open API message types used by the dashboard (JSON over WebSocket). */
export const PT = Object.freeze({
  ERROR_RES_COMMON: 50,
  HEARTBEAT_EVENT: 51,
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  ASSET_LIST_REQ: 2112,
  ASSET_LIST_RES: 2113,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  TRADER_UPDATE_EVENT: 2123,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  DEAL_LIST_REQ: 2133,
  DEAL_LIST_RES: 2134,
  ERROR_RES: 2142,
  ACCOUNTS_TOKEN_INVALIDATED_EVENT: 2147,
  CLIENT_DISCONNECT_EVENT: 2148,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: 2150,
  ACCOUNT_DISCONNECT_EVENT: 2164,
  GET_POSITION_UNREALIZED_PNL_REQ: 2187,
  GET_POSITION_UNREALIZED_PNL_RES: 2188,
  ORDER_LIST_REQ: 2175,
  ORDER_LIST_RES: 2176,
});

export class OpenApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * Minimal cTrader Open API client: request/response matching by clientMsgId,
 * heartbeats, and unsolicited events emitted as 'message'. Emits 'close' once.
 */
export class OpenApiClient extends EventEmitter {
  constructor(url, { requestTimeoutMs = 20_000, heartbeatMs = 10_000 } = {}) {
    super();
    this.url = url;
    this.requestTimeoutMs = requestTimeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.pending = new Map();
    this.ws = null;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        this.heartbeat = setInterval(() => this.send({ payloadType: PT.HEARTBEAT_EVENT, payload: {} }), this.heartbeatMs);
        resolve();
      });
      ws.addEventListener('message', (event) => this.onMessage(event.data));
      ws.addEventListener('error', () => {
        if (!opened) reject(new Error('Could not connect to cTrader.'));
      });
      ws.addEventListener('close', () => this.onClose(opened ? undefined : reject));
    });
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    const waiting = msg.clientMsgId && this.pending.get(msg.clientMsgId);
    if (waiting) {
      this.pending.delete(msg.clientMsgId);
      clearTimeout(waiting.timer);
      if (msg.payloadType === PT.ERROR_RES || msg.payloadType === PT.ERROR_RES_COMMON) {
        const p = msg.payload || {};
        waiting.reject(new OpenApiError(p.errorCode, p.description || p.errorCode));
      } else {
        waiting.resolve(msg.payload || {});
      }
      return;
    }
    if (msg.payloadType !== PT.HEARTBEAT_EVENT) this.emit('message', msg);
  }

  onClose(rejectConnect) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Connection to cTrader closed.'));
    }
    this.pending.clear();
    rejectConnect?.(new Error('Could not connect to cTrader.'));
    this.emit('close');
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  request(payloadType, payload = {}) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to cTrader.'));
    }
    const clientMsgId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error('cTrader did not answer in time.'));
      }, this.requestTimeoutMs);
      this.pending.set(clientMsgId, { resolve, reject, timer });
      this.send({ clientMsgId, payloadType, payload });
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.onClose();
  }
}
