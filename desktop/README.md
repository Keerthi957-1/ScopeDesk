# ScopeDesk: Secure Task-Bounded Remote Support

Clients create a task (allowed app + time window) and get a one-time token. A Vendor enters the token to start a session.
If the vendor's monitor detects an out-of-bounds app, the **Client** gets an alert with a **Terminate Session Now** button.

## How it runs
ScopeDesk runs on **Railway** (see `RAILWAY.md`). Open your Railway address in a browser, or use the desktop app (`DESKTOP.md`).
No server, `.bat` file or terminal is needed on users' computers.

To try it on your own computer first: double-click `start-local-windows.bat` (Mac/Linux: `start-local-mac-linux.command`). It installs what is needed, starts a local copy and opens http://localhost:3100 (its own port, so an older ScopeDesk window cannot get in the way). The bottom-right corner of the page shows `build 2026-10-24-a`; if you do not see it, you are looking at old files. Use only that address, not VS Code Live Server.

Demo accounts exist only in a local development database (password `Password123!`; never created in production): `office_admin` (client), `it_vendor` (vendor).
The two seeded demo tokens expire 30-45 minutes after the database is first created, so create a fresh task to test.

## Run a real remote session
1. **Client PC:** `cd agent && npm install` once. Sign in as `office_admin`, create a task (approved app, e.g. `billing.exe`, and a time window).
2. **Vendor** (`it_vendor`, other browser or PC): click **Accept & Connect**. The countdown starts on both sides.
3. **Client:** a dialog asks to share the screen. Choose **Entire screen**. Open the approved app.
4. **Client:** click **Pair host agent**, copy the command, run it in the `agent` folder. The live bar shows *Host agent: enforcing* once the approved app is in front.
5. **Vendor:** click the remote screen to take control. Mouse, wheel and keyboard are mirrored.
6. Bring any other app to the front (Chrome, Explorer...) and the Client sees the red alert with **Terminate Session Now**. Control halts at once; the stream is cut unless `AUTO_CUT_STREAM=false`.
7. At 00:00 the server ends the task, tells both browsers to close the peer connection, stops input and stops the agent.

## How it is built
- `server/session-timers.js` one timer per task, fires at the exact end of the window.
- `server/remote-control.js` validates and relays vendor input to the agent, halts it on violation or expiry, rate limits it.
- `server/rtc-config.js` ICE servers. With `TURN_URLS` + `TURN_SECRET` set, relay credentials expire with the task, so the media really stops at zero.
- `public/webrtc.js` screen capture (Client), stream receiver + input capture (Vendor), signaling over the app's Socket.IO link.
- `public/status-monitor.js` the in-page banner shown when the server is unreachable.
- `agent/monitor.js` the foreground-app security loop, `agent/input-injector.js` applies input, `agent/client-agent.js` wires them together.

Notes: the agent needs OS permissions on first run (macOS: Screen Recording and Accessibility; Linux: X11, Wayland is not supported by nut-js). A violation is only blamed on the vendor if vendor input was applied just before the window changed (`ATTRIBUTION_MS`), so the Client can use their own browser to read the alert.

## Vendors (client side)
- Click **Approved Partner Agencies** to see every vendor account. From there you can **Request task**, **Report**, or **Terminate access**.
- The task form lists all vendor accounts. A request sent to a vendor shows up on that vendor's dashboard with **Accept & Connect**.
- **Terminate access** ends that vendor's live sessions with you, revokes their pending requests, and blocks them from your tasks until you click **Restore access**. It does not delete their account, because other clients may use them.
- **Report** saves a report (reason + details) in the database for administrator review.

## Password reset emails (real email)
Easiest: double-click `setup-email-windows.bat` (or run `setup-email-mac-linux.command`, or `npm run setup-email`). It asks for your Gmail address and App Password, sends you a test email, and saves the settings.

Manual way:
"Forgot password?" emails the user a link that works for 30 minutes. To turn on real email (Gmail example):
1. In your Google Account: Security, turn on **2-Step Verification**, then search for **App passwords** and create one. Copy the 16 letters.
2. In this folder, copy `.env.example` to a new file named `.env`.
3. Fill in `SMTP_USER` (your Gmail address), `SMTP_PASS` (the app password) and `MAIL_FROM`.
4. Run `npm install`, then restart ScopeDesk. The console should say `[MAIL] Email is ready`.

