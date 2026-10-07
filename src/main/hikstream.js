'use strict';
/*
 * Hikvision "stream encryption" (Platform Access / Hik-Connect → Stream Encryption, key = the device's verification code).
 *
 * Format (reverse engineered by the EZVIZ/Hik-Connect community, see pyezvizapi `decrypt_hikvision_ps_video` and
 * github.com/Bahrombekk/cloud-cam-viewer):
 *   - the container (Hikvision private MPEG-PS from the SDK, RTP/RTSP, …) is untouched; only the video NAL units
 *     inside the video PES payloads are encrypted, in place (lengths do not change);
 *   - per NAL unit: the Annex-B start code and the NAL header stay clear (2 bytes for HEVC, 1 for H.264; some H.264
 *     devices encrypt the header too), then the first 4096 bytes of the NAL body are AES-128-ECB encrypted in whole
 *     16-byte blocks; the rest of a long NAL (and the <16 byte tail) is clear;
 *   - key = verification code, NUL-padded to 16 bytes; standard 10-round AES (PlayM4 "AES_10R") or Hikvision's
 *     3-round variant ("AES_3R") — both are tried on the first parameter set and the one that yields a plausible
 *     SPS/VPS wins;
 *   - some devices encrypt every NAL, others only key frames + parameter sets (P/B slices clear). Until that is known
 *     the non-key NALs are held back and the first unambiguous slice headers vote (clear vs decrypted plausibility).
 *
 * NalDecryptor works on the stream of video payload bytes split across container packets and decrypts in place with
 * minimal hold-back (a packet is released as soon as none of its bytes belong to an unfinished AES block or an
 * undecided NAL). PsDecryptor / TsDecryptor are Transform streams wrapping it for MPEG-PS (SDK stream) and MPEG-TS
 * (RTSP → ffmpeg -c copy -f mpegts). Without a key they only detect whether the stream is encrypted.
 */
const { Transform } = require('stream');
const { makeCipher, streamKey } = require('./hikcrypto');

const ENC_PREFIX = 4096;
const H264_PROFILES = new Set([66, 77, 88, 100, 110, 122, 244, 44, 83, 86, 118, 128, 134, 135, 138, 139]);
const H264_KEY_TYPES = new Set([5, 7, 8]);
const HEVC_KEY_TYPES = new Set([16, 17, 18, 19, 20, 21, 32, 33, 34]);
const MAX_HOLD = 8192;          // bytes held for one NAL while its header / parameter set is examined
const MAX_DEFER = 2 << 20;      // bytes of non-key NALs held while "are P frames encrypted?" is still undecided

const h264Type = (b) => b & 0x1f;
const hevcType = (b) => (b >> 1) & 0x3f;
const plausibleH264Header = (b) => (b & 0x80) === 0 && h264Type(b) >= 1 && h264Type(b) <= 23;
const plausibleHevcHeader = (b0, b1) => (b0 & 0x81) === 0 && hevcType(b0) <= 40 && (b1 >> 3) === 0 && (b1 & 7) >= 1;
// SPS body: profile_idc, constraint flags (2 reserved zero bits), level_idc
const h264SpsOk = (d) => H264_PROFILES.has(d[0]) && (d[1] & 0x03) === 0 && d[2] >= 9 && d[2] <= 62;
const hevcVpsOk = (d) => d[0] === 0x0c && d[1] === 0xff && d[2] === 0xff;
const hevcSpsOk = (d) => (d[0] >> 4) === 0 && (d[1] & 0xc0) === 0 && (d[1] & 0x1f) >= 1 && (d[1] & 0x1f) <= 4;
const hevcParamOk = (type, d) => (type === 32 ? hevcVpsOk(d) : hevcSpsOk(d));
// first body byte of the first slice of a picture (first_mb_in_slice / first_slice_segment_in_pic_flag, slice_type, pps id…)
const plausibleInterH264 = (b) => b >= 0xe0 || (b & 0xfe) === 0x9a || (b & 0xf8) === 0xa8 || (b & 0xfe) === 0x9e;
const plausibleInterHevc = (b) => b >= 0xe0 || (b & 0xf8) === 0xd0;

/** Ordered packet queue: a packet is pushed downstream once no held byte references it (and all earlier ones are out). */
class PacketQueue {
  constructor(push) { this.q = []; this.push = push; }
  add(pkt) { this.q.push(pkt); }
  drain() { while (this.q.length && this.q[0].holds === 0) this.push(this.q.shift().buf); }
}

