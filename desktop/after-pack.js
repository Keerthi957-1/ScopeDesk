'use strict';
// electron-builder "afterPack" hook. Guarantees the host agent's packages (agent/node_modules) are INSIDE the built app,
// so the installed app works with no terminal and no "npm install" on the user's PC. If anything is missing the build FAILS here,
// instead of shipping an installer whose agent cannot start ("The module socket.io-client is not installed").
const fs = require('fs');
const path = require('path');

const REQUIRED = ['socket.io-client', 'active-win', path.join('@nut-tree-fork', 'nut-js')];

function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function missingIn(dir) {
  return REQUIRED.filter((m) => !fs.existsSync(path.join(dir, m, 'package.json')));
}

exports.default = async function afterPack(context) {
  const res = resourcesDir(context);
  const src = path.resolve(context.packager.projectDir, '..', 'agent', 'node_modules');
  const dest = path.join(res, 'agent', 'node_modules');

  if (missingIn(dest).length) {
    if (missingIn(src).length) {
      throw new Error('Cannot build: agent/node_modules is missing ' + missingIn(src).join(', ') + '. Run "npm run prepare:agent" in the desktop folder first.');
    }
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, {
      recursive: true,
      dereference: true,
      force: true,
      filter: (p) => !p.split(path.sep).includes('scopedesk-desktop') && path.basename(p) !== '.bin'
    });
  }

  const still = missingIn(dest);
  if (still.length) throw new Error('Built app is missing agent packages: ' + still.join(', ') + ' (looked in ' + dest + ')');
  console.log('afterPack OK: host agent packages are inside the app (' + dest + ')');
};
exports.missingIn = missingIn;
