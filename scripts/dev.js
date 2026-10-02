#!/usr/bin/env node
// Cross-platform launcher for the test modes: node scripts/dev.js smoke | e2e [--mediamtx <path>]
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const mode = process.argv[2];
const env = { ...process.env };
if (mode === 'smoke') env.UNIVMS_SMOKE = '1';
else if (mode === 'e2e') {
  env.UNIVMS_E2E = '1';
  const i = process.argv.indexOf('--mediamtx');
  if (i > 0) env.UNIVMS_E2E_MEDIAMTX = process.argv[i + 1];
  if (!env.UNIVMS_E2E_MEDIAMTX) {
    const local = path.join(__dirname, '..', 'vendor', 'tools', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
    if (fs.existsSync(local)) env.UNIVMS_E2E_MEDIAMTX = local;
  }
  if (!env.UNIVMS_E2E_MEDIAMTX) { console.error('e2e needs mediamtx: pass --mediamtx <path> or place it in vendor/tools/ (https://github.com/bluenviron/mediamtx/releases)'); process.exit(2); }
  env.UNIVMS_E2E_OUT = env.UNIVMS_E2E_OUT || path.join(__dirname, '..', 'e2e-out');
} else {
  console.error('usage: node scripts/dev.js smoke | e2e [--mediamtx <path>]');
  process.exit(2);
}
const electron = require('electron');
const r = spawnSync(electron, [path.join(__dirname, '..')], { stdio: 'inherit', env });
process.exit(r.status === null ? 1 : r.status);
