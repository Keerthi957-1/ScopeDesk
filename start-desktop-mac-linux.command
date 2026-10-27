#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
[ -d agent/node_modules ] || npm --prefix agent install --no-audit --no-fund
nohup ./node_modules/.bin/electron . >/dev/null 2>&1 &
