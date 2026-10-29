'use strict';
// Pure key translation rules of agent/input-injector.js for every host / vendor OS combination (no OS input involved).
const test = require('node:test');
const assert = require('node:assert/strict');
const { InputInjector } = require('../input-injector');

const make = (platform) => new InputInjector({ monitor: { state: 'armed' }, log: () => {}, viewOnly: false, policy: null, platform });
const press = (inj, k, o) => { const r = inj.translateKey({ k, d: true, o }); if (r.host) inj.down.set(k, r.host); return r.host; };

test('Mac client, Windows vendor: Ctrl becomes Command; Cmd+Q / Cmd+Tab / Cmd+Space stay blocked', () => {
  const inj = make('darwin');
  assert.equal(press(inj, 'ControlLeft', 'win'), 'MetaLeft');
  assert.equal(press(inj, 'KeyC', 'win'), 'KeyC');                       // = Cmd+C: copy works
  assert.equal(press(inj, 'KeyQ', 'win'), null);                         // Cmd+Q would quit the app
  assert.equal(press(inj, 'Tab', 'win'), null);
  assert.equal(press(inj, 'Space', 'win'), null);
  assert.equal(press(inj, 'MetaLeft', 'win'), null);                     // the Windows key itself
});

test('Mac client, Mac vendor: Command is Command; Control stays Control; Control+arrows (Spaces) blocked', () => {
  const inj = make('darwin');
  assert.equal(press(inj, 'MetaLeft', 'mac'), 'MetaLeft');
  assert.equal(press(inj, 'KeyV', 'mac'), 'KeyV');
  inj.down.clear();
  assert.equal(press(inj, 'ControlLeft', 'mac'), 'ControlLeft');
  assert.equal(press(inj, 'ArrowLeft', 'mac'), null);
});

test('Windows client: Ctrl+Esc, Alt+F4 blocked; Mac vendor Cmd+letter becomes Ctrl+letter, other Cmd use dropped', () => {
  const inj = make('win32');
  assert.equal(press(inj, 'ControlLeft', 'win'), 'ControlLeft');
  assert.equal(press(inj, 'Escape', 'win'), null);
  inj.down.clear();
  assert.equal(press(inj, 'AltLeft', 'win'), 'AltLeft');
  assert.equal(press(inj, 'F4', 'win'), null);
  inj.down.clear();
  assert.equal(press(inj, 'MetaLeft', 'mac'), null);                     // held, not pressed
  assert.deepEqual(inj.translateKey({ k: 'KeyC', d: true, o: 'mac' }), { host: 'KeyC', ctrlFirst: true });
  assert.equal(inj.translateKey({ k: 'KeyR', d: true, o: 'mac' }).host, null);   // Cmd+R has no safe Windows equivalent here
  inj.translateKey({ k: 'MetaLeft', d: false, o: 'mac' });
  assert.equal(inj.translateKey({ k: 'KeyR', d: true, o: 'mac' }).host, 'KeyR');
});

test('Linux/Windows client, Windows vendor: the Windows key is never pressed', () => {
  assert.equal(make('linux').translateKey({ k: 'MetaLeft', d: true, o: 'win' }).host, null);
  assert.equal(make('win32').translateKey({ k: 'OSLeft', d: true }).host, null);
});
