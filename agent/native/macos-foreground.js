// ScopeDesk foreground probe (macOS), run with:  osascript -l JavaScript agent/native/macos-foreground.js
// Prints ONE JSON line when the frontmost application (or, for Finder, its front window's folder) changes, plus a heartbeat every ~2 s.
// "path" is the POSIX path of the folder in Finder's front window. Reading it asks macOS ONCE for permission to control Finder
// (System Settings > Privacy & Security > Automation); without it "path" stays empty and only the application name is checked.
ObjC.import('Foundation');
ObjC.import('AppKit');

function finderFolder() {
  try {
    var finder = Application('Finder');
    if (finder.finderWindows.length === 0) return '';
    var url = finder.finderWindows[0].target().url();
    return ObjC.unwrap($.NSURL.URLWithString(url).path) || '';
  } catch (e) { return ''; }
}

var out = $.NSFileHandle.fileHandleWithStandardOutput;
var last = '';
var beat = 0;
while (true) {
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var name = app ? ObjC.unwrap(app.localizedName) : '';
  var pid = app ? app.processIdentifier : 0;
  var folder = name === 'Finder' ? finderFolder() : '';
  var line = JSON.stringify({ name: name, pid: pid, title: '', path: folder });
  beat++;
  if (line !== last || beat >= 10) {
    out.writeData($.NSString.alloc.initWithUTF8String(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    last = line;
    beat = 0;
  }
  $.NSThread.sleepForTimeInterval(0.2);
}
