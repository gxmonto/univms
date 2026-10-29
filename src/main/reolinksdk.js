'use strict';
/*
 * Reolink's own SDK (libBCSDKWrapper.dll from the user's installed Reolink desktop app; never bundled — it is Reolink's
 * proprietary library) for Reolink-via-UID recordings: login by UID through Reolink's relay, recording search, and
 * download-by-time to MP4 (no re-encode). Live view stays on Neolink (the SDK only hands decoded keyframes to callers;
 * full-motion video goes to its native window player).
 *
 * Signatures and struct layouts come from the Reolink app's own ffi table (resources/app/183.js, module 35490, types in
 * module 39889, sizes in module 22141); verified 2026-10-21 against an RLN16-410 (fw v3.5.1.356).
 *
 * One file, two roles: required from the main process it is a proxy that runs this same file in an Electron
 * utilityProcess (an SDK crash or a blocking call never takes the window down); in that child it hosts the SDK.
 */
const path = require('path');
const fs = require('fs');

// the Reolink app installs per user (default) or for all users (Program Files)
const DIR = [process.env.REOLINK_APP_DIR, ...[process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((p) => path.join(p, 'Reolink', 'resources', 'app'))]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'libBCSDKWrapper.dll'))) || '';
const DLL = path.join(DIR, 'libBCSDKWrapper.dll');
const available = () => process.platform === 'win32' && !!DIR;

const CMD = { GET_OSD: 2001, GET_SYS: 2021, CAMERA_STATE: 2119, LOGIN: 2087, SEARCH_RECFILES: 2113, DOWNLOAD_CUT: 2145, DOWNLOAD_CUT_PROGRESS: 2148 };
const STREAM = { main: 0, sub: 1 };

