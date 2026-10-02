import { el, api } from '../core.js';

export async function mount(container) {
  const info = await api('app:info');
  const root = el('div', { class: 'scroll pad', style: { flex: 1 } });
  const sec = (title, items) => el('div', { class: 'card', style: { marginBottom: '12px' } }, el('h3', {}, title), el('ul', { style: { margin: 0, paddingLeft: '18px', lineHeight: 1.7 } }, ...items.map((i) => el('li', { html: i }))));
  root.append(el('div', { class: 'about' },
    el('h2', {}, `UniVMS ${info.version}`),
    el('p', { class: 'ver' }, 'Multi-vendor video management client for Hikvision (ISAPI) devices and Digital Watchdog DW Spectrum servers. Windows, Debian/Ubuntu (.deb) and Fedora/RHEL (.rpm).'),
    sec('Main View', ['Layouts 1 / 4 / 6 / 8 / 9 / 10 / 13 / 16 / 25 / 36 / 64 plus custom N×M grids', 'Drag cameras, whole devices or groups onto tiles; drag tiles to swap; double-click to maximize', 'Per-tile snapshot, local recording, audio, main/sub stream switch, digital zoom, fullscreen', 'PTZ panel: 8-way pan/tilt, zoom, focus, iris, speed, presets (go/set/delete), patrols, light/wiper; drag a box on video for Hikvision 3D positioning', 'Saved views, startup view, tour (auto-switch) between views, auxiliary windows for multi-monitor walls (Ctrl+N)']),
    sec('Remote Playback', ['Calendar with recording markers (Hikvision), timeline with continuous / motion / alarm / event colors and DW bookmarks', 'Wheel zoom, drag pan, click to seek; 1 or 4 synchronous cameras; speed 0.25×–8×', 'Snapshot, in/out marks and clip export to MP4 (stream copy, no re-encode)']),
    sec('Event Center & E-map', ['Hikvision alert stream (motion, line crossing, intrusion, alarm input, video loss, tampering, HDD…) and DW Spectrum event log polling', 'Device online/offline monitoring, popup with snapshot and sound, acknowledge, jump to live or playback', 'E-maps: import floor plan images, drop cameras as hotspots, flashing hotspots on alarm, click for live popup']),
    sec('Device Management & Maintenance', ['Add Hikvision NVR/DVR/IPC by IP + port (HTTP/HTTPS digest auth) and DW Spectrum servers (port 7001, bearer or digest)', 'Online device discovery (Hikvision SADP, ONVIF WS-Discovery, DW subnet probe)', 'Remote config: device info, cameras & codecs, storage/HDD, time sync, network, users, reboot; import DW server layouts as views', 'Camera groups, local camera aliases, hide cameras', 'Log search (Hikvision log search, DW audit log), application log, encrypted configuration backup/restore']),
    sec('Local Files & System Config', ['Snapshot and recording browser with previews, open folder, move to trash', 'Paths, ffmpeg detection, default stream, RTSP transport, low latency, alarm types, login/users, tray, fullscreen start']),
    sec('Notes', ['Live view uses ffmpeg to remux RTSP into fragmented MP4 played by Chromium Media Source Extensions. H.264 plays natively; H.265 uses hardware decoding where available, otherwise UniVMS automatically transcodes to H.264.', 'DW Spectrum RTSP uses the same credentials as the server login; cloud-only accounts with 2FA are not supported for streaming — create a local user on the server.', 'Two-way audio and Hikvision smart-event rule configuration are not included in this version.']),
  ));
  container.append(root);
}
export function unmount() {}
