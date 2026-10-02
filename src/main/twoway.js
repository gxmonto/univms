'use strict';
/*
 * Hikvision two-way audio (ISAPI /ISAPI/System/TwoWayAudio).
 *   1. GET  /channels                    -> capabilities (codec, channel id)
 *   2. PUT  /channels/{id}/open
 *   3. PUT  /channels/{id}/audioData     (long-lived chunked body: G.711 µ-law/A-law 8 kHz mono from the mic)
 *      GET  /channels/{id}/audioData     (device -> client audio, same codec)
 *   4. PUT  /channels/{id}/close
 * The renderer does the mic capture and codec work (talk.js); this module owns the HTTP streams.
 */
const { EventEmitter } = require('events');
const { XMLParser } = require('fast-xml-parser');
const { streamRequest } = require('./httpclient');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

class TwoWayAudioSession extends EventEmitter {
  /**
   * target: { cameraChannel, deviceType, channelId }
   *   - channelId given      -> use it (manual override / "talk to NVR" = 1)
   *   - NVR/DVR (or >1 channels listed): voice channel 1 is the recorder's own audio output,
   *     IP camera N is voice channel N+1 (same mapping iVMS / HCNetSDK use)
   *   - standalone camera: its single channel
   */
  constructor(driver, target = {}) {
    super();
    this.driver = driver;
    this.target = typeof target === 'object' ? target : { cameraChannel: target };
    this.cameraChannel = Number(this.target.cameraChannel) || 1;
    this.channelId = null;
    this.mapping = null;
    this.codec = 'G.711ulaw';
    this.sampleRate = 8000;
    this.tx = null;
    this.rx = null;
    this.bytesOut = 0;
    this.bytesIn = 0;
    this.closed = false;
  }

  async open() {
    const d = this.driver;
    // capabilities: list of two-way audio channels (IPC: one; NVR: one per camera or a single shared channel)
    let chans = [];
    try {
      const x = await d.xml('/ISAPI/System/TwoWayAudio/channels');
      chans = asArray((x.TwoWayAudioChannelList || {}).TwoWayAudioChannel);
    } catch (e) {
      throw new Error('Device does not expose two-way audio (' + e.message + ')');
    }
    const pick = this.selectChannel(chans);
    if (!pick) throw new Error('No two-way audio channel on this device');
    this.channelId = Number(pick.id);
    this.codec = pick.audioCompressionType || 'G.711ulaw';
    // ISAPI reports the rate in kHz on most firmware ("8", "16"), occasionally in Hz
    const rate = Number(pick.audioSamplingRate) || 8;
    this.sampleRate = rate < 1000 ? rate * 1000 : rate;
    if (!/G\.?711/i.test(this.codec)) throw new Error(`Unsupported two-way audio codec ${this.codec} (only G.711 µ-law/A-law is supported)`);
    const base = `/ISAPI/System/TwoWayAudio/channels/${this.channelId}`;
    await d.put(`${base}/open`, '', { timeout: 8000 }); // also primes the digest challenge cache

    // outbound stream (client mic -> device)
    const tx = streamRequest(d.base + `${base}/audioData`, { method: 'PUT', auth: d.auth, headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } });
    this.tx = tx.req;
    tx.response.then((res) => { if (res.statusCode >= 400) this.fail(new Error(`audioData upload rejected: HTTP ${res.statusCode}`)); res.resume(); }).catch((e) => this.fail(e));
    this.tx.on('error', (e) => this.fail(e));

    // inbound stream (device -> client)
    const rx = streamRequest(d.base + `${base}/audioData`, { method: 'GET', auth: d.auth });
    rx.req.end();
    rx.response.then((res) => {
      if (res.statusCode >= 400) { res.resume(); return; } // many devices only support one direction over HTTP
      this.rx = res;
      res.on('data', (chunk) => { this.bytesIn += chunk.length; this.emit('audio', chunk); });
      res.on('error', () => {});
    }).catch(() => {});
    return { channelId: this.channelId, mapping: this.mapping, codec: /alaw/i.test(this.codec) ? 'alaw' : 'ulaw', sampleRate: this.sampleRate };
  }

  selectChannel(chans) {
    const byId = (id) => chans.find((c) => Number(c.id) === Number(id));
    if (this.target.channelId) { this.mapping = 'manual'; return byId(this.target.channelId) || null; }
    const isRecorder = /NVR|DVR|HybridNVR|IPC_?NVR|XVR|CVR/i.test(String(this.target.deviceType || '')) || chans.length > 1;
    if (isRecorder) {
      const cam = byId(this.cameraChannel + 1);
      if (cam) { this.mapping = 'camera'; return cam; }
      // recorder without per-camera voice channels: talk through the recorder's own output, like iVMS does
      this.mapping = 'recorder';
      return byId(1) || chans[0];
    }
    this.mapping = 'camera';
    return byId(this.cameraChannel) || chans[0];
  }

  send(chunk) {
    if (this.closed || !this.tx || this.tx.destroyed) return false;
    this.bytesOut += chunk.length;
    return this.tx.write(Buffer.from(chunk.buffer ? chunk.buffer : chunk, chunk.byteOffset || 0, chunk.byteLength || chunk.length));
  }

  fail(err) {
    if (this.closed) return;
    this.emit('error', err);
    this.close().catch(() => {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.tx && this.tx.end(); } catch (_) {}
    try { this.rx && this.rx.destroy(); } catch (_) {}
    const tx = this.tx; setTimeout(() => { try { tx && tx.destroy(); } catch (_) {} }, 500); // do not leave keep-alive sockets behind
    if (this.channelId !== null) {
      try { await this.driver.put(`/ISAPI/System/TwoWayAudio/channels/${this.channelId}/close`, '', { timeout: 6000 }); } catch (_) {}
    }
    this.emit('closed', { bytesOut: this.bytesOut, bytesIn: this.bytesIn });
  }
}

module.exports = { TwoWayAudioSession };
