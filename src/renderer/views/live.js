// Main View: live video wall with layouts, drag & drop, PTZ, snapshots, local recording, tours
import { api, state, bus, emit, el, svg, btn, toast, modal, confirm, promptText, cameraById, deviceById, contextMenu, setStatus } from '../core.js';
import { createCameraTree, DT_CAMERA, DT_DEVICE, DT_GROUP, showCameraInfo } from '../tree.js';
import { Player } from '../player.js';
import { createPtzPanel } from '../ptz.js';
import { TalkSession } from '../talk.js';
import { Dewarper, DEFAULT_DEWARP } from '../dewarp.js';
import { openRulesEditor } from '../rules.js';

export const LAYOUTS = {
  '1': { n: 1, cols: 1, rows: 1 },
  '4': { n: 4, cols: 2, rows: 2 },
  '6': { n: 6, cols: 3, rows: 3, areas: ['a a b', 'a a c', 'd e f'] },
  '8': { n: 8, cols: 4, rows: 4, areas: ['a a a b', 'a a a c', 'a a a d', 'e f g h'] },
  '9': { n: 9, cols: 3, rows: 3 },
  '10': { n: 10, cols: 4, rows: 4, areas: ['a a b b', 'a a b b', 'c d e f', 'g h i j'] },
  '13': { n: 13, cols: 4, rows: 4, areas: ['a b c d', 'e f f g', 'h f f i', 'j k l m'] },
  '16': { n: 16, cols: 4, rows: 4 },
  '25': { n: 25, cols: 5, rows: 5 },
  '36': { n: 36, cols: 6, rows: 6 },
  '64': { n: 64, cols: 8, rows: 8 },
};
const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

let root, gridEl, tiles = [], layoutId = '4', customLayout = null, selectedIdx = -1, maximizedIdx = -1;
let tree, ptz, sideRight, tourTimer = null, tourIdx = 0, currentViewId = null, pendingParams = null;
let unsubs = [];

const persistState = () => {
  try { localStorage.setItem('live.state', JSON.stringify({ layoutId, customLayout, cells: tiles.map((t) => (t.cameraId ? { cameraId: t.cameraId, stream: t.stream } : null)), currentViewId })); } catch (_) {}
};

function layoutDef() { return customLayout || LAYOUTS[layoutId] || LAYOUTS['4']; }

