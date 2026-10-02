// Maintenance: device health cards, storage, time sync, reboot, stream statistics, config backup/restore
import { api, state, bus, el, svg, btn, toast, confirm, promptText, fmtTime, fmtBytes, fmtDur, setStatus, modal } from '../core.js';

let root, timer, unsubs = [];

async function deviceCard(d) {
  const st = state.status[d.id] || {};
  const card = el('div', { class: 'card' });
  const head = el('div', { class: 'row' }, el('span', { class: `status-dot ${st.online === true ? 'on' : st.online === false ? 'off' : 'unknown'}` }), el('strong', { class: 'grow' }, d.name), el('span', { class: 'dim small' }, d.type === 'dwspectrum' ? 'DW Spectrum' : 'Hikvision'));
  const body = el('div', { class: 'dim small' }, st.online === false ? 'Offline: ' + (st.error || '') : 'Loading…');
  card.append(head, body);
  if (st.online !== false) {
    api('devices:info', d.id).then((info) => {
      body.innerHTML = ''; body.className = '';
      const kv = el('dl', { class: 'kv' });
      const add = (k, v) => { if (v !== undefined && v !== null && v !== '') kv.append(el('dt', {}, k), el('dd', {}, String(v))); };
      add('Model', info.info.model); add('Firmware', info.info.firmware); add('Serial', info.info.serial);
      if (info.status && info.status.uptimeSeconds) add('Uptime', fmtDur(info.status.uptimeSeconds));
      if (info.status && info.status.cpu && info.status.cpu.length) add('CPU', info.status.cpu.map((c) => c.utilization + '%').join(', '));
      if (info.time && info.time.localTime) { const dev = Date.parse(info.time.localTime); const drift = Number.isFinite(dev) ? Math.round((dev - Date.now()) / 1000) : null; add('Device time', `${info.time.localTime}${drift !== null ? ` (${drift >= 0 ? '+' : ''}${drift}s vs PC)` : ''}`); }
      body.append(kv);
      if (Array.isArray(info.storage) && info.storage.length) {
        body.append(el('h3', {}, 'Storage'));
        for (const h of info.storage) { const used = h.capacityMB ? 1 - h.freeMB / h.capacityMB : 0; body.append(el('div', { class: 'row small', style: { marginBottom: '4px' } }, el('span', { style: { width: '110px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: h.name }, h.name || `#${h.id}`), el('div', { class: `bar grow ${used > 0.95 ? 'warn' : ''} ${/error|abnormal|offline/i.test(h.status || '') ? 'err' : ''}` }, el('i', { style: { width: Math.round(used * 100) + '%' } })), el('span', { class: 'dim', style: { width: '120px', textAlign: 'right' } }, `${fmtBytes(h.freeMB * 1048576)} free`), el('span', { class: /ok|normal/i.test(h.status) ? 'ok' : 'warn', style: { width: '60px' } }, h.status || ''))); }
      }
      body.append(el('div', { class: 'row', style: { marginTop: '10px' } },
        btn('Sync time', { cls: 'sm', icon: 'clock' }, async () => { try { await api('devices:syncTime', d.id); toast(`${d.name}: time synchronized`, 'ok'); } catch (e) { toast(e.message, 'err'); } }),
        btn('Refresh cameras', { cls: 'sm', icon: 'refresh' }, async () => { try { const r = await api('devices:refresh', d.id); toast(`${d.name}: ${r.cameras.length} cameras`, 'ok'); } catch (e) { toast(e.message, 'err'); } }),
        btn('Reboot', { cls: 'sm danger', icon: 'power' }, async () => { if (await confirm(`Reboot ${d.name}?`, { danger: true, okLabel: 'Reboot' })) { try { await api('devices:reboot', d.id); toast('Reboot sent', 'ok'); } catch (e) { toast(e.message, 'err'); } } })));
    }).catch((e) => { body.textContent = 'Error: ' + e.message; body.className = 'err small'; });
  }
  return card;
}

async function render() {
  if (!root) return;
  root.innerHTML = '';
  const streamsBox = el('div', { class: 'card' }, el('h3', {}, 'Active streams'), el('div', { class: 'dim small' }, 'Loading…'));
  root.append(el('div', { class: 'row', style: { marginBottom: '12px' } }, el('h2', { class: 'grow', style: { margin: 0 } }, 'Device health'),
    btn('Sync time on all Hikvision devices', { cls: 'sm', icon: 'clock' }, async () => { let ok = 0, fail = 0; for (const d of state.devices.filter((x) => x.type === 'hikvision')) { try { await api('devices:syncTime', d.id); ok++; } catch (_) { fail++; } } toast(`Time sync: ${ok} ok, ${fail} failed`, fail ? 'warn' : 'ok'); }),
    btn('Refresh all cameras', { cls: 'sm', icon: 'refresh' }, async () => { setStatus('Refreshing…'); await api('devices:refreshAll'); toast('Camera lists refreshed', 'ok'); render(); }),
    btn('Backup configuration…', { cls: 'sm', icon: 'download' }, exportConfig),
    btn('Restore configuration…', { cls: 'sm', icon: 'upload' }, importConfig),
    btn('Reload', { cls: 'sm', icon: 'refresh' }, render)));
  const cards = el('div', { class: 'cards' });
  for (const d of state.devices) cards.append(await deviceCard(d));
  if (!state.devices.length) cards.append(el('div', { class: 'empty' }, 'No devices'));
  root.append(cards, el('div', { style: { height: '14px' } }), streamsBox);
  const refreshStreams = async () => {
    const st = await api('stream:stats').catch(() => []);
    const rec = await api('record:status').catch(() => ({}));
    streamsBox.innerHTML = '';
    streamsBox.append(el('h3', {}, `Active streams (${st.length}) • local recordings (${Object.keys(rec).length})`));
    if (!st.length && !Object.keys(rec).length) return streamsBox.append(el('div', { class: 'dim small' }, 'None'));
    const t = el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, ...['Stream', 'Camera', 'Mode', 'Uptime', 'Received'].map((h) => el('th', {}, h)))), el('tbody', {}, ...st.map((s) => el('tr', {}, el('td', { class: 'mono' }, s.id), el('td', {}, s.url), el('td', {}, s.transcode ? 'transcode' : 'remux'), el('td', {}, fmtDur(s.uptime / 1000)), el('td', {}, fmtBytes(s.bytes)))), ...Object.entries(rec).map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, 'REC'), el('td', {}, v.file), el('td', {}, 'recording'), el('td', {}, fmtDur((Date.now() - v.started) / 1000)), el('td', {}, '')))));
    streamsBox.append(t);
  };
  refreshStreams();
  clearInterval(timer); timer = setInterval(refreshStreams, 3000);
}

async function exportConfig() {
  const pw = await promptText('Backup configuration', 'Encryption password (leave empty for plain JSON — device passwords would be readable!)', '', { password: true });
  if (pw === null) return;
  try { const f = await api('config:export', { password: pw }); if (f) toast('Configuration saved to ' + f, 'ok', 6000); } catch (e) { toast(e.message, 'err'); }
}
async function importConfig() {
  const pw = await promptText('Restore configuration', 'Password (if the file is encrypted)', '', { password: true });
  if (pw === null) return;
  try { const r = await api('config:import', { password: pw, merge: true }); if (r) toast(`Imported ${r.devices} device(s), ${r.views} view(s)`, 'ok', 6000); } catch (e) { toast(e.message, 'err', 6000); }
}

export function mount(container) {
  root = el('div', { class: 'scroll pad', style: { flex: 1 } });
  container.append(root);
  render();
  const onStatus = () => {};
  bus.addEventListener('status', onStatus);
  unsubs.push(() => bus.removeEventListener('status', onStatus));
  setStatus('Maintenance');
}
export function unmount() { clearInterval(timer); root = null; for (const u of unsubs) u(); unsubs = []; }
