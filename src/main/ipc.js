'use strict';
const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TYPES, splitCameraId } = require('./drivers');
const ffmpegBin = require('./ffmpeg');
const discovery = require('./discovery');
const { TwoWayAudioSession } = require('./twoway');
const hiksdk = require('./hiksdk');

function ts(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const safeName = (s) => String(s || 'camera').replace(/[^\w.-]+/g, '_').slice(0, 60);

function register(ctx) {
  const { store, pool, streams, hub, broadcast, createWindow, log } = ctx;
  const h = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      log('ipc error', channel, e.message);
      throw new Error(e.message || String(e));
    }
  });

  const dirs = () => {
    const s = store.getSettings();
    let base;
    try { base = app.getPath('videos'); } catch (_) { try { base = app.getPath('documents'); } catch (_e) { base = app.getPath('home'); } }
    return {
      snapshotDir: s.snapshotDir || path.join(base, 'UniVMS', 'Snapshots'),
      recordDir: s.recordDir || path.join(base, 'UniVMS', 'Recordings'),
    };
  };

  const camInfo = (cameraId) => {
    const { deviceId, channel } = splitCameraId(cameraId);
    const dev = store.getDevice(deviceId);
    if (!dev) throw new Error('Device not found for camera ' + cameraId);
    const cams = hub.cameraCache.get(deviceId) || dev.cameras || [];
    const cam = cams.find((c) => String(c.channel) === String(channel)) || { channel, name: `Channel ${channel}` };
    const alias = store.data.cameraAliases[cameraId];
    return { dev, cam: { ...cam, name: (alias && alias.name) || cam.name }, channel, driver: pool.get(deviceId) };
  };

  // ---------- app ----------
  h('app:info', () => ({
    version: app.getVersion(), name: app.getName(), platform: process.platform, userData: app.getPath('userData'),
    ffmpeg: ffmpegBin.status(store.getSettings()), ...dirs(), locked: !!ctx.locked, hiksdk: hiksdk.status(),
  }));
  h('app:openExternal', (_e, url) => shell.openExternal(url));
  h('app:changelog', (_e, version) => {
    // Section of CHANGELOG.md for a version (bundled with the app)
    for (const p of [path.join(app.getAppPath(), 'CHANGELOG.md'), path.join(__dirname, '..', '..', 'CHANGELOG.md')]) {
      try {
        const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
        const re = new RegExp(`^## ${String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))`, 'm');
        const m = re.exec(text);
        if (m) return m[1].trim();
      } catch (_) {}
    }
    return null;
  });
  // ---------- updates ----------
  h('updates:status', () => ctx.updater ? ctx.updater.status : null);
  h('updates:check', async () => { if (!ctx.updater) return null; const s = await ctx.updater.check({ manual: true }); return { ...s, manualCheck: true }; });
  h('updates:download', () => ctx.updater ? ctx.updater.download() : null);
  h('updates:install', () => ctx.updater ? ctx.updater.install() : { ok: false, reason: 'Updater unavailable' });
  h('updates:skip', (_e, version) => { if (!ctx.updater) return null; const v = ctx.updater.skip(version); store.setSettings({ updates: { ...store.getSettings().updates, skippedVersion: v } }); return v; });
  h('updates:dismiss', () => ctx.updater ? ctx.updater.dismiss() : null);
  h('updates:configure', (_e, patch) => { const u = { ...store.getSettings().updates, ...patch }; store.setSettings({ updates: u }); if (ctx.updater) ctx.updater.configure(u); return u; });
  h('app:openPath', (_e, p) => shell.openPath(p));
  h('app:showInFolder', (_e, p) => shell.showItemInFolder(p));
  h('app:quit', () => app.quit());
  h('window:fullscreen', (e, on) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(on === undefined ? !w.isFullScreen() : !!on); return w ? w.isFullScreen() : false; });
  h('window:openAux', (_e, params) => { createWindow(params || {}); return true; });
  h('window:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); w && w.minimize(); });
  h('window:toggleMaximize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.isMaximized() ? w.unmaximize() : w.maximize(); });
  h('window:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); w && w.close(); });
  h('window:isMaximized', (e) => { const w = BrowserWindow.fromWebContents(e.sender); return !!(w && w.isMaximized()); });

  // ---------- settings ----------
  h('settings:get', () => ({ ...store.getSettings(), ...dirs() }));
  h('settings:set', (_e, patch) => { const r = store.setSettings(patch); ffmpegBin.clearCache(); return r; });
  h('settings:pickDir', async (e, current) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'], defaultPath: current || undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  h('settings:pickFile', async (e, opts) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: (opts && opts.filters) || [] });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- users (app login) ----------
  h('users:list', () => store.list('users').map(({ hash, salt, ...u }) => u));
  h('users:create', (_e, { username, password, role }) => {
    if (!username || !password) throw new Error('Username and password are required');
    if (store.list('users').some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new Error('User already exists');
    const { salt, hash } = store.hashPassword(password);
    const u = store.upsert('users', { username, role: role || (store.list('users').length ? 'operator' : 'admin'), salt, hash, createdAt: Date.now() });
    const { hash: _h, salt: _s, ...pub } = u;
    return pub;
  });
  h('users:remove', (_e, id) => { store.remove('users', id); return true; });
  h('users:setPassword', (_e, { id, password }) => {
    const u = store.list('users').find((x) => x.id === id);
    if (!u) throw new Error('User not found');
    Object.assign(u, store.hashPassword(password));
    store.save();
    return true;
  });
  h('users:login', (_e, { username, password }) => {
    const u = store.verifyUser(username, password);
    if (!u) throw new Error('Invalid username or password');
    ctx.locked = false;
    ctx.currentUser = u;
    return u;
  });
  h('users:lock', () => { ctx.locked = true; ctx.currentUser = null; return true; });
  h('users:current', () => ctx.currentUser || null);

  // ---------- devices ----------
  h('devices:types', () => Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label, defaultPort: t.defaultPort })));
  h('devices:list', () => store.listDevices().map((d) => ({ ...d, status: hub.status.get(d.id) || null })));
  h('devices:test', async (_e, cfg) => {
    if (cfg.id && (!cfg.password || cfg.password === '')) {
      const stored = store.getDeviceWithSecret(cfg.id);
      if (stored) cfg = { ...cfg, password: stored.password };
    }
    const drv = pool.make(cfg);
    const info = await drv.probe();
    const cams = await drv.cameras();
    return { info, cameraCount: cams.length, cameras: cams.slice(0, 200) };
  });
  h('devices:save', async (_e, cfg) => {
    const dev = store.upsertDevice(cfg);
    hub.setStatus(dev.id, { authFailed: false, error: null });
    pool.drop(dev.id);
    hub.subscribe(dev.id);
    refreshDevice(dev.id).catch(() => {});
    broadcast('devices:changed');
    return dev;
  });
  h('devices:remove', (_e, id) => {
    hub.unsubscribe(id);
    pool.drop(id);
    hub.cameraCache.delete(id);
    hub.status.delete(id);
    store.removeDevice(id);
    broadcast('devices:changed');
    return true;
  });
  async function refreshDevice(id) {
    const drv = pool.get(id);
    let info;
    try { info = await drv.probe(); }
    catch (e) { if (!hub.noteFailure(id, e)) hub.setStatus(id, { online: false, error: e.message }); throw e; }
    const cams = await drv.cameras();
    hub.setCameras(id, cams);
    store.patchDevice(id, { info, cameras: cams, lastRefresh: Date.now() });
    if (info.rtspPort && !store.getDevice(id).rtspPort) store.patchDevice(id, { detectedRtspPort: info.rtspPort });
    hub.setStatus(id, { online: true, error: null, info });
    broadcast('devices:changed');
    return { info, cameras: cams };
  }
  ctx.refreshDevice = refreshDevice;
  h('devices:refresh', (_e, id) => refreshDevice(id));
  h('devices:refreshAll', async () => {
    const out = {};
    for (const d of store.list('devices')) {
      try { out[d.id] = (await refreshDevice(d.id)).cameras.length; } catch (e) { out[d.id] = 'error: ' + e.message; hub.setStatus(d.id, { online: false, error: e.message }); }
    }
    return out;
  });
  h('devices:status', () => hub.getStatus());
  h('devices:info', async (_e, id) => {
    const drv = pool.get(id);
    const [info, status, storage, time, network, users] = await Promise.all([
      drv.probe(), drv.systemStatus().catch(() => null), drv.storage().catch((e) => ({ error: e.message })),
      drv.time().catch((e) => ({ error: e.message })), drv.network().catch(() => []), drv.users().catch(() => []),
    ]);
    return { info, status, storage, time, network, users };
  });
  h('devices:storage', (_e, id) => pool.get(id).storage());
  h('devices:time', (_e, id) => pool.get(id).time());
  h('devices:syncTime', (_e, id) => pool.get(id).setTimeNow());
  h('devices:reboot', (_e, id) => pool.get(id).reboot());
  h('devices:logs', (_e, { id, start, end }) => pool.get(id).logs(start, end));
  h('devices:setCameraAlias', (_e, { cameraId, name, hidden, dewarp, talkChannel }) => {
    const cur = store.data.cameraAliases[cameraId] || {};
    store.data.cameraAliases[cameraId] = { ...cur, ...(name !== undefined ? { name } : {}), ...(hidden !== undefined ? { hidden } : {}), ...(dewarp !== undefined ? { dewarp } : {}), ...(talkChannel !== undefined ? { talkChannel } : {}) };
    store.save();
    broadcast('devices:changed');
    return store.data.cameraAliases[cameraId];
  });

  // ---------- two-way audio (Hikvision) ----------
  const talks = new Map(); // `${wcId}|${cameraId}` -> session
  const talkKey = (e, cameraId) => `${e.sender.id}|${cameraId}`;
  // id is a cameraId, or "dev:<deviceId>" to talk through the recorder's own audio output (speakers on the NVR)
  const talkTarget = (id, opts = {}) => {
    if (String(id).startsWith('dev:')) {
      const deviceId = String(id).slice(4);
      const dev = store.getDevice(deviceId);
      if (!dev) throw new Error('Device not found');
      return { dev, driver: pool.get(deviceId), target: { channelId: opts.channelId || 1, deviceType: (dev.info && dev.info.deviceType) || 'NVR' } };
    }
    const { dev, driver, channel } = camInfo(id);
    const alias = store.data.cameraAliases[id] || {};
    return { dev, driver, target: { cameraChannel: channel, deviceType: (dev.info && dev.info.deviceType) || '', channelId: opts.channelId || alias.talkChannel || undefined } };
  };
  h('twoway:channels', async (_e, deviceId) => {
    const dev = store.getDevice(deviceId);
    if (!dev || dev.type !== 'hikvision') return [];
    const drv = pool.get(deviceId);
    if (drv.usesSdk) {
      const info = await drv.sdk.login();
      const cams = hub.cameraCache.get(deviceId) || dev.cameras || [];
      const list = [{ id: 1, label: `${dev.name} audio output (speaker on the recorder)`, codec: 'device setting' }];
      for (const c of cams) list.push({ id: drv.sdk.voiceChannel(c.channel, c.kind), label: `${c.name} (camera ${c.channel})`, codec: 'device setting' });
      return list;
    }
    const x = await drv.xml('/ISAPI/System/TwoWayAudio/channels');
    const list = x.TwoWayAudioChannelList ? [].concat(x.TwoWayAudioChannelList.TwoWayAudioChannel || []) : [];
    const cams = hub.cameraCache.get(deviceId) || dev.cameras || [];
    return list.map((c) => {
      const id = Number(c.id);
      const cam = cams.find((k) => Number(k.channel) === id - 1);
      return { id, codec: c.audioCompressionType, enabled: c.enabled, inputType: c.audioInputType, speakerVolume: c.speakerVolume, label: id === 1 && (list.length > 1 || /NVR|DVR|XVR/i.test((dev.info && dev.info.deviceType) || '')) ? `${dev.name} audio output (speaker on the recorder)` : cam ? `${cam.name} (camera ${cam.channel})` : `Voice channel ${id}` };
    });
  });
  h('twoway:start', async (e, cameraId, opts) => {
    const { dev, driver, target } = talkTarget(cameraId, opts || {});
    if (dev.type !== 'hikvision') throw new Error('Two-way audio is currently supported for Hikvision devices only');
    const key = talkKey(e, cameraId);
    const old = talks.get(key); if (old) await old.close();
    if (driver.usesSdk) {
      // SDK voice channel: NVR local output = 1, cameras from byStartDTalkChan (exactly what iVMS does)
      const voiceChan = target.channelId || driver.sdk.voiceChannel(target.cameraChannel, driver.camKind(target.cameraChannel));
      const wc = e.sender;
      const v = await driver.sdk.startVoice(voiceChan, (chunk) => { if (!wc.isDestroyed()) wc.send('twoway:data', cameraId, chunk); });
      const sess = { send: (c) => v.send(c), close: async () => { v.stop(); talks.delete(key); if (!wc.isDestroyed()) wc.send('twoway:end', cameraId, {}); }, bytesOut: 0 };
      talks.set(key, sess);
      return { channelId: voiceChan, mapping: target.channelId ? 'manual' : 'camera', codec: v.codec, sampleRate: v.sampleRate, rxCodec: v.rxCodec, rxSampleRate: v.rxSampleRate, via: 'sdk' };
    }
    const s = new TwoWayAudioSession(driver, target);
    talks.set(key, s);
    const wc = e.sender;
    s.on('audio', (chunk) => { if (!wc.isDestroyed()) wc.send('twoway:data', cameraId, chunk); });
    s.on('error', (err) => { log('twoway error', err.message); if (!wc.isDestroyed()) wc.send('twoway:end', cameraId, { error: err.message }); });
    s.on('closed', () => { if (talks.get(key) === s) talks.delete(key); if (!wc.isDestroyed()) wc.send('twoway:end', cameraId, {}); });
    try { return await s.open(); } catch (err) { talks.delete(key); throw err; }
  });
  h('twoway:send', (e, cameraId, chunk) => { const s = talks.get(talkKey(e, cameraId)); if (s) s.send(chunk); return !!s; });
  h('twoway:stop', async (e, cameraId) => { const s = talks.get(talkKey(e, cameraId)); if (s) await s.close(); return true; });
  h('twoway:active', () => [...talks.keys()]);

  // ---------- Hik-Connect / Guarding Vision + device QR ----------
  const hikDriver = (deviceId) => { const dev = store.getDevice(deviceId); if (!dev || dev.type !== 'hikvision') throw new Error('Hik-Connect settings exist on Hikvision devices only'); return { dev, drv: pool.get(deviceId) }; };
  h('hikconnect:status', (_e, deviceId) => hikDriver(deviceId).drv.hikConnect());
  h('hikconnect:set', (_e, { deviceId, enabled, verificationCode }) => hikDriver(deviceId).drv.setHikConnect({ enabled, verificationCode }).then(() => true));
  h('hikconnect:qr', async (_e, { text }) => require('qrcode').toDataURL(String(text || ''), { margin: 1, width: 512, errorCorrectionLevel: 'M' }));
  // iVMS-4200-style password-protected device export QR (carries host/port/user/password for the mobile app's IP-device import)
  h('hikconnect:deviceQr', async (_e, { deviceId, password, host, port, name }) => {
    const dev = store.getDeviceWithSecret(deviceId);
    if (!dev) throw new Error('Device not found');
    const { encodeDeviceQr } = require('./hikqr');
    const text = encodeDeviceQr({ devices: [{ name: name || dev.name, host: host || dev.host, port: Number(port) || (dev.transport === 'sdk' ? dev.port : 8000), username: dev.username, password: dev.password }], password });
    const dataUrl = await require('qrcode').toDataURL(text, { margin: 1, width: 512, errorCorrectionLevel: 'M' });
    return { text, dataUrl, length: text.length };
  });
  h('hikconnect:saveQr', async (e, { deviceId, text }) => {
    const dev = store.getDevice(deviceId);
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: `${safeName(dev ? dev.name : 'device')}-hikconnect-qr.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (r.canceled) return null;
    await require('qrcode').toFile(r.filePath, String(text || ''), { margin: 2, width: 800, errorCorrectionLevel: 'M' });
    return r.filePath;
  });

  // ---------- smart event rules (Hikvision) ----------
  const rulesDriver = (cameraId) => { const { dev, driver, channel } = camInfo(cameraId); if (dev.type !== 'hikvision') throw new Error('Event rules can be edited on Hikvision devices only'); return { driver, channel }; };
  h('rules:caps', (_e, cameraId) => { const { driver, channel } = rulesDriver(cameraId); return driver.ruleCapabilities(channel); });
  h('rules:get', (_e, { cameraId, kind }) => { const { driver, channel } = rulesDriver(cameraId); return driver.getRule(kind, channel); });
  h('rules:set', (_e, { cameraId, kind, config }) => { const { driver, channel } = rulesDriver(cameraId); return driver.setRule(kind, channel, config).then(() => true); });

  // ---------- discovery ----------
  h('discovery:scan', (_e, opts) => discovery.discover(opts || {}));

  // ---------- cameras ----------
  h('cameras:list', () => {
    const out = [];
    for (const d of store.list('devices')) {
      const cams = hub.cameraCache.get(d.id) || d.cameras || [];
      for (const c of cams) {
        const alias = store.data.cameraAliases[c.id] || {};
        out.push({ ...c, name: alias.name || c.name, originalName: c.name, hidden: !!alias.hidden, dewarp: alias.dewarp, talkChannel: alias.talkChannel, deviceName: d.name, deviceType: d.type });
      }
    }
    return out;
  });
  h('cameras:snapshot', async (_e, { cameraId, stream, time }) => {
    const { driver, channel } = camInfo(cameraId);
    const r = await driver.snapshot(channel, stream || 'main', time);
    return { contentType: r.contentType, data: r.data.toString('base64') };
  });
  h('cameras:liveUrl', (_e, { cameraId, stream }) => {
    const { driver, channel } = camInfo(cameraId);
    return driver.liveUrl(channel, stream);
  });

  // ---------- streaming ----------
  h('stream:start', (e, opts) => {
    const { driver, channel, cam } = camInfo(opts.cameraId);
    if (driver.usesSdk) {
      // Hikvision SDK (server port 8000): the device pushes a PS stream that ffmpeg remuxes from stdin
      return streams.startPiped(e.sender, { ...opts, cameraName: cam.name }, (write) => opts.kind === 'playback'
        ? driver.sdk.startPlayback(channel, driver.camKind(channel), opts.startMs, opts.endMs, write)
        : driver.sdk.startLive(channel, driver.camKind(channel), opts.stream || store.getSettings().defaultStream || 'sub', write));
    }
    const url = opts.kind === 'playback' ? driver.playbackUrl(channel, opts.startMs, opts.endMs) : driver.liveUrl(channel, opts.stream || store.getSettings().defaultStream || 'sub');
    return streams.start(e.sender, { ...opts, url, cameraName: cam.name });
  });
  h('stream:stop', (_e, id) => streams.stop(id));
  h('stream:stats', () => streams.stats());

  // ---------- recording / snapshots ----------
  h('record:start', (e, { cameraId, stream }) => {
    const { driver, channel, cam, dev } = camInfo(cameraId);
    const file = path.join(dirs().recordDir, safeName(dev.name), `${safeName(cam.name)}_${ts()}.mp4`);
    streams.startRecord(cameraId, driver.liveUrl(channel, stream || 'main'), file, (r) => broadcast('record:end', { cameraId, ...r }));
    return { file };
  });
  h('record:stop', (_e, cameraId) => streams.stopRecord(cameraId));
  h('record:status', () => Object.fromEntries([...streams.records.entries()].map(([k, v]) => [k, { file: v.file, started: v.started }])));
  h('files:saveSnapshot', (_e, { cameraId, dataUrl, suffix }) => {
    const { cam, dev } = camInfo(cameraId);
    const dir = path.join(dirs().snapshotDir, safeName(dev.name));
    fs.mkdirSync(dir, { recursive: true });
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('Bad image data');
    const file = path.join(dir, `${safeName(cam.name)}_${ts()}${suffix || ''}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    return { file };
  });
  h('files:saveDeviceSnapshot', async (_e, { cameraId }) => {
    const { cam, dev, driver, channel } = camInfo(cameraId);
    const r = await driver.snapshot(channel, 'main');
    const dir = path.join(dirs().snapshotDir, safeName(dev.name));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeName(cam.name)}_${ts()}_full.jpg`);
    fs.writeFileSync(file, r.data);
    return { file };
  });
  h('files:list', (_e, { kind }) => {
    const dir = kind === 'recordings' ? dirs().recordDir : dirs().snapshotDir;
    const out = [];
    const walk = (d, depth) => {
      if (!fs.existsSync(d) || depth > 3) return;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p, depth + 1);
        else if (/\.(mp4|mkv|avi|jpg|jpeg|png)$/i.test(ent.name)) {
          const st = fs.statSync(p);
          out.push({ path: p, name: ent.name, folder: path.relative(dir, path.dirname(p)), size: st.size, mtime: st.mtimeMs, type: /\.(jpe?g|png)$/i.test(ent.name) ? 'image' : 'video' });
        }
      }
    };
    walk(dir, 0);
    return { dir, files: out.sort((a, b) => b.mtime - a.mtime) };
  });
  h('files:read', (_e, p) => {
    const st = fs.statSync(p);
    if (st.size > 50 * 1024 * 1024) throw new Error('File too large to preview');
    const ext = path.extname(p).toLowerCase().slice(1);
    const mime = ext === 'mp4' ? 'video/mp4' : ext === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  });
  h('files:trash', async (_e, p) => { await shell.trashItem(p); return true; });

  // ---------- playback ----------
  h('playback:search', async (_e, { cameraId, start, end }) => {
    const { driver, channel } = camInfo(cameraId);
    const segments = await driver.searchRecordings(channel, start, end);
    let bookmarks = [];
    if (driver.bookmarks) bookmarks = await driver.bookmarks(channel, start, end).catch(() => []);
    return { segments, bookmarks };
  });
  h('playback:days', (_e, { cameraId, year, month }) => { const { driver, channel } = camInfo(cameraId); return driver.recordingDays(channel, year, month); });
  h('export:clip', (e, { cameraId, start, end }) => {
    const { driver, channel, cam, dev } = camInfo(cameraId);
    const id = 'exp_' + crypto.randomBytes(4).toString('hex');
    const file = path.join(dirs().recordDir, 'Exports', `${safeName(dev.name)}_${safeName(cam.name)}_${ts(new Date(start))}_${Math.round((end - start) / 1000)}s.mp4`);
    streams.exportClip(id, driver.playbackUrl(channel, start, end), file, (end - start) / 1000,
      (p) => { if (!e.sender.isDestroyed()) e.sender.send('export:progress', { id, progress: p }); },
      (r) => broadcast('export:end', { id, ...r }));
    return { id, file };
  });
  h('export:cancel', (_e, id) => { streams.cancelExport(id); return true; });

  // ---------- PTZ ----------
  h('ptz:capable', (_e, cameraId) => { const { driver, channel } = camInfo(cameraId); return driver.ptzCapable(channel); });
  h('ptz:move', (_e, { cameraId, pan, tilt, zoom }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzContinuous(channel, { pan, tilt, zoom }).then(() => true); });
  h('ptz:stop', (_e, cameraId) => { const { driver, channel } = camInfo(cameraId); return driver.ptzStop(channel).then(() => true); });
  h('ptz:focus', (_e, { cameraId, speed }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzFocus(channel, speed).then(() => true); });
  h('ptz:iris', (_e, { cameraId, speed }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzIris(channel, speed).then(() => true); });
  h('ptz:aux', (_e, { cameraId, type, on }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzAux(channel, type, on).then(() => true); });
  h('ptz:presets', (_e, cameraId) => { const { driver, channel } = camInfo(cameraId); return driver.ptzPresets(channel); });
  h('ptz:gotoPreset', (_e, { cameraId, presetId }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzGotoPreset(channel, presetId).then(() => true); });
  h('ptz:setPreset', (_e, { cameraId, presetId, name }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzSetPreset(channel, presetId, name).then(() => true); });
  h('ptz:deletePreset', (_e, { cameraId, presetId }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzDeletePreset(channel, presetId).then(() => true); });
  h('ptz:patrols', (_e, cameraId) => { const { driver, channel } = camInfo(cameraId); return driver.ptzPatrols(channel); });
  h('ptz:patrol', (_e, { cameraId, patrolId, start }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzPatrol(channel, patrolId, start).then(() => true); });
  h('ptz:position3D', (_e, { cameraId, sx, sy, ex, ey }) => { const { driver, channel } = camInfo(cameraId); return driver.ptzPosition3D ? driver.ptzPosition3D(channel, sx, sy, ex, ey).then(() => true) : false; });

  // ---------- views / groups / maps ----------
  for (const coll of ['views', 'groups']) {
    h(`${coll}:list`, () => store.list(coll));
    h(`${coll}:save`, (_e, item) => { const r = store.upsert(coll, item); broadcast('views:changed'); return r; });
    h(`${coll}:remove`, (_e, id) => { store.remove(coll, id); broadcast('views:changed'); return true; });
  }
  h('maps:list', () => store.list('maps').map((m) => ({ ...m, imageUrl: m.image ? 'univms-map://' + path.basename(m.image) : null })));
  h('maps:save', (_e, m) => store.upsert('maps', m));
  h('maps:remove', (_e, id) => {
    const m = store.list('maps').find((x) => x.id === id);
    if (m && m.image) try { fs.unlinkSync(m.image); } catch (_) {}
    store.remove('maps', id);
    return true;
  });
  h('maps:importImage', async (e, { id, filePath }) => {
    let src = filePath;
    if (!src) {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }] });
      if (r.canceled) return null;
      src = r.filePaths[0];
    }
    const dir = path.join(app.getPath('userData'), 'maps');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${id || 'map'}_${Date.now()}${path.extname(src).toLowerCase()}`);
    fs.copyFileSync(src, dest);
    return { image: dest, imageUrl: 'univms-map://' + path.basename(dest) };
  });

  // ---------- DW server layouts import ----------
  h('dw:layouts', async (_e, deviceId) => {
    const drv = pool.get(deviceId);
    if (!drv.layouts) throw new Error('Device does not expose layouts');
    return drv.layouts();
  });

  // ---------- events ----------
  h('events:list', (_e, q) => hub.list(q || {}));
  h('events:ack', (_e, ids) => { hub.ack(ids); return true; });
  h('events:clear', () => { hub.clear(); return true; });
  h('events:test', () => hub.push({ deviceId: null, deviceName: 'UniVMS', type: 'test', state: 'active', time: Date.now(), description: 'Test alarm', severity: 'alarm' }));

  // ---------- config import / export ----------
  h('config:export', async (e, { password }) => {
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: `univms-config-${ts()}.json`, filters: [{ name: 'UniVMS config', extensions: ['json'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(store.exportConfig(password), null, 2));
    return r.filePath;
  });
  h('config:import', async (e, { password, merge }) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: 'UniVMS config', extensions: ['json'] }] });
    if (r.canceled) return null;
    const obj = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const res = store.importConfig(obj, password, { merge: merge !== false });
    for (const d of store.list('devices')) { pool.drop(d.id); hub.subscribe(d.id); }
    broadcast('devices:changed');
    hub.healthCheck().catch(() => {});
    return res;
  });

  // ---------- app log ----------
  h('log:recent', () => ctx.logBuffer.slice(-500));
  h('log:openFolder', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
  h('config:status', () => ({ file: store.file, lastFlush: store.lastFlush || null, lastError: store.lastError || null }));
}

module.exports = { register };