Until `.env` is filled in, no email is sent. The reset link is printed in the console and shown on the page so you can still test.
The link in the email opens `APP_URL`. On Railway it defaults to your generated domain.

## Open ScopeDesk only through the server
Both the Client and the Vendor open your Railway address (or the desktop app). Do not use VS Code Live Server or open an HTML file directly. Use a second browser profile or a private window for the second account (logins are per tab).

## Staying signed in
Logins last 7 days and renew automatically while you are using the app. Tasks have their own time window, and a task expiring never signs you out.

## Folder layout
- `server.js`: API + Socket.IO. `db.js`: SQLite. `public/`: the web UI (only this folder is served).
- `.jwt_secret` is created on first run. Never commit it or share it.

## Live screen
See "Run a real remote session" above.

## Remote control: data channel + local bridge
- The Client's offer creates two RTCDataChannels: `ctl` (ordered, reliable: clicks, keys, wheel) and `mv` (unordered, `maxRetransmits:0`: mouse moves).
- The Vendor sends JSON on them. The Client's browser cannot touch the OS, so it forwards each message unchanged to the agent over `ws://127.0.0.1:47600` (local only, Origin-checked, pairing token verified by the server).
- If the channel or bridge is not up, the Vendor automatically falls back to the server relay.
- Message formats: `{"t":"move","x":0.42,"y":0.11}` · `{"t":"down"|"up","x":..,"y":..,"b":0|1|2}` · `{"t":"wheel","dx":0,"dy":120}` · `{"t":"key","k":"KeyA","d":true|false}`. Host to vendor on `ctl`: `{"t":"bridge","ready":true}`. Agent to browser on the bridge: `{"t":"ready"|"state"|"halt",...}`.
- Vendor stays read-only until the agent is `enforcing`, which needs the approved app in front. Run the agent with `DEBUG_FOREGROUND=true` to see the exact name `active-win` reports and set the task's approved app to match.

## Task policies: which apps and folders the vendor may use
`agent/policies.json` maps a **task type** to what is allowed on the Client's PC:
```json
{ "Billing": { "allowedApps": ["explorer.exe", "excel.exe"],
               "allowedPaths": ["C:\\BillingData", "C:\\Users\\Public\\Invoices"] } }
```
Choose the type (e.g. `Billing`) when creating the task. The task's own approved app is always allowed too. With `allowedPaths`, every folder shown by the file manager (Explorer, or Finder on macOS) must be inside one of them (the folder itself or anything below it). Explorer with several tabs: ALL tabs must be in scope. The desktop and taskbar count as out of scope; dialogs such as Properties or Delete do not. A task type with no entry in `policies.json` falls back to app-only mode.

**Test it before a real session:** `cd agent && TASK_TYPE=Billing TARGET=billing.exe npm run probe` (Windows: `set TASK_TYPE=Billing&& set TARGET=billing.exe&& npm run probe`). Click around in Explorer and watch the verdicts. If a verdict looks wrong, fix `policies.json` before you rely on it.

When a rule is broken, in this order: the agent freezes input, tells the Client's browser to hang up, and reports to the server, which shows the alert with the exact app or folder, sends a browser notification (click **Enable alerts** once) and offers **Terminate Access**.

### What this does NOT do (read this)
- **It is a tripwire, not a wall.** The breach is detected after it happens: for up to about half a second the vendor can see the out-of-scope folder before input freezes and the stream is cut. For real protection of sensitive data, ALSO use the operating system: run the session in a restricted Windows user account, or deny that account access to everything but the allowed folders (NTFS permissions).
- Only the file manager's folder is checked. File Open/Save dialogs inside an allowed app (for example Excel) can browse anywhere and are not tracked.
- A shortcut or junction inside an allowed folder that points elsewhere looks like an allowed folder.
- Folder checks work on Windows and macOS (Finder). On Linux the agent refuses to start a folder-restricted task instead of running a weaker check.

