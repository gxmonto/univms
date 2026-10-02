// Two-way audio (talk to a camera / NVR speaker): mic capture -> G.711 -> main process -> device,
// and device audio -> G.711 decode -> speakers. One active talk session per window.
import { api, on, toast } from './core.js';

const BIAS = 0x84, CLIP = 32635;
function linearToUlaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function ulawToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}
function linearToAlaw(sample) {
  let sign = (~sample >> 8) & 0x80;
  if (!sign) sample = -sample;
  if (sample > 32635) sample = 32635;
  let aval;
  if (sample >= 256) {
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
    aval = (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f);
  } else aval = sample >> 4;
  return (aval ^ sign ^ 0x55) & 0xff;
}
function alawToLinear(a) {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8; else if (seg === 1) t += 0x108; else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
}

let active = null;

export class TalkSession {
  constructor(cameraId, { onStatus, channelId } = {}) {
    this.cameraId = cameraId;
    this.opts = channelId ? { channelId } : {};
    this.onStatus = onStatus || (() => {});
    this.ctx = null; this.stream = null; this.proc = null; this.src = null;
    this.codec = 'ulaw'; this.rate = 8000;
    this.playHead = 0;
    this.unsubs = [];
    this.running = false;
    this.txBytes = 0; this.rxBytes = 0;
  }

  async start() {
    if (active && active !== this) await active.stop();
    active = this;
    this.onStatus('connecting');
    const info = await api('twoway:start', this.cameraId, this.opts || {});
    this.info = info;
    this.codec = info.codec; this.rate = info.sampleRate || 8000;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      await api('twoway:stop', this.cameraId).catch(() => {});
      throw new Error('Microphone not available: ' + e.message);
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    const ratio = this.ctx.sampleRate / this.rate;
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
    const sink = this.ctx.createGain(); sink.gain.value = 0; // keep the graph alive without echoing the mic
    let carry = 0;
    const enc = this.codec === 'alaw' ? linearToAlaw : linearToUlaw;
    this.proc.onaudioprocess = (e) => {
      if (!this.running) return;
      const input = e.inputBuffer.getChannelData(0);
      const out = [];
      // linear-interpolation downsample to the device rate
      for (let pos = carry; pos < input.length; pos += ratio) {
        const i = Math.floor(pos), frac = pos - i;
        const s = input[i] * (1 - frac) + (input[Math.min(i + 1, input.length - 1)] || 0) * frac;
        out.push(enc(Math.max(-32768, Math.min(32767, Math.round(s * 32767)))));
      }
      carry = (carry + Math.ceil((input.length - carry) / ratio) * ratio) - input.length;
      if (carry < 0 || carry >= ratio) carry = 0;
      if (out.length) { const bytes = new Uint8Array(out); this.txBytes += bytes.length; api('twoway:send', this.cameraId, bytes).catch(() => {}); }
    };
    this.src.connect(this.proc); this.proc.connect(sink); sink.connect(this.ctx.destination);
    const dec = this.codec === 'alaw' ? alawToLinear : ulawToLinear;
    this.unsubs.push(on('twoway:data', (cameraId, chunk) => {
      if (cameraId !== this.cameraId || !this.ctx) return;
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      this.rxBytes += u8.length;
      const buf = this.ctx.createBuffer(1, u8.length, this.rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < u8.length; i++) ch[i] = dec(u8[i]) / 32768;
      const node = this.ctx.createBufferSource(); node.buffer = buf; node.connect(this.ctx.destination);
      const now = this.ctx.currentTime;
      if (this.playHead < now + 0.05) this.playHead = now + 0.1;
      node.start(this.playHead); this.playHead += buf.duration;
    }));
    this.unsubs.push(on('twoway:end', (cameraId, info2) => { if (cameraId === this.cameraId) { this.onStatus('ended', info2 && info2.error); this.stop(false); } }));
    this.running = true;
    this.onStatus('talking', `${info.mapping === 'recorder' ? 'via NVR speaker' : info.mapping === 'manual' ? 'voice ch ' + info.channelId : 'camera'} • ${this.codec.toUpperCase()} ${this.rate} Hz`);
    return info;
  }

  async stop(tellMain = true) {
    this.running = false;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    try { this.proc && this.proc.disconnect(); this.src && this.src.disconnect(); } catch (_) {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { this.ctx && this.ctx.close(); } catch (_) {}
    this.ctx = null; this.stream = null;
    if (tellMain) await api('twoway:stop', this.cameraId).catch(() => {});
    if (active === this) active = null;
    this.onStatus('idle');
  }
}

export const activeTalk = () => active;
export const codecs = { linearToUlaw, ulawToLinear, linearToAlaw, alawToLinear };
