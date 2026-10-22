'use strict';
// ICE server list handed to the browsers.
//
// STUN alone lets peers connect directly, and then the server can only *ask* them to hang up.
// With a TURN server (coturn, `use-auth-secret`) the media is relayed and the credentials below expire
// when the task window ends, so the stream dies at zero even if a peer ignores the close command.
//
// .env:  TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349   TURN_SECRET=<coturn static-auth-secret>
//        STUN_URL=stun:stun.l.google.com:19302   (optional)   TURN_FORCE_RELAY=false (optional)
const crypto = require('crypto');

function buildRtcConfig({ userId, expiresAtMs }) {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  const turnUrls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const secret = process.env.TURN_SECRET;
  const turn = turnUrls.length > 0 && !!secret;

  if (turn) {
    const username = `${Math.floor(expiresAtMs / 1000)}:${userId}`; // coturn REST-API convention: "<unix expiry>:<user>"
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }
  return {
    iceServers,
    iceTransportPolicy: turn && process.env.TURN_FORCE_RELAY !== 'false' ? 'relay' : 'all',
    hardExpiry: turn
  };
}

module.exports = { buildRtcConfig };
