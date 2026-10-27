const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('../config');
const { loadPolicy, isInside, normalizeKey } = require('../policy');

test('Billing.exe, billing.exe, BILLING.EXE and padded variants are the same app', () => {
  const forms = ['Billing.exe', 'billing.exe', 'BILLING.EXE', '  Billing.EXE  ', 'BILLING'];
  forms.forEach((f) => assert.strictEqual(normalize(f), 'billing'));
  const policy = loadPolicy({ taskType: '', targetProcess: 'Billing.exe', taskId: 1, extra: {}, log: () => {} });
  forms.forEach((f) => assert.ok(policy.apps.has(normalize(f)), f));
  assert.ok(!policy.apps.has(normalize('billing-evil.exe')));
});
test('task types match regardless of case and spacing', () => {
  assert.strictEqual(normalizeKey(' Billing  Support '), normalizeKey('BILLING support'));
});
test('Windows folder paths are compared case-insensitively, by whole segments', () => {
  assert.ok(isInside('C:\\BILLINGDATA\\Invoices', 'c:\\billingdata'));
  assert.ok(isInside('c:\\billingdata\\', 'C:\\BillingData'));
  assert.ok(!isInside('C:\\BillingDataEvil', 'C:\\BillingData'));
  assert.ok(!isInside('C:\\Users\\Other', 'C:\\BillingData'));
});
