# ScopeDesk foreground probe (Windows). Started by agent/foreground-monitor.js.
# Prints ONE JSON line to stdout whenever the window in front changes (and a heartbeat every ~2 s), e.g.
#   {"name":"notepad","pid":4242,"title":"Untitled - Notepad"}
# Store apps (Calculator, Photos, Settings...) run inside ApplicationFrameHost.exe: the real app behind the frame is reported instead.
# When the window in front is a File Explorer window, "path" holds the folder it shows (e.g. C:\Users\ann\Reports). Virtual views such as
# This PC / Quick access report no filesystem path ("" or a ::{GUID} string) and the monitor ignores them.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class ScopeDeskForeground {
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);

    public static long ForegroundHandle() { return GetForegroundWindow().ToInt64(); }

    public static uint[] Current(out string title) {
        title = "";
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return new uint[0];
        uint pid; GetWindowThreadProcessId(h, out pid);
        StringBuilder sb = new StringBuilder(256);
        GetWindowText(h, sb, 256);
        title = sb.ToString();
        List<uint> pids = new List<uint>();
        pids.Add(pid);
        EnumChildWindows(h, delegate (IntPtr child, IntPtr l) {
            uint cp; GetWindowThreadProcessId(child, out cp);
            if (cp != pid && !pids.Contains(cp)) pids.Add(cp);
            return true;
        }, IntPtr.Zero);
        return pids.ToArray();
    }
}
"@

$shell = $null
try { $shell = New-Object -ComObject Shell.Application } catch { }

function Get-ExplorerPath([long]$hwnd) {
    if ($null -eq $shell) { return '' }
    try {
        foreach ($w in $shell.Windows()) {
            if ([long]$w.HWND -eq $hwnd) { return [string]$w.Document.Folder.Self.Path }
        }
    } catch { }
    return ''
}

$last = ''
$beat = 0
while ($true) {
    try {
        $title = ''
        $pids = [ScopeDeskForeground]::Current([ref]$title)
        if ($pids.Length -gt 0) {
            $proc = Get-Process -Id $pids[0]
            $name = $proc.ProcessName
            $pid0 = $pids[0]
            if ($name -ieq 'ApplicationFrameHost' -and $pids.Length -gt 1) {
                $inner = Get-Process -Id $pids[1]
                if ($inner) { $name = $inner.ProcessName; $pid0 = $pids[1] }
            }
            $folder = ''
            if ($name -ieq 'explorer') { $folder = Get-ExplorerPath ([ScopeDeskForeground]::ForegroundHandle()) }
            $line = (@{ name = $name; pid = $pid0; title = $title; path = $folder } | ConvertTo-Json -Compress)
        } else {
            $line = '{"name":"","pid":0,"title":""}'
        }
        $beat++
        if ($line -ne $last -or $beat -ge 10) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line; $beat = 0 }
    } catch { }
    Start-Sleep -Milliseconds 200
}
