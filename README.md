# UniVMS

Multi-vendor video management client (iVMS-4200 style) for **Hikvision** NVRs / DVRs / IP cameras (ISAPI) and **Digital Watchdog DW Spectrum** servers (Nx-based API). Runs on Windows (NSIS installer + portable exe), Debian/Ubuntu (`.deb`) and Fedora/RHEL (`.rpm`).

## Features

| Area | What you get |
| --- | --- |
| Main View | 1/4/6/8/9/10/13/16/25/36/64 and custom N×M layouts, drag & drop from the camera tree (camera, whole device or group), tile swap, maximize, per-tile snapshot / local recording / audio / main-sub stream / digital zoom, saved views, startup view, view tour (auto-switch), auxiliary windows for multi-monitor walls |
| PTZ | 8-way pan/tilt, zoom, focus, iris, speed, presets (go/set/delete), patrols/tours, light & wiper aux, Hikvision 3D positioning by dragging a box on the video |
| Two-way audio | Talk through a Hikvision camera/NVR speaker from the live tile (G.711 over ISAPI), device audio played back |
| Event rules | Edit Hikvision motion-detection grid, line-crossing lines and intrusion regions on a snapshot and write them to the device |
| Fisheye | Client-side WebGL dewarping of fisheye cameras: 360° panorama or virtual PTZ with per-camera calibration |
| Remote Playback | Calendar with recording days, timeline with continuous / motion / alarm / event colouring and DW bookmarks, wheel-zoom and drag, click-to-seek, 1 or 4 synchronous cameras, speed 0.25×–8×, snapshots, in/out marks and MP4 clip export |
| Event Center | Hikvision alert stream (motion, line crossing, intrusion, alarm input, video loss, tamper, disk…) and DW Spectrum event log, device online/offline monitoring, popup with snapshot + sound, acknowledge, jump to live or playback |
| E-map | Floor plan images with camera hotspots, flashing on alarm, click for live popup |
| Device Management | Add by IP + port, test connection, LAN discovery (Hikvision SADP, ONVIF WS-Discovery, DW subnet probe), remote config (info, cameras & codecs, storage, time sync, network, users, reboot), DW server layout import, camera groups, aliases, hide cameras |
| Tools | Log search (Hikvision log search, DW audit log), application log, maintenance dashboard with HDD usage & time drift, encrypted config backup/restore, local file browser |
| System Config | Paths, ffmpeg detection, default stream, RTSP transport, low latency, alarm types, application users & login lock, tray, fullscreen start |

## How it works

* **Main process (Node/Electron)** talks to devices: digest-auth ISAPI for Hikvision, bearer/digest REST for DW Spectrum. Passwords are stored encrypted with Electron `safeStorage` (DPAPI on Windows, libsecret on Linux).
* **Video** is pulled over RTSP by a bundled **ffmpeg** and remuxed (no re-encode) into fragmented MP4 that the renderer plays with Media Source Extensions. H.264 plays natively everywhere; H.265 uses hardware decoding where Chromium supports it, otherwise the stream is automatically restarted with an H.264 transcode.
* **Local recording / clip export** are also ffmpeg stream copies, so they are cheap and lossless.

## Development

```bash
npm install
npm start
```

Run unit tests (mock ISAPI / Nx servers, digest auth, store encryption):

```bash
npm test
```

Smoke test (opens the app, walks every view, exits non-zero on renderer errors):

```bash
npm run smoke
```

End-to-end test (mock Hikvision NVR + mediamtx RTSP test pattern; verifies live decoding, events, e-map, view restore and writes screenshots to `e2e-out/`). Needs a [mediamtx](https://github.com/bluenviron/mediamtx/releases) binary in `vendor/tools/` or passed with `--mediamtx`:

```bash
npm run e2e
```

ffmpeg is looked up in this order: System Config override → bundled `resources/ffmpeg` → `vendor/ffmpeg/<platform>-<arch>` → `PATH`.

## Building installers

```bash
npm run dist:win      # dist/UniVMS-<ver>-win-x64.exe (NSIS installer) + dist/UniVMS-<ver>-portable.exe
npm run dist:linux    # dist/UniVMS-<ver>-linux-amd64.deb + dist/UniVMS-<ver>-linux-x86_64.rpm
```

Both commands work from Windows, macOS or Linux:

1. `scripts/fetch-ffmpeg.js` downloads a static ffmpeg build (BtbN GPL) for the target platform into `vendor/ffmpeg/<platform>-x64/` (cached under `vendor/ffmpeg/.cache/`). It ships inside the app as `resources/ffmpeg`. Set `UNIVMS_FFMPEG_SKIP=1` to skip bundling; the app then needs ffmpeg on `PATH`.
2. electron-builder packages the app. For Windows it produces the NSIS installer and the portable exe directly.
3. For Linux, electron-builder produces the unpacked app (`dist/linux-unpacked`) and `scripts/package-linux.js` wraps it into `.deb` and `.rpm` with [nfpm](https://github.com/goreleaser/nfpm), which is a single binary that runs anywhere (electron-builder's own deb/rpm targets need `fpm` and `rpmbuild`, which only exist on Linux/macOS). Put `nfpm` (or `nfpm.exe`) into `vendor/tools/` or on `PATH`, or set `NFPM=/path/to/nfpm`.

The Linux packages install to `/opt/UniVMS`, add `/usr/bin/univms`, a desktop entry and hicolor icons, and set the SUID bit on `chrome-sandbox` in post-install. If you prefer a native Linux build, `scripts/build-linux-wsl.sh` runs the full electron-builder flow inside WSL/any Linux host.

## Device notes

* **Hikvision**: use the HTTP(S) port (default 80). The RTSP port is read from the device (`/ISAPI/Security/adminAccesses`); override it in the device dialog if NAT-forwarded. Enable *Hikvision-CGI* / *ISAPI* and digest authentication on the device (default). Events come from `/ISAPI/Event/notification/alertStream`; make sure the events you want are armed on the NVR.
* **DW Spectrum**: use the server port (default 7001). Login uses the REST v2 session API (bearer token) with digest fallback for 4.x. RTSP streaming uses the same user/password, so use a **local** server user (cloud 2FA accounts cannot stream). Server layouts can be imported as UniVMS views from *Remote config → Server layouts*.
* Both vendors: sub streams are used in grids by default; switch any tile to the main stream with the `SUB/MAIN` button.

## Not included (yet)

Access-control / intercom modules (need a Hikvision access controller or intercom to develop against) and two-way audio for DW Spectrum servers (needs a DW server to verify the audio API).
