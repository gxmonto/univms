'use strict';
/*
 * Persistent JSON store (devices, layouts, views, maps, groups, settings, users).
 * Device passwords are encrypted at rest with Electron safeStorage when available.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PlainBox, SecretError } = require('./secrets');

const DEFAULTS = {
  version: 1,
  devices: [],
  views: [],        // saved live-view layouts
  groups: [],       // camera groups { id, name, cameras: [cameraId] }
  maps: [],         // e-maps { id, name, image, hotspots: [{cameraId,x,y}] }
  users: [],        // app users { id, username, hash, salt, role }
  cameraAliases: {},// cameraId -> { name, hidden }
  settings: {
    snapshotDir: '',
    recordDir: '',
    ffmpegPath: '',
    ffprobePath: '',
    defaultStream: 'sub',
    rtspTransport: 'tcp',
    lowLatency: true,
    autoReconnect: true,
    alarmPopup: true,
    alarmSound: true,
    alarmTypes: ['VMD', 'linedetection', 'fielddetection', 'IO', 'videoloss', 'shelteralarm', 'cameraMotionEvent', 'cameraInputEvent', 'cameraDisconnectEvent'],
    requireLogin: false,
    autoLogin: false,
    minimizeToTray: false,
    startFullscreen: false,
    updates: { mode: 'ask', url: '', token: '', skippedVersion: '' },
    autoSwitchInterval: 10,
    hwDecode: true,
    eventRetention: 2000,
    language: 'en',
    theme: 'dark',
  },
};

class Store {
  /**
   * @param {string} file config path
   * @param {object|null} secrets SecretBox (see secrets.js); null = base64 fallback (unit tests)
   */
  constructor(file, secrets) {
    this.file = file;
    this.secrets = secrets && typeof secrets.encrypt === 'function' ? secrets : new PlainBox();
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this._saveTimer = null;
    this.load();
    this.migrateSecrets();
  }

  /** Re-encrypt passwords stored in an older format while they still decrypt; lost ones stay as they are and are
   *  reported through getDeviceWithSecret().secretLost so the user re-enters them. */
  migrateSecrets() {
    let changed = 0;
    this.lostSecrets = [];
    for (const d of this.data.devices) {
      if (!d.passwordEnc || this.secrets.isCurrent(d.passwordEnc)) continue;
      try { d.passwordEnc = this.secrets.encrypt(this.secrets.decrypt(d.passwordEnc)); changed++; }
      catch (e) { this.lostSecrets.push(d.id); }
    }
    if (changed) this.save();
    return { migrated: changed, lost: this.lostSecrets.length };
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...raw, settings: { ...DEFAULTS.settings, ...(raw.settings || {}) } };
      }
    } catch (e) {
      console.error('[store] failed to load, starting fresh:', e.message);
      try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (_) {}
    }
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this._saveTimer);
    let json;
    try { json = JSON.stringify(this.data, null, 2); }
    catch (e) { this.lastError = 'Configuration could not be serialized: ' + e.message; this.onError && this.onError(this.lastError); return false; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, json);
      try { fs.renameSync(tmp, this.file); }
      catch (e) {
        // Windows: rename can fail while another process (AV scanner, editor) holds the file; write directly instead
        fs.writeFileSync(this.file, json);
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
      this.lastError = null;
      this.lastFlush = Date.now();
      return true;
    } catch (e) {
      this.lastError = `Configuration could not be saved to ${this.file}: ${e.message}`;
      this.onError && this.onError(this.lastError);
      // retry shortly; keep the data in memory
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.flush(), 5000);
      return false;
    }
  }

  // ---- secrets ----
  encrypt(plain) { return this.secrets.encrypt(plain); }

  /** Returns '' when the value cannot be decrypted (see getDeviceWithSecret for the flag). */
  decrypt(stored) {
    try { return this.secrets.decrypt(stored); }
    catch (e) { return ''; }
  }

  // ---- devices ----
  listDevices() {
    return this.data.devices.map((d) => this.publicDevice(d));
  }
  publicDevice(d) {
    const { passwordEnc, streamKeyEnc, ...pub } = d;
    return { ...pub, hasPassword: !!passwordEnc, hasStreamKey: !!streamKeyEnc };
  }
  getDevice(id) {
    return this.data.devices.find((d) => d.id === id) || null;
  }
  getDeviceWithSecret(id) {
    const d = this.getDevice(id);
    if (!d) return null;
    const streamKey = this.decrypt(d.streamKeyEnc) || '';
    try { return { ...d, password: this.secrets.decrypt(d.passwordEnc), streamKey, secretLost: false }; }
    catch (e) {
      // never log in with an empty password instead (Hikvision counts it as a failed attempt and locks the account)
      return { ...d, password: '', streamKey, secretLost: true, secretError: e.message };
    }
  }
  upsertDevice(input) {
    const existing = input.id ? this.getDevice(input.id) : null;
    const dev = existing ? { ...existing } : { id: 'dev_' + crypto.randomBytes(6).toString('hex'), createdAt: Date.now() };
    const { password, streamKey, ...rest } = input;
    Object.assign(dev, rest);
    if (password !== undefined && password !== null && password !== '') dev.passwordEnc = this.encrypt(password);
    // stream encryption key (Hikvision verification code): '' / undefined keep, null removes
    if (streamKey === null) delete dev.streamKeyEnc;
    else if (streamKey !== undefined && streamKey !== '') dev.streamKeyEnc = this.encrypt(streamKey);
    dev.updatedAt = Date.now();
    if (existing) {
      const i = this.data.devices.findIndex((d) => d.id === dev.id);
      this.data.devices[i] = dev;
    } else {
      this.data.devices.push(dev);
    }
    this.save();
    return this.publicDevice(dev);
  }
  removeDevice(id) {
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    for (const g of this.data.groups) g.cameras = (g.cameras || []).filter((c) => !c.startsWith(id + ':'));
    for (const v of this.data.views) v.cells = (v.cells || []).map((c) => (c && c.cameraId && c.cameraId.startsWith(id + ':') ? null : c));
    for (const m of this.data.maps) m.hotspots = (m.hotspots || []).filter((h) => !h.cameraId.startsWith(id + ':'));
    this.save();
  }
  patchDevice(id, patch) {
    const d = this.getDevice(id);
    if (!d) return null;
    Object.assign(d, patch);
    this.save();
    return this.publicDevice(d);
  }

  // ---- generic collections ----
  list(coll) { return this.data[coll] || []; }
  upsert(coll, item) {
    const arr = this.data[coll] || (this.data[coll] = []);
    if (!item.id) item.id = coll.slice(0, 3) + '_' + crypto.randomBytes(5).toString('hex');
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = { ...arr[i], ...item }; else arr.push(item);
    this.save();
    return arr[i >= 0 ? i : arr.length - 1];
  }
  remove(coll, id) {
    this.data[coll] = (this.data[coll] || []).filter((x) => x.id !== id);
    this.save();
  }

  // ---- settings ----
  getSettings() { return { ...this.data.settings }; }
  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.getSettings();
  }

  // ---- app users ----
  hashPassword(password, salt) {
    salt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
  }
  verifyUser(username, password) {
    const u = this.data.users.find((x) => x.username.toLowerCase() === String(username).toLowerCase());
    if (!u) return null;
    const { hash } = this.hashPassword(password, u.salt);
    if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) {
      const { hash: _h, salt: _s, ...pub } = u;
      return pub;
    }
    return null;
  }

  // ---- export / import (devices + config) ----
  exportConfig(password) {
    const payload = {
      exportedAt: new Date().toISOString(),
      devices: this.data.devices.map((d) => ({ ...d, passwordEnc: undefined, streamKeyEnc: undefined, password: this.decrypt(d.passwordEnc), streamKey: this.decrypt(d.streamKeyEnc) || undefined })),
      views: this.data.views, groups: this.data.groups, maps: this.data.maps.map((m) => ({ ...m, image: undefined })),
      cameraAliases: this.data.cameraAliases, settings: this.data.settings,
    };
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    if (!password) return { format: 'univms-config', encrypted: false, data: payload };
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(json), cipher.final()]);
    return { format: 'univms-config', encrypted: true, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') };
  }
  importConfig(obj, password, { merge = true } = {}) {
    if (!obj || obj.format !== 'univms-config') throw new Error('Not a UniVMS configuration file');
    let payload = obj.data;
    if (obj.encrypted) {
      if (!password) throw new Error('This configuration file is encrypted; a password is required');
      const key = crypto.scryptSync(password, Buffer.from(obj.salt, 'base64'), 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(obj.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(obj.tag, 'base64'));
      try {
        payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(obj.data, 'base64')), decipher.final()]).toString('utf8'));
      } catch (e) { throw new Error('Wrong password or corrupted file'); }
    }
    if (!merge) { this.data.devices = []; this.data.views = []; this.data.groups = []; this.data.maps = []; }
    for (const d of payload.devices || []) {
      const { password: pw, streamKey: sk, ...rest } = d;
      const exists = this.getDevice(rest.id);
      if (exists) Object.assign(exists, rest, { passwordEnc: pw ? this.encrypt(pw) : exists.passwordEnc, streamKeyEnc: sk ? this.encrypt(sk) : exists.streamKeyEnc });
      else this.data.devices.push({ ...rest, passwordEnc: this.encrypt(pw || ''), ...(sk ? { streamKeyEnc: this.encrypt(sk) } : {}) });
    }
    for (const coll of ['views', 'groups', 'maps']) for (const it of payload[coll] || []) this.upsert(coll, it);
    this.data.cameraAliases = { ...this.data.cameraAliases, ...(payload.cameraAliases || {}) };
    if (payload.settings) this.data.settings = { ...this.data.settings, ...payload.settings };
    this.save();
    return { devices: (payload.devices || []).length, views: (payload.views || []).length };
  }
}

module.exports = { Store, DEFAULTS, SecretError };
