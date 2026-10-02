'use strict';
/*
 * Digital Watchdog DW Spectrum (Nx Witness based) server driver.
 * Default port 7001 (HTTPS + RTSP on the same port).
 * Camera identity: `${deviceId}:${cameraUuid}` (uuid without braces).
 */
const { request, HttpError } = require('./httpclient');

const stripBraces = (s) => String(s || '').replace(/[{}]/g, '');

class DWSpectrumServer {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.host = cfg.host;
    this.port = Number(cfg.port) || 7001;
    this.username = cfg.username;
    this.password = cfg.password;
    this.https = cfg.https !== false; // Nx 4.0+ requires https
    this.rtspPort = Number(cfg.rtspPort) || this.port;
    this.base = `${this.https ? 'https' : 'http'}://${this.host}:${this.port}`;
    this.token = null;
    this.tokenExpires = 0;
    this.apiMode = null; // 'rest' | 'legacy'
  }

  // ---------- auth ----------
  async login(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpires - 60000) return this.token;
    try {
      const res = await request(this.base + '/rest/v2/login/sessions', {
        method: 'POST', body: JSON.stringify({ username: this.username, password: this.password, setCookie: false }),
        headers: { 'Content-Type': 'application/json' }, timeout: 12000,
      });
      if (res.status === 200) {
        const j = JSON.parse(res.text);
        this.token = j.token;
        this.tokenExpires = Date.now() + (Number(j.expiresInS) || 3600) * 1000;
        this.apiMode = 'rest';
        return this.token;
      }
      if (res.status === 401 || res.status === 403) {
        let msg = 'Invalid username or password';
        try { msg = JSON.parse(res.text).errorString || msg; } catch (_) {}
        throw new HttpError(res.status, msg, '/rest/v2/login/sessions');
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
    // Legacy (4.x and earlier): digest/basic
    this.apiMode = 'legacy';
    this.token = null;
    return null;
  }

  authFor() {
    if (this.token) return { type: 'bearer', token: this.token };
    return { type: 'digest', username: this.username, password: this.password };
  }

  async call(pathname, { method = 'GET', body, timeout = 15000, retry = true, raw = false } = {}) {
    await this.login();
    const headers = {};
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) body = JSON.stringify(body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await request(this.base + pathname, { method, body, headers, auth: this.authFor(), timeout });
    if (res.status === 401 && retry && this.token) {
      await this.login(true);
      return this.call(pathname, { method, body, timeout, retry: false, raw });
    }
    if (res.status >= 400) throw new HttpError(res.status, res.text, pathname);
    if (raw) return res;
    const t = res.text;
    if (!t) return null;
    try { return JSON.parse(t); } catch (_) { return t; }
  }

  async tryCalls(list, opts) {
    let lastErr;
    for (const p of list) {
      try { return await this.call(p, opts); } catch (e) { lastErr = e; if (!(e.status === 404 || e.status === 400 || e.status === 405)) throw e; }
    }
    throw lastErr;
  }

  // ---------- info ----------
  async probe() {
    await this.login();
    let info = {};
    try {
      const j = await this.call('/rest/v2/system/info');
      info = { name: j.name || j.systemName, systemId: j.localId || j.cloudId, version: j.version };
    } catch (_) {
      const j = await this.call('/api/moduleInformation');
      const r = j.reply || j;
      info = { name: r.systemName, systemId: r.localSystemId, version: r.version, serverName: r.name };
    }
    let servers = [];
    try { servers = await this.servers(); } catch (_) {}
    const me = servers.find((s) => (s.url || '').includes(this.host)) || servers[0] || {};
    return { ...info, model: 'DW Spectrum', deviceType: 'VMS Server', firmware: info.version || me.version, serverName: me.name || info.serverName, servers: servers.length, rtspPort: this.rtspPort, vendor: 'dwspectrum', apiMode: this.apiMode };
  }

  async servers() {
    try {
      const j = await this.call('/rest/v2/servers');
      return (Array.isArray(j) ? j : []).map((s) => ({ id: stripBraces(s.id), name: s.name, url: s.url, status: s.status, version: s.version }));
    } catch (_) {
      const j = await this.call('/ec2/getMediaServersEx');
      return (Array.isArray(j) ? j : []).map((s) => ({ id: stripBraces(s.id), name: s.name, url: s.url, status: s.status, version: s.version }));
    }
  }

  // ---------- cameras ----------
  async cameras() {
    let list;
    try {
      list = await this.call('/rest/v2/devices');
      if (!Array.isArray(list)) throw new Error('unexpected');
    } catch (_) {
      list = await this.call('/ec2/getCamerasEx');
    }
    let servers = [];
    try { servers = await this.servers(); } catch (_) {}
    const serverName = (sid) => (servers.find((s) => s.id === stripBraces(sid)) || {}).name;
    return (list || [])
      .filter((c) => !c.typeId || !/desktop/i.test(c.name || ''))
      .map((c) => {
        const uuid = stripBraces(c.id);
        const status = String(c.status || 'Online');
        const online = /online|recording/i.test(status);
        const group = c.group && c.group.name ? c.group.name : (c.parameters && c.parameters.customGroupId) || (c.addParams && (c.addParams.find && (c.addParams.find((p) => p.name === 'customGroupId') || {}).value)) || null;
        const caps = Number((c.parameters && c.parameters.ptzCapabilities) || c.ptzCapabilities || 0);
        return {
          id: `${this.id}:${uuid}`, deviceId: this.id, vendor: 'dwspectrum', uuid,
          channel: uuid, name: c.name || c.model || uuid, kind: 'ip', online, status,
          ip: (c.url || '').replace(/^[a-z]+:\/\//i, '').split(/[/:?]/)[0] || null,
          model: c.model, vendorName: c.vendor, server: serverName(c.serverId), serverId: stripBraces(c.serverId),
          group, physicalId: c.physicalId, logicalId: c.logicalId,
          ptzHint: caps ? true : undefined,
          streams: { main: { track: 0 }, sub: { track: 1 } },
        };
      })
      .sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name));
  }

  // ---------- URLs ----------
  creds() { return `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`; }
  liveUrl(uuid, stream = 'sub') {
    return `rtsp://${this.creds()}${this.host}:${this.rtspPort}/${uuid}?stream=${stream === 'main' ? 0 : 1}`;
  }
  playbackUrl(uuid, startMs, endMs) {
    let u = `rtsp://${this.creds()}${this.host}:${this.rtspPort}/${uuid}?stream=0&pos=${Math.floor(startMs)}`;
    if (endMs) u += `&endpos=${Math.floor(endMs)}`;
    return u;
  }

  // ---------- snapshot ----------
  async snapshot(uuid, stream = 'main', timeMs) {
    const size = stream === 'main' ? '' : '&size=640x';
    const paths = [
      `/rest/v2/devices/${uuid}/image?timestampMs=${timeMs ? Math.floor(timeMs) : 'now'}${size}`,
      `/ec2/cameraThumbnail?cameraId=${uuid}&time=${timeMs ? Math.floor(timeMs) : 'latest'}${stream === 'main' ? '' : '&height=360'}&imageFormat=jpg`,
    ];
    let lastErr;
    for (const p of paths) {
      try {
        const res = await this.call(p, { raw: true, timeout: 15000 });
        if (res.buffer && res.buffer.length > 100) return { contentType: res.headers['content-type'] || 'image/jpeg', data: res.buffer };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No image');
  }

  // ---------- PTZ ----------
  async ptzCapable(uuid) {
    try {
      const j = await this.call(`/api/ptz?cameraId=${uuid}&command=GetDevicePtzCapabilitiesPtzCommand`, { timeout: 8000 });
      const caps = j && j.reply !== undefined ? j.reply : j;
      return Number(caps) > 0 || (typeof caps === 'object' && caps !== null);
    } catch (_) {
      return true; // let the user try
    }
  }
  ptzContinuous(uuid, { pan = 0, tilt = 0, zoom = 0 }) {
    const q = `cameraId=${uuid}&command=ContinuousMovePtzCommand&xSpeed=${(pan / 100).toFixed(2)}&ySpeed=${(tilt / 100).toFixed(2)}&zSpeed=${(zoom / 100).toFixed(2)}`;
    return this.call(`/api/ptz?${q}`, { timeout: 8000 });
  }
  ptzStop(uuid) { return this.ptzContinuous(uuid, { pan: 0, tilt: 0, zoom: 0 }); }
  ptzFocus(uuid, speed) { return this.call(`/api/ptz?cameraId=${uuid}&command=ContinuousFocusPtzCommand&speed=${(speed / 100).toFixed(2)}`, { timeout: 8000 }); }
  ptzIris() { return Promise.resolve(null); }
  ptzAux() { return Promise.resolve(null); }
  async ptzPresets(uuid) {
    const j = await this.call(`/api/ptz?cameraId=${uuid}&command=GetPresetsPtzCommand`, { timeout: 8000 });
    const arr = (j && j.reply) || j || [];
    return (Array.isArray(arr) ? arr : []).map((p) => ({ id: p.id, name: p.name || p.id }));
  }
  ptzGotoPreset(uuid, presetId) { return this.call(`/api/ptz?cameraId=${uuid}&command=ActivatePresetPtzCommand&presetId=${encodeURIComponent(presetId)}&speed=1`, { timeout: 8000 }); }
  ptzSetPreset(uuid, presetId, name) { return this.call(`/api/ptz?cameraId=${uuid}&command=CreatePresetPtzCommand&presetId=${encodeURIComponent(presetId)}&presetName=${encodeURIComponent(name || presetId)}`, { timeout: 8000 }); }
  ptzDeletePreset(uuid, presetId) { return this.call(`/api/ptz?cameraId=${uuid}&command=RemovePresetPtzCommand&presetId=${encodeURIComponent(presetId)}`, { timeout: 8000 }); }
  async ptzPatrols(uuid) {
    try {
      const j = await this.call(`/api/ptz?cameraId=${uuid}&command=GetToursPtzCommand`, { timeout: 8000 });
      const arr = (j && j.reply) || [];
      return (Array.isArray(arr) ? arr : []).map((t) => ({ id: t.id, name: t.name || t.id, enabled: true }));
    } catch (_) { return []; }
  }
  ptzPatrol(uuid, tourId, start) {
    return start ? this.call(`/api/ptz?cameraId=${uuid}&command=ActivateTourPtzCommand&tourId=${encodeURIComponent(tourId)}`, { timeout: 8000 }) : this.ptzStop(uuid);
  }

  // ---------- recordings ----------
  async searchRecordings(uuid, startMs, endMs) {
    const j = await this.tryCalls([
      `/ec2/recordedTimePeriods?cameraId=${uuid}&startTime=${Math.floor(startMs)}&endTime=${Math.floor(endMs)}&flat&periodsType=0&detail=1000`,
      `/rest/v3/devices/${uuid}/footage?startTimeMs=${Math.floor(startMs)}&endTimeMs=${Math.floor(endMs)}&detailLevelMs=1000`,
    ], { timeout: 30000 });
    let periods = j && j.reply !== undefined ? j.reply : j;
    while (Array.isArray(periods) && periods.length && Array.isArray(periods[0])) periods = periods.flat();
    const out = [];
    for (const p of periods || []) {
      const s = Number(p.startTimeMs !== undefined ? p.startTimeMs : p.startTime);
      let d = Number(p.durationMs !== undefined ? p.durationMs : p.duration);
      if (!Number.isFinite(s)) continue;
      if (!Number.isFinite(d) || d < 0) d = Math.max(0, Math.min(Date.now(), endMs) - s); // -1 = still recording
      out.push({ start: s, end: s + d, type: 'timing' });
    }
    // Motion periods for timeline coloring
    try {
      const m = await this.call(`/ec2/recordedTimePeriods?cameraId=${uuid}&startTime=${Math.floor(startMs)}&endTime=${Math.floor(endMs)}&flat&periodsType=1&detail=1000`, { timeout: 30000 });
      let mp = m && m.reply !== undefined ? m.reply : m;
      while (Array.isArray(mp) && mp.length && Array.isArray(mp[0])) mp = mp.flat();
      for (const p of mp || []) {
        const s = Number(p.startTimeMs), d = Number(p.durationMs);
        if (Number.isFinite(s) && Number.isFinite(d) && d > 0) out.push({ start: s, end: s + d, type: 'motion' });
      }
    } catch (_) {}
    return out.sort((a, b) => a.start - b.start);
  }

  async bookmarks(uuid, startMs, endMs) {
    try {
      const j = await this.call(`/ec2/bookmarks?cameraId=${uuid}&startTime=${Math.floor(startMs)}&endTime=${Math.floor(endMs)}`, { timeout: 15000 });
      return (Array.isArray(j) ? j : j && j.reply) || [];
    } catch (_) { return []; }
  }

  recordingDays() { return Promise.resolve(null); }

  // ---------- events ----------
  async events(fromMs, toMs) {
    const j = await this.tryCalls([
      `/api/getEvents?from=${Math.floor(fromMs)}&to=${Math.floor(toMs)}`,
      `/rest/v4/events/log?startTime=${Math.floor(fromMs)}&endTime=${Math.floor(toMs)}`,
      `/rest/v3/events/log?startTime=${Math.floor(fromMs)}&endTime=${Math.floor(toMs)}`,
    ], { timeout: 20000 });
    const arr = (j && j.reply) || (Array.isArray(j) ? j : []);
    return arr.map((e) => {
      const ep = e.eventParams || e.eventData || e;
      const usec = ep.eventTimestampUsec || ep.timestampUsec;
      const time = usec ? Math.floor(Number(usec) / 1000) : Number(ep.timestampMs || e.timestampMs) || Date.now();
      const res = stripBraces(ep.eventResourceId || ep.deviceId || ep.resourceId || '');
      return {
        type: ep.eventType || e.type || 'event', state: 'active', channel: res || null, time,
        description: ep.caption || ep.description || ep.eventType || 'Event', count: Number(e.aggregationCount || 1), raw: e,
      };
    });
  }

  // ---------- storage / time / maintenance ----------
  async storage() {
    const j = await this.call('/api/storageSpace');
    const r = (j && j.reply) || j || {};
    return (r.storages || []).map((s, i) => ({
      id: i + 1, name: s.url, type: s.storageType || 'local', status: s.isOnline === false ? 'offline' : 'ok',
      property: s.isUsedForWriting ? 'RW' : 'R', capacityMB: Math.round(Number(s.totalSpace) / 1048576), freeMB: Math.round(Number(s.freeSpace) / 1048576),
    }));
  }
  async time() {
    const j = await this.call('/api/gettime');
    const r = (j && j.reply) || j || {};
    return { mode: 'server', localTime: new Date(Number(r.utcTime) || Date.now()).toISOString(), timeZone: r.timezoneId || r.timeZoneId, offset: r.timeZoneOffset };
  }
  setTimeNow() { throw new Error('DW Spectrum servers synchronize time themselves; set the time on the server OS.'); }
  async reboot() {
    try {
      const servers = await this.servers();
      const me = servers.find((s) => (s.url || '').includes(this.host)) || servers[0];
      if (me) return await this.call(`/rest/v2/servers/${me.id}/restart`, { method: 'POST' });
    } catch (_) {}
    return this.call('/api/restart');
  }
  async users() {
    try {
      const j = await this.call('/rest/v2/users');
      return (Array.isArray(j) ? j : []).map((u) => ({ id: stripBraces(u.id), name: u.name, level: u.type || (u.isOwner ? 'Owner' : u.permissions) }));
    } catch (_) {
      const j = await this.call('/ec2/getUsers');
      return (Array.isArray(j) ? j : []).map((u) => ({ id: stripBraces(u.id), name: u.name, level: u.isAdmin ? 'Administrator' : 'User' }));
    }
  }
  network() { return Promise.resolve([]); }
  async systemStatus() {
    try {
      const j = await this.call('/api/statistics');
      const r = (j && j.reply) || j || {};
      const stats = r.statistics || [];
      return {
        uptimeSeconds: Number(r.uptimeMs || 0) / 1000,
        cpu: stats.filter((s) => s.deviceType === 'StatisticsCPU').map((s) => ({ desc: s.description, utilization: Math.round(Number(s.value) * 100) })),
        memory: stats.filter((s) => s.deviceType === 'StatisticsRAM').map((s) => ({ desc: s.description, usage: Math.round(Number(s.value) * 100) })),
      };
    } catch (_) { return {}; }
  }
  async logs(startMs, endMs) {
    const j = await this.call(`/api/auditLog?from=${Math.floor(startMs)}&to=${Math.floor(endMs)}`, { timeout: 20000 });
    const arr = (j && j.reply) || (Array.isArray(j) ? j : []);
    return arr.map((r) => ({
      time: Number(r.createdTimeSec) * 1000 || Number(r.eventTimeSec) * 1000 || null,
      major: r.eventType, minor: r.params || '', user: (r.authSession || {}).userName, remote: (r.authSession || {}).userHost, raw: r,
    }));
  }

  // ---------- server layouts (import) ----------
  async layouts() {
    let list;
    try { list = await this.call('/rest/v2/layouts'); } catch (_) { list = await this.call('/ec2/getLayouts'); }
    return (Array.isArray(list) ? list : []).map((l) => ({
      id: stripBraces(l.id), name: l.name,
      items: (l.items || []).map((it) => ({ cameraUuid: stripBraces(it.resourceId), left: it.left, top: it.top, right: it.right, bottom: it.bottom })),
    })).filter((l) => l.items.length);
  }
}

module.exports = { DWSpectrumServer };
