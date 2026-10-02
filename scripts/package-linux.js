#!/usr/bin/env node
/*
 * Wraps dist/linux-unpacked (produced by `electron-builder --linux dir`) into .deb and .rpm using nfpm.
 * nfpm is a single Go binary that works on Windows/macOS/Linux, so Linux packages can be built anywhere
 * (electron-builder's own deb/rpm targets need fpm + rpmbuild, which only exist on Linux/macOS).
 *
 * Usage: node scripts/package-linux.js [--unpacked dist/linux-unpacked] [--out dist]
 * nfpm lookup: $NFPM, vendor/tools/nfpm(.exe), PATH. Get it from https://github.com/goreleaser/nfpm/releases
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const unpacked = path.resolve(root, opt('--unpacked', 'dist/linux-unpacked'));
const outDir = path.resolve(root, opt('--out', 'dist'));
const exe = process.platform === 'win32' ? '.exe' : '';

function findNfpm() {
  const cands = [process.env.NFPM, path.join(root, 'vendor', 'tools', 'nfpm' + exe)].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['nfpm'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/)[0].trim() || null;
  } catch (_) { return null; }
}

const nfpm = findNfpm();
if (!nfpm) { console.error('[package-linux] nfpm not found. Set NFPM or put nfpm into vendor/tools/'); process.exit(1); }
if (!fs.existsSync(unpacked)) { console.error(`[package-linux] ${unpacked} missing. Run: npx electron-builder --linux dir --x64`); process.exit(1); }

// Make sure the Linux ffmpeg is inside the unpacked tree (electron-builder skips extraResources that did not exist at build time)
const ffSrc = path.join(root, 'vendor', 'ffmpeg', 'linux-x64');
const ffDst = path.join(unpacked, 'resources', 'ffmpeg');
if (fs.existsSync(path.join(ffSrc, 'ffmpeg')) && !fs.existsSync(path.join(ffDst, 'ffmpeg'))) {
  fs.mkdirSync(ffDst, { recursive: true });
  for (const f of fs.readdirSync(ffSrc)) fs.copyFileSync(path.join(ffSrc, f), path.join(ffDst, f));
  console.log('[package-linux] copied ffmpeg into resources/ffmpeg');
}
if (!fs.existsSync(path.join(ffDst, 'ffmpeg'))) console.warn('[package-linux] WARNING: no bundled ffmpeg; the package will rely on ffmpeg from PATH');

// Executable name chosen by electron-builder (package.json name unless linux.executableName is set)
const exeName = fs.existsSync(path.join(unpacked, pkg.name)) ? pkg.name : fs.readdirSync(unpacked).find((f) => !f.includes('.') && fs.statSync(path.join(unpacked, f)).isFile() && !['LICENSE', 'LICENSES', 'chrome-sandbox', 'chrome_crashpad_handler', 'version'].includes(f));
if (!exeName) { console.error('[package-linux] could not determine the Electron executable name in ' + unpacked); process.exit(1); }
const installDir = '/opt/UniVMS';
const EXEC = new Set([exeName, 'chrome-sandbox', 'chrome_crashpad_handler', 'ffmpeg', 'ffprobe']); // .so files get 0755 below

// Explicit content list so executable bits are right even when packaging from Windows
const contents = [];
const walk = (dir, rel = '') => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name), r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) { walk(p, r); continue; }
    const base = ent.name;
    const mode = base === 'chrome-sandbox' ? '4755' : EXEC.has(base) || base.endsWith('.so') || /\.so\.\d+$/.test(base) ? '0755' : '0644';
    contents.push({ src: p.replace(/\\/g, '/'), dst: `${installDir}/${r}`, file_info: { mode: parseInt(mode, 8) === parseInt('4755', 8) ? 0o4755 : parseInt(mode, 8), owner: 'root', group: 'root' } });
  }
};
walk(unpacked);

// desktop entry + icons
const stage = path.join(outDir, 'linux-stage');
fs.mkdirSync(stage, { recursive: true });
const desktop = `[Desktop Entry]\nName=UniVMS\nComment=Video management client for Hikvision and DW Spectrum\nExec=${installDir}/${exeName} %U\nTerminal=false\nType=Application\nIcon=univms\nStartupWMClass=UniVMS\nCategories=AudioVideo;Video;Network;\n`;
fs.writeFileSync(path.join(stage, 'univms.desktop'), desktop);
contents.push({ src: path.join(stage, 'univms.desktop').replace(/\\/g, '/'), dst: '/usr/share/applications/univms.desktop', file_info: { mode: 0o644 } });
for (const f of fs.readdirSync(path.join(root, 'build', 'icons'))) {
  const m = /^(\d+)x\1\.png$/.exec(f);
  if (m) contents.push({ src: path.join(root, 'build', 'icons', f).replace(/\\/g, '/'), dst: `/usr/share/icons/hicolor/${m[1]}x${m[1]}/apps/univms.png`, file_info: { mode: 0o644 } });
}
contents.push({ src: `${installDir}/${exeName}`, dst: '/usr/bin/univms', type: 'symlink' });

const postinstall = path.join(stage, 'postinstall.sh');
fs.writeFileSync(postinstall, `#!/bin/sh\nset -e\nchmod 4755 ${installDir}/chrome-sandbox 2>/dev/null || true\nchmod 755 ${installDir}/${exeName} ${installDir}/resources/ffmpeg/ffmpeg 2>/dev/null || true\ncommand -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications >/dev/null 2>&1 || true\ncommand -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || true\nexit 0\n`);
const postremove = path.join(stage, 'postremove.sh');
fs.writeFileSync(postremove, `#!/bin/sh\ncommand -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications >/dev/null 2>&1 || true\nexit 0\n`);

const yaml = (o, ind = '') => Object.entries(o).map(([k, v]) => {
  if (Array.isArray(v)) return `${ind}${k}:\n` + v.map((it) => (typeof it === 'object' ? `${ind}  -\n${yaml(it, ind + '    ')}` : `${ind}  - ${JSON.stringify(it)}`)).join('\n');
  if (v && typeof v === 'object') return `${ind}${k}:\n${yaml(v, ind + '  ')}`;
  return `${ind}${k}: ${typeof v === 'number' ? '0' + v.toString(8) : JSON.stringify(String(v))}`;
}).join('\n');

const config = {
  name: 'univms',
  arch: 'amd64',
  platform: 'linux',
  version: pkg.version,
  section: 'video',
  priority: 'optional',
  maintainer: pkg.author,
  description: pkg.description,
  vendor: 'SightWatch',
  homepage: pkg.homepage || 'https://sightwatch.com',
  license: pkg.license,
  depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0'],
  contents,
  scripts: { postinstall: postinstall.replace(/\\/g, '/'), postremove: postremove.replace(/\\/g, '/') },
  overrides: {
    rpm: { depends: ['gtk3', 'libnotify', 'nss', 'libXScrnSaver', 'libXtst', 'xdg-utils', 'at-spi2-core', 'libuuid', 'libsecret'] },
  },
  rpm: { group: 'Applications/Multimedia', summary: 'Multi-vendor video management client (Hikvision, DW Spectrum)', compression: 'xz' },
  deb: { compression: 'xz' },
};
const cfgPath = path.join(stage, 'nfpm.yaml');
fs.writeFileSync(cfgPath, yaml(config) + '\n');

fs.mkdirSync(outDir, { recursive: true });
for (const fmt of ['deb', 'rpm']) {
  const target = path.join(outDir, fmt === 'deb' ? `UniVMS-${pkg.version}-linux-amd64.deb` : `UniVMS-${pkg.version}-linux-x86_64.rpm`);
  console.log(`[package-linux] building ${fmt} -> ${target}`);
  execFileSync(nfpm, ['package', '--config', cfgPath, '--packager', fmt, '--target', target], { stdio: 'inherit' });
  console.log(`[package-linux] ${fmt}: ${(fs.statSync(target).size / 1048576).toFixed(1)} MB`);
}
console.log('[package-linux] done');
