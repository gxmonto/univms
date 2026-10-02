// System Config: paths, streaming, alarms, login & users, startup behavior
import { api, state, el, svg, btn, toast, confirm, promptText, loadAll, setStatus } from '../core.js';
import { typeLabel } from './events.js';

const ALARM_TYPES = ['VMD', 'linedetection', 'fielddetection', 'regionEntrance', 'regionExiting', 'IO', 'videoloss', 'shelteralarm', 'facedetection', 'PIR', 'scenechangedetection', 'audioexception', 'diskfull', 'diskerror', 'nicbroken', 'ipconflict', 'illaccess', 'cameraMotionEvent', 'cameraInputEvent', 'cameraDisconnectEvent', 'storageFailureEvent', 'networkIssueEvent', 'serverFailureEvent', 'analyticsSdkEvent', 'softwareTriggerEvent', 'deviceOffline'];

export async function mount(container) {
  const s = await api('settings:get');
  const info = await api('app:info');
  const root = el('div', { class: 'scroll pad', style: { flex: 1 } });
  container.append(root);
  const save = async (patch) => { Object.assign(s, patch); const r = await api('settings:set', patch); state.settings = r; };
  const pathField = (key, label) => { const inp = el('input', { type: 'text', value: s[key] || '', placeholder: info[key] || '', onChange: () => save({ [key]: inp.value }) }); return el('label', { class: 'field full' }, label, el('div', { class: 'row' }, inp, btn('Browse…', { cls: 'sm' }, async () => { const p = await api('settings:pickDir', inp.value || info[key]); if (p) { inp.value = p; save({ [key]: p }); } }), btn('Open', { cls: 'sm', icon: 'folder' }, () => api('app:openPath', inp.value || info[key])))); };
  const check = (key, label, extra) => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!s[key], onChange: (e) => { save({ [key]: e.target.checked }); extra && extra(e.target.checked); } }), label);
  const select = (key, label, options) => el('label', { class: 'field' }, label, el('select', { onChange: (e) => save({ [key]: e.target.value }) }, ...options.map(([v, l]) => el('option', { value: v, selected: s[key] === v }, l))));
  const number = (key, label, min, max) => el('label', { class: 'field' }, label, el('input', { type: 'number', min, max, value: s[key], onChange: (e) => save({ [key]: Number(e.target.value) }) }));

  const ffBox = el('div', { class: 'dim small' }, info.ffmpeg.ffmpeg ? `Detected: ${info.ffmpeg.ffmpeg} (${info.ffmpeg.ffmpegVersion || 'version unknown'})${info.ffmpeg.hwaccels.length ? ' • hwaccels: ' + info.ffmpeg.hwaccels.join(', ') : ''}` : 'ffmpeg NOT found — live view will not work. Install ffmpeg or set the path below.');
  ffBox.classList.toggle('err', !info.ffmpeg.ffmpeg);
  const ffInput = el('input', { type: 'text', value: s.ffmpegPath || '', placeholder: 'auto-detect (bundled, vendor/, or PATH)', onChange: () => save({ ffmpegPath: ffInput.value }) });

  const alarmTypes = new Set(s.alarmTypes || []);
  const alarmGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px 12px' } }, ...ALARM_TYPES.map((t) => el('label', { class: 'check small' }, el('input', { type: 'checkbox', checked: alarmTypes.has(t), onChange: (e) => { e.target.checked ? alarmTypes.add(t) : alarmTypes.delete(t); save({ alarmTypes: [...alarmTypes] }); } }), `${typeLabel(t)} (${t})`)));

  // users
  const usersBox = el('div');
  const renderUsers = async () => {
    const users = await api('users:list');
    usersBox.innerHTML = '';
    if (!users.length) usersBox.append(el('div', { class: 'dim small' }, 'No application users. Login is only enforced when at least one user exists and "Require login" is on.'));
    else usersBox.append(el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, el('th', {}, 'Username'), el('th', {}, 'Role'), el('th', {}, 'Created'), el('th', {}, ''))), el('tbody', {}, ...users.map((u) => el('tr', {}, el('td', {}, u.username), el('td', {}, u.role), el('td', {}, new Date(u.createdAt).toLocaleDateString()), el('td', {}, el('div', { class: 'row' }, btn('Set password', { cls: 'sm' }, async () => { const p = await promptText('Set password', `New password for ${u.username}`, '', { password: true }); if (p) { await api('users:setPassword', { id: u.id, password: p }); toast('Password updated', 'ok'); } }), btn('Remove', { cls: 'sm danger' }, async () => { if (await confirm(`Remove user ${u.username}?`, { danger: true, okLabel: 'Remove' })) { await api('users:remove', u.id); renderUsers(); } }))))))));
  };
  renderUsers();

  root.append(
    el('h2', {}, 'System configuration'),
    el('div', { class: 'cards' },
      el('div', { class: 'card' }, el('h3', {}, 'File paths'), el('div', { class: 'col' }, pathField('snapshotDir', 'Snapshot folder'), pathField('recordDir', 'Recording / export folder'))),
      el('div', { class: 'card' }, el('h3', {}, 'ffmpeg'), ffBox, el('label', { class: 'field', style: { marginTop: '8px' } }, 'ffmpeg path override', el('div', { class: 'row' }, ffInput, btn('Browse…', { cls: 'sm' }, async () => { const p = await api('settings:pickFile', { filters: [{ name: 'ffmpeg', extensions: ['exe', ''] }] }); if (p) { ffInput.value = p; save({ ffmpegPath: p }); } }))), el('div', { class: 'dim small', style: { marginTop: '6px' } }, 'Restart streams after changing. The Windows installer and Linux packages bundle ffmpeg; the path override is only needed for custom builds.')),
      el('div', { class: 'card' }, el('h3', {}, 'Streaming'), el('div', { class: 'form-grid' }, select('defaultStream', 'Default live stream', [['sub', 'Sub stream (recommended for grids)'], ['main', 'Main stream']]), select('rtspTransport', 'RTSP transport', [['tcp', 'TCP (reliable)'], ['udp', 'UDP (lower latency)']]), number('autoSwitchInterval', 'Tour interval (seconds)', 3, 600), number('eventRetention', 'Events kept in memory', 100, 20000)), el('div', { class: 'col', style: { marginTop: '8px' } }, check('lowLatency', 'Low-latency mode (smaller buffers; may stutter on weak networks)'), check('autoReconnect', 'Automatically reconnect dropped streams'), check('hwDecode', 'Prefer hardware video decoding (requires app restart)'))),
      el('div', { class: 'card' }, el('h3', {}, 'Alarms'), el('div', { class: 'col' }, check('alarmPopup', 'Show alarm popup with snapshot'), check('alarmSound', 'Play alarm sound')), el('h3', {}, 'Event types that trigger popups'), alarmGrid),
      el('div', { class: 'card' }, el('h3', {}, 'Startup & window'), el('div', { class: 'col' }, check('startFullscreen', 'Start in fullscreen'), check('minimizeToTray', 'Minimize to tray on close (requires app restart)'), el('div', { class: 'dim small' }, `Startup view: ${s.startupView ? (state.views.find((v) => v.id === s.startupView) || {}).name || s.startupView : 'last used layout'} — choose in Main View → Views → Manage views`))),
      el('div', { class: 'card' }, el('h3', {}, 'Application login'), el('div', { class: 'col' }, check('requireLogin', 'Require login at startup (needs at least one user)'), check('autoLogin', 'Auto-login (skip the login screen but keep lock button)')), el('h3', {}, 'Users'), usersBox, el('div', { class: 'row', style: { marginTop: '8px' } }, btn('Add user', { cls: 'sm primary', icon: 'plus' }, async () => { const u = await promptText('New user', 'Username'); if (!u) return; const p = await promptText('New user', 'Password', '', { password: true }); if (!p) return; try { await api('users:create', { username: u, password: p }); renderUsers(); toast('User created', 'ok'); } catch (e) { toast(e.message, 'err'); } }))),
      el('div', { class: 'card' }, el('h3', {}, 'About'), el('dl', { class: 'kv' }, el('dt', {}, 'Version'), el('dd', {}, info.version), el('dt', {}, 'Platform'), el('dd', {}, info.platform), el('dt', {}, 'Data folder'), el('dd', { class: 'mono small' }, info.userData), el('dt', {}, 'Electron'), el('dd', {}, window.vms.versions.electron), el('dt', {}, 'Chromium'), el('dd', {}, window.vms.versions.chrome)), el('div', { class: 'row', style: { marginTop: '8px' } }, btn('Open data folder', { cls: 'sm', icon: 'folder' }, () => api('app:openPath', info.userData)), btn('Help & feature guide', { cls: 'sm', icon: 'info' }, () => window.__navigate('about'))))));
  setStatus('System Config');
}
export function unmount() {}
