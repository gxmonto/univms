'use strict';
/*
 * Hanwha Vision / Wisenet NVR and camera driver — SUNAPI (/stw-cgi/*.cgi, digest, "key=value" lines). Verified
 * 2026-10-19 on QRN-1630S recorders (HTTPS on a custom port): deviceinfo, videosource (channels, 0-based), videoprofile,
 * streamuri (live RTSP /LiveChannel/{N}/media.smp/profile={1|2}), snapshot, recording timeline, storageinfo, date,
 * eventstatus monitordiff (multipart event stream).
 * Playback: the NVR's RTSP playback needs a "Range: clock=" PLAY header that ffmpeg cannot send → not available yet.
 * Scheme: tries the configured one, falls back once between http and https (these NVRs often only answer HTTPS).
 */
const { request, HttpError } = require('./httpclient');

const parseKv = (text) => { const o = {}; for (const line of String(text || '').split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } return o; };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

class HanwhaDevice {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.host = cfg.host;
    this.port = Number(cfg.port) || 80;
    this.username = cfg.username;
    this.password = cfg.password;
    this.scheme = cfg.https ? 'https' : 'http';
    this.auth = { type: 'digest', username: this.username, password: this.password };
    this.rtspPort = Number(cfg.rtspPort) || Number(cfg.detectedRtspPort) || 554;
    this.isNvr = !cfg.info || !cfg.info.deviceType || /NVR|DVR/i.test(cfg.info.deviceType);
    this.overlappedId = null;
  }
  get base() { return `${this.scheme}://${this.host}:${this.port}`; }
  camKind() { return 'ip'; }

  async cgi(pathname, { timeout = 15000, raw = false, retry = true } = {}) {
    let res;
    try { res = await request(this.base + pathname, { auth: this.auth, timeout }); }
    catch (e) {
      // wrong scheme shows up as a reset / TLS error, not an HTTP status
      if (retry && /socket hang up|EPROTO|ECONNRESET|wrong version number|packet length/i.test(e.message)) { this.scheme = this.scheme === 'https' ? 'http' : 'https'; return this.cgi(pathname, { timeout, raw, retry: false }); }
      throw e;
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(res.status, 'Login rejected by the device', pathname);
    if (res.status >= 400) throw new HttpError(res.status, res.text, pathname);
    if (raw) return res;
    const m = /^NG\s*Error Code:\s*(\d+)\s*Error Details:\s*(.*)$/m.exec(res.text || '');
    if (m) throw new HttpError(Number(m[1]) === 600 ? 404 : 400, `SUNAPI error ${m[1]}: ${m[2].trim()}`, pathname);
    return parseKv(res.text);
  }

  // ---------- info ----------
  async probe() {
    const kv = await this.cgi('/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view');
    this.isNvr = /NVR|DVR/i.test(kv.DeviceType || '');
    if (!this.cfg.rtspPort) { try { const r = await this.cgi('/stw-cgi/network.cgi?msubmenu=rtsp&action=view'); if (Number(r.Port)) this.rtspPort = Number(r.Port); } catch (_) {} }
    return { name: kv.DeviceName || kv.Model, model: kv.Model, serial: kv.SerialNumber, firmware: kv.FirmwareVersion, deviceType: kv.DeviceType || 'Camera', rtspPort: this.rtspPort, vendor: 'hanwha', https: this.scheme === 'https' };
  }
  async systemStatus() { return {}; }

  // ---------- cameras (SUNAPI channels are 0-based; we keep that number as the channel id) ----------
  async cameras() {
    const kv = await this.cgi('/stw-cgi/media.cgi?msubmenu=videosource&action=view');
    const chans = [...new Set(Object.keys(kv).map((k) => (/^Channel\.(\d+)\./.exec(k) || [])[1]).filter((x) => x !== undefined))].map(Number).sort((a, b) => a - b);
    const out = [];
    for (const n of chans) {
      if (kv[`Channel.${n}.State`] === 'Deactive') continue;
      let streams = { main: { track: 0 }, sub: { track: 1 } };
      try {
        const p = await this.cgi(`/stw-cgi/media.cgi?msubmenu=videoprofile&action=view&Channel=${n}`, { timeout: 10000 });
        const f = (i) => { const b = `Channel.${n}.Profile.${i}.`; return p[b + 'EncodingType'] ? { codec: p[b + 'EncodingType'], width: Number((p[b + 'Resolution'] || '').split('x')[0]) || undefined, height: Number((p[b + 'Resolution'] || '').split('x')[1]) || undefined, fps: Number(p[b + 'FrameRate']) || undefined } : {}; };
        streams = { main: { track: 0, ...f(1) }, sub: { track: 1, ...f(2) } };
      } catch (_) {}
      out.push({ id: `${this.id}:${n}`, deviceId: this.id, vendor: 'hanwha', channel: n, name: kv[`Channel.${n}.Name`] || `Channel ${n + 1}`, kind: 'ip', online: kv[`Channel.${n}.State`] === 'On', streams });
    }
    return out;
  }

  // ---------- URLs ----------
  creds() { return `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`; }
  liveUrl(channel, stream = 'sub') {
    const profile = stream === 'main' ? 1 : 2;
    return this.isNvr ? `rtsp://${this.creds()}${this.host}:${this.rtspPort}/LiveChannel/${channel}/media.smp/profile=${profile}` : `rtsp://${this.creds()}${this.host}:${this.rtspPort}/profile${profile}/media.smp`;
  }
  playbackUrl() { throw new Error('Playback from Hanwha recorders is not available yet: the recorder needs an RTSP clock range the player cannot send. Use the recorder\'s web viewer for now.'); }

  async snapshot(channel) {
    const res = await this.cgi(`/stw-cgi/video.cgi?msubmenu=snapshot&action=view&Channel=${channel}`, { raw: true });
    return { contentType: res.headers['content-type'] || 'image/jpeg', data: res.buffer };
  }

  // ---------- PTZ ----------
  async ptzCapable(channel) { try { await this.cgi(`/stw-cgi/ptzcontrol.cgi?msubmenu=query&action=view&Channel=${channel}&Query=Pan,Tilt,Zoom`, { timeout: 8000 }); return true; } catch (_) { return false; } }
  ptzContinuous(channel, { pan = 0, tilt = 0, zoom = 0 }) {
    const s = (v) => Math.round(Math.max(-6, Math.min(6, v / 100 * 6)));
    if (!pan && !tilt && !zoom) return this.ptzStop(channel);
    return this.cgi(`/stw-cgi/ptzcontrol.cgi?msubmenu=continuous&action=control&Channel=${channel}&Pan=${s(pan)}&Tilt=${s(tilt)}&Zoom=${s(zoom)}`, { timeout: 8000 });
  }
  ptzStop(channel) { return this.cgi(`/stw-cgi/ptzcontrol.cgi?msubmenu=stop&action=control&Channel=${channel}&OperationType=All`, { timeout: 8000 }); }
  ptzFocus(channel, speed) { return this.cgi(`/stw-cgi/image.cgi?msubmenu=focus&action=control&Channel=${channel}&Mode=${speed > 0 ? 'Far' : speed < 0 ? 'Near' : 'Stop'}`, { timeout: 8000 }); }
  ptzIris() { return Promise.resolve(null); }
  ptzAux() { return Promise.resolve(null); }
  async ptzPresets(channel) {
    try { const kv = await this.cgi(`/stw-cgi/ptzcontrol.cgi?msubmenu=preset&action=view&Channel=${channel}`, { timeout: 8000 }); return Object.entries(kv).filter(([k]) => /^Preset\.\d+\.Name$/.test(k)).map(([k, v]) => ({ id: Number(k.split('.')[1]), name: v || k.split('.')[1] })); }
    catch (_) { return []; }
  }
  ptzGotoPreset(channel, id) { return this.cgi(`/stw-cgi/ptzcontrol.cgi?msubmenu=preset&action=control&Channel=${channel}&Preset=${id}`, { timeout: 8000 }); }
  ptzSetPreset(channel, id, name) { return this.cgi(`/stw-cgi/ptzcontrol.cgi?msubmenu=preset&action=add&Channel=${channel}&Preset=${id}&Name=${encodeURIComponent(name || 'Preset ' + id)}`, { timeout: 8000 }); }
  ptzDeletePreset(channel, id) { return this.cgi(`/stw-cgi/ptzcontrol.cgi?msubmenu=preset&action=remove&Channel=${channel}&Preset=${id}`, { timeout: 8000 }); }
  ptzPatrols() { return Promise.resolve([]); }
  ptzPatrol(channel, id, start) { return this.cgi(`/stw-cgi/ptzcontrol.cgi?msubmenu=group&action=control&Channel=${channel}&Group=${id}&Mode=${start ? 'Start' : 'Stop'}`, { timeout: 8000 }); }

  // ---------- recordings ----------
  async overlapped() {
    if (this.overlappedId !== null) return this.overlappedId;
    try { const kv = await this.cgi('/stw-cgi/recording.cgi?msubmenu=overlapped&action=view&Channel=0&FromDate=2000-01-01T00:00:00Z&ToDate=2099-01-01T00:00:00Z'); const ids = (kv.OverlappedIDList || '').split(',').map(Number).filter(Number.isFinite); this.overlappedId = ids.length ? Math.max(...ids) : 100; }
    catch (_) { this.overlappedId = 100; }
    return this.overlappedId;
  }
  async searchRecordings(channel, startMs, endMs) {
    const ov = await this.overlapped();
    const kv = await this.cgi(`/stw-cgi/recording.cgi?msubmenu=timeline&action=view&ChannelIDList=${channel}&FromDate=${iso(startMs)}&ToDate=${iso(endMs)}&Type=All&OverlappedID=${ov}`, { timeout: 30000 });
    const out = [];
    for (const [k, v] of Object.entries(kv)) {
      const m = new RegExp(`^Channel\\.${channel}\\.Result\\.(\\d+)\\.StartTime$`).exec(k);
      if (!m) continue;
      const s = Date.parse(v), e = Date.parse(kv[`Channel.${channel}.Result.${m[1]}.EndTime`]);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      const type = kv[`Channel.${channel}.Result.${m[1]}.Type`] || 'Normal';
      out.push({ start: s, end: e, type: type === 'Normal' ? 'timing' : 'motion' });
    }
    return out.sort((a, b) => a.start - b.start);
  }
  recordingDays() { return Promise.resolve(null); }
  bookmarks() { return Promise.resolve([]); }

  // ---------- events: eventstatus monitordiff (multipart stream of key=value diffs) ----------
  async alertStream(onEvent, onClose) {
    const res = await request(this.base + '/stw-cgi/eventstatus.cgi?msubmenu=eventstatus&action=monitordiff', { auth: this.auth, stream: true, timeout: 30000 });
    if (res.status >= 400) { res.stream.resume(); throw new HttpError(res.status, '', 'monitordiff'); }
    const s = res.stream;
    let buf = '', closed = false, first = true;
    s.setTimeout(120000, () => s.destroy(new Error('event stream idle timeout')));
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('--SamsungTechwin', 2)) > 0) {
        const part = buf.slice(0, idx); buf = buf.slice(idx);
        if (first) { first = false; continue; } // initial full state, not events
        for (const line of part.split(/\r?\n/)) {
          const m = /^Channel\.(\d+)\.([A-Za-z.]+)=(True|False)$/.exec(line.trim());
          if (!m || m[2] === 'NetworkCameraConnect' && m[3] === 'True') continue;
          onEvent({ type: m[2], state: m[3] === 'True' ? 'active' : 'inactive', channel: Number(m[1]), time: Date.now(), description: m[2].replace(/([a-z])([A-Z])/g, '$1 $2'), count: 1 });
        }
      }
      if (buf.length > 1_000_000) buf = buf.slice(-100_000);
    });
    const done = (err) => { if (!closed) { closed = true; onClose && onClose(err); } };
    s.on('end', () => done()); s.on('close', () => done()); s.on('error', (e) => done(e));
    return { close() { closed = true; s.destroy(); } };
  }

  // ---------- maintenance ----------
  async storage() {
    const kv = await this.cgi('/stw-cgi/system.cgi?msubmenu=storageinfo&action=view');
    return [...new Set(Object.keys(kv).map((k) => (/^Storage\.(\d+)\./.exec(k) || [])[1]).filter(Boolean))].map((i) => ({ id: Number(i), name: kv[`Storage.${i}.Model`] || `Slot ${kv[`Storage.${i}.SlotNumber`] || i}`, type: kv[`Storage.${i}.Type`] || 'HDD', status: (kv[`Storage.${i}.Status`] || 'ok').toLowerCase() === 'normal' ? 'ok' : (kv[`Storage.${i}.Status`] || 'unknown'), property: 'RW', capacityMB: Math.round(Number(kv[`Storage.${i}.TotalSpaceInBytes`]) / 1048576) || 0, freeMB: Math.round((Number(kv[`Storage.${i}.TotalSpaceInBytes`]) - Number(kv[`Storage.${i}.UsedSpaceInBytes`])) / 1048576) || 0 }));
  }
  async time() { const kv = await this.cgi('/stw-cgi/system.cgi?msubmenu=date&action=view'); return { mode: kv.SyncType === 'NTP' ? 'NTP' : 'manual', localTime: (kv.LocalTime || '').replace(' ', 'T'), timeZone: kv.POSIXTimeZone, ntpServer: kv.NTPURLList }; }
  setTimeNow() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return this.cgi(`/stw-cgi/system.cgi?msubmenu=date&action=set&Date=${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}&Time=${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`); }
  reboot() { return this.cgi('/stw-cgi/system.cgi?msubmenu=reboot&action=control'); }
  users() { return Promise.resolve([]); }
  network() { return Promise.resolve([]); }
  logs() { return Promise.resolve([]); }
}

module.exports = { HanwhaDevice, parseKv };
