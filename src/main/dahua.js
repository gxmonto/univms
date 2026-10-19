'use strict';
/*
 * Dahua HTTP API driver (also Amcrest, Lorex, IC Realtime and other Dahua OEMs). Digest auth on the web port.
 *  - info: magicBox.cgi; channels: configManager ChannelTitle (+ LogicDeviceManager camera state on recorders)
 *  - live RTSP: /cam/realmonitor?channel=N&subtype=0|1; playback RTSP: /cam/playback?channel=N&starttime=…&endtime=… (device local time)
 *  - snapshot: snapshot.cgi; PTZ: ptz.cgi (start/stop with a code); recordings: mediaFileFind.cgi; events: eventManager.cgi attach stream
 * Responses are "key=value" lines (table.X[i].Y=…); parseKv() flattens them.
 */
const { request, HttpError } = require('./httpclient');

const pad = (n) => String(n).padStart(2, '0');
const dahuaTime = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const rtspTime = (ms) => dahuaTime(ms).replace(/[- :]/g, '_');
const parseTime = (s) => { const m = /(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN; };

/** "a.b[0].c=v" lines -> { 'a.b[0].c': 'v' } */
function parseKv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}
/** Group keys like `${prefix}[i].field` into [{ field: value }] */
function rows(kv, prefix) {
  const out = [];
  const re = new RegExp('^' + prefix.replace(/[.[\]]/g, '\\$&') + '\\[(\\d+)\\]\\.(.+)$');
  for (const [k, v] of Object.entries(kv)) { const m = re.exec(k); if (m) (out[+m[1]] = out[+m[1]] || {})[m[2]] = v; }
  return out.filter(Boolean);
}

