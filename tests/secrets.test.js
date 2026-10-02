'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretBox, SecretError, getDpapi } = require('../src/main/secrets');
const { Store } = require('../src/main/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'univms-test-'));

// A safeStorage stand-in whose key can be "lost" like Chromium's Local State key
function fakeSafeStorage(key = 'k1') {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(key + '|' + s, 'utf8'),
    decryptString: (b) => { const t = b.toString('utf8'); if (!t.startsWith(key + '|')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); return t.slice(key.length + 1); },
  };
}

test('key survives restarts and passwords round-trip', () => {
  const dir = tmpDir();
  const a = new SecretBox(dir, { safeStorage: null });
  assert.ok(fs.existsSync(path.join(dir, 'univms.key')));
  assert.ok(['dpapi', 'plain'].includes(a.scheme));
  if (process.platform === 'win32') { assert.ok(getDpapi(), 'DPAPI available through koffi'); assert.strictEqual(a.scheme, 'dpapi'); }
  const stored = a.encrypt('Sightwatch#1');
  assert.ok(stored.startsWith('aes:') && !stored.includes('Sightwatch'));
  const b = new SecretBox(dir, { safeStorage: null });
  assert.strictEqual(b.decrypt(stored), 'Sightwatch#1');
  assert.strictEqual(b.encrypt(''), '');
  assert.strictEqual(b.decrypt(''), '');
  // the key file itself never holds the raw key when DPAPI protects it
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'univms.key'), 'utf8'));
  if (rec.scheme === 'dpapi') assert.notStrictEqual(Buffer.from(rec.key, 'base64').toString('base64'), a.key.toString('base64'));
});

test('legacy safeStorage values migrate while they decrypt, and are reported lost when they do not', () => {
  const dir = tmpDir();
  const ss = fakeSafeStorage('k1');
  const file = path.join(dir, 'cfg.json');
  // config written by the old code: 'enc:' values
  fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [
    { id: 'dev_ok', name: 'NVR', host: '10.0.0.1', port: 80, username: 'admin', passwordEnc: 'enc:' + ss.encryptString('pw-ok').toString('base64') },
    { id: 'dev_lost', name: 'Old', host: '10.0.0.2', port: 80, username: 'admin', passwordEnc: 'enc:' + fakeSafeStorage('k0').encryptString('pw-lost').toString('base64') },
  ] }));
  const s = new Store(file, new SecretBox(dir, { safeStorage: ss }));
  assert.deepStrictEqual(s.lostSecrets, ['dev_lost']);
  assert.ok(s.getDevice('dev_ok').passwordEnc.startsWith('aes:'), 'migrated to the new format');
  assert.strictEqual(s.getDeviceWithSecret('dev_ok').password, 'pw-ok');
  const lost = s.getDeviceWithSecret('dev_lost');
  assert.strictEqual(lost.secretLost, true);
  assert.strictEqual(lost.password, '');
  assert.ok(s.getDevice('dev_lost').passwordEnc.startsWith('enc:'), 'lost value left untouched');
  // re-entering the password clears the problem
  s.upsertDevice({ id: 'dev_lost', password: 'new-pw' });
  assert.strictEqual(s.getDeviceWithSecret('dev_lost').secretLost, false);
  assert.strictEqual(s.getDeviceWithSecret('dev_lost').password, 'new-pw');
  s.flush();
  // ... and a restart with a changed safeStorage key no longer matters: everything is under our own key
  const s2 = new Store(file, new SecretBox(dir, { safeStorage: fakeSafeStorage('k2') }));
  assert.strictEqual(s2.getDeviceWithSecret('dev_ok').password, 'pw-ok');
  assert.strictEqual(s2.getDeviceWithSecret('dev_lost').password, 'new-pw');
  assert.deepStrictEqual(s2.lostSecrets, []);
});

test('an unreadable key file is set aside and the passwords it protected are reported lost', () => {
  const dir = tmpDir();
  const a = new SecretBox(dir, { safeStorage: null });
  const stored = a.encrypt('secret');
  fs.writeFileSync(path.join(dir, 'univms.key'), '{not json');
  const b = new SecretBox(dir, { safeStorage: null });
  assert.ok(b.keyError);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('univms.key.lost-')));
  assert.throws(() => b.decrypt(stored), (e) => e instanceof SecretError && e.secretLost === true);
  assert.strictEqual(b.decrypt(b.encrypt('again')), 'again');
});

test('driver pool refuses to log in with a lost password (lockout protection)', () => {
  const { DriverPool } = require('../src/main/drivers');
  const dir = tmpDir();
  const file = path.join(dir, 'cfg.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [{ id: 'dev_lost', type: 'hikvision', name: 'Old', host: '10.0.0.2', port: 80, username: 'admin', passwordEnc: 'enc:AAAA' }] }));
  const s = new Store(file, new SecretBox(dir, { safeStorage: fakeSafeStorage('k1') }));
  const pool = new DriverPool(s);
  assert.throws(() => pool.get('dev_lost'), (e) => e.authFailure === true && e.secretLost === true && /enter the password again/.test(e.message));
});
