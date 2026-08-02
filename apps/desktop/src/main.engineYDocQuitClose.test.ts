import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A SOURCE-LEVEL WIRING assertion, in the same spirit as
// main.engineYDocSaveState.test.ts: the quit teardown lives inside main.ts's
// Electron bootstrap and has no unit harness. What the bound DOES is covered
// behaviorally in workspaceEngineYDocRestart.test.ts, which prices both the
// quit close and an ordinary one. What is only checkable here is which close
// asks for it — and that is the whole safety argument, because the flag makes
// a close give up on a daemon that might still come back.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("engine Y.Doc close bounding at quit", () => {
  it("bounds the will-quit teardown's closes", () => {
    const start = mainSource.indexOf("async function closeAllEngineYDocSessions");
    expect(start).toBeGreaterThan(-1);
    const body = mainSource.slice(start, mainSource.indexOf("\n}", start));
    expect(body).toContain("shuttingDown: true");
  });

  it("bounds NOTHING else", () => {
    // Every other close in main — the document-close IPC, the renderer-reload
    // teardown, a stale session's replacement — must keep the full transport
    // ladder. A daemon that relaunches in a second is a session worth waiting
    // for; giving up early there leaves the path's capture deferred until
    // somebody reopens the document.
    expect(mainSource.split("shuttingDown: true").length - 1).toBe(1);
  });
});
