import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LABEL = 'ctrader-dashboard.instance';

export function containerName(instanceId) {
  return `ctdash-${instanceId}`;
}

/**
 * Builds the `docker run` arguments for one cBot instance using the official
 * cTrader CLI image. Returned as an argv array (never a shell string), so no
 * user value can be interpreted by a shell.
 */
export function buildRunArgs({ instance, account, bot, config }) {
  const botFile = `/mnt/bots/${path.basename(bot.file)}`;
  const pwdFile = '/mnt/secrets/ctrader.pwd';
  const params = Object.entries(instance.parameters || {});

  const args = [
    'run', '-d',
    '--name', containerName(instance.id),
    '--label', `${LABEL}=${instance.id}`,
    '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
    '-v', `${path.join(config.hostDataDir, 'bots', path.basename(bot.file))}:${botFile}:ro`,
    '-v', `${path.join(config.hostDataDir, 'secrets', `${account.id}.pwd`)}:${pwdFile}:ro`,
  ];
  // cBot parameters are read from environment variables named exactly like the parameter.
  for (const [name, value] of params) args.push('-e', `${name}=${value}`);

  args.push(
    config.ctraderImage,
    'run', botFile,
    `--ctid=${account.ctid}`,
    `--pwd-file=${pwdFile}`,
    `--account=${account.accountNumber}`,
    `--symbol=${instance.symbol}`,
    `--period=${instance.period}`,
    '--exit-on-stop',
  );
  if (params.length) args.push('--environment-variables');
  if (instance.fullAccess) args.push('--full-access');
  return args;
}

export class DockerRunner {
  name = 'docker';

  constructor(config) {
    this.config = config;
    this.followers = new Map(); // instanceId -> `docker logs -f` child process
  }

  static async isAvailable(config) {
    try {
      await execFileAsync(config.dockerBin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  docker(args, timeout = 60_000) {
    return execFileAsync(this.config.dockerBin, args, { timeout, maxBuffer: 10 * 1024 * 1024 });
  }

  async start(ctx, handlers) {
    // Clear out any leftover container with the same name from an earlier run.
    await this.docker(['rm', '-f', containerName(ctx.instance.id)]).catch(() => {});
    try {
      await this.docker(buildRunArgs({ ...ctx, config: this.config }), 10 * 60_000);
    } catch (err) {
      throw new Error(cleanDockerError(err));
    }
    this.attach(ctx.instance.id, handlers, 0);
  }

  /** Streams the container's output and reports its exit code once it stops. */
  attach(instanceId, { onLog, onExit }, tail = 200) {
    const name = containerName(instanceId);
    const child = spawn(this.config.dockerBin, ['logs', '-f', '--tail', String(tail), name], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.followers.set(instanceId, child);
    readline.createInterface({ input: child.stdout }).on('line', (line) => onLog(line, 'stdout'));
    readline.createInterface({ input: child.stderr }).on('line', (line) => onLog(line, 'stderr'));

    child.on('close', async () => {
      if (this.followers.get(instanceId) === child) this.followers.delete(instanceId);
      let code = null;
      try {
        const { stdout } = await this.docker(['wait', name]);
        code = Number.parseInt(stdout.trim(), 10);
      } catch {
        // Container already gone; exit code unknown.
      }
      await this.docker(['rm', '-f', name]).catch(() => {});
      onExit(Number.isNaN(code) ? null : code);
    });
    child.on('error', (err) => onLog(`Could not read logs: ${err.message}`, 'stderr'));
  }

  async stop(instanceId) {
    try {
      await this.docker(['stop', '--time', '20', containerName(instanceId)]);
    } catch (err) {
      // "No such container" means it already stopped; anything else is a real failure.
      if (!/no such container/i.test(String(err.stderr || err.message))) throw new Error(cleanDockerError(err));
    }
  }

  /** @returns {Promise<Array<{instanceId: string, running: boolean}>>} */
  async listContainers() {
    const { stdout } = await this.docker([
      'ps', '-a', '--filter', `label=${LABEL}`, '--format', `{{.Label "${LABEL}"}}\t{{.State}}`,
    ]);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [instanceId, state] = line.split('\t');
        return { instanceId, running: state === 'running' };
      });
  }

  async remove(instanceId) {
    await this.docker(['rm', '-f', containerName(instanceId)]).catch(() => {});
  }
}

function cleanDockerError(err) {
  const message = String(err.stderr || err.message || err).trim();
  return message.split('\n').filter(Boolean).pop() || 'Docker command failed';
}
