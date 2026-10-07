'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Rijndael, makeCipher, streamKey } = require('../src/main/hikcrypto');
const { PsDecryptor, TsDecryptor } = require('../src/main/hikstream');

/** Run a whole buffer through a decryptor (tests, probes). Resolves { data, state, stats }. */
function transformBuffer(Cls, opts, data, chunkSizes) {
  return new Promise((resolve, reject) => {
    const t = new Cls(opts);
    const out = [];
    t.on('data', (d) => out.push(d));
    t.on('error', reject);
    t.on('end', () => resolve({ data: Buffer.concat(out), state: t.state, stats: t.stats }));
    let pos = 0, i = 0;
    while (pos < data.length) {
      const n = chunkSizes ? chunkSizes[i++ % chunkSizes.length] : data.length;
      t.write(data.subarray(pos, pos + n)); pos += n;
    }
    t.end();
  });
}


// deterministic "random" bytes without 0x00 (no accidental start codes, no trailing zeros)
function rnd(seed, n) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = 1 + (x % 255); }
  return out;
}
const START = Buffer.from([0, 0, 0, 1]);

/** Synthetic Annex-B elementary stream: frames = [[nal, nal, ...]] (each nal = Buffer without start code). */
function h264Frames(seed = 1) {
  const sps = Buffer.concat([Buffer.from([0x67, 100, 0x00, 31]), rnd(seed + 1, 20)]);
  const pps = Buffer.concat([Buffer.from([0x68, 0xce, 0x3c, 0x80])]);
  const aud = Buffer.from([0x09, 0xf0]);
  const idr = Buffer.concat([Buffer.from([0x65]), rnd(seed + 2, 6000)]);
  const p = (s, n, first = 0xe8) => Buffer.concat([Buffer.from([0x41, first]), rnd(s, n)]);
  const sei = Buffer.concat([Buffer.from([0x06, 0x05, 0x18]), rnd(seed + 3, 24), Buffer.from([0x80])]);
  return [[aud, sps, pps, sei, idr], [aud, p(seed + 4, 10)], [aud, p(seed + 5, 14)], [aud, p(seed + 6, 15)], [aud, p(seed + 7, 30)], [aud, p(seed + 8, 31)], [aud, p(seed + 9, 800)], [aud, p(seed + 10, 5000)], [aud, sps, pps, idr], [aud, p(seed + 11, 400, 0x9a)], [aud, p(seed + 12, 4200)]];
}
function hevcFrames(seed = 7) {
  const vps = Buffer.concat([Buffer.from([0x40, 0x01, 0x0c, 0xff, 0xff]), rnd(seed + 1, 18)]);
  const sps = Buffer.concat([Buffer.from([0x42, 0x01, 0x01, 0x01, 0x60]), rnd(seed + 2, 30)]);
  const pps = Buffer.concat([Buffer.from([0x44, 0x01, 0xc1, 0x72, 0xb4, 0x62, 0x40])]);
  const aud = Buffer.from([0x46, 0x01, 0x50]);
  const idr = Buffer.concat([Buffer.from([0x26, 0x01]), rnd(seed + 3, 5000)]);
  const p = (s, n, first = 0xd2) => Buffer.concat([Buffer.from([0x02, 0x01, first]), rnd(s, n)]);
  const pn = (s, n) => Buffer.concat([Buffer.from([0x00, 0x01, 0xe4]), rnd(s, n)]); // TRAIL_N: header byte 0x00
  return [[aud, vps, sps, pps, idr], [aud, p(seed + 4, 12)], [aud, pn(seed + 5, 16)], [aud, p(seed + 6, 17)], [aud, p(seed + 7, 700)], [aud, pn(seed + 8, 4500)], [aud, vps, sps, pps, idr], [aud, p(seed + 9, 300)]];
}
const esOf = (frames) => Buffer.concat(frames.flatMap((f) => f.flatMap((n) => [START, n])));

