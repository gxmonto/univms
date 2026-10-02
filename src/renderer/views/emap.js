// E-map: floor plans with camera hotspots; alarms flash hotspots; click for live popup
import { api, state, bus, el, svg, btn, toast, modal, confirm, promptText, cameraById, setStatus } from '../core.js';
import { createCameraTree, DT_CAMERA } from '../tree.js';
import { Player } from '../player.js';

let maps = [], current = null, stage, canvas, img, listEl, scale = 1, alarms = new Map(), unsubs = [], tree;

async function load() { maps = await api('maps:list'); if (current) current = maps.find((m) => m.id === current.id) || maps[0] || null; else current = maps[0] || null; renderList(); renderMap(); }
function renderList() {
  listEl.innerHTML = '';
  for (const m of maps) listEl.append(el('div', { class: `m ${current && current.id === m.id ? 'active' : ''}`, onClick: () => { current = m; renderList(); renderMap(); } }, svg('emap'), el('span', { class: 'grow' }, m.name), el('span', { class: 'dim small' }, String((m.hotspots || []).length))));
  if (!maps.length) listEl.append(el('div', { class: 'empty small' }, 'No maps. Click + to add a floor plan image.'));
}
async function save() { if (current) { await api('maps:save', { id: current.id, name: current.name, image: current.image, hotspots: current.hotspots }); } }

function renderMap() {
  canvas.innerHTML = '';
  if (!current) { canvas.append(el('div', { class: 'empty', style: { width: '400px' } }, svg('emap'), 'Add a map to get started')); return; }
  img = el('img', { src: current.imageUrl ? current.imageUrl + '?t=' + Date.now() : '', draggable: false });
  img.onerror = () => { canvas.append(el('div', { class: 'empty' }, 'Image missing — import a new image for this map')); };
  canvas.append(img);
  for (const h of current.hotspots || []) canvas.append(hotspotEl(h));
  canvas.style.transform = `scale(${scale})`;
  setStatus(`E-map: ${current.name} • drag cameras from the tree onto the map`);
}
function hotspotEl(h) {
  const cam = cameraById(h.cameraId);
  const off = cam && (cam.online === false || (state.status[cam.deviceId] && state.status[cam.deviceId].online === false));
  const e = el('div', { class: `hotspot ${alarms.has(h.cameraId) ? 'alarm' : ''} ${off ? 'off' : ''}`, style: { left: h.x + '%', top: h.y + '%' }, title: cam ? cam.name : h.cameraId }, svg('camera'), el('span', { class: 'hl' }, cam ? cam.name : '?'));
  let drag = null;
  e.addEventListener('pointerdown', (ev) => { if (ev.button !== 0) return; ev.stopPropagation(); drag = { x: ev.clientX, y: ev.clientY, moved: false }; e.setPointerCapture(ev.pointerId); });
  e.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientX - drag.x) > 3 || Math.abs(ev.clientY - drag.y) > 3) drag.moved = true;
    if (drag.moved) { const r = img.getBoundingClientRect(); h.x = Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)); h.y = Math.max(0, Math.min(100, ((ev.clientY - r.top) / r.height) * 100)); e.style.left = h.x + '%'; e.style.top = h.y + '%'; }
  });
  e.addEventListener('pointerup', () => { if (drag && drag.moved) save(); else if (drag) openPopup(h.cameraId); drag = null; });
  e.addEventListener('contextmenu', async (ev) => { ev.preventDefault(); ev.stopPropagation(); if (await confirm(`Remove ${cam ? cam.name : 'this camera'} from the map?`, { danger: true, okLabel: 'Remove' })) { current.hotspots = current.hotspots.filter((x) => x !== h); await save(); renderMap(); } });
  return e;
}
function openPopup(cameraId) {
  const cam = cameraById(cameraId);
  if (!cam) return toast('Camera not found', 'err');
  const video = el('video', { muted: true, autoplay: true, playsinline: true, style: { width: '100%', maxHeight: '60vh', background: '#000' } });
  const st = el('div', { class: 'dim small' });
  const player = new Player(video, { cameraId, stream: 'sub', kind: 'live', onStatus: (s, d) => { st.textContent = s === 'playing' ? d : s; } });
  player.start();
  modal({ title: cam.name, size: 'wide', body: el('div', {}, video, st), onClose: () => player.destroy(),
    buttons: [{ label: 'Open in Main View', onClick: (close) => { close(); window.__navigate('live', { cameraId }); } }, { label: 'Playback', onClick: (close) => { close(); window.__navigate('playback', { cameraId }); } }, { label: 'Close', primary: true }] });
}

