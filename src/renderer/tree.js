// Camera tree (by device or by group) with search, drag & drop, context menu
import { state, el, svg, bus, api, toast, contextMenu, promptText, modal, deviceById, actions } from './core.js';

export const DT_CAMERA = 'application/x-univms-camera';
export const DT_DEVICE = 'application/x-univms-device';
export const DT_GROUP = 'application/x-univms-group';

/**
 * createCameraTree(container, { onActivate(camera), onActivateDevice(device, cameras), draggable, showHidden, selectable, onSelect(camera), multi, onContext })
 * returns { refresh(), selected(), setSelected(id) }
 */
export function createCameraTree(container, opts = {}) {
  let mode = localStorage.getItem('tree.mode') || 'device';
  let filter = '';
  let selected = new Set();
  const collapsed = new Set(JSON.parse(localStorage.getItem('tree.collapsed') || '[]'));

  const head = el('div', { class: 'toolbar', style: { padding: '6px 8px' } });
  const search = el('input', { type: 'text', placeholder: 'Search cameras…', onInput: (e) => { filter = e.target.value.toLowerCase(); render(); } });
  const sbox = el('div', { class: 'search-box grow' }, svg('search'), search);
  const modeBtn = el('button', { class: 'icon-btn', title: 'Toggle device / group view', onClick: () => { mode = mode === 'device' ? 'group' : 'device'; localStorage.setItem('tree.mode', mode); render(); } }, svg('grid'));
  head.append(sbox, modeBtn);
  const body = el('div', { class: 'tree side-body' });
  container.append(head, body);

  function statusOf(cam) {
    const ds = state.status[cam.deviceId];
    if (ds && ds.online === false) return 'off';
    if (cam.online === false) return 'off';
    if (cam.online === true) return 'on';
    return 'unknown';
  }

  function camNode(cam, depth) {
    const st = statusOf(cam);
    const node = el('div', { class: `node camera ${st} ${selected.has(cam.id) ? 'selected' : ''} ${state.playing.has(cam.id) ? 'playing' : ''} ${cam.hidden ? 'hidden-cam' : ''}`, draggable: opts.draggable !== false, title: `${cam.name}${cam.ip ? ' • ' + cam.ip : ''}${cam.streams && cam.streams.main && cam.streams.main.codec ? ' • ' + cam.streams.main.codec : ''}`, dataset: { id: cam.id } },
      svg('camera'), el('span', { class: 'lbl' }, cam.name), cam.ptzHint ? el('span', { class: 'cnt', title: 'PTZ' }, 'PTZ') : null);
    node.addEventListener('click', (e) => {
      if (opts.multi && (e.ctrlKey || e.metaKey)) { selected.has(cam.id) ? selected.delete(cam.id) : selected.add(cam.id); }
      else { selected = new Set([cam.id]); }
      render();
      opts.onSelect && opts.onSelect(cam, [...selected]);
    });
    node.addEventListener('dblclick', () => opts.onActivate && opts.onActivate(cam));
    node.addEventListener('dragstart', (e) => { e.dataTransfer.setData(DT_CAMERA, cam.id); e.dataTransfer.setData('text/plain', cam.name); e.dataTransfer.effectAllowed = 'copy'; });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [
        { label: opts.activateLabel || 'Open in live view', icon: 'play', onClick: () => opts.onActivate && opts.onActivate(cam) },
        '-',
        { label: 'Rename (local alias)…', icon: 'edit', onClick: async () => { const n = await promptText('Rename camera', 'Display name', cam.name); if (n !== null) { await api('devices:setCameraAlias', { cameraId: cam.id, name: n.trim() || cam.originalName }); } } },
        { label: cam.hidden ? 'Unhide camera' : 'Hide camera', icon: cam.hidden ? 'eye' : 'eyeoff', onClick: () => api('devices:setCameraAlias', { cameraId: cam.id, hidden: !cam.hidden }) },
        { label: 'Snapshot from device', icon: 'snapshot', onClick: async () => { try { const r = await api('files:saveDeviceSnapshot', { cameraId: cam.id }); toast('Saved ' + r.file, 'ok'); } catch (err) { toast(err.message, 'err'); } } },
        { label: 'Camera details', icon: 'info', onClick: () => showCameraInfo(cam) },
        (deviceById(cam.deviceId) || {}).type === 'hikvision' ? { label: 'Event rules (motion / line / intrusion)…', icon: 'alert', onClick: () => import('./rules.js').then((m) => m.openRulesEditor(cam.id)) } : null,
      ];
      if (opts.extraContext) items.push(...opts.extraContext(cam));
      contextMenu(e.clientX, e.clientY, items);
    });
    return node;
  }

  function groupNode(key, label, icon, cams, dragData) {
    const isCollapsed = collapsed.has(key) && !filter;
    const onlineCount = cams.filter((c) => statusOf(c) === 'on').length;
    const header = el('div', { class: `node device ${isCollapsed ? 'collapsed' : ''}`, draggable: opts.draggable !== false },
      el('span', { class: 'caret', html: '▾' }), svg(icon), el('span', { class: 'lbl' }, label), el('span', { class: 'cnt' }, `${onlineCount}/${cams.length}`));
    header.addEventListener('click', () => { collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); localStorage.setItem('tree.collapsed', JSON.stringify([...collapsed])); render(); });
    header.addEventListener('dblclick', () => opts.onActivateDevice && opts.onActivateDevice(cams));
    header.addEventListener('dragstart', (e) => { e.dataTransfer.setData(dragData.type, dragData.value); e.dataTransfer.setData('text/plain', label); });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const dev = dragData.type === DT_DEVICE ? deviceById(dragData.value) : null;
      contextMenu(e.clientX, e.clientY, dev ? deviceMenuItems(dev, cams, opts) : [
        { label: 'Open all in live view', icon: 'play', onClick: () => opts.onActivateDevice && opts.onActivateDevice(cams) },
        { label: isCollapsed ? 'Expand' : 'Collapse', onClick: () => header.click() },
      ]);
    });
    const kids = el('div', { class: 'children' });
    if (!isCollapsed) for (const c of cams) kids.append(camNode(c));
    return el('div', {}, header, kids);
  }

  function visible(c) {
    if (c.hidden && !opts.showHidden) return false;
    if (!filter) return true;
    return (c.name || '').toLowerCase().includes(filter) || (c.ip || '').includes(filter) || (c.deviceName || '').toLowerCase().includes(filter);
  }

  function render() {
    body.innerHTML = '';
    const cams = state.cameras.filter(visible);
    if (!state.devices.length) {
      body.append(el('div', { class: 'empty' }, svg('devices'), 'No devices yet.', el('br'), 'Add a Hikvision NVR or DW Spectrum server in Device Management.'));
      return;
    }
    if (mode === 'device') {
      for (const d of state.devices) {
        const dc = cams.filter((c) => c.deviceId === d.id);
        if (filter && !dc.length) continue;
        const ds = state.status[d.id];
        const label = d.name + (ds && ds.online === false ? ' (offline)' : '');
        if (d.type === 'dwspectrum') {
          // sub-group DW cameras by their server-side group
          const groups = new Map();
          for (const c of dc) { const g = c.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
          if (groups.size > 1) {
            const key = d.id;
            const isCollapsed = collapsed.has(key) && !filter;
            const header = el('div', { class: `node device ${isCollapsed ? 'collapsed' : ''}`, draggable: true }, el('span', { class: 'caret', html: '▾' }), svg('server'), el('span', { class: 'lbl' }, label), el('span', { class: 'cnt' }, `${dc.filter((c) => statusOf(c) === 'on').length}/${dc.length}`));
            header.addEventListener('click', () => { collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); localStorage.setItem('tree.collapsed', JSON.stringify([...collapsed])); render(); });
            header.addEventListener('dblclick', () => opts.onActivateDevice && opts.onActivateDevice(dc));
            header.addEventListener('dragstart', (e) => { e.dataTransfer.setData(DT_DEVICE, d.id); e.dataTransfer.setData('text/plain', d.name); });
            header.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, deviceMenuItems(d, dc, opts)); });
            const kids = el('div', { class: 'children' });
            if (!isCollapsed) for (const [g, gc] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) kids.append(groupNode(d.id + '/' + g, g || 'Ungrouped', 'folder', gc, { type: DT_GROUP, value: gc.map((c) => c.id).join(',') }));
            body.append(el('div', {}, header, kids));
            continue;
          }
        }
        body.append(groupNode(d.id, label, d.type === 'dwspectrum' ? 'server' : 'nvr', dc, { type: DT_DEVICE, value: d.id }));
      }
    } else {
      for (const g of state.groups) {
        const gc = (g.cameras || []).map((id) => cams.find((c) => c.id === id)).filter(Boolean);
        if (filter && !gc.length) continue;
        body.append(groupNode('g:' + g.id, g.name, 'folder', gc, { type: DT_GROUP, value: gc.map((c) => c.id).join(',') }));
      }
      if (!state.groups.length) body.append(el('div', { class: 'empty small' }, 'No groups. Create groups in Device Management → Groups.'));
    }
  }

  bus.addEventListener('data', render);
  bus.addEventListener('status', render);
  bus.addEventListener('playing', render);
  render();
  const destroy = () => { bus.removeEventListener('data', render); bus.removeEventListener('status', render); bus.removeEventListener('playing', render); };
  return { refresh: render, destroy, selected: () => [...selected], setSelected: (ids) => { selected = new Set([].concat(ids)); render(); }, get mode() { return mode; } };
}