// ---- MPEG-PS packaging (MPEG-2 pack header + PES with PTS, video PES split at odd sizes, private audio PES in between) ----
function pes(id, payload, pts) {
  const hdr = Buffer.from([0x80, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, 0x01 | ((pts >> 14) & 0xfe), (pts >> 7) & 0xff, 0x01 | ((pts << 1) & 0xfe)]);
  const len = hdr.length + payload.length;
  return Buffer.concat([Buffer.from([0, 0, 1, id, len >> 8, len & 0xff]), hdr, payload]);
}
const PACK = Buffer.from([0, 0, 1, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x01, 0x89, 0xc3, 0xf8]);
function buildPs(frames, splits = [60000]) {
  const parts = [Buffer.from([0, 0, 1, 0xbb, 0, 6, 0x80, 0x01, 0x89, 0xc3, 0xf8, 0xe0])];
  let pts = 9000, si = 0;
  for (const f of frames) {
    parts.push(PACK);
    const es = esOf([f]);
    let pos = 0;
    while (pos < es.length) { const n = Math.min(splits[si++ % splits.length], es.length - pos, 65000); parts.push(pes(0xe0, es.subarray(pos, pos + n), pts)); pos += n; }
    parts.push(pes(0xbd, Buffer.concat([Buffer.from([0, 0, 1, 0xba, 0, 0, 1, 0x67]), rnd(pts, 150)]), pts)); // private stream with misleading bytes inside
    pts += 3600;
  }
  return Buffer.concat(parts);
}
// ---- MPEG-TS packaging (video PID 0x101, unbounded PES, PAT/PMT/null packets, adaptation field with PCR) ----
function tsPacket(pid, pusi, payload, { adaptation = null, cc = 0 } = {}) {
  const pkt = Buffer.alloc(188, 0xff);
  pkt[0] = 0x47; pkt[1] = (pusi ? 0x40 : 0) | (pid >> 8); pkt[2] = pid & 0xff;
  let pos = 4;
  const room = 184 - (adaptation ? 1 + adaptation.length : 0);
  const stuffing = room - payload.length;
  if (adaptation || stuffing > 0) {
    const af = Buffer.concat([adaptation || Buffer.alloc(0), Buffer.alloc(Math.max(0, stuffing - (adaptation ? 0 : 1)), 0xff)]);
    const afLen = adaptation ? af.length : Math.max(0, stuffing - 1);
    pkt[3] = 0x30 | (cc & 15);
    pkt[4] = afLen;
    if (afLen > 0) pkt[5] = adaptation ? 0x10 : 0x00;
    if (adaptation) adaptation.copy(pkt, 6);
    pos = 5 + afLen;
  } else pkt[3] = 0x10 | (cc & 15);
  payload.copy(pkt, pos);
  return pkt;
}
function buildTs(frames) {
  const out = [tsPacket(0, true, Buffer.concat([Buffer.from([0x00, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf1, 0x00]), rnd(3, 4)])),
    tsPacket(0x100, true, Buffer.concat([Buffer.from([0x00, 0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x1b, 0xe1, 0x01, 0xf0, 0x00]), rnd(4, 4)]))];
  let cc = 0, pts = 9000;
  for (const f of frames) {
    const es = esOf([f]);
    const hdr = Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, 0x01 | ((pts >> 14) & 0xfe), (pts >> 7) & 0xff, 0x01 | ((pts << 1) & 0xfe)]);
    const data = Buffer.concat([hdr, es]);
    let pos = 0, first = true;
    while (pos < data.length) {
      const adaptation = first ? Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) : null; // PCR placeholder (flags byte says PCR present)
      const room = 184 - (adaptation ? 1 + adaptation.length : 0);
      const n = Math.min(room, data.length - pos);
      out.push(tsPacket(0x101, first, data.subarray(pos, pos + n), { adaptation, cc: cc++ }));
      pos += n; first = false;
    }
    out.push(tsPacket(0x1fff, false, Buffer.alloc(184, 0xff)));
    pts += 3600;
  }
  return Buffer.concat(out);
}

const KEY = 'ABCDEF';
const encryptPs = (ps, mode, key = KEY) => transformBuffer(PsDecryptor, { key, encrypt: true, mode: { encrypted: true, ...mode } }, ps);
const encryptTs = (ts, mode, key = KEY) => transformBuffer(TsDecryptor, { key, encrypt: true, mode: { encrypted: true, ...mode } }, ts);
const CHUNKS = [1, 7, 188, 1000, 3, 16, 4096];

