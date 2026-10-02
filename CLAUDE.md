# UniVMS — notes for Claude Code (read first)

This file is the project's memory: conventions, what exists, what was learned, what the user wants. Update it with every change (the user works from more than one PC and relies on it).

## What this is

Electron desktop VMS client (iVMS-4200 replacement) for **Hikvision** NVR/DVR/IPC via ISAPI and **DW Spectrum** (Nx Witness based) servers. Ships as Windows NSIS installer + portable exe, Debian `.deb`, RPM `.rpm`, each with a bundled static ffmpeg. GitHub: `gxmonto/univms` (private). Owner: Mike (SightWatch, `mike@sightwatch.com`), gh CLI logged in as `gxmonto`.

## Versioning (user's rule — NOT textbook semver)

Version is `1.X.Y`.
- **Major change** → bump the **second** number, reset the third: `npm run release:major` (1.2.3 → 1.3.0). Use for a genuinely new capability (new module/feature area, new vendor, packaging/update-mechanism changes).
- **Minor change** → bump the **third** number: `npm run release:minor` (1.2.3 → 1.2.4). Use for fixes, small enhancements, UI tweaks, dependency bumps.
- The first number stays `1` unless the user asks.
- **Judge the size of the whole change set before bumping** (user feedback after 1.1.0). A round of fixes is minor even if there are many of them; when a round mixes fixes with a real new feature, say which bump you chose and why. When unsure, ask.
- Keep notes under `## Unreleased` in `CHANGELOG.md` for every change; the release script moves them under the new version, writes `release-notes.md`, commits `Release vX.Y.Z`, tags, and with `-- --push` pushes (tag triggers `.github/workflows/release.yml`, which builds all installers and publishes the GitHub release with that section as notes). Do **not** put versioning explanations in README/CHANGELOG — they are for users; this file is for Claude.

## Layout

- `src/main/` — Electron main: `main.js` (windows, frameless, tray, protocol `univms-map://`, smoke/e2e hooks, updater wiring), `ipc.js` (all `ipcMain.handle`s; channel prefixes allow-listed in `preload.js`), `store.js` (JSON config in userData, passwords via `safeStorage`, window bounds), `drivers.js`, `hikvision.js` (ISAPI driver incl. PTZ, search, logs, alert stream, smart rules), `dwspectrum.js` (REST v2 bearer + legacy fallback), `httpclient.js` (digest/basic/bearer, `streamRequest` for long-lived bodies), `streams.js` (ffmpeg RTSP→fMP4 pipe, local record, clip export), `events.js` (event hub, health checks), `discovery.js` (SADP, ONVIF WS-Discovery, DW /24 probe), `twoway.js` (Hikvision two-way audio), `updater.js` (electron-updater + manual-link mode), `ffmpeg.js` (binary lookup).
- `src/renderer/` — vanilla ES modules: `app.js` (shell, nav, login, alarm popups, window controls), `core.js` (state, `el()` helper, modal/toast/context menu, `actions` registry), `tree.js` (camera tree, drag sources, device/camera menus), `player.js` + `mp4.js` (MSE player, box splitter, codec strings), `ptz.js`, `timeline.js`, `talk.js` (mic → G.711), `dewarp.js` (WebGL fisheye), `rules.js` (smart rule editor), `updates.js` (update dialogs), `views/*.js` (live, playback, events, emap, devices, files, logs, maintenance, settings, about).
- `tests/` — node:test unit tests with mock ISAPI/Nx servers (`tests/e2e/mock-isapi.js` is shared); `tests/e2e/harness.js` drives the real app (`UNIVMS_E2E=1`).
- `scripts/` — `fetch-ffmpeg.js`, `package-linux.js` (nfpm), `bump.js`, `release-notes.js`, `dev.js` (smoke/e2e launcher), `make-icons.js`, `build-linux-wsl.sh`.

## Commands

