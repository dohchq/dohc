import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import type { ScheduledAutomation, CollectionAutomationRun, CollectionAutomationsOptions, DatasetAutomationHost, CollectionAutomationHold } from "@dohc/automation-executor/collection-automations";
import type { AutomationRunStore, StoredRun, StoredStep } from "@dohc/automation-executor/automation-run-store";
import { runSteps, type StepBackend } from "@dohc/automation-executor/automation-step-run";
import { newRun } from "@dohc/automation-executor/collection-automation-run";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { AUTOMATION_SERVER_MAX_WORKSPACES } from "@dohc/workspace-contracts/relay";
import type {RelayButtonInspection} from "@dohc/workspace-contracts/relay";
import {SHARED_BUTTON_DENIED, SHARED_BUTTON_HELD, SHARED_BUTTON_MOVED, SHARED_BUTTON_FIELD_CHANGED, SHARED_BUTTON_UNCHECKED} from "@dohc/automation-executor/button-presser";
import type { ReachHandover } from "@dohc/automation-executor/reach-verdicts";
import { DaemonRefusalError, OwnerYDocOutbox, VersionedLiveAdapter, type AutomationClaim, type AutomationGroupHandover, type MomentRecord } from "@dohc/workspace-engine-client";
import { AUTOMATION_SWITCHED_OFF_BODY, AUTOMATION_SWITCHED_OFF_VIEW_BODY } from "@dohc/automation-executor/automation-failed-notice";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { OwnerYDocOutboxDrainer } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import * as daemon from "@dohc/workspace-engine-client/daemon";
import { startAutomationReplicas, type AutomationReplica } from "./automationReplicas";
import type { LiveClaimLedger } from "./automationLiveClaims";
import { createRunGate, SERVER_RUN_BURST, startAutomationServer, type AutomationServerOptions, type ServerExecutor } from "./automationServer";
import type { Event } from "@dohc/workspace-engine-client";
import type { ServerRuns } from "./automationServerRoutes";
import { AUTOMATION_WORKSPACE_LEAVE_AFTER_MS } from "./storage/automationWorkspaces";
import type { RelayDatasetHost } from "./datasetHost";
import type { SyncRelayStorage } from "./storage";
import {
  claimWorkspace, closeTestStorages, createShare, inspectDatabase, json, jsonBody, request, storagePath, testHandler, testStorage,
} from "./testing";

// The server runs a workspace's automations in process: it follows the host
// record through the real relay routes and storage, runs schedules with the
// real scheduler on a clock the test sets, takes presses from shared views,
// and posts its notices into the relay's list. The executor and the replica
// are fakes at the engine's edge.

const WORKSPACE = "workspace-trip";
const OWNER = "owner";
const HOUR = 3_600_000;
const at = (hour: number, minute = 0) => Date.UTC(2026, 8, 27, hour, minute);
const HOURLY: ScheduledAutomation = {
  automationId: "collection:Tasks#hourly", collectionPath: "Tasks", name: "Hourly",
  trigger: { kind: "schedule", every: "hour", at: ":00", timezone: "UTC" }, scheduleHash: "hash-hourly", enabledSince: null,
};
const PRESSED = "collection:Tasks#pay";
const HELD = {
  collectionPath: "Budget",
  automationId: PRESSED, automationName: "Pay", definitionHash: "0123456789abcdef", step: "0", seq: 7,
  collection: "Tasks", target: "Invoices", action: "change" as const, stoppedFor: "Ana", fileUnread: false,
};

// What the laptop and the server each carry in a release.
const groups = (floorMs: number, messageId: string): AutomationGroupHandover => ({
  floorMs, automations: [{ automationId: "collection:Tasks#task", sinceMs: 1, decided: [{ messageId, createdAtMs: floorMs - 1 }] }],
});
const reach = (verdict: "stopped" | "held", seq: number): ReachHandover => ({
  version: 2, unproven: [], unprovenAll: false, unprovenFolders: [], unprovenPaths: [],
  verdicts: [{ automationId: PRESSED, definitionHash: "hash-pay", step: "0", verdict, stoppedFor: verdict === "stopped" ? "ana" : null, seq }],
});

let clock = at(8);
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  closeTestStorages();
});
const cleanup: Array<() => Promise<void>> = [];

function fakeExecutor(
  options: CollectionAutomationsOptions,
  marks: Map<string, { automationId: string; scheduleHash: string; throughMs: number }>,
  engine: { answers: boolean } = { answers: true },
  scheduled: ScheduledAutomation[] = [HOURLY],
) {
  let opened = false;
  let marksAsked = 0;
  const claims: Array<{ run: number[]; throughMs: number }> = [];
  const pressed: Array<{ pressId: string; pressedBy: string }> = [];
  let hostChanges = 0;
  let claimWakes = 0;
  const holds: CollectionAutomationHold[] = [];
  // What the owner's routes asked of this executor, in order.
  const asked: unknown[] = [];
  const executor: ServerExecutor = {
    holds: () => [...holds],
    open: async () => {
      opened = true;
      options.onSchedulesChanged?.();
    },
    dispose: async () => undefined,
    notifyClaimed: () => { claimWakes += 1; },
    failuresChanged: vi.fn(),
    datasetsChanged: () => undefined,
    pressDataset: async () => ({busy: true}),
    handlePulledPaths: () => undefined,
    relayAnswered: () => undefined,
    groupMessagesArrived: async () => undefined,
    hostChanged: () => { hostChanges += 1; },
    releaseGroupSubscriptions: async () => ({ handover: groups(at(10, 30), "message-on-server"), watchedGeneration: 3 }),
    reachHandover: async () => reach("held", 9),
    relayedClaim: async () => null,
    inspectRelayedBatch: async ids => ids.map(() => ({ kind: "unchecked", reason: "Host unavailable" })),
    pressRelayed: async (input, watch) => {
      pressed.push({ pressId: input.pressId, pressedBy: input.pressedBy });
      watch(`claim-${input.pressId}`, null);
      return { pressed: { busy: false, claimId: `claim-${input.pressId}`, settled: null }, field: "Mark paid" };
    },
    automationName: () => "Pay",
    schedules: () => (opened ? scheduled : null),
    scheduleMarks: async () => {
      marksAsked += 1;
      return engine.answers ? [...marks.values()] : null;
    },
    claimSchedule: async (input) => {
      claims.push({ run: input.run, throughMs: input.throughMs });
      const mark = { automationId: input.automationId, scheduleHash: input.scheduleHash, throughMs: input.throughMs };
      marks.set(input.automationId, mark);
      return mark;
    },
    runs: async (automationId, before) => {
      asked.push(["runs", automationId, before]);
      return { runs: [{ claimId: "claim-1", state: "failed", error: "boom", createdAtMs: 1, updatedAtMs: 2, trigger: { kind: "changed", recordId: "record", by: "human", depth: 0, sharedAuthor: null }, writes: [], definitionChanged: false, neverStarted: false, chainStopped: false, undoUnfinished: false, undone: false }], next: null };
    },
    listedRun: async (automationId, claimId) => {
      asked.push(["get", automationId, claimId]);
      return null;
    },
    hasRun: async (_automationId, claimId) => claimId === "claim-1",
    retry: async (input) => {
      asked.push(["retry", input, await options.mayRetryPress("ana")]);
      return { status: "queued", press: false };
    },
    undo: async (input) => {
      asked.push(["undo", input]);
      return { status: "undone", reverted: 1, removed: 0, kept: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0, deleted: 0, keptChanged: 0, gone: 0 };
    },
    removePendingRestore: async id => { asked.push(["releaseRestore", id]); },
    undoRunsOf: async (definitions, _trash, again, retentionId) => {
      expect(retentionId).toBe("desktop:restore-test");
      asked.push(["restore", definitions, again]);
      return { undone: definitions.length, left: 0, reverted: 1, missing: 0, keptFields: [], otherKept: 0, errorMessage: null };
    },
    confirmReach: async (input) => {
      asked.push(["allow", input]);
      return input.seq === HELD.seq ? "confirmed" : "changed";
    },
  };
  return { executor, options, holds, claims, pressed, asked, claimWakes: () => claimWakes, hostChanges: () => hostChanges, marksAsked: () => marksAsked };
}

type Fake = ReturnType<typeof fakeExecutor>;

async function relay() {
  const storage = await testStorage();
  const h = testHandler(storage, { nowMs: () => clock, automationServer: { label: "My dohc server" } });
  await claimWorkspace(h, OWNER, WORKSPACE);
  const host = async (action: string, body?: Record<string, unknown>) => {
    const response = await h(request(OWNER, `/sync/${WORKSPACE}/automation-host${action}`, body ? jsonBody(body) : {}));
    return { status: response.status, body: await json(response) };
  };
  return { storage, h, host };
}

async function server(storage: SyncRelayStorage, h: Pick<ReturnType<typeof testHandler>, "readOwnerShares">, input: {
  datasetHost?: RelayDatasetHost;
  marks?: Map<string, { automationId: string; scheduleHash: string; throughMs: number }>;
  incarnation?: number;
  startedAtMs?: number;
  engine?: { answers: boolean };
  schedules?: ScheduledAutomation[];
  /** The copy's sync; succeeds at once unless a test says otherwise. */
  sync?: () => Promise<void>;
  live?: AutomationServerOptions["live"];
  client?: EngineClient;
  inspection?: RelayButtonInspection;
  recordDelivery?: AutomationServerOptions["recordDelivery"];
  root?: string;
  startReplicas?: typeof startAutomationReplicas;
} = {}) {
  const marks = input.marks ?? new Map();
  const executors: Fake[] = [];
  const open = new Map<string, AutomationReplica>();
  let pulledHead = 0;
  const sync = vi.fn(async () => {
    await input.sync?.();
    pulledHead = storage.automationWorkspaceLogHead(WORKSPACE);
  });
  let hooks: Parameters<typeof startAutomationReplicas>[0] | undefined;
  const errors: Array<[string, unknown]> = [];
  const run = await startAutomationServer({
    storage, datasetHost: input.datasetHost,
    server: { label: "My dohc server" },
    replicas: { root: input.root ?? "unused", engineExecutable: "unused", relayOrigin: "https://relay.example.test", key: new Uint8Array(32), namespace: "test" },
    readOwnerShares: (ownerUserId, path) => h.readOwnerShares(ownerUserId, path),
    lookupUserDisplayName: (userId) => (userId === OWNER ? "Ice" : "Ana"),
    noticeLimiter: new TokenBucketLimiter(10, 1, 100),
    onError: (context, error) => errors.push([context, error]),
    nowMs: () => clock,
    // The scheduler wakes when the host changes or a test steps it.
    clock: { now: () => clock, monotonic: () => clock, setTimer: () => null, clearTimer: () => undefined },
    startReplicas: async (options) => {
      hooks = options;
      if (input.startReplicas) return await input.startReplicas(options);
      return { unavailable: false, replica: (id) => open.get(id), reconcile: () => undefined, deleteWorkspaces: async () => undefined,
      failedSyncs: () => new Map(), settled: async () => undefined, close: async () => undefined };
    },
    ...(input.live ? { live: input.live } : {}),
    ...(input.recordDelivery ? {recordDelivery: input.recordDelivery} : {}),
    createExecutor: (options) => {
      const fake = fakeExecutor(options, marks, input.engine, input.schedules);
      if (input.inspection) fake.executor.inspectRelayedBatch = async ids => ids.map(() => input.inspection!);
      executors.push(fake);
      return fake.executor;
    },
  });
  cleanup.push(() => run.close());
  return {
    run, errors, marks, sync,
    /** What the replicas module reports to the server. */
    replicaHooks: () => hooks!,
    /** What the replicas module is asked to keep. */
    wanted: () => hooks!.wanted(),
    /** The replicas module opened this server's copy of the workspace. */
    async openReplica(): Promise<Fake> {
      const signal = new AbortController().signal;
      open.set(WORKSPACE, {
        workspaceId: WORKSPACE, ownerUserId: OWNER, incarnation: input.incarnation ?? 1, startedAtMs: input.startedAtMs ?? at(7),
        root: "unused", metadataDir: "unused", client: input.client ?? {} as unknown as EngineClient, workspace: "handle", signal,
        nextRequestId: () => 1, sync, withRecordWork: work => work(), get pulledHead() { return pulledHead; },
      });
      hooks!.onChanged?.(WORKSPACE);
      await vi.waitFor(() => expect(executors).toHaveLength(1));
      // Most fake replicas keep no History. A test can provide a real client or override these instance reads.
      if (input.client === undefined) await executors[0]!.options.withEngine(async (engine) => {
        if (!(engine instanceof VersionedLiveAdapter)) throw new Error("Expected the replica adapter");
        vi.spyOn(engine, "flushCapture").mockResolvedValue({ settled: true, running: false, degraded: false, heldFiles: [], deferredWrites: [] });
        vi.spyOn(engine, "getActiveVersion").mockImplementation((params) => {
          // Existing write tests supply a prototype implementation.
          return vi.isMockFunction(VersionedLiveAdapter.prototype.getActiveVersion)
            ? VersionedLiveAdapter.prototype.getActiveVersion.call(engine, params) : Promise.resolve(null);
        });
      });
      return executors[0]!;
    },
  };
}

const notices = (storage: SyncRelayStorage, userId: string) =>
  storage.readNoticeChanges({ recipientUserId: userId, cursor: null, limit: 50, nowMs: clock }).notices;

function resolvers() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function payAutomation() {
  const parsed = parseAutomationsFile("version: 1\nautomations:\n  - id: pay\n    name: Pay\n    when: record-added\n    do: [{set: {Status: Paid}}]\n");
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("invalid fixture");
  return parsed.entries[0].automation;
}
const setStatus = (n: number): StoredStep["effects"][number] => ({ kind: "set", target: { recordId: `record-${n}`, collectionPath: "Tasks", path: `Tasks/${n}.md` },
  fields: [{ field: "Status", before: "Open", after: "Paid" }] });
