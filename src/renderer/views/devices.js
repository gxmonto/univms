// Device Management: devices table, add/edit/test, discovery, remote config, camera groups, DW layout import
import { api, state, bus, el, svg, btn, toast, modal, confirm, promptText, fmtTime, fmtBytes, loadAll, cameraById, setStatus, actions, contextMenu } from '../core.js';
import { createCameraTree, deviceMenuItems } from '../tree.js';

let tbody, types = [], selectedId = null, tab = 'devices', container_, pickerTree = null;

const typeLabel = (t) => (types.find((x) => x.id === t) || {}).label || t;

// ---------- add / edit ----------
export function editDevice(dev = null, prefill = {}) {
  const d = { type: 'hikvision', port: 80, https: false, username: 'admin', ...(dev || {}), ...prefill };
  const f = {};
  const inp = (key, attrs = {}) => (f[key] = el('input', { type: 'text', value: d[key] !== undefined && d[key] !== null ? d[key] : '', ...attrs }));
  const portLabelFor = (type) => (type === 'dwspectrum' ? 'Server port (usually 7001)' : 'HTTP port (usually 80) — not the SDK/server port 8000');
  f.type = el('select', { onChange: () => { const t = types.find((x) => x.id === f.type.value); if (t && (!f.port.value || types.some((x) => String(x.defaultPort) === f.port.value))) f.port.value = t.defaultPort; f.https.checked = f.type.value === 'dwspectrum'; httpsLbl.classList.toggle('hidden', f.type.value === 'dwspectrum'); portLabel.firstChild.textContent = portLabelFor(f.type.value); } }, ...types.map((t) => el('option', { value: t.id, selected: t.id === d.type }, t.label)));
  inp('name', { placeholder: 'Front office NVR' });
  inp('host', { placeholder: '192.168.1.100 or hostname' });
  inp('port', { type: 'number', min: 1, max: 65535 });
  inp('username');
  f.password = el('input', { type: 'password', placeholder: dev && dev.hasPassword ? '(unchanged)' : '' });
  inp('rtspPort', { type: 'number', placeholder: 'auto (554 / 7001)' });
  f.https = el('input', { type: 'checkbox', checked: d.type === 'dwspectrum' ? d.https !== false : !!d.https });
  f.eventsDisabled = el('input', { type: 'checkbox', checked: !!d.eventsDisabled });
  const httpsLbl = el('label', { class: `check ${d.type === 'dwspectrum' ? 'hidden' : ''}` }, f.https, 'Use HTTPS');
  const result = el('div', { class: 'small', style: { minHeight: '20px' } });
  const portLabel = el('label', { class: 'field' }, portLabelFor(d.type), f.port);
  const collect = () => ({ ...(dev ? { id: dev.id } : {}), type: f.type.value, name: f.name.value.trim(), host: f.host.value.trim(), port: Number(f.port.value) || types.find((t) => t.id === f.type.value).defaultPort, https: f.type.value === 'dwspectrum' ? true : f.https.checked, username: f.username.value, password: f.password.value, rtspPort: Number(f.rtspPort.value) || undefined, eventsDisabled: f.eventsDisabled.checked });
  const validate = (c) => { if (!c.host) throw new Error('Host is required'); if (!c.name) c.name = c.host; if (!c.username) throw new Error('Username is required'); if (!dev && !c.password) throw new Error('Password is required'); };
  const body = el('div', { class: 'form-grid' },
    el('label', { class: 'field full' }, 'Device type', f.type),
    el('label', { class: 'field' }, 'Name', f.name), el('label', { class: 'field' }, 'Host / IP', f.host),
    portLabel, el('label', { class: 'field' }, 'RTSP port (optional, auto-detected)', f.rtspPort),
    el('label', { class: 'field' }, 'Username', f.username), el('label', { class: 'field' }, 'Password', f.password),
    el('div', { class: 'row full' }, httpsLbl, el('label', { class: 'check' }, f.eventsDisabled, 'Do not subscribe to events from this device')),
    el('div', { class: 'full' }, result));
  modal({ title: dev ? `Edit ${dev.name}` : 'Add device', size: 'wide', body, buttons: [
    { label: 'Test connection', left: true, onClick: async () => { try { const c = collect(); validate(c); result.textContent = 'Testing…'; result.className = 'small muted'; const r = await api('devices:test', c); result.className = 'small ok'; result.textContent = `OK: ${r.info.model || r.info.name || ''} ${r.info.firmware ? '• fw ' + r.info.firmware : ''} • ${r.cameraCount} camera(s)${r.info.rtspPort ? ' • RTSP ' + r.info.rtspPort : ''}`; } catch (e) { result.className = 'small err'; result.textContent = 'Failed: ' + e.message; } return false; } },
    { label: 'Cancel' },
    { label: dev ? 'Save' : 'Add', primary: true, onClick: async (close) => {
      let c;
      try { c = collect(); validate(c); } catch (e) { result.className = 'small err'; result.textContent = e.message; return false; }
      let saved;
      try { saved = await api('devices:save', c); } catch (e) { result.className = 'small err'; result.textContent = 'Could not save: ' + e.message; return false; }
      close();
      toast(`${c.name} saved — connecting…`, 'ok');
      api('devices:refresh', saved.id).then((r) => toast(`${c.name}: connected, ${r.cameras.length} camera(s)`, 'ok')).catch((e) => toast(`${c.name} saved, but the connection failed: ${e.message}. Right-click the device → Edit to correct it.`, 'warn', 9000));
    } },
  ] });
}

