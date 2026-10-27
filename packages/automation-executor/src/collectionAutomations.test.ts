import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { AutomationStoreNotOpenedError, createAutomationRunStore } from "./automationRunStore";
import { CollectionAutomations, type CollectionAutomationEngine, type CollectionAutomationsOptions } from "./collectionAutomations";
import { definitionHash } from "./automationPlan";
import { newRun } from "./collectionAutomationRun";
import { SHARED_BUTTON_DENIED } from "./buttonPresser";
import type { RelayButtonAuthority } from "@dohc/workspace-contracts/relay";
import { createTestScratch, testStoreFolder } from "./testScratch";

it("labels unconfirmed receipts in History, including created records", async () => {
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-history-unconfirmed-")));
  const evaluator = createAutomationFormulaEvaluator();
  const text = "version: 1\nautomations:\n  - id: change\n    name: Change\n    when: record-added\n    do: [{set: {A: 1}}]\n";
  const parsed = parseAutomationsFile(text);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("invalid fixture");
  const claim = { claimId: "claim", automationId: "collection:Tasks#change", trigger: { historyId: 1 }, recordId: "record", collectionPath: "Tasks", depth: 0,
    change: { kind: "added", onBehalfOf: null, actorKind: "human", fields: [], fieldsOmitted: 0 }, state: "failed", attempts: 1, run: 1, createdAtMs: 1, updatedAtMs: 2, error: "refused" };
  const state = newRun(claim, parsed.entries[0].automation, "key", 1);
  state.outcome = { state: "failed", error: "refused", run: 1, step: 0 };
  state.finishedAtMs = Date.now();
  state.steps = [
    { ordinal: 0, effects: [{ kind: "set", target: { recordId: "record", collectionPath: "Tasks", path: "Tasks/one.md" }, fields: [{ field: "A", before: 0, after: 1 }] }] },
    { ordinal: 1, effects: [{ kind: "add", recordId: "lost", collectionPath: "Tasks", name: "lost", fields: [] }] },
  ];
  state.applied = [
    { ordinal: 0, writes: [{ kind: "field", recordId: "record", path: "Tasks/one.md", field: "A", before: 0, after: 1 }] },
    { ordinal: 1, writes: [{ kind: "created", recordId: "lost", path: "Tasks/lost.md" }] },
  ];
  state.applied[1]!.writes.push({ kind: "kept", recordId: "record", path: "Tasks/one.md", field: "B", planned: 1, current: 2 },
    { kind: "skipped", recordId: "missing", path: "Tasks/missing.md", reason: "gone" });
  state.durableEffects = 1;
  state.created = [{ ordinal: 1, planned: "lost", recordId: "lost", path: "Tasks/lost.md" }];
  await store.save(state);
  const roster = { kind: "owner" as const, ownerUserId: null, grants: [] };
  const engine = { listCollections: async () => ({ collections: [{ path: "Tasks", objectId: "Tasks", status: "valid", reasons: [] }] }),
    subscribeAutomation: async () => {}, releaseAutomationGroups: async () => ({ watchedGeneration: 0, handover: { floorMs: 0, automations: [] } }),
    claimNextAutomation: async () => null, getAutomationClaim: async () => ({ claim }), listAutomationClaims: async () => ({ claims: [], next: null }),
    listAutomationFailures: async () => ({ failures: [] }), pruneAutomationHistory: async () => ({ pruned: 0, more: false }) } as unknown as CollectionAutomationEngine;
  const executor = new CollectionAutomations({ withEngine: async work => work(engine),
    withRecordWrites: async () => { throw Error("unexpected write"); }, withUndoWrites: async () => { throw Error("unexpected undo"); },
    readText: async path => path === "Tasks/automations.yaml" ? { text, truncated: false, contentHash: "hash" } : null,
    writeText: async () => ({ status: "conflict" }), pathExists: async () => true, roster: async () => roster, cachedRoster: async () => roster,
    evaluator: evaluator.forWorkspace("workspace"), store, personName: id => id, withDatasetHost: async () => null, groupHost: async () => null,
    groupRelayRecord: async () => ({ generation: 0, handover: null }), reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
    groupMessagesSkipped: async () => {}, requestHost: async () => {}, readMessageBody: async () => null,
    chat: { hasMessage: async () => false, directory: async () => null, write: async () => {} }, postNotice: async () => {}, mayRetryPress: async () => false,
    onPressSettled: () => {}, onPressWaiting: () => {}, onRunsChanged: () => {}, reportFailure: async () => {}, withdrawFailure: async () => {},
    onSwitchedOff: () => {}, onHoldsChanged: () => {}, onAutomationsChanged: () => {}, onError: (_where, error) => { throw error; },
  });
  try {
    await executor.open();
    const history = await executor.run(claim.automationId, claim.claimId);
    expect(history?.steps).toEqual([{ step: 1, writes: state.applied[0]!.writes },
      { step: 2, writes: [{ ...state.applied[1]!.writes[0]!, unconfirmed: true }, ...state.applied[1]!.writes.slice(1)] }]);
  } finally { await executor.dispose(); await evaluator.close(); }
});