/** A run of Pay, as the server's executor starts one in its copy. */
const payRunRecord = (claimId: string): StoredRun => ({ ...newRun({ automationId: PRESSED, claimId }, payAutomation(), `seed-${claimId}`, clock),
  collections: [{ collectionId: "Tasks", path: "Tasks" }] });

/**
 * One run of Pay through the executor's own step runner, with the hooks the
 * server gives its executor. Its step sets Status on `effects` records.
 */
function payRun(options: CollectionAutomationsOptions, claimId: string, effects: number) {
  const automation = payAutomation();
  const claim = { claimId, automationId: PRESSED, collectionPath: "Tasks", createdAtMs: clock, change: { kind: "added" as const, fields: [], fieldsOmitted: 0 } };
  const run = newRun(claim, automation, `seed-${claimId}`, clock);
  // Each save, as `outcome:durableEffects`.
  const saves: string[] = [];
  const backend: StepBackend = {
    step: (async () => ({ step: { ordinal: 0, effects: Array.from({ length: effects }, (_, n) => setStatus(n)) } })) as StepBackend["step"],
    collectionsOf: () => [{ collectionId: "Tasks", path: "Tasks" }],
    added: () => null,
    apply: async (_run, effect) => effect.kind === "set"
      ? [{ kind: "field", recordId: effect.target.recordId, path: effect.target.path, field: "Status", before: "Open", after: "Paid" }] : [],
  };
  const f = {
    run, saves, backend,
    onSave: async (_run: StoredRun): Promise<void> => undefined,
    execute: (saved: boolean) => runSteps(dependencies, backend, {
      automation, collection: { path: "Tasks", name: "Tasks" }, roster: { kind: "owner", ownerUserId: OWNER, grants: [] },
      signal: new AbortController().signal, stopped: new AbortController().signal, claimRun: 1, engineClaimId: claimId,
    }, { automation, claim, message: null, person: null, chat: null, nowMs: clock, key: { claimId, hash: "key" } }, run, saved, { prepareMs: 0, runMs: 0 }),
  };
  const store = {
    save: async (saved: StoredRun) => { saves.push(`${saved.outcome?.state ?? "open"}:${saved.durableEffects}`); await f.onSave(saved); },
    appendEffect: async () => undefined,
    appendStep: async () => { throw new Error("A fresh run saves its first step with the run."); },
  } as unknown as AutomationRunStore;
  const dependencies: Parameters<typeof runSteps>[0] = {
    store, nowMs: () => clock, makeDurable: async () => undefined,
    evaluator: { evaluate: async () => { throw new Error("Pay has no formulas."); }, runCode: async () => { throw new Error("Pay runs no code."); } },
    chat: { hasMessage: async () => false, directory: async () => null, write: async () => { throw new Error("Pay posts nothing."); } },
    recipientVerdicts: async () => [], readCode: async () => null,
    beforeEffect: options.beforeEffect, onRunEnded: options.onRunEnded,
  };
  return f;
}