class NalDecryptor {
  /**
   * @param {object} o
   * @param {Buffer|string|null} o.key   verification code / 16-byte key; null = detect only
   * @param {object} [o.mode]            preset state (codec, hdr, rounds, encrypted, inter) — used by the encrypt helper
   * @param {boolean} [o.encrypt]        encrypt instead of decrypt (test fixtures)
   * @param {Function} [o.onState]       called with a copy of the state whenever something is learned
   */
  constructor({ key = null, mode = null, encrypt = false, onState = null } = {}) {
    this.key = key ? streamKey(key) : null;
    this.encrypt = encrypt;
    this.onState = onState;
    this.ciphers = new Map();
    this.state = { encrypted: null, keyError: false, codec: null, hdr: null, rounds: null, inter: 'unknown', nals: 0, badHeaders: 0, detail: '' };
    if (mode) Object.assign(this.state, mode);
    this.cur = this.key && this.state.encrypted && this.state.rounds ? this.cipher(this.state.rounds) : null;
    this.passAll = false;
    this.votes = { clear: 0, encrypted: 0 };
    // bytes of the current NAL not yet released downstream (parallel arrays: packet, offset, value)
    this.hp = []; this.ho = []; this.hv = [];
    this.deferred = []; this.deferredBytes = 0;   // finished non-key NALs waiting for the inter-frame decision
    this.zeroRun = 0;
    this.nal = null;
  }

  cipher(rounds) {
    let c = this.ciphers.get(rounds);
    if (!c) { c = makeCipher(this.key, rounds); this.ciphers.set(rounds, c); }
    return c;
  }
  emitState(detail) {
    if (detail) this.state.detail = detail;
    this.onState && this.onState({ ...this.state });
  }

  // ---- held bytes of the current NAL ----
  heldLen() { return this.hv.length; }
  heldByte(i) { return this.hv[i]; }
  heldSlice(i, n) { return Buffer.from(this.hv.slice(i, i + n)); }
  hold(pkt, off, v) { this.hp.push(pkt); this.ho.push(off); this.hv.push(v); pkt.holds++; }
  release(n) {
    if (n <= 0) return;
    for (let k = 0; k < n; k++) this.hp[k].holds--;
    this.hp.splice(0, n); this.ho.splice(0, n); this.hv.splice(0, n);
  }
  /** Replace the first 16 held bytes with their (de|en)crypted value and release them. */
  commitBlock() {
    const out = this.crypt(this.heldSlice(0, 16));
    for (let k = 0; k < 16; k++) this.hp[k].buf[this.ho[k]] = out[k];
    this.release(16);
  }
  crypt(block) { return this.encrypt ? this.cur.encryptBlock(block) : this.cur.decryptBlock(block); }
  passRest() { this.release(this.heldLen()); if (this.nal) this.nal.phase = 'pass'; }

  // ---- input ----
  feed(pkt, start, end) {
    const b = pkt.buf;
    for (let i = start; i < end; i++) {
      const v = b[i];
      if (v === 1 && this.zeroRun >= 2) { this.startCode(); continue; }
      if (this.passAll || !this.nal || this.nal.phase === 'pass') { this.zeroRun = v === 0 ? this.zeroRun + 1 : 0; continue; }
      this.hold(pkt, i, v);
      this.zeroRun = v === 0 ? this.zeroRun + 1 : 0;
      if (this.nal.phase === 'defer') { if (this.hv.length + this.deferredBytes > MAX_DEFER) this.resolveDeferred(this.lean(), 'too much data held back'); continue; }
      if (this.hv.length > MAX_HOLD) { this.passRest(); continue; }
      this.advance();
    }
  }
  end() {
    if (this.nal) this.finishNal();
    this.nal = null; this.zeroRun = 0;
    if (this.deferred.length) this.resolveDeferred(this.lean(), 'end of stream');
  }

  /** The current NAL is complete (a start code follows or the stream ends). */
  finishNal() {
    const nal = this.nal;
    if (!nal || nal.phase === 'pass') return;
    if (nal.phase === 'defer') { this.deferNal(); return; }
    // a tail shorter than one block (left clear by the encryptor) plus the zero bytes of the next start code
    this.release(this.heldLen());
  }
  startCode() {
    this.finishNal();
    this.zeroRun = 0;
    this.state.nals++;
    const s = this.state;
    if (this.passAll) { this.nal = { phase: 'pass' }; return; }
    if (s.encrypted === true && s.hdr === 0) { this.nal = { phase: 'body', encLeft: ENC_PREFIX }; return; }
    this.nal = { phase: 'hdr' };
  }

