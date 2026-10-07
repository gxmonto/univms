// MSE player fed by fragmented MP4 from the main process (ffmpeg remux of RTSP).
import { BoxSplitter, parseMoov } from './mp4.js';

const players = new Map();
let seq = 0;
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  window.vms.on('stream:data', (id, chunk) => {
    const p = players.get(id);
    if (p) p.feed(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  });
  window.vms.on('stream:end', (id, info) => {
    const p = players.get(id);
    if (p) p.onEnd(info);
  });
}

export class Player {
  /**
   * opts: { cameraId, stream:'main'|'sub', kind:'live'|'playback', startMs, endMs, audio, onStatus(status, detail), onTime(ms) }
   */
  constructor(video, opts) {
    wire();
    this.video = video;
    this.opts = { stream: 'sub', kind: 'live', audio: false, ...opts };
    this.id = null;
    this.ms = null;
    this.sb = null;
    this.queue = [];
    this.splitter = new BoxSplitter();
    this.init = null;
    this.codecInfo = null;
    this.transcode = false;
    this.stopped = true;
    this.retry = 0;
    this.bytes = 0;
    this.lastBytes = 0;
    this.lastStatsAt = 0;
    this.bitrate = 0;
    this.fps = 0;
    this._lastFrames = 0;
    this.statusText = 'idle';
    this.pendingInit = [];
    this._statsTimer = null;
    this._retryTimer = null;
    this._onVideoError = () => this.handleDecodeError('video element error ' + (video.error && video.error.code));
    video.addEventListener('error', this._onVideoError);
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
  }

  setStatus(s, detail) {
    this.statusText = s;
    this.opts.onStatus && this.opts.onStatus(s, detail || '');
  }

  async start() {
    this.stop(false);
    this.stopped = false;
    this.id = `s${++seq}_${Date.now().toString(36)}`;
    players.set(this.id, this);
    this.splitter.reset();
    this.queue = [];
    this.init = null;
    this.codecInfo = null;
    this.bytes = 0;
    this.lastBytes = 0;
    this.setStatus('connecting');
    this.resetMediaSource();
    try {
      await window.vms.invoke('stream:start', {
        id: this.id, cameraId: this.opts.cameraId, stream: this.opts.stream, kind: this.opts.kind,
        startMs: this.opts.startMs, endMs: this.opts.endMs, transcode: this.transcode, audio: this.opts.audio,
      });
    } catch (e) {
      this.setStatus('error', e.message);
      this.scheduleRetry();
    }
    clearInterval(this._statsTimer);
    this._statsTimer = setInterval(() => this.tick(), 1000);
  }

  resetMediaSource() {
    if (this.ms) {
      try { if (this.ms.readyState === 'open') this.ms.endOfStream(); } catch (_) {}
    }
    this.ms = new MediaSource();
    this.sb = null;
    const url = URL.createObjectURL(this.ms);
    this.video.src = url;
    this.ms.addEventListener('sourceopen', () => { URL.revokeObjectURL(url); this.pump(); }, { once: true });
  }

  feed(chunk) {
    if (this.stopped) return;
    this.bytes += chunk.length;
    for (const box of this.splitter.push(chunk)) {
      if (box.type === 'ftyp') { this.pendingInit = [box.data]; continue; }
      if (box.type === 'moov') {
        this.pendingInit.push(box.data);
        const total = this.pendingInit.reduce((n, b) => n + b.length, 0);
        const init = new Uint8Array(total);
        let o = 0; for (const b of this.pendingInit) { init.set(b, o); o += b.length; }
        this.init = init;
        this.codecInfo = parseMoov(box.data);
        this.pendingInit = [];
        if (!this.codecInfo.video) { this.handleDecodeError('no video track'); return; }
        if (!('MediaSource' in window) || !MediaSource.isTypeSupported(this.codecInfo.mime)) {
          this.handleDecodeError(`codec not supported: ${this.codecInfo.video.codec}`);
          return;
        }
        this.queue.push(init);
        this.setStatus('buffering', `${this.codecInfo.video.fourcc.toUpperCase()} ${this.codecInfo.video.width}x${this.codecInfo.video.height}`);
        this.pump();
        continue;
      }
      if (box.type === 'moof' || box.type === 'mdat') {
        if (!this.init) continue;
        this.queue.push(box.data);
      }
    }
    this.pump();
  }

