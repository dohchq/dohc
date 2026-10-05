import { describe, expect, it } from "vitest";
import { createServerRuns } from "./serverRuns";

describe("server automation recovery", () => {
  it("retains a completed run's pending shared settlement note", async () => {
    const run = {claimId: "pending", state: "done", error: null, createdAtMs: 1, updatedAtMs: 2, sharedSettlementPending: true,
      trigger: {kind: "button", recordId: "record", by: "human", sharedAuthor: null, depth: 0},
      writes: [{kind: "field", recordId: "record", path: "Tasks/one.md", field: "Status", before: null, after: "Done", sharedFileUpdateState: "pending"}],
      definitionChanged: false, chainStopped: false, neverStarted: false, undone: false};
    const server = createServerRuns(async () => ({status: 200, body: {ok: true, runs: [run], next: null}, asker: {account: "owner", current: () => true}}));
    await expect(server.runs("ws", "finish")).resolves.toEqual({runs: [run], next: null});
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
  await expect(server.restore("ws", [], false)).resolves.toEqual(pass);
});
