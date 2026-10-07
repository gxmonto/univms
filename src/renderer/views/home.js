// Control Panel (iVMS-4200 style start page): one tile per module.
import { el, svg, state } from '../core.js';
import { navigate } from '../app.js';

const TILES = [
  ['live', 'Main View', 'Live video in layouts, PTZ, snapshots, recording, two-way audio'],
  ['playback', 'Remote Playback', 'Search and play recordings from devices, export clips'],
  ['events', 'Event Center', 'Alarms and events from all devices'],
  ['emap', 'E-map', 'Camera hotspots on floor plans and maps'],
  ['devices', 'Device Management', 'Add NVRs, cameras and servers, remote configuration'],
  ['files', 'Local Files', 'Snapshots and recordings saved on this PC'],
  ['logs', 'Log Search', 'Device logs by time and type'],
  ['maintenance', 'Maintenance', 'Device health, storage, time, stream statistics, backup'],
  ['settings', 'System Config', 'Application settings and updates'],
];

export function mount(root) {
  root.append(el('div', { class: 'home' },
    el('div', { class: 'home-head' }, el('h2', {}, 'Control Panel'), el('span', { class: 'dim' }, `${state.devices.length} device(s) • ${state.cameras.length} camera(s)`)),
    el('div', { class: 'home-grid' }, ...TILES.map(([id, label, desc]) => el('button', { class: 'home-tile', onClick: () => navigate(id) }, svg(id === 'settings' ? 'settings' : id), el('strong', {}, label), el('span', { class: 'dim small' }, desc))))));
}
export function unmount() {}
