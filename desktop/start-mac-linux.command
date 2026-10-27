#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org then run this again."
  read -p "Press Enter to close..."; exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a==22&&b>=13)?0:1)"; then
  echo "Your Node.js ($(node -v)) is too old. ScopeDesk needs 22.13 or newer. Install the LTS version from https://nodejs.org"
  read -p "Press Enter to close..."; exit 1
fi
echo "Checking packages..."
npm install --no-audit --no-fund || { echo "npm install failed. Check your internet connection."; read -p "Press Enter to close..."; exit 1; }
( sleep 3; (open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null) ) &
echo "Starting ScopeDesk. Keep this window open. Press Ctrl+C to stop."
node server.js
echo
echo "ScopeDesk stopped. Read the message above to see why."
read -p "Press Enter to close..."
