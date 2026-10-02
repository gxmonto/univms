'use strict';
/*
 * Hikvision's AES flavours.
 *  - Standard AES-128 (10 rounds): stream encryption of video NAL units (PlayM4 "ENCRYPT_AES_10R_VIDEO"), uses
 *    Node's crypto.
 *  - Reduced-round Rijndael (3 or 4 rounds, same key schedule and round functions, just fewer rounds): 4 rounds for
 *    the device QR codes (hikqr.js), 3 rounds for some encrypted streams ("ENCRYPT_AES_3R_VIDEO"). Node cannot do
 *    these, so a small pure-JS Rijndael is used (only a few KB per second go through it).
 * All uses are ECB on 16-byte blocks; padding is the caller's business (NUL padding for the QR, none for streams).
 */
const crypto = require('crypto');

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
  return w;
}
function addRoundKey(s, w, r) { for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) s[4 * c + i] ^= w[4 * r + c][i]; }
function subBytes(s, box) { for (let i = 0; i < 16; i++) s[i] = box[s[i]]; }
function shiftRows(s) { for (let r = 1; r < 4; r++) { const row = [s[r], s[4 + r], s[8 + r], s[12 + r]]; for (let c = 0; c < 4; c++) s[4 * c + r] = row[(c + r) % 4]; } }
function invShiftRows(s) { for (let r = 1; r < 4; r++) { const row = [s[r], s[4 + r], s[8 + r], s[12 + r]]; for (let c = 0; c < 4; c++) s[4 * ((c + r) % 4) + r] = row[c]; } }
function mixColumns(s) { for (let c = 0; c < 4; c++) { const a = s.slice(4 * c, 4 * c + 4); s[4 * c] = mul(a[0], 2) ^ mul(a[1], 3) ^ a[2] ^ a[3]; s[4 * c + 1] = a[0] ^ mul(a[1], 2) ^ mul(a[2], 3) ^ a[3]; s[4 * c + 2] = a[0] ^ a[1] ^ mul(a[2], 2) ^ mul(a[3], 3); s[4 * c + 3] = mul(a[0], 3) ^ a[1] ^ a[2] ^ mul(a[3], 2); } }
function invMixColumns(s) { for (let c = 0; c < 4; c++) { const a = s.slice(4 * c, 4 * c + 4); s[4 * c] = mul(a[0], 14) ^ mul(a[1], 11) ^ mul(a[2], 13) ^ mul(a[3], 9); s[4 * c + 1] = mul(a[0], 9) ^ mul(a[1], 14) ^ mul(a[2], 11) ^ mul(a[3], 13); s[4 * c + 2] = mul(a[0], 13) ^ mul(a[1], 9) ^ mul(a[2], 14) ^ mul(a[3], 11); s[4 * c + 3] = mul(a[0], 11) ^ mul(a[1], 13) ^ mul(a[2], 9) ^ mul(a[3], 14); } }

class Rijndael {
  constructor(key, rounds) {
    if (![16, 24, 32].includes(key.length)) throw new Error('Rijndael key must be 16, 24 or 32 bytes');
    this.rounds = rounds;
    this.w = expandKey(key, rounds);
  }
  encryptBlock(block) {
    const s = Array.from(block), w = this.w, R = this.rounds;
    addRoundKey(s, w, 0);
    for (let r = 1; r < R; r++) { subBytes(s, SBOX); shiftRows(s); mixColumns(s); addRoundKey(s, w, r); }
    subBytes(s, SBOX); shiftRows(s); addRoundKey(s, w, R);
    return Buffer.from(s);
  }
  decryptBlock(block) {
    const s = Array.from(block), w = this.w, R = this.rounds;
    addRoundKey(s, w, R);
    for (let r = R - 1; r >= 1; r--) { invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, w, r); invMixColumns(s); }
    invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, w, 0);
    return Buffer.from(s);
  }
}

/** Block cipher for one 16-byte key: { rounds, encryptBlock(buf16), decryptBlock(buf16) }. */
function makeCipher(key, rounds = 10) {
  key = Buffer.from(key);
  if (rounds === 10 && key.length === 16) {
    const enc = crypto.createCipheriv('aes-128-ecb', key, null); enc.setAutoPadding(false);
    const dec = crypto.createDecipheriv('aes-128-ecb', key, null); dec.setAutoPadding(false);
    return { rounds, encryptBlock: (b) => Buffer.from(enc.update(b)), decryptBlock: (b) => Buffer.from(dec.update(b)) };
  }
  return new Rijndael(key, rounds);
}

/** Stream key from the verification code / key text: NUL-padded or truncated to 16 bytes. */
function streamKey(code) {
  if (Buffer.isBuffer(code)) { const k = Buffer.alloc(16); code.copy(k, 0, 0, 16); return k; }
  const k = Buffer.alloc(16);
  Buffer.from(String(code), 'utf8').copy(k, 0, 0, 16);
  return k;
}

module.exports = { Rijndael, makeCipher, streamKey, SBOX, INV_SBOX };
