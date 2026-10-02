First release of UniVMS, a multi-vendor video management client for Hikvision devices and DW Spectrum servers.

**Devices**
- Hikvision NVR / DVR / IP cameras over ISAPI (web port) or the Hikvision Device Network SDK (server port 8000, like iVMS-4200); DW Spectrum servers (port 7001).
- Add by IP and port, connection test, LAN discovery (Hikvision SADP, ONVIF, DW probe), remote configuration (info, cameras and codecs, storage, time sync, network, users, reboot), DW server layout import, camera groups, "Import encoding channels", local camera names, hide cameras.
- Lockout protection: after a device rejects the credentials, automatic logins stop until the device is edited.

**Live view**
- Layouts 1 to 64 plus custom grids, drag & drop of cameras, devices and groups, saved views, startup view, tour, auxiliary windows.
- Per-tile snapshot, local recording, audio, main/sub stream, digital zoom, fisheye dewarping (panorama / virtual PTZ), two-way audio (camera or recorder speaker, voice channels mapped like iVMS).
- PTZ panel: pan/tilt/zoom/focus/iris, presets, patrols, light and wiper, Hikvision 3D positioning.

**Playback, events, maps**
- Calendar and colour-coded timeline, 1 or 4 synchronized cameras, speed control, snapshots, MP4 clip export.
- Event Center with alarm popups and sound, acknowledge, jump to live or playback; device online/offline monitoring.
- E-maps with camera hotspots that flash on alarm.
- Event rules editor for Hikvision channels: motion grid, line crossing, intrusion regions.

**Application**
- Frameless window with its own title bar, module bar that collapses on narrow windows, log search, maintenance dashboard, local file browser, encrypted configuration backup, optional application login.
- Automatic updates from GitHub Releases with release notes; silent install and relaunch on Windows, download links for the portable exe and Linux packages.
- Packages: Windows installer and portable exe, Debian `.deb`, RPM `.rpm`, all with bundled ffmpeg and the Hikvision SDK runtime.
