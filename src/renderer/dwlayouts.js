// Import DW Spectrum layouts as Main View layouts. The copies are ordinary, editable layouts; importing a DW layout
// again replaces the earlier copy of it.
import { state, el, api, toast, modal, btn, areaName } from './core.js';

// DW item rectangles are in cell units (right/bottom exclusive). Every DW cell becomes a tile: merged items keep their
// size through grid areas, empty cells stay empty tiles you can drop cameras on. Items that are not cameras of this
// server (web pages, deleted cameras…) are dropped.
export function toView(l, deviceId) {
  const known = new Set(state.cameras.map((c) => c.id));
  const items = l.items.filter((i) => i.w >= 1 && i.h >= 1 && known.has(`${deviceId}:${i.uuid}`));
  if (!items.length) return null;
  const x0 = Math.min(...items.map((i) => i.x)), y0 = Math.min(...items.map((i) => i.y));
  const cols = Math.max(...items.map((i) => i.x + i.w)) - x0, rows = Math.max(...items.map((i) => i.y + i.h)) - y0;
  const owner = Array.from({ length: rows }, () => Array(cols).fill(-1)); // cell -> index in placed
  const placed = [];
  for (const i of items) {
    const x = i.x - x0, y = i.y - y0;
    let free = true;
    for (let r = y; r < y + i.h; r++) for (let c = x; c < x + i.w; c++) if (owner[r][c] >= 0) free = false;
    if (!free) continue; // overlapping item (rare in DW): first one wins
    for (let r = y; r < y + i.h; r++) for (let c = x; c < x + i.w; c++) owner[r][c] = placed.length;
    placed.push({ cameraId: `${deviceId}:${i.uuid}` });
  }
  // tiles in reading order of their top-left cell
  const tileOf = Array.from({ length: rows }, () => Array(cols).fill(-1)), cells = [], tileOfPlaced = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = owner[r][c];
    if (p < 0) { tileOf[r][c] = cells.length; cells.push(null); } else {
      if (!tileOfPlaced.has(p)) { tileOfPlaced.set(p, cells.length); cells.push({ cameraId: placed[p].cameraId }); }
      tileOf[r][c] = tileOfPlaced.get(p);
    }
  }
  const custom = { n: cells.length, cols, rows };
  if (cells.length < cols * rows) custom.areas = tileOf.map((row) => row.map(areaName).join(' '));
  return { name: l.name, layoutId: null, custom, cells, inTour: false, dw: { deviceId, layoutId: l.id } };
}

export async function importDwLayouts(dev) {
  let list;
  try { list = await api('dw:layouts', dev.id); } catch (e) { toast(`Could not read layouts: ${e.message}`, 'err'); return; }
  const existing = new Map(state.views.filter((v) => v.dw && v.dw.deviceId === dev.id).map((v) => [v.dw.layoutId, v]));
  const rows = list.map((l) => ({ l, view: toView(l, dev.id) })).filter((r) => r.view).sort((a, b) => a.l.name.localeCompare(b.l.name));
  if (!rows.length) { toast('No layouts with cameras of this server', 'warn'); return; }
  const checked = new Set(rows.filter((r) => !existing.has(r.l.id)).map((r) => r.l.id));
  let filter = '';
  const listEl = el('div', { class: 'dwl-list' });
  const count = el('span', { class: 'dim small' });
  const render = () => {
    listEl.innerHTML = '';
    for (const { l, view } of rows) {
      if (filter && !l.name.toLowerCase().includes(filter)) continue;
      const n = view.cells.filter(Boolean).length;
      const box = el('input', { type: 'checkbox', checked: checked.has(l.id), onChange: (e) => { e.target.checked ? checked.add(l.id) : checked.delete(l.id); count.textContent = `${checked.size} selected`; } });
      listEl.append(el('label', { class: 'dwl-row' }, box, el('span', { class: 'lbl' }, l.name),
        el('span', { class: 'dim small' }, `${n} camera${n === 1 ? '' : 's'} • ${view.custom.cols}×${view.custom.rows}${l.shared ? ' • shared' : ''}${existing.has(l.id) ? ' • imported, will be replaced' : ''}`)));
    }
    count.textContent = `${checked.size} selected`;
  };
  const visible = () => rows.filter((r) => !filter || r.l.name.toLowerCase().includes(filter)).map((r) => r.l.id);
  const body = el('div', { class: 'col' },
    el('div', { class: 'row' },
      el('input', { type: 'search', placeholder: 'Filter layouts…', onInput: (e) => { filter = e.target.value.toLowerCase(); render(); } }),
      btn('All', { cls: 'sm' }, () => { visible().forEach((id) => checked.add(id)); render(); }),
      btn('None', { cls: 'sm' }, () => { visible().forEach((id) => checked.delete(id)); render(); }), count),
    listEl,
    el('div', { class: 'dim small' }, `Shared layouts and the layouts of ${dev.username || 'this account'}. ${list.length - rows.length} without cameras of this server are not listed. Imported layouts can be edited freely.`));
  render();
  modal({ title: `Import layouts from ${dev.name}`, size: 'wide', body, buttons: [
    { label: 'Cancel' },
    { label: 'Import', primary: true, onClick: async () => {
      const items = rows.filter((r) => checked.has(r.l.id)).map((r) => ({ ...r.view, id: existing.has(r.l.id) ? existing.get(r.l.id).id : undefined }));
      if (!items.length) { toast('Nothing selected', 'warn'); return false; }
      await api('views:import', items);
      toast(`${items.length} layout(s) imported — see Layouts in Main View`, 'ok');
    } },
  ] });
}
