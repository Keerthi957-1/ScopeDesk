#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
npm run prepare:agent || { echo "Host agent packages could not be installed. Check your internet connection and run this again."; exit 1; }
nohup ./node_modules/.bin/electron . >/dev/null 2>&1 &
