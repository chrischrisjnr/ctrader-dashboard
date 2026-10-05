import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { newId } from './store.js';
import { HttpError, PERIODS, validateAccount, validateInstance } from './validation.js';

export function createApi({ store, manager, monitor, config, auth }) {
  const api = express.Router();
  const botsDir = path.join(config.dataDir, 'bots');
  const secretsDir = path.join(config.dataDir, 'secrets');

  const upload = multer({
    storage: multer.diskStorage({
      destination: botsDir,
      filename: (_req, _file, cb) => cb(null, `${newId()}.algo`),
    }),
    limits: { fileSize: config.maxBotUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (path.extname(file.originalname).toLowerCase() === '.algo') return cb(null, true);
      cb(new HttpError(400, 'Upload a compiled cBot file ending in .algo.'));
    },
  });

  // --- session ---------------------------------------------------------------

  api.get('/session', (req, res) => {
    res.json({ authRequired: auth.enabled, authenticated: auth.isAuthenticated(req) });
  });
  api.post('/login', auth.login);
  api.post('/logout', auth.logout);

  api.use(auth.requireAuth);

  api.get('/status', (_req, res) => {
    res.json({ runner: manager.runner.name, image: config.ctraderImage, periods: PERIODS });
  });

  // --- accounts --------------------------------------------------------------

  const publicAccount = (a) => ({ ...a, hasPassword: true });

  async function writePassword(accountId, password) {
    // Directory is private to this user; the file itself must be readable by the
    // cTrader container, which may run as a different user.
    await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(secretsDir, `${accountId}.pwd`), password, { mode: 0o644 });
  }

  function assertUniqueAccount(account, exceptId) {
    const duplicate = store.list('accounts').some(
      (a) => a.id !== exceptId && a.accountNumber === account.accountNumber && a.ctid.toLowerCase() === account.ctid.toLowerCase(),
    );
    if (duplicate) throw new HttpError(409, 'This account has already been added.');
  }

  api.get('/accounts', (_req, res) => {
    res.json(store.list('accounts').map(publicAccount));
  });

  api.post('/accounts', async (req, res) => {
    const { account, password } = validateAccount(req.body);
    assertUniqueAccount(account);
    const created = await store.insert('accounts', account);
    await writePassword(created.id, password);
    res.status(201).json(publicAccount(created));
  });

  api.put('/accounts/:id', async (req, res) => {
    const existing = store.get('accounts', req.params.id);
    if (!existing) throw new HttpError(404, 'Account not found.');
    const { account, password } = validateAccount(req.body, existing);
    assertUniqueAccount(account, existing.id);
    if (password) await writePassword(existing.id, password);
    const updated = await store.update('accounts', existing.id, account);
    res.json(publicAccount(updated));
  });

  api.delete('/accounts/:id', async (req, res) => {
    const id = req.params.id;
    if (!store.get('accounts', id)) throw new HttpError(404, 'Account not found.');
    if (store.list('instances').some((i) => i.accountId === id)) {
      throw new HttpError(409, 'Remove the bots that use this account first.');
    }
    await store.remove('accounts', id);
    await fs.rm(path.join(secretsDir, `${id}.pwd`), { force: true });
    res.status(204).end();
  });

  // --- cBot files -------------------------------------------------------------

  api.get('/bots', (_req, res) => {
    res.json(store.list('bots'));
  });

  api.post('/bots', upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose a .algo file to upload.');
    const fallback = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const name = String(req.body.name || fallback).trim().slice(0, 60) || 'cBot';
    const bot = await store.insert('bots', {
      name,
      originalName: req.file.originalname.slice(0, 120),
      file: req.file.filename,
      size: req.file.size,
    });
    res.status(201).json(bot);
  });

  api.delete('/bots/:id', async (req, res) => {
    const bot = store.get('bots', req.params.id);
    if (!bot) throw new HttpError(404, 'cBot not found.');
    if (store.list('instances').some((i) => i.botId === bot.id)) {
      throw new HttpError(409, 'Remove the bots that use this cBot first.');
    }
    await store.remove('bots', bot.id);
    await fs.rm(path.join(botsDir, path.basename(bot.file)), { force: true });
    res.status(204).end();
  });

  // --- running bots (instances) -------------------------------------------------

  api.get('/instances', (_req, res) => {
    res.json(manager.list());
  });

  api.post('/instances', async (req, res) => {
    const instance = await store.insert('instances', { ...validateInstance(req.body, store), desiredState: 'stopped' });
    res.status(201).json(manager.view(instance));
  });

  api.put('/instances/:id', async (req, res) => {
    const id = req.params.id;
    if (!store.get('instances', id)) throw new HttpError(404, 'Bot not found.');
    const updated = await store.update('instances', id, validateInstance(req.body, store));
    const view = manager.view(updated);
    manager.emit('instance', view);
    res.json(view);
  });

  api.delete('/instances/:id', async (req, res) => {
    const id = req.params.id;
    if (!store.get('instances', id)) throw new HttpError(404, 'Bot not found.');
    if (manager.isActive(id)) throw new HttpError(409, 'Stop the bot before deleting it.');
    await store.remove('instances', id);
    manager.forget(id);
    res.status(204).end();
  });

  api.get('/instances/:id/logs', (req, res) => {
    if (!store.get('instances', req.params.id)) throw new HttpError(404, 'Bot not found.');
    res.json(manager.logs(req.params.id));
  });

  for (const action of ['start', 'stop', 'restart']) {
    api.post(`/instances/:id/${action}`, async (req, res) => {
      res.json(await manager[action](req.params.id));
    });
  }

  api.post('/start-all', async (_req, res) => {
    await manager.startAll();
    res.json(manager.list());
  });

  api.post('/stop-all', async (_req, res) => {
    await manager.stopAll();
    res.json(manager.list());
  });

  // --- account monitor (cTrader Open API, read-only) ---------------------------

  api.get('/monitor', (req, res) => {
    res.json({ ...monitor.snapshot(), redirectUri: oauthRedirectUri(req) });
  });

  api.post('/monitor/credentials', async (req, res) => {
    const clientId = String(req.body?.clientId ?? '').trim();
    const clientSecret = String(req.body?.clientSecret ?? '').trim();
    if (!/^[\w.-]{4,200}$/.test(clientId)) throw new HttpError(400, 'Client ID is not valid.');
    if (!/^[\w.-]{4,200}$/.test(clientSecret)) throw new HttpError(400, 'Client Secret is not valid.');
    await monitor.saveCredentials({ clientId, clientSecret });
    res.json(monitor.snapshot());
  });

  api.post('/monitor/connect', (req, res) => {
    try {
      res.json({ url: monitor.beginLogin(oauthRedirectUri(req)) });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });

  api.delete('/monitor/logins/:id', async (req, res) => {
    try {
      await monitor.removeLogin(req.params.id);
    } catch (err) {
      throw new HttpError(404, err.message);
    }
    res.json(monitor.snapshot());
  });

  api.post('/monitor/disconnect', async (_req, res) => {
    await monitor.disconnect();
    res.json(monitor.snapshot());
  });

  api.get('/monitor/history.csv', async (req, res) => {
    const account = String(req.query.account || 'all');
    let csv;
    try {
      csv = await monitor.exportHistoryCsv(account);
    } catch (err) {
      throw new HttpError(409, err.message);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const name = account === 'all' ? 'all-accounts' : `account-${account.replace(/\W/g, '')}`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="trade-history-${name}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.send(csv);
  });

  // --- live updates (Server-Sent Events) ---------------------------------------

  api.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onInstance = (view) => send('instance', view);
    const onLog = (payload) => send('log', payload);
    const onMonitor = (snapshot) => send('monitor', snapshot);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    manager.on('instance', onInstance);
    manager.on('log', onLog);
    monitor.on('update', onMonitor);
    req.on('close', () => {
      clearInterval(heartbeat);
      manager.off('instance', onInstance);
      manager.off('log', onLog);
      monitor.off('update', onMonitor);
    });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  api.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong.' : err.message });
  });

  return api;
}

export function oauthRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/oauth/callback`;
}

/** Where cTrader sends the browser back after the user approves access. */
export function createOAuthCallback({ monitor, auth }) {
  return async (req, res) => {
    if (!auth.isAuthenticated(req)) return res.redirect('/');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      const reason = String(req.query.error_description || req.query.error || 'Access was not granted.');
      return res.redirect(`/?monitor_error=${encodeURIComponent(reason.slice(0, 200))}`);
    }
    try {
      await monitor.finishLogin({ code, redirectUri: oauthRedirectUri(req) });
      res.redirect('/?monitor=connected');
    } catch (err) {
      res.redirect(`/?monitor_error=${encodeURIComponent(err.message.slice(0, 200))}`);
    }
  };
}
