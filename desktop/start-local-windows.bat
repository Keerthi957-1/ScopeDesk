@echo off
REM ScopeDesk LOCAL TEST launcher (Windows). For trying the app on this computer. The live app runs on Railway (see RAILWAY.md).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)" || (echo Your Node.js is too old. Install the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (
  echo Installing for the first time, this takes a minute...
  call npm install --no-audit --no-fund || (echo npm install failed. Check your internet connection. & pause & exit /b 1)
)
echo.
netstat -ano | findstr ":3000 " | findstr LISTENING >nul && echo NOTE: an older ScopeDesk is still running on port 3000. This launcher uses port 3100 so it cannot clash with it. Close the old black window when you can.
echo ScopeDesk is starting. Your browser opens at http://localhost:3100
echo Use ONLY that address. Keep this window open while testing; close it to stop.
echo Demo sign-in: office_admin / Password123!   (or create your own account)
echo.
set PORT=3100
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3100"
node server.js
pause
