// cBot Control — dashboard front end (no build step, no framework).

const state = {
  status: null,
  accounts: [],
  bots: [],
  instances: new Map(),
  lastLog: new Map(),
  logsFor: null, // instance id shown in the logs drawer
  events: null,
};

const $ = (sel, root = document) => root.querySelector(sel);

/** Small DOM builder. Text is always set via text nodes, so user data can never inject HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// --- API -------------------------------------------------------------------------

class ApiError extends Error {}

async function api(path, { method = 'GET', body, form } = {}) {
  const options = { method, headers: {} };
  if (form) options.body = form;
  else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, options);
  } catch {
    throw new ApiError('Cannot reach the dashboard server.');
  }
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new ApiError('Please log in.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`);
  return data;
}

function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}

async function run(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) toast(successMessage);
    return result;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}

// --- Login -------------------------------------------------------------------------

function showLogin() {
  state.events?.close();
  state.events = null;
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('.form-error', form);
  error.textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password: form.password.value } });
    form.reset();
    await boot();
  } catch (err) {
    error.textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await run(() => api('/logout', { method: 'POST' }));
  showLogin();
});

// --- Formatting --------------------------------------------------------------------

const STATUS_LABEL = {
  running: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
  restarting: 'Restarting',
  stopped: 'Stopped',
  crashed: 'Problem',
};

function formatUptime(startedAt) {
  if (!startedAt) return '—';
  let s = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const hr = Math.floor(s / 3600); s -= hr * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d) return `${d}d ${hr}h ${m}m`;
  if (hr) return `${hr}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

const byId = (list, id) => list.find((item) => item.id === id);
const isActive = (status) => ['starting', 'running', 'stopping', 'restarting'].includes(status);

// --- Rendering ---------------------------------------------------------------------

function renderStats() {
  const statuses = [...state.instances.values()].map((i) => i.status);
  $('#stat-running').textContent = statuses.filter((s) => s === 'running').length;
  $('#stat-stopped').textContent = statuses.filter((s) => s === 'stopped').length;
  $('#stat-crashed').textContent = statuses.filter((s) => s === 'crashed').length;
  $('#stat-accounts').textContent = state.accounts.length;
  $('#stat-bots').textContent = state.bots.length;
}

function instanceCard(inst) {
  const bot = byId(state.bots, inst.botId);
  const account = byId(state.accounts, inst.accountId);
  const active = isActive(inst.status);
  const busy = ['starting', 'stopping'].includes(inst.status);
  const last = state.lastLog.get(inst.id);
  const paramCount = Object.keys(inst.parameters || {}).length;

  return h('article', { class: `card bot-card status-${inst.status}`, dataset: { id: inst.id } },
    h('header', {},
      h('div', {},
        h('h3', {}, inst.name),
        h('span', { class: 'muted' }, bot ? bot.name : 'Missing cBot file')),
      h('span', { class: `pill ${inst.status}` }, STATUS_LABEL[inst.status] || inst.status)),
    h('dl', { class: 'bot-meta' },
      h('dt', {}, 'Account'), h('dd', {}, account ? `${account.label} · #${account.accountNumber}` : 'Missing account'),
      h('dt', {}, 'Market'), h('dd', {}, `${inst.symbol} · ${inst.period.toUpperCase()}`),
      h('dt', {}, 'Uptime'), h('dd', { dataset: { uptime: inst.startedAt || '' } }, formatUptime(inst.startedAt)),
      paramCount ? [h('dt', {}, 'Parameters'), h('dd', {}, `${paramCount} custom`)] : null),
    inst.status === 'crashed' && inst.error ? h('p', { class: 'bot-error' }, inst.error) : null,
    h('div', { class: 'last-log', title: last?.line || '' }, last ? last.line : 'No output yet'),
    h('div', { class: 'bot-actions' },
      active
        ? h('button', { class: 'btn small danger-outline', disabled: busy, onclick: () => instanceAction(inst.id, 'stop') }, 'Stop')
        : h('button', { class: 'btn small primary', onclick: () => instanceAction(inst.id, 'start') }, 'Start'),
      h('button', { class: 'btn small', disabled: !active || busy, onclick: () => instanceAction(inst.id, 'restart') }, 'Restart'),
      h('button', { class: 'btn small', onclick: () => openLogs(inst.id) }, 'Logs'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small ghost', disabled: active, title: active ? 'Stop the bot to edit it' : '', onclick: () => openInstanceDialog(inst) }, 'Edit'),
      h('button', { class: 'btn small ghost', disabled: active, title: active ? 'Stop the bot to delete it' : '', onclick: () => deleteInstance(inst) }, 'Delete')));
}

function renderInstances() {
  const container = $('#instances');
  const list = [...state.instances.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) {
    const needs = !state.accounts.length ? 'account' : !state.bots.length ? 'bot' : null;
    container.replaceChildren(h('div', { class: 'empty' },
      h('p', {}, needs === 'account'
        ? 'Start by adding a demo account.'
        : needs === 'bot' ? 'Next, upload a cBot (.algo) file.' : 'No bots yet. Create one to run a cBot on an account.'),
      h('button', {
        class: 'btn primary',
        onclick: () => (needs === 'account' ? openAccountDialog() : needs === 'bot' ? openBotDialog() : openInstanceDialog()),
      }, needs === 'account' ? '+ Add account' : needs === 'bot' ? '+ Upload cBot' : '+ New bot')));
    return;
  }
  container.replaceChildren(...list.map(instanceCard));
}

function renderAccounts() {
  const rows = state.accounts.map((a) => {
    const used = [...state.instances.values()].filter((i) => i.accountId === a.id).length;
    return h('tr', {},
      h('td', {}, h('strong', {}, a.label), h('div', { class: 'muted' }, a.broker || '')),
      h('td', {}, a.ctid),
      h('td', {}, `#${a.accountNumber}`),
      h('td', {}, h('span', { class: 'badge demo' }, 'Demo')),
      h('td', {}, used ? `${used} bot${used > 1 ? 's' : ''}` : '—'),
      h('td', { class: 'actions' },
        h('button', { class: 'btn small ghost', onclick: () => openAccountDialog(a) }, 'Edit'),
        h('button', { class: 'btn small ghost', onclick: () => deleteAccount(a) }, 'Delete')));
  });
  $('#accounts').replaceChildren(
    h('thead', {}, h('tr', {}, ['Name', 'cTrader ID', 'Account', 'Type', 'Used by', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.length ? rows : h('tr', { class: 'empty-row' }, h('td', { colspan: 6 }, 'No accounts yet.'))));
}

function renderBots() {
  const rows = state.bots.map((b) => {
    const used = [...state.instances.values()].filter((i) => i.botId === b.id).length;
    return h('tr', {},
      h('td', {}, h('strong', {}, b.name)),
      h('td', { class: 'muted' }, b.originalName),
      h('td', {}, formatSize(b.size)),
      h('td', {}, new Date(b.createdAt).toLocaleDateString()),
      h('td', {}, used ? `${used} bot${used > 1 ? 's' : ''}` : '—'),
      h('td', { class: 'actions' }, h('button', { class: 'btn small ghost', onclick: () => deleteBot(b) }, 'Delete')));
  });
  $('#bots').replaceChildren(
    h('thead', {}, h('tr', {}, ['Name', 'File', 'Size', 'Uploaded', 'Used by', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.length ? rows : h('tr', { class: 'empty-row' }, h('td', { colspan: 6 }, 'No cBots uploaded yet.'))));
}

function renderAll() {
  renderStats();
  renderInstances();
  renderAccounts();
  renderBots();
}

/** Updates a single card in place instead of re-rendering the whole grid. */
function updateInstance(view) {
  const isNew = !state.instances.has(view.id);
  state.instances.set(view.id, view);
  const existing = $(`#instances [data-id="${CSS.escape(view.id)}"]`);
  if (existing && !isNew) existing.replaceWith(instanceCard(view));
  else renderInstances();
  renderStats();
  if (state.logsFor === view.id) renderLogsSubtitle();
}

