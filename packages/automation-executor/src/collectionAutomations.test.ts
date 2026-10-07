import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { createAutomationRunStore } from "./automationRunStore";
import { CollectionAutomations, type CollectionAutomationEngine } from "./collectionAutomations";
import { definitionHash } from "./automationPlan";
import { SHARED_BUTTON_DENIED } from "./buttonPresser";
import type { RelayButtonAuthority } from "@dohc/workspace-contracts/relay";
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
  } finally {
    await executor.dispose();
    await evaluator.close();
  }
});

it("keeps private reach reasons out of a recipient's direct press and retry", async () => {
  const store = createAutomationRunStore(await createTestScratch("dohc-button-privacy-"), testMetadataDir);
  const errors = vi.fn();
  const evaluator = createAutomationFormulaEvaluator();
  const texts = new Map([
    ["Tasks/collection.yaml", "fields: {Status: {type: text}, Press: {type: button}}"],
    ["Budget/collection.yaml", "fields: {Status: {type: text}, Press: {type: button}}"],
    ["Tasks/automations.yaml", "version: 1\nautomations:\n  - id: spend\n    name: Spend\n    when: {button: Press}\n    do: [{add-record: {Status: Paid}, collection: Budget}]\n"],
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
    mayRetryPress: async () => true, onPressSettled: () => undefined, onPressWaiting: () => undefined,
    onRunsChanged: () => undefined, reportFailure: async () => undefined, withdrawFailure: async () => undefined,
    onSwitchedOff: () => undefined, onHoldsChanged: () => undefined, onAutomationsChanged: () => undefined, onError: errors,
  });
  try {
    await executor.open();
    const automationId = (await executor.automationIdAt("Tasks", "spend"))!;
    const parsed = parseAutomationsFile(texts.get("Tasks/automations.yaml")!);
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("Invalid test automation");
    const authority: RelayButtonAuthority = {workspaceId: "workspace", userId: "editor", grantId: "editor", grantGeneration: 1, hostGeneration: 1,
      automationId, collectionPath: "Tasks", definitionHash: definitionHash(parsed.entries[0].automation), recordId: "record", confirmed: [], principals: []};
    const seams = executor as unknown as {
      runnableButtonState(): Promise<{kind: "disabled"; reason: string; denialCause: string}>;
      pressAuthority(): Promise<RelayButtonAuthority>;
      findClaim(): Promise<{neverStarted: boolean; pressedBy: string; hostPressId: string}>;
    };
    vi.spyOn(seams, "pressAuthority").mockResolvedValue(authority);
    vi.spyOn(seams, "runnableButtonState").mockResolvedValue({kind: "disabled", reason: "Private Budget is restricted for Ana", denialCause: "reach-restricted"});
    vi.spyOn(seams, "findClaim").mockResolvedValue({neverStarted: false, pressedBy: "editor", hostPressId: "press"});
    await expect(executor.pressRelayed({automationId, collectionPath: "Tasks", definitionHash: authority.definitionHash,
      pressId: "press", recordId: "record", pressedBy: "editor", confirmed: []}, () => undefined)).rejects.toThrow(SHARED_BUTTON_DENIED);
    expect(await executor.retry({automationId, claimId: "claim", startOver: false})).toEqual({status: "refused", reason: SHARED_BUTTON_DENIED});
    expect(errors.mock.calls.some(([, error]) => String(error).includes("Private Budget is restricted for Ana"))).toBe(true);
    // Inspection was ready, then cached sharing changed before press checked again.
    vi.mocked(seams.runnableButtonState).mockResolvedValueOnce({kind: "ready", automationId} as unknown as Awaited<ReturnType<typeof seams.runnableButtonState>>);
    const pressEngine = engine as unknown as {getAutomationClaim: () => Promise<{claim: null}>};
    pressEngine.getAutomationClaim = async () => ({claim: null});
    await expect(executor.pressRelayed({automationId, collectionPath: "Tasks", definitionHash: authority.definitionHash,
      pressId: "race", recordId: "record", pressedBy: "editor", confirmed: []}, () => undefined)).rejects.toThrow(SHARED_BUTTON_DENIED);

  } finally {await executor.dispose(); await evaluator.close();}
});
