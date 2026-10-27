'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const afterPack = require('../after-pack.js');

function mk(base, mods) {
  for (const m of mods) { const d = path.join(base, m); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'package.json'), '{}'); }
}

test('copies agent node_modules into the app and passes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ap-'));
  const projectDir = path.join(root, 'desktop'); fs.mkdirSync(projectDir);
  mk(path.join(root, 'agent', 'node_modules'), ['socket.io-client', 'active-win', '@nut-tree-fork/nut-js']);
  const appOutDir = path.join(root, 'out'); fs.mkdirSync(path.join(appOutDir, 'resources'), { recursive: true });
  await afterPack.default({ electronPlatformName: 'win32', appOutDir, packager: { projectDir, appInfo: { productFilename: 'ScopeDesk' } } });
  assert.deepStrictEqual(afterPack.missingIn(path.join(appOutDir, 'resources', 'agent', 'node_modules')), []);
});

test('fails the build when agent packages are missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ap-'));
  const projectDir = path.join(root, 'desktop'); fs.mkdirSync(projectDir);
  fs.mkdirSync(path.join(root, 'agent', 'node_modules'), { recursive: true });
  const appOutDir = path.join(root, 'out'); fs.mkdirSync(path.join(appOutDir, 'resources'), { recursive: true });
  await assert.rejects(afterPack.default({ electronPlatformName: 'win32', appOutDir, packager: { projectDir, appInfo: { productFilename: 'ScopeDesk' } } }), /prepare:agent/);
});
