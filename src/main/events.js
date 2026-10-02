'use strict';
/*
 * Event hub: subscribes to device event sources, keeps a ring buffer, monitors device health,
 * and pushes 'events:new' / 'devices:status' to all renderer windows.
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');

class EventHub extends EventEmitter {
  constructor(store, pool, broadcast) {
    super();
    this.store = store;
    this.pool = pool;
    this.broadcast = broadcast;
    this.events = [];
    this.subs = new Map();       // deviceId -> { close, timer, stopped }
    this.status = new Map();     // deviceId -> { online, lastSeen, error, cameras }
    this.cameraCache = new Map(); // deviceId -> cameras[]
    this.healthTimer = null;
  }

  start() {
    for (const d of this.store.list('devices')) this.subscribe(d.id);
    this.healthTimer = setInterval(() => this.healthCheck(), 60000);
    setTimeout(() => this.healthCheck(), 1500);
  }

  stop() {
    clearInterval(this.healthTimer);
    for (const id of [...this.subs.keys()]) this.unsubscribe(id);
  }

  push(ev) {
    const e = { id: 'ev_' + crypto.randomBytes(6).toString('hex'), acked: false, receivedAt: Date.now(), ...ev };
    this.events.push(e);
    const max = Number(this.store.getSettings().eventRetention) || 2000;
    if (this.events.length > max) this.events.splice(0, this.events.length - max);
    this.broadcast('events:new', e);
    this.emit('event', e);
    return e;
  }

  list({ deviceId, type, since, limit = 500, unackedOnly } = {}) {
    let arr = this.events;
    if (deviceId) arr = arr.filter((e) => e.deviceId === deviceId);
    if (type) arr = arr.filter((e) => e.type === type);
    if (since) arr = arr.filter((e) => e.time >= since);
    if (unackedOnly) arr = arr.filter((e) => !e.acked);
    return arr.slice(-limit).reverse();
  }
  ack(ids) {
    const set = new Set([].concat(ids));
    for (const e of this.events) if (set.has(e.id) || set.has('*')) e.acked = true;
    this.broadcast('events:acked', [...set]);
  }
  clear() { this.events = []; this.broadcast('events:cleared'); }

  cameraName(deviceId, channel) {
    const cams = this.cameraCache.get(deviceId) || [];
    const c = cams.find((x) => String(x.channel) === String(channel));
    const alias = c && this.store.data.cameraAliases[c.id];
    return c ? { cameraId: c.id, cameraName: (alias && alias.name) || c.name } : { cameraId: channel ? `${deviceId}:${channel}` : null, cameraName: channel ? `Channel ${channel}` : null };
  }

  setCameras(deviceId, cams) { this.cameraCache.set(deviceId, cams); }

  setStatus(deviceId, patch) {
    const prev = this.status.get(deviceId) || {};
    const next = { ...prev, ...patch, lastCheck: Date.now() };
    this.status.set(deviceId, next);
    const dev = this.store.getDevice(deviceId);
    if (prev.online !== undefined && prev.online !== next.online && dev) {
      this.push({ deviceId, deviceName: dev.name, type: next.online ? 'deviceOnline' : 'deviceOffline', state: 'active', time: Date.now(), description: next.online ? 'Device is back online' : `Device offline${next.error ? ': ' + next.error : ''}`, severity: next.online ? 'info' : 'warning' });
    }
    this.broadcast('devices:status', { deviceId, ...next });
    return next;
  }
  getStatus() { return Object.fromEntries(this.status); }

  /** After a credentials error we stop all automatic logins to that device until it is edited (Hikvision locks accounts after a few failures). */
  authBlocked(deviceId) {
    const st = this.status.get(deviceId);
    const dev = this.store.getDevice(deviceId);
    return !!(st && st.authFailed && dev && st.authFailedAt >= (dev.updatedAt || 0));
  }
  noteFailure(deviceId, e) {
    if (e && e.authFailure) {
      this.setStatus(deviceId, { online: false, error: e.message, authFailed: true, authFailedAt: Date.now(), secretLost: !!e.secretLost });
      this.unsubscribe(deviceId);
      return true;
    }
    return false;
  }

  async healthCheck() {
    for (const d of this.store.list('devices')) {
      if (this.authBlocked(d.id)) continue;
      try {
        const drv = this.pool.get(d.id);
        const info = await drv.probe();
        this.setStatus(d.id, { online: true, error: null, info, authFailed: false });
        if (!this.subs.has(d.id)) this.subscribe(d.id);
      } catch (e) {
        if (!this.noteFailure(d.id, e)) this.setStatus(d.id, { online: false, error: e.message });
      }
    }
  }

  subscribe(deviceId) {
    this.unsubscribe(deviceId);
    const dev = this.store.getDevice(deviceId);
    if (!dev || dev.eventsDisabled || this.authBlocked(deviceId)) return;
    const sub = { stopped: false, close: null, timer: null, backoff: 2000 };
    this.subs.set(deviceId, sub);
    if (dev.type === 'hikvision') this._hikLoop(deviceId, sub);
    else if (dev.type === 'dwspectrum') this._dwLoop(deviceId, sub);
  }

  unsubscribe(deviceId) {
    const sub = this.subs.get(deviceId);
    if (!sub) return;
    sub.stopped = true;
    clearTimeout(sub.timer);
    try { sub.close && sub.close(); } catch (_) {}
    this.subs.delete(deviceId);
  }

  async _hikLoop(deviceId, sub) {
    if (sub.stopped) return;
    const dev = this.store.getDevice(deviceId);
    if (!dev) return;
    try {
      const drv = this.pool.get(deviceId);
      const handle = await drv.alertStream((ev) => {
        const names = this.cameraName(deviceId, ev.channel);
        this.push({ deviceId, deviceName: dev.name, ...names, type: ev.type, state: ev.state, time: ev.time, description: ev.description, count: ev.count, severity: 'alarm' });
      }, (err) => {
        if (sub.stopped) return;
        sub.timer = setTimeout(() => this._hikLoop(deviceId, sub), sub.backoff);
        sub.backoff = Math.min(sub.backoff * 2, 60000);
      });
      if (sub.stopped) { handle.close(); return; }
      sub.close = () => handle.close();
      sub.backoff = 2000;
    } catch (e) {
      if (sub.stopped) return;
      if (this.noteFailure(deviceId, e)) return; // credentials rejected: do not retry automatically
      sub.timer = setTimeout(() => this._hikLoop(deviceId, sub), sub.backoff);
      sub.backoff = Math.min(sub.backoff * 2, 60000);
    }
  }

  async _dwLoop(deviceId, sub) {
    if (sub.stopped) return;
    const dev = this.store.getDevice(deviceId);
    if (!dev) return;
    const since = sub.lastTs || Date.now() - 60000;
    try {
      const drv = this.pool.get(deviceId);
      const now = Date.now();
      const evs = await drv.events(since, now);
      let maxTs = since;
      for (const ev of evs.sort((a, b) => a.time - b.time)) {
        if (ev.time <= since) continue;
        maxTs = Math.max(maxTs, ev.time);
        const names = this.cameraName(deviceId, ev.channel);
        this.push({ deviceId, deviceName: dev.name, ...names, type: ev.type, state: 'active', time: ev.time, description: ev.description, count: ev.count, severity: /disconnect|offline|failure|storage/i.test(ev.type) ? 'warning' : 'alarm' });
      }
      sub.lastTs = Math.max(maxTs, now - 5000);
      sub.backoff = 5000;
    } catch (e) {
      sub.backoff = Math.min((sub.backoff || 5000) * 2, 60000);
    }
    if (!sub.stopped) sub.timer = setTimeout(() => this._dwLoop(deviceId, sub), sub.backoff || 5000);
  }
}

module.exports = { EventHub };
