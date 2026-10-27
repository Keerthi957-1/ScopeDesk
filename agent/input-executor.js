'use strict';
/**
 * Turns validated remote-input messages (public/remote-input-channel.js) into real mouse and keyboard input on THIS computer.
 * Runs on the Client's PC only, and only receives messages that already passed parseInputMessage() and sandbox-guard.
 *
 *   Windows : a long-lived PowerShell helper (agent/native/windows-input.ps1) calling user32 SendInput
 *   macOS   : a long-lived JXA helper (agent/native/macos-input.js) posting CoreGraphics events (needs the Accessibility permission)
 *   Linux   : xdotool (X11 sessions only; Wayland does not allow synthetic input)
 *
 * Safety rules enforced here, whatever the vendor sends:
 *   - nothing from the message is ever placed in a shell command: helpers get numbers and table-looked-up key codes only
 *   - Windows / Super / Meta keys are dropped (no Start menu, no Win+R), and so are the shortcuts that would leave the approved apps
 *     or end ScopeDesk itself: Alt+Tab, Alt+F4, Ctrl+Esc, Ctrl+Shift+Esc, Cmd+Tab, Cmd+Space, Cmd+Q, Cmd+Option+Esc
 *   - at most MAX_EVENTS_PER_SECOND events per second; every pressed key and button is released when the executor closes
 */

const path = require('path');
const { spawn: nodeSpawn, execFile: nodeExecFile } = require('child_process');
const { parseInputMessage } = require('../public/remote-input-channel');

const MAX_EVENTS_PER_SECOND = 400;

// ---------- key tables: KeyboardEvent.code -> native key ----------
function buildWindowsKeys() {
  const t = {};
  for (let i = 0; i < 26; i++) t[`Key${String.fromCharCode(65 + i)}`] = { vk: 0x41 + i };
  for (let i = 0; i < 10; i++) { t[`Digit${i}`] = { vk: 0x30 + i }; t[`Numpad${i}`] = { vk: 0x60 + i }; }
  for (let i = 1; i <= 12; i++) t[`F${i}`] = { vk: 0x6F + i };
  Object.assign(t, {
    Backspace: { vk: 0x08 }, Tab: { vk: 0x09 }, Enter: { vk: 0x0D }, NumpadEnter: { vk: 0x0D, ext: true }, Escape: { vk: 0x1B }, Space: { vk: 0x20 },
    ShiftLeft: { vk: 0xA0 }, ShiftRight: { vk: 0xA1 }, ControlLeft: { vk: 0xA2 }, ControlRight: { vk: 0xA3, ext: true },
    AltLeft: { vk: 0xA4 }, AltRight: { vk: 0xA5, ext: true }, CapsLock: { vk: 0x14 },
    PageUp: { vk: 0x21, ext: true }, PageDown: { vk: 0x22, ext: true }, End: { vk: 0x23, ext: true }, Home: { vk: 0x24, ext: true },
    ArrowLeft: { vk: 0x25, ext: true }, ArrowUp: { vk: 0x26, ext: true }, ArrowRight: { vk: 0x27, ext: true }, ArrowDown: { vk: 0x28, ext: true },
    Insert: { vk: 0x2D, ext: true }, Delete: { vk: 0x2E, ext: true }, PrintScreen: { vk: 0x2C, ext: true }, ContextMenu: { vk: 0x5D, ext: true },
    NumpadMultiply: { vk: 0x6A }, NumpadAdd: { vk: 0x6B }, NumpadSubtract: { vk: 0x6D }, NumpadDecimal: { vk: 0x6E }, NumpadDivide: { vk: 0x6F, ext: true },
    Semicolon: { vk: 0xBA }, Equal: { vk: 0xBB }, Comma: { vk: 0xBC }, Minus: { vk: 0xBD }, Period: { vk: 0xBE }, Slash: { vk: 0xBF },
    Backquote: { vk: 0xC0 }, BracketLeft: { vk: 0xDB }, Backslash: { vk: 0xDC }, BracketRight: { vk: 0xDD }, Quote: { vk: 0xDE }
  });
  return t;
}

