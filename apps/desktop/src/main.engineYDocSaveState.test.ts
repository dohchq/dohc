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
    expect(handler.slice(reportAt, applyAt)).toContain('"error"');
    // And it still refuses rather than writing.
    expect(handler.indexOf("return;", reportAt)).toBeLessThan(applyAt);
  });

  it("advances the edit counter only on the path that actually journals", () => {
    const handler = handlerSource("engineYDocApplyUpdate");
    expect(handler.indexOf("entry.dirtySeq = input.seq")).toBeLessThan(
      handler.indexOf("entry.session.applyLocalUpdate("),
    );
  });

  it("defaults the edit seq instead of requiring it, so the boundary cannot throw", () => {
    // A required field rejects at the schema BEFORE the session lookup,
    // turning the documented "inert no-op, never throws" refusal for an
    // unknown/foreign/read-only session into an exception.
    const contract = readFileSync(
      new URL("./ipc/bridgeContract.ts", import.meta.url),
      "utf8",
    );
    const start = contract.indexOf("export const ApplyEngineYDocUpdatePayload");
    const payload = contract.slice(start, contract.indexOf("});", start));
    expect(payload).toContain("z.number().int().nonnegative().default(0)");
  });
});
