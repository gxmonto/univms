#!/usr/bin/env node
/*
 * Downloads the Neolink runtime (our build from github.com/gxmonto/neolink + a pruned GStreamer runtime) into
 *   vendor/neolink/win32-x64/   (neolink.exe, OpenSSL + GStreamer DLLs, plugins/)
 * from a release asset of the private univms-assets repository, so electron-builder bundles it as resources/neolink.
 * Windows only for now (Linux users would need a system GStreamer). Usage: node scripts/fetch-neolink.js [win32] [x64]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ASSET_TAG = 'neolink-v0.6.3-univms2';
const ASSET_REPO = process.env.UNIVMS_ASSETS_REPO || 'gxmonto/univms-assets';
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || 'x64';
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'vendor', 'neolink', `${platform}-${arch}`);

if (process.env.UNIVMS_NEOLINK_SKIP) { console.log('[fetch-neolink] skipped'); process.exit(0); }
if (platform !== 'win32' || arch !== 'x64') { console.log(`[fetch-neolink] no runtime for ${platform}-${arch}, skipping`); process.exit(0); }
if (fs.existsSync(path.join(outDir, 'neolink.exe'))) { console.log(`[fetch-neolink] already present: ${outDir}`); process.exit(0); }

const ghCliToken = () => { try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return ''; } };
const token = process.env.ASSETS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ghCliToken() || '';
const get = (u, accept, dest, redirects = 0) => new Promise((resolve, reject) => {
  const headers = { 'User-Agent': 'univms-build', Accept: accept };
  if (token && !/objects\.githubusercontent|release-assets/.test(u)) headers.Authorization = `Bearer ${token}`;
  https.get(u, { headers }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) { res.resume(); return resolve(get(res.headers.location, accept, dest, redirects + 1)); }
    if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${u.replace(/\?.*/, '')}`)); }
    if (dest) { const f = fs.createWriteStream(dest); res.pipe(f); f.on('finish', () => f.close(resolve)); f.on('error', reject); return; }
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

(async () => {
  const rel = await get(`https://api.github.com/repos/${ASSET_REPO}/releases/tags/${ASSET_TAG}`, 'application/vnd.github+json');
  const name = `neolink-${platform}-${arch}.zip`;
  const asset = (rel.assets || []).find((a) => a.name === name);
  if (!asset) throw new Error(`asset ${name} not found in release ${ASSET_TAG}`);
  const cacheDir = path.join(root, 'vendor', 'neolink', '.cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, name);
  if (!(fs.existsSync(zip) && fs.statSync(zip).size === asset.size)) {
    console.log(`[fetch-neolink] downloading ${name} from ${ASSET_REPO} release ${ASSET_TAG}`);
    await get(asset.url, 'application/octet-stream', zip + '.part');
    fs.renameSync(zip + '.part', zip);
  }
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(fs.existsSync(sys32) ? sys32 : 'tar', ['-xf', zip, '-C', outDir], { stdio: 'inherit' });
  console.log(`[fetch-neolink] runtime ready -> ${outDir}`);
})().catch((e) => {
  console.error('[fetch-neolink] failed:', e.message);
  if (process.env.UNIVMS_NEOLINK_REQUIRED) process.exit(1);
  console.error('[fetch-neolink] continuing without Neolink (the app hides the "Reolink via UID" device type). Set UNIVMS_NEOLINK_REQUIRED=1 to fail instead.');
});
