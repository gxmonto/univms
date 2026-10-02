// Event Center: live alarm/event list with filters, acknowledge, jump to live/playback
import { api, on, state, bus, el, svg, btn, toast, fmtTime, cameraById, confirm, setStatus } from '../core.js';

let tbody, filters = { deviceId: '', type: '', unackedOnly: false, text: '' }, events = [], selected = new Set(), detail, unsubs = [];

const TYPE_LABELS = { VMD: 'Motion detection', linedetection: 'Line crossing', fielddetection: 'Intrusion', regionEntrance: 'Region entrance', regionExiting: 'Region exiting', IO: 'Alarm input', videoloss: 'Video loss', shelteralarm: 'Video tampering', facedetection: 'Face detection', attendedBaggage: 'Object left', unattendedBaggage: 'Object removed', PIR: 'PIR alarm', scenechangedetection: 'Scene change', audioexception: 'Audio exception', diskfull: 'HDD full', diskerror: 'HDD error', nicbroken: 'Network disconnected', ipconflict: 'IP conflict', illaccess: 'Illegal login', cameraMotionEvent: 'Motion', cameraInputEvent: 'Input signal', cameraDisconnectEvent: 'Camera disconnected', storageFailureEvent: 'Storage failure', networkIssueEvent: 'Network issue', cameraIpConflictEvent: 'IP conflict', serverFailureEvent: 'Server failure', serverConflictEvent: 'Server conflict', serverStartEvent: 'Server started', licenseIssueEvent: 'License issue', analyticsSdkEvent: 'Analytics event', softwareTriggerEvent: 'Soft trigger', pluginDiagnosticEvent: 'Plugin diagnostic', deviceOnline: 'Device online', deviceOffline: 'Device offline', test: 'Test alarm' };
export const typeLabel = (t) => TYPE_LABELS[t] || t;

function row(ev) {
  const cam = ev.cameraId ? cameraById(ev.cameraId) : null;
  const tr = el('tr', { class: `ev-row ${ev.acked ? 'acked' : 'unacked'} ${selected.has(ev.id) ? 'selected' : ''}`, dataset: { id: ev.id },
    onClick: (e) => { if (e.ctrlKey) { selected.has(ev.id) ? selected.delete(ev.id) : selected.add(ev.id); } else selected = new Set([ev.id]); render(); showDetail(ev); } },
    el('td', {}, fmtTime(ev.time)),
    el('td', {}, el('span', { class: `pill ${ev.severity || 'info'}` }, typeLabel(ev.type))),
    el('td', {}, ev.deviceName || '-'),
    el('td', {}, ev.cameraName || '-'),
    el('td', { title: ev.description }, ev.description || ''),
    el('td', {}, ev.state === 'inactive' ? 'ended' : ev.count > 1 ? `×${ev.count}` : ''),
    el('td', {}, el('div', { class: 'row' },
      cam ? el('button', { class: 'icon-btn', title: 'Live view', onClick: (e) => { e.stopPropagation(); window.__navigate('live', { cameraId: cam.id }); } }, svg('live')) : null,
      cam ? el('button', { class: 'icon-btn', title: 'Playback at event time', onClick: (e) => { e.stopPropagation(); window.__navigate('playback', { cameraId: cam.id, time: ev.time - 10000 }); } }, svg('playback')) : null,
      !ev.acked ? el('button', { class: 'icon-btn', title: 'Acknowledge', onClick: (e) => { e.stopPropagation(); api('events:ack', [ev.id]); ev.acked = true; render(); } }, svg('check')) : null)));
  return tr;
}
function matches(ev) {
  if (filters.deviceId && ev.deviceId !== filters.deviceId) return false;
  if (filters.type && ev.type !== filters.type) return false;
  if (filters.unackedOnly && ev.acked) return false;
  if (filters.text) { const t = filters.text.toLowerCase(); if (!`${ev.description} ${ev.cameraName} ${ev.deviceName} ${ev.type}`.toLowerCase().includes(t)) return false; }
  return true;
}
function render() {
  tbody.innerHTML = '';
  const list = events.filter(matches);
  for (const ev of list.slice(0, 1000)) tbody.append(row(ev));
  if (!list.length) tbody.append(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, 'No events')));
  setStatus(`${list.length} events • ${events.filter((e) => !e.acked).length} unacknowledged`);
}
async function showDetail(ev) {
  detail.innerHTML = '';
  const cam = ev.cameraId ? cameraById(ev.cameraId) : null;
  const img = el('img', { style: { width: '100%', borderRadius: '6px', background: '#000', minHeight: '120px' } });
  detail.append(el('h3', {}, typeLabel(ev.type)),
    el('dl', { class: 'kv' }, el('dt', {}, 'Time'), el('dd', {}, fmtTime(ev.time)), el('dt', {}, 'Device'), el('dd', {}, ev.deviceName || '-'), el('dt', {}, 'Camera'), el('dd', {}, ev.cameraName || '-'), el('dt', {}, 'State'), el('dd', {}, ev.state || '-'), el('dt', {}, 'Description'), el('dd', {}, ev.description || '-')),
    cam ? el('div', { style: { marginTop: '10px' } }, img) : null,
    el('details', { style: { marginTop: '10px' } }, el('summary', { class: 'dim small' }, 'Raw data'), el('pre', { class: 'mono small', style: { whiteSpace: 'pre-wrap', maxHeight: '200px', overflow: 'auto' } }, JSON.stringify(ev.raw || ev, null, 2))));
  if (cam) api('cameras:snapshot', { cameraId: cam.id, stream: 'sub' }).then((r) => { img.src = `data:${r.contentType};base64,${r.data}`; }).catch(() => { img.alt = 'snapshot unavailable'; });
}

