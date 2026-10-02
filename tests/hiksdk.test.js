'use strict';
// Loads the real HCNetSDK libraries (when present) and exercises init + an unreachable login.
const test = require('node:test');
const assert = require('node:assert');
const hik = require('../src/main/hiksdk');

test('Hikvision SDK loads, initializes and reports errors', { skip: !hik.available() && 'SDK libraries not present (run scripts/fetch-hiksdk.js)' }, async () => {
  hik.ensureLoaded();
  const st = hik.status();
  assert.strictEqual(st.loaded, true);
  assert.strictEqual(st.initialized, true);
  const koffi = require('koffi');
  const T = hik._types();
  // struct layouts the SDK documents (bytes): sanity-check the binding against known sizes
  assert.strictEqual(koffi.sizeof(T.NET_DVR_TIME), 24);
  assert.strictEqual(koffi.sizeof(T.NET_DVR_JPEGPARA), 4);
  assert.strictEqual(koffi.sizeof(T.NET_DVR_STREAM_INFO), 72);
  assert.strictEqual(koffi.sizeof(T.NET_DVR_SETUPALARM_PARAM_V50), 148);
  assert.strictEqual(koffi.sizeof(T.NET_DVR_ALARMINFO_V30), 268); // 265 bytes of fields padded to the DWORD alignment
  assert.strictEqual(koffi.sizeof(T.NET_DVR_DEVICEINFO_V30), 80);
  // login to a closed port fails fast with a readable SDK error
  const s = hik.HikSdkSession.get({ id: 't', host: '127.0.0.1', port: 1, username: 'admin', password: 'x' });
  await assert.rejects(() => s.login(), /not reachable|SDK login failed/);
  s.logout();
});
