'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { encodeDeviceQr, decodeDeviceQr, hikEncrypt, hikDecrypt } = require('../src/main/hikqr');

// Real export produced by the Hik-Connect app (sample from github.com/maxim-smirnov/hik-qr-export README)
const SAMPLE = 'QRC03010003eJwrKnNNzC0vNy/yLogwD041LTUocg13tLW1ijRyK4mK8MpQM1DzDcmu9MlyNfJ3NqkA0rZqFgYGBmpqySWGuSYp5iEVwc5eHkZJHpnhWcFBQK04JVSsjJO8g5IC0gMSU6KcqsxczEuzjfQNA21tAQ4rKR0=';

test('decodes a real Hik-Connect export QR (validates the 4-round AES port)', () => {
  const d = decodeDeviceQr(SAMPLE);
  assert.strictEqual(d.header, 'QRC03010003');
  assert.ok(typeof d.password === 'string' && d.password.length > 0 && /^[\x20-\x7e]+$/.test(d.password), `password decrypts to printable text: ${JSON.stringify(d.password)}`);
  assert.ok(Number.isInteger(d.timestamp) && d.timestamp > 1500000000, `timestamp plausible: ${d.timestamp}`);
  assert.ok(d.devices.length >= 1);
  for (const dev of d.devices) {
    assert.ok(/^[\x20-\x7e]+$/.test(dev.username), `username printable: ${JSON.stringify(dev.username)}`);
    assert.ok(/^[\x20-\x7e]*$/.test(dev.password), `password printable: ${JSON.stringify(dev.password)}`);
    assert.ok(dev.port > 0 && dev.port < 65536);
    assert.ok(dev.host.length > 0);
  }
});

test('encrypt/decrypt round trip and encode/decode round trip', () => {
  for (const s of ['admin', 'Sightwatch101!', 'a'.repeat(32), '']) assert.strictEqual(hikDecrypt(hikEncrypt(s)), s);
  const text = encodeDeviceQr({ devices: [{ name: 'Lobby NVR', host: '192.168.1.50', port: 8000, username: 'admin', password: 'Secret#123' }, { name: 'Site DDNS', host: 'site.ddns.net', port: 8000, username: 'operator', password: 'pw' }], password: 'qr-pass', timestamp: 1759400000 });
  assert.ok(text.startsWith('QRC03010003'));
  const d = decodeDeviceQr(text);
  assert.strictEqual(d.password, 'qr-pass');
  assert.strictEqual(d.timestamp, 1759400000);
  assert.deepStrictEqual(d.devices, [
    { name: 'Lobby NVR', host: '192.168.1.50', port: 8000, username: 'admin', password: 'Secret#123' },
    { name: 'Site DDNS', host: 'site.ddns.net', port: 8000, username: 'operator', password: 'pw' },
  ]);
  assert.throws(() => encodeDeviceQr({ devices: [], password: '' }), /1–16/);
});