// ---------- tiles ----------
function createTile(i) {
  const video = el('video', { muted: true, autoplay: true, playsinline: true });
  const nameEl = el('div', { class: 'name hidden' });
  const statusEl = el('span', { class: 'st' });
  const recEl = el('span', { class: 'rec hidden' }, '● REC');
  const label = el('span', { class: 'lbl' });
  nameEl.append(label, recEl, statusEl);
  const msg = el('div', { class: 'msg hidden' });
  const spinner = el('div', { class: 'spinner hidden' });
  const hint = el('div', { class: 'empty-hint' }, svg('camera'));
  const hintInfo = el('div', { class: 'hint-info', dataset: { tip: 'Drag a camera here, or double-click one in the tree' } }, 'i');
  const tools = el('div', { class: 'tools hidden' });
  const tile = { i, cameraId: null, stream: state.settings.defaultStream || 'sub', audio: false, player: null, zoom: null, el: null, video, nameEl, label, statusEl, recEl, msg, spinner, hint, tools, recording: false, ptz3d: false, talk: null, dewarp: null, dewarpCanvas: null };
  const t = el('div', { class: 'tile', dataset: { idx: i } }, video, hint, hintInfo, nameEl, msg, spinner, tools);
  tile.el = t;
  tile.hintInfo = hintInfo;

  const tb = (icon, title, fn, cls = '') => { const b = el('button', { title, class: cls, onClick: (e) => { e.stopPropagation(); fn(b); } }, svg(icon)); return b; };
  const streamBtn = el('button', { class: 'lbl-btn', title: 'Toggle main / sub stream', onClick: (e) => { e.stopPropagation(); setStream(tile, tile.stream === 'main' ? 'sub' : 'main'); } }, 'SUB');
  tile.streamBtn = streamBtn;
  tile.audioBtn = tb('mute', 'Audio on/off', () => setAudio(tile, !tile.audio));
  tile.recBtn = tb('record', 'Start/stop local recording', () => toggleRecord(tile));
  tile.zoomBtn = tb('zoom', 'Digital zoom (wheel to zoom, drag to pan)', () => toggleZoom(tile));
  tile.ptzBtn = tb('ptz', 'PTZ control (opens panel; drag a box on video for 3D positioning on Hikvision)', () => { selectTile(i); togglePtzPanel(true); tile.ptz3d = !tile.ptz3d; tile.ptzBtn.classList.toggle('on', tile.ptz3d); });
  tile.talkBtn = tb('mic', 'Two-way audio: talk through the camera / NVR speaker (click to start, click again to stop)', () => toggleTalk(tile));
  tile.fishBtn = tb('fisheye', 'Fisheye dewarp: off → panorama → virtual PTZ (right-click for settings)', () => cycleDewarp(tile));
  tile.fishBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); dewarpSettings(tile); });
  tools.append(
    tb('snapshot', 'Snapshot', () => snapshot(tile)),
    tile.recBtn, tile.audioBtn, streamBtn, tile.zoomBtn, tile.ptzBtn, tile.talkBtn, tile.fishBtn,
    tb('fullscreen', 'Maximize / restore (double-click)', () => toggleMaximize(i)),
    tb('close', 'Stop', () => clearTile(i)),
  );

  t.addEventListener('click', () => selectTile(i));
  t.addEventListener('dblclick', (e) => { if (e.target.closest('.tools')) return; if (tile.cameraId) toggleMaximize(i); });
  t.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectTile(i);
    const cam = tile.cameraId ? cameraById(tile.cameraId) : null;
    contextMenu(e.clientX, e.clientY, [
      cam && { label: 'Snapshot', icon: 'snapshot', onClick: () => snapshot(tile) },
      cam && { label: tile.recording ? 'Stop recording' : 'Start local recording', icon: 'record', onClick: () => toggleRecord(tile) },
      cam && { label: tile.stream === 'main' ? 'Switch to sub stream' : 'Switch to main stream', icon: 'swap', onClick: () => setStream(tile, tile.stream === 'main' ? 'sub' : 'main') },
      cam && { label: tile.audio ? 'Mute' : 'Enable audio', icon: 'audio', onClick: () => setAudio(tile, !tile.audio) },
      cam && { label: tile.talk ? 'Stop talking' : 'Talk (two-way audio)', icon: 'mic', onClick: () => toggleTalk(tile) },
      cam && { label: 'Fisheye dewarp settings…', icon: 'fisheye', onClick: () => dewarpSettings(tile) },
      cam && deviceById(cam.deviceId) && deviceById(cam.deviceId).type === 'hikvision' && { label: 'Event rules (motion / line / intrusion)…', icon: 'alert', onClick: () => openRulesEditor(cam.id) },
      cam && { label: 'Open in playback', icon: 'playback', onClick: () => window.__navigate('playback', { cameraId: cam.id }) },
      cam && { label: 'Camera details', icon: 'info', onClick: () => showCameraInfo(cam) },
      cam && '-',
      cam && { label: 'Stop', icon: 'close', onClick: () => clearTile(i) },
      { label: 'Stop all', icon: 'stop', danger: true, onClick: () => stopAll() },
    ]);
  });

  // drag & drop
  t.addEventListener('dragover', (e) => { if ([DT_CAMERA, DT_DEVICE, DT_GROUP, 'application/x-univms-tile'].some((x) => e.dataTransfer.types.includes(x))) { e.preventDefault(); t.classList.add('drag-over'); } });
  t.addEventListener('dragleave', () => t.classList.remove('drag-over'));
  t.addEventListener('drop', (e) => {
    e.preventDefault(); t.classList.remove('drag-over');
    const camId = e.dataTransfer.getData(DT_CAMERA);
    const devId = e.dataTransfer.getData(DT_DEVICE);
    const grp = e.dataTransfer.getData(DT_GROUP);
    const from = e.dataTransfer.getData('application/x-univms-tile');
    if (camId) assign(i, camId);
    else if (devId) fillFrom(i, state.cameras.filter((c) => c.deviceId === devId && !c.hidden).map((c) => c.id));
    else if (grp) fillFrom(i, grp.split(',').filter(Boolean));
    else if (from !== '') swap(Number(from), i);
  });
  t.draggable = true;
  t.addEventListener('dragstart', (e) => { if (!tile.cameraId || tile.zoom) { e.preventDefault(); return; } e.dataTransfer.setData('application/x-univms-tile', String(i)); e.dataTransfer.effectAllowed = 'move'; });

  // digital zoom + 3D PTZ
  t.addEventListener('wheel', (e) => {
    if (!tile.zoom) return;
    e.preventDefault();
    const z = tile.zoom;
    z.scale = Math.min(10, Math.max(1, z.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    if (z.scale === 1) { z.x = 0; z.y = 0; }
    applyZoom(tile);
  }, { passive: false });
  let drag = null;
  t.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.tools')) return;
    if (tile.zoom && tile.zoom.scale > 1) { drag = { x: e.clientX, y: e.clientY, ox: tile.zoom.x, oy: tile.zoom.y }; t.setPointerCapture(e.pointerId); }
    else if (tile.ptz3d && tile.cameraId) {
      const r = t.getBoundingClientRect();
      drag = { ptz: true, x: e.clientX - r.left, y: e.clientY - r.top, rect: el('div', { class: 'ptz-rect' }), r };
      t.append(drag.rect); t.setPointerCapture(e.pointerId);
    }
  });
  t.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.ptz) {
      const x = e.clientX - drag.r.left, y = e.clientY - drag.r.top;
      Object.assign(drag.rect.style, { left: Math.min(x, drag.x) + 'px', top: Math.min(y, drag.y) + 'px', width: Math.abs(x - drag.x) + 'px', height: Math.abs(y - drag.y) + 'px' });
    } else {
      tile.zoom.x = drag.ox + (e.clientX - drag.x); tile.zoom.y = drag.oy + (e.clientY - drag.y); applyZoom(tile);
    }
  });
  const endDrag = (e) => {
    if (!drag) return;
    if (drag.ptz) {
      const x = e.clientX - drag.r.left, y = e.clientY - drag.r.top;
      drag.rect.remove();
      const sc = (v, max) => Math.max(0, Math.min(255, Math.round((v / max) * 255)));
      const sx = sc(drag.x, drag.r.width), sy = sc(drag.y, drag.r.height), ex = sc(x, drag.r.width), ey = sc(y, drag.r.height);
      api('ptz:position3D', { cameraId: tile.cameraId, sx, sy, ex: Math.abs(ex - sx) < 3 ? sx : ex, ey: Math.abs(ey - sy) < 3 ? sy : ey }).then((ok) => { if (ok === false) toast('3D positioning is not supported for this camera', 'warn'); }).catch((err) => toast('PTZ: ' + err.message, 'err'));
    }
    drag = null;
  };
  t.addEventListener('pointerup', endDrag);
  t.addEventListener('pointercancel', () => { if (drag && drag.rect) drag.rect.remove(); drag = null; });
  return tile;
}

