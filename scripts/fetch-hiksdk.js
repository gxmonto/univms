#!/usr/bin/env node
/*
 * Downloads the Hikvision Device Network SDK (free, from hikvision.com) and flattens the runtime libraries into
 *   vendor/hiksdk/win32-x64/   (HCNetSDK.dll, HCCore.dll, HCNetSDKCom/, ...)
 *   vendor/hiksdk/linux-x64/   (libhcnetsdk.so, libHCCore.so, HCNetSDKCom/, ...)
 * so electron-builder bundles them as resources/hiksdk. Not committed to git (size + Hikvision EULA: ship inside
 * your app only). The CDN requires a browser-like User-Agent.
 *
 * Usage: node scripts/fetch-hiksdk.js [win32|linux] [x64]
 * Set UNIVMS_HIKSDK_SKIP=1 to skip (the app then hides the "SDK / server port" connection type).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const VERSION = 'V6.1.9.4_build20220412';
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || 'x64';
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'vendor', 'hiksdk', `${platform}-${arch}`);
const main = platform === 'win32' ? 'HCNetSDK.dll' : 'libhcnetsdk.so';

if (process.env.UNIVMS_HIKSDK_SKIP) { console.log('[fetch-hiksdk] skipped'); process.exit(0); }
if (arch !== 'x64' || !['win32', 'linux'].includes(platform)) { console.log(`[fetch-hiksdk] no SDK for ${platform}-${arch}, skipping`); process.exit(0); }
if (fs.existsSync(path.join(outDir, main))) { console.log(`[fetch-hiksdk] already present: ${outDir}`); process.exit(0); }

const file = `EN-HCNetSDK${VERSION}_${platform === 'win32' ? 'win64' : 'linux64'}.zip`;
const url = `https://www.hikvision.com/content/dam/hikvision/en/support/download/sdk/device-network-sdk/${file}`;
const cacheDir = path.join(root, 'vendor', 'hiksdk', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const archive = path.join(cacheDir, file);

function download(u, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Referer: 'https://www.hikvision.com/us-en/support/download/sdk/', Accept: '*/*' };
    https.get(u, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) { res.resume(); return resolve(download(res.headers.location, dest, redirects + 1)); }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      if (!/zip|octet/.test(res.headers['content-type'] || '')) return reject(new Error(`Unexpected content type ${res.headers['content-type']} (bot check?)`));
      const total = Number(res.headers['content-length'] || 0); let got = 0, last = -1;
      const f = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; if (total) { const p = Math.floor((got / total) * 100); if (p !== last && p % 10 === 0) { last = p; process.stdout.write(`\r[fetch-hiksdk] ${p}%`); } } });
      res.pipe(f); f.on('finish', () => f.close(() => { process.stdout.write('\n'); resolve(); })); f.on('error', reject);
    }).on('error', reject);
  });
}
function extract(a, dest) {
  const sys32 = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
  const tar = sys32 && fs.existsSync(sys32) ? sys32 : 'tar';
  try { execFileSync(tar, ['-xf', a, '-C', dest], { stdio: 'inherit' }); }
  catch (e) { if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${a}' -DestinationPath '${dest}'`], { stdio: 'inherit' }); else execFileSync('unzip', ['-q', '-o', a, '-d', dest], { stdio: 'inherit' }); }
}
const walk = (d, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p, acc) : acc.push(p); } return acc; };

