import { vi } from "vitest";

// jsdom implements no hit testing: document.elementFromPoint does not exist.
//
// ProseMirror calls it on every pointer press (posAtCoords, reached from its
// mousedown handler) and does not feature-guard it, so every renderer test
// that clicks or types into the WYSIWYG editor threw an uncaught TypeError
// inside the listener. The assertions still passed -- the throw happens in the
// event handler, not in the test -- but vitest fails a run that produced
// unhandled errors. That is why the FileInspector suite went red on a busy box
// and green in isolation, naming a different test each time.
//
// Only elementFromPoint. ProseMirror feature-guards the two caret-from-point
// APIs (`if (doc.caretPositionFromPoint)`, `if (doc.caretRangeFromPoint)`) and
// a stub returning null would produce exactly what their absence already
// produces, so stubbing them would be inert code pretending to be a fix.
//
// null is the honest value, not a stub that pretends: jsdom lays nothing out,
// every rect is 0x0, and no element is at any point. ProseMirror handles null
// two lines later (`if (!elt || ...)`) and falls back to its own rect maths,
// which is the path these tests were already taking once the throw was
// swallowed.
//
// This is not dead insurance, which is the charge that removed an equivalent
// stub in #580. Instrumented, elementFromPoint takes 0 calls in a serial run
// and 3 across 16 concurrent runs, and unregistering this file puts
// "elementFromPoint is not a function" back into 21 of 32 loaded runs. #580's
// "zero calls at this head" was measured unloaded.
//
// Registered as a vitest setupFile, so it runs inside each test file's own
// environment. The typeof guard keeps it inert in the node-environment suites,
// which have no document at all.
if (
  typeof document !== "undefined" &&
  typeof document.elementFromPoint !== "function"
) {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    writable: true,
    value: () => null,
  });
}

// Testing Library's own 1 s default for waitFor and findBy* failed loaded runs
// with "Unable to find" while the product was healthy. A full gate beside other
// work then missed a 5 s wait for the source-view toggle that passes alone.
// 10 s stays inside vitest.config.ts's 30 s test timeout, so a stuck wait
// still reports what it waited for.
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/dom");
  configure({ asyncUtilTimeout: 10_000 });
}

// vi.waitFor has the same fixed 1 s default and no setting for it, so every
// desktop suite gets the same 10 s here. An explicit timeout still wins.
const waitFor = vi.waitFor;
vi.waitFor = (callback, options) =>
  waitFor(callback, typeof options === "number" ? options : { timeout: 10_000, ...options });
