'use strict';
/*
 * Main-process side of the Hikvision SDK host (sdkhost.js in an Electron utilityProcess). Same surface as
 * hiksdk.HikSdkSession, but every call is a message, so the main process never blocks on the SDK.
 */
const path = require('path');
const { utilityProcess } = require('electron');
const { available, sdkChannel, voiceChannel, SdkError } = require('./hiksdk');

let child = null, nextId = 1;
const pending = new Map();   // id -> { resolve, reject }
const streams = new Map();   // h -> onData
const alarms = new Map();    // h -> onEvent
let log = () => {};

function ensureChild() {
  if (child) return child;
  child = utilityProcess.fork(path.join(__dirname, 'sdkhost.js'), [], { serviceName: 'UniVMS Hikvision SDK', stdio: 'ignore' });
  child.on('message', (m) => {
    if (m.ev === 'data') { const cb = streams.get(m.h); if (cb) cb(Buffer.from(m.buf)); return; }
    if (m.ev === 'alarm') { const cb = alarms.get(m.h); if (cb) cb(m.event); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else { const e = new SdkError(m.error.message, m.error.sdkCode); e.authFailure = m.error.authFailure; p.reject(e); }
  });
  child.on('exit', (code) => {
    log('SDK host exited', code);
    child = null;
    for (const p of pending.values()) p.reject(new Error('Hikvision SDK process exited (' + code + ')'));
    pending.clear(); streams.clear(); alarms.clear();
    for (const s of HikSdkSession.pool.values()) s.info = null;
  });
  return child;
}
function call(op, cfg, ...args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ensureChild().postMessage({ id, op, cfg, args });
  });
}

class HikSdkSession {
  constructor(cfg) { this.cfg = cfg; this.info = null; }
  static get(cfg) {
    let s = HikSdkSession.pool.get(cfg.id);
    if (!s || s.cfg.host !== cfg.host || s.cfg.port !== cfg.port || s.cfg.username !== cfg.username || s.cfg.password !== cfg.password) {
      if (s) s.logout();
      s = new HikSdkSession(cfg); HikSdkSession.pool.set(cfg.id, s);
    }
    return s;
  }
  async login() { if (!this.info) this.info = await call('login', this.cfg); return this.info; }
  logout() { HikSdkSession.pool.delete(this.cfg.id); this.info = null; if (child) call('logout', this.cfg).catch(() => {}); }
  sdkChannel(channel, kind) { return sdkChannel(this.info, channel, kind); }
  voiceChannel(channel, kind) { return voiceChannel(this.info, channel, kind); }
  async isapi(method, url, body) { const r = await call('isapi', this.cfg, method, url, body); r.buffer = Buffer.from(r.buffer || []); return r; }
  async snapshot(channel, kind) { return Buffer.from(await call('snapshot', this.cfg, channel, kind)); }
  async deviceStreamKey() { const k = await call('deviceStreamKey', this.cfg); return k ? Buffer.from(k) : null; }
  setStreamKey(key) { return call('setStreamKey', this.cfg, key ? Buffer.from(key) : null); }
  async startLive(channel, kind, stream, onData) { return this._stream('startLive', [channel, kind, stream], onData); }
  async startPlayback(channel, kind, startMs, endMs, onData) { return this._stream('startPlayback', [channel, kind, startMs, endMs], onData); }
  async _stream(op, args, onData) {
    const h = await call(op, this.cfg, ...args);
    streams.set(h, onData);
    return { stop: () => { streams.delete(h); call('stop', this.cfg, h).catch(() => {}); } };
  }
  async startVoice(voiceChannel_, onData) {
    const { h, ...meta } = await call('startVoice', this.cfg, voiceChannel_);
    streams.set(h, onData);
    return { ...meta, send: (chunk) => { call('voiceSend', this.cfg, h, Buffer.from(chunk.buffer ? chunk.buffer : chunk, chunk.byteOffset || 0, chunk.byteLength || chunk.length)).catch(() => {}); return true; }, stop: () => { streams.delete(h); call('stop', this.cfg, h).catch(() => {}); } };
  }
  async subscribeAlarms(onEvent) {
    const h = await call('subscribeAlarms', this.cfg);
    alarms.set(h, onEvent);
    return { close: () => { alarms.delete(h); call('stop', this.cfg, h).catch(() => {}); } };
  }
}
HikSdkSession.pool = new Map();

/** { available, loaded, initialized, dir, error, platform } — spawns the host when the SDK is bundled. */
async function status() {
  if (!available()) return { available: false, dir: null, loaded: false, initialized: false, error: null, platform: `${process.platform}-${process.arch}` };
  try { return await call('status', null); } catch (e) { return { available: true, loaded: false, initialized: false, error: e.message, platform: `${process.platform}-${process.arch}` }; }
}
function shutdown() {
  if (!child) return;
  const c = child; child = null;
  try { c.postMessage({ id: 0, op: 'shutdown', cfg: null, args: [] }); } catch (_) {}
  setTimeout(() => { try { c.kill(); } catch (_) {} }, 1500);
}

module.exports = { HikSdkSession, available, status, shutdown, setLog: (fn) => { log = fn; } };
