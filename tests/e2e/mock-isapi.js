'use strict';
// Minimal Hikvision ISAPI mock used by unit tests and the Electron end-to-end harness.
const http = require('http');

const FIX = {
  '/ISAPI/System/deviceInfo': `<?xml version="1.0" encoding="UTF-8"?><DeviceInfo><deviceName>Mock NVR</deviceName><deviceID>1</deviceID><model>DS-7608NI-MOCK</model><serialNumber>MOCK0001</serialNumber><macAddress>00:11:22:33:44:55</macAddress><firmwareVersion>V4.0.0</firmwareVersion><firmwareReleasedDate>build 260101</firmwareReleasedDate><deviceType>NVR</deviceType></DeviceInfo>`,
  '/ISAPI/Streaming/channels': `<StreamingChannelList><StreamingChannel><id>101</id><channelName>Test Pattern</channelName><enabled>true</enabled><Video><enabled>true</enabled><videoCodecType>H.264</videoCodecType><videoResolutionWidth>1280</videoResolutionWidth><videoResolutionHeight>720</videoResolutionHeight><maxFrameRate>1500</maxFrameRate></Video></StreamingChannel><StreamingChannel><id>102</id><channelName>Test Pattern</channelName><enabled>true</enabled><Video><videoCodecType>H.264</videoCodecType><videoResolutionWidth>1280</videoResolutionWidth><videoResolutionHeight>720</videoResolutionHeight></Video></StreamingChannel></StreamingChannelList>`,
  '/ISAPI/ContentMgmt/InputProxy/channels': `<InputProxyChannelList><InputProxyChannel><id>1</id><name>Test Pattern</name><sourceInputPortDescriptor><proxyProtocol>HIKVISION</proxyProtocol><ipAddress>127.0.0.1</ipAddress></sourceInputPortDescriptor></InputProxyChannel></InputProxyChannelList>`,
  '/ISAPI/ContentMgmt/InputProxy/channels/status': `<InputProxyChannelStatusList><InputProxyChannelStatus><id>1</id><online>true</online></InputProxyChannelStatus></InputProxyChannelStatusList>`,
  '/ISAPI/ContentMgmt/Storage': `<storage><hddList><hdd><id>1</id><hddName>hdd1</hddName><hddType>SATA</hddType><status>ok</status><capacity>1000000</capacity><freeSpace>250000</freeSpace><property>RW</property></hdd></hddList></storage>`,
  '/ISAPI/System/time': `<Time><timeMode>manual</timeMode><localTime>${new Date().toISOString().slice(0, 19)}+00:00</localTime><timeZone>CST-0:00:00</timeZone></Time>`,
  '/ISAPI/PTZCtrl/channels/1/capabilities': `<PTZChanelCap><ContinuousPanTiltSpace/></PTZChanelCap>`,
  '/ISAPI/PTZCtrl/channels/1/presets': `<PTZPresetList><PTZPreset><enabled>true</enabled><id>1</id><presetName>Gate</presetName></PTZPreset></PTZPresetList>`,
};

// Smart rule fixtures (editable: PUTs replace them so round-trips can be verified)
const RULES = {
  '/ISAPI/System/Video/inputs/channels/1/motionDetection': `<?xml version="1.0" encoding="UTF-8"?><MotionDetection version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><enabled>true</enabled><enableHighlight>false</enableHighlight><samplingInterval>2</samplingInterval><startTriggerTime>500</startTriggerTime><endTriggerTime>500</endTriggerTime><regionType>grid</regionType><Grid><rowGranularity>18</rowGranularity><columnGranularity>22</columnGranularity></Grid><MotionDetectionLayout version="2.0"><sensitivityLevel>60</sensitivityLevel><layout><gridMap>${'fffffc'.repeat(18)}</gridMap></layout></MotionDetectionLayout></MotionDetection>`,
  '/ISAPI/Smart/LineDetection/1': `<?xml version="1.0" encoding="UTF-8"?><LineDetection version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><id>1</id><enabled>false</enabled><normalizedScreenSize><normalizedScreenWidth>1000</normalizedScreenWidth><normalizedScreenHeight>1000</normalizedScreenHeight></normalizedScreenSize><LineItemList size="4"><LineItem><id>1</id><enabled>false</enabled><sensitivityLevel>50</sensitivityLevel><directionSensitivity>any</directionSensitivity><CoordinatesList><Coordinates><positionX>200</positionX><positionY>500</positionY></Coordinates><Coordinates><positionX>800</positionX><positionY>500</positionY></Coordinates></CoordinatesList></LineItem></LineItemList></LineDetection>`,
  '/ISAPI/Smart/FieldDetection/1': `<?xml version="1.0" encoding="UTF-8"?><FieldDetection version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><id>1</id><enabled>false</enabled><normalizedScreenSize><normalizedScreenWidth>1000</normalizedScreenWidth><normalizedScreenHeight>1000</normalizedScreenHeight></normalizedScreenSize><FieldDetectionRegionList size="4"><FieldDetectionRegion><id>1</id><enabled>false</enabled><sensitivityLevel>50</sensitivityLevel><objectOccupation>1</objectOccupation><timeThreshold>0</timeThreshold><RegionCoordinatesList><RegionCoordinates><positionX>100</positionX><positionY>100</positionY></RegionCoordinates><RegionCoordinates><positionX>900</positionX><positionY>100</positionY></RegionCoordinates><RegionCoordinates><positionX>900</positionX><positionY>900</positionY></RegionCoordinates><RegionCoordinates><positionX>100</positionX><positionY>900</positionY></RegionCoordinates></RegionCoordinatesList></FieldDetectionRegion></FieldDetectionRegionList></FieldDetection>`,
};
FIX['/ISAPI/System/TwoWayAudio/channels'] = `<TwoWayAudioChannelList><TwoWayAudioChannel><id>1</id><enabled>true</enabled><audioCompressionType>G.711ulaw</audioCompressionType><audioInputType>LineIn</audioInputType><speakerVolume>50</speakerVolume><audioSamplingRate>8</audioSamplingRate></TwoWayAudioChannel><TwoWayAudioChannel><id>2</id><enabled>true</enabled><audioCompressionType>G.711ulaw</audioCompressionType><audioInputType>MicIn</audioInputType><speakerVolume>50</speakerVolume><audioSamplingRate>8</audioSamplingRate></TwoWayAudioChannel></TwoWayAudioChannelList>`;

