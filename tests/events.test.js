'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventHub } = require('../src/main/events');
const { HikvisionDevice } = require('../src/main/hikvision');
const { startMockIsapi } = require('./e2e/mock-isapi');

test('EventHub receives Hikvision alert stream events', async () => {
  const mock = await startMockIsapi({ rtspPort: 554, eventIntervalMs: 200 });
  try {
    const device = { id: 'dev_1', type: 'hikvision', name: 'Mock', host: '127.0.0.1', port: mock.port, username: 'admin', password: 'pw' };
    const store = { list: (c) => (c === 'devices' ? [device] : []), getDevice: () => device, getSettings: () => ({ eventRetention: 100 }), data: { cameraAliases: {} } };
    const pool = { get: () => new HikvisionDevice(device) };
    const received = [];
    const hub = new EventHub(store, pool, (ch, payload) => { if (ch === 'events:new') received.push(payload); });
    hub.setCameras('dev_1', [{ id: 'dev_1:1', channel: 1, name: 'Test Pattern' }]);
    hub.subscribe('dev_1');
    await new Promise((r) => setTimeout(r, 1500));
    hub.stop();
    assert.ok(received.length >= 2, `expected events, got ${received.length}`);
    assert.strictEqual(received[0].type, 'VMD');
    assert.strictEqual(received[0].cameraName, 'Test Pattern');
    assert.strictEqual(received[0].cameraId, 'dev_1:1');
    assert.strictEqual(hub.list({}).length, received.length);
  } finally { mock.close(); }
});
