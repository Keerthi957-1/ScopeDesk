@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist node_modules call npm install --no-audit --no-fund
echo Checking host agent packages...
call npm run prepare:agent
if errorlevel 1 (
  echo Host agent packages could not be installed. Check your internet connection, then run this again.
  pause
  exit /b 1
)
if not exist node_modules\electron\dist\electron.exe (
  echo Electron did not install. Check your internet connection and run this again.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
