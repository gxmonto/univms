'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_PREFIXES = ['app:', 'devices:', 'cameras:', 'discovery:', 'stream:', 'playback:', 'ptz:', 'views:', 'groups:', 'maps:', 'files:', 'settings:', 'events:', 'users:', 'export:', 'record:', 'log:', 'config:', 'window:', 'dw:', 'updates:'];
const EVENT_CHANNELS = ['stream:data', 'stream:end', 'events:new', 'events:acked', 'events:cleared', 'devices:status', 'record:end', 'export:progress', 'export:end', 'app:navigate', 'app:fullscreen', 'devices:changed', 'views:changed', 'updates:status', 'window:state'];

contextBridge.exposeInMainWorld('vms', {
  invoke(channel, ...args) {
    if (!INVOKE_PREFIXES.some((p) => channel.startsWith(p))) return Promise.reject(new Error('Blocked channel ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, cb) {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error('Blocked event channel ' + channel);
    const handler = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch (_) { return file.path; }
  },
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
});
