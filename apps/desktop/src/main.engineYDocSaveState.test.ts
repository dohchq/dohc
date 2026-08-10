import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// AUDIT-SILENTSAVE round 2 (D2a). These are SOURCE-LEVEL WIRING assertions,
// not behavioral ones: the engine Y.Doc IPC handlers live inside main.ts's
// Electron bootstrap and have no unit harness. The behavior they guard is
// covered where it can be driven for real — useEngineDoc.saveState.test.tsx
// owns what the renderer does with each state, and the capture tests own what
// produces them. What is only checkable here is that main actually SENDS one
// on the paths that discard an edit.

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("engine Y.Doc save-state reporting in main", () => {
  it("keeps each move and delete capture lifecycle inside one exclusive workspace operation", () => {
    for (const channel of ["moveWorkspacePath", "deleteWorkspacePath"]) {
      const handler = handlerSource(channel);
      const exclusiveAt = handler.indexOf("withExclusiveWorkspaceOperation(");
      const callbackAt = handler.indexOf("async (markWorkspaceChanged)", exclusiveAt);
      const captureAt =
        channel === "moveWorkspacePath"
          ? handler.indexOf("capture.beginFileRename(")
          : handler.indexOf("settleAndCloseLiveSessionsForPath(");
      const mutationAt =
        channel === "moveWorkspacePath"
          ? handler.indexOf("await movePath(")
          : handler.indexOf("await deletePath(");
      const successAt =
        channel === "moveWorkspacePath"
          ? handler.indexOf("finishRename?.(true)")
          : handler.indexOf("finishDebts?.(true)");
      const changedAt = handler.indexOf("markWorkspaceChanged()", mutationAt);
      const failureAt =
        channel === "moveWorkspacePath"
          ? handler.indexOf("finishRename?.(false)")
          : handler.indexOf("finishDebts?.(false)");
      expect(exclusiveAt).toBeGreaterThan(-1);
      expect(callbackAt).toBeGreaterThan(exclusiveAt);
      expect(captureAt).toBeGreaterThan(callbackAt);
      expect(mutationAt).toBeGreaterThan(captureAt);
      expect(changedAt).toBeGreaterThan(mutationAt);
      expect(changedAt).toBeLessThan(successAt);
      expect(successAt).toBeGreaterThan(mutationAt);
      expect(failureAt).toBeGreaterThan(successAt);
    }
  });

  it("admits unconditional file and folder creation through stale-sensitive workspace scheduling", () => {
    for (const [channel, mutation] of [
      ["createWorkspaceFile", "await createFile("],
      ["createWorkspaceFolder", "await createFolder("],
    ] as const) {
      const handler = handlerSource(channel);
      const scheduledAt = handler.indexOf("withStaleSensitiveWorkspaceOperation(");
      expect(scheduledAt).toBeGreaterThan(-1);
      expect(handler.indexOf(mutation)).toBeGreaterThan(scheduledAt);
    }
  });

  it("admits imports through stale-sensitive scheduling without holding the native dialog", () => {
    const handler = handlerSource("importWorkspaceFiles");
    const droppedAt = handler.indexOf("importDroppedPaths(");
    const firstScheduleAt = handler.indexOf("withStaleSensitiveWorkspaceOperation(");
    const dialogAt = handler.indexOf("await dialog.showOpenDialog(");
    const secondScheduleAt = handler.indexOf(
      "withStaleSensitiveWorkspaceOperation(",
      firstScheduleAt + 1,
    );
    const copyAt = handler.indexOf("copyIntoWorkspace(");
    expect(firstScheduleAt).toBeGreaterThan(-1);
    expect(droppedAt).toBeGreaterThan(firstScheduleAt);
    expect(dialogAt).toBeGreaterThan(droppedAt);
    expect(secondScheduleAt).toBeGreaterThan(dialogAt);
    expect(copyAt).toBeGreaterThan(secondScheduleAt);
  });

  it("notifies live renderer sessions only after the disk delete succeeds", () => {
    const handler = handlerSource("deleteWorkspacePath");
    const deleteAt = handler.indexOf("await deletePath(");
    const notifyAt = handler.indexOf("notifyEngineYDocSessionsDeleted(");
    const successAt = handler.indexOf("finishDebts?.(true)");
    const failureAt = handler.indexOf("finishDebts?.(false)");
    expect(deleteAt).toBeGreaterThan(-1);
    expect(notifyAt).toBeGreaterThan(deleteAt);
    expect(notifyAt).toBeLessThan(successAt);
    expect(failureAt).toBeGreaterThan(successAt);
  });

  it("notifies live sessions against the SAME canonical path deletePath resolved to", () => {
    // The DeleteWorkspacePathPayload schema bounds relativePath's length but
    // does not normalize it (no trailing-slash/segment cleanup) — deletePath
    // normalizes internally via validateUserWritePath for its own disk
    // target, but that normalized form never reached the session-matching
    // call until this fix. A raw "notes/" would otherwise widen the prefix
    // match in notifyEngineYDocSessionsDeleted to "notes//" and miss every
    // live session under it (round-5 CodeRabbit).
    //
    // MUTATION: revert to `notifyEngineYDocSessionsDeleted(workspace
    // .workspaceId, input.relativePath)` -> this test still passes textually
    // (both source snippets exist), so the second assertion pins the ORDER:
    // the normalized value, not the raw payload field, must reach the call.
    const handler = handlerSource("deleteWorkspacePath");
    const validateAt = handler.indexOf("validateUserWritePath(input.relativePath)");
    const notifyAt = handler.indexOf("notifyEngineYDocSessionsDeleted(");
    expect(validateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(notifyAt);
    const call = handler.slice(notifyAt, handler.indexOf(");", notifyAt) + 2);
    // The OLD (buggy) call passed the raw payload field straight through.
    expect(call).not.toContain("workspace.workspaceId, input.relativePath)");
    expect(call).toContain("validatedDeletePath.normalized");
  });

  it("tells the renderer when a shared-view re-check DISCARDS a local edit", () => {
    // The renderer has already counted this edit, so a silent return strands
    // the document on "Saving…" forever: every later report carries a seq
    // below the renderer's, and the indicator can never clear. The IPC answer
    // must stay an inert no-op (that boundary must never throw), but the
    // save state has to say the edit is not going to disk.
    const handler = handlerSource("engineYDocApplyUpdate");
    const guardAt = handler.indexOf("if (sharedViewOf(entry.workspaceId))");
    expect(guardAt).toBeGreaterThan(-1);
    const reportAt = handler.indexOf("sendEngineYDocSaveState(", guardAt);
    const applyAt = handler.indexOf("entry.session.applyLocalUpdate(");
    expect(reportAt).toBeGreaterThan(guardAt);
    expect(reportAt).toBeLessThan(applyAt);
    // Its OWN state, not the generic error: in a shared view every later edit
    // is refused too, so "try another edit" would be futile advice.
    expect(handler.slice(reportAt, applyAt)).toContain('"read-only"');
    // And it still refuses rather than writing.
    expect(handler.indexOf("return;", reportAt)).toBeLessThan(applyAt);
  });

  it("counts the edit when the session hands it to the settle, not on arrival", () => {
    // The session QUEUES updates, so counting here — before the hand-over —
    // credits a settle armed by an earlier update with edits still waiting in
    // that queue, and the editor reads "Saved" over a partial file (#514).
    // The count belongs in the hand-over callback, which fires when the
    // update reaches the provider. What that callback promises is proved
    // behaviorally in workspaces/workspaceEngineYDocSession.test.ts.
    //
    // Textual order alone would not prove it: `applyLocalUpdate(input.update)`
    // followed on the NEXT LINE by a bare `noteLocalEdit(...)` reads as "later
    // in the file" while reintroducing #514 exactly. So pin that noteLocalEdit
    // IS the hand-over callback.
    const handler = handlerSource("engineYDocApplyUpdate");
    expect(handler).toMatch(
      /entry\.session\.applyLocalUpdate\(\s*input\.update,\s*\(\)\s*=>\s*noteLocalEdit\(/,
    );
  });

  it("makes updates inert after a successful delete and repeats the deleted state", () => {
    const handler = handlerSource("engineYDocApplyUpdate");
    const deletedAt = handler.indexOf("if (entry.deleted)");
    const applyAt = handler.indexOf("entry.session.applyLocalUpdate(");
    expect(deletedAt).toBeGreaterThan(-1);
    expect(deletedAt).toBeLessThan(applyAt);
    expect(handler.slice(deletedAt, applyAt)).toContain('"deleted"');
    expect(handler.indexOf("return;", deletedAt)).toBeLessThan(applyAt);
  });

  it("maps a removal-window open refusal to a retryable interval", () => {
    const handler = handlerSource("engineYDocOpen");
    const catchAt = handler.indexOf("} catch (error) {");
    const answer = handler.slice(catchAt, handler.indexOf("const entry:"));
    expect(answer).toContain("isYDocRemovalInProgressError(error)");
    expect(answer).toContain("removalInProgress:");
    expect(answer).toContain("operation: error.removalOperation");
    expect(answer).toContain("message: error.inProgress");
    expect(answer).not.toContain("deletedWhileEditing");
  });

  it("reports each settle against the seq state of ITS OWN open", () => {
    // The reporter used to find its entry by session id. A refused open whose
    // close FAILED keeps reporting — its session is still the daemon's — and
    // that lookup then moved the save sequence of whichever open owns the id
    // now: a settle vouching for edits it never carried, over another
    // document (#683). The state is made before the session so the callback
    // closes over it, and the entry carries that same object.
    const handler = handlerSource("engineYDocOpen");
    const saveSeqAt = handler.indexOf("const saveSeq = createEngineYDocSaveSeqState();");
    expect(saveSeqAt).toBeGreaterThan(-1);
    expect(saveSeqAt).toBeLessThan(handler.indexOf("capture.openYDocSession"));
    const reporter = handler.slice(
      handler.indexOf("onSaveState:"),
      handler.indexOf("onRemoteUpdate:"),
    );
    expect(reporter).not.toContain("engineYDocSessions.get(");
    expect(reporter).toMatch(/noteSettleStart\(saveSeq,/);
    expect(reporter).toMatch(/noteSettleOutcome\(saveSeq,/);
    // The entry shares that object, so an update counted through the entry and
    // a settle counted through the reporter meet in one state.
    expect(handler.slice(handler.indexOf("const entry: EngineYDocSessionEntry"))).toContain(
      "        saveSeq,\n",
    );
  });

  it("stops reporting and stops forwarding once the open is refused", () => {
    // The renderer keys both events by the session id it minted. After a
    // refusal that id belongs to another document: a report would move that
    // document's save indicator, and a delta would be applied to its Y.Doc.
    // A refused session whose close FAILED still hears its own document.
    const handler = handlerSource("engineYDocOpen");
    const reporter = handler.slice(
      handler.indexOf("onSaveState:"),
      handler.indexOf("onRemoteUpdate:"),
    );
    const forwarder = handler.slice(
      handler.indexOf("onRemoteUpdate:"),
      handler.indexOf("} catch (error) {"),
    );
    expect(reporter).toContain("if (refused) return;");
    expect(forwarder).toContain("refused ||");
    // One flag, set where every post-open refusal already goes.
    const releaseAt = handler.indexOf("const release = (reason: string)");
    expect(handler.slice(releaseAt)).toContain("refused = true;");
  });

  // The defaulted seq is pinned BEHAVIORALLY in ipc/bridgeContract.test.ts
  // ("accepts a payload with no seq, defaulting it") — parsing a real payload,
  // not matching the schema's source text. A source-echo assertion here would
  // break on any semantically identical refactor while proving less.
});
