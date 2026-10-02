# UniVMS — notes for Claude Code

Electron video management client (Hikvision ISAPI + DW Spectrum). Main process in `src/main`, vanilla ES-module renderer in `src/renderer`, tests in `tests/`.

## Versioning (project convention, not plain semver)

Version is `1.X.Y`:

- **Major change** (new feature area, large behaviour change, new vendor/driver, packaging change): bump the **second** number and reset the third. `npm run release:major` → `1.2.3 → 1.3.0`.
- **Minor change** (bug fix, small enhancement, UI tweak, dependency bump): bump the **third** number. `npm run release:minor` → `1.2.3 → 1.2.4`.
- The first number stays `1` unless the user explicitly asks for a new product generation.

Workflow: add a bullet under `## Unreleased` in `CHANGELOG.md` with every change, commit, then run the release script (add `--push` to push the tag; a tag `vX.Y.Z` triggers `.github/workflows/release.yml`, which builds the Windows installer, `.deb` and `.rpm` and attaches them to a GitHub release).

## Commands

- `npm start` — run the app. `npm test` — unit tests (mock ISAPI/Nx servers). `npm run smoke` — opens every view, fails on renderer errors. `npm run e2e` — real live-stream test (needs mediamtx in `vendor/tools/`).
- `npm run dist:win`, `npm run dist:linux` — installers into `dist/`. Linux packages are produced with nfpm (`vendor/tools/nfpm`) from `dist/linux-unpacked`; electron-builder's own deb/rpm targets need Linux tooling.

## Gotchas

- GitHub downloads on this machine are slow and reset; `scripts/fetch-ffmpeg.js` caches archives in `vendor/ffmpeg/.cache/`.
- Electron is pinned to 33.x because the runtime zip is in the local electron cache.
- Never commit anything from `vendor/` or `dist/` (gitignored).
