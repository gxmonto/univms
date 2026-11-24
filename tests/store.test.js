'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { SecretBox } = require('../src/main/secrets');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'univms-test-')), 'cfg.json');
const mk = (file = tmpFile()) => new Store(file, new SecretBox(path.dirname(file), { safeStorage: null }));

test('store encrypts passwords (fallback) and round-trips devices', () => {
  const file = tmpFile();
  const s = mk(file);
  const d = s.upsertDevice({ type: 'hikvision', name: 'NVR', host: '10.0.0.1', port: 80, username: 'admin', password: 's3cret' });
  assert.ok(d.id.startsWith('dev_'));
  assert.strictEqual(d.hasPassword, true);
  assert.strictEqual(d.password, undefined, 'password not exposed publicly');
  s.flush();
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('s3cret'), 'plain password never written to disk');
  const s2 = mk(file);
  assert.strictEqual(s2.getDeviceWithSecret(d.id).password, 's3cret');
  // editing without password keeps the old one
  s2.upsertDevice({ id: d.id, name: 'NVR2', password: '' });
  assert.strictEqual(s2.getDeviceWithSecret(d.id).password, 's3cret');
  assert.strictEqual(s2.getDevice(d.id).name, 'NVR2');
});

test('encrypted config export/import', () => {
  const s = mk();
  const d = s.upsertDevice({ type: 'dwspectrum', name: 'DW', host: '10.0.0.2', port: 7001, username: 'u', password: 'p' });
  s.upsert('views', { name: 'V1', layoutId: '4', cells: [{ cameraId: d.id + ':x' }] });
  const exp = s.exportConfig('backup-pw');
  assert.strictEqual(exp.encrypted, true);
  assert.ok(!JSON.stringify(exp).includes('"p"'));
  const s2 = mk();
  assert.throws(() => s2.importConfig(exp, 'wrong'), /Wrong password/);
  const r = s2.importConfig(exp, 'backup-pw');
  assert.strictEqual(r.devices, 1);
  assert.strictEqual(s2.getDeviceWithSecret(d.id).password, 'p');
  assert.strictEqual(s2.list('views')[0].name, 'V1');
});

test('app users: scrypt hash + verify', () => {
  const s = mk();
  const { salt, hash } = s.hashPassword('hunter2');
  s.upsert('users', { username: 'Mike', role: 'admin', salt, hash });
  assert.ok(s.verifyUser('mike', 'hunter2'));
  assert.strictEqual(s.verifyUser('mike', 'wrong'), null);
});

test('obsolete update preferences are stripped on load, settings edits, and import', () => {
  const file = tmpFile();
  const updates = { url: 'https://example.test', token: 'old-token', mode: 'off' };
  fs.writeFileSync(file, JSON.stringify({ settings: { updates, defaultStream: 'main' } }));
  const store = mk(file);
  assert.strictEqual(store.getSettings().defaultStream, 'main');
  assert.strictEqual(store.getSettings().updates, undefined);
  store.setSettings({ updates });
  store.importConfig({ format: 'univms-config', data: { settings: { updates } } });
  assert.strictEqual(store.getSettings().updates, undefined);
  store.flush();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /old-token/);
});