function applyZoom(tile) {
  const z = tile.zoom;
  tile.video.style.transform = z && z.scale > 1 ? `translate(${z.x}px, ${z.y}px) scale(${z.scale})` : '';
  tile.el.classList.toggle('zoomed', !!(z && z.scale > 1));
}
function toggleZoom(tile) {
  if (tile.zoom) { tile.zoom = null; tile.zoomBtn.classList.remove('on'); }
  else { tile.zoom = { scale: 1.5, x: 0, y: 0 }; tile.zoomBtn.classList.add('on'); }
  applyZoom(tile);
}

function setTileStatus(tile, status, detail) {
  tile.statusEl.textContent = (tile.talk ? 'TALKING • ' : '') + (status === 'playing' ? detail : status === 'idle' ? '' : status);
  tile.spinner.classList.toggle('hidden', !['connecting', 'buffering', 'reconnecting'].includes(status));
  tile.msg.classList.toggle('hidden', !(status === 'error' || status === 'reconnecting'));
  tile.msg.classList.toggle('err', status === 'error');
  tile.msg.textContent = status === 'error' ? `Error: ${detail}` : status === 'reconnecting' ? `Reconnecting… ${detail}` : '';
}

export function assign(i, cameraId, stream) {
  const tile = tiles[i];
  if (!tile) return;
  const cam = cameraById(cameraId);
  if (!cam) { toast('Camera not found', 'err'); return; }
  if (tile.player) { stopRecordingIfAny(tile); tile.player.destroy(); state.playing.delete(tile.cameraId); }
  tile.cameraId = cameraId;
  tile.stream = stream || tile.stream || state.settings.defaultStream || 'sub';
  if (!cam.streams || !cam.streams.sub) tile.stream = 'main';
  tile.streamBtn.textContent = tile.stream === 'main' ? 'MAIN' : 'SUB';
  tile.label.textContent = cam.name;
  tile.nameEl.classList.remove('hidden'); tile.hint.classList.add('hidden'); tile.hintInfo.classList.add('hidden'); tile.tools.classList.remove('hidden');
  tile.player = new Player(tile.video, { cameraId, stream: tile.stream, kind: 'live', audio: tile.audio, onStatus: (s, d) => setTileStatus(tile, s, d) });
  tile.player.start();
  state.playing.add(cameraId);
  const alias = (cam && cam.id && (state.cameras.find((c) => c.id === cam.id) || {})) || {};
  const dw = cam.dewarp || alias.dewarp;
  if (dw && dw.mode && dw.mode !== 'off') setDewarp(tile, dw.mode, dw);
  emit('playing');
  persistState();
}

