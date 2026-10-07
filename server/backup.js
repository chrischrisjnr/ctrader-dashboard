import fs from 'node:fs/promises';
import path from 'node:path';

const HISTORY_FILE = /^[\w-]+-(equity\.csv|balance\.json)$/;
export const BACKUP_APP = 'ctrader-dashboard';

/**
 * One file holding everything the Monitor needs to move to another computer or server:
 * Open API app + login tokens, account names, and balance/equity history.
 */
export async function createBackup(dataDir) {
  const readJson = async (file, fallback) => {
    try {
      return JSON.parse(await fs.readFile(path.join(dataDir, file), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  };
  const history = {};
  const historyDir = path.join(dataDir, 'history');
  let names = [];
  try {
    names = await fs.readdir(historyDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const name of names) {
    if (HISTORY_FILE.test(name)) history[name] = await fs.readFile(path.join(historyDir, name), 'utf8');
  }
  return {
    app: BACKUP_APP,
    version: 1,
    createdAt: new Date().toISOString(),
    settings: await readJson('openapi.json', {}),
    accountNames: await readJson('account-names.json', {}),
    history,
  };
}

async function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Merges a backup into this dashboard's data. Nothing already here is thrown away:
 * logins are combined, names from the backup win, equity samples are combined.
 */
export async function restoreBackup(dataDir, backup) {
  if (!backup || backup.app !== BACKUP_APP || backup.version !== 1) {
    throw new Error('That file is not a cBot Control backup.');
  }
  const current = await createBackup(dataDir);

  // Open API app + logins
  const incoming = backup.settings && typeof backup.settings === 'object' ? backup.settings : {};
  const logins = [...(current.settings.logins || [])];
  for (const login of Array.isArray(incoming.logins) ? incoming.logins : []) {
    if (login?.accessToken && !logins.some((l) => l.accessToken === login.accessToken)) logins.push(login);
  }
  const settings = {
    clientId: current.settings.clientId || incoming.clientId,
    clientSecret: current.settings.clientSecret || incoming.clientSecret,
    logins,
  };
  if (incoming.clientId && current.settings.clientId && incoming.clientId !== current.settings.clientId) {
    // A different Open API app: its logins only work with its own credentials.
    settings.clientId = incoming.clientId;
    settings.clientSecret = incoming.clientSecret;
    settings.logins = Array.isArray(incoming.logins) ? incoming.logins.filter((l) => l?.accessToken) : [];
  }
  await fs.mkdir(dataDir, { recursive: true });
  await writeAtomic(path.join(dataDir, 'openapi.json'), JSON.stringify(settings, null, 2));

  // Account names
  const names = { ...current.accountNames };
  for (const [id, meta] of Object.entries(backup.accountNames || {})) {
    if (/^\d+$/.test(id) && meta && typeof meta === 'object') {
      names[id] = { name: String(meta.name || '').slice(0, 60), algorithm: String(meta.algorithm || '').slice(0, 120) };
    }
  }
  await writeAtomic(path.join(dataDir, 'account-names.json'), JSON.stringify(names, null, 2));

  // History
  const historyDir = path.join(dataDir, 'history');
  await fs.mkdir(historyDir, { recursive: true });
  let files = 0;
  for (const [name, content] of Object.entries(backup.history || {})) {
    if (!HISTORY_FILE.test(name) || typeof content !== 'string') continue;
    const target = path.join(historyDir, name);
    if (name.endsWith('-equity.csv')) {
      const lines = new Map();
      for (const line of `${current.history[name] || ''}\n${content}`.split('\n')) {
        const [t, b, e] = line.split(',').map(Number);
        if (Number.isFinite(t) && Number.isFinite(b) && Number.isFinite(e)) lines.set(t, `${t},${b},${e}`);
      }
      const merged = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l).join('\n');
      await writeAtomic(target, merged ? `${merged}\n` : '');
    } else {
      // Balance history is rebuilt from cTrader anyway; keep whichever copy is more complete.
      let keep = content;
      try {
        const mine = JSON.parse(current.history[name] || 'null');
        const theirs = JSON.parse(content);
        if (mine && (!theirs || (mine.through || 0) >= (theirs.through || 0))) keep = current.history[name];
      } catch {
        // invalid incoming JSON: keep ours if we have it
        if (current.history[name]) keep = current.history[name];
        else continue;
      }
      await writeAtomic(target, keep);
    }
    files += 1;
  }
  return { logins: settings.logins.length, names: Object.keys(names).length, historyFiles: files };
}