- `npm start` · `npm test` · `npm run smoke` (every view, fails on renderer errors) · `npm run e2e` (needs mediamtx in `vendor/tools/`; verifies live decoding, drag & drop, two-way audio with fake mic, rules editor, e-map, narrow-window nav collapse; screenshots in `e2e-out/`).
- `npm run dist:win` · `npm run dist:linux` (electron-builder `--linux dir` + nfpm; electron-builder's own deb/rpm need Linux tooling).

## How things work (decisions)

- Video: ffmpeg remuxes RTSP to fragmented MP4 (`-movflags empty_moov+default_base_moof+frag_keyframe -frag_duration 300000`), piped over IPC, played with MSE. H.265 → MSE codec check → automatic transcode restart. No `-tag:v hvc1` (breaks H.264).
- Hikvision has two connection types (`device.transport`): `isapi` (HTTP/ISAPI on the web port, default) and `sdk` (Hikvision Device Network SDK on the server port 8000, like iVMS-4200). RTSP port is auto-read from `/ISAPI/Security/adminAccesses` in ISAPI mode.
- **Hikvision SDK path** (`src/main/hiksdk.js`, koffi FFI, no compiler): `HikSdkSession` per device — login (`NET_DVR_Login_V40`), ISAPI pass-through (`NET_DVR_STDXMLConfig`, so the whole ISAPI driver works unchanged over 8000), live (`NET_DVR_RealPlay_V40` + `NET_DVR_SetStandardDataCallBack` → PS stream piped into ffmpeg stdin via `streams.startPiped`), playback (`NET_DVR_PlayBackByTime_V40`, device **local** time), snapshots (`NET_DVR_CaptureJPEGPicture_NEW`), voice (`NET_DVR_StartVoiceCom_MR_V30`, G.711 only; voice channel = `byStartDTalkChan + ch − 1` for IP cameras, 1 = recorder output), alarms (`NET_DVR_SetupAlarmChan_V50`, decodes `COMM_ALARM_V30`, maps `COMM_ALARM_RULE`). SDK channel numbers: IP camera N = `byStartDChan + N − 1`. Struct layouts use default alignment (koffi sizes verified in `tests/hiksdk.test.js`). The libraries (~45 MB win, ~20 MB linux) are downloaded by `scripts/fetch-hiksdk.js` from hikvision.com (needs a browser User-Agent; URLs are stable per SDK version) into `vendor/hiksdk/<platform>-x64` and bundled as `resources/hiksdk`; not in git. hikvision.com's CDN blocks GitHub runner IPs with a bot-check page, so the pruned runtimes are also stored as assets of the non-app release `hiksdk-v6.1.9.4` in this repo (`hiksdk-win32-x64.zip`, `hiksdk-linux-x64.zip`); `fetch-hiksdk.js` tries that first (needs `GH_TOKEN`/`GITHUB_TOKEN` because the repo is private) and falls back to the CDN. To update the SDK: download the new zips here, run the fetch script against them, zip the pruned folders and `gh release create hiksdk-vX.Y.Z …`, then bump `ASSET_TAG`/`VERSION` in the script. **Not yet tested against a real NVR** — needs one reachable on port 8000.
- DW Spectrum: server port 7001, HTTPS, REST v2 session token; RTSP uses the same user/password (local server user needed, cloud 2FA accounts cannot stream).
- Two-way audio (Hikvision only): `/ISAPI/System/TwoWayAudio/channels/{id}/open`, chunked PUT + GET of `audioData` in G.711 µ-law/A-law 8 kHz; renderer does capture/codec in `talk.js`. Voice-channel mapping follows iVMS/HCNetSDK: on a recorder channel 1 = the NVR's own audio output (speakers on the NVR, used via device right-click "Two-way audio with the recorder" → `talkbar.js`, id `dev:<deviceId>`), camera N = channel N+1, fallback to channel 1 when the camera has no voice channel; standalone camera = channel 1. Per-camera override stored in `cameraAliases[id].talkChannel`. DW not implemented (API unverified; needs a DW server).
- Smart rules: GET XML → edit object (fast-xml-parser keeps `@_size` attrs and namespace) → PUT rebuilt XML. Motion grid `gridMap` is hex, `ceil(cols/8)` bytes per row, column 0 = MSB.
- Fisheye dewarp is purely client-side WebGL (equidistant lens model, 180° FOV); per-camera params stored in `cameraAliases[id].dewarp`.
- Updates: electron-updater (GitHub provider) for the NSIS build; portable/deb/rpm read the GitHub release via API and get a download link. Private repo needs a token in System Config → Updates (or make the repo public). Release notes come from `release-notes.md` → `latest.yml`.
- Frameless window (`frame:false`) with custom min/max/close; `-webkit-app-region: drag` on `#topbar`, `no-drag` on controls. Native `title=` tooltips are unreliable in frameless windows → use CSS tooltips (`data-tip`). Module bar collapses into a menu button when it overflows (ResizeObserver on `#topbar`).
- Window: sized to the work area and bounds remembered (`store.data.windowBounds`); a frameless window larger than the screen is unusable, which is what the user hit first.
- "Import encoding channels" (iVMS term) = re-enumerate a device (`devices:refresh`) and add its cameras to a group (`Camera groups → Import encoding channels…`).

## Gotchas learned

- **Hikvision locks the account after a few failed logins** (ISAPI `userCheck` returns 401 with `lockStatus lock` and `unlockTime`; SDK code 153). Background retries (health check every 60 s, alarm resubscribe backoff) turned one bad login into a permanent lock in 1.3.0. Rule now: after any auth failure (`HttpError.authFailure`, `SdkError.authFailure`) the hub blocks automatic logins to that device until it is edited (`status.authFailed`, `authBlocked()`), and the SDK does a TCP connect test before sending credentials. Remote sites often forward only HTTP (e.g. `:9000`) and RTSP `:554`, not the server port 8000 → SDK mode cannot work there; use ISAPI.
- Switching a device to SDK must force port 8000 (the dialog now does); the first field test sent SDK logins to the HTTP port 9000.
- Config saves failed silently on the user's installed 1.3.0 (file untouched while devices were added) — cause not found (folder writable, no lock). `store.flush()` now catches errors, falls back to a direct write, retries and toasts; main log persists to `userData/logs/main.log`; Settings → About shows the last save time. Check that log first next time.

- `el('div', { draggable: true })` must emit `draggable="true"`; an empty attribute disables dragging (this broke all drag & drop in 1.0.0).
- Node ≥16: a server request's `'close'` fires when the body is consumed — use `res.on('close')` for connection lifetime (mock event stream bug).
- ffmpeg cannot serve RTSP for players (`-rtsp_flags listen` only accepts pushes); use mediamtx for tests.
- Windows: Git's GNU `tar` misreads `C:\…` paths; `scripts/fetch-ffmpeg.js` uses `System32\tar.exe`. Python 3.14 refuses paths > 260 chars — copy scripts to a short path. GitHub downloads here are slow (~200 KB/s) and reset; archives are cached in `vendor/ffmpeg/.cache/`.
- CRLF: the repo has `.gitattributes` `* text=auto eol=lf`; `core.autocrlf=false` locally. All changelog tooling normalizes `\r\n` (the 1.1.0 release had its changelog mangled by CRLF).
- Electron pinned to 33.x (runtime zip was cached locally). electron-builder `publish` config is required for `latest.yml`; CI passes `--publish never` and uploads artifacts itself.
- Mutation Events (`DOMNodeRemoved`) are gone in Chromium ≥127 → use modal `onClose`.
- `#app` must use `grid-template-columns: minmax(0, 1fr)`: an implicit `auto` column is sized to the top bar's min-content width and the whole UI overflows the window (the user's "icons hidden" report). Module bar uses short names (`short` in `VIEWS`) so it fits at the default width next to the window controls.
- ISAPI `audioSamplingRate` is in kHz ("8"). `talk.js` still uses ScriptProcessorNode (deprecated but working); AudioWorklet is the eventual replacement. A synthetic `.click()` is not a user gesture → always `audioContext.resume()`.
- Hikvision snapshot endpoint is not in the mock, so the rules editor shows a black background in e2e; on real devices the snapshot loads.
- WSL on this PC has no outbound network and `sudo` needs a password (`wsl -u root` works) — Linux packages are built on Windows with nfpm instead.

