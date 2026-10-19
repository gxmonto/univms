'use strict';
/*
 * Reolink camera / NVR driver — JSON API: POST /api.cgi?cmd=<Cmd>&token=<t> with [{cmd, action, param}], token from
 * cmd=Login (lease 3600 s). Verified 2026-10-19 on an RLC-520A: GetDevInfo, GetChannelstatus, GetNetPort, GetEnc, GetTime,
 * GetHddInfo, GetMdState, GetAiState, GetPtzPreset, GetUser, Snap. RTSP live: /Preview_{NN}_{main|sub} (NN = channel+1,
 * works for H.264 and H.265). Playback: Search + Playback (MP4 over HTTP). Events: GetMdState/GetAiState polled.
 * Two-way audio uses Reolink's private protocol → not available.
 */
const { request, HttpError } = require('./httpclient');

const two = (n) => String(n).padStart(2, '0');
const tobj = (ms) => { const d = new Date(ms); return { year: d.getFullYear(), mon: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds() }; };
const fromObj = (t) => t ? new Date(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec).getTime() : NaN;

class ReolinkDevice {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.host = cfg.host;
    this.port = Number(cfg.port) || 80;
    this.username = cfg.username;
    this.password = cfg.password;
    this.base = `${cfg.https ? 'https' : 'http'}://${this.host}:${this.port}`;
    this.rtspPort = Number(cfg.rtspPort) || Number(cfg.detectedRtspPort) || 554;
    this.token = null; this.tokenExpires = 0;
    this.lastStates = new Map(); // channel -> { md, people, vehicle, ... } for event transitions
  }
  camKind() { return 'ip'; }

  async login(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpires - 60000) return this.token;
    const res = await request(this.base + '/api.cgi?cmd=Login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ cmd: 'Login', action: 0, param: { User: { Version: '0', userName: this.username, password: this.password } } }]), timeout: 15000 });
    let j; try { j = JSON.parse(res.text)[0]; } catch (_) { throw new HttpError(res.status || 500, 'Not a Reolink API response', '/api.cgi?cmd=Login'); }
    if (j.code !== 0 || !j.value || !j.value.Token) throw new HttpError(401, (j.error && j.error.detail) || 'Login rejected by the device', '/api.cgi?cmd=Login');
    this.token = j.value.Token.name;
    this.tokenExpires = Date.now() + (Number(j.value.Token.leaseTime) || 3600) * 1000;
    return this.token;
  }
  /** One command; returns its `value`. */
  async cmd(name, param = {}, { timeout = 15000, retry = true } = {}) {
    const token = await this.login();
    const res = await request(`${this.base}/api.cgi?cmd=${name}&token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ cmd: name, action: 0, param }]), timeout });
    let j; try { j = JSON.parse(res.text)[0]; } catch (_) { throw new HttpError(res.status || 500, 'Not a Reolink API response', name); }
    if (j.code !== 0) {
      const code = j.error && j.error.rspCode;
      if (code === -6 && retry) { await this.login(true); return this.cmd(name, param, { timeout, retry: false }); } // token expired
      throw new HttpError(400, `${name}: ${(j.error && j.error.detail) || 'error'} (${code})`, name);
    }
    return j.value || {};
  }

  // ---------- info ----------
  async probe() {
    const d = (await this.cmd('GetDevInfo')).DevInfo || {};
    try { const np = (await this.cmd('GetNetPort')).NetPort || {}; if (!this.cfg.rtspPort && Number(np.rtspPort)) this.rtspPort = Number(np.rtspPort); this.rtspEnabled = np.rtspEnable !== 0; } catch (_) {}
    return { name: d.name, model: d.model, serial: d.serial, firmware: d.firmVer, deviceType: d.type || (Number(d.channelNum) > 1 ? 'NVR' : 'IPC'), channels: d.channelNum, rtspPort: this.rtspPort, rtspEnabled: this.rtspEnabled, vendor: 'reolink' };
  }
  async systemStatus() { return {}; }

  // ---------- cameras (0-based channels, as the API uses them) ----------
  async cameras() {
    const st = (await this.cmd('GetChannelstatus')).status || [];
    const out = [];
    for (const c of st) {
      let streams = { main: { track: 0 }, sub: { track: 1 } };
      try { const e = (await this.cmd('GetEnc', { channel: c.channel }, { timeout: 10000 })).Enc || {}; const f = (s) => (s ? { width: s.width, height: s.height, fps: s.frameRate, codec: s.vType ? s.vType.toUpperCase() : undefined } : {}); streams = { main: { track: 0, ...f(e.mainStream) }, sub: { track: 1, ...f(e.subStream) } }; } catch (_) {}
      out.push({ id: `${this.id}:${c.channel}`, deviceId: this.id, vendor: 'reolink', channel: Number(c.channel), name: c.name || `Camera ${c.channel + 1}`, kind: 'ip', online: Number(c.online) === 1, model: c.typeInfo, streams });
    }
    return out;
  }

  // ---------- URLs ----------
  creds() { return `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`; }
  liveUrl(channel, stream = 'sub') { return `rtsp://${this.creds()}${this.host}:${this.rtspPort}/Preview_${two(Number(channel) + 1)}_${stream === 'main' ? 'main' : 'sub'}`; }
  /** Reolink has no time-based RTSP playback: find the recording file covering startMs and stream it as MP4 over HTTP. */
  async playbackUrl(channel, startMs, endMs) {
    const files = await this.searchFiles(channel, startMs - 3600 * 1000, Math.max(endMs || 0, startMs + 60000));
    const f = files.find((x) => x.start <= startMs && x.end > startMs) || files.find((x) => x.start >= startMs);
    if (!f) throw new Error('No recording at that time on the device');
    const token = await this.login();
    return `${this.base}/cgi-bin/api.cgi?cmd=Playback&source=${encodeURIComponent(f.name)}&output=${encodeURIComponent(f.name.replace(/.*\//, ''))}&token=${token}`;
  }

  async snapshot(channel) {
    const token = await this.login();
    const res = await request(`${this.base}/cgi-bin/api.cgi?cmd=Snap&channel=${channel}&rs=${Date.now().toString(36)}&token=${token}`, { timeout: 15000 });
    if (res.status >= 400 || !res.buffer || res.buffer.length < 100) throw new HttpError(res.status || 500, 'No snapshot', 'Snap');
    return { contentType: res.headers['content-type'] || 'image/jpeg', data: res.buffer };
  }

  // ---------- PTZ ----------
  async ptzCapable(channel) { try { const a = (await this.cmd('GetAbility', { User: { userName: this.username } })).Ability || {}; const ch = (a.abilityChn || [])[channel] || {}; return !!(ch.ptzCtrl && ch.ptzCtrl.permit); } catch (_) { return true; } }
  ptz(channel, op, extra = {}) { return this.cmd('PtzCtrl', { channel: Number(channel), op, ...extra }, { timeout: 8000 }); }
  ptzContinuous(channel, { pan = 0, tilt = 0, zoom = 0 }) {
    const v = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const dir = { '0,1': 'Up', '0,-1': 'Down', '-1,0': 'Left', '1,0': 'Right', '-1,1': 'LeftUp', '1,1': 'RightUp', '-1,-1': 'LeftDown', '1,-1': 'RightDown' }[`${v(pan)},${v(tilt)}`];
    const op = dir || (zoom > 0 ? 'ZoomInc' : zoom < 0 ? 'ZoomDec' : null);
    if (!op) return this.ptzStop(channel);
    const speed = Math.max(1, Math.min(64, Math.round(Math.max(Math.abs(pan), Math.abs(tilt), Math.abs(zoom)) / 100 * 64)));
    return this.ptz(channel, op, { speed });
  }
  ptzStop(channel) { return this.ptz(channel, 'Stop'); }
  ptzFocus(channel, speed) { return speed ? this.ptz(channel, speed > 0 ? 'FocusInc' : 'FocusDec', { speed: 32 }) : this.ptzStop(channel); }
  ptzIris(channel, speed) { return speed ? this.ptz(channel, speed > 0 ? 'IrisInc' : 'IrisDec', { speed: 32 }) : this.ptzStop(channel); }
  ptzAux() { return Promise.resolve(null); }
  async ptzPresets(channel) { return ((await this.cmd('GetPtzPreset', { channel: Number(channel) })).PtzPreset || []).filter((p) => p.enable).map((p) => ({ id: p.id, name: p.name || `Preset ${p.id}` })); }
  ptzGotoPreset(channel, id) { return this.ptz(channel, 'ToPos', { id: Number(id), speed: 32 }); }
  ptzSetPreset(channel, id, name) { return this.cmd('SetPtzPreset', { PtzPreset: { channel: Number(channel), enable: 1, id: Number(id), name: name || `Preset ${id}` } }); }
  ptzDeletePreset(channel, id) { return this.cmd('SetPtzPreset', { PtzPreset: { channel: Number(channel), enable: 0, id: Number(id) } }); }
  async ptzPatrols(channel) { try { return ((await this.cmd('GetPtzPatrol', { channel: Number(channel) })).PtzPatrol || []).filter((p) => p.enable).map((p) => ({ id: p.id, name: p.name || `Patrol ${p.id}`, enabled: true })); } catch (_) { return []; } }
  ptzPatrol(channel, id, start) { return this.ptz(channel, start ? 'StartPatrol' : 'StopPatrol', { id: Number(id) }); }

  // ---------- recordings ----------
  async searchFiles(channel, startMs, endMs) {
    const v = await this.cmd('Search', { Search: { channel: Number(channel), onlyStatus: 0, streamType: 'main', StartTime: tobj(startMs), EndTime: tobj(endMs) } }, { timeout: 30000 });
    return (((v.SearchResult || {}).File) || []).map((f) => ({ start: fromObj(f.StartTime), end: fromObj(f.EndTime), name: f.name, size: f.size, type: /md|ai|people|vehicle|dog/i.test(f.type || '') ? 'motion' : 'timing' })).filter((f) => Number.isFinite(f.start));
  }
  async searchRecordings(channel, startMs, endMs) {
    return (await this.searchFiles(channel, startMs, endMs)).map((f) => ({ start: f.start, end: f.end, type: f.type })).sort((a, b) => a.start - b.start);
  }
  recordingDays() { return Promise.resolve(null); }
  bookmarks() { return Promise.resolve([]); }

  // ---------- events: poll motion / AI states, report transitions ----------
  async events() {
    const out = [];
    const chans = this.cfg.cameras && this.cfg.cameras.length ? this.cfg.cameras.map((c) => Number(c.channel)) : [0];
    for (const ch of chans) {
      let md = 0; const ai = {};
      try { md = Number((await this.cmd('GetMdState', { channel: ch }, { timeout: 8000 })).state) || 0; } catch (_) {}
      try { const a = await this.cmd('GetAiState', { channel: ch }, { timeout: 8000 }); for (const k of ['people', 'vehicle', 'face', 'dog_cat']) if (a[k] && a[k].support) ai[k] = Number(a[k].alarm_state) || 0; } catch (_) {}
      const prev = this.lastStates.get(ch) || {};
      const cur = { md, ...ai };
      for (const [k, val] of Object.entries(cur)) if (val && !prev[k]) out.push({ type: k === 'md' ? 'VMD' : k, state: 'active', channel: ch, time: Date.now(), description: k === 'md' ? 'Motion detected' : `${k.replace('_', '/')} detected`, count: 1 });
      this.lastStates.set(ch, cur);
    }
    return out;
  }

  // ---------- maintenance ----------
  async storage() { return ((await this.cmd('GetHddInfo')).HddInfo || []).map((h, i) => ({ id: h.number !== undefined ? h.number : i + 1, name: `Disk ${h.number !== undefined ? h.number : i + 1}`, type: 'HDD', status: h.mount ? (h.format ? 'ok' : 'unformatted') : 'offline', property: 'RW', capacityMB: Number(h.capacity) || 0, freeMB: Number(h.size) || 0 })); }
  async time() { const t = (await this.cmd('GetTime')).Time || {}; const d = fromObj(t); return { mode: 'manual', localTime: Number.isFinite(d) ? new Date(d - new Date().getTimezoneOffset() * 60000).toISOString().replace(/\.\d{3}Z$/, '') : null, timeZone: t.timeZone }; }
  async setTimeNow() { const t = (await this.cmd('GetTime')).Time || {}; return this.cmd('SetTime', { Time: { ...t, ...tobj(Date.now()) } }); }
  reboot() { return this.cmd('Reboot'); }
  async users() { return ((await this.cmd('GetUser')).User || []).map((u) => ({ id: u.userName, name: u.userName, level: u.level })); }
  network() { return Promise.resolve([]); }
  logs() { return Promise.resolve([]); }
}

module.exports = { ReolinkDevice };
