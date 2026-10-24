import { describe, expect, it } from "vitest";
import { createServerRuns } from "./serverRuns";

describe("server automation recovery", () => {
  it("keeps release queued while the original account cannot send", async () => {
    let signedIn = false;
    const server = createServerRuns(async () => signedIn ? {status: 200, body: {ok: true, errorMessage: null},
      asker: {account: "owner", current: () => true}} : null);
    // Release must distinguish an unavailable account from a server without this copy.
    expect(await server.releaseRestore("ws", "release")).toBe(false);
    signedIn = true;
    expect(await server.releaseRestore("ws", "release")).toBe(true);
  });
  it("retains a completed run's pending shared settlement note and unfinished Undo", async () => {
    const run = {claimId: "pending", state: "done", error: null, createdAtMs: 1, updatedAtMs: 2, sharedSettlementPending: true,
      trigger: {kind: "button", recordId: "record", by: "human", sharedAuthor: null, depth: 0},
      writes: [{kind: "field", recordId: "record", path: "Tasks/one.md", field: "Status", before: null, after: "Done", sharedFileUpdateState: "pending"}],
      definitionChanged: false, chainStopped: false, neverStarted: false, undone: false, undoUnfinished: true};
    const server = createServerRuns(async () => ({status: 200, body: {ok: true, runs: [run], next: null}, asker: {account: "owner", current: () => true}}));
    await expect(server.runs("ws", "finish")).resolves.toEqual({runs: [run], next: null});
  });
  it("keeps the mark of a run whose changes the server's lost copy may not have sent", async () => {
    const run = {claimId: "lost", state: "failed", error: "Your server lost its copy of this workspace and may not have sent this run's latest changes.",
      createdAtMs: 1, updatedAtMs: 2, trigger: {kind: null, recordId: null, by: null, sharedAuthor: null, depth: 0}, writes: [],
      definitionChanged: false, chainStopped: false, neverStarted: false, undone: false, undoUnfinished: false, unsentChangesLost: true};
    const server = createServerRuns(async () => ({status: 200, body: {ok: true, run}, asker: {account: "owner", current: () => true}}));
    await expect(server.get("ws", "collection:Tasks#pay", "lost")).resolves.toEqual(run);
  });
  it("preserves the typed controls target when Try again reaches an off automation", async () => {
    const target = { recovery: "automation-controls" as const, automation: "collection:Tasks#slow", path: "Tasks/automations.yaml" };
    const server = createServerRuns(async () => ({ status: 200, body: { ok: true, status: "switched-off", target }, asker: { account: "owner", current: () => true } }));
    await expect(server.retry("ws", { automationId: target.automation, claimId: "third-timeout", startOver: false }))
      .resolves.toEqual({ status: "switched-off", target });
  });
});

it("carries kept field paths and names from the owner's server", async () => {
  const keptFields = [
    { id: "f".repeat(32), path: "trip/Tasks/Untitled.md", field: "Finished on", recordId: null },
    { id: "a".repeat(32), path: "Budget", field: "Status", recordId: "a" },
  ];
  const pass = { undone: 1, left: 0, reverted: 0, missing: 0, keptFields, otherKept: 0, errorMessage: null };
  const server = createServerRuns(async () => ({ status: 200, body: { ok: true, ...pass }, asker: { account: "owner", current: () => true } }));
  await expect(server.restore("ws", [], false, "restore-test")).resolves.toEqual(pass);
});
