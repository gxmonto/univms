'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, protocol, safeStorage, shell, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { SecretBox } = require('./secrets');
const { DriverPool } = require('./drivers');
const { StreamManager } = require('./streams');
const { EventHub } = require('./events');
const ipc = require('./ipc');
const { Updater } = require('./updater');

// Chromium flags: HW HEVC where the platform supports it, no background throttling for video walls
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,PlatformHEVCDecoderSupport');

protocol.registerSchemesAsPrivileged([{ scheme: 'univms-map', privileges: { standard: false, secure: true, supportFetchAPI: true, bypassCSP: true } }]);

const SMOKE = !!process.env.UNIVMS_SMOKE;
const E2E = !!process.env.UNIVMS_E2E;
let e2e = null;
if (E2E) {
  e2e = require('../../tests/e2e/harness'); e2e.prepare(app);
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
// A windowed app launched by double-click has no console on Windows; stdout/stderr writes can throw there and
// would abort whatever called console.log. Make every console method unable to throw.
for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  const orig = typeof console[m] === 'function' ? console[m].bind(console) : null;
  console[m] = (...a) => { try { orig && orig(...a); } catch (_) {} };
}
for (const st of [process.stdout, process.stderr]) { try { st && st.on && st.on('error', () => {}); } catch (_) {} }
const logBuffer = [];
let logFile = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })())).join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > 2000) logBuffer.splice(0, logBuffer.length - 2000);
  if (logFile) {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile.replace(/\.log$/, '.1.log'));
      fs.appendFileSync(logFile, line + '\n');
    } catch (_) {}
  }
  console.log(line);
}
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack ? e.stack : String(e)));
process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION', e && e.stack ? e.stack : String(e)));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !SMOKE && !E2E) {
  app.quit();
} else {
  let store, pool, streams, hub, tray;
  const windows = new Set();
  const ctx = { logBuffer, log, locked: false, currentUser: null };

  const broadcast = (channel, ...args) => {
    for (const w of windows) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  function createWindow(params = {}) {
    const s = store.getSettings();
    // Fit the default size to the work area (a frameless window larger than the screen cannot be moved or resized
    // by the user) and restore the main window's last position/size when it is still on a connected display.
    const wa = screen.getPrimaryDisplay().workAreaSize;
    let bounds = { width: Math.min(params.width || 1480, wa.width - 24), height: Math.min(params.height || 900, wa.height - 24) };
    const saved = !params.aux && store.data.windowBounds;
    if (saved && saved.width && screen.getAllDisplays().some((d) => saved.x >= d.bounds.x - 50 && saved.x < d.bounds.x + d.bounds.width && saved.y >= d.bounds.y - 50 && saved.y < d.bounds.y + d.bounds.height)) {
      bounds = { x: saved.x, y: saved.y, width: Math.min(saved.width, wa.width), height: Math.min(saved.height, wa.height) };
    }
    const win = new BrowserWindow({
      ...bounds, minWidth: 900, minHeight: 600,
      backgroundColor: '#0f1318', title: 'UniVMS', show: false, autoHideMenuBar: true,
      frame: false, // custom title bar with min/max/close in the renderer (same as TwinLine)
      icon: path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icons/256x256.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false,
        backgroundThrottling: false, spellcheck: false,
      },
    });
    windows.add(win);
    const q = new URLSearchParams(params.query || {});
    if (params.aux) q.set('aux', '1');
    if (params.view) q.set('view', params.view);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: Object.fromEntries(q) });
    if (!params.aux) {
      if (saved && saved.maximized) win.maximize();
      let saveTimer = null;
      const remember = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (win.isDestroyed()) return; const b = win.getNormalBounds(); store.data.windowBounds = { ...b, maximized: win.isMaximized() }; store.save(); }, 400); };
      win.on('resize', remember); win.on('move', remember); win.on('maximize', remember); win.on('unmaximize', remember);
    }
    win.once('ready-to-show', () => {
      win.show();
      if (s.startFullscreen && !params.aux) win.setFullScreen(true);
    });
    const wc = win.webContents;
    win.on('closed', () => { windows.delete(win); streams.stopAllFor(wc); });
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => { if (!wc.isDestroyed()) wc.send('window:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() }); });
    // reload / renderer crash: the old renderer's streams have no consumer any more
    wc.on('did-start-navigation', (e) => { if (e.isMainFrame !== false) streams.stopAllFor(wc); });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    let rendererRestarts = [];
    win.webContents.on('render-process-gone', (_e, d) => {
      log('renderer gone', d.reason, 'exit code', d.exitCode);
      streams.stopAllFor(wc);
      if (d.reason === 'clean-exit' || win.isDestroyed()) return;
      // A crashed renderer leaves a blank window; reload it (at most 3 times per minute to avoid a crash loop)
      const now = Date.now();
      rendererRestarts = rendererRestarts.filter((t) => now - t < 60000);
      if (rendererRestarts.length >= 3) { log('renderer crashed repeatedly, not reloading'); return; }
      rendererRestarts.push(now);
      setTimeout(() => { if (!win.isDestroyed()) { log('reloading renderer after', d.reason); wc.reload(); } }, 500);
    });
    win.on('close', (e) => {
      if (!params.aux && store.getSettings().minimizeToTray && !app.isQuitting && tray) { e.preventDefault(); win.hide(); }
    });
    return win;
  }

  function setupTray() {
    try {
      const iconPath = path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icons/32x32.png');
      const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
      tray = new Tray(img);
      tray.setToolTip('UniVMS');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show UniVMS', click: () => { const w = [...windows][0]; if (w) { w.show(); w.focus(); } else createWindow(); } },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
      ]));
      tray.on('double-click', () => { const w = [...windows][0]; if (w) { w.show(); w.focus(); } });
    } catch (e) { log('tray unavailable', e.message); }
  }

  function buildMenu() {
    const tpl = [
      { label: 'File', submenu: [
        { label: 'New live view window', accelerator: 'CmdOrCtrl+N', click: () => createWindow({ aux: true, view: 'live' }) },
        { label: 'Open snapshots folder', click: () => { const s = store.getSettings(); shell.openPath(s.snapshotDir || path.join(app.getPath('videos'), 'UniVMS', 'Snapshots')); } },
        { type: 'separator' },
        { role: 'quit' },
      ] },
      { label: 'View', submenu: [
        ...['live', 'playback', 'events', 'emap', 'devices', 'files', 'logs', 'maintenance', 'settings'].map((v, i) => ({ label: ['Main View', 'Remote Playback', 'Event Center', 'E-map', 'Device Management', 'Local Files', 'Log Search', 'Maintenance', 'System Config'][i], accelerator: `CmdOrCtrl+${i + 1}`, click: (_m, w) => w && w.webContents.send('app:navigate', v) })),
        { type: 'separator' },
        { role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' },
      ] },
      { label: 'Help', submenu: [
        { label: 'About UniVMS', click: (_m, w) => w && w.webContents.send('app:navigate', 'about') },
      ] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
  }

  app.on('second-instance', () => { const w = [...windows][0]; if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } });

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    try { fs.mkdirSync(path.join(userData, 'logs'), { recursive: true }); logFile = path.join(userData, 'logs', 'main.log'); } catch (_) {}
    const secrets = new SecretBox(userData, { safeStorage, log });
    store = new Store(path.join(userData, 'univms-config.json'), secrets);
    log('config file', store.file, '| secrets key:', secrets.scheme, secrets.keyError ? `(previous key unreadable: ${secrets.keyError})` : '');
    if (store.lostSecrets.length) log('secrets: saved passwords unreadable for devices', store.lostSecrets.join(', '));
    store.onError = (msg) => { log('store error', msg); broadcast('app:error', msg); };
    pool = new DriverPool(store);
    streams = new StreamManager(() => store.getSettings());
    hub = new EventHub(store, pool, broadcast);
    Object.assign(ctx, { store, pool, streams, hub, broadcast, createWindow });
    ctx.locked = !!store.getSettings().requireLogin && store.list('users').length > 0 && !store.getSettings().autoLogin;

    // Serve e-map images from userData/maps
    protocol.handle('univms-map', (req) => {
      // non-standard scheme: "univms-map://file.png?t=1" parses as host=file.png, pathname='' (never include the query)
      const u = new URL(req.url);
      const name = decodeURIComponent(((u.host || '') + u.pathname).replace(/^\/+/, ''));
      const file = path.join(userData, 'maps', path.basename(name));
      return net.fetch(pathToFileURL(file).toString());
    });

    ipc.register(ctx);
    buildMenu();
    if (store.getSettings().minimizeToTray) setupTray();
    for (const d of store.list('devices')) if (d.cameras) hub.setCameras(d.id, d.cameras);
    hub.start();

    ctx.updater = new Updater({ log });
    ctx.updater.on('status', (s) => broadcast('updates:status', s));
    ctx.updater.configure(store.getSettings().updates);
    if (!SMOKE && !E2E) ctx.updater.start();

    const win = createWindow();
    log('UniVMS started', app.getVersion(), 'electron', process.versions.electron);

    if (E2E) {
      win.webContents.on('console-message', (e, level, message) => {
        const lvl = typeof e === 'object' && e.level !== undefined ? e.level : level;
        const msg = typeof e === 'object' && e.message !== undefined ? e.message : message;
        if (lvl === 'error' || lvl === 3 || lvl === 'warning' || lvl === 2) log('renderer:', msg);
      });
      win.webContents.once('did-finish-load', () => setTimeout(() => e2e.run(ctx, win, app).catch((err) => { log('E2E crashed', err.message); ctx.shutdownAll(); app.exit(1); }), 1500));
    }
    if (SMOKE) {
      const errors = [];
      win.webContents.on('console-message', (e) => {
        const level = typeof e === 'object' && e.level !== undefined ? e.level : arguments[1];
        const msg = typeof e === 'object' && e.message !== undefined ? e.message : arguments[2];
        if (level === 'error' || level === 3) errors.push(msg);
        else log('renderer:', msg);
      });
      setTimeout(async () => {
        const result = await win.webContents.executeJavaScript('window.__smoke ? window.__smoke() : "no smoke hook"').catch((e) => 'exec error: ' + e.message);
        log('SMOKE result', result);
        log('SMOKE ffmpeg', JSON.stringify(require('./ffmpeg').status(store.getSettings())));
        try { const hk = require('./hiksdk'); if (hk.available()) hk.ensureLoaded(); log('SMOKE hiksdk', JSON.stringify(hk.status())); } catch (e) { log('SMOKE hiksdk error', e.message); }
        log('SMOKE console errors', errors.length ? errors : 'none');
        app.isQuitting = true;
        ctx.shutdownAll();
        app.exit(errors.length || (typeof result === 'string' && /error/i.test(result)) ? 1 : 0);
      }, 6000);
    }
  });

  app.on('activate', () => { if (windows.size === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !(tray && store.getSettings().minimizeToTray)) app.quit(); });
  app.on('before-quit', () => { app.isQuitting = true; });
  // Also run before app.exit() (smoke / e2e): exiting with the Hikvision SDK still initialized crashed the packaged
  // process during teardown (WER dumps in %LOCALAPPDATA%\CrashDumps); app.exit() does not emit will-quit.
  function shutdownAll() {
    // config first: nothing below may prevent it from reaching the disk
    for (const step of [() => store && store.flush(), () => ctx.updater && ctx.updater.stop(), () => hub && hub.stop(), () => streams && streams.shutdown(), () => require('./hiksdk').shutdown()]) {
      try { step(); } catch (_) {}
    }
  }
  ctx.shutdownAll = shutdownAll;
  app.on('will-quit', shutdownAll);
}
