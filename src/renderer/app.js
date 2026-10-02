// Application shell: navigation, login lock, alarm popups, status bar
import { api, on, state, bus, emit, loadAll, el, svg, toast, iconBtn, modal, beep, fmtTime, cameraById } from './core.js';
import * as live from './views/live.js';
import * as playback from './views/playback.js';
import * as events from './views/events.js';
import * as emap from './views/emap.js';
import * as devices from './views/devices.js';
import * as files from './views/files.js';
import * as logs from './views/logs.js';
import * as maintenance from './views/maintenance.js';
import * as settings from './views/settings.js';
import * as about from './views/about.js';

const VIEWS = [
  { id: 'live', label: 'Main View', icon: 'live', mod: live },
  { id: 'playback', label: 'Remote Playback', icon: 'playback', mod: playback },
  { id: 'events', label: 'Event Center', icon: 'events', mod: events },
  { id: 'emap', label: 'E-map', icon: 'emap', mod: emap },
  { id: 'devices', label: 'Device Management', icon: 'devices', mod: devices },
  { id: 'files', label: 'Local Files', icon: 'files', mod: files },
  { id: 'logs', label: 'Log Search', icon: 'logs', mod: logs },
  { id: 'maintenance', label: 'Maintenance', icon: 'maintenance', mod: maintenance },
  { id: 'settings', label: 'System Config', icon: 'settings', mod: settings },
  { id: 'about', label: 'About', icon: 'info', mod: about, hidden: true },
];

const params = new URLSearchParams(location.search);
const isAux = params.get('aux') === '1';
let current = null;
const viewRoot = document.getElementById('view');
const nav = document.getElementById('nav');

let navChain = Promise.resolve();
export function navigate(id, p = {}) {
  // Mounts are async; serialize so a view never finishes mounting after it has been unmounted
  navChain = navChain.then(async () => {
    const v = VIEWS.find((x) => x.id === id) || VIEWS[0];
    if (current && current.mod.unmount) { try { current.mod.unmount(); } catch (e) { console.error('unmount failed', current.id, e); } }
    viewRoot.innerHTML = '';
    current = v;
    for (const b of nav.children) b.classList.toggle('active', b.dataset.id === v.id);
    try { await v.mod.mount(viewRoot, p); } catch (e) { console.error('mount failed', v.id, e); toast(`Failed to open ${v.label}: ${e.message}`, 'err'); }
    localStorage.setItem('app.lastView', v.id);
  }).catch((e) => console.error(e));
  return navChain;
}
window.__navigate = navigate;

function buildNav() {
  nav.innerHTML = '';
  for (const v of VIEWS.filter((x) => !x.hidden)) {
    nav.append(el('button', { dataset: { id: v.id }, onClick: () => navigate(v.id) }, svg(v.icon), v.label));
  }
}

// ---------- alarm popups ----------
let popupQueue = [];
function showAlarmPopup(ev) {
  const root = document.getElementById('popup-root');
  if (root.children.length >= 3) root.firstChild.remove();
  const cam = ev.cameraId ? cameraById(ev.cameraId) : null;
  const img = el('img', { hidden: true });
  const box = el('div', { class: 'alarm-popup' },
    el('div', { class: 't' }, el('span', {}, svg('alert'), ' ', ev.description || ev.type), iconBtn('close', 'Dismiss', () => box.remove())),
    el('div', { class: 'd' }, `${ev.deviceName || ''}${ev.cameraName ? ' • ' + ev.cameraName : ''} • ${fmtTime(ev.time)}`),
    img,
    el('div', { class: 'acts' },
      cam ? el('button', { class: 'btn sm', onClick: () => { box.remove(); navigate('live', { cameraId: cam.id }); } }, svg('live'), 'Live') : null,
      cam ? el('button', { class: 'btn sm', onClick: () => { box.remove(); navigate('playback', { cameraId: cam.id, time: ev.time - 10000 }); } }, svg('playback'), 'Playback') : null,
      el('button', { class: 'btn sm', onClick: () => { api('events:ack', [ev.id]); box.remove(); } }, svg('check'), 'Acknowledge'),
    ));
  root.append(box);
  if (cam) api('cameras:snapshot', { cameraId: cam.id, stream: 'sub' }).then((r) => { img.src = `data:${r.contentType};base64,${r.data}`; img.hidden = false; }).catch(() => {});
  setTimeout(() => box.remove(), 20000);
}

async function updateBadge() {
  const unacked = await api('events:list', { unackedOnly: true, limit: 999 });
  const b = document.getElementById('alarm-badge');
  b.hidden = unacked.length === 0;
  b.textContent = unacked.length > 99 ? '99+' : String(unacked.length);
}