test('hikcrypto: 10-round Rijndael matches AES-128, stream key padding', () => {
  const key = crypto.randomBytes(16);
  const r = new Rijndael(key, 10), c = makeCipher(key, 10);
  for (let i = 0; i < 20; i++) {
    const blk = crypto.randomBytes(16);
    assert.deepStrictEqual(r.encryptBlock(blk), c.encryptBlock(blk));
    assert.deepStrictEqual(r.decryptBlock(c.encryptBlock(blk)), blk);
    assert.deepStrictEqual(c.decryptBlock(c.encryptBlock(blk)), blk);
    const r3 = makeCipher(key, 3);
    assert.deepStrictEqual(r3.decryptBlock(r3.encryptBlock(blk)), blk);
    assert.notDeepStrictEqual(r3.encryptBlock(blk), c.encryptBlock(blk));
  }
  assert.deepStrictEqual(streamKey('ABCDEF'), Buffer.from('ABCDEF\0\0\0\0\0\0\0\0\0\0', 'latin1'));
  assert.strictEqual(streamKey('0123456789abcdefXYZ').toString('latin1'), '0123456789abcdef');
});

for (const variant of [
  { name: 'H.264, all NALs, AES-10', frames: h264Frames(), mode: { codec: 'h264', hdr: 1, rounds: 10, inter: 'encrypted' } },
  { name: 'H.264, all NALs, AES-3 (Hikvision 3-round)', frames: h264Frames(11), mode: { codec: 'h264', hdr: 1, rounds: 3, inter: 'encrypted' } },
  { name: 'H.264, key frames only (P slices clear)', frames: h264Frames(21), mode: { codec: 'h264', hdr: 1, rounds: 10, inter: 'clear' } },
  { name: 'H.264, NAL header encrypted too', frames: h264Frames(31), mode: { codec: 'h264', hdr: 0, rounds: 10, inter: 'encrypted' } },
  { name: 'HEVC, all NALs, AES-10', frames: hevcFrames(), mode: { codec: 'hevc', hdr: 2, rounds: 10, inter: 'encrypted' } },
  { name: 'HEVC, key frames only', frames: hevcFrames(17), mode: { codec: 'hevc', hdr: 2, rounds: 3, inter: 'clear' } },
]) {
  test(`PS stream decryption: ${variant.name}`, async () => {
    const clear = buildPs(variant.frames, [60000, 1000, 7, 16, 17, 333]);
    const enc = await encryptPs(clear, variant.mode);
    assert.strictEqual(enc.data.length, clear.length, 'encryption keeps the length');
    assert.ok(!enc.data.equals(clear), 'ciphertext differs');
    // the parameter sets must be unreadable before decryption (sanity check of the fixture)
    const spsPos = clear.indexOf(Buffer.from([0, 0, 0, 1, variant.mode.codec === 'h264' ? 0x67 : 0x42]));
    assert.ok(spsPos > 0);
    assert.ok(!enc.data.subarray(spsPos + 4, spsPos + 24).equals(clear.subarray(spsPos + 4, spsPos + 24)));
    for (const chunks of [null, CHUNKS, [1], [188]]) {
      const dec = await transformBuffer(PsDecryptor, { key: KEY }, enc.data, chunks);
      assert.strictEqual(dec.data.length, clear.length);
      assert.ok(dec.data.equals(clear), `decrypted stream equals the original (chunks ${JSON.stringify(chunks)}) — first diff at ${dec.data.findIndex((b, i) => b !== clear[i])}`);
      assert.strictEqual(dec.state.encrypted, true);
      assert.strictEqual(dec.state.keyError, false);
      assert.strictEqual(dec.state.codec, variant.mode.codec);
      assert.strictEqual(dec.state.hdr, variant.mode.hdr);
      assert.strictEqual(dec.state.rounds, variant.mode.rounds);
    }
    // wrong key → reported, stream passed through untouched
    const wrong = await transformBuffer(PsDecryptor, { key: 'nope' }, enc.data, CHUNKS);
    assert.strictEqual(wrong.state.encrypted, true);
    if (variant.mode.hdr !== 0) assert.strictEqual(wrong.state.keyError, true, 'key error flagged');
    assert.ok(wrong.data.equals(enc.data));
    // no key → detection only
    const det = await transformBuffer(PsDecryptor, { key: null }, enc.data, CHUNKS);
    if (variant.mode.hdr !== 0) { assert.strictEqual(det.state.encrypted, true); assert.strictEqual(det.state.keyError, false); }
    assert.ok(det.data.equals(enc.data));
    // clear stream → recognised as clear, untouched (with and without key)
    const clr = await transformBuffer(PsDecryptor, { key: KEY }, clear, CHUNKS);
    assert.strictEqual(clr.state.encrypted, false);
    assert.ok(clr.data.equals(clear));
    const clr2 = await transformBuffer(PsDecryptor, { key: null }, clear, [50]);
    assert.strictEqual(clr2.state.encrypted, false);
  });
}