describe("a server that runs a workspace's automations", () => {
  it("notifies the owner, last editor and triggering person of a breaker with current permission checks", async () => {
    const { storage, h } = await relay();
    await createShare(h, OWNER, WORKSPACE, { recipientUserId: "starter", paths: ["Tasks"], access: "edit" });
    await createShare(h, OWNER, WORKSPACE, { recipientUserId: "editor", paths: ["Tasks"], access: "edit" });
    const s = await server(storage, h);
    const fake = await s.openReplica();
    const before = "version: 1\nautomations:\n  - id: hourly\n    name: Old name\n    when: {field-changed: Status}\n    do: [{set: {X: 1}}]\n";
    const after = before.replace("Old name", "Hourly");
    const moment: MomentRecord = { momentOrder: 1, momentId: "edited", versionId: "main", objectId: "object", path: "Tasks/automations.yaml",
      recordedAtMs: clock, operation: "write", afterContentKind: "text", afterBlobSha256: "after", afterBinarySha256: null,
      beforePresent: true, beforeContentKind: "text", beforeBlobSha256: "before", beforeBinarySha256: null, beforeLatestMomentId: null,
      metadataOrigin: "api", authors: [{ kind: "named", userId: "editor", grantId: "grant-editor", grantGeneration: 1 }], syncRecordOnly: false,
      afterText: after, afterByteLength: after.length, afterInbandLimitBytes: null,
      beforeText: before, beforeByteLength: before.length, beforeInbandLimitBytes: null };
    await fake.options.withEngine(async (engine) => {
      if (!(engine instanceof VersionedLiveAdapter)) throw new Error("Expected the replica adapter");
      vi.spyOn(engine, "getActiveVersion").mockResolvedValue({ id: "main", workspaceId: WORKSPACE, kind: "main", name: "Main", createdAtMs: 0 });
      vi.spyOn(engine, "readTextFile").mockResolvedValue({ versionId: "main", path: "Tasks/automations.yaml", objectId: "object", contentKind: "text",
        text: after, blobSha256: "after", workspaceId: WORKSPACE, sha256: "after", byteLength: after.length, updatedAtMs: clock,
        latestMomentId: "edited", metadataOrigin: "api" });
      vi.spyOn(engine, "readHistoryPage").mockResolvedValue({
        activeVersion: { id: "main", workspaceId: WORKSPACE, kind: "main", name: "Main", createdAtMs: 0 },
        moments: [{...moment, beforePath: moment.beforePath ?? null}], protectedMoments: [], versionMarkers: [], latestMomentOrder: 1, nextCursor: null,
        startCursor: { format: 1, engineUuid: "test", workspaceId: WORKSPACE, versionId: "main", objectId: "object", operationId: null, textFence: 1, protectedFence: -1, markerFence: -1, text: null, protected: null, marker: null },
      });
      vi.spyOn(engine, "getMoment").mockResolvedValue(moment);
    });
    const failure = { automationId: HOURLY.automationId, claimId: "third-timeout", generation: 3,
      datasetInstance: null, neverStarted: false, chainStopped: false, error: "private-step-token".repeat(2_000), updatedAtMs: clock,
      switchedOff: { reason: "consecutive-timeouts" as const, collectionPath: "Tasks" } };
    await fake.options.reportFailure({ failure, name: "Hourly", collectionPath: "Tasks", startedBy: "starter", replaces: null });
    expect(notices(storage, OWNER)).toHaveLength(1);
    expect(notices(storage, OWNER)[0]!.body.startsWith(AUTOMATION_SWITCHED_OFF_BODY)).toBe(true);
    for (const person of ["starter", "editor"]) {
      expect(notices(storage, person)).toHaveLength(1);
      expect(notices(storage, person)[0]).toMatchObject({ body: AUTOMATION_SWITCHED_OFF_BODY,
        target: { recovery: "automation-controls", path: "Tasks/automations.yaml", automation: HOURLY.automationId } });
      expect(notices(storage, person)[0]!.target).not.toHaveProperty("run");
    }
    expect(notices(storage, "outsider")).toHaveLength(0);
    // The last editor now lacks access to Tasks. A later failure must not disclose even its safe copy to them.
    await fake.options.withEngine(async (engine) => {
      if (!(engine instanceof VersionedLiveAdapter)) throw new Error("Expected the replica adapter");
      vi.spyOn(engine, "getMoment").mockResolvedValue({ ...moment, authors: [{ kind: "named", userId: "outsider", grantId: "lost", grantGeneration: 1 }] });
    });
    await fake.options.reportFailure({ failure: { ...failure, generation: 4 }, name: "Hourly", collectionPath: "Tasks", startedBy: "starter", replaces: failure });
    expect(notices(storage, "outsider")).toHaveLength(0);
    expect(s.errors.some(([context]) => context.includes("another person involved"))).toBe(true);
  });

  it("tells a viewer to ask an editor and keeps the switch-off fact first", async () => {
    const { storage, h } = await relay();
    await createShare(h, OWNER, WORKSPACE, { recipientUserId: "viewer", paths: ["Tasks"], access: "view" });
    const s = await server(storage, h);
    const fake = await s.openReplica();
    await fake.options.reportFailure({ failure: { automationId: HOURLY.automationId, claimId: "third-timeout", generation: 3,
      datasetInstance: null, neverStarted: false, chainStopped: false, error: "private-step-token", updatedAtMs: clock,
      switchedOff: { reason: "consecutive-timeouts", collectionPath: "Tasks" } },
      name: "Hourly", collectionPath: "Tasks", startedBy: "viewer", replaces: null });
    expect(notices(storage, OWNER)[0]!.body.startsWith(AUTOMATION_SWITCHED_OFF_BODY)).toBe(true);
    expect(notices(storage, "viewer")[0]!.body).toBe(AUTOMATION_SWITCHED_OFF_VIEW_BODY);
    expect(notices(storage, "viewer")[0]!.body).not.toContain("private-step-token");
    await createShare(h, OWNER, WORKSPACE, { recipientUserId: "viewer", paths: ["Tasks"], access: "edit" });
    await fake.options.reportFailure({ failure: { automationId: HOURLY.automationId, claimId: "fourth-timeout", generation: 4,
      datasetInstance: null, neverStarted: false, chainStopped: false, error: "private-step-token", updatedAtMs: clock,
      switchedOff: { reason: "consecutive-timeouts", collectionPath: "Tasks" } },
      name: "Hourly", collectionPath: "Tasks", startedBy: "viewer", replaces: null });
    expect(notices(storage, "viewer")[1]!.body).toBe(AUTOMATION_SWITCHED_OFF_BODY);
  });

  it.each(["x".repeat(2_000), "界".repeat(700)])("delivers the owner's Notice when controls exceed the wire limit (%#)", async (collectionPath) => {
    const { storage, h } = await relay();
    const s = await server(storage, h);
    const fake = await s.openReplica();
    await fake.options.reportFailure({ failure: { automationId: HOURLY.automationId, claimId: "third-timeout", generation: 3,
      datasetInstance: null, neverStarted: false, chainStopped: false, error: "timeout", updatedAtMs: clock,
      switchedOff: { reason: "consecutive-timeouts", collectionPath } },
      name: "Hourly", collectionPath, startedBy: null, replaces: null });
    expect(notices(storage, OWNER)).toHaveLength(1);
    expect(notices(storage, OWNER)[0]!.body.startsWith(AUTOMATION_SWITCHED_OFF_BODY)).toBe(true);
    expect(notices(storage, OWNER)[0]!.target).toEqual({ automation: HOURLY.automationId, run: "third-timeout" });
  });
  it("returns a conflict for a write precondition refusal and throws other errors", async () => {
    const { storage, h } = await relay();
    const s = await server(storage, h);
    const fake = await s.openReplica();
    const path = "Tasks/automations.yaml";
    const text = "automations: []\n";
    const contentHash = createHash("sha256").update(text).digest("hex");
    const active = vi.spyOn(VersionedLiveAdapter.prototype, "getActiveVersion").mockResolvedValue({
      id: "main", workspaceId: WORKSPACE, kind: "main", name: "Main", createdAtMs: 0,
    });
    const read = vi.spyOn(VersionedLiveAdapter.prototype, "readTextFile").mockResolvedValue({
      versionId: "main", path, objectId: "object", contentKind: "text", text, blobSha256: contentHash,
      workspaceId: WORKSPACE, sha256: contentHash, byteLength: Buffer.byteLength(text), updatedAtMs: 0,
      latestMomentId: "moment", metadataOrigin: "api",
    });
    const refused = new DaemonRefusalError({ code: "CONFLICT", message: "write-precondition-failed", retry: "no" }, undefined);
    const write = vi.spyOn(VersionedLiveAdapter.prototype, "writeTextFile").mockRejectedValueOnce(refused);
    try {
      expect(await fake.options.readText(path)).toEqual({ text, truncated: false, contentHash });
      await expect(fake.options.writeText(path, "automations: []\n# switched off\n", contentHash, PRESSED))
        .resolves.toEqual({ status: "conflict" });
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ path, publish: true, expectedSha256: contentHash }));
      expect(s.sync).not.toHaveBeenCalled();
      for (const error of [
        new DaemonRefusalError({ code: "CONFLICT", message: "conflict-stale-target", retry: "no" }, undefined),
        new Error("write-precondition-failed"),
      ]) {
        write.mockRejectedValueOnce(error);
        await expect(fake.options.writeText(path, text, contentHash, PRESSED)).rejects.toBe(error);
      }
      expect(s.errors).toEqual([]);
    } finally {
      active.mockRestore();
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("loads a change author's name before handing the claim to the executor", async () => {
    const { storage, h } = await relay();
    const s = await server(storage, h);
    const fake = await s.openReplica();
    const claim: AutomationClaim = {
      claimId: "atc_changed", automationId: "collection:Tasks#stamp", trigger: { historyId: 7 },
      recordId: "rec_task", collectionPath: "Tasks", depth: 0,
      change: {
        kind: "changed", authorOriginId: null, actorKind: "human", onBehalfOf: "ana",
        sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0,
      },
      state: "running", attempts: 1, run: 1, createdAtMs: clock, updatedAtMs: clock,
    };
    const next = vi.spyOn(VersionedLiveAdapter.prototype, "claimNextAutomation").mockResolvedValueOnce(claim);
    try {
      expect(fake.options.personName("ana")).toBe("ana");
      await fake.options.withEngine(async (engine) => {
        expect(await engine.claimNextAutomation({ automationIdPrefix: "collection:" })).toEqual(claim);
        expect(fake.options.personName("ana")).toBe("Ana");
      });
    } finally {
      next.mockRestore();
    }
  });

  it("passes the run metadata to a wake with an opaque effect id", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const s = await server(storage, h);
    const fake = await s.openReplica();
    await expect(fake.options.chat.write(new AbortController().signal, {
      target: { kind: "agent" }, effectId: "opaque-effect", messageId: "message", threadId: "thread",
      automation: { automationId: HOURLY.automationId, name: "Hourly", depth: 1 }, body: "Check Tasks",
    }, { claimId: "claim/with/slashes", keySeed: "seed/with/slashes", startedAtMs: clock }))
      .resolves.toMatchObject({ name: "Ice" });
    expect(notices(storage, OWNER)[0]?.wake?.body).toBe("Check Tasks");
  });

  it("takes the schedules, Group coverage, and reach verdicts from a computer, and hands them back", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    // The owner chose the laptop, then this server.
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: false });
    expect((await host("/choose", { installId: "laptop", generation: 0 })).status).toBe(200);
    expect((await host("/choose", { installId: "server", generation: 1 })).body.host).toMatchObject({ installId: "server", handoverFrom: "laptop", generation: 2 });
    const s = await server(storage, h);
    const fake = await s.openReplica();
    expect(await fake.options.groupHost(), "the server runs nothing until the laptop releases").toBeNull();

    // The laptop ran its schedules through 8:00 and releases what it decided.
    clock = at(9, 1);
    expect((await host("/release", {
      installId: "laptop", generation: 2, releasedThroughMs: at(8), groups: groups(at(8), "message-on-laptop"), groupsWatched: 1, reach: reach("stopped", 4),
    })).status).toBe(200);

    // The server starts after the laptop: 9:00 runs here, and nothing before it.
    await vi.waitFor(() => expect(fake.claims).toEqual([{ run: [], throughMs: at(8) }, { run: [at(9)], throughMs: at(9, 1) }]));
    expect(await fake.options.groupHost()).toBe(3);
    expect(await fake.options.groupRelayRecord(3), "the laptop's decided messages, so each claims once")
      .toEqual({ generation: 3, handover: groups(at(8), "message-on-laptop") });
    expect(await fake.options.reachRelayRecord(3), "the step the laptop stopped stays stopped here")
      .toEqual({ generation: 3, reach: reach("stopped", 4), everShared: false });
    expect(storage.readAutomationServerSchedules(WORKSPACE)).toEqual({ incarnation: 1, hostGeneration: 3, hostReleasedMs: at(8), throughMs: at(9, 1), takenGeneration: 3, fenceGeneration: null });

    // The owner chooses the laptop again: the server steps once more and releases.
    clock = at(10, 30);
    expect((await host("/choose", { installId: "laptop", generation: 3 })).status).toBe(200);
    await vi.waitFor(async () => expect((await host("")).body.host).toEqual({
      installId: "laptop", generation: 5, handoverFrom: null, releasedThroughMs: at(10, 30),
    }));
    expect(fake.claims.at(-1)).toEqual({ run: [at(10)], throughMs: at(10, 30) });
    expect((await host("/groups?generation=5")).body, "the laptop takes what the server decided and held").toMatchObject({
      generation: 5, groups: groups(at(10, 30), "message-on-server"), reach: reach("held", 9),
    });
    expect(await fake.options.groupHost()).toBeNull();
    expect(storage.readAutomationServerSchedules(WORKSPACE)?.throughMs).toBe(at(10, 30));
    expect(s.errors).toEqual([]);
  });

  it("resumes a rebuilt copy at the latest progress on record, never at the host's older release", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    expect((await host("")).body.host).toMatchObject({ installId: "server", generation: 1 });
    // A laptop last released at 6:00. The last copy started here and ran 9:00.
    inspectDatabase(storagePath(storage)).prepare("UPDATE sync_relay_automation_hosts SET released_through_ms = ?").run(at(6));
    storage.recordAutomationServerStart({ workspaceId: WORKSPACE, incarnation: 1, generation: 1, releasedThroughMs: at(6) });
    storage.recordAutomationServerProgress({ workspaceId: WORKSPACE, throughMs: at(9) });
    // The server's clock went back: this copy begins at 8:40 with no marks.
    clock = at(8, 40);
    const s = await server(storage, h, { incarnation: 2, startedAtMs: at(8, 40) });
    const fake = await s.openReplica();
    await vi.waitFor(() => expect(fake.claims).toEqual([{ run: [], throughMs: at(9) }]));
    expect(storage.readAutomationServerSchedules(WORKSPACE)).toMatchObject({ incarnation: 2, hostGeneration: 1 });
    expect(notices(storage, OWNER)).toEqual([]);
  });

  it("resumes a rebuilt copy at its progress after the owner called a handover off", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: false });
    await host("/choose", { installId: "laptop", generation: 0 });
    await host("/choose", { installId: "server", generation: 1 });
    await host("/release", { installId: "laptop", generation: 2, releasedThroughMs: at(8), groups: groups(at(8), "m"), groupsWatched: 1, reach: reach("stopped", 4) });
    // The first copy took the laptop's release at generation 3 and ran through 10:00.
    storage.beginAutomationServerCopy({ workspaceId: WORKSPACE, incarnation: 1 });
    storage.recordAutomationServerTaken({ workspaceId: WORKSPACE, generation: 3 });
    storage.recordAutomationServerStart({ workspaceId: WORKSPACE, incarnation: 1, generation: 3, releasedThroughMs: at(8) });
    storage.recordAutomationServerProgress({ workspaceId: WORKSPACE, throughMs: at(10) });
    // The owner chose the laptop and then the server again, with no release between.
    await host("/choose", { installId: "laptop", generation: 3 });
    expect((await host("/choose", { installId: "server", generation: 4 })).body.host).toMatchObject({ installId: "server", generation: 5, handoverFrom: null });
    clock = at(9, 30);
    const s = await server(storage, h, { incarnation: 2 });
    const fake = await s.openReplica();
    await vi.waitFor(() => expect(fake.claims).toEqual([{ run: [], throughMs: at(10) }]));
    expect(await fake.options.groupRelayRecord(5), "the earlier copy took that release").toEqual({ generation: 3, handover: null });
  });

  it("resumes a rebuilt copy again after a restart that came before its marks landed", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    storage.beginAutomationServerCopy({ workspaceId: WORKSPACE, incarnation: 1 });
    storage.recordAutomationServerStart({ workspaceId: WORKSPACE, incarnation: 1, generation: 1, releasedThroughMs: null });
    storage.recordAutomationServerProgress({ workspaceId: WORKSPACE, throughMs: at(10) });
    clock = at(9, 30);
    // The engine of the new copy stops answering before the scheduler reads its marks.
    const first = await server(storage, h, { incarnation: 2, engine: { answers: false } });
    const stalled = await first.openReplica();
    await vi.waitFor(() => expect(stalled.marksAsked()).toBeGreaterThan(0));
    await first.run.close();
    expect(stalled.claims).toEqual([]);
    expect(storage.readAutomationServerSchedules(WORKSPACE), "not started yet").toMatchObject({ incarnation: 2, hostGeneration: null });
    // After the restart the copy still has no marks, so it resumes at its progress.
    const second = await server(storage, h, { incarnation: 2 });
    const fake = await second.openReplica();
    await vi.waitFor(() => expect(fake.claims).toEqual([{ run: [], throughMs: at(10) }]));
    await vi.waitFor(() => expect(storage.readAutomationServerSchedules(WORKSPACE)).toMatchObject({ incarnation: 2, hostGeneration: 1 }));
  });

  it("tells the owner which schedule times a rebuilt copy missed", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    storage.recordAutomationServerStart({ workspaceId: WORKSPACE, incarnation: 1, generation: 1, releasedThroughMs: null });
    storage.recordAutomationServerProgress({ workspaceId: WORKSPACE, throughMs: at(8) });
    clock = at(11, 30);
    const s = await server(storage, h, { incarnation: 2, startedAtMs: at(11, 30) });
    const fake = await s.openReplica();
    await vi.waitFor(() => expect(notices(storage, OWNER)).toEqual([expect.objectContaining({ kind: "schedule-skipped", title: "Hourly skipped 3 times" })]));
    expect(fake.claims).toEqual([{ run: [], throughMs: at(8) }, { run: [], throughMs: at(11, 30) }]);
  });

  it("takes no Group coverage or reach verdicts an earlier copy took, even one with no schedules, and takes a later release", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: false });
    await host("/choose", { installId: "laptop", generation: 0 });
    await host("/choose", { installId: "server", generation: 1 });
    await host("/release", { installId: "laptop", generation: 2, releasedThroughMs: at(8), groups: groups(at(8), "message-on-laptop"), groupsWatched: 1, reach: reach("stopped", 4) });
    // The first copy, which ran no schedules, was given the laptop's release.
    const first = await server(storage, h, { incarnation: 1, schedules: [] });
    const taking = await first.openReplica();
    expect(await taking.options.groupRelayRecord(3)).toEqual({ generation: 3, handover: groups(at(8), "message-on-laptop") });
    await first.run.close();
    const s = await server(storage, h, { incarnation: 2 });
    const fake = await s.openReplica();
    expect(await fake.options.groupRelayRecord(3), "Group triggers start from now").toEqual({ generation: 3, handover: null });
    expect(await fake.options.reachRelayRecord(3), "what it cannot prove, it holds").toEqual({ generation: 3, reach: null, everShared: false });

    // The owner moves the automations to the laptop and back: that release is new to this copy.
    clock = at(9);
    await host("/choose", { installId: "laptop", generation: 3 });
    await vi.waitFor(async () => expect((await host("")).body.host).toMatchObject({ installId: "laptop", generation: 5 }));
    await host("/choose", { installId: "server", generation: 5 });
    await host("/release", { installId: "laptop", generation: 6, releasedThroughMs: at(9), groups: groups(at(9), "later"), groupsWatched: 5, reach: reach("held", 6) });
    expect(await fake.options.groupRelayRecord(7)).toEqual({ generation: 7, handover: groups(at(9), "later") });
    expect(await fake.options.reachRelayRecord(7)).toEqual({ generation: 7, reach: reach("held", 6), everShared: false });
  });

  it.each([
    [{kind: "unchecked", reason: "Host unavailable"}, SHARED_BUTTON_UNCHECKED],
    [{kind: "denied", reason: "carol@x cannot view Payroll"}, SHARED_BUTTON_DENIED],
    [{kind: "denied", reason: "Private Collection does not support this step"}, SHARED_BUTTON_DENIED],
    [{kind: "denied", reason: SHARED_BUTTON_HELD}, SHARED_BUTTON_HELD],
    [{kind: "denied", reason: SHARED_BUTTON_MOVED}, SHARED_BUTTON_MOVED],
    [{kind: "denied", reason: SHARED_BUTTON_FIELD_CHANGED}, SHARED_BUTTON_FIELD_CHANGED],
  ] satisfies Array<[RelayButtonInspection, string]>)("answers an inspection safely with an initial press backlog: %j", async (inspectionResult, safeReason) => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    const shareId = await createShare(h, OWNER, WORKSPACE, { recipientUserId: "ana", paths: ["Tasks"], access: "edit" });
    const grant = storage.listActiveShareGrantsForRecipient(shareId, "ana")[0]!;
    const s = await server(storage, h, {inspection: inspectionResult});
    expect((await h(request("ana", `/sync/shares/${shareId}/automation-presses`, jsonBody({
      pressId: "initial", automationId: PRESSED, collectionPath: "Tasks", definitionHash: "0123456789abcdef", recordId: "rec-12", confirmed: [],
    })))).status).toBe(200);
    const list = storage.listAutomationPresses.bind(storage);
    const controller = new AbortController();
    let inspection: ReturnType<SyncRelayStorage["inspectAutomationButton"]> | undefined;
    let queued = 0;
    const spy = vi.spyOn(storage, "listAutomationPresses").mockImplementation(scope => {
      const presses = list(scope);
      if (presses.length > 0 && inspection === undefined) {
        inspection = storage.inspectAutomationButton({
          target: { automationId: PRESSED, collectionPath: "Tasks", definitionHash: "0123456789abcdef" },
          source: { workspaceId: WORKSPACE, shareId, grantId: grant.grantId, grantGeneration: grant.generation, userId: "ana" },
          id: "busy-server", signal: controller.signal, wake: () => {},
        });
        queued = storage.listButtonInspections(scope).length;
      }
      return presses;
    });
    try {
      const fake = await s.openReplica();
      await vi.waitFor(() => expect(fake.pressed).toHaveLength(1));
      expect(queued).toBe(1);
      // The fake executor answers unchecked; receiving it proves the request reached the host.
      await expect(inspection).resolves.toEqual({ kind: inspectionResult.kind, reason: safeReason });
      expect(s.errors.some(([, error]) => error instanceof Error && error.message === inspectionResult.reason)).toBe(true);
    } finally { controller.abort(); spy.mockRestore(); }
  });

  it("runs a press from a share view as the person who pressed, and tells them when it fails", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    const shareId = await createShare(h, OWNER, WORKSPACE, { recipientUserId: "ana", paths: ["Tasks"], access: "edit" });
    const s = await server(storage, h);
    const fake = await s.openReplica();

    const pressed = await h(request("ana", `/sync/shares/${shareId}/automation-presses`, jsonBody({
      pressId: "press-1", automationId: PRESSED, collectionPath: "Tasks", definitionHash: "0123456789abcdef", recordId: "rec-12", confirmed: [],
    })));
    expect(pressed.status).toBe(200);
    await vi.waitFor(() => expect(fake.pressed).toEqual([{ pressId: expect.any(String), pressedBy: "ana" }]));
    const [{ pressId }] = fake.pressed;

    fake.options.onPressSettled({ claimId: `claim-${pressId}`, outcome: "failed", error: "Tasks/one.md is not a record." });
    const failure = { automationId: PRESSED, claimId: `claim-${pressId}`, generation: 1, datasetInstance: null,
      neverStarted: false, chainStopped: false, error: "Tasks/one.md is not a record.", updatedAtMs: clock };
    await fake.options.reportFailure({ failure, name: "Mark paid", collectionPath: "Tasks", startedBy: "ana", replaces: null });
    await vi.waitFor(() => expect(notices(storage, "ana")).toHaveLength(1));
    expect(notices(storage, "ana")[0]!.noticeId).not.toContain("automation-press:");
    expect(inspectDatabase(storagePath(storage)).prepare("SELECT user_id, state, outcome FROM sync_relay_automation_presses").all())
      .toEqual([{ user_id: "ana", state: "settled", outcome: "failed" }]);
    await fake.options.withdrawFailure(failure);
    expect(notices(storage, "ana").filter(notice => notice.dismissedAtMs === null)).toEqual([]);
  });

  it("replaces the owner's failure notice by generation and withdraws it after a retry", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const s = await server(storage, h);
    const fake = await s.openReplica();
    const failure = {
      automationId: HOURLY.automationId, claimId: "claim-hourly", generation: 1,
      datasetInstance: null, neverStarted: false, chainStopped: false, error: "A field is missing.", updatedAtMs: clock,
    };
    await fake.options.reportFailure({ failure, name: "Hourly", collectionPath: "Tasks", startedBy: null, replaces: null });
    const first = notices(storage, OWNER)[0]!;
    expect(first).toMatchObject({
      originInstallId: "server", senderUserId: OWNER, dismissedAtMs: null,
      body: "A field is missing. It ran on My dohc server.",
      target: { path: "Tasks/automations.yaml", automation: HOURLY.automationId, run: failure.claimId },
    });
    const repeated = { ...failure, generation: 2 };
    await fake.options.reportFailure({ failure: repeated, name: "Hourly", collectionPath: "Tasks", startedBy: null, replaces: failure });
    const listed = notices(storage, OWNER);
    expect(listed.find((notice) => notice.noticeId === first.noticeId)?.dismissedAtMs).toBe(clock);
    const current = listed.find((notice) => notice.noticeId !== first.noticeId)!;
    expect(current.body).toBe("2 failures so far. A field is missing. It ran on My dohc server.");
    expect(current.dismissedAtMs).toBeNull();
    await fake.options.withdrawFailure(repeated);
    expect(notices(storage, OWNER).every((notice) => notice.dismissedAtMs === clock)).toBe(true);
  });

  it("routes failed-claim and retry events through the executor's failure ledger", async () => {
    const { storage, h } = await relay();
    const s = await server(storage, h);
    const fake = await s.openReplica();
    for (const change of [{ state: "failed" }, { state: "pending", run: 2 }]) {
      s.replicaHooks().onEngineEvent?.({ name: "automation.claimed", seq: 1, sessionGeneration: 1, payload: { workspaceId: WORKSPACE, ...change } });
    }
    expect(fake.executor.failuresChanged).toHaveBeenCalledTimes(2);
  });

  it("reports a chain stop without offering a run to retry", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const s = await server(storage, h);
    const fake = await s.openReplica();
    await fake.options.reportFailure({
      failure: {
        automationId: HOURLY.automationId, claimId: "chain-stopped", generation: 1,
        datasetInstance: null, neverStarted: true, chainStopped: true, error: "chain-stopped", updatedAtMs: clock,
      },
      name: "Hourly", collectionPath: "Tasks", startedBy: null, replaces: null,
    });
    expect(notices(storage, OWNER)[0]).toMatchObject({
      title: "An automation chain stopped",
      target: { path: "Tasks/automations.yaml", automation: HOURLY.automationId },
    });
    expect(notices(storage, OWNER)[0]!.target).not.toHaveProperty("run");
  });

  it("checks reach against the relay's own share records, which narrow and widen at once", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    const s = await server(storage, h);
    const fake = await s.openReplica();
    expect(await fake.options.roster()).toEqual({ kind: "owner", ownerUserId: OWNER, grants: [], formerEditors: [] });
    const shareId = await createShare(h, OWNER, WORKSPACE, { recipientUserId: "ana", paths: ["Tasks"], access: "edit" });
    expect(await fake.options.roster()).toMatchObject({ kind: "owner", grants: [{ recipientUserId: "ana", files: { paths: ["Tasks"], access: "edit" } }] });
    expect((await h(request(OWNER, `/sync/shares/${shareId}/revoke`, { method: "POST" }))).status).toBe(200);
    expect(await fake.options.roster()).toEqual({ kind: "owner", ownerUserId: OWNER, grants: [], formerEditors: [] });
  });

  it("reads the owner's shares without claiming an invite the owner has not opened", async () => {
    const storage = await testStorage();
    // Ana invites the owner by email before the relay knows that address.
    const h = testHandler(storage, { nowMs: () => clock, resolveUserIdByEmail: () => null });
    await claimWorkspace(h, "ana", "workspace-ana");
    const shareId = await createShare(h, "ana", "workspace-ana", { recipientEmail: "owner@dohc.test", paths: ["docs"] });
    expect((await h.readOwnerShares(OWNER, "/sync/shares")).status).toBe(200);
    expect(storage.listActiveShareGrantsForRecipient(shareId, OWNER), "the server claimed nothing").toEqual([]);
    // The owner's own listing claims it, as before.
    expect((await h(request(OWNER, "/sync/shares"))).status).toBe(200);
    expect(storage.listActiveShareGrantsForRecipient(shareId, OWNER)).toHaveLength(1);
  });

  it("holds a workspace past its run budget and tells the owner once that day", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    const s = await server(storage, h);
    const fake = await s.openReplica();
    const signal = new AbortController();
    for (let run = 0; run < SERVER_RUN_BURST; run += 1) (await fake.options.admitRun!(signal.signal))!.release(true);
    const waiting = fake.options.admitRun!(signal.signal);
    await vi.waitFor(() => expect(notices(storage, OWNER)).toEqual([expect.objectContaining({
      kind: "automation-failed", title: "Automations are waiting to run",
      body: "Your server runs up to 360 automations an hour in each workspace. The waiting ones run in order as the limit allows.",
    })]));
    signal.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it("tells the owner which schedule times it skipped while it was down", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    const marks = new Map([[HOURLY.automationId, { automationId: HOURLY.automationId, scheduleHash: HOURLY.scheduleHash, throughMs: at(8) }]]);
    // It started from this record before it went down.
    storage.recordAutomationServerStart({ workspaceId: WORKSPACE, incarnation: 1, generation: 1, releasedThroughMs: null });
    clock = at(11, 30);
    const s = await server(storage, h, { marks });
    await s.openReplica();
    await vi.waitFor(() => expect(notices(storage, OWNER)).toEqual([expect.objectContaining({
      kind: "schedule-skipped", title: "Hourly skipped 3 times", senderUserId: OWNER,
    })]));
  });
});

