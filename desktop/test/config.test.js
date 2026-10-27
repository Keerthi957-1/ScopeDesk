const test = require('node:test');
const assert = require('node:assert');
const { resolveServerUrl } = require('../config');
const file = (url) => () => JSON.stringify({ serverUrl: url });

test('uses the Railway address from app-config.json', () => {
  assert.deepStrictEqual(resolveServerUrl({ env: {}, readConfigFile: file('https://scopedesk.up.railway.app/') }), { url: 'https://scopedesk.up.railway.app', error: null });
});
test('the environment variable wins over the file', () => {
  assert.strictEqual(resolveServerUrl({ env: { SCOPEDESK_SERVER_URL: 'https://staging.example.com' }, readConfigFile: file('https://prod.example.com') }).url, 'https://staging.example.com');
});
test('an empty or unreadable config gives a clear error, never a localhost guess', () => {
  assert.match(resolveServerUrl({ env: {}, readConfigFile: file('') }).error, /No server address/);
  assert.match(resolveServerUrl({ env: {}, readConfigFile: () => { throw new Error('missing'); } }).error, /No server address/);
});
test('plain http is refused except for localhost', () => {
  assert.match(resolveServerUrl({ env: {}, readConfigFile: file('http://scopedesk.example.com') }).error, /https/);
  assert.strictEqual(resolveServerUrl({ env: { SCOPEDESK_SERVER_URL: 'http://localhost:3000' }, readConfigFile: file('') }).url, 'http://localhost:3000');
});
test('garbage is rejected', () => {
  assert.match(resolveServerUrl({ env: {}, readConfigFile: file('not a url') }).error, /not a valid/);
});
