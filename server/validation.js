export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const PERIODS = [
  'm1', 'm2', 'm3', 'm4', 'm5', 'm10', 'm15', 'm30', 'm45',
  'h1', 'h2', 'h3', 'h4', 'h6', 'h8', 'h12',
  'd1', 'd2', 'd3', 'w1', 'month1',
];

// Names that the cTrader CLI reads from the environment itself; a cBot
// parameter with one of these names would silently override the CLI option.
const RESERVED_PARAM_NAMES = new Set(['CTID', 'PWD-FILE', 'ACCOUNT', 'SYMBOL', 'PERIOD', 'FULL-ACCESS']);

function fail(message) {
  throw new HttpError(400, message);
}

function text(value, field, { max = 100, pattern, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return '';
    fail(`${field} is required.`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') fail(`${field} must be text.`);
  const str = String(value).trim();
  if (!str && !optional) fail(`${field} is required.`);
  if (str.length > max) fail(`${field} must be at most ${max} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(str)) fail(`${field} contains invalid characters.`);
  if (str && pattern && !pattern.test(str)) fail(`${field} is not valid.`);
  return str;
}

/**
 * @param {object} input  request body
 * @param {object} [existing]  current account when editing (password becomes optional)
 */
export function validateAccount(input = {}, existing) {
  const account = {
    label: text(input.label, 'Name', { max: 60 }),
    broker: text(input.broker, 'Broker', { max: 60, optional: true }),
    ctid: text(input.ctid, 'cTrader ID', { max: 120, pattern: /^[^\s'"`]+$/ }),
    accountNumber: text(input.accountNumber, 'Account number', { max: 20, pattern: /^\d+$/ }),
  };
  if (input.isDemo !== true) {
    fail('This dashboard only runs cBots on demo accounts. Confirm the account is a demo account.');
  }
  account.isDemo = true;

  const password = input.password ?? '';
  if (typeof password !== 'string') fail('Password must be text.');
  if (!existing && !password) fail('Password is required.');
  if (password.length > 200 || /[\r\n]/.test(password)) fail('Password is not valid.');
  return { account, password };
}

export function validateParameters(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('Parameters must be a list of name/value pairs.');
  const entries = Object.entries(input);
  if (entries.length > 100) fail('Too many parameters.');
  const params = {};
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      fail(`Parameter name "${name}" is not valid. Use letters, numbers and underscores, exactly as in the cBot code.`);
    }
    if (RESERVED_PARAM_NAMES.has(name.toUpperCase())) fail(`Parameter name "${name}" is reserved.`);
    params[name] = text(value, `Parameter "${name}"`, { max: 500, optional: true });
  }
  return params;
}

export function validateInstance(input = {}, store) {
  const instance = {
    name: text(input.name, 'Name', { max: 60 }),
    botId: text(input.botId, 'cBot', { max: 40 }),
    accountId: text(input.accountId, 'Account', { max: 40 }),
    symbol: text(input.symbol, 'Symbol', { max: 30, pattern: /^[A-Za-z0-9._/#-]+$/ }),
    period: text(input.period, 'Timeframe', { max: 10 }).toLowerCase(),
    parameters: validateParameters(input.parameters),
    fullAccess: input.fullAccess === true,
    autoRestart: input.autoRestart !== false,
  };
  if (!PERIODS.includes(instance.period)) fail('Timeframe is not valid.');
  if (!store.get('bots', instance.botId)) fail('Choose a cBot.');
  const account = store.get('accounts', instance.accountId);
  if (!account) fail('Choose an account.');
  if (!account.isDemo) fail('cBots can only be run on demo accounts.');
  return instance;
}