class DahuaDevice {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.host = cfg.host;
    this.port = Number(cfg.port) || 80;
    this.username = cfg.username;
    this.password = cfg.password;
    this.https = !!cfg.https;
    this.base = `${this.https ? 'https' : 'http'}://${this.host}:${this.port}`;
    this.auth = { type: 'digest', username: this.username, password: this.password };
    this.rtspPort = Number(cfg.rtspPort) || Number(cfg.detectedRtspPort) || 554;
    this._ptzCode = {};
  }
  camKind() { return 'ip'; }

  async get(pathname, { timeout = 15000, raw = false } = {}) {
    const res = await request(this.base + pathname, { auth: this.auth, timeout });
    if (res.status >= 400) throw new HttpError(res.status, res.text, pathname);
    return raw ? res : parseKv(res.text);
  }
  async field(pathname, key) { return (await this.get(pathname))[key]; }

  // ---------- info ----------
  async probe() {
    const model = await this.field('/cgi-bin/magicBox.cgi?action=getDeviceType', 'type'); // first call: wrong password fails here
    const [serial, version, name, cls, rtsp] = await Promise.all([
      this.field('/cgi-bin/magicBox.cgi?action=getSerialNo', 'sn').catch(() => ''),
      this.field('/cgi-bin/magicBox.cgi?action=getSoftwareVersion', 'version').catch(() => ''),
      this.field('/cgi-bin/magicBox.cgi?action=getMachineName', 'name').catch(() => ''),
      this.field('/cgi-bin/magicBox.cgi?action=getDeviceClass', 'class').catch(() => ''),
      this.field('/cgi-bin/configManager.cgi?action=getConfig&name=RTSP', 'table.RTSP.Port').catch(() => ''),
    ]);
    if (!this.cfg.rtspPort && Number(rtsp)) this.rtspPort = Number(rtsp);
    return { name: name || model, model, serial, firmware: (version || '').split(',')[0], deviceType: cls || (/NVR|XVR|DVR|HCVR/i.test(model || '') ? 'NVR' : 'IPC'), rtspPort: this.rtspPort, vendor: 'dahua' };
  }
  async systemStatus() { return {}; }

  // ---------- cameras ----------
  async cameras() {
    const kv = await this.get('/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle');
    const titles = rows(kv, 'table.ChannelTitle');
    // recorder: which channels have a camera attached (getCameraState is "501 Not Implemented" on some firmware → getCameraAll)
    let attached = null;
    try { attached = new Map(rows(await this.get('/cgi-bin/LogicDeviceManager.cgi?action=getCameraState&uniqueChannels[0]=-1'), 'states').map((s) => [Number(s.channel), /connected/i.test(s.connectionState || '')])); }
    catch (_) { try { attached = new Map(rows(await this.get('/cgi-bin/LogicDeviceManager.cgi?action=getCameraAll'), 'camera').map((c) => [Number(c.UniqueChannel !== undefined ? c.UniqueChannel : c.Channel), c.Enable !== 'false' && c['DeviceInfo.Enable'] !== 'false'])); } catch (_) {} } // UniqueChannel = recorder slot (0-based); Channel is the camera's own input
    let enc = {};
    try { enc = await this.get('/cgi-bin/configManager.cgi?action=getConfig&name=Encode'); } catch (_) {}
    const fmt = (i, which) => { const p = `table.Encode[${i}].${which}[0].Video.`; return enc[p + 'Compression'] ? { codec: enc[p + 'Compression'], width: Number(enc[p + 'Width']) || undefined, height: Number(enc[p + 'Height']) || undefined, fps: Number(enc[p + 'FPS']) || undefined } : {}; };
    return titles.map((t, i) => ({
      id: `${this.id}:${i + 1}`, deviceId: this.id, vendor: 'dahua', channel: i + 1, name: t.Name || `Channel ${i + 1}`, kind: 'ip',
      online: attached ? !!attached.get(i) : true,
      streams: { main: { track: 0, ...fmt(i, 'MainFormat') }, sub: { track: 1, ...fmt(i, 'ExtraFormat') } },
    }));
  }

  // ---------- URLs ----------
  creds() { return `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`; }
  liveUrl(channel, stream = 'sub') { return `rtsp://${this.creds()}${this.host}:${this.rtspPort}/cam/realmonitor?channel=${channel}&subtype=${stream === 'main' ? 0 : 1}`; }
  playbackUrl(channel, startMs, endMs) { return `rtsp://${this.creds()}${this.host}:${this.rtspPort}/cam/playback?channel=${channel}&starttime=${rtspTime(startMs)}&endtime=${rtspTime(endMs || startMs + 3600 * 1000)}`; }

  async snapshot(channel) {
    const res = await this.get(`/cgi-bin/snapshot.cgi?channel=${channel}`, { raw: true });
    return { contentType: res.headers['content-type'] || 'image/jpeg', data: res.buffer };
  }

  // ---------- PTZ ----------
  async ptzCapable() { return true; }
  ptz(channel, action, code, a1 = 0, a2 = 0, a3 = 0) { return this.get(`/cgi-bin/ptz.cgi?action=${action}&channel=${channel}&code=${code}&arg1=${a1}&arg2=${a2}&arg3=${a3}`, { timeout: 8000 }); }
  async ptzContinuous(channel, { pan = 0, tilt = 0, zoom = 0 }) {
    const v = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const dir = { '0,0': null, '0,1': 'Up', '0,-1': 'Down', '-1,0': 'Left', '1,0': 'Right', '-1,1': 'LeftUp', '1,1': 'RightUp', '-1,-1': 'LeftDown', '1,-1': 'RightDown' }[`${v(pan)},${v(tilt)}`];
    const code = dir || (zoom > 0 ? 'ZoomTele' : zoom < 0 ? 'ZoomWide' : null);
    if (!code) return this.ptzStop(channel);
    const speed = Math.max(1, Math.min(8, Math.round(Math.max(Math.abs(pan), Math.abs(tilt), Math.abs(zoom)) / 100 * 8)));
    this._ptzCode[channel] = code;
    return this.ptz(channel, 'start', code, dir ? speed : 0, speed);
  }
  ptzStop(channel) { const code = this._ptzCode[channel] || 'Up'; return this.ptz(channel, 'stop', code, 0, 0); }
  ptzFocus(channel, speed) { if (!speed) return this.ptz(channel, 'stop', 'FocusNear'); this._ptzCode[channel] = speed > 0 ? 'FocusFar' : 'FocusNear'; return this.ptz(channel, 'start', this._ptzCode[channel], 0, 1); }
  ptzIris(channel, speed) { if (!speed) return this.ptz(channel, 'stop', 'IrisLarge'); this._ptzCode[channel] = speed > 0 ? 'IrisLarge' : 'IrisSmall'; return this.ptz(channel, 'start', this._ptzCode[channel], 0, 1); }
  ptzAux(channel, type, on) { return this.ptz(channel, on ? 'start' : 'stop', type === 'light' ? 'LightOn' : type === 'wiper' ? 'WiperOn' : 'AuxOn'); }
  async ptzPresets(channel) {
    const kv = await this.get(`/cgi-bin/ptz.cgi?action=getPresets&channel=${channel}`, { timeout: 8000 });
    return rows(kv, 'presets').map((p) => ({ id: Number(p.Index), name: p.Name || `Preset ${p.Index}` }));
  }
  ptzGotoPreset(channel, id) { return this.ptz(channel, 'start', 'GotoPreset', 0, id); }
  ptzSetPreset(channel, id) { return this.ptz(channel, 'start', 'SetPreset', 0, id); }
  ptzDeletePreset(channel, id) { return this.ptz(channel, 'start', 'ClearPreset', 0, id); }
  async ptzPatrols(channel) {
    try { const kv = await this.get(`/cgi-bin/ptz.cgi?action=getTours&channel=${channel}`, { timeout: 8000 }); return rows(kv, 'tours').map((t) => ({ id: Number(t.Index), name: t.Name || `Tour ${t.Index}`, enabled: true })); }
    catch (_) { return [{ id: 1, name: 'Tour 1', enabled: true }]; }
  }
  ptzPatrol(channel, id, start) { return this.ptz(channel, 'start', start ? 'StartTour' : 'StopTour', id); }

  // ---------- recordings ----------
  async searchRecordings(channel, startMs, endMs) {
    const obj = await this.field('/cgi-bin/mediaFileFind.cgi?action=factory.create', 'result');
    const out = [];
    try {
      // condition.Channel is 1-based here (verified on an EV-N42A16P16 NVR: Channel=0 answers "400 Bad Request", Channel=1 lists camera 1's files)
      await this.get(`/cgi-bin/mediaFileFind.cgi?action=findFile&object=${obj}&condition.Channel=${channel}&condition.StartTime=${encodeURIComponent(dahuaTime(startMs))}&condition.EndTime=${encodeURIComponent(dahuaTime(endMs))}&condition.Types[0]=dav`, { timeout: 30000 });
      for (let guard = 0; guard < 200; guard++) {
        const kv = await this.get(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${obj}&count=100`, { timeout: 30000 });
        const items = rows(kv, 'items');
        for (const it of items) {
          const s = parseTime(it.StartTime), e = parseTime(it.EndTime);
          if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
          const flags = Object.entries(it).filter(([k]) => k.startsWith('Flags[')).map(([, v]) => v).join(',');
          out.push({ start: s, end: e, type: /Event|Motion|Alarm|Intelli/i.test(flags) ? 'motion' : 'timing' });
        }
        if (Number(kv.found) < 100 || !items.length) break;
      }
    } catch (e) { if (!(e instanceof HttpError && e.status === 400) || !out.length) { if (!(e instanceof HttpError && e.status === 400)) throw e; } }
    finally { this.get(`/cgi-bin/mediaFileFind.cgi?action=close&object=${obj}`).catch(() => {}); this.get(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${obj}`).catch(() => {}); }
    // continuous recordings come as 'timing' files; keep motion files for timeline colouring only when both kinds are present
    return out.sort((a, b) => a.start - b.start);
  }
  recordingDays() { return Promise.resolve(null); }
  bookmarks() { return Promise.resolve([]); }

  // ---------- events ----------
  async alertStream(onEvent, onClose) {
    const res = await request(this.base + '/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5', { auth: this.auth, stream: true, timeout: 30000 });
    if (res.status >= 400) { res.stream.resume(); throw new HttpError(res.status, '', 'eventManager'); }
    const s = res.stream;
    let buf = '', closed = false;
    s.setTimeout(90000, () => s.destroy(new Error('event stream idle timeout')));
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const re = /Code=([^;\r\n]+);action=([^;\r\n]+);index=(\d+)(?:;data=(\{[\s\S]*?\}))?(?=\r?\n)/g;
      let m, last = 0;
      while ((m = re.exec(buf))) {
        last = re.lastIndex;
        const [, code, action, idx, data] = m;
        if (code === 'Heartbeat' || code === 'VideoLoss' && action === 'Stop') continue;
        let d = {}; try { d = data ? JSON.parse(data) : {}; } catch (_) {}
        onEvent({ type: code, state: action === 'Start' ? 'active' : 'inactive', channel: Number(idx) + 1, time: Date.now(), description: d.Name || d.Class || code, count: 1, raw: d });
      }
      if (last) buf = buf.slice(last);
      if (buf.length > 1_000_000) buf = buf.slice(-100_000);
    });
    const done = (err) => { if (!closed) { closed = true; onClose && onClose(err); } };
    s.on('end', () => done()); s.on('close', () => done()); s.on('error', (e) => done(e));
    return { close() { closed = true; s.destroy(); } };
  }

  // ---------- maintenance ----------
  async storage() {
    const kv = await this.get('/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo');
    return rows(kv, 'list.info').map((d, i) => {
      // one disk = several partitions (Detail[k]); sum them
      const parts = rows(d, 'Detail');
      const total = parts.reduce((n, p) => n + (Number(p.TotalBytes) || 0), 0), used = parts.reduce((n, p) => n + (Number(p.UsedBytes) || 0), 0);
      const error = parts.some((p) => p.IsError === 'true') || /error|fail/i.test(d.State || '');
      return { id: i + 1, name: d.Name || parts[0] && parts[0].Path || `Disk ${i + 1}`, type: d.Type || 'local', status: error ? 'error' : 'ok', property: 'RW', capacityMB: Math.round(total / 1048576), freeMB: Math.round((total - used) / 1048576) };
    });
  }
  async time() { const t = await this.field('/cgi-bin/global.cgi?action=getCurrentTime', 'result'); return { mode: 'manual', localTime: (t || '').replace(' ', 'T') }; }
  setTimeNow() { return this.get(`/cgi-bin/global.cgi?action=setCurrentTime&time=${encodeURIComponent(dahuaTime(Date.now()))}`); }
  reboot() { return this.get('/cgi-bin/magicBox.cgi?action=reboot'); }
  async users() { const kv = await this.get('/cgi-bin/userManager.cgi?action=getUserInfoAll'); return rows(kv, 'users').map((u) => ({ id: u.Name, name: u.Name, level: u.Group })); }
  network() { return Promise.resolve([]); }
  async logs(startMs, endMs, { max = 500 } = {}) {
    const token = await this.field(`/cgi-bin/log.cgi?action=startFind&condition.StartTime=${encodeURIComponent(dahuaTime(startMs))}&condition.EndTime=${encodeURIComponent(dahuaTime(endMs))}`, 'token');
    const out = [];
    try {
      while (out.length < max) {
        const kv = await this.get(`/cgi-bin/log.cgi?action=doFind&token=${token}&count=100`, { timeout: 30000 });
        const items = rows(kv, 'items');
        for (const it of items) out.push({ time: parseTime(it.Time) || null, major: it.Type, minor: it.Detail || '', user: it.User, remote: it.Address, raw: it });
        if (Number(kv.found) < 100 || !items.length) break;
      }
    } finally { this.get(`/cgi-bin/log.cgi?action=stopFind&token=${token}`).catch(() => {}); }
    return out;
  }
}

module.exports = { DahuaDevice, parseKv, rows };
