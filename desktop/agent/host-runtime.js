'use strict';
/**
 * Everything that runs on the Client's PC during one approved session, wired together:
 *
 *   vendor browser --RTCDataChannel--> handleChannelMessage()
 *        1. sandbox-guard.handlePayload()   zero-trust check (apps, folders, size, JSON)
 *        2. parseInputMessage()             strict protocol check
 *        3. input-executor.execute()        real mouse / keyboard input (blocked shortcuts dropped)
 *
 *   foreground-monitor (whole time window) --breach--> the same lockdown the guard uses:
 *        1. closeConnections()   stop EVERY screen-share track and close every RTCPeerConnection / RTCDataChannel
 *        2. lock the workstation + onLockdown() so the Client sees the full-screen alert and a persistent notification
 *        3. reportViolation()    "host-violation" to the server, which ends the task, kills the vendor's session and timers
 *
 * Nothing here trusts the vendor: scope comes from GET /api/agent/scope (the task row), never from the data channel.
 */

const { createSandboxGuard } = require('./sandbox-guard');
const { createInputExecutor } = require('./input-executor');
const { createForegroundMonitor } = require('./foreground-monitor');

/**
 * @param {object} cfg
 * @param {{ taskId:number, allowedApps:string[], allowedPaths:string[], endsAt:number }} cfg.scope
 * @param {() => (void|Promise<void>)} cfg.closeConnections   stops all video tracks and closes all peers (renderer side)
 * @param {(v:object) => Promise<any>} cfg.reportViolation    usually (v) => socket.emitWithAck('host-violation', v)
 * @param {(v:object, result:object) => void} [cfg.onLockdown] show the local alert (full-screen overlay + system notification)
 * @param {() => Promise<void>} [cfg.lockWorkstation]
 */
function createHostRuntime(cfg) {
  const scope = cfg.scope || {};
  const log = cfg.log || (() => {});
  const platform = cfg.platform || process.platform;

  const executor = cfg.executor || createInputExecutor({ platform, env: cfg.env, log, spawn: cfg.spawn, execFile: cfg.execFile, onDropped: (why) => log('[input] dropped: ' + why) });
  let monitor = null;
  let lockdownResult = null;

  const guard = createSandboxGuard({
    taskId: scope.taskId,
    allowedApps: scope.allowedApps || [],
    allowedPaths: scope.allowedPaths || [],
    platform,
    env: cfg.env,
    exec: cfg.exec,
    realpath: cfg.realpath,
    log,
    lockWorkstation: cfg.lockWorkstation,
    // Step 1 of the breach sequence. Input stops first, so nothing more can be done while the connections are being torn down.
    closeConnections: async () => {
      executor.close();
      if (monitor) monitor.stop();
      await cfg.closeConnections();
    },
    reportViolation: cfg.reportViolation
  });

  async function lockdown(violation) {
    if (lockdownResult) return lockdownResult;
    lockdownResult = guard.lockdown(violation);
    const result = await lockdownResult;
    try { if (cfg.onLockdown) cfg.onLockdown(violation, result); } catch (err) { log('[runtime] onLockdown failed: ' + err.message); }
    return result;
  }

  monitor = createForegroundMonitor({
    allowedApps: scope.allowedApps || [],
    allowedPaths: scope.allowedPaths || [],
    realpath: cfg.realpath,
    endsAt: scope.endsAt,
    platform,
    env: cfg.env,
    log,
    spawn: cfg.spawn,
    execFile: cfg.execFile,
    source: cfg.monitorSource,
    confirmMs: cfg.confirmMs,
    getLastInputAt: () => executor.lastInputAt(),
    onBreach: (violation) => lockdown(violation)
  });

  return {
    guard,
    executor,
    monitor,
    start() { monitor.start(); },
    /** Normal end of the session (time up, terminated, vendor finished): release input and stop watching. */
    stop() { monitor.stop(); executor.close(); },
    isLockedDown: () => guard.isLockedDown(),
    /** Call with every message that arrives on the vendor's data channels. */
    async handleChannelMessage(raw) {
      const checked = await guard.handlePayload(raw);
      if (checked.breach) {
        // handlePayload already ran the lockdown; make sure the local alert is shown too
        if (!lockdownResult) lockdownResult = Promise.resolve(checked.lockdown);
        try { if (cfg.onLockdown) cfg.onLockdown((checked.lockdown && checked.lockdown.violation) || { kind: checked.kind }, checked.lockdown); } catch (err) { log('[runtime] onLockdown failed: ' + err.message); }
        return { ok: false, breach: true };
      }
      if (!checked.ok) return { ok: false, reason: checked.reason };
      return executor.execute(checked.payload);
    }
  };
}

module.exports = { createHostRuntime };
