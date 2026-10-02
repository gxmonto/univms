'use strict';
/*
 * Hikvision "device export" QR codes (what iVMS-4200 / Hik-Connect generate under "Generate QR code"):
 *   <header><base64(zlib(payload))>
 *   payload = enc(pw)  ':'  devices  ':'  enc(timestamp)
 *   devices = device '$' device '$' ...   device = b64(name) '&' '0' '&' b64(host) '&' port '&' '' '&' enc(user) '&' enc(pass)
 * enc() = Hikvision's AES: key "dkfj4593@#&*wlfm", **4 rounds** (not the standard 10), ECB per 16-byte block,
 * values NUL-padded to a block multiple, base64 output. The mobile app asks for the QR password, compares it with
 * the decrypted enc(pw) part and then imports the devices (IP/domain devices, usually on the server port 8000).
 * Format documented by https://github.com/maxim-smirnov/hik-qr-export (reverse engineered).
 */
const zlib = require('zlib');
const { Rijndael } = require('./hikcrypto');

const KEY = Buffer.from('dkfj4593@#&*wlfm', 'latin1');
const ROUNDS = 4;
const HEADER = 'QRC03010003';
const C = new Rijndael(KEY, ROUNDS);

const padBlock = (s) => { const b = Buffer.from(String(s), 'utf8'); const len = Math.ceil(b.length / 16) * 16 || 16; return Buffer.concat([b, Buffer.alloc(len - b.length)]); };
function hikEncrypt(str) { const data = padBlock(str); const out = []; for (let i = 0; i < data.length; i += 16) out.push(C.encryptBlock(data.subarray(i, i + 16))); return Buffer.concat(out).toString('base64'); }
function hikDecrypt(b64) { const raw = Buffer.from(b64, 'base64'); const out = []; for (let i = 0; i + 16 <= raw.length; i += 16) out.push(C.decryptBlock(raw.subarray(i, i + 16))); return Buffer.concat(out).toString('utf8').replace(/\0+$/, ''); }

/**
 * Build the QR text. devices: [{ name, host, port, username, password }], password: 1–16 chars.
 */
function encodeDeviceQr({ devices, password, timestamp = Math.floor(Date.now() / 1000), header = HEADER }) {
  if (!password || password.length > 16) throw new Error('QR password must be 1–16 characters');
  for (const d of devices) {
    if (String(d.username || '').length > 32 || String(d.password || '').length > 32) throw new Error(`Credentials of ${d.name} are longer than 32 characters, which the QR format cannot carry`);
  }
  const recs = devices.map((d) => [Buffer.from(d.name || d.host, 'utf8').toString('base64'), '0', Buffer.from(String(d.host), 'utf8').toString('base64'), String(d.port), '', hikEncrypt(d.username || ''), hikEncrypt(d.password || '')].join('&')).join('$') + '$';
  const payload = [hikEncrypt(password), recs, hikEncrypt(String(timestamp))].join(':');
  return header + zlib.deflateSync(Buffer.from(payload, 'utf8')).toString('base64');
}

/** Decode (for tests / verification). Returns { header, password, timestamp, devices }. */
function decodeDeviceQr(text) {
  const headerLen = text.startsWith('iVMS') ? 12 : text.startsWith('DVR/NVR') ? 13 : 11;
  const header = text.slice(0, headerLen);
  const payload = zlib.inflateSync(Buffer.from(text.slice(headerLen), 'base64')).toString('utf8');
  const parts = payload.split(':');
  let password = null, timestamp = null, recs;
  if (parts.length === 1) recs = parts[0];
  else if (parts.length === 2) { password = hikDecrypt(parts[0]); recs = parts[1]; }
  else { password = hikDecrypt(parts[0]); recs = parts[1]; timestamp = Number(hikDecrypt(parts[2])); }
  const devSep = recs.includes('$') || recs.includes('&') ? '$' : ';';
  const fieldSep = devSep === '$' ? '&' : ',';
  const devices = recs.split(devSep).filter(Boolean).map((r) => {
    const f = r.split(fieldSep);
    return { name: Buffer.from(f[0], 'base64').toString('utf8'), host: Buffer.from(f[2], 'base64').toString('utf8'), port: Number(f[3]), username: hikDecrypt(f[5]), password: hikDecrypt(f[6]) };
  });
  return { header, password, timestamp, devices };
}

module.exports = { encodeDeviceQr, decodeDeviceQr, hikEncrypt, hikDecrypt, HEADER };