/** Pruned runtime zip hosted as a release asset of the private univms-assets repository (hikvision.com blocks CI runner IPs). */
function ghCliToken() { try { return require('child_process').execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return ''; } }
const ASSET_TAG = 'hiksdk-v6.1.9.4';
const ASSET_REPO = process.env.UNIVMS_HIKSDK_REPO || 'gxmonto/univms-assets'; // private; needs ASSETS_TOKEN (read-only) or a gh login
function githubJson(u, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'univms-build', Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    https.get(u, { headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`GitHub API HTTP ${res.statusCode}`)); try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
function githubDownload(u, dest, token, redirects = 0) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'univms-build', Accept: 'application/octet-stream' };
    if (token && !/objects\.githubusercontent|release-assets/.test(u)) headers.Authorization = `Bearer ${token}`;
    https.get(u, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) { res.resume(); return resolve(githubDownload(res.headers.location, dest, token, redirects + 1)); }
      if (res.statusCode !== 200) return reject(new Error(`asset HTTP ${res.statusCode}`));
      const f = fs.createWriteStream(dest); res.pipe(f); f.on('finish', () => f.close(resolve)); f.on('error', reject);
    }).on('error', reject);
  });
}
async function fromGithubAsset() {
  const token = process.env.ASSETS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ghCliToken() || '';
  let rel;
  try { rel = await githubJson(`https://api.github.com/repos/${ASSET_REPO}/releases/tags/${ASSET_TAG}`, token); }
  catch (e) {
    // diagnose without printing the token: who is it, can it see the repo at all?
    const src = process.env.ASSETS_TOKEN ? 'ASSETS_TOKEN' : process.env.GH_TOKEN ? 'GH_TOKEN' : process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : token ? 'gh auth token' : 'none';
    let who = 'unknown', repoVisible = false;
    try { who = (await githubJson('https://api.github.com/user', token)).login; } catch (_) {}
    try { await githubJson(`https://api.github.com/repos/${ASSET_REPO}`, token); repoVisible = true; } catch (_) {}
    throw new Error(`${e.message} — token source: ${src}, token user: ${who}, can see ${ASSET_REPO}: ${repoVisible ? 'yes (release/tag missing?)' : 'NO — give the token "Contents: read" on that repository'}`);
  }
  const name = `hiksdk-${platform}-${arch}.zip`;
  const asset = (rel.assets || []).find((a) => a.name === name);
  if (!asset) throw new Error(`asset ${name} not found in release ${ASSET_TAG}`);
  const zip = path.join(cacheDir, name);
  if (!(fs.existsSync(zip) && fs.statSync(zip).size === asset.size)) {
    console.log(`[fetch-hiksdk] downloading ${name} from ${ASSET_REPO} release ${ASSET_TAG}`);
    await githubDownload(asset.url, zip + '.part', token);
    fs.renameSync(zip + '.part', zip);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  extract(zip, outDir);
  if (platform !== 'win32') for (const f of walk(outDir)) fs.chmodSync(f, 0o755);
  console.log(`[fetch-hiksdk] runtime ready from release asset -> ${outDir}`);
}

(async () => {
  try { await fromGithubAsset(); return; } catch (e) { console.log(`[fetch-hiksdk] release asset unavailable (${e.message}); trying hikvision.com`); }
  if (!(fs.existsSync(archive) && fs.statSync(archive).size > 10_000_000)) {
    console.log(`[fetch-hiksdk] downloading ${url}`);
    await download(url, archive + '.part');
    fs.renameSync(archive + '.part', archive);
  } else console.log(`[fetch-hiksdk] using cached ${archive}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-hiksdk-'));
  console.log('[fetch-hiksdk] extracting');
  extract(archive, tmp);
  const libDir = path.dirname(walk(tmp).find((f) => path.basename(f) === main) || '');
  if (!libDir) throw new Error(`${main} not found in archive`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // runtime only: skip demos, import libs and the local-render stack (PlayCtrl & co.) which UniVMS does not use
  const skipDir = /ClientDemoDll/i;
  const skipFile = /\.(lib|exe|zip|pdb)$|^(PlayCtrl|SuperRender|MP_Render|HXVA|YUVProcess|GdiPlus|libmmd|AudioRender|OpenAL32|libPlayCtrl\.so|libSuperRender\.so|libAudioRender\.so|libopenal\.so\.1)/i;
  let n = 0, size = 0;
  for (const f of walk(libDir)) {
    const rel = path.relative(libDir, f);
    if (skipDir.test(rel) || skipFile.test(path.basename(f))) continue;
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f, dst);
    if (platform !== 'win32') fs.chmodSync(dst, 0o755);
    n++; size += fs.statSync(dst).size;
  }
  const lic = walk(tmp).find((f) => /license|eula/i.test(path.basename(f)) && /\.(txt|pdf|md)$/i.test(f));
  if (lic) fs.copyFileSync(lic, path.join(outDir, 'LICENSE-hikvision' + path.extname(lic)));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`[fetch-hiksdk] ${n} files, ${(size / 1048576).toFixed(1)} MB -> ${outDir}`);
})().catch((e) => {
  console.error('[fetch-hiksdk] failed:', e.message);
  if (process.env.UNIVMS_HIKSDK_REQUIRED) process.exit(1);
  console.error('[fetch-hiksdk] continuing without the Hikvision SDK (the app hides the SDK connection type). Set UNIVMS_HIKSDK_REQUIRED=1 to fail instead.');
});
