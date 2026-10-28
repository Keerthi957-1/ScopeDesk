# Update 6: cross-OS shortcuts, folder auditing for Explorer / Finder, macOS lock chain, TURN aliases

| File | Change |
|---|---|
| `server/rtc-config.js` | Accepts `TURN_URL` (single address) as well as `TURN_URLS`, `TURN_PASSWORD` as well as `TURN_CREDENTIAL`; a bare `turn:host:3478` is tried over UDP and TCP; with `TURN_SECRET`, `TURN_USERNAME` becomes a label in the minted username |
| `agent/input-executor.js` | Windows vendor -> Mac host: Ctrl is pressed as Command (Ctrl+C/V/A/Z... work). Mac vendor -> Windows host: Cmd+A/C/V/X/Z/Y/F/S/P/N/O is pressed as Ctrl+letter. Ctrl+Q / Ctrl+Space / Ctrl+Tab are blocked on a Mac host (they would become Cmd+Q etc.). The Windows key and all other Meta shortcuts stay blocked |
| `agent/sandbox-guard.js` | macOS lock tries `CGSession -suspend` first, then `pmset displaysleepnow`. Windows is unchanged (`rundll32.exe user32.dll,LockWorkStation`) |
| `agent/native/windows-foreground.ps1` | When Explorer is in front, also reports the folder it shows |
| `agent/native/macos-foreground.js` | When Finder is in front, also reports its front window's POSIX folder |
| `agent/foreground-monitor.js` | File manager is allowed only while it shows an approved folder or a sub-folder; anything else is a `path` breach (same lockdown as an unapproved app). Virtual views (This PC, Quick access, Recents) are ignored until a real folder opens. No approved folders = no folder policy |
| `agent/host-runtime.js` | Passes the approved folders to the monitor |
| `test/cross-platform.test.js` (new) | 8 tests (74 total pass) |

macOS asks once to let ScopeDesk control Finder (Privacy & Security > Automation). Without it, Finder is checked as an app only.

Not run here (no Windows or Mac machine, no network): the PowerShell and JXA probes, a real lock, a real TURN relay. The logic around them is tested with simulated probes.

**About "Host agent: could not start: Node.js v22.21.1":** that text is the last line Node prints after a crash, so the real error is just above it. The message comes from the OLD agent path (a separate `node` process), which is not in this zip. The new in-app host (`agent/electron-glue.js`) runs inside Electron's own Node and has no native modules. Your screen still shows the old path, so your `desktop/main.js` and `desktop/preload.js` do not yet call `registerHostIpc` / `exposeHostApi`. Those two files were not in the upload.

---

# Update 5: email through Brevo (Railway blocks Gmail's SMTP port)

Railway log showed `Could not send the verification code: Connection timeout`: free/Hobby Railway plans block SMTP (587/465), so Gmail can never be reached from there.

| File | Change |
|---|---|
| `server/mailer.js` | If `BREVO_API_KEY` is set, codes are sent over HTTPS through Brevo (never blocked). Sender = `BREVO_SENDER_EMAIL`, else the address in `MAIL_FROM`. SMTP/Gmail still works when no Brevo key is set (your own PC) |
| `.env.example` | Brevo settings documented |
| `test/brevo-mailer.test.js` (new) | 3 tests (66 total pass) |

