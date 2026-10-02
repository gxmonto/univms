'use strict';
/*
 * ffmpeg process manager.
 *  - live/playback: RTSP -> fragmented MP4 piped to the renderer (MSE) via IPC
 *  - record: RTSP -> local MP4 file
 *  - export: playback RTSP -> MP4 clip with progress
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegBin = require('./ffmpeg');

function sanitizeUrl(u) { return String(u).replace(/\/\/[^@/]*@/, '//***@'); }

class StreamManager {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.streams = new Map();   // id -> { proc, wc, info }
    this.records = new Map();   // id -> { proc, file }
    this.exports = new Map();   // id -> { proc, file }
  }

  bin(name) {
    const s = this.getSettings();
    const p = ffmpegBin.resolve(name, s[name + 'Path']);
    if (!p) throw new Error(`${name} not found. Install ffmpeg or set its path in System Config.`);
    return p;
  }

  /**
   * Start a stream for a renderer. Data is sent as 'stream:data' (id, Buffer) events.
   * opts: { id, url, transcode, audio, transport, kind:'live'|'playback', speed }
   */
  start(wc, opts) {
    this.stop(opts.id);
    const s = this.getSettings();
    const transport = opts.transport || s.rtspTransport || 'tcp';
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
    if (s.lowLatency !== false && opts.kind !== 'playback') args.push('-fflags', 'nobuffer', '-flags', 'low_delay');
    else args.push('-fflags', '+genpts');
    args.push('-rtsp_transport', transport, '-timeout', '15000000', '-i', opts.url);
    // Note: -timeout is the RTSP socket timeout (µs) in ffmpeg >= 5
    args.push('-map', '0:v:0');
    if (opts.audio) args.push('-map', '0:a:0?', '-c:a', 'aac', '-ar', '16000', '-ac', '1', '-b:a', '48k');
    else args.push('-an');
    if (opts.transcode) {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-g', '25', '-b:v', opts.bitrate || '2M');
      if (opts.scale) args.push('-vf', `scale=${opts.scale}:-2`);
    } else {
      // Remux only; the renderer requests a transcode restart if MSE cannot decode the codec (e.g. HEVC without HW support)
      args.push('-c:v', 'copy');
    }
    args.push('-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe', '-frag_duration', opts.kind === 'playback' ? '500000' : '300000', '-avoid_negative_ts', 'make_zero', 'pipe:1');

    const proc = spawn(this.bin('ffmpeg'), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const entry = { proc, wc, info: { ...opts, url: sanitizeUrl(opts.url) }, errors: [], bytes: 0, started: Date.now() };
    this.streams.set(opts.id, entry);

    proc.stdout.on('data', (chunk) => {
      entry.bytes += chunk.length;
      if (!wc.isDestroyed()) wc.send('stream:data', opts.id, chunk);
    });
    proc.stderr.on('data', (d) => {
      const lines = d.toString().split(/\r?\n/).filter(Boolean);
      entry.errors.push(...lines);
      if (entry.errors.length > 20) entry.errors.splice(0, entry.errors.length - 20);
    });
    proc.on('error', (e) => {
      entry.errors.push(e.message);
    });
    proc.on('close', (code) => {
      if (this.streams.get(opts.id) === entry) this.streams.delete(opts.id);
      if (!wc.isDestroyed()) wc.send('stream:end', opts.id, { code, error: entry.errors.slice(-3).join('\n'), bytes: entry.bytes, uptime: Date.now() - entry.started });
    });
    return { ok: true, args: args.map((a) => (a === opts.url ? sanitizeUrl(a) : a)) };
  }

  /**
   * Like start(), but ffmpeg reads from stdin and `attach(write)` connects a data source (Hikvision SDK PS stream).
   * attach returns (or resolves to) { stop }.
   */
  async startPiped(wc, opts, attach) {
    this.stop(opts.id);
    const s = this.getSettings();
    const args = ['-hide_banner', '-loglevel', 'warning'];
    if (s.lowLatency !== false && opts.kind !== 'playback') args.push('-fflags', 'nobuffer', '-flags', 'low_delay');
    else args.push('-fflags', '+genpts');
    args.push('-probesize', '2000000', '-analyzeduration', '3000000', '-f', 'mpeg', '-i', 'pipe:0', '-map', '0:v:0');
    if (opts.audio) args.push('-map', '0:a:0?', '-c:a', 'aac', '-ar', '16000', '-ac', '1', '-b:a', '48k'); else args.push('-an');
    if (opts.transcode) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-g', '25', '-b:v', opts.bitrate || '2M');
    else args.push('-c:v', 'copy');
    args.push('-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe', '-frag_duration', opts.kind === 'playback' ? '500000' : '300000', '-avoid_negative_ts', 'make_zero', 'pipe:1');
    const proc = spawn(this.bin('ffmpeg'), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const entry = { proc, wc, info: { ...opts, url: 'sdk://' + (opts.cameraId || '') }, errors: [], bytes: 0, started: Date.now(), source: null };
    this.streams.set(opts.id, entry);
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', (chunk) => { entry.bytes += chunk.length; if (!wc.isDestroyed()) wc.send('stream:data', opts.id, chunk); });
    proc.stderr.on('data', (d) => { entry.errors.push(...d.toString().split(/\r?\n/).filter(Boolean)); if (entry.errors.length > 20) entry.errors.splice(0, entry.errors.length - 20); });
    proc.on('close', (code) => {
      if (entry.source) { try { entry.source.stop(); } catch (_) {} entry.source = null; }
      if (this.streams.get(opts.id) === entry) this.streams.delete(opts.id);
      if (!wc.isDestroyed()) wc.send('stream:end', opts.id, { code, error: entry.errors.slice(-3).join('\n'), bytes: entry.bytes, uptime: Date.now() - entry.started });
    });
    try {
      entry.source = await attach((buf) => { if (!proc.stdin.destroyed && proc.exitCode === null) proc.stdin.write(buf); });
    } catch (e) {
      this.stop(opts.id);
      throw e;
    }
    return { ok: true, piped: true };
  }

  stop(id) {
    const e = this.streams.get(id);
    if (!e) return false;
    this.streams.delete(id);
    if (e.source) { try { e.source.stop(); } catch (_) {} e.source = null; }
    try { e.proc.stdin && e.proc.stdin.end(); } catch (_) {}
    try { e.proc.kill('SIGKILL'); } catch (_) {}
    return true;
  }

  stopAllFor(wc) {
    for (const [id, e] of [...this.streams]) if (e.wc === wc) this.stop(id);
  }

  stats() {
    return [...this.streams.entries()].map(([id, e]) => ({ id, bytes: e.bytes, uptime: Date.now() - e.started, url: e.info.url, transcode: !!e.info.transcode }));
  }

  // ---------- local recording ----------
  startRecord(id, url, outFile, onEnd) {
    this.stopRecord(id);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const s = this.getSettings();
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', s.rtspTransport || 'tcp', '-timeout', '15000000', '-i', url,
      '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-f', 'mp4', '-movflags', '+faststart', '-y', outFile];
    const proc = spawn(this.bin('ffmpeg'), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    const entry = { proc, file: outFile, started: Date.now(), errors: [] };
    this.records.set(id, entry);
    proc.stderr.on('data', (d) => entry.errors.push(d.toString()));
    proc.on('close', (code) => {
      if (this.records.get(id) === entry) this.records.delete(id);
      onEnd && onEnd({ code, file: outFile, error: entry.errors.slice(-2).join('') });
    });
    return { file: outFile };
  }
  stopRecord(id) {
    const e = this.records.get(id);
    if (!e) return false;
    this.records.delete(id);
    try { e.proc.stdin.write('q\n'); } catch (_) {}
    setTimeout(() => { try { e.proc.kill('SIGKILL'); } catch (_) {} }, 4000);
    return true;
  }
  recording(id) { const e = this.records.get(id); return e ? { file: e.file, started: e.started } : null; }

  // ---------- clip export ----------
  exportClip(id, url, outFile, durationSec, onProgress, onEnd) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const s = this.getSettings();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rtsp_transport', s.rtspTransport || 'tcp', '-timeout', '15000000', '-i', url,
      '-t', String(Math.max(1, Math.round(durationSec))), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac',
      '-f', 'mp4', '-movflags', '+faststart', '-progress', 'pipe:2', '-y', outFile];
    const proc = spawn(this.bin('ffmpeg'), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const entry = { proc, file: outFile, errors: [] };
    this.exports.set(id, entry);
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const m = /^out_time_us=(\d+)/.exec(l) || /^out_time_ms=(\d+)/.exec(l);
        if (m) onProgress && onProgress(Math.min(1, Number(m[1]) / 1e6 / durationSec));
        else if (!/^(frame|fps|bitrate|total_size|speed|progress|dup_frames|drop_frames|stream_)/.test(l) && l.trim()) entry.errors.push(l);
      }
    });
    proc.on('close', (code) => {
      this.exports.delete(id);
      onEnd && onEnd({ code, file: outFile, error: entry.errors.slice(-3).join('\n') });
    });
    return { file: outFile };
  }
  cancelExport(id) {
    const e = this.exports.get(id);
    if (e) { try { e.proc.kill('SIGKILL'); } catch (_) {} }
  }

  shutdown() {
    for (const id of [...this.streams.keys()]) this.stop(id);
    for (const id of [...this.records.keys()]) this.stopRecord(id);
    for (const id of [...this.exports.keys()]) this.cancelExport(id);
  }
}

module.exports = { StreamManager };