// ---------- two-way audio ----------
async function toggleTalk(tile) {
  if (!tile.cameraId) return;
  if (tile.talk) { await tile.talk.stop(); return; }
  for (const t of tiles) if (t.talk) await t.talk.stop();
  const session = new TalkSession(tile.cameraId, { onStatus: (s, d) => {
    if (s === 'idle' || s === 'ended') { tile.talk = null; tile.talkBtn.classList.remove('talk'); tile.statusEl.textContent = tile.player ? tile.player.detailText() : ''; if (s === 'ended' && d) toast('Two-way audio ended: ' + d, 'warn'); }
    else { tile.talkBtn.classList.add('talk'); tile.statusEl.textContent = s === 'talking' ? `TALKING • ${d}` : 'connecting audio…'; }
  } });
  tile.talk = session;
  try { await session.start(); toast('Two-way audio active. Click the microphone again to stop.', 'ok'); }
  catch (e) { tile.talk = null; tile.talkBtn.classList.remove('talk'); toast('Two-way audio: ' + e.message, 'err', 6000); }
}

// ---------- fisheye dewarp ----------
function setDewarp(tile, mode, params) {
  if (mode === 'off') {
    if (tile.dewarp) { tile.dewarp.stop(); tile.dewarp = null; }
    if (tile.dewarpCanvas) { tile.dewarpCanvas.remove(); tile.dewarpCanvas = null; }
    tile.video.style.opacity = '';
    tile.fishBtn.classList.remove('on');
    return;
  }
  if (!tile.dewarpCanvas) {
    const c = el('canvas', { class: 'dewarp' });
    tile.el.insertBefore(c, tile.nameEl);
    tile.dewarpCanvas = c;
    let drag = null;
    c.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, pan: tile.dewarp.p.pan, tilt: tile.dewarp.p.tilt }; c.setPointerCapture(e.pointerId); e.stopPropagation(); });
    c.addEventListener('pointermove', (e) => { if (!drag || !tile.dewarp) return; const dx = (e.clientX - drag.x) / c.clientWidth, dy = (e.clientY - drag.y) / c.clientHeight; tile.dewarp.set({ pan: drag.pan - dx * Math.PI, tilt: Math.max(0, Math.min(1.5, drag.tilt - dy * 1.5)) }); });
    c.addEventListener('pointerup', () => { if (drag) saveDewarp(tile); drag = null; });
    c.addEventListener('wheel', (e) => { if (!tile.dewarp || tile.dewarp.p.mode !== 'ptz') return; e.preventDefault(); e.stopPropagation(); tile.dewarp.set({ fov: Math.max(0.3, Math.min(2.4, tile.dewarp.p.fov * (e.deltaY < 0 ? 0.9 : 1.1))) }); saveDewarp(tile); }, { passive: false });
    c.addEventListener('dblclick', (e) => e.stopPropagation());
  }
  if (!tile.dewarp) {
    try { tile.dewarp = new Dewarper(tile.video, tile.dewarpCanvas, params || {}); tile.dewarp.start(); }
    catch (e) { toast('Fisheye dewarp unavailable: ' + e.message, 'err'); setDewarp(tile, 'off'); return; }
  }
  tile.dewarp.set({ ...(params || {}), mode });
  tile.video.style.opacity = '0';
  tile.fishBtn.classList.add('on');
  tile.fishBtn.title = `Fisheye: ${mode === 'panorama' ? '360° panorama' : 'virtual PTZ (drag to look around, wheel to zoom)'} — click for next mode, right-click for settings`;
}
function cycleDewarp(tile) {
  if (!tile.cameraId) return;
  const cur = tile.dewarp ? tile.dewarp.p.mode : 'off';
  const next = cur === 'off' ? 'panorama' : cur === 'panorama' ? 'ptz' : 'off';
  const cam = cameraById(tile.cameraId) || {};
  setDewarp(tile, next, { ...(cam.dewarp || {}) });
  saveDewarp(tile);
}
function saveDewarp(tile) {
  if (!tile.cameraId) return;
  const p = tile.dewarp ? { ...tile.dewarp.p } : { ...DEFAULT_DEWARP, mode: 'off' };
  clearTimeout(tile._dwSave);
  tile._dwSave = setTimeout(() => api('devices:setCameraAlias', { cameraId: tile.cameraId, dewarp: p }).catch(() => {}), 500);
}
function dewarpSettings(tile) {
  if (!tile.cameraId) return;
  const cam = cameraById(tile.cameraId) || {};
  const p = { ...DEFAULT_DEWARP, ...(cam.dewarp || {}), ...(tile.dewarp ? tile.dewarp.p : {}) };
  const apply = () => { if (tile.dewarp) tile.dewarp.set(p); else if (p.mode !== 'off') setDewarp(tile, p.mode, p); saveDewarp(tile); };
  const slider = (label, key, min, max, step) => { const out = el('span', { class: 'dim small' }, Number(p[key]).toFixed(2)); return el('label', { class: 'field' }, el('span', {}, label, ' ', out), el('input', { type: 'range', min, max, step, value: p[key], onInput: (e) => { p[key] = Number(e.target.value); out.textContent = p[key].toFixed(2); apply(); } })); };
  modal({ title: `Fisheye dewarp — ${cam.name || ''}`, body: el('div', { class: 'col' },
    el('label', { class: 'field' }, 'Mode', el('select', { onChange: (e) => { p.mode = e.target.value; setDewarp(tile, p.mode, p); saveDewarp(tile); } }, ...[['off', 'Off (original fisheye image)'], ['panorama', '360° panorama strip'], ['ptz', 'Virtual PTZ (drag to look around, wheel to zoom)']].map(([v, l]) => el('option', { value: v, selected: p.mode === v }, l)))),
    el('label', { class: 'field' }, 'Mount', el('select', { onChange: (e) => { p.mount = e.target.value; apply(); } }, ...[['ceiling', 'Ceiling'], ['table', 'Table / desk'], ['wall', 'Wall']].map(([v, l]) => el('option', { value: v, selected: p.mount === v }, l)))),
    slider('Image circle center X', 'cx', 0.2, 0.8, 0.005), slider('Image circle center Y', 'cy', 0.2, 0.8, 0.005), slider('Image circle radius (of width)', 'r', 0.2, 0.6, 0.005),
    el('div', { class: 'dim small' }, 'Adjust center and radius until the edge of the fisheye circle lines up with the picture edge in panorama mode. Settings are saved per camera.')),
    buttons: [{ label: 'Reset', left: true, onClick: () => { Object.assign(p, DEFAULT_DEWARP, { mode: p.mode }); apply(); return false; } }, { label: 'Close', primary: true }] });
}

