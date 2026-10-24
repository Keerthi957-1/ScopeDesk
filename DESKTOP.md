# ScopeDesk desktop app

## Point it at your live server (once)
Put the live ScopeDesk address in `desktop/app-config.json`:
```json
{ "serverUrl": "https://your-app.up.railway.app" }
```
(or set the `SCOPEDESK_SERVER_URL` environment variable). The address must be `https://`. The app is a pure client: it
does **not** start a server on your computer, and shows a clear message if the address is missing or the server cannot be reached.
For development only, `SCOPEDESK_LOCAL_SERVER=1` starts a local server instead.

## Run it (development)
- Windows: double-click `start-desktop-windows.bat`
- Mac/Linux: run `start-desktop-mac-linux.command`

First run installs packages (needs internet and Node.js 22.13+). After that the app opens by itself, shows the dashboard from
the live server, and starts the host agent when a live session begins. No terminal, no token to copy.

## Build an installer for end users
`npm run dist` creates the installer in the `dist` folder (.exe on Windows, .dmg on Mac, AppImage on Linux). The address in
`desktop/app-config.json` is baked in, so set it before building.

## Remote control safety (built in, please keep)
- Remote control runs only while the ScopeDesk window is open. Closing it stops the agent.
- The window title shows REMOTE CONTROL ACTIVE and a system notification appears; "Stop remote control" ends it at once.
- The agent still limits control to the task's approved app/folders and time window, and locks on any violation.

## Check any copy of the project for old popups
`node tools/find-alerts.js "C:\path\to\folder"` lists every alert()/prompt() and the old "webrtc.js is running" text.
