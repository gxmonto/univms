// Local Files: browse snapshots and recordings, preview, open folder, move to trash
import { api, el, svg, btn, toast, modal, confirm, fmtTime, fmtBytes, setStatus } from '../core.js';

let kind = 'snapshots', gridEl, filter = '', data = { dir: '', files: [] }, dirLabel;

async function load() {
  data = await api('files:list', { kind });
  dirLabel.textContent = data.dir;
  render();
}
function render() {
  gridEl.innerHTML = '';
  const list = data.files.filter((f) => !filter || f.name.toLowerCase().includes(filter) || (f.folder || '').toLowerCase().includes(filter));
  if (!list.length) gridEl.append(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, svg('folder'), `No ${kind} yet`));
  for (const f of list.slice(0, 400)) {
    const thumb = el('div', { class: 'thumb' }, svg(f.type === 'image' ? 'image' : 'play'));
    const card = el('div', { class: 'file-card', onClick: () => preview(f), onContextmenu: (e) => { e.preventDefault(); } }, thumb, el('div', { class: 'meta' }, el('div', { class: 'n', title: f.name }, f.name), el('div', { class: 'dim' }, `${f.folder || ''} • ${fmtBytes(f.size)} • ${fmtTime(f.mtime)}`)));
    if (f.type === 'image' && f.size < 8 * 1024 * 1024) api('files:read', f.path).then((u) => { thumb.style.backgroundImage = `url("${u}")`; thumb.innerHTML = ''; }).catch(() => {});
    gridEl.append(card);
  }
  setStatus(`${list.length} file(s) in ${data.dir}`);
}
async function preview(f) {
  let media;
  if (f.type === 'image') { const u = await api('files:read', f.path).catch((e) => { toast(e.message, 'err'); return null; }); if (!u) return; media = el('img', { class: 'preview-media', src: u }); }
  else { const u = await api('files:read', f.path).catch((e) => { toast(e.message + ' — open it with the system player instead.', 'warn'); return null; }); media = u ? el('video', { class: 'preview-media', src: u, controls: true, autoplay: true }) : el('div', { class: 'empty' }, 'File too large to preview inline'); }
  modal({ title: f.name, size: 'wide', body: el('div', {}, media, el('div', { class: 'dim small', style: { marginTop: '8px' } }, f.path)), buttons: [
    { label: 'Open with system player', left: true, onClick: () => { api('app:openPath', f.path); return false; } },
    { label: 'Show in folder', left: true, onClick: () => { api('app:showInFolder', f.path); return false; } },
    { label: 'Move to trash', cls: 'danger', onClick: async (close) => { if (await confirm(`Move ${f.name} to the recycle bin / trash?`, { danger: true, okLabel: 'Move to trash' })) { try { await api('files:trash', f.path); close(); load(); } catch (e) { toast(e.message, 'err'); } } return false; } },
    { label: 'Close', primary: true }] });
}
export async function mount(container) {
  const content = el('section', { class: 'content' });
  const tabs = el('div', { class: 'tabs' });
  const show = (k) => { kind = k; for (const b of tabs.children) b.classList.toggle('active', b.dataset.k === k); load(); };
  tabs.append(el('button', { dataset: { k: 'snapshots' }, onClick: () => show('snapshots') }, 'Snapshots'), el('button', { dataset: { k: 'recordings' }, onClick: () => show('recordings') }, 'Recordings & exports'));
  dirLabel = el('span', { class: 'dim small mono' });
  const search = el('input', { type: 'text', placeholder: 'Filter…', onInput: (e) => { filter = e.target.value.toLowerCase(); render(); } });
  const tb = el('div', { class: 'toolbar' }, el('div', { class: 'search-box' }, svg('search'), search), btn('Refresh', { cls: 'sm', icon: 'refresh' }, load), btn('Open folder', { cls: 'sm', icon: 'folder' }, () => api('app:openPath', data.dir)), el('div', { class: 'spacer' }), dirLabel);
  gridEl = el('div', { class: 'file-grid' });
  content.append(tabs, tb, el('div', { class: 'scroll' }, gridEl));
  container.append(content);
  show(kind);
}
export function unmount() {}
