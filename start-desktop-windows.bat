@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist node_modules call npm install --no-audit --no-fund
if not exist agent\node_modules call npm --prefix agent install --no-audit --no-fund
if not exist node_modules\electron\dist\electron.exe (
  echo Electron did not install. Check your internet connection and run this again.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