// ---------- discovery ----------
function discoverDialog() {
  const tb = el('tbody');
  const status = el('span', { class: 'dim small' }, 'Click Scan to search the LAN (Hikvision SADP + ONVIF)');
  const dwChk = el('input', { type: 'checkbox' });
  const scan = async () => {
    tb.innerHTML = ''; status.textContent = 'Scanning…';
    try {
      const list = await api('discovery:scan', { sadp: true, onvif: true, dw: dwChk.checked });
      status.textContent = `${list.length} device(s) found`;
      for (const d of list) {
        const known = state.devices.some((x) => x.host === d.ip);
        tb.append(el('tr', {}, el('td', {}, d.ip), el('td', {}, d.source), el('td', {}, d.model || d.deviceType || '-'), el('td', {}, d.serial || d.mac || '-'), el('td', {}, String(d.httpPort || '')), el('td', {}, d.firmware || '-'), el('td', {}, d.activated !== undefined ? (String(d.activated) === 'true' ? 'active' : 'NOT ACTIVATED') : ''),
          el('td', {}, known ? el('span', { class: 'pill ok' }, 'added') : btn('Add', { cls: 'sm primary' }, () => editDevice(null, { type: d.vendor === 'dwspectrum' ? 'dwspectrum' : 'hikvision', host: d.ip, port: d.httpPort || 80, name: d.name || d.model || d.ip })))));
      }
      if (!list.length) tb.append(el('tr', {}, el('td', { colspan: 8, class: 'empty' }, 'Nothing found. Devices must be on the same subnet for multicast discovery; add them manually by IP otherwise.')));
    } catch (e) { status.textContent = 'Scan failed: ' + e.message; }
  };
  modal({ title: 'Online devices', size: 'large', body: el('div', {}, el('div', { class: 'row', style: { marginBottom: '8px' } }, btn('Scan', { cls: 'primary', icon: 'search' }, scan), el('label', { class: 'check small' }, dwChk, 'Also probe local /24 subnets for DW Spectrum servers (port 7001, slower)'), status),
    el('div', { style: { maxHeight: '55vh', overflow: 'auto' } }, el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, ...['IP', 'Source', 'Model', 'Serial / MAC', 'Port', 'Firmware', 'State', ''].map((h) => el('th', {}, h)))), tb))), buttons: [{ label: 'Close', primary: true }] });
  scan();
}

