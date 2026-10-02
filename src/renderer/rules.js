// Hikvision smart event rule editor: motion detection grid, line crossing, intrusion (field detection).
// Reads the device configuration, lets the user draw on a snapshot, writes the same structure back.
import { api, el, svg, btn, toast, modal, cameraById } from './core.js';

const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const NORM = 1000;

export async function openRulesEditor(cameraId) {
  const cam = cameraById(cameraId);
  if (!cam) return;
  const body = el('div', {}, el('div', { class: 'empty' }, 'Reading device configuration…'));
  const m = modal({ title: `Event rules — ${cam.name}`, size: 'large', body, buttons: [{ label: 'Close', primary: true }] });
  let caps;
  try { caps = await api('rules:caps', cameraId); } catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'err' }, e.message)); return; }
  const kinds = [['motion', 'Motion detection'], ['line', 'Line crossing'], ['intrusion', 'Intrusion']].filter(([k]) => caps[k]);
  body.innerHTML = '';
  if (!kinds.length) { body.append(el('div', { class: 'empty' }, 'This channel does not expose motion / line crossing / intrusion settings over ISAPI. On NVRs these are usually configured on the camera itself: add the camera by its own IP.')); return; }

  // snapshot background + overlay canvas
  const img = el('img', { style: { display: 'block', width: '100%', maxHeight: '58vh', objectFit: 'contain', background: '#000' } });
  const canvas = el('canvas', { style: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', cursor: 'crosshair' } });
  const stage = el('div', { style: { position: 'relative', background: '#000', flex: '1', minWidth: 0 } }, img, canvas);
  const panel = el('div', { style: { width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '8px' } });
  const tabs = el('div', { class: 'tabs', style: { padding: 0 } });
  const hint = el('div', { class: 'dim small' });
  body.append(tabs, el('div', { class: 'row', style: { alignItems: 'stretch', marginTop: '10px' } }, stage, panel), hint);
  api('cameras:snapshot', { cameraId, stream: 'main' }).then((r) => { img.src = `data:${r.contentType};base64,${r.data}`; }).catch(() => { img.alt = 'no snapshot'; img.style.minHeight = '360px'; });
  const ro = new ResizeObserver(() => { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; draw(); });
  ro.observe(stage);
  m.el.addEventListener('click', () => {}, { once: true });

  let kind = kinds[0][0], cfg = null, root = null, draw = () => {}, sel = 0, drawing = null;
  const ctx = canvas.getContext('2d');
  const toPx = (x, y) => [x / NORM * canvas.width, y / NORM * canvas.height];
  const toNorm = (ev) => { const r = canvas.getBoundingClientRect(); return [Math.round(Math.max(0, Math.min(NORM, ((ev.clientX - r.left) / r.width) * NORM))), Math.round(Math.max(0, Math.min(NORM, ((ev.clientY - r.top) / r.height) * NORM)))]; };

  async function load(k) {
    kind = k;
    for (const b of tabs.children) b.classList.toggle('active', b.dataset.k === k);
    panel.innerHTML = ''; panel.append(el('div', { class: 'dim small' }, 'Loading…'));
    try { const r = await api('rules:get', { cameraId, kind: k }); cfg = r.config; } catch (e) { panel.innerHTML = ''; panel.append(el('div', { class: 'err small' }, e.message)); return; }
    root = cfg[Object.keys(cfg).find((key) => !key.startsWith('?'))];
    sel = 0; drawing = null;
    ({ motion: setupMotion, line: setupLine, intrusion: setupIntrusion })[k]();
  }
  for (const [k, label] of kinds) tabs.append(el('button', { dataset: { k }, onClick: () => load(k) }, label));

  const save = async () => { try { await api('rules:set', { cameraId, kind, config: cfg }); toast('Rule saved to device', 'ok'); } catch (e) { toast('Save failed: ' + e.message, 'err', 6000); } };
  const field = (label, input) => el('label', { class: 'field' }, label, input);
  const check = (label, get, set) => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: get() === 'true' || get() === true, onChange: (e) => { set(e.target.checked ? 'true' : 'false'); draw(); } }), label);
  const range = (label, get, set, min = 0, max = 100) => { const out = el('span', { class: 'dim small' }, String(get())); return el('label', { class: 'field' }, el('span', {}, label, ' ', out), el('input', { type: 'range', min, max, value: Number(get()) || 0, onInput: (e) => { set(String(e.target.value)); out.textContent = e.target.value; } })); };

  // ---------- motion grid ----------
  function setupMotion() {
    const grid = root.Grid || { rowGranularity: '18', columnGranularity: '22' };
    const rows = Number(grid.rowGranularity) || 18, cols = Number(grid.columnGranularity) || 22;
    const layout = root.MotionDetectionLayout || (root.MotionDetectionLayout = { sensitivityLevel: '50', layout: { gridMap: '' } });
    if (!layout.layout) layout.layout = { gridMap: '' };
    const bytesPerRow = Math.ceil(cols / 8);
    const cells = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const hex = String(layout.layout.gridMap || '');
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const byte = parseInt(hex.substr((r * bytesPerRow + (c >> 3)) * 2, 2), 16) || 0;
      cells[r][c] = !!(byte & (0x80 >> (c & 7)));
    }
    const encode = () => { let out = ''; for (let r = 0; r < rows; r++) { const bytes = new Array(bytesPerRow).fill(0); for (let c = 0; c < cols; c++) if (cells[r][c]) bytes[c >> 3] |= 0x80 >> (c & 7); out += bytes.map((b) => b.toString(16).padStart(2, '0')).join(''); } layout.layout.gridMap = out; };
    draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cw = canvas.width / cols, ch = canvas.height / rows;
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.fillStyle = 'rgba(239,83,80,.35)';
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { if (cells[r][c]) ctx.fillRect(c * cw, r * ch, cw, ch); ctx.strokeRect(c * cw, r * ch, cw, ch); }
    };
    let paint = null;
    canvas.onpointerdown = (e) => { const [x, y] = toNorm(e); const c = Math.min(cols - 1, Math.floor(x / NORM * cols)), r = Math.min(rows - 1, Math.floor(y / NORM * rows)); paint = !cells[r][c]; cells[r][c] = paint; encode(); draw(); canvas.setPointerCapture(e.pointerId); };
    canvas.onpointermove = (e) => { if (paint === null) return; const [x, y] = toNorm(e); const c = Math.min(cols - 1, Math.floor(x / NORM * cols)), r = Math.min(rows - 1, Math.floor(y / NORM * rows)); if (cells[r][c] !== paint) { cells[r][c] = paint; encode(); draw(); } };
    canvas.onpointerup = () => { paint = null; };
    canvas.ondblclick = null;
    panel.innerHTML = '';
    panel.append(check('Motion detection enabled', () => root.enabled, (v) => { root.enabled = v; }),
      range('Sensitivity', () => layout.sensitivityLevel, (v) => { layout.sensitivityLevel = v; }),
      el('div', { class: 'row' }, btn('Select all', { cls: 'sm' }, () => { cells.forEach((row) => row.fill(true)); encode(); draw(); }), btn('Clear', { cls: 'sm' }, () => { cells.forEach((row) => row.fill(false)); encode(); draw(); })),
      el('div', { class: 'dim small' }, `${rows} × ${cols} grid. Click or drag on the picture to toggle cells.`),
      btn('Save to device', { cls: 'primary', icon: 'save' }, save));
    hint.textContent = 'Red cells are monitored for motion.';
    draw();
  }

  // ---------- line crossing ----------
  function setupLine() {
    const list = root.LineItemList || (root.LineItemList = { '@_size': '4', LineItem: [] });
    const max = Number(list['@_size']) || 4;
    let items = asArray(list.LineItem);
    while (items.length < max) items.push({ id: String(items.length + 1), enabled: 'false', sensitivityLevel: '50', directionSensitivity: 'any', CoordinatesList: { Coordinates: [{ positionX: '300', positionY: '500' }, { positionX: '700', positionY: '500' }] } });
    items = items.slice(0, max).map((it, i) => ({ ...it, id: String(it.id || i + 1), CoordinatesList: { Coordinates: asArray((it.CoordinatesList || {}).Coordinates) } }));
    list.LineItem = items;
    const pts = (it) => it.CoordinatesList.Coordinates;
    draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      items.forEach((it, i) => {
        const p = pts(it); if (p.length < 2) return;
        const [x1, y1] = toPx(+p[0].positionX, +p[0].positionY), [x2, y2] = toPx(+p[1].positionX, +p[1].positionY);
        ctx.lineWidth = i === sel ? 3 : 2; ctx.strokeStyle = it.enabled === 'true' ? (i === sel ? '#ffd54f' : '#3ac46b') : (i === sel ? '#ffd54f' : 'rgba(255,255,255,.35)');
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        // direction arrow(s) at the midpoint
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, ang = Math.atan2(y2 - y1, x2 - x1), len = 18;
        const arrow = (dir) => { const a = ang + dir * Math.PI / 2; ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + Math.cos(a) * len, my + Math.sin(a) * len); ctx.stroke(); };
        if (it.directionSensitivity === 'any' || it.directionSensitivity === 'left-right') arrow(1);
        if (it.directionSensitivity === 'any' || it.directionSensitivity === 'right-left') arrow(-1);
        ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.fillText(`Line ${it.id}`, x1 + 4, y1 - 4);
      });
      if (drawing && drawing.p1) { const [x, y] = toPx(drawing.p1[0], drawing.p1[1]); ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }
    };
    canvas.onpointerdown = (e) => {
      const p = toNorm(e);
      if (!drawing) { drawing = { p1: p }; hint.textContent = 'Click the second point of the line.'; }
      else { pts(items[sel]).splice(0, 2, { positionX: String(drawing.p1[0]), positionY: String(drawing.p1[1]) }, { positionX: String(p[0]), positionY: String(p[1]) }); drawing = null; hint.textContent = 'Line set. Click two points to redraw the selected line.'; }
      draw();
    };
    canvas.onpointermove = null; canvas.onpointerup = null; canvas.ondblclick = null;
    const renderPanel = () => {
      panel.innerHTML = '';
      const it = items[sel];
      panel.append(check('Line crossing enabled (channel)', () => root.enabled, (v) => { root.enabled = v; }),
        field('Line', el('select', { onChange: (e) => { sel = Number(e.target.value); drawing = null; renderPanel(); draw(); } }, ...items.map((x, i) => el('option', { value: i, selected: i === sel }, `Line ${x.id}${x.enabled === 'true' ? ' (on)' : ''}`)))),
        check('This line enabled', () => it.enabled, (v) => { it.enabled = v; renderPanel(); }),
        field('Direction', el('select', { onChange: (e) => { it.directionSensitivity = e.target.value; draw(); } }, ...[['any', 'Both directions'], ['left-right', 'A → B'], ['right-left', 'B → A']].map(([v, l]) => el('option', { value: v, selected: it.directionSensitivity === v }, l)))),
        range('Sensitivity', () => it.sensitivityLevel, (v) => { it.sensitivityLevel = v; }),
        el('div', { class: 'dim small' }, 'Click two points on the picture to place the selected line.'),
        btn('Save to device', { cls: 'primary', icon: 'save' }, save));
    };
    renderPanel();
    hint.textContent = 'Click two points on the picture to draw the selected line.';
    draw();
  }

  // ---------- intrusion polygons ----------
  function setupIntrusion() {
    const list = root.FieldDetectionRegionList || (root.FieldDetectionRegionList = { '@_size': '4', FieldDetectionRegion: [] });
    const max = Number(list['@_size']) || 4;
    let regions = asArray(list.FieldDetectionRegion);
    while (regions.length < max) regions.push({ id: String(regions.length + 1), enabled: 'false', sensitivityLevel: '50', objectOccupation: '1', timeThreshold: '0', RegionCoordinatesList: { RegionCoordinates: [] } });
    regions = regions.slice(0, max).map((r, i) => ({ ...r, id: String(r.id || i + 1), RegionCoordinatesList: { RegionCoordinates: asArray((r.RegionCoordinatesList || {}).RegionCoordinates) } }));
    list.FieldDetectionRegion = regions;
    const pts = (r) => r.RegionCoordinatesList.RegionCoordinates;
    draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      regions.forEach((r, i) => {
        const p = pts(r); if (!p.length) return;
        ctx.lineWidth = i === sel ? 3 : 2; ctx.strokeStyle = i === sel ? '#ffd54f' : r.enabled === 'true' ? '#b069ff' : 'rgba(255,255,255,.35)'; ctx.fillStyle = i === sel ? 'rgba(255,213,79,.15)' : 'rgba(176,105,255,.15)';
        ctx.beginPath(); p.forEach((c, k) => { const [x, y] = toPx(+c.positionX, +c.positionY); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        if (!(drawing && i === sel)) ctx.closePath();
        ctx.fill(); ctx.stroke();
        p.forEach((c) => { const [x, y] = toPx(+c.positionX, +c.positionY); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); });
        const [lx, ly] = toPx(+p[0].positionX, +p[0].positionY); ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.fillText(`Region ${r.id}`, lx + 4, ly - 6);
      });
    };
    canvas.onpointerdown = (e) => {
      const p = toNorm(e);
      if (!drawing) { drawing = true; pts(regions[sel]).length = 0; }
      if (pts(regions[sel]).length < 10) pts(regions[sel]).push({ positionX: String(p[0]), positionY: String(p[1]) });
      hint.textContent = `${pts(regions[sel]).length} point(s). Double-click or press Finish to close the region (3–10 points).`;
      draw();
    };
    canvas.ondblclick = () => finish();
    canvas.onpointermove = null; canvas.onpointerup = null;
    const finish = () => { if (pts(regions[sel]).length < 3) { toast('A region needs at least 3 points', 'warn'); return; } drawing = null; hint.textContent = 'Region closed. Click on the picture to start a new polygon for the selected region.'; draw(); };
    const renderPanel = () => {
      panel.innerHTML = '';
      const r = regions[sel];
      panel.append(check('Intrusion detection enabled (channel)', () => root.enabled, (v) => { root.enabled = v; }),
        field('Region', el('select', { onChange: (e) => { sel = Number(e.target.value); drawing = null; renderPanel(); draw(); } }, ...regions.map((x, i) => el('option', { value: i, selected: i === sel }, `Region ${x.id}${x.enabled === 'true' ? ' (on)' : ''}`)))),
        check('This region enabled', () => r.enabled, (v) => { r.enabled = v; renderPanel(); }),
        range('Sensitivity', () => r.sensitivityLevel, (v) => { r.sensitivityLevel = v; }),
        range('Time threshold (s)', () => r.timeThreshold, (v) => { r.timeThreshold = v; }, 0, 10),
        range('Object size (%)', () => r.objectOccupation, (v) => { r.objectOccupation = v; }, 1, 100),
        el('div', { class: 'row' }, btn('Finish polygon', { cls: 'sm' }, finish), btn('Clear region', { cls: 'sm' }, () => { pts(r).length = 0; drawing = null; draw(); })),
        btn('Save to device', { cls: 'primary', icon: 'save' }, save));
    };
    renderPanel();
    hint.textContent = 'Click points on the picture to draw the region, double-click to close it.';
    draw();
  }

  load(kind);
}
