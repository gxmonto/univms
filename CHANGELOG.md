# Changelog

## Unreleased

## 1.1.0 - 2026-10-02

- Maintenance release.
Versioning: `1.X.Y` — a **major change** increases `X` (the second number) and resets `Y`; a **minor change** increases `Y` (the third number). Use `npm run release:major` / `npm run release:minor`. Add notes under *Unreleased* as you go; the release script moves them under the new version.

## Unreleased

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
