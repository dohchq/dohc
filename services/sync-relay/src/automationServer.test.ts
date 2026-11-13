import type { RelayButtonInspection } from "@dohc/workspace-contracts/relay";
import {
  SHARED_BUTTON_DENIED,
  SHARED_BUTTON_HELD,
  SHARED_BUTTON_MOVED,
  SHARED_BUTTON_FIELD_CHANGED,
  SHARED_BUTTON_UNCHECKED,
} from "@dohc/automation-executor/button-presser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import type {
  ScheduledAutomation,
  CollectionAutomationRun,
  CollectionAutomationsOptions,
  CollectionAutomationHold,
} from "@dohc/automation-executor/collection-automations";
import type {
  AutomationRunStore,
  StoredRun,
  StoredStep,
} from "@dohc/automation-executor/automation-run-store";
import { runSteps, type StepBackend } from "@dohc/automation-executor/automation-step-run";
import { newRun } from "@dohc/automation-executor/collection-automation-run";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { AUTOMATION_SERVER_MAX_WORKSPACES } from "@dohc/workspace-contracts/relay";
import type { ReachHandover } from "@dohc/automation-executor/reach-verdicts";
import {
  OwnerYDocOutbox,
  VersionedLiveAdapter,
  type AutomationGroupHandover,
  type MomentRecord,
} from "@dohc/workspace-engine-client";
import { AUTOMATION_SWITCHED_OFF_BODY } from "@dohc/automation-executor/automation-failed-notice";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { OwnerYDocOutboxDrainer } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import type { startAutomationReplicas, AutomationReplica } from "./automationReplicas";
import {
  createRunGate,
  startAutomationServer,
  type AutomationServerOptions,
  type ServerExecutor,
} from "./automationServer";
import type { ServerRuns } from "./automationServerRoutes";
import type { RelayDatasetHost } from "./datasetHost";
import type { SyncRelayStorage } from "./storage";
import {
  claimWorkspace,
  closeTestStorages,
  createShare,
  inspectDatabase,
  json,
  jsonBody,
  request,
  storagePath,
  testHandler,
  testStorage,
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
  automationId: "collection:Tasks#hourly",
  collectionPath: "Tasks",
  name: "Hourly",
  trigger: { kind: "schedule", every: "hour", at: ":00", timezone: "UTC" },
  scheduleHash: "hash-hourly",
  enabledSince: null,
};
const PRESSED = "collection:Tasks#pay";
const HELD = {
  collectionPath: "Budget",
  automationId: PRESSED,
  automationName: "Pay",
  definitionHash: "0123456789abcdef",
  step: "0",
  seq: 7,
  collection: "Tasks",
  target: "Invoices",
  action: "change" as const,
  stoppedFor: "Ana",
  fileUnread: false,
};

// What the laptop and the server each carry in a release.
const groups = (floorMs: number, messageId: string): AutomationGroupHandover => ({
  floorMs,
  automations: [
    {
      automationId: "collection:Tasks#task",
      sinceMs: 1,
      decided: [{ messageId, createdAtMs: floorMs - 1 }],
    },
  ],
});
const reach = (verdict: "stopped" | "held", seq: number): ReachHandover => ({
  version: 2,
  unproven: [],
  unprovenAll: false,
  unprovenFolders: [],
  unprovenPaths: [],
  verdicts: [
    {
      automationId: PRESSED,
      definitionHash: "hash-pay",
      step: "0",
      verdict,
      stoppedFor: verdict === "stopped" ? "ana" : null,
      seq,
    },
  ],
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
    notifyClaimed: () => undefined,
    failuresChanged: vi.fn(),
    datasetsChanged: () => undefined,
    pressDataset: async () => ({ busy: true }),
    handlePulledPaths: () => undefined,
    relayAnswered: () => undefined,
    groupMessagesArrived: async () => undefined,
    hostChanged: () => undefined,
    releaseGroupSubscriptions: async () => ({
      handover: groups(at(10, 30), "message-on-server"),
      watchedGeneration: 3,
    }),
    reachHandover: async () => reach("held", 9),
    relayedClaim: async () => null,
    inspectRelayedBatch: async (ids) =>
      ids.map(() => ({ kind: "unchecked", reason: "Host unavailable" })),
    pressRelayed: async (input, watch) => {
      pressed.push({ pressId: input.pressId, pressedBy: input.pressedBy });
      watch(`claim-${input.pressId}`, null);
      return {
        pressed: { busy: false, claimId: `claim-${input.pressId}`, settled: null },
        field: "Mark paid",
      };
    },
    automationName: () => "Pay",
    schedules: () => (opened ? scheduled : null),
    scheduleMarks: async () => {
      marksAsked += 1;
      return engine.answers ? [...marks.values()] : null;
    },
    claimSchedule: async (input) => {
      claims.push({ run: input.run, throughMs: input.throughMs });
      const mark = {
        automationId: input.automationId,
        scheduleHash: input.scheduleHash,
        throughMs: input.throughMs,
      };
      marks.set(input.automationId, mark);
      return mark;
    },
    runs: async (automationId, before) => {
      asked.push(["runs", automationId, before]);
      return {
        runs: [
          {
            claimId: "claim-1",
            state: "failed",
            error: "boom",
            createdAtMs: 1,
            updatedAtMs: 2,
            trigger: {
              kind: "changed",
              recordId: "record",
              by: "human",
              depth: 0,
              sharedAuthor: null,
            },
            writes: [],
            definitionChanged: false,
            neverStarted: false,
            chainStopped: false,
            undoUnfinished: false,
            undone: false,
          },
        ],
        next: null,
      };
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
      return {
        status: "undone",
        reverted: 1,
        removed: 0,
        kept: 0,
        changedSince: 0,
        missing: 0,
        irreversible: 0,
        actions: 0,
        actionsReversed: 0,
        deleted: 0,
        keptChanged: 0,
        gone: 0,
      };
    },
    removePendingRestore: async (id) => {
      asked.push(["releaseRestore", id]);
    },
    undoRunsOf: async (definitions, _trash, again, retentionId) => {
      expect(retentionId).toBe("desktop:restore-test");
      asked.push(["restore", definitions, again]);
      return {
        undone: definitions.length,
        left: 0,
        reverted: 1,
        missing: 0,
        keptFields: [],
        otherKept: 0,
        errorMessage: null,
      };
    },
    confirmReach: async (input) => {
      asked.push(["allow", input]);
      return input.seq === HELD.seq ? "confirmed" : "changed";
    },
  };
  return { executor, options, holds, claims, pressed, asked, marksAsked: () => marksAsked };
}

type Fake = ReturnType<typeof fakeExecutor>;

async function relay() {
  const storage = await testStorage();
  const h = testHandler(storage, {
    nowMs: () => clock,
    automationServer: { label: "My dohc server" },
  });
  await claimWorkspace(h, OWNER, WORKSPACE);
  const host = async (action: string, body?: Record<string, unknown>) => {
    const response = await h(
      request(OWNER, `/sync/${WORKSPACE}/automation-host${action}`, body ? jsonBody(body) : {}),
    );
    return { status: response.status, body: await json(response) };
  };
  return { storage, h, host };
}

