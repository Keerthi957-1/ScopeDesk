'use strict';
// Stand-in for the active-win package (used by real-agent-harness.js). Returns whatever window the test put in front.
module.exports = async function activeWindow() {
  const w = global.__harnessForeground ? global.__harnessForeground() : null;
  if (w && w.error) throw new Error(w.error);
  return w;
};
