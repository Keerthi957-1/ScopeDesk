'use strict';
// Runs after "npm run prepare:agent": stops the build early (instead of shipping an app whose agent cannot start)
// when a module the host agent needs is missing from ../agent/node_modules.
const path = require('path');
const agentDir = path.join(__dirname, '..', 'agent');
const fs = require('fs');
// A link back to the desktop folder inside agent/node_modules makes the packaging step copy desktop/ into itself forever
// (Windows: "The data present in the reparse point buffer is invalid"). Remove it if anything created one.
const loop = path.join(agentDir, 'node_modules', 'scopedesk-desktop');
try {
  if (fs.lstatSync(loop)) {
    try { fs.unlinkSync(loop); } catch (_) { fs.rmdirSync(loop); }
    console.log('Removed the stray link agent/node_modules/scopedesk-desktop');
  }
} catch (_) { /* not present: good */ }
const needed = ['socket.io-client', 'active-win', '@nut-tree-fork/nut-js'];
const missing = [];
for (const m of needed) {
  try { require.resolve(m, { paths: [agentDir] }); } catch (_) { missing.push(m); }
}
if (missing.length) {
  console.error('Agent dependencies missing: ' + missing.join(', ') + '\nRun: npm --prefix ../agent install --omit=dev');
  process.exit(1);
}
console.log('Agent dependencies OK: ' + needed.join(', '));
