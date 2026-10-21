'use strict';
/*
 * Reolink via UID (P2P relay) — live view only. The device record's `host` holds the 16-character UID (or host:9000 for the
 * native client port), `channels` the number of NVR channels (1 for a camera). Video comes from the bundled Neolink process
 * (see neolink.js); there is no HTTP API over the relay, so playback, snapshots, PTZ and events are not available.
 */
const neolink = require('./neolink');

const CONNECT_WAIT_MS = 25000;

class ReolinkUidDevice {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.host = cfg.host;
    this.channels = Math.max(1, Math.min(64, Number(cfg.channels) || 1));
  }
  camKind() { return 'ip'; }

  /** Starts the relay process and waits (bounded) for the first channel to log in. */
  async probe() {
    await neolink.ensure({ id: this.id, host: this.host, username: this.cfg.username, password: this.cfg.password, channels: this.channels });
    const t0 = Date.now();
    for (;;) {
      const st = neolink.state(this.id);
      if (st && st.authFailure) { const e = new Error(`Login rejected through the Reolink relay: ${st.error}`); e.authFailure = true; throw e; }
      if (st && Object.values(st.cams).includes('online')) return { name: this.cfg.name, model: 'Reolink (UID relay)', deviceType: this.channels > 1 ? 'NVR' : 'IPC', channels: this.channels, vendor: 'reolink', apiMode: 'P2P relay (live only)' };
      if (!st || !st.running) throw new Error(st && st.error ? st.error : 'Relay process not running');
      if (Date.now() - t0 > CONNECT_WAIT_MS) throw new Error(st.error || 'No answer through the Reolink relay yet (is the device online in the Reolink app?)');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  systemStatus() { return Promise.resolve({}); }

  async cameras() {
    const st = neolink.state(this.id) || { cams: {} };
    const out = [];
    for (let ch = 0; ch < this.channels; ch++) out.push({ id: `${this.id}:${ch}`, deviceId: this.id, vendor: 'reolink', channel: ch, name: `Camera ${ch + 1}`, kind: 'ip', online: st.cams[`ch${ch}`] === 'online', streams: { main: { track: 0 }, sub: { track: 1 } } });
    return out;
  }

  liveUrl(channel, stream = 'sub') {
    const port = neolink.port(this.id);
    if (!port) throw new Error('Reolink relay not connected yet — refresh the device and try again');
    return `rtsp://127.0.0.1:${port}/ch${Number(channel)}/${stream === 'main' ? 'mainStream' : 'subStream'}`;
  }
  playbackUrl() { return Promise.reject(new Error('Playback is not available through the Reolink relay (UID); add the device by IP for recordings')); }
  snapshot() { return Promise.reject(new Error('Snapshots are not available through the Reolink relay')); }

  ptzCapable() { return Promise.resolve(false); }
  ptzContinuous() { return Promise.reject(new Error('PTZ is not available through the Reolink relay')); }
  ptzStop() { return Promise.resolve(); }
  ptzFocus() { return Promise.resolve(); }
  ptzIris() { return Promise.resolve(); }
  ptzAux() { return Promise.resolve(null); }
  ptzPresets() { return Promise.resolve([]); }
  ptzGotoPreset() { return Promise.resolve(); }
  ptzSetPreset() { return Promise.resolve(); }
  ptzDeletePreset() { return Promise.resolve(); }
  ptzPatrols() { return Promise.resolve([]); }
  ptzPatrol() { return Promise.resolve(); }

  searchRecordings() { return Promise.resolve([]); }
  recordingDays() { return Promise.resolve(null); }
  bookmarks() { return Promise.resolve([]); }
  storage() { return Promise.resolve([]); }
  time() { return Promise.resolve({}); }
  setTimeNow() { return Promise.reject(new Error('Not available through the Reolink relay')); }
  reboot() { return Promise.reject(new Error('Not available through the Reolink relay')); }
  users() { return Promise.resolve([]); }
  network() { return Promise.resolve([]); }
  logs() { return Promise.resolve([]); }
}

module.exports = { ReolinkUidDevice };