async function server(
  storage: SyncRelayStorage,
  h: Pick<ReturnType<typeof testHandler>, "readOwnerShares">,
  input: {
    datasetHost?: RelayDatasetHost;
    incarnation?: number;
    schedules?: ScheduledAutomation[];
    inspection?: RelayButtonInspection;
    engine?: { answers: boolean };
    client?: EngineClient;
    recordDelivery?: AutomationServerOptions["recordDelivery"];
  } = {},
) {
  const marks = new Map<
    string,
    { automationId: string; scheduleHash: string; throughMs: number }
  >();
  const executors: Fake[] = [];
  const open = new Map<string, AutomationReplica>();
  let pulledHead = 0;
  const sync = vi.fn(async () => {
    pulledHead = storage.automationWorkspaceLogHead(WORKSPACE);
  });
  let hooks: Parameters<typeof startAutomationReplicas>[0] | undefined;
  const errors: Array<[string, unknown]> = [];
  const replicaOf = (): AutomationReplica => ({
    workspaceId: WORKSPACE,
    ownerUserId: OWNER,
    incarnation: input.incarnation ?? 1,
    reasons: ["automation"],
    startedAtMs: at(7),
    root: "unused",
    metadataDir: "unused",
    client: input.client ?? ({} as unknown as EngineClient),
    workspace: "handle",
    signal: new AbortController().signal,
    nextRequestId: () => 1,
    sync,
    step: async () => true,
    withRecordWork: (work) => work(),
    get pulledHead() {
      return pulledHead;
    },
  });
  const run = await startAutomationServer({
    storage,
    datasetHost: input.datasetHost,
    server: { label: "My dohc server" },
    replicas: {
      root: "unused",
      engineExecutable: "unused",
      relayOrigin: "https://relay.example.test",
      key: new Uint8Array(32),
      namespace: "test",
    },
    readOwnerShares: (ownerUserId, path) => h.readOwnerShares(ownerUserId, path),
    lookupUserDisplayName: (userId) => (userId === OWNER ? "Ice" : "Ana"),
    noticeLimiter: new TokenBucketLimiter(10, 1, 100),
    onError: (context, error) => errors.push([context, error]),
    nowMs: () => clock,
    // The scheduler wakes when the host changes or a test steps it.
    clock: {
      now: () => clock,
      monotonic: () => clock,
      setTimer: () => null,
      clearTimer: () => undefined,
    },
    startReplicas: async (options) => {
      hooks = options;
      return {
        unavailable: false,
        replica: (id) => open.get(id),
        reconcile: () => undefined,
        deleteWorkspaces: async () => undefined,
        failedSyncs: () => new Map(),
        settled: async () => undefined,
        close: async () => undefined,
      };
    },
    ...(input.recordDelivery ? { recordDelivery: input.recordDelivery } : {}),
    createExecutor: (options) => {
      const fake = fakeExecutor(options, marks, input.engine, input.schedules);
      if (input.inspection)
        fake.executor.inspectRelayedBatch = async (ids) => ids.map(() => input.inspection!);
      executors.push(fake);
      return fake.executor;
    },
  });
  cleanup.push(() => run.close());
  return {
    run,
    errors,
    sync,
    /** The workspaces the replicas module is asked to keep. */
    wanted: () => [...hooks!.wanted().keys()],
    /** The replicas module opened this server's copy of the workspace. */
    async openReplica(): Promise<Fake> {
      open.set(WORKSPACE, replicaOf());
      hooks!.onChanged?.(WORKSPACE);
      await vi.waitFor(() => expect(executors).toHaveLength(1));
      // Most fake replicas keep no History. A test can provide a real client or override these instance reads.
      if (input.client === undefined)
        await executors[0]!.options.withEngine(async (engine) => {
          if (!(engine instanceof VersionedLiveAdapter))
            throw new Error("Expected the replica adapter");
          vi.spyOn(engine, "flushCapture").mockResolvedValue({
            settled: true,
            running: false,
            degraded: false,
            heldFiles: [],
            deferredWrites: [],
          });
          vi.spyOn(engine, "getActiveVersion").mockImplementation((params) => {
            // Existing write tests supply a prototype implementation.
            return vi.isMockFunction(VersionedLiveAdapter.prototype.getActiveVersion)
              ? VersionedLiveAdapter.prototype.getActiveVersion.call(engine, params)
              : Promise.resolve(null);
          });
        });
      return executors[0]!;
    },
  };
}

const notices = (storage: SyncRelayStorage, userId: string) =>
  storage.readNoticeChanges({ recipientUserId: userId, cursor: null, limit: 50, nowMs: clock })
    .notices;

function resolvers() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function payAutomation() {
  const parsed = parseAutomationsFile(
    "version: 1\nautomations:\n  - id: pay\n    name: Pay\n    when: record-added\n    do: [{set: {Status: Paid}}]\n",
  );
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid")
    throw new Error("invalid fixture");
  return parsed.entries[0].automation;
}
const setStatus = (n: number): StoredStep["effects"][number] => ({
  kind: "set",
  target: { recordId: `record-${n}`, collectionPath: "Tasks", path: `Tasks/${n}.md` },
  fields: [{ field: "Status", before: "Open", after: "Paid" }],
});
/** A run of Pay, as the server's executor starts one in its copy. */
const payRunRecord = (claimId: string): StoredRun => ({
  ...newRun({ automationId: PRESSED, claimId }, payAutomation(), `seed-${claimId}`, clock),
  collections: [{ collectionId: "Tasks", path: "Tasks" }],
});

/**
 * One run of Pay through the executor's own step runner, with the hooks the
 * server gives its executor. Its step sets Status on `effects` records.
 */
function payRun(options: CollectionAutomationsOptions, claimId: string, effects: number) {
  const automation = payAutomation();
  const claim = {
    claimId,
    automationId: PRESSED,
    collectionPath: "Tasks",
    createdAtMs: clock,
    change: { kind: "added" as const, fields: [], fieldsOmitted: 0 },
  };
  const run = newRun(claim, automation, `seed-${claimId}`, clock);
  // Each save, as `outcome:durableEffects`.
  const saves: string[] = [];
  const backend: StepBackend = {
    step: (async () => ({
      step: { ordinal: 0, effects: Array.from({ length: effects }, (_, n) => setStatus(n)) },
    })) as StepBackend["step"],
    collectionsOf: () => [{ collectionId: "Tasks", path: "Tasks" }],
    added: () => null,
    apply: async (_run, effect) =>
      effect.kind === "set"
        ? [
            {
              kind: "field",
              recordId: effect.target.recordId,
              path: effect.target.path,
              field: "Status",
              before: "Open",
              after: "Paid",
            },
          ]
        : [],
  };
  const f = {
    run,
    saves,
    backend,
    onSave: async (_run: StoredRun): Promise<void> => undefined,
    execute: (saved: boolean) =>
      runSteps(
        dependencies,
        backend,
        {
          automation,
          collection: { path: "Tasks", name: "Tasks" },
          roster: { kind: "owner", ownerUserId: OWNER, grants: [] },
          signal: new AbortController().signal,
          stopped: new AbortController().signal,
          claimRun: 1,
          engineClaimId: claimId,
        },
        {
          automation,
          claim,
          message: null,
          person: null,
          chat: null,
          nowMs: clock,
          key: { claimId, hash: "key" },
        },
        run,
        saved,
        { prepareMs: 0, runMs: 0 },
      ),
  };
  const store = {
    save: async (saved: StoredRun) => {
      saves.push(`${saved.outcome?.state ?? "open"}:${saved.durableEffects}`);
      await f.onSave(saved);
    },
    appendEffect: async () => undefined,
    appendStep: async () => {
      throw new Error("A fresh run saves its first step with the run.");
    },
  } as unknown as AutomationRunStore;
  const dependencies: Parameters<typeof runSteps>[0] = {
    store,
    nowMs: () => clock,
    makeDurable: async () => undefined,
    evaluator: {
      evaluate: async () => {
        throw new Error("Pay has no formulas.");
      },
      runCode: async () => {
        throw new Error("Pay runs no code.");
      },
    },
    chat: {
      hasMessage: async () => false,
      directory: async () => null,
      write: async () => {
        throw new Error("Pay posts nothing.");
      },
    },
    recipientVerdicts: async () => [],
    readCode: async () => null,
    beforeEffect: options.beforeEffect,
    onRunEnded: options.onRunEnded,
  };
  return f;
}

