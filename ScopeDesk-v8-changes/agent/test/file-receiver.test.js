'use strict';
// Vendor -> Client files: only into approved folders, never programs, never overwriting, complete or nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileReceiver, safeFileName } = require('../file-receiver');
const { isInside } = require('../policy');

function rig({ allowed = true, locked = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-files-'));
  const ok = path.join(root, 'Approved'); fs.mkdirSync(ok);
  const other = path.join(root, 'Private'); fs.mkdirSync(other);
  const allowedPaths = allowed ? [ok] : [];
  const policy = { allowedPaths, pathAllowed: (p) => allowedPaths.some((a) => isInside(p, a)) };
  const results = [];
  const r = createFileReceiver({ policy, isLocked: () => locked, report: (x) => results.push(x), tmpDir: root });
  return { r, ok, other, results };
}
const send = (r, id, name, buf, extra = {}) => r.chunk({ id, seq: 0, name, size: buf.length, last: true, data: buf, ...extra });

test('a file arrives in the approved folder, complete; a second one with the same name is never overwritten', () => {
  const { r, ok, results } = rig();
  assert.equal(send(r, 'abc123', 'report.txt', Buffer.from('hello')), true);
  assert.equal(fs.readFileSync(path.join(ok, 'report.txt'), 'utf8'), 'hello');
  send(r, 'abc124', 'report.txt', Buffer.from('second'));
  assert.equal(fs.readFileSync(path.join(ok, 'report (1).txt'), 'utf8'), 'second');
  assert.deepEqual(results.map((x) => x.ok), [true, true]);
});

test('chunks are assembled in order; out-of-order or oversized data is refused', () => {
  const { r, ok, results } = rig();
  r.chunk({ id: 'chunky1', seq: 0, name: 'a.csv', size: 6, last: false, data: Buffer.from('abc') });
  r.chunk({ id: 'chunky1', seq: 1, name: 'a.csv', size: 6, last: true, data: Buffer.from('def') });
  assert.equal(fs.readFileSync(path.join(ok, 'a.csv'), 'utf8'), 'abcdef');
  r.chunk({ id: 'chunky2', seq: 0, name: 'b.csv', size: 3, last: false, data: Buffer.from('abc') });
  assert.equal(r.chunk({ id: 'chunky2', seq: 2, name: 'b.csv', size: 3, last: true, data: Buffer.from('x') }), false);
  assert.equal(send(r, 'chunky3', 'c.csv', Buffer.from('toolong'), { size: 3 }), false);
  assert.equal(results.filter((x) => !x.ok).length, 2);
});

test('programs and scripts, folders outside the scope, tasks without folders and a locked session are all refused', () => {
  const a = rig();
  for (const n of ['setup.exe', 'run.BAT', 'x.ps1', 'Evil.app', 'go.command', 'k.sh', 'p.msi']) assert.equal(send(a.r, 'id' + n.length + 'xxxxx' + n.replace(/\W/g, ''), n, Buffer.from('x')), false, n);
  assert.equal(send(a.r, 'outside1', 'note.txt', Buffer.from('x'), { folder: a.other }), false);
  assert.equal(fs.existsSync(path.join(a.other, 'note.txt')), false);
  assert.equal(send(rig({ allowed: false }).r, 'nofold1', 'note.txt', Buffer.from('x')), false);
  assert.equal(send(rig({ locked: true }).r, 'locked1', 'note.txt', Buffer.from('x')), false);
});

test('file names are cleaned: no folder parts, no device names, no hidden dot files', () => {
  assert.equal(safeFileName('..\\..\\Windows\\win.ini'), 'win.ini');
  assert.equal(safeFileName('a/b/../c.txt'), 'c.txt');
  assert.equal(safeFileName('CON.txt'), null);
  assert.equal(safeFileName('.bashrc'), 'bashrc');
  assert.equal(safeFileName('Q1: "draft"?.xlsx'), 'Q1_ _draft__.xlsx');
});