export function clearTile(i) {
  const tile = tiles[i];
  if (!tile) return;
  if (tile.talk) { tile.talk.stop().catch(() => {}); tile.talk = null; }
  setDewarp(tile, 'off');
  if (tile.player) { tile.player.destroy(); tile.player = null; }
  stopRecordingIfAny(tile);
  if (tile.cameraId) { state.playing.delete(tile.cameraId); }
  tile.cameraId = null; tile.zoom = null; applyZoom(tile); tile.zoomBtn.classList.remove('on');
  tile.nameEl.classList.add('hidden'); tile.hint.classList.remove('hidden'); tile.hintInfo.classList.remove('hidden'); tile.tools.classList.add('hidden');
  setTileStatus(tile, 'idle', '');
  if (tile.ptz3d) { tile.ptz3d = false; tile.ptzBtn.classList.remove('on'); }
  emit('playing');
  persistState();
}

function fillFrom(start, cameraIds) {
  let idx = start;
  for (const id of cameraIds) {
    if (idx >= tiles.length) {
      // grow layout to fit if needed
      const need = cameraIds.length + start;
      const next = Object.keys(LAYOUTS).map(Number).find((n) => n >= need);
      if (next && next > tiles.length) { setLayout(String(next), true); return fillFrom(start, cameraIds); }
      break;
    }
    assign(idx++, id);
  }
}

function swap(a, b) {
  if (a === b || !tiles[a] || !tiles[b]) return;
  const A = { cameraId: tiles[a].cameraId, stream: tiles[a].stream }, B = { cameraId: tiles[b].cameraId, stream: tiles[b].stream };
  clearTile(a); clearTile(b);
  if (B.cameraId) assign(a, B.cameraId, B.stream);
  if (A.cameraId) assign(b, A.cameraId, A.stream);
}

function setStream(tile, stream) {
  tile.stream = stream;
  tile.streamBtn.textContent = stream === 'main' ? 'MAIN' : 'SUB';
  if (tile.player) tile.player.setStream(stream);
  persistState();
}
function setAudio(tile, on) {
  if (on) for (const t of tiles) if (t !== tile && t.audio) setAudio(t, false); // one audio tile at a time
  tile.audio = on;
  tile.audioBtn.innerHTML = svg(on ? 'audio' : 'mute').innerHTML;
  tile.audioBtn.classList.toggle('on', on);
  if (tile.player) tile.player.setAudio(on);
}
async function snapshot(tile) {
  if (!tile.player) return;
  const url = tile.dewarp ? tile.dewarp.snapshotDataUrl() : tile.player.snapshotDataUrl();
  if (!url) { toast('No frame yet', 'warn'); return; }
  try { const r = await api('files:saveSnapshot', { cameraId: tile.cameraId, dataUrl: url, suffix: tile.dewarp ? '_dewarp' : '' }); toast('Snapshot saved: ' + r.file, 'ok'); } catch (e) { toast(e.message, 'err'); }
}
async function toggleRecord(tile) {
  if (!tile.cameraId) return;
  try {
    if (tile.recording) { await api('record:stop', tile.cameraId); tile.recording = false; }
    else { const r = await api('record:start', { cameraId: tile.cameraId, stream: 'main' }); tile.recording = true; toast('Recording to ' + r.file, 'ok'); }
  } catch (e) { toast(e.message, 'err'); }
  tile.recBtn.classList.toggle('rec', tile.recording);
  tile.recEl.classList.toggle('hidden', !tile.recording);
}
function stopRecordingIfAny(tile) {
  if (tile.recording) { api('record:stop', tile.cameraId).catch(() => {}); tile.recording = false; tile.recBtn.classList.remove('rec'); tile.recEl.classList.add('hidden'); }
}

