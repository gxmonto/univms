'use strict';
/*
 * LAN device discovery:
 *   - Hikvision SADP (UDP multicast 239.255.255.250:37020, XML Probe/ProbeMatch)
 *   - ONVIF WS-Discovery (UDP multicast 239.255.255.250:3702)
 *   - DW Spectrum / Nx servers (UDP broadcast on port 7001? Nx uses multicast 239.255.11.11:5007 "module information")
 */
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });

function localAddresses() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out.length ? out : ['0.0.0.0'];
}

function sadpProbe(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    const uuid = crypto.randomUUID().toUpperCase();
    const probe = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${uuid}</Uuid><Types>inquiry</Types></Probe>`);
    const handle = (msg, rinfo) => {
      try {
        const x = parser.parse(msg.toString('utf8'));
        const pm = x.ProbeMatch;
        if (!pm) return;
        const ip = pm.IPv4Address || rinfo.address;
        if (!found.has(ip)) {
          found.set(ip, {
            vendor: 'hikvision', source: 'SADP', ip, mac: pm.MAC, model: pm.DeviceDescription, deviceType: pm.DeviceType, serial: pm.DeviceSN,
            httpPort: Number(pm.HttpPort) || 80, commandPort: Number(pm.CommandPort) || 8000, firmware: pm.SoftwareVersion, activated: pm.Activated,
            dhcp: pm.DHCP, mask: pm.IPv4SubnetMask, gateway: pm.IPv4Gateway,
          });
        }
      } catch (_) {}
    };
    // Devices answer by multicast to 239.255.255.250:37020, so listen on that port on every interface.
    try {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => {});
      s.on('message', handle);
      s.bind(37020, () => {
        try { s.setBroadcast(true); s.setMulticastTTL(4); } catch (_) {}
        for (const addr of localAddresses()) {
          try { s.addMembership('239.255.255.250', addr === '0.0.0.0' ? undefined : addr); } catch (_) {}
        }
        const sendAll = () => {
          for (const addr of localAddresses()) {
            try { if (addr !== '0.0.0.0') s.setMulticastInterface(addr); s.send(probe, 37020, '239.255.255.250'); } catch (_) {}
          }
          try { s.send(probe, 37020, '255.255.255.255'); } catch (_) {}
        };
        sendAll();
        setTimeout(sendAll, 900);
      });
      sockets.push(s);
    } catch (_) {}
    setTimeout(() => {
      for (const s of sockets) try { s.close(); } catch (_) {}
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

function onvifProbe(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    const msgId = 'uuid:' + crypto.randomUUID();
    const probe = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
      `<e:Header><w:MessageID>${msgId}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action a:mustUnderstand="true" xmlns:a="http://www.w3.org/2003/05/soap-envelope">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>` +
      `<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`);
    const handle = (msg, rinfo) => {
      try {
        const x = parser.parse(msg.toString('utf8'));
        const body = (x.Envelope || {}).Body || {};
        const matches = body.ProbeMatches ? [].concat(body.ProbeMatches.ProbeMatch || []) : [];
        for (const m of matches) {
          const scopes = String(m.Scopes || '').split(/\s+/);
          const scope = (k) => { const s = scopes.find((v) => v.includes(`/${k}/`)); return s ? decodeURIComponent(s.split(`/${k}/`)[1]) : undefined; };
          const xaddr = String(m.XAddrs || '').split(/\s+/)[0] || '';
          const ipm = /\/\/([^:/]+)(?::(\d+))?/.exec(xaddr);
          const ip = (ipm && ipm[1]) || rinfo.address;
          if (!found.has(ip)) {
            found.set(ip, { vendor: 'onvif', source: 'ONVIF', ip, httpPort: (ipm && Number(ipm[2])) || 80, model: scope('hardware') || scope('model'), name: scope('name'), location: scope('location'), xaddr });
          }
        }
      } catch (_) {}
    };
    for (const addr of localAddresses()) {
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', () => {});
        s.on('message', handle);
        s.bind(0, addr === '0.0.0.0' ? undefined : addr, () => {
          try { s.setMulticastTTL(4); if (addr !== '0.0.0.0') s.setMulticastInterface(addr); } catch (_) {}
          s.send(probe, 3702, '239.255.255.250');
        });
        sockets.push(s);
      } catch (_) {}
    }
    setTimeout(() => {
      for (const s of sockets) try { s.close(); } catch (_) {}
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/** Nx/DW servers answer an HTTP GET /api/ping without auth. Scan candidates on port 7001 within local /24s. */
async function dwScan(timeoutMs = 2500) {
  const { rawRequest } = require('./httpclient');
  const found = [];
  const nets = new Set();
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal && a.netmask === '255.255.255.0') nets.add(a.address.split('.').slice(0, 3).join('.'));
  }
  const targets = [];
  for (const n of nets) for (let i = 1; i < 255; i++) targets.push(`${n}.${i}`);
  const batch = 64;
  for (let i = 0; i < targets.length; i += batch) {
    await Promise.all(targets.slice(i, i + batch).map(async (ip) => {
      try {
        const res = await rawRequest(`https://${ip}:7001/api/ping`, { timeout: timeoutMs });
        if (res.status === 200 && /reply/.test(res.text)) {
          let info = {};
          try { info = JSON.parse(res.text).reply || {}; } catch (_) {}
          found.push({ vendor: 'dwspectrum', source: 'DW/Nx ping', ip, httpPort: 7001, model: 'DW Spectrum server', name: info.systemName || info.name, firmware: info.version, serial: info.id });
        }
      } catch (_) {}
    }));
  }
  return found;
}

async function discover({ dw = false } = {}) {
  const sadp = true, onvif = true;
  const [a, b, c] = await Promise.all([sadp ? sadpProbe() : [], onvif ? onvifProbe() : [], dw ? dwScan() : []]);
  // Merge ONVIF info into SADP entries with the same IP
  const byIp = new Map();
  for (const d of [...a, ...c]) byIp.set(d.ip, d);
  for (const d of b) {
    const ex = byIp.get(d.ip);
    if (ex) { ex.onvif = d.xaddr; ex.name = ex.name || d.name; } else byIp.set(d.ip, d);
  }
  return [...byIp.values()].sort((x, y) => x.ip.split('.').map(Number).reduce((acc, v) => acc * 256 + v, 0) - y.ip.split('.').map(Number).reduce((acc, v) => acc * 256 + v, 0));
}

module.exports = { discover };
