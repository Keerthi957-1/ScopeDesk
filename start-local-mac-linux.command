#!/bin/bash
# ScopeDesk LOCAL TEST launcher (macOS / Linux). For trying the app on this computer. The live app runs on Railway (see RAILWAY.md).
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."; exit 1; }
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)" || { echo "Your Node.js is too old. Install the LTS version from https://nodejs.org"; exit 1; }
[ -d node_modules ] || { echo "Installing for the first time..."; npm install --no-audit --no-fund || exit 1; }
echo
echo "ScopeDesk is starting. Your browser opens at http://localhost:3100. Use ONLY that address."
echo "Demo sign-in: office_admin / Password123!   (or create your own account)"
export PORT=3100
(sleep 4; open http://localhost:3100 2>/dev/null || xdg-open http://localhost:3100 2>/dev/null) &
node server.js
