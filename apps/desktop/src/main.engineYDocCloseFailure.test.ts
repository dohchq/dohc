import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// SOURCE-LEVEL WIRING assertions, in the same spirit as
// main.engineYDocSaveState.test.ts: the engine Y.Doc IPC handlers live inside
// main.ts's Electron bootstrap and have no unit harness. What the release DOES
// is proved behaviorally in workspaces/engineYDocSessionRelease.test.ts. What
// is only checkable here is that every NON-QUIT teardown routes through it —
// the swallow they replace (#657) is a one-token regression. The quit sweep
// closes directly and deliberately; see closeAllEngineYDocSessions.
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

  it("answers engineMayHoldDocument — not a plain fallback — when a close fails", () => {
    // engineMayHoldDocument is the contract for "the engine may still hold this
    // document": the renderer stays read-only and offers a retry, and that
    // retry is also what discharges the session the failed close left behind.
    const handler = handlerSource("engineYDocOpen");
    const failedStaleClose = handler.indexOf("stale session replaced");
    const staleAnswer = handler.slice(
      failedStaleClose,
      handler.indexOf("THIS OPEN IS THE RETRY"),
    );
    expect(staleAnswer).toContain("engineMayHoldDocument: true");
    // The two post-open refusals answer it conditionally, on the release's
    // own verdict — a released session really is on disk and keeps the plain
    // editor.
    expect(
      handler.split("...(released ? {} : { engineMayHoldDocument: true }),").length - 1,
    ).toBe(2);
  });

  it("keeps a committed scene read-only while its artifact assets are pending", () => {
    const handler = handlerSource("engineYDocOpen");
    // The workspace-session predicate owns pending-refusal classification;
    // this handler owns mapping that retryable class to a read-only result.
    const predicateAt = handler.indexOf("isEngineWorkspaceOpenRefusedError(error)");
    expect(predicateAt).toBeGreaterThan(-1);
    expect(
      handler.slice(predicateAt, handler.indexOf("const entry:", predicateAt)),
    ).toContain("engineMayHoldDocument: true");
  });

  it("reports corrupt scene asset authority as terminal instead of retryable", () => {
    const handler = handlerSource("engineYDocOpen");
    const predicateAt = handler.indexOf("isYdocArtifactAssetsInvalidRefusal(error)");
    expect(predicateAt).toBeGreaterThan(-1);
    const invalidBranch = handler.slice(
      predicateAt,
      handler.indexOf("isEngineWorkspaceOpenRefusedError(error)", predicateAt),
    );
    expect(invalidBranch).toContain("artifactAssetsInvalid: true");
    expect(invalidBranch).not.toContain("engineMayHoldDocument: true");
  });

  it("retries a failed close BY PATH before it binds anything", () => {
    // The renderer retries under a NEW session id (useEngineDoc, nextSessionId),
    // so an id-keyed retry never reaches the session whose close failed. The
    // daemon then answers the fresh open ydoc-session-busy, and this loop is
    // the only thing that can release the session it names — without it the
    // document is read-only for good (#616), and before #616 it took the
    // writable plain editor instead.
    const handler = handlerSource("engineYDocOpen");
    const retryAt = handler.indexOf("unreleased session retried by a new open");
    expect(retryAt).toBeGreaterThan(-1);
    expect(retryAt).toBeLessThan(handler.indexOf("capture.openYDocSession"));
    const retry = handler.slice(
      handler.lastIndexOf("for (const [failedKey, entry]", retryAt),
      handler.indexOf("let session:"),
    );
    // Marked entries only: a LIVE session for this path belongs to whoever
    // opened it, and closing it here would tear down another window's editor.
    expect(retry).toContain("entry.closeFailed");
    expect(retry).toContain("entry.workspaceId !== workspace.workspaceId");
    expect(retry).toContain("entry.path !== path");
    expect(retry).toContain("engineMayHoldDocument: true");
  });

  it("counts as a pending open from its FIRST await, not from the open", () => {
    // A reload waits on the pending-open registration. Registering it after the
    // releases leaves their awaits outside that wait: prepareForRendererReload
    // can finish both sweeps and reload while this handler sits in a release,
    // and the handler then takes a daemon session for a generation that no
    // longer exists — while the replacement renderer's open of the same
    // document gets ydoc-session-busy, leaving it read-only over a session
    // that generation can no longer release (#616).
    const handler = handlerSource("engineYDocOpen");
    const beginAt = handler.indexOf("beginPendingEngineYDocOpen(");
    const tryAt = handler.indexOf("try {", beginAt);
    expect(beginAt).toBeGreaterThan(-1);
    expect(tryAt).toBeGreaterThan(beginAt);
    // Both releases are inside that try — so is every early return they take,
    // which is what keeps the one `finally` covering all of them.
    expect(handler.indexOf("stale session replaced")).toBeGreaterThan(tryAt);
    expect(
      handler.indexOf("unreleased session retried by a new open"),
    ).toBeGreaterThan(tryAt);
    expect(handler.split("finishPendingOpen();").length - 1).toBe(1);
    expect(handler.indexOf("finishPendingOpen();")).toBeGreaterThan(
      handler.lastIndexOf("engineMayHoldDocument: true"),
    );
  });

  it("registers the sender cleanup hook before the kind check", () => {
    // A kind-mismatched session whose close fails STAYS registered so a
    // teardown can retry it. Hooking after that check would leave the entry
    // reachable only by the quit sweep.
    const handler = handlerSource("engineYDocOpen");
    const hookAt = handler.indexOf("engineYDocCleanupHooked.add(sender)");
    const kindCheckAt = handler.indexOf("session.contentKind !== requestedKind");
    expect(hookAt).toBeGreaterThan(-1);
    expect(kindCheckAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(kindCheckAt);
  });
});

