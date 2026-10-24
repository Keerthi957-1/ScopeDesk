@echo off
REM ScopeDesk host agent launcher (Windows). Run this on the CLIENT's PC, not the vendor's.
REM It connects to the live ScopeDesk server (Railway). No server runs on this computer.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (
  echo Installing the agent for the first time, this takes a minute...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)
echo.
echo In ScopeDesk click "Pair host agent". It shows the server address and a token.
if "%SERVER_URL%"=="" set /p SERVER_URL=Paste the server address (for example https://your-app.up.railway.app) and press Enter: 
if "%SERVER_URL%"=="" (echo No server address entered. & pause & exit /b 1)
set /p SCOPEDESK_AGENT_TOKEN=Paste the token here and press Enter: 
if "%SCOPEDESK_AGENT_TOKEN%"=="" (echo No token entered. & pause & exit /b 1)
echo.
echo Starting the agent. Leave this window open during the session. Close it to stop remote control.
node client-agent.js
pause
