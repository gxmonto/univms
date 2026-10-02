'use strict';
/*
 * End-to-end harness, loaded by the main process when UNIVMS_E2E=1.
 *  - isolated userData directory (does not touch the real configuration)
 *  - mock Hikvision ISAPI server + ffmpeg RTSP test-pattern source
 *  - drives the renderer: add device -> live view -> wait for decoded frames -> screenshots
 * Output: screenshots in UNIVMS_E2E_OUT (default: ./e2e-out), exit code 0/1.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { startMockIsapi } = require('./mock-isapi');

const RTSP_PORT = 18554;

/**
 * RTSP test source = mediamtx server (UNIVMS_E2E_MEDIAMTX points to the binary) + ffmpeg publishing a test pattern.
 * ffmpeg alone cannot act as an RTSP play server (its listen mode only accepts ANNOUNCE/RECORD pushes).
 */
function startRtspSource(ffmpeg) {
  const url = `rtsp://127.0.0.1:${RTSP_PORT}/Streaming/Channels/102`;
  const mediamtx = process.env.UNIVMS_E2E_MEDIAMTX;
  if (!mediamtx || !fs.existsSync(mediamtx)) throw new Error('UNIVMS_E2E_MEDIAMTX must point to a mediamtx binary');
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-mtx-'));
  const cfg = path.join(cfgDir, 'mediamtx.yml');
  fs.writeFileSync(cfg, `logLevel: warn\napi: no\nmetrics: no\npprof: no\nplayback: no\nrtsp: yes\nrtspAddress: 127.0.0.1:${RTSP_PORT}\nrtspTransports: [tcp]\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\npaths:\n  all_others:\n`);
  const server = spawn(mediamtx, [cfg], { cwd: cfgDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); // cwd: keeps its auto-generated certs out of the repo
  server.stdout.on('data', (d) => process.stdout.write('[mediamtx] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('[mediamtx] ' + d));
  let pub = null;
  const startPublisher = () => {
    const args = ['-hide_banner', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '16000', '-f', 'rtsp', '-rtsp_transport', 'tcp', url];
    pub = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    pub.stderr.on('data', (d) => process.stdout.write('[rtsp-pub] ' + d));
  };
  setTimeout(startPublisher, 1200);
  return { url, kill: () => { for (const p of [pub, server]) { try { p && p.kill('SIGKILL'); } catch (_) {} } } };
}

async function run(ctx, win, app) {
  const { log } = ctx;
  const outDir = process.env.UNIVMS_E2E_OUT || path.join(process.cwd(), 'e2e-out');
  fs.mkdirSync(outDir, { recursive: true });
  const ffmpegBin = require('../../src/main/ffmpeg').resolve('ffmpeg', ctx.store.getSettings().ffmpegPath);
  if (!ffmpegBin) throw new Error('ffmpeg not found for e2e');
  const mock = await startMockIsapi({ rtspPort: RTSP_PORT });
  const src = startRtspSource(ffmpegBin);
  log('e2e: mock ISAPI on', mock.port, 'rtsp source', src.url);
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG()); log('e2e: screenshot', name); };
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = {};
  try {
    await sleep(1500);
    await shot('01-empty-live');
    // add the mock device via the renderer API path (same as the UI)
    const dev = await js(`window.vms.invoke('devices:save', { type: 'hikvision', name: 'Mock NVR', host: '127.0.0.1', port: ${mock.port}, username: 'admin', password: 'pw' })`);
    results.deviceAdded = !!dev.id;
    // wait for cameras to be enumerated
    let cams = [];
    for (let i = 0; i < 30 && !cams.length; i++) { await sleep(500); cams = await js(`window.vms.invoke('cameras:list')`); }
    results.cameras = cams.length;
    if (!cams.length) throw new Error('no cameras enumerated');
    // persistence: the device must be on disk shortly after being added
    await sleep(700);
    try { const onDisk = JSON.parse(fs.readFileSync(ctx.store.file, 'utf8')); results.persistedDevices = (onDisk.devices || []).length; results.configFile = ctx.store.file; } catch (e) { results.persistError = e.message; }
    await js(`window.__navigate('devices')`); await sleep(800); await shot('02-devices');
    await js(`window.__navigate('live', { cameraId: ${JSON.stringify(cams[0].id)} })`);
    // wait for decoded frames
    let ok = false, status = '';
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const r = await js(`(() => { const v = document.querySelector('.tile video'); const st = document.querySelector('.tile .name .st'); return { w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0, t: v ? v.currentTime : 0, paused: v ? v.paused : true, status: st ? st.textContent : '' }; })()`);
      status = JSON.stringify(r);
      if (r.w > 0 && r.t > 0.5 && !r.paused) { ok = true; results.video = r; break; }
    }
    results.livePlaying = ok;
    results.lastStatus = status;
    // drag & drop: tree nodes must be draggable="true" and a drop onto an empty tile must assign the camera
    results.treeDraggable = await js(`document.querySelector('.tree .node.camera').getAttribute('draggable')`);
    results.dropAssigned = await js(`(() => {
      const tile = document.querySelectorAll('.tile')[1];
      const dt = new DataTransfer(); dt.setData('application/x-univms-camera', ${JSON.stringify(cams[0].id)});
      tile.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      tile.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return !tile.querySelector('.name').classList.contains('hidden');
    })()`);
    await sleep(300);
    results.winControls = await js(`!!document.getElementById('win-close') && getComputedStyle(document.getElementById('topbar')).getPropertyValue('-webkit-app-region')`);
    // two-way audio with the fake microphone (Chromium --use-fake-device-for-media-stream)
    try {
      await js(`document.querySelector('.tile .tools button[title^="Two-way audio"]').click()`);
      await sleep(2500);
      results.talkStatus = await js(`document.querySelector('.tile .name .st').textContent`);
      results.talkBytesAtDevice = mock.twoWay.bytesIn;
      await js(`document.querySelector('.tile .tools button[title^="Two-way audio"]').click()`);
      await sleep(600);
      results.talkClosed = mock.twoWay.closed;
    } catch (e) { results.talkError = e.message; }
    // event rules editor opens and reads the motion grid from the device
    try {
      await js(`import('./rules.js').then((m) => m.openRulesEditor(${JSON.stringify(cams[0].id)}))`);
      await sleep(2000);
      results.rulesTabs = await js(`[...document.querySelectorAll('.modal .tabs button')].map((b) => b.textContent)`);
      results.rulesMotionEnabled = await js(`(() => { const c = document.querySelector('.modal input[type=checkbox]'); return c ? c.checked : null; })()`);
      await shot('03b-rules-editor');
      await js(`document.querySelector('.modal .m-head .icon-btn').click()`);
      await sleep(300);
    } catch (e) { results.rulesError = e.message; }
    // Hik-Connect dialog: status from the mock EZVIZ node + QR code rendered
    try {
      await js(`window.vms.invoke('devices:list').then((l) => import('./hikconnect.js').then((m) => m.openHikConnect(l[0])))`);
      await sleep(1500);
      await js(`(() => { const p = document.querySelector('.modal input[type=password]'); p.value = 'test1234'; [...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('Generate QR')).click(); })()`);
      await sleep(800);
      results.hikConnect = await js(`(() => { const img = document.querySelector('.modal img[alt="Device QR"]'); const txt = document.querySelector('.modal').textContent; return { qr: !!(img && img.src.startsWith('data:image/png') && img.style.display !== 'none'), serial: txt.includes('MOCK0001'), enabled: txt.includes('Enabled') }; })()`);
      await shot('03d-hikconnect');
      await js(`document.querySelector('.modal .m-head .icon-btn').click()`);
      await sleep(300);
    } catch (e) { results.hikConnectError = e.message; }
    // narrow window: module bar must collapse into the menu button and the window controls stay visible
    const [bw, bh] = win.getSize();
    win.setSize(1000, 700);
    await sleep(600);
    results.navCollapsedNarrow = await js(`document.getElementById('nav').classList.contains('collapsed')`);
    results.closeVisibleNarrow = await js(`(() => { const r = document.getElementById('win-close').getBoundingClientRect(); return r.right <= window.innerWidth && r.width > 0; })()`);
    await shot('03c-narrow');
    win.setSize(bw, bh);
    await sleep(600);
    results.navExpandedWide = await js(`!document.getElementById('nav').classList.contains('collapsed')`);
    await shot('03-live-playing');
    // playback view and event center for visual check
    await js(`window.__navigate('playback', { cameraId: ${JSON.stringify(cams[0].id)} })`); await sleep(1500); await shot('04-playback');
    await js(`window.__navigate('events')`); await sleep(5500); await shot('05-events');
    results.events = (await js(`window.vms.invoke('events:list', {})`)).length;
    // e-map: create a map from a bundled image and verify the custom protocol serves it
    const mapId = (await js(`window.vms.invoke('maps:save', { name: 'E2E floor', hotspots: [] })`)).id;
    const imgInfo = await js(`window.vms.invoke('maps:importImage', { id: ${JSON.stringify(mapId)}, filePath: ${JSON.stringify(path.join(__dirname, '..', '..', 'build', 'icon.png'))} })`);
    await js(`window.vms.invoke('maps:save', { id: ${JSON.stringify(mapId)}, name: 'E2E floor', hotspots: [{ cameraId: ${JSON.stringify(cams[0].id)}, x: 50, y: 50 }], image: ${JSON.stringify(imgInfo.image)} })`);
    await js(`window.__navigate('emap')`); await sleep(1500);
    results.mapImageWidth = await js(`(() => { const i = document.querySelector('.map-canvas img'); return i ? i.naturalWidth : -1; })()`);
    results.mapHotspots = await js(`document.querySelectorAll('.hotspot').length`);
    await shot('05b-emap');
    await js(`window.__navigate('maintenance')`); await sleep(1500); await shot('06-maintenance');
    await js(`window.__navigate('settings')`); await sleep(800); await shot('07-settings');
    await js(`window.__navigate('live')`); await sleep(6000); await shot('08-live-restored');
    const live2 = await js(`(() => { const v = document.querySelector('.tile video'); return v ? v.videoWidth : 0; })()`);
    results.liveRestoredWidth = live2;
  } catch (e) {
    results.error = e.message;
  } finally {
    src.kill(); mock.close();
  }
  log('E2E RESULTS', results);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const pass = results.deviceAdded && results.cameras > 0 && results.livePlaying && results.mapImageWidth > 0 && results.mapHotspots === 1 && results.events > 0 && results.treeDraggable === 'true' && results.dropAssigned === true && results.talkBytesAtDevice > 0 && results.talkClosed === 1 && Array.isArray(results.rulesTabs) && results.rulesTabs.length === 3 && results.navCollapsedNarrow === true && results.closeVisibleNarrow === true && results.navExpandedWide === true && results.hikConnect && results.hikConnect.qr && results.hikConnect.serial && results.persistedDevices === 1 && !results.error;
  log(pass ? 'E2E PASS' : 'E2E FAIL');
  app.isQuitting = true;
  if (ctx.shutdownAll) ctx.shutdownAll();
  app.exit(pass ? 0 : 1);
}

function prepare(app) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-e2e-'));
  app.setPath('userData', dir);
  return dir;
}

module.exports = { run, prepare };
