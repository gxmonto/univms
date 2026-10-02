// Remote Playback: calendar, timeline, 1 or 4 synchronized cameras, clip export, snapshots
import { api, state, el, svg, btn, toast, fmtTime, fmtClock, fmtDur, startOfDay, cameraById, setStatus, on } from '../core.js';
import { createCameraTree, DT_CAMERA } from '../tree.js';
import { Player } from '../player.js';
import { Timeline } from '../timeline.js';

let tree, timeline, tiles = [], day = startOfDay(Date.now()), playing = false, rate = 1, primary = null;
let timeEl, calEl, layout = 1, playBtn, exportBar, exportId = null, unsubs = [], daysWithRec = new Set(), calMonth;

function tileFor(i) {
  const video = el('video', { muted: true, autoplay: true, playsinline: true });
  const label = el('div', { class: 'name hidden' }, el('span', { class: 'lbl' }), el('span', { class: 'st' }));
  const msg = el('div', { class: 'msg hidden' });
  const spinner = el('div', { class: 'spinner hidden' });
  const hint = el('div', { class: 'empty-hint' }, svg('playback'), 'Drag or double-click a camera');
  const tools = el('div', { class: 'tools hidden' });
  const t = { i, cameraId: null, player: null, segments: [], el: null, video, label, msg, spinner, hint, tools, lastTime: 0 };
  const close = el('button', { title: 'Remove', onClick: (e) => { e.stopPropagation(); clearTile(t); } }, svg('close'));
  const snap = el('button', { title: 'Snapshot', onClick: (e) => { e.stopPropagation(); snapshot(t); } }, svg('snapshot'));
  const audio = el('button', { title: 'Audio', onClick: (e) => { e.stopPropagation(); if (t.player) { const onA = !t.player.opts.audio; t.player.setAudio(onA); audio.classList.toggle('on', onA); } } }, svg('audio'));
  tools.append(snap, audio, close);
  t.el = el('div', { class: 'tile', onClick: () => setPrimary(t) }, video, hint, label, msg, spinner, tools);
  t.el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DT_CAMERA)) { e.preventDefault(); t.el.classList.add('drag-over'); } });
  t.el.addEventListener('dragleave', () => t.el.classList.remove('drag-over'));
  t.el.addEventListener('drop', (e) => { e.preventDefault(); t.el.classList.remove('drag-over'); const id = e.dataTransfer.getData(DT_CAMERA); if (id) assign(t, id); });
  t.el.addEventListener('dblclick', () => { if (t.cameraId) { layout = layout === 1 ? 4 : 1; renderLayout(); } });
  return t;
}
function setStatusT(t, s, d) {
  t.label.querySelector('.st').textContent = s === 'playing' ? d : s === 'idle' ? '' : s;
  t.spinner.classList.toggle('hidden', !['connecting', 'buffering', 'reconnecting'].includes(s));
  t.msg.classList.toggle('hidden', !(s === 'error' || s === 'ended'));
  t.msg.classList.toggle('err', s === 'error');
  t.msg.textContent = s === 'error' ? 'Error: ' + d : s === 'ended' ? 'End of recording' : '';
}
function setPrimary(t) {
  primary = t;
  tiles.forEach((x) => x.el.classList.toggle('selected', x === t));
  timeline.setSegments(t.segments);
  timeline.setBookmarks(t.bookmarks || []);
}

