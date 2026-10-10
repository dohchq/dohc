import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { createAutomationRunStore } from "./automationRunStore";
import { CollectionAutomations, type CollectionAutomationEngine } from "./collectionAutomations";
import { createTestScratch, testMetadataDir } from "./testScratch";

it("persists unchanged reach verdicts after the first save fails", async () => {
  const store = createAutomationRunStore(await createTestScratch("dohc-reach-save-"), testMetadataDir);
  const failure = new Error("Verdict save failed");
  const save = vi.spyOn(store, "saveReachVerdicts").mockRejectedValueOnce(failure);
  const errors = vi.fn();
  const evaluator = createAutomationFormulaEvaluator();
  const texts = new Map([
    ["Tasks/collection.yaml", "fields: {Status: {type: text}}"],
    ["Budget/collection.yaml", "fields: {Status: {type: text}}"],
    ["Tasks/automations.yaml", "version: 1\nautomations:\n  - id: spend\n    name: Spend\n    when: {field-changed: Status}\n    do: [{add-record: {Status: Paid}, collection: Budget}]\n"],
  ]);
  expect(parseAutomationsFile(texts.get("Tasks/automations.yaml")!)).toMatchObject({
    status: "read", entries: [{ status: "valid" }],
  });
  const roster = { kind: "owner" as const, ownerUserId: "owner", grants: [{
    grantId: "editor", recipientUserId: "editor", recipientEmail: null,
    files: { paths: ["Tasks"], versionId: null, access: "edit" as const }, channel: null,
  }] };
  const engine = {
    listCollections: async () => ({ collections: ["Tasks", "Budget"].map(path => ({ path, objectId: path, status: "valid", reasons: [] })) }),
    subscribeAutomation: async () => undefined,
    releaseAutomationGroups: async () => ({ watchedGeneration: 0, handover: { floorMs: 0, automations: [] } }),
    claimNextAutomation: async () => null,
    listAutomationClaims: async () => ({ claims: [], next: null }),
    listAutomationFailures: async () => ({ failures: [] }),
    pruneAutomationHistory: async () => ({ pruned: 0, more: false }),
  } as unknown as CollectionAutomationEngine;
  const executor = new CollectionAutomations({
    withEngine: async work => work(engine),
    withRecordWrites: async () => { throw Error("Unexpected record write"); },
    withUndoWrites: async () => { throw Error("Unexpected Undo"); },
    readText: async path => texts.has(path) ? { text: texts.get(path)!, truncated: false, contentHash: createHash("sha256").update(texts.get(path)!).digest("hex") } : null,
    writeText: async () => ({ status: "conflict" }), pathExists: async path => texts.has(path),
    roster: async () => roster, cachedRoster: async () => roster,
    evaluator: evaluator.forWorkspace("workspace"), store, personName: userId => userId,
    withDatasetHost: async () => null, groupHost: async () => null,
    groupRelayRecord: async () => ({ generation: 0, handover: null }),
    reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
    groupMessagesSkipped: async () => undefined, requestHost: async () => undefined, readMessageBody: async () => "",
    chat: { directory: async () => null, write: async () => { throw Error("Unexpected chat"); } }, postNotice: async () => undefined,
    mayRetryPress: async () => false, onPressSettled: () => undefined, onPressWaiting: () => undefined,
    onRunsChanged: () => undefined, reportFailure: async () => undefined, withdrawFailure: async () => undefined,
    onSwitchedOff: () => undefined, onHoldsChanged: () => undefined, onAutomationsChanged: () => undefined, onError: errors,
  });
  try {
    await executor.open();
    await expect.poll(() => errors.mock.calls, { timeout: 10_000 }).toEqual([["check who can edit automations", failure]]);
    expect(save).toHaveBeenCalledOnce();
    const attempted = save.mock.calls[0]![0];
    expect(attempted.verdicts).toMatchObject([{ automationId: "collection:Tasks#spend", verdict: "stopped" }]);
    expect((await store.readReachVerdicts()).verdicts).toEqual([]);

    expect(await executor.automationsIn("Tasks")).toMatchObject({
      status: "read",
      automations: [{ valid: true, cannotRun: null, reach: { kind: "checked", steps: [{ verdict: "stopped" }] } }],
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toEqual(attempted);
    expect((await store.readReachVerdicts()).verdicts).toEqual(attempted.verdicts);
    expect(errors.mock.calls).toEqual([["check who can edit automations", failure]]);
    const claim = vi.fn().mockRejectedValueOnce(new DaemonRefusalError({code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff"}, undefined)).mockResolvedValue(null);
    engine.claimNextAutomation = claim;
    executor.notifyClaimed();
    await expect.poll(() => claim.mock.calls.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expect(errors.mock.calls).toEqual([["check who can edit automations", failure]]);
  } finally {
    await executor.dispose();
    await evaluator.close();
  }
});
