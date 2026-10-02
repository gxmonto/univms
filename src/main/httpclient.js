'use strict';
/*
 * Minimal HTTP(S) client with Digest / Basic / Bearer auth, self-signed TLS tolerance,
 * timeouts and optional streaming responses. No external dependencies.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
// host:port -> cached digest challenge (saves a round-trip on every request)
const challenges = new Map();

function parseAuthHeader(header) {
  const out = {};
  const s = header.replace(/^\s*Digest\s+/i, '');
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : m[3]).trim();
  return out;
}

function digestAuthorization(ch, method, uri, username, password) {
  ch.nc = (ch.nc || 0) + 1;
  const nc = ch.nc.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const algorithm = (ch.algorithm || 'MD5').toUpperCase();
  let ha1 = md5(`${username}:${ch.realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  let qop = null;
  if (ch.qop) {
    const qops = ch.qop.split(',').map((x) => x.trim());
    qop = qops.includes('auth') ? 'auth' : qops[0];
  }
  const response = qop
    ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${ch.nonce}:${ha2}`);
  let h = `Digest username="${username}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (ch.opaque) h += `, opaque="${ch.opaque}"`;
  if (ch.algorithm) h += `, algorithm=${ch.algorithm}`;
  return h;
}

function rawRequest(urlStr, { method = 'GET', headers = {}, body, timeout = 15000, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'UniVMS/1.0', Accept: '*/*', Connection: 'close', ...headers },
      rejectUnauthorized: false,
      timeout,
    };
    if (body !== undefined && body !== null) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      opts.headers['Content-Length'] = buf.length;
      body = buf;
    }
    const req = lib.request(opts, (res) => {
      if (stream) return resolve({ status: res.statusCode, headers: res.headers, stream: res, request: req });
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          get text() { return buffer.toString('utf8'); },
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeout} ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * request(url, options)
 *  options.auth = { type: 'digest'|'basic'|'bearer'|'none', username, password, token }
 *  options.stream = true -> resolves with { status, headers, stream }
 */
async function request(urlStr, options = {}) {
  const { auth, ...rest } = options;
  const method = (rest.method || 'GET').toUpperCase();
  const headers = { ...(rest.headers || {}) };
  const u = new URL(urlStr);
  const key = `${u.protocol}//${u.host}`;
  const uri = u.pathname + u.search;

  if (auth && auth.type === 'basic') {
    headers.Authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  } else if (auth && auth.type === 'bearer') {
    headers.Authorization = `Bearer ${auth.token}`;
  } else if (auth && auth.type === 'digest') {
    const ch = challenges.get(key);
    if (ch) headers.Authorization = digestAuthorization(ch, method, uri, auth.username, auth.password);
  }

  let res = await rawRequest(urlStr, { ...rest, method, headers });

  if (res.status === 401 && auth && (auth.type === 'digest' || auth.type === 'auto')) {
    const www = [].concat(res.headers['www-authenticate'] || []).join(', ');
    if (res.stream) res.stream.resume();
    if (/digest/i.test(www)) {
      const ch = parseAuthHeader(www.split(/,(?=\s*Basic)/i).find((p) => /digest/i.test(p)) || www);
      ch.nc = 0;
      challenges.set(key, ch);
      headers.Authorization = digestAuthorization(ch, method, uri, auth.username, auth.password);
      res = await rawRequest(urlStr, { ...rest, method, headers });
      if (res.status === 401 && /stale=true/i.test([].concat(res.headers['www-authenticate'] || []).join(','))) {
        if (res.stream) res.stream.resume();
        const ch2 = parseAuthHeader([].concat(res.headers['www-authenticate']).join(', '));
        ch2.nc = 0;
        challenges.set(key, ch2);
        headers.Authorization = digestAuthorization(ch2, method, uri, auth.username, auth.password);
        res = await rawRequest(urlStr, { ...rest, method, headers });
      }
    } else if (/basic/i.test(www)) {
      headers.Authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      res = await rawRequest(urlStr, { ...rest, method, headers });
    }
  }
  return res;
}

class HttpError extends Error {
  constructor(status, text, url) {
    const lock = /<lockStatus>\s*lock/i.test(text || '') ? (/<unlockTime>(\d+)<\/unlockTime>/.exec(text || '') || [])[1] : null;
    const plain = text && !/^\s*</.test(text) ? String(text).slice(0, 160) : '';
    super(status === 401
      ? `Login rejected by the device (401${plain ? ': ' + plain : ''})${lock ? ` — account locked for ${Math.ceil(Number(lock) / 60)} more minute(s) after repeated failed logins` : ''}. Check the username and password.`
      : `HTTP ${status}${text ? ': ' + text.slice(0, 300) : ''}`);
    this.status = status;
    this.url = url;
    this.authFailure = status === 401 || status === 403;
    this.lockedSeconds = lock ? Number(lock) : null;
  }
}

/**
 * Long-lived request whose body is written by the caller (e.g. Hikvision two-way audio PUT audioData).
 * Digest: uses the challenge cached by an earlier request to the same host (callers do a normal request first).
 * Resolves immediately with { req, response } where response is a promise of the IncomingMessage.
 */
function streamRequest(urlStr, { method = 'PUT', headers = {}, auth, timeout = 0 } = {}) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  const key = `${u.protocol}//${u.host}`;
  const uri = u.pathname + u.search;
  const h = { 'User-Agent': 'UniVMS/1.0', Accept: '*/*', Connection: 'close', ...headers };
  if (auth && auth.type === 'basic') h.Authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  else if (auth && auth.type === 'bearer') h.Authorization = `Bearer ${auth.token}`;
  else if (auth && auth.type === 'digest') {
    const ch = challenges.get(key);
    if (ch) h.Authorization = digestAuthorization(ch, method, uri, auth.username, auth.password);
  }
  const req = lib.request({ method, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: uri, headers: h, rejectUnauthorized: false, timeout });
  const response = new Promise((resolve, reject) => { req.on('response', resolve); req.on('error', reject); });
  return { req, response };
}

module.exports = { request, rawRequest, streamRequest, HttpError, parseAuthHeader, digestAuthorization, _challenges: challenges };
