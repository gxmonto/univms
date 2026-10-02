// Log Search: device logs (Hikvision log search / DW audit log) and the local application log
import { api, state, el, svg, btn, toast, fmtTime, setStatus } from '../core.js';

export async function mount(container) {
  const content = el('section', { class: 'content' });
  const tabs = el('div', { class: 'tabs' });
  const body = el('div', { class: 'content' });
  const dayAgo = new Date(Date.now() - 86400000), now = new Date();
  const toLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const deviceLogs = () => {
    body.innerHTML = '';
    const dev = el('select', {}, ...state.devices.map((d) => el('option', { value: d.id }, d.name)));
    const start = el('input', { type: 'datetime-local', value: toLocal(dayAgo) });
    const end = el('input', { type: 'datetime-local', value: toLocal(now) });
    const text = el('input', { type: 'text', placeholder: 'Filter…' });
    const tbody = el('tbody');
    let rows = [];
    const render = () => { tbody.innerHTML = ''; const f = text.value.toLowerCase(); const list = rows.filter((r) => !f || JSON.stringify(r).toLowerCase().includes(f)); for (const r of list.slice(0, 2000)) tbody.append(el('tr', {}, el('td', {}, r.time ? fmtTime(r.time) : '-'), el('td', {}, String(r.major || '')), el('td', {}, typeof r.minor === 'object' ? JSON.stringify(r.minor) : String(r.minor || '')), el('td', {}, String(r.channel || '')), el('td', {}, String(r.user || '')), el('td', {}, String(r.remote || '')))); if (!list.length) tbody.append(el('tr', {}, el('td', { colspan: 6, class: 'empty' }, rows.length ? 'No matches' : 'No logs loaded'))); setStatus(`${list.length} log entries`); };
    text.addEventListener('input', render);
    const search = async () => { if (!dev.value) return toast('Add a device first', 'warn'); tbody.innerHTML = ''; tbody.append(el('tr', {}, el('td', { colspan: 6, class: 'empty' }, 'Searching…'))); try { rows = await api('devices:logs', { id: dev.value, start: new Date(start.value).getTime(), end: new Date(end.value).getTime() }); render(); } catch (e) { rows = []; render(); toast('Log search failed: ' + e.message, 'err'); } };
    body.append(el('div', { class: 'toolbar' }, el('span', { class: 'dim small' }, 'Device'), dev, el('span', { class: 'dim small' }, 'From'), start, el('span', { class: 'dim small' }, 'To'), end, btn('Search', { cls: 'primary', icon: 'search' }, search), el('div', { class: 'sep' }), el('div', { class: 'search-box' }, svg('search'), text), el('div', { class: 'spacer' }),
      btn('Export CSV', { cls: 'sm', icon: 'download' }, () => { if (!rows.length) return; const csv = ['time,major,minor,channel,user,remote', ...rows.map((r) => [r.time ? fmtTime(r.time) : '', r.major, typeof r.minor === 'object' ? JSON.stringify(r.minor) : r.minor, r.channel, r.user, r.remote].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `logs-${Date.now()}.csv`; a.click(); })),
      el('div', { class: 'scroll' }, el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, ...['Time', 'Major type', 'Minor type / detail', 'Channel', 'User', 'Remote host'].map((h) => el('th', {}, h)))), tbody)));
    render();
  };
  const appLog = async () => {
    body.innerHTML = '';
    const pre = el('pre', { class: 'mono small', style: { padding: '12px', whiteSpace: 'pre-wrap', margin: 0 } });
    const refresh = async () => { const lines = await api('log:recent'); pre.textContent = lines.join('\n'); pre.scrollTop = pre.scrollHeight; };
    body.append(el('div', { class: 'toolbar' }, btn('Refresh', { cls: 'sm', icon: 'refresh' }, refresh), el('span', { class: 'dim small' }, 'Application log (main process)')), el('div', { class: 'scroll' }, pre));
    refresh();
  };
  tabs.append(el('button', { class: 'active', onClick: (e) => { for (const b of tabs.children) b.classList.remove('active'); e.target.classList.add('active'); deviceLogs(); } }, 'Device logs'), el('button', { onClick: (e) => { for (const b of tabs.children) b.classList.remove('active'); e.target.classList.add('active'); appLog(); } }, 'Application log'));
  content.append(tabs, body);
  container.append(content);
  deviceLogs();
}
export function unmount() {}