function selectTile(i) {
  selectedIdx = i;
  tiles.forEach((t, k) => t.el.classList.toggle('selected', k === i));
  if (ptz) ptz.setCamera(tiles[i] && tiles[i].cameraId);
}
function toggleMaximize(i) {
  maximizedIdx = maximizedIdx === i ? -1 : i;
  renderGrid(false);
}

// ---------- layout ----------
function renderGrid(rebuild = true) {
  const def = layoutDef();
  if (rebuild) {
    // keep existing tiles' content where possible
    const prev = tiles;
    tiles = [];
    for (let i = 0; i < def.n; i++) tiles.push(prev[i] || createTile(i));
    for (let i = def.n; i < prev.length; i++) { if (prev[i].player) prev[i].player.destroy(); if (prev[i].cameraId) state.playing.delete(prev[i].cameraId); stopRecordingIfAny(prev[i]); }
    if (maximizedIdx >= def.n) maximizedIdx = -1;
    if (selectedIdx >= def.n) { selectedIdx = -1; if (ptz) ptz.setCamera(null); }
  }
  gridEl.innerHTML = '';
  if (maximizedIdx >= 0) {
    gridEl.style.gridTemplateColumns = '1fr'; gridEl.style.gridTemplateRows = '1fr'; gridEl.style.gridTemplateAreas = '';
    const t = tiles[maximizedIdx]; t.el.style.gridArea = ''; gridEl.append(t.el);
  } else {
    gridEl.style.gridTemplateColumns = `repeat(${def.cols}, 1fr)`;
    gridEl.style.gridTemplateRows = `repeat(${def.rows}, 1fr)`;
    gridEl.style.gridTemplateAreas = def.areas ? def.areas.map((r) => `"${r}"`).join(' ') : '';
    tiles.forEach((t, i) => { t.el.style.gridArea = def.areas ? letters[i] : ''; gridEl.append(t.el); });
  }
  document.querySelectorAll('.layout-btns button').forEach((b) => b.classList.toggle('active', !customLayout && b.dataset.layout === layoutId));
  emit('playing');
  persistState();
}
export function setLayout(id, keep = true) {
  customLayout = null; layoutId = id; maximizedIdx = -1;
  renderGrid(true);
}
function setCustomLayout(cols, rows) {
  customLayout = { n: cols * rows, cols, rows }; maximizedIdx = -1;
  renderGrid(true);
}
export function stopAll() { tiles.forEach((_, i) => clearTile(i)); }