setInterval(() => {
  for (const el of document.querySelectorAll('[data-uptime]')) el.textContent = formatUptime(el.dataset.uptime);
}, 1000);

// --- Tabs --------------------------------------------------------------------------

for (const tab of document.querySelectorAll('.tabs [data-tab]')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tabs [data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  try { localStorage.setItem('ctdash.tab', name); } catch { /* storage unavailable */ }
}

// --- Dialog helpers ----------------------------------------------------------------

/** Wires a <form method="dialog"> so Save runs `onSave` and only closes on success. */
function bindDialog(dialog, onSave) {
  const form = $('form', dialog);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') return dialog.close();
    const error = $('.form-error', form);
    const saveBtn = $('button[value="save"]', form);
    error.textContent = '';
    saveBtn.disabled = true;
    try {
      await onSave(form);
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });
}

function resetForm(form) {
  form.reset();
  $('.form-error', form).textContent = '';
}

// --- Accounts ----------------------------------------------------------------------

let editingAccount = null;

function openAccountDialog(account = null) {
  editingAccount = account;
  const dialog = $('#account-dialog');
  const form = $('form', dialog);
  resetForm(form);
  $('[data-title]', form).textContent = account ? 'Edit account' : 'Add demo account';
  $('[data-password-hint]', form).hidden = !account;
  form.password.required = !account;
  if (account) {
    for (const key of ['label', 'broker', 'ctid', 'accountNumber']) form[key].value = account[key] || '';
    form.isDemo.checked = account.isDemo;
  }
  dialog.showModal();
}