// ---------------------------------------------------------------- host (utility process)
function host() {
  const koffi = require('koffi');
  process.env.PATH = DIR + ';' + process.env.PATH;
  // the Reolink app preloads its dependencies the same way (some live next to the DLL, the CRT may be in System32)
  for (const d of ['vcruntime140', 'vcruntime140_1', 'msvcp140', 'libwinpthread-1', 'libiconv-2', 'liblzma-5', 'zlib1', 'libbz2-1', 'avutil-59', 'swresample-5', 'swscale-8', 'avcodec-61', 'avformat-61', 'SoundTouch', 'd3dx9_43', 'libcrypto-1_1-x64', 'opencv_world4120']) {
    try { koffi.load(path.join(DIR, d + '.dll')); } catch (_) {}
  }
  const lib = koffi.load(DLL);
  const str = (n) => koffi.array('char', n, 'String');
  const bytes = (n) => koffi.array('uint8_t', n);
  const OpenParam = koffi.struct('RlOpenParam', { uid_type: 'int', area: 'int', trans: 'int', p2p_log_path: str(128), p2p_log_max_file_size: 'int' });
  const LoginInfo = koffi.struct('RlLoginInfo', { iAuthMode: 'int', port: 'int', uidPort: 'int', name: str(256), host: str(1024), uid: str(128), username: str(32), password: str(32), authCode: str(64) });
  const Evt = koffi.struct('RlEvt', { bcCmd: 'int', cmdIdx: 'int', bcRspCode: 'int', channelId: 'int', subChannelId: 'int', channelType: 'int', hdevice: 'int', pRspData: 'uint8_t *', dataLen: 'unsigned long' });
  const ConnectCb = koffi.proto('void RlConnectCb(const char *json)');
  const DeviceCb = koffi.proto('int RlDeviceCb(int handle, RlEvt evt, void *user)');
  const Callbacks = koffi.struct('RlCallbacks', { connectDataCallback: koffi.pointer(ConnectCb), func: koffi.pointer(DeviceCb), userData: 'void *', jsonApiEnable: 'int' });
  const PreviewInfo = koffi.struct('RlPreviewInfo', { channel: 'int', streamType: 'int' });
  const AutoPreview = koffi.struct('RlAutoPreview', { enable: 'int', size: 'int', version: 'int', previewInfo: koffi.array(PreviewInfo, 2) });
  const QuickOpen = koffi.struct('RlQuickOpen', { chnbitMap: 'uint64_t', enabled: 'int', streamType: 'int' });
  const OpenCtx = koffi.struct('RlOpenCtx', { async: 'bool', autoPreviewCtx: AutoPreview, quickOpenCtx: QuickOpen });
  const BcTime = koffi.struct('RlTime', { iYear: 'int', iMonth: 'int', iDay: 'int', iHour: 'int', iMinute: 'int', iSecond: 'int' });
  // E_BC_CMD_GET_SYS answer (232 bytes): the recorder's own clock, local time
  const SysGeneral = koffi.struct('RlSysGeneral', { validField: bytes(128), eTS: 'int', iTimeZone: 'int', eDateFormat: 'int', eTimeFormat: 'int', iYear: 'int', iMonth: 'int', iDay: 'int', iHour: 'int', iMin: 'int', iSecond: 'int', iDeviceId: 'int', iLanguage: 'int', cDeviceName: str(32), iLoginLock: 'int', iLoginLockTime: 'int', iAllowedLoginTimes: 'int', iSyncTime: 'int', isDst: 'int' });
  // E_BC_CMD_GET_OSD answer: the channel name shown on the picture (= the camera name in the Reolink app)
  const OsdPos = koffi.struct('RlOsdPos', { bShow: 'bool', iX: 'int', iY: 'int' });
  const Osd = koffi.struct('RlOsd', { validField: bytes(128), isCopyTo: 'bool', byChannelName: str(32), channelName: OsdPos, time: OsdPos, flowData: OsdPos, eSize: 'int', elanguage: 'int', iBgColor: 'int', iWaterMark: 'int', iWaterMarkXPos: 'int', iWaterMarkYPos: 'int' });
  const TextFeature = koffi.struct('RlTextFeature', { text: bytes(128), textFeature: bytes(2048) });
  const FeatureList = koffi.struct('RlFeatureList', { iSize: 'int', item: koffi.array(TextFeature, 6) });
  const Filter = koffi.struct('RlFilter', { version: 'int', similarity: 'int', iSucceed: 'int', feature: TextFeature, filterList: FeatureList });
  const SubTypes = koffi.struct('RlSubTypes', { subSize: 'int', subType: koffi.array(bytes(78), 16) });
  const SearchParam = koffi.struct('RlSearchParam', { uid: str(32), logicChnBitmap: 'uint64_t', bNotSearchVideo: 'bool', streamType: 'int', fileType: 'int', seq: 'int', start: BcTime, end: BcTime, bsearchAITrack: 'bool', remoteChn: 'int', mode: 'int', needFeature: 'int', filterList: Filter, category: bytes(32), subTypeList: SubTypes });
  const RecFile = koffi.struct('RlRecFile', { iChannel: 'int', cIdentity: str(256), cFileName: str(32), AITrackFile: str(256), struStartTime: BcTime, struStopTime: BcTime, iFileSize: 'uint64_t', cCardNum: bytes(32), cLocked: 'uint8_t', cSupportNum: 'uint8_t', cRes: bytes(2), recordType: 'uint64_t', eStreamType: 'int', eFileType: 'int', iContainsAudio: 'int', iAnimalType: 'int', typeExtension: 'uint64_t', bEncrypted: 'bool' });
  const SearchResult = koffi.struct('RlSearchResult', { seq: 'int', fileNum: 'int', fileType: 'int', streamType: 'int', recFile: koffi.array(RecFile, 40) });
  // E_BC_CMD_CAMERA_STATE (2119), sent by the recorder right after login: one item per channel slot (21256 bytes)
  const CamItem = koffi.struct('RlCamItem', { iChannel: 'int', iIndex: 'int', cUid: str(128), devName: str(32), cFakeUid: str(128), iAbilityChanged: 'int', doorbellCoverCrop: 'float', iMeshState: 'int', iNetPortType: 'int', eState: 'int', eTrend: 'int', supportExtenStream: 'bool', eLoginState: 'int', eWifiState: 'int' });
  const CamState = koffi.struct('RlCamState', { item: koffi.array(CamItem, 64), size: 'int', chnType: 'int' });

  const fn = (sig) => lib.func(sig);
  const sdk = {
    Open: fn('int BCSDK_Open(RlOpenParam *p)'),
    Close: fn('void BCSDK_Close()'),
    SetClientModel: fn('int BCSDK_SetClientModel(const char *m)'),
    AddDevice: fn('int BCSDK_AddDevice(RlLoginInfo *info, RlCallbacks *cb, _Out_ int *err)'),
    RemoveDevice: fn('int BCSDK_RemoveDevice(int h)'),
    RemoteGetOsdCfg: fn('int BCSDK_RemoteGetOsdCfg(int h, int ch)'),
    RemoteGetSysGeneralCfg: fn('int BCSDK_RemoteGetSysGeneralCfg(int h, int ch, int ct)'),
    DeviceForceOpen: fn('int BCSDK_DeviceForceOpen(int h, RlOpenCtx ctx)'),
    RecordFilesSearch: fn('int BCSDK_RecordFilesSearch(int h, int ch, RlSearchParam *p)'),
    StartDownloadByTime: fn('int BCSDK_StartDownloadByTime(int h, int ch, const char *chUid, int logicChnBitmap, RlTime *start, RlTime *end, int stream, const char *tmpDir, const char *dst, int reserved)'),
    StopDownload: fn('int BCSDK_StopDownload(int h, int ch)'),
  };
  // The SDK's times are the recorder's local wall clock. With its UTC offset known (s.offMin, from its clock) convert with
  // that; otherwise fall back to the PC's zone (right only when PC and recorder share a time zone).
  const tparts = (ms, off) => { const d = off == null ? new Date(ms) : new Date(ms + off * 60000), u = off != null; return { iYear: u ? d.getUTCFullYear() : d.getFullYear(), iMonth: (u ? d.getUTCMonth() : d.getMonth()) + 1, iDay: u ? d.getUTCDate() : d.getDate(), iHour: u ? d.getUTCHours() : d.getHours(), iMinute: u ? d.getUTCMinutes() : d.getMinutes(), iSecond: u ? d.getUTCSeconds() : d.getSeconds() }; };
  const tms = (t, off) => (off == null ? new Date(t.iYear, t.iMonth - 1, t.iDay, t.iHour, t.iMinute, t.iSecond).getTime() : Date.UTC(t.iYear, t.iMonth - 1, t.iDay, t.iHour, t.iMinute, t.iSecond) - off * 60000);

  sdk.Open({ uid_type: 0, area: 0, trans: 0, p2p_log_path: '', p2p_log_max_file_size: 0 });
  sdk.SetClientModel('win');

  const sessions = new Map(); // key -> { handle, loggedIn, waiters: Map(cmd -> [fn]) }
  const byHandle = new Map();
  const waitFor = (s, cmd, ms, onEvt) => new Promise((resolve, reject) => {
    const list = s.waiters.get(cmd) || []; s.waiters.set(cmd, list);
    const w = (e) => { const r = onEvt ? onEvt(e) : true; if (r === undefined) return false; clearTimeout(timer); return (r instanceof Error ? reject(r) : resolve(r)), true; };
    const timer = setTimeout(() => { const i = list.indexOf(w); if (i >= 0) list.splice(i, 1); reject(new Error(`Reolink SDK: no answer (cmd ${cmd})`)); }, ms);
    list.push(w);
  });
  const connectCb = koffi.register(() => {}, koffi.pointer(ConnectCb));
  const deviceCb = koffi.register((h, e) => {
    const s = byHandle.get(h); if (!s) return 0;
    if (e.bcCmd === CMD.CAMERA_STATE && e.pRspData && e.dataLen === koffi.sizeof(CamState)) {
      const st = koffi.decode(e.pRspData, CamState); const items = [];
      for (let i = 0; i < Math.min(st.size, 64); i++) { const c = st.item[i]; if (c.iChannel >= 0) items.push({ channel: c.iChannel, name: c.devName, state: c.eState }); }
      s.cameraState = items; s.cameraStateAt = Date.now();
    }
    const list = s.waiters.get(e.bcCmd); if (!list) return 0;
    for (let i = 0; i < list.length; i++) if (list[i](e)) { list.splice(i, 1); i--; }
    return 0;
  }, koffi.pointer(DeviceCb));

  async function session({ key, uid, username, password }) {
    let s = sessions.get(key);
    if (s && s.loggedIn) return s;
    if (!s) {
      const err = [0];
      const handle = sdk.AddDevice({ iAuthMode: 0, port: 9000, uidPort: 2018, name: key.slice(0, 200), host: '', uid, username, password, authCode: '' }, { connectDataCallback: connectCb, func: deviceCb, userData: null, jsonApiEnable: 0 }, err);
      if (handle < 0 || err[0]) throw new Error(`Reolink SDK: could not add the device (${handle}/${err[0]})`);
      s = { key, handle, loggedIn: false, waiters: new Map() };
      sessions.set(key, s); byHandle.set(handle, s);
    }
    const login = waitFor(s, CMD.LOGIN, 30000, (e) => (e.bcRspCode === 0 ? true : Object.assign(new Error(e.bcRspCode === 10 || e.bcRspCode === 4 ? 'Login rejected by the Reolink device (user or password)' : `Reolink login failed (code ${e.bcRspCode})`), { authFailure: e.bcRspCode === 10 || e.bcRspCode === 4 })));
    sdk.DeviceForceOpen(s.handle, { async: true, autoPreviewCtx: { enable: 0, size: 0, version: 0, previewInfo: [{ channel: 0, streamType: 0 }, { channel: 0, streamType: 0 }] }, quickOpenCtx: { chnbitMap: 0, enabled: 0, streamType: 0 } });
    const t0 = Date.now();
    try { await login; } catch (e) { drop(key); log('reolink login failed', uid.slice(0, 6) + '…', e.message); throw e; }
    log('reolink login ok', uid.slice(0, 6) + '…', Date.now() - t0, 'ms');
    s.loggedIn = true; s.lastUse = Date.now();
    await readClock(s);
    return s;
  }
  // recorder UTC offset (minutes, DST included) = its clock minus ours, rounded to 15 min; null = unknown (PC zone used)
  async function readClock(s) {
    const ans = waitFor(s, CMD.GET_SYS, 10000, (e) => (e.bcRspCode !== 0 ? new Error(`code ${e.bcRspCode}`) : e.pRspData && e.dataLen >= koffi.sizeof(SysGeneral) ? koffi.decode(e.pRspData, SysGeneral) : new Error(`len ${e.dataLen}`)));
    ans.catch(() => {});
    try {
      const rc = sdk.RemoteGetSysGeneralCfg(s.handle, 0, 0);
      if (rc !== 0) throw new Error(`rc ${rc}`);
      const g = await ans;
      const off = Math.round((Date.UTC(g.iYear, g.iMonth - 1, g.iDay, g.iHour, g.iMin, g.iSecond) - Date.now()) / 900000) * 15;
      s.offMin = Math.abs(off) <= 14 * 60 ? off : null;
      log('reolink clock', s.key.split('|')[0], 'UTC offset', s.offMin, 'min; PC', -new Date().getTimezoneOffset());
    } catch (e) { s.offMin = null; log('reolink clock unreadable, using the PC time zone:', e.message); }
  }
  function drop(key) { const s = sessions.get(key); if (!s) return; sessions.delete(key); byHandle.delete(s.handle); try { sdk.RemoveDevice(s.handle); } catch (_) {} }

  let seq = 0;
  async function search(dev, { channel, stream, startMs, endMs }) {
    const s = await session(dev); s.lastUse = Date.now();
    const out = []; const mySeq = ++seq;
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reolink SDK: recording search timed out')), 60000);
      const list = s.waiters.get(CMD.SEARCH_RECFILES) || []; s.waiters.set(CMD.SEARCH_RECFILES, list);
      list.push((e) => {
        if (e.channelId % 64 !== channel) return false;
        if (e.bcRspCode !== 0) { clearTimeout(timer); reject(new Error(`Reolink search failed (code ${e.bcRspCode})`)); return true; }
        if (!e.dataLen || !e.pRspData) { clearTimeout(timer); resolve(); return true; } // no data = nothing (more) found
        const r = koffi.decode(e.pRspData, SearchResult);
        if (r.seq !== mySeq) return false;
        for (let i = 0; i < r.fileNum; i++) { const f = r.recFile[i]; out.push({ start: tms(f.struStartTime, s.offMin), end: tms(f.struStopTime, s.offMin), recordType: Number(f.recordType), size: Number(f.iFileSize) }); }
        if (r.fileNum < 40) { clearTimeout(timer); resolve(); return true; }
        return false; // more batches follow
      });
    });
    const empty = { text: Buffer.alloc(128), textFeature: Buffer.alloc(2048) };
    const rc = sdk.RecordFilesSearch(s.handle, channel, { uid: '', logicChnBitmap: 255, bNotSearchVideo: false, streamType: STREAM[stream] ?? 0, fileType: 0, seq: mySeq, start: tparts(startMs, s.offMin), end: tparts(endMs, s.offMin), bsearchAITrack: true, remoteChn: -1, mode: 0, needFeature: 0, filterList: { version: 0, similarity: 0, iSucceed: 0, feature: empty, filterList: { iSize: 0, item: Array(6).fill(empty) } }, category: Buffer.alloc(32), subTypeList: { subSize: 0, subType: Array(16).fill(Buffer.alloc(78)) } });
    if (rc !== 0) throw new Error(`Reolink search could not start (${rc})`);
    await done;
    log('reolink search ch', channel, out.length, 'files');
    return out.sort((a, b) => a.start - b.start);
  }

  const busy = new Map(); // `${key}|${channel}` -> download in progress (the SDK allows one per channel)
  async function download(dev, { channel, stream, startMs, endMs, file }) {
    const s = await session(dev); s.lastUse = Date.now();
    const slot = `${dev.key}|${channel}`;
    while (busy.get(slot)) await busy.get(slot).catch(() => {});
    const tmp = path.join(path.dirname(file), '.bctmp'); fs.mkdirSync(tmp, { recursive: true });
    try { fs.unlinkSync(file); } catch (_) {}
    const p = (async () => {
      const done = waitFor(s, CMD.DOWNLOAD_CUT, 10 * 60000, (e) => (e.bcRspCode === 0 ? true : new Error(`Reolink download failed (code ${e.bcRspCode})`)));
      const rc = sdk.StartDownloadByTime(s.handle, channel, '', 0, tparts(startMs, s.offMin), tparts(endMs, s.offMin), STREAM[stream] ?? 1, tmp, file, 0);
      if (rc !== 0) throw new Error(`Reolink download could not start (${rc})`);
      await done.catch((e) => { log('reolink download ch', channel, e.message); throw e; });
      sdk.StopDownload(s.handle, channel); // finalizes the MP4 (moov + move out of the temp folder), as the Reolink app does at 100 %
      // the file appears shortly after: wait until it exists and stops growing
      let last = -1;
      for (let i = 0; i < 75; i++) {
        const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
        if (size > 0 && size === last) break;
        last = size; await new Promise((r) => setTimeout(r, 200));
      }
      if (!fs.existsSync(file)) throw new Error('Reolink download produced no file (no recording in that range?)');
      return file;
    })();
    busy.set(slot, p);
    try { return await p; } finally { if (busy.get(slot) === p) busy.delete(slot); s.lastUse = Date.now(); }
  }
  function stopDownload(dev, { channel }) { const s = sessions.get(dev.key); if (s) try { sdk.StopDownload(s.handle, channel); } catch (_) {} }

  // idle sessions log out after 2 minutes (the recorder's session cap is small)
  setInterval(() => { for (const s of [...sessions.values()]) if (Date.now() - (s.lastUse || 0) > 120000 && ![...busy.keys()].some((k) => k.startsWith(s.key + '|'))) drop(s.key); }, 30000).unref();

  /** Channel slots of the recorder: { channel (0-based), name, state } with state 1 connected, 0 offline, 2 empty slot. */
  async function cameras(dev) {
    const s = await session(dev); s.lastUse = Date.now();
    for (let i = 0; i < 50 && !s.cameraState; i++) await new Promise((r) => setTimeout(r, 200)); // arrives just after login
    if (!s.cameraState) throw new Error('Reolink SDK: the recorder did not report its cameras');
    // devName is often empty on NVRs: the camera name the Reolink app shows is the channel's OSD name
    for (const c of s.cameraState) {
      if (c.name || c.state === 2) continue;
      const ans = waitFor(s, CMD.GET_OSD, 8000, (e) => (e.channelId % 64 !== c.channel ? undefined : e.bcRspCode === 0 && e.pRspData && e.dataLen >= koffi.sizeof(Osd) ? koffi.decode(e.pRspData, Osd).byChannelName : ''));
      ans.catch(() => {});
      try { if (sdk.RemoteGetOsdCfg(s.handle, c.channel) === 0) c.name = String(await ans || '').trim(); } catch (_) {}
    }
    return s.cameraState;
  }

  const ops = { cameras, search, download, stopDownload: async (d, a) => stopDownload(d, a), logout: async (d) => drop(d.key), shutdown: () => { for (const k of [...sessions.keys()]) drop(k); try { sdk.Close(); } catch (_) {} } };
  if (!process.parentPort) return ops; // in-process use (tests / scratch harness)
  log = (...a) => process.parentPort.postMessage({ log: a.join(' ') }); // into the app's main.log
  process.parentPort.on('message', async ({ data }) => {
    const { id, op, dev, args } = data;
    if (op === 'shutdown') { ops.shutdown(); process.exit(0); }
    try { process.parentPort.postMessage({ id, ok: true, result: await ops[op](dev, args || {}) }); }
    catch (e) { process.parentPort.postMessage({ id, ok: false, error: e.message, authFailure: !!e.authFailure }); }
  });
}

