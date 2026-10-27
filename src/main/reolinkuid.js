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
   * Relay channels: the recorder's populated slots when known (Reolink SDK), else 0..N-1 from the device dialog.
   * Channels log in only while a tile shows them (idle_disconnect) and all share one login.
   */
  relay() { return neolink.ensure({ id: this.id, host: this.host, username: this.cfg.username, password: this.cfg.password, channels: this.slotIds || this.channels }); }

  /** Recorder slot list through Reolink's SDK (needs the Reolink desktop app): [{ channel, name, state }] without empty slots. */
  async slots() {
    if (!rsdk.available()) return null;
    try { const s = (await rsdk.call('cameras', this.sdkDev())).filter((x) => x.state !== 2); return s.length ? s : null; } catch (_) { return null; }
  }

  async probe() {
    if (!this.slotIds) { const s = await this.slots(); if (s) this.applySlots(s); } // before the relay starts: no restart later
    await this.relay();
    await new Promise((r) => setTimeout(r, 500));
    const st = neolink.state(this.id);
    if (st && st.authFailure) { const e = new Error(`Login rejected through the Reolink relay: ${st.error}`); e.authFailure = true; throw e; }
    if (!st || !st.running) throw new Error(st && st.error ? st.error : 'Relay process not running');
    return { name: this.cfg.name, model: 'Reolink (UID relay)', deviceType: this.channels > 1 ? 'NVR' : 'IPC', channels: this.channels, vendor: 'reolink', apiMode: 'P2P relay' };
  }
  systemStatus() { return Promise.resolve({}); }

  applySlots(slots) {
    this.slotIds = slots.map((x) => x.channel).sort((a, b) => a - b);
    this.offline = new Set(slots.filter((x) => x.state === 0).map((x) => x.channel)); // recorder says: camera disconnected
  }

  /** Populated slots only (any order, real online state) with the Reolink app installed; else channels 0..N-1. */
  async cameras() {
    const cam = (ch, name, online) => ({ id: `${this.id}:${ch}`, deviceId: this.id, vendor: 'reolink', channel: ch, name: name || `Camera ${ch + 1}`, kind: 'ip', online, streams: { main: { track: 0 }, sub: { track: 1 } } });
    const slots = await this.slots();
    if (slots) {
      const before = JSON.stringify(this.slotIds);
      this.applySlots(slots);
      if (JSON.stringify(this.slotIds) !== before) await this.relay(); // a camera was added to / removed from a slot
      return slots.map((x) => cam(x.channel, x.name, x.state === 1));
    }
    const st = neolink.state(this.id) || { cams: {} };
    const out = [];
    for (let ch = 0; ch < this.channels; ch++) out.push(cam(ch, null, st.cams[`ch${ch}`] !== 'error'));
    return out;
  }

  /** Waits (≤45 s) until the relay serves this channel: opening a tile earlier only fails and pushes its retry back. */
  async liveUrl(channel, stream = 'sub') {
    const ch = Number(channel);
    // the recorder reports this slot's camera as disconnected: fail fast instead of opening a relay stream that never has video
    if (this.offline && this.offline.has(ch)) throw new Error('Camera offline (the recorder reports it disconnected)');
    if (!neolink.port(this.id)) await this.probe();
    for (let i = 0; i < 90; i++) {
      const st = neolink.state(this.id);
      if (!st || !st.running) throw new Error((st && st.error) || 'Reolink relay not running');
      if (st.ready.includes(`ch${ch}`)) return `rtsp://127.0.0.1:${st.port}/ch${ch}/${stream === 'main' ? 'mainStream' : 'subStream'}`;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('The Reolink relay did not get this camera ready in 45 s');
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
      // two retries 2 s apart: relay hiccups, and code -40102 right after a previous download on the channel was stopped
      const dl = (tries) => rsdk.call('download', dev, args).catch((e) => (stopped ? Promise.reject(new Error('stopped')) : tries ? new Promise((r) => setTimeout(r, 2000)).then(() => dl(tries - 1)) : Promise.reject(e)));
      const file = dl(2);
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
