'use strict';
/*
 * Windows installer builds download automatically and install on exit or restart.
 * Portable and Linux builds check automatically and offer a package download link.
 */
const { EventEmitter } = require('events');
const https = require('https');
const fs = require('fs');
const { app, shell } = require('electron');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 20 * 1000;
const UPDATE_FEED = { provider: 'github', owner: 'gxmonto', repo: 'univms' };
const REPO_PATH = `${UPDATE_FEED.owner}/${UPDATE_FEED.repo}`;
const RELEASES_URL = `https://github.com/${REPO_PATH}/releases`;

function compareVersions(a, b) {
  const p = (v) => String(v).trim().replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': `UniVMS/${app.getVersion()}`, Accept: 'application/vnd.github+json' };
    const req = https.get(`https://api.github.com/repos/${REPO_PATH}/releases/latest`, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from update server`));
        return;
      }
      res.on('error', reject);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid response from update server')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timed out')));
  });
}

function linuxPackageKind() {
  if (process.platform !== 'linux') return null;
  const { execFileSync } = require('child_process');
  const owns = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 3000 }); return true; } catch (_) { return false; } };
  if (owns('rpm', ['-q', 'univms'])) return 'rpm';
  if (owns('dpkg-query', ['-W', 'univms'])) return 'deb';
  try {
    const os = fs.readFileSync('/etc/os-release', 'utf8');
    const like = `${(/^ID=(.*)$/m.exec(os) || [])[1] || ''} ${(/^ID_LIKE=(.*)$/m.exec(os) || [])[1] || ''}`.toLowerCase();
    if (/fedora|rhel|centos|suse|opensuse|mageia/.test(like)) return 'rpm';
    if (/debian|ubuntu/.test(like)) return 'deb';
  } catch (_) {}
  return 'deb';
}
const isWindowsPortable = () => process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;

function friendlyError(err) {
  const m = String((err && err.message) || err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out|net::/i.test(m)) return 'Could not reach the update server.';
  if (/404|No release found/i.test(m)) return 'No UniVMS release was found.';
  if (/sha512|checksum/i.test(m)) return 'Downloaded file failed verification. Please try again.';
  return m.length > 200 ? m.slice(0, 200) + '…' : m;
}

class Updater extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.status = { state: 'idle', current: app.getVersion(), version: null, notes: null, progress: null, error: null, lastCheck: null, manualDownloadUrl: null, packageKind: null, pendingInstall: false, releaseUrl: null };
    this._auto = null;
    this._timer = null;
    this._supported = app.isPackaged;
    this._manualOnly = (process.platform === 'linux') || isWindowsPortable();
  }

  _set(patch) { this.status = { ...this.status, ...patch }; this.emit('status', this.status); }

  _autoUpdater() {
    if (this._auto) return this._auto;
    if (!this._supported || this._manualOnly) return null;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = { info: (m) => this.log('updater', String(m)), warn: (m) => this.log('updater warn', String(m)), error: (m) => this.log('updater error', String(m)), debug: () => {} };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = true; // a published rollback (lower version) also reaches installed copies
    autoUpdater.setFeedURL({ ...UPDATE_FEED });
    autoUpdater.on('checking-for-update', () => this._set({ state: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => {
      const notes = notesText(info.releaseNotes);
      this._set({ state: 'downloading', version: info.version, notes, progress: null, releaseUrl: `${RELEASES_URL}/tag/v${info.version}` });
    });
    autoUpdater.on('update-not-available', (info) => this._set({ state: 'up-to-date', version: info && info.version, progress: null }));
    autoUpdater.on('download-progress', (p) => this._set({ state: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bps: p.bytesPerSecond } }));
    autoUpdater.on('update-downloaded', (info) => this._set({ state: 'downloaded', version: info.version, notes: notesText(info.releaseNotes) || this.status.notes, progress: null, pendingInstall: true }));
    autoUpdater.on('error', (err) => this._set({ state: 'error', error: friendlyError(err), progress: null }));
    this._auto = autoUpdater;
    return autoUpdater;
  }

  start() {
    if (!this._supported) { this._set({ state: 'disabled', error: 'Updates only work in the installed app, not when running from source.' }); return; }
    this._schedule();
  }
  _schedule() {
    clearTimeout(this._timer); clearInterval(this._timer); this._timer = null;
    if (!this._supported) return;
    this._timer = setTimeout(() => {
      this.check().catch(() => {});
      this._timer = setInterval(() => this.check().catch(() => {}), CHECK_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
  }

  async check() {
    if (!this._supported) return this.status;
    if (['checking', 'downloading', 'downloaded'].includes(this.status.state)) return this.status;
    this._set({ state: 'checking', error: null, lastCheck: Date.now() });
    try {
      if (this._manualOnly) await this._checkManual();
      else {
        const auto = this._autoUpdater();
        const r = await auto.checkForUpdates();
        if (!r) this._set({ state: 'up-to-date' });
        // electron-updater also reports download errors through its error event.
        r?.downloadPromise?.catch(() => {});
      }
    } catch (e) {
      this._set({ state: 'error', error: friendlyError(e) });
    }
    return this.status;
  }

  /** Portable exe / .deb / .rpm: read the latest GitHub release and point at the right asset. */
  async _checkManual() {
    const rel = await fetchLatestRelease();
    const tag = rel.tag_name;
    if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Release has an invalid version tag');
    const version = tag.slice(1);
    if (compareVersions(version, app.getVersion()) <= 0) { this._set({ state: 'up-to-date', version, manualDownloadUrl: null }); return; }
    const kind = isWindowsPortable() ? 'portable' : linuxPackageKind();
    const want = kind === 'portable' ? /portable\.exe$/i : kind === 'rpm' ? /\.rpm$/i : /\.deb$/i;
    const asset = (rel.assets || []).find((a) => want.test(a.name));
    const releaseUrl = `${RELEASES_URL}/tag/${tag}`;
    const manualDownloadUrl = asset ? `${RELEASES_URL}/download/${tag}/${encodeURIComponent(asset.name)}` : releaseUrl;
    this._set({ state: 'available', version, notes: rel.body || null, packageKind: kind, manualDownloadUrl, releaseUrl });
  }

  async download() {
    if (this._manualOnly && this.status.state === 'available' && this.status.manualDownloadUrl) await shell.openExternal(this.status.manualDownloadUrl);
    return this.status;
  }

  install() {
    if (this.status.state !== 'downloaded' || !this._auto) return { ok: false, reason: 'Nothing downloaded yet.' };
    setImmediate(() => this._auto.quitAndInstall(true, true)); // silent NSIS install (/S), relaunch when done — no installer wizard
    return { ok: true };
  }

  stop() { clearTimeout(this._timer); clearInterval(this._timer); this._timer = null; }
}

function notesText(notes) {
  if (!notes) return null;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => `${n.version}\n${n.note || ''}`).join('\n\n');
  return null;
}

module.exports = { Updater, compareVersions };
