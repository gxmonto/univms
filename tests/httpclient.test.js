'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { request, parseAuthHeader } = require('../src/main/httpclient');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function digestServer({ user = 'admin', pass = 'secret', realm = 'TestRealm' } = {}) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const srv = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    const ok = (() => {
      if (!auth || !auth.startsWith('Digest')) return false;
      const p = parseAuthHeader(auth);
      const ha1 = md5(`${user}:${realm}:${pass}`), ha2 = md5(`${req.method}:${p.uri}`);
      const expected = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
      return p.username === user && p.response === expected && p.nonce === nonce;
    })();
    if (!ok) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="abc"` });
      return res.end('unauthorized');
    }
    if (req.url === '/echo') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`${req.method}:${b}`); }); return; }
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<ok>yes</ok>');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

test('digest auth handshake succeeds and caches challenge', async () => {
  const { srv, port } = await digestServer();
  try {
    const auth = { type: 'digest', username: 'admin', password: 'secret' };
    const r1 = await request(`http://127.0.0.1:${port}/ISAPI/System/deviceInfo`, { auth });
    assert.strictEqual(r1.status, 200);
    assert.match(r1.text, /<ok>/);
    const r2 = await request(`http://127.0.0.1:${port}/echo`, { auth, method: 'PUT', body: '<x/>' });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.text, 'PUT:<x/>');
  } finally { srv.close(); }
});

test('wrong password yields 401', async () => {
  const { srv, port } = await digestServer();
  try {
    const r = await request(`http://127.0.0.1:${port}/x`, { auth: { type: 'digest', username: 'admin', password: 'nope' } });
    assert.strictEqual(r.status, 401);
  } finally { srv.close(); }
});

test('parseAuthHeader handles quoted and unquoted params', () => {
  const p = parseAuthHeader('Digest realm="R", nonce="n1", qop="auth,auth-int", algorithm=MD5, stale=false');
  assert.deepStrictEqual(p, { realm: 'R', nonce: 'n1', qop: 'auth,auth-int', algorithm: 'MD5', stale: 'false' });
});
