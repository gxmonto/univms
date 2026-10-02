// PTZ control panel: d-pad, zoom/focus/iris, speed, presets, patrols, aux
import { api, el, svg, toast, promptText, cameraById, deviceById, confirm } from './core.js';
import I from './icons.js';

export function createPtzPanel(container) {
  let cameraId = null;
  let speed = Number(localStorage.getItem('ptz.speed') || 50);
  let capable = null;

  const title = el('div', { class: 'muted small', style: { textAlign: 'center' } }, 'Select a camera tile');
  const pad = el('div', { class: 'pad' });
  const dirs = [[-1, 1, 315], [0, 1, 0], [1, 1, 45], [-1, 0, 270], null, [1, 0, 90], [-1, -1, 225], [0, -1, 180], [1, -1, 135]];
  for (const d of dirs) {
    if (!d) { pad.append(el('button', { class: 'center', title: 'Stop', onClick: () => stop() }, svg('ptz'))); continue; }
    const b = el('button', { html: I.arrow(d[2]) });
    hold(b, () => move(d[0] * speed, d[1] * speed, 0));
    pad.append(b);
  }
  const speedRow = el('div', { class: 'zrow' }, el('span', {}, 'Speed'), el('input', { type: 'range', min: 10, max: 100, step: 10, value: speed, style: { gridColumn: '2 / span 2' }, onInput: (e) => { speed = Number(e.target.value); localStorage.setItem('ptz.speed', speed); } }));
  const mk = (label, minusFn, plusFn, minusLbl = '−', plusLbl = '+') => {
    const m = el('button', {}, minusLbl), p = el('button', {}, plusLbl);
    hold(m, minusFn); hold(p, plusFn);
    return el('div', { class: 'zrow' }, el('span', {}, label), m, p);
  };
  const zoomRow = mk('Zoom', () => move(0, 0, -speed), () => move(0, 0, speed));
  const focusRow = mk('Focus', () => focus(-speed), () => focus(speed), 'Near', 'Far');
  const irisRow = mk('Iris', () => iris(-speed), () => iris(speed), 'Close', 'Open');
  const auxRow = el('div', { class: 'row', style: { justifyContent: 'center' } },
    el('button', { class: 'btn sm', title: 'Light on/off', onClick: () => aux('LIGHT') }, svg('light'), 'Light'),
    el('button', { class: 'btn sm', title: 'Wiper on/off', onClick: () => aux('WIPER') }, svg('wiper'), 'Wiper'));
  const presetsList = el('div', { class: 'presets' });
  const presetsHead = el('div', { class: 'row' }, el('h3', { class: 'grow', style: { margin: 0 } }, 'Presets'),
    el('button', { class: 'icon-btn', title: 'Refresh', onClick: loadPresets }, svg('refresh')),
    el('button', { class: 'icon-btn', title: 'Save current position as new preset', onClick: addPreset }, svg('plus')));
  const patrolsList = el('div', { class: 'presets' });
  const patrolsHead = el('div', { class: 'row' }, el('h3', { class: 'grow', style: { margin: 0 } }, 'Patrols / Tours'), el('button', { class: 'icon-btn', title: 'Refresh', onClick: loadPatrols }, svg('refresh')));
  const auxState = {};

  const root = el('div', { class: 'ptz' }, title, pad, speedRow, zoomRow, focusRow, irisRow, auxRow, presetsHead, presetsList, patrolsHead, patrolsList);
  container.append(root);

  function hold(button, onStart) {
    let active = false;
    const start = (e) => { e.preventDefault(); if (!cameraId) return; active = true; button.classList.add('pressed'); onStart(); };
    const end = () => { if (!active) return; active = false; button.classList.remove('pressed'); stop(); };
    button.addEventListener('pointerdown', start);
    button.addEventListener('pointerup', end);
    button.addEventListener('pointerleave', end);
    button.addEventListener('pointercancel', end);
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const guard = (p) => p.catch((e) => toast('PTZ: ' + e.message, 'err', 2500));
  function move(pan, tilt, zoom) { if (cameraId) guard(api('ptz:move', { cameraId, pan, tilt, zoom })); }
  function stop() { if (cameraId) guard(api('ptz:stop', cameraId)); }
  function focus(s) { if (cameraId) guard(api('ptz:focus', { cameraId, speed: s })); }
  function iris(s) { if (cameraId) guard(api('ptz:iris', { cameraId, speed: s })); }
  function aux(type) { if (!cameraId) return; auxState[type] = !auxState[type]; guard(api('ptz:aux', { cameraId, type, on: auxState[type] })); }

  async function loadPresets() {
    presetsList.innerHTML = '';
    if (!cameraId) return;
    try {
      const list = await api('ptz:presets', cameraId);
      if (!list.length) presetsList.append(el('div', { class: 'dim small', style: { padding: '6px 8px' } }, 'No presets'));
      for (const p of list) {
        presetsList.append(el('div', { class: 'p', title: 'Double-click to go to preset', onDblclick: () => guard(api('ptz:gotoPreset', { cameraId, presetId: p.id })) },
          el('span', { class: 'dim' }, String(p.id)), el('span', { class: 'n' }, p.name),
          el('button', { title: 'Go to', onClick: () => guard(api('ptz:gotoPreset', { cameraId, presetId: p.id })) }, svg('play')),
          el('button', { title: 'Overwrite with current position', onClick: async () => { if (await confirm(`Overwrite preset ${p.id} "${p.name}" with the current position?`)) guard(api('ptz:setPreset', { cameraId, presetId: p.id, name: p.name }).then(loadPresets)); } }, svg('save')),
          el('button', { title: 'Delete', onClick: async () => { if (await confirm(`Delete preset ${p.id} "${p.name}"?`, { danger: true, okLabel: 'Delete' })) guard(api('ptz:deletePreset', { cameraId, presetId: p.id }).then(loadPresets)); } }, svg('trash'))));
      }
    } catch (e) { presetsList.append(el('div', { class: 'dim small', style: { padding: '6px 8px' } }, 'Presets unavailable: ' + e.message)); }
  }
  async function addPreset() {
    if (!cameraId) return;
    const cam = cameraById(cameraId);
    const dev = deviceById(cam && cam.deviceId) || {};
    const idStr = await promptText('New preset', dev.type === 'hikvision' ? 'Preset number (1-300)' : 'Preset id', dev.type === 'hikvision' ? String((presetsList.children.length || 0) + 1) : 'preset' + Date.now().toString(36));
    if (idStr === null) return;
    const name = await promptText('New preset', 'Preset name', 'Preset ' + idStr);
    if (name === null) return;
    guard(api('ptz:setPreset', { cameraId, presetId: /^\d+$/.test(idStr) ? Number(idStr) : idStr, name }).then(loadPresets));
  }
  async function loadPatrols() {
    patrolsList.innerHTML = '';
    if (!cameraId) return;
    try {
      const list = await api('ptz:patrols', cameraId);
      if (!list.length) patrolsList.append(el('div', { class: 'dim small', style: { padding: '6px 8px' } }, 'No patrols'));
      for (const p of list) {
        patrolsList.append(el('div', { class: 'p' }, el('span', { class: 'dim' }, String(p.id)), el('span', { class: 'n' }, p.name),
          el('button', { title: 'Start', onClick: () => guard(api('ptz:patrol', { cameraId, patrolId: p.id, start: true })) }, svg('play')),
          el('button', { title: 'Stop', onClick: () => guard(api('ptz:patrol', { cameraId, patrolId: p.id, start: false })) }, svg('stop'))));
      }
    } catch (e) { patrolsList.append(el('div', { class: 'dim small', style: { padding: '6px 8px' } }, 'Patrols unavailable')); }
  }

  async function setCamera(id) {
    cameraId = id;
    const cam = id ? cameraById(id) : null;
    title.textContent = cam ? cam.name : 'Select a camera tile';
    root.style.opacity = cam ? '1' : '.5';
    presetsList.innerHTML = ''; patrolsList.innerHTML = '';
    if (!cam) return;
    capable = null;
    api('ptz:capable', id).then((ok) => { capable = ok; if (!ok) title.textContent = cam.name + ' (no PTZ reported)'; }).catch(() => {});
    loadPresets(); loadPatrols();
  }

  return { setCamera, el: root, get cameraId() { return cameraId; } };
}
