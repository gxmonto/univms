'use strict';
/*
 * Hikvision Device Network SDK (HCNetSDK) binding via koffi — the "server port 8000" path iVMS-4200 uses.
 *
 *  - login/logout, device info (channel ranges incl. digital talk channels)
 *  - ISAPI pass-through (NET_DVR_STDXMLConfig): the whole ISAPI driver works unchanged over port 8000
 *  - live stream (NET_DVR_RealPlay_V40 + standard PS data callback) and playback by time, both piped into ffmpeg
 *  - two-way audio (NET_DVR_StartVoiceCom_MR_V30, G.711 only), alarms (NET_DVR_SetupAlarmChan_V50), JPEG snapshots
 *
 * Libraries are looked up in resources/hiksdk (packaged) or vendor/hiksdk/<platform>-<arch> (dev); they are not in git.
 */
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

let koffi = null, lib = null, F = null, T = null, initialized = false, loadError = null;
const sessions = new Map(); // userId -> HikSdkSession (for the global alarm callback)
let alarmCb = null;

function sdkDir() {
  const name = `${process.platform}-${process.arch}`;
  const cands = [process.resourcesPath ? path.join(process.resourcesPath, 'hiksdk') : null, path.join(__dirname, '..', '..', 'vendor', 'hiksdk', name)].filter(Boolean);
  const main = process.platform === 'win32' ? 'HCNetSDK.dll' : 'libhcnetsdk.so';
  return cands.find((d) => fs.existsSync(path.join(d, main))) || null;
}
function available() { return !!sdkDir() && (process.platform === 'win32' || process.platform === 'linux') && process.arch === 'x64'; }

function ensureLoaded() {
  if (lib) return;
  if (loadError) throw loadError;
  try {
    const dir = sdkDir();
    if (!dir) throw new Error('Hikvision SDK libraries are not bundled with this build');
    koffi = require('koffi');
    const win = process.platform === 'win32';
    if (win) {
      process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
      try { koffi.load('kernel32.dll').func('int SetDllDirectoryW(const char16_t *p)')(dir); } catch (_) {}
    } else {
      // dependencies first with RTLD_GLOBAL so libhcnetsdk.so resolves them without LD_LIBRARY_PATH
      for (const dep of ['libcrypto.so.1.1', 'libssl.so.1.1', 'libz.so', 'libhpr.so', 'libHCCore.so']) {
        const p = path.join(dir, dep); if (fs.existsSync(p)) { try { koffi.load(p, { global: true }); } catch (_) {} }
      }
    }
    lib = koffi.load(path.join(dir, win ? 'HCNetSDK.dll' : 'libhcnetsdk.so'));
    defineTypes();
    // tell the SDK where HCNetSDKCom/ lives (must precede NET_DVR_Init)
    F.NET_DVR_SetSDKInitCfg(2, koffi.as({ sPath: dir, byRes: new Array(128).fill(0) }, 'NET_DVR_LOCAL_SDK_PATH *'));
    if (!win) {
      F.NET_DVR_SetSDKInitCfg(3, Buffer.from(path.join(dir, 'libcrypto.so.1.1') + '\0'));
      F.NET_DVR_SetSDKInitCfg(4, Buffer.from(path.join(dir, 'libssl.so.1.1') + '\0'));
    }
    if (!F.NET_DVR_Init()) throw new Error('NET_DVR_Init failed: ' + lastError());
    initialized = true;
    F.NET_DVR_SetConnectTime(6000, 1);
    F.NET_DVR_SetReconnect(10000, 1);
    alarmCb = koffi.register(onAlarm, koffi.pointer(T.MSGCallBack));
    F.NET_DVR_SetDVRMessageCallBack_V50(0, alarmCb, null);
  } catch (e) {
    loadError = e; lib = null;
    throw e;
  }
}

