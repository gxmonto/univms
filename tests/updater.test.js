'use strict';
const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
// electron is not available under plain node; stub the bits updater.js touches at load time
const electron = { app: { getVersion: () => '1.0.0', isPackaged: true }, shell: { openExternal: async () => {} } };
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: electron };
const { Updater, compareVersions } = require('../src/main/updater');
test('compareVersions follows the 1.X.Y convention numerically', () => {
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('1.0.1', '1.1.0') < 0);
  assert.strictEqual(compareVersions('v1.2.0', '1.2.0'), 0);
});
test('installer updates download automatically from the official feed and refuse downgrades', () => {
  const autoUpdater = Object.assign(new EventEmitter(), { setFeedURL(feed) { this.feed = feed; } });
  require.cache[require.resolve('electron-updater')] = { loaded: true, exports: { autoUpdater } };
  const updater = new Updater();
  updater._manualOnly = false;
  assert.strictEqual(updater._autoUpdater(), autoUpdater);
  assert.deepStrictEqual(autoUpdater.feed, { provider: 'github', owner: 'gxmonto', repo: 'univms' });
  assert.strictEqual(autoUpdater.autoDownload, true);
  assert.strictEqual(autoUpdater.autoInstallOnAppQuit, true);
  assert.strictEqual(autoUpdater.allowDowngrade, true);
});

test('manual packages ignore external URLs from release metadata', async (t) => {
  t.mock.method(https, 'get', (url, { headers }, cb) => {
    assert.strictEqual(url, 'https://api.github.com/repos/gxmonto/univms/releases/latest');
    assert.strictEqual(headers.Authorization, undefined);
    const response = Readable.from([JSON.stringify({ tag_name: 'v1.2.0', html_url: 'https://example.test' })]);
    response.statusCode = 200;
    process.nextTick(() => cb(response));
    return Object.assign(new EventEmitter(), { setTimeout() {} });
  });
  const open = t.mock.method(electron.shell, 'openExternal');
  const updater = new Updater();
  updater._manualOnly = true;
  assert.strictEqual((await updater.check()).state, 'available');
  await updater.download();
  assert.deepStrictEqual(open.mock.calls[0].arguments, ['https://github.com/gxmonto/univms/releases/tag/v1.2.0']);
});
