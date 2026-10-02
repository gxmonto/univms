'use strict';
const { HikvisionDevice } = require('./hikvision');
const { DWSpectrumServer } = require('./dwspectrum');

const TYPES = {
  hikvision: { label: 'Hikvision NVR / DVR / IPC (ISAPI)', defaultPort: 80, cls: HikvisionDevice },
  dwspectrum: { label: 'DW Spectrum server', defaultPort: 7001, cls: DWSpectrumServer },
};

/** Driver instances cached per device id; invalidated when the device record changes. */
class DriverPool {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
  }
  get(deviceId) {
    const d = this.store.getDeviceWithSecret(deviceId);
    if (!d) throw new Error(`Unknown device ${deviceId}`);
    const key = `${d.id}|${d.updatedAt}`;
    const hit = this.cache.get(d.id);
    if (hit && hit.key === key) return hit.driver;
    const t = TYPES[d.type];
    if (!t) throw new Error(`Unsupported device type ${d.type}`);
    const driver = new t.cls(d);
    this.cache.set(d.id, { key, driver });
    return driver;
  }
  make(cfg) {
    const t = TYPES[cfg.type];
    if (!t) throw new Error(`Unsupported device type ${cfg.type}`);
    return new t.cls({ id: cfg.id || 'tmp', ...cfg });
  }
  drop(deviceId) { this.cache.delete(deviceId); }
}

/** Split `${deviceId}:${channel}` */
function splitCameraId(cameraId) {
  const i = String(cameraId).indexOf(':');
  if (i < 0) throw new Error(`Bad camera id ${cameraId}`);
  const deviceId = cameraId.slice(0, i);
  const chanRaw = cameraId.slice(i + 1);
  const channel = /^\d+$/.test(chanRaw) ? Number(chanRaw) : chanRaw;
  return { deviceId, channel };
}

module.exports = { TYPES, DriverPool, splitCameraId };
