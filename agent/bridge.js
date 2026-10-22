'use strict';
// LOCAL BRIDGE. Data channel events land in the Client's BROWSER, but only the agent can drive the OS.
// The browser forwards them here over ws://127.0.0.1:<port>. Protection, in order:
//   1. bound to 127.0.0.1 only (not reachable from the network)
//   2. the page's Origin must be the ScopeDesk server's origin (other websites are refused)
//   3. the first message must carry the pairing token, which the SERVER confirms is valid for this task and client
//   4. size and rate limits; every event is schema-checked again before use
const { WebSocketServer } = require('ws');

function startBridge({ port, allowedOrigins, verifyToken, onInput, getState, log }) {
  const wss = new WebSocketServer({
    host: '127.0.0.1', port, maxPayload: 512,
    verifyClient: (info) => allowedOrigins.has(info.origin)
  });
  wss.on('error', (e) => log('warn', `Local bridge could not start on port ${port}: ${e.message}. The vendor will use the server relay instead.`));
  wss.on('listening', () => log('info', `Local bridge listening on 127.0.0.1:${port}`));

  wss.on('connection', (ws) => {
    let authed = false, windowStart = 0, count = 0;
    const timeout = setTimeout(() => { if (!authed) ws.close(); }, 5000);
    ws.on('close', () => clearTimeout(timeout));
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (!authed) {
        if (msg.t !== 'hello' || typeof msg.token !== 'string') return ws.close();
        verifyToken(msg.token, (ok) => {
          if (!ok) return ws.close();
          authed = true; ws.authed = true;
          ws.send(JSON.stringify({ t: 'ready', state: getState() }));
        });
        return;
      }
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count > 400) return;           // flood guard
      onInput(msg);
    });
  });

  return {
    broadcast(obj) { const data = JSON.stringify(obj); wss.clients.forEach((c) => { if (c.authed && c.readyState === 1) c.send(data); }); },
    close() { wss.close(); }
  };
}
module.exports = { startBridge };
