# Changelog

## Unreleased

- Reolink cameras added by UID show their real names (as in the Reolink app) instead of Camera 1, Camera 2… The names also appear in snapshot file names. Needs the Reolink desktop app on the PC; the list updates shortly after start.
- Reolink recordings by UID: the log (`%APPDATA%\UniVMS\logs\main.log`) now records login, recorder clock, search and download results, to diagnose playback that fails on one PC.

## 1.5.3 - 2026-10-28

- Snapshots are saved directly in the snapshot folder you choose (no extra folders), named with the camera name, date and time, e.g. `Camera 01 2026-10-28 17.44.57.jpg`. Playback snapshots use the time of the recorded frame. Without a chosen folder they go to Pictures.
## 1.5.2 - 2026-10-28

- Fixed: Reolink cameras connected by UID showed recordings at the wrong time (or none) on PCs in a different time zone than the recorder. Times now follow the recorder's own clock.

- Reolink cameras connected by UID: recordings now also work when the Reolink desktop app is installed for all users (Program Files). Without the Reolink app, Playback now says so instead of showing an empty timeline.
## 1.5.1 - 2026-10-27

- Fixed: Reolink cameras connected by UID stopped playing recordings after a few seconds and kept reconnecting. Playback now runs continuously.
- Fixed: playback no longer jumps ahead when the recording has a small gap.
- Zoom windows can now be moved: drag the zoom window to another tile. Drag its coloured frame on the camera to move the zoomed area, and scroll on the frame or in the zoom window to zoom in or out.
- Dragging a camera tile onto another one now swaps them instantly, without reconnecting the streams.
## 1.5.0 - 2026-10-27

- The installers now list Mike Borden as publisher.
- Main View: right-click a tile → Make bigger / Make smaller. A bigger tile takes the space of its neighbours; their cameras move to free tiles (or a new row) and keep playing.
- Main View: zoom windows. Click the zoom window button on a tile (or right-click → Create zoom window) and drag a box on the video: a new tile shows that area enlarged. Drag the coloured frame on the camera, or drag and scroll inside the zoom window, to change the area. Uses no extra stream; saved with layouts.
## 1.4.17 - 2026-10-27

- The installers now list Gustavo Montoya as publisher and the GitHub project as homepage.
- Main View: a button at the bottom left hides or shows the camera panel (remembered).
- Main View: the fullscreen button now shows only the camera grid, without menus or toolbars. Press Esc or the button at the top to leave.
## 1.4.16 - 2026-10-23

- Reolink via UID: smooth video. Cameras behind the Reolink relay played too fast and kept freezing and jumping; they now play at their real speed with a steady picture, about 3 seconds behind live.
## 1.4.15 - 2026-10-23

- Fixed: tiles that showed the codec and bitrate but stayed black (seen on DW Spectrum and Reolink cameras with few keyframes). The player kept jumping to the newest video before the picture could be decoded; it now catches up by playing slightly faster and only jumps when it is far behind.
## 1.4.14 - 2026-10-22

- DW Spectrum: cameras open much faster and more reliably on large systems. Video now comes straight from the server that records each camera instead of being relayed through the one you added, the first picture appears in about 1–3 seconds instead of 3–8, and connections a server drops right away are reopened automatically instead of leaving the tile waiting.
## 1.4.13 - 2026-10-22

- DW Spectrum: import the server's layouts into Main View. Right-click the DW server → "Import layouts from DW…", pick the layouts (shared ones and your own) and they appear under Layouts with the same tile arrangement, including larger tiles. The copies can be edited like any other layout; importing a layout again replaces its copy.
## 1.4.12 - 2026-10-22

- DW Spectrum: cameras with a forced aspect ratio no longer fail with "Invalid data found when processing input". UniVMS now asks for the camera's own video instead of a copy re-encoded by the server, whose few re-encoding slots were full.
## 1.4.11 - 2026-10-22

- DW Spectrum: video now comes over the server's web connection with the login session instead of RTSP with the password. This fixes tiles stuck on "401 Unauthorized" with accounts that log in fine, and cameras open in about a second. Playback works the same way.
- DW Spectrum: cameras set to a forced aspect ratio in DW (for example 16:9) are shown that way.
- Main View: tiles keep a 16:9 shape like in DW Spectrum and iVMS-4200, instead of stretching to the window.
- Select several cameras in the camera panel with Ctrl or Shift, then drag them onto the grid or double-click to open them all.
- Select several tiles with Ctrl- or Shift-click; right-click to stop them, switch their stream or take snapshots, or press Delete to stop them.
- The stop (X) button is now in the top right corner of each tile.
## 1.4.10 - 2026-10-22

