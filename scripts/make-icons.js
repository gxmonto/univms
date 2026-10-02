#!/usr/bin/env node
// Generates build/icon.ico and build/icons/<N>x<N>.png without external tools.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // corner radius
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5)) { px[i + 3] = 0; continue; }
      const t = (x + y) / (2 * size);
      // gradient from #2f8fff to #7cc4ff
      let R = Math.round(0x2f + (0x7c - 0x2f) * t), G = Math.round(0x8f + (0xc4 - 0x8f) * t), B = 0xff;
      // camera lens: dark ring + white dot
      const cx = size / 2, cy = size / 2, d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const lensR = size * 0.27, ringW = size * 0.07;
      if (d < lensR) {
        if (d > lensR - ringW) { R = 0x0f; G = 0x13; B = 0x18; }
        else if (d < lensR * 0.42) { R = 0xff; G = 0xff; B = 0xff; }
        else { R = 0x15; G = 0x1b; B = 0x22; }
      }
      // play triangle cut in bottom-right as a "live" hint
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngs = {};
for (const s of sizes) { pngs[s] = render(s); fs.writeFileSync(path.join(out, 'icons', `${s}x${s}.png`), pngs[s]); }
fs.writeFileSync(path.join(out, 'icon.png'), pngs[512]);

// ICO with embedded PNGs (Vista+)
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
const entries = []; const datas = [];
let offset = 6 + 16 * icoSizes.length;
for (const s of icoSizes) {
  const d = pngs[s];
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(d.length, 8); e.writeUInt32LE(offset, 12);
  entries.push(e); datas.push(d); offset += d.length;
}
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...entries, ...datas]));
console.log('icons written to', out);
