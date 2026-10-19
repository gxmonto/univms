'use strict';
// Uniview (LAPI), Hanwha (SUNAPI) and Reolink drivers against small mocks modelled on real device responses (2026-10-19).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { UniviewDevice } = require('../src/main/uniview');
const { HanwhaDevice } = require('../src/main/hanwha');
const { ReolinkDevice } = require('../src/main/reolink');

const digestGate = (req, res) => {
  const a = req.headers.authorization || '';
  if (!/^Digest /.test(a)) { res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="dev", qop="auth", nonce="n1"' }); res.end(); return false; }
  if (!/username="admin"/.test(a)) { res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="dev", qop="auth", nonce="n2"' }); res.end(); return false; }
  return true;
};
const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
const lapi = (url, data) => JSON.stringify({ Response: { ResponseURL: url, ResponseCode: 0, ResponseString: 'Succeed', StatusCode: 0, Data: data } });

test('Uniview NVR: info, channels, URLs, recordings, no PTZ', async () => {
  const { srv, port } = await listen(http.createServer((req, res) => {
    if (!digestGate(req, res)) return;
    const u = req.url, j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(o); };
    if (u === '/LAPI/V1.0/System/DeviceInfo') return j(lapi(u, { DeviceName: 'NVR302-16S2-P16', DeviceType: 1, DeviceModel: 'NVR302-16S2-P16', SerialNumber: '210235XJRF3244000043', Manufacturer: 'UNIVIEW', FirmwareVersion: 'NVR-B3601.39.27.240813' }));
    if (u === '/LAPI/V1.0/Channels/System/ChannelDetailInfos') return j(lapi(u, { Nums: 2, DetailInfos: [{ ID: 1, Name: 'front entrance', Status: 1, DeviceModel: 'NCU-A8032-AW28', AddressInfo: { Address: '100.10.10.106' } }, { ID: 2, Name: 'Garage', Status: 0, AddressInfo: { Address: '100.10.10.5' } }] }));
    if (u.startsWith('/LAPI/V1.0/Channels/1/Media/Video/Streams/0/Records?Begin=')) return j(lapi(u, { RecordInfos: [{ FileName: '', RecordType: 4, Begin: 1792178761, End: 1792178855 }, { FileName: '', RecordType: 1, Begin: 1792178880, End: 1792182569 }] }));
    if (u === '/LAPI/V1.0/Channels/1/PTZ/Capabilities') return j(lapi(u, { IsSupportPTZ: 0 }));
    if (u === '/LAPI/V1.0/Channels/1/Media/Video/Streams/0/Snapshot') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.alloc(200, 0xff)); }
    if (u === '/LAPI/V1.0/System/Time') return j(lapi(u, { TimeZone: 'GMT-00:00', DeviceTime: 1792435135 }));
    res.writeHead(200); res.end(JSON.stringify({ Response: { ResponseURL: u, ResponseCode: 1, ResponseString: 'Common Error', StatusCode: 65535, Data: {} } }));
  }));
  try {
    const d = new UniviewDevice({ id: 'dev_u', host: '127.0.0.1', port, username: 'admin', password: 'pw', rtspPort: 9090 });
    const info = await d.probe();
    assert.strictEqual(info.model, 'NVR302-16S2-P16'); assert.strictEqual(info.deviceType, 'NVR');
    const cams = await d.cameras();
    assert.deepStrictEqual(cams.map((c) => [c.channel, c.name, c.online]), [[1, 'front entrance', true], [2, 'Garage', false]]);
    assert.strictEqual(d.liveUrl(1, 'sub'), 'rtsp://admin:pw@127.0.0.1:9090/unicast/c1/s1/live');
    assert.match(d.playbackUrl(2, new Date(2026, 9, 18, 10, 0, 0).getTime(), new Date(2026, 9, 18, 11, 0, 0).getTime()), /\/unicast\/c2\/s0\/playback\?begin=20261018100000&end=20261018110000$/);
    const segs = await d.searchRecordings(1, 1792100000000, 1792200000000);
    assert.deepStrictEqual(segs.map((s) => [s.type, s.end - s.start]), [['motion', 94000], ['timing', 3689000]]);
    assert.strictEqual(await d.ptzCapable(1), false);
    assert.strictEqual((await d.snapshot(1)).data.length, 200);
    assert.strictEqual((await d.time()).localTime, '2026-10-19T18:38:55.000Z');
    await assert.rejects(() => new UniviewDevice({ id: 'x', host: '127.0.0.1', port, username: 'bad', password: 'pw' }).probe(), (e) => e.status === 401 && e.authFailure === true);
  } finally { srv.close(); }
});