// ---------- saved views ----------
function currentViewData() {
  return { layoutId: customLayout ? null : layoutId, custom: customLayout, cells: tiles.map((t) => (t.cameraId ? { cameraId: t.cameraId, stream: t.stream } : null)) };
}
async function saveView(asNew = false) {
  const existing = !asNew && currentViewId ? state.views.find((v) => v.id === currentViewId) : null;
  const name = await promptText(existing ? 'Update view' : 'Save view', 'View name', existing ? existing.name : `View ${state.views.length + 1}`);
  if (name === null) return;
  const v = await api('views:save', { ...(existing || {}), name, ...currentViewData(), inTour: existing ? existing.inTour : true });
  currentViewId = v.id;
  toast(`View "${name}" saved`, 'ok');
  persistState();
}
export function loadView(v, { keepTour = false } = {}) {
  if (!keepTour) stopTour(false);
  stopAll();
  if (v.custom) { customLayout = v.custom; } else { customLayout = null; layoutId = v.layoutId || '4'; }
  maximizedIdx = -1;
  renderGrid(true);
  (v.cells || []).forEach((c, i) => { if (c && c.cameraId && cameraById(c.cameraId)) assign(i, c.cameraId, c.stream); });
  currentViewId = v.id;
  setStatus(`View: ${v.name}`);
  persistState();
}
function viewsMenu(x, y) {
  const items = state.views.map((v) => ({ label: `${v.inTour !== false ? '◉ ' : '○ '}${v.name}${v.id === currentViewId ? '  ✓' : ''}`, onClick: () => loadView(v) }));
  contextMenu(x, y, [
    ...(items.length ? items : [{ label: 'No saved views', disabled: true }]), '-',
    { label: 'Save current as new view…', icon: 'save', onClick: () => saveView(true) },
    currentViewId && { label: 'Update current view', icon: 'save', onClick: () => saveView(false) },
    { label: 'Manage views…', icon: 'edit', onClick: manageViews },
  ]);
}
function manageViews() {
  const body = el('div', {});
  const render = () => {
    body.innerHTML = '';
    if (!state.views.length) body.append(el('div', { class: 'empty' }, 'No saved views'));
    const table = el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Layout'), el('th', {}, 'Cameras'), el('th', {}, 'In tour'), el('th', {}, 'Startup'), el('th', {}, ''))));
    const tb = el('tbody');
    for (const v of state.views) {
      tb.append(el('tr', {}, el('td', {}, v.name), el('td', {}, v.custom ? `${v.custom.cols}×${v.custom.rows}` : v.layoutId), el('td', {}, String((v.cells || []).filter(Boolean).length)),
        el('td', {}, el('input', { type: 'checkbox', checked: v.inTour !== false, onChange: async (e) => { await api('views:save', { ...v, inTour: e.target.checked }); } })),
        el('td', {}, el('input', { type: 'radio', name: 'startup', checked: state.settings.startupView === v.id, onChange: async () => { await api('settings:set', { startupView: v.id }); state.settings.startupView = v.id; } })),
        el('td', {}, el('div', { class: 'row' },
          btn('Load', { cls: 'sm' }, () => { loadView(v); m.close(); }),
          btn('Rename', { cls: 'sm' }, async () => { const n = await promptText('Rename view', 'Name', v.name); if (n) { await api('views:save', { ...v, name: n }); await refreshViews(); render(); } }),
          btn('Delete', { cls: 'sm danger' }, async () => { if (await confirm(`Delete view "${v.name}"?`, { danger: true, okLabel: 'Delete' })) { await api('views:remove', v.id); if (currentViewId === v.id) currentViewId = null; await refreshViews(); render(); } })))));
    }
    table.append(tb); body.append(table);
    body.append(el('div', { class: 'row', style: { marginTop: '10px' } }, btn('Clear startup view', { cls: 'sm' }, async () => { await api('settings:set', { startupView: null }); state.settings.startupView = null; render(); })));
  };
  render();
  const m = modal({ title: 'Manage views', body, size: 'wide', buttons: [{ label: 'Close', primary: true }] });
}
async function refreshViews() { state.views = await api('views:list'); }

// ---------- tour ----------
function startTour() {
  const list = state.views.filter((v) => v.inTour !== false);
  if (list.length < 2) { toast('Save at least two views (marked "in tour") to start a tour', 'warn'); return; }
  const interval = Math.max(3, Number(state.settings.autoSwitchInterval) || 10) * 1000;
  tourIdx = Math.max(0, list.findIndex((v) => v.id === currentViewId));
  const step = () => { const l = state.views.filter((v) => v.inTour !== false); if (!l.length) return stopTour(); tourIdx = (tourIdx + 1) % l.length; loadView(l[tourIdx], { keepTour: true }); };
  tourTimer = setInterval(step, interval);
  document.getElementById('btn-tour').classList.add('active');
  setStatus(`Tour running (${interval / 1000}s)`);
}
function stopTour(notify = true) {
  if (tourTimer) { clearInterval(tourTimer); tourTimer = null; if (notify) setStatus('Tour stopped'); }
  const b = document.getElementById('btn-tour'); if (b) b.classList.remove('active');
}
function togglePtzPanel(show) {
  const on = show === undefined ? sideRight.classList.contains('hidden') : show;
  sideRight.classList.toggle('hidden', !on);
  localStorage.setItem('live.ptzPanel', on ? '1' : '0');
  document.getElementById('btn-ptz-panel').classList.toggle('active', on);
}