bindDialog($('#account-dialog'), async (form) => {
  const body = {
    label: form.label.value,
    broker: form.broker.value,
    ctid: form.ctid.value,
    password: form.password.value,
    accountNumber: form.accountNumber.value,
    isDemo: form.isDemo.checked,
  };
  if (editingAccount) {
    const updated = await api(`/accounts/${editingAccount.id}`, { method: 'PUT', body });
    state.accounts = state.accounts.map((a) => (a.id === updated.id ? updated : a));
    toast('Account saved.');
  } else {
    state.accounts = [...state.accounts, await api('/accounts', { method: 'POST', body })];
    toast('Account added.');
  }
  renderAll();
});

async function deleteAccount(account) {
  if (!confirm(`Delete account "${account.label}"? The saved password will be removed.`)) return;
  const ok = await run(() => api(`/accounts/${account.id}`, { method: 'DELETE' }), 'Account deleted.');
  if (ok !== undefined) {
    state.accounts = state.accounts.filter((a) => a.id !== account.id);
    renderAll();
  }
}

// --- cBot files --------------------------------------------------------------------

function openBotDialog() {
  resetForm($('#bot-form'));
  $('#bot-dialog').showModal();
}

bindDialog($('#bot-dialog'), async (form) => {
  const data = new FormData();
  data.append('name', form.name.value);
  data.append('file', form.file.files[0]);
  state.bots = [...state.bots, await api('/bots', { method: 'POST', form: data })];
  toast('cBot uploaded.');
  renderAll();
});

async function deleteBot(bot) {
  if (!confirm(`Delete cBot "${bot.name}"?`)) return;
  const ok = await run(() => api(`/bots/${bot.id}`, { method: 'DELETE' }), 'cBot deleted.');
  if (ok !== undefined) {
    state.bots = state.bots.filter((b) => b.id !== bot.id);
    renderAll();
  }
}

// --- Bots (instances) --------------------------------------------------------------

let editingInstance = null;

