# ScopeDesk desktop app

The desktop app opens your live ScopeDesk server (the Railway address in `public/app-config.json`) in its own window and
runs the host agent during a session. Nothing else runs on the computer: no server, no terminal.

## Set up
1. Put your Railway address in `public/app-config.json` (see `RAILWAY.md`).
2. Development: double-click `desktop/start-desktop-windows.bat` (Mac/Linux: `desktop/start-desktop-mac-linux.command`). First run installs packages (needs Node.js 22.13+).
3. For users: `cd desktop` then `npm run dist` creates the installer in `desktop/dist` (.exe, .dmg or AppImage). Users just install and open it.

To try a different server without editing files, set `SCOPEDESK_SERVER_URL` (https only, except localhost).

## Remote control safety (built in, please keep)
- Remote control runs only while the ScopeDesk window is open. Closing it stops the agent.
- The window title shows REMOTE CONTROL ACTIVE and a system notification appears; "Stop remote control" ends it at once.
- The agent limits control to the task's approved app/folders and time window, and locks on any violation.

## Check any copy of the project for old popups
`node tools/find-alerts.js "C:\path\to\folder"`