function defineTypes() {
  const S = (name, def) => koffi.struct(name, def);
  const bytes = (n) => koffi.array('uint8', n);
  const chars = (n) => koffi.array('char', n, 'String');
  T = {};
  T.NET_DVR_LOCAL_SDK_PATH = S('NET_DVR_LOCAL_SDK_PATH', { sPath: chars(256), byRes: bytes(128) });
  T.NET_DVR_DEVICEINFO_V30 = S('NET_DVR_DEVICEINFO_V30', {
    sSerialNumber: chars(48), byAlarmInPortNum: 'uint8', byAlarmOutPortNum: 'uint8', byDiskNum: 'uint8', byDVRType: 'uint8', byChanNum: 'uint8', byStartChan: 'uint8', byAudioChanNum: 'uint8', byIPChanNum: 'uint8', byZeroChanNum: 'uint8', byMainProto: 'uint8', bySubProto: 'uint8', bySupport: 'uint8', bySupport1: 'uint8', bySupport2: 'uint8', wDevType: 'uint16', bySupport3: 'uint8', byMultiStreamProto: 'uint8', byStartDChan: 'uint8', byStartDTalkChan: 'uint8', byHighDChanNum: 'uint8', bySupport4: 'uint8', byLanguageType: 'uint8', byVoiceInChanNum: 'uint8', byStartVoiceInChanNo: 'uint8', bySupport5: 'uint8', bySupport6: 'uint8', byMirrorChanNum: 'uint8', wStartMirrorChanNo: 'uint16', bySupport7: 'uint8', byRes2: 'uint8',
  });
  T.NET_DVR_DEVICEINFO_V40 = S('NET_DVR_DEVICEINFO_V40', {
    struDeviceV30: T.NET_DVR_DEVICEINFO_V30, bySupportLock: 'uint8', byRetryLoginTime: 'uint8', byPasswordLevel: 'uint8', byProxyType: 'uint8', dwSurplusLockTime: 'uint32', byCharEncodeType: 'uint8', bySupportDev5: 'uint8', bySupport: 'uint8', byLoginMode: 'uint8', dwOEMCode: 'uint32', iResidualValidity: 'int32', byResidualValidity: 'uint8', bySingleStartDTalkChan: 'uint8', bySingleDTalkChanNums: 'uint8', byPassWordResetLevel: 'uint8', bySupportStreamEncrypt: 'uint8', byMarketType: 'uint8', byRes2: bytes(238),
  });
  T.NET_DVR_USER_LOGIN_INFO = S('NET_DVR_USER_LOGIN_INFO', {
    sDeviceAddress: chars(129), byUseTransport: 'uint8', wPort: 'uint16', sUserName: chars(64), sPassword: chars(64), cbLoginResult: 'void *', pUser: 'void *', bUseAsynLogin: 'int32', byProxyType: 'uint8', byUseUTCTime: 'uint8', byLoginMode: 'uint8', byHttps: 'uint8', iProxyID: 'int32', byVerifyMode: 'uint8', byRes3: bytes(119),
  });
  T.NET_DVR_XML_CONFIG_INPUT = S('NET_DVR_XML_CONFIG_INPUT', { dwSize: 'uint32', lpRequestUrl: 'void *', dwRequestUrlLen: 'uint32', lpInBuffer: 'void *', dwInBufferSize: 'uint32', dwRecvTimeOut: 'uint32', byForceEncrpt: 'uint8', byNumOfMultiPart: 'uint8', byMIMEType: 'uint8', byRes: bytes(29) });
  T.NET_DVR_XML_CONFIG_OUTPUT = S('NET_DVR_XML_CONFIG_OUTPUT', { dwSize: 'uint32', lpOutBuffer: 'void *', dwOutBufferSize: 'uint32', dwReturnedXMLSize: 'uint32', lpStatusBuffer: 'void *', dwStatusSize: 'uint32', lpDataBuffer: 'void *', byNumOfMultiPart: 'uint8', byRes: bytes(23) });
  T.NET_DVR_PREVIEWINFO = S('NET_DVR_PREVIEWINFO', { lChannel: 'int32', dwStreamType: 'uint32', dwLinkMode: 'uint32', hPlayWnd: 'void *', bBlocked: 'uint32', bPassbackRecord: 'uint32', byPreviewMode: 'uint8', byStreamID: bytes(32), byProtoType: 'uint8', byRes1: 'uint8', byVideoCodingType: 'uint8', dwDisplayBufNum: 'uint32', byNPQMode: 'uint8', byRecvMetaData: 'uint8', byDataType: 'uint8', byRes: bytes(213) });
  T.NET_DVR_TIME = S('NET_DVR_TIME', { dwYear: 'uint32', dwMonth: 'uint32', dwDay: 'uint32', dwHour: 'uint32', dwMinute: 'uint32', dwSecond: 'uint32' });
  T.NET_DVR_STREAM_INFO = S('NET_DVR_STREAM_INFO', { dwSize: 'uint32', byID: bytes(32), dwChannel: 'uint32', byRes: bytes(32) });
  T.NET_DVR_VOD_PARA = S('NET_DVR_VOD_PARA', { dwSize: 'uint32', struIDInfo: T.NET_DVR_STREAM_INFO, struBeginTime: T.NET_DVR_TIME, struEndTime: T.NET_DVR_TIME, hWnd: 'void *', byDrawFrame: 'uint8', byVolumeType: 'uint8', byVolumeNum: 'uint8', byStreamType: 'uint8', dwFileIndex: 'uint32', byAudioFile: 'uint8', byCourseFile: 'uint8', byDownload: 'uint8', byOptimalStreamType: 'uint8', byUseAsyn: 'uint8', byRes2: bytes(19) });
  T.NET_DVR_JPEGPARA = S('NET_DVR_JPEGPARA', { wPicSize: 'uint16', wPicQuality: 'uint16' });
  T.NET_DVR_COMPRESSION_AUDIO = S('NET_DVR_COMPRESSION_AUDIO', { byAudioEncType: 'uint8', byAudioSamplingRate: 'uint8', byAudioBitRate: 'uint8', byres: bytes(4), bySupport: 'uint8' });
  T.NET_DVR_SETUPALARM_PARAM_V50 = S('NET_DVR_SETUPALARM_PARAM_V50', { dwSize: 'uint32', byLevel: 'uint8', byAlarmInfoType: 'uint8', byRetAlarmTypeV40: 'uint8', byRetDevInfoVersion: 'uint8', byRetVQDAlarmType: 'uint8', byFaceAlarmDetection: 'uint8', bySupport: 'uint8', byBrokenNetHttp: 'uint8', wTaskNo: 'uint16', byDeployType: 'uint8', bySubScription: 'uint8', byBrokenNetHttpV60: 'uint8', byRes1: 'uint8', byAlarmTypeURL: 'uint8', byCustomCtrl: 'uint8', byRes4: bytes(128) });
  T.NET_DVR_ALARMER = S('NET_DVR_ALARMER', { byUserIDValid: 'uint8', bySerialValid: 'uint8', byVersionValid: 'uint8', byDeviceNameValid: 'uint8', byMacAddrValid: 'uint8', byLinkPortValid: 'uint8', byDeviceIPValid: 'uint8', bySocketIPValid: 'uint8', lUserID: 'int32', sSerialNumber: chars(48), dwDeviceVersion: 'uint32', sDeviceName: chars(32), byMacAddr: bytes(6), wLinkPort: 'uint16', sDeviceIP: chars(128), sSocketIP: chars(128), byIpProtocol: 'uint8', byRes1: bytes(2), bJSONBroken: 'uint8', wSocketPort: 'uint16', byRes2: bytes(6) });
  T.NET_DVR_ALARMINFO_V30 = S('NET_DVR_ALARMINFO_V30', { dwAlarmType: 'uint32', dwAlarmInputNumber: 'uint32', byAlarmOutputNumber: bytes(96), byAlarmRelateChannel: bytes(64), byChannel: bytes(64), byDiskNumber: bytes(33) });
  T.MSGCallBack = koffi.proto('void MSGCallBack(int32_t lCommand, NET_DVR_ALARMER *pAlarmer, void *pAlarmInfo, uint32_t dwBufLen, void *pUser)');
  T.RealDataCb = koffi.proto('void RealDataCb(int32_t h, uint32_t dwDataType, void *pBuffer, uint32_t dwBufSize, void *pUser)');
  T.StdDataCb = koffi.proto('void StdDataCb(int32_t h, uint32_t dwDataType, void *pBuffer, uint32_t dwBufSize, uint32_t dwUser)');
  T.VoiceDataCb = koffi.proto('void VoiceDataCb(int32_t h, void *pRecvDataBuffer, uint32_t dwBufSize, uint8_t byAudioFlag, void *pUser)');

  F = {};
  const fn = (sig) => { const name = /\s\*?(\w+)\(/.exec(sig)[1]; F[name] = lib.func(sig); };
  fn('int NET_DVR_Init()');
  fn('int NET_DVR_Cleanup()');
  fn('int NET_DVR_SetSDKInitCfg(int enumType, void *lpInBuff)');
  fn('int NET_DVR_SetConnectTime(uint32_t dwWaitTime, uint32_t dwTryTimes)');
  fn('int NET_DVR_SetReconnect(uint32_t dwInterval, int bEnableRecon)');
  fn('int NET_DVR_SetLogToFile(uint32_t nLogLevel, const char *strLogDir, int bAutoDel)');
  fn('int32_t NET_DVR_Login_V40(NET_DVR_USER_LOGIN_INFO *pLoginInfo, _Out_ NET_DVR_DEVICEINFO_V40 *lpDeviceInfo)');
  fn('int NET_DVR_Logout(int32_t lUserID)');
  fn('uint32_t NET_DVR_GetLastError()');
  fn('const char *NET_DVR_GetErrorMsg(_Inout_ int32_t *pErrorNo)');
  fn('int NET_DVR_STDXMLConfig(int32_t lUserID, NET_DVR_XML_CONFIG_INPUT *lpInputParam, NET_DVR_XML_CONFIG_OUTPUT *lpOutputParam)');
  fn('int NET_DVR_SetSDKSecretKey(int32_t lUserID, const uint8_t *sSecretKey)');
  fn('int NET_DVR_GetDVRConfig(int32_t lUserID, uint32_t dwCommand, int32_t lChannel, _Out_ uint8_t *lpOutBuffer, uint32_t dwOutBufferSize, _Out_ uint32_t *lpBytesReturned)');
  fn('int NET_DVR_CaptureJPEGPicture_NEW(int32_t lUserID, int32_t lChannel, NET_DVR_JPEGPARA *lpJpegPara, _Out_ uint8_t *sJpegPicBuffer, uint32_t dwPicSize, _Out_ uint32_t *lpSizeReturned)');
  fn('int32_t NET_DVR_RealPlay_V40(int32_t lUserID, NET_DVR_PREVIEWINFO *lpPreviewInfo, RealDataCb *cb, void *pUser)');
  fn('int NET_DVR_SetStandardDataCallBack(int32_t lRealHandle, StdDataCb *cb, uint32_t dwUser)');
  fn('int NET_DVR_StopRealPlay(int32_t lRealHandle)');
  fn('int32_t NET_DVR_PlayBackByTime_V40(int32_t lUserID, NET_DVR_VOD_PARA *pVodPara)');
  fn('int NET_DVR_SetPlayDataCallBack_V40(int32_t lPlayHandle, RealDataCb *cb, void *pUser)');
  fn('int NET_DVR_PlayBackControl_V40(int32_t lPlayHandle, uint32_t dwControlCode, void *lpInBuffer, uint32_t dwInLen, void *lpOutBuffer, _Out_ uint32_t *lpOutLen)');
  fn('int NET_DVR_StopPlayBack(int32_t lPlayHandle)');
  fn('int32_t NET_DVR_StartVoiceCom_MR_V30(int32_t lUserID, uint32_t dwVoiceChan, VoiceDataCb *cb, void *pUser)');
  fn('int NET_DVR_VoiceComSendData(int32_t lVoiceComHandle, void *pSendBuf, uint32_t dwBufSize)');
  fn('int NET_DVR_StopVoiceCom(int32_t lVoiceComHandle)');
  fn('int NET_DVR_GetCurrentAudioCompress(int32_t lUserID, _Out_ NET_DVR_COMPRESSION_AUDIO *lpCompressAudio)');
  fn('int NET_DVR_PTZControlWithSpeed_Other(int32_t lUserID, int32_t lChannel, uint32_t dwPTZCommand, uint32_t dwStop, uint32_t dwSpeed)');
  fn('int NET_DVR_SetDVRMessageCallBack_V50(int iIndex, MSGCallBack *cb, void *pUser)');
  fn('int32_t NET_DVR_SetupAlarmChan_V50(int32_t iUserID, NET_DVR_SETUPALARM_PARAM_V50 *lpSetupParam, void *pSub, uint32_t dwSubSize)');
  fn('int NET_DVR_CloseAlarmChan_V30(int32_t lAlarmHandle)');
}

const ERRORS = { 1: 'Username or password incorrect', 2: 'No permission', 3: 'SDK not initialized', 4: 'Channel number error', 5: 'Too many connections to the device', 6: 'Version mismatch', 7: 'Could not connect to the device (server port closed or wrong port)', 8: 'Failed to send data to the device', 9: 'Failed to receive data from the device', 10: 'Receive timeout', 11: 'Data error', 12: 'Device busy / order error', 13: 'Device returned an error', 17: 'Parameter error', 23: 'Device does not support this operation', 29: 'Device operation failed', 41: 'Device not found', 43: 'Buffer too small', 47: 'Device locked (too many failed logins)', 153: 'User account locked', 250: 'Device does not support the ISAPI pass-through for this command' };
function lastError() {
  const code = F.NET_DVR_GetLastError();
  let msg = ERRORS[code];
  if (!msg) { try { msg = F.NET_DVR_GetErrorMsg([code]); } catch (_) {} }
  return `${msg || 'SDK error'} (code ${code})`;
}

class SdkError extends Error { constructor(msg, code) { super(msg); this.sdkCode = code; this.authFailure = [1, 2, 47, 153].includes(Number(code)); } }

/** Plain TCP connect test so we never send credentials to a closed/wrong port (every rejected login counts towards the device lock). */
function tcpReachable(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.connect({ host, port });
    const done = (ok) => { try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** One logged-in SDK connection per device record (shared by all consumers). */
class HikSdkSession extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.userId = -1;
    this.info = null;
    this.alarmHandle = -1;
    this.alarmListeners = new Set();
    this.loginPromise = null;
  }
  static get(cfg) {
    const key = cfg.id;
    let s = HikSdkSession.pool.get(key);
    if (!s || s.cfg.host !== cfg.host || s.cfg.port !== cfg.port || s.cfg.username !== cfg.username || s.cfg.password !== cfg.password) {
      if (s) s.logout();
      s = new HikSdkSession(cfg); HikSdkSession.pool.set(key, s);
    }
    return s;
  }

  async login() {
    if (this.userId >= 0) return this.info;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      ensureLoaded();
      const port = Number(this.cfg.port) || 8000;
      if (!(await tcpReachable(this.cfg.host, port))) throw new SdkError(`Server port ${port} on ${this.cfg.host} is not reachable. The SDK needs the device's server port (8000 by default); if only the HTTP port is forwarded, use the HTTP/ISAPI connection instead.`, 7);
      const login = { sDeviceAddress: this.cfg.host, byUseTransport: 0, wPort: Number(this.cfg.port) || 8000, sUserName: this.cfg.username || 'admin', sPassword: this.cfg.password || '', cbLoginResult: null, pUser: null, bUseAsynLogin: 0, byProxyType: 0, byUseUTCTime: 0, byLoginMode: 0, byHttps: 0, iProxyID: 0, byVerifyMode: 0, byRes3: new Array(119).fill(0) };
      const out = {};
      // koffi calls are synchronous; run in the event loop as-is (login takes up to the connect timeout)
      const id = F.NET_DVR_Login_V40(login, out);
      if (id < 0) throw new SdkError('SDK login failed: ' + lastError(), F.NET_DVR_GetLastError());
      this.userId = id;
      const v30 = out.struDeviceV30 || {};
      this.info = {
        serial: String(v30.sSerialNumber || '').replace(/\0.*$/, ''), deviceType: Number(v30.wDevType), analogChannels: v30.byChanNum, startChan: v30.byStartChan || 1,
        ipChannels: (v30.byIPChanNum || 0) + 256 * (v30.byHighDChanNum || 0), startDChan: v30.byStartDChan || 33, startDTalkChan: v30.byStartDTalkChan || 0,
        audioChannels: v30.byAudioChanNum, voiceInChannels: v30.byVoiceInChanNum, startVoiceInChan: v30.byStartVoiceInChanNo, alarmIn: v30.byAlarmInPortNum, alarmOut: v30.byAlarmOutPortNum, disks: v30.byDiskNum,
        loginMode: out.byLoginMode, passwordLevel: out.byPasswordLevel,
      };
      sessions.set(this.userId, this);
      return this.info;
    })().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  logout() {
    if (this.alarmHandle >= 0) { try { F.NET_DVR_CloseAlarmChan_V30(this.alarmHandle); } catch (_) {} this.alarmHandle = -1; }
    if (this.userId >= 0) { try { F.NET_DVR_Logout(this.userId); } catch (_) {} sessions.delete(this.userId); this.userId = -1; }
    HikSdkSession.pool.delete(this.cfg.id);
  }

  /** ISAPI channel numbers (1..N for IP, 1..M analog) -> SDK channel numbers. */
  sdkChannel(channel, kind) {
    const ch = Number(channel) || 1;
    if (!this.info) return ch;
    if (kind === 'ip' || (this.info.analogChannels === 0 && this.info.ipChannels > 0)) return this.info.startDChan + ch - 1;
    return ch;
  }
  /** iVMS voice channel for a camera: digital talk channels start at byStartDTalkChan. */
  voiceChannel(channel, kind) {
    const ch = Number(channel) || 1;
    if (!this.info) return ch + 1;
    if (kind === 'ip' || (this.info.analogChannels === 0 && this.info.ipChannels > 0)) {
      if (this.info.startDTalkChan > 0) return this.info.startDTalkChan + ch - 1;
      return ch + 1;
    }
    return ch;
  }

  /** ISAPI over the SDK connection. Returns { status, text, buffer }. */
  async isapi(method, url, body) {
    await this.login();
    const req = Buffer.from(`${method.toUpperCase()} ${url}\0`, 'utf8');
    const inBuf = body ? Buffer.from(String(body), 'utf8') : null;
    const outBuf = Buffer.alloc(4 * 1024 * 1024);
    const statusBuf = Buffer.alloc(16 * 1024);
    const input = { dwSize: koffi.sizeof(T.NET_DVR_XML_CONFIG_INPUT), lpRequestUrl: req, dwRequestUrlLen: req.length - 1, lpInBuffer: inBuf, dwInBufferSize: inBuf ? inBuf.length : 0, dwRecvTimeOut: 15000, byForceEncrpt: 0, byNumOfMultiPart: 0, byMIMEType: 0, byRes: new Array(29).fill(0) };
    const output = { dwSize: koffi.sizeof(T.NET_DVR_XML_CONFIG_OUTPUT), lpOutBuffer: outBuf, dwOutBufferSize: outBuf.length, dwReturnedXMLSize: 0, lpStatusBuffer: statusBuf, dwStatusSize: statusBuf.length, lpDataBuffer: null, byNumOfMultiPart: 0, byRes: new Array(23).fill(0) };
    const ok = F.NET_DVR_STDXMLConfig(this.userId, input, output);
    const outLen = outBuf.indexOf(0) >= 0 ? outBuf.indexOf(0) : outBuf.length;
    const text = outBuf.subarray(0, outLen).toString('utf8');
    if (ok) return { status: 200, text, buffer: outBuf.subarray(0, outLen) };
    const code = F.NET_DVR_GetLastError();
    const statusLen = statusBuf.indexOf(0) >= 0 ? statusBuf.indexOf(0) : statusBuf.length;
    const statusXml = statusBuf.subarray(0, statusLen).toString('utf8');
    const m = /<statusCode>(\d+)<\/statusCode>[\s\S]*?<statusString>([^<]*)<\/statusString>/.exec(statusXml) || [];
    const http = m[1] === '4' ? 404 : m[1] === '6' ? 400 : m[1] === '7' ? 500 : code === 2 ? 401 : code === 7 || code === 10 ? 504 : 500;
    return { status: http, text: statusXml || text, buffer: Buffer.alloc(0), error: `${m[2] || lastError()}` };
  }

  async snapshot(channel, kind) {
    await this.login();
    const buf = Buffer.alloc(6 * 1024 * 1024);
    const ret = [0];
    const ok = F.NET_DVR_CaptureJPEGPicture_NEW(this.userId, this.sdkChannel(channel, kind), { wPicSize: 0xff, wPicQuality: 0 }, buf, buf.length, ret);
    if (!ok) throw new SdkError('Snapshot failed: ' + lastError());
    return Buffer.from(buf.subarray(0, ret[0]));
  }

  /** Stream encryption key stored on the device (NET_DVR_GET_AES_KEY = 6113); null when not available or all zero. */
  async deviceStreamKey() {
    if (this._aesKey !== undefined) return this._aesKey;
    await this.login();
    const buf = Buffer.alloc(80), ret = [0];
    let key = null;
    try { if (F.NET_DVR_GetDVRConfig(this.userId, 6113, -1, buf, buf.length, ret)) { const k = buf.subarray(0, 16); if (k.some((b) => b !== 0)) key = Buffer.from(k); } } catch (_) {}
    this._aesKey = key;
    return key;
  }
  /** Hand the stream key to the SDK (NET_DVR_SetSDKSecretKey, "set before live view"). The PS data we receive may still be
   *  encrypted — hikstream.js decrypts it — but the SDK's own paths (snapshots, playback) use it. */
  async setStreamKey(key) {
    if (!key) { this.streamKey = null; return false; }
    this.streamKey = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(String(key), 'utf8');
    await this.login();
    return this.applyStreamKey();
  }
  applyStreamKey() {
    if (!this.streamKey || this.userId < 0) return false;
    const k = Buffer.alloc(17); this.streamKey.copy(k, 0, 0, 16);
    try { return !!F.NET_DVR_SetSDKSecretKey(this.userId, k); } catch (_) { return false; }
  }

  /** Live stream: standard PS data delivered to onData(Buffer). Returns { stop }. */
  async startLive(channel, kind, stream, onData) {
    await this.login();
    this.applyStreamKey();
    const preview = { lChannel: this.sdkChannel(channel, kind), dwStreamType: stream === 'main' ? 0 : stream === 'third' ? 2 : 1, dwLinkMode: 0, hPlayWnd: null, bBlocked: 0, bPassbackRecord: 0, byPreviewMode: 0, byStreamID: new Array(32).fill(0), byProtoType: 0, byRes1: 0, byVideoCodingType: 0, dwDisplayBufNum: 1, byNPQMode: 0, byRecvMetaData: 0, byDataType: 0, byRes: new Array(213).fill(0) };
    let stopped = false;
    // The RealPlay callback delivers Hikvision's private PS stream: type 1 = 40-byte system header ("IMKH"), type 2 = PS packs
    // (0x000001BA…) that ffmpeg's mpeg demuxer reads. (NET_DVR_SetStandardDataCallBack would give RTP-wrapped ES instead.)
    const cb = koffi.register((h, type, ptr, len) => { if (!stopped && type === 2 && len > 0 && ptr) onData(Buffer.from(koffi.decode(ptr, koffi.array('uint8', len, 'Typed')))); }, koffi.pointer(T.RealDataCb));
    const handle = F.NET_DVR_RealPlay_V40(this.userId, preview, cb, null);
    if (handle < 0) { koffi.unregister(cb); throw new SdkError('Live stream failed: ' + lastError()); }
    return { stop: () => { if (stopped) return; stopped = true; try { F.NET_DVR_StopRealPlay(handle); } catch (_) {} setTimeout(() => { try { koffi.unregister(cb); } catch (_) {} }, 1000); } };
  }

  /** Playback by time (device local time). PS data to onData. */
  async startPlayback(channel, kind, startMs, endMs, onData) {
    await this.login();
    const t = (ms) => { const d = new Date(ms); return { dwYear: d.getFullYear(), dwMonth: d.getMonth() + 1, dwDay: d.getDate(), dwHour: d.getHours(), dwMinute: d.getMinutes(), dwSecond: d.getSeconds() }; };
    const vod = { dwSize: koffi.sizeof(T.NET_DVR_VOD_PARA), struIDInfo: { dwSize: koffi.sizeof(T.NET_DVR_STREAM_INFO), byID: new Array(32).fill(0), dwChannel: this.sdkChannel(channel, kind), byRes: new Array(32).fill(0) }, struBeginTime: t(startMs), struEndTime: t(endMs || startMs + 3600 * 1000 * 24), hWnd: null, byDrawFrame: 0, byVolumeType: 0, byVolumeNum: 0, byStreamType: 0, dwFileIndex: 0, byAudioFile: 0, byCourseFile: 0, byDownload: 0, byOptimalStreamType: 0, byUseAsyn: 0, byRes2: new Array(19).fill(0) };
    let stopped = false;
    const cb = koffi.register((h, type, ptr, len) => { if (!stopped && type === 2 && len > 0 && ptr) onData(Buffer.from(koffi.decode(ptr, koffi.array('uint8', len, 'Typed')))); }, koffi.pointer(T.RealDataCb));
    const handle = F.NET_DVR_PlayBackByTime_V40(this.userId, vod);
    if (handle < 0) { koffi.unregister(cb); throw new SdkError('Playback failed: ' + lastError()); }
    F.NET_DVR_SetPlayDataCallBack_V40(handle, cb, null);
    if (!F.NET_DVR_PlayBackControl_V40(handle, 1, null, 0, null, null)) { F.NET_DVR_StopPlayBack(handle); koffi.unregister(cb); throw new SdkError('Playback start failed: ' + lastError()); }
    return { stop: () => { if (stopped) return; stopped = true; try { F.NET_DVR_StopPlayBack(handle); } catch (_) {} setTimeout(() => { try { koffi.unregister(cb); } catch (_) {} }, 1000); } };
  }

  /** Two-way audio through the SDK (G.711 only). */
  async startVoice(voiceChannel, onData) {
    await this.login();
    const comp = {};
    let codec = 'ulaw', rate = 8000;
    if (F.NET_DVR_GetCurrentAudioCompress(this.userId, comp)) {
      const t = Number(comp.byAudioEncType);
      if (t === 1) codec = 'ulaw'; else if (t === 2) codec = 'alaw'; else throw new SdkError(`Device two-way audio codec is ${['G.722.1', 'G.711u', 'G.711a', '?', '?', 'MP2L2', 'G.726', 'AAC', 'PCM'][t] || t}; only G.711 is supported — set the device's audio encoding to G.711 µ-law or A-law`);
      rate = { 1: 16000, 2: 32000, 3: 48000, 4: 44100, 5: 8000 }[Number(comp.byAudioSamplingRate)] || 8000;
    }
    let stopped = false;
    // MR ("manual render") mode: the SDK decodes device audio to PCM16 mono for us; what we send must be encoded G.711 in 160-byte frames.
    const cb = koffi.register((h, ptr, len, flag) => { if (!stopped && len > 0 && ptr) onData(Buffer.from(koffi.decode(ptr, koffi.array('uint8', len, 'Typed')))); }, koffi.pointer(T.VoiceDataCb));
    const handle = F.NET_DVR_StartVoiceCom_MR_V30(this.userId, voiceChannel, cb, null);
    if (handle < 0) { koffi.unregister(cb); throw new SdkError('Two-way audio failed: ' + lastError()); }
    let pending = Buffer.alloc(0);
    const FRAME = 160;
    return {
      codec, sampleRate: rate, channelId: voiceChannel, rxCodec: 'pcm16', rxSampleRate: rate, txFrameBytes: FRAME,
      send: (chunk) => {
        if (stopped) return false;
        pending = Buffer.concat([pending, Buffer.from(chunk.buffer ? chunk.buffer : chunk, chunk.byteOffset || 0, chunk.byteLength || chunk.length)]);
        let ok = true;
        while (pending.length >= FRAME) { const frame = pending.subarray(0, FRAME); pending = pending.subarray(FRAME); if (!F.NET_DVR_VoiceComSendData(handle, Buffer.from(frame), FRAME)) ok = false; }
        return ok;
      },
      stop: () => { if (stopped) return; stopped = true; try { F.NET_DVR_StopVoiceCom(handle); } catch (_) {} setTimeout(() => { try { koffi.unregister(cb); } catch (_) {} }, 1000); },
    };
  }

  /** Alarm subscription; onEvent({type,state,channel,time,description}). Returns { close }. */
  async subscribeAlarms(onEvent) {
    await this.login();
    this.alarmListeners.add(onEvent);
    if (this.alarmHandle < 0) {
      const param = { dwSize: koffi.sizeof(T.NET_DVR_SETUPALARM_PARAM_V50), byLevel: 1, byAlarmInfoType: 1, byRetAlarmTypeV40: 0, byRetDevInfoVersion: 0, byRetVQDAlarmType: 0, byFaceAlarmDetection: 1, bySupport: 0, byBrokenNetHttp: 0, wTaskNo: 0, byDeployType: 0, bySubScription: 0, byBrokenNetHttpV60: 0, byRes1: 0, byAlarmTypeURL: 0, byCustomCtrl: 0, byRes4: new Array(128).fill(0) };
      const h = F.NET_DVR_SetupAlarmChan_V50(this.userId, param, null, 0);
      if (h < 0) { this.alarmListeners.delete(onEvent); throw new SdkError('Alarm subscription failed: ' + lastError()); }
      this.alarmHandle = h;
    }
    return { close: () => { this.alarmListeners.delete(onEvent); if (!this.alarmListeners.size && this.alarmHandle >= 0) { try { F.NET_DVR_CloseAlarmChan_V30(this.alarmHandle); } catch (_) {} this.alarmHandle = -1; } } };
  }

  dispatchAlarm(ev) { for (const l of this.alarmListeners) { try { l(ev); } catch (_) {} } }
}
HikSdkSession.pool = new Map();

