'use strict';
const test = require('node:test');
const assert = require('node:assert');
// electron is not available under plain node; stub the bits updater.js touches at load time
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: { app: { getVersion: () => '1.0.0', isPackaged: false }, shell: { openExternal: async () => {} } } };
const { compareVersions, feedFromUrl } = require('../src/main/updater');
test('compareVersions follows the 1.X.Y convention numerically', () => {
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('1.0.1', '1.1.0') < 0);
  assert.strictEqual(compareVersions('v1.2.0', '1.2.0'), 0);
});
test('feedFromUrl parses GitHub and generic feeds', () => {
  assert.deepStrictEqual(feedFromUrl('https://github.com/gxmonto/univms'), { provider: 'github', owner: 'gxmonto', repo: 'univms' });
  assert.deepStrictEqual(feedFromUrl('https://updates.example.com/univms/'), { provider: 'generic', url: 'https://updates.example.com/univms' });
  assert.strictEqual(feedFromUrl(''), null);
  assert.throws(() => feedFromUrl('http://insecure.example.com'), /https/);
});