  advance() {
    const nal = this.nal, s = this.state;
    for (;;) {
      const avail = this.heldLen() - this.zeroRun; // bytes that are certainly NAL bytes (followed by a non-zero byte)
      if (nal.phase === 'hdr') {
        const need = s.codec === 'h264' ? 1 : 2;
        if (avail < need) return;
        const b0 = this.heldByte(0), b1 = need > 1 ? this.heldByte(1) : 0;
        if (s.encrypted === true) {
          // mode known: classify the NAL and decide whether its body is encrypted
          const type = s.codec === 'h264' ? h264Type(b0) : hevcType(b0);
          const isKey = (s.codec === 'h264' ? H264_KEY_TYPES : HEVC_KEY_TYPES).has(type);
          nal.type = type;
          nal.isSlice = s.codec === 'h264' ? type >= 1 && type <= 4 : type <= 9;
          if (isKey || s.inter === 'encrypted') { this.release(s.hdr); nal.phase = 'body'; nal.encLeft = ENC_PREFIX; continue; }
          if (s.inter === 'clear') { this.passRest(); return; }
          nal.phase = 'defer'; return; // header stays held with the body until the decision
        }
        // mode unknown yet: only parameter sets can tell us something
        const hevcParam = plausibleHevcHeader(b0, b1) && (hevcType(b0) === 32 || hevcType(b0) === 33);
        const h264Sps = plausibleH264Header(b0) && h264Type(b0) === 7;
        const anyHeader = plausibleH264Header(b0) || plausibleHevcHeader(b0, b1);
        if (!anyHeader) s.badHeaders++;
        if (hevcParam || h264Sps || (!anyHeader && this.key)) { nal.phase = 'detect'; nal.need = hevcParam ? 18 : h264Sps ? 17 : 16; continue; }
        if (!anyHeader && s.nals >= 40 && s.badHeaders * 2 > s.nals && s.encrypted === null) {
          // never saw a readable parameter set and most NAL headers are garbage: encrypted with the header included
          s.encrypted = true; this.passAll = true; this.emitState('encrypted stream (headers unreadable)');
        }
        this.passRest(); return;
      }
      if (nal.phase === 'detect') {
        if (avail < nal.need) return;
        if (!this.detect()) { this.passRest(); return; }
        if (s.encrypted === false) { this.passAll = true; this.passRest(); return; }
        this.release(s.hdr);
        nal.phase = 'body'; nal.encLeft = ENC_PREFIX;
        continue;
      }
      if (nal.phase === 'body') {
        if (nal.encLeft < 16) { this.passRest(); return; }
        if (avail < 16) return;
        this.commitBlock();
        nal.encLeft -= 16;
        continue;
      }
      return;
    }
  }

  // ---- "are inter frames encrypted?" ----
  lean() { return this.votes.encrypted >= this.votes.clear ? 'encrypted' : 'clear'; }
  /** Move the finished non-key NAL to the deferred list and let it vote. */
  deferNal() {
    const s = this.state, nal = this.nal;
    const total = this.hv.length, bodyLen = Math.max(0, total - s.hdr - this.zeroRun);
    const rec = { hp: this.hp, ho: this.ho, hv: this.hv, hdr: s.hdr, bodyLen };
    this.hp = []; this.ho = []; this.hv = [];
    nal.phase = 'done'; // complete; resolveDeferred must not treat it as the NAL in progress
    this.deferred.push(rec); this.deferredBytes += total;
    if (nal.isSlice && bodyLen >= 16 && s.inter === 'unknown') {
      const ok = s.codec === 'h264' ? plausibleInterH264 : plausibleInterHevc;
      const clearOk = ok(rec.hv[s.hdr]);
      const encOk = ok(this.cur.decryptBlock(Buffer.from(rec.hv.slice(s.hdr, s.hdr + 16)))[0]);
      if (clearOk !== encOk) this.votes[clearOk ? 'clear' : 'encrypted']++;
      const d = this.votes.encrypted - this.votes.clear, n = this.votes.encrypted + this.votes.clear;
      if (Math.abs(d) >= 3 || n >= 16) this.resolveDeferred(d >= 0 ? 'encrypted' : 'clear', `${n} slices sampled`);
    }
  }
  /** Decide the inter-frame mode and process everything held back. */
  resolveDeferred(kind, why) {
    const s = this.state;
    if (s.inter === 'unknown') { s.inter = kind; this.emitState(`inter frames ${kind} (${why})`); }
    for (const rec of this.deferred) {
      if (kind === 'encrypted') {
        const n = Math.floor(Math.min(rec.bodyLen, ENC_PREFIX) / 16) * 16;
        for (let o = rec.hdr; o < rec.hdr + n; o += 16) {
          const out = this.crypt(Buffer.from(rec.hv.slice(o, o + 16)));
          for (let k = 0; k < 16; k++) rec.hp[o + k].buf[rec.ho[o + k]] = out[k];
        }
      }
      for (const p of rec.hp) p.holds--;
    }
    this.deferred = []; this.deferredBytes = 0;
    if (this.nal && this.nal.phase === 'defer') {
      // the NAL in progress follows the decision from here on
      if (kind === 'clear') this.passRest();
      else { this.release(s.hdr); this.nal.phase = 'body'; this.nal.encLeft = ENC_PREFIX; this.advance(); }
    }
  }