// ---------- remote configuration ----------
async function remoteConfig(dev) {
  const body = el('div', {}, el('div', { class: 'empty' }, 'Loading…'));
  const m = modal({ title: `${dev.name} — remote configuration`, size: 'large', body, buttons: [{ label: 'Close', primary: true }], onClose: () => m.onClose && m.onClose() });
  let info;
  try { info = await api('devices:info', dev.id); } catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'err' }, 'Failed: ' + e.message)); return; }
  const tabs = el('div', { class: 'tabs' });
  const pane = el('div', { style: { padding: '12px 0', maxHeight: '60vh', overflow: 'auto' } });
  const cams = state.cameras.filter((c) => c.deviceId === dev.id);
  const panes = {
    Information: () => el('div', { class: 'cards' },
      el('div', { class: 'card' }, el('h3', {}, 'Device'), el('dl', { class: 'kv' }, ...Object.entries({ Name: info.info.name, Model: info.info.model, Type: info.info.deviceType, Serial: info.info.serial, MAC: info.info.mac, Firmware: info.info.firmware, 'RTSP port': info.info.rtspPort, 'API mode': info.info.apiMode, Servers: info.info.servers }).filter(([, v]) => v !== undefined && v !== null).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))]))),
      el('div', { class: 'card' }, el('h3', {}, 'Status'), info.status ? el('dl', { class: 'kv' }, el('dt', {}, 'Uptime'), el('dd', {}, info.status.uptimeSeconds ? `${Math.floor(info.status.uptimeSeconds / 86400)}d ${Math.floor((info.status.uptimeSeconds % 86400) / 3600)}h` : '-'), ...(info.status.cpu || []).flatMap((c) => [el('dt', {}, c.desc || 'CPU'), el('dd', {}, `${c.utilization}%`)]), ...(info.status.memory || []).flatMap((c) => [el('dt', {}, c.desc || 'Memory'), el('dd', {}, `${c.usage}%`)])) : el('div', { class: 'dim' }, 'Not available')),
      el('div', { class: 'card' }, el('h3', {}, 'Time'), info.time && !info.time.error ? el('dl', { class: 'kv' }, el('dt', {}, 'Device time'), el('dd', {}, info.time.localTime || '-'), el('dt', {}, 'Mode'), el('dd', {}, info.time.mode || '-'), el('dt', {}, 'Time zone'), el('dd', {}, info.time.timeZone || '-'), el('dt', {}, 'PC time'), el('dd', {}, fmtTime(Date.now()))) : el('div', { class: 'dim' }, info.time && info.time.error),
        el('div', { class: 'row', style: { marginTop: '8px' } }, btn('Sync time with this PC', { cls: 'sm', icon: 'clock' }, async () => { try { await api('devices:syncTime', dev.id); toast('Time synchronized', 'ok'); } catch (e) { toast(e.message, 'err'); } }))),
      el('div', { class: 'card' }, el('h3', {}, 'Network'), info.network && info.network.length ? el('dl', { class: 'kv' }, ...info.network.flatMap((n) => [el('dt', {}, `Interface ${n.id}`), el('dd', {}, `${n.ip || ''} / ${n.mask || ''} gw ${n.gateway || ''} (${n.dhcp || ''})`)])) : el('div', { class: 'dim' }, 'Not available')),
      el('div', { class: 'card' }, el('h3', {}, 'Maintenance'), el('div', { class: 'row' }, btn('Reboot device', { cls: 'sm danger', icon: 'power' }, async () => { if (await confirm(`Reboot ${dev.name}? All streams from it will drop for a few minutes.`, { danger: true, okLabel: 'Reboot' })) { try { await api('devices:reboot', dev.id); toast('Reboot command sent', 'ok'); } catch (e) { toast(e.message, 'err'); } } }), btn('Refresh cameras', { cls: 'sm', icon: 'refresh' }, async () => { try { const r = await api('devices:refresh', dev.id); toast(`${r.cameras.length} cameras`, 'ok'); } catch (e) { toast(e.message, 'err'); } })))),
    Cameras: () => el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, ...['#', 'Name', 'Status', 'IP', 'Main stream', 'Sub stream', 'Group / Server', 'Local alias', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...cams.map((c) => el('tr', {}, el('td', {}, String(c.channel).slice(0, 12)), el('td', {}, c.originalName || c.name), el('td', {}, el('span', { class: `status-dot ${c.online === false ? 'off' : c.online ? 'on' : 'unknown'}` }), c.status || (c.online === false ? 'Offline' : c.online ? 'Online' : '-')), el('td', {}, c.ip || '-'),
        el('td', {}, c.streams && c.streams.main && c.streams.main.codec ? `${c.streams.main.codec} ${c.streams.main.width}x${c.streams.main.height}` : '-'), el('td', {}, c.streams && c.streams.sub && c.streams.sub.codec ? `${c.streams.sub.codec} ${c.streams.sub.width}x${c.streams.sub.height}` : (c.streams && c.streams.sub ? 'yes' : '-')), el('td', {}, c.group || c.server || '-'),
        el('td', {}, c.name !== c.originalName ? c.name : '', c.hidden ? el('span', { class: 'pill' }, 'hidden') : null),
        el('td', {}, el('div', { class: 'row' }, el('button', { class: 'icon-btn', title: 'Rename alias', onClick: async () => { const n = await promptText('Rename camera', 'Display name', c.name); if (n !== null) await api('devices:setCameraAlias', { cameraId: c.id, name: n.trim() || c.originalName }); } }, svg('edit')), el('button', { class: 'icon-btn', title: c.hidden ? 'Unhide' : 'Hide', onClick: () => api('devices:setCameraAlias', { cameraId: c.id, hidden: !c.hidden }) }, svg(c.hidden ? 'eye' : 'eyeoff'))))))) ),
    Storage: () => Array.isArray(info.storage) ? (info.storage.length ? el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, ...['#', 'Name', 'Type', 'Status', 'Capacity', 'Free', 'Usage', 'Property'].map((h) => el('th', {}, h)))), el('tbody', {}, ...info.storage.map((h) => { const used = h.capacityMB ? 1 - h.freeMB / h.capacityMB : 0; return el('tr', {}, el('td', {}, String(h.id)), el('td', {}, h.name || '-'), el('td', {}, h.type || '-'), el('td', {}, el('span', { class: /ok|normal/i.test(h.status) ? 'ok' : 'warn' }, h.status || '-')), el('td', {}, fmtBytes(h.capacityMB * 1048576)), el('td', {}, fmtBytes(h.freeMB * 1048576)), el('td', {}, el('div', { class: `bar ${used > 0.95 ? 'warn' : ''}`, style: { width: '120px' } }, el('i', { style: { width: Math.round(used * 100) + '%' } }))), el('td', {}, h.property || '-')); }))) : el('div', { class: 'empty' }, 'No storage reported')) : el('div', { class: 'err' }, info.storage && info.storage.error),
    Users: () => info.users && info.users.length ? el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, el('th', {}, 'ID'), el('th', {}, 'Username'), el('th', {}, 'Level'))), el('tbody', {}, ...info.users.map((u) => el('tr', {}, el('td', {}, String(u.id)), el('td', {}, u.name), el('td', {}, String(u.level || '')))))) : el('div', { class: 'empty' }, 'Not available'),
  };
  if (dev.type === 'dwspectrum') panes['Server layouts'] = () => { const w = el('div', {}, el('div', { class: 'dim' }, 'Loading…')); api('dw:layouts', dev.id).then((ls) => { w.innerHTML = ''; if (!ls.length) return w.append(el('div', { class: 'empty' }, 'No layouts on server')); w.append(el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, el('th', {}, 'Layout'), el('th', {}, 'Cameras'), el('th', {}, ''))), el('tbody', {}, ...ls.map((l) => el('tr', {}, el('td', {}, l.name), el('td', {}, String(l.items.length)), el('td', {}, btn('Import as view', { cls: 'sm' }, async () => { await importDwLayout(dev, l); }))))))); }).catch((e) => { w.textContent = e.message; }); return w; };
  const show = (name) => { pane.innerHTML = ''; pane.append(panes[name]()); for (const b of tabs.children) b.classList.toggle('active', b.textContent === name); };
  for (const name of Object.keys(panes)) tabs.append(el('button', { onClick: () => show(name) }, name));
  body.innerHTML = ''; body.append(tabs, pane); show('Information');
  const refresh = () => { if (document.body.contains(body)) { const active = tabs.querySelector('.active'); if (active && active.textContent === 'Cameras') show('Cameras'); } };
  bus.addEventListener('data', refresh);
  m.onClose = () => bus.removeEventListener('data', refresh);
}