test('Hanwha NVR over SUNAPI: https fallback, channels, profiles, timeline, events', async () => {
  const { srv, port } = await listen(http.createServer((req, res) => {
    if (!digestGate(req, res)) return;
    const u = req.url, t = (s) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(s); };
    if (u.includes('msubmenu=deviceinfo')) return t('Model=QRN-1630S\nSerialNumber=ZSCA6V4YA00006Z\nFirmwareVersion=5.35.32_250617114505\nDeviceType=NVR\nDeviceName=QRN-1630S\n');
    if (u.includes('msubmenu=rtsp')) return t('MobilePort=558\nPort=558\n');
    if (u.includes('msubmenu=videosource')) return t('Channel.0.Name=Back Door-inter\nChannel.0.State=On\nChannel.1.Name=5th front\nChannel.1.State=On\nChannel.2.Name=\nChannel.2.State=Deactive\n');
    if (u.includes('msubmenu=videoprofile')) { const ch = /Channel=(\d+)/.exec(u)[1]; return t(`Channel.${ch}.Profile.1.EncodingType=H264\nChannel.${ch}.Profile.1.Resolution=2560x1440\nChannel.${ch}.Profile.1.FrameRate=20\nChannel.${ch}.Profile.2.EncodingType=H264\nChannel.${ch}.Profile.2.Resolution=640x360\nChannel.${ch}.Profile.2.FrameRate=20\n`); }
    if (u.includes('msubmenu=overlapped')) return t('OverlappedIDList=100\n');
    if (u.includes('msubmenu=timeline')) return t('TotalCount=2\nChannel.1.Result.1.StartTime=2026-10-18T00:00:00Z\nChannel.1.Result.1.EndTime=2026-10-19T00:00:00Z\nChannel.1.Result.1.Type=Normal\nChannel.1.Result.2.StartTime=2026-10-18T00:11:28Z\nChannel.1.Result.2.EndTime=2026-10-18T00:13:06Z\nChannel.1.Result.2.Type=MotionDetection\n');
    if (u.includes('msubmenu=preset')) return t('NG\nError Code: 600\nError Details: Submenu Not Found\n');
    if (u.includes('msubmenu=storageinfo')) return t('Status=Normal\nStorage.1.SlotNumber=1\nStorage.1.Model=WDC WD102PURP-85\nStorage.1.UsedSpaceInBytes=9886087774208\nStorage.1.TotalSpaceInBytes=9886087774208\nStorage.1.Type=HDD\nStorage.1.Status=Normal\n');
    if (u.includes('action=monitordiff')) {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=SamsungTechwin' });
      res.write('--SamsungTechwin\r\nContent-type:text/plain\r\n\r\nChannel.0.NetworkCameraConnect=True\r\nChannel.0.MotionDetection=False\r\nChannel.1.MotionDetection=False\r\n\r\n');
      setTimeout(() => res.write('--SamsungTechwin\r\nContent-type:text/plain\r\n\r\nChannel.1.MotionDetection=True\r\n\r\n'), 50);
      setTimeout(() => res.end('--SamsungTechwin\r\nContent-type:text/plain\r\n\r\nChannel.1.MotionDetection=False\r\n\r\n--SamsungTechwin--\r\n'), 120);
      return;
    }
    t('NG\nError Code: 600\nError Details: Submenu Not Found\n');
  }));
  try {
    // configured as https while the mock speaks http: the driver must fall back
    const d = new HanwhaDevice({ id: 'dev_h', host: '127.0.0.1', port, https: true, username: 'admin', password: 'pw' });
    const info = await d.probe();
    assert.strictEqual(info.model, 'QRN-1630S'); assert.strictEqual(info.deviceType, 'NVR'); assert.strictEqual(info.rtspPort, 558); assert.strictEqual(d.scheme, 'http');
    const cams = await d.cameras();
    assert.deepStrictEqual(cams.map((c) => [c.channel, c.name, c.online, c.streams.main.width]), [[0, 'Back Door-inter', true, 2560], [1, '5th front', true, 2560]]);
    assert.strictEqual(d.liveUrl(1, 'main'), 'rtsp://admin:pw@127.0.0.1:558/LiveChannel/1/media.smp/profile=1');
    assert.throws(() => d.playbackUrl(1, 0, 1), /not available yet/);
    const segs = await d.searchRecordings(1, Date.parse('2026-10-18T00:00:00Z'), Date.parse('2026-10-19T00:00:00Z'));
    assert.deepStrictEqual(segs.map((s) => s.type), ['timing', 'motion']);
    assert.deepStrictEqual(await d.ptzPresets(0), []);
    assert.strictEqual((await d.storage())[0].capacityMB, 9428108);
    const events = [];
    await new Promise((resolve, reject) => d.alertStream((e) => events.push(e), (err) => (err ? reject(err) : resolve())).catch(reject));
    assert.deepStrictEqual(events.map((e) => [e.channel, e.type, e.state]), [[1, 'MotionDetection', 'active'], [1, 'MotionDetection', 'inactive']]);
  } finally { srv.close(); }
});