describe("a server whose copies of workspaces fail", () => {
  it("stays available when one workspace's copy fails, and not when a whole pass does", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const s = await server(storage, h);
    const hooks = s.replicaHooks();
    hooks.onReconciled?.();
    expect(s.run.unavailable).toBe(false);
    hooks.onError?.(new Error("the engine refused this workspace"), "broken");
    expect(s.run.unavailable, "one tenant does not take the server down").toBe(false);
    expect(s.errors.map(([context]) => context)).toEqual([`keep this server's copy of workspace "broken"`]);
    hooks.onError?.(new Error("the replicas folder is gone"));
    expect(s.run.unavailable).toBe(true);
    hooks.onReconciled?.();
    expect(s.run.unavailable).toBe(false);
  });
});

describe("a server that pushes its copy of a workspace", () => {
  it("flushes pending drafts at startup and still syncs while an owner device is offline", async () => {
    clock = at(8);
    const {storage, h} = await relay();
    const binding = {workspaceId: WORKSPACE, mainVersionId: "main", objectId: "record", lineageClaimId: "a".repeat(64),
      currentPath: "Tasks/one.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0};
    const draft = {binding, pendingBytes: 10, state: "active", outboxId: "outbox"};
    let rejectDelivery: (error: Error) => void = () => {};
    const preparing = new Promise<never>((_resolve, reject) => {rejectDelivery = reject;});
    const capture = vi.fn(() => preparing);
    const client = {ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft], next: null})),
      ownerYDocPrepareEnrollment: vi.fn(() => preparing)};
    vi.spyOn(storage, "automationRecordBinding").mockReturnValue({binding, shareId: "share"});
    const readHead = vi.spyOn(OwnerYDocOutbox.prototype, "readHead").mockResolvedValue({outboxId: "outbox", binding,
      baseUpdate: Uint8Array.of(0, 0), baseUpdateDigest: binding.lineageClaimId, state: "active", pendingBytes: 10,
      oldestEntryAtMs: 1, quarantineReason: null, observedBinding: null, retryDeliveryId: null,
      entry: {appendKey: "key", sequence: 1, deliveryId: "delivery", updateDigest: "b".repeat(64), update: Uint8Array.of(0, 0), byteLength: 2, createdAtMs: 1}});
    const currentBinding = vi.mocked(storage.automationRecordBinding);
    const s = await server(storage, h, {client: client as unknown as EngineClient,
      recordDelivery: {namespace: "relay", capture}});
    const fake = await s.openReplica();
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    await vi.waitFor(() => expect(s.sync).toHaveBeenCalledTimes(1));
    expect(client.ownerYDocListDrafts).toHaveBeenCalledWith(expect.anything(), {after: null, limit: 64, pendingOnly: true}, expect.anything());
    rejectDelivery(new Error("Device delivery is unavailable."));
    await vi.waitFor(() => expect(s.errors.some(([context]) => context.startsWith("deliver automation record"))).toBe(true));
    await fake.options.withRecordWrites(new AbortController().signal, async () => undefined);
    await vi.waitFor(() => expect(s.sync.mock.calls.length).toBeGreaterThan(1));
    readHead.mockRestore(); currentBinding.mockRestore();
  });
  it("delivers a quarantined draft whose owner asked to try again", async () => {
    clock = at(8);
    const {storage, h} = await relay();
    const binding = {workspaceId: WORKSPACE, mainVersionId: "main", objectId: "record", lineageClaimId: "a".repeat(64),
      currentPath: "Tasks/one.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0};
    const draft = {binding, pendingBytes: 10, state: "quarantined", outboxId: "outbox"};
    const capture = vi.fn(async () => {throw new Error("Device delivery is unavailable.");});
    const client = {ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft], next: null}))};
    vi.spyOn(storage, "automationRecordBinding").mockReturnValue({binding, shareId: "share"});
    const readHead = vi.spyOn(OwnerYDocOutbox.prototype, "readHead").mockResolvedValue({outboxId: "outbox", binding,
      baseUpdate: Uint8Array.of(0, 0), baseUpdateDigest: binding.lineageClaimId, state: "quarantined", pendingBytes: 10,
      oldestEntryAtMs: 1, quarantineReason: "invalid-update", observedBinding: null, retryDeliveryId: "delivery",
      entry: {appendKey: "key", sequence: 1, deliveryId: "delivery", updateDigest: "b".repeat(64), update: Uint8Array.of(0, 0), byteLength: 2, createdAtMs: 1}});
    const currentBinding = vi.mocked(storage.automationRecordBinding);
    const s = await server(storage, h, {client: client as unknown as EngineClient,
      recordDelivery: {namespace: "relay", capture}});
    await s.openReplica();
    await vi.waitFor(() => expect(s.errors.some(([context]) => context.startsWith("deliver automation record"))).toBe(true));
    expect(readHead).toHaveBeenCalledWith("outbox");
    expect(capture).toHaveBeenCalled();
    readHead.mockRestore(); currentBinding.mockRestore();
  });
  it("never captures a quarantined draft its owner has not asked to try again", async () => {
    clock = at(8);
    const {storage, h} = await relay();
    const binding = {workspaceId: WORKSPACE, mainVersionId: "main", objectId: "record", lineageClaimId: "a".repeat(64),
      currentPath: "Tasks/one.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0};
    const draft = {binding, pendingBytes: 10, state: "quarantined", outboxId: "outbox"};
    const capture = vi.fn(async () => {throw new Error("Device delivery is unavailable.");});
    const client = {ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft], next: null}))};
    vi.spyOn(storage, "automationRecordBinding").mockReturnValue({binding, shareId: "share"});
    const readHead = vi.spyOn(OwnerYDocOutbox.prototype, "readHead").mockResolvedValue({outboxId: "outbox", binding,
      baseUpdate: Uint8Array.of(0, 0), baseUpdateDigest: binding.lineageClaimId, state: "quarantined", pendingBytes: 10,
      oldestEntryAtMs: 1, quarantineReason: "invalid-update", observedBinding: null, retryDeliveryId: null,
      entry: {appendKey: "key", sequence: 1, deliveryId: "delivery", updateDigest: "b".repeat(64), update: Uint8Array.of(0, 0), byteLength: 2, createdAtMs: 1}});
    const drained = vi.spyOn(OwnerYDocOutboxDrainer.prototype, "drainOnce");
    const currentBinding = vi.mocked(storage.automationRecordBinding);
    const s = await server(storage, h, {client: client as unknown as EngineClient,
      recordDelivery: {namespace: "relay", capture}});
    await s.openReplica();
    await vi.waitFor(() => expect(drained).toHaveBeenCalled());
    expect(await drained.mock.results[0]!.value).toBe("frozen");
    expect(readHead).toHaveBeenCalledWith("outbox");
    expect(capture).not.toHaveBeenCalled();
    expect(s.errors.filter(([context]) => context.startsWith("deliver automation record"))).toEqual([]);
    drained.mockRestore(); readHead.mockRestore(); currentBinding.mockRestore();
  });
  it("confirms no run's changes sent while a record update it found no outbox for waits", async () => {
    clock = at(8);
    const {storage, h} = await relay();
    const binding = {workspaceId: WORKSPACE, mainVersionId: "main", objectId: "record", lineageClaimId: "a".repeat(64),
      currentPath: "Tasks/one.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0};
    let drafts: unknown[] = [];
    const client = {ownerYDocListDrafts: vi.fn(async () => ({drafts, next: null})),
      ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "capture"}))};
    const s = await server(storage, h, {client: client as unknown as EngineClient, recordDelivery: {namespace: "relay", capture: vi.fn()}});
    const {options} = await s.openReplica();
    const ended = () => storage.endedAutomationServerRuns({workspaceId: WORKSPACE, incarnation: 1});
    // With no record update waiting, the sync after a run ends confirms its changes.
    const sent = payRunRecord("claim-sent");
    options.beforeEffect!(sent, setStatus(0));
    options.onRunEnded!(sent);
    await vi.waitFor(() => expect(ended()).toEqual([]));
    expect(s.errors).toEqual([]);
    // Two records' updates wait, and the flush finds no outbox to deliver them from.
    drafts = [{binding, pendingBytes: 10, state: "active", outboxId: null},
      {binding: {...binding, objectId: "record-two", currentPath: "Tasks/two.md"}, pendingBytes: 10, state: "active", outboxId: null}];
    const flushes = client.ownerYDocListDrafts.mock.calls.length;
    const held = payRunRecord("claim-held");
    options.beforeEffect!(held, setStatus(0));
    const syncs = s.sync.mock.calls.length;
    options.onRunEnded!(held);
    // Closing waits for the sync that began after the run ended, which leaves it on record.
    await vi.waitFor(() => expect(s.sync.mock.calls.length).toBeGreaterThan(syncs));
    await s.run.close();
    expect(client.ownerYDocPrepareEnrollment).toHaveBeenCalled();
    expect(ended()).toEqual([expect.objectContaining({claimId: "claim-held"})]);
    // The operator hears once for each such flush, of the first record it left.
    const left = client.ownerYDocListDrafts.mock.calls.length - flushes;
    expect(left).toBeGreaterThan(0);
    expect(s.errors).toEqual(Array.from({length: left}, () => [`deliver automation record "Tasks/one.md" in workspace "${WORKSPACE}"`,
      expect.objectContaining({message: "The record has updates waiting but no outbox to deliver them from, so the server confirms no run's changes as sent."})]));
  });
  it("tries a sync the engine refused again, and reports only one that keeps failing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      clock = at(8);
      const { storage, h, host } = await relay();
      await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
      let refusals = 2, syncs = 0;
      const s = await server(storage, h, { sync: async () => {
        syncs += 1;
        if (refusals > 0) { refusals -= 1; throw new Error("workspace operation failed"); }
      } });
      const fake = await s.openReplica();
      // An automation's write pushes the copy when it ends.
      await fake.options.withRecordWrites(new AbortController().signal, async () => undefined);
      await vi.waitFor(() => expect(syncs).toBe(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(syncs).toBe(2));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(syncs).toBe(3));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncs, "it stops once a sync succeeds").toBe(3);
      expect(s.errors, "two refusals in a row are not reported").toEqual([]);

      // Three in a row are.
      refusals = 3;
      await fake.options.withRecordWrites(new AbortController().signal, async () => undefined);
      await vi.waitFor(() => expect(syncs).toBe(4));
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(syncs).toBe(5));
      expect(s.errors, "a new streak counts from its own first failure").toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(s.errors.map(([context]) => context)).toEqual([`sync the server's copy of workspace "${WORKSPACE}"`]));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a server whose live host claims live-shared records", () => {
  it("posts a failure notice when an old live claim has no replication coordinate", async () => {
    const { storage, h } = await relay();
    let pending = true;
    let failed: { claimId: string; state: "done" | "failed"; error?: string } | null = null;
    const claim = {
      claimId: "legacy-live", automationId: PRESSED, trigger: { historyId: 7 },
      change: { kind: "changed" as const, authorOriginId: "ana", actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
      recordId: "record", collectionPath: "Tasks", depth: 0, state: "running" as const, attempts: 1, run: 1,
      createdAtMs: 1, updatedAtMs: 1,
    };
    const ledger: LiveClaimLedger = {
      incarnation: "host", engine: {
        subscribeAutomation: async () => ({ subscribed: true }),
        unsubscribeAutomation: async () => ({ unsubscribed: true }),
        retryAutomationClaim: async () => { throw new Error("Unexpected retry"); },
        releaseAutomationClaim: async () => { throw new Error("Unexpected release"); },
        claimNextAutomation: async () => { if (!pending) return null; pending = false; return claim; },
        settleAutomationClaim: async input => { failed = input; return { ...claim, ...input }; },
        listAutomationFailures: async () => ({ failures: failed ? [{ automationId: PRESSED, claimId: claim.claimId, chainStopped: false, error: failed.error!, updatedAtMs: 1, generation: 1 }] : [] }),
        getAutomationClaim: async () => ({ claim: null }),
      pruneAutomationHistory: async () => ({ pruned: 0, more: false }),
      listAutomationClaims: async () => ({ claims: failed ? [{ ...claim, ...failed }] : [], next: null }),
      } as LiveClaimLedger["engine"],
    };
    const client = { sendRequest: async (request: { id: number; method: string }) => {
      if (request.method === "automations.claimNext") return { id: request.id, result: null };
      if (request.method === "automations.failures") return { id: request.id, result: { failures: [] } };
      if (request.method === "automations.listClaims") return { id: request.id, result: { claims: [] } };
      throw new Error(`Unexpected ${request.method}`);
    } } as unknown as EngineClient;
    const s = await server(storage, h, { client, live: {
      ledger: () => ledger, workspaces: () => [WORKSPACE], onEvent: () => () => {},
    } });
    const fake = await s.openReplica();
    expect(await fake.options.withEngine(engine => engine.claimNextAutomation({ automationIdPrefix: "collection:" }))).toBeNull();
    expect(fake.executor.failuresChanged).toHaveBeenCalledOnce();
    const failures = await fake.options.withEngine(engine => engine.listAutomationFailures());
    expect(failures?.failures).toHaveLength(1);
    await fake.options.reportFailure({
      failure: { ...failures!.failures[0]!, datasetInstance: null, neverStarted: false }, name: "Pay", collectionPath: "Tasks", startedBy: null, replaces: null,
    });
    expect(notices(storage, OWNER)).toEqual([expect.objectContaining({
      kind: "automation-failed", title: 'Automation "Pay" failed',
      body: "This automation could not run because the live host did not record which change triggered it. Update your dohc server, then change the record again. It ran on My dohc server.",
    })]);
  });

  it("keeps a copy of a workspace it does not host, and drains when the live host claims a change there", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const handlers = new Set<(event: Event) => void>();
    const s = await server(storage, h, { live: {
      ledger: () => null,
      workspaces: () => [WORKSPACE],
      onEvent: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    } });
    expect(s.wanted(), "no host record names the server, but a live-shared record needs its automations").toEqual([WORKSPACE]);
    const fake = await s.openReplica();
    expect(await fake.options.groupHost(), "it runs no schedules or Group triggers there").toBeNull();
    const before = fake.claimWakes();
    for (const handler of handlers) handler({ name: "automation.claimed", payload: { workspaceId: WORKSPACE, state: "pending", run: 1 } } as unknown as Event);
    expect(fake.claimWakes()).toBe(before + 1);
    await s.run.close();
    expect(handlers.size, "closing stops listening").toBe(0);
  });
});