const ALARM_TYPES = { 0: ['IO', 'Alarm input'], 1: ['diskfull', 'HDD full'], 2: ['videoloss', 'Video loss'], 3: ['VMD', 'Motion detection'], 4: ['diskerror', 'HDD unformatted'], 5: ['diskerror', 'HDD error'], 6: ['shelteralarm', 'Video tampering'], 7: ['videoexception', 'Video standard mismatch'], 8: ['illaccess', 'Illegal access'], 9: ['videoexception', 'Video exception'], 10: ['recordexception', 'Record exception'], 11: ['scenechangedetection', 'Scene change'], 12: ['diskerror', 'RAID exception'], 15: ['VCA', 'Smart event'], 16: ['poe', 'PoE power exception'], 19: ['audioexception', 'Audio input lost'] };
function onAlarm(lCommand, alarmer, infoPtr, len) {
  try {
    const session = alarmer && sessions.get(Number(alarmer.lUserID));
    if (!session) return;
    const time = Date.now();
    if (lCommand === 0x4000 && len >= 8) { // COMM_ALARM_V30
      const info = koffi.decode(infoPtr, T.NET_DVR_ALARMINFO_V30);
      const [type, desc] = ALARM_TYPES[info.dwAlarmType] || ['alarm', `Alarm type ${info.dwAlarmType}`];
      const channels = [];
      const arr = info.dwAlarmType === 0 ? info.byAlarmRelateChannel : info.byChannel;
      for (let i = 0; i < arr.length; i++) if (arr[i]) channels.push(i + 1);
      if (!channels.length) channels.push(null);
      for (const ch of channels) session.dispatchAlarm({ type, state: 'active', channel: ch !== null ? session.isapiChannel(ch) : null, time, description: desc + (info.dwAlarmType === 0 ? ` (input ${info.dwAlarmInputNumber + 1})` : ''), raw: { command: lCommand, alarmType: info.dwAlarmType } });
    } else if (lCommand === 0x1102) { // COMM_ALARM_RULE (VCA: line crossing / intrusion / ...)
      const u8 = koffi.decode(infoPtr, koffi.array('uint8', Math.min(len, 64), 'Typed'));
      const eventType = u8.length >= 56 ? new DataView(u8.buffer, u8.byteOffset).getUint32(52, true) : 0;
      const names = { 1: ['linedetection', 'Line crossing'], 2: ['regionEntrance', 'Region entrance'], 3: ['regionExiting', 'Region exiting'], 4: ['fielddetection', 'Intrusion'], 5: ['loitering', 'Loitering'], 6: ['parking', 'Parking'], 7: ['running', 'Fast moving'], 8: ['attendedBaggage', 'Object left'], 9: ['unattendedBaggage', 'Object removed'] };
      const [type, desc] = names[eventType] || ['VCA', `Smart event ${eventType}`];
      session.dispatchAlarm({ type, state: 'active', channel: null, time, description: desc, raw: { command: lCommand, eventType } });
    } else {
      session.dispatchAlarm({ type: 'alarm', state: 'active', channel: null, time, description: `Device alarm (command 0x${lCommand.toString(16)})`, raw: { command: lCommand } });
    }
  } catch (e) { /* never throw into the SDK thread */ }
}
HikSdkSession.prototype.isapiChannel = function (sdkCh) {
  if (!this.info) return sdkCh;
  if (sdkCh >= this.info.startDChan && this.info.ipChannels > 0) return sdkCh - this.info.startDChan + 1;
  return sdkCh;
};

function status() {
  const dir = sdkDir();
  return { available: available(), dir, loaded: !!lib, initialized, error: loadError ? loadError.message : null, platform: `${process.platform}-${process.arch}` };
}
function shutdown() {
  for (const s of [...HikSdkSession.pool.values()]) s.logout();
  if (initialized) { try { F.NET_DVR_Cleanup(); } catch (_) {} initialized = false; }
}

module.exports = { HikSdkSession, SdkError, available, ensureLoaded, status, shutdown, sdkDir, tcpReachable, _types: () => T };
