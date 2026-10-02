// Hikvision stream encryption key (= the device's verification code, Network → Platform Access / Hik-Connect).
import { api, el, modal, toast, deviceById } from './core.js';

/** Ask for the key and store it on the device. Resolves true when a key was saved (or removed). */
export function setStreamKey(deviceId, { reason = '' } = {}) {
  const dev = deviceById(deviceId);
  return new Promise((resolve) => {
    const inp = el('input', { type: 'password', maxlength: 16, style: { width: '100%' }, placeholder: dev && dev.hasStreamKey ? '(a key is stored — enter a new one)' : 'verification code' });
    const save = async (close) => {
      const key = inp.value;
      if (!key) { toast('Enter the key', 'warn'); return false; }
      try { await api('devices:setStreamKey', { deviceId, key }); toast('Stream key saved — reconnecting', 'ok'); close(true); } catch (e) { toast(e.message, 'err'); return false; }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(m.close); } });
    const m = modal({ title: `Stream encryption key — ${dev ? dev.name : ''}`, onClose: (v) => resolve(!!v), body: el('div', {},
      reason ? el('p', { class: 'small' }, reason) : null,
      el('label', { class: 'field' }, 'Key (the device\'s verification code)', inp),
      el('p', { class: 'dim small' }, 'Same key iVMS-4200 asks for when "Stream Encryption" is enabled under Network → Advanced → Platform Access. It is stored encrypted with the device and used for live view and playback.')),
      buttons: [
        dev && dev.hasStreamKey ? { label: 'Remove key', left: true, onClick: async (close) => { try { await api('devices:setStreamKey', { deviceId, key: '' }); toast('Stream key removed', 'ok'); close(true); } catch (e) { toast(e.message, 'err'); return false; } } } : null,
        { label: 'Cancel' },
        { label: 'Save', primary: true, onClick: save },
      ].filter(Boolean) });
  });
}
