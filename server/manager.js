import { EventEmitter } from 'node:events';
import { HttpError } from './validation.js';

const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_IN_WINDOW = 5;

/**
 * Owns the lifecycle of every cBot instance: start/stop, live logs, crash
 * detection and automatic restarts. Emits:
 *   'instance' (view)            whenever an instance's state changes
 *   'log'      ({ id, entry })   for every new log line
 */
export class Manager extends EventEmitter {
  constructor({ store, runner, maxLogLines = 1000 }) {
    super();
    this.store = store;
    this.runner = runner;
    this.maxLogLines = maxLogLines;
    this.runtime = new Map();
  }

  rt(id) {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = { status: 'stopped', startedAt: null, exitCode: null, error: null, logs: [], restarts: [], gen: 0, timer: null };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  view(instance) {
    const rt = this.rt(instance.id);
    return {
      ...instance,
      status: rt.status,
      startedAt: rt.startedAt,
      exitCode: rt.exitCode,
      error: rt.error,
    };
  }

  list() {
    return this.store.list('instances').map((instance) => this.view(instance));
  }

  logs(id) {
    return this.rt(id).logs;
  }

  isActive(id) {
    return ['starting', 'running', 'stopping', 'restarting'].includes(this.rt(id).status);
  }

  /** Re-attach to cBots that kept running while the dashboard was offline and resume the rest. */
  async init() {
    const containers = await this.runner.listContainers();
    for (const { instanceId, running } of containers) {
      const instance = this.store.get('instances', instanceId);
      if (!instance || !running) {
        await this.runner.remove(instanceId);
        continue;
      }
      const rt = this.rt(instanceId);
      rt.status = 'running';
      rt.startedAt = new Date().toISOString();
      this.log(instanceId, 'Dashboard restarted; reconnected to running cBot.', 'system');
      this.runner.attach(instanceId, this.handlers(instanceId, ++rt.gen));
    }
    for (const instance of this.store.list('instances')) {
      if (instance.desiredState === 'running' && !this.isActive(instance.id)) {
        this.log(instance.id, 'Resuming cBot that was running before the dashboard restarted.', 'system');
        this.launch(instance.id).catch(() => {});
      }
    }
  }

  async start(id) {
    const instance = this.requireInstance(id);
    if (this.isActive(id) && this.rt(id).status !== 'restarting') return this.view(instance);
    await this.store.update('instances', id, { desiredState: 'running' });
    const rt = this.rt(id);
    rt.restarts = [];
    await this.launch(id);
    return this.view(instance);
  }

  async stop(id) {
    const instance = this.requireInstance(id);
    await this.store.update('instances', id, { desiredState: 'stopped' });
    const rt = this.rt(id);
    clearTimeout(rt.timer);
    rt.timer = null;
    if (rt.status === 'restarting' || rt.status === 'crashed') {
      this.setStatus(id, 'stopped');
      return this.view(instance);
    }
    if (!this.isActive(id)) return this.view(instance);

    this.setStatus(id, 'stopping');
    this.log(id, 'Stopping cBot...', 'system');
    try {
      await this.runner.stop(id);
    } catch (err) {
      this.log(id, `Stop failed: ${err.message}`, 'system');
      this.setStatus(id, 'running');
      throw new HttpError(500, `Could not stop cBot: ${err.message}`);
    }
    return this.view(instance);
  }

  async restart(id) {
    await this.stop(id);
    await this.waitUntilIdle(id);
    return this.start(id);
  }

  async startAll() {
    const ids = this.store.list('instances').map((i) => i.id).filter((id) => !this.isActive(id));
    await Promise.allSettled(ids.map((id) => this.start(id)));
  }

  async stopAll() {
    const ids = this.store.list('instances').map((i) => i.id).filter((id) => this.isActive(id));
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }

  async shutdown() {
    // Containers keep running on purpose when the dashboard stops; only stop simulated bots.
    if (this.runner.name !== 'docker') {
      await Promise.allSettled([...this.runtime.keys()].map((id) => this.runner.stop(id)));
    }
  }

  forget(id) {
    clearTimeout(this.rt(id).timer);
    this.runtime.delete(id);
  }

  // --- internals -----------------------------------------------------------

  requireInstance(id) {
    const instance = this.store.get('instances', id);
    if (!instance) throw new HttpError(404, 'Bot not found.');
    return instance;
  }

  async launch(id) {
    const instance = this.requireInstance(id);
    const account = this.store.get('accounts', instance.accountId);
    const bot = this.store.get('bots', instance.botId);
    const rt = this.rt(id);
    clearTimeout(rt.timer);
    rt.timer = null;

    if (!account || !bot) return this.failStart(id, 'Its account or cBot file has been deleted.');
    if (!account.isDemo) return this.failStart(id, 'cBots can only run on demo accounts.');

    const gen = ++rt.gen;
    rt.error = null;
    rt.exitCode = null;
    this.setStatus(id, 'starting');
    this.log(id, `Starting "${bot.name}" on ${account.label} (${instance.symbol} ${instance.period.toUpperCase()})...`, 'system');
    try {
      await this.runner.start({ instance, account, bot }, this.handlers(id, gen));
    } catch (err) {
      if (gen === rt.gen) this.failStart(id, err.message);
      return;
    }
    if (gen === rt.gen && rt.status === 'starting') {
      rt.startedAt = new Date().toISOString();
      this.setStatus(id, 'running');
    }
  }

  failStart(id, message) {
    const rt = this.rt(id);
    rt.error = message;
    this.log(id, `Could not start: ${message}`, 'system');
    this.setStatus(id, 'crashed');
    throw new HttpError(500, `Could not start cBot: ${message}`);
  }

  handlers(id, gen) {
    return {
      onLog: (line, stream) => {
        if (gen === this.rt(id).gen) this.log(id, line, stream);
      },
      onExit: (code) => {
        if (gen === this.rt(id).gen) this.handleExit(id, code);
      },
    };
  }

  handleExit(id, code) {
    const rt = this.rt(id);
    const instance = this.store.get('instances', id);
    const userStopped = rt.status === 'stopping' || !instance || instance.desiredState !== 'running';
    rt.exitCode = code;
    rt.startedAt = null;

    if (userStopped) {
      this.log(id, 'cBot stopped.', 'system');
      this.setStatus(id, 'stopped');
      return;
    }
    if (code === 0) {
      // The cBot called Stop() itself; respect that rather than restarting it.
      this.log(id, 'cBot stopped by itself.', 'system');
      this.store.update('instances', id, { desiredState: 'stopped' }).catch(() => {});
      this.setStatus(id, 'stopped');
      return;
    }

    rt.error = `cBot exited unexpectedly (exit code ${code ?? 'unknown'}).`;
    this.log(id, rt.error, 'system');
    if (!instance.autoRestart) {
      this.setStatus(id, 'crashed');
      return;
    }
    const now = Date.now();
    rt.restarts = rt.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (rt.restarts.length >= MAX_RESTARTS_IN_WINDOW) {
      this.log(id, `Crashed ${MAX_RESTARTS_IN_WINDOW} times in 10 minutes; giving up. Check the logs and start it again.`, 'system');
      this.setStatus(id, 'crashed');
      return;
    }
    const delay = Math.min(60_000, 5_000 * 2 ** rt.restarts.length);
    rt.restarts.push(now);
    this.log(id, `Restarting in ${Math.round(delay / 1000)} seconds...`, 'system');
    this.setStatus(id, 'restarting');
    rt.timer = setTimeout(() => this.launch(id).catch(() => {}), delay);
  }

  waitUntilIdle(id, timeoutMs = 60_000) {
    if (!this.isActive(id) || this.rt(id).status === 'restarting') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('instance', onChange);
        resolve();
      };
      const onChange = (view) => {
        if (view.id === id && !this.isActive(id)) done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.on('instance', onChange);
    });
  }

  setStatus(id, status) {
    this.rt(id).status = status;
    const instance = this.store.get('instances', id);
    if (instance) this.emit('instance', this.view(instance));
  }

  log(id, line, stream) {
    const entry = { t: new Date().toISOString(), line, stream };
    const logs = this.rt(id).logs;
    logs.push(entry);
    if (logs.length > this.maxLogLines) logs.splice(0, logs.length - this.maxLogLines);
    this.emit('log', { id, entry });
  }
}
