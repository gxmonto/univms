// Hik-Connect / Guarding Vision dialog: device info + password-protected device QR (same format as
// iVMS-4200 "Generate QR code"): the app asks for the QR password when scanning, then adds the device
// with address, port, user and password filled in.
import { api, el, svg, btn, toast, modal } from './core.js';

export async function openHikConnect(dev) {
  const body = el('div', {}, el('div', { class: 'empty' }, 'Reading device information…'));
  const m = modal({ title: `Hik-Connect / Guarding Vision — ${dev.name}`, size: 'wide', body, buttons: [{ label: 'Close', primary: true }] });
  let st = {};
  try { st = await api('hikconnect:status', dev.id); } catch (e) { st = { supported: false, error: e.message }; }
  body.innerHTML = '';

  // ---- left: device info + service toggle ----
  const enabled = el('input', { type: 'checkbox', checked: !!st.enabled, disabled: st.supported === false });
  const applyEnabled = btn('Apply', { cls: 'sm' }, async () => {
    try { await api('hikconnect:set', { deviceId: dev.id, enabled: enabled.checked }); toast(`Hik-Connect service ${enabled.checked ? 'enabled' : 'disabled'} on the device`, 'ok'); }
    catch (e) { toast('Could not change the service: ' + e.message, 'err', 6000); }
  });
  const info = el('dl', { class: 'kv' },
    el('dt', {}, 'Device'), el('dd', {}, `${dev.name} • ${dev.host}:${dev.port}${dev.transport === 'sdk' ? ' (SDK)' : ''}`),
    el('dt', {}, 'Model'), el('dd', {}, st.model || (dev.info && dev.info.model) || '-'),
    el('dt', {}, 'Serial number'), el('dd', { class: 'mono' }, st.serial || (dev.info && dev.info.serial) || '-'),
    el('dt', {}, 'Short serial'), el('dd', { class: 'mono' }, st.shortSerial || '-'),
    el('dt', {}, 'Cloud service'), el('dd', {}, st.supported === false ? (st.error ? 'Unavailable: ' + st.error : 'Not supported by this firmware') : st.enabled ? 'Enabled' : 'Disabled'),
    el('dt', {}, 'Registration'), el('dd', {}, st.registerStatus === undefined ? '-' : String(st.registerStatus)),
    el('dt', {}, 'Server'), el('dd', { class: 'small mono' }, st.serverAddress || '-'));

  // ---- QR form ----
  const qp = el('input', { type: 'password', placeholder: 'required, up to 16 characters — the app asks for it when scanning', maxlength: 16, style: { width: '100%' } });
  const qname = el('input', { type: 'text', value: dev.name });
  const qhost = el('input', { type: 'text', value: dev.host });
  const qport = el('input', { type: 'number', min: 1, max: 65535, value: dev.transport === 'sdk' ? dev.port : 8000, title: 'Server port the app connects to (Hikvision SDK port, 8000 by default)' });
  const qrImg = el('img', { style: { width: '300px', height: '300px', background: '#fff', borderRadius: '8px', padding: '8px', display: 'none' }, alt: 'Device QR' });
  const qrPlaceholder = el('div', { class: 'empty', style: { width: '300px', height: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--line)', borderRadius: '8px' } }, 'Enter the QR password and click Generate');
  const actions = el('div', { class: 'row', style: { marginTop: '8px', display: 'none' } });
  let qrText = '';
  actions.append(
    btn('Save PNG…', { cls: 'sm', icon: 'download' }, async () => { try { const f = await api('hikconnect:saveQr', { deviceId: dev.id, text: qrText }); if (f) toast('Saved ' + f, 'ok'); } catch (e) { toast(e.message, 'err'); } }),
    btn('Print', { cls: 'sm' }, () => printQr(dev, qhost.value, qport.value, qrImg.src)));
  const generate = async () => {
    if (!qp.value) { toast('Enter the QR password first', 'warn'); qp.focus(); return; }
    try {
      const r = await api('hikconnect:deviceQr', { deviceId: dev.id, password: qp.value, host: qhost.value.trim(), port: Number(qport.value), name: qname.value.trim() });
      qrText = r.text; qrImg.src = r.dataUrl; qrImg.style.display = 'block'; qrPlaceholder.style.display = 'none'; actions.style.display = 'flex';
    } catch (e) { toast('QR: ' + e.message, 'err', 6000); }
  };
  qp.addEventListener('keydown', (e) => { if (e.key === 'Enter') generate(); });

  body.append(el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '28px' } },
    el('div', { style: { flex: 1, minWidth: 0 } },
      el('h3', {}, 'Device'), info,
      el('div', { class: 'row', style: { marginTop: '8px' } }, el('label', { class: 'check' }, enabled, 'Hik-Connect / Guarding Vision service enabled on the device'), applyEnabled),
      el('h3', { style: { marginTop: '18px' } }, 'QR code for the mobile app'),
      el('label', { class: 'field' }, 'QR password', qp),
      el('div', { class: 'form-grid', style: { marginTop: '8px' } }, el('label', { class: 'field' }, 'Device name in the app', qname), el('label', { class: 'field' }, 'Address (IP or domain)', qhost), el('label', { class: 'field' }, 'Server port', qport)),
      el('div', { class: 'row', style: { marginTop: '10px' } }, btn('Generate QR', { cls: 'primary', icon: 'external' }, generate)),
      el('p', { class: 'dim small' }, 'In Hik-Connect / Guarding Vision: Add Device → Manual adding → scan this QR → enter the QR password. The device is added with its address, port, user and password. The password is the only protection of the credentials inside the QR, so share the image carefully.')),
    el('div', {}, qrPlaceholder, qrImg, actions)));
  setTimeout(() => qp.focus(), 50);
}

function printQr(dev, host, port, src) {
  const w = window.open('', '_blank', 'width=460,height=600');
  if (!w) return toast('Popup blocked', 'warn');
  w.document.write(`<html><head><title>${dev.name} — QR</title><style>body{font-family:sans-serif;text-align:center;padding:24px}img{width:320px;height:320px}code{font-size:14px}</style></head><body><h2>${dev.name}</h2><img src="${src}"><p><code>${host}:${port}</code></p><p style="font-size:12px;color:#555">Hik-Connect / Guarding Vision → Add Device → Manual adding → scan, then enter the QR password</p><script>window.onload=()=>{window.print();}</script></body></html>`);
  w.document.close();
}
