'use strict';
/*
 * Secrets at rest (device passwords).
 *
 * Why not Electron safeStorage alone: on Windows safeStorage encrypts with a per-profile AES key that Chromium keeps
 * in `userData/Local State`, written lazily. When the process is killed or crashes before that file is flushed,
 * the next start generates a NEW key and every stored password becomes undecryptable ("Error while decrypting the
 * ciphertext provided to safeStorage.decryptString") — the app then logged in with empty passwords and Hikvision
 * locked the accounts. So we keep our own random 256-bit key in `userData/univms.key`, written synchronously right
 * when it is created, and protect that key with Windows DPAPI (user scope, via koffi → crypt32) or, on other
 * platforms, with safeStorage; if neither is available the key file is stored as is (user profile permissions).
 *
 * Formats: 'aes:' + base64(iv12 | tag16 | ciphertext)  — current
 *          'enc:' + base64(safeStorage ciphertext)      — legacy, migrated when it still decrypts
 *          'b64:' + base64(plain)                       — legacy fallback
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SecretError extends Error {
  constructor(msg) { super(msg); this.secretLost = true; }
}

// ---- Windows DPAPI through koffi (already a dependency for the Hikvision SDK) ----
let dpapi = null;
function getDpapi() {
  if (dpapi !== null) return dpapi;
  dpapi = false;
  if (process.platform !== 'win32') return dpapi;
  try {
    const koffi = require('koffi');
    const crypt32 = koffi.load('crypt32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const DATA_BLOB = koffi.struct('UNIVMS_DATA_BLOB', { cbData: 'uint32', pbData: 'uint8_t *' });
    const Protect = crypt32.func('int CryptProtectData(UNIVMS_DATA_BLOB *pDataIn, const char16_t *szDataDescr, UNIVMS_DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ UNIVMS_DATA_BLOB *pDataOut)');
    const Unprotect = crypt32.func('int CryptUnprotectData(UNIVMS_DATA_BLOB *pDataIn, _Out_ void **ppszDataDescr, UNIVMS_DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ UNIVMS_DATA_BLOB *pDataOut)');
    const LocalFree = kernel32.func('void *LocalFree(void *h)');
    const CRYPTPROTECT_UI_FORBIDDEN = 1;
    const take = (out) => { const b = Buffer.from(koffi.decode(out.pbData, koffi.array('uint8', out.cbData, 'Typed'))); LocalFree(out.pbData); return b; };
    dpapi = {
      protect(buf) {
        const out = {};
        if (!Protect({ cbData: buf.length, pbData: buf }, 'UniVMS', null, null, null, CRYPTPROTECT_UI_FORBIDDEN, out)) throw new Error('CryptProtectData failed');
        return take(out);
      },
      unprotect(buf) {
        const out = {}; const desc = [null];
        if (!Unprotect({ cbData: buf.length, pbData: buf }, desc, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, out)) throw new Error('CryptUnprotectData failed');
        if (desc[0]) { try { LocalFree(desc[0]); } catch (_) {} }
        return take(out);
      },
    };
    void DATA_BLOB;
  } catch (_) { dpapi = false; }
  return dpapi;
}

class SecretBox {
  /**
   * @param {string} dir userData directory (key file lives here)
   * @param {{safeStorage?: object, log?: Function, dpapi?: boolean}} opts
   */
  constructor(dir, { safeStorage = null, log = () => {}, dpapi: useDpapi = true } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'univms.key');
    this.safeStorage = safeStorage;
    this.log = log;
    this.useDpapi = useDpapi;
    this.scheme = null;   // how the key file is protected: 'dpapi' | 'safeStorage' | 'plain'
    this.key = null;
    this.keyError = null;
    this._loadOrCreateKey();
  }

  _wrap(key) {
    if (this.useDpapi) {
      const d = getDpapi();
      if (d) { try { return { scheme: 'dpapi', key: d.protect(key).toString('base64') }; } catch (e) { this.log('secrets: DPAPI unavailable', e.message); } }
    }
    if (this.safeStorage) {
      try { if (this.safeStorage.isEncryptionAvailable()) return { scheme: 'safeStorage', key: this.safeStorage.encryptString(key.toString('base64')).toString('base64') }; } catch (_) {}
    }
    return { scheme: 'plain', key: key.toString('base64') };
  }
  _unwrap(rec) {
    const raw = Buffer.from(rec.key, 'base64');
    if (rec.scheme === 'dpapi') { const d = getDpapi(); if (!d) throw new Error('DPAPI not available on this platform'); return d.unprotect(raw); }
    if (rec.scheme === 'safeStorage') { if (!this.safeStorage) throw new Error('safeStorage not available'); return Buffer.from(this.safeStorage.decryptString(raw), 'base64'); }
    return raw;
  }
  _loadOrCreateKey() {
    try {
      if (fs.existsSync(this.file)) {
        const rec = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.key = this._unwrap(rec);
        this.scheme = rec.scheme;
        if (this.key.length !== 32) throw new Error('key file has the wrong length');
        return;
      }
    } catch (e) {
      // A key we cannot open any more (another Windows user / machine): keep it aside and start a new one; the
      // passwords encrypted with it are reported as lost so the user re-enters them.
      this.keyError = e.message;
      this.log('secrets: key file unreadable, creating a new key', e.message);
      try { fs.renameSync(this.file, this.file + '.lost-' + Date.now()); } catch (_) {}
    }
    const key = crypto.randomBytes(32);
    const rec = this._wrap(key);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    try { fs.renameSync(tmp, this.file); } catch (_) { fs.writeFileSync(this.file, JSON.stringify(rec), { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch (_) {} }
    this.key = key;
    this.scheme = rec.scheme;
    this.log('secrets: new key created, protected with', rec.scheme);
  }

  encrypt(plain) {
    if (plain === undefined || plain === null || plain === '') return '';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return 'aes:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  /** Throws SecretError (secretLost = true) when the stored value cannot be decrypted any more. */
  decrypt(stored) {
    if (!stored) return '';
    if (stored.startsWith('aes:')) {
      const raw = Buffer.from(stored.slice(4), 'base64');
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
      } catch (e) { throw new SecretError('the saved password was encrypted with a key this installation no longer has'); }
    }
    if (stored.startsWith('enc:')) {
      try { return this.safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')); }
      catch (e) { throw new SecretError('the saved password cannot be decrypted any more (the system encryption key changed)'); }
    }
    if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    return stored; // legacy plain text
  }

  isCurrent(stored) { return !stored || stored.startsWith('aes:'); }
}

module.exports = { SecretBox, SecretError, getDpapi };
