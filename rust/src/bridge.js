// Recreates the Electron preload API (`window.vms`) on top of Tauri, so the renderer in src/renderer runs unchanged.
// Calls go through one Tauri command (`ipc`, dispatched by channel name in ipc.rs). Events and video arrive over one
// local WebSocket per window (Tauri events are JSON-only; video chunks are binary): text frames are `[channel, ...args]`,
// binary frames are `[idLength][stream id][fMP4 bytes]` for 'stream:data'.
(() => {
  if (window.vms) return;
  const T = () => window.__TAURI_INTERNALS__;
  const listeners = new Map();
  const fire = (channel, args) => {
    const set = listeners.get(channel);
    if (!set) return;
    for (const cb of [...set]) { try { cb(...args); } catch (e) { console.error(e); } }
  };
  // Electron rejected with an Error; Tauri rejects with the bare string the Rust side returned
  const call = (channel, args) => T().invoke('ipc', { channel, args }).catch((e) => { throw new Error(typeof e === 'string' ? e : (e && e.message) || String(e)); });
  const dec = new TextDecoder();

  let ready = null;
  function connect() {
    return call('app:hello', []).then(({ port, token }) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws.binaryType = 'arraybuffer';
      let ok = false;
      ws.onopen = () => ws.send(token);
      ws.onmessage = (m) => {
        if (typeof m.data === 'string') {
          const msg = JSON.parse(m.data);
          if (msg[0] === '__ready') { ok = true; resolve(); return; }
          fire(msg[0], msg.slice(1));
          return;
        }
        const buf = new Uint8Array(m.data);
        const n = buf[0];
        fire('stream:data', [dec.decode(buf.subarray(1, 1 + n)), buf.subarray(1 + n)]);
      };
      ws.onclose = () => {
        if (!ok) { reject(new Error('Event channel refused')); return; }
        ready = new Promise((r) => setTimeout(r, 1000)).then(connect);
      };
    }));
  }
  ready = connect();

  window.vms = {
    async invoke(channel, ...args) {
      await ready;
      return call(channel, args);
    },
    on(channel, cb) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(cb);
      return () => listeners.get(channel).delete(cb);
    },
    pathForFile(file) { return (file && file.path) || ''; },
    platform: '__PLATFORM__',
    versions: { electron: 'Tauri ' + '__TAURI_VERSION__', chrome: (/(?:Chrome|Edg|AppleWebKit)\/([\d.]+)/.exec(navigator.userAgent) || [])[1] || '', node: '-' },
  };

  // Electron moved the frameless window with -webkit-app-region; Tauri needs startDragging (title bar, not its buttons).
  const label = () => T().metadata.currentWindow.label;
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    const bar = e.target.closest && e.target.closest('#topbar');
    if (!bar || e.target.closest('button, input, select, a, nav button, .no-drag')) return;
    e.preventDefault();
    T().invoke('plugin:window|start_dragging', { label: label() }).catch(() => {});
  });
})();
