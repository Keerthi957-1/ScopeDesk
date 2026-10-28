'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildReport, scrub } = require('../diagnostics');

test('every local file main.js (and the files it loads) requires is listed in the installer "files", so the packaged app can start', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const listed = new Set(pkg.build.files);
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const m of src.matchAll(/require\('\.\/([\w.-]+)'\)/g)) {
      const dep = m[1].endsWith('.js') || m[1].endsWith('.json') ? m[1] : m[1] + '.js';
      assert.ok(listed.has(dep), `${dep} is required by ${file} but missing from build.files in desktop/package.json`);
      if (dep.endsWith('.js')) walk(dep);
    }
  };
  walk('main.js'); walk('preload.js');
});

test('diagnostics report: shows what is installed, the agent state and a scrubbed log', () => {
  const text = buildReport({
    appVersion: '1.2.3', versions: { electron: '37', node: '22' }, platform: 'win32', arch: 'x64', packaged: true,
    serverUrl: 'https://example.up.railway.app', agentDir: 'C:\\App\\resources\\agent',
    exists: (p) => !/input-executor/.test(p), canResolve: (m) => m !== 'socket.io-client',
    agentStatus: { phase: 'error', uiState: 'error', taskId: 4, detail: 'token=abcd1234efgh used' },
    agentLogs: ['[AGENT] connecting with SCD-8377-EBFA8F', 'Authorization: Bearer abcdef123456', 'plain line'],
    lastDisplayDenial: 'error: boom', now: new Date('2026-10-29T10:00:00Z')
  });
  assert.match(text, /module socket\.io-client: MISSING/);
  assert.match(text, /module active-win: OK/);
  assert.match(text, /input-executor\.js: MISSING/);
  assert.match(text, /phase=error/);
  assert.match(text, /Last screen-share refusal: error: boom/);
  assert.ok(!/EBFA8F|abcdef123456|abcd1234efgh/.test(text), 'secrets must not appear');
  assert.match(text, /plain line/);
  assert.equal(scrub(undefined), '');
});