  pump() {
    if (this.stopped || !this.ms || this.ms.readyState !== 'open' || !this.init) return;
    if (!this.sb) {
      try {
        this.sb = this.ms.addSourceBuffer(this.codecInfo.mime);
        this.sb.mode = 'segments';
        this.sb.addEventListener('updateend', () => { this.afterAppend(); this.pump(); });
        this.sb.addEventListener('error', () => this.handleDecodeError('source buffer error'));
      } catch (e) {
        this.handleDecodeError('addSourceBuffer failed: ' + e.message);
        return;
      }
    }
    if (this.sb.updating || !this.queue.length) return;
    // merge queued boxes into one append for efficiency
    const total = this.queue.reduce((n, b) => n + b.length, 0);
    const merged = new Uint8Array(total);
    let o = 0; for (const b of this.queue) { merged.set(b, o); o += b.length; }
    this.queue = [];
    try {
      this.sb.appendBuffer(merged);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        const b = this.video.buffered;
        const trimmable = b.length && this.video.currentTime - b.start(0) > 2;
        if (trimmable) { this.trim(true); this.queue.unshift(merged); }
        else if (this.opts.kind === 'playback' && this._userPaused) { this._droppedWhilePaused = true; } // paused: drop data ahead, re-seek on resume
        else this.queue.unshift(merged);
      } else this.handleDecodeError('append failed: ' + e.message);
    }
  }

  afterAppend() {
    const v = this.video;
    const b = v.buffered;
    if (!b.length) return;
    const start = b.start(b.length - 1), end = b.end(b.length - 1);
    if (this.statusText !== 'playing' && end - start > 0.2) this.setStatus('playing', this.detailText());
    if (v.currentTime < start || (v.readyState < 2 && end - start > 0.5)) v.currentTime = Math.max(start, end - 0.5);
    if (this.opts.kind === 'live' && end - v.currentTime > 2.5) v.currentTime = end - 0.4;
    if (v.paused && !this._userPaused) v.play().catch(() => {});
  }

  trim(force) {
    const v = this.video;
    if (!this.sb || this.sb.updating || !v.buffered.length) return;
    const start = v.buffered.start(0);
    const keep = this.opts.kind === 'live' ? 20 : 60;
    if (force || v.currentTime - start > keep * 2) {
      try { this.sb.remove(start, Math.max(start, v.currentTime - keep)); } catch (_) {}
    }
  }

  tick() {
    const now = performance.now();
    if (this.lastStatsAt) {
      const dt = (now - this.lastStatsAt) / 1000;
      this.bitrate = ((this.bytes - this.lastBytes) * 8) / dt;
      const q = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
      if (q) { this.fps = (q.totalVideoFrames - this._lastFrames) / dt; this._lastFrames = q.totalVideoFrames; }
    }
    this.lastStatsAt = now;
    this.lastBytes = this.bytes;
    this.trim(false);
    if (this.statusText === 'playing') this.opts.onStatus && this.opts.onStatus('playing', this.detailText());
    if (this.opts.onTime && this.opts.kind === 'playback' && this.opts.startMs) this.opts.onTime(this.opts.startMs + this.video.currentTime * 1000);
    // stall detection
    if (!this.stopped && this.statusText === 'playing' && this.bitrate === 0 && !this._userPaused) {
      this._stall = (this._stall || 0) + 1;
      if (this._stall >= 12) {
        this._stall = 0;
        if (this.opts.noRetry) { this.setStatus('error', 'no data'); this.stop(false); this.opts.onEnded && this.opts.onEnded(); }
        else { this.setStatus('reconnecting', 'no data'); this.restart(); }
      }
    } else this._stall = 0;
  }

  detailText() {
    const c = this.codecInfo && this.codecInfo.video;
    const parts = [];
    if (c) parts.push(`${c.fourcc.startsWith('hvc') || c.fourcc.startsWith('hev') ? 'H.265' : c.fourcc.startsWith('avc') ? 'H.264' : c.fourcc.toUpperCase()}${this.transcode ? ' (transcoded)' : ''}`, `${c.width}x${c.height}`);
    if (this.bitrate) parts.push(`${(this.bitrate / 1e6).toFixed(2)} Mbps`);
    if (this.fps) parts.push(`${Math.round(this.fps)} fps`);
    return parts.join(' • ');
  }

  handleDecodeError(reason) {
    if (this.stopped) return;
    if (!this.transcode) {
      this.transcode = true;
      this.setStatus('reconnecting', 'switching to transcode: ' + reason);
      this.restart();
    } else {
      this.setStatus('error', reason);
      this.scheduleRetry();
    }
  }

  onEnd(info) {
    if (this.stopped) return;
    if (info && info.encrypted) {
      // Hikvision stream encryption: retrying is pointless until the key is set; the view offers to enter it
      this.setStatus('encrypted', info.keyError ? 'Stream key rejected by the stream' : 'Stream is encrypted');
      this.opts.onEncrypted && this.opts.onEncrypted(info);
      return;
    }
    const msg = (info && info.error) || (info && info.code ? `ffmpeg exited (${info.code})` : 'stream ended');
    if (this.opts.kind === 'playback' && info && info.code === 0 && info.bytes > 0) {
      this.setStatus('ended', 'end of recording');
      this.opts.onEnded && this.opts.onEnded();
      return;
    }
    this.setStatus('error', msg);
    this.scheduleRetry();
  }

  scheduleRetry() {
    clearTimeout(this._retryTimer);
    if (this.stopped || this.opts.noRetry) return;
    const delay = Math.min(30000, 1500 * Math.pow(2, Math.min(this.retry, 4)));
    this.retry++;
    this.setStatus('reconnecting', `retry in ${Math.round(delay / 1000)}s`);
    this._retryTimer = setTimeout(() => this.restart(), delay);
  }

  restart() {
    if (this.stopped) return;
    // playback: resume from the current position instead of the original seek point
    if (this.opts.kind === 'playback' && this.opts.startMs && this.video.currentTime > 0) this.opts.startMs += Math.floor(this.video.currentTime * 1000);
    const oldId = this.id;
    if (oldId) { players.delete(oldId); window.vms.invoke('stream:stop', oldId).catch(() => {}); }
    this.start();
  }

  pause() { this._userPaused = true; this.video.pause(); }
  play() {
    this._userPaused = false;
    if (this._droppedWhilePaused) { this._droppedWhilePaused = false; this.restart(); return; }
    this.video.play().catch(() => {});
  }
  setRate(r) { this.video.playbackRate = r; }

  setAudio(on) {
    if (on === this.opts.audio) { this.video.muted = !on; return; }
    this.opts.audio = on;
    this.video.muted = !on;
    this.restart();
  }
  setStream(stream) {
    if (stream === this.opts.stream) return;
    this.opts.stream = stream;
    this.transcode = false;
    this.restart();
  }
  seek(startMs, endMs) {
    this.opts.startMs = startMs;
    if (endMs !== undefined) this.opts.endMs = endMs;
    this.retry = 0;
    this.restart();
  }

  stop(final = true) {
    this.stopped = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._statsTimer);
    if (this.id) { players.delete(this.id); window.vms.invoke('stream:stop', this.id).catch(() => {}); this.id = null; }
    this.queue = [];
    this.init = null;
    if (this.ms) {
      try { if (this.ms.readyState === 'open') this.ms.endOfStream(); } catch (_) {}
      this.ms = null; this.sb = null;
    }
    if (final) {
      try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); } catch (_) {}
      this.setStatus('idle');
    }
  }

  destroy() {
    this.stop(true);
    this.video.removeEventListener('error', this._onVideoError);
  }

  snapshotDataUrl(type = 'image/jpeg', quality = 0.92) {
    const v = this.video;
    if (!v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return c.toDataURL(type, quality);
  }
}

