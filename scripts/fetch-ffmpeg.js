#!/usr/bin/env node
/*
 * Downloads static ffmpeg + ffprobe builds (BtbN/FFmpeg-Builds, GPL) into
 *   vendor/ffmpeg/<platform>-<arch>/ffmpeg[.exe], ffprobe[.exe]
 * so electron-builder can bundle them as extraResources.
 *
 * Usage: node scripts/fetch-ffmpeg.js [win32|linux] [x64]
 * Set UNIVMS_FFMPEG_SKIP=1 to skip (the app then falls back to ffmpeg on PATH).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || 'x64';
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'vendor', 'ffmpeg', `${platform}-${arch}`);
const exe = platform === 'win32' ? '.exe' : '';

if (process.env.UNIVMS_FFMPEG_SKIP) {
  console.log('[fetch-ffmpeg] skipped (UNIVMS_FFMPEG_SKIP set)');
  process.exit(0);
}
if (fs.existsSync(path.join(outDir, 'ffmpeg' + exe))) {
  console.log(`[fetch-ffmpeg] already present: ${outDir}`);
  process.exit(0);
}

const urls = {
  'win32-x64': 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
  'linux-x64': 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz',
  'linux-arm64': 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linuxarm64-gpl.tar.xz',
};
const url = urls[`${platform}-${arch}`];
if (!url) {
  console.error(`[fetch-ffmpeg] no download URL for ${platform}-${arch}`);
  process.exit(1);
}

function download(u, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { 'User-Agent': 'univms-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, lastPct = -1;
      const f = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`\r[fetch-ffmpeg] ${pct}%`); }
        }
      });
      res.pipe(f);
      f.on('finish', () => f.close(() => { process.stdout.write('\n'); resolve(); }));
      f.on('error', reject);
    }).on('error', reject);
  });
}

function extract(archive, dest) {
  // Prefer bsdtar (handles zip and tar.xz). On Windows the one in System32 is bsdtar; Git's GNU tar
  // misreads "C:\..." as a remote host, so avoid whatever happens to be first on PATH.
  const sys32 = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
  const tar = sys32 && fs.existsSync(sys32) ? sys32 : 'tar';
  try {
    execFileSync(tar, ['-xf', archive, '-C', dest], { stdio: 'inherit' });
  } catch (e) {
    if (process.platform === 'win32' && archive.endsWith('.zip')) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${archive}' -DestinationPath '${dest}'`], { stdio: 'inherit' });
    } else if (archive.endsWith('.zip')) {
      execFileSync('unzip', ['-q', '-o', archive, '-d', dest], { stdio: 'inherit' });
    } else {
      execFileSync('tar', ['--force-local', '-xf', archive, '-C', dest], { stdio: 'inherit' });
    }
  }
}

(async () => {
  const cacheDir = path.join(root, 'vendor', 'ffmpeg', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `${platform}-${arch}-${path.basename(url)}`);
  if (fs.existsSync(archive) && fs.statSync(archive).size > 1_000_000) {
    console.log(`[fetch-ffmpeg] using cached archive ${archive}`);
  } else {
    console.log(`[fetch-ffmpeg] downloading ${url}`);
    await download(url, archive + '.part');
    fs.renameSync(archive + '.part', archive);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-ffmpeg-'));
  console.log('[fetch-ffmpeg] extracting');
  extract(archive, tmp);
  const walk = (d, acc = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, acc); else acc.push(p);
    }
    return acc;
  };
  const files = walk(tmp);
  fs.mkdirSync(outDir, { recursive: true });
  // ffprobe is ~170 MB in the GPL builds and UniVMS does not call it; bundle it only on request.
  const wanted = process.env.UNIVMS_BUNDLE_FFPROBE ? ['ffmpeg', 'ffprobe'] : ['ffmpeg'];
  for (const name of wanted) {
    const src = files.find((f) => path.basename(f) === name + exe);
    if (!src) throw new Error(`${name}${exe} not found in archive`);
    const dst = path.join(outDir, name + exe);
    fs.copyFileSync(src, dst);
    if (platform !== 'win32') fs.chmodSync(dst, 0o755);
    console.log(`[fetch-ffmpeg] -> ${dst}`);
  }
  const lic = files.find((f) => /LICENSE/i.test(path.basename(f)));
  if (lic) fs.copyFileSync(lic, path.join(outDir, 'LICENSE-ffmpeg.txt'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('[fetch-ffmpeg] done');
})().catch((e) => { console.error('[fetch-ffmpeg] failed:', e.message); process.exit(1); });
