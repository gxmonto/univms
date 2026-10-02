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

function startMockIsapi({ rtspPort, eventIntervalMs = 4000 }) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
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
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, close: () => srv.close() })));
}

module.exports = { startMockIsapi, FIX };