describe("the server's run gate", () => {
  it("lets a workspace start its burst, then one run per refill, and gives back a turn that ran nothing", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const waiting: string[] = [];
      const gate = createRunGate({ nowMs: () => Date.now(), onWaiting: (workspaceId) => waiting.push(workspaceId), burst: 2, refillMs: 1_000 });
      const signal = new AbortController().signal;
      (await gate.admit("a", signal))!.release(true);
      (await gate.admit("a", signal))!.release(false);
      (await gate.admit("a", signal))!.release(true);
      let third = false;
      const next = gate.admit("a", signal).then((turn) => { third = true; return turn; });
      await vi.advanceTimersByTimeAsync(999);
      expect(third).toBe(false);
      expect(waiting).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(1);
      (await next)!.release(true);
      // Another workspace has its own bucket.
      (await gate.admit("b", signal))!.release(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("neither drains nor refills a bucket while the clock is behind its last reading", async () => {
    let now = 10_000;
    // The gate says at once, before it waits, when a workspace has no run left.
    const waits: string[] = [];
    const gate = createRunGate({ nowMs: () => now, onWaiting: (workspaceId) => waits.push(workspaceId), burst: 2, refillMs: 1_000 });
    const stop = new AbortController();
    try {
      (await gate.admit("a", stop.signal))!.release(true);
      // The clock steps back an hour: the run left still starts.
      now -= 3_600_000;
      const back = gate.admit("a", stop.signal);
      expect(waits, "a clock that went back takes no run away").toEqual([]);
      (await back)!.release(true);
      // Back at 500 ms past the first reading, half a run has come, not an hour of them.
      now = 10_500;
      const later = gate.admit("a", stop.signal);
      expect(waits).toEqual(["a"]);
      stop.abort();
      expect(await later).toBeNull();
    } finally {
      stop.abort();
    }
  });

  it("runs at most so many at once across workspaces, in arrival order", async () => {
    const gate = createRunGate({ nowMs: () => 0, onWaiting: () => undefined, concurrentRuns: 1 });
    const signal = new AbortController().signal;
    const first = (await gate.admit("a", signal))!;
    const order: string[] = [];
    const second = gate.admit("b", signal).then((turn) => { order.push("b"); return turn; });
    const third = gate.admit("c", signal).then((turn) => { order.push("c"); return turn; });
    await Promise.resolve();
    expect(order).toEqual([]);
    first.release(true);
    (await second)!.release(true);
    (await third)!.release(true);
    expect(order).toEqual(["b", "c"]);
  });
});

it("wires dataset-only workspaces to their ledger and wakes them without owning schedules", async () => {
  clock = at(8);
  const { storage, h } = await relay();
  let claimed: ((workspaceId: string, failed: boolean) => void) | undefined;
  const failures = vi.fn(() => []);
  const ledger = { failures } as unknown as DatasetAutomationHost;
  const workspace = vi.fn(() => ledger);
  const stop = vi.fn();
  const datasetHost = {
    automations: { workspace, wantedWorkspaces: () => [WORKSPACE], metadata: () => "rules" },
    observeAutomationClaims(wake: (workspaceId: string, failed: boolean) => void) { claimed = wake; return stop; },
  } as unknown as RelayDatasetHost;
  const s = await server(storage, h, { datasetHost });
  expect(s.wanted()).toEqual([WORKSPACE]);
  const fake = await s.openReplica();
  expect(await fake.options.withDatasetHost(host => host, false)).toBe(ledger);
  expect(workspace).toHaveBeenCalledWith(WORKSPACE, OWNER, expect.any(AbortSignal));
  expect(await fake.options.groupHost()).toBeNull();
  expect(fake.executor.failuresChanged).toHaveBeenCalledOnce();
  vi.mocked(fake.executor.failuresChanged).mockClear();
  claimed?.(WORKSPACE, false);
  expect(fake.executor.failuresChanged).not.toHaveBeenCalled();
  claimed?.(WORKSPACE, true);
  expect(fake.executor.failuresChanged).toHaveBeenCalledOnce();
  expect(fake.claimWakes()).toBe(2);
  await s.run.close();
  expect(stop).toHaveBeenCalledOnce();
});


it("holds missing reach history on dataset-only copies even after the editor leaves", async () => {
  const { storage, h } = await relay();
  const shareId = await createShare(h, OWNER, WORKSPACE, { recipientUserId: "ana", paths: ["Tasks"], access: "edit" });
  await h(request(OWNER, `/sync/shares/${shareId}/revoke`, { method: "POST" }));
  for (const incarnation of [1, 2]) {
    const s = await server(storage, h, { incarnation });
    const fake = await s.openReplica();
    expect(await fake.options.groupHost()).toBeNull();
    expect(await fake.options.holdUnprovenWithoutHistory?.()).toBe(true);
    await s.run.close();
  }
});

it.each([
  [false, "0", "Step 1", undefined], [true, "0", "Step 1", undefined],
  [false, JSON.stringify(["operation", "dataset-budget", "00000000-0000-4000-8000-000000000001"]), 'Step "Edit invoice"', "Edit invoice"],
  [false, JSON.stringify(["operation", "dataset-budget", "00000000-0000-4000-8000-000000000001"]), "The step", undefined],
  [false, "[broken", "The step", undefined],
] as const)("posts one notice per held step and withdraws it after clearing across restart: %s, %s", async (restart, step, label, operationName) => {
  const { storage, h } = await relay();
  const s = await server(storage, h);
  const fake = await s.openReplica();
  fake.holds.push({ automationId: PRESSED, automationName: "Pay", definitionHash: "a".repeat(64), step, operationName, seq: 1,
    collection: "Tasks", collectionPath: "Tasks", target: "Budget", action: "change", stoppedFor: "ana", fileUnread: false });
  fake.options.onHoldsChanged();
  fake.options.onHoldsChanged();
  await vi.waitFor(() => expect(notices(storage, OWNER)).toHaveLength(1), { timeout: 30_000 });
  expect(notices(storage, OWNER)[0]).toMatchObject({ title: 'Automation "Pay" is waiting',
    body: `${label} to change "Budget" waits for you. Allow it in Notices, where it shows as waiting on your server.` });
  if (restart) {
    await s.run.close();
    const next = await server(storage, h);
    await next.openReplica();
  } else {
    fake.holds.splice(0);
    fake.options.onHoldsChanged();
  }
  await vi.waitFor(() => expect(notices(storage, OWNER)[0]).toMatchObject({ dismissedAtMs: clock }), { timeout: 30_000 });
  expect(s.errors).toEqual([]);
});

it.each([
  ["chain-stopped", "An automation chain stopped", '"Pay" did not run. dohc stops a chain after automations and agents start each other 4 times in a row. Check which automations start each other.'],
  ["claim-limit", 'Automation "Pay" failed', "This change triggered too many automation runs. Make a smaller change."],
  ["record-id-too-long", 'Automation "Pay" failed', "This record's ID is too long for an automation run. Use a shorter ID."],
  ["Unsupported change", 'Automation "Pay" failed', "The automation could not read this change. Unsupported change"],
])("describes a failed dataset claim by its %s reason", async (error, title, body) => {
  const { storage, h } = await relay();
  const failure = { automationId: PRESSED, claimId: "failed", datasetInstance: "dataset", neverStarted: true, error, updatedAtMs: clock, generation: 1 };
  const ledger = { failures: () => [failure],
    claim: () => ({ claimId: "failed", attempts: 0, error, state: "failed" }) } as unknown as DatasetAutomationHost;
  const datasetHost = { automations: { workspace: () => ledger, wantedWorkspaces: () => [WORKSPACE], metadata: () => "rules" },
    observeAutomationClaims: () => () => undefined } as unknown as RelayDatasetHost;
  const s = await server(storage, h, { datasetHost });
  const fake = await s.openReplica();
  expect(fake.executor.failuresChanged).toHaveBeenCalledOnce();
  await fake.options.reportFailure({ failure: { ...failure, chainStopped: failure.neverStarted }, name: "Pay", collectionPath: "Tasks", startedBy: null, replaces: null });
  expect(notices(storage, OWNER)).toEqual([expect.objectContaining({ title, body: `${body}${/[.!?]$/.test(body) ? "" : "."} This happened on My dohc server.` })]);
  expect(notices(storage, OWNER)[0]!.target?.run).toBeUndefined();
  expect(s.errors).toEqual([]);
});

it("tells the owner when dataset workspaces exceed the server cap", async () => {
  const { storage, h } = await relay();
  const ids = Array.from({ length: AUTOMATION_SERVER_MAX_WORKSPACES + 1 }, (_, index) => `workspace-${index}`);
  for (const workspaceId of ids) await claimWorkspace(h, OWNER, workspaceId);
  const datasetHost = { automations: { wantedWorkspaces: () => ids }, observeAutomationClaims: () => () => undefined } as unknown as RelayDatasetHost;
  const s = await server(storage, h, { datasetHost });
  expect(s.wanted()).toEqual(ids.slice(0, AUTOMATION_SERVER_MAX_WORKSPACES));
  s.wanted();
  await vi.waitFor(() => expect(notices(storage, OWNER)).toHaveLength(1), { timeout: 30_000 });
  expect(notices(storage, OWNER)[0]).toMatchObject({ title: "This workspace's automations are waiting", workspaceId: ids.at(-1) });
  const first = ids.shift()!; s.wanted();
  await vi.waitFor(() => expect(notices(storage, OWNER)[0]).toMatchObject({ dismissedAtMs: clock }), { timeout: 30_000 });
  clock += 1; ids.unshift(first); s.wanted();
  await vi.waitFor(() => expect(notices(storage, OWNER).filter(notice => notice.dismissedAtMs === null)).toHaveLength(1), { timeout: 30_000 });
  expect(s.errors).toEqual([]);
});

it.each([false, true])("syncs dataset presses only behind the log head, with a starting workspace: %s", async starting => {
  const { storage, h } = await relay();
  const press = vi.fn(async (_auth: unknown, _dataset: unknown, _signal: unknown, work: (description: unknown) => Promise<unknown>) => work({}));
  const datasetHost = { automations: { press, workspace: () => ({ failures: () => [] }), wantedWorkspaces: () => [WORKSPACE], metadata: () => "rules" },
    observeAutomationClaims: () => () => undefined } as unknown as RelayDatasetHost;
  const s = await server(storage, h, { datasetHost });
  const auth = { kind: "named" as const, userId: OWNER, workspaceId: WORKSPACE };
  const input = { by: { kind: "human" as const }, confirmed: [], datasetId: "dataset", table: "Tasks", field: "Pay", recordId: "one", pressId: "press" };
  const signal = new AbortController().signal;
  if (starting) await expect(s.run.pressDataset(auth, input, signal)).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("starting") });
  await s.openReplica();
  await s.run.pressDataset(auth, input, signal);
  expect(s.sync).not.toHaveBeenCalled();
  inspectDatabase(storagePath(storage)).prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES(?,'test',1,'test','{}',1,1)").run(WORKSPACE);
  await s.run.pressDataset(auth, input, signal);
  expect(s.sync).toHaveBeenCalledOnce();
  await s.run.pressDataset(auth, input, signal);
  expect(s.sync).toHaveBeenCalledOnce();
});

