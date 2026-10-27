'use strict';
// Server-side view of the task-type policies, used to check a support ticket WHEN IT IS CREATED, so a typo is reported in
// the form instead of surfacing later as a surprise violation.
//
// The policy file lives on the Client's host machine (agent/policies.json) and the AGENT is what enforces it. This module only
// reads it when the file is reachable from the server: same machine / same project folder (the default path below), or
// POLICY_FILE=/path/to/policies.json in .env. When it is not reachable, validation is skipped and the agent still decides.
const fs = require('fs');
const path = require('path');

// Same rule as normalizeKey() in agent/policy.js. Keep them in sync.
const normalizeKey = (s) => String(s == null ? '' : s).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function read() {
  const file = process.env.POLICY_FILE || path.join(__dirname, '..', 'agent', 'policies.json');
  try {
    const defs = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.keys(defs).filter((k) => !k.startsWith('_'));
  } catch (_) {
    return null; // not reachable from here
  }
}

// Read on every call: the file is tiny and editing it must not need a server restart
function listTypes() { return read(); }

// -> { validated, canonical, available }
//    canonical = the name exactly as written in policies.json ("Billing"), whatever case the user typed
function resolveTaskType(input) {
  const typed = String(input || '').trim();
  const names = read();
  if (!names) return { validated: false, canonical: typed, available: [] };
  if (!typed) return { validated: true, canonical: '', available: names };
  const hit = names.find((n) => normalizeKey(n) === normalizeKey(typed));
  return { validated: true, canonical: hit || null, available: names };
}

module.exports = { normalizeKey, listTypes, resolveTaskType };