async function assign(t, cameraId) {
  clearTile(t, false);
  t.cameraId = cameraId;
  const cam = cameraById(cameraId);
  t.label.querySelector('.lbl').textContent = cam ? cam.name : cameraId;
  t.label.classList.remove('hidden'); t.hint.classList.add('hidden'); t.tools.classList.remove('hidden');
  if (!primary || !primary.cameraId) setPrimary(t);
  await search(t);
  // auto-start at first segment of the day or at requested time
  const startAt = t.pendingTime || (t.segments.length ? Math.max(day, t.segments[0].start) : null);
  t.pendingTime = null;
  if (startAt !== null) startPlayback(startAt, [t]);
}
function clearTile(t, resetUI = true) {
  if (t.player) { t.player.destroy(); t.player = null; }
  t.cameraId = null; t.segments = []; t.bookmarks = [];
  if (resetUI) { t.label.classList.add('hidden'); t.hint.classList.remove('hidden'); t.tools.classList.add('hidden'); setStatusT(t, 'idle', ''); if (primary === t) timeline.setSegments([]); }
}
async function search(t) {
  if (!t.cameraId) return;
  setStatusT(t, 'buffering', 'searching');
  try {
    const r = await api('playback:search', { cameraId: t.cameraId, start: day, end: day + 86400000 });
    t.segments = r.segments; t.bookmarks = r.bookmarks || [];
    if (primary === t) { timeline.setSegments(t.segments); timeline.setBookmarks(t.bookmarks); }
    setStatusT(t, 'idle', '');
    if (!r.segments.length) setStatus(`No recordings on ${fmtTime(day).slice(0, 10)} for ${cameraById(t.cameraId)?.name || ''}`);
    else setStatus(`${r.segments.filter((s) => s.type === 'timing').length} segments, ${fmtDur(r.segments.filter((s) => s.type === 'timing').reduce((n, s) => n + (s.end - s.start) / 1000, 0))} recorded`);
  } catch (e) { setStatusT(t, 'error', e.message); toast('Search failed: ' + e.message, 'err'); }
}
function startPlayback(timeMs, list = tiles.filter((t) => t.cameraId)) {
  for (const t of list) {
    if (!t.cameraId) continue;
    if (t.player) t.player.destroy();
    t.player = new Player(t.video, { cameraId: t.cameraId, kind: 'playback', stream: 'main', startMs: timeMs, endMs: day + 86400000, noRetry: true,
      onStatus: (s, d) => setStatusT(t, s, d),
      onTime: (ms) => { t.lastTime = ms; if (t === primary) { timeline.setPlayhead(ms); timeEl.textContent = fmtTime(ms); } },
      onEnded: () => { if (t === primary) { playing = false; updatePlayBtn(); } } });
    t.player.start();
    t.player.setRate(rate);
  }
  playing = true; updatePlayBtn();
  timeline.setPlayhead(timeMs); timeEl.textContent = fmtTime(timeMs);
}
function seekAll(timeMs) { startPlayback(timeMs); }
function updatePlayBtn() { playBtn.innerHTML = svg(playing ? 'pause' : 'play').innerHTML; playBtn.title = playing ? 'Pause' : 'Play'; }
function togglePlay() {
  const active = tiles.filter((t) => t.player);
  if (!active.length) { const t = tiles.find((x) => x.cameraId); if (t) startPlayback(t.segments.length ? t.segments[0].start : day); return; }
  playing = !playing;
  for (const t of active) playing ? t.player.play() : t.player.pause();
  updatePlayBtn();
}
function stopAll() { for (const t of tiles) if (t.player) { t.player.destroy(); t.player = null; setStatusT(t, 'idle', ''); } playing = false; updatePlayBtn(); timeline.setPlayhead(null); }
async function snapshot(t) {
  if (!t.player) return;
  const url = t.player.snapshotDataUrl();
  if (!url) return toast('No frame yet', 'warn');
  try { const r = await api('files:saveSnapshot', { cameraId: t.cameraId, dataUrl: url, suffix: '_pb' }); toast('Snapshot saved: ' + r.file, 'ok'); } catch (e) { toast(e.message, 'err'); }
}

// ---------- export ----------
async function exportClip() {
  if (!primary || !primary.cameraId) return toast('Select a camera first', 'warn');
  let { markIn, markOut } = timeline;
  if (markIn === null && markOut === null && primary.lastTime) { markIn = primary.lastTime - 30000; markOut = primary.lastTime + 30000; }
  if (markIn === null || markOut === null) return toast('Set in/out points on the timeline (shift+click = in, ctrl+click = out)', 'warn', 5000);
  if (markOut - markIn > 4 * 3600000) return toast('Clip too long (max 4 hours)', 'warn');
  try {
    const r = await api('export:clip', { cameraId: primary.cameraId, start: Math.floor(markIn), end: Math.floor(markOut) });
    exportId = r.id;
    exportBar.classList.remove('hidden');
    exportBar.querySelector('.n').textContent = `Exporting ${fmtDur((markOut - markIn) / 1000)} clip…`;
    exportBar.querySelector('i').style.width = '0%';
  } catch (e) { toast('Export failed: ' + e.message, 'err'); }
}

