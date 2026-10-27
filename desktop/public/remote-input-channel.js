/* ScopeDesk remote-input channel: ONE file used on both ends.
 *
 *   Vendor's browser : ScopeDeskInputChannel.createCapture({ surface, video, send }) captures mouse and keyboard on the remote
 *                      screen, scales pointer positions to the shared screen (0..1 of the real picture, correct even when the
 *                      video is letter-boxed) and sends small JSON messages over an RTCDataChannel.
 *   Client's PC (Node): parseInputMessage(raw) re-validates every message (types, ranges, key names, size). The vendor's browser is
 *                      never trusted: the host drops anything that does not match this protocol exactly.
 *
 * Wire format (version 1), all numbers finite:
 *   { v:1, t:'mm', x, y }                                   pointer moved          x,y in 0..1
 *   { v:1, t:'md'|'mu', x, y, b }                           button down / up       b: 0 left, 1 middle, 2 right
 *   { v:1, t:'wh', dx, dy }                                 wheel                  pixels, clamped to +-2000
 *   { v:1, t:'kd'|'ku', code, key, shift, ctrl, alt, meta } key down / up          KeyboardEvent.code / .key
 *   { v:1, t:'rel' }                                        release every key and button (focus lost, disconnect)
 *
 * Channels (see CHANNELS): "scopedesk-input" is reliable + ordered (buttons, keys, wheel). "scopedesk-pointer" is unordered with no
 * retransmits (pointer moves: a late position is useless, a lost button-up would be a disaster, so buttons never use it).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScopeDeskInputChannel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const MAX_MESSAGE_BYTES = 1024;
  const MAX_WHEEL = 2000;
  const MAX_KEY_NAME = 32;
  const CHANNELS = Object.freeze({
    reliable: { label: 'scopedesk-input', options: { ordered: true } },
    pointer: { label: 'scopedesk-pointer', options: { ordered: false, maxRetransmits: 0 } }
  });

  // Public STUN used only when the server's /api/rtc-config cannot be reached (it normally also supplies TURN)
  const FALLBACK_ICE_SERVERS = Object.freeze([
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }
  ]);

  const TYPES = new Set(['mm', 'md', 'mu', 'wh', 'kd', 'ku', 'rel']);
  const KEY_CODE_RE = /^[A-Za-z0-9_+\-]{1,32}$/;

  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /**
   * Validates one incoming message (string or object). Returns the clean message, or null when it is not acceptable.
   * Unknown fields are dropped, so nothing extra can ride along to the executor.
   */
  function parseInputMessage(raw) {
    let msg = raw;
    if (typeof raw === 'string') {
      if (raw.length > MAX_MESSAGE_BYTES) return null;
      try { msg = JSON.parse(raw); } catch (_) { return null; }
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
    if (msg.v !== VERSION || typeof msg.t !== 'string' || !TYPES.has(msg.t)) return null;

    switch (msg.t) {
      case 'mm':
        if (!isNum(msg.x) || !isNum(msg.y)) return null;
        return { v: VERSION, t: 'mm', x: clamp(msg.x, 0, 1), y: clamp(msg.y, 0, 1) };
      case 'md':
      case 'mu':
        if (!isNum(msg.x) || !isNum(msg.y) || !Number.isInteger(msg.b) || msg.b < 0 || msg.b > 2) return null;
        return { v: VERSION, t: msg.t, x: clamp(msg.x, 0, 1), y: clamp(msg.y, 0, 1), b: msg.b };
      case 'wh':
        if (!isNum(msg.dx) || !isNum(msg.dy)) return null;
        return { v: VERSION, t: 'wh', dx: clamp(Math.round(msg.dx), -MAX_WHEEL, MAX_WHEEL), dy: clamp(Math.round(msg.dy), -MAX_WHEEL, MAX_WHEEL) };
      case 'kd':
      case 'ku': {
        if (typeof msg.code !== 'string' || !KEY_CODE_RE.test(msg.code)) return null;
        const key = typeof msg.key === 'string' ? msg.key : '';
        if (key.length > MAX_KEY_NAME) return null;
        // The key name is only used for lookups and to type a single printable character, never put in a command line
        if ([...key].length > 1 && !/^[A-Za-z0-9]+$/.test(key)) return null;
        return {
          v: VERSION, t: msg.t, code: msg.code, key,
          shift: msg.shift === true, ctrl: msg.ctrl === true, alt: msg.alt === true, meta: msg.meta === true
        };
      }
      case 'rel':
        return { v: VERSION, t: 'rel' };
      default:
        return null;
    }
  }

  /**
   * Where inside the shared picture is this pointer? The <video> may be letter-boxed (object-fit: contain), so the picture is
   * only part of the element. Returns { x, y } in 0..1 of the PICTURE, or null when the pointer is on the black bars.
   * @param {{left:number, top:number, width:number, height:number}} rect  video element box (getBoundingClientRect)
   * @param {number} videoWidth   video.videoWidth (the real size of the shared screen)
   * @param {number} videoHeight  video.videoHeight
   */
  function mapPointer(clientX, clientY, rect, videoWidth, videoHeight) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0) || !(videoWidth > 0) || !(videoHeight > 0)) return null;
    const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
    const shownW = videoWidth * scale;
    const shownH = videoHeight * scale;
    const offsetX = rect.left + (rect.width - shownW) / 2;
    const offsetY = rect.top + (rect.height - shownH) / 2;
    const x = (clientX - offsetX) / shownW;
    const y = (clientY - offsetY) / shownH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  /**
   * Vendor side. Attaches mouse and keyboard listeners to `surface` (a focusable element that contains the <video>).
   * @param {object} cfg
   * @param {HTMLElement} cfg.surface
   * @param {HTMLVideoElement} cfg.video
   * @param {(message:string, kind:'reliable'|'pointer') => boolean} cfg.send   returns false when the channel is not open
   * @param {number} [cfg.moveIntervalMs=16]   at most ~60 pointer messages per second
   * @returns {{ detach: () => void, releaseAll: () => void }}
   */
  function createCapture(cfg) {
    const { surface, video, send } = cfg;
    if (!surface || !video || typeof send !== 'function') throw new Error('createCapture needs { surface, video, send }.');
    const moveIntervalMs = cfg.moveIntervalMs || 16;
    const now = cfg.now || (() => Date.now());
    const doc = surface.ownerDocument;

    const downKeys = new Map();      // code -> last key-down message, so a lost focus can release them
    const downButtons = new Set();
    let lastMoveAt = 0;
    let pendingMove = null;
    let moveTimer = null;

    const emit = (m, kind) => { try { return send(JSON.stringify(m), kind); } catch (_) { return false; } };
    const point = (e) => mapPointer(e.clientX, e.clientY, video.getBoundingClientRect(), video.videoWidth, video.videoHeight);

    function flushMove() {
      moveTimer = null;
      if (!pendingMove) return;
      lastMoveAt = now();
      const m = pendingMove; pendingMove = null;
      emit(m, 'pointer');
    }
    function onMove(e) {
      const p = point(e);
      if (!p) return;
      pendingMove = { v: VERSION, t: 'mm', x: p.x, y: p.y };
      const wait = moveIntervalMs - (now() - lastMoveAt);
      if (wait <= 0) flushMove();
      else if (!moveTimer) moveTimer = setTimeout(flushMove, wait);   // coalesce: only the newest position is sent
    }
    function onDown(e) {
      const p = point(e);
      if (!p) return;
      surface.focus();
      e.preventDefault();
      downButtons.add(e.button);
      pendingMove = null;
      emit({ v: VERSION, t: 'md', x: p.x, y: p.y, b: e.button }, 'reliable');
    }
    function onUp(e) {
      if (!downButtons.has(e.button)) return;
      downButtons.delete(e.button);
      const p = point(e) || { x: 0.5, y: 0.5 };      // released outside the picture: still release on the other side
      e.preventDefault();
      emit({ v: VERSION, t: 'mu', x: p.x, y: p.y, b: e.button }, 'reliable');
    }
    function onWheel(e) {
      if (!point(e)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;   // lines / pages -> pixels
      emit({ v: VERSION, t: 'wh', dx: e.deltaX * unit, dy: e.deltaY * unit }, 'reliable');
    }
    function keyMessage(type, e) {
      return { v: VERSION, t: type, code: e.code || '', key: e.key || '', shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
    }
    function onKeyDown(e) {
      if (e.isComposing || !e.code) return;
      e.preventDefault();                            // keys go to the remote PC, not to this page
      const m = keyMessage('kd', e);
      downKeys.set(e.code, m);
      emit(m, 'reliable');
    }
    function onKeyUp(e) {
      if (!e.code) return;
      e.preventDefault();
      downKeys.delete(e.code);
      emit(keyMessage('ku', e), 'reliable');
    }
    function releaseAll() {
      for (const [code, m] of downKeys) emit({ ...m, t: 'ku', code }, 'reliable');
      downKeys.clear();
      downButtons.clear();
      emit({ v: VERSION, t: 'rel' }, 'reliable');
    }
    const onContext = (e) => e.preventDefault();
    const onBlur = () => releaseAll();

    surface.addEventListener('mousemove', onMove);
    surface.addEventListener('mousedown', onDown);
    doc.addEventListener('mouseup', onUp);
    surface.addEventListener('wheel', onWheel, { passive: false });
    surface.addEventListener('keydown', onKeyDown);
    surface.addEventListener('keyup', onKeyUp);
    surface.addEventListener('contextmenu', onContext);
    surface.addEventListener('blur', onBlur);

    return {
      releaseAll,
      detach() {
        releaseAll();
        clearTimeout(moveTimer);
        surface.removeEventListener('mousemove', onMove);
        surface.removeEventListener('mousedown', onDown);
        doc.removeEventListener('mouseup', onUp);
        surface.removeEventListener('wheel', onWheel);
        surface.removeEventListener('keydown', onKeyDown);
        surface.removeEventListener('keyup', onKeyUp);
        surface.removeEventListener('contextmenu', onContext);
        surface.removeEventListener('blur', onBlur);
      }
    };
  }

  /**
   * Vendor side, ready-made `send` for createCapture from the two data channels:
   *   const send = ScopeDeskInputChannel.channelSender(reliableChannel, pointerChannel);
   * Messages are dropped (returns false) while a channel is not open or its buffer is backed up.
   */
  function channelSender(reliable, pointer) {
    return (message, kind) => {
      const ch = kind === 'pointer' && pointer && pointer.readyState === 'open' ? pointer : reliable;
      if (!ch || ch.readyState !== 'open') return false;
      if (kind === 'pointer' && ch.bufferedAmount > 16 * 1024) return false;   // stale positions are worthless: drop, never queue
      ch.send(message);
      return true;
    };
  }

  /** Vendor side: creates both data channels on the vendor's peer connection (call BEFORE createOffer, or on the offering side). */
  function createChannels(pc) {
    return {
      reliable: pc.createDataChannel(CHANNELS.reliable.label, CHANNELS.reliable.options),
      pointer: pc.createDataChannel(CHANNELS.pointer.label, CHANNELS.pointer.options)
    };
  }

  return { VERSION, CHANNELS, FALLBACK_ICE_SERVERS, MAX_MESSAGE_BYTES, parseInputMessage, mapPointer, createCapture, channelSender, createChannels };
}));
