'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { DahuaDevice } = require('../src/main/dahua');

// Dahua "key=value" CGI mock. Digest challenge once per connection-less request; wrong password -> 401 forever.
function mockDahua() {
  const srv = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (!/^Digest /.test(auth)) { res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="Login to 1A2B3C", qop="auth", nonce="abc123", opaque="x"' }); return res.end(); }
    if (!/username="admin"/.test(auth) || /badpw/.test(req.url)) { res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="Login to 1A2B3C", qop="auth", nonce="abc124", stale=false' }); return res.end(); }
    const txt = (s) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(s); };
    const u = req.url;
    if (u.includes('getDeviceType')) return txt('type=DHI-NVR5216-4KS2\r\n');
    if (u.includes('getSerialNo')) return txt('sn=7G0A1B2C3D4E5F\r\n');
    if (u.includes('getSoftwareVersion')) return txt('version=4.001.0000000.1.R,build:2023-05-10\r\n');
    if (u.includes('getMachineName')) return txt('name=Front NVR\r\n');
    if (u.includes('getDeviceClass')) return txt('class=NVR\r\n');
    if (u.includes('name=RTSP')) return txt('table.RTSP.Enable=true\r\ntable.RTSP.Port=10554\r\n');
    if (u.includes('name=ChannelTitle')) return txt('table.ChannelTitle[0].Name=Lobby\r\ntable.ChannelTitle[1].Name=Parking\r\ntable.ChannelTitle[2].Name=\r\n');
    if (u.includes('getCameraState')) return txt('states[0].channel=0\r\nstates[0].connectionState=Connected\r\nstates[1].channel=1\r\nstates[1].connectionState=Unconnect\r\n');
    if (u.includes('name=Encode')) return txt('table.Encode[0].MainFormat[0].Video.Compression=H.265\r\ntable.Encode[0].MainFormat[0].Video.Width=2560\r\ntable.Encode[0].MainFormat[0].Video.Height=1440\r\ntable.Encode[0].MainFormat[0].Video.FPS=15\r\ntable.Encode[0].ExtraFormat[0].Video.Compression=H.264\r\ntable.Encode[0].ExtraFormat[0].Video.Width=704\r\ntable.Encode[0].ExtraFormat[0].Video.Height=576\r\n');
    if (u.includes('factory.create')) return txt('result=12345\r\n');
    if (u.includes('action=findFile')) return txt('OK\r\n');
    if (u.includes('findNextFile')) return txt('found=2\r\nitems[0].Channel=0\r\nitems[0].StartTime=2026-10-15 10:00:00\r\nitems[0].EndTime=2026-10-15 10:30:00\r\nitems[0].Type=dav\r\nitems[0].Flags[0]=Timing\r\nitems[1].StartTime=2026-10-15 10:30:00\r\nitems[1].EndTime=2026-10-15 10:31:00\r\nitems[1].Type=dav\r\nitems[1].Flags[0]=Event\r\n');
    if (u.includes('getPresets')) return txt('presets[0].Index=1\r\npresets[0].Name=Door\r\npresets[1].Index=2\r\npresets[1].Name=Gate\r\n');
    if (u.includes('/ptz.cgi')) return txt('OK\r\n');
    if (u.includes('getUserInfoAll')) return txt('users[0].Name=admin\r\nusers[0].Group=admin\r\n');
    if (u.includes('getCurrentTime')) return txt('result=2026-10-15 12:00:00\r\n');
    if (u.includes('eventManager.cgi')) {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=myboundary' });
      res.write('--myboundary\r\nContent-Type: text/plain\r\nContent-Length: 42\r\n\r\nCode=VideoMotion;action=Start;index=1;data={"Name":"Parking","RegionName":["Region1"]}\r\n');
      res.write('--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=Heartbeat;action=Pulse;index=0\r\n');
      setTimeout(() => res.end(), 200);
      return;
    }
    res.writeHead(400); res.end('Error\r\n');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

test('Dahua probe, channels, URLs, recordings, presets, events', async () => {
  const { srv, port } = await mockDahua();
  try {
    const d = new DahuaDevice({ id: 'dev_dh', host: '127.0.0.1', port, username: 'admin', password: 'pw' });
    const info = await d.probe();
    assert.strictEqual(info.model, 'DHI-NVR5216-4KS2');
    assert.strictEqual(info.name, 'Front NVR');
    assert.strictEqual(info.firmware, '4.001.0000000.1.R');
    assert.strictEqual(info.deviceType, 'NVR');
    assert.strictEqual(info.rtspPort, 10554);
    const cams = await d.cameras();
    assert.strictEqual(cams.length, 3);
    assert.deepStrictEqual(cams.map((c) => [c.channel, c.name, c.online]), [[1, 'Lobby', true], [2, 'Parking', false], [3, 'Channel 3', true]]);
    assert.strictEqual(cams[0].streams.main.codec, 'H.265');
    assert.strictEqual(cams[0].streams.sub.width, 704);
    assert.strictEqual(d.liveUrl(2, 'main'), 'rtsp://admin:pw@127.0.0.1:10554/cam/realmonitor?channel=2&subtype=0');
    assert.match(d.playbackUrl(1, new Date(2026, 9, 15, 10, 0, 0).getTime(), new Date(2026, 9, 15, 11, 0, 0).getTime()), /\/cam\/playback\?channel=1&starttime=2026_10_15_10_00_00&endtime=2026_10_15_11_00_00$/);
    const segs = await d.searchRecordings(1, new Date(2026, 9, 15).getTime(), new Date(2026, 9, 16).getTime());
    assert.deepStrictEqual(segs.map((s) => s.type), ['timing', 'motion']);
    assert.strictEqual(segs[0].end - segs[0].start, 30 * 60 * 1000);
    assert.deepStrictEqual(await d.ptzPresets(1), [{ id: 1, name: 'Door' }, { id: 2, name: 'Gate' }]);
    await d.ptzContinuous(1, { pan: 50, tilt: 50, zoom: 0 }); await d.ptzStop(1);
    const events = [];
    await new Promise((resolve, reject) => d.alertStream((e) => events.push(e), (err) => (err ? reject(err) : resolve())).catch(reject));
    assert.strictEqual(events.length, 1, 'heartbeat filtered');
    assert.strictEqual(events[0].type, 'VideoMotion');
    assert.strictEqual(events[0].channel, 2);
    assert.strictEqual(events[0].description, 'Parking');
    assert.deepStrictEqual(await d.users(), [{ id: 'admin', name: 'admin', level: 'admin' }]);
  } finally { srv.close(); }
});

test('Dahua wrong password is an auth failure (lockout protection)', async () => {
  const { srv, port } = await mockDahua();
  try {
    const d = new DahuaDevice({ id: 'dev_dh', host: '127.0.0.1', port, username: 'operator', password: 'x' });
    await assert.rejects(() => d.probe(), (e) => e.status === 401 && e.authFailure === true);
  } finally { srv.close(); }
});