- DW Spectrum: cameras that have only one stream (common for generic RTSP cameras) now play. UniVMS asked for their non-existent second stream and the tiles kept reconnecting. Camera lists are refreshed shortly after start so this applies without re-adding the server.
- Connections to devices and servers no longer fail on every second request ("socket hang up"). This made DW Spectrum camera lists, events and other calls fail at random.
## 1.4.9 - 2026-10-22

- Reconnecting tiles show why the last attempt failed (for example "401 Unauthorized" or "no data"), not just the countdown.
- Stream errors in the log and on tiles no longer include the camera password.
## 1.4.8 - 2026-10-22

- Main View: saved layouts are listed in the camera panel under the devices ("Layouts"). Click one to open it; right-click for save and manage.
- Opening a layout keeps the tiles that already show the same camera instead of restarting them, so re-opening a layout is instant.
- Reolink via UID: a camera closed and reopened quickly no longer risks being stopped by the old stream's late stop request.
## 1.4.7 - 2026-10-21

- Reolink via UID: full frame rate for many cameras at once. The relay connection was being throttled to a fraction of what Reolink's relay can carry; ten cameras now play at their normal rate, start in about 11 seconds and no longer freeze for long stretches. (This replaces the note in 1.4.6 about limited relay bandwidth: the limit was in UniVMS, not at the site.)
## 1.4.6 - 2026-10-21

- Reolink via UID: tiles no longer reload every few seconds. The relay held back each camera's video until a large buffer filled, and tiles reconnected while waiting; now video is passed on as it arrives, and a tile keeps its picture through gaps instead of reconnecting. Note that a recorder reached through Reolink's relay has limited bandwidth (about 0.5 Mbit/s at the tested site): with many cameras open at once each one updates less often; open fewer tiles, or forward the recorder's port and add it by IP, for smooth video.
## 1.4.5 - 2026-10-21

- Fixed: cameras open in Main View disappeared when switching to another module and back. They now stay until the app is closed.
- Reolink via UID: cameras start much faster (about 15 to 20 seconds for ten cameras at once, instead of 30 seconds or more with repeated reconnects). Tiles wait until the relay has the camera ready instead of failing and retrying, and reconnect attempts are at most 10 seconds apart.
## 1.4.4 - 2026-10-21

- Reolink via UID: cameras that the recorder reports as disconnected now say "Camera offline" instead of showing a grey "Stream not ready" test picture, and a camera that is still connecting no longer gets stuck in a slow "transcoded" mode because of that picture.

- Alarm popups and the alarm sound are now off by default, also on existing installs. Motion and other events are still recorded in the Event Center; turn popups back on in System Config → Alarms if wanted.
## 1.4.3 - 2026-10-21

- Reolink via UID: fixed tiles stuck on "reconnecting" when many cameras of the same recorder were open. One stalled tile could freeze every other camera of that recorder, closed tiles kept their video running in the background, and opening many tiles at once could jam the relay. The camera list (which slots have a camera, and which are online) now refreshes by itself shortly after start and every 10 minutes, so no manual refresh is needed. With many tiles open through the relay, each camera gets fewer frames per second: the site's upload through Reolink's relay is shared by all open cameras.
## 1.4.2 - 2026-10-21

- Reolink via UID now works with many cameras at once: all channels share one login to the recorder, like the Reolink app, instead of one login per channel, which went over the recorder's limit and made tiles reconnect forever. **Channels:** with the Reolink desktop app installed on the same PC, UniVMS asks the recorder which slots have a camera and shows exactly those, wherever they are (for example cameras 1, 7 and 19 of a 24-channel NVR), with their real online state; the Channels number in the device dialog is then ignored. Without the Reolink app, UniVMS cannot ask the recorder, so it shows slots 1 up to the Channels number: enter the recorder's total number of slots (24 for a 24-channel NVR), not the number of cameras, so cameras on high slots are not left out. Empty slots then show "Stream not ready".
## 1.4.1 - 2026-10-21

- Reolink via UID: channels no longer log in to the recorder by themselves. Only channels shown in a tile hold a session, and the device's health check no longer logs in, so recorders with many channels stay under Reolink's session limit. Set the channel count to the recorder's real number of channels, and close the Reolink app while viewing the same recorder in UniVMS.
## 1.4.0 - 2026-10-21

