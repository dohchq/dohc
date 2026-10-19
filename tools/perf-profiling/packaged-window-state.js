// The macOS counterpart of packaged-window-state.ps1, run by osascript -l JavaScript.
// It reads one JSON request per stdin line and answers one JSON line per request.
// Window facts come from the window server; hiding needs no Accessibility permission.
// macOS has no programmatic minimize without Accessibility, so 'minimized' hides the app:
// its windows leave the screen and Chromium sees them occluded, as with a minimized window.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function windowsOf(pid, onScreenOnly) {
  const options = onScreenOnly ? $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements : $.kCGWindowListOptionAll;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID));
  const rows = [];
  for (let i = 0; i < list.count; i++) {
    const entry = list.objectAtIndex(i);
    if (ObjC.unwrap(entry.objectForKey('kCGWindowOwnerPID')) !== pid || ObjC.unwrap(entry.objectForKey('kCGWindowLayer')) !== 0) continue;
    const bounds = ObjC.deepUnwrap(entry.objectForKey('kCGWindowBounds'));
    if (bounds.Width < 100 || bounds.Height < 100) continue;
    rows.push({ window: ObjC.unwrap(entry.objectForKey('kCGWindowNumber')), title: ObjC.unwrap(entry.objectForKey('kCGWindowName')) ?? null, bounds });
  }
  return rows;
}

function inspect(pid) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.isNil()) return { ready: false, reason: 'process-not-found', pid };
  const all = windowsOf(pid, false);
  if (!all.length) return { ready: false, reason: 'window-not-ready', pid };
  const onScreen = windowsOf(pid, true);
  const hidden = app.hidden;
  const window = onScreen[0] ?? all[0];
  return { pid, window: window.window, title: window.title, class: 'NSWindow', normalRect: window.bounds,
    visible: onScreen.length > 0 && !hidden, minimized: !onScreen.length, hidden, active: app.active, at: Date.now() };
}

function setState(pid, state) {
  if (!['inspect', 'visible', 'minimized'].includes(state)) throw Error('Invalid window state');
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (state !== 'inspect' && app && !app.isNil()) {
    if (state === 'minimized') app.hide; else app.unhide;
    const deadline = Date.now() + 5000;
    for (;;) {
      const current = inspect(pid);
      if (current.ready !== false && (state === 'minimized' ? current.minimized && current.hidden : current.visible)) return { ...current, state };
      if (Date.now() > deadline) throw Error(`Window did not reach ${state}`);
      delay(0.02);
    }
  }
  return { ...inspect(pid), state };
}

function write(value) {
  const text = $.NSString.alloc.initWithUTF8String(`${JSON.stringify(value)}\n`);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(text.dataUsingEncoding($.NSUTF8StringEncoding));
}

function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  write({ ready: true });
  let buffer = '';
  for (;;) {
    const data = input.availableData;
    if (data.length === 0) return;
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
        if (request.state === 'exit') return;
        write({ id: request.id, value: request.state === 'ping' ? { pong: true } : setState(Number(request.pid), request.state) });
      } catch (error) { write({ id: request?.id, error: String(error.message ?? error) }); }
    }
  }
}
