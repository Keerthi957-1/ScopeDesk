@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a==22&&b>=13)?0:1)"
if errorlevel 1 (
  echo Your Node.js is too old. ScopeDesk needs 22.13 or newer. Install the LTS version from https://nodejs.org then run this again.
  node -v
  pause
  exit /b 1
)
echo Checking packages...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo npm install failed. Check your internet connection, then run this again.
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
echo Starting ScopeDesk. Keep this window open. Press Ctrl+C to stop.
node server.js
echo.
echo ScopeDesk stopped. Read the message above to see why.
pause