Railway Variables to add: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` (the address you verified in Brevo). You can delete the four `SMTP_` variables.
Not run: a real Brevo send (no network here).

---

# Update 4: friendlier message + short route names

| File | Change |
|---|---|
| `public/script.js` | When email is not connected on a hosted server the sign-up form now says "Sign-up is temporarily unavailable. Please try again later." (no "contact the administrator") |
| `server.js` | Added aliases: `POST /api/verify-signup-otp`, `POST /api/forgot-password`, `POST /api/reset-password`. Reset also accepts `otpCode` and `newPassword` besides `code` and `password` |

The red box itself goes away only when the server has a mail login: set `SMTP_USER` and `SMTP_PASS` (a Gmail App Password) in Railway > Variables, or in `.env` on your PC, then redeploy/restart.

Tests: 63 of 63 pass; `server.js` and `script.js` pass a syntax check. Not run: booting `server.js` and a real SMTP login.

---

# Update 3: seamless sign-up with a 6-digit code (no terminal)

Why the red banner appeared: the server had no SMTP login (`SMTP_USER` / `SMTP_PASS`), and no code can invent one. It disappears once a login exists, and you can now enter it **inside the app**.

| File | Change |
|---|---|
| `server/otp.js` (new) | 6-digit code (crypto random), keyed hash only, **15-minute** expiry, 5 wrong tries then dead, new code cancels old ones |
| `server/mail-settings.js` (new) | in-app email settings saved to `mail-settings.json` (owner-only); env/.env always wins; only the server's own computer, never in production, only while email is unconfigured |
| `server/mailer.js` | professional HTML email (code in a highlighted box, 15 min), `testSmtpLogin` (logs in without sending), `explainSmtpError` (plain sentences, e.g. "use a Google App Password") |
| `db.js` | `users.status` (`PENDING_VERIFICATION` -> `ACTIVE`), migrated from the previous flag |
| `server.js` | `POST /api/register` (+ old paths) creates the account as `PENDING_VERIFICATION` and emails the code; `POST /api/verify-otp` activates it **and returns the login token**; `POST /api/resend-otp` with a server-enforced 60 s cooldown; `GET/POST /api/setup/mail`; mailer reloads without a restart |
| `public/index.html`, `public/style.css`, `public/script.js` | "Verify Your Account" screen: your email in the text, 6 segmented boxes (auto-advance, paste, backspace), red error under the boxes ("Incorrect or expired code. Please try again."), **Verify & Activate**, **Resend Code (59s)**; success goes straight to the dashboard. "Connect email" screen offered automatically when email is not connected |
| `.gitignore` (new) | keeps `.env`, `mail-settings.json`, the database out of git |
| `test/otp-and-setup.test.js` (new) | 10 tests (63 total pass), incl. OTP against a real SQLite engine and an HTML/JS element-id cross-check |

Not run here: a real SMTP login, or `server.js` itself (needs `express`, `socket.io`, `bcryptjs` and the modules missing from the upload). The new SQL was run against the real schema.

---

# Update 2: email verification, cross-network streaming, input control, breach guard

Install once: `npm install nodemailer socket.io-client` (socket.io-client is only needed by the desktop app). Copy `.env.example` to `.env`.

## 1. Email
| File | Change |
|---|---|
| `server/email-check.js` (new) | strict address parsing, disposable-domain block, "did you mean gmail.com", DNS check (MX, then A/AAAA; a DNS outage never blocks a real person) |
| `server/mailer.js` | `sendVerificationCode`, `isPermanentRecipientFailure` (SMTP 5xx on the recipient) |
| `db.js` | `users.email_verified` (existing accounts stay verified), `email_verifications` table |
| `server.js` | register: validate -> create account **unverified** -> email a 6-digit code (hash only stored, 30 min, 5 wrong tries); `POST /api/auth/verify-email`, `POST /api/auth/resend-verification`; login refuses unverified accounts (`EMAIL_NOT_VERIFIED`); forgot/reset only for verified accounts; unverified leftovers are replaceable and purged after 24 h; a mailbox the mail server rejects (5xx) removes the account again; no SMTP = 503, no account |
| `public/index.html`, `public/script.js` | "Verify your email" step after sign-up and after a sign-in attempt on an unverified account |

Verification uses `users.email_verified`, not `is_active`: `is_active = 0` already means "deactivated by an administrator", and mixing the two would let a deactivated account re-activate itself by verifying.

## 2. Cross-network WebRTC and remote input
| File | Change |
|---|---|
| `server/rtc-config.js` | STUN (Google, Cloudflare) + TURN from `.env`; `TURN_SECRET` mints credentials that expire with the task window; start-up line says whether TURN is set |
| `public/rtc-channel-hub.js` (new, load before `webrtc.js`) | wraps `RTCPeerConnection`: adds public STUN if a config has none, creates the two input data channels before every offer, registers every peer / track / channel so `hardStop()` really ends the stream |
| `public/remote-input-channel.js` (new) | protocol + validator (shared by both ends), vendor capture with letter-box-aware pointer scaling (0..1 of the real screen), throttled moves, clicks, wheel, key strings |
| `agent/input-executor.js`, `agent/native/windows-input.ps1`, `agent/native/macos-input.js` (new) | native input: Windows SendInput, macOS CoreGraphics, Linux xdotool (X11). Drops Win/Super keys, Alt+Tab, Alt+F4, Ctrl+Esc, Cmd+Q/Tab/Space |
| `agent/electron-glue.js` (new) | `registerHostIpc` for Electron main, `exposeHostApi` for the preload (`window.scopedeskHost`) |
| `public/script.js` | uses `scopedeskHost.hostStart` when present; starts vendor capture after the viewer connects |

## 3. Sandbox guard and forced termination
| File | Change |
|---|---|
| `agent/foreground-monitor.js`, `agent/native/windows-foreground.ps1`, `agent/native/macos-foreground.js` (new) | watches the foreground program for the whole approved window (Store apps resolved to the real app), breach if an unapproved program stays in front > 350 ms, once |
| `agent/host-runtime.js` (new) | guard + monitor + executor. Breach order: input stops -> every track / peer closed -> PC locked + local full-screen alert + persistent notification -> `host-violation` to the server (which ends the task and the vendor's session) |
| `agent/app-catalog.js` | WhatsApp added; `filemanager` / `file-manager` match File Manager |

## Wiring in the desktop app (3 lines)
```js
// main process
const { registerHostIpc } = require('./agent/electron-glue');
registerHostIpc({ ipcMain, Notification, getWindow: () => mainWindow, serverUrl: SERVER_URL });
// preload
require('./agent/electron-glue').exposeHostApi({ contextBridge, ipcRenderer });
```
`remote-viewport.html` (the vendor's full-screen window) must also load `remote-input-channel.js` and `rtc-channel-hub.js` before its WebRTC script, then call `ScopeDeskHub.startVendorCapture({ surface, video })` once the stream plays.

## Not verified / not seen
* Tested here: all logic (53 tests), not the real PowerShell/JXA/xdotool helpers on real Windows/macOS/Linux machines and not a real SMTP login.
* Not in the upload and therefore not changed: `webrtc.js`, `remote-input.js`, `desktop-bridge.js`, `remote-viewport.html`, `agent/client-agent.js`, `agent/monitor.js`, `server/remote-control.js`, the Electron `desktop/` files.
* "Host agent: could not start: Node.js v22.21.1" comes from one of those files. The new host runtime runs inside Electron's own Node, so it avoids that check.
* Windows cannot inject input into elevated (administrator) windows; macOS needs the Accessibility permission for ScopeDesk.

---

# Update: real email + application picker

Install the one new dependency once: `npm install nodemailer`, then copy `.env.example` to `.env` and fill in `SMTP_USER` / `SMTP_PASS`
(`SMTP_HOST` defaults to `smtp.gmail.com`, `SMTP_PORT` to `587`; for Mailtrap use `sandbox.smtp.mailtrap.io` / `2525`).

| File | What changed |
|---|---|
| `server/mailer.js` (new) | env-driven nodemailer transport, Gmail App Password spaces stripped, timeouts, `sendResetCode(to, username, code)` |
| `server.js` | forgot-password now emails the code to `user.email`; **the `[RESET CODE]` console log is gone**; no SMTP config = HTTP 503 and no code is created; a failed send cancels the code. New `GET /api/apps` (built-in matrix + device-reported apps + search aliases) and `POST /api/apps/report` |
| `agent/app-catalog.js` | adds **File Manager** (+ Paint, WordPad, Snipping Tool, Photos, Media Player, Brave, 7-Zip, VLC, Zoom, Teams ...), `mergeAppLists`, `listAliases`; "File Manager" still forces the approved-folder check in the guard |
| `agent/app-discovery.js` (new) | reads installed programs on the Client's PC (Windows Start Menu + App Paths, macOS `*.app`, Linux `.desktop`), cleans names, falls back to the catalog |
| `server/task-scope.js` | up to 50 applications per ticket (was 10) |
| `public/script.js` | picker always shows the built-in list immediately, merges server + device apps, search matches names and aliases ("file manager", "explorer", "calc"), "Select all shown" / "Clear", retries loading when opened |
| `test/mailer-and-apps.test.js` (new) | 8 tests (29 total pass) |
| `.env.example` (new) | Gmail and Mailtrap settings |

One wiring step (the `desktop/` Electron files were not in the upload). A website running on Railway cannot see programs installed on the Client's PC,
so the desktop app must expose the discovery module. In Electron main: `ipcMain.handle('scopedesk:list-apps', () => require('./agent/app-discovery').discoverInstalledApps());`
In the preload script: `contextBridge.exposeInMainWorld('scopedeskNative', { listInstalledApps: () => ipcRenderer.invoke('scopedesk:list-apps') });`
The page already calls `window.scopedeskNative.listInstalledApps()` and reports the result to the server. Until that is wired, the picker shows the built-in list (never "No applications available").
Not tested: a real SMTP login (no network here; the transport is tested with a stub) and booting `server.js` (its other `server/*` modules were not in the upload).

---

# ScopeDesk: changed files

Copy these over the same paths in your repo (they are the files that changed, plus three new modules and tests).
Run the tests with `node --test test/sandbox-guard.test.js test/trust-engine.test.js` (Node 22.13+).

| File | What changed |
|---|---|
| `db.js` | `tasks.alerts_enabled` column; **trust-engine trigger** (`rating = rating + 1` on `completed`); demo vendors/tasks no longer seeded on real databases |
| `server.js` | data isolation, vendor required + only that vendor can claim, new task validation, breach protocol, role-aware history, `GET /api/apps`, `GET /api/agent/scope` |
| `server/task-scope.js` (new) | server-side validation of the new ticket form |
| `agent/app-catalog.js` (new) | clean app names (no `.exe`/`.app`), blocked shells, alias matching |
| `agent/sandbox-guard.js` (new) | payload validation + lockdown (close peers, lock PC, report) |
| `public/index.html`, `script.js`, `style.css` | new ticket form, apps multi-select, alert switch, task details, termination overlay |
| `test/*.test.js` (new) | 21 tests |

## One thing you must wire (I did not have these files)
Your upload had no `agent/` (host agent), `desktop/` (Electron), `server/remote-control.js` or `public/webrtc.js`, so I could not edit
the code that receives data-channel messages on the Client's PC. `agent/sandbox-guard.js` is built to drop in there:

```js
const { createSandboxGuard } = require('./sandbox-guard');
const scope = await (await fetch(`${SERVER_URL}/api/agent/scope`, { headers: { Authorization: `Bearer ${agentToken}` } })).json();
const guard = createSandboxGuard({
  taskId: scope.taskId,
  allowedApps: scope.allowedApps,           // clean names from the ticket
  allowedPaths: scope.allowedPaths,         // folders named in the task text
  closeConnections: () => closeEveryPeerConnectionAndDataChannel(),   // your existing teardown
  reportViolation: (v) => socket.emitWithAck('host-violation', v)    // the agent's existing socket
});
dataChannel.onmessage = async (ev) => {
  const r = await guard.handlePayload(ev.data);   // never executes anything itself
  if (r.ok) execute(r.payload);                    // run ONLY the sanitized payload
};
```
On a breach the guard closes all connections, runs `rundll32.exe user32.dll,LockWorkStation` (macOS: `pmset displaysleepnow`,
Linux: `loginctl lock-session`) and reports to the server, which ends the task and sends the `termination-alert` event
(overlay on the Client's page). The check must stay on the Client's PC, never in the vendor's browser.

## Behaviour changes to know about
- A task now **requires** a vendor. The token works only for that vendor (anyone else gets the same "token not found" answer).
  Old pending tasks with no vendor can no longer be claimed.
- The form's folder boundary comes from folders written in the task text (quote paths with spaces). No folder in the text = no folder allowed.
- Shells and system tools (cmd, PowerShell, regedit, Task Manager...) can never be allowed. Edit `BLOCKED` in `agent/app-catalog.js` to change that.
- A breach now terminates the task immediately. Set `ALLOW_RESUME_AFTER_VIOLATION=true` to restore the old "Client decides" flow.
- Alerts switch off = no overlay or notification, but lockdown, termination and the audit log still happen.
- Rating starts at 0 for a vendor's first row in a client's directory and gets +1 per clean completed task (a task with a logged violation earns nothing).
  A vendor can press "End Session" to complete a task, so they can raise their own rating inside a client's directory. If that matters, make completion client-only.
- If your production database was created by an older build, delete any fake demo rows (vendors with client_id 1 and ids 1-4, tasks `SCD-1042-XP8B`, `SCD-3091-ZN72`) if they are not yours.

## What was and was not tested
Tested: the rating trigger (real SQLite), form/task validation, the sandbox guard (Windows and POSIX path rules, symlinks, traversal, lockdown order),
and the new UI in headless Chrome with the missing front-end scripts stubbed. **Not tested:** booting `server.js` (express, socket.io and your
`server/*` modules were not available) and a real WebRTC session; syntax-checked and reviewed only.

## UPDATE 9: session enforcement and screen-share fix

- Screen share "ScopeDesk app detail: error: undefined": `desktop/display-media-handler.js` printed `err.message` for errors that are not
  Error objects. Every thrown value is now described, `getSources` is retried (3 attempts, different thumbnail sizes), and when the
  capturer itself keeps failing the primary display is offered directly.
- In the desktop app the share dialog no longer tells the Client to "click the picture of your screen" (there is no picker there).
- `server/remote-control.js`: new `teardown(taskId, reason)` (halt, cancel countdown, drop host-agent sockets, release memory) used by
  `terminateTask`; the countdown is also armed from the database when the host agent says hello or a peer joins the stream
  (`session-timers.js` `ensure()`); a vendor "open folder" request outside the approved paths is checked on the SERVER
  (`task-scope.js` `checkPathScope`) and ends the session as a breach before it reaches the Client's PC.
- `server.js`: breach handling shared by host-agent reports and the server-side check (`enforceBreach`).
- `public/screen-share.js`: `stopAll()` stops every capture, `showSessionClosed()` shows a friendly notice at the top of the window;
  wired to `session-ended`, `webrtc-close` and `control-halt` (`script.js`, `webrtc.js`). Cache-busting query strings bumped.
- Tests: `test/session-enforcement.test.js`, extra cases in `test/screen-share.test.js`.

## UPDATE 10: cross-network relay and diagnostics

- `server/rtc-config.js` now matches its tests and RAILWAY.md: Cloudflare Realtime TURN (per-session credentials that expire with the task),
  Metered TURN, your own coturn/fixed account, `TURN_FORCE_RELAY`. Failures are logged once without keys and fall through to the next option.
  There is deliberately no built-in "public" relay: the shared open-relay servers are gone or parked.
- Desktop app: Help > Save diagnostics report writes ScopeDesk-diagnostics.txt on the Desktop (agent files/modules present, agent state,
  last log lines, last screen-share refusal; tokens and keys removed). `diagnostics.js` is in the installer's file list and a test now
  fails the build if any file main.js requires is missing from that list.