export async function mount(container) {
  const side = el('aside', { class: 'side' });
  listEl = el('div', { class: 'map-list' });
  side.append(el('div', { class: 'side-head' }, svg('emap'), el('span', { class: 'grow' }, 'Maps'),
    el('button', { class: 'icon-btn', title: 'Add map', onClick: async () => {
      const name = await promptText('New map', 'Map name', `Map ${maps.length + 1}`); if (!name) return;
      const m = await api('maps:save', { name, hotspots: [] });
      const r = await api('maps:importImage', { id: m.id });
      if (r) await api('maps:save', { ...m, image: r.image });
      current = { ...m, image: r && r.image }; await load();
    } }, svg('plus')),
    el('button', { class: 'icon-btn', title: 'Rename map', onClick: async () => { if (!current) return; const n = await promptText('Rename map', 'Name', current.name); if (n) { current.name = n; await save(); await load(); } } }, svg('edit')),
    el('button', { class: 'icon-btn', title: 'Replace image', onClick: async () => { if (!current) return; const r = await api('maps:importImage', { id: current.id }); if (r) { current.image = r.image; await save(); await load(); } } }, svg('image')),
    el('button', { class: 'icon-btn danger', title: 'Delete map', onClick: async () => { if (current && await confirm(`Delete map "${current.name}"?`, { danger: true, okLabel: 'Delete' })) { await api('maps:remove', current.id); current = null; await load(); } } }, svg('trash'))),
    listEl, el('div', { class: 'side-head' }, svg('camera'), 'Cameras (drag onto map)'));
  tree = createCameraTree(side, { activateLabel: 'Open live popup', onActivate: (cam) => openPopup(cam.id) });

  const content = el('section', { class: 'content' });
  stage = el('div', { class: 'map-stage' });
  canvas = el('div', { class: 'map-canvas' });
  stage.append(canvas);
  stage.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DT_CAMERA) && current) e.preventDefault(); });
  stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DT_CAMERA);
    if (!id || !current || !img) return;
    const r = img.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100, y = ((e.clientY - r.top) / r.height) * 100;
    if (x < 0 || y < 0 || x > 100 || y > 100) return;
    current.hotspots = (current.hotspots || []).filter((h) => h.cameraId !== id);
    current.hotspots.push({ cameraId: id, x, y });
    await save(); renderMap();
  });
  stage.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); scale = Math.min(4, Math.max(0.25, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); canvas.style.transform = `scale(${scale})`; }, { passive: false });
  const tb = el('div', { class: 'toolbar' }, btn('Zoom in', { cls: 'sm', icon: 'plus' }, () => { scale = Math.min(4, scale * 1.25); canvas.style.transform = `scale(${scale})`; }), btn('Zoom out', { cls: 'sm', icon: 'minimize' }, () => { scale = Math.max(0.25, scale / 1.25); canvas.style.transform = `scale(${scale})`; }), btn('Fit', { cls: 'sm' }, () => { if (img && img.naturalWidth) { scale = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight); canvas.style.transform = `scale(${scale})`; } }), el('span', { class: 'dim small' }, 'Ctrl+wheel to zoom • right-click a hotspot to remove'));
  content.append(tb, stage);
  container.append(side, content);
  await load();
  const onEv = (e) => { const ev = e.detail; if (ev.cameraId && ev.severity === 'alarm') { alarms.set(ev.cameraId, Date.now()); renderMap(); setTimeout(() => { if (Date.now() - (alarms.get(ev.cameraId) || 0) >= 29000) { alarms.delete(ev.cameraId); renderMap(); } }, 30000); } };
  bus.addEventListener('event', onEv);
  const onStatus = () => renderMap();
  bus.addEventListener('status', onStatus);
  unsubs.push(() => bus.removeEventListener('event', onEv), () => bus.removeEventListener('status', onStatus));
}
export function unmount() { if (tree) { tree.destroy(); tree = null; } for (const u of unsubs) u(); unsubs = []; }
