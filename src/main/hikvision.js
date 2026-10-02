'use strict';
/*
 * Hikvision ISAPI driver (NVR / DVR / IP camera).
 * Camera identity: `${deviceId}:${channelNo}`; stream track id = channelNo*100 + streamNo.
 */
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { request, HttpError } = require('./httpclient');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const b = (v) => String(v).toLowerCase() === 'true';
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const isoCompact = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

class HikvisionDevice {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.host = cfg.host;
    this.port = Number(cfg.port) || 80;
    this.https = !!cfg.https;
    this.username = cfg.username;
    this.password = cfg.password;
    this.rtspPort = Number(cfg.rtspPort) || Number(cfg.detectedRtspPort) || 554;
    this.base = `${this.https ? 'https' : 'http'}://${this.host}:${this.port}`;
    this.auth = { type: 'digest', username: this.username, password: this.password };
  }

  // ---------- low level ----------
  async get(pathname, opts = {}) {
    const res = await request(this.base + pathname, { auth: this.auth, timeout: opts.timeout || 12000, headers: opts.headers });
    if (res.status >= 400) throw new HttpError(res.status, res.text, pathname);
    return res;
  }
  async xml(pathname, opts) {
    const res = await this.get(pathname, opts);
    return parser.parse(res.text);
  }
  async send(method, pathname, body, opts = {}) {
    const res = await request(this.base + pathname, {
      method, body, auth: this.auth, timeout: opts.timeout || 15000,
      headers: { 'Content-Type': 'application/xml', ...(opts.headers || {}) },
    });
    if (res.status >= 400) throw new HttpError(res.status, res.text, pathname);
    return parser.parse(res.text || '<empty/>');
  }
  put(p, body, o) { return this.send('PUT', p, body, o); }
  post(p, body, o) { return this.send('POST', p, body, o); }

  // ---------- info ----------
  async deviceInfo() {
    const x = await this.xml('/ISAPI/System/deviceInfo');
    const d = x.DeviceInfo || {};
    return {
      name: d.deviceName, model: d.model, serial: d.serialNumber, mac: d.macAddress,
      firmware: `${d.firmwareVersion || ''} ${d.firmwareReleasedDate || ''}`.trim(),
      deviceType: d.deviceType, hardware: d.hardwareVersion, encoder: d.encoderVersion,
    };
  }

  async probe() {
    const info = await this.deviceInfo();
    try {
      const ports = await this.ports();
      if (ports.rtsp) this.rtspPort = ports.rtsp;
    } catch (_) {}
    return { ...info, rtspPort: this.rtspPort, vendor: 'hikvision' };
  }

  async ports() {
    const x = await this.xml('/ISAPI/Security/adminAccesses');
    const out = {};
    for (const p of asArray((x.AdminAccessProtocolList || {}).AdminAccessProtocol)) {
      const proto = String(p.protocol || '').toLowerCase();
      if (proto && b(p.enabled !== undefined ? p.enabled : 'true')) out[proto] = Number(p.portNo);
    }
    return out;
  }

  async systemStatus() {
    const x = await this.xml('/ISAPI/System/status');
    const s = x.DeviceStatus || {};
    return {
      currentTime: s.currentDeviceTime, uptimeSeconds: Number(s.deviceUpTime || 0),
      cpu: asArray((s.CPUList || {}).CPU).map((c) => ({ desc: c.cpuDescription, utilization: Number(c.cpuUtilization) })),
      memory: asArray((s.MemoryList || {}).Memory).map((m) => ({ desc: m.memoryDescription, usage: Number(m.memoryUsage), available: Number(m.memoryAvailable) })),
    };
  }

  // ---------- channels / cameras ----------
  async cameras() {
    const cams = new Map();
    // Stream channel metadata (codec/resolution), keyed by video input channel
    let streamInfo = {};
    try {
      const sx = await this.xml('/ISAPI/Streaming/channels');
      for (const sc of asArray((sx.StreamingChannelList || {}).StreamingChannel)) {
        const id = Number(sc.id);
        const chan = Math.floor(id / 100), streamNo = id % 100;
        const v = sc.Video || {};
        (streamInfo[chan] = streamInfo[chan] || {})[streamNo] = {
          codec: v.videoCodecType, width: Number(v.videoResolutionWidth), height: Number(v.videoResolutionHeight),
          fps: v.maxFrameRate ? Number(v.maxFrameRate) / 100 : undefined, enabled: b(sc.enabled !== undefined ? sc.enabled : 'true'),
          name: sc.channelName,
        };
      }
    } catch (_) {}

    // Analog / local video inputs (DVR, IPC)
    try {
      const vx = await this.xml('/ISAPI/System/Video/inputs/channels');
      for (const vc of asArray((vx.VideoInputChannelList || {}).VideoInputChannel)) {
        const chan = Number(vc.id);
        cams.set(chan, { channel: chan, name: vc.name || `Camera ${chan}`, kind: 'analog', online: true, ip: null });
      }
    } catch (_) {}

    // IP channels on NVR
    let proxyList = [];
    try {
      const px = await this.xml('/ISAPI/ContentMgmt/InputProxy/channels');
      proxyList = asArray((px.InputProxyChannelList || {}).InputProxyChannel);
    } catch (_) {}
    if (proxyList.length) {
      // Digital channels replace the analog ones for hybrid DVRs where ids overlap only if both sets are present
      for (const pc of proxyList) {
        const chan = Number(pc.id);
        const d = pc.sourceInputPortDescriptor || {};
        cams.set(chan, {
          channel: chan, name: pc.name || `Camera ${chan}`, kind: 'ip', online: null,
          ip: d.ipAddress || d.hostName || null, protocol: d.proxyProtocol, managePort: Number(d.managePortNo) || undefined,
        });
      }
      try {
        const st = await this.xml('/ISAPI/ContentMgmt/InputProxy/channels/status');
        for (const s of asArray((st.InputProxyChannelStatusList || {}).InputProxyChannelStatus)) {
          const c = cams.get(Number(s.id));
          if (c) {
            c.online = b(s.online);
            const ids = asArray((s.streamingProxyChannelIdList || {}).streamingProxyChannelId).map(Number);
            if (ids.length) c.streamIds = ids;
            const sd = s.sourceInputPortDescriptor || {};
            if (sd.ipAddress) c.ip = sd.ipAddress;
          }
        }
      } catch (_) {}
    }

    const list = [...cams.values()].sort((a, b2) => a.channel - b2.channel);
    for (const c of list) {
      const si = streamInfo[c.channel] || {};
      c.streams = {
        main: { track: c.channel * 100 + 1, ...(si[1] || {}) },
        sub: si[2] ? { track: c.channel * 100 + 2, ...si[2] } : null,
        third: si[3] ? { track: c.channel * 100 + 3, ...si[3] } : null,
      };
      if (c.online === null) c.online = !!(si[1] && si[1].enabled);
      c.id = `${this.id}:${c.channel}`;
      c.deviceId = this.id;
      c.vendor = 'hikvision';
    }
    return list;
  }

  // ---------- URLs ----------
  creds() {
    return `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`;
  }
  liveUrl(channel, stream = 'sub') {
    const streamNo = stream === 'main' ? 1 : stream === 'third' ? 3 : 2;
    return `rtsp://${this.creds()}${this.host}:${this.rtspPort}/Streaming/Channels/${channel * 100 + streamNo}`;
  }
  playbackUrl(channel, startMs, endMs) {
    const track = channel * 100 + 1;
    let u = `rtsp://${this.creds()}${this.host}:${this.rtspPort}/Streaming/tracks/${track}?starttime=${isoCompact(startMs)}`;
    if (endMs) u += `&endtime=${isoCompact(endMs)}`;
    return u;
  }

  // ---------- snapshot ----------
  async snapshot(channel, stream = 'main') {
    const streamNo = stream === 'main' ? 1 : 2;
    const res = await this.get(`/ISAPI/Streaming/channels/${channel * 100 + streamNo}/picture`, { timeout: 15000 });
    return { contentType: res.headers['content-type'] || 'image/jpeg', data: res.buffer };
  }

  // ---------- PTZ ----------
  async ptzCapable(channel) {
    try {
      await this.get(`/ISAPI/PTZCtrl/channels/${channel}/capabilities`, { timeout: 6000 });
      return true;
    } catch (e) {
      return false;
    }
  }
  ptzContinuous(channel, { pan = 0, tilt = 0, zoom = 0 }) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><PTZData><pan>${Math.round(pan)}</pan><tilt>${Math.round(tilt)}</tilt><zoom>${Math.round(zoom)}</zoom></PTZData>`;
    return this.put(`/ISAPI/PTZCtrl/channels/${channel}/continuous`, body, { timeout: 6000 });
  }
  ptzStop(channel) { return this.ptzContinuous(channel, { pan: 0, tilt: 0, zoom: 0 }); }
  ptzFocus(channel, speed) {
    return this.put(`/ISAPI/System/Video/inputs/channels/${channel}/focus`, `<?xml version="1.0" encoding="UTF-8"?><FocusData><focus>${Math.round(speed)}</focus></FocusData>`, { timeout: 6000 });
  }
  ptzIris(channel, speed) {
    return this.put(`/ISAPI/System/Video/inputs/channels/${channel}/iris`, `<?xml version="1.0" encoding="UTF-8"?><IrisData><iris>${Math.round(speed)}</iris></IrisData>`, { timeout: 6000 });
  }
  ptzAux(channel, type, on) {
    const id = type === 'WIPER' ? 2 : 1;
    return this.put(`/ISAPI/PTZCtrl/channels/${channel}/auxcontrols/${id}`, `<?xml version="1.0" encoding="UTF-8"?><PTZAux><id>${id}</id><type>${type}</type><status>${on ? 'on' : 'off'}</status></PTZAux>`, { timeout: 6000 });
  }
  async ptzPresets(channel) {
    const x = await this.xml(`/ISAPI/PTZCtrl/channels/${channel}/presets`);
    return asArray((x.PTZPresetList || {}).PTZPreset).filter((p) => b(p.enabled !== undefined ? p.enabled : 'true')).map((p) => ({ id: Number(p.id), name: p.presetName || `Preset ${p.id}` }));
  }
  ptzGotoPreset(channel, presetId) { return this.put(`/ISAPI/PTZCtrl/channels/${channel}/presets/${presetId}/goto`, '', { timeout: 6000 }); }
  ptzSetPreset(channel, presetId, name) {
    return this.put(`/ISAPI/PTZCtrl/channels/${channel}/presets/${presetId}`, `<?xml version="1.0" encoding="UTF-8"?><PTZPreset><id>${presetId}</id><presetName>${xmlEsc(name || 'Preset ' + presetId)}</presetName></PTZPreset>`, { timeout: 6000 });
  }
  ptzDeletePreset(channel, presetId) { return this.send('DELETE', `/ISAPI/PTZCtrl/channels/${channel}/presets/${presetId}`, '', { timeout: 6000 }); }
  async ptzPatrols(channel) {
    const x = await this.xml(`/ISAPI/PTZCtrl/channels/${channel}/patrols`);
    return asArray((x.PatrolList || {}).Patrol).map((p) => ({ id: Number(p.id), name: p.patrolName || `Patrol ${p.id}`, enabled: b(p.enabled !== undefined ? p.enabled : 'true') }));
  }
  ptzPatrol(channel, patrolId, start) { return this.put(`/ISAPI/PTZCtrl/channels/${channel}/patrols/${patrolId}/${start ? 'start' : 'stop'}`, '', { timeout: 6000 }); }
  ptzAbsoluteZoom(channel, zoom) {
    // 3D positioning is PUT /ISAPI/PTZCtrl/channels/N/position3D; used for click-to-center
    return this.put(`/ISAPI/PTZCtrl/channels/${channel}/absolute`, `<?xml version="1.0" encoding="UTF-8"?><PTZData><AbsoluteHigh><absoluteZoom>${Math.round(zoom)}</absoluteZoom></AbsoluteHigh></PTZData>`, { timeout: 6000 });
  }
  ptzPosition3D(channel, startX, startY, endX, endY) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><Position3D><StartPoint><positionX>${Math.round(startX)}</positionX><positionY>${Math.round(startY)}</positionY></StartPoint><EndPoint><positionX>${Math.round(endX)}</positionX><positionY>${Math.round(endY)}</positionY></EndPoint></Position3D>`;
    return this.put(`/ISAPI/PTZCtrl/channels/${channel}/position3D`, body, { timeout: 6000 });
  }

  // ---------- recordings ----------
  async searchRecordings(channel, startMs, endMs, { types } = {}) {
    const track = channel * 100 + 1;
    const results = [];
    let pos = 0;
    for (let page = 0; page < 60; page++) {
      const body = `<?xml version="1.0" encoding="utf-8"?><CMSearchDescription><searchID>${crypto.randomUUID()}</searchID>` +
        `<trackIDList><trackID>${track}</trackID></trackIDList>` +
        `<timeSpanList><timeSpan><startTime>${new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}</startTime><endTime>${new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}</endTime></timeSpan></timeSpanList>` +
        `<maxResults>100</maxResults><searchResultPostion>${pos}</searchResultPostion>` +
        `<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`;
      const x = await this.post('/ISAPI/ContentMgmt/search', body, { timeout: 30000 });
      const r = x.CMSearchResult || {};
      const items = asArray((r.matchList || {}).searchMatchItem);
      for (const it of items) {
        const ts = it.timeSpan || {};
        const md = it.mediaSegmentDescriptor || {};
        const desc = asArray((it.metadataMatches || {}).metadataDescriptor).join(',') || '';
        const type = (desc.split('/').pop() || 'record').toLowerCase();
        results.push({
          start: Date.parse(ts.startTime), end: Date.parse(ts.endTime),
          type: type.includes('motion') || type === 'vmd' ? 'motion' : type.includes('alarm') || type === 'io' ? 'alarm' : type.includes('event') || type.includes('smart') || type.includes('line') || type.includes('field') ? 'event' : 'timing',
          codec: md.codecType, playbackURI: md.playbackURI,
        });
      }
      const status = String(r.responseStatusStrg || '').toUpperCase();
      pos += items.length;
      if (status !== 'MORE' || items.length === 0) break;
    }
    results.sort((a, c) => a.start - c.start);
    if (types && types.length) return results.filter((s) => types.includes(s.type));
    return results;
  }

  // Dates (days) with recordings for a month: use daily search on the track; ISAPI has
  // /ISAPI/ContentMgmt/record/tracks/{track}/dailyDistribution on newer firmware.
  async recordingDays(channel, year, month) {
    const track = channel * 100 + 1;
    try {
      const body = `<?xml version="1.0" encoding="utf-8"?><trackDailyParam><year>${year}</year><monthOfYear>${month}</monthOfYear></trackDailyParam>`;
      const x = await this.post(`/ISAPI/ContentMgmt/record/tracks/${track}/dailyDistribution`, body, { timeout: 15000 });
      const days = asArray(((x.trackDailyDistribution || {}).dayList || {}).day);
      return days.filter((d) => b(d.record)).map((d) => Number(d.dayOfMonth));
    } catch (e) {
      return null; // unsupported; UI falls back to per-day search
    }
  }

  // ---------- storage / time / maintenance ----------
  async storage() {
    const x = await this.xml('/ISAPI/ContentMgmt/Storage');
    const s = x.storage || {};
    const hdds = asArray((s.hddList || {}).hdd).map((h) => ({
      id: h.id, name: h.hddName, type: h.hddType, status: h.status, property: h.property,
      capacityMB: Number(h.capacity), freeMB: Number(h.freeSpace),
    }));
    const nas = asArray((s.nasList || {}).nas).map((n) => ({ id: n.id, name: n.path || n.ipAddress, type: n.nasType || 'NAS', status: n.status, capacityMB: Number(n.capacity), freeMB: Number(n.freeSpace) }));
    return [...hdds, ...nas];
  }
  async time() {
    const x = await this.xml('/ISAPI/System/time');
    const t = x.Time || {};
    return { mode: t.timeMode, localTime: t.localTime, timeZone: t.timeZone };
  }
  async setTimeNow() {
    const cur = await this.time();
    // Keep the device's configured offset; compose local time string in that zone.
    const now = new Date();
    const m = /([+-])(\d{1,2}):?(\d{2})?/.exec((cur.localTime || '').slice(19)) || [];
    let offsetMin = 0;
    if (m.length) offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
    const local = new Date(now.getTime() + offsetMin * 60000).toISOString().replace(/\.\d{3}Z$/, '');
    const sign = offsetMin < 0 ? '-' : '+';
    const abs = Math.abs(offsetMin);
    const tzs = cur.localTime && cur.localTime.length > 19 ? cur.localTime.slice(19) : `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    const body = `<?xml version="1.0" encoding="UTF-8"?><Time><timeMode>manual</timeMode><localTime>${local}${tzs}</localTime><timeZone>${xmlEsc(cur.timeZone || 'CST-0:00:00')}</timeZone></Time>`;
    await this.put('/ISAPI/System/time', body);
    return this.time();
  }
  reboot() { return this.put('/ISAPI/System/reboot', ''); }

  async users() {
    const x = await this.xml('/ISAPI/Security/users');
    return asArray((x.UserList || {}).User).map((u) => ({ id: u.id, name: u.userName, level: u.userLevel }));
  }

  async network() {
    const x = await this.xml('/ISAPI/System/Network/interfaces');
    return asArray((x.NetworkInterfaceList || {}).NetworkInterface).map((n) => {
      const ip = (n.IPAddress || {});
      return { id: n.id, ip: ip.ipAddress, mask: ip.subnetMask, gateway: (ip.DefaultGateway || {}).ipAddress, dhcp: ip.addressingType, mac: (n.Link || {}).MACAddress };
    });
  }

  async logs(startMs, endMs, { max = 500 } = {}) {
    const out = [];
    let pos = 0;
    for (let page = 0; page < 20 && out.length < max; page++) {
      const body = `<?xml version="1.0" encoding="utf-8"?><CMSearchDescription><searchID>${crypto.randomUUID()}</searchID><metaId>log.std-cgi.com</metaId>` +
        `<timeSpanList><timeSpan><startTime>${new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}</startTime><endTime>${new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}</endTime></timeSpan></timeSpanList>` +
        `<maxResults>100</maxResults><searchResultPostion>${pos}</searchResultPostion></CMSearchDescription>`;
      const x = await this.post('/ISAPI/ContentMgmt/logSearch', body, { timeout: 30000 });
      const r = x.CMSearchResult || {};
      const items = asArray((r.matchList || {}).searchMatchItem);
      for (const it of items) {
        const md = it.metadataMatches || {};
        const ts = it.timeSpan || {};
        out.push({
          time: Date.parse(ts.startTime || md.logTime || md.startTime) || null,
          major: md.majorType || md.logType, minor: md.minorType || md.logDescription,
          channel: md.channelID || md.channel, user: md.userName, remote: md.remoteHostAddr || md.ipAddress,
          raw: md,
        });
      }
      pos += items.length;
      if (String(r.responseStatusStrg || '').toUpperCase() !== 'MORE' || !items.length) break;
    }
    return out;
  }

  // ---------- smart event rules (motion / line crossing / intrusion) ----------
  // Configurations are read as XML, edited as objects and written back with the same structure,
  // so unknown device-specific fields survive the round trip.
  async getRule(kind, channel) {
    const p = this.rulePath(kind, channel);
    const res = await this.get(p);
    return { xml: res.text, config: parser.parse(res.text), path: p };
  }
  async setRule(kind, channel, config) {
    const { XMLBuilder } = require('fast-xml-parser');
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', suppressEmptyNode: false, format: false });
    let xml = builder.build(config);
    if (!/^<\?xml/.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8"?>' + xml;
    return this.put(this.rulePath(kind, channel), xml, { timeout: 15000 });
  }
  rulePath(kind, channel) {
    if (kind === 'motion') return `/ISAPI/System/Video/inputs/channels/${channel}/motionDetection`;
    if (kind === 'line') return `/ISAPI/Smart/LineDetection/${channel}`;
    if (kind === 'intrusion') return `/ISAPI/Smart/FieldDetection/${channel}`;
    throw new Error('Unknown rule kind ' + kind);
  }
  /** Which smart rules the channel supports (capability probes). */
  async ruleCapabilities(channel) {
    const out = {};
    for (const [kind, p] of [['motion', this.rulePath('motion', channel)], ['line', this.rulePath('line', channel)], ['intrusion', this.rulePath('intrusion', channel)]]) {
      try { await this.get(p, { timeout: 6000 }); out[kind] = true; } catch (_) { out[kind] = false; }
    }
    return out;
  }

  // ---------- events (multipart alert stream) ----------
  /**
   * Opens /ISAPI/Event/notification/alertStream and calls onEvent for each alert.
   * Returns { close() }. Caller handles reconnection.
   */
  async alertStream(onEvent, onClose) {
    const res = await request(this.base + '/ISAPI/Event/notification/alertStream', { auth: this.auth, stream: true, timeout: 30000 });
    if (res.status >= 400) { res.stream.resume(); throw new HttpError(res.status, '', 'alertStream'); }
    let buf = '';
    let closed = false;
    const s = res.stream;
    s.setTimeout(90000, () => s.destroy(new Error('alert stream idle timeout')));
    s.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let m;
      const re = /<EventNotificationAlert[\s\S]*?<\/EventNotificationAlert>/g;
      let last = 0;
      while ((m = re.exec(buf))) {
        last = re.lastIndex;
        try {
          const x = parser.parse(Buffer.from(m[0], 'latin1').toString('utf8'));
          const e = x.EventNotificationAlert || {};
          const type = e.eventType || 'unknown';
          const state = e.eventState || 'active';
          if (type === 'videoloss' && state === 'inactive') continue; // heartbeat
          onEvent({
            type, state,
            channel: Number(e.dynChannelID || e.channelID || 0) || null,
            time: Date.parse(e.dateTime) || Date.now(),
            description: e.eventDescription || type,
            count: Number(e.activePostCount || 0),
            ip: e.ipAddress, raw: e,
          });
        } catch (_) {}
      }
      if (last) buf = buf.slice(last);
      if (buf.length > 2_000_000) buf = buf.slice(-200_000);
    });
    const done = (err) => { if (!closed) { closed = true; onClose && onClose(err); } };
    s.on('end', () => done());
    s.on('close', () => done());
    s.on('error', (e) => done(e));
    return { close() { closed = true; s.destroy(); } };
  }
}

module.exports = { HikvisionDevice };
