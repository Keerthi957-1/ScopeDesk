# ScopeDesk: Secure Task-Bounded Remote Support

Clients create a task (allowed app + time window) and get a one-time token. A Vendor enters the token to start a session.
If the vendor's monitor detects an out-of-bounds app, the **Client** gets an alert with a **Terminate Session Now** button.

## Easiest way to run it
- Windows: double-click `start-windows.bat`
- Mac/Linux: run `start-mac-linux.command`

It installs what is needed on first run, starts the server and opens the browser. Keep its window open while you use ScopeDesk.

## Run it manually
1. Install Node.js 22.13 or newer (https://nodejs.org)
2. In this folder: `npm install`
3. `npm start`
4. Open http://localhost:3000

Demo accounts (password `Password123!`): `office_admin` (client), `it_vendor` (vendor).
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
The link in the email opens `APP_URL` (default `http://localhost:3000`), so set `APP_URL` if people open ScopeDesk from another computer.

## Open ScopeDesk only through the server
Both the Client and the Vendor must open **http://localhost:3000** (or http://<client-PC-address>:3000 from another computer). Do not use VS Code Live Server (port 5500) or open an HTML file directly: those are not the app served by `npm start`. Use a second browser profile or a private window for the second account (logins are per tab).

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
