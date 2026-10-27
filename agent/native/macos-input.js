// ScopeDesk input helper (macOS), run with:  osascript -l JavaScript agent/native/macos-input.js
// Reads ONE JSON command per line on stdin. It can only move the pointer, press/release buttons, scroll and press/release keys.
//   {"op":"move","x":0..1,"y":0..1}   {"op":"btn","b":0|1|2,"down":bool,"x":0..1,"y":0..1}
//   {"op":"wheel","dx":int,"dy":int}  {"op":"key","kc":int,"down":bool}
// macOS asks the user once to allow the host app under System Settings > Privacy & Security > Accessibility.
ObjC.import('Foundation');
ObjC.import('ApplicationServices');

var FLAGS = { 54: 0x100000, 55: 0x100000, 56: 0x20000, 60: 0x20000, 58: 0x80000, 61: 0x80000, 59: 0x40000, 62: 0x40000 };   // Cmd, Shift, Option, Control
var flags = 0, posX = 0, posY = 0;

function bounds() { return $.CGDisplayBounds($.CGMainDisplayID()); }
function point(nx, ny) {
  var b = bounds();
  posX = b.origin.x + Math.min(Math.max(nx, 0), 1) * (b.size.width - 1);
  posY = b.origin.y + Math.min(Math.max(ny, 0), 1) * (b.size.height - 1);
  return $.CGPointMake(posX, posY);
}
function post(ev) { $.CGEventSetFlags(ev, flags); $.CGEventPost($.kCGHIDEventTap, ev); }

function handle(c) {
  if (c.op === 'move') {
    var held = c.held === 0 ? $.kCGEventLeftMouseDragged : c.held === 2 ? $.kCGEventRightMouseDragged : c.held === 1 ? $.kCGEventOtherMouseDragged : $.kCGEventMouseMoved;
    post($.CGEventCreateMouseEvent(null, held, point(c.x, c.y), c.held === 2 ? $.kCGMouseButtonRight : c.held === 1 ? $.kCGMouseButtonCenter : $.kCGMouseButtonLeft));
  } else if (c.op === 'btn') {
    var p = point(c.x, c.y);
    var types = [[$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft],
                 [$.kCGEventOtherMouseDown, $.kCGEventOtherMouseUp, $.kCGMouseButtonCenter],
                 [$.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGMouseButtonRight]][c.b];
    if (types) post($.CGEventCreateMouseEvent(null, c.down ? types[0] : types[1], p, types[2]));
  } else if (c.op === 'wheel') {
    post($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 2, c.dy, c.dx));
  } else if (c.op === 'key') {
    if (FLAGS[c.kc]) flags = c.down ? (flags | FLAGS[c.kc]) : (flags & ~FLAGS[c.kc]);
    post($.CGEventCreateKeyboardEvent(null, c.kc, c.down));
  }
}

var input = $.NSFileHandle.fileHandleWithStandardInput;
var pending = '';
while (true) {
  var data = input.availableData;
  if (data.length === 0) break;                       // stdin closed: the agent stopped
  pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  var lines = pending.split('\n');
  pending = lines.pop();
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].length > 512) continue;
    try { handle(JSON.parse(lines[i])); } catch (e) { /* ignore a bad line */ }
  }
}