  /** Decide codec / header size / rounds / encrypted from the held parameter-set NAL. Returns false when nothing could be learned. */
  detect() {
    const s = this.state;
    const b0 = this.heldByte(0), b1 = this.heldByte(1);
    const rounds = this.key ? [10, 3] : [];
    const found = (m, detail) => { Object.assign(s, m); if (m.encrypted) this.cur = this.cipher(m.rounds); this.emitState(detail); return true; };
    const fail = (what) => {
      s.encrypted = true;
      this.passAll = true; // nothing we can do for this stream any more: pass it through and let the caller decide
      if (this.key) s.keyError = true;
      this.emitState(this.key ? `${what} does not decrypt with this key` : `${what} unreadable: encrypted stream`);
      return false;
    };
    if (plausibleHevcHeader(b0, b1) && (hevcType(b0) === 32 || hevcType(b0) === 33)) {
      const t = hevcType(b0), body = this.heldSlice(2, 16);
      if (hevcParamOk(t, body)) return found({ codec: 'hevc', hdr: 2, encrypted: false }, 'clear HEVC stream');
      for (const r of rounds) if (hevcParamOk(t, this.cipher(r).decryptBlock(body))) return found({ codec: 'hevc', hdr: 2, rounds: r, encrypted: true }, `HEVC, AES ${r} rounds`);
      return fail(t === 32 ? 'HEVC VPS' : 'HEVC SPS');
    }
    if (plausibleH264Header(b0) && h264Type(b0) === 7) {
      const body = this.heldSlice(1, 16);
      if (h264SpsOk(body)) return found({ codec: 'h264', hdr: 1, encrypted: false }, 'clear H.264 stream');
      for (const r of rounds) if (h264SpsOk(this.cipher(r).decryptBlock(body))) return found({ codec: 'h264', hdr: 1, rounds: r, encrypted: true }, `H.264, AES ${r} rounds`);
      return fail('H.264 SPS');
    }
    // unreadable header: maybe H.264 with the NAL header encrypted as well
    for (const r of rounds) {
      const d = this.cipher(r).decryptBlock(this.heldSlice(0, 16));
      if (plausibleH264Header(d[0]) && h264Type(d[0]) === 7 && h264SpsOk(d.subarray(1))) return found({ codec: 'h264', hdr: 0, rounds: r, encrypted: true, inter: 'encrypted' }, `H.264 (header encrypted), AES ${r} rounds`);
    }
    return false;
  }
}

/** Base Transform: subclasses split the container into packets and report video payload ranges. */
class ContainerDecryptor extends Transform {
  constructor(opts = {}) {
    super();
    this.buf = null;
    this.q = new PacketQueue((b) => this.push(b));
    this.nal = new NalDecryptor(opts);
    this.stats = { packets: 0, videoBytes: 0, bytes: 0 };
  }
  get state() { return this.nal.state; }
  _transform(chunk, _enc, cb) {
    this.stats.bytes += chunk.length;
    this.buf = this.buf && this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try { this.parse(); } catch (e) { cb(e); return; }
    this.q.drain();
    cb();
  }
  _flush(cb) {
    this.nal.end();
    if (this.buf && this.buf.length) this.q.add({ buf: Buffer.from(this.buf), holds: 0 });
    this.buf = null;
    this.q.drain();
    cb();
  }
  raw(b) { this.q.add({ buf: Buffer.from(b), holds: 0 }); }
  video(pkt, start, end) { this.stats.videoBytes += end - start; this.nal.feed(pkt, start, end); }
}