// ---------- login ----------
async function showLogin() {
  const root = document.getElementById('login-root');
  root.hidden = false;
  root.innerHTML = '';
  const user = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const pass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = el('div', { class: 'err small' });
  const go = async () => {
    try {
      const u = await api('users:login', { username: user.value, password: pass.value });
      state.user = u;
      document.getElementById('current-user').textContent = u.username;
      root.hidden = true;
      document.getElementById('btn-lock').hidden = false;
    } catch (e) { err.textContent = e.message; pass.value = ''; pass.focus(); }
  };
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  user.addEventListener('keydown', (e) => { if (e.key === 'Enter') pass.focus(); });
  root.append(el('div', { class: 'login-box' },
    el('div', { class: 'brand' }, el('span', { class: 'logo' }), el('span', { class: 'name' }, 'UniVMS')),
    el('div', { class: 'muted small', style: { textAlign: 'center' } }, 'Sign in to continue'),
    user, pass, err,
    el('button', { class: 'btn primary', style: { justifyContent: 'center', padding: '9px' }, onClick: go }, svg('login'), 'Login')));
  setTimeout(() => user.focus(), 50);
}

// ---------- boot ----------
async function boot() {
  buildNav();
  document.getElementById('btn-alarms').querySelector('.ico').innerHTML = svg('bell').innerHTML;
  document.getElementById('btn-alarms').addEventListener('click', () => navigate('events'));
  document.getElementById('btn-newwin').innerHTML = svg('window').innerHTML;
  document.getElementById('btn-newwin').addEventListener('click', () => api('window:openAux', { aux: true, view: 'live' }));
  document.getElementById('btn-fullscreen').innerHTML = svg('fullscreen').innerHTML;
  document.getElementById('btn-fullscreen').addEventListener('click', () => api('window:fullscreen'));
  const lockBtn = document.getElementById('btn-lock');
  lockBtn.innerHTML = svg('lock').innerHTML;
  lockBtn.addEventListener('click', async () => { await api('users:lock'); showLogin(); });
  if (isAux) document.getElementById('aux-tag').textContent = 'auxiliary window';

  state.info = await api('app:info');
  await loadAll();
  if (state.info.locked) showLogin();
  else if (state.settings.requireLogin) { const u = await api('users:current'); if (u) { state.user = u; document.getElementById('current-user').textContent = u.username; lockBtn.hidden = false; } }

  on('devices:changed', () => loadAll());
  on('views:changed', () => loadAll());
  on('devices:status', (s) => { state.status[s.deviceId] = s; emit('status', s); });
  on('events:new', (ev) => {
    emit('event', ev);
    updateBadge();
    const s = state.settings;
    const wanted = ev.type === 'test' || (ev.severity === 'alarm' && (s.alarmTypes || []).includes(ev.type)) || (ev.type === 'deviceOffline' && (s.alarmTypes || []).includes('deviceOffline'));
    if (!isAux && wanted) {
      if (s.alarmPopup) showAlarmPopup(ev);
      if (s.alarmSound) beep();
    }
  });
  on('events:acked', () => updateBadge());
  on('events:cleared', () => updateBadge());
  on('app:navigate', (v) => navigate(v));
  on('record:end', (r) => { if (r.code === 0 || r.code === 255) toast(`Recording saved: ${r.file}`, 'ok', 5000); else toast(`Recording ended (${r.code}) ${r.error || ''}`, 'warn', 6000); });
  on('export:end', (r) => { if (r.code === 0) toast(`Export complete: ${r.file}`, 'ok', 8000); else toast(`Export failed: ${r.error || r.code}`, 'err', 8000); });
  updateBadge();

  // status bar
  setInterval(async () => {
    const st = await api('stream:stats').catch(() => []);
    const total = st.reduce((n, s) => n + (s.bytes || 0), 0);
    document.getElementById('status-right').textContent = `${st.length} stream${st.length === 1 ? '' : 's'} • ${state.devices.length} device${state.devices.length === 1 ? '' : 's'} • ${state.cameras.length} cameras • ${new Date().toLocaleTimeString()}`;
    void total;
  }, 1000);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); api('window:fullscreen'); }
  });
  // prevent default file drop
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  const startView = params.get('view') || (isAux ? 'live' : localStorage.getItem('app.lastView') || 'live');
  navigate(VIEWS.some((v) => v.id === startView) ? startView : 'live');
}

// Smoke-test hook used by `npm run smoke`
window.__smoke = async () => {
  const results = [];
  for (const v of VIEWS) {
    try { await navigate(v.id); await new Promise((r) => setTimeout(r, 120)); results.push(`${v.id}:ok`); }
    catch (e) { results.push(`${v.id}:ERROR ${e.message}`); }
  }
  navigate('live');
  return results.join(', ');
};

boot().catch((e) => { console.error(e); toast('Startup error: ' + e.message, 'err', 10000); });
