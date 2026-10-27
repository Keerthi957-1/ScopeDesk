'use strict';
// Reads the REAL folder shown by the file manager in the foreground window.
// A window title is not good enough: Explorer shows only the last folder name, and users can change it.
//
//   Windows: one hidden, long-lived PowerShell asks Shell.Application for every Explorer window/tab and its folder path,
//            and maps each (tab) window to its top-level window, so it can be matched with the window active-win reports.
//   macOS:   asks Finder for the folder of its front window (osascript).
//   others:  not supported (supported === false). The agent then refuses to start a path-restricted task.
//
// foldersFor(win) -> string[]  folders shown in that window (several when Explorer has several tabs; ALL must be allowed)
//                 -> []        the window is not a folder window (desktop, taskbar, a dialog)
//                 -> undefined could not be determined right now (timeout, probe died)
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace SD -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr h, uint f);'
$sh = New-Object -ComObject Shell.Application
while ($true) {
  $id = [Console]::In.ReadLine()
  if ($null -eq $id) { break }
  $out = New-Object System.Collections.ArrayList
  foreach ($w in $sh.Windows()) {
    try {
      $h = [System.IntPtr][int64]$w.HWND
      $root = [SD.Win]::GetAncestor($h, 2).ToInt64()
      if ($root -eq 0) { $root = $h.ToInt64() }
      [void]$out.Add(@{ root = $root; path = [string]$w.Document.Folder.Self.Path })
    } catch {}
  }
  [Console]::Out.WriteLine($id + "\`t" + (ConvertTo-Json -InputObject @($out) -Compress))
  [Console]::Out.Flush()
}
`;

function createWindowsProbe(log) {
  const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let dead = false, seq = 0, pending = null, chain = Promise.resolve();
  ps.stderr.on('data', () => {});
  ps.on('error', (e) => { dead = true; log('warn', 'PowerShell could not start: ' + e.message); });
  ps.on('exit', () => { dead = true; if (pending) pending.resolve(undefined); log('warn', 'Folder probe stopped. Folder checks will fail closed.'); });

  readline.createInterface({ input: ps.stdout }).on('line', (line) => {
    const tab = line.indexOf('\t');
    if (tab < 0 || !pending || line.slice(0, tab) !== pending.id) return; // late answer to a request that timed out
    const p = pending; pending = null; clearTimeout(p.timer);
    try { const d = JSON.parse(line.slice(tab + 1)); p.resolve(d === null ? [] : (Array.isArray(d) ? d : [d])); } catch (_) { p.resolve(undefined); }
  });

  const query = () => {
    const run = () => new Promise((resolve) => {
      if (dead) return resolve(undefined);
      const id = String(++seq);
      pending = { id, resolve, timer: setTimeout(() => { pending = null; resolve(undefined); }, 3000) };
      ps.stdin.write(id + '\n');
    });
    const p = chain.then(run); chain = p.catch(() => {}); return p;
  };
  query(); // warm-up: the first call compiles the helper

  return {
    supported: true,
    async foldersFor(win) {
      const all = await query();
      if (!all) return undefined;
      return all.filter((e) => Number(e.root) === Number(win.id)).map((e) => String(e.path || ''));
    },
    close() { try { ps.kill(); } catch (_) { /* gone */ } }
  };
}

function createMacProbe() {
  const SCRIPT = 'tell application "Finder"\nif (count of windows) is 0 then return ""\nreturn POSIX path of (target of front window as alias)\nend tell';
  return {
    supported: true,
    foldersFor(win) {
      if (!/finder/i.test(win.owner && win.owner.name)) return Promise.resolve([]);
      return new Promise((resolve) => execFile('osascript', ['-e', SCRIPT], { timeout: 3000 }, (err, out) => resolve(err ? undefined : (out.trim() ? [out.trim()] : []))));
    },
    close() {}
  };
}

function createPathProbe(log) {
  if (process.platform === 'win32') return createWindowsProbe(log);
  if (process.platform === 'darwin') return createMacProbe();
  return { supported: false, foldersFor: async () => undefined, close() {} };
}

module.exports = { createPathProbe };
