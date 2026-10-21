'use strict';
const { HikvisionDevice } = require('./hikvision');
const { DWSpectrumServer } = require('./dwspectrum');
const { DahuaDevice } = require('./dahua');
const { UniviewDevice } = require('./uniview');
const { HanwhaDevice } = require('./hanwha');
const { ReolinkDevice } = require('./reolink');
const { ReolinkUidDevice } = require('./reolinkuid');

const TYPES = {
  hikvision: { label: 'Hikvision / LTS / ENS NVR, DVR, IPC', defaultPort: 80, cls: HikvisionDevice },
  dahua: { label: 'Dahua / Amcrest / Lorex NVR, XVR, IPC (HTTP API)', defaultPort: 80, cls: DahuaDevice },
  uniview: { label: 'Uniview / UNV NVR, IPC (LAPI)', defaultPort: 80, cls: UniviewDevice },
  hanwha: { label: 'Hanwha / Wisenet NVR, camera (SUNAPI)', defaultPort: 80, cls: HanwhaDevice },
  reolink: { label: 'Reolink camera / NVR', defaultPort: 80, cls: ReolinkDevice },
  reolinkuid: { label: 'Reolink via UID (P2P relay, live view only)', defaultPort: 0, cls: ReolinkUidDevice },
  dwspectrum: { label: 'DW Spectrum / Nx Witness / Wisenet WAVE server', defaultPort: 7001, cls: DWSpectrumServer },
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
    if (d.secretLost) {
      // Treated like a credentials failure: no automatic logins until the device is edited (see EventHub.authBlocked)
      const e = new Error(`The saved password of ${d.name || d.host} could not be read (${d.secretError}). Edit the device and enter the password again.`);
      e.authFailure = true; e.secretLost = true;
      throw e;
    }
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