## User preferences

- Short labels and explanations in the UI; a tooltip beats a long sentence. iVMS-4200 behaviours are the reference (module menu when space is tight, import encoding channels, right-click menus, frameless title bar like TwinLine).
- Confirm destructive actions; report connection problems in a toast with guidance instead of blocking dialogs.
- Keep README/CHANGELOG user-facing; internal notes go here.

## Pending / needs from the user

- **Hikvision SDK mode** needs a real NVR reachable on port 8000 (IP + user/password) to validate login, stream, voice and alarms.
- Two-way audio for **DW Spectrum**: need a reachable DW server (or its API docs) to verify the audio endpoint.
- **Access control / intercom** modules (iVMS has them): need a Hikvision access controller or intercom device (model + reachable unit) to develop against the `/ISAPI/AccessControl/*` API.
- Real-device validation: all drivers are tested against mocks only; first runs against production NVRs / DW servers may reveal firmware quirks.
- Make the GitHub repo public or add a token in the app so the update check works.

## Session log

- **2026-10-02 — 1.3.1**: lockout protection after credential failures, SDK TCP pre-check and forced port 8000, robust config saving with error toast, persistent main log, config-save status in Settings.

- **2026-10-02 — 1.3.0**: Hikvision SDK connection type (port 8000) covering live, playback, two-way audio, alarms, snapshots and ISAPI pass-through; SDK fetched at build time and cached in CI. Awaiting validation on a real NVR.

- **2026-10-02 — 1.2.1**: two-way audio voice-channel mapping like iVMS (camera → N+1, recorder output = 1), "Two-way audio with the recorder" on devices, per-camera target override, voice channel list in Remote config; sockets closed cleanly (`Connection: close`, tx destroy) and unit tests get a 30 s timeout.

- **2026-10-01 — 1.0.0**: full app built (drivers, live view, playback, events, e-map, devices, files, logs, maintenance, settings), tests, installers (win/deb/rpm), GitHub repo + CI/release workflows, versioning scripts.
- **2026-10-02 — 1.1.0**: auto-update (electron-updater + manual links), frameless title bar, device right-click menus, drag & drop fix (`draggable=""`), per-vendor port labels, centered empty-tile placeholder, friendlier device edit flow. Note: user felt the bump should have been weighed more carefully → rule above.
- **2026-10-02 — 1.2.0**: two-way audio (Hikvision), smart event rules editor, fisheye dewarping, import encoding channels, collapsing module bar + work-area window sizing with remembered bounds, shorter port labels, CSS tooltip, CRLF-safe changelog tooling, README/CHANGELOG stripped of versioning text. 1.1.0 release notes on GitHub repaired.
