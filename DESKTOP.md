# ScopeDesk desktop app

## Run it (development)
- Windows: double-click `start-desktop-windows.bat`
- Mac/Linux: run `start-desktop-mac-linux.command`

First run installs packages (needs internet and Node.js 22.13+). After that the app opens by itself: it starts the
server in the background, shows the dashboard, and starts the host agent when a live session begins.
No terminal, no token to copy.

## Build an installer for end users
`npm run dist` creates the installer in the `dist` folder (.exe on Windows, .dmg on Mac, AppImage on Linux).

## Using a hosted server
Real vendors on other computers need a server they can reach. Host `server.js` somewhere, then start the desktop
app with the environment variable `SCOPEDESK_SERVER_URL=https://your-server`. The app then skips its own local server.

## Remote control safety (built in, please keep)
- Remote control runs only while the ScopeDesk window is open. Closing it stops the agent.
- The window title shows REMOTE CONTROL ACTIVE and a system notification appears; "Stop remote control" ends it at once.
- The agent still limits control to the task's approved app/folders and time window, and locks on any violation.

## Check any copy of the project for old popups
`node tools/find-alerts.js "C:\path\to\folder"` lists every alert()/prompt() and the old "webrtc.js is running" text.
