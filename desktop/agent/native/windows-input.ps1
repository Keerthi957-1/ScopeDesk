# ScopeDesk input helper (Windows). Started by agent/input-executor.js, reads ONE JSON command per line on stdin.
# It can only move the pointer, press/release mouse buttons, scroll and press/release keys. It never starts programs.
#   {"op":"move","x":0..65535,"y":0..65535}      pointer, absolute on the primary monitor
#   {"op":"btn","b":0|1|2,"down":true|false}
#   {"op":"wheel","dx":int,"dy":int}             WHEEL_DELTA units (120 = one notch)
#   {"op":"key","vk":int,"ext":bool,"down":bool}
#   {"op":"char","cp":int,"down":bool}           a Unicode character, typed regardless of keyboard layout
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ScopeDeskNativeInput {
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint n, INPUT[] inputs, int size);

    const uint MOUSE = 0, KEYBOARD = 1;
    const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040,
               WHEEL = 0x0800, HWHEEL = 0x1000, ABSOLUTE = 0x8000;
    const uint KEYUP = 0x0002, EXT = 0x0001, UNICODE = 0x0004;

    static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }

    static INPUT Mouse(uint flags, int dx, int dy, int data) {
        INPUT i = new INPUT(); i.type = MOUSE;
        i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = unchecked((uint)data); i.u.mi.dwFlags = flags;
        return i;
    }
    public static void Move(int x, int y) { Send(Mouse(MOVE | ABSOLUTE, x, y, 0)); }
    public static void Button(int b, bool down) {
        uint f = b == 0 ? (down ? LDOWN : LUP) : b == 1 ? (down ? MDOWN : MUP) : (down ? RDOWN : RUP);
        Send(Mouse(f, 0, 0, 0));
    }
    public static void Wheel(int dx, int dy) {
        if (dy != 0) Send(Mouse(WHEEL, 0, 0, dy));
        if (dx != 0) Send(Mouse(HWHEEL, 0, 0, dx));
    }
    public static void Key(int vk, bool ext, bool down) {
        INPUT i = new INPUT(); i.type = KEYBOARD;
        i.u.ki.wVk = (ushort)vk; i.u.ki.dwFlags = (ext ? EXT : 0) | (down ? 0 : KEYUP);
        Send(i);
    }
    public static void Char(int cp, bool down) {
        string s = char.ConvertFromUtf32(cp);
        foreach (char c in s) {
            INPUT i = new INPUT(); i.type = KEYBOARD;
            i.u.ki.wScan = c; i.u.ki.dwFlags = UNICODE | (down ? 0 : KEYUP);
            Send(i);
        }
    }
}
"@

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }          # stdin closed: the agent stopped, so this helper stops too
    if ($line.Length -eq 0 -or $line.Length -gt 512) { continue }
    try {
        $c = $line | ConvertFrom-Json
        switch ($c.op) {
            'move'  { [ScopeDeskNativeInput]::Move([int]$c.x, [int]$c.y) }
            'btn'   { [ScopeDeskNativeInput]::Button([int]$c.b, [bool]$c.down) }
            'wheel' { [ScopeDeskNativeInput]::Wheel([int]$c.dx, [int]$c.dy) }
            'key'   { [ScopeDeskNativeInput]::Key([int]$c.vk, [bool]$c.ext, [bool]$c.down) }
            'char'  { [ScopeDeskNativeInput]::Char([int]$c.cp, [bool]$c.down) }
        }
    } catch { [Console]::Error.WriteLine('input-helper: ' + $_.Exception.Message) }
}