// ---------------------------------------------------------------- proxy (main process)
let child = null, nextId = 1; const pending = new Map(); let log = () => {};
function call(op, dev, args) {
  if (!available()) return Promise.reject(new Error('Recordings over the Reolink UID need the Reolink desktop app installed on this PC (UniVMS uses its playback library).'));
  if (!child) {
    const { utilityProcess } = require('electron');
    child = utilityProcess.fork(__filename, [], { serviceName: 'Reolink SDK host', stdio: 'ignore', env: { ...process.env, UNIVMS_REOLINK_SDK_HOST: '1' } });
    child.on('message', (m) => { if (m.log) return log(m.log); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(Object.assign(new Error(m.error), { authFailure: m.authFailure })); });
    child.on('exit', (code) => { log('Reolink SDK host exited', code); child = null; for (const p of pending.values()) p.reject(new Error('Reolink SDK host stopped')); pending.clear(); });
  }
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); child.postMessage({ id, op, dev, args }); });
}
const shutdown = () => { if (child) { try { child.postMessage({ op: 'shutdown' }); } catch (_) {} child = null; } };

if (process.env.UNIVMS_REOLINK_SDK_HOST && process.parentPort) host();

let inproc = null;
module.exports = { available, call, shutdown, setLog: (fnLog) => { log = fnLog; }, inProcess: () => (inproc = inproc || host()) };
