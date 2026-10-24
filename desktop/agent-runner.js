'use strict';
// Starts and stops the host agent (agent/client-agent.js) as a hidden background process.
// The Client never sees a terminal: the agent is forked with windowsHide and talks to this module over IPC.
// The token reaches the agent through its environment (not the command line, which other programs can list).
const path = require('path');
const { fork } = require('child_process');

function createAgentRunner({ agentDir, serverUrl, forkFn = fork, execPath = process.execPath, onStatus = () => {}, log = () => {} }) {
  let child = null;
  let status = { phase: 'stopped', uiState: 'offline', taskId: null, policy: '', detail: '' };
  const tail = [];

  function set(patch) { status = { ...status, ...patch }; onStatus({ ...status }); }
  function remember(line) { tail.push(line); if (tail.length > 200) tail.shift(); log(line); }

  function start({ taskId, token, viewOnly = false }) {
    if (child) stop('restart');
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SERVER_URL: serverUrl,
      SCOPEDESK_AGENT_TOKEN: token,
      VIEW_ONLY: viewOnly ? 'true' : 'false'
    };
    let c;
    try {
      c = forkFn(path.join(agentDir, 'client-agent.js'), [], { cwd: agentDir, env, execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (e) {
      set({ phase: 'error', uiState: 'error', taskId, detail: e.message });
      return { ok: false, error: 'Could not start the host agent: ' + e.message };
    }
    child = c;
    set({ phase: 'starting', uiState: 'starting', taskId, policy: '', detail: '' });

    const pipeLines = (stream) => stream && stream.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach(remember));
    pipeLines(c.stdout); pipeLines(c.stderr);

    c.on('message', (m) => {
      if (c !== child || !m || typeof m !== 'object') return;
      if (m.type === 'connected') set({ phase: 'connected', uiState: 'waiting' });
      else if (m.type === 'state') set({ phase: 'running', uiState: String(m.state), policy: String(m.policy || '') });
      else if (m.type === 'violation') set({ detail: `Scope violation (${m.kind}): ${m.processName || 'unknown app'}` });
      else if (m.type === 'ended') set({ detail: String(m.reason || '') });
    });
    c.on('error', (e) => { if (c !== child) return; child = null; set({ phase: 'error', uiState: 'error', detail: e.message }); });
    c.on('exit', (code) => {
      if (c !== child) return;
      child = null;
      if (code === 0) set({ phase: 'stopped', uiState: 'offline' });
      else set({ phase: 'error', uiState: 'error', detail: tail[tail.length - 1] || `The host agent stopped (code ${code}).` });
    });
    return { ok: true };
  }

  function stop(reason = 'stopped') {
    const c = child;
    if (!c) return { ok: true };
    child = null;
    try { c.send({ type: 'stop' }); } catch (_) { /* already gone */ }   // lets the agent release held keys and buttons
    const killer = setTimeout(() => { try { c.kill(); } catch (_) { /* ignore */ } }, 1500);
    if (killer.unref) killer.unref();
    c.once('exit', () => clearTimeout(killer));
    set({ phase: 'stopped', uiState: 'offline', detail: reason === 'restart' ? '' : status.detail });
    return { ok: true };
  }

  return { start, stop, status: () => ({ ...status }), logs: () => tail.slice() };
}

module.exports = { createAgentRunner };
