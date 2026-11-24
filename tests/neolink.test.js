'use strict';
// Reolink UID relay: Neolink config generation and the local RTSP URLs (no process is started here).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const neolink = require('../src/main/neolink');
const { ReolinkUidDevice } = require('../src/main/reolinkuid');

test('neolink config: one camera entry per channel, UID vs address', () => {
  const t = neolink.toml({ id: 'dev_1', host: ' 9527000kp8kgp7vf ', username: 'admin', password: 'p"w\\d', channels: 2 }, 8554);
  assert.match(t, /^bind = "127\.0\.0\.1"\nbind_port = 8554\n/);
  assert.strictEqual((t.match(/\[\[cameras\]\]/g) || []).length, 2);
  assert.match(t, /name = "ch0"[\s\S]*channel_id = 0/);
  assert.match(t, /name = "ch1"[\s\S]*channel_id = 1/);
  assert.strictEqual((t.match(/idle_disconnect = true/g) || []).length, 2); // sessions only while viewed (NVR session cap)
  assert.match(t, /uid = "9527000KP8KGP7VF"\ndiscovery = "cellular"/);
  assert.match(t, /password = "p\\"w\\\\d"/); // JSON escaping is valid TOML
  const a = neolink.toml({ id: 'dev_2', host: '192.168.1.5:9000', username: 'admin', password: 'x', channels: 0 }, 9000);
  assert.match(a, /address = "192\.168\.1\.5:9000"/);
  assert.ok(!/discovery/.test(a));
  assert.strictEqual((a.match(/\[\[cameras\]\]/g) || []).length, 1);
  const l = neolink.toml({ id: 'dev_3', host: '9527000KP8KGP7VF', username: 'admin', password: 'x', channels: [1, 7, 19] }, 9100); // only populated slots
  assert.deepStrictEqual([...l.matchAll(/channel_id = (\d+)/g)].map((m) => +m[1]), [1, 7, 19]);
  assert.match(l, /use_splash = false/);
  assert.ok(neolink.isUid('9527000KP8KGP7VF') && !neolink.isUid('192.168.1.5:9000'));
});

test('concurrent tiles share one Neolink process and canceled starts do not spawn', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-relay-'));
  const resourcesPath = process.resourcesPath;
  const modulePath = require.resolve('../src/main/neolink');
  const priorModule = require.cache[modulePath];
  fs.mkdirSync(path.join(dir, 'neolink'));
  fs.writeFileSync(path.join(dir, 'neolink', process.platform === 'win32' ? 'neolink.exe' : 'neolink'), '');
  process.resourcesPath = dir;
  const spawn = t.mock.method(childProcess, 'spawn', () => Object.assign(new EventEmitter(), {
    pid: 1, killed: false, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { this.killed = true; },
  }));
  delete require.cache[modulePath];
  const relay = require(modulePath);
  relay.init({ userData: dir });
  t.after(() => {
    relay.shutdown();
    require.cache[modulePath] = priorModule;
    if (resourcesPath === undefined) delete process.resourcesPath;
    else process.resourcesPath = resourcesPath;
    fs.unlinkSync(path.join(dir, 'neolink', process.platform === 'win32' ? 'neolink.exe' : 'neolink'));
    fs.rmdirSync(path.join(dir, 'neolink'));
    fs.rmdirSync(dir);
  });

  const dev = { id: 'recorder', host: '127.0.0.1:9000', channels: 8 };
  const ports = await Promise.all(Array.from({ length: 8 }, () => relay.ensure(dev)));
  assert.deepStrictEqual(new Set(ports), new Set([relay.port(dev.id)]));
  assert.strictEqual(spawn.mock.callCount(), 1);
  const helper = spawn.mock.calls[0].result;
  helper.stdout.write('[INFO] ch0: Available');
  helper.stderr.write('a warning from GStreamer\n');
  helper.stdout.write(' at /ch0/subStream\n');
  assert.deepStrictEqual(relay.state(dev.id).ready, ['ch0']);

  const canceled = relay.ensure({ ...dev, id: 'deleted-recorder' });
  relay.stop('deleted-recorder');
  await assert.rejects(canceled, /canceled/);
  assert.strictEqual(spawn.mock.callCount(), 1);
});

test('reolinkuid driver: channels and URLs, unsupported features reject', async (t) => {
  t.mock.method(require('../src/main/reolinksdk'), 'available', () => false);
  const d = new ReolinkUidDevice({ id: 'dev_1', host: '9527000KP8KGP7VF', username: 'admin', password: 'x', channels: 3 });
  const cams = await d.cameras();
  // channels only log in while viewed, so "not tried yet" counts as online; only a failed attempt marks one offline
  assert.deepStrictEqual(cams.map((c) => [c.id, c.channel, c.online]), [['dev_1:0', 0, true], ['dev_1:1', 1, true], ['dev_1:2', 2, true]]);
  d.applySlots([{ channel: 0, state: 0 }, { channel: 7, state: 1 }]); // recorder: slot 0 disconnected, slot 7 has a camera
  await assert.rejects(d.liveUrl(0), /Camera offline/);
  assert.deepStrictEqual(d.slotIds, [0, 7]);
  await assert.rejects(d.playbackUrl(0, 0, 1), /Clip export is not available/); // playback goes through playbackPiped (Reolink SDK)
  assert.strictEqual(typeof d.playbackPiped, 'function');
  assert.strictEqual(await d.ptzCapable(0), false);
  assert.strictEqual(neolink.port('dev_1'), null);
  assert.strictEqual(neolink.state('dev_1'), null);
});
