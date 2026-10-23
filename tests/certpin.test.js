// HTTPS trust on first use: a changed certificate fails before any request byte reaches the server
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('../src/main/httpclient');

const tlsFix = (n) => ({ key: fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', `${n}.key`)), cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', `${n}.crt`)) });
const serve = (cert, port = 0) => new Promise((resolve) => {
  const s = https.createServer(cert, (req, res) => { s.hits++; res.end('ok'); }); s.hits = 0;
  s.listen(port, '127.0.0.1', () => resolve(s));
});

test('certificate pinning: first certificate remembered, a different one refused before sending anything', async () => {
  const pins = new Map();
  http.setCertPins({ get: (k) => pins.get(k), set: (k, v) => pins.set(k, v) });
  let a = await serve(tlsFix('a'));
  const port = a.address().port; const url = `https://127.0.0.1:${port}/x`;
  try {
    const r1 = await http.request(url, { auth: { type: 'basic', username: 'u', password: 'secret' } });
    assert.strictEqual(r1.status, 200);
    assert.ok(pins.get(`127.0.0.1:${port}`), 'pinned on first use');
    assert.strictEqual((await http.request(url)).status, 200, 'same certificate keeps working');
    await new Promise((r) => a.close(r));

    const b = await serve(tlsFix('b'), port); a = b; // same host:port, different certificate
    await assert.rejects(http.request(url, { auth: { type: 'basic', username: 'u', password: 'secret' } }), (e) => e.certChanged === `127.0.0.1:${port}` && /certificate .* changed/.test(e.message));
    assert.strictEqual(b.hits, 0, 'no request (and no password) reached the server with the new certificate');
    // streaming requests (event streams) are checked the same way
    const { response } = http.streamRequest(url, {});
    await assert.rejects(response, (e) => !!e.certChanged);

    pins.delete(`127.0.0.1:${port}`); // "Trust new certificate"
    assert.strictEqual((await http.request(url)).status, 200);
    assert.strictEqual(b.hits, 1);
  } finally { http.setCertPins(null); await new Promise((r) => a.close(r)); }
});
