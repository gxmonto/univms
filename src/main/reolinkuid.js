'use strict';
/*
 * Reolink via UID (P2P relay). The device record's `host` holds the 16-character UID (or host:9000 for the native client
 * port), `channels` the number of NVR channels (1 for a camera). Live video comes from the bundled Neolink process
 * (see neolink.js). Recordings (search + playback) go through Reolink's own SDK from the installed Reolink desktop app
 * (reolinksdk.js): download-by-time in chunks, each remuxed to MPEG-TS with continuous timestamps and piped into the
 * player. No snapshots, PTZ or events over the relay.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const neolink = require('./neolink');
const rsdk = require('./reolinksdk');

const FIRST_CHUNK_MS = 30000, CHUNK_MS = 120000, LEAD_MS = 180000; // fast start, then 2-min chunks kept ≤3 min ahead of real time


class ReolinkUidDevice {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.host = cfg.host;
    this.channels = Math.max(1, Math.min(64, Number(cfg.channels) || 1));
  }
  camKind() { return 'ip'; }

  /**
   * Starts the relay process. Channels log in only while a tile shows them (idle_disconnect), so there is no login to
   * wait for here: Reolink recorders cap client sessions (~10) and a health check must not hold one.
   */
  relay(channels = this.channels) { return neolink.ensure({ id: this.id, host: this.host, username: this.cfg.username, password: this.cfg.password, channels }); }

  async probe() {
    await this.relay(Math.max(this.channels, this.slots || 0));
    await new Promise((r) => setTimeout(r, 500));
    const st = neolink.state(this.id);
    if (st && st.authFailure) { const e = new Error(`Login rejected through the Reolink relay: ${st.error}`); e.authFailure = true; throw e; }
    if (!st || !st.running) throw new Error(st && st.error ? st.error : 'Relay process not running');
    return { name: this.cfg.name, model: 'Reolink (UID relay)', deviceType: this.channels > 1 ? 'NVR' : 'IPC', channels: this.channels, vendor: 'reolink', apiMode: 'P2P relay' };
  }
  systemStatus() { return Promise.resolve({}); }

  /**
   * With the Reolink app installed, the recorder's own slot list (through Reolink's SDK): only populated slots, in any
   * order, with their real online state. Without it: channels 0..N-1 from the device dialog.
   */
  async cameras() {
    const cam = (ch, name, online) => ({ id: `${this.id}:${ch}`, deviceId: this.id, vendor: 'reolink', channel: ch, name: name || `Camera ${ch + 1}`, kind: 'ip', online, streams: { main: { track: 0 }, sub: { track: 1 } } });
    if (rsdk.available()) {
      try {
        const slots = (await rsdk.call('cameras', this.sdkDev())).filter((s) => s.state !== 2); // 2 = empty slot
        if (slots.length) {
          const need = Math.max(...slots.map((s) => s.channel)) + 1;
          if (need > this.channels) { this.slots = need; await this.relay(need); } // relay must serve the highest populated slot
          return slots.map((s) => cam(s.channel, s.name, s.state === 1));
        }
      } catch (_) { /* fall back to the configured count */ }
    }
    const st = neolink.state(this.id) || { cams: {} };
    const out = [];
    for (let ch = 0; ch < this.channels; ch++) out.push(cam(ch, null, st.cams[`ch${ch}`] !== 'error'));
    return out;
  }

  liveUrl(channel, stream = 'sub') {
    const port = neolink.port(this.id);
    if (!port) throw new Error('Reolink relay not connected yet — refresh the device and try again');
    return `rtsp://127.0.0.1:${port}/ch${Number(channel)}/${stream === 'main' ? 'mainStream' : 'subStream'}`;
  }
  playbackUrl() { return Promise.reject(new Error('Clip export is not available through the Reolink relay yet; use playback, or add the device by IP')); }

  sdkDev() { return { key: `${this.id}|${this.cfg.updatedAt || ''}`, uid: String(this.host).trim().toUpperCase(), username: this.cfg.username, password: this.cfg.password }; }

  /** Recording search through Reolink's SDK (needs the Reolink desktop app installed). */
  async searchRecordings(channel, startMs, endMs) {
    if (!rsdk.available()) return [];
    const files = await rsdk.call('search', this.sdkDev(), { channel: Number(channel), stream: 'sub', startMs, endMs });
    return files.map((f) => ({ start: f.start, end: f.end, type: 'timing' }));
  }

  /**
   * Playback for streams.startPiped (format mpegts): downloads [startMs, endMs] in chunks through the SDK and writes each
   * chunk as MPEG-TS (timestamps offset so the chunks join seamlessly). Resolves once the first chunk is ready so login /
   * "no recording" errors reach the caller; returns { stop }. Sub stream: the relay is too slow for 4K main in real time.
   */
  async playbackPiped(channel, startMs, endMs, write, done) {
    const ch = Number(channel), dev = this.sdkDev();
    const stopAt = Math.min(endMs || Date.now(), Date.now());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-reolink-'));
    const ffmpeg = require('./ffmpeg').resolve('ffmpeg');
    let stopped = false, conv = null, n = 0;
    const t0 = Date.now();
    const fetch = (from) => {
      if (from >= stopAt) return null;
      const to = Math.min(stopAt, from + (from === startMs ? FIRST_CHUNK_MS : CHUNK_MS));
      const args = { channel: ch, stream: 'sub', startMs: from, endMs: to, file: path.join(dir, `c${n++}.mp4`) };
      const file = rsdk.call('download', dev, args).catch(() => (stopped ? Promise.reject(new Error('stopped')) : rsdk.call('download', dev, args))); // one retry: relay hiccups
      file.catch(() => {}); // a prefetched chunk may fail after a stop; the loop awaits it when needed
      return { from, to, file };
    };
    const feed = (file, offsetSec) => new Promise((resolve) => {
      conv = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0', '-c', 'copy', '-output_ts_offset', String(offsetSec), '-f', 'mpegts', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      conv.stdout.on('data', (b) => { if (!stopped) write(b); });
      conv.on('close', () => { conv = null; try { fs.unlinkSync(file); } catch (_) {} resolve(); });
    });
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} };
    let cur = fetch(startMs);
    if (!cur) { cleanup(); throw new Error('Nothing recorded after that time'); }
    try { await cur.file; } catch (e) { cleanup(); throw e; } // first chunk: let errors (login, no recording, Reolink app missing) reach the player
    (async () => {
      try {
        while (cur && !stopped) {
          const file = await cur.file;
          const next = fetch(cur.to); // prefetch while this chunk plays
          await feed(file, (cur.from - startMs) / 1000);
          cur = next;
          while (cur && !stopped && (cur.from - startMs) - (Date.now() - t0) > LEAD_MS) await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (_) { /* a failed chunk (gap in the recording, relay drop) ends the playback */ }
      if (!stopped) done();
      cleanup();
    })();
    return { stop: () => { stopped = true; if (conv) try { conv.kill(); } catch (_) {} rsdk.call('stopDownload', dev, { channel: ch }).catch(() => {}); } };
  }
  snapshot() { return Promise.reject(new Error('Snapshots are not available through the Reolink relay')); }

  ptzCapable() { return Promise.resolve(false); }
  ptzContinuous() { return Promise.reject(new Error('PTZ is not available through the Reolink relay')); }
  ptzStop() { return Promise.resolve(); }
  ptzFocus() { return Promise.resolve(); }
  ptzIris() { return Promise.resolve(); }
  ptzAux() { return Promise.resolve(null); }
  ptzPresets() { return Promise.resolve([]); }
  ptzGotoPreset() { return Promise.resolve(); }
  ptzSetPreset() { return Promise.resolve(); }
  ptzDeletePreset() { return Promise.resolve(); }
  ptzPatrols() { return Promise.resolve([]); }
  ptzPatrol() { return Promise.resolve(); }

  recordingDays() { return Promise.resolve(null); }
  bookmarks() { return Promise.resolve([]); }
  storage() { return Promise.resolve([]); }
  time() { return Promise.resolve({}); }
  setTimeNow() { return Promise.reject(new Error('Not available through the Reolink relay')); }
  reboot() { return Promise.reject(new Error('Not available through the Reolink relay')); }
  users() { return Promise.resolve([]); }
  network() { return Promise.resolve([]); }
  logs() { return Promise.resolve([]); }
}

module.exports = { ReolinkUidDevice };
