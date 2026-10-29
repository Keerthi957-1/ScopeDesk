'use strict';
// Strict schema for every input event. The agent trusts NOTHING it receives, whichever path it came by
// (data channel via the local bridge, or the server relay). Keep in sync with server/remote-control.js.
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const unit = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);
const VENDOR_OS = new Set(['mac', 'win', 'linux']);
const MAX_CLIP = 4000;   // characters

function parseInput(e) {
  if (!e || typeof e !== 'object') return null;
  switch (e.t) {
    case 'move': { const x = unit(e.x), y = unit(e.y); return x === null || y === null ? null : { t: 'move', x, y }; }
    case 'down':
    case 'up': {
      const x = unit(e.x), y = unit(e.y);
      if (x === null || y === null || ![0, 1, 2].includes(e.b)) return null;
      return { t: e.t, x, y, b: e.b };
    }
    case 'wheel': {
      if (!Number.isFinite(e.dx) || !Number.isFinite(e.dy)) return null;
      return { t: 'wheel', dx: clamp(Math.round(e.dx), -2000, 2000), dy: clamp(Math.round(e.dy), -2000, 2000) };
    }
    case 'key': {
      if (typeof e.k !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(e.k) || typeof e.d !== 'boolean') return null;
      const out = { t: 'key', k: e.k, d: e.d };
      if (VENDOR_OS.has(e.o)) out.o = e.o;   // the vendor's OS, so Ctrl/Cmd shortcuts can be translated for the Client's OS
      return out;
    }
    case 'text': {   // printable characters typed by the vendor: typed as characters, so any keyboard layout and OS works
      if (typeof e.s !== 'string' || e.s.length === 0 || [...e.s].length > 8 || /[\u0000-\u001f\u007f]/.test(e.s)) return null;
      return { t: 'text', s: e.s };
    }
    case 'clip': {   // vendor pasted text (vendor -> Client only). Put on the Client's clipboard, then pasted inside the approved app
      if (typeof e.s !== 'string' || e.s.length > MAX_CLIP || /\u0000/.test(e.s)) return null;
      const out = { t: 'clip', s: e.s };
      if (VENDOR_OS.has(e.o)) out.o = e.o;
      return out;
    }
    case 'open': {   // "open this folder in the file manager". The policy check happens in the injector, not here.
      if (typeof e.p !== 'string' || e.p.length === 0 || e.p.length > 260 || /[\u0000-\u001f]/.test(e.p)) return null;
      return { t: 'open', p: e.p };
    }
    default: return null;
  }
}
module.exports = { parseInput };
