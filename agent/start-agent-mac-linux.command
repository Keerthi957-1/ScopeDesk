#!/bin/bash
# ScopeDesk host agent launcher (macOS / Linux). Run this on the CLIENT's computer, not the vendor's.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Install it from https://nodejs.org and run this again."; exit 1; }
[ -d node_modules ] || { echo "Installing the agent for the first time..."; npm install || exit 1; }
export SERVER_URL="${SERVER_URL:-http://localhost:3000}"
echo
echo 'In ScopeDesk click "Pair host agent", then copy the token shown under "Easiest".'
read -r -p "Paste the token here and press Enter: " SCOPEDESK_AGENT_TOKEN
[ -n "$SCOPEDESK_AGENT_TOKEN" ] || { echo "No token entered."; exit 1; }
export SCOPEDESK_AGENT_TOKEN
echo "Starting the agent. Leave this window open during the session."
node client-agent.js
