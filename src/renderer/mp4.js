// Minimal fMP4 utilities: split a byte stream into complete top-level boxes and
// extract MSE codec strings from the moov box.

const td = new TextDecoder('ascii');
const type4 = (u8, off) => td.decode(u8.subarray(off, off + 4));
const u32 = (u8, off) => ((u8[off] << 24) >>> 0) + (u8[off + 1] << 16) + (u8[off + 2] << 8) + u8[off + 3];

export class BoxSplitter {
  constructor() { this.buf = new Uint8Array(0); }
  /** Push bytes; returns array of complete top-level boxes as {type, data} */
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out = [];
    let off = 0;
    while (this.buf.length - off >= 8) {
      let size = u32(this.buf, off);
      const type = type4(this.buf, off + 4);
      let hdr = 8;
      if (size === 1) {
        if (this.buf.length - off < 16) break;
        const hi = u32(this.buf, off + 8), lo = u32(this.buf, off + 12);
        size = hi * 4294967296 + lo;
        hdr = 16;
      } else if (size === 0) {
        size = this.buf.length - off; // to end of stream (shouldn't happen for fMP4)
      }
      if (size < hdr) { // corrupt; resync by dropping a byte
        off += 1;
        continue;
      }
      if (this.buf.length - off < size) break;
      out.push({ type, data: this.buf.subarray(off, off + size) });
      off += size;
    }
    this.buf = this.buf.subarray(off);
    return out;
  }
  reset() { this.buf = new Uint8Array(0); }
}

function* children(u8, start, end) {
  let off = start;
  while (end - off >= 8) {
    let size = u32(u8, off);
    const type = type4(u8, off + 4);
    let hdr = 8;
    if (size === 1) { size = u32(u8, off + 8) * 4294967296 + u32(u8, off + 12); hdr = 16; }
    if (size === 0) size = end - off;
    if (size < hdr || off + size > end) return;
    yield { type, start: off + hdr, end: off + size };
    off += size;
  }
}

function findChild(u8, start, end, type) {
  for (const c of children(u8, start, end)) if (c.type === type) return c;
  return null;
}

function hevcCodecString(u8, s, e, fourcc) {
  // HEVCDecoderConfigurationRecord
  const b1 = u8[s + 1];
  const profileSpace = b1 >> 6, tier = (b1 >> 5) & 1, profileIdc = b1 & 0x1f;
  const compat = u32(u8, s + 2);
  // reverse bit order of 32-bit compat flags
  let rev = 0;
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) rev |= 1 << (31 - i);
  rev >>>= 0;
  const constraint = Array.from(u8.subarray(s + 6, s + 12));
  const level = u8[s + 12];
  while (constraint.length && constraint[constraint.length - 1] === 0) constraint.pop();
  const parts = [fourcc, `${['', 'A', 'B', 'C'][profileSpace]}${profileIdc}`, rev.toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${level}`];
  if (constraint.length) parts.push(...constraint.map((b) => b.toString(16).toUpperCase().padStart(2, '0')));
  return parts.join('.');
}

/** Returns { mime, video: {codec, width, height}, audio: {codec} } */
export function parseMoov(moov) {
  const u8 = moov;
  const result = { video: null, audio: null };
  for (const trak of children(u8, 8, u8.length)) {
    if (trak.type !== 'trak') continue;
    const mdia = findChild(u8, trak.start, trak.end, 'mdia'); if (!mdia) continue;
    const minf = findChild(u8, mdia.start, mdia.end, 'minf'); if (!minf) continue;
    const stbl = findChild(u8, minf.start, minf.end, 'stbl'); if (!stbl) continue;
    const stsd = findChild(u8, stbl.start, stbl.end, 'stsd'); if (!stsd) continue;
    // stsd: version/flags (4) + entry_count (4)
    for (const entry of children(u8, stsd.start + 8, stsd.end)) {
      const t = entry.type;
      if (['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v'].includes(t)) {
        const width = (u8[entry.start + 24] << 8) | u8[entry.start + 25];
        const height = (u8[entry.start + 26] << 8) | u8[entry.start + 27];
        const cfgStart = entry.start + 78;
        let codec = t;
        if (t === 'avc1' || t === 'avc3') {
          const avcC = findChild(u8, cfgStart, entry.end, 'avcC');
          if (avcC) codec = `${t}.${[u8[avcC.start + 1], u8[avcC.start + 2], u8[avcC.start + 3]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        } else if (t === 'hvc1' || t === 'hev1') {
          const hvcC = findChild(u8, cfgStart, entry.end, 'hvcC');
          if (hvcC) codec = hevcCodecString(u8, hvcC.start, hvcC.end, t);
        } else if (t === 'mp4v') codec = 'mp4v.20.9';
        result.video = { codec, width, height, fourcc: t };
      } else if (t === 'mp4a') {
        result.audio = { codec: 'mp4a.40.2' };
      } else if (['ulaw', 'alaw', 'sowt', 'twos', 'lpcm', 'samr'].includes(t)) {
        result.audio = { codec: t, unsupported: true };
      }
    }
  }
  const codecs = [];
  if (result.video) codecs.push(result.video.codec);
  if (result.audio && !result.audio.unsupported) codecs.push(result.audio.codec);
  result.mime = `video/mp4; codecs="${codecs.join(', ')}"`;
  return result;
}
