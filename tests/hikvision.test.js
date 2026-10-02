'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { HikvisionDevice } = require('../src/main/hikvision');

const FIX = {
  '/ISAPI/System/deviceInfo': `<?xml version="1.0" encoding="UTF-8"?><DeviceInfo><deviceName>Lobby NVR</deviceName><deviceID>1</deviceID><model>DS-7616NI-I2/16P</model><serialNumber>DS-7616NI-I2/16P1620190101CCRRC12345678WCVU</serialNumber><macAddress>a4:14:37:00:00:01</macAddress><firmwareVersion>V4.61.000</firmwareVersion><firmwareReleasedDate>build 220128</firmwareReleasedDate><deviceType>NVR</deviceType></DeviceInfo>`,
  '/ISAPI/Security/adminAccesses': `<AdminAccessProtocolList><AdminAccessProtocol><id>1</id><enabled>true</enabled><protocol>HTTP</protocol><portNo>80</portNo></AdminAccessProtocol><AdminAccessProtocol><id>3</id><enabled>true</enabled><protocol>RTSP</protocol><portNo>10554</portNo></AdminAccessProtocol></AdminAccessProtocolList>`,
  '/ISAPI/Streaming/channels': `<StreamingChannelList><StreamingChannel><id>101</id><channelName>Front Door</channelName><enabled>true</enabled><Video><enabled>true</enabled><videoCodecType>H.265</videoCodecType><videoResolutionWidth>2560</videoResolutionWidth><videoResolutionHeight>1440</videoResolutionHeight><maxFrameRate>2000</maxFrameRate></Video></StreamingChannel><StreamingChannel><id>102</id><channelName>Front Door</channelName><enabled>true</enabled><Video><videoCodecType>H.264</videoCodecType><videoResolutionWidth>704</videoResolutionWidth><videoResolutionHeight>480</videoResolutionHeight></Video></StreamingChannel><StreamingChannel><id>201</id><enabled>true</enabled><Video><videoCodecType>H.264</videoCodecType><videoResolutionWidth>1920</videoResolutionWidth><videoResolutionHeight>1080</videoResolutionHeight></Video></StreamingChannel></StreamingChannelList>`,
  '/ISAPI/ContentMgmt/InputProxy/channels': `<InputProxyChannelList><InputProxyChannel><id>1</id><name>Front Door</name><sourceInputPortDescriptor><proxyProtocol>HIKVISION</proxyProtocol><ipAddress>192.168.1.64</ipAddress><managePortNo>8000</managePortNo></sourceInputPortDescriptor></InputProxyChannel><InputProxyChannel><id>2</id><name>Parking</name><sourceInputPortDescriptor><proxyProtocol>ONVIF</proxyProtocol><ipAddress>192.168.1.65</ipAddress></sourceInputPortDescriptor></InputProxyChannel></InputProxyChannelList>`,
  '/ISAPI/ContentMgmt/InputProxy/channels/status': `<InputProxyChannelStatusList><InputProxyChannelStatus><id>1</id><online>true</online><streamingProxyChannelIdList><streamingProxyChannelId>101</streamingProxyChannelId><streamingProxyChannelId>102</streamingProxyChannelId></streamingProxyChannelIdList></InputProxyChannelStatus><InputProxyChannelStatus><id>2</id><online>false</online></InputProxyChannelStatus></InputProxyChannelStatusList>`,
  '/ISAPI/ContentMgmt/Storage': `<storage><hddList><hdd><id>1</id><hddName>hdd1</hddName><hddType>SATA</hddType><status>ok</status><capacity>3815447</capacity><freeSpace>0</freeSpace><property>RW</property></hdd></hddList></storage>`,
  '/ISAPI/PTZCtrl/channels/1/presets': `<PTZPresetList><PTZPreset><enabled>true</enabled><id>1</id><presetName>Gate</presetName></PTZPreset><PTZPreset><enabled>false</enabled><id>2</id><presetName>Unused</presetName></PTZPreset></PTZPresetList>`,
};
const SEARCH_RESULT = `<CMSearchResult><searchID>x</searchID><responseStatus>true</responseStatus><responseStatusStrg>OK</responseStatusStrg><numOfMatches>2</numOfMatches><matchList>
<searchMatchItem><sourceID>{0}</sourceID><trackID>101</trackID><timeSpan><startTime>2026-09-30T00:00:00Z</startTime><endTime>2026-09-30T01:00:00Z</endTime></timeSpan><mediaSegmentDescriptor><contentType>video</contentType><codecType>H.264-BP</codecType><playbackURI>rtsp://192.168.1.10/Streaming/tracks/101/?starttime=20260930T000000Z&amp;endtime=20260930T010000Z&amp;name=00000000001000000&amp;size=1</playbackURI></mediaSegmentDescriptor><metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/timing</metadataDescriptor></metadataMatches></searchMatchItem>
<searchMatchItem><sourceID>{0}</sourceID><trackID>101</trackID><timeSpan><startTime>2026-09-30T01:05:00Z</startTime><endTime>2026-09-30T01:06:30Z</endTime></timeSpan><mediaSegmentDescriptor><contentType>video</contentType><codecType>H.264-BP</codecType><playbackURI>rtsp://x</playbackURI></mediaSegmentDescriptor><metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/VMD</metadataDescriptor></metadataMatches></searchMatchItem>
</matchList></CMSearchResult>`;