function emptyExecutor(store: CollectionAutomationsOptions["store"], overrides: Partial<CollectionAutomationsOptions> = {}) {
  const engine = {
    listCollections: async () => ({ collections: [] }),
    releaseAutomationGroups: async () => ({ watchedGeneration: 0, handover: { floorMs: 0, automations: [] } }),
    claimNextAutomation: async () => null,
    listAutomationClaims: async () => ({ claims: [], next: null }),
    listAutomationFailures: async () => ({ failures: [] }),
    pruneAutomationHistory: async () => ({ pruned: 0, more: false }),
  } as unknown as CollectionAutomationEngine;
  const roster = { kind: "owner" as const, ownerUserId: "owner", grants: [] };
  const evaluator = createAutomationFormulaEvaluator();
  const executor = new CollectionAutomations({
    withEngine: async work => work(engine),
    withRecordWrites: async () => { throw Error("Unexpected record write"); },
    withUndoWrites: async () => { throw Error("Unexpected Undo"); },
    readText: async () => null, writeText: async () => ({ status: "conflict" }), pathExists: async () => false,
    roster: async () => roster, cachedRoster: async () => roster,
    evaluator: evaluator.forWorkspace("workspace"), store, personName: userId => userId,
    withDatasetHost: async () => null, groupHost: async () => null,
    groupRelayRecord: async () => ({ generation: 0, handover: null }),
    reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
    groupMessagesSkipped: async () => undefined, requestHost: async () => undefined, readMessageBody: async () => "",
    chat: { hasMessage: async () => false, directory: async () => null, write: async () => { throw Error("Unexpected chat"); } }, postNotice: async () => undefined,
    mayRetryPress: async () => false, onPressSettled: () => undefined, onPressWaiting: () => undefined,
    onRunsChanged: () => undefined, reportFailure: async () => undefined, withdrawFailure: async () => undefined,
    onSwitchedOff: () => undefined, onHoldsChanged: () => undefined, onAutomationsChanged: () => undefined,
    onError: vi.fn(), ...overrides,
  });
  return { executor, evaluator, engine };
}

it("retries a busy reconcile during background open without rejecting or reporting a failure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-open-busy-")));
  const errors = vi.fn((_where: string, error: unknown) => { throw error; });
  const reconciled = Promise.withResolvers<void>();
  const { executor, evaluator, engine } = emptyExecutor(store, {
    onError: errors, onAutomationsChanged: () => reconciled.resolve(),
  });
  const busy = new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, undefined);
  const release = vi.spyOn(engine, "releaseAutomationGroups").mockRejectedValueOnce(busy);
  const opened = Promise.withResolvers<void>();
  // The relay starts open in the background and forwards rejections to its error reporter.
  void executor.open().then(() => opened.resolve(), (error: unknown) => { opened.resolve(); throw error; });
  try {
    await opened.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(errors).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await reconciled.promise;
    await executor.idle();
    expect(release).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await executor.dispose();
    await evaluator.close();
    vi.useRealTimers();
  }
});

it.each([false, true])("opens once the workspace opens, after an open that came first could not read the run store (still opening: %s)", async (stillOpening) => {
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-open-before-workspace-")));
  const changed = vi.fn();
  const { executor, evaluator } = emptyExecutor(store, { onAutomationsChanged: changed });
  vi.spyOn(store, "readReachVerdicts").mockRejectedValueOnce(new AutomationStoreNotOpenedError("The workspace has not finished opening."));
  try {
    const first = executor.open();
    if (!stillOpening) await first;
    await executor.workspaceOpened();
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    await executor.dispose();
    await evaluator.close();
  }
});

it.each([false, true])("reports a non-retryable reconcile refusal through the open error path (after busy: %s)", async (afterBusy) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-open-refused-")));
  const reported = Promise.withResolvers<void>();
  const errors = vi.fn(() => reported.resolve());
  const { executor, evaluator, engine } = emptyExecutor(store, { onError: errors });
  const refusal = new DaemonRefusalError({ code: "INVALID_PARAMS", message: "invalid-input", retry: "no" }, undefined);
  const release = vi.spyOn(engine, "releaseAutomationGroups");
  if (afterBusy) release.mockRejectedValueOnce(new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, undefined));
  release.mockRejectedValueOnce(refusal);
  try {
    await executor.open();
    if (afterBusy) {
      expect(errors).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await reported.promise;
    }
    expect(errors).toHaveBeenCalledExactlyOnceWith("open Collection automations", refusal);
  } finally {
    await executor.dispose();
    await evaluator.close();
    vi.useRealTimers();
  }
});

