import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// SOURCE-LEVEL WIRING assertions, in the same spirit as
// main.engineYDocSaveState.test.ts: the engine Y.Doc IPC handlers live inside
// main.ts's Electron bootstrap and have no unit harness. What the release DOES
// is proved behaviorally in workspaces/engineYDocSessionRelease.test.ts. What
// is only checkable here is that the open handler's three discard paths route
// through it — the swallow they replace (#657) is a one-token regression.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("engine Y.Doc open: a failed close is never a clean fallback", () => {
  it("closes no discarded session with a swallowed close", () => {
    // `.catch(() => undefined)` on these three closes is the whole defect: the
    // capture layer rethrows because the reservation MAY STILL BE HELD, and
    // swallowing it turned that into `available: false` — the answer that
    // downgrades the document to the WRITABLE plain editor, a second writer
    // over a document the daemon still owns.
    const handler = handlerSource("engineYDocOpen");
    expect(handler).not.toContain("session.close()");
    expect(handler).not.toContain("catch(() => undefined)");
  });

  it("routes all three discard paths through releaseEngineYDocSession", () => {
    const handler = handlerSource("engineYDocOpen");
    for (const reason of [
      "stale session replaced",
      "renderer gone before hand-over",
      "kind-mismatched lineage",
    ]) {
      expect(handler).toContain(reason);
    }
    // One per discarded session: the stale close, plus the shared `release`
    // helper the two post-open refusals call.
    expect(handler.split("releaseEngineYDocSession(").length - 1).toBe(2);
    expect(handler.split("await release(").length - 1).toBe(2);
  });

  it("answers openTimedOut — not a plain fallback — when a close fails", () => {
    // openTimedOut is the contract for "the engine may still hold this
    // document": the renderer stays read-only and offers a retry, and that
    // retry is also what discharges the session the failed close left behind.
    const handler = handlerSource("engineYDocOpen");
    const failedStaleClose = handler.indexOf("stale session replaced");
    const staleAnswer = handler.slice(
      failedStaleClose,
      handler.indexOf("beginPendingEngineYDocOpen"),
    );
    expect(staleAnswer).toContain("openTimedOut: true");
    // The two post-open refusals answer it conditionally, on the release's
    // own verdict — a released session really is on disk and keeps the plain
    // editor.
    expect(
      handler.split("...(released ? {} : { openTimedOut: true }),").length - 1,
    ).toBe(2);
  });

  it("registers the sender cleanup hook before the kind check", () => {
    // A kind-mismatched session whose close fails STAYS registered so a
    // teardown can retry it. Hooking after that check would leave the entry
    // reachable only by the quit sweep.
    const handler = handlerSource("engineYDocOpen");
    const hookAt = handler.indexOf("engineYDocCleanupHooked.add(sender)");
    const kindCheckAt = handler.indexOf('session.contentKind !== "richdoc"');
    expect(hookAt).toBeGreaterThan(-1);
    expect(kindCheckAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(kindCheckAt);
  });
});
