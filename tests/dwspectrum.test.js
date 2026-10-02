'use strict';
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const http = require('http');
const { DWSpectrumServer } = require('../src/main/dwspectrum');

// Plain HTTP mock (driver's https flag off for the test)
function mockNx() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/rest/v2/login/sessions' && req.method === 'POST') {
        const b = JSON.parse(body);
        if (b.username === 'admin' && b.password === 'pw') return json({ token: 'vms-token-1', expiresInS: 3600, username: 'admin' });
        return json({ errorString: 'Wrong password' }, 401);
      }
      if (req.headers.authorization !== 'Bearer vms-token-1') return json({ error: 'unauthorized' }, 401);
      if (req.url === '/rest/v2/system/info') return json({ name: 'HQ System', localId: '{abc}', version: '6.0.1.12345' });
      if (req.url === '/rest/v2/servers') return json([{ id: '{ee9cc344-2d09-4d3a-ede5-4170c9c77cb0}', name: 'Server A', url: 'https://127.0.0.1:7001', status: 'Online', version: '6.0.1' }]);
      if (req.url === '/rest/v2/devices') return json([
        { id: '{0016575c-f1bd-ab3a-570d-e1f0cfc261fd}', name: 'Lobby', physicalId: 'abc', url: 'rtsp://10.0.0.5:554/stream', serverId: '{ee9cc344-2d09-4d3a-ede5-4170c9c77cb0}', status: 'Recording', vendor: 'GENERIC_RTSP', model: 'x', group: { id: 'g', name: 'Myrtle Ave' } },
        { id: '{1116575c-f1bd-ab3a-570d-e1f0cfc261fd}', name: 'Garage', url: 'http://10.0.0.6', serverId: '{ee9cc344-2d09-4d3a-ede5-4170c9c77cb0}', status: 'Offline' },
      ]);
      if (req.url.startsWith('/ec2/recordedTimePeriods') && req.url.includes('periodsType=0')) return json([{ startTimeMs: 1000, durationMs: 5000 }, { startTimeMs: 9000, durationMs: -1 }]);
      if (req.url.startsWith('/ec2/recordedTimePeriods') && req.url.includes('periodsType=1')) return json({ reply: [[{ startTimeMs: 2000, durationMs: 1000 }]] });
      if (req.url.startsWith('/api/getEvents')) return json({ reply: [{ aggregationCount: 2, eventParams: { eventType: 'cameraMotionEvent', eventTimestampUsec: '1700000000000000', eventResourceId: '{0016575c-f1bd-ab3a-570d-e1f0cfc261fd}', caption: 'Motion on Lobby' } }] });
      if (req.url.startsWith('/api/ptz')) return json({ reply: [{ id: 'p1', name: 'Entrance' }] });
      json({ error: 'not found' }, 404);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

test('DW Spectrum login, cameras, periods, events', async () => {
  const { srv, port } = await mockNx();
  try {
    const dw = new DWSpectrumServer({ id: 'dev_dw', host: '127.0.0.1', port, https: false, username: 'admin', password: 'pw' });
    const info = await dw.probe();
    assert.strictEqual(info.name, 'HQ System');
    assert.strictEqual(info.apiMode, 'rest');
    const cams = await dw.cameras();
    assert.strictEqual(cams.length, 2);
    const lobby = cams.find((c) => c.name === 'Lobby');
    assert.strictEqual(lobby.id, 'dev_dw:0016575c-f1bd-ab3a-570d-e1f0cfc261fd');
    assert.strictEqual(lobby.online, true);
    assert.strictEqual(lobby.group, 'Myrtle Ave');
    assert.strictEqual(lobby.server, 'Server A');
    assert.strictEqual(lobby.ip, '10.0.0.5');
    assert.strictEqual(cams.find((c) => c.name === 'Garage').online, false);
    assert.strictEqual(dw.liveUrl(lobby.uuid, 'main'), `rtsp://admin:pw@127.0.0.1:${port}/0016575c-f1bd-ab3a-570d-e1f0cfc261fd?stream=0`);
    assert.match(dw.playbackUrl(lobby.uuid, 1700000000000), /\?stream=0&pos=1700000000000$/);
    const segs = await dw.searchRecordings(lobby.uuid, 0, 20000);
    assert.strictEqual(segs.filter((s) => s.type === 'timing').length, 2);
    assert.strictEqual(segs.find((s) => s.type === 'motion').start, 2000);
    assert.strictEqual(segs.find((s) => s.start === 9000).end, 20000, 'open-ended period gets a synthetic end');
    const evs = await dw.events(0, Date.now());
    assert.strictEqual(evs[0].type, 'cameraMotionEvent');
    assert.strictEqual(evs[0].time, 1700000000000);
    assert.strictEqual(evs[0].channel, '0016575c-f1bd-ab3a-570d-e1f0cfc261fd');
    const presets = await dw.ptzPresets(lobby.uuid);
    assert.deepStrictEqual(presets, [{ id: 'p1', name: 'Entrance' }]);
  } finally { srv.close(); }
});

test('DW Spectrum wrong password is reported', async () => {
  const { srv, port } = await mockNx();
  try {
    const dw = new DWSpectrumServer({ id: 'dev_dw', host: '127.0.0.1', port, https: false, username: 'admin', password: 'bad' });
    await assert.rejects(() => dw.probe(), /Wrong password/);
  } finally { srv.close(); }
});
