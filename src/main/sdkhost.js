'use strict';
/*
 * Runs inside an Electron utilityProcess. Hosts the Hikvision SDK sessions (hiksdk.js) so their synchronous koffi
 * calls (login up to the connect timeout, config reads, stream setup) block this process instead of the main one —
 * the window showed "Not Responding" while a remote NVR was contacted. NET_DVR_GetLastError is thread-local, so the
 * calls cannot simply be made asynchronous; keeping them synchronous in one dedicated process keeps the error codes
 * (the lockout protection depends on them). A crash of the SDK takes this process down, not the app.
 *
 * Protocol (process.parentPort): request { id, op, cfg, args } -> { id, ok, result } | { id, ok: false, error }
 * events: { ev: 'data'|'end', h, buf } for stream handles, { ev: 'alarm', h, event } for alarm subscriptions.
 */
const sdk = require('./hiksdk');

const port = process.parentPort;
const handles = new Map(); // h -> { stop } | { close } | voice
let nextHandle = 1;
const post = (m) => { try { port.postMessage(m); } catch (_) {} };
const newHandle = (obj) => { const h = nextHandle++; handles.set(h, obj); return h; };

async function dispatch(op, cfg, args) {
  if (op === 'status') { if (sdk.available()) { try { sdk.ensureLoaded(); } catch (_) {} } return sdk.status(); }
  if (op === 'shutdown') { for (const x of handles.values()) { try { (x.stop || x.close).call(x); } catch (_) {} } handles.clear(); sdk.shutdown(); return true; }
  if (op === 'stop') { const x = handles.get(args[0]); handles.delete(args[0]); if (x) (x.stop || x.close).call(x); return true; }
  if (op === 'voiceSend') { const x = handles.get(args[0]); return x ? x.send(Buffer.from(args[1])) : false; }
  const s = sdk.HikSdkSession.get(cfg);
  switch (op) {
    case 'login': return s.login();
    case 'logout': s.logout(); return true;
    case 'isapi': return s.isapi(...args);
    case 'snapshot': return s.snapshot(...args);
    case 'deviceStreamKey': return s.deviceStreamKey();
    case 'setStreamKey': return s.setStreamKey(args[0] ? Buffer.from(args[0]) : null);
    case 'startLive': case 'startPlayback': {
      const h = nextHandle++;
      const src = await s[op](...args, (buf) => post({ ev: 'data', h, buf }));
      handles.set(h, src);
      return h;
    }
    case 'startVoice': {
      const h = nextHandle++;
      const v = await s.startVoice(args[0], (buf) => post({ ev: 'data', h, buf }));
      handles.set(h, v);
      const { send, stop, ...meta } = v;
      return { h, ...meta };
    }
    case 'subscribeAlarms': {
      const h = nextHandle++;
      handles.set(h, await s.subscribeAlarms((event) => post({ ev: 'alarm', h, event })));
      return h;
    }
    default: throw new Error('unknown SDK op ' + op);
  }
}

port.on('message', async (e) => {
  const { id, op, cfg, args = [] } = e.data;
  try { post({ id, ok: true, result: await dispatch(op, cfg, args) }); }
  catch (err) { post({ id, ok: false, error: { message: err.message, sdkCode: err.sdkCode, authFailure: !!err.authFailure } }); }
});
void newHandle;