describe("the owner's routes to the server's runs", () => {
  async function owned(changesPerOwner = 60) {
    clock = at(8);
    const storage = await testStorage();
    let serverRuns: ServerRuns | undefined;
    const h = testHandler(storage, {
      nowMs: () => clock, automationServer: { label: "My dohc server" }, serverRuns: () => serverRuns,
      automationHostRateLimiter: new TokenBucketLimiter(changesPerOwner, 1, 10),
    });
    await claimWorkspace(h, OWNER, WORKSPACE);
    // The server keeps a copy of the workspace.
    storage.claimWorkspaceIdentity({ workspaceId: WORKSPACE, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const s = await server(storage, h);
    serverRuns = s.run.runs;
    const call = async (userId: string, action: string, body?: Record<string, unknown>, init: RequestInit = {}) => {
      const response = await h(request(userId, `/sync/${WORKSPACE}/automation-server/${action}`, { ...(body ? jsonBody(body) : {}), ...init }));
      return { status: response.status, body: await json(response) };
    };
    return { storage, h, s, call };
  }

  it("answers the owner from the server's copy: runs, Try again, Undo, Stop and restore, and held steps", async () => {
    const { h, s, call } = await owned();
    // The server runs this workspace's automations.
    await h(request(OWNER, `/sync/${WORKSPACE}/automation-host/check-in`, jsonBody({ installId: "laptop", label: "Laptop", claim: true })));
    const fake = await s.openReplica();
    fake.holds.push(HELD);
    s.sync.mockImplementation(async () => { fake.asked.push("sync"); });
    const runs = await call(OWNER, `runs?automationId=${encodeURIComponent(PRESSED)}`);
    expect(runs).toMatchObject({ status: 200, body: { ok: true, runs: [{ claimId: "claim-1", state: "failed" }] } });
    expect(await call(OWNER, "retry", { automationId: PRESSED, claimId: "claim-1", startOver: false }))
      .toMatchObject({ status: 200, body: { ok: true, status: "queued" } });
    expect(await call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }))
      .toMatchObject({ status: 200, body: { ok: true, status: "undone", reverted: 1 } });
    const definitions = [{ collectionPath: "Budget", id: "pay", definitionHash: "0123456789abcdef" }];
    expect(await call(OWNER, "restore", { definitions, again: false, retentionId: "restore-test" })).toMatchObject({ status: 200, body: { ok: true, undone: 1, left: 0, reverted: 1 } });
    expect(await call(OWNER, "holds")).toMatchObject({ status: 200, body: { ok: true, holds: [HELD] } });
    const allow = { automationId: PRESSED, definitionHash: HELD.definitionHash, step: "0", seq: 7 };
    expect(await call(OWNER, "allow", allow)).toMatchObject({ status: 200, body: { ok: true, status: "confirmed" } });
    expect(await call(OWNER, "allow", { ...allow, seq: 6 })).toMatchObject({ status: 200, body: { status: "changed" } });
    // The owner's route is the only one that asks for Try again, so a press
    // may run again. An Undo first brings the copy up to the relay, so it
    // keeps what anyone changed since.
    expect(fake.asked).toEqual([
      ["runs", PRESSED, undefined],
      ["retry", { automationId: PRESSED, claimId: "claim-1", startOver: false }, true],
      "sync",
      ["undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }],
      "sync",
      "sync",
      ["restore", definitions, false],
      "sync",
      ["allow", allow],
      ["allow", { ...allow, seq: 6 }],
    ]);
    expect(await call(OWNER, "restore", {definitions: [], again: false, retentionId: "restore-test"}))
      .toMatchObject({status: 200, body: {ok: true, undone: 0, errorMessage: null}});
    expect(fake.asked.at(-1)).toEqual(["releaseRestore", "desktop:restore-test"]);
  });

  it("forwards page cursors, old-run lookups, and confirmed deletes through the owner's copy", async () => {
    const { s, call } = await owned();
    const fake = await s.openReplica();
    expect(await call(OWNER, `runs?automationId=${encodeURIComponent(PRESSED)}&before=30%3Aclaim-new`))
      .toMatchObject({ status: 200, body: { next: null } });
    expect(fake.asked).toContainEqual(["runs", PRESSED, "30:claim-new"]);
    expect(await call(OWNER, `runs?automationId=${encodeURIComponent(PRESSED)}&claimId=claim-old`))
      .toMatchObject({ status: 200, body: { run: null } });
    expect(fake.asked).toContainEqual(["get", PRESSED, "claim-old"]);
    const deletes = { token: "preview", chosen: [{ key: "table", operationId: "delete" }] };
    const input = { automationId: PRESSED, claimId: "claim-1", deletes };
    expect(await call(OWNER, "undo", input)).toMatchObject({ status: 200, body: { deleted: 0, keptChanged: 0, gone: 0 } });
    expect(fake.asked).toContainEqual(["undo", input]);
    const count = fake.asked.length;
    expect(await call(OWNER, "undo", { ...input, deletes: { token: "preview", chosen: [{ key: "table" }] } }))
      .toMatchObject({ status: 400 });
    expect(fake.asked).toHaveLength(count);
  });

  it("answers anyone else, a browser cookie, or a workspace with no copy here as if nothing were there", async () => {
    const { storage, h, s, call } = await owned();
    // Ana can edit Tasks, which makes her no owner.
    await createShare(h, OWNER, WORKSPACE, { recipientUserId: "ana", paths: ["Tasks"], access: "edit" });
    // No copy yet: the owner hears what a stranger hears.
    const none = await call(OWNER, "holds");
    expect(none.status).toBe(404);
    const fake = await s.openReplica();
    for (const attempt of [
      await call("ana", "holds"),
      await call("ana", "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }),
      await call(OWNER, "holds", undefined, { headers: { cookie: "session=1" } }),
    ]) expect(attempt).toEqual(none);
    expect(fake.asked).toEqual([]);
    // A workspace the relay no longer lists under the owner is not theirs to change.
    inspectDatabase(storagePath(storage)).prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'someone-else' WHERE workspace_id = ?").run(WORKSPACE);
    expect(await call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null })).toEqual(none);
    expect(fake.asked).toEqual([]);
  });

  describe("after the server loses its host data", () => {
    const LOST_ERROR = "Your server lost its copy of this workspace and may not have sent this run's latest changes. Check the records it changed.";
    const runsOf = (query = "") => `runs?automationId=${encodeURIComponent(PRESSED)}${query}`;

    // Each start opens the server's copy of the workspace from its host
    // data. A higher incarnation is a copy rebuilt from empty host data.
    async function copies() {
      clock = at(8);
      const storage = await testStorage();
      let serverRuns: ServerRuns | undefined;
      const h = testHandler(storage, { nowMs: () => clock, automationServer: { label: "My dohc server" }, serverRuns: () => serverRuns });
      await claimWorkspace(h, OWNER, WORKSPACE);
      storage.claimWorkspaceIdentity({ workspaceId: WORKSPACE, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
      storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
      // The server runs this workspace's automations.
      await h(request(OWNER, `/sync/${WORKSPACE}/automation-host/check-in`, jsonBody({ installId: "laptop", label: "Laptop", claim: true })));
      const call = async (action: string, body?: Record<string, unknown>) => {
        const response = await h(request(OWNER, `/sync/${WORKSPACE}/automation-server/${action}`, body ? jsonBody(body) : {}));
        return { status: response.status, body: await json(response) };
      };
      const start = async (incarnation: number) => {
        const s = await server(storage, h, { incarnation });
        serverRuns = s.run.runs;
        return { ...s, fake: await s.openReplica() };
      };
      return { storage, call, start };
    }

    it("shows the owner which runs' changes the lost copy may not have sent", async () => {
      const { storage, call, start } = await copies();
      const first = await start(1);
      const { beforeEffect, onRunEnded } = first.fake.options;
      // One run ends and a sync sends its changes. One sends only a notice,
      // which the relay holds itself. One is still changing the copy.
      const sent = payRunRecord("claim-sent"), notified = payRunRecord("claim-notified"), unsent = payRunRecord("claim-unsent");
      beforeEffect!(sent, setStatus(0));
      beforeEffect!(notified, { kind: "notice", name: "Tell", notice: { noticeId: "n-claim-notified", kind: "automation-notify", title: "Paid", body: "Paid",
        target: { path: "Tasks/a.md", automation: PRESSED, run: "claim-notified" }, recipientUserId: OWNER } });
      clock = at(8, 5);
      beforeEffect!(unsent, setStatus(0));
      onRunEnded!(sent);
      onRunEnded!(notified);
      // The run's end is on record now, and the sync it started confirms it.
      await vi.waitFor(() => expect(storage.endedAutomationServerRuns({ workspaceId: WORKSPACE, incarnation: 1 })).toEqual([]));

      await first.run.close();
      clock = at(9);
      const second = await start(2);
      const lostRun = { claimId: "claim-unsent", state: "failed", createdAtMs: at(8), updatedAtMs: at(8, 5), writes: [], unsentChangesLost: true, error: LOST_ERROR };
      await vi.waitFor(() => expect(notices(storage, OWNER)).toEqual([expect.objectContaining({
        kind: "automation-failed", title: 'Automation "Pay" may have lost changes', body: LOST_ERROR,
        target: { automation: PRESSED, run: "claim-unsent", path: "Tasks/automations.yaml" },
      })]));
      // Run history, as the owner's computers and agents read it, lists the lost run after this copy's own.
      const listed = await call(runsOf());
      expect(listed).toMatchObject({ status: 200, body: { runs: [{ claimId: "claim-1" }, lostRun], next: null } });
      expect(listed.body.runs).toHaveLength(2);
      expect(await call(runsOf("&claimId=claim-unsent"))).toMatchObject({ status: 200, body: { run: lostRun } });
      expect(await call("retry", { automationId: PRESSED, claimId: "claim-unsent", startOver: false })).toMatchObject({ status: 200,
        body: { status: "refused", reason: "Your server lost this run's history with its copy of the workspace, so it will not run this again." } });

      // Opening the copy again tells the owner nothing new.
      await second.run.close();
      await start(2);
      expect(await call(runsOf("&claimId=claim-unsent"))).toMatchObject({ body: { run: lostRun } });
      expect(notices(storage, OWNER)).toHaveLength(1);
    });

    it("reports a fresh run that saves its first step with the run, before that step changes the copy", async () => {
      const { storage, call, start } = await copies();
      const first = await start(1);
      const pay = payRun(first.fake.options, "claim-fresh", 1);
      const applying = resolvers(), applied = resolvers();
      const apply = pay.backend.apply;
      pay.backend.apply = async (...args) => { applying.resolve(); await applied.promise; return apply(...args); };
      const running = pay.execute(false);
      await applying.promise;

      // The server loses its host data while the run changes its copy.
      await first.run.close();
      clock = at(9);
      await start(2);
      await vi.waitFor(() => expect(notices(storage, OWNER)).toEqual([expect.objectContaining({
        body: LOST_ERROR, target: { automation: PRESSED, run: "claim-fresh", path: "Tasks/automations.yaml" },
      })]));
      expect(await call(runsOf("&claimId=claim-fresh"))).toMatchObject({ body: { run: { createdAtMs: at(8), updatedAtMs: at(8), unsentChangesLost: true } } });
      applied.resolve();
      await expect(running).resolves.toEqual({ kind: "done" });
      expect(pay.saves).toEqual(["open:0", "done:1"]);
    });

    it("reports Try again on a failed run, which stays on record past its saved progress until it ends", async () => {
      const { storage, start } = await copies();
      const first = await start(1);
      const pay = payRun(first.fake.options, "claim-again", 50);
      const apply = pay.backend.apply;
      pay.backend.apply = async () => ({ outcome: { kind: "failed", error: "The record is locked.", timedOut: false } });
      await expect(pay.execute(false)).resolves.toMatchObject({ kind: "failed" });
      // The failed run's end is on record, and the sync it started confirms it.
      await vi.waitFor(() => expect(storage.endedAutomationServerRuns({ workspaceId: WORKSPACE, incarnation: 1 })).toEqual([]));

      // Try again lands all 50 changes, slowly enough that it saves its
      // progress after the last, before it saves its end.
      clock = at(8, 30);
      pay.backend.apply = async (...args) => { clock += 50; return apply(...args); };
      const ending = resolvers(), ended = resolvers();
      pay.onSave = async (saved) => { if (saved.outcome?.state === "done") { ending.resolve(); await ended.promise; } };
      const running = pay.execute(true);
      await ending.promise;
      expect(pay.saves).toEqual(["open:0", "failed:0", "failed:50", "done:50"]);

      // The server loses its host data before the run's end is on record.
      await first.run.close();
      clock = at(9);
      await start(2);
      await vi.waitFor(() => expect(notices(storage, OWNER)).toEqual([expect.objectContaining({
        body: LOST_ERROR, target: { automation: PRESSED, run: "claim-again", path: "Tasks/automations.yaml" },
      })]));
      ended.resolve();
      await expect(running).resolves.toEqual({ kind: "done" });
    });

    it("lists every run the lost copy may not have sent, and tells the owner of them all in one Notice", async () => {
      const { storage, call, start } = await copies();
      const changing = (claimId: string, startedAtMs: number, nowMs = startedAtMs) => storage.recordAutomationServerRunChanging({ workspaceId: WORKSPACE,
        incarnation: 1, automationId: PRESSED, claimId, automationName: "Pay", collectionPath: "Tasks", startedAtMs, nowMs });
      // The first copy changed 260 runs it never sent, and one run that
      // started longer ago than run history keeps a run changed it today.
      changing("claim-waited", at(8) - 31 * 24 * HOUR, at(8));
      const lost = Array.from({ length: 260 }, (_, n) => `claim-${String(n).padStart(3, "0")}`);
      lost.forEach((claimId, n) => changing(claimId, at(8) + n));
      clock = at(9);
      await start(2);
      await vi.waitFor(() => expect(notices(storage, OWNER)).toEqual([expect.objectContaining({
        title: 'Automation "Pay" may have lost changes',
        body: "Your server lost its copy of this workspace and may not have sent the latest changes of 261 runs. Check the records they changed.",
        target: { automation: PRESSED, run: "claim-259", path: "Tasks/automations.yaml" },
      })]));
      const listed: string[] = [];
      let before: string | null = null;
      do {
        const page = await call(runsOf(before === null ? "" : `&before=${encodeURIComponent(before)}`));
        expect(page.status).toBe(200);
        const body = page.body as { runs: Array<{ claimId: string }>; next: string | null };
        listed.push(...body.runs.map((run) => run.claimId));
        before = body.next;
      } while (before !== null);
      expect(listed).toEqual(["claim-1", ...[...lost].reverse(), "claim-waited"]);
    });

    it.each([
      ["on the page where the copy's runs meet the lost ones", false],
      ["on an earlier page of the copy's runs", true],
    ])("lists a dataset claim the relay keeps once, as lost, %s", async (_where, earlier) => {
      const { storage, call, start } = await copies();
      const changing = (claimId: string) => storage.recordAutomationServerRunChanging({ workspaceId: WORKSPACE, incarnation: 1,
        automationId: PRESSED, claimId, automationName: "Pay", collectionPath: "Tasks", startedAtMs: at(8), nowMs: at(8, 5) });
      // The first copy changed two runs it never sent. One is a dataset claim
      // the relay keeps, so the rebuilt copy still lists it as done.
      changing("claim-dataset");
      changing("claim-unsent");
      clock = at(9);
      const { fake } = await start(2);
      const row = (claimId: string): CollectionAutomationRun => ({ claimId, state: "done", error: null, createdAtMs: at(8), updatedAtMs: at(8, 10),
        trigger: { kind: "changed", recordId: "record", by: "human", depth: 0, sharedAuthor: null }, writes: [],
        definitionChanged: false, neverStarted: false, chainStopped: false, undoUnfinished: false, undone: false });
      const pages: Record<string, { runs: CollectionAutomationRun[]; next: string | null }> = earlier
        ? { first: { runs: [row("claim-new"), row("claim-dataset")], next: "page-2" }, "page-2": { runs: [row("claim-old")], next: null } }
        : { first: { runs: [row("claim-new"), row("claim-dataset"), row("claim-old")], next: null } };
      const kept = Object.values(pages).flatMap((page) => page.runs.map((run) => run.claimId));
      fake.executor.runs = async (_automationId, before) => pages[before ?? "first"]!;
      fake.executor.listedRun = async (_automationId, claimId) => (kept.includes(claimId) ? row(claimId) : null);
      fake.executor.hasRun = async (_automationId, claimId) => kept.includes(claimId);

      const listed: CollectionAutomationRun[] = [];
      let before: string | null = null;
      do {
        const page = await call(runsOf(before === null ? "" : `&before=${encodeURIComponent(before)}`));
        expect(page.status).toBe(200);
        const body = page.body as { runs: CollectionAutomationRun[]; next: string | null };
        listed.push(...body.runs);
        before = body.next;
      } while (before !== null);
      const lostRun = { state: "failed", error: LOST_ERROR, updatedAtMs: at(8, 5), unsentChangesLost: true };
      expect(listed.map((run) => run.claimId)).toEqual(["claim-new", "claim-dataset", "claim-old", "claim-unsent"]);
      expect(listed[1]).toMatchObject({ ...lostRun, trigger: { recordId: "record" } });
      expect(listed[0]).toMatchObject({ state: "done" });
      expect(listed[0]!.unsentChangesLost).toBeUndefined();
      expect(listed[3]).toMatchObject(lostRun);
      expect(await call(runsOf("&claimId=claim-dataset"))).toMatchObject({ status: 200, body: { run: { claimId: "claim-dataset", ...lostRun } } });
      expect(await call(runsOf("&claimId=claim-new"))).toMatchObject({ status: 200, body: { run: { claimId: "claim-new", state: "done" } } });
    });

    // A failed dataset claim the relay keeps, as the copy's executor lists it.
    const failedClaim = (claimId: string, updatedAtMs: number): CollectionAutomationRun => ({ claimId, state: "failed", error: "The record is locked.",
      createdAtMs: at(8), updatedAtMs, trigger: { kind: "changed", recordId: "record", by: "human", depth: 0, sharedAuthor: null }, writes: [],
      definitionChanged: false, neverStarted: false, chainStopped: false, undoUnfinished: false, undone: false });
    // The copy's executor lists these claims, and saved a run of those in `ran`.
    function keeps(fake: Fake, kept: CollectionAutomationRun[], ran: readonly string[] = []) {
      fake.executor.runs = async () => ({ runs: kept, next: null });
      fake.executor.listedRun = async (_automationId, claimId) => kept.find((run) => run.claimId === claimId) ?? null;
      fake.executor.hasRun = async (_automationId, claimId) => kept.some((run) => run.claimId === claimId);
      const saved = ran.map((claimId) => payRun(fake.options, claimId, 1).run);
      vi.spyOn(fake.options.store, "runsOf").mockImplementation(async (_automationId, claimId) =>
        ({ runs: saved.filter((run) => run.claimId === claimId), unreadable: false }));
      return vi.spyOn(fake.executor, "retry");
    }

    it("shows a dataset claim this copy ran again since the loss as it ran, and tries again only that one", async () => {
      const { storage, call, start } = await copies();
      const changing = (claimId: string) => storage.recordAutomationServerRunChanging({ workspaceId: WORKSPACE, incarnation: 1,
        automationId: PRESSED, claimId, automationName: "Pay", collectionPath: "Tasks", startedAtMs: at(8), nowMs: at(8, 5) });
      // The first copy changed two dataset claims it never sent. The relay
      // keeps both; the rebuilt copy ran one again, and it failed. Recovery
      // failed the other after the loss without running it, so this copy
      // saved no run of it.
      changing("claim-kept");
      changing("claim-again");
      clock = at(9);
      const { fake } = await start(2);
      const kept = [failedClaim("claim-again", at(9, 30)), failedClaim("claim-kept", at(9, 20))];
      const retry = keeps(fake, kept, ["claim-again"]);

      const lostRun = { state: "failed", error: LOST_ERROR, updatedAtMs: at(8, 5), unsentChangesLost: true };
      const listed = await call(runsOf());
      expect(listed).toMatchObject({ status: 200, body: { runs: [kept[0], { claimId: "claim-kept", ...lostRun }], next: null } });
      expect((listed.body.runs as CollectionAutomationRun[])[0]!.unsentChangesLost).toBeUndefined();
      const read = await call(runsOf("&claimId=claim-again"));
      expect(read).toMatchObject({ status: 200, body: { run: kept[0] } });
      expect((read.body.run as CollectionAutomationRun).unsentChangesLost).toBeUndefined();
      expect(await call(runsOf("&claimId=claim-kept"))).toMatchObject({ status: 200, body: { run: { claimId: "claim-kept", ...lostRun } } });

      expect(await call("retry", { automationId: PRESSED, claimId: "claim-kept", startOver: false })).toMatchObject({ status: 200,
        body: { status: "refused", reason: "Your server lost this run's history with its copy of the workspace, so it will not run this again." } });
      expect(retry).not.toHaveBeenCalled();
      expect(await call("retry", { automationId: PRESSED, claimId: "claim-again", startOver: false }))
        .toMatchObject({ status: 200, body: { status: "queued" } });
      expect(retry).toHaveBeenCalledExactlyOnceWith({ automationId: PRESSED, claimId: "claim-again", startOver: false });
    });

    it("shows a dataset claim as lost when the copy that ran it again lost its host data too", async () => {
      const { storage, call, start } = await copies();
      storage.recordAutomationServerRunChanging({ workspaceId: WORKSPACE, incarnation: 1,
        automationId: PRESSED, claimId: "claim-again", automationName: "Pay", collectionPath: "Tasks", startedAtMs: at(8), nowMs: at(8, 5) });
      clock = at(9);
      const second = await start(2);
      // The second copy ran the claim again, it failed, and a sync sent its
      // changes. Then that copy lost its host data too.
      await second.run.close();
      clock = at(10);
      const { fake } = await start(3);
      const retry = keeps(fake, [failedClaim("claim-again", at(9, 30))]);

      const lostRun = { claimId: "claim-again", state: "failed", error: LOST_ERROR, updatedAtMs: at(8, 5), unsentChangesLost: true };
      expect(await call(runsOf())).toMatchObject({ status: 200, body: { runs: [lostRun], next: null } });
      expect(await call(runsOf("&claimId=claim-again"))).toMatchObject({ status: 200, body: { run: lostRun } });
      expect(await call("retry", { automationId: PRESSED, claimId: "claim-again", startOver: false })).toMatchObject({ status: 200,
        body: { status: "refused", reason: "Your server lost this run's history with its copy of the workspace, so it will not run this again." } });
      expect(retry).not.toHaveBeenCalled();
    });

    it("lists a run whose older record expires between pages, on the page its first record placed it", async () => {
      const { storage, call, start } = await copies();
      const changing = (incarnation: number, claimId: string, startedAtMs: number) => storage.recordAutomationServerRunChanging({ workspaceId: WORKSPACE,
        incarnation, automationId: PRESSED, claimId, automationName: "Pay", collectionPath: "Tasks", startedAtMs, nowMs: startedAtMs });
      // The first copy changed a claim and never sent it. The second ran it
      // again, and 60 runs that start between its two starts, and never sent them either.
      changing(1, "claim-twice", at(8));
      clock = at(9);
      const second = await start(2);
      const others = Array.from({ length: 60 }, (_, n) => `claim-${String(n).padStart(3, "0")}`);
      others.forEach((claimId, n) => changing(2, claimId, at(9) + n + 1));
      changing(2, "claim-twice", at(9, 30));
      await second.run.close();
      clock = at(10);
      await start(3);

      const first = await call(runsOf());
      const body = first.body as { runs: Array<{ claimId: string }>; next: string | null };
      // The first copy's record expires before the next page.
      clock = at(9) + 30 * 24 * HOUR;
      const rest = await call(runsOf(`&before=${encodeURIComponent(body.next!)}`));
      expect(rest).toMatchObject({ status: 200, body: { next: null } });
      expect([...body.runs, ...(rest.body as { runs: Array<{ claimId: string }> }).runs].map((run) => run.claimId))
        .toEqual(["claim-1", ...[...others].reverse(), "claim-twice"]);
    });

    it.each([
      ["on one page", 0],
      ["on different pages", 60],
    ])("lists a run two lost copies may not have sent once, with its records %s", async (_where, between) => {
      const { storage, call, start } = await copies();
      const changing = (incarnation: number, claimId: string, startedAtMs: number) => storage.recordAutomationServerRunChanging({ workspaceId: WORKSPACE,
        incarnation, automationId: PRESSED, claimId, automationName: "Pay", collectionPath: "Tasks", startedAtMs, nowMs: startedAtMs });
      // The first copy changed a dataset claim, and other runs after it, and never sent them.
      changing(1, "claim-twice", at(8));
      const others = Array.from({ length: between }, (_, n) => `claim-${String(n).padStart(3, "0")}`);
      others.forEach((claimId, n) => changing(1, claimId, at(8) + n + 1));
      clock = at(9);
      const second = await start(2);
      // The rebuilt copy ran the claim again, then lost its host data too, and
      // the copy after it no longer keeps the claim.
      changing(2, "claim-twice", at(9, 30));
      await second.run.close();
      clock = at(10);
      await start(3);

      const listed: string[] = [];
      let before: string | null = null;
      do {
        const page = await call(runsOf(before === null ? "" : `&before=${encodeURIComponent(before)}`));
        expect(page.status).toBe(200);
        const body = page.body as { runs: Array<{ claimId: string }>; next: string | null };
        listed.push(...body.runs.map((run) => run.claimId));
        before = body.next;
      } while (before !== null);
      expect(listed).toEqual(["claim-1", ...[...others].reverse(), "claim-twice"]);
      const lostRun = { claimId: "claim-twice", state: "failed", createdAtMs: at(8), updatedAtMs: at(8), unsentChangesLost: true, error: LOST_ERROR };
      expect(await call(runsOf("&claimId=claim-twice"))).toMatchObject({ status: 200, body: { run: lostRun } });
      expect(await call("retry", { automationId: PRESSED, claimId: "claim-twice", startOver: false })).toMatchObject({ status: 200,
        body: { status: "refused", reason: "Your server lost this run's history with its copy of the workspace, so it will not run this again." } });
    });
  });

  it("refuses what the server would not run", async () => {
    const { s, call } = await owned();
    const fake = await s.openReplica();
    expect((await call(OWNER, "retry", { automationId: "plugin:x", claimId: "claim-1", startOver: false })).status).toBe(400);
    expect((await call(OWNER, "allow", { automationId: PRESSED, definitionHash: "not-a-hash", step: "0", seq: 1 })).status).toBe(400);
    expect((await call(OWNER, "restore", { definitions: "all" })).status).toBe(400);
    expect((await call(OWNER, "runs", { automationId: PRESSED })).status, "a list is read, not posted").toBe(405);
    expect(fake.asked).toEqual([]);
  });

  it("opens a copy it keeps after the workspace left it for the owner's action, then lets it leave again", async () => {
    const { storage, s, call } = await owned();
    // The server ran this workspace's automations, then the owner moved them and the copy left.
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    expect(storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS })).not.toBeNull();
    expect(s.wanted()).toEqual([]);

    const undone = call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null });
    await vi.waitFor(() => expect(s.wanted()).toEqual([WORKSPACE]));
    // The replicas module joins the copy again as it opens it.
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: clock });
    const fake = await s.openReplica();
    expect(await undone).toMatchObject({ status: 200, body: { status: "undone" } });
    expect(fake.asked).toEqual([["undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }]]);
    // Undo pushed what it put back before the action let the copy go.
    expect(s.sync).toHaveBeenCalledTimes(2);
    // Try again would queue a run nothing here will run.
    await expect(s.run.runs.retry({ workspaceId: WORKSPACE, ownerUserId: OWNER }, { automationId: PRESSED, claimId: "claim-1", startOver: false }))
      .resolves.toEqual({ status: "refused", reason: "Your server no longer runs this workspace's automations, so it will not run this again." });
    // The action is over: nothing needs the copy, and it keeps the times it
    // left at, so the action does not extend how long it is kept.
    expect(s.wanted()).toEqual([]);
    expect(storage.listAutomationWorkspaces()[0]).toMatchObject({ unwantedSinceMs: 0, leftAtMs: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS });
    // The host record names no server, so the reopened copy runs no schedules.
    expect(fake.claims).toEqual([]);
  });

  it("opens a failed copy at the 60 s retry cap within one pass for an owner's action", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    clock = 0;
    const { storage, h } = await relay();
    storage.claimWorkspaceIdentity({ workspaceId: WORKSPACE, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    inspectDatabase(storagePath(storage)).prepare("INSERT INTO sync_relay_automation_hosts (workspace_id, install_id, generation, handover_from) VALUES (?, 'server', 1, NULL)").run(WORKSPACE);
    const root = await mkdtemp(join(tmpdir(), "automation-owner-retry-"));
    cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
    let failing = true, opens = 0;
    const engine = {
      sendRequest: vi.fn(async ({ method }: { method: string }) => {
        switch (method) {
          case "workspace.open": return { result: { workspace: `handle-${++opens}` } };
          case "versions.ensureMain": return { result: { id: "main" } };
          case "sync.adoptJoinIdentity": return { result: { adopted: true } };
          case "sync.push":
            if (failing) throw new Error("replica cannot push");
            return { result: { status: "complete", pushed: 0, hasMore: false, sharingDeclined: [], ownerAdmissionPending: [] } };
          case "sync.pull": return { result: { status: "complete", nextCursor: 1, pendingCursor: { kind: "relay", token: "t" }, hasMore: false,
            fetched: 0, applied: 0, refused: 0, skipped: 0, conflictsOpened: 0, refusals: [], sharingDeclined: [], changedPaths: [] } };
          case "sync.materializePendingCursor": return { result: { materialized: true } };
          case "sync.commitCursor": return { result: { committed: true, sharingDeclined: [] } };
          case "workspace.close": return { result: {} };
          default: throw new Error(`unexpected ${method}`);
        }
      }),
      ownerYDocListDrafts: vi.fn(async () => ({ drafts: [], next: null })),
      onEvent: vi.fn(), close: vi.fn(), waitForExit: vi.fn(async () => undefined),
    };
    const spawning = vi.spyOn(daemon, "createEngineClient").mockResolvedValue(engine as unknown as EngineClient);
    cleanup.push(async () => { spawning.mockRestore(); });
    const waiting: Array<{ attempts: number; resolve(): void }> = [];
    const passAfter = (attempts: number) => new Promise<void>(resolve => waiting.push({ attempts, resolve }));
    const s = await server(storage, h, { root, schedules: [], startReplicas: options => startAutomationReplicas({ ...options,
      onReconciled: () => {
        options.onReconciled?.();
        for (const waiter of [...waiting]) if (opens >= waiter.attempts) {
          waiting.splice(waiting.indexOf(waiter), 1);
          waiter.resolve();
        }
      } }) });
    for (const [index, delay] of [0, 2_000, 4_000, 8_000, 16_000, 32_000].entries()) {
      const failed = passAfter(index + 1);
      await vi.advanceTimersByTimeAsync(delay);
      await failed;
    }
    expect(opens).toBe(6);
    failing = false;
    let outcome: unknown;
    const requested = passAfter(0);
    const action = s.run.runs.list({ workspaceId: WORKSPACE, ownerUserId: OWNER }, PRESSED)
      .then(result => { outcome = result; }, error => { outcome = error; });
    cleanup.push(async () => { if (outcome === undefined) await vi.advanceTimersByTimeAsync(30_000); await action; });
    await vi.advanceTimersByTimeAsync(100);
    // Fake time does not wait for the pass's real folder work.
    await requested;
    expect(opens, "the owner's action bypasses the remaining minute of backoff").toBe(7);
    await action;
    expect(outcome).toMatchObject({ runs: [{ claimId: "claim-1" }] });
  });

  it("opens no kept copy past the server's cap, and says so", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const ids = Array.from({ length: AUTOMATION_SERVER_MAX_WORKSPACES }, (_, index) => `workspace-${index}`);
    const datasetHost = { automations: { wantedWorkspaces: () => ids }, observeAutomationClaims: () => () => undefined } as unknown as RelayDatasetHost;
    storage.claimWorkspaceIdentity({ workspaceId: WORKSPACE, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const s = await server(storage, h, { datasetHost });
    await expect(s.run.runs.list({ workspaceId: WORKSPACE, ownerUserId: OWNER }, PRESSED))
      .rejects.toMatchObject({ statusCode: 503, message: "Your server has as many workspaces open as it can. Try again later." });
    expect(s.wanted()).toEqual(ids);
  });

  it("keeps an admitted action's copy open when another workspace needs the server", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const ids = Array.from({ length: AUTOMATION_SERVER_MAX_WORKSPACES - 1 }, (_, index) => `workspace-${index}`);
    const datasetHost = {
      automations: { wantedWorkspaces: () => ids, metadata: () => "", workspace: () => ({ failures: () => [] }) },
      observeAutomationClaims: () => () => undefined,
    } as unknown as RelayDatasetHost;
    storage.claimWorkspaceIdentity({ workspaceId: WORKSPACE, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const s = await server(storage, h, { datasetHost });
    const listed = s.run.runs.list({ workspaceId: WORKSPACE, ownerUserId: OWNER }, PRESSED);
    await vi.waitFor(() => expect(s.wanted()).toContain(WORKSPACE));
    ids.push("workspace-late");
    expect(s.wanted()).toContain(WORKSPACE);
    expect(s.wanted()).toHaveLength(AUTOMATION_SERVER_MAX_WORKSPACES);
    await s.openReplica();
    expect((await listed).runs).toHaveLength(1);
    expect(s.wanted()).toContain("workspace-late");
  });

  it("holds an open copy for each action until the last one ends", async () => {
    const { s, call } = await owned();
    const fake = await s.openReplica();
    expect(s.wanted(), "nothing runs here, so the copy is waiting to leave").toEqual([]);
    let finish: () => void = () => undefined;
    s.sync.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const slow = call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null });
    await vi.waitFor(() => expect(s.sync).toHaveBeenCalled());
    expect((await call(OWNER, `runs?automationId=${encodeURIComponent(PRESSED)}`)).status).toBe(200);
    expect(s.wanted(), "the Undo still holds the copy").toEqual([WORKSPACE]);
    finish();
    expect((await slow).status).toBe(200);
    expect(s.wanted()).toEqual([]);
    expect(fake.asked.map((entry) => (Array.isArray(entry) ? entry[0] : entry))).toEqual(["runs", "undo"]);
  });

  it("opens no kept copy for anyone but its owner, or for a workspace it never kept", async () => {
    const { storage, s, call } = await owned();
    // The copy was made for another owner, as before the workspace changed hands.
    inspectDatabase(storagePath(storage)).prepare("UPDATE sync_relay_automation_workspaces SET owner_user_id = 'someone-else'").run();
    expect((await call(OWNER, `runs?automationId=${encodeURIComponent(PRESSED)}`)).status).toBe(404);
    inspectDatabase(storagePath(storage)).prepare("DELETE FROM sync_relay_automation_workspaces").run();
    expect((await call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null })).status).toBe(404);
    expect(s.wanted()).toEqual([]);
  });

  it("undoes nothing when the copy cannot catch up with the relay", async () => {
    const { s, call } = await owned();
    const fake = await s.openReplica();
    s.sync.mockRejectedValue(new Error("The relay refused the pull."));
    expect((await call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null })).status).toBe(500);
    expect((await call(OWNER, "restore", { definitions: [{ collectionPath: "Budget", id: "pay", definitionHash: "0123456789abcdef" }], again: false, retentionId: "restore-test" })).status).toBe(500);
    expect(fake.asked).toEqual([]);
  });

  it("limits the owner's changes, and never their reads", async () => {
    const { s, call } = await owned(1);
    const fake = await s.openReplica();
    const undo = { automationId: PRESSED, claimId: "claim-1", deletes: null };
    expect((await call(OWNER, "undo", undo)).status).toBe(200);
    expect(await call(OWNER, "undo", undo)).toMatchObject({ status: 429, body: { code: "automation_host_rate_limited" } });
    expect((await call(OWNER, "holds")).status).toBe(200);
    expect(fake.asked).toEqual([["undo", undo]]);
  });
});
