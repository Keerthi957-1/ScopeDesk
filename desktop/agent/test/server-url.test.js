'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeServerUrl } = require('../server-url');

test('accepts the live https address, dropping slash, path and query', () => {
  assert.deepStrictEqual(normalizeServerUrl('https://app.up.railway.app'), { ok: true, url: 'https://app.up.railway.app' });
  assert.strictEqual(normalizeServerUrl('https://app.up.railway.app/').url, 'https://app.up.railway.app');
  assert.strictEqual(normalizeServerUrl('  https://app.up.railway.app/index.html?x=1 ').url, 'https://app.up.railway.app');
});

test('refuses plain http to a remote host (token and sign-in would be readable)', () => {
  const r = normalizeServerUrl('http://app.up.railway.app');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /https/);
});

test('allows http only for a server on this same computer (development)', () => {
  assert.strictEqual(normalizeServerUrl('http://localhost:3000').ok, true);
  assert.strictEqual(normalizeServerUrl('http://127.0.0.1:3000/').url, 'http://127.0.0.1:3000');
});

test('rejects empty, malformed and non-web addresses', () => {
  for (const bad of ['', '   ', null, undefined, 'not a url', 'app.up.railway.app', 'ftp://x.example']) {
    assert.strictEqual(normalizeServerUrl(bad).ok, false, String(bad));
  }
});