const MAC_KEYS = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27,
  Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39,
  KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50, Backspace: 51,
  Escape: 53, MetaRight: 54, MetaLeft: 55, ShiftLeft: 56, CapsLock: 57, AltLeft: 58, ControlLeft: 59, ShiftRight: 60, AltRight: 61, ControlRight: 62,
  F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F10: 109, F12: 111, Home: 115, PageUp: 116, Delete: 117, F4: 118, End: 119, F2: 120,
  PageDown: 121, F1: 122, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87, Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92,
  NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumpadSubtract: 78, NumpadDivide: 75, NumpadEnter: 76
};

function buildLinuxKeys() {
  const t = {};
  for (let i = 0; i < 26; i++) t[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i);
  for (let i = 0; i < 10; i++) { t[`Digit${i}`] = String(i); t[`Numpad${i}`] = `KP_${i}`; }
  for (let i = 1; i <= 12; i++) t[`F${i}`] = `F${i}`;
  Object.assign(t, {
    Backspace: 'BackSpace', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'KP_Enter', Escape: 'Escape', Space: 'space',
    ShiftLeft: 'Shift_L', ShiftRight: 'Shift_R', ControlLeft: 'Control_L', ControlRight: 'Control_R', AltLeft: 'Alt_L', AltRight: 'Alt_R', CapsLock: 'Caps_Lock',
    PageUp: 'Prior', PageDown: 'Next', End: 'End', Home: 'Home', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowRight: 'Right', ArrowDown: 'Down',
    Insert: 'Insert', Delete: 'Delete', NumpadMultiply: 'KP_Multiply', NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract', NumpadDecimal: 'KP_Decimal', NumpadDivide: 'KP_Divide',
    Semicolon: 'semicolon', Equal: 'equal', Comma: 'comma', Minus: 'minus', Period: 'period', Slash: 'slash', Backquote: 'grave',
    BracketLeft: 'bracketleft', Backslash: 'backslash', BracketRight: 'bracketright', Quote: 'apostrophe'
  });
  return t;
}

const WIN_KEYS = buildWindowsKeys();
const LINUX_KEYS = buildLinuxKeys();
const META_CODES = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);

/**
 * Returns a reason string when this key must never be injected on this platform, otherwise null.
 * `msg` is a validated 'kd' / 'ku' message (its modifier flags describe what the vendor holds down).
 */
function blockedKeyReason(msg, platform) {
  const mac = platform === 'darwin';
  // A Mac vendor's Cmd+<editing letter> is allowed on Windows because it is delivered as Ctrl+<letter>; every other Meta use is not
  const macStyleShortcut = msg.meta && !msg.ctrl && SHORTCUT_LETTERS.has(msg.code);
  if (!mac && (META_CODES.has(msg.code) || (msg.meta && !macStyleShortcut))) return 'The Windows / Super key is not allowed.';
  if (msg.alt && msg.code === 'Tab') return 'Alt+Tab is not allowed.';
  if (msg.code === 'F4' && msg.alt) return 'Alt+F4 is not allowed.';
  if (msg.code === 'Escape' && msg.ctrl && !mac) return 'Ctrl+Esc / Ctrl+Shift+Esc is not allowed.';
  // On a Mac host the vendor's Ctrl is delivered as Command (see CROSS_OS below), so the Command rules cover both
  if (mac && (msg.meta || msg.ctrl)) {
    if (['Tab', 'Space', 'KeyQ'].includes(msg.code)) return 'This Command shortcut is not allowed.';
    if (msg.code === 'Escape' && msg.alt) return 'Force Quit is not allowed.';
    if (msg.ctrl && msg.meta && msg.code === 'KeyQ') return 'Lock screen is not allowed.';
  }
  if (mac && msg.code === 'KeyQ' && msg.ctrl && msg.meta) return 'Lock screen is not allowed.';
  return null;
}

/**
 * Printable text is typed as the character itself (works on any keyboard layout); everything else, and every shortcut,
 * is sent as a physical key.
 */
