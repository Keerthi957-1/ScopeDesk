'use strict';
// cd agent && npm test     (Node 18+, no extra packages)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPolicy } = require('./../policy');

const logs = [];
const log = (l, m) => logs.push(`${l}: ${m}`);
const file = path.join(os.tmpdir(), `scopedesk-policies-${process.pid}.json`);
fs.writeFileSync(file, JSON.stringify({ Billing: { allowedApps: ['explorer.exe', 'excel.exe'], allowedPaths: ['C:\\BillingData'] } }));
test.after(() => fs.rmSync(file, { force: true }));

test('task type only: unchanged behaviour', () => {
  const p = loadPolicy({ taskType: 'billing', targetProcess: 'billing.exe', file, log });
  assert.equal(p.name, 'Billing');
  assert.ok(p.pathAllowed('C:\\BillingData\\2026'));
  assert.ok(!p.pathAllowed('C:\\Other'));
});

test('custom task: no type, own folders and apps', () => {
  const p = loadPolicy({ taskType: '', targetProcess: 'payroll.exe', extra: { allowedPaths: ['C:\\Clients\\Acme'], allowedApps: ['notepad.exe'] }, file, log });
  assert.equal(p.name, 'Custom');
  assert.ok(p.apps.has('payroll') && p.apps.has('notepad'));
  assert.ok(p.apps.has('explorer'), 'file manager is allowed automatically when folders are given');
  assert.ok(p.pathAllowed('C:\\clients\\acme\\2026'));
  assert.ok(!p.pathAllowed('C:\\Clients\\AcmeEvil'));
  assert.ok(!p.pathAllowed('C:\\Users'));
});

test('type + custom folders are combined', () => {
  const p = loadPolicy({ taskType: 'Billing', targetProcess: 'billing.exe', extra: { allowedPaths: ['D:\\Extra'], allowedApps: [] }, file, log });
  assert.equal(p.name, 'Billing (custom)');
  assert.ok(p.pathAllowed('C:\\BillingData') && p.pathAllowed('D:\\Extra\\x'));
});

test('custom apps only: no folder policy, file manager stays out of scope', () => {
  const p = loadPolicy({ taskType: '', targetProcess: 'tool.exe', extra: { allowedPaths: [], allowedApps: ['calc.exe'] }, file, log });
  assert.ok(p.apps.has('calc') && !p.apps.has('explorer'));
  assert.equal(p.allowedPaths.length, 0);
});

test('unknown type with a custom scope still works (and warns)', () => {
  const p = loadPolicy({ taskType: 'Nope', targetProcess: 'x.exe', extra: { allowedPaths: ['C:\\A'], allowedApps: [] }, file, log });
  assert.equal(p.name, 'Custom');
  assert.ok(logs.some((l) => /No policy named "Nope"/.test(l)));
});
