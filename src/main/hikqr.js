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

const KEY = Buffer.from('dkfj4593@#&*wlfm', 'latin1');
const ROUNDS = 4;
const HEADER = 'QRC03010003';

// ---- Rijndael with a configurable number of rounds ----
const SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256);
(function initSbox() {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();
const xtime = (b) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r; };

function expandKey(key, rounds) {
  const nk = key.length / 4, total = 4 * (rounds + 1);
  const w = [];
  for (let i = 0; i < nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  let rcon = 1;
  for (let i = nk; i < total; i++) {
    let t = w[i - 1].slice();
    if (i % nk === 0) { t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]; rcon = xtime(rcon); }
    else if (nk > 6 && i % nk === 4) t = t.map((b) => SBOX[b]);
    w.push(w[i - nk].map((b, j) => b ^ t[j]));
  }
  return w; // words
}
function addRoundKey(s, w, r) { for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) s[4 * c + i] ^= w[4 * r + c][i]; }
function subBytes(s, box) { for (let i = 0; i < 16; i++) s[i] = box[s[i]]; }
function shiftRows(s) { for (let r = 1; r < 4; r++) { const row = [s[r], s[4 + r], s[8 + r], s[12 + r]]; for (let c = 0; c < 4; c++) s[4 * c + r] = row[(c + r) % 4]; } }
function invShiftRows(s) { for (let r = 1; r < 4; r++) { const row = [s[r], s[4 + r], s[8 + r], s[12 + r]]; for (let c = 0; c < 4; c++) s[4 * ((c + r) % 4) + r] = row[c]; } }
function mixColumns(s) { for (let c = 0; c < 4; c++) { const a = s.slice(4 * c, 4 * c + 4); s[4 * c] = mul(a[0], 2) ^ mul(a[1], 3) ^ a[2] ^ a[3]; s[4 * c + 1] = a[0] ^ mul(a[1], 2) ^ mul(a[2], 3) ^ a[3]; s[4 * c + 2] = a[0] ^ a[1] ^ mul(a[2], 2) ^ mul(a[3], 3); s[4 * c + 3] = mul(a[0], 3) ^ a[1] ^ a[2] ^ mul(a[3], 2); } }
function invMixColumns(s) { for (let c = 0; c < 4; c++) { const a = s.slice(4 * c, 4 * c + 4); s[4 * c] = mul(a[0], 14) ^ mul(a[1], 11) ^ mul(a[2], 13) ^ mul(a[3], 9); s[4 * c + 1] = mul(a[0], 9) ^ mul(a[1], 14) ^ mul(a[2], 11) ^ mul(a[3], 13); s[4 * c + 2] = mul(a[0], 13) ^ mul(a[1], 9) ^ mul(a[2], 14) ^ mul(a[3], 11); s[4 * c + 3] = mul(a[0], 11) ^ mul(a[1], 13) ^ mul(a[2], 9) ^ mul(a[3], 14); } }

function encryptBlock(block, w, rounds) {
  const s = Array.from(block);
  addRoundKey(s, w, 0);
  for (let r = 1; r < rounds; r++) { subBytes(s, SBOX); shiftRows(s); mixColumns(s); addRoundKey(s, w, r); }
  subBytes(s, SBOX); shiftRows(s); addRoundKey(s, w, rounds);
  return Buffer.from(s);
}
function decryptBlock(block, w, rounds) {
  const s = Array.from(block);
  addRoundKey(s, w, rounds);
  for (let r = rounds - 1; r >= 1; r--) { invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, w, r); invMixColumns(s); }
  invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, w, 0);
  return Buffer.from(s);
}

const W = expandKey(KEY, ROUNDS);
const padBlock = (s) => { const b = Buffer.from(String(s), 'utf8'); const len = Math.ceil(b.length / 16) * 16 || 16; return Buffer.concat([b, Buffer.alloc(len - b.length)]); };
function hikEncrypt(str) { const data = padBlock(str); const out = []; for (let i = 0; i < data.length; i += 16) out.push(encryptBlock(data.subarray(i, i + 16), W, ROUNDS)); return Buffer.concat(out).toString('base64'); }
function hikDecrypt(b64) { const raw = Buffer.from(b64, 'base64'); const out = []; for (let i = 0; i + 16 <= raw.length; i += 16) out.push(decryptBlock(raw.subarray(i, i + 16), W, ROUNDS)); return Buffer.concat(out).toString('utf8').replace(/\0+$/, ''); }

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