function mockIsapi() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/ISAPI/ContentMgmt/search' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(SEARCH_RESULT); }
      if (req.url === '/ISAPI/PTZCtrl/channels/1/continuous' && req.method === 'PUT') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(`<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString><body>${body}</body></ResponseStatus>`); }
      if (req.url === '/ISAPI/Event/notification/alertStream') {
        res.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=boundary' });
        const part = (xml) => `--boundary\r\nContent-Type: application/xml; charset="UTF-8"\r\nContent-Length: ${Buffer.byteLength(xml)}\r\n\r\n${xml}\r\n`;
        res.write(part('<EventNotificationAlert><ipAddress>1.2.3.4</ipAddress><channelID>1</channelID><dateTime>2026-09-30T10:00:00+00:00</dateTime><activePostCount>0</activePostCount><eventType>videoloss</eventType><eventState>inactive</eventState><eventDescription>videoloss alarm</eventDescription></EventNotificationAlert>'));
        setTimeout(() => res.write(part('<EventNotificationAlert><ipAddress>1.2.3.4</ipAddress><channelID>2</channelID><dateTime>2026-09-30T10:00:01+00:00</dateTime><activePostCount>1</activePostCount><eventType>VMD</eventType><eventState>active</eventState><eventDescription>Motion alarm</eventDescription></EventNotificationAlert>')), 20);
        setTimeout(() => res.end('--boundary--'), 60);
        return;
      }
      const fx = FIX[req.url];
      if (!fx) { res.writeHead(404); return res.end('<ResponseStatus><statusCode>4</statusCode></ResponseStatus>'); }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(fx);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, calls })));
}

test('Hikvision probe + cameras + URLs', async () => {
  const { srv, port } = await mockIsapi();
  try {
    const dev = new HikvisionDevice({ id: 'dev_1', host: '127.0.0.1', port, username: 'admin', password: 'pw' });
    const info = await dev.probe();
    assert.strictEqual(info.model, 'DS-7616NI-I2/16P');
    assert.strictEqual(info.rtspPort, 10554, 'RTSP port read from adminAccesses');
    const cams = await dev.cameras();
    assert.strictEqual(cams.length, 2);
    assert.strictEqual(cams[0].id, 'dev_1:1');
    assert.strictEqual(cams[0].name, 'Front Door');
    assert.strictEqual(cams[0].online, true);
    assert.strictEqual(cams[0].ip, '192.168.1.64');
    assert.strictEqual(cams[0].streams.main.codec, 'H.265');
    assert.strictEqual(cams[0].streams.sub.track, 102);
    assert.strictEqual(cams[1].online, false);
    assert.strictEqual(cams[1].streams.sub, null);
    assert.strictEqual(dev.liveUrl(1, 'sub'), `rtsp://admin:pw@127.0.0.1:10554/Streaming/Channels/102`);
    assert.strictEqual(dev.liveUrl(2, 'main'), `rtsp://admin:pw@127.0.0.1:10554/Streaming/Channels/201`);
    assert.match(dev.playbackUrl(1, Date.UTC(2026, 8, 30, 1, 2, 3), Date.UTC(2026, 8, 30, 2, 0, 0)), /tracks\/101\?starttime=20260930T010203Z&endtime=20260930T020000Z$/);
    const st = await dev.storage();
    assert.strictEqual(st[0].capacityMB, 3815447);
    const presets = await dev.ptzPresets(1);
    assert.deepStrictEqual(presets, [{ id: 1, name: 'Gate' }]);
  } finally { srv.close(); }
});

test('Hikvision recording search parses types', async () => {
  const { srv, port } = await mockIsapi();
  try {
    const dev = new HikvisionDevice({ id: 'dev_1', host: '127.0.0.1', port, username: 'admin', password: 'pw' });
    const segs = await dev.searchRecordings(1, Date.UTC(2026, 8, 30), Date.UTC(2026, 8, 30, 23, 59, 59));
    assert.strictEqual(segs.length, 2);
    assert.strictEqual(segs[0].type, 'timing');
    assert.strictEqual(segs[1].type, 'motion');
    assert.strictEqual(segs[0].end - segs[0].start, 3600000);
  } finally { srv.close(); }
});

test('Hikvision PTZ continuous body and alert stream parsing', async () => {
  const { srv, port } = await mockIsapi();
  try {
    const dev = new HikvisionDevice({ id: 'dev_1', host: '127.0.0.1', port, username: 'admin', password: 'pw' });
    const r = await dev.ptzContinuous(1, { pan: 50, tilt: -20, zoom: 0 });
    assert.deepStrictEqual(r.ResponseStatus.body.PTZData, { pan: '50', tilt: '-20', zoom: '0' });
    const events = [];
    await new Promise((resolve, reject) => {
      dev.alertStream((e) => events.push(e), (err) => (err ? reject(err) : resolve())).catch(reject);
    });
    assert.strictEqual(events.length, 1, 'videoloss/inactive heartbeat filtered out');
    assert.strictEqual(events[0].type, 'VMD');
    assert.strictEqual(events[0].channel, 2);
    assert.strictEqual(events[0].time, Date.UTC(2026, 8, 30, 10, 0, 1));
  } finally { srv.close(); }
});
