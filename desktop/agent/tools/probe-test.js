'use strict';
// Run this BEFORE a real session:   cd agent && npm run probe
// Open Explorer, move between folders and apps, and watch what the agent would see. Ctrl+C to stop.
// Pass a task type to test your policy:   TASK_TYPE=Billing TARGET=billing.exe npm run probe
const { ForegroundMonitor } = require('../monitor');
const { loadPolicy } = require('../policy');
const { createPathProbe } = require('../path-probe');
const log = (l, m) => console.log(`[${l}] ${m}`);
const policy = loadPolicy({ taskType: process.env.TASK_TYPE, targetProcess: process.env.TARGET || 'explorer.exe', sessionConfigFile: process.env.SESSION_CONFIG, log });
const probe = createPathProbe(log);
console.log(`Policy: ${policy.name} | apps: ${policy.appList.join(', ')} | folders: ${policy.allowedPaths.join(' | ') || '(any)'}`);
const m = new ForegroundMonitor({ policy, probe, pollMs: 500, strikes: 1, attributionMs: 0, onViolation() {}, onState() {}, log, debug: true });
m.start().then(() => console.log('Watching the foreground window... (Ctrl+C to stop)'));
process.on('SIGINT', () => { m.stop(); process.exit(0); });
