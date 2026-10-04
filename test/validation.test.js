import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAccount, validateInstance, validateParameters } from '../server/validation.js';

const goodAccount = { label: 'Demo 1', ctid: 'me@example.com', password: 'secret', accountNumber: '5123456', isDemo: true };

test('accepts a valid demo account', () => {
  const { account, password } = validateAccount(goodAccount);
  assert.equal(account.accountNumber, '5123456');
  assert.equal(account.isDemo, true);
  assert.equal(password, 'secret');
});

test('refuses accounts not confirmed as demo', () => {
  assert.throws(() => validateAccount({ ...goodAccount, isDemo: false }), /demo/);
  assert.throws(() => validateAccount({ ...goodAccount, isDemo: 'true' }), /demo/);
});

test('password is required for new accounts but optional when editing', () => {
  assert.throws(() => validateAccount({ ...goodAccount, password: '' }), /Password is required/);
  assert.doesNotThrow(() => validateAccount({ ...goodAccount, password: '' }, { id: 'x' }));
});

test('rejects malformed account fields', () => {
  assert.throws(() => validateAccount({ ...goodAccount, accountNumber: '12a' }), /Account number/);
  assert.throws(() => validateAccount({ ...goodAccount, ctid: 'me --full-access' }), /cTrader ID/);
  assert.throws(() => validateAccount({ ...goodAccount, password: 'a\nb' }), /Password/);
});

test('parameters must be valid identifiers and not reserved', () => {
  assert.deepEqual(validateParameters({ StopLossPips: '20', Volume: 1000 }), { StopLossPips: '20', Volume: '1000' });
  assert.throws(() => validateParameters({ 'bad name': '1' }), /not valid/);
  assert.throws(() => validateParameters({ ACCOUNT: '1' }), /reserved/);
  assert.throws(() => validateParameters(['x']), /name\/value/);
});

test('instances must reference an existing demo account and cBot', () => {
  const store = {
    get: (kind, id) => ({ bots: { b1: { id: 'b1' } }, accounts: { a1: { id: 'a1', isDemo: true }, a2: { id: 'a2', isDemo: false } } })[kind][id],
  };
  const base = { name: 'Bot', botId: 'b1', accountId: 'a1', symbol: 'EURUSD', period: 'H1' };
  const instance = validateInstance(base, store);
  assert.equal(instance.period, 'h1');
  assert.equal(instance.autoRestart, true);
  assert.equal(instance.fullAccess, false);
  assert.throws(() => validateInstance({ ...base, accountId: 'a2' }, store), /demo/);
  assert.throws(() => validateInstance({ ...base, botId: 'zz' }, store), /cBot/);
  assert.throws(() => validateInstance({ ...base, period: 'h5' }, store), /Timeframe/);
  assert.throws(() => validateInstance({ ...base, symbol: 'EUR USD' }, store), /Symbol/);
});
