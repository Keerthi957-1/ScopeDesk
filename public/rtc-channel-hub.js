/* ScopeDesk RTC hub. Load it BEFORE webrtc.js. It makes three things true for every RTCPeerConnection the page creates, without
 * touching the code that creates it:
 *
 *   1. NAT traversal: if the connection's configuration has no STUN server, public STUN servers are added, so "Share my screen"
 *      works between different ISPs (the server's /api/rtc-config adds TURN when configured, see server/rtc-config.js).
 *   2. Remote-control channels: whichever side makes the offer, the two input data channels (scopedesk-input, scopedesk-pointer)
 *      exist before the offer is created. The other side receives them through "datachannel".
 *   3. Hard stop: every peer, data channel and media track is registered, so hardStop() (called on a breach) really ends the stream
 *      even if the page's own code is stuck or already gone.
 *
 * Client (host) : messages arriving on the channels go to window.scopedeskHost.hostInput() (the sandbox guard + native input in
 *                 the desktop app). The page can never inject input into its own PC from here.
 * Vendor        : ScopeDeskHub.startVendorCapture({ surface, video }) sends mouse and keyboard over the channels.
 */
(function () {
  'use strict';
  if (window.ScopeDeskHub) return;

  const IC = window.ScopeDeskInputChannel;           // remote-input-channel.js (must be loaded first)
  const NativeRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!NativeRTC || !IC) { window.ScopeDeskHub = { available: false }; return; }

  const peers = new Set();
  const channelsByPeer = new Map();                   // pc -> { reliable, pointer }
  const streams = new Set();
  const listeners = { state: new Set() };
  let activeCapture = null;

  const emitState = () => listeners.state.forEach((fn) => { try { fn(status()); } catch (_) { /* a listener must not break the stream */ } });

  function hasStun(config) {
    return (config.iceServers || []).some((s) => [].concat(s.urls || s.url || []).some((u) => /^stuns?:/i.test(u)));
  }
  function withIce(config) {
    const cfg = Object.assign({}, config || {});
    const list = Array.isArray(cfg.iceServers) ? cfg.iceServers.slice() : [];
    cfg.iceServers = list;
    if (!hasStun(cfg)) list.push(...IC.FALLBACK_ICE_SERVERS.map((s) => Object.assign({}, s)));
    if (cfg.iceCandidatePoolSize === undefined) cfg.iceCandidatePoolSize = 4;
    return cfg;
  }

  function track(pc, role, channel) {
    const entry = channelsByPeer.get(pc) || {};
    if (channel.label === IC.CHANNELS.reliable.label) entry.reliable = channel;
    else if (channel.label === IC.CHANNELS.pointer.label) entry.pointer = channel;
    else return;
    channelsByPeer.set(pc, entry);
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', emitState);
    channel.addEventListener('close', emitState);
    // CLIENT side: hand every message to the desktop app. The page never executes anything itself.
    if (window.scopedeskHost && typeof window.scopedeskHost.hostInput === 'function') {
      channel.addEventListener('message', (ev) => { if (typeof ev.data === 'string') window.scopedeskHost.hostInput(ev.data); });
    }
  }

  function PatchedPeerConnection(config, ...rest) {
    const pc = new NativeRTC(withIce(config), ...rest);
    peers.add(pc);
    pc.addEventListener('datachannel', (ev) => track(pc, 'answerer', ev.channel));
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') channelsByPeer.delete(pc);
      emitState();
    });
    const originalOffer = pc.createOffer.bind(pc);
    pc.createOffer = function (...args) {
      if (!channelsByPeer.has(pc) && pc.signalingState !== 'closed') {
        try { const made = IC.createChannels(pc); track(pc, 'offerer', made.reliable); track(pc, 'offerer', made.pointer); } catch (_) { /* renegotiation: channels already exist */ }
      }
      return originalOffer(...args);
    };
    const originalAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = function (t, ...s) { s.forEach((st) => streams.add(st)); return originalAddTrack(t, ...s); };
    return pc;
  }
  PatchedPeerConnection.prototype = NativeRTC.prototype;
  Object.setPrototypeOf(PatchedPeerConnection, NativeRTC);
  window.RTCPeerConnection = PatchedPeerConnection;

  function liveChannels() {
    let best = null;
    for (const [pc, ch] of channelsByPeer) if (pc.connectionState !== 'closed' && ch.reliable && ch.reliable.readyState === 'open') best = ch;
    return best;
  }
  function status() {
    const ch = liveChannels();
    return { peers: peers.size, inputOpen: !!ch };
  }

  /** Ends everything: stops every media track, closes every data channel and peer connection. Safe to call twice. */
  function hardStop(reason) {
    for (const pc of Array.from(peers)) {
      try { pc.getSenders().forEach((s) => { if (s.track) s.track.stop(); }); } catch (_) { /* closed */ }
      try { pc.getReceivers().forEach((r) => { if (r.track) r.track.stop(); }); } catch (_) { /* closed */ }
      const ch = channelsByPeer.get(pc);
      if (ch) { try { ch.reliable && ch.reliable.close(); } catch (_) { /* closed */ } try { ch.pointer && ch.pointer.close(); } catch (_) { /* closed */ } }
      try { pc.close(); } catch (_) { /* closed */ }
      peers.delete(pc);
    }
    channelsByPeer.clear();
    streams.forEach((s) => { try { s.getTracks().forEach((t) => t.stop()); } catch (_) { /* gone */ } });
    streams.clear();
    if (activeCapture) { try { activeCapture.detach(); } catch (_) { /* detached */ } activeCapture = null; }
    // Also tell the page's own WebRTC module, so its state and the on-screen status follow
    try { if (window.ScopeDeskRTC && typeof window.ScopeDeskRTC.stop === 'function') window.ScopeDeskRTC.stop(reason || 'violation'); } catch (_) { /* module not ready */ }
    emitState();
  }

  /** Vendor: capture mouse + keyboard on `surface` and send them over the channels. Returns a handle with detach(). */
  function startVendorCapture({ surface, video }) {
    if (activeCapture) activeCapture.detach();
    const send = (message, kind) => {
      const ch = liveChannels();
      return ch ? IC.channelSender(ch.reliable, ch.pointer)(message, kind) : false;
    };
    if (!surface.hasAttribute('tabindex')) surface.setAttribute('tabindex', '0');
    activeCapture = IC.createCapture({ surface, video, send });
    return activeCapture;
  }

  // Desktop app: the host runtime asks the page to cut the stream (breach) or announces the lockdown
  if (window.scopedeskHost) {
    if (typeof window.scopedeskHost.onCloseRtc === 'function') window.scopedeskHost.onCloseRtc((d) => hardStop((d && d.reason) || 'violation'));
    if (typeof window.scopedeskHost.onLockdown === 'function') {
      window.scopedeskHost.onLockdown((d) => {
        hardStop('violation');
        window.dispatchEvent(new CustomEvent('scopedesk-host-lockdown', { detail: d || {} }));
      });
    }
  }

  window.ScopeDeskHub = {
    available: true,
    hardStop,
    startVendorCapture,
    status,
    onState(fn) { listeners.state.add(fn); return () => listeners.state.delete(fn); }
  };
}());
