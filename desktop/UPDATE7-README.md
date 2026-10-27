# Update 7: Node 22 host-agent launcher + guarded screen sharing

## Read this first
The files that contain the two bugs were NOT in the zip you uploaded (`server.js`, `agent/client-agent.js`, `desktop/main.js`,
`desktop/preload.js`, `public/script.js`, `public/webrtc.js`). I cannot edit code I have not seen, so this update gives you
drop-in modules plus the exact lines to put in those files. Upload them and I will patch them in place.

## New files (copy to the same paths)
| File | Purpose |
|---|---|
| `agent/host-launcher.js` | Starts the host agent safely (see below). Replaces your current `spawn` / `exec` of the old agent |
| `agent/native-loader.js` | `loadNative('robotjs')` returns the module or `null`, never throws |
| `public/screen-share.js` | Defensive `getDisplayMedia` wrapper. Never throws, never touches the socket |
| `desktop/display-media-handler.js` | Electron main: offers the primary screen after the user's click, so no fragile picker |
| `test/host-launcher.test.js`, `test/screen-share.test.js` | 26 tests (all pass on Node 22) |

## Why "could not start: Node.js v22.21.1"
That line is the banner Node prints LAST after any crash. Your launcher shows only the last line, so the real cause is hidden.
`host-launcher.js` removes the banner, reads the real error and reports it ("native add-on built for another Node version",
"module X not installed", "node not found" ...). It also: tries Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), then `node` from PATH,
then the current Node; drops flags the runtime rejects (Node 22 exits with code 9 on `--experimental-policy`,
`--experimental-network-imports`, `--harmony-*`); switches off native add-ons that fail to load so the built-in PowerShell /
osascript / xdotool helpers are used; handles child and stdout/stderr `error` events (EPIPE); kills the whole process tree on stop;
restarts a crashed agent up to 3 times.

## Wiring 1: Electron main process (`desktop/main.js`)
Replace the code that starts the old agent with:
```js
const path = require('path');
const { desktopCapturer, screen } = require('electron');
const { createHostLauncher } = require('../agent/host-launcher');
const { installDisplayMediaHandler } = require('./display-media-handler');

installDisplayMediaHandler({
  session: mainWindow.webContents.session,
  desktopCapturer, screen,
  allowedOrigins: [new URL(SERVER_URL).origin],
  log: console.log
});

const launcher = createHostLauncher({
  entry: path.join(__dirname, '..', 'agent', 'client-agent.js'),   // your existing agent script
  env: { SERVER_URL, AGENT_TOKEN: agentToken },                     // whatever the old code passed
  log: console.log
});
launcher.on('status', (s) => mainWindow.webContents.send('scopedesk:host-status', s));
const started = await launcher.start();      // never throws
// started.ok === false -> started.error.headline / .hint / .detail are what to show in "Host agent:"
app.on('before-quit', () => { launcher.stop(); });
```
Preload: `ipcRenderer.on('scopedesk:host-status', (_e, s) => cb(s))` exposed through `contextBridge`, and show `s.message`
in the "Host agent:" field instead of the old text.

If the agent starts but shows "native add-ons switched off": in `client-agent.js` replace `require('robotjs')` / `require('active-win')`
with `const robot = require('./native-loader').loadNative('robotjs');` and use `agent/input-executor.js` when it is `null`.
If the agent should signal readiness, add `if (process.send) process.send({ type: 'ready' });` (otherwise it counts as started after 2 s alive).

## Wiring 2: screen share (`public/index.html` and `public/script.js`)
```html
<script src="screen-share.js"></script>   <!-- before script.js -->
```
```js
const share = ScopeDeskScreenShare.create({
  onTip: ScopeDeskScreenShare.bindTipElement(document.getElementById('screenShareError'))   // your red box
});
async function onShareMyScreenClick() {
  const result = await share.start();
  if (!result.ok) return;          // IMPORTANT: no terminate / hardStop / socket.disconnect here; the dialog stays open
  addStreamToPeerConnection(result.stream);   // your existing code
}
share.onEnded(() => { /* "Stop sharing" pressed in the browser bar: your choice what to do */ });
```
Find every `catch` around your current `getDisplayMedia` call and make sure it no longer calls terminate / hardStop /
`socket.disconnect()` or emits an end-of-session event. That is what produces the "Remote control has ended" notification.

## Not verified
No Windows machine, no Electron here. Tested: launcher against real child processes on Node 22 (crash diagnosis, native fallback,
runtime fallback, flag dropping, restart, stop), the screen-share logic with a fake `mediaDevices`, and the Electron handler with fakes.
Not tested: a real picker, a real robotjs failure, Electron's behaviour when a request is denied (the renderer sees NotAllowedError or
NotFoundError; both are handled).