async function importDwLayout(dev, l) {
  const maxR = Math.max(...l.items.map((i) => i.right)), maxB = Math.max(...l.items.map((i) => i.bottom)), minL = Math.min(...l.items.map((i) => i.left)), minT = Math.min(...l.items.map((i) => i.top));
  const cols = Math.max(1, Math.round(maxR - minL)), rows = Math.max(1, Math.round(maxB - minT));
  const cells = new Array(cols * rows).fill(null);
  for (const it of l.items) {
    const c = Math.round(it.left - minL), r = Math.round(it.top - minT);
    const cam = state.cameras.find((x) => x.deviceId === dev.id && x.uuid === it.cameraUuid);
    if (cam && r * cols + c < cells.length) cells[r * cols + c] = { cameraId: cam.id, stream: 'sub' };
  }
  const std = Object.entries({ 1: [1, 1], 4: [2, 2], 9: [3, 3], 16: [4, 4], 25: [5, 5], 36: [6, 6] }).find(([, v]) => v[0] === cols && v[1] === rows);
  await api('views:save', { name: `${l.name} (${dev.name})`, layoutId: std ? std[0] : null, custom: std ? null : { n: cols * rows, cols, rows }, cells, inTour: true });
  toast(`Imported layout "${l.name}" as a view`, 'ok');
}

