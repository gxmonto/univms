// DW layout -> Main View layout conversion (renderer module, loaded once with a stubbed core.js; the stub reads __state live)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

async function load(cameras) {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/dwlayouts.js'), 'utf8')
    .replace(/^import .*core\.js';$/m, "const AREA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; const areaName = (i) => AREA[i] || `t${i}`; const state = { get cameras() { return globalThis.__state.cameras; } };");
  globalThis.__state = { cameras };
  return import('data:text/javascript,' + encodeURIComponent(src));
}

// every grid-area name must cover a rectangle, and there must be exactly n names
function checkAreas(custom) {
  const seen = new Map();
  custom.areas.forEach((row, r) => row.split(' ').forEach((name, c) => { const b = seen.get(name) || { r0: r, r1: r, c0: c, c1: c, cells: 0 }; b.r1 = Math.max(b.r1, r); b.c0 = Math.min(b.c0, c); b.c1 = Math.max(b.c1, c); b.cells++; seen.set(name, b); }));
  for (const [name, b] of seen) assert.strictEqual(b.cells, (b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1), `area ${name} is not a rectangle`);
  assert.strictEqual(seen.size, custom.n);
}

test('DW layout with merged items and gaps', async () => {
  const cams = ['a', 'b', 'c'].map((u) => ({ id: `dw1:${u}` }));
  const { toView } = await load(cams);
  // 3x2 grid: a = 2x2 at (-1,-1), b = 1x1 at (1,-1), c = 1x1 at (1,0); a web page item and a missing camera are dropped
  const v = toView({ id: 'L', name: 'Lobby', items: [
    { uuid: 'a', x: -1, y: -1, w: 2, h: 2 }, { uuid: 'b', x: 1, y: -1, w: 1, h: 1 }, { uuid: 'c', x: 1, y: 0, w: 1, h: 1 },
    { uuid: 'webpage', x: 2, y: -1, w: 1, h: 1 }, { uuid: 'bad', x: 0, y: 0, w: -1, h: -1 },
  ] }, 'dw1');
  assert.deepStrictEqual(v.custom, { n: 3, cols: 3, rows: 2, areas: ['a a b', 'a a c'] });
  assert.deepStrictEqual(v.cells, [{ cameraId: 'dw1:a' }, { cameraId: 'dw1:b' }, { cameraId: 'dw1:c' }]);
  assert.deepStrictEqual(v.dw, { deviceId: 'dw1', layoutId: 'L' });
  checkAreas(v.custom);
});

test('DW layout of 1x1 items is a plain grid with empty tiles in the gaps', async () => {
  const { toView } = await load([{ id: 'dw1:a' }, { id: 'dw1:b' }]);
  const v = toView({ id: 'L', name: 'x', items: [{ uuid: 'a', x: 0, y: 0, w: 1, h: 1 }, { uuid: 'b', x: 1, y: 1, w: 1, h: 1 }] }, 'dw1');
  assert.deepStrictEqual(v.custom, { n: 4, cols: 2, rows: 2 });
  assert.deepStrictEqual(v.cells, [{ cameraId: 'dw1:a' }, null, null, { cameraId: 'dw1:b' }]);
  assert.strictEqual(toView({ id: 'E', name: 'empty', items: [{ uuid: 'zzz', x: 0, y: 0, w: 1, h: 1 }] }, 'dw1'), null);
});

// optional: real layouts dumped from a DW server (DW_LAYOUTS=<layouts.json from driver.layouts()> DW_CAMS=<cameras.json>)
test('real DW layouts convert', { skip: !process.env.DW_LAYOUTS }, async () => {
  const cams = JSON.parse(fs.readFileSync(process.env.DW_CAMS, 'utf8')).map((c) => ({ id: `dw1:${c.uuid}` }));
  const { toView } = await load(cams);
  const ls = JSON.parse(fs.readFileSync(process.env.DW_LAYOUTS, 'utf8'));
  let ok = 0, merged = 0, camsIn = 0, camsOut = 0;
  for (const l of ls) {
    const v = toView(l, 'dw1');
    if (!v) continue;
    ok++;
    if (v.custom.areas) { merged++; checkAreas(v.custom); }
    assert.strictEqual(v.cells.length, v.custom.n);
    camsIn += new Set(l.items.filter((i) => i.w >= 1 && cams.some((c) => c.id === `dw1:${i.uuid}`)).map((i) => `${i.x},${i.y}`)).size;
    camsOut += v.cells.filter(Boolean).length;
  }
  console.log(`converted ${ok}/${ls.length}, ${merged} with merged tiles, cameras ${camsOut}/${camsIn}`);
  assert.ok(camsOut >= camsIn - 2); // DW has 2 overlapping items
});
