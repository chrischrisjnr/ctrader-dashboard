import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBackup, restoreBackup } from '../server/backup.js';
import { Monitor } from '../server/monitor.js';
import { startFakeCtrader } from './helpers/fake-ctrader.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctdash-bk-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a backup moves logins, names and history to another dashboard and merges with what is there', async (t) => {
  const mac = await tempDir(t);
  const server = await tempDir(t);
  await fs.mkdir(path.join(mac, 'history'));
  await fs.writeFile(path.join(mac, 'openapi.json'), JSON.stringify({ clientId: 'app-1', clientSecret: 'secret-123', logins: [{ id: 'a', accessToken: 'access-1' }, { id: 'b', accessToken: 'access-2' }] }));
  await fs.writeFile(path.join(mac, 'account-names.json'), JSON.stringify({ 101: { name: 'Gold test', algorithm: 'MRZ' } }));
  await fs.writeFile(path.join(mac, 'history', '101-equity.csv'), '1000,10,11\n2000,10,12\n');
  await fs.writeFile(path.join(mac, 'history', '../evil.txt'), 'x').catch(() => {});

  // The server already has the app and one login connected, plus a newer equity sample.
  await fs.mkdir(path.join(server, 'history'));
  await fs.writeFile(path.join(server, 'openapi.json'), JSON.stringify({ clientId: 'app-1', clientSecret: 'secret-123', logins: [{ id: 'z', accessToken: 'access-9' }] }));
  await fs.writeFile(path.join(server, 'history', '101-equity.csv'), '2000,10,12\n3000,10,13\n');

  const backup = JSON.parse(JSON.stringify(await createBackup(mac)));
  assert.equal(backup.app, 'ctrader-dashboard');
  assert.deepEqual(Object.keys(backup.history), ['101-equity.csv']);

  const result = await restoreBackup(server, backup);
  assert.deepEqual(result, { logins: 3, names: 1, historyFiles: 1 });
  const settings = JSON.parse(await fs.readFile(path.join(server, 'openapi.json'), 'utf8'));
  assert.deepEqual(settings.logins.map((l) => l.accessToken), ['access-9', 'access-1', 'access-2']);
  assert.equal(JSON.parse(await fs.readFile(path.join(server, 'account-names.json'), 'utf8'))['101'].name, 'Gold test');
  assert.equal(await fs.readFile(path.join(server, 'history', '101-equity.csv'), 'utf8'), '1000,10,11\n2000,10,12\n3000,10,13\n');

  // Restoring the same file again changes nothing.
  assert.equal((await restoreBackup(server, backup)).logins, 3);

  await assert.rejects(restoreBackup(server, { hello: 1 }), /not a cBot Control backup/);
  await assert.rejects(restoreBackup(server, null), /not a cBot Control backup/);
  // Unsafe file names in a tampered backup are ignored.
  await restoreBackup(server, { ...backup, history: { '../../escape-equity.csv': '1,1,1\n' } });
  await assert.rejects(fs.access(path.join(server, '..', 'escape-equity.csv')));
});

test('after restoring, the monitor reconnects with the restored logins', async (t) => {
  const fake = await startFakeCtrader();
  t.after(() => fake.close());
  const mac = await tempDir(t);
  const server = await tempDir(t);
  await fs.writeFile(path.join(mac, 'openapi.json'), JSON.stringify({ clientId: 'app-1', clientSecret: 'secret-123', logins: [{ id: 'a', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 1e10 }, { id: 'b', accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: Date.now() + 1e10 }] }));

  const monitor = new Monitor({ file: path.join(server, 'openapi.json'), config: fake.config });
  t.after(() => monitor.stop());
  await monitor.load();
  assert.equal(monitor.state, 'not_configured');
  await restoreBackup(server, await createBackup(mac));
  await monitor.reload();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`state=${monitor.state} ${monitor.error}`)), 5000);
    const check = () => {
      const s = monitor.snapshot();
      if (s.state === 'connected' && s.accounts.length === 3) { clearTimeout(timer); monitor.off('update', check); resolve(); }
    };
    monitor.on('update', check);
    check();
  });
  assert.equal(monitor.snapshot().logins.length, 2);
});

test('when two copies of a login exist, the working one is kept', async (t) => {
  const fake = await startFakeCtrader();
  t.after(() => fake.close());
  const dir = await tempDir(t);
  const future = Date.now() + 1e10;
  await fs.writeFile(path.join(dir, 'openapi.json'), JSON.stringify({
    clientId: 'app-1',
    clientSecret: 'secret-123',
    logins: [
      { id: 'works', accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: future, accountLogins: [7001234] },
      { id: 'stale', accessToken: 'revoked', refreshToken: 'revoked', expiresAt: future, accountLogins: [7001234] },
    ],
  }));
  const monitor = new Monitor({ file: path.join(dir, 'openapi.json'), config: fake.config });
  t.after(() => monitor.stop());
  await monitor.load();
  monitor.start();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`state=${monitor.state}`)), 5000);
    const check = () => {
      if (monitor.snapshot().state === 'connected') { clearTimeout(timer); monitor.off('update', check); resolve(); }
    };
    monitor.on('update', check);
    check();
  });
  assert.deepEqual(monitor.snapshot().logins.map((l) => l.id), ['works']);
});
