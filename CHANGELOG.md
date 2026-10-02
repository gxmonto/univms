# Changelog

## Unreleased

- Hikvision SDK connection type (server port 8000, exactly like iVMS-4200): login, live view and playback (SDK stream piped into ffmpeg), two-way audio with the SDK's own voice-channel numbering, alarms, snapshots and all ISAPI configuration tunnelled through port 8000. Choose "Connection: Hikvision SDK / server port" in the device dialog. The free Device Network SDK is downloaded at build time (`scripts/fetch-hiksdk.js`) and bundled as `resources/hiksdk`.

## 1.2.1 - 2026-10-02

- Two-way audio now maps voice channels the way iVMS does: the microphone on a camera talks to that camera through the NVR (voice channel N+1), falling back to the recorder's own output, and a new "Two-way audio with the recorder" action on the device (right-click, or Remote config) drives speakers connected to the NVR. Per-camera override available in the tile menu; Remote config lists the device's voice channels.
## 1.2.0 - 2026-10-02

- Two-way audio: talk through Hikvision cameras / NVR speakers from a live tile (microphone button), with device audio played back.
- Event rules editor for Hikvision channels: motion-detection grid, line-crossing lines and intrusion regions drawn over a snapshot and written back to the device (camera right-click → Event rules).
- Fisheye dewarping (WebGL): 360° panorama or virtual PTZ per tile, with per-camera center/radius/mount calibration; snapshots capture the dewarped view.
- "Import encoding channels" in Camera groups, and "Re-import channels" on devices, for rebuilding groups after a device was fixed or a group deleted.
- Fixed the UI overflowing the window (window controls and right-hand tiles pushed off-screen); module bar uses shorter names and collapses into a single menu button when the window is too narrow; the window is sized to the screen's work area and its position/size are remembered.
- Shorter, per-vendor port labels in the device dialog; a real tooltip on the empty-tile info icon.
- Fixed the release script mangling CHANGELOG.md on Windows (CRLF line endings).
## 1.1.0 - 2026-10-02

- Automatic update checks against GitHub Releases with a "new version" dialog that shows the release notes, download progress and a restart prompt; the portable exe and Linux packages get a direct download link. New *Updates* section in System Config (policy, server, token, check now, release notes) and a "What's new" screen after upgrading.
- Frameless window with minimize / maximize / close in the app's own title bar; double-click the bar to maximize.
- Right-click menus on devices (tree and device table): open all cameras, edit, rename, remote configuration, refresh cameras, delete.
- Fixed drag & drop from the camera tree into live view, playback and e-maps (the draggable attribute was emitted as an empty string, which disables dragging).
- The device dialog now labels the port correctly per vendor: HTTP/ISAPI port for Hikvision, server port for DW Spectrum, and explains which one is needed.
- Empty live-view windows show a centered placeholder with an info icon instead of a clipped label.
- Saving an edited device no longer looks like a failure: the dialog closes, the connection is retried and the result is reported in a toast with guidance.

## 1.0.0 - 2026-10-01

- First release: Hikvision (ISAPI) and DW Spectrum drivers, live view grids with layouts/views/tour, PTZ with presets and patrols, remote playback with timeline and clip export, event center with alarm popups, e-maps, device management with discovery and remote config, log search, maintenance dashboard, local file browser, system config with app users.
- Packaging: Windows NSIS installer and portable exe, Debian `.deb` and RPM `.rpm`, all with bundled ffmpeg.