test('Reolink camera: token login, info, channels, URLs, presets, events, playback file', async () => {
  const { srv, port } = await listen(http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const cmd = u.searchParams.get('cmd'); const tok = u.searchParams.get('token');
      const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([o])); };
      if (cmd === 'Login') { const p = JSON.parse(body)[0].param.User; return p.userName === 'admin' && p.password === 'pw' ? j({ cmd: 'Login', code: 0, value: { Token: { leaseTime: 3600, name: 'tok1' } } }) : j({ cmd: 'Login', code: 1, error: { detail: 'login failed', rspCode: -7 } }); }
      if (tok !== 'tok1') return j({ cmd: 'Unknown', code: 1, error: { detail: 'please login first', rspCode: -6 } });
      if (cmd === 'Snap') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.alloc(300, 1)); }
      if (cmd === 'GetMdState') return j({ cmd, code: 0, value: { state: srv.mdCalls++ === 1 ? 1 : 0 } }); // motion on the 2nd poll only
      const V = {
        GetDevInfo: { DevInfo: { channelNum: 1, firmVer: 'v3.1.0.801_22010701', model: 'RLC-520A', name: 'Camera1', serial: '00000000983040', type: 'IPC' } },
        GetNetPort: { NetPort: { httpPort: 8081, rtspEnable: 1, rtspPort: 551 } },
        GetChannelstatus: { count: 1, status: [{ channel: 0, name: 'Camera1', online: 1, typeInfo: 'RLC-520A' }] },
        GetEnc: { Enc: { channel: 0, mainStream: { frameRate: 20, height: 1920, width: 2560 }, subStream: { frameRate: 10, height: 480, width: 640 } } },
        GetPtzPreset: { PtzPreset: [{ channel: 0, enable: 1, id: 1, name: 'Door' }, { channel: 0, enable: 0, id: 2, name: 'pos2' }] },
        GetAiState: { channel: 0, people: { alarm_state: 0, support: 1 }, vehicle: { alarm_state: 0, support: 1 }, face: { support: 0 } },
        GetUser: { User: [{ level: 'admin', userName: 'admin' }] },
        GetHddInfo: { HddInfo: [] },
        Search: { SearchResult: { channel: 0, File: [{ StartTime: { year: 2026, mon: 10, day: 18, hour: 10, min: 0, sec: 0 }, EndTime: { year: 2026, mon: 10, day: 18, hour: 10, min: 30, sec: 0 }, name: 'Mp4Record/2026-10-18/RecM01_20261018_100000_103000_6D28808_2B5D08.mp4', size: 10, type: 'main' }] } },
        PtzCtrl: {},
      };
      if (V[cmd]) return j({ cmd, code: 0, value: V[cmd] });
      j({ cmd, code: 1, error: { detail: 'not support', rspCode: -9 } });
    });
  }));
  srv.mdCalls = 0;
  try {
    const d = new ReolinkDevice({ id: 'dev_r', host: '127.0.0.1', port, username: 'admin', password: 'pw' });
    const info = await d.probe();
    assert.strictEqual(info.model, 'RLC-520A'); assert.strictEqual(info.rtspPort, 551);
    const cams = await d.cameras();
    assert.deepStrictEqual(cams.map((c) => [c.channel, c.name, c.online, c.streams.sub.height]), [[0, 'Camera1', true, 480]]);
    assert.strictEqual(d.liveUrl(0, 'main'), 'rtsp://admin:pw@127.0.0.1:551/Preview_01_main');
    assert.deepStrictEqual(await d.ptzPresets(0), [{ id: 1, name: 'Door' }]);
    await d.ptzContinuous(0, { pan: 80, tilt: 0, zoom: 0 }); await d.ptzStop(0);
    assert.strictEqual((await d.snapshot(0)).data.length, 300);
    const segs = await d.searchRecordings(0, new Date(2026, 9, 18).getTime(), new Date(2026, 9, 19).getTime());
    assert.strictEqual(segs.length, 1); assert.strictEqual(segs[0].end - segs[0].start, 30 * 60 * 1000);
    const pb = await d.playbackUrl(0, new Date(2026, 9, 18, 10, 5, 0).getTime(), new Date(2026, 9, 18, 10, 10, 0).getTime());
    assert.match(pb, /cmd=Playback&source=Mp4Record%2F2026-10-18%2FRecM01_.*&token=tok1$/);
    assert.deepStrictEqual(await d.events(), [], 'first poll establishes state');
    const ev = await d.events();
    assert.deepStrictEqual(ev.map((e) => [e.type, e.channel]), [['VMD', 0]]);
    assert.deepStrictEqual(await d.events(), []);
    assert.deepStrictEqual(await d.users(), [{ id: 'admin', name: 'admin', level: 'admin' }]);
    await assert.rejects(() => new ReolinkDevice({ id: 'x', host: '127.0.0.1', port, username: 'admin', password: 'nope' }).probe(), (e) => e.status === 401 && e.authFailure === true);
  } finally { srv.close(); }
});