// ---------- groups ----------
function renderGroups(root) {
  root.innerHTML = '';
  const side = el('div', { class: 'side', style: { width: '300px' } });
  const list = el('div', { class: 'side-body' });
  const content = el('div', { class: 'content pad scroll' });
  let sel = state.groups[0] || null;
  const renderList = () => { list.innerHTML = ''; for (const g of state.groups) list.append(el('div', { class: `node device ${sel && sel.id === g.id ? 'selected' : ''}`, style: { paddingLeft: '10px' }, onClick: () => { sel = g; renderList(); renderContent(); } }, svg('folder'), el('span', { class: 'lbl' }, g.name), el('span', { class: 'cnt' }, String((g.cameras || []).length)))); if (!state.groups.length) list.append(el('div', { class: 'empty small' }, 'No groups yet')); };
  const renderContent = () => {
    content.innerHTML = '';
    if (!sel) return content.append(el('div', { class: 'empty' }, 'Create a group with the + button'));
    const picker = el('div', { class: 'side', style: { width: '100%', border: '1px solid var(--line)', borderRadius: '8px', maxHeight: '420px' } });
    if (pickerTree) pickerTree.destroy();
    const t = pickerTree = createCameraTree(picker, { multi: true, draggable: false, onActivate: async (cam) => { if (!(sel.cameras || []).includes(cam.id)) { sel.cameras = [...(sel.cameras || []), cam.id]; await api('groups:save', sel); await loadAll(); renderList(); renderContent(); } } });
    const members = el('div', {});
    for (const id of sel.cameras || []) { const cam = cameraById(id); members.append(el('div', { class: 'row', style: { padding: '3px 0' } }, svg('camera'), el('span', { class: 'grow' }, cam ? `${cam.name} (${cam.deviceName})` : id), el('button', { class: 'icon-btn', title: 'Remove', onClick: async () => { sel.cameras = sel.cameras.filter((x) => x !== id); await api('groups:save', sel); await loadAll(); renderList(); renderContent(); } }, svg('close')))); }
    if (!(sel.cameras || []).length) members.append(el('div', { class: 'dim small' }, 'No cameras in this group'));
    content.append(el('div', { class: 'row' }, el('h2', { class: 'grow' }, sel.name), btn('Rename', { cls: 'sm', icon: 'edit' }, async () => { const n = await promptText('Rename group', 'Name', sel.name); if (n) { sel.name = n; await api('groups:save', sel); await loadAll(); renderList(); renderContent(); } }), btn('Delete group', { cls: 'sm danger', icon: 'trash' }, async () => { if (await confirm(`Delete group "${sel.name}"?`, { danger: true, okLabel: 'Delete' })) { await api('groups:remove', sel.id); await loadAll(); sel = state.groups[0] || null; renderList(); renderContent(); } })),
      el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '10px' } },
        el('div', {}, el('h3', {}, 'Members'), members),
        el('div', {}, el('h3', {}, 'Add cameras (double-click, or select several and click Add)'), picker, el('div', { class: 'row', style: { marginTop: '8px' } },
          btn('Add selected', { cls: 'sm primary', icon: 'plus' }, async () => { const ids = t.selected().filter((id) => !(sel.cameras || []).includes(id)); if (!ids.length) return; sel.cameras = [...(sel.cameras || []), ...ids]; await api('groups:save', sel); await loadAll(); renderList(); renderContent(); }),
          btn('Import encoding channels…', { cls: 'sm', icon: 'upload', title: 'Add every channel of a device to this group (like iVMS "Import encoding channels")' }, () => importChannels(sel, async () => { await loadAll(); renderList(); renderContent(); }))))));
  };
  side.append(el('div', { class: 'side-head' }, svg('folder'), el('span', { class: 'grow' }, 'Camera groups'), el('button', { class: 'icon-btn', title: 'New group', onClick: async () => { const n = await promptText('New group', 'Group name', `Group ${state.groups.length + 1}`); if (n) { sel = await api('groups:save', { name: n, cameras: [] }); await loadAll(); renderList(); renderContent(); } } }, svg('plus'))), list);
  root.append(side, content);
  renderList(); renderContent();
}

