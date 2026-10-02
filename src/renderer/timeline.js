// Canvas timeline: recording segments by type, bookmarks, playhead, zoom/pan, click-to-seek, in/out markers
import { fmtClock } from './core.js';

const COLORS = { timing: '#2f8fff', motion: '#3ac46b', alarm: '#ef5350', event: '#b069ff' };

export class Timeline {
  constructor(canvas, { onSeek, onRange } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onRange = onRange;
    this.start = 0; this.end = 0;     // visible range
    this.dayStart = 0; this.dayEnd = 0;
    this.segments = []; this.bookmarks = [];
    this.playhead = null;
    this.markIn = null; this.markOut = null;
    this.hover = null;
    this._drag = null;
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
  }
  setDay(dayStartMs) { this.dayStart = dayStartMs; this.dayEnd = dayStartMs + 86400000; this.start = this.dayStart; this.end = this.dayEnd; this.draw(); }
  setSegments(s) { this.segments = s || []; this.draw(); }
  setBookmarks(b) { this.bookmarks = b || []; this.draw(); }
  setPlayhead(ms) { this.playhead = ms; this.draw(); }
  setMarks(i, o) { this.markIn = i; this.markOut = o; this.draw(); }
  xToTime(x) { return this.start + (x / this.c.clientWidth) * (this.end - this.start); }
  timeToX(t) { return ((t - this.start) / (this.end - this.start)) * this.c.clientWidth; }

  wheel(e) {
    e.preventDefault();
    const rect = this.c.getBoundingClientRect();
    const t = this.xToTime(e.clientX - rect.left);
    const span = this.end - this.start;
    const factor = e.deltaY < 0 ? 0.7 : 1 / 0.7;
    let ns = Math.max(60000, Math.min(86400000, span * factor));
    const ratio = (t - this.start) / span;
    let start = t - ratio * ns, end = start + ns;
    if (start < this.dayStart) { start = this.dayStart; end = start + ns; }
    if (end > this.dayEnd) { end = this.dayEnd; start = end - ns; }
    this.start = start; this.end = end;
    this.draw();
  }
  down(e) {
    const rect = this.c.getBoundingClientRect();
    this._drag = { x: e.clientX - rect.left, start: this.start, end: this.end, moved: false };
    this.c.setPointerCapture(e.pointerId);
  }
  move(e) {
    const rect = this.c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (this._drag) {
      const dx = x - this._drag.x;
      if (Math.abs(dx) > 3) this._drag.moved = true;
      if (this._drag.moved) {
        const span = this._drag.end - this._drag.start;
        let start = this._drag.start - (dx / this.c.clientWidth) * span;
        start = Math.max(this.dayStart, Math.min(this.dayEnd - span, start));
        this.start = start; this.end = start + span;
      }
    }
    this.hover = x;
    this.draw();
  }
  up(e) {
    const rect = this.c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (this._drag && !this._drag.moved) {
      const t = this.xToTime(x);
      if (e.shiftKey) { this.markIn = t; if (this.markOut !== null && this.markOut < t) this.markOut = null; this.onRange && this.onRange(this.markIn, this.markOut); }
      else if (e.ctrlKey || e.metaKey) { this.markOut = t; if (this.markIn !== null && this.markIn > t) this.markIn = null; this.onRange && this.onRange(this.markIn, this.markOut); }
      else this.onSeek && this.onSeek(t);
    }
    this._drag = null;
    this.draw();
  }