function isPlainText(msg) {
  return [...msg.key].length === 1 && !msg.ctrl && !msg.alt && !msg.meta && msg.key.codePointAt(0) >= 0x20 && msg.key.codePointAt(0) !== 0x7f;
}

/**
 * Cross-OS shortcut mapping. The vendor's browser reports physical keys, so Windows <-> macOS needs a translation or Ctrl+C would
 * not copy on a Mac and Cmd+C would do nothing on Windows.
 *   Mac host     : ControlLeft/Right are pressed as Command, so Ctrl+C / Ctrl+V / Ctrl+A ... behave like Cmd+C / Cmd+V / Cmd+A.
 *                  (Control+click and other Control-only chords are not needed for the approved apps.)
 *   Windows host : Command + <letter> is pressed as Ctrl + <letter> (the vendor's Meta key itself is still dropped).
 */
const MAC_CTRL_TO_CMD = { ControlLeft: 'MetaLeft', ControlRight: 'MetaRight' };
const SHORTCUT_LETTERS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyF', 'KeyS', 'KeyP', 'KeyN', 'KeyO']);

function toWindowsPoint(x, y) {
  return { x: Math.round(x * 65535), y: Math.round(y * 65535) };
}

/**
 * Pure translation: one validated message -> the native commands for a platform. Exported for tests.
 * `state` holds { held: Set of pressed button numbers } and is updated.
 * @returns {{ commands: object[], dropped?: string }}
 */
function translate(msg, platform, state) {
  const out = [];
  const held = state.held;
  const lastHeld = () => (held.size ? [...held][held.size - 1] : -1);

  if (msg.t === 'rel') {
    if (platform === 'win32') {
      for (const b of held) out.push({ op: 'btn', b, down: false });
      for (const code of state.keys) { const k = WIN_KEYS[code]; if (k) out.push({ op: 'key', vk: k.vk, ext: !!k.ext, down: false }); }
    } else if (platform === 'darwin') {
      for (const b of held) out.push({ op: 'btn', b, down: false, x: state.x, y: state.y });
      for (const code of state.keys) if (MAC_KEYS[code] !== undefined) out.push({ op: 'key', kc: MAC_KEYS[code], down: false });
    } else {
      for (const b of held) out.push({ op: 'btn', b, down: false });
      for (const code of state.keys) if (LINUX_KEYS[code]) out.push({ op: 'key', sym: LINUX_KEYS[code], down: false });
    }
    held.clear();
    state.keys.clear();
    return { commands: out };
  }

  if (msg.t === 'mm' || msg.t === 'md' || msg.t === 'mu') {
    state.x = msg.x; state.y = msg.y;
    if (platform === 'win32') {
      const p = toWindowsPoint(msg.x, msg.y);
      out.push({ op: 'move', x: p.x, y: p.y });
    } else if (platform === 'darwin') {
      if (msg.t === 'mm') out.push({ op: 'move', x: msg.x, y: msg.y, held: lastHeld() });
    } else {
      out.push({ op: 'move', x: msg.x, y: msg.y });
    }
    if (msg.t === 'md') { held.add(msg.b); out.push(platform === 'darwin' ? { op: 'btn', b: msg.b, down: true, x: msg.x, y: msg.y } : { op: 'btn', b: msg.b, down: true }); }
    if (msg.t === 'mu') { held.delete(msg.b); out.push(platform === 'darwin' ? { op: 'btn', b: msg.b, down: false, x: msg.x, y: msg.y } : { op: 'btn', b: msg.b, down: false }); }
    return { commands: out };
  }

  if (msg.t === 'wh') {
    if (platform === 'win32') out.push({ op: 'wheel', dx: Math.round(msg.dx * 1.2), dy: Math.round(-msg.dy * 1.2) });   // WHEEL_DELTA: +up, JS: +down
    else if (platform === 'darwin') out.push({ op: 'wheel', dx: -Math.round(msg.dx), dy: -Math.round(msg.dy) });
    else out.push({ op: 'wheel', dx: msg.dx, dy: msg.dy });
    return { commands: out };
  }

  // keys
  const down = msg.t === 'kd';
  const blocked = blockedKeyReason(msg, platform);
  if (blocked) return { commands: [], dropped: blocked };

  // Windows host, Mac vendor: Cmd+<letter> becomes Ctrl+<letter> (Ctrl is held just for this key press)
  if (platform === 'win32' && msg.meta && !msg.ctrl && SHORTCUT_LETTERS.has(msg.code)) {
    const ctrl = WIN_KEYS.ControlLeft;
    const k = WIN_KEYS[msg.code];
    if (down) { out.push({ op: 'key', vk: ctrl.vk, ext: false, down: true }, { op: 'key', vk: k.vk, ext: false, down: true }); state.keys.add(msg.code); }
    else { out.push({ op: 'key', vk: k.vk, ext: false, down: false }, { op: 'key', vk: ctrl.vk, ext: false, down: false }); state.keys.delete(msg.code); }
    return { commands: out };
  }
  // Mac host, Windows vendor: the Control key is pressed as Command
  if (platform === 'darwin' && MAC_CTRL_TO_CMD[msg.code]) {
    const mapped = MAC_CTRL_TO_CMD[msg.code];
    out.push({ op: 'key', kc: MAC_KEYS[mapped], down });
    if (down) state.keys.add(mapped); else state.keys.delete(mapped);
    return { commands: out };
  }

  if (platform === 'win32') {
    if (isPlainText(msg) && !WIN_KEYS[msg.code]?.ext) {
      out.push({ op: 'char', cp: msg.key.codePointAt(0), down });
    } else if (WIN_KEYS[msg.code]) {
      out.push({ op: 'key', vk: WIN_KEYS[msg.code].vk, ext: !!WIN_KEYS[msg.code].ext, down });
    } else return { commands: [], dropped: `Unknown key ${msg.code}.` };
  } else if (platform === 'darwin') {
    if (MAC_KEYS[msg.code] === undefined) return { commands: [], dropped: `Unknown key ${msg.code}.` };
    out.push({ op: 'key', kc: MAC_KEYS[msg.code], down });
  } else {
    if (isPlainText(msg) && msg.key !== ' ') out.push({ op: 'text', ch: msg.key, down });
    else if (LINUX_KEYS[msg.code]) out.push({ op: 'key', sym: LINUX_KEYS[msg.code], down });
    else return { commands: [], dropped: `Unknown key ${msg.code}.` };
  }
  if (down) state.keys.add(msg.code); else state.keys.delete(msg.code);
  return { commands: out };
}