// ---------- mount ----------
export function mount(container, p = {}) {
  pendingParams = p;
  const side = el('aside', { class: 'side' });
  const content = el('section', { class: 'content' });
  gridEl = el('div', { class: 'vgrid' });
  const gridWrap = el('div', { class: 'grid-wrap' }, gridEl);

  const layoutBtns = el('div', { class: 'layout-btns' });
  for (const k of Object.keys(LAYOUTS)) layoutBtns.append(el('button', { dataset: { layout: k }, title: `${k} windows`, onClick: () => setLayout(k) }, k));
  const cols = el('input', { type: 'number', min: 1, max: 12, value: 3, style: { width: '46px' }, title: 'Columns' });
  const rows = el('input', { type: 'number', min: 1, max: 12, value: 2, style: { width: '46px' }, title: 'Rows' });
  const bottom = el('div', { class: 'toolbar bottom' },
    layoutBtns, el('div', { class: 'sep' }),
    el('span', { class: 'dim small' }, 'Custom'), cols, el('span', { class: 'dim' }, '×'), rows, btn('Apply', { cls: 'sm' }, () => setCustomLayout(Number(cols.value) || 1, Number(rows.value) || 1)),
    el('div', { class: 'sep' }),
    btn('Views', { cls: 'sm', icon: 'grid', title: 'Saved views' }, (e) => viewsMenu(e.clientX, e.clientY - 200)),
    btn('Save', { cls: 'sm', icon: 'save', title: 'Save view' }, () => saveView(!currentViewId)),
    el('button', { id: 'btn-tour', class: 'btn sm', title: 'Auto-switch between saved views', onClick: () => (tourTimer ? stopTour() : startTour()) }, svg('tour'), 'Tour'),
    el('div', { class: 'spacer' }),
    el('button', { id: 'btn-ptz-panel', class: 'btn sm', title: 'PTZ panel', onClick: () => togglePtzPanel() }, svg('ptz'), 'PTZ'),
    btn('Stop all', { cls: 'sm', icon: 'stop' }, stopAll),
    btn('', { cls: 'sm', icon: 'fullscreen', title: 'Fullscreen' }, () => api('window:fullscreen')),
  );
  content.append(gridWrap, bottom);
  sideRight = el('aside', { class: 'side right' }, el('div', { class: 'side-head' }, svg('ptz'), 'PTZ control'));
  ptz = createPtzPanel(sideRight);
  if (localStorage.getItem('live.ptzPanel') !== '1') sideRight.classList.add('hidden');
  container.append(side, content, sideRight);
  root = container;

  tree = createCameraTree(side, {
    onActivate: (cam) => {
      let idx = selectedIdx >= 0 && tiles[selectedIdx] && !tiles[selectedIdx].cameraId ? selectedIdx : tiles.findIndex((t) => !t.cameraId);
      if (idx < 0) idx = selectedIdx >= 0 && tiles[selectedIdx] ? selectedIdx : 0;
      assign(idx, cam.id); selectTile(idx);
    },
    onActivateDevice: (cams) => { fillFrom(0, cams.filter((c) => !c.hidden).map((c) => c.id)); },
  });

  // restore state
  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem('live.state') || 'null');
    const startup = state.settings.startupView && state.views.find((v) => v.id === state.settings.startupView);
    if (startup && !p.cameraId && !sessionStorage.getItem('live.booted')) { renderGrid(true); loadView(startup); restored = true; }
    else if (saved) {
      layoutId = saved.layoutId || '4'; customLayout = saved.custom || saved.customLayout || null; currentViewId = saved.currentViewId || null;
      renderGrid(true);
      (saved.cells || []).forEach((c, i) => { if (c && c.cameraId && cameraById(c.cameraId)) assign(i, c.cameraId, c.stream); });
      restored = true;
    }
  } catch (_) {}
  sessionStorage.setItem('live.booted', '1');
  if (!restored) renderGrid(true);
  if (p.deviceId) fillFrom(0, state.cameras.filter((c) => c.deviceId === p.deviceId && !c.hidden).map((c) => c.id));
  if (p.cameraId) {
    let idx = tiles.findIndex((t) => t.cameraId === p.cameraId);
    if (idx < 0) idx = tiles.findIndex((t) => !t.cameraId);
    if (idx < 0) idx = 0;
    assign(idx, p.cameraId); selectTile(idx);
  }
  document.querySelectorAll('.layout-btns button').forEach((b) => b.classList.toggle('active', !customLayout && b.dataset.layout === layoutId));

  const onKey = (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape' && maximizedIdx >= 0) toggleMaximize(maximizedIdx);
    if (e.key === 'Delete' && selectedIdx >= 0) clearTile(selectedIdx);
  };
  document.addEventListener('keydown', onKey);
  unsubs.push(() => document.removeEventListener('keydown', onKey));
  const onData = () => { for (const t of tiles) if (t.cameraId) { const c = cameraById(t.cameraId); if (c) t.label.textContent = c.name; } };
  bus.addEventListener('data', onData);
  unsubs.push(() => bus.removeEventListener('data', onData));
  setStatus('Main View');
}

export function unmount() {
  stopTour(false);
  if (tree) { tree.destroy(); tree = null; }
  for (const t of tiles) { if (t.talk) t.talk.stop().catch(() => {}); if (t.dewarp) t.dewarp.stop(); if (t.player) t.player.destroy(); stopRecordingIfAny(t); }
  state.playing.clear();
  tiles = [];
  for (const u of unsubs) u();
  unsubs = [];
  selectedIdx = -1; maximizedIdx = -1;
}
