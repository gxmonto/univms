// Update notifications: "new version available" dialog with release notes, download progress,
// restart prompt, and a one-time "what's new" after an upgrade.
import { api, on, state, el, svg, btn, modal, toast, fmtBytes, escapeHtml } from './core.js';

let dialog = null;      // { close, body } for the active update modal
let status = null;
let shownFor = null;    // version for which the dialog was auto-shown this session

export function renderNotes(text) {
  // Minimal markdown: headings, bullets, paragraphs, inline code
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let ul = null;
  const inline = (s) => escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  for (const raw of lines) {
    const l = raw.trim();
    if (/^[-*] /.test(l)) { if (!ul) { ul = el('ul', { style: { margin: '4px 0 8px', paddingLeft: '18px', lineHeight: 1.6 } }); out.push(ul); } ul.append(el('li', { html: inline(l.slice(2)) })); continue; }
    ul = null;
    if (!l) continue;
    if (/^#{1,3} /.test(l)) out.push(el('h3', { style: { marginTop: '8px' } }, l.replace(/^#+ /, '')));
    else out.push(el('p', { style: { margin: '4px 0' }, html: inline(l) }));
  }
  return el('div', {}, ...(out.length ? out : [el('p', { class: 'dim' }, 'No release notes.')]));
}

function body(s) {
  const wrap = el('div', {});
  if (s.state === 'downloading') {
    const pct = s.progress && s.progress.percent ? Math.round(s.progress.percent) : 0;
    wrap.append(el('p', {}, `Downloading UniVMS ${s.version}…`), el('div', { class: 'progress', style: { margin: '8px 0' } }, el('i', { style: { width: pct + '%' } })),
      el('div', { class: 'dim small' }, s.progress && s.progress.total ? `${fmtBytes(s.progress.transferred)} of ${fmtBytes(s.progress.total)}${s.progress.bps ? ` • ${fmtBytes(s.progress.bps)}/s` : ''}` : ''));
  } else if (s.state === 'downloaded') {
    wrap.append(el('p', {}, `UniVMS ${s.version} has been downloaded. Click Restart and update: the app closes, installs silently in the background (no installer wizard) and reopens on the new version. Your devices, views and settings are kept.`));
  } else {
    wrap.append(el('p', { class: 'muted' }, `You have ${s.current}. Version ${s.version} is available.`));
    if (s.packageKind === 'portable') wrap.append(el('p', { class: 'small warn' }, 'The portable exe cannot update itself: download the new file, close UniVMS and replace the old exe.'));
    if (s.packageKind === 'deb' || s.packageKind === 'rpm') wrap.append(el('p', { class: 'small warn' }, `Linux packages are not replaced from inside the app: download the new .${s.packageKind} and install it with your package manager.`));
    wrap.append(el('h3', {}, "What's new"), el('div', { style: { maxHeight: '45vh', overflow: 'auto', paddingRight: '6px' } }, renderNotes(s.notes)));
  }
  return wrap;
}

function buttons(s) {
  if (s.state === 'downloading') return [{ label: 'Hide', onClick: (close) => { close(); } }];
  if (s.state === 'downloaded') return [{ label: 'Later', onClick: (close) => close() }, { label: 'Restart and update', primary: true, onClick: async (close) => { const r = await api('updates:install'); if (!r.ok) toast(r.reason, 'warn'); else close(); } }];
  return [
    { label: 'Skip this version', left: true, onClick: async (close) => { await api('updates:skip', s.version); close(); } },
    { label: 'Later', onClick: async (close) => { await api('updates:dismiss'); close(); } },
    { label: s.manualDownloadUrl ? 'Download' : 'Download and install', primary: true, onClick: async (close) => { await api('updates:download'); if (s.manualDownloadUrl) close(); } },
  ];
}

export function showUpdateDialog(s = status) {
  if (!s || !['available', 'downloading', 'downloaded'].includes(s.state)) return;
  if (dialog) { dialog.close(); dialog = null; }
  const title = s.state === 'downloaded' ? 'Update ready' : `UniVMS ${s.version} is available`;
  const m = modal({ title, size: 'wide', body: body(s), buttons: buttons(s), onClose: () => { dialog = null; } });
  dialog = m;
}

function refreshDialog(s) {
  if (!dialog) return;
  if (!['available', 'downloading', 'downloaded'].includes(s.state)) { dialog.close(); dialog = null; return; }
  showUpdateDialog(s);
}

export async function initUpdates() {
  on('updates:status', (s) => {
    const prev = status;
    status = s;
    if (dialog) { if (!prev || prev.state !== s.state || (s.state === 'downloading')) refreshDialog(s); return; }
    if (s.state === 'available' && shownFor !== s.version) { shownFor = s.version; showUpdateDialog(s); }
    else if (s.state === 'downloaded' && shownFor !== 'dl:' + s.version) { shownFor = 'dl:' + s.version; showUpdateDialog(s); }
    else if (s.state === 'error' && s.manualCheck) toast('Update check failed: ' + s.error, 'err', 6000);
  });
  status = await api('updates:status').catch(() => null);
  // What's new after an upgrade (once per version)
  try {
    const info = state.info || (await api('app:info'));
    const seen = localStorage.getItem('updates.lastSeenVersion');
    if (seen && seen !== info.version) {
      const notes = await api('app:changelog', info.version).catch(() => null);
      if (notes) modal({ title: `What's new in UniVMS ${info.version}`, size: 'wide', body: renderNotes(notes), buttons: [{ label: 'Close', primary: true }] });
    }
    localStorage.setItem('updates.lastSeenVersion', info.version);
  } catch (_) {}
}

export const updateStatus = () => status;