// ---------- backends ----------
function persistentHelper({ spawn, file, args, log }) {
  let child = null;
  function ensure() {
    if (child && !child.killed && child.stdin.writable) return child;
    child = spawn(file, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    child.stderr.on('data', (d) => log('[input] helper: ' + String(d).trim().slice(0, 200)));
    child.on('error', (e) => { log('[input] helper failed: ' + e.message); child = null; });
    child.on('exit', () => { child = null; });
    child.stdin.on('error', () => { child = null; });
    return child;
  }
  return {
    send(command) { const c = ensure(); if (c && c.stdin.writable) c.stdin.write(JSON.stringify(command) + '\n'); },
    close() { if (child) { try { child.stdin.end(); child.kill(); } catch (_) { /* already gone */ } child = null; } }
  };
}

function windowsBackend({ spawn, log, env }) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(__dirname, 'native', 'windows-input.ps1');
  return persistentHelper({ spawn, log, file: powershell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] });
}

function macBackend({ spawn, log }) {
  return persistentHelper({ spawn, log, file: '/usr/bin/osascript', args: ['-l', 'JavaScript', path.join(__dirname, 'native', 'macos-input.js')] });
}

function linuxBackend({ execFile, log, screen }) {
  let queue = Promise.resolve();
  const BUTTON = [1, 2, 3];
  const run = (...args) => new Promise((resolve) => { execFile('xdotool', args, { timeout: 3000 }, (err) => { if (err) log('[input] xdotool: ' + err.message); resolve(); }); });
  return {
    send(c) {
      queue = queue.then(async () => {
        if (c.op === 'move') {
          const s = await screen();
          if (s) await run('mousemove', String(Math.round(c.x * (s.width - 1))), String(Math.round(c.y * (s.height - 1))));
        } else if (c.op === 'btn') await run(c.down ? 'mousedown' : 'mouseup', String(BUTTON[c.b] || 1));
        else if (c.op === 'wheel') {
          const vert = Math.min(10, Math.ceil(Math.abs(c.dy) / 100));
          const horiz = Math.min(10, Math.ceil(Math.abs(c.dx) / 100));
          for (let i = 0; i < vert; i++) await run('click', c.dy < 0 ? '4' : '5');
          for (let i = 0; i < horiz; i++) await run('click', c.dx < 0 ? '6' : '7');
        } else if (c.op === 'key') await run(c.down ? 'keydown' : 'keyup', c.sym);
        else if (c.op === 'text') { if (c.down) await run('type', '--delay', '0', '--', c.ch); }
      }).catch(() => {});
    },
    close() { queue = Promise.resolve(); }
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {(msg:object)=>void} [options.onDropped]      called with a reason when a message is refused
 * @param {{send:Function, close:Function}} [options.backend]   inject a fake backend (tests)
 */
function createInputExecutor(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const spawn = options.spawn || nodeSpawn;
  const execFile = options.execFile || nodeExecFile;
  const now = options.now || (() => Date.now());

  let screenCache = null;
  const screen = async () => {
    if (screenCache) return screenCache;
    screenCache = await new Promise((resolve) => {
      execFile('xdotool', ['getdisplaygeometry'], { timeout: 3000 }, (err, stdout) => {
        const m = /^(\d+)\s+(\d+)/.exec(String(stdout || ''));
        resolve(err || !m ? null : { width: Number(m[1]), height: Number(m[2]) });
      });
    });
    return screenCache;
  };

  let backend = options.backend;
  let unsupported = null;
  if (!backend) {
    if (platform === 'win32') backend = windowsBackend({ spawn, log, env });
    else if (platform === 'darwin') backend = macBackend({ spawn, log });
    else if (String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland') unsupported = 'Remote control is not available on Wayland sessions. Log in with an X11 session.';
    else backend = linuxBackend({ execFile, log, screen });
  }

  const state = { held: new Set(), keys: new Set(), x: 0.5, y: 0.5 };
  let lastInputAt = 0;
  let windowStart = now();
  let count = 0;
  let closed = false;

  return {
    unsupported,
    /** When did the last vendor input reach this PC? (the foreground monitor uses it to tell the vendor from the Client) */
    lastInputAt: () => lastInputAt,
    /**
     * @param {unknown} raw  a message that already passed sandbox-guard
     * @returns {{ ok: boolean, reason?: string }}
     */
    execute(raw) {
      if (closed) return { ok: false, reason: 'closed' };
      if (unsupported) return { ok: false, reason: unsupported };
      const msg = parseInputMessage(raw);
      if (!msg) return { ok: false, reason: 'invalid-message' };

      const t = now();
      if (t - windowStart >= 1000) { windowStart = t; count = 0; }
      if (++count > MAX_EVENTS_PER_SECOND && msg.t !== 'rel' && msg.t !== 'mu' && msg.t !== 'ku') return { ok: false, reason: 'rate-limited' };

      const { commands, dropped } = translate(msg, platform, state);
      if (dropped) { if (options.onDropped) options.onDropped(dropped); return { ok: false, reason: dropped }; }
      lastInputAt = t;
      for (const c of commands) backend.send(c);
      return { ok: true };
    },
    /** Releases every key and button, then stops the helper. Always call this when the session ends. */
    close() {
      if (closed) return;
      try {
        const { commands } = translate({ v: 1, t: 'rel' }, platform, state);
        if (backend) for (const c of commands) backend.send(c);
      } finally {
        closed = true;
        if (backend) backend.close();
      }
    }
  };
}

module.exports = { createInputExecutor, translate, MAC_CTRL_TO_CMD, blockedKeyReason, isPlainText, WIN_KEYS, MAC_KEYS, LINUX_KEYS, MAX_EVENTS_PER_SECOND };
