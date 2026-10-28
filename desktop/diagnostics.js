'use strict';
// Builds the plain-text "diagnostics report" the Client can save from Help > Save diagnostics report and send to support.
// Pure function (no Electron, no disk access except through the injected helpers) so it can be tested.
// Tokens, keys and passwords never appear: log lines are scrubbed before they are written.

const SECRET_PATTERNS = [
  [/Bearer\s+[^\s"',;]+/gi, 'Bearer [hidden]'],                       // Authorization headers
  [/SCD-[A-Z0-9]{4}-[A-Z0-9]{4,}/gi, 'SCD-[token]'],              // task tokens
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[jwt]'],   // JSON web tokens
  [/(token|secret|password|credential|apikey|api_key|authorization)(["'=:\s]+)[^\s"',;]{4,}/gi, '$1$2[hidden]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[hex]']
];

function scrub(line) {
  let out = String(line == null ? '' : line);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out.slice(0, 400);
}

/**
 * @param {object} i
 * @param {string} i.appVersion
 * @param {object} i.versions            process.versions
 * @param {string} i.platform
 * @param {string} i.arch
 * @param {boolean} i.packaged
 * @param {string} i.serverUrl
 * @param {string} i.agentDir
 * @param {(p:string)=>boolean} i.exists          does this path exist?
 * @param {(m:string)=>boolean} i.canResolve      can this module be loaded from the agent folder?
 * @param {object} i.agentStatus         runner.status()
 * @param {string[]} i.agentLogs         runner.logs()
 * @param {string} i.lastDisplayDenial
 * @param {Date} [i.now]
 */
function buildReport(i) {
  const join = (...a) => a.join(i.platform === 'win32' ? '\\' : '/');
  const ok = (v) => (v ? 'OK' : 'MISSING');
  const files = ['client-agent.js', 'host-runtime.js', 'input-executor.js', 'package.json'];
  const modules = ['socket.io-client', 'active-win', '@nut-tree-fork/nut-js'];
  const st = i.agentStatus || {};
  const lines = [];
  lines.push('ScopeDesk diagnostics report');
  lines.push('Created: ' + (i.now || new Date()).toISOString());
  lines.push('');
  lines.push('App version: ' + (i.appVersion || 'unknown') + (i.packaged ? ' (installed build)' : ' (running from source)'));
  lines.push('Electron ' + ((i.versions && i.versions.electron) || '?') + ', Node ' + ((i.versions && i.versions.node) || '?') + ', ' + i.platform + ' ' + i.arch);
  lines.push('Server: ' + (i.serverUrl || '(none configured)'));
  lines.push('');
  lines.push('Host agent');
  lines.push('  Folder: ' + i.agentDir + '  [' + ok(i.exists(i.agentDir)) + ']');
  files.forEach((f) => lines.push('  ' + f + ': ' + ok(i.exists(join(i.agentDir, f)))));
  modules.forEach((m) => lines.push('  module ' + m + ': ' + ok(i.canResolve(m))));
  lines.push('  Status: phase=' + (st.phase || '?') + ', state=' + (st.uiState || '?') + ', task=' + (st.taskId == null ? '-' : st.taskId) + ', policy=' + (st.policy || '-'));
  if (st.detail) lines.push('  Detail: ' + scrub(st.detail));
  lines.push('');
  lines.push('Last screen-share refusal: ' + (i.lastDisplayDenial ? scrub(i.lastDisplayDenial) : '(none)'));
  lines.push('');
  lines.push('Host agent log (last 80 lines, secrets removed)');
  const tail = (i.agentLogs || []).slice(-80).map(scrub);
  lines.push(tail.length ? tail.map((l) => '  ' + l).join('\n') : '  (empty)');
  lines.push('');
  return lines.join('\n');
}

module.exports = { buildReport, scrub };