// ---------- devices table ----------
function renderDevices(root) {
  root.innerHTML = '';
  const content = el('section', { class: 'content' });
  const toolbar = el('div', { class: 'toolbar' },
    btn('Add device', { cls: 'primary', icon: 'plus' }, () => editDevice()),
    btn('Online devices', { icon: 'search' }, discoverDialog),
    el('div', { class: 'sep' }),
    btn('Edit', { icon: 'edit' }, () => { const d = state.devices.find((x) => x.id === selectedId); if (d) editDevice(d); else toast('Select a device', 'warn'); }),
    btn('Remote config', { icon: 'settings' }, () => { const d = state.devices.find((x) => x.id === selectedId); if (d) remoteConfig(d); else toast('Select a device', 'warn'); }),
    btn('Re-import channels', { icon: 'refresh', title: 'Enumerate the encoding channels again (after fixing a device or changing cameras on the NVR)' }, async () => { const d = state.devices.find((x) => x.id === selectedId); try { if (d) { const r = await api('devices:refresh', d.id); toast(`${d.name}: ${r.cameras.length} cameras`, 'ok'); } else { setStatus('Refreshing all devices…'); const r = await api('devices:refreshAll'); toast(Object.entries(r).map(([k, v]) => `${(state.devices.find((x) => x.id === k) || {}).name}: ${v}`).join('\n'), 'ok', 6000); } } catch (e) { toast(e.message, 'err'); } }),
    btn('Delete', { cls: 'danger', icon: 'trash' }, async () => { const d = state.devices.find((x) => x.id === selectedId); if (!d) return toast('Select a device', 'warn'); if (await confirm(`Remove ${d.name} and all of its cameras from UniVMS?`, { danger: true, okLabel: 'Remove' })) { await api('devices:remove', d.id); selectedId = null; toast('Device removed', 'ok'); } }),
    el('div', { class: 'spacer' }),
    el('span', { class: 'dim small' }, `${state.devices.length} devices • ${state.cameras.length} cameras`));
  tbody = el('tbody');
  const table = el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, ...['', 'Name', 'Type', 'Address', 'Model', 'Serial', 'Firmware', 'Cameras', 'Last refresh', 'Status'].map((h) => el('th', {}, h)))), tbody);
  content.append(toolbar, el('div', { class: 'scroll' }, table));
  root.append(content);
  renderRows();
}
function renderRows() {
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const d of state.devices) {
    const st = state.status[d.id] || d.status || {};
    const cams = state.cameras.filter((c) => c.deviceId === d.id);
    const online = cams.filter((c) => c.online !== false).length;
    tbody.append(el('tr', { class: selectedId === d.id ? 'selected' : '', onClick: () => { selectedId = d.id; renderRows(); }, onDblclick: () => remoteConfig(d),
      onContextmenu: (e) => { e.preventDefault(); selectedId = d.id; renderRows(); contextMenu(e.clientX, e.clientY, deviceMenuItems(d, cams)); } },
      el('td', {}, el('span', { class: `status-dot ${st.online === true ? 'on' : st.online === false ? 'off' : 'unknown'}` })),
      el('td', {}, d.name), el('td', {}, typeLabel(d.type)), el('td', {}, `${d.https ? 'https://' : ''}${d.host}:${d.port}`),
      el('td', {}, (d.info && (d.info.model || d.info.name)) || '-'), el('td', {}, (d.info && d.info.serial) || '-'), el('td', {}, (d.info && d.info.firmware) || '-'),
      el('td', {}, cams.length ? `${online}/${cams.length}` : '-'), el('td', {}, d.lastRefresh ? fmtTime(d.lastRefresh) : '-'),
      el('td', { title: st.error || '' }, st.online === false ? el('span', { class: 'err' }, 'Offline' + (st.error ? ': ' + st.error.slice(0, 60) : '')) : st.online ? el('span', { class: 'ok' }, 'Online') : el('span', { class: 'dim' }, 'Checking…'))));
  }
  if (!state.devices.length) tbody.append(el('tr', {}, el('td', { colspan: 10, class: 'empty' }, 'No devices. Click "Add device" or "Online devices" to begin.')));
}