const findStartCode = (b, from) => { for (let i = from; i + 2 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) return i; return -1; };

/** Offset of the payload inside a PES packet (MPEG-2 header, or MPEG-1 for ffmpeg's plain "mpeg" muxer); -1 when malformed. */
function pesPayloadStart(p, end) {
  if (end < 9) return -1;
  if ((p[6] & 0xc0) === 0x80) return 9 + p[8];
  let i = 6;
  while (i < end && p[i] === 0xff) i++;
  if (i < end && (p[i] & 0xc0) === 0x40) i += 2;
  if (i >= end) return -1;
  if ((p[i] & 0xf0) === 0x20) i += 5;
  else if ((p[i] & 0xf0) === 0x30) i += 10;
  else if (p[i] === 0x0f) i += 1;
  else return -1;
  return i <= end ? i : -1;
}

/** MPEG-PS (Hikvision private PS from the SDK, type-2 packets). */
class PsDecryptor extends ContainerDecryptor {
  parse() {
    const b = this.buf;
    let pos = 0;
    while (b.length - pos >= 4) {
      if (!(b[pos] === 0 && b[pos + 1] === 0 && b[pos + 2] === 1)) {
        const n = findStartCode(b, pos + 1);
        const stop = n < 0 ? b.length : n;
        this.raw(b.subarray(pos, stop)); pos = stop; continue;
      }
      const id = b[pos + 3];
      let len;
      if (id === 0xba) { if (b.length - pos < 14) break; len = (b[pos + 4] & 0xc0) === 0x40 ? 14 + (b[pos + 13] & 7) : 12; }
      else if (id === 0xb9) len = 4;
      else if (id >= 0xbb) { if (b.length - pos < 6) break; len = 6 + b.readUInt16BE(pos + 4); }
      else { const n = findStartCode(b, pos + 1); const stop = n < 0 ? b.length : n; this.raw(b.subarray(pos, stop)); pos = stop; continue; }
      if (b.length - pos < len) break;
      const pkt = { buf: Buffer.from(b.subarray(pos, pos + len)), holds: 0 };
      this.stats.packets++;
      this.q.add(pkt);
      if (id >= 0xe0 && id <= 0xef) {
        const start = pesPayloadStart(pkt.buf, len);
        if (start > 0 && start < len) this.video(pkt, start, len);
      }
      pos += len;
    }
    this.buf = pos ? b.subarray(pos) : b;
  }
}

/** MPEG-TS (ffmpeg -c copy -f mpegts of the RTSP stream). Video PIDs are learned from the PES stream ids (0xE0–0xEF). */
class TsDecryptor extends ContainerDecryptor {
  constructor(opts) { super(opts); this.videoPids = new Set(); }
  parse() {
    const b = this.buf;
    let pos = 0;
    while (b.length - pos >= 188) {
      if (b[pos] !== 0x47) {
        let n = pos + 1;
        while (n < b.length && !(b[n] === 0x47 && (n + 188 >= b.length || b[n + 188] === 0x47))) n++;
        this.raw(b.subarray(pos, n)); pos = n; continue;
      }
      const pkt = { buf: Buffer.from(b.subarray(pos, pos + 188)), holds: 0 };
      const h = pkt.buf;
      const pusi = (h[1] & 0x40) !== 0, pid = ((h[1] & 0x1f) << 8) | h[2], afc = (h[3] >> 4) & 3;
      let ps = 4;
      if (afc & 2) ps += 1 + h[4];
      this.stats.packets++;
      this.q.add(pkt);
      if ((afc & 1) && ps < 188 && pid !== 0 && pid !== 0x1fff) {
        if (pusi) {
          const rel = 188 - ps >= 9 && h[ps] === 0 && h[ps + 1] === 0 && h[ps + 2] === 1 && h[ps + 3] >= 0xe0 && h[ps + 3] <= 0xef ? pesPayloadStart(h.subarray(ps), 188 - ps) : -1;
          if (rel > 0) {
            this.videoPids.add(pid);
            if (ps + rel < 188) this.video(pkt, ps + rel, 188);
          } else this.videoPids.delete(pid);
        } else if (this.videoPids.has(pid)) this.video(pkt, ps, 188);
      }
      pos += 188;
    }
    this.buf = pos ? b.subarray(pos) : b;
  }
}

module.exports = { PsDecryptor, TsDecryptor };
