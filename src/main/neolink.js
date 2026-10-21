'use strict';
/*
 * Reolink UID (P2P) relay — runs the bundled Neolink (AGPL-3.0, separate process; our build with a Windows UDP fix lives at
 * github.com/gxmonto/neolink, branch "univms") which logs into the camera/NVR through Reolink's relay servers with the UID and
 * re-serves every channel as RTSP on 127.0.0.1: rtsp://127.0.0.1:<port>/ch<N>/{mainStream|subStream}. One process per device,
 * config written to userData/neolink/<deviceId>.toml (contains the password; removed when the process stops).
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const exe = process.platform === 'win32' ? '.exe' : '';
const procs = new Map(); // deviceId -> { proc, port, key, cfg, cams: Map(name -> 'connecting'|'online'|'error'), error, lines }
let log = () => {};
let userData = null;

function dir() {
  for (const d of [process.resourcesPath && path.join(process.resourcesPath, 'neolink'), path.join(__dirname, '..', '..', 'vendor', 'neolink', `${process.platform}-${process.arch}`)]) {
    if (d && fs.existsSync(path.join(d, 'neolink' + exe))) return d;
  }
  return null;
}
const available = () => !!dir();
function init(opts) { if (opts.log) log = opts.log; userData = opts.userData; }

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const isUid = (s) => /^[A-Z0-9]{16}$/i.test(String(s || '').trim());

/** Neolink config: one camera entry per channel (names ch0..chN-1). JSON string escaping is valid TOML basic-string escaping. */
function toml(dev, port) {
  const q = (s) => JSON.stringify(String(s == null ? '' : s));
  const target = isUid(dev.host) ? `uid = ${q(String(dev.host).trim().toUpperCase())}\ndiscovery = "cellular"` : `address = ${q(String(dev.host).trim())}`;
  const n = Math.max(1, Math.min(64, Number(dev.channels) || 1));
  const cams = [];
  // idle_disconnect: a channel holds an NVR session only while it is viewed (+30 s). Reolink NVRs cap concurrent client
  // sessions (~10 seen on an RLN16-410); one permanent session per channel got the rest kicked in a reconnect loop.
  for (let ch = 0; ch < n; ch++) cams.push(`[[cameras]]\nname = "ch${ch}"\nusername = ${q(dev.username)}\npassword = ${q(dev.password)}\n${target}\nchannel_id = ${ch}\nstream = "both"\nidle_disconnect = true\npush_notifications = false\nupdate_time = false\nuse_splash = false\n`); // no "Stream not Ready" test pattern: it is MJPEG, which sent tiles into transcode mode
  return `bind = "127.0.0.1"\nbind_port = ${port}\n\n${cams.join('\n')}`;
}

const AUTH_RE = /password|credential|login (failed|rejected)|unauthori[sz]ed/i;

// Neolink's own output goes to logs/neolink.log (rotated at 5 MB): the only record of relay/stream problems.
function toFile(l) {
  if (!userData) return;
  try {
    const f = path.join(userData, 'logs', 'neolink.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, f.replace(/\.log$/, '.1.log'));
    fs.appendFileSync(f, l + '\n');
  } catch (_) {}
}

function onLine(entry, line) {
  const l = line.trim(); if (!l) return;
  toFile(l);
  entry.lines.push(l); if (entry.lines.length > 60) entry.lines.shift();
  const m = /\]\s+(ch\d+):\s+(.*)$/.exec(l); if (!m) return;
  const [, name, msg] = m;
  if (/Connected and logged in/.test(msg)) { entry.cams.set(name, 'online'); entry.error = null; }
  else if (/Connection Lost|Discovery failed|Failed to connect/.test(msg)) { entry.cams.set(name, 'error'); entry.error = msg.replace(/\s+/g, ' ').slice(0, 200); if (AUTH_RE.test(msg)) { entry.authFailure = true; stop(entry.id); } }
}

/** Start (or reuse) the relay process for a device; resolves with the local RTSP port. */
async function ensure(dev) {
  const key = JSON.stringify([dev.host, dev.username, dev.password, dev.channels]);
  const cur = procs.get(dev.id);
  if (cur && cur.key === key && cur.proc.exitCode === null) return cur.port;
  if (cur) stop(dev.id);
  const d = dir();
  if (!d) throw new Error('Reolink UID support (Neolink) is not bundled in this build');
  const port = await freePort();
  const cfgDir = path.join(userData, 'neolink'); fs.mkdirSync(cfgDir, { recursive: true });
  const cfg = path.join(cfgDir, `${dev.id}-${port}.toml`); // per process: an exiting old process deletes its own file, not the new one
  fs.writeFileSync(cfg, toml(dev, port), { mode: 0o600 });
  // own plugin registry file: never share the user's/system GStreamer registry (stale entries from other installs)
  const env = { ...process.env, GST_PLUGIN_PATH: path.join(d, 'plugins'), GST_PLUGIN_SYSTEM_PATH: '', GST_REGISTRY: path.join(cfgDir, 'gst-registry.bin'), RUST_LOG: process.env.NEOLINK_LOG || 'info' };
  const proc = spawn(path.join(d, 'neolink' + exe), ['rtsp', '--config', cfg], { env, cwd: d, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { id: dev.id, proc, port, key, cfg, cams: new Map(), error: null, authFailure: false, lines: [] };
  let buf = '';
  const feed = (c) => { buf += c; const parts = buf.split(/\r?\n/); buf = parts.pop(); for (const p of parts) onLine(entry, p); };
  proc.stdout.on('data', feed); proc.stderr.on('data', feed);
  proc.on('error', (e) => { entry.error = e.message; log('neolink spawn error', dev.id, e.message); });
  proc.on('exit', (code, sig) => { log('neolink exited', dev.id, code, sig || ''); if (procs.get(dev.id) === entry) { entry.error = entry.error || `Neolink exited (${code})`; } try { fs.unlinkSync(cfg); } catch (_) {} });
  procs.set(dev.id, entry);
  log('neolink started', dev.id, 'port', port, isUid(dev.host) ? 'uid' : 'address');
  return port;
}

function stop(deviceId) {
  const e = procs.get(deviceId); if (!e) return;
  procs.delete(deviceId);
  try { e.proc.kill(); } catch (_) {}
  try { fs.unlinkSync(e.cfg); } catch (_) {}
}
function shutdown() { for (const id of [...procs.keys()]) stop(id); }
function state(deviceId) { const e = procs.get(deviceId); return e ? { port: e.port, running: e.proc.exitCode === null, cams: Object.fromEntries(e.cams), error: e.error, authFailure: e.authFailure, lines: e.lines.slice(-10) } : null; }
const port = (deviceId) => { const e = procs.get(deviceId); return e && e.proc.exitCode === null ? e.port : null; };

module.exports = { available, init, ensure, stop, shutdown, state, port, toml, isUid };