/** Right-click menu for a device (shared by the tree and the device table). */
export function deviceMenuItems(dev, cams, opts = {}) {
  const run = (name, ...a) => (actions[name] ? actions[name](...a) : toast('Open Device Management to do that', 'warn'));
  return [
    { label: 'Open all cameras in live view', icon: 'play', onClick: () => (opts.onActivateDevice ? opts.onActivateDevice(cams) : window.__navigate('live', { deviceId: dev.id })) },
    '-',
    { label: 'Edit device…', icon: 'edit', onClick: () => run('editDevice', dev) },
    { label: 'Rename…', icon: 'edit', onClick: () => run('renameDevice', dev) },
    { label: 'Remote configuration…', icon: 'settings', onClick: () => run('remoteConfig', dev) },
    dev.type === 'hikvision' && { label: 'Hik-Connect / Guarding Vision & QR code…', icon: 'external', onClick: () => import('./hikconnect.js').then((m) => m.openHikConnect(dev)) },
    dev.type === 'hikvision' && { label: dev.hasStreamKey ? 'Stream encryption key… (set)' : 'Stream encryption key…', icon: 'edit', onClick: () => import('./streamkey.js').then((m) => m.setStreamKey(dev.id)) },
    dev.type === 'hikvision' && { label: 'Two-way audio with the recorder (speaker on the NVR)', icon: 'mic', onClick: () => import('./talkbar.js').then((m) => m.talkToDevice(dev)) },
    { label: 'Re-import channels (refresh camera list)', icon: 'refresh', onClick: async () => { try { const r = await api('devices:refresh', dev.id); toast(`${dev.name}: ${r.cameras.length} channel(s) imported`, 'ok'); } catch (e) { toast(e.message, 'err'); } } },
    '-',
    { label: 'Delete device', icon: 'trash', danger: true, onClick: () => run('deleteDevice', dev) },
  ];
}

export function showCameraInfo(cam) {
  const d = deviceById(cam.deviceId) || {};
  const rows = [['Name', cam.name], ['Device', `${d.name || ''} (${d.type || ''})`], ['Channel / ID', String(cam.channel)], ['IP', cam.ip || '-'], ['Status', cam.online === false ? 'Offline' : cam.online ? 'Online' : 'Unknown'], ['Model', cam.model || '-'], ['Vendor', cam.vendorName || cam.vendor || '-'], ['Server', cam.server || '-'], ['Group', cam.group || '-']];
  if (cam.streams) for (const [k, v] of Object.entries(cam.streams)) if (v && v.codec) rows.push([`${k} stream`, `${v.codec} ${v.width || ''}x${v.height || ''} ${v.fps ? v.fps + ' fps' : ''}`]);
  modal({ title: 'Camera details', body: el('dl', { class: 'kv' }, rows.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])), buttons: [{ label: 'Close', primary: true }] });
}
