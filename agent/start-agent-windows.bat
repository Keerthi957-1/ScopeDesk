@echo off
REM ScopeDesk host agent launcher (Windows). Run this on the CLIENT's PC, not the vendor's.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (
  echo Installing the agent for the first time, this takes a minute...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)
if "%SERVER_URL%"=="" set SERVER_URL=http://localhost:3000
echo.
echo In ScopeDesk click "Pair host agent", then copy the token shown under "Easiest".
set /p SCOPEDESK_AGENT_TOKEN=Paste the token here and press Enter: 
if "%SCOPEDESK_AGENT_TOKEN%"=="" (echo No token entered. & pause & exit /b 1)
echo.
echo Starting the agent. Leave this window open during the session. Close it to stop remote control.
node client-agent.js
pause
