'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HikvisionDevice } = require('../src/main/hikvision');
const { TwoWayAudioSession } = require('../src/main/twoway');
const { startMockIsapi } = require('./e2e/mock-isapi');

test('two-way audio: open, stream mic bytes, receive device audio, close', async () => {
  const mock = await startMockIsapi({ rtspPort: 554 });
  try {
    const dev = new HikvisionDevice({ id: 'd', host: '127.0.0.1', port: mock.port, username: 'admin', password: 'pw' });
    // mock device is an NVR with voice channel 1 = local output and 2 = camera 1 (iVMS mapping: camera N -> N+1)
    const s = new TwoWayAudioSession(dev, { cameraChannel: 1, deviceType: 'NVR' });
    let received = 0;
    s.on('audio', (c) => { received += c.length; });
    const info = await s.open();
    assert.strictEqual(info.codec, 'ulaw');
    assert.strictEqual(info.channelId, 2);
    assert.strictEqual(info.mapping, 'camera');
    assert.strictEqual(mock.twoWay.openedChannel, 2);
    for (let i = 0; i < 20; i++) s.send(new Uint8Array(160).fill(0xff));
    await new Promise((r) => setTimeout(r, 300));
    await s.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(mock.twoWay.bytesIn >= 160 * 20, `device received ${mock.twoWay.bytesIn} bytes`);
    assert.ok(received > 0, 'client received device audio');
    assert.strictEqual(mock.twoWay.opened, 1);
    assert.strictEqual(mock.twoWay.closed, 1);
  } finally { mock.close(); }
});

test('two-way audio: talk to the recorder output and manual override', async () => {
  const mock = await startMockIsapi({ rtspPort: 554 });
  try {
    const dev = new HikvisionDevice({ id: 'd', host: '127.0.0.1', port: mock.port, username: 'admin', password: 'pw' });
    const nvr = new TwoWayAudioSession(dev, { channelId: 1, deviceType: 'NVR' });
    const i1 = await nvr.open();
    assert.strictEqual(i1.channelId, 1); assert.strictEqual(i1.mapping, 'manual');
    await nvr.close();
    // camera 5 on this NVR has no voice channel (6) -> falls back to the recorder output like iVMS
    const fb = new TwoWayAudioSession(dev, { cameraChannel: 5, deviceType: 'NVR' });
    const i2 = await fb.open();
    assert.strictEqual(i2.channelId, 1); assert.strictEqual(i2.mapping, 'recorder');
    await fb.close();
    // standalone camera: single channel 1
    const ipc = new TwoWayAudioSession(dev, { cameraChannel: 1, deviceType: 'IPCamera' });
    ipc.selectChannel = TwoWayAudioSession.prototype.selectChannel;
    const pick = ipc.selectChannel([{ id: '1', audioCompressionType: 'G.711ulaw' }]);
    assert.strictEqual(Number(pick.id), 1); assert.strictEqual(ipc.mapping, 'camera');
  } finally { mock.close(); }
});

test('smart rules round-trip: read, modify, write back valid XML', async () => {
  const mock = await startMockIsapi({ rtspPort: 554 });
  try {
    const dev = new HikvisionDevice({ id: 'd', host: '127.0.0.1', port: mock.port, username: 'admin', password: 'pw' });
    const caps = await dev.ruleCapabilities(1);
    assert.deepStrictEqual(caps, { motion: true, line: true, intrusion: true });

    const m = await dev.getRule('motion', 1);
    assert.strictEqual(m.config.MotionDetection.enabled, 'true');
    assert.strictEqual(m.config.MotionDetection.Grid.columnGranularity, '22');
    m.config.MotionDetection.MotionDetectionLayout.sensitivityLevel = '80';
    m.config.MotionDetection.MotionDetectionLayout.layout.gridMap = '000000'.repeat(18);
    await dev.setRule('motion', 1, m.config);
    const m2 = await dev.getRule('motion', 1);
    assert.strictEqual(m2.config.MotionDetection.MotionDetectionLayout.sensitivityLevel, '80');
    assert.ok(m2.xml.includes('xmlns="http://www.hikvision.com/ver20/XMLSchema"'), 'namespace preserved');
    assert.ok(m2.xml.startsWith('<?xml'), 'declaration preserved');

    const l = await dev.getRule('line', 1);
    const item = l.config.LineDetection.LineItemList.LineItem;
    item.enabled = 'true';
    item.directionSensitivity = 'left-right';
    item.CoordinatesList.Coordinates[0].positionX = '100';
    l.config.LineDetection.enabled = 'true';
    await dev.setRule('line', 1, l.config);
    const l2 = await dev.getRule('line', 1);
    assert.strictEqual(l2.config.LineDetection.LineItemList['@_size'], '4', 'size attribute preserved');
    assert.strictEqual(l2.config.LineDetection.LineItemList.LineItem.directionSensitivity, 'left-right');
    assert.strictEqual(l2.config.LineDetection.LineItemList.LineItem.CoordinatesList.Coordinates[0].positionX, '100');

    const f = await dev.getRule('intrusion', 1);
    const region = f.config.FieldDetection.FieldDetectionRegionList.FieldDetectionRegion;
    region.RegionCoordinatesList.RegionCoordinates.push({ positionX: '500', positionY: '950' });
    await dev.setRule('intrusion', 1, f.config);
    const f2 = await dev.getRule('intrusion', 1);
    assert.strictEqual(f2.config.FieldDetection.FieldDetectionRegionList.FieldDetectionRegion.RegionCoordinatesList.RegionCoordinates.length, 5);
  } finally { mock.close(); }
});
