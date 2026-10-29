# Testing remote control (two authorised devices)

Automated tests prove the routing and the state rules. Only a real run proves that a real mouse moves. Use two devices or two accounts that
you are allowed to use.

## 1. Run the project on your Mac (the Client)

```bash
cd ScopeDesk
npm install                              # server dependencies
npm --prefix desktop install             # Electron
npm --prefix desktop run prepare:agent   # installs the host agent's modules and checks them
npm run test:all                         # optional: runs every automated test

# Client app against your deployed server (needed when the vendor is on another device/network):
SCOPEDESK_SERVER_URL=https://scopedesk-api-production.up.railway.app npm --prefix desktop start
```

Only on one Mac, with a local server instead (two terminals):

```bash
PORT=3100 node server.js                                                      # terminal 1
SCOPEDESK_SERVER_URL=http://localhost:3100 npm --prefix desktop start         # terminal 2 (the Client app)
# the Vendor signs in at http://localhost:3100 in Chrome with a second account
```

Vendor on a SECOND device on the same Wi-Fi, with the local server: start the server with your Mac's address allowed, e.g.
`CORS_ORIGIN=http://192.168.1.20:3100 PORT=3100 node server.js`, and the vendor opens `http://192.168.1.20:3100` (find the address with
`ipconfig getifaddr en0`). Across different networks use the deployed Railway server instead (and set up TURN, see RAILWAY.md).

## 2. macOS permissions (the usual reason for "I can see but not control")

System Settings > Privacy & Security:
- **Screen & System Audio Recording**: switch ScopeDesk on (when started with `npm start` the entry is called **Electron**).
- **Accessibility**: switch ScopeDesk on (**Electron**, and your **Terminal** app if control still does nothing in `npm start` mode).
Then **quit and reopen** the app. If Accessibility is missing the client sees "view only (macOS has not allowed ScopeDesk to control this Mac...)"
and the vendor sees "Live view only. The client's computer is not allowing control".

## 3. The test, in this order

1. Client: sign in, open **Calculator**, create a task that allows Calculator, copy the token to the vendor.
2. Vendor (other device or account): accept the task with the token.
3. Client: press **Share my screen** in the dialog. That is the approval: it shares the screen AND starts remote control. The button on the
   bar now says **Stop remote control**. It must not change by itself.
4. Client: bring **Calculator** to the front. The status line changes to "Active Secured Session".
5. Vendor badge must say "Live. Remote control active". Anything else names the reason (waiting for the app, view only, not started).

## 4. How to know the vendor is really controlling the computer

- The vendor moves the mouse over the shared picture: the **physical cursor on the client's screen moves** (not just the picture).
- The vendor clicks the Calculator buttons 7, x, 6, = : the **client's own Calculator shows 42**.
- The vendor types digits on the keyboard: they appear in the client's Calculator.
- A video that shows the vendor's pointer only proves the stream. The two checks above prove control.

## 5. Stop and expiry

- Client presses **Stop remote control**: the vendor's clicks must immediately do nothing. The button says **Start remote control** and stays
  that way (it never starts by itself). Pressing it again starts a new control session.
- Client presses **Terminate Connection**, or the timer ends: the vendor is cut off and the client sees the "session has ended" notice.
- Vendor opens an app that is not approved: the session is locked and the client is alerted.

## 6. If it still does not work

The Client's "Host agent" line now says exactly why input is paused, for example
`waiting for Word: waiting: "Finder" is in front, which is not an approved app (Word)` or
`cannot read which app is in front (...)` (a missing macOS permission). Developer consoles (View > Toggle Developer Tools) show
`[ScopeDesk] remote-control <stage>: <state>` lines (host agent, data channel ctl/mv, host bridge, input path). The server log shows
`[RC] task N: host agent connected/disconnected`, `remote control started/stopped by the client`, `input not delivered`. No typed text,
coordinates or passwords are ever logged.

1. Client: **Help > Save diagnostics report** and read these lines: `Input: ready`, `macOS Accessibility: allowed`, `phase=running`.
2. Client window: View > Toggle Developer Tools > Console. Lines starting `[ScopeDesk] remote-control` show each stage
   (host agent, data channel, input path). They never contain typed characters or coordinates.
3. Railway logs: `[RC] task N: input not delivered, host agent offline` means the client's agent is not connected to the server.


## 7. Different operating systems and networks (Update 10)

| Client PC (runs the ScopeDesk desktop app) | Vendor (any browser) | Notes |
|---|---|---|
| Windows 10/11 | Windows, Mac, Linux, phone | Ctrl shortcuts as usual; a Mac vendor's Cmd+C/V/X/Z/A/S/F works as Ctrl |
| macOS | Windows, Mac, Linux, phone | Accessibility + Screen Recording permission; a Windows vendor's Ctrl+C works as Cmd+C |
| Linux (X11 / "Xorg" session) | any | Wayland: screen sharing only; the app tells the Client to log in with "Ubuntu on Xorg". Folder limits need Windows or Mac |

Things to try per pair: type `é@€` (any layout), copy text on the vendor's PC and press Ctrl/Cmd+V in the approved app, Ctrl/Cmd+C
then V inside the app, and check Alt+Tab / Cmd+Tab / the Windows key do nothing.

**Different networks:** without TURN the vendor's toolbar shows "(via ScopeDesk server, reduced picture rate)" after ~12 s. That
proves the fallback; set up TURN (RAILWAY.md) for full speed. **Several monitors:** pick the screen in the share dialog, then use
"Switch screen" and check the vendor's clicks land on the new screen. **Files:** create a task with an approved folder, then in the
vendor workspace use "Send file": it must appear only in that folder, and a `.exe`/`.sh` must be refused.

## 8. What is deliberately NOT possible (scope protection)
- Downloading files or reading the clipboard FROM the Client's PC (that would let data leave it).
- Unattended access (every session needs the Client's approval in the app).
- Windows UAC prompts / the lock screen: they run on a protected desktop that no normal app can control (AnyDesk installs a system
  service for that). Admin windows ("Run as administrator") can only be controlled if the Client starts ScopeDesk with
  "Run as administrator".
- A file Open/Save dialog inside an allowed app can browse other folders: it belongs to the allowed app, so the agent cannot tell
  it apart. Keep allowed apps to what the task needs; a web browser warns in the form.