function paramRow(name = '', value = '') {
  const row = h('div', { class: 'param-row' },
    h('input', { name: 'paramName', placeholder: 'Name, e.g. StopLossPips', value: name, 'aria-label': 'Parameter name' }),
    h('input', { name: 'paramValue', placeholder: 'Value', value, 'aria-label': 'Parameter value' }),
    h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Remove parameter', onclick: () => row.remove() }, '✕'));
  return row;
}

$('#add-param-btn').addEventListener('click', () => $('#param-rows').append(paramRow()));

function openInstanceDialog(inst = null) {
  if (!state.accounts.length) return toast('Add a demo account first.', 'error');
  if (!state.bots.length) return toast('Upload a cBot file first.', 'error');
  editingInstance = inst;
  const form = $('#instance-form');
  resetForm(form);
  $('[data-title]', form).textContent = inst ? 'Edit bot' : 'New bot';
  form.botId.replaceChildren(...state.bots.map((b) => h('option', { value: b.id }, b.name)));
  form.accountId.replaceChildren(...state.accounts.map((a) => h('option', { value: a.id }, `${a.label} · #${a.accountNumber}`)));
  form.period.replaceChildren(...state.status.periods.map((p) => h('option', { value: p }, p.toUpperCase())));
  form.period.value = 'h1';
  $('#param-rows').replaceChildren();
  if (inst) {
    form.name.value = inst.name;
    form.botId.value = inst.botId;
    form.accountId.value = inst.accountId;
    form.symbol.value = inst.symbol;
    form.period.value = inst.period;
    form.autoRestart.checked = inst.autoRestart;
    form.fullAccess.checked = inst.fullAccess;
    for (const [name, value] of Object.entries(inst.parameters || {})) $('#param-rows').append(paramRow(name, value));
  }
  $('#instance-dialog').showModal();
}

bindDialog($('#instance-dialog'), async (form) => {
  const parameters = {};
  for (const row of document.querySelectorAll('#param-rows .param-row')) {
    const name = $('[name="paramName"]', row).value.trim();
    if (name) parameters[name] = $('[name="paramValue"]', row).value;
  }
  const body = {
    name: form.name.value,
    botId: form.botId.value,
    accountId: form.accountId.value,
    symbol: form.symbol.value.toUpperCase(),
    period: form.period.value,
    parameters,
    autoRestart: form.autoRestart.checked,
    fullAccess: form.fullAccess.checked,
  };
  const saved = editingInstance
    ? await api(`/instances/${editingInstance.id}`, { method: 'PUT', body })
    : await api('/instances', { method: 'POST', body });
  updateInstance(saved);
  renderAccounts();
  renderBots();
  toast(editingInstance ? 'Bot saved.' : 'Bot created. Press Start to run it.');
});

async function instanceAction(id, action) {
  const view = await run(() => api(`/instances/${id}/${action}`, { method: 'POST' }));
  if (view) updateInstance(view);
}

async function deleteInstance(inst) {
  if (!confirm(`Delete bot "${inst.name}"?`)) return;
  const ok = await run(() => api(`/instances/${inst.id}`, { method: 'DELETE' }), 'Bot deleted.');
  if (ok !== undefined) {
    state.instances.delete(inst.id);
    state.lastLog.delete(inst.id);
    renderAll();
  }
}

$('#add-instance-btn').addEventListener('click', () => openInstanceDialog());
$('#add-account-btn').addEventListener('click', () => openAccountDialog());
$('#add-bot-btn').addEventListener('click', () => openBotDialog());

$('#start-all-btn').addEventListener('click', async () => {
  const list = await run(() => api('/start-all', { method: 'POST' }), 'Starting all bots.');
  if (list) list.forEach(updateInstance);
});

$('#stop-all-btn').addEventListener('click', async () => {
  if (!confirm('Stop every running bot?')) return;
  const list = await run(() => api('/stop-all', { method: 'POST' }), 'Stopping all bots.');
  if (list) list.forEach(updateInstance);
});

// --- Logs --------------------------------------------------------------------------

function logLine(entry) {
  return h('div', { class: entry.stream },
    h('span', { class: 't' }, `${formatTime(entry.t)}  `), entry.line);
}

function renderLogsSubtitle() {
  const inst = state.instances.get(state.logsFor);
  if (!inst) return;
  $('#logs-title').textContent = inst.name;
  $('#logs-sub').textContent = `${STATUS_LABEL[inst.status]} · ${inst.symbol} ${inst.period.toUpperCase()}`;
}

async function openLogs(id) {
  state.logsFor = id;
  renderLogsSubtitle();
  const body = $('#logs-body');
  body.replaceChildren(h('div', { class: 'system' }, 'Loading…'));
  $('#logs-dialog').showModal();
  const entries = await run(() => api(`/instances/${id}/logs`));
  if (state.logsFor !== id || !entries) return;
  body.replaceChildren(...(entries.length ? entries.map(logLine) : [h('div', { class: 'system' }, 'No output yet.')]));
  body.scrollTop = body.scrollHeight;
}

function appendLog(id, entry) {
  state.lastLog.set(id, entry);
  const card = $(`#instances [data-id="${CSS.escape(id)}"] .last-log`);
  if (card) {
    card.textContent = entry.line;
    card.title = entry.line;
  }
  if (state.logsFor !== id || !$('#logs-dialog').open) return;
  const body = $('#logs-body');
  if (body.firstChild?.textContent === 'No output yet.') body.replaceChildren();
  body.append(logLine(entry));
  while (body.childElementCount > 2000) body.firstChild.remove();
  if ($('#logs-follow').checked) body.scrollTop = body.scrollHeight;
}

$('#logs-close').addEventListener('click', () => $('#logs-dialog').close());
$('#logs-dialog').addEventListener('close', () => { state.logsFor = null; });

// --- Live updates ------------------------------------------------------------------

function connectEvents() {
  state.events?.close();
  const source = new EventSource('/api/events');
  state.events = source;
  source.addEventListener('open', () => $('#conn').classList.add('on'));
  source.addEventListener('error', () => {
    $('#conn').classList.remove('on');
    // EventSource retries on its own; if our session expired, fall back to the login screen.
    if (source.readyState === EventSource.CLOSED) api('/session').then((s) => s.authenticated || showLogin()).catch(() => {});
  });
  source.addEventListener('instance', (event) => updateInstance(JSON.parse(event.data)));
  source.addEventListener('monitor', (event) => {
    state.monitor = { ...state.monitor, ...JSON.parse(event.data) };
    renderMonitor();
  });
  source.addEventListener('log', (event) => {
    const { id, entry } = JSON.parse(event.data);
    appendLog(id, entry);
  });
}

// --- Monitor (cTrader Open API, read-only) ----------------------------------------

const MON_STATE = {
  not_configured: ['Not set up', ''],
  needs_login: ['Not connected', ''],
  connecting: ['Connecting', 'starting'],
  connected: ['Live', 'running'],
  error: ['Reconnecting', 'crashed'],
};

function fmtMoney(value, currency = '') {
  const n = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
  return currency ? `${n} ${currency}` : n;
}

function pnl(value, currency) {
  const sign = value > 0 ? '+' : '';
  return h('span', { class: value > 0 ? 'pos' : value < 0 ? 'neg' : '' }, sign + fmtMoney(value, currency));
}

function metric(label, value) {
  return h('div', { class: 'metric' }, h('span', {}, label), h('span', {}, value));
}

function renderMonitor() {
  const m = state.monitor;
  if (!m) return;
  const [label, cls] = MON_STATE[m.state] || [m.state, ''];
  const pill = $('#mon-state');
  pill.textContent = label;
  pill.className = `pill ${cls}`;

  const live = ['connecting', 'connected', 'error'].includes(m.state);
  $('#mon-setup').hidden = live;
  $('#mon-disconnect').hidden = !live;
  $('#mon-csv-all').hidden = m.state !== 'connected' || m.accounts.length < 2;
  $('#mon-redirect').textContent = m.redirectUri || `${location.origin}/oauth/callback`;
  $('#mon-connect').disabled = m.state === 'not_configured';
  const credForm = $('#mon-cred-form');
  if (m.clientId && !credForm.clientId.value && document.activeElement?.form !== credForm) credForm.clientId.value = m.clientId;

  const error = $('#mon-error');
  error.hidden = !m.error;
  error.textContent = m.error || '';

  if (!live) {
    $('#mon-totals').replaceChildren();
    $('#mon-accounts').replaceChildren();
    return;
  }

  // Totals, kept separate per account currency.
  const byCurrency = new Map();
  for (const a of m.accounts) {
    const t = byCurrency.get(a.currency) || { balance: 0, equity: 0, floating: 0, closed: 0 };
    t.balance += a.balance; t.equity += a.equity; t.floating += a.floating; t.closed += a.closedToday.pnl;
    byCurrency.set(a.currency, t);
  }
  const lines = (key, asPnl) => [...byCurrency].map(([cur, t]) => h('div', {}, asPnl ? pnl(t[key], cur) : fmtMoney(t[key], cur)));
  const openTrades = m.accounts.reduce((n, a) => n + a.positions.length, 0);
  $('#mon-totals').replaceChildren(
    h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Accounts'), h('span', { class: 'stat-value' }, m.accounts.length)),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Open trades'), h('span', { class: 'stat-value' }, openTrades)),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Total equity'), h('span', { class: 'stat-value small' }, lines('equity'))),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Floating P&L'), h('span', { class: 'stat-value small' }, lines('floating', true))),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Closed today'), h('span', { class: 'stat-value small' }, lines('closed', true))));

  if (!m.accounts.length) {
    $('#mon-accounts').replaceChildren(h('div', { class: 'empty' }, h('p', {}, m.state === 'connected'
      ? 'No demo accounts found on this cTrader ID.' + (m.hiddenLiveAccounts ? ` (${m.hiddenLiveAccounts} live account(s) are hidden on purpose.)` : '')
      : 'Loading your accounts…')));
    return;
  }

  const openDetails = new Set([...document.querySelectorAll('#mon-accounts details[open]')].map((d) => d.dataset.id));
  $('#mon-accounts').replaceChildren(...m.accounts.map((a) => {
    const cur = a.currency;
    const bots = a.bots.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'cBot (label)'), h('th', {}, 'Symbols'), h('th', { class: 'num' }, 'Open trades'), h('th', { class: 'num' }, 'Floating P&L'))),
        h('tbody', {}, a.bots.map((b) => h('tr', {},
          h('td', {}, b.name || h('span', { class: 'muted' }, 'No label (manual or unlabelled cBot)')),
          h('td', {}, b.symbols.join(', ')),
          h('td', { class: 'num' }, b.trades),
          h('td', { class: 'num' }, pnl(b.floating, cur)))))))
      : h('p', { class: 'mon-empty' }, 'No open trades right now.');
    const positions = a.positions.length ? h('details', { dataset: { id: a.id }, open: openDetails.has(a.id) },
      h('summary', {}, `Open trades (${a.positions.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Symbol', 'Side', 'Lots', 'Open price', 'Opened', 'Label'].map((t) => h('th', {}, t)), h('th', { class: 'num' }, 'P&L'))),
        h('tbody', {}, a.positions.map((p) => h('tr', {},
          h('td', {}, p.symbol),
          h('td', { class: p.side === 'Buy' ? 'pos' : 'neg' }, p.side),
          h('td', {}, p.lots !== null ? +p.lots.toFixed(4) : `${p.units} units`),
          h('td', {}, p.openPrice ?? '—'),
          h('td', {}, p.openedAt ? new Date(p.openedAt).toLocaleString() : '—'),
          h('td', {}, p.label || p.comment || '—'),
          h('td', { class: 'num' }, pnl(p.netPnl, cur)))))))) : null;

    return h('article', { class: 'card mon-account' },
      h('header', {},
        h('div', {}, h('h3', {}, `#${a.login}`), h('span', { class: 'muted' }, [a.broker, cur, 'Demo'].filter(Boolean).join(' · '))),
        h('button', { class: 'btn small', onclick: (e) => downloadHistory(a.id, e.currentTarget) }, 'Download trade history (CSV)')),
      a.error ? h('p', { class: 'bot-error' }, a.error) : null,
      h('div', { class: 'metrics' },
        metric('Balance', fmtMoney(a.balance, cur)),
        metric('Equity', fmtMoney(a.equity, cur)),
        metric('Floating P&L', pnl(a.floating, cur)),
        metric(`Closed today (${a.closedToday.count})`, pnl(a.closedToday.pnl, cur))),
      bots,
      positions);
  }));
}