describe("a server that runs a workspace's automations", () => {
  it("notifies the owner, last editor and triggering person of a breaker with current permission checks", async () => {
    const { storage, h } = await relay();
    await createShare(h, OWNER, WORKSPACE, {
      recipientUserId: "starter",
      paths: ["Tasks"],
      access: "edit",
    });
    await createShare(h, OWNER, WORKSPACE, {
      recipientUserId: "editor",
      paths: ["Tasks"],
      access: "edit",
    });
    const s = await server(storage, h);
    const fake = await s.openReplica();
    const before =
      "version: 1\nautomations:\n  - id: hourly\n    name: Old name\n    when: {field-changed: Status}\n    do: [{set: {X: 1}}]\n";
    const after = before.replace("Old name", "Hourly");
    const moment: MomentRecord = {
      momentOrder: 1,
      momentId: "edited",
      versionId: "main",
      objectId: "object",
      path: "Tasks/automations.yaml",
      recordedAtMs: clock,
      operation: "write",
      afterContentKind: "text",
      afterBlobSha256: "after",
      afterBinarySha256: null,
      beforePresent: true,
      beforeContentKind: "text",
      beforeBlobSha256: "before",
      beforeBinarySha256: null,
      beforeLatestMomentId: null,
      metadataOrigin: "api",
      authors: [{ kind: "named", userId: "editor", grantId: "grant-editor", grantGeneration: 1 }],
      syncRecordOnly: false,
      afterText: after,
      afterByteLength: after.length,
      afterInbandLimitBytes: null,
      beforeText: before,
      beforeByteLength: before.length,
      beforeInbandLimitBytes: null,
    };
    await fake.options.withEngine(async (engine) => {
      if (!(engine instanceof VersionedLiveAdapter))
        throw new Error("Expected the replica adapter");
      vi.spyOn(engine, "getActiveVersion").mockResolvedValue({
        id: "main",
        workspaceId: WORKSPACE,
        kind: "main",
        name: "Main",
        createdAtMs: 0,
      });
      vi.spyOn(engine, "readTextFile").mockResolvedValue({
        versionId: "main",
        path: "Tasks/automations.yaml",
        objectId: "object",
        contentKind: "text",
        text: after,
        blobSha256: "after",
        workspaceId: WORKSPACE,
        sha256: "after",
        byteLength: after.length,
        updatedAtMs: clock,
        latestMomentId: "edited",
        metadataOrigin: "api",
      });
      vi.spyOn(engine, "readHistoryPage").mockResolvedValue({
        activeVersion: {
          id: "main",
          workspaceId: WORKSPACE,
          kind: "main",
          name: "Main",
          createdAtMs: 0,
        },
        moments: [{ ...moment, beforePath: moment.beforePath ?? null }],
        protectedMoments: [],
        versionMarkers: [],
        latestMomentOrder: 1,
        nextCursor: null,
        startCursor: {
          format: 1,
          engineUuid: "test",
          workspaceId: WORKSPACE,
          versionId: "main",
          objectId: "object",
          operationId: null,
          textFence: 1,
          protectedFence: -1,
          markerFence: -1,
          text: null,
          protected: null,
          marker: null,
        },
      });
      vi.spyOn(engine, "getMoment").mockResolvedValue(moment);
    });
    const failure = {
      automationId: HOURLY.automationId,
      claimId: "third-timeout",
      generation: 3,
      datasetInstance: null,
      neverStarted: false,
      chainStopped: false,
      error: "private-step-token".repeat(2_000),
      updatedAtMs: clock,
      switchedOff: { reason: "consecutive-timeouts" as const, collectionPath: "Tasks" },
    };
    await fake.options.reportFailure({
      failure,
      name: "Hourly",
      collectionPath: "Tasks",
      startedBy: "starter",
      replaces: null,
    });
    expect(notices(storage, OWNER)).toHaveLength(1);
    expect(notices(storage, OWNER)[0]!.body.startsWith(AUTOMATION_SWITCHED_OFF_BODY)).toBe(true);
    for (const person of ["starter", "editor"]) {
      expect(notices(storage, person)).toHaveLength(1);
      expect(notices(storage, person)[0]).toMatchObject({
        body: AUTOMATION_SWITCHED_OFF_BODY,
        target: {
          recovery: "automation-controls",
          path: "Tasks/automations.yaml",
          automation: HOURLY.automationId,
        },
      });
      expect(notices(storage, person)[0]!.target).not.toHaveProperty("run");
    }
    expect(notices(storage, "outsider")).toHaveLength(0);
    // The last editor now lacks access to Tasks. A later failure must not disclose even its safe copy to them.
    await fake.options.withEngine(async (engine) => {
      if (!(engine instanceof VersionedLiveAdapter))
        throw new Error("Expected the replica adapter");
      vi.spyOn(engine, "getMoment").mockResolvedValue({
        ...moment,
        authors: [{ kind: "named", userId: "outsider", grantId: "lost", grantGeneration: 1 }],
      });
    });
    await fake.options.reportFailure({
      failure: { ...failure, generation: 4 },
      name: "Hourly",
      collectionPath: "Tasks",
      startedBy: "starter",
      replaces: failure,
    });
    expect(notices(storage, "outsider")).toHaveLength(0);
    expect(s.errors.some(([context]) => context.includes("another person involved"))).toBe(true);
  });

  it("takes the schedules, Group coverage, and reach verdicts from a computer, and hands them back", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    // The owner chose the laptop, then this server.
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: false });
    expect((await host("/choose", { installId: "laptop", generation: 0 })).status).toBe(200);
    expect((await host("/choose", { installId: "server", generation: 1 })).body.host).toMatchObject(
      { installId: "server", handoverFrom: "laptop", generation: 2 },
    );
    const s = await server(storage, h);
    const fake = await s.openReplica();
    expect(
      await fake.options.groupHost(),
      "the server runs nothing until the laptop releases",
    ).toBeNull();

    // The laptop ran its schedules through 8:00 and releases what it decided.
    clock = at(9, 1);
    expect(
      (
        await host("/release", {
          installId: "laptop",
          generation: 2,
          releasedThroughMs: at(8),
          groups: groups(at(8), "message-on-laptop"),
          groupsWatched: 1,
          reach: reach("stopped", 4),
        })
      ).status,
    ).toBe(200);

    // The server starts after the laptop: 9:00 runs here, and nothing before it.
    await vi.waitFor(() =>
      expect(fake.claims).toEqual([
        { run: [], throughMs: at(8) },
        { run: [at(9)], throughMs: at(9, 1) },
      ]),
    );
    expect(await fake.options.groupHost()).toBe(3);
    expect(
      await fake.options.groupRelayRecord(3, new AbortController().signal),
      "the laptop's decided messages, so each claims once",
    ).toEqual({ generation: 3, handover: groups(at(8), "message-on-laptop") });
    expect(
      await fake.options.reachRelayRecord(3, new AbortController().signal),
      "the step the laptop stopped stays stopped here",
    ).toEqual({ generation: 3, reach: reach("stopped", 4), everShared: false });
    expect(storage.readAutomationServerSchedules(WORKSPACE)).toEqual({
      incarnation: 1,
      hostGeneration: 3,
      hostReleasedMs: at(8),
      throughMs: at(9, 1),
      takenGeneration: 3,
      fenceGeneration: null,
    });

    // The owner chooses the laptop again: the server steps once more and releases.
    clock = at(10, 30);
    expect((await host("/choose", { installId: "laptop", generation: 3 })).status).toBe(200);
    await vi.waitFor(async () =>
      expect((await host("")).body.host).toEqual({
        installId: "laptop",
        generation: 5,
        handoverFrom: null,
        releasedThroughMs: at(10, 30),
      }),
    );
    expect(fake.claims.at(-1)).toEqual({ run: [at(10)], throughMs: at(10, 30) });
    expect(
      (await host("/groups?generation=5")).body,
      "the laptop takes what the server decided and held",
    ).toMatchObject({
      generation: 5,
      groups: groups(at(10, 30), "message-on-server"),
      reach: reach("held", 9),
    });
    expect(await fake.options.groupHost()).toBeNull();
    expect(storage.readAutomationServerSchedules(WORKSPACE)?.throughMs).toBe(at(10, 30));
    expect(s.errors).toEqual([]);
  });

  it("takes no Group coverage or reach verdicts an earlier copy took, even one with no schedules, and takes a later release", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: false });
    await host("/choose", { installId: "laptop", generation: 0 });
    await host("/choose", { installId: "server", generation: 1 });
    await host("/release", {
      installId: "laptop",
      generation: 2,
      releasedThroughMs: at(8),
      groups: groups(at(8), "message-on-laptop"),
      groupsWatched: 1,
      reach: reach("stopped", 4),
    });
    // The first copy, which ran no schedules, was given the laptop's release.
    const first = await server(storage, h, { incarnation: 1, schedules: [] });
    const taking = await first.openReplica();
    expect(await taking.options.groupRelayRecord(3, new AbortController().signal)).toEqual({
      generation: 3,
      handover: groups(at(8), "message-on-laptop"),
    });
    await first.run.close();
    const s = await server(storage, h, { incarnation: 2 });
    const fake = await s.openReplica();
    expect(
      await fake.options.groupRelayRecord(3, new AbortController().signal),
      "Group triggers start from now",
    ).toEqual({ generation: 3, handover: null });
    expect(
      await fake.options.reachRelayRecord(3, new AbortController().signal),
      "what it cannot prove, it holds",
    ).toEqual({ generation: 3, reach: null, everShared: false });

    // The owner moves the automations to the laptop and back: that release is new to this copy.
    clock = at(9);
    await host("/choose", { installId: "laptop", generation: 3 });
    await vi.waitFor(async () =>
      expect((await host("")).body.host).toMatchObject({ installId: "laptop", generation: 5 }),
    );
    await host("/choose", { installId: "server", generation: 5 });
    await host("/release", {
      installId: "laptop",
      generation: 6,
      releasedThroughMs: at(9),
      groups: groups(at(9), "later"),
      groupsWatched: 5,
      reach: reach("held", 6),
    });
    expect(await fake.options.groupRelayRecord(7, new AbortController().signal)).toEqual({
      generation: 7,
      handover: groups(at(9), "later"),
    });
    expect(await fake.options.reachRelayRecord(7, new AbortController().signal)).toEqual({
      generation: 7,
      reach: reach("held", 6),
      everShared: false,
    });
  });

  it("resumes a rebuilt copy again after a restart that came before its marks landed", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    storage.beginAutomationServerCopy({ workspaceId: WORKSPACE, incarnation: 1 });
    storage.recordAutomationServerStart({
      workspaceId: WORKSPACE,
      incarnation: 1,
      generation: 1,
      releasedThroughMs: null,
    });
    storage.recordAutomationServerProgress({ workspaceId: WORKSPACE, throughMs: at(10) });
    clock = at(9, 30);
    // The engine of the new copy stops answering before the scheduler reads its marks.
    const first = await server(storage, h, { incarnation: 2, engine: { answers: false } });
    const stalled = await first.openReplica();
    await vi.waitFor(() => expect(stalled.marksAsked()).toBeGreaterThan(0));
    await first.run.close();
    expect(stalled.claims).toEqual([]);
    expect(storage.readAutomationServerSchedules(WORKSPACE), "not started yet").toMatchObject({
      incarnation: 2,
      hostGeneration: null,
    });
    // After the restart the copy still has no marks, so it resumes at its progress.
    const second = await server(storage, h, { incarnation: 2 });
    const fake = await second.openReplica();
    await vi.waitFor(() => expect(fake.claims).toEqual([{ run: [], throughMs: at(10) }]));
    await vi.waitFor(() =>
      expect(storage.readAutomationServerSchedules(WORKSPACE)).toMatchObject({
        incarnation: 2,
        hostGeneration: 1,
      }),
    );
  });
  it.each([
    [{ kind: "unchecked", reason: "Host unavailable" }, SHARED_BUTTON_UNCHECKED],
    [{ kind: "denied", reason: "carol@x cannot view Payroll" }, SHARED_BUTTON_DENIED],
    [
      { kind: "denied", reason: "Private Collection does not support this step" },
      SHARED_BUTTON_DENIED,
    ],
    [{ kind: "denied", reason: SHARED_BUTTON_HELD }, SHARED_BUTTON_HELD],
    [{ kind: "denied", reason: SHARED_BUTTON_MOVED }, SHARED_BUTTON_MOVED],
    [{ kind: "denied", reason: SHARED_BUTTON_FIELD_CHANGED }, SHARED_BUTTON_FIELD_CHANGED],
  ] satisfies Array<[RelayButtonInspection, string]>)(
    "answers an inspection safely with an initial press backlog: %j",
    async (inspectionResult, safeReason) => {
      clock = at(8);
      const { storage, h, host } = await relay();
      await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
      const shareId = await createShare(h, OWNER, WORKSPACE, {
        recipientUserId: "ana",
        paths: ["Tasks"],
        access: "edit",
      });
      const grant = storage.listActiveShareGrantsForRecipient(shareId, "ana")[0]!;
      const s = await server(storage, h, { inspection: inspectionResult });
      expect(
        (
          await h(
            request(
              "ana",
              `/sync/shares/${shareId}/automation-presses`,
              jsonBody({
                pressId: "initial",
                automationId: PRESSED,
                collectionPath: "Tasks",
                definitionHash: "0123456789abcdef",
                recordId: "rec-12",
                confirmed: [],
              }),
            ),
          )
        ).status,
      ).toBe(200);
      const list = storage.listAutomationPresses.bind(storage);
      const controller = new AbortController();
      let inspection: ReturnType<SyncRelayStorage["inspectAutomationButton"]> | undefined;
      let queued = 0;
      const spy = vi.spyOn(storage, "listAutomationPresses").mockImplementation((scope) => {
        const presses = list(scope);
        if (presses.length > 0 && inspection === undefined) {
          inspection = storage.inspectAutomationButton({
            target: {
              automationId: PRESSED,
              collectionPath: "Tasks",
              definitionHash: "0123456789abcdef",
            },
            source: {
              workspaceId: WORKSPACE,
              shareId,
              grantId: grant.grantId,
              grantGeneration: grant.generation,
              userId: "ana",
            },
            id: "busy-server",
            signal: controller.signal,
            wake: () => {},
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
        await expect(inspection).resolves.toEqual({
          kind: inspectionResult.kind,
          reason: safeReason,
        });
        expect(
          s.errors.some(
            ([, error]) => error instanceof Error && error.message === inspectionResult.reason,
          ),
        ).toBe(true);
      } finally {
        controller.abort();
        spy.mockRestore();
      }
    },
  );

  it("runs a press from a share view as the person who pressed, and tells them when it fails", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    const shareId = await createShare(h, OWNER, WORKSPACE, {
      recipientUserId: "ana",
      paths: ["Tasks"],
      access: "edit",
    });
    const s = await server(storage, h);
    const fake = await s.openReplica();

    const pressed = await h(
      request(
        "ana",
        `/sync/shares/${shareId}/automation-presses`,
        jsonBody({
          pressId: "press-1",
          automationId: PRESSED,
          collectionPath: "Tasks",
          definitionHash: "0123456789abcdef",
          recordId: "rec-12",
          confirmed: [],
        }),
      ),
    );
    expect(pressed.status).toBe(200);
    await vi.waitFor(() =>
      expect(fake.pressed).toEqual([{ pressId: expect.any(String), pressedBy: "ana" }]),
    );
    const [{ pressId }] = fake.pressed;

    fake.options.onPressSettled({
      claimId: `claim-${pressId}`,
      outcome: "failed",
      error: "Tasks/one.md is not a record.",
    });
    const failure = {
      automationId: PRESSED,
      claimId: `claim-${pressId}`,
      generation: 1,
      datasetInstance: null,
      neverStarted: false,
      chainStopped: false,
      error: "Tasks/one.md is not a record.",
      updatedAtMs: clock,
    };
    await fake.options.reportFailure({
      failure,
      name: "Mark paid",
      collectionPath: "Tasks",
      startedBy: "ana",
      replaces: null,
    });
    await vi.waitFor(() => expect(notices(storage, "ana")).toHaveLength(1));
    expect(notices(storage, "ana")[0]!.noticeId).not.toContain("automation-press:");
    expect(
      inspectDatabase(storagePath(storage))
        .prepare("SELECT user_id, state, outcome FROM sync_relay_automation_presses")
        .all(),
    ).toEqual([{ user_id: "ana", state: "settled", outcome: "failed" }]);
    await fake.options.withdrawFailure(failure);
    expect(notices(storage, "ana").filter((notice) => notice.dismissedAtMs === null)).toEqual([]);
  });

  it("checks reach against the relay's own share records, which narrow and widen at once", async () => {
    clock = at(8);
    const { storage, h, host } = await relay();
    await host("/check-in", { installId: "laptop", label: "Laptop", claim: true });
    const s = await server(storage, h);
    const fake = await s.openReplica();
    expect(await fake.options.roster()).toEqual({
      kind: "owner",
      ownerUserId: OWNER,
      grants: [],
      formerEditors: [],
    });
    const shareId = await createShare(h, OWNER, WORKSPACE, {
      recipientUserId: "ana",
      paths: ["Tasks"],
      access: "edit",
    });
    expect(await fake.options.roster()).toMatchObject({
      kind: "owner",
      grants: [{ recipientUserId: "ana", files: { paths: ["Tasks"], access: "edit" } }],
    });
    expect(
      (await h(request(OWNER, `/sync/shares/${shareId}/revoke`, { method: "POST" }))).status,
    ).toBe(200);
    expect(await fake.options.roster()).toEqual({
      kind: "owner",
      ownerUserId: OWNER,
      grants: [],
      formerEditors: [],
    });
  });

  it("reads the owner's shares without claiming an invite the owner has not opened", async () => {
    const storage = await testStorage();
    // Ana invites the owner by email before the relay knows that address.
    const h = testHandler(storage, { nowMs: () => clock, resolveUserIdByEmail: () => null });
    await claimWorkspace(h, "ana", "workspace-ana");
    const shareId = await createShare(h, "ana", "workspace-ana", {
      recipientEmail: "owner@dohc.test",
      paths: ["docs"],
    });
    expect((await h.readOwnerShares(OWNER, "/sync/shares")).status).toBe(200);
    expect(
      storage.listActiveShareGrantsForRecipient(shareId, OWNER),
      "the server claimed nothing",
    ).toEqual([]);
    // The owner's own listing claims it, as before.
    expect((await h(request(OWNER, "/sync/shares"))).status).toBe(200);
    expect(storage.listActiveShareGrantsForRecipient(shareId, OWNER)).toHaveLength(1);
  });
});

const UNDELIVERED =
  "The record has updates the server has not sent, because no outbox holds them or the shared file set them aside. Until they are sent, the server confirms no run's changes as sent.";

describe("a server that pushes its copy of a workspace", () => {
  it("never captures a quarantined draft its owner has not asked to try again, nor confirms a run's changes sent while it waits", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const binding = {
      workspaceId: WORKSPACE,
      mainVersionId: "main",
      objectId: "record",
      lineageClaimId: "a".repeat(64),
      currentPath: "Tasks/one.md",
      selectorPaths: ["Tasks"],
      restoreFenceGeneration: 0,
    };
    const draft = { binding, pendingBytes: 10, state: "quarantined", outboxId: "outbox" };
    const capture = vi.fn(async () => {
      throw new Error("Device delivery is unavailable.");
    });
    // The engine lists a quarantined draft as pending only while its owner's Try again waits.
    const client = {
      ownerYDocListDrafts: vi.fn(async (_request: unknown, input: { pendingOnly?: boolean }) => ({
        drafts: input.pendingOnly ? [] : [draft],
        next: null,
      })),
    };
    vi.spyOn(storage, "automationRecordBinding").mockReturnValue({ binding });
    const readHead = vi.spyOn(OwnerYDocOutbox.prototype, "readHead").mockResolvedValue({
      outboxId: "outbox",
      binding,
      baseUpdate: Uint8Array.of(0, 0),
      baseUpdateDigest: binding.lineageClaimId,
      state: "quarantined",
      pendingBytes: 10,
      oldestEntryAtMs: 1,
      quarantineReason: "invalid-update",
      observedBinding: null,
      retryDeliveryId: null,
      entry: {
        appendKey: "key",
        sequence: 1,
        deliveryId: "delivery",
        updateDigest: "b".repeat(64),
        update: Uint8Array.of(0, 0),
        byteLength: 2,
        createdAtMs: 1,
      },
    });
    const drained = vi.spyOn(OwnerYDocOutboxDrainer.prototype, "drainOnce");
    const currentBinding = vi.mocked(storage.automationRecordBinding);
    const s = await server(storage, h, {
      client: client as unknown as EngineClient,
      recordDelivery: { namespace: "relay", capture },
    });
    const { options } = await s.openReplica();
    const held = payRunRecord("claim-held");
    options.beforeEffect!(held, setStatus(0));
    const syncs = s.sync.mock.calls.length;
    options.onRunEnded!(held);
    // Closing waits for the sync that began after the run ended, which leaves it on record.
    await vi.waitFor(() => expect(s.sync.mock.calls.length).toBeGreaterThan(syncs));
    await s.run.close();
    expect(storage.endedAutomationServerRuns({ workspaceId: WORKSPACE, incarnation: 1 })).toEqual([
      expect.objectContaining({ claimId: "claim-held" }),
    ]);
    expect(await drained.mock.results[0]!.value).toBe("frozen");
    expect(readHead).toHaveBeenCalledWith("outbox");
    expect(capture).not.toHaveBeenCalled();
    const delivering = s.errors.filter(([context]) =>
      context.startsWith("deliver automation record"),
    );
    expect(delivering.length).toBeGreaterThan(0);
    expect(delivering).toEqual(
      delivering.map(() => [
        `deliver automation record "Tasks/one.md" in workspace "${WORKSPACE}"`,
        expect.objectContaining({ message: UNDELIVERED }),
      ]),
    );
    drained.mockRestore();
    readHead.mockRestore();
    currentBinding.mockRestore();
  });
  it("confirms runs' changes sent again once a set-aside queue recovers with nothing pending", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const binding = {
      workspaceId: WORKSPACE,
      mainVersionId: "main",
      objectId: "record",
      lineageClaimId: "a".repeat(64),
      currentPath: "Tasks/one.md",
      selectorPaths: ["Tasks"],
      restoreFenceGeneration: 0,
    };
    let draft = { binding, pendingBytes: 10, state: "quarantined", outboxId: "outbox" };
    const client = { ownerYDocListDrafts: vi.fn(async () => ({ drafts: [draft], next: null })) };
    vi.spyOn(storage, "automationRecordBinding").mockReturnValue({ binding });
    const readHead = vi.spyOn(OwnerYDocOutbox.prototype, "readHead").mockResolvedValue({
      outboxId: "outbox",
      binding,
      baseUpdate: Uint8Array.of(0, 0),
      baseUpdateDigest: binding.lineageClaimId,
      state: "quarantined",
      pendingBytes: 10,
      oldestEntryAtMs: 1,
      quarantineReason: "binding-changed",
      observedBinding: null,
      retryDeliveryId: null,
      entry: {
        appendKey: "key",
        sequence: 1,
        deliveryId: "delivery",
        updateDigest: "b".repeat(64),
        update: Uint8Array.of(0, 0),
        byteLength: 2,
        createdAtMs: 1,
      },
    });
    const currentBinding = vi.mocked(storage.automationRecordBinding);
    const s = await server(storage, h, {
      client: client as unknown as EngineClient,
      recordDelivery: { namespace: "relay", capture: vi.fn() },
    });
    const { options } = await s.openReplica();
    const ended = () =>
      storage.endedAutomationServerRuns({ workspaceId: WORKSPACE, incarnation: 1 });
    const reported = () =>
      s.errors.filter(([context]) => context.startsWith("deliver automation record")).length;
    // The record still resolves to the queue's binding, so the queue can recover and holds the run.
    const held = payRunRecord("claim-held");
    options.beforeEffect!(held, setStatus(0));
    const lists = client.ownerYDocListDrafts.mock.calls.length,
      reports = reported();
    options.onRunEnded!(held);
    await vi.waitFor(() => {
      expect(client.ownerYDocListDrafts.mock.calls.length).toBeGreaterThan(lists);
      expect(reported()).toBeGreaterThan(reports);
    });
    expect(ended()).toEqual([expect.objectContaining({ claimId: "claim-held" })]);
    // Recovery leaves the queue active with nothing pending. The next sync confirms both runs.
    draft = { ...draft, pendingBytes: 0, state: "active" };
    const after = payRunRecord("claim-after");
    options.beforeEffect!(after, setStatus(1));
    options.onRunEnded!(after);
    await vi.waitFor(() => expect(ended()).toEqual([]));
    readHead.mockRestore();
    currentBinding.mockRestore();
  });
});

