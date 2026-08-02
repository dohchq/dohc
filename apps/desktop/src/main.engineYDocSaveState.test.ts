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
    const handler = handlerSource("engineYDocApplyUpdate");
    const applyAt = handler.indexOf("entry.session.applyLocalUpdate(");
    const countAt = handler.indexOf("noteLocalEdit(");
    expect(applyAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(applyAt);
  });

  // The defaulted seq is pinned BEHAVIORALLY in ipc/bridgeContract.test.ts
  // ("accepts a payload with no seq, defaulting it") — parsing a real payload,
  // not matching the schema's source text. A source-echo assertion here would
  // break on any semantically identical refactor while proving less.
});