async function downloadHistory(accountId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing… (can take a minute)';
  try {
    const res = await fetch(`/api/monitor/history.csv?account=${encodeURIComponent(accountId)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Download failed.');
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'trade-history.csv';
    const url = URL.createObjectURL(await res.blob());
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('Trade history downloaded.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$('#mon-csv-all').addEventListener('click', (e) => downloadHistory('all', e.currentTarget));

$('#mon-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#mon-redirect').textContent);
    toast('Copied.');
  } catch {
    toast('Select the address and copy it manually.', 'error');
  }
});

$('#mon-cred-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('.form-error', form.parentElement);
  error.textContent = '';
  try {
    state.monitor = { ...state.monitor, ...(await api('/monitor/credentials', {
      method: 'POST',
      body: { clientId: form.clientId.value, clientSecret: form.clientSecret.value },
    })) };
    form.clientSecret.value = '';
    renderMonitor();
    toast('Saved. Now press "Connect cTrader".');
  } catch (err) {
    error.textContent = err.message;
  }
});

$('#mon-connect').addEventListener('click', async () => {
  const result = await run(() => api('/monitor/connect', { method: 'POST' }));
  if (result?.url) location.href = result.url;
});

$('#mon-disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect the monitor from cTrader? Your cBots keep running; you can connect again any time.')) return;
  const snapshot = await run(() => api('/monitor/disconnect', { method: 'POST' }));
  if (snapshot) {
    state.monitor = { ...state.monitor, ...snapshot };
    renderMonitor();
  }
});

// --- Boot --------------------------------------------------------------------------

async function boot() {
  const session = await api('/session');
  if (!session.authenticated) return showLogin();

  const [status, accounts, bots, instances, monitor] = await Promise.all([
    api('/status'), api('/accounts'), api('/bots'), api('/instances'),
    api('/monitor').catch(() => {
      toast('The dashboard program running on this computer is an older version. Close every dashboard window, then double-click the Start file again.', 'error');
      return { state: 'not_configured', accounts: [] };
    }),
  ]);
  Object.assign(state, { status, accounts, bots, monitor, instances: new Map(instances.map((i) => [i.id, i])) });

  const simulated = status.runner === 'simulation';
  $('#sim-banner').hidden = !simulated;
  $('#logout-btn').hidden = !session.authRequired;

  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  let tab = 'monitor';
  try { tab = localStorage.getItem('ctdash.tab') || tab; } catch { /* storage unavailable */ }

  // Coming back from cTrader's login page.
  const params = new URLSearchParams(location.search);
  if (params.has('monitor') || params.has('monitor_error')) {
    tab = 'monitor';
    if (params.get('monitor') === 'connected') toast('cTrader connected. Loading your accounts…');
    if (params.get('monitor_error')) toast(`cTrader connection failed: ${params.get('monitor_error')}`, 'error');
    history.replaceState(null, '', location.pathname);
  }
  selectTab(document.querySelector(`[data-tab="${tab}"]`) ? tab : 'monitor');
  renderAll();
  renderMonitor();
  connectEvents();

  // Seed each card's "last line" preview.
  await Promise.all(instances.map(async (inst) => {
    const logs = await api(`/instances/${inst.id}/logs`).catch(() => []);
    if (logs.length) appendLog(inst.id, logs[logs.length - 1]);
  }));
}

boot().catch((err) => toast(err.message, 'error'));
