// Floating "talking to <device>" bar for device-level two-way audio (speakers on the NVR), like iVMS'
// "Start Two-way Audio" on a recorder.
import { el, svg, toast } from './core.js';
import { TalkSession } from './talk.js';

let bar = null, session = null;

export async function talkToDevice(dev) {
  if (session) await stop();
  const id = `dev:${dev.id}`;
  const status = el('span', { class: 'dim small' }, 'connecting…');
  bar = el('div', { class: 'talk-bar' }, svg('mic'), el('strong', {}, `Talking to ${dev.name}`), status, el('button', { class: 'btn sm danger', onClick: () => stop() }, svg('stop'), 'Stop'));
  document.body.append(bar);
  session = new TalkSession(id, { onStatus: (s, d) => {
    if (s === 'idle' || s === 'ended') { if (s === 'ended' && d) toast('Two-way audio ended: ' + d, 'warn'); remove(); }
    else status.textContent = s === 'talking' ? d : s;
  } });
  try { await session.start(); }
  catch (e) { toast('Two-way audio: ' + e.message, 'err', 6000); remove(); }
}

async function stop() { const s = session; session = null; if (s) await s.stop(); remove(); }
function remove() { if (bar) { bar.remove(); bar = null; } session = null; }
