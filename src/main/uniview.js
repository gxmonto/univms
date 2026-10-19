'use strict';
/*
 * Uniview (UNV) NVR / IPC driver — "LAPI" JSON API over HTTP with digest auth (verified 2026-10-19 on NVR302/304/504).
 *  - info: /LAPI/V1.0/System/DeviceInfo; channels (NVR): /LAPI/V1.0/Channels/System/ChannelDetailInfos
 *  - live RTSP: NVR /unicast/c{N}/s{0|1}/live, camera /media/video{1|2}; playback (NVR): /unicast/c{N}/s0/playback?begin=YYYYMMDDHHMMSS&end=…
 *  - recordings: /LAPI/V1.0/Channels/{N}/Media/Video/Streams/0/Records?Begin=<epoch s>&End=<epoch s> → RecordInfos[{Begin,End,RecordType}]
 *  - snapshot: /LAPI/V1.0/Channels/{N}/Media/Video/Streams/0/Snapshot
 * No event polling endpoint found (the device only pushes alarms to a subscriber address) → no events.
 */
const { request, HttpError } = require('./httpclient');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };

class UniviewDevice {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.host = cfg.host;
    this.port = Number(cfg.port) || 80;
    this.username = cfg.username;
    this.password = cfg.password;
    this.base = `${cfg.https ? 'https' : 'http'}://${this.host}:${this.port}`;
    this.auth = { type: 'digest', username: this.username, password: this.password };
    this.rtspPort = Number(cfg.rtspPort) || 554;
    this.isNvr = !cfg.info || !cfg.info.deviceType || cfg.info.deviceType === 'NVR';
  }
  camKind() { return 'ip'; }

  async lapi(pathname, { method = 'GET', body, timeout = 15000, raw = false } = {}) {
    const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
    const res = await request(this.base + pathname, { method, body: body !== undefined ? JSON.stringify(body) : undefined, headers, auth: this.auth, timeout });
    if (res.status === 401 || res.status === 403) throw new HttpError(res.status, 'Login rejected by the device', pathname);
    if (raw) { if (res.status >= 400) throw new HttpError(res.status, res.text, pathname); return res; }
    let j; try { j = JSON.parse(res.text); } catch (_) { throw new HttpError(res.status || 500, (res.text || '').slice(0, 200) || 'Not a LAPI response', pathname); }
    const r = j.Response || {};
    if (r.ResponseCode !== 0) throw new HttpError(res.status === 200 ? 400 : res.status, `${r.ResponseString || 'LAPI error'} (${r.StatusCode})`, pathname);
    return r.Data || {};
  }

  // ---------- info ----------
  async probe() {
    const d = await this.lapi('/LAPI/V1.0/System/DeviceInfo');
    this.isNvr = Number(d.DeviceType) === 1 || /NVR/i.test(d.DeviceModel || '');
    return { name: d.DeviceName, model: d.DeviceModel, serial: d.SerialNumber, firmware: d.FirmwareVersion, deviceType: this.isNvr ? 'NVR' : 'IPC', rtspPort: this.rtspPort, vendor: 'uniview' };
  }
  async systemStatus() { return {}; }

  // ---------- cameras ----------
  async cameras() {
    let infos = null;
    try { infos = (await this.lapi('/LAPI/V1.0/Channels/System/ChannelDetailInfos')).DetailInfos || []; this.isNvr = true; } catch (e) { if (e.authFailure) throw e; }
    if (!infos) { const d = await this.lapi('/LAPI/V1.0/System/DeviceInfo'); this.isNvr = false; return [{ id: `${this.id}:1`, deviceId: this.id, vendor: 'uniview', channel: 1, name: d.DeviceName || 'Camera', kind: 'ip', online: true, streams: { main: { track: 0 }, sub: { track: 1 } } }]; }
    return infos.map((c) => ({
      id: `${this.id}:${c.ID}`, deviceId: this.id, vendor: 'uniview', channel: Number(c.ID), name: c.Name || `Channel ${c.ID}`, kind: 'ip',
      online: Number(c.Status) === 1, ip: c.AddressInfo && c.AddressInfo.Address, model: c.DeviceModel,
      streams: { main: { track: 0 }, sub: { track: 1 } },
    }));
  }

  // ---------- URLs ----------
  creds() { return `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`; }
  liveUrl(channel, stream = 'sub') {
    const sub = stream !== 'main';
    return this.isNvr ? `rtsp://${this.creds()}${this.host}:${this.rtspPort}/unicast/c${channel}/s${sub ? 1 : 0}/live` : `rtsp://${this.creds()}${this.host}:${this.rtspPort}/media/video${sub ? 2 : 1}`;
  }
  playbackUrl(channel, startMs, endMs) { return `rtsp://${this.creds()}${this.host}:${this.rtspPort}/unicast/c${channel}/s0/playback?begin=${stamp(startMs)}&end=${stamp(endMs || startMs + 3600 * 1000)}`; }

  async snapshot(channel) {
    const res = await this.lapi(`/LAPI/V1.0/Channels/${channel}/Media/Video/Streams/0/Snapshot`, { raw: true });
    return { contentType: res.headers['content-type'] || 'image/jpeg', data: res.buffer };
  }

  // ---------- PTZ (presets readable; control commands not verified on a PTZ unit yet) ----------
  async ptzCapable(channel) { try { return Number((await this.lapi(`/LAPI/V1.0/Channels/${channel}/PTZ/Capabilities`)).IsSupportPTZ) === 1; } catch (_) { return false; } }
  ptzContinuous() { return Promise.reject(new Error('PTZ control for Uniview is not implemented yet (needs a PTZ camera to verify the LAPI commands)')); }
  ptzStop() { return Promise.resolve(null); }
  ptzFocus() { return this.ptzContinuous(); }
  ptzIris() { return this.ptzContinuous(); }
  ptzAux() { return this.ptzContinuous(); }
  async ptzPresets(channel) { const d = await this.lapi(`/LAPI/V1.0/Channels/${channel}/PTZ/Presets`); return (d.Presets || d.PresetInfos || []).map((p) => ({ id: Number(p.ID), name: p.Name || `Preset ${p.ID}` })); }
  ptzGotoPreset(channel, id) { return this.lapi(`/LAPI/V1.0/Channels/${channel}/PTZ/Presets/${id}/Goto`, { method: 'PUT', body: {} }); }
  ptzSetPreset() { return this.ptzContinuous(); }
  ptzDeletePreset(channel, id) { return this.lapi(`/LAPI/V1.0/Channels/${channel}/PTZ/Presets/${id}`, { method: 'DELETE' }); }
  ptzPatrols() { return Promise.resolve([]); }
  ptzPatrol() { return this.ptzContinuous(); }

  // ---------- recordings ----------
  async searchRecordings(channel, startMs, endMs) {
    const d = await this.lapi(`/LAPI/V1.0/Channels/${channel}/Media/Video/Streams/0/Records?Begin=${Math.floor(startMs / 1000)}&End=${Math.floor(endMs / 1000)}`, { timeout: 30000 });
    return (d.RecordInfos || []).map((r) => ({ start: Number(r.Begin) * 1000, end: Number(r.End) * 1000, type: Number(r.RecordType) === 4 ? 'motion' : 'timing' })).sort((a, b) => a.start - b.start);
  }
  recordingDays() { return Promise.resolve(null); }
  bookmarks() { return Promise.resolve([]); }

  // ---------- maintenance ----------
  storage() { return Promise.resolve([]); }
  async time() { const d = await this.lapi('/LAPI/V1.0/System/Time'); return { mode: 'manual', localTime: new Date(Number(d.DeviceTime) * 1000).toISOString(), timeZone: d.TimeZone }; }
  setTimeNow() { return this.lapi('/LAPI/V1.0/System/Time', { method: 'PUT', body: { DeviceTime: Math.floor(Date.now() / 1000) } }); }
  reboot() { return this.lapi('/LAPI/V1.0/System/Reboot', { method: 'PUT', body: {} }); }
  users() { return Promise.resolve([]); }
  network() { return Promise.resolve([]); }
  logs() { return Promise.resolve([]); }
}

module.exports = { UniviewDevice };