export async function deleteDevice(d) {
  if (await confirm(`Remove ${d.name} and all of its cameras from UniVMS?`, { danger: true, okLabel: 'Remove' })) { await api('devices:remove', d.id); if (selectedId === d.id) selectedId = null; toast('Device removed', 'ok'); }
}
export async function renameDevice(d) {
  const n = await promptText('Rename device', 'Device name', d.name);
  if (n && n.trim() && n.trim() !== d.name) { await api('devices:save', { id: d.id, name: n.trim() }); toast('Renamed', 'ok'); }
}
/** iVMS-style "Import encoding channels": re-enumerate a device and add all (or all online) channels to a group. */
async function importChannels(group, done) {
  if (!state.devices.length) return toast('Add a device first', 'warn');
  const dev = el('select', {}, ...state.devices.map((d) => el('option', { value: d.id }, d.name)));
  const refresh = el('input', { type: 'checkbox', checked: true });
  const onlyOnline = el('input', { type: 'checkbox' });
  const includeHidden = el('input', { type: 'checkbox' });
  modal({ title: `Import encoding channels into "${group.name}"`, body: el('div', { class: 'col' },
    el('label', { class: 'field' }, 'Device', dev),
    el('label', { class: 'check' }, refresh, 'Re-read the channel list from the device first'),
    el('label', { class: 'check' }, onlyOnline, 'Only channels that are online'),
    el('label', { class: 'check' }, includeHidden, 'Include hidden channels'),
    el('div', { class: 'dim small' }, 'Channels already in the group are skipped. Channels are never duplicated or removed by this action.')),
    buttons: [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: async (close) => {
      try {
        if (refresh.checked) await api('devices:refresh', dev.value);
        await loadAll();
        const cams = state.cameras.filter((c) => c.deviceId === dev.value && (!onlyOnline.checked || c.online !== false) && (includeHidden.checked || !c.hidden));
        const ids = cams.map((c) => c.id).filter((id) => !(group.cameras || []).includes(id));
        group.cameras = [...(group.cameras || []), ...ids];
        await api('groups:save', group);
        toast(`Imported ${ids.length} channel(s) (${cams.length - ids.length} already present)`, 'ok');
        close(); done && done();
      } catch (e) { toast('Import failed: ' + e.message, 'err', 6000); return false; }
    } }] });
}

// make device actions available to the camera tree in other views (right-click menus)
Object.assign(actions, { editDevice: (d) => { if (!types.length) api('devices:types').then((t) => { types = t; editDevice(d); }); else editDevice(d); }, remoteConfig, deleteDevice, renameDevice });

export async function mount(container) {
  container_ = container;
  types = await api('devices:types');
  const wrap = el('section', { class: 'content' });
  const tabs = el('div', { class: 'tabs' });
  const body = el('div', { class: 'page', style: { flex: 1, minHeight: 0 } });
  const show = (t) => { tab = t; for (const b of tabs.children) b.classList.toggle('active', b.dataset.t === t); if (t === 'devices') renderDevices(body); else renderGroups(body); };
  tabs.append(el('button', { dataset: { t: 'devices' }, onClick: () => show('devices') }, 'Devices'), el('button', { dataset: { t: 'groups' }, onClick: () => show('groups') }, 'Camera groups'));
  wrap.append(tabs, body);
  container.append(wrap);
  show(tab);
  const onData = () => { if (tab === 'devices') renderRows(); };
  bus.addEventListener('data', onData); bus.addEventListener('status', onData);
  container._cleanup = () => { bus.removeEventListener('data', onData); bus.removeEventListener('status', onData); if (pickerTree) { pickerTree.destroy(); pickerTree = null; } };
  setStatus('Device Management');
}
export function unmount() { if (container_ && container_._cleanup) container_._cleanup(); tbody = null; }
