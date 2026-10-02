// Hik-Connect / Guarding Vision dialog: cloud service status, verification code, and the device QR code
// that the mobile apps scan (same content as the label on the device: the serial number).
import { api, el, svg, btn, toast, modal, deviceById } from './core.js';

export async function openHikConnect(dev) {
  const body = el('div', {}, el('div', { class: 'empty' }, 'Reading Hik-Connect settings…'));
  const m = modal({ title: `Hik-Connect / Guarding Vision — ${dev.name}`, size: 'wide', body, buttons: [{ label: 'Close', primary: true }] });
  let st;
  try { st = await api('hikconnect:status', dev.id); } catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'err' }, e.message)); return; }
  body.innerHTML = '';

  const qrImg = el('img', { style: { width: '260px', height: '260px', background: '#fff', borderRadius: '8px', padding: '8px', display: 'block' }, alt: 'QR code' });
  // Same layout as the label on the device: service URL, full serial, verification code, each ending with CR.
  // Hik-Connect / Guarding Vision fill both fields from it; without a code the QR carries only the serial.
  const BRANDS = { hik: ['Hik-Connect / Guarding Vision', 'www.hik-connect.com'], ezviz: ['EZVIZ', 'www.ezviz7.com'] };
  const brand = el('select', { onChange: () => renderQr() }, ...Object.entries(BRANDS).map(([k, [label]]) => el('option', { value: k }, label)));
  const qrText = () => { const c = code.value.trim(); return c ? `${BRANDS[brand.value][1]}
${st.serial}
${c}
` : st.serial; };
  const qrNote = el('div', { class: 'dim small' });
  let qrTimer = null;
  const renderQr = async () => {
    try { qrImg.src = await api('hikconnect:qr', { text: qrText() }); } catch (e) { toast('QR: ' + e.message, 'err'); }
    qrNote.textContent = code.value.trim() ? 'Contains the serial number and the verification code — the app fills both. Keep this QR private.' : 'Contains the serial number only; the app will ask for the verification code. Enter the code above to include it.';
  };

  const enabled = el('input', { type: 'checkbox', checked: !!st.enabled });
  const code = el('input', { type: 'text', placeholder: st.verificationCodeReadable ? '' : 'not readable from the device — type it to include it in the QR / change it', value: st.verificationCode || '', maxlength: 12, style: { width: '100%' }, onInput: () => { clearTimeout(qrTimer); qrTimer = setTimeout(renderQr, 250); } });
  renderQr();
  const save = btn('Save to device', { cls: 'primary', icon: 'save' }, async () => {
    try {
      const c = code.value.trim();
      if (c && !/^[A-Za-z0-9]{6,12}$/.test(c)) return toast('Verification code: 6–12 letters/digits', 'warn');
      await api('hikconnect:set', { deviceId: dev.id, enabled: enabled.checked, verificationCode: c || undefined });
      toast('Hik-Connect settings saved', 'ok');
      st = await api('hikconnect:status', dev.id);
      status.replaceChildren(statusList());
    } catch (e) { toast('Save failed: ' + e.message, 'err', 6000); }
  });
  const statusList = () => el('dl', { class: 'kv' },
    el('dt', {}, 'Service'), el('dd', {}, st.supported === false ? 'Not supported by this device/firmware' : st.enabled ? 'Enabled' : 'Disabled'),
    el('dt', {}, 'Registration'), el('dd', {}, st.registerStatus || '-'),
    el('dt', {}, 'Server'), el('dd', { class: 'small mono' }, st.serverAddress || '-'),
    el('dt', {}, 'Serial number'), el('dd', { class: 'mono' }, st.serial || '-'),
    el('dt', {}, 'Short serial'), el('dd', { class: 'mono' }, st.shortSerial || '-'),
    el('dt', {}, 'Model'), el('dd', {}, st.model || '-'));
  const status = el('div', {}, statusList());

  // ---- iVMS-style password-protected device QR (IP/domain import in Hik-Connect / Guarding Vision) ----
  const qp = el('input', { type: 'password', placeholder: 'required, up to 16 characters', maxlength: 16 });
  const qhost = el('input', { type: 'text', value: dev.host });
  const qport = el('input', { type: 'number', min: 1, max: 65535, value: dev.transport === 'sdk' ? dev.port : 8000, title: 'Server port the app will connect to (Hikvision SDK port, 8000 by default)' });
  const qname = el('input', { type: 'text', value: dev.name });
  const devQrImg = el('img', { style: { width: '260px', height: '260px', background: '#fff', borderRadius: '8px', padding: '8px', display: 'none' }, alt: 'Device QR' });
  const devQrInfo = el('div', { class: 'dim small' }, 'Like iVMS-4200 → Generate QR code: the app asks for this password when scanning, then adds the device with its address, port, user and password. Credentials travel inside the QR (Hikvision fixed cipher), so the password is the only protection — share carefully.');
  let devQrText = '';
  const devQrActions = el('div', { class: 'row', style: { marginTop: '8px', display: 'none' } },
    btn('Save PNG…', { cls: 'sm', icon: 'download' }, async () => { try { const f = await api('hikconnect:saveQr', { deviceId: dev.id, text: devQrText }); if (f) toast('Saved ' + f, 'ok'); } catch (e) { toast(e.message, 'err'); } }),
    btn('Print', { cls: 'sm' }, () => printQr(dev, { serial: `${qhost.value}:${qport.value}`, model: 'Scan in Hik-Connect / Guarding Vision → Add Device → Manual adding → scan QR, then enter the QR password' }, devQrImg.src)));
  const gen = btn('Generate QR', { cls: 'primary', icon: 'external' }, async () => {
    if (!qp.value) return toast('Enter the QR password first', 'warn');
    try {
      const r = await api('hikconnect:deviceQr', { deviceId: dev.id, password: qp.value, host: qhost.value.trim(), port: Number(qport.value), name: qname.value.trim() });
      devQrText = r.text; devQrImg.src = r.dataUrl; devQrImg.style.display = 'block'; devQrActions.style.display = 'flex';
    } catch (e) { toast('QR: ' + e.message, 'err', 6000); }
  });
  body.append(el('h3', {}, 'Device QR with password (import by IP/domain, like iVMS-4200)'),
    el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '24px' } },
      el('div', { style: { flex: 1 }, class: 'col' },
        el('div', { class: 'form-grid' }, el('label', { class: 'field' }, 'QR password', qp), el('label', { class: 'field' }, 'Device name in the app', qname), el('label', { class: 'field' }, 'Address (IP or domain)', qhost), el('label', { class: 'field' }, 'Server port', qport)),
        el('div', { class: 'row' }, gen), devQrInfo),
      el('div', {}, devQrImg, devQrActions)),
    el('h3', { style: { marginTop: '18px' } }, 'Label QR (Hik-Connect cloud add by serial)'));
  body.append(el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '24px' } },
    el('div', { style: { flex: 1 } },
      el('h3', {}, 'Status'), status,
      el('h3', {}, 'Settings'),
      el('label', { class: 'check' }, enabled, 'Enable Hik-Connect / Guarding Vision service on the device'),
      el('label', { class: 'field', style: { marginTop: '8px' } }, 'Device verification code (needed when adding the device in the app)', code),
      el('div', { class: 'row', style: { marginTop: '10px' } }, save),
      el('p', { class: 'dim small' }, 'In Hik-Connect or Guarding Vision: Add Device → Scan QR code → scan the code on the right (same as the label on the device), then enter the verification code. The device must be online with the service enabled.')),
    el('div', {}, el('h3', {}, 'Device QR code'), el('label', { class: 'field', style: { marginBottom: '8px' } }, 'App', brand), qrImg, qrNote,
      el('div', { class: 'row', style: { marginTop: '8px' } },
        btn('Save PNG…', { cls: 'sm', icon: 'download' }, async () => { try { const f = await api('hikconnect:saveQr', { deviceId: dev.id, text: qrText() }); if (f) toast('Saved ' + f, 'ok'); } catch (e) { toast(e.message, 'err'); } }),
        btn('Print', { cls: 'sm' }, () => printQr(dev, st, qrImg.src))))));
}

function printQr(dev, st, src) {
  const w = window.open('', '_blank', 'width=420,height=560');
  if (!w) return toast('Popup blocked', 'warn');
  w.document.write(`<html><head><title>${dev.name} — QR</title><style>body{font-family:sans-serif;text-align:center;padding:24px}img{width:300px;height:300px}code{font-size:14px}</style></head><body><h2>${dev.name}</h2><img src="${src}"><p><code>${st.serial || ''}</code></p><p>${st.model || ''}</p><p style="font-size:12px;color:#555">Scan with Hik-Connect / Guarding Vision → Add Device → Scan QR code</p><script>window.onload=()=>{window.print();}</script></body></html>`);
  w.document.close();
}
