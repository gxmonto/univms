'use strict';
// End-to-end check of the Rust build with the Electron e2e fixtures: mock Hikvision ISAPI + mediamtx RTSP test pattern.
// Drives the real app through WebView2's DevTools port. Usage (from the repo root):
//   UNIVMS_E2E_MEDIAMTX=path\to\mediamtx.exe node rust/e2e.js [path\to\univms-rust.exe]
// Writes rust/e2e-out/live.png and prints a JSON result; exit code 1 when live video did not play.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { startMockIsapi } = require('../tests/e2e/mock-isapi');

const RTSP_PORT = 18554;
const CDP_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');
const exe = process.argv[2] || path.join(__dirname, 'target', 'debug', process.platform === 'win32' ? 'univms-rust.exe' : 'univms-rust');
const ffmpeg = path.join(root, 'vendor', 'ffmpeg', 'win32-x64', 'ffmpeg.exe');

function rtspSource() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-mtx-'));
  const cfg = path.join(cfgDir, 'mediamtx.yml');
  fs.writeFileSync(cfg, `logLevel: warn\napi: no\nmetrics: no\npprof: no\nplayback: no\nrtsp: yes\nrtspAddress: 127.0.0.1:${RTSP_PORT}\nrtspTransports: [tcp]\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\nmoq: no\npaths:\n  all_others:\n`);
  const server = spawn(process.env.UNIVMS_E2E_MEDIAMTX, [cfg], { cwd: cfgDir, stdio: 'ignore', windowsHide: true });
  let pub;
  setTimeout(() => {
    pub = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${RTSP_PORT}/Streaming/Channels/102`], { stdio: 'ignore', windowsHide: true });
  }, 1200);
  return () => { for (const p of [pub, server]) { try { p && p.kill('SIGKILL'); } catch (_) {} } };
}

const getJson = (url) => new Promise((resolve, reject) => http.get(url, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject));

async function cdp() {
  let pages = [];
  for (let i = 0; i < 60 && !pages.some((p) => p.type === 'page' && p.title === 'UniVMS'); i++) { await sleep(500); pages = await getJson(`http://127.0.0.1:${CDP_PORT}/json`).catch(() => []); }
  const page = pages.find((p) => p.type === 'page' && p.title === 'UniVMS');
  if (!page) throw new Error('app page not found on the DevTools port');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let n = 0; const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  return { js, send, close: () => ws.close() };
}

(async () => {
  const results = {};
  const outDir = path.join(__dirname, 'e2e-out');
  fs.mkdirSync(outDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-rust-e2e-'));
  const mock = await startMockIsapi({ rtspPort: RTSP_PORT });
  const stopRtsp = rtspSource();
  const app = spawn(exe, [`--user-data-dir=${profile}`], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` }, stdio: 'ignore' });
  let c;
  try {
    c = await cdp();
    for (let i = 0; i < 40 && !(await c.js(`!!(window.vms && window.__navigate)`).catch(() => false)); i++) await sleep(250);
    results.info = await c.js(`window.vms.invoke('app:info').then((i) => ({ version: i.version, ffmpeg: !!i.ffmpeg.ffmpeg }))`);
    const dev = await c.js(`window.vms.invoke('devices:save', { type: 'hikvision', name: 'Mock NVR', host: '127.0.0.1', port: ${mock.port}, username: 'admin', password: 'pw' })`);
    results.deviceAdded = !!dev.id;
    results.passwordHidden = dev.password === undefined && dev.passwordEnc === undefined && dev.hasPassword === true;
    let cams = [];
    for (let i = 0; i < 30 && !cams.length; i++) { await sleep(500); cams = await c.js(`window.vms.invoke('cameras:list')`); }
    results.cameras = cams.length;
    const onDisk = JSON.parse(fs.readFileSync(path.join(profile, 'univms-config.json'), 'utf8'));
    results.passwordEncrypted = /^aes:/.test(onDisk.devices[0].passwordEnc) && !JSON.stringify(onDisk).includes('"pw"');
    for (const v of ['devices', 'playback', 'events', 'files', 'logs', 'settings']) { await c.js(`window.__navigate(${JSON.stringify(v)})`); await sleep(300); }
    await c.js(`window.__navigate('live', { cameraId: ${JSON.stringify(cams[0] && cams[0].id)} })`);
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const r = await c.js(`(() => { const v = document.querySelector('.tile video'); const st = document.querySelector('.tile .name .st'); return { w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0, t: v ? v.currentTime : 0, paused: v ? v.paused : true, status: st ? st.textContent : '' }; })()`);
      results.video = r;
      if (r.w > 0 && r.t > 1 && !r.paused) { ok = true; break; }
    }
    results.livePlaying = ok;
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result) fs.writeFileSync(path.join(outDir, 'live.png'), Buffer.from(shot.result.data, 'base64'));
    results.streamStats = await c.js(`window.vms.invoke('stream:stats')`);
    results.log = (await c.js(`window.vms.invoke('log:recent')`)).slice(-8);
  } catch (e) {
    results.error = e.message;
  } finally {
    if (c) c.close();
    try { app.kill(); } catch (_) {}
    stopRtsp(); mock.close();
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.livePlaying ? 0 : 1);
})();