describe("the server's run gate", () => {
  it("lets a workspace start its burst, then one run per refill, and gives back a turn that ran nothing", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const waiting: string[] = [];
      const gate = createRunGate({
        nowMs: () => Date.now(),
        onWaiting: (workspaceId) => waiting.push(workspaceId),
        burst: 2,
        refillMs: 1_000,
      });
      const signal = new AbortController().signal;
      (await gate.admit("a", signal))!.release(true);
      (await gate.admit("a", signal))!.release(false);
      (await gate.admit("a", signal))!.release(true);
      let third = false;
      const next = gate.admit("a", signal).then((turn) => {
        third = true;
        return turn;
      });
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

  it("runs at most so many at once across workspaces, in arrival order", async () => {
    const gate = createRunGate({ nowMs: () => 0, onWaiting: () => undefined, concurrentRuns: 1 });
    const signal = new AbortController().signal;
    const first = (await gate.admit("a", signal))!;
    const order: string[] = [];
    const second = gate.admit("b", signal).then((turn) => {
      order.push("b");
      return turn;
    });
    const third = gate.admit("c", signal).then((turn) => {
      order.push("c");
      return turn;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    first.release(true);
    (await second)!.release(true);
    (await third)!.release(true);
    expect(order).toEqual(["b", "c"]);
  });
});

describe("the owner's routes to the server's runs", () => {
  async function owned(changesPerOwner = 60) {
    clock = at(8);
    const storage = await testStorage();
    let serverRuns: ServerRuns | undefined;
    const h = testHandler(storage, {
      nowMs: () => clock,
      automationServer: { label: "My dohc server" },
      serverRuns: () => serverRuns,
      automationHostRateLimiter: new TokenBucketLimiter(changesPerOwner, 1, 10),
    });
    await claimWorkspace(h, OWNER, WORKSPACE);
    // The server keeps a copy of the workspace.
    storage.claimWorkspaceIdentity({
      workspaceId: WORKSPACE,
      replicationEpoch: "epoch-1",
      streamIdentity: "stream-1",
    });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
    const s = await server(storage, h);
    serverRuns = s.run.runs;
    const call = async (
      userId: string,
      action: string,
      body?: Record<string, unknown>,
      init: RequestInit = {},
    ) => {
      const response = await h(
        request(userId, `/sync/${WORKSPACE}/automation-server/${action}`, {
          ...(body ? jsonBody(body) : {}),
          ...init,
        }),
      );
      return { status: response.status, body: await json(response) };
    };
    return { storage, h, s, call };
  }

  it("answers the owner from the server's copy: runs, Try again, Undo, Stop and restore, and held steps", async () => {
    const { h, s, call } = await owned();
    // The server runs this workspace's automations.
    await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/automation-host/check-in`,
        jsonBody({ installId: "laptop", label: "Laptop", claim: true }),
      ),
    );
    const fake = await s.openReplica();
    fake.holds.push(HELD);
    s.sync.mockImplementation(async () => {
      fake.asked.push("sync");
    });
    const runs = await call(OWNER, `runs?automationId=${encodeURIComponent(PRESSED)}`);
    expect(runs).toMatchObject({
      status: 200,
      body: { ok: true, runs: [{ claimId: "claim-1", state: "failed" }] },
    });
    expect(
      await call(OWNER, "retry", { automationId: PRESSED, claimId: "claim-1", startOver: false }),
    ).toMatchObject({ status: 200, body: { ok: true, status: "queued" } });
    expect(
      await call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }),
    ).toMatchObject({ status: 200, body: { ok: true, status: "undone", reverted: 1 } });
    const definitions = [
      { collectionPath: "Budget", id: "pay", definitionHash: "0123456789abcdef" },
    ];
    expect(
      await call(OWNER, "restore", { definitions, again: false, retentionId: "restore-test" }),
    ).toMatchObject({ status: 200, body: { ok: true, undone: 1, left: 0, reverted: 1 } });
    expect(await call(OWNER, "holds")).toMatchObject({
      status: 200,
      body: { ok: true, holds: [HELD] },
    });
    const allow = { automationId: PRESSED, definitionHash: HELD.definitionHash, step: "0", seq: 7 };
    expect(await call(OWNER, "allow", allow)).toMatchObject({
      status: 200,
      body: { ok: true, status: "confirmed" },
    });
    expect(await call(OWNER, "allow", { ...allow, seq: 6 })).toMatchObject({
      status: 200,
      body: { status: "changed" },
    });
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
    expect(
      await call(OWNER, "restore", { definitions: [], again: false, retentionId: "restore-test" }),
    ).toMatchObject({ status: 200, body: { ok: true, undone: 0, errorMessage: null } });
    expect(fake.asked.at(-1)).toEqual(["releaseRestore", "desktop:restore-test"]);
  });

  it("answers anyone else, a browser cookie, or a workspace with no copy here as if nothing were there", async () => {
    const { storage, h, s, call } = await owned();
    // Ana can edit Tasks, which makes her no owner.
    await createShare(h, OWNER, WORKSPACE, {
      recipientUserId: "ana",
      paths: ["Tasks"],
      access: "edit",
    });
    // No copy yet: the owner hears what a stranger hears.
    const none = await call(OWNER, "holds");
    expect(none.status).toBe(404);
    const fake = await s.openReplica();
    for (const attempt of [
      await call("ana", "holds"),
      await call("ana", "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }),
      await call(OWNER, "holds", undefined, { headers: { cookie: "session=1" } }),
    ])
      expect(attempt).toEqual(none);
    expect(fake.asked).toEqual([]);
    // A workspace the relay no longer lists under the owner is not theirs to change.
    inspectDatabase(storagePath(storage))
      .prepare(
        "UPDATE sync_relay_workspaces SET owner_user_id = 'someone-else' WHERE workspace_id = ?",
      )
      .run(WORKSPACE);
    expect(
      await call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }),
    ).toEqual(none);
    expect(fake.asked).toEqual([]);
  });

  describe("after the server loses its host data", () => {
    const LOST_ERROR =
      "Your server lost its copy of this workspace and may not have sent this run's latest changes. Check the records it changed.";
    const runsOf = (query = "") => `runs?automationId=${encodeURIComponent(PRESSED)}${query}`;

    // Each start opens the server's copy of the workspace from its host
    // data. A higher incarnation is a copy rebuilt from empty host data.
    async function copies() {
      clock = at(8);
      const storage = await testStorage();
      let serverRuns: ServerRuns | undefined;
      const h = testHandler(storage, {
        nowMs: () => clock,
        automationServer: { label: "My dohc server" },
        serverRuns: () => serverRuns,
      });
      await claimWorkspace(h, OWNER, WORKSPACE);
      storage.claimWorkspaceIdentity({
        workspaceId: WORKSPACE,
        replicationEpoch: "epoch-1",
        streamIdentity: "stream-1",
      });
      storage.joinAutomationWorkspace({
        workspaceId: WORKSPACE,
        nowMs: 0,
        reasons: ["automation"],
      });
      // The server runs this workspace's automations.
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/automation-host/check-in`,
          jsonBody({ installId: "laptop", label: "Laptop", claim: true }),
        ),
      );
      const call = async (action: string, body?: Record<string, unknown>) => {
        const response = await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/automation-server/${action}`,
            body ? jsonBody(body) : {},
          ),
        );
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
      const sent = payRunRecord("claim-sent"),
        notified = payRunRecord("claim-notified"),
        unsent = payRunRecord("claim-unsent");
      beforeEffect!(sent, setStatus(0));
      beforeEffect!(notified, {
        kind: "notice",
        name: "Tell",
        notice: {
          noticeId: "n-claim-notified",
          kind: "automation-notify",
          title: "Paid",
          body: "Paid",
          target: { path: "Tasks/a.md", automation: PRESSED, run: "claim-notified" },
          recipientUserId: OWNER,
        },
      });
      clock = at(8, 5);
      beforeEffect!(unsent, setStatus(0));
      onRunEnded!(sent);
      onRunEnded!(notified);
      // The run's end is on record now, and the sync it started confirms it.
      await vi.waitFor(() =>
        expect(
          storage.endedAutomationServerRuns({ workspaceId: WORKSPACE, incarnation: 1 }),
        ).toEqual([]),
      );

      await first.run.close();
      clock = at(9);
      const second = await start(2);
      const lostRun = {
        claimId: "claim-unsent",
        state: "failed",
        createdAtMs: at(8),
        updatedAtMs: at(8, 5),
        writes: [],
        unsentChangesLost: true,
        error: LOST_ERROR,
      };
      await vi.waitFor(() =>
        expect(notices(storage, OWNER)).toEqual([
          expect.objectContaining({
            kind: "automation-failed",
            title: 'Automation "Pay" may have lost changes',
            body: LOST_ERROR,
            target: { automation: PRESSED, run: "claim-unsent", path: "Tasks/automations.yaml" },
          }),
        ]),
      );
      // Run history, as the owner's computers and agents read it, lists the lost run after this copy's own.
      const listed = await call(runsOf());
      expect(listed).toMatchObject({
        status: 200,
        body: { runs: [{ claimId: "claim-1" }, lostRun], next: null },
      });
      expect(listed.body.runs).toHaveLength(2);
      expect(await call(runsOf("&claimId=claim-unsent"))).toMatchObject({
        status: 200,
        body: { run: lostRun },
      });
      expect(
        await call("retry", { automationId: PRESSED, claimId: "claim-unsent", startOver: false }),
      ).toMatchObject({
        status: 200,
        body: {
          status: "refused",
          reason:
            "Your server lost this run's history with its copy of the workspace, so it will not run this again.",
        },
      });

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
      const applying = resolvers(),
        applied = resolvers();
      const apply = pay.backend.apply;
      pay.backend.apply = async (...args) => {
        applying.resolve();
        await applied.promise;
        return apply(...args);
      };
      const running = pay.execute(false);
      await applying.promise;

      // The server loses its host data while the run changes its copy.
      await first.run.close();
      clock = at(9);
      await start(2);
      await vi.waitFor(() =>
        expect(notices(storage, OWNER)).toEqual([
          expect.objectContaining({
            body: LOST_ERROR,
            target: { automation: PRESSED, run: "claim-fresh", path: "Tasks/automations.yaml" },
          }),
        ]),
      );
      expect(await call(runsOf("&claimId=claim-fresh"))).toMatchObject({
        body: { run: { createdAtMs: at(8), updatedAtMs: at(8), unsentChangesLost: true } },
      });
      applied.resolve();
      await expect(running).resolves.toEqual({ kind: "done" });
      expect(pay.saves).toEqual(["open:0", "done:1"]);
    });

    it("lists every run the lost copy may not have sent, and tells the owner of them all in one Notice", async () => {
      const { storage, call, start } = await copies();
      const changing = (claimId: string, startedAtMs: number, nowMs = startedAtMs) =>
        storage.recordAutomationServerRunChanging({
          workspaceId: WORKSPACE,
          incarnation: 1,
          automationId: PRESSED,
          claimId,
          automationName: "Pay",
          collectionPath: "Tasks",
          startedAtMs,
          nowMs,
        });
      // The first copy changed 51 runs it never sent, and one run that
      // started longer ago than run history keeps a run changed it today.
      changing("claim-waited", at(8) - 31 * 24 * HOUR, at(8));
      const lost = Array.from({ length: 51 }, (_, n) => `claim-${String(n).padStart(3, "0")}`);
      lost.forEach((claimId, n) => changing(claimId, at(8) + n));
      clock = at(9);
      await start(2);
      await vi.waitFor(() =>
        expect(notices(storage, OWNER)).toEqual([
          expect.objectContaining({
            title: 'Automation "Pay" may have lost changes',
            body: "Your server lost its copy of this workspace and may not have sent the latest changes of 52 runs. Check the records they changed.",
            target: { automation: PRESSED, run: "claim-050", path: "Tasks/automations.yaml" },
          }),
        ]),
      );
      const listed: string[] = [];
      let before: string | null = null;
      do {
        const page = await call(
          runsOf(before === null ? "" : `&before=${encodeURIComponent(before)}`),
        );
        expect(page.status).toBe(200);
        const body = page.body as { runs: Array<{ claimId: string }>; next: string | null };
        listed.push(...body.runs.map((run) => run.claimId));
        before = body.next;
      } while (before !== null);
      expect(listed).toEqual(["claim-1", ...[...lost].reverse(), "claim-waited"]);
    });

    // A failed dataset claim the relay keeps, as the copy's executor lists it.
    const failedClaim = (claimId: string, updatedAtMs: number): CollectionAutomationRun => ({
      claimId,
      state: "failed",
      error: "The record is locked.",
      createdAtMs: at(8),
      updatedAtMs,
      trigger: { kind: "changed", recordId: "record", by: "human", depth: 0, sharedAuthor: null },
      writes: [],
      definitionChanged: false,
      neverStarted: false,
      chainStopped: false,
      undoUnfinished: false,
      undone: false,
    });
    // The copy's executor lists these claims, and saved a run of those in `ran`.
    function keeps(fake: Fake, kept: CollectionAutomationRun[], ran: readonly string[] = []) {
      fake.executor.runs = async () => ({ runs: kept, next: null });
      fake.executor.listedRun = async (_automationId, claimId) =>
        kept.find((run) => run.claimId === claimId) ?? null;
      fake.executor.hasRun = async (_automationId, claimId) =>
        kept.some((run) => run.claimId === claimId);
      const saved = ran.map((claimId) => payRun(fake.options, claimId, 1).run);
      vi.spyOn(fake.options.store, "runsOf").mockImplementation(async (_automationId, claimId) => ({
        runs: saved.filter((run) => run.claimId === claimId),
        unreadable: false,
      }));
      return vi.spyOn(fake.executor, "retry");
    }

    it("shows a dataset claim this copy ran again since the loss as it ran, and tries again only that one", async () => {
      const { storage, call, start } = await copies();
      const changing = (claimId: string) =>
        storage.recordAutomationServerRunChanging({
          workspaceId: WORKSPACE,
          incarnation: 1,
          automationId: PRESSED,
          claimId,
          automationName: "Pay",
          collectionPath: "Tasks",
          startedAtMs: at(8),
          nowMs: at(8, 5),
        });
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

      const lostRun = {
        state: "failed",
        error: LOST_ERROR,
        updatedAtMs: at(8, 5),
        unsentChangesLost: true,
      };
      const listed = await call(runsOf());
      expect(listed).toMatchObject({
        status: 200,
        body: { runs: [kept[0], { claimId: "claim-kept", ...lostRun }], next: null },
      });
      expect((listed.body.runs as CollectionAutomationRun[])[0]!.unsentChangesLost).toBeUndefined();
      const read = await call(runsOf("&claimId=claim-again"));
      expect(read).toMatchObject({ status: 200, body: { run: kept[0] } });
      expect((read.body.run as CollectionAutomationRun).unsentChangesLost).toBeUndefined();
      expect(await call(runsOf("&claimId=claim-kept"))).toMatchObject({
        status: 200,
        body: { run: { claimId: "claim-kept", ...lostRun } },
      });

      expect(
        await call("retry", { automationId: PRESSED, claimId: "claim-kept", startOver: false }),
      ).toMatchObject({
        status: 200,
        body: {
          status: "refused",
          reason:
            "Your server lost this run's history with its copy of the workspace, so it will not run this again.",
        },
      });
      expect(retry).not.toHaveBeenCalled();
      expect(
        await call("retry", { automationId: PRESSED, claimId: "claim-again", startOver: false }),
      ).toMatchObject({ status: 200, body: { status: "queued" } });
      expect(retry).toHaveBeenCalledExactlyOnceWith({
        automationId: PRESSED,
        claimId: "claim-again",
        startOver: false,
      });
    });
  });

  it("opens no kept copy past the server's cap, and says so", async () => {
    clock = at(8);
    const { storage, h } = await relay();
    const ids = Array.from(
      { length: AUTOMATION_SERVER_MAX_WORKSPACES },
      (_, index) => `workspace-${index}`,
    );
    const datasetHost = {
      automations: { wantedWorkspaces: () => ids },
      observeAutomationClaims: () => () => undefined,
    } as unknown as RelayDatasetHost;
    storage.claimWorkspaceIdentity({
      workspaceId: WORKSPACE,
      replicationEpoch: "epoch-1",
      streamIdentity: "stream-1",
    });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
    const s = await server(storage, h, { datasetHost });
    await expect(
      s.run.runs.list({ workspaceId: WORKSPACE, ownerUserId: OWNER }, PRESSED),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: "Your server has as many workspaces open as it can. Try again later.",
    });
    expect(s.wanted()).toEqual(ids);
  });

  it("opens no kept copy for anyone but its owner, or for a workspace it never kept", async () => {
    const { storage, s, call } = await owned();
    // The copy was made for another owner, as before the workspace changed hands.
    inspectDatabase(storagePath(storage))
      .prepare("UPDATE sync_relay_automation_workspaces SET owner_user_id = 'someone-else'")
      .run();
    expect((await call(OWNER, `runs?automationId=${encodeURIComponent(PRESSED)}`)).status).toBe(
      404,
    );
    inspectDatabase(storagePath(storage))
      .prepare("DELETE FROM sync_relay_automation_workspaces")
      .run();
    expect(
      (await call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }))
        .status,
    ).toBe(404);
    expect(s.wanted()).toEqual([]);
  });

  it("undoes nothing when the copy cannot catch up with the relay", async () => {
    const { s, call } = await owned();
    const fake = await s.openReplica();
    s.sync.mockRejectedValue(new Error("The relay refused the pull."));
    expect(
      (await call(OWNER, "undo", { automationId: PRESSED, claimId: "claim-1", deletes: null }))
        .status,
    ).toBe(500);
    expect(
      (
        await call(OWNER, "restore", {
          definitions: [
            { collectionPath: "Budget", id: "pay", definitionHash: "0123456789abcdef" },
          ],
          again: false,
          retentionId: "restore-test",
        })
      ).status,
    ).toBe(500);
    expect(fake.asked).toEqual([]);
  });
});
