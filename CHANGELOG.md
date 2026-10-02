# Changelog

## Unreleased

- Hik-Connect / Guarding Vision dialog (device right-click or Remote config): service status, enable/disable, set the verification code, the device QR code in the label format (serial number plus verification code), and the iVMS-4200-style **password-protected device QR** (address, port, user and password encrypted in Hikvision's format) that Hik-Connect / Guarding Vision import after asking for the QR password; PNG export and print for both.
- SDK connection: live view and playback now read Hikvision's private PS stream from the RealPlay/playback callbacks (the "standard stream" callback delivers RTP packets, which ffmpeg could not parse); two-way audio over the SDK sends G.711 in 160-byte frames and plays the PCM the SDK returns.
- Stream failures are written to the main log (ffmpeg exit code, bytes in/out, last error lines).

## 1.0.0 - 2026-10-02

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
