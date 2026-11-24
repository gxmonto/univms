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
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const exe = process.platform === 'win32' ? '.exe' : '';
const procs = new Map(); // deviceId -> { proc, port, key, cfg, cams: Map(name -> 'connecting'|'online'|'error'), error, lines }
const starts = new Map();
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
  // channels: a count (0..n-1) or the explicit list of recorder slots that have a camera
  const ids = Array.isArray(dev.channels) ? dev.channels.filter((c) => c >= 0 && c < 64) : [...Array(Math.max(1, Math.min(64, Number(dev.channels) || 1))).keys()];
  const cams = [];
  // idle_disconnect: a channel holds an NVR session only while it is viewed (+30 s). Reolink NVRs cap concurrent client
  // sessions (~10 seen on an RLN16-410); one permanent session per channel got the rest kicked in a reconnect loop.
  for (const ch of ids) cams.push(`[[cameras]]\nname = "ch${ch}"\nusername = ${q(dev.username)}\npassword = ${q(dev.password)}\n${target}\nchannel_id = ${ch}\nstream = "both"\nidle_disconnect = true\npush_notifications = false\nupdate_time = false\nuse_splash = false\n`); // no "Stream not Ready" test pattern: it is MJPEG, which sent tiles into transcode mode
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
  const l = line.trim().replace(/(UID:\s*)[A-Z0-9]{16}\b/gi, '$1[redacted]'); if (!l) return;
  toFile(l);
  entry.lines.push(l); if (entry.lines.length > 60) entry.lines.shift();
  const m = /\]\s+(ch\d+):\s+(.*)$/.exec(l); if (!m) return;
  const [, name, msg] = m;
  if (/Available at/.test(msg)) { entry.ready.add(name); }
  if (/Connected and logged in/.test(msg)) { entry.cams.set(name, 'online'); entry.error = null; }
  else if (/Connection Lost|Discovery failed|Failed to connect/.test(msg)) {
    entry.cams.set(name, 'error');
    entry.error = msg.replace(/\s+/g, ' ').slice(0, 200);
    if (AUTH_RE.test(msg) && procs.get(entry.id) === entry) {
      entry.authFailure = true;
      entry.proc.kill();
    }
  }
}

/** Start (or reuse) the relay process for a device; resolves with the local RTSP port. */
async function ensure(dev) {
  const key = JSON.stringify([dev.host, dev.username, dev.password, dev.channels]);
  const pending = starts.get(dev.id);
  if (pending && pending.key === key) return pending.promise;
  const cur = procs.get(dev.id);
  if (cur && cur.key === key) {
    if (cur.authFailure) throw Object.assign(new Error('Login rejected through the Reolink relay'), { authFailure: true });
    if (running(cur)) return cur.port;
  }
  stop(dev.id);
  const d = dir();
  if (!d) throw new Error('Reolink UID support (Neolink) is not bundled in this build');

  const start = { key, promise: freePort().then((port) => {
    if (starts.get(dev.id) !== start) throw new Error('Reolink relay start was canceled');
    return spawnRelay(dev, d, port, key);
  }).finally(() => {
    if (starts.get(dev.id) === start) starts.delete(dev.id);
  }) };
  starts.set(dev.id, start);
  return start.promise;
}

function spawnRelay(dev, d, port, key) {
  const cfgDir = path.join(userData, 'neolink'); fs.mkdirSync(cfgDir, { recursive: true });
  const cfg = path.join(cfgDir, `relay-${randomUUID()}.toml`);
  fs.writeFileSync(cfg, toml(dev, port), { mode: 0o600, flag: 'wx' });
  const cleanup = () => { try { fs.unlinkSync(cfg); } catch (_) {} };
  // own plugin registry file: never share the user's/system GStreamer registry (stale entries from other installs)
  const env = { ...process.env, GST_PLUGIN_PATH_1_0: path.join(d, 'plugins'), GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_REGISTRY: path.join(cfgDir, 'gst-registry-bundled.bin'), GST_DEBUG: process.env.GST_DEBUG || 'GST_PIPELINE:2,GST_PLUGIN_LOADING:2', RUST_LOG: process.env.NEOLINK_LOG || 'info' };
  let proc;
  try { proc = spawn(path.join(d, 'neolink' + exe), ['rtsp', '--config', cfg], { env, cwd: d, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { cleanup(); throw e; }
  const entry = { id: dev.id, proc, port, key, cfg, cams: new Map(), ready: new Set(), error: null, authFailure: false, lines: [] };
  for (const output of [proc.stdout, proc.stderr]) {
    let buf = '';
    output.setEncoding('utf8');
    output.on('data', (chunk) => { const parts = (buf + chunk).split(/\r?\n/); buf = parts.pop(); for (const line of parts) onLine(entry, line); });
    output.on('end', () => onLine(entry, buf));
  }
  proc.on('error', (e) => { entry.error = e.message; cleanup(); log('neolink spawn error', dev.id, e.message); });
  proc.on('close', (code, sig) => { log('neolink exited', dev.id, code, sig || ''); entry.error ||= `Neolink exited (${code ?? sig})`; cleanup(); });
  procs.set(dev.id, entry);
  log('neolink started', dev.id, 'port', port, isUid(dev.host) ? 'uid' : 'address');
  return port;
}

function stop(deviceId) {
  starts.delete(deviceId);
  const e = procs.get(deviceId); if (!e) return;
  procs.delete(deviceId);
  try { e.proc.kill(); } catch (_) {}
  try { fs.unlinkSync(e.cfg); } catch (_) {}
}
function shutdown() { starts.clear(); for (const id of [...procs.keys()]) stop(id); }
const running = (e) => !!e.proc.pid && !e.proc.killed && e.proc.exitCode === null && e.proc.signalCode === null;
function state(deviceId) { const e = procs.get(deviceId); return e ? { port: e.port, running: running(e), cams: Object.fromEntries(e.cams), ready: [...e.ready], error: e.error, authFailure: e.authFailure, lines: e.lines.slice(-10) } : null; }
const port = (deviceId) => { const e = procs.get(deviceId); return e && running(e) ? e.port : null; };

module.exports = { available, init, ensure, stop, shutdown, state, port, toml, isUid };