test('TS stream decryption (RTSP path): H.264 and HEVC round trips in random chunks', async () => {
  for (const [frames, mode] of [[h264Frames(41), { codec: 'h264', hdr: 1, rounds: 10, inter: 'encrypted' }], [hevcFrames(43), { codec: 'hevc', hdr: 2, rounds: 10, inter: 'clear' }]]) {
    const clear = buildTs(frames);
    assert.strictEqual(clear.length % 188, 0);
    const enc = await encryptTs(clear, mode);
    assert.ok(!enc.data.equals(clear));
    assert.strictEqual(enc.data.length, clear.length);
    for (const chunks of [null, CHUNKS, [188], [1]]) {
      const dec = await transformBuffer(TsDecryptor, { key: KEY }, enc.data, chunks);
      assert.ok(dec.data.equals(clear), `TS ${mode.codec} decrypted equals original (chunks ${JSON.stringify(chunks)}) — first diff at ${dec.data.findIndex((b, i) => b !== clear[i])}`);
      assert.strictEqual(dec.state.encrypted, true);
      assert.strictEqual(dec.state.codec, mode.codec);
    }
    const det = await transformBuffer(TsDecryptor, { key: null }, enc.data, [188]);
    assert.strictEqual(det.state.encrypted, true);
    const clr = await transformBuffer(TsDecryptor, { key: KEY }, clear, [100]);
    assert.strictEqual(clr.state.encrypted, false);
    assert.ok(clr.data.equals(clear));
  }
});

test('garbage and misaligned input pass through unchanged', async () => {
  const junk = Buffer.concat([rnd(5, 300), Buffer.from([0, 0, 1, 0xe0, 0, 3, 1, 2, 3]), rnd(6, 50)]);
  const r = await transformBuffer(PsDecryptor, { key: KEY }, junk, [13]);
  assert.ok(r.data.equals(junk));
  const ts = Buffer.concat([rnd(8, 100), buildTs(h264Frames(51)).subarray(0, 188 * 5), rnd(9, 20)]);
  const r2 = await transformBuffer(TsDecryptor, { key: KEY }, ts, [77]);
  assert.ok(r2.data.equals(ts));
});

// ---- real H.264 produced by ffmpeg, when a bundled ffmpeg is available (vendor/ffmpeg) ----
function findFfmpeg() {
  const cands = [process.env.UNIVMS_FFMPEG, path.join(__dirname, '..', 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || null;
}
const FFMPEG = findFfmpeg();
test('real ffmpeg H.264 PS/TS: encrypt → decrypt → identical and decodable', { skip: FFMPEG ? false : 'ffmpeg not available' }, async () => {
  for (const [fmt, Cls] of [['mpeg', PsDecryptor], ['mpegts', TsDecryptor]]) {
    const gen = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-bf', '0', '-bsf:v', 'filter_units=remove_types=6', '-f', fmt, 'pipe:1'], { maxBuffer: 64 << 20, windowsHide: true });
    assert.strictEqual(gen.status, 0, gen.stderr.toString());
    const clear = gen.stdout;
    assert.ok(clear.length > 10000);
    for (const inter of ['encrypted', 'clear']) {
      const enc = await transformBuffer(Cls, { key: KEY, encrypt: true, mode: { encrypted: true, codec: 'h264', hdr: 1, rounds: 10, inter } }, clear);
      assert.ok(!enc.data.equals(clear));
      const dec = await transformBuffer(Cls, { key: KEY }, enc.data, CHUNKS);
      assert.ok(dec.data.equals(clear), `${fmt}/${inter}: round trip identical — first diff at ${dec.data.findIndex((b, i) => b !== clear[i])}`);
      assert.strictEqual(dec.state.encrypted, true);
      assert.strictEqual(dec.state.inter, inter);
      const play = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', fmt, '-i', 'pipe:0', '-f', 'null', '-'], { input: dec.data, windowsHide: true });
      assert.strictEqual(play.status, 0, play.stderr.toString());
      assert.ok(!/error|invalid/i.test(play.stderr.toString()), play.stderr.toString());
    }
    const det = await transformBuffer(Cls, { key: null }, clear, [500]);
    assert.strictEqual(det.state.encrypted, false);
  }
});