function startMockIsapi({ rtspPort, eventIntervalMs = 4000 }) {
  const twoWay = { bytesIn: 0, opened: 0, closed: 0 };
  const srv = http.createServer((req, res) => {
    // two-way audio: streaming endpoints must be handled before the body is buffered
    const twm = /^\/ISAPI\/System\/TwoWayAudio\/channels\/(\d+)\/(audioData|open|close)$/.exec(req.url);
    if (twm && twm[2] === 'audioData') {
      twoWay.lastChannel = Number(twm[1]);
      if (req.method === 'PUT') { req.on('data', (c) => { twoWay.bytesIn += c.length; }); req.on('end', () => { res.writeHead(200); res.end('<ResponseStatus><statusCode>1</statusCode></ResponseStatus>'); }); return; }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        const t = setInterval(() => { const b = Buffer.alloc(160); for (let i = 0; i < 160; i++) b[i] = 0xff ^ ((Math.round(60 * Math.sin((i / 160) * Math.PI * 2 * 8)) + 128) & 0xff); res.write(b); }, 20); // ~ 440 Hz-ish µ-law blips
        res.on('close', () => clearInterval(t));
        return;
      }
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (twm && twm[2] === 'open' && req.method === 'PUT') { twoWay.opened++; twoWay.openedChannel = Number(twm[1]); res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end('<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>'); }
      if (twm && twm[2] === 'close' && req.method === 'PUT') { twoWay.closed++; res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end('<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>'); }
      if (RULES[req.url]) {
        if (req.method === 'PUT') { if (!/^<\?xml/.test(body) || !/<\/(MotionDetection|LineDetection|FieldDetection)>$/.test(body.trim())) { res.writeHead(400); return res.end('<ResponseStatus><statusCode>4</statusCode><statusString>Invalid XML</statusString></ResponseStatus>'); } RULES[req.url] = body; res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end('<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>'); }
        res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(RULES[req.url]);
      }
      if (req.url === '/ISAPI/Security/adminAccesses') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(`<AdminAccessProtocolList><AdminAccessProtocol><id>1</id><enabled>true</enabled><protocol>HTTP</protocol><portNo>80</portNo></AdminAccessProtocol><AdminAccessProtocol><id>3</id><enabled>true</enabled><protocol>RTSP</protocol><portNo>${rtspPort}</portNo></AdminAccessProtocol></AdminAccessProtocolList>`); }
      if (req.url === '/ISAPI/Event/notification/alertStream') {
        res.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=boundary' });
        const part = (xml) => `--boundary\r\nContent-Type: application/xml; charset="UTF-8"\r\nContent-Length: ${Buffer.byteLength(xml)}\r\n\r\n${xml}\r\n`;
        const t = setInterval(() => res.write(part(`<EventNotificationAlert><ipAddress>127.0.0.1</ipAddress><channelID>1</channelID><dateTime>${new Date().toISOString()}</dateTime><activePostCount>1</activePostCount><eventType>VMD</eventType><eventState>active</eventState><eventDescription>Motion alarm</eventDescription></EventNotificationAlert>`)), eventIntervalMs);
        res.on('close', () => clearInterval(t));
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end('<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>'); }
      const fx = FIX[req.url];
      if (!fx) { res.writeHead(404); return res.end('<ResponseStatus><statusCode>4</statusCode></ResponseStatus>'); }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(fx);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, close: () => { try { srv.closeAllConnections(); } catch (_) {} srv.close(); }, twoWay, rules: RULES })));
}

module.exports = { startMockIsapi, FIX, RULES };
