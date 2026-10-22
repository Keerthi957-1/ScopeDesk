// ScopeDesk WebRTC remote desktop.
//   Client: captures the screen (getDisplayMedia) and sends it.     Vendor: receives it and mirrors mouse/keyboard back.
// Signaling (offer/answer/ICE) goes through the authenticated Socket.IO connection the app already has.
// Input does NOT travel peer-to-peer: it goes vendor -> server -> host agent so the server can stop it the moment the
// timer ends or a violation is flagged (see server/remote-control.js).
(function () {
  let api = null, socket = null, onChange = () => {};
  let role = null, taskId = null, iceCfg = null;
  let pc = null, stream = null, pendingIce = [], retries = 0;
  let video = null, stage = null, detachInput = null;
  // Input path state. Vendor: the two data channels the Client's offer created. Client: the local bridge to the host agent.
  let dc = { ctl: null, mv: null }, hostBridgeReady = false, hostCtl = null;
  const BRIDGE_URL = 'ws://127.0.0.1:47600';
  const TOKEN_KEY = 'scopedesk_agent_token';
  const bridge = { ws: null, ready: false, token: null, timer: null, tries: 0 };
  const view = { conn: 'idle', agent: 'unknown', halted: null, shareSurface: null };

  const set = (patch) => { Object.assign(view, patch); onChange({ ...view, role, taskId }); };

  function init(opts) { api = opts.api; onChange = opts.onChange || onChange; }

  // Called by script.js every time it (re)creates the app socket
  function bindSocket(s) {
    socket = s;
    s.on('webrtc-peer-joined', (d) => { if (role === 'host' && d.role === 'vendor') makeOffer(); });
    s.on('webrtc-peer-left', () => { if (role === 'host') { closePeer(); set({ conn: 'waiting' }); } else set({ conn: 'waiting' }); });
    s.on('webrtc-signal', onSignal);
    s.on('webrtc-close', (d) => { if (taskId && d.taskId === taskId) stop(d.reason === 'security_violation' ? 'violation' : 'closed'); });
    s.on('agent-status', (d) => { if (d.taskId === taskId) set({ agent: d.online ? 'waiting' : 'offline' }); });
    s.on('agent-state', (d) => { if (d.taskId === taskId) set({ agent: d.state, policy: d.policy || view.policy }); });
    s.on('control-halt', (d) => { if (d.taskId === taskId) set({ halted: d.reason, locked: !!d.permanent }); });
    s.on('control-resume', (d) => { if (d.taskId === taskId) set({ halted: null, locked: false }); });
    // After a dropped connection the server forgot our room membership: join again
    s.on('connect', () => { if (role && taskId) join().catch(() => {}); });
  }

  const emitAck = (ev, payload) => new Promise((resolve) => socket.emit(ev, payload, resolve));

  async function join() {
    const res = await emitAck('webrtc-join', { taskId, role: role === 'host' ? 'client' : 'vendor' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not join the session.');
    const a = await emitAck('agent-status', { taskId });
    if (a && a.ok) set({ agent: a.online ? (a.state || 'waiting') : 'offline', halted: a.halted || null });
    if (role === 'host' && res.peers.includes('vendor')) makeOffer();
    else set({ conn: 'waiting' });
  }

  function newPeer() {
    closePeer();
    pc = new RTCPeerConnection({ iceServers: iceCfg.iceServers, iceTransportPolicy: iceCfg.iceTransportPolicy });
    pendingIce = [];
    pc.onicecandidate = (e) => { if (e.candidate && socket) socket.emit('webrtc-signal', { taskId, type: 'candidate', candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      const st = pc && pc.connectionState;
      if (st === 'connected') set({ conn: 'live' });
      else if (st === 'connecting') set({ conn: 'connecting' });
      else if (st === 'failed' || st === 'disconnected') {
        set({ conn: 'lost' });
        if (st === 'failed' && role === 'host' && retries < 3) { retries++; const mine = pc; setTimeout(() => { if (pc === mine && role === 'host') makeOffer(); }, 1000); }
      }
      if (st === 'connected') retries = 0;
    };
    // VENDOR side: the Client's offer carries two channels. 'ctl' = reliable + ordered (clicks, keys, wheel).
    // 'mv' = unordered, no retransmits (mouse moves: a late move is worthless, so never wait for it).
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label !== 'ctl' && ch.label !== 'mv') return;
      dc[ch.label] = ch;
      ch.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.t === 'bridge') hostBridgeReady = !!d.ready; } catch (_) { /* ignore */ } };
      ch.onclose = () => { if (dc[ch.label] === ch) dc[ch.label] = null; };
    };
    pc.ontrack = (e) => { if (video) { video.srcObject = e.streams[0]; video.play().catch(() => {}); } };
    return pc;
  }

  async function makeOffer() {
    if (role !== 'host' || !stream) return;
    const p = newPeer();
    const senders = stream.getTracks().map((t) => p.addTrack(t, stream)); // add tracks first, then create the offer
    // Data channels must exist before createOffer so they are part of the SDP. The Client only RECEIVES on them.
    hostCtl = p.createDataChannel('ctl', { ordered: true });
    const mv = p.createDataChannel('mv', { ordered: false, maxRetransmits: 0 });
    [hostCtl, mv].forEach((ch) => { ch.onmessage = (m) => forwardToAgent(m.data); });
    hostCtl.onopen = announceBridge;
    set({ conn: 'connecting' });
    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    socket.emit('webrtc-signal', { taskId, type: 'offer', offer });
    senders.filter((sn) => sn.track && sn.track.kind === 'video').forEach((sn) => {
      const prm = sn.getParameters();
      if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
      prm.encodings[0].maxBitrate = 4000000;
      prm.degradationPreference = 'maintain-resolution'; // keep text readable; drop frames instead
      sn.setParameters(prm).catch(() => {});
    });
  }

  async function onSignal(msg) {
    if (!msg || msg.taskId !== taskId) return;
    try {
      if (msg.type === 'offer' && role === 'viewer') {
        const p = newPeer();
        set({ conn: 'connecting' });
        await p.setRemoteDescription(msg.offer);
        await flushIce();
        const answer = await p.createAnswer();
        await p.setLocalDescription(answer);
        socket.emit('webrtc-signal', { taskId, type: 'answer', answer });
      } else if (msg.type === 'answer' && role === 'host' && pc) {
        await pc.setRemoteDescription(msg.answer);
        await flushIce();
      } else if (msg.type === 'candidate' && pc) {
        if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate); else pendingIce.push(msg.candidate);
      }
    } catch (err) { set({ conn: 'lost' }); }
  }

  async function flushIce() { for (const c of pendingIce) await pc.addIceCandidate(c); pendingIce = []; }

  // ---------- CLIENT: share the screen. Must be called from a click (browsers require a user gesture) ----------
  async function startHost(id) {
    stop();
    role = 'host'; taskId = id; set({ conn: 'starting', halted: null });
    try {
      // getDisplayMedia must be the FIRST await after the click: Chrome/Edge only allow it while the click's
      // "transient user activation" is fresh (~5 s). Fetching the ICE config before it can make the call fail.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',            // hint: open the picker on "Entire screen" (needed for remote control)
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1920 }, height: { ideal: 1080 }   // ideal only: hard limits can make capture fail
        },
        audio: false,
        monitorTypeSurfaces: 'include',         // Chromium extras; browsers that do not know them ignore them
        selfBrowserSurface: 'exclude',          // do not offer the ScopeDesk tab itself (avoids a mirror-in-mirror)
        surfaceSwitching: 'exclude'
      });
      iceCfg = await api(`/api/rtc-config?taskId=${id}`);
    } catch (err) {
      stop();
      const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      throw new Error(cancelled ? 'Screen sharing was cancelled. In the browser window, click the screen preview first, then press Share.' : (err.message || 'Could not start screen sharing.'));
    }
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';               // favour sharp text over smooth motion
    set({ shareSurface: (track.getSettings() || {}).displaySurface || null });
    track.onended = () => stop('stopped');      // the Client pressed the browser's "Stop sharing"
    await join();
  }

  // ---------- VENDOR: receive the screen and mirror input ----------
  async function startViewer(id, els) {
    stop();
    role = 'viewer'; taskId = id; video = els.video; stage = els.stage; set({ conn: 'starting', halted: null });
    iceCfg = await api(`/api/rtc-config?taskId=${id}`);
    attachInput();
    await join();
  }

  // The capture logic lives in remote-input.js; this only decides how each event travels
  function attachInput() {
    const send = (e, volatile) => {
      if (role !== 'viewer' || view.halted) return;
      const ch = e.t === 'move' ? dc.mv : dc.ctl;
      // Fast path: peer-to-peer data channel, used only when the Client's browser has a live link to the host agent
      if (hostBridgeReady && ch && ch.readyState === 'open') return ch.send(JSON.stringify(e));
      // Fallback: the server relay (still checked by the server on every event)
      if (socket && socket.connected) (volatile ? socket.volatile : socket).emit('remote-input', { taskId, e });
    };
    detachInput = window.ScopeDeskInput.attach({ stage, video, send });
  }

  // ---------- teardown ----------
  function closePeer() {
    if (pc) { try { pc.close(); } catch (_) { /* already closed */ } pc = null; }
    window.scopedeskPeer = null;
    pendingIce = [];
    dc = { ctl: null, mv: null }; hostBridgeReady = false; hostCtl = null;
  }

  function stop(reason) {
    closePeer();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (video) video.srcObject = null;
    if (detachInput) { detachInput(); detachInput = null; }
    if (socket && taskId && role) socket.emit('webrtc-leave', { taskId });
    const was = taskId;
    role = null; taskId = null; video = null; stage = null;
    set({ conn: reason || 'idle', agent: 'unknown', halted: null, shareSurface: null });
    return was;
  }

  // ---------- CLIENT: local bridge to the host agent ----------
  function announceBridge() {
    if (hostCtl && hostCtl.readyState === 'open') hostCtl.send(JSON.stringify({ t: 'bridge', ready: bridge.ready }));
  }
  // Raw JSON from the vendor's data channel goes to the agent untouched; the agent validates every event itself
  function forwardToAgent(raw) {
    if (typeof raw !== 'string' || raw.length > 200 || !bridge.ready || view.halted) return;
    bridge.ws.send(raw);
  }
  function setAgentToken(token) {
    bridge.token = token;
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_) { /* storage blocked: bridge works until reload */ }
    bridge.tries = 0;
    startBridge();
  }
  function startBridge() {
    if (!bridge.token) { try { bridge.token = sessionStorage.getItem(TOKEN_KEY); } catch (_) { /* ignore */ } }
    if (!bridge.token || bridge.ws) return;
    let ws;
    try { ws = new WebSocket(BRIDGE_URL); } catch (_) { return retryBridge(); }
    bridge.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: bridge.token }));
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch (_) { return; }
      if (d.t === 'ready') { bridge.ready = true; bridge.tries = 0; set({ agent: d.state || 'waiting' }); announceBridge(); }
      else if (d.t === 'state') set({ agent: d.state });
      // The agent saw a violation: hang up immediately, without waiting for the server
      else if (d.t === 'halt' && d.reason === 'violation' && role === 'host') stop('violation');
    };
    ws.onclose = () => { bridge.ws = null; if (bridge.ready) { bridge.ready = false; announceBridge(); } if (bridge.token) retryBridge(); };
    ws.onerror = () => { /* agent not running: the UI shows "Host agent: not running" */ };
  }
  function retryBridge() {
    clearTimeout(bridge.timer);
    bridge.timer = setTimeout(startBridge, Math.min(15000, 2000 * (++bridge.tries))); // back off so a missing agent is not hammered
  }
  function stopBridge() {
    clearTimeout(bridge.timer);
    bridge.token = null; bridge.tries = 0;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ }
    if (bridge.ws) { const w = bridge.ws; bridge.ws = null; w.close(); }
    bridge.ready = false;
  }

  window.ScopeDeskRTC = { init, bindSocket, startHost, startViewer, stop, setAgentToken, startBridge, stopBridge, isActive: () => !!role, current: () => ({ role, taskId }) };
})();
