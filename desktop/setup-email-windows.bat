@echo off
cd /d "%~dp0"
call npm install --no-audit --no-fund
node setup-email.js
pause