  draw() {
    const c = this.c, ctx = this.ctx;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#10161d'; ctx.fillRect(0, 0, w, h);
    if (!this.end) return;
    const span = this.end - this.start;
    const trackTop = 26, trackH = h - 26 - 18;

    // ticks
    const steps = [60000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 10800000, 21600000];
    const step = steps.find((s) => (span / s) <= w / 70) || 21600000;
    ctx.strokeStyle = '#2b3641'; ctx.fillStyle = '#98a6b5'; ctx.font = '11px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center';
    const first = Math.ceil(this.start / step) * step;
    for (let t = first; t <= this.end; t += step) {
      const x = this.timeToX(t);
      ctx.beginPath(); ctx.moveTo(x, trackTop - 6); ctx.lineTo(x, h - 18); ctx.stroke();
      ctx.fillText(fmtClock(t).slice(0, step < 60000 ? 8 : 5), x, 14);
    }
    // track background
    ctx.fillStyle = '#1a222b'; ctx.fillRect(0, trackTop, w, trackH);
    // segments (timing first, then others on top)
    const order = ['timing', 'event', 'motion', 'alarm'];
    for (const type of order) {
      ctx.fillStyle = COLORS[type] || COLORS.timing;
      for (const s of this.segments) {
        if ((s.type || 'timing') !== type) continue;
        if (s.end < this.start || s.start > this.end) continue;
        const x1 = Math.max(0, this.timeToX(s.start)), x2 = Math.min(w, this.timeToX(s.end));
        const y = type === 'timing' ? trackTop : trackTop + trackH * 0.45;
        const hh = type === 'timing' ? trackH : trackH * 0.55;
        ctx.fillRect(x1, y, Math.max(1, x2 - x1), hh);
      }
    }
    // bookmarks
    for (const b of this.bookmarks) {
      const t = Number(b.startTimeMs || b.time);
      if (t < this.start || t > this.end) continue;
      const x = this.timeToX(t);
      ctx.fillStyle = '#ffd54f';
      ctx.beginPath(); ctx.moveTo(x - 5, trackTop); ctx.lineTo(x + 5, trackTop); ctx.lineTo(x, trackTop + 7); ctx.closePath(); ctx.fill();
    }
    // in/out selection
    if (this.markIn !== null || this.markOut !== null) {
      const xi = this.markIn !== null ? this.timeToX(this.markIn) : 0;
      const xo = this.markOut !== null ? this.timeToX(this.markOut) : w;
      ctx.fillStyle = 'rgba(255,213,79,.18)'; ctx.fillRect(Math.min(xi, xo), trackTop, Math.abs(xo - xi), trackH);
      ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 1.5;
      if (this.markIn !== null) { ctx.beginPath(); ctx.moveTo(xi, trackTop); ctx.lineTo(xi, trackTop + trackH); ctx.stroke(); }
      if (this.markOut !== null) { ctx.beginPath(); ctx.moveTo(xo, trackTop); ctx.lineTo(xo, trackTop + trackH); ctx.stroke(); }
      ctx.lineWidth = 1;
    }
    // hover
    if (this.hover !== null) {
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath(); ctx.moveTo(this.hover, trackTop); ctx.lineTo(this.hover, h - 18); ctx.stroke();
      ctx.fillStyle = '#dfe6ee'; ctx.textAlign = this.hover > w - 60 ? 'right' : 'left';
      ctx.fillText(fmtClock(this.xToTime(this.hover)), this.hover + (this.hover > w - 60 ? -4 : 4), h - 5);
    }
    // playhead
    if (this.playhead && this.playhead >= this.start && this.playhead <= this.end) {
      const x = this.timeToX(this.playhead);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, trackTop - 8); ctx.lineTo(x, h - 18); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(x - 6, trackTop - 8); ctx.lineTo(x + 6, trackTop - 8); ctx.lineTo(x, trackTop); ctx.closePath(); ctx.fill();
    }
    // visible range label
    ctx.fillStyle = '#66727f'; ctx.textAlign = 'left';
    ctx.fillText(`${fmtClock(this.start).slice(0, 5)} – ${fmtClock(this.end - 1).slice(0, 5)}  (wheel: zoom, drag: pan, click: seek, shift+click: in, ctrl+click: out)`, 6, h - 5);
  }
  destroy() { this.ro.disconnect(); }
}