- Reolink via UID: **playback**. Recordings are searched and played back through the relay like live view, including the timeline for each day. Needs the Reolink desktop app installed on the same PC (UniVMS uses its playback library). Playback uses the sub stream, since the relay is too slow for 4K.
## 1.3.1 - 2026-10-21

- Fixed: Reolink via UID with many channels kept reconnecting. Each channel now holds a recorder session only while it is being watched (Reolink recorders allow only about ten at once), and a closed tile no longer keeps its stream running in the background. Set the channel count to the recorder's real number of channels.
## 1.3.0 - 2026-10-21

- New device type **Reolink via UID** (P2P relay): cameras and NVRs that are only reachable through the Reolink app (no forwarded HTTP/RTSP ports) can be added with their 16-character UID, like in the Reolink app. Live view of every channel (main and sub stream) through Reolink's relay servers; no playback, snapshots, PTZ or events over the relay. Windows builds bundle the relay helper (Neolink, AGPL-3.0, source: github.com/gxmonto/neolink).
## 1.2.0 - 2026-10-20

- New vendors: **Uniview / UNV** (LAPI: live, playback by time, snapshots, recording search), **Hanwha / Wisenet** (SUNAPI: live, snapshots, recording timeline, live events, storage; HTTPS auto-detected; playback from recorders not yet available), **Reolink** cameras and NVRs (live, snapshots, PTZ with presets and patrols, recording search and playback of recorded files, motion and AI events).
- New vendor: **Dahua** NVR / XVR / IPC and Dahua OEMs (Amcrest, Lorex, IC Realtime) over the HTTP API: live view, playback by time, snapshots, PTZ with presets and tours, recording search, live events, storage, users, logs, time sync, reboot.
- Device types relabelled: Hikvision covers LTS and ENS (Hikvision OEM); DW Spectrum covers Nx Witness and Wisenet WAVE (same server software); Dahua covers Amcrest and Lorex.

- Fixed: opening a camera on an SDK (port 8000) device could freeze the whole window ("Not Responding") while the recorder was being contacted; the Hikvision SDK now runs in its own helper process.
## 1.1.2 - 2026-10-07

- Start page: a Control Panel with one tile per module opens first, like iVMS-4200.
- Cameras that were playing when the app closed are no longer reopened at the next start (a bad stream made the app crash in a loop); the layout is kept, and the tiles still come back when switching between modules in the same session. A startup view set in Main View → Views still loads. After a video crash the app reopens without the cameras.
## 1.1.1 - 2026-10-07

- Internal cleanup: removed unused code paths and settings (no visible change).
## 1.1.0 - 2026-10-07

- Hik-Connect / Guarding Vision dialog (device right-click or Remote config): service status, enable/disable, set the verification code, and the iVMS-4200-style **password-protected device QR** (address, port, user and password in Hikvision's encrypted format) that Hik-Connect / Guarding Vision import after asking for the QR password, with PNG export and print.
- SDK connection: live view and playback now read Hikvision's private PS stream from the RealPlay/playback callbacks (the "standard stream" callback delivers RTP packets, which ffmpeg could not parse); two-way audio over the SDK sends G.711 in 160-byte frames and plays the PCM the SDK returns.
- Stream failures are written to the main log (ffmpeg exit code, bytes in/out, last error lines).
- Fixed: saved device passwords became unreadable after a restart (the Windows encryption key Electron keeps in `Local State` was lost when the app was killed), so the app logged in with empty passwords and Hikvision locked the account. Passwords are now encrypted with the app's own key, protected by Windows DPAPI; a device whose saved password cannot be read any more is shown as "Saved password unreadable" and is never logged into until it is edited.
- Fixed: copies started by double-click wrote neither the log nor the configuration (console output has nowhere to go in a windowed process); the log file is written first and console errors are ignored.
- A crashed renderer (blank window) is reloaded automatically; the configuration is flushed first when the app quits.
- Fixed: the empty part of the title bar next to the module buttons could not be used to drag the window (and double-clicking it did not maximize).
- Uninstalling the Windows app now removes its data folder (configuration, logs, key); updates keep it.
- **Stream encryption** (Hikvision Platform Access / Hik-Connect → "Stream Encryption"): encrypted live view and playback now play once the key (the device's verification code) is entered, like iVMS-4200. A tile that receives an encrypted stream says so and offers to enter the key instead of reconnecting forever; the key can also be set in the device dialog or the device right-click menu, is stored encrypted with the device, and over the SDK connection the key is read from the device automatically. H.264 and H.265, both Hikvision AES variants, devices that encrypt all frames or only key frames.
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
