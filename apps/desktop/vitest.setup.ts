// jsdom implements no hit testing. document.elementFromPoint,
// caretPositionFromPoint and caretRangeFromPoint simply do not exist there.
//
// ProseMirror calls them on every pointer press (posAtCoords, reached from its
// mousedown handler), so every renderer test that clicks or types into the
// WYSIWYG editor threw an uncaught TypeError inside the listener. The
// assertions still passed -- the throw happens in the event handler, not in
// the test -- but vitest fails a run that produced unhandled errors. That is
// why the FileInspector suite went red on a busy box and green in isolation,
// naming a different test each time (#590).
//
// null is the honest answer, not a stub that pretends: jsdom lays nothing out,
// every rect is 0x0, and no element is at any point. ProseMirror already
// treats null as "nothing there" and falls back to its own rect maths, which
// is the path these tests were always taking once the throw was swallowed.
//
// This file is registered as a vitest setupFile, so it runs inside each test
// file's own environment. The typeof guard keeps it inert in the node-
// environment suites, which have no document at all.
if (typeof document !== "undefined") {
  const missingHitTesting: Array<keyof Document> = [
    "elementFromPoint",
    "caretPositionFromPoint",
    "caretRangeFromPoint",
  ];
  for (const api of missingHitTesting) {
    if (typeof document[api] === "function") continue;
    Object.defineProperty(document, api, {
      configurable: true,
      writable: true,
      value: () => null,
    });
  }
}
