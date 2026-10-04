import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRunArgs } from '../server/runners/docker.js';

const config = { hostDataDir: '/srv/data', ctraderImage: 'ghcr.io/spotware/ctrader-console:latest' };
const account = { id: 'acc1', ctid: 'me@example.com', accountNumber: '5123456' };
const bot = { id: 'bot1', file: 'abc.algo' };

test('builds the cTrader CLI run command', () => {
  const instance = { id: 'i1', symbol: 'EURUSD', period: 'h1', parameters: {}, fullAccess: false };
  const args = buildRunArgs({ instance, account, bot, config });
  assert.deepEqual(args.slice(0, 4), ['run', '-d', '--name', 'ctdash-i1']);
  assert.ok(args.includes('/srv/data/bots/abc.algo:/mnt/bots/abc.algo:ro'));
  assert.ok(args.includes('/srv/data/secrets/acc1.pwd:/mnt/secrets/ctrader.pwd:ro'));
  const tail = args.slice(args.indexOf(config.ctraderImage));
  assert.deepEqual(tail, [
    config.ctraderImage, 'run', '/mnt/bots/abc.algo',
    '--ctid=me@example.com', '--pwd-file=/mnt/secrets/ctrader.pwd', '--account=5123456',
    '--symbol=EURUSD', '--period=h1', '--exit-on-stop',
  ]);
});

test('passes cBot parameters as environment variables', () => {
  const instance = { id: 'i2', symbol: 'XAUUSD', period: 'm15', parameters: { Volume: '1000', Label: 'a b' }, fullAccess: true };
  const args = buildRunArgs({ instance, account, bot, config });
  const image = args.indexOf(config.ctraderImage);
  const before = args.slice(0, image);
  assert.ok(before.includes('Volume=1000'));
  assert.ok(before.includes('Label=a b'));
  assert.ok(args.slice(image).includes('--environment-variables'));
  assert.ok(args.slice(image).includes('--full-access'));
});