export async function mount(container) {
  const content = el('section', { class: 'content' });
  const side = el('aside', { class: 'side right', style: { width: '320px' } }, el('div', { class: 'side-head' }, svg('info'), 'Event details'));
  detail = el('div', { class: 'side-body pad' }, el('div', { class: 'empty small' }, 'Select an event'));
  side.append(detail);
  const devSel = el('select', { onChange: (e) => { filters.deviceId = e.target.value; render(); } }, el('option', { value: '' }, 'All devices'), ...state.devices.map((d) => el('option', { value: d.id }, d.name)));
  const typeSel = el('select', { onChange: (e) => { filters.type = e.target.value; render(); } }, el('option', { value: '' }, 'All types'));
  const text = el('input', { type: 'text', placeholder: 'Search…', onInput: (e) => { filters.text = e.target.value; render(); } });
  const unacked = el('label', { class: 'check small' }, el('input', { type: 'checkbox', onChange: (e) => { filters.unackedOnly = e.target.checked; render(); } }), 'Unacknowledged only');
  const toolbar = el('div', { class: 'toolbar' }, devSel, typeSel, el('div', { class: 'search-box' }, svg('search'), text), unacked, el('div', { class: 'spacer' }),
    btn('Acknowledge selected', { cls: 'sm', icon: 'check' }, () => { if (selected.size) { api('events:ack', [...selected]); for (const e of events) if (selected.has(e.id)) e.acked = true; render(); } }),
    btn('Acknowledge all', { cls: 'sm' }, () => { api('events:ack', ['*']); for (const e of events) e.acked = true; render(); }),
    btn('Clear', { cls: 'sm danger', icon: 'trash' }, async () => { if (await confirm('Clear all events from the list?', { danger: true, okLabel: 'Clear' })) { await api('events:clear'); events = []; render(); } }),
    btn('Test alarm', { cls: 'sm', icon: 'bell' }, () => api('events:test')));
  tbody = el('tbody');
  const table = el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Type'), el('th', {}, 'Device'), el('th', {}, 'Camera'), el('th', {}, 'Description'), el('th', {}, ''), el('th', {}, 'Actions'))), tbody);
  content.append(toolbar, el('div', { class: 'scroll' }, table));
  container.append(content, side);

  events = await api('events:list', { limit: 2000 });
  const refreshTypes = () => { const cur = typeSel.value; typeSel.innerHTML = ''; typeSel.append(el('option', { value: '' }, 'All types')); for (const t of [...new Set(events.map((e) => e.type))].sort()) typeSel.append(el('option', { value: t, selected: t === cur }, typeLabel(t))); };
  refreshTypes();
  render();
  const onEv = (e) => { events.unshift(e.detail); if (events.length > 2000) events.pop(); if (!typeSel.querySelector(`option[value="${e.detail.type}"]`)) refreshTypes(); render(); };
  bus.addEventListener('event', onEv);
  unsubs.push(() => bus.removeEventListener('event', onEv));
  unsubs.push(on('events:acked', (ids) => { const set = new Set(ids); for (const e of events) if (set.has('*') || set.has(e.id)) e.acked = true; render(); }));
  unsubs.push(on('events:cleared', () => { events = []; render(); }));
}
export function unmount() { for (const u of unsubs) u(); unsubs = []; selected = new Set(); }
