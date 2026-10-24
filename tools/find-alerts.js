// Finds native popups and the old "is running" messages in any ScopeDesk folder.
//   node tools/find-alerts.js                      scans ./public
//   node tools/find-alerts.js "C:\path\to\folder"  scans another copy (e.g. the folder Live Server is serving)
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const PATTERNS = [[/\b(alert|prompt)\s*\(/, 'native popup'], [/webrtc\.js is running/i, 'old WebRTC popup text'], [/server is not running/i, 'old orange banner text']];
let hits = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!/\.(js|html|htm)$/i.test(e.name)) continue;
    fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const [re, why] of PATTERNS) if (re.test(line)) { hits++; console.log(`${full}:${i + 1}  [${why}]  ${line.trim().slice(0, 140)}`); break; }
    });
  }
})(root);
console.log(hits ? `\n${hits} match(es) in ${root}` : `No matches in ${root}`);
