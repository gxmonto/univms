'use strict';
/*
 * Locates ffmpeg / ffprobe:
 *   1. explicit path from settings
 *   2. bundled binaries (resources/ffmpeg) in packaged builds
 *   3. vendor/ffmpeg/<platform>-<arch> during development
 *   4. anything on PATH
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const exe = process.platform === 'win32' ? '.exe' : '';
const cache = {};

function candidates(name, override) {
  const list = [];
  if (override) list.push(override);
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'ffmpeg', name + exe));
  list.push(path.join(__dirname, '..', '..', 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, name + exe));
  return list;
}

function fromPath(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch (_) {
    return null;
  }
}

function resolve(name, override) {
  const key = name + '|' + (override || '');
  if (cache[key] !== undefined) return cache[key];
  let found = null;
  for (const c of candidates(name, override)) {
    if (c && fs.existsSync(c)) { found = c; break; }
  }
  if (!found) found = fromPath(name);
  cache[key] = found;
  return found;
}

function version(bin) {
  if (!bin) return null;
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000 });
    const line = (r.stdout || '').split(/\r?\n/)[0] || '';
    return line.replace(/^ffmpeg version\s*/i, '').replace(/^ffprobe version\s*/i, '').trim() || null;
  } catch (_) {
    return null;
  }
}

function hwaccels(bin) {
  if (!bin) return [];
  try {
    const r = spawnSync(bin, ['-hide_banner', '-hwaccels'], { encoding: 'utf8', timeout: 5000 });
    return (r.stdout || '').split(/\r?\n/).slice(1).map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function status(settings = {}) {
  const ffmpeg = resolve('ffmpeg', settings.ffmpegPath);
  const ffprobe = resolve('ffprobe', settings.ffprobePath);
  return { ffmpeg, ffprobe, ffmpegVersion: version(ffmpeg), hwaccels: hwaccels(ffmpeg) };
}

function clearCache() { for (const k of Object.keys(cache)) delete cache[k]; }

module.exports = { resolve, status, clearCache };
