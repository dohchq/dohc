import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// SOURCE-LEVEL WIRING assertions, in the same spirit as
// main.engineYDocSaveState.test.ts: the engine Y.Doc IPC handlers live inside
// main.ts's Electron bootstrap and have no unit harness. What the release DOES
// is proved behaviorally in workspaces/engineYDocSessionRelease.test.ts. What
// is only checkable here is that every teardown routes through it — the
// swallow they replace (#657) is a one-token regression.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

function functionSource(name: string): string {
  const start = mainSource.indexOf(`async function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  return mainSource.slice(start, mainSource.indexOf("\n}", start));
}

describe("engine Y.Doc open: a failed close is never a clean fallback", () => {
  it("closes no discarded session with a swallowed close", () => {
    // `.catch(() => undefined)` on these closes is the whole defect: the
    // capture layer rethrows because the reservation MAY STILL BE HELD, and
    // swallowing it turned that into `available: false` — the answer that
    // downgrades the document to the WRITABLE plain editor, a second writer
    // over a document the daemon still owns.
    const handler = handlerSource("engineYDocOpen");
    expect(handler).not.toContain("session.close()");
    expect(handler).not.toContain("catch(() => undefined)");
  });

  it("routes all three discard paths through the release", () => {
    const handler = handlerSource("engineYDocOpen");
    for (const reason of [
      "stale session replaced",
      "renderer gone before hand-over",
      "kind-mismatched lineage",
    ]) {
      expect(handler).toContain(reason);
    }
    // The stale close, the path-keyed retry, and the shared `release` helper
    // the two post-open refusals call.
    expect(handler.split("releaseEngineYDocSessionEntry(").length - 1).toBe(3);
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
      handler.indexOf("THIS OPEN IS THE RETRY"),
    );
    expect(staleAnswer).toContain("openTimedOut: true");
    // The two post-open refusals answer it conditionally, on the release's
    // own verdict — a released session really is on disk and keeps the plain
    // editor.
    expect(
      handler.split("...(released ? {} : { openTimedOut: true }),").length - 1,
    ).toBe(2);
  });

  it("retries a failed close BY PATH before it binds anything", () => {
    // The renderer retries under a NEW session id (useEngineDoc, nextSessionId),
    // so an id-keyed retry never reaches the session whose close failed. The
    // daemon then answers the fresh open ydoc-session-busy — an ordinary
    // fallback — and the writable plain editor lands back on a document the
    // engine may still hold.
    const handler = handlerSource("engineYDocOpen");
    const retryAt = handler.indexOf("unreleased session retried by a new open");
    expect(retryAt).toBeGreaterThan(-1);
    expect(retryAt).toBeLessThan(handler.indexOf("capture.openYDocSession"));
    const retry = handler.slice(
      handler.lastIndexOf("for (const [sessionId, entry]", retryAt),
      handler.indexOf("beginPendingEngineYDocOpen"),
    );
    // Marked entries only: a LIVE session for this path belongs to whoever
    // opened it, and closing it here would tear down another window's editor.
    expect(retry).toContain("entry.closeFailed");
    expect(retry).toContain("entry.workspaceId !== workspace.workspaceId");
    expect(retry).toContain("entry.path !== input.path");
    expect(retry).toContain("openTimedOut: true");
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

describe("engine Y.Doc teardown: every close keeps its failure", () => {
  it("closes the document through the release, not a swallow", () => {
    // The close IPC dropped the entry BEFORE swallowing the close. That is
    // what left the renderer's "Try again" with nothing to retry: its fresh
    // session id met a daemon that still held the document.
    const handler = handlerSource("engineYDocClose");
    expect(handler).toContain("releaseEngineYDocSessionEntry(");
    expect(handler).not.toContain("engineYDocSessions.delete(");
    expect(handler).not.toContain("catch(() => undefined)");
  });

  it("sweeps a renderer's sessions through the release", () => {
    const sweep = functionSource("closeEngineYDocSessionsForSender");
    expect(sweep).toContain("releaseEngineYDocSessionEntry(");
    expect(sweep).not.toContain("engineYDocSessions.delete(");
    expect(sweep).not.toContain("catch(() => undefined)");
  });

  it("sweeps again once the reload's pending opens have settled", () => {
    // The first sweep runs in parallel with the pending opens. An open that
    // registers a failed release AFTER it would otherwise get no renderer-side
    // retry at all: a reload keeps the WebContents, so the 'destroyed' hook
    // never fires.
    const reload = functionSource("prepareForRendererReload");
    expect(reload.split("closeEngineYDocSessionsForSender(").length - 1).toBe(2);
    expect(
      reload.lastIndexOf("closeEngineYDocSessionsForSender("),
    ).toBeGreaterThan(reload.indexOf("waitForPendingEngineYDocOpens("));
  });
});
