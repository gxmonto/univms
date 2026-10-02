#!/usr/bin/env bash
# Builds the .deb and .rpm packages inside WSL (Ubuntu) or any Linux box.
# Usage (from Windows):  wsl -d Ubuntu -u root -- bash scripts/build-linux-wsl.sh
# Requires: nodejs >= 20, npm, rpm (rpmbuild), fakeroot, dpkg-dev.
# The project is copied to a native Linux path first: building on /mnt/c is slow and breaks permissions.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${UNIVMS_LINUX_BUILD_DIR:-$HOME/univms-build}"
echo "[build-linux] source: $SRC"
echo "[build-linux] work:   $WORK"
mkdir -p "$WORK"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude e2e-out --exclude '.git' \
  --exclude 'vendor/ffmpeg/win32-*' --exclude 'vendor/ffmpeg/.cache' \
  "$SRC/" "$WORK/"
cd "$WORK"

# Electron's npm package would download the Linux runtime zip; electron-builder downloads it again
# into ~/.cache/electron for packaging, so skip the first one.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund
fi

if [ ! -f vendor/ffmpeg/linux-x64/ffmpeg ]; then
  node scripts/fetch-ffmpeg.js linux x64
fi

# USE_SYSTEM_FPM is not set: electron-builder downloads its own fpm bundle (needs ruby runtime inside the bundle).
npx electron-builder --linux deb rpm --x64 "$@"

mkdir -p "$SRC/dist"
cp -v dist/*.deb dist/*.rpm "$SRC/dist/" 2>/dev/null || true
echo "[build-linux] done. Packages copied to $SRC/dist"
