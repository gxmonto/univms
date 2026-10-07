'use strict';
/*
 * Update checking and installation (same model as TwinLine):
 *   - Windows installer builds: electron-updater against GitHub Releases (latest.yml), download on request,
 *     install on restart.
 *   - Windows portable exe and Linux .deb/.rpm cannot replace themselves: we read the latest GitHub release
 *     through the API and hand the user a direct download link for the right file.
 *   - Modes: 'ask' (default: notify, download when asked), 'auto' (download silently, offer restart), 'off'.
 *   - Optional GitHub token for private repositories (the univms repo is private unless made public).
 */
const { EventEmitter } = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 20 * 1000;
const DEFAULT_REPO = { owner: 'gxmonto', repo: 'univms' };

function compareVersions(a, b) {
  const p = (v) => String(v).trim().replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

function feedFromUrl(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(u);
  if (gh) return { provider: 'github', owner: gh[1], repo: gh[2].replace(/\.git$/, '') };
  if (/^https:\/\//i.test(u)) return { provider: 'generic', url: u.replace(/\/+$/, '') };
  throw new Error('Update server must be an https:// URL (GitHub repository or a folder with latest.yml).');
}

function fetchJson(url, token, redirects = 5) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': `UniVMS/${app.getVersion()}`, Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) { res.resume(); return resolve(fetchJson(res.headers.location, token, redirects - 1)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(res.statusCode === 404 ? 'No release found (private repository without token, or no releases yet).' : `HTTP ${res.statusCode} from update server`));
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
  if (/404|No release found/i.test(m)) return 'No release found. If the repository is private, add a GitHub token in System Config → Updates.';
  if (/sha512|checksum/i.test(m)) return 'Downloaded file failed verification. Please try again.';
  return m.length > 200 ? m.slice(0, 200) + '…' : m;
}

class Updater extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.settings = { mode: 'ask', url: '', token: '', skippedVersion: '' };
    this.feed = null;
    this.status = { state: 'idle', current: app.getVersion(), version: null, notes: null, progress: null, error: null, lastCheck: null, manualDownloadUrl: null, packageKind: null, pendingInstall: false, releaseUrl: null };
    this._auto = null;
    this._timer = null;
    this._supported = app.isPackaged;
    this._manualOnly = (process.platform === 'linux') || isWindowsPortable();
  }

  configure(s) {
    this.settings = { mode: 'ask', url: '', token: '', skippedVersion: '', ...(s || {}) };
    try { this.feed = feedFromUrl(this.settings.url); } catch (e) { this.feed = null; this._set({ state: 'error', error: e.message }); }
    if (this._auto) {
      try { this._auto.setFeedURL(this._autoFeed()); } catch (e) { this.log('updater setFeedURL failed', e.message); }
      this._auto.autoDownload = this.settings.mode === 'auto';
    }
    this._schedule();
  }

  _set(patch) { this.status = { ...this.status, ...patch }; this.emit('status', this.status); }

  _repo() {
    const f = this.feed || this._feedFromAppUpdateYml();
    if (f && f.provider === 'github') return { owner: f.owner, repo: f.repo };
    return DEFAULT_REPO;
  }
  _autoFeed() {
    const f = this.feed || this._feedFromAppUpdateYml() || { provider: 'github', ...DEFAULT_REPO };
    if (f.provider === 'github' && this.settings.token) return { ...f, private: true, token: this.settings.token };
    return f;
  }
  _feedFromAppUpdateYml() {
    try {
      const text = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
      const get = (k) => { const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(text); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null; };
      const provider = get('provider');
      if (provider === 'github') return { provider, owner: get('owner'), repo: get('repo') };
      if (provider === 'generic') return { provider, url: String(get('url') || '').replace(/\/+$/, '') };
    } catch (_) {}
    return null;
  }

  _autoUpdater() {
    if (this._auto) return this._auto;
    if (!this._supported || this._manualOnly) return null;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = { info: (m) => this.log('updater', String(m)), warn: (m) => this.log('updater warn', String(m)), error: (m) => this.log('updater error', String(m)), debug: () => {} };
    autoUpdater.autoDownload = this.settings.mode === 'auto';
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = true; // follow whatever "latest" is, so a published rollback (lower version) also reaches installed copies
    try { autoUpdater.setFeedURL(this._autoFeed()); } catch (e) { this.log('updater setFeedURL failed', e.message); }
    autoUpdater.on('checking-for-update', () => this._set({ state: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => {
      const notes = notesText(info.releaseNotes);
      if (info.version === this.settings.skippedVersion && this.settings.mode !== 'auto') { this._set({ state: 'idle', version: info.version, notes }); return; }
      this._set({ state: this.settings.mode === 'auto' ? 'downloading' : 'available', version: info.version, notes, progress: null, releaseUrl: `https://github.com/${this._repo().owner}/${this._repo().repo}/releases/tag/v${info.version}` });
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
    if (!this._supported || this.settings.mode === 'off') return;
    this._timer = setTimeout(() => {
      this.check({ manual: false }).catch(() => {});
      this._timer = setInterval(() => this.check({ manual: false }).catch(() => {}), CHECK_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
  }

  async check({ manual = true } = {}) {
    if (!this._supported) return this.status;
    if (['downloading', 'downloaded'].includes(this.status.state)) return this.status;
    this._set({ state: 'checking', error: null, lastCheck: Date.now() });
    try {
      if (this._manualOnly) await this._checkManual(manual);
      else {
        const auto = this._autoUpdater();
        const r = await auto.checkForUpdates();
        if (!r) this._set({ state: 'up-to-date' });
      }
    } catch (e) {
      this._set({ state: 'error', error: friendlyError(e) });
    }
    return this.status;
  }

  /** Portable exe / .deb / .rpm: read the latest GitHub release and point at the right asset. */
  async _checkManual(manual) {
    const { owner, repo } = this._repo();
    const rel = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, this.settings.token);
    const version = String(rel.tag_name || rel.name || '').replace(/^v/, '');
    if (!version) throw new Error('Release has no version tag');
    if (compareVersions(version, app.getVersion()) <= 0) { this._set({ state: 'up-to-date', version }); return; }
    if (!manual && version === this.settings.skippedVersion) { this._set({ state: 'idle', version }); return; }
    const kind = isWindowsPortable() ? 'portable' : linuxPackageKind();
    const want = kind === 'portable' ? /portable\.exe$/i : kind === 'rpm' ? /\.rpm$/i : /\.deb$/i;
    const asset = (rel.assets || []).find((a) => want.test(a.name));
    this._set({ state: 'available', version, notes: rel.body || null, packageKind: kind, manualDownloadUrl: asset ? asset.browser_download_url : rel.html_url, releaseUrl: rel.html_url });
  }

  async download() {
    if (this.status.manualDownloadUrl) {
      if (/^https:\/\//i.test(this.status.manualDownloadUrl)) await shell.openExternal(this.status.manualDownloadUrl);
      return this.status;
    }
    const auto = this._autoUpdater();
    if (!auto || this.status.state !== 'available') return this.status;
    this._set({ state: 'downloading', progress: { percent: 0 } });
    try { await auto.downloadUpdate(); } catch (e) { this._set({ state: 'error', error: friendlyError(e) }); }
    return this.status;
  }

  install() {
    if (this.status.state !== 'downloaded' || !this._auto) return { ok: false, reason: 'Nothing downloaded yet.' };
    setImmediate(() => this._auto.quitAndInstall(true, true)); // silent NSIS install (/S), relaunch when done — no installer wizard
    return { ok: true };
  }

  skip(version) {
    this.settings.skippedVersion = version || this.status.version;
    this._set({ state: 'idle' });
    return this.settings.skippedVersion;
  }
  dismiss() {
    if (['available', 'error', 'up-to-date'].includes(this.status.state)) this._set({ state: 'idle', error: null });
    return this.status;
  }
  stop() { clearTimeout(this._timer); clearInterval(this._timer); this._timer = null; }
}

function notesText(notes) {
  if (!notes) return null;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => `${n.version}\n${n.note || ''}`).join('\n\n');
  return null;
}

module.exports = { Updater, compareVersions, feedFromUrl };
