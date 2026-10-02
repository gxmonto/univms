// Shared state, IPC wrapper, UI helpers (modal, toast, context menu, formatting)
import I from './icons.js';

export const api = (channel, ...args) => window.vms.invoke(channel, ...args);
export const on = (channel, cb) => window.vms.on(channel, cb);

export const state = {
  cameras: [], devices: [], groups: [], views: [], settings: {}, status: {}, info: null, user: null,
  playing: new Set(), // cameraIds currently shown live (for tree highlighting)
};

export const bus = new EventTarget();
// Cross-view actions registered by views (avoids circular imports): editDevice(dev), remoteConfig(dev), deleteDevice(dev), renameDevice(dev)
export const actions = {};
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export async function loadAll() {
  const [cameras, devices, groups, views, settings, status] = await Promise.all([
    api('cameras:list'), api('devices:list'), api('groups:list'), api('views:list'), api('settings:get'), api('devices:status'),
  ]);
  Object.assign(state, { cameras, devices, groups, views, settings, status });
  emit('data');
}

export const cameraById = (id) => state.cameras.find((c) => c.id === id) || null;
export const deviceById = (id) => state.devices.find((d) => d.id === id) || null;
export const cameraLabel = (id) => { const c = cameraById(id); return c ? c.name : id; };

// ---------- DOM helpers ----------
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'draggable' || k === 'contenteditable' || k === 'spellcheck') node.setAttribute(k, String(v)); // enumerated attrs: "" is invalid (draggable="" disables dragging)
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
export const svg = (name) => { const s = document.createElement('span'); s.className = 'ico'; s.innerHTML = typeof I[name] === 'function' ? I[name]() : I[name] || ''; return s; };
export const btn = (label, opts = {}, onClick) => {
  const b = el('button', { class: `btn ${opts.cls || ''}`, title: opts.title, disabled: opts.disabled, onClick }, opts.icon ? svg(opts.icon) : null, label);
  return b;
};
export const iconBtn = (icon, title, onClick, cls = '') => el('button', { class: `icon-btn ${cls}`, title, onClick }, svg(icon));

// ---------- formatting ----------
const p2 = (n) => String(n).padStart(2, '0');
export const fmtTime = (ms) => { if (!ms) return '-'; const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
export const fmtClock = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
export const fmtDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export const fmtBytes = (b) => { if (!b && b !== 0) return '-'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return `${b.toFixed(i ? 1 : 0)} ${u[i]}`; };
export const fmtDur = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}h ${p2(m)}m` : m ? `${m}m ${p2(x)}s` : `${x}s`; };
export const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

// ---------- toasts ----------
export function toast(msg, type = 'info', ms = 3500) {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: `toast ${type}` }, msg);
  root.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms);
  return t;
}
export const setStatus = (text) => { const e = document.getElementById('status-left'); if (e) e.textContent = text; };

// ---------- modal ----------
/**
 * modal({ title, body: Node|fn(close), buttons: [{label, cls, onClick(close) , primary}], size })
 * returns { close, el }
 */
export function modal({ title, body, buttons = [], size = '', onClose } = {}) {
  const root = document.getElementById('modal-root');
  let bd, esc, closed = false;
  const close = (v) => { if (closed) return; closed = true; document.removeEventListener('keydown', esc); bd.remove(); onClose && onClose(v); };
  const content = typeof body === 'function' ? body(close) : body;
  const foot = el('div', { class: 'm-foot' });
  for (const b of buttons) {
    const x = el('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.cls || ''} ${b.left ? 'left' : ''}`, onClick: async () => { if (b.onClick) { const r = await b.onClick(close); if (r === false) return; } else close(); } }, b.label);
    foot.append(x);
  }
  bd = el('div', { class: 'modal-backdrop', onMousedown: (e) => { if (e.target === bd) close(); } },
    el('div', { class: `modal ${size}` },
      el('div', { class: 'm-head' }, el('span', {}, title), iconBtn('close', 'Close', () => close())),
      el('div', { class: 'm-body' }, content),
      buttons.length ? foot : null));
  root.append(bd);
  esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const first = bd.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: bd };
}
export const confirm = (msg, { title = 'Confirm', okLabel = 'OK', danger = false } = {}) => new Promise((resolve) => {
  modal({ title, body: el('div', {}, msg), onClose: (v) => resolve(!!v), buttons: [{ label: 'Cancel' }, { label: okLabel, primary: !danger, cls: danger ? 'danger' : '', onClick: (close) => close(true) }] });
});
export const promptText = (title, label, value = '', { password = false } = {}) => new Promise((resolve) => {
  const inp = el('input', { type: password ? 'password' : 'text', value, style: { width: '100%' } });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { m.close(inp.value); } });
  const m = modal({ title, body: el('label', { class: 'field' }, label, inp), onClose: (v) => resolve(typeof v === 'string' ? v : null), buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: (close) => close(inp.value) }] });
});

// ---------- context menu ----------
export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const menu = el('div', { class: 'ctx-menu', style: { left: x + 'px', top: y + 'px' } });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(el('div', { class: 'sep' })); continue; }
    menu.append(el('button', { class: it.danger ? 'danger' : '', disabled: it.disabled, onClick: () => { menu.remove(); it.onClick && it.onClick(); } }, it.icon ? svg(it.icon) : null, it.label));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = (innerWidth - r.width - 4) + 'px';
  if (r.bottom > innerHeight) menu.style.top = (innerHeight - r.height - 4) + 'px';
  const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
  return menu;
}

// ---------- misc ----------
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const isDevType = (c, t) => (c.deviceType || (deviceById(c.deviceId) || {}).type) === t;
export function beep() {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.frequency.setValueAtTime(660, ctx.currentTime + 0.15); o.stop(ctx.currentTime + 0.3);
  } catch (_) {}
}
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