describe("engine Y.Doc registry: a registration never replaces a live session", () => {
  // What the claim and the key DO is proved behaviorally in
  // workspaces/engineYDocSessionRegistry.test.ts. What is only checkable here
  // is that the handlers use them: the unconditional `set` they replace, and
  // the by-id lookups they replace, are one-token regressions (#683).
  it("claims the slot after the open instead of setting it", () => {
    const handler = handlerSource("engineYDocOpen");
    expect(handler).not.toContain("engineYDocSessions.set(");
    const claimAt = handler.indexOf("claimEngineYDocSessionSlot(");
    expect(claimAt).toBeGreaterThan(handler.indexOf("capture.openYDocSession"));
    const claim = handler.slice(claimAt);
    // The SAME key the rest of the handler uses. Claiming under a key nothing
    // else computes would file the entry where no lookup, sweep, or release
    // can reach it, while every other assertion here stayed green.
    expect(claim).toContain("key: sessionKey,");
    // The refused open releases ITS OWN session through the same helper as
    // every other post-open refusal, and answers read-only unless that release
    // happened.
    expect(claim).toContain("release,");
    expect(claim).toContain(
      "...(claim.released ? {} : { engineMayHoldDocument: true }),",
    );
  });

  it("keys every session by its SENDER and the renderer's id", () => {
    // A renderer-minted id alone lets two windows collide in one registry.
    for (const channel of [
      "engineYDocOpen",
      "engineYDocApplyUpdate",
      "engineYDocClose",
    ]) {
      const handler = handlerSource(channel);
      expect(handler).toContain("engineYDocSessionKey(");
      expect(handler).not.toContain("engineYDocSessions.get(input.sessionId)");
    }
  });
});

describe("workspace text writes: a live Y.Doc stays canonical", () => {
  it("refuses the direct disk writer while any session owns the path", () => {
    const handler = handlerSource("writeWorkspaceText");
    const sessionGuardAt = handler.indexOf(
      "for (const entry of engineYDocSessions.values())",
    );
    const diskWriteAt = handler.indexOf("await writeWorkspaceText(");

    expect(sessionGuardAt).toBeGreaterThan(-1);
    expect(sessionGuardAt).toBeLessThan(diskWriteAt);
    expect(handler).toContain("entry.workspaceId === workspace.workspaceId");
    expect(handler).toContain("const writePath = validateUserWritePath(input.relativePath)");
    expect(handler).toContain("entry.path === writePath.normalized");
    expect(handler).toContain("The engine owns this live document.");
  });

  it("stores the same normalized path that the direct writer compares", () => {
    const handler = handlerSource("engineYDocOpen");
    const validationAt = handler.indexOf(
      "const validatedPath = validateUserWritePath(input.path)",
    );
    const registrationAt = handler.indexOf("const entry: EngineYDocSessionEntry");

    expect(validationAt).toBeGreaterThan(-1);
    expect(validationAt).toBeLessThan(registrationAt);
    expect(handler).toContain("const path = validatedPath.normalized");
    expect(handler.slice(registrationAt)).toContain("path,");
    expect(handler.slice(registrationAt)).not.toContain("path: input.path");
  });
});

describe("engine Y.Doc artifact assets stay bound to one authorized session", () => {
  it("derives authority from the sender session and its pinned descriptor", () => {
    const handler = handlerSource("engineYDocReadArtifactAsset");
    expect(handler).toContain("assertTrustedSender(event)");
    expect(handler).toContain("engineYDocSessionKey(event.sender.id, input.sessionId)");
    expect(handler).toContain("entry.sender !== event.sender");
    expect(handler).toContain("entry.generation !== rendererGeneration(event.sender.id)");
    expect(handler).toContain("entry.artifactAssetsById.get(input.assetId)");
    expect(handler).toContain("entry.session.readArtifactAsset(input.assetId)");
    expect(handler).not.toContain("workspaceId");
    expect(handler).not.toContain("versionId");
    expect(handler).not.toContain("input.ref");
  });

  it("rejects unknown, stale, foreign, and changed descriptors", () => {
    const handler = handlerSource("engineYDocReadArtifactAsset");
    expect(handler).toContain("!entry ||");
    // A deleted entry stays session-bound until normal close so the renderer
    // can finish the drawing recovery that the deletion notice started.
    expect(handler).not.toContain("entry.deleted");
    expect(handler).toContain("!descriptor");
    expect(handler).toContain("hydrated.descriptor.ref !== descriptor.ref");
    expect(handler).toContain("hydrated.descriptor.sha256 !== descriptor.sha256");
    expect(handler).toContain("hydrated.descriptor.mimeType !== descriptor.mimeType");
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
