import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Manager } from '../server/manager.js';
import { Store } from '../server/store.js';

/** Runner double that lets tests decide when a bot exits. */
class FakeRunner {
  name = 'fake';
  started = [];
  handlers = new Map();
  async start(ctx, handlers) {
    this.started.push(ctx.instance.id);
    this.handlers.set(ctx.instance.id, handlers);
    handlers.onLog('hello', 'stdout');
  }
  async stop(id) {
    this.handlers.get(id)?.onExit(143);
  }
  crash(id, code = 1) {
    this.handlers.get(id).onExit(code);
  }
  async listContainers() { return []; }
  attach() {}
  async remove() {}
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctdash-'));
  const store = new Store(path.join(dir, 'db.json'));
  const account = await store.insert('accounts', { label: 'A', ctid: 'x', accountNumber: '1', isDemo: true });
  const bot = await store.insert('bots', { name: 'B', file: 'b.algo' });
  const instance = await store.insert('instances', {
    name: 'I', botId: bot.id, accountId: account.id, symbol: 'EURUSD', period: 'h1', parameters: {}, autoRestart: true, desiredState: 'stopped',
  });
  const runner = new FakeRunner();
  const manager = new Manager({ store, runner });
  return { dir, store, runner, manager, instance };
}

test('start and stop update status and desired state', async (t) => {
  const { dir, store, runner, manager, instance } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await manager.start(instance.id);
  assert.equal(manager.view(instance).status, 'running');
  assert.equal(store.get('instances', instance.id).desiredState, 'running');
  assert.equal(manager.logs(instance.id).at(-1).line, 'hello');

  await manager.stop(instance.id);
  assert.equal(manager.view(instance).status, 'stopped');
  assert.equal(store.get('instances', instance.id).desiredState, 'stopped');
  assert.deepEqual(runner.started, [instance.id]);
});

test('a crash schedules an automatic restart', async (t) => {
  const { dir, runner, manager, instance } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });

  await manager.start(instance.id);
  runner.crash(instance.id);
  assert.equal(manager.view(instance).status, 'restarting');

  t.mock.timers.tick(5_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(manager.view(instance).status, 'running');
  assert.equal(runner.started.length, 2);
});

test('gives up after repeated crashes', async (t) => {
  const { dir, runner, manager, instance } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });

  await manager.start(instance.id);
  for (let i = 0; i < 5; i++) {
    runner.crash(instance.id);
    t.mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
  }
  runner.crash(instance.id);
  assert.equal(manager.view(instance).status, 'crashed');
});

test('a cBot that stops itself is not restarted', async (t) => {
  const { dir, store, runner, manager, instance } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await manager.start(instance.id);
  runner.crash(instance.id, 0);
  assert.equal(manager.view(instance).status, 'stopped');
  await store.pending;
  assert.equal(store.get('instances', instance.id).desiredState, 'stopped');
});

test('refuses to start on a non-demo account', async (t) => {
  const { dir, store, manager, instance } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.update('accounts', instance.accountId, { isDemo: false });
  await assert.rejects(manager.start(instance.id), /demo/);
  assert.equal(manager.view(instance).status, 'crashed');
});

test('store persists to disk', async (t) => {
  const { dir, store } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const reloaded = new Store(store.file);
  await reloaded.load();
  assert.equal(reloaded.list('instances').length, 1);
});
