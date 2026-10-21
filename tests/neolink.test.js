'use strict';
// Reolink UID relay: Neolink config generation and the local RTSP URLs (no process is started here).
const test = require('node:test');
const assert = require('node:assert');
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
  assert.ok(neolink.isUid('9527000KP8KGP7VF') && !neolink.isUid('192.168.1.5:9000'));
});

test('reolinkuid driver: channels and URLs, unsupported features reject', async () => {
  const d = new ReolinkUidDevice({ id: 'dev_1', host: '9527000KP8KGP7VF', username: 'admin', password: 'x', channels: 3 });
  const cams = await d.cameras();
  assert.deepStrictEqual(cams.map((c) => [c.id, c.channel, c.online]), [['dev_1:0', 0, false], ['dev_1:1', 1, false], ['dev_1:2', 2, false]]);
  assert.throws(() => d.liveUrl(0), /not connected/);
  await assert.rejects(d.playbackUrl(0, 0, 1), /Clip export is not available/); // playback goes through playbackPiped (Reolink SDK)
  assert.strictEqual(typeof d.playbackPiped, 'function');
  assert.strictEqual(await d.ptzCapable(0), false);
  assert.strictEqual(neolink.port('dev_1'), null);
  assert.strictEqual(neolink.state('dev_1'), null);
});
