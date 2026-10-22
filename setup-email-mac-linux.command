#!/bin/bash
cd "$(dirname "$0")"
npm install --no-audit --no-fund
node setup-email.js
