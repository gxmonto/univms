#!/bin/bash
# Make bundled ffmpeg binaries executable and set up chrome-sandbox permissions.
set -e
APP_DIR="/opt/UniVMS"
if [ -d "$APP_DIR" ]; then
  chmod 4755 "$APP_DIR/chrome-sandbox" 2>/dev/null || true
  if [ -d "$APP_DIR/resources/ffmpeg" ]; then
    chmod 755 "$APP_DIR/resources/ffmpeg/ffmpeg" "$APP_DIR/resources/ffmpeg/ffprobe" 2>/dev/null || true
  fi
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
exit 0