// ---------- calendar ----------
function renderCalendar() {
  calEl.innerHTML = '';
  const m = calMonth || new Date(day);
  const y = m.getFullYear(), mo = m.getMonth();
  const head = el('div', { class: 'cal-head' },
    el('button', { class: 'icon-btn', onClick: () => { calMonth = new Date(y, mo - 1, 1); loadDays(); renderCalendar(); } }, svg('prev')),
    el('span', {}, m.toLocaleString(undefined, { month: 'long', year: 'numeric' })),
    el('button', { class: 'icon-btn', onClick: () => { calMonth = new Date(y, mo + 1, 1); loadDays(); renderCalendar(); } }, svg('next')));
  const grid = el('div', { class: 'cal-grid' });
  for (const d of ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']) grid.append(el('div', { class: 'dow' }, d));
  const first = new Date(y, mo, 1);
  const offset = first.getDay();
  const dim = new Date(y, mo + 1, 0).getDate();
  for (let i = 0; i < offset; i++) grid.append(el('div'));
  for (let d = 1; d <= dim; d++) {
    const ms = new Date(y, mo, d).getTime();
    const cell = el('div', { class: `d ${ms === day ? 'sel' : ''} ${daysWithRec.has(d) ? 'has' : ''} ${ms > Date.now() ? 'other' : ''}`, onClick: () => setDay(ms) }, String(d));
    grid.append(cell);
  }
  calEl.append(head, grid);
}
async function loadDays() {
  daysWithRec = new Set();
  const cam = primary && primary.cameraId;
  if (!cam) return;
  const m = calMonth || new Date(day);
  try {
    const days = await api('playback:days', { cameraId: cam, year: m.getFullYear(), month: m.getMonth() + 1 });
    if (days) { daysWithRec = new Set(days); renderCalendar(); }
  } catch (_) {}
}
async function setDay(ms) {
  day = startOfDay(ms);
  calMonth = new Date(day);
  stopAll();
  timeline.setDay(day); timeline.setMarks(null, null);
  renderCalendar();
  for (const t of tiles) if (t.cameraId) await search(t);
  const t = primary && primary.cameraId ? primary : tiles.find((x) => x.cameraId);
  if (t && t.segments.length) startPlayback(Math.max(day, t.segments[0].start));
}

function renderLayout(container) {
  const stage = document.getElementById('pb-stage');
  stage.innerHTML = '';
  stage.style.gridTemplateColumns = layout === 4 ? '1fr 1fr' : '1fr';
  stage.style.gridTemplateRows = layout === 4 ? '1fr 1fr' : '1fr';
  while (tiles.length < layout) tiles.push(tileFor(tiles.length));
  for (let i = layout; i < tiles.length; i++) clearTile(tiles[i]);
  tiles.length = Math.max(layout, tiles.length);
  for (let i = 0; i < layout; i++) stage.append(tiles[i].el);
  if (!primary || tiles.indexOf(primary) >= layout) setPrimary(tiles[0]);
}

export function mount(container, p = {}) {
  const side = el('aside', { class: 'side' });
  const content = el('section', { class: 'content' });
  const stage = el('div', { class: 'pb-video', id: 'pb-stage' });
  const canvas = el('canvas');
  const tlWrap = el('div', { class: 'timeline-wrap' }, canvas);
  timeEl = el('span', { class: 'time' }, '--');
  playBtn = el('button', { class: 'icon-btn', title: 'Play', onClick: togglePlay }, svg('play'));
  const rateSel = el('select', { title: 'Client-side playback rate. Above 1x the stream is still pulled in real time, so fast speeds may pause to buffer.', onChange: (e) => { rate = Number(e.target.value); for (const t of tiles) if (t.player) t.player.setRate(rate); } }, ...[0.25, 0.5, 1, 2, 4, 8].map((r) => el('option', { value: r, selected: r === 1 }, r + 'x')));
  exportBar = el('div', { class: 'row hidden', style: { padding: '4px 10px', background: 'var(--bg-2)' } }, el('span', { class: 'n small muted' }), el('div', { class: 'progress grow' }, el('i')), btn('Cancel', { cls: 'sm' }, () => { if (exportId) api('export:cancel', exportId); exportBar.classList.add('hidden'); }));
  const controls = el('div', { class: 'pb-controls' },
    playBtn,
    el('button', { class: 'icon-btn', title: 'Stop', onClick: stopAll }, svg('stop')),
    el('button', { class: 'icon-btn', title: 'Back 30s', onClick: () => primary && primary.lastTime && seekAll(primary.lastTime - 30000) }, svg('prev')),
    el('button', { class: 'icon-btn', title: 'Forward 30s', onClick: () => primary && primary.lastTime && seekAll(primary.lastTime + 30000) }, svg('next')),
    el('span', { class: 'dim small' }, 'Speed'), rateSel,
    el('div', { class: 'sep' }), timeEl, el('div', { class: 'sep' }),
    btn('Snapshot', { cls: 'sm', icon: 'snapshot' }, () => primary && snapshot(primary)),
    btn('Mark in', { cls: 'sm' }, () => { if (primary && primary.lastTime) { timeline.setMarks(primary.lastTime, timeline.markOut !== null && timeline.markOut > primary.lastTime ? timeline.markOut : null); } }),
    btn('Mark out', { cls: 'sm' }, () => { if (primary && primary.lastTime) { timeline.setMarks(timeline.markIn !== null && timeline.markIn < primary.lastTime ? timeline.markIn : null, primary.lastTime); } }),
    btn('Export clip', { cls: 'sm', icon: 'download' }, exportClip),
    el('div', { class: 'spacer' }),
    el('div', { class: 'legend' }, ...Object.entries({ Continuous: 'var(--timing)', Motion: 'var(--motion)', Alarm: 'var(--alarm)', Event: 'var(--event)', Bookmark: '#ffd54f' }).map(([k, v]) => el('span', {}, el('i', { style: { background: v } }), k))),
    el('div', { class: 'sep' }),
    btn('1', { cls: 'sm', title: 'Single camera' }, () => { layout = 1; renderLayout(); }),
    btn('4', { cls: 'sm', title: 'Four cameras (synchronous)' }, () => { layout = 4; renderLayout(); }),
    btn('', { cls: 'sm', icon: 'fullscreen' }, () => api('window:fullscreen')),
  );
  content.append(stage, exportBar, tlWrap, controls);
  calEl = el('div', { class: 'calendar' });
  side.append(el('div', { class: 'side-head' }, svg('clock'), 'Date'), calEl);
  container.append(side, content);

  timeline = new Timeline(canvas, { onSeek: (t) => seekAll(t), onRange: () => {} });
  timeline.setDay(day);
  tiles = [];
  renderLayout();
  renderCalendar();

  tree = createCameraTree(side, {
    activateLabel: 'Play back',
    onActivate: (cam) => { const t = (primary && !primary.cameraId) ? primary : tiles.slice(0, layout).find((x) => !x.cameraId) || primary || tiles[0]; assign(t, cam.id); setPrimary(t); loadDays(); },
    onSelect: () => {},
  });

  unsubs.push(on('export:progress', ({ id, progress }) => { if (id === exportId) exportBar.querySelector('i').style.width = Math.round(progress * 100) + '%'; }));
  unsubs.push(on('export:end', ({ id }) => { if (id === exportId) { exportBar.classList.add('hidden'); exportId = null; } }));
  const onKey = (e) => { if (e.target.matches('input, select, textarea')) return; if (e.code === 'Space') { e.preventDefault(); togglePlay(); } };
  document.addEventListener('keydown', onKey);
  unsubs.push(() => document.removeEventListener('keydown', onKey));

  if (p.cameraId) {
    const t = tiles[0];
    if (p.time) { day = startOfDay(p.time); calMonth = new Date(day); timeline.setDay(day); renderCalendar(); t.pendingTime = p.time; }
    assign(t, p.cameraId); setPrimary(t); loadDays();
  }
  setStatus('Remote Playback');
}

export function unmount() {
  if (tree) { tree.destroy(); tree = null; }
  for (const t of tiles) if (t.player) t.player.destroy();
  tiles = []; primary = null; playing = false;
  if (timeline) timeline.destroy();
  for (const u of unsubs) u();
  unsubs = [];
}
