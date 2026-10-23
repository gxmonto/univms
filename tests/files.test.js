// insideRoots: file handlers accept only files inside the snapshot/recording folders
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { insideRoots } = require('../src/main/ipc');

test('file paths from the renderer are limited to the media folders', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'univms-files-'));
  const snaps = path.join(base, 'Snapshots'); const sibling = path.join(base, 'Snapshots2'); const outside = path.join(base, 'secret.txt');
  fs.mkdirSync(path.join(snaps, 'Lobby'), { recursive: true }); fs.mkdirSync(sibling);
  const shot = path.join(snaps, 'Lobby', 'a.jpg');
  fs.writeFileSync(shot, 'x'); fs.writeFileSync(path.join(sibling, 'b.jpg'), 'x'); fs.writeFileSync(outside, 'x');
  try {
    assert.strictEqual(insideRoots(shot, [snaps]).toLowerCase(), fs.realpathSync(shot).toLowerCase());
    assert.throws(() => insideRoots(outside, [snaps]), /Not a UniVMS/);
    assert.throws(() => insideRoots(path.join(snaps, '..', 'secret.txt'), [snaps]), /Not a UniVMS/, 'dot-dot escape');
    assert.throws(() => insideRoots(path.join(sibling, 'b.jpg'), [snaps]), /Not a UniVMS/, 'sibling folder with the same prefix');
    assert.throws(() => insideRoots(snaps, [snaps]), /Not a UniVMS/, 'the root itself');
    assert.throws(() => insideRoots(path.join(snaps, 'missing.jpg'), [snaps]), /ENOENT/);
    // a link inside the folder that points outside it is followed and refused
    const link = path.join(snaps, 'escape');
    fs.symlinkSync(base, link, 'junction');
    assert.throws(() => insideRoots(path.join(link, 'secret.txt'), [snaps]), /Not a UniVMS/, 'link out of the folder');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