it.each([
  ["close", "listCollections"], ["dispose", "listCollections"],
  ["close", "releaseAutomationGroups"], ["dispose", "releaseAutomationGroups"],
] as const)("cancels a busy open retry on %s after %s refuses", async (operation, method) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-open-busy-stop-")));
  const errors = vi.fn();
  const { executor, evaluator, engine } = emptyExecutor(store, { onError: errors });
  const open = vi.spyOn(executor, "open");
  const refused = vi.spyOn(engine, method).mockRejectedValueOnce(
    new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, undefined),
  );
  try {
    await executor.open();
    await executor[operation]();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(open).toHaveBeenCalledOnce();
    expect(refused).toHaveBeenCalledOnce();
    expect(executor.schedules()).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await executor.dispose();
    await evaluator.close();
    vi.useRealTimers();
  }
});

it.each(["listCollections", "releaseAutomationGroups"] as const)("resumes a busy open after an engine restart when %s refuses", async (method) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-open-busy-restart-")));
  const errors = vi.fn();
  const reconciled = Promise.withResolvers<void>();
  const { executor, evaluator, engine } = emptyExecutor(store, {
    onError: errors, onAutomationsChanged: () => reconciled.resolve(),
  });
  const refused = vi.spyOn(engine, method).mockRejectedValueOnce(
    new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, undefined),
  );
  try {
    await executor.open();
    executor.pauseForEngineRestart();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refused).toHaveBeenCalledOnce();
    executor.resumeAfterEngineRestart();
    await expect.poll(() => refused.mock.calls.length).toBe(2);
    await reconciled.promise;
    expect(executor.schedules()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await executor.dispose();
    await evaluator.close();
    vi.useRealTimers();
  }
});

it.each(["listCollections", "releaseAutomationGroups"] as const)("stays closed when closed during an engine restart after %s refuses", async (method) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-open-busy-restart-close-")));
  const errors = vi.fn();
  const { executor, evaluator, engine } = emptyExecutor(store, { onError: errors });
  const refused = vi.spyOn(engine, method).mockRejectedValueOnce(
    new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, undefined),
  );
  // Every open starts by reading subscriptions, so a reopen shows here first.
  const opens = vi.spyOn(store, "readSubscriptions");
  try {
    await executor.open();
    executor.pauseForEngineRestart();
    await executor.close();
    executor.resumeAfterEngineRestart();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opens).toHaveBeenCalledOnce();
    expect(refused).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await executor.dispose();
    await evaluator.close();
    vi.useRealTimers();
  }
});

it.each(["close", "dispose"] as const)("waits for the current run history prune batch on %s without starting another", async (operation) => {
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch(`dohc-${operation}-pruning-`)));
  const entered = Promise.withResolvers<void>();
  const batch = Promise.withResolvers<string | null>();
  const expire = vi.spyOn(store, "expire").mockImplementation(() => {
    entered.resolve();
    return batch.promise;
  });
  const { executor, evaluator } = emptyExecutor(store);
  let closing: Promise<void> | undefined;
  try {
    await executor.open();
    await entered.promise;
    await executor.idle();
    closing = executor[operation]();
    const state = await Promise.race([
      closing.then(() => "closed"),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    expect(state).toBe("pending");
    batch.resolve("next-batch");
    await closing;
    expect(expire).toHaveBeenCalledOnce();
  } finally {
    batch.resolve(null);
    await closing;
    await executor.dispose();
    await evaluator.close();
  }
});

it("closes when run history pruning has never started", async () => {
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-close-no-pruning-")));
  const expire = vi.spyOn(store, "expire");
  let closing: Promise<void> | undefined;
  const { executor, evaluator } = emptyExecutor(store, {
    onAutomationsChanged: () => { closing = executor.close(); },
  });
  try {
    await executor.open();
    expect(closing).toBeDefined();
    await closing;
    expect(expire).not.toHaveBeenCalled();
  } finally {
    await executor.dispose();
    await evaluator.close();
  }
});

it("persists unchanged reach verdicts after the first save fails", async () => {
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-reach-save-")));
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
    chat: { hasMessage: async () => false, directory: async () => null, write: async () => { throw Error("Unexpected chat"); } }, postNotice: async () => undefined,
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

it("keeps private reach reasons out of a recipient's direct press and retry", async () => {
  const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-button-privacy-")));
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
    chat: { hasMessage: async () => false, directory: async () => null, write: async () => { throw Error("Unexpected chat"); } }, postNotice: async () => undefined,
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
