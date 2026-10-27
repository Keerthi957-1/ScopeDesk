'use strict';
/**
 * Safe loading of OPTIONAL compiled addons (robotjs, active-win, nut-js ...).
 *
 * A compiled addon is built for one exact Node / Electron ABI. After a Node or Electron upgrade it throws while loading
 * ("was compiled against a different Node.js version using NODE_MODULE_VERSION ...") and the whole process dies.
 *
 * Use it instead of a bare require():
 *
 *   const { loadNative } = require('./native-loader');
 *   const robot = loadNative('robotjs');        // module, or null when it is missing / disabled / broken
 *   if (robot) robot.moveMouse(10, 10); else useBuiltInInputExecutor();   // agent/input-executor.js needs no addon
 *
 * agent/host-launcher.js sets these variables for the agent process it starts:
 *   SCOPEDESK_NATIVE=off                    never load any addon
 *   SCOPEDESK_NATIVE_DISABLED=robotjs,...   never load these addons (found broken by the launcher's probe)
 */

function disabledSet(env) {
  const e = env || process.env;
  const set = new Set(String(e.SCOPEDESK_NATIVE_DISABLED || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (String(e.SCOPEDESK_NATIVE || '').toLowerCase() === 'off') set.add('*');
  return set;
}

function isDisabled(name, env) {
  const set = disabledSet(env);
  return set.has('*') || set.has(name);
}

/**
 * @param {string} name   package name
 * @param {{ env?: object, log?: Function, requireFn?: Function }} [options]
 * @returns {object|null}
 */
function loadNative(name, options = {}) {
  const log = options.log || (() => {});
  const requireFn = options.requireFn || require;
  if (isDisabled(name, options.env)) {
    log(`[native] ${name} is disabled; using the built-in fallback`);
    return null;
  }
  try {
    return requireFn(name);
  } catch (err) {
    const missing = err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`'${name}'`);
    log(missing ? `[native] ${name} is not installed; using the built-in fallback`
      : `[native] ${name} failed to load (${firstLine(err)}); using the built-in fallback`);
    return null;
  }
}

function firstLine(err) {
  return String((err && err.message) || err || '').split('\n')[0].slice(0, 300);
}

module.exports = { loadNative, isDisabled, disabledSet };