## Per-session policy file and Calculator
Instead of `policies.json` you can give the agent a file for exactly one session (`agent/session.example.json`):
```json
{ "taskId": 14, "scope": "Fix Billing Software Invoice PDF Export Engine Error",
  "allowedProcesses": ["explorer.exe", "calc.exe", "notepad.exe"],
  "allowedDirectories": ["C:\\BillingData", "C:\\Program Files\\BillingEngine"] }
```
Windows:  `set SESSION_CONFIG=session.example.json&& set SCOPEDESK_AGENT_TOKEN=<token>&& npm start`. The agent refuses to start if `taskId` is not the task it is paired with. Anything not listed (cmd.exe, PowerShell, browsers) is out of scope. `calc.exe`, `CalculatorApp.exe` and "Calculator" are treated as the same app, because the Windows 10/11 Calculator window does not belong to `calc.exe`. Run `npm run probe` with Calculator open to see the exact name your PC reports.

## Lockout after a violation
By default a violation locks the vendor out **for good**: input is frozen, the peer connection is closed, the vendor cannot rejoin the stream, and the Client's only choice is **Terminate Connection**. Set `ALLOW_RESUME_AFTER_VIOLATION=true` in `.env` to give the Client a "Resume session" button instead.

## Testing: use TWO computers
Remote control cannot be tested with the Client and the Vendor on the same PC. The vendor's browser is then the window in front, it is not an approved app, and the first click is (correctly) treated as a violation; the vendor's mouse would also fight with yours. Run the Client on one PC and open `http://<client-PC-address>:3000` on a second computer or phone for the Vendor (the server listens on all interfaces; allow it through the firewall).

## Any kind of task: custom scope
The ticket form's first list has a **Custom task...** entry: type any description, then say what the vendor may touch:
- **Allowed folders** (one per line, full paths; `%ENV%` and `~` work). The vendor can open only these folders and their sub-folders in the file manager. The file manager is allowed automatically when you list folders. A whole drive (`C:\`) is rejected so a slip cannot open everything.
- **Extra allowed applications** (comma separated). Anything else that comes to the front is a violation.
- **Task type** is optional. Pick one (Billing, Printer, ERP, VPN, Email, Documents or your own in `agent/policies.json`) to start from a ready list; your custom folders/apps are added on top.

The lists are saved with the ticket and delivered to the host agent when it pairs; only the Client can create or change a ticket, and vendors never see the folder names. `Printer`, `ERP`, `VPN` and `Email` in `policies.json` are starting points: edit the paths to match this PC.
**Limit to know:** folder checks cover the file manager. An app on the allowed list (Excel, Notepad, mmc.exe...) can still show its own Open/Save dialog, which this agent does not inspect. Allow only apps you are comfortable with, and use Windows folder permissions for anything that must be impossible to reach.
Run the agent tests with `cd agent && npm test`.

## Task types are case-insensitive
`Billing`, `billing`, `BILLING` and ` Billing ` are the same task type everywhere: the ticket form, the server and the host agent all compare names trimmed, with inner spaces collapsed and without case (`normalizeKey`). The type is stored in the spelling used in `agent/policies.json`. App names ignore case and `.exe`. Folder paths on Windows and macOS are compared without case; on Linux they stay case-sensitive, because `/Data` and `/data` are different folders there.

- **At ticket creation** the server checks the type against `agent/policies.json` when it can read that file (same project folder, or `POLICY_FILE=` in `.env`). A typo is rejected with the list of valid types. If the server cannot see the file, the agent decides.
- **In the form**, the type list comes from the policy file, and choosing a scope that ends in a known category, e.g. "... (Billing)", fills the type in for you.
- **On the dashboard** the live bar shows the policy the agent actually loaded, e.g. `enforcing (policy: Billing)`. `(app only)` means no folder policy was found: only the approved app is allowed and the file manager will be a violation.

## Starting the host agent the easy way
On the Client's PC, double-click `agent/start-agent-windows.bat` (or `start-agent-mac-linux.command`). It installs what it needs the first time, asks for the token (click **Pair host agent** in the dashboard, copy the token shown under "Easiest") and starts the agent. Until the live bar says `Host agent: enforcing`, the vendor is view-only.
