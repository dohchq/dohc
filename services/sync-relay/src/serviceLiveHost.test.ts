import { notifyRelayWrite } from "./relayWriteChanges.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as Y from "yjs";
import { openRelayDeployment } from "./relayDeployment.js";
import { openEmptyRelayTestDeployment } from "./testing/emptyRelayDeployment.js";
import {
  startServiceLiveHost,
  deleteConfiguredServiceWorkspaceRoots,
  type ServiceWorkspace,
} from "./serviceLiveHost.js";
import {
  EngineRequestDeadlineError,
  EngineRequestError,
} from "@dohc/workspace-engine-client/daemon";
import { errorResponse } from "./errors.js";
import { parseLogOp } from "./relayLogInputs.js";
import { createNamedFrameChanges } from "./liveHostChanges.js";
import { HeldReadBusyError } from "./liveHostRequests.js";
import { captureOwnerLiveFrameHost } from "./namedLiveFrameHost.js";
import type { LiveHostConnectionCoordinate } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import { readServiceActivationRetirement } from "./storage/serviceActivationRetirement.js";
import { type ServiceHostRetirementPreparation } from "./storage/serviceHostEnrollment.js";
import { preparedStop } from "./liveTickets.test-helper.js";
import { ServiceActivationStore } from "./storage/serviceActivation.js";
import { LiveCommittedDeliveryStore } from "./storage/liveCommittedDelivery.js";
import { initialAcceptedHistoryDigest } from "./liveAcceptedHistory.js";
import { nativeRestoreFence } from "./storage/liveRestoreOperation.js";
import { ServiceActivationDriver } from "./serviceActivationDriver.js";
import { ServiceHostedReplication } from "./serviceHostedReplication.js";
import { startSelfHostedLiveHost } from "./selfHostedLiveHost.js";
import { type ServiceKeptEdits } from "./storage/serviceKeptEdits.js";
import { liveEditors } from "./liveEditors.js";
import { createHeldDocumentRoutes } from "./heldDocumentRoutes.js";
import { OwnerCommittedDelivery } from "./ownerCommittedDelivery.js";
import type { NativeOwnerActivation } from "@dohc/workspace-engine-client/daemon";
import {
  markdownToYDoc,
  yDocToMarkdown,
} from "../../../packages/ydoc-projection/src/import-export.js";
import {
  createLiveMarkdownJournalValidator,
  createLiveMarkdownRegistrationValidator,
} from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import {
  hostedWindowCovers,
  releasedLineageBindingDigest,
  type HostedWindow,
  type ReleasedLineageBinding,
} from "@dohc/workspace-engine-client/relay-wire";
import bindingVectors from "../../../packages/workspace-engine-client/src/relay/releasedLineageBindingVectors.json" with { type: "json" };
import {
  ServiceActivationHistoryOverBudget,
  validateOrdinaryActivation,
} from "./storage/ordinaryActivationValidation.js";
import {
  readOrdinaryActivationHistory,
  ServiceActivationTooLarge,
  verifyOrdinaryActivationCut,
} from "./storage/ordinaryActivationSource.js";
import {
  CHECKPOINT_MOMENTS,
  checkpointPolicySha256,
  readOrdinaryCheckpoint,
} from "./storage/ordinaryActivationCheckpoint.js";
import {
  foldOrdinaryCheckpointPages,
  ORDINARY_FOLD_PAGE_ROWS,
  ORDINARY_FOLD_RUN_PAGES,
} from "./storage/ordinaryActivationFold.js";
import {
  nativeSettlementId,
  prepareHostedSettlements,
  settlementRecordDigest,
} from "./storage/hostedSettlement.js";
import { stableJsonStringify } from "./canonicalJson.js";
import { encodeNativeRestoreProposal } from "./liveRestoreProposal.js";
import { resolveLiveRestorePoint } from "../../../packages/ydoc-projection/src/liveRestorePoint.js";
import {
  policy as restorePolicy,
  restore as restoreValidation,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rm: vi.fn(original.rm) };
});
vi.mock("@dohc/workspace-engine-client/daemon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>()),
  createEngineClient: spawn,
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(rm).mockReset();
  for (const close of cleanup.splice(0).reverse()) await close();
  spawn.mockReset();
});

// `selfHosted` provisions the host ID the self-host supervisor provisions, so the supervisor can run this host.
async function fixture({ selfHosted = false, requestDeadlineMs = 1000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "service-host-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const deploymentConfig = join(root, "deployment.json");
  const deployment = openEmptyRelayTestDeployment({
    configPath: deploymentConfig,
    relayPath: join(root, "relay", "relay.sqlite"),
    continuityDirectory: join(root, "continuity"),
  });
  const hostId = selfHosted ? `self-host-${deployment.history.namespace}` : "service";
  deployment.storage.provisionLiveHostControl({
    mode: "service",
    hostId,
    updatedAtMs: 1,
    guard() {},
  });
  const config = {
    version: 1,
    engineExecutable: process.execPath,
    hostId,
    instanceId: "instance",
    workspaces: [{ root: workspace, workspaceId: "workspace", maxRegistrations: 8 }],
    ingress: {
      aggregateBytes: 200_000_000,
      applicationWorkingReserveBytes: 50_000_000,
      maxUploads: 2,
      uploadDeadlineMs: 1000,
    },
    client: {
      aggregateBytes: 200_000_000,
      maxUploads: 2,
      connectTimeoutMs: 1000,
      requestDeadlineMs,
    },
  };
  const configPath = join(root, "service.json");
  const save = () => writeFile(configPath, JSON.stringify(config));
  await save();
  let closed = false;
  const closeStorage = () => {
    if (!closed) {
      deployment.storage.close();
      closed = true;
    }
  };
  cleanup.push(async () => {
    closeStorage();
    await rm(root, { recursive: true, force: true });
  });
  const passEnds = new Set<() => void>();
  return {
    trustedAccount: (accountId: string) => ({ accountId, name: "Owner name" }),
    ...deployment,
    root,
    config,
    configPath,
    save,
    closeStorage,
    passEnds,
    onPass: () => {
      for (const listener of [...passEnds]) listener();
    },
  };
}
function afterPasses(f: { passEnds: Set<() => void> }, count = 1) {
  let ended = 0;
  return new Promise<void>((resolve) => {
    // The first pass to end may have begun before the call.
    const listener = () => {
      if (++ended > count) {
        f.passEnds.delete(listener);
        resolve();
      }
    };
    f.passEnds.add(listener);
  });
}
function seedRows(db: InstanceType<typeof DatabaseSync>, write: () => void) {
  db.exec("BEGIN");
  try {
    write();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
function clientFrom(options: { env: Record<string, string> }) {
  const nativePath = options.env.DOHC_ENGINE_LIVE_HOST_CONFIG!;
  const config = JSON.parse(readFileSync(nativePath, "utf8"));
  const client = {
    sendRequest: vi.fn(async (request?: { method: string }) =>
      request?.method === "sync.createHostedReplica"
        ? { result: { hosted: true } }
        : {
            result: {
              relayNamespace: config.relayNamespace,
              host: config.host,
              workspaces: config.workspaces.map((row: { workspaceId: string }) => ({
                workspaceId: row.workspaceId,
                workspaceHandle: "actual-open-handle",
              })),
            },
          },
    ),
    close: vi.fn(),
    waitForExit: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
  };
  return { client, config, nativePath };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const hostedPass = (overrides: Record<string, unknown> = {}) => ({
  fetched: 0,
  applied: 0,
  refused: 0,
  skipped: 0,
  conflictsOpened: 0,
  hasMore: false,
  pendingCursor: { kind: "hosted", token: "pending" },
  changedPaths: [],
  changedPathsOmitted: 0,
  refusals: [],
  refusalsOmitted: 0,
  sharingDeclined: [],
  sharingDeclinedOmitted: 0,
  held: [],
  heldThrough: null,
  newlyHeld: [],
  newlyHeldOmitted: 0,
  departed: [],
  departedThrough: null,
  ...overrides,
});
const hostedCommit = (overrides: Record<string, unknown> = {}) => ({
  committed: true,
  hasMore: false,
  retirement: null,
  departed: [],
  departedThrough: null,
  sharingDeclined: [],
  ...overrides,
});
const pushReply = {
  status: "complete",
  hasMore: false,
  pushed: 0,
  sharingDeclined: [],
  ownerAdmissionPending: [],
};

it("refuses forged engine discovery before opening relay admission", async () => {
  const f = await fixture();
  let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async (options) => {
    captured = clientFrom(options);
    captured.client.sendRequest.mockImplementation(async () => ({
      result: { relayNamespace: "foreign", host: captured.config.host, workspaces: [] },
    }));
    return captured.client;
  });
  await expect(startServiceLiveHost(f)).rejects.toThrow("identity mismatch");
  expect(captured.client.close).toHaveBeenCalledTimes(1);
  expect(existsSync(captured.nativePath)).toBe(false);
  expect(f.storage.getLiveHostControl()?.admissionState).toBe("closed");
});

it("closes the daemon immediately when storage loses continuity standing", async () => {
  const f = await fixture();
  let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async (options) => {
    captured = clientFrom(options);
    return captured.client;
  });
  const host = await startServiceLiveHost(f);
  f.closeStorage();
  expect(host.invalidated.aborted).toBe(true);
  expect(captured.client.close).toHaveBeenCalledTimes(1);
  await host.close();
  expect(existsSync(captured.nativePath)).toBe(false);
});

// Proves: an engine that ends by itself is logged with its exit code and signal, and the host stops with it.
it("logs an engine that exits by itself with its code and signal", async () => {
  const f = await fixture();
  let exit!: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawn.mockImplementation(async (options) => {
    exit = options.onExit;
    return clientFrom(options).client;
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = await startServiceLiveHost(f);
  try {
    exit(null, "SIGKILL");
    expect(host.invalidated.aborted).toBe(true);
    expect(log.mock.calls.filter(([message]) => String(message).startsWith("Live host"))).toEqual([
      ["Live host engine exited.", { code: null, signal: "SIGKILL" }],
    ]);
  } finally {
    await host.close();
    log.mockRestore();
  }
});

// Proves: an engine the relay stops after a missed request deadline is logged as stopped by the relay, and its exit
// that follows as one the relay caused.
it("logs an engine the relay stops for a missed deadline, then its exit", async () => {
  const f = await fixture();
  let captured!: ReturnType<typeof clientFrom>,
    exit!: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawn.mockImplementation(async (options) => {
    captured = clientFrom(options);
    exit = options.onExit;
    captured.client.sendRequest.mockRejectedValue(
      new EngineRequestDeadlineError(1, "liveApplication.hosts", 50),
    );
    return captured.client;
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      startServiceLiveHost({ ...f, frameChanges: createNamedFrameChanges(16) }),
    ).rejects.toBeInstanceOf(EngineRequestDeadlineError);
    expect(captured.client.close).toHaveBeenCalled();
    exit(0, null);
    expect(log.mock.calls.filter(([message]) => String(message).startsWith("Live host"))).toEqual([
      [
        "Live host stopped an engine that did not answer in time.",
        { method: "liveApplication.hosts", deadlineMs: 50 },
      ],
      ["Live host engine exited after the relay stopped it.", { code: 0, signal: null }],
    ]);
  } finally {
    log.mockRestore();
  }
});

async function configureActivation(f: Awaited<ReturnType<typeof fixture>>, limits = {}) {
  Object.assign(f.config.workspaces[0]!, {
    hostedReplication: {
      relay: { baseUrl: "https://relay.example", bearerToken: "service-token" },
      identity: { replicationEpoch: "epoch", streamIdentity: "stream" },
      maxPagesPerPull: 1,
    },
  });
  Object.assign(f.config, {
    adoption: {
      maxBytes: 1_000_000,
      maxEvents: 10,
      ownerOutbox: { maxPendingBytes: 1_000_000, maxPendingAgeMs: 60_000 },
    },
    settlement: { maxApplicationsPerSettlement: 8 },
    sync: {
      policy: {
        maxReadBytes: 1_000_000,
        maxOutputBytes: 1_000_000,
        maxClientVectorBytes: 1000,
        maxHostVectorBytes: 1000,
      },
      workingReserveBytes: 1_000_000,
    },
    activation: {
      targets: [{ workspaceId: "workspace", path: "file.md" }],
      maxCaptureBytes: 1_000_000,
      maxActivationHistoryEntries: 10,
      maxEntriesPerDrain: 10,
      maxBytesPerDrain: 1_000_000,
      maxDocumentsPerPass: 1,
      pollIntervalMs: 60_000,
      idlePollIntervalMs: 1,
      passDeadlineMs: 1000,
      idleUnloadMs: 600_000,
      idleRetryMs: 30_000,
      validation: {
        maxStructVisits: 1000,
        maxValueNodeVisits: 1000,
        maxDecodedPayloadByteVisits: 1000,
        maxStructClientGroupVisits: 1000,
        maxDeleteClientGroupVisits: 1000,
        maxDeleteIntervalVisits: 1000,
        maxIndexOperations: 1000,
      },
      ...limits,
    },
  });
  await f.save();
}

it("joins deadline-expired activation work before removing the native directory", async () => {
  const f = await fixture(),
    entered = deferred<AbortSignal>();
  const settled = deferred<Awaited<ReturnType<ServiceActivationDriver["activate"]>>>();
  await configureActivation(f, { passDeadlineMs: 10 });
  let captured!: ReturnType<typeof clientFrom>;
  const order: string[] = [];
  spawn.mockImplementation(async (options) => {
    captured = clientFrom(options);
    captured.client.waitForExit.mockImplementation(async () => {
      order.push("exit");
    });
    return captured.client;
  });
  const activate = vi
    .spyOn(ServiceActivationDriver.prototype, "activate")
    .mockImplementation((_target, signal) => {
      entered.resolve(signal);
      return settled.promise.then((result) => {
        order.push("settled");
        return result;
      });
    });
  const host = await startServiceLiveHost(f),
    signal = await entered.promise;
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const closed = vi.fn(),
    closes = [host.close().then(closed), host.close().then(closed)];
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal.aborted).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(captured.client.close).toHaveBeenCalledTimes(1);
    expect(captured.client.waitForExit).not.toHaveBeenCalled();
    expect(existsSync(captured.nativePath)).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
  } finally {
    settled.resolve({ kind: "pending", reason: "finished" });
    await Promise.all(closes);
    activate.mockRestore();
  }
  expect(closed).toHaveBeenCalledTimes(2);
  expect(captured.client.waitForExit).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["settled", "exit"]);
  expect(existsSync(captured.nativePath)).toBe(false);
});

it("logs a pass over a second at most once a minute, with cut ids, timings and fixed words only", async () => {
  const f = await fixture();
  await configureActivation(f, { pollIntervalMs: 100 });
  spawn.mockImplementation(async (options) => clientFrom(options).client);
  let clock = 0;
  const document = {
    workspaceId: "workspace",
    mainVersionId: "main",
    objectId: "object-with-a-longer-id",
    lineageClaimId: "a".repeat(64),
  };
  let settlesSent = 0,
    failSettle = false;
  const consumer = {
    get settlesSent() {
      return settlesSent;
    },
    async settle() {
      settlesSent++;
      if (failSettle) throw new Error("Engine settle failed.");
      return { settlementId: null, previousCursor: 0, terminalCursor: 0, materialized: true };
    },
  };
  // Each activation takes a second and a half, and its settlement goes to the engine.
  const activate = vi
    .spyOn(ServiceActivationDriver.prototype, "activate")
    .mockImplementation(async (_target, signal, settle) => {
      clock += 1500;
      await settle?.(consumer as never, document, signal);
      return { kind: "pending", reason: "Waiting for its restore to finish." };
    });
  const pull = vi
    .spyOn(ServiceHostedReplication.prototype, "pull")
    .mockResolvedValue({ hasMore: false, pages: [] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  const host = await startServiceLiveHost({ ...f, nowMs: () => clock });
  try {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    // The third pass's settlement reaches the engine and then fails.
    clock += 60_000;
    failSettle = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(activate).toHaveBeenCalledTimes(3);
    const slow = log.mock.calls.filter(([message]) => message === "Live host pass was slow.");
    // The second pass falls inside the first one's minute.
    expect(slow).toHaveLength(2);
    const workspaces = [{ workspace: "workspac", pullMs: 0, pulls: { unready: 1 } }];
    expect(slow[0]![1]).toMatchObject({
      passMs: 1500,
      workspaces,
      targets: [
        { object: "object-w", ms: 1500, outcome: "pending", settle: "sent", materialized: true },
      ],
    });
    expect(slow[1]![1]).toMatchObject({
      passMs: 1500,
      workspaces,
      targets: [
        { object: "object-w", ms: 1500, outcome: "error", settle: "sent", materialized: null },
      ],
    });
    const shown = JSON.stringify(slow);
    for (const hidden of [
      "file.md",
      "object-with",
      "Waiting for its restore",
      "Engine settle failed",
    ])
      expect(shown).not.toContain(hidden);
  } finally {
    await host.close();
    vi.useRealTimers();
    log.mockRestore();
    activate.mockRestore();
    pull.mockRestore();
  }
});

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
type DrainLimits = { maxEntriesPerDrain?: number; maxBytesPerDrain?: number };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type IdleClock = { nowMs: () => number; schedule: (atMs: number, fire: () => void) => () => void };

// A service owner whose activation completed under an earlier connection, as
// after a restart. The started host resumes it from real relay storage; only
// the engine is mocked. `park` holds the next engine request for one method.
// `maxApplications` is the settlement bound, which pages a retirement's applications. `limits` are the drain budgets.
// `pollIntervalMs` replaces the pause between passes, and `idleClock` the clock idle unloading reads and arms.
// `paced` puts the pauses on its manual clock, with its poll and idle intervals.
async function completedServiceOwner(
  options: {
    empty?: boolean;
    frameChanges?: boolean;
    maxDocumentsPerPass?: number;
    polling?: boolean;
    adopted?: boolean;
    maxApplications?: number;
    limits?: DrainLimits;
    pollIntervalMs?: number;
    selfHosted?: boolean;
    restore?: boolean;
    idleClock?: IdleClock;
    paced?: Paced;
    nowMs?: () => number;
    requestDeadlineMs?: number;
  } = {},
) {
  const adopted = options.adopted ?? true;
  const f = await fixture({
      selfHosted: options.selfHosted,
      ...(options.requestDeadlineMs ? { requestDeadlineMs: options.requestDeadlineMs } : {}),
    }),
    raw = new DatabaseSync(join(f.root, "relay", "relay.sqlite"));
  cleanup.push(async () => raw.close());
  const policy = {
    maxStructVisits: 1_000_000,
    maxValueNodeVisits: 5_000_000,
    maxDecodedPayloadByteVisits: 100_000_000,
    maxStructClientGroupVisits: 1_000_000,
    maxDeleteClientGroupVisits: 1_000_000,
    maxDeleteIntervalVisits: 1_000_000,
    maxIndexOperations: 10_000_000,
  };
  const validateBaseline = createLiveMarkdownRegistrationValidator(policy),
    validateJournal = createLiveMarkdownJournalValidator(policy);
  const doc = markdownToYDoc("Original"),
    baselineBytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.getMap("frontmatter").set("title", "Edited");
  const fullState = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  const document = {
    workspaceId: "workspace",
    mainVersionId: "main" as const,
    objectId: "object",
    lineageClaimId: sha256(baselineBytes),
  };
  const validated = validateJournal({
    document,
    currentPath: "docs/a.md",
    checkpoint: baselineBytes,
    suffix: [],
    candidate: fullState,
  });
  const base = validateBaseline({ document, currentPath: "docs/a.md", checkpoint: baselineBytes });
  if (validated.kind !== "accepted" || base.kind !== "accepted")
    throw new Error("Invalid owner fixture.");
  const capture: NativeOwnerActivation = {
    activationId: `ordinary-activation-${"a".repeat(64)}`,
    sessionId: "native-session",
    baselineBytes,
    fullState,
    source: {
      version: 1,
      relayDatabaseNamespace: f.history.namespace,
      ...document,
      currentPath: "docs/a.md",
      replicationEpoch: "epoch",
      streamIdentity: "stream",
      committedCursor: 3,
      baseOriginId: "origin",
      baseOriginSeq: 1,
      baseRelaySeq: 2,
      sourceMomentId: `moment-ydoc-apply-${sha256(Buffer.from(["workspace", "main", "object", "docs/a.md", "origin", "2"].join("\0")))}`,
      sourceDigest: validated.evidence.projectedMarkdownSha256,
      sourceByteLength: validated.evidence.projectedMarkdownByteLength,
      nativeHeadSequence: 2,
      fullStateDigest: sha256(fullState),
      fullStateByteLength: fullState.length,
    },
  };
  seedRows(raw, () => {
    raw.exec(
      "INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES ('workspace','owner',0,'epoch','stream')",
    );
    const log = raw.prepare(
      "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',?,?,?,?)",
    );
    log.run(
      0,
      "moment.append",
      JSON.stringify({
        versionId: "main",
        objectId: "object",
        momentId: "original-moment",
        path: "docs/a.md",
        operation: "write",
        payloadAfterPath: "docs/a.md",
        payloadAfterContentKind: "text",
        payloadAfterBlobSha256: base.evidence.projectedMarkdownSha256,
        payloadAfterByteLength: base.evidence.projectedMarkdownByteLength,
      }),
      0,
    );
    log.run(
      1,
      "ydoc.update",
      JSON.stringify({
        versionId: "main",
        objectId: "object",
        path: "docs/a.md",
        contentKind: "richdoc",
        isBaseState: true,
        lineageClaimId: document.lineageClaimId,
        updateBlobSha256: document.lineageClaimId,
      }),
      1,
    );
    log.run(
      2,
      "ydoc.update",
      JSON.stringify({
        versionId: "main",
        objectId: "object",
        path: "docs/a.md",
        contentKind: "richdoc",
        isBaseState: false,
        lineageClaimId: document.lineageClaimId,
        updateBlobSha256: sha256(fullState),
      }),
      2,
    );
    const blob = raw.prepare(
      "INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)",
    );
    blob.run(document.lineageClaimId, baselineBytes.length, baselineBytes);
    blob.run(sha256(fullState), fullState.length, fullState);
    raw
      .prepare(
        "INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace','object',1,'original-moment','main','docs/a.md',?,'text',?,0)",
      )
      .run(base.evidence.projectedMarkdownSha256, base.evidence.projectedMarkdownByteLength);
    raw
      .prepare(
        "INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share','workspace','owner',?,0)",
      )
      .run(JSON.stringify({ paths: ["docs"], versionId: null }));
    raw.exec(
      "INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('grant','share','user','reader',NULL,'edit',1,'active',0,NULL,NULL)",
    );
  });

  // Complete the activation under the earlier connection: adoption, seed, native application. Without `adopted` it is only prepared.
  const earlier = {
    mode: "service" as const,
    hostId: f.config.hostId,
    hostEpoch: f.storage.getLiveHostControl()!.hostEpoch,
    instanceId: "instance",
    connectionId: "earlier",
  };
  const actor = { kind: "owner" as const, userId: "owner" },
    store = f.storage.createServiceActivationStore(f.history);
  await store.prepare({
    capture,
    host: earlier,
    registeredAtMs: 3,
    guard() {},
    validate: async (work) => validateOrdinaryActivation(work, policy),
    bounds: { maxCaptureBytes: 1_000_000, maxHistoryEntries: 10, maxBytesPerDrain: 1_000_000 },
  });
  const access = store.pending(document, earlier),
    delivery = f.storage.createLiveCommittedDeliveryStore(f.history, access);
  if (adopted) {
    const adoption = delivery.captureOwnerCut({
      host: earlier,
      document,
      actor,
      adoptionId: capture.activationId,
      expectedLocalSequence: 2,
      maxBytes: 1_000_000,
      maxEvents: 100,
      throughCursor: 0,
    });
    delivery.acknowledgeOwnerAdoption(adoption, {
      adoptionId: capture.activationId,
      localYDocSequence: 2,
      terminalCursor: 0,
      adoptionReplayed: false,
    });
    const current = f.storage.resolveCurrentLiveDocumentBinding({ document, actor }, access),
      cut = f.storage.readLiveUpdateJournalCut({ document });
    if (current.kind !== "current" || cut.kind !== "cut")
      throw new Error("Missing activation authority.");
    const seed = validateJournal({
      document,
      currentPath: current.binding.currentPath,
      checkpoint: cut.cut.checkpoint.bytes,
      suffix: cut.cut.suffix.map((row) => row.bytes),
      candidate: fullState,
    });
    f.storage.commitLiveUpdateJournal(
      {
        host: earlier,
        actor,
        expectedAuthority: current.authority,
        metadata: { deliveryId: "seed", updateDigest: sha256(fullState), binding: current.binding },
        cutToken: cut.cut,
        validation: seed,
        updateBytes: fullState,
        receivedAtMs: 4,
      },
      access,
    );
    const owner = delivery.openOwnerDelivery({ host: earlier, document, actor }),
      event = delivery.nextOwnerApplication(owner)!;
    delivery.acknowledgeOwnerDeliveryApplication(owner, {
      ...event.metadata.accepted.receipt,
      localYDocSequence: 2,
      applicationReplayed: false,
    });
    store.complete({
      document,
      host: earlier,
      access,
      nativeState: { adoptionId: capture.activationId, pendingBytes: 0 },
      guard() {},
    });
  }

  const target = { workspaceId: "workspace", path: "docs/a.md" };
  // An empty host activates documents it gains on its next pass. It and a polling host pass every 20 ms.
  await configureActivation(f, {
    targets: options.empty ? [] : [target],
    passDeadlineMs: 10_000,
    validation: policy,
    ...(options.pollIntervalMs
      ? { pollIntervalMs: options.pollIntervalMs }
      : options.empty || options.polling
        ? { pollIntervalMs: 20 }
        : {}),
    ...(options.paced
      ? { pollIntervalMs: options.paced.poll, idlePollIntervalMs: options.paced.ceiling }
      : {}),
    ...(options.maxDocumentsPerPass ? { maxDocumentsPerPass: options.maxDocumentsPerPass } : {}),
    ...options.limits,
  });
  const workspace = f.config.workspaces[0]! as ServiceWorkspace;
  if (options.maxApplications)
    Object.assign(f.config, {
      settlement: { maxApplicationsPerSettlement: options.maxApplications },
    });
  if (options.restore) Object.assign(f.config, { restore: RESTORE });
  if (options.empty) f.config.workspaces = [];
  await f.save();

  let parked:
    | {
        method: string;
        entered: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const requestListeners = new Set<(method: string) => void>();
  // Queued unload replies, or errors that lose them. `replies` overrides every hosted pass, commit and push until a test changes it.
  // With `heldPerPass` and `departedPerPass`, a pass and its commit list at most that many, as when the rest do not fit.
  // `loseCommit` loses the next commit's reply after the commit stood.
  const pushed = deferred<void>(),
    unloads: unknown[] = [];
  // `diverge` refuses each pull as diverged. `create` fails each create, as diverged when a relay is ahead at the replica's origin.
  const replies: {
    pass: Record<string, unknown>;
    commit: Record<string, unknown>;
    push: Record<string, unknown>;
    diverge?: boolean;
    heldPerPass?: number;
    departedPerPass?: number;
    loseCommit?: boolean;
    create?: "diverged" | Error;
  } = { pass: {}, commit: {}, push: {} };
  const divergence = (id: number) =>
    new EngineRequestError(id, {
      code: "INVALID_PARAMS",
      message: "relay-origin-diverged",
      retry: "no",
    } as never);
  // As the engine does, a list names the documents after where the pull asked, and says where it stops if cut.
  let departedAfter: string | undefined;
  const page = (ids: readonly string[], after: string | undefined, limit: number | undefined) => {
    const rest = ids.filter((id) => after === undefined || id > after),
      listed = rest.slice(0, limit ?? rest.length);
    return { listed, through: listed.length < rest.length ? listed.at(-1)! : null };
  };
  // What the engine applied of each accepted row, by delivery ID. `lost` loses each application's
  // reply and every ACK read after it, as when the engine applied a row the relay never recorded.
  // While `pending` is set, the engine answers each application pending and applies nothing.
  const applied = new Map<string, Record<string, unknown>>(),
    lost = { replies: false, pending: false };
  // Applied rows no settlement reached the file with yet. They keep the document's unload pending.
  const unsettled = new Set<string>();
  // Once set, each registration gets a new ID and retires the one before it, as the engine does.
  let registrations: { next: number; live: number } | undefined,
    registrationRefusal: Error | undefined;
  let registrationsByObject: Map<string, number> | undefined;
  const retired = (id: unknown) => registrations !== undefined && id !== registrations.live;
  const unavailable = (id: number) =>
    new EngineRequestError(id, {
      code: "INVALID_PARAMS",
      message: "live-registration-unavailable",
      retry: "no",
    } as never);
  // Whether the engine's settlement reaches the file. Until it does, the same terminal settles again.
  const settlement = { materialized: true };
  // The engine's side of a retirement. Reconciliation first asks the journal for each delivery in `unproven`, and
  // records each answer in `journals`. It then reports the adoption, if the activation adopted, and a page of what
  // it applied after the relay's tip, in journal order, and asks to settle until a retirement settled through all
  // of it. `refusal` refuses it. Release keeps its first boundary. An adopted activation releases only once its
  // document parked, which a commit listing it departed or settled output still `unpushed` prevents, and then only
  // once it settled through what it applied, unless `releasePending` names another reason. Native capture returns
  // `capture`, as a test sets for a successor, which adopts at its predecessor's boundary; `adoption` is what the
  // engine last adopted. `generation` is the restore generation the document's application binding has, once a
  // restore moved it past its queues'. `prepared` is the activation whose local appends a Stop's preparation blocks,
  // until its release, its retirement's reconciliation, or the end of the connection; `releaseFailure` fails each release.
  const engine: {
    refusal?: Error;
    boundary?: unknown;
    settledThrough?: number;
    reconciledThrough?: number;
    unproven: string[];
    journals: unknown[];
    unpushed: number;
    releasePending?: string;
    capture: NativeOwnerActivation;
    adoption: { activationId: string; throughCursor: number | null };
    generation?: number;
    fenceCommitted?: boolean;
    abandonableSeed?: boolean;
    prepared?: Record<string, unknown>;
    prepareFailure?: Error;
    releaseFailure?: Error;
  } = {
    capture,
    unproven: [],
    journals: [],
    unpushed: 0,
    adoption: { activationId: capture.activationId, throughCursor: adopted ? 0 : null },
  };
  // The activation's own native queue, which delivery reads through its owner state once `outboxId` names it. Its entries
  // wait in order. A refused head quarantines it until a Try again names that head in `retryDeliveryId`, and acknowledging
  // that head resumes it. The engine never receives an acknowledgement of an entry `loseAcks` names, so the entry stays
  // queued, as when the relay accepted it and its receipt never reached the engine.
  type NativeEntry = { sequence: number; deliveryId: string; update: Buffer };
  const NATIVE = "native-outbox";
  const native: {
    outboxId: string | null;
    binding?: unknown;
    entries: NativeEntry[];
    nextSequence: number;
    state: "active" | "quarantined";
    retryDeliveryId: string | null;
    loseAcks: Set<string>;
  } = {
    outboxId: null,
    entries: [],
    nextSequence: 1,
    state: "active",
    retryDeliveryId: null,
    loseAcks: new Set(),
  };
  const nativeBytes = () => native.entries.reduce((sum, entry) => sum + entry.update.length, 0);
  // One page of the native queue's snapshot, as the engine reads it: each part whole, entries in order after the header.
  const nativePage = (params: Record<string, unknown>) => {
    const header = {
      outboxId: NATIVE,
      binding: native.binding,
      baseUpdateDigest: document.lineageClaimId,
      baseByteLength: 1,
      state: native.state,
      pendingBytes: nativeBytes(),
      pendingEntryCount: native.entries.length,
      nextSequence: native.nextSequence,
      oldestEntryAtMs: native.entries.length ? 1 : null,
      quarantineReason: native.state === "quarantined" ? "invalid-update" : null,
      observedBinding: null,
      retryDeliveryId: native.retryDeliveryId,
    };
    const snapshot = sha256(Buffer.from(JSON.stringify(header))),
      cursor = (part: string, sequence = 0) => ({ snapshot, part, sequence, offset: 0 });
    const requested = (params.cursor as ReturnType<typeof cursor> | undefined) ?? cursor("header");
    if (requested.snapshot !== snapshot) return { kind: "readChanged" };
    const first = native.entries[0],
      at = native.entries.findIndex((entry) => entry.sequence === requested.sequence);
    const entry = native.entries[at],
      following = native.entries[at + 1];
    const live = {
      firstEntryCursor: first ? cursor("entryHeader", first.sequence) : null,
      frozenAtRefusedSeed: false,
      checkpointDigest: null,
      recoveryCheckpointDigest: null,
    };
    if (requested.part !== "header" && requested.part !== "base" && !entry)
      return { kind: "readChanged" };
    const [bytes, nextCursor] =
      requested.part === "header"
        ? ([Buffer.from(JSON.stringify({ ...header, ...live })), cursor("base")] as const)
        : requested.part === "base"
          ? ([Buffer.from([1]), live.firstEntryCursor] as const)
          : requested.part === "entryHeader"
            ? ([
                Buffer.from(
                  JSON.stringify({
                    sequence: entry!.sequence,
                    appendKey: `append-${entry!.deliveryId}`,
                    deliveryId: entry!.deliveryId,
                    updateDigest: sha256(entry!.update),
                    byteLength: entry!.update.length,
                    createdAtMs: 1,
                  }),
                ),
                cursor("update", entry!.sequence),
              ] as const)
            : ([
                entry!.update,
                following ? cursor("entryHeader", following.sequence) : null,
              ] as const);
    return {
      kind: "page",
      ...requested,
      totalBytes: bytes.length,
      digest: sha256(bytes),
      bytesBase64: bytes.toString("base64"),
      nextCursor,
    };
  };
  // The bytes delivery reads for the queue's head now: its header, entry header and update pages.
  const nativeHeadBytes = () => {
    let read = 0,
      cursor: unknown;
    for (let page = 0; page < 3; page++) {
      const answer = nativePage(cursor === undefined ? {} : { cursor }) as {
        bytesBase64: string;
        nextCursor: { part: string } | null;
      };
      read += answer.bytesBase64.length;
      // Delivery skips the base part.
      cursor =
        page === 0
          ? { ...answer.nextCursor, part: "entryHeader", sequence: native.entries[0]!.sequence }
          : answer.nextCursor;
    }
    return read;
  };
  const ownerBoundary = () => {
    const tip = JSON.parse(
      String(
        raw
          .prepare(
            "SELECT tip_receipt_json FROM sync_relay_live_delivery_owners WHERE object_id='object'",
          )
          .get()!.tip_receipt_json,
      ),
    );
    if (!tip)
      return {
        terminalReceipt: null,
        eventCount: 0,
        historyEvidenceDigest: initialAcceptedHistoryDigest(f.history.namespace, document),
      };
    const endpoint = raw
      .prepare(
        "SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE object_id='object' AND journal_cursor=?",
      )
      .get(tip.journalCursor)!;
    return {
      terminalReceipt: tip,
      eventCount: endpoint.accepted_event_count,
      historyEvidenceDigest: endpoint.accepted_evidence_digest,
    };
  };
  const membership: { method: string; workspace?: string; params: unknown }[] = [];
  // A refused queue the engine keeps, with one entry, as the host's own connection reads it.
  // A granted Try again keeps the document's unload pending, as the engine does.
  // Its head's append key tells an adoption seed from later work. Other queues the test adds keep their own state; the engine
  // answers one it no longer holds as not found. `checkpoint` is the accepted state a recovery copy reads.
  // A drained one holds no pending entry, as once the engine abandoned its seed.
  type KeptOutbox = {
    binding: unknown;
    state: string;
    retryDeliveryId: string | null;
    appendKey: string;
    checkpoint?: Buffer;
    drained?: boolean;
  };
  const keptOutbox: KeptOutbox = {
    binding: undefined,
    state: "quarantined",
    retryDeliveryId: null,
    appendKey: "append-1",
  };
  const keptOutboxes = new Map<string, KeptOutbox | null>();
  const outboxOf = (request: { id: number; params: Record<string, unknown> }) => {
    const found = keptOutboxes.get(String(request.params.outboxId));
    if (found === null)
      throw new EngineRequestError(request.id, {
        code: "INVALID_PARAMS",
        message: "owner-outbox-not-found",
        retry: "no",
      } as never);
    return found ?? keptOutbox;
  };
  // A queue holding its owner's refused adoption seed at the document's current restore generation, which no settlement passes.
  const seeded = (queue: KeptOutbox | null | undefined): queue is KeptOutbox =>
    queue?.binding !== undefined &&
    queue.state === "quarantined" &&
    queue.appendKey.startsWith("owner-adoption:") &&
    (engine.generation === undefined ||
      engine.generation ===
        (queue.binding as { restoreFenceGeneration: number }).restoreFenceGeneration);
  // Earlier stores open read-only for recovery, by workspace, at most one each as the engine allows.
  // Each serves its own queue, whose head's append key names its root.
  // A closing store reads nothing and keeps its workspace from opening another, as the engine's.
  const recoveryStores = new Map<string, { root: string; handle: string; closing?: boolean }>();
  let recoveryOpens = 0;
  // `loseOpen` loses the next open's answer after the engine opened the store; `failOpen` fails the next open before it opens;
  // `failClose` fails the next close before it closes; `preparing` answers that many recovery reads with `preparing`;
  // `failRead` fails the next recovery read, and `failCurrentRead` the next read of an attached store; while `worker`
  // is pending, the first close of a store times out and leaves it closing, and a later one waits for it.
  const recoveryFaults: {
    loseOpen?: boolean;
    failOpen?: Error;
    failClose?: Error;
    preparing?: number;
    failRead?: Error;
    failCurrentRead?: Error;
    worker?: Promise<void>;
  } = {};
  const keptPage = (
    request: { id: number; params: Record<string, unknown> },
    queue = outboxOf(request),
  ) => {
    const { params } = request;
    const header = {
        outboxId: params.outboxId,
        binding: queue.binding,
        baseUpdateDigest: (queue.binding as { lineageClaimId: string }).lineageClaimId,
        baseByteLength: 1,
        state: queue.state,
        pendingBytes: queue.drained ? 0 : 1,
        pendingEntryCount: queue.drained ? 0 : 1,
        nextSequence: 2,
        oldestEntryAtMs: 1,
        quarantineReason: "invalid-update",
        observedBinding: null,
        retryDeliveryId: queue.retryDeliveryId,
      },
      update = Buffer.from([7]);
    const snapshot = sha256(Buffer.from(JSON.stringify(header))),
      cursor = (part: string, sequence = 0) => ({ snapshot, part, sequence, offset: 0 });
    const requested = (params.cursor as ReturnType<typeof cursor> | undefined) ?? cursor("header");
    if (requested.snapshot !== snapshot) return { kind: "readChanged" };
    // Outside the snapshot, as the engine's: the frozen answer and the checkpoint a copy reads now, which
    // a copy of a queue holding a refused seed, at any restore generation, must hold.
    const checkpointDigest = queue.checkpoint ? sha256(queue.checkpoint) : null;
    const refusedSeed =
      queue.state === "quarantined" &&
      queue.appendKey.startsWith("owner-adoption:") &&
      queue.retryDeliveryId === null;
    const live = {
      firstEntryCursor: queue.drained ? null : cursor("entryHeader", 1),
      frozenAtRefusedSeed: seeded(queue) && queue.retryDeliveryId === null,
      checkpointDigest,
      recoveryCheckpointDigest: refusedSeed ? checkpointDigest : null,
    };
    if (requested.part === "checkpoint" && !queue.checkpoint) return { kind: "readChanged" };
    const [bytes, nextCursor] =
      requested.part === "header"
        ? ([Buffer.from(JSON.stringify({ ...header, ...live })), cursor("base")] as const)
        : requested.part === "checkpoint"
          ? ([queue.checkpoint!, null] as const)
          : requested.part === "entryHeader"
            ? ([
                Buffer.from(
                  JSON.stringify({
                    sequence: 1,
                    appendKey: queue.appendKey,
                    deliveryId: "refused",
                    updateDigest: sha256(update),
                    byteLength: 1,
                    createdAtMs: 1,
                  }),
                ),
                cursor("update", 1),
              ] as const)
            : ([update, null] as const);
    return {
      kind: "page",
      ...requested,
      totalBytes: bytes.length,
      digest: sha256(bytes),
      bytesBase64: bytes.toString("base64"),
      nextCursor,
    };
  };
  // As the engine refuses to settle past a seed frozen at the current generation.
  const seedFrozen = () => [keptOutbox, ...keptOutboxes.values()].some(seeded);
  let ownerRequests = 0,
    client!: ReturnType<typeof clientFrom>["client"] & {
      captureOwnerActivation: ReturnType<typeof vi.fn>;
      sendLiveApplication: ReturnType<typeof vi.fn>;
      readLiveApplicationAck: ReturnType<typeof vi.fn>;
      sendLiveOwnerAdoption: ReturnType<typeof vi.fn>;
    };
  // The engine's reason for refusing native capture, as for a document with an open sync conflict, and its reasons for single paths.
  let refusal: Error | undefined, detachFailure: Error | undefined;
  const refusals = new Map<string, Error>();
  // Completed activations of other documents, by activation ID. Capture resumes one when named, and the owner
  // state of a registration for one reports its own adoption, with no native queue.
  const otherActivations = new Map<string, NativeOwnerActivation>();
  const registeredActivations = new Map<number, unknown>();
  spawn.mockImplementation(async (options) => {
    const captured = clientFrom(options),
      discovery = captured.client.sendRequest.getMockImplementation()!;
    client = Object.assign(captured.client, {
      captureOwnerActivation: vi.fn(
        async (
          _request: unknown,
          path: string,
          _maxBytes?: number,
          _signal?: AbortSignal,
          activationId?: string,
        ) => {
          const refused = refusals.get(path) ?? refusal;
          if (refused) throw refused;
          const captured =
            (activationId === undefined ? undefined : otherActivations.get(activationId)) ??
            engine.capture;
          // A fresh capture has imported the current relay head; a resumed one keeps its saved source.
          if (activationId !== undefined) return captured;
          const committedCursor = Number(
            raw
              .prepare(
                "SELECT COALESCE(MAX(relay_seq),0) AS cursor FROM sync_relay_log WHERE workspace_id=?",
              )
              .get(captured.source.workspaceId)!.cursor,
          );
          return { ...captured, source: { ...captured.source, committedCursor } };
        },
      ),
      sendLiveOwnerAdoption: vi.fn(
        async (
          input: { id: number },
          cut: { adoptionId: string; terminalReceipt: { journalCursor: number } | null },
        ) => {
          const terminalCursor = cut.terminalReceipt?.journalCursor ?? 0;
          engine.adoption = { activationId: cut.adoptionId, throughCursor: terminalCursor };
          return {
            id: input.id,
            result: {
              status: "adopted",
              adoption: {
                adoptionId: cut.adoptionId,
                localYDocSequence: 2,
                terminalCursor,
                adoptionReplayed: false,
              },
            },
          };
        },
      ),
      sendLiveApplication: vi.fn(
        async (
          input: { id: number; registrationId: number },
          event: {
            metadata: { accepted: { receipt: { deliveryId: string; journalCursor: number } } };
          },
        ) => {
          if (retired(input.registrationId)) throw unavailable(input.id);
          const receipt = event.metadata.accepted.receipt;
          if (lost.pending)
            return { id: input.id, result: { status: "pending", reason: "application-pending" } };
          applied.set(receipt.deliveryId, {
            ...receipt,
            localYDocSequence: receipt.journalCursor + 1,
          });
          unsettled.add(receipt.deliveryId);
          if (lost.replies) throw new Error("Application reply lost.");
          return {
            id: input.id,
            result: {
              status: "applied",
              ack: { ...applied.get(receipt.deliveryId), applicationReplayed: false },
            },
          };
        },
      ),
      readLiveApplicationAck: vi.fn(
        async (input: { id: number; registrationId: number }, identity: { deliveryId: string }) => {
          if (retired(input.registrationId)) throw unavailable(input.id);
          if (lost.replies) throw new Error("ACK read lost.");
          const ack = applied.get(identity.deliveryId);
          return ack ? { ...ack, applicationReplayed: true } : null;
        },
      ),
    });
    client.sendRequest.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as {
          id: number;
          method: string;
          workspace?: string;
          params: Record<string, unknown>;
        },
        held = parked;
      for (const listener of [...requestListeners]) listener(request.method);
      if (request.method.startsWith("liveApplication.")) ownerRequests++;
      if (held?.method === request.method) {
        parked = undefined;
        held.entered.resolve();
        await held.release.promise;
      }
      const reply = (result: unknown) => ({ id: request.id, result }) as never;
      if (
        request.method !== "liveApplication.register" &&
        retired(request.params?.registrationId ?? registrations?.live)
      )
        throw unavailable(request.id);
      if (/^liveApplication\.(attach|detach|unload)/.test(request.method))
        membership.push({
          method: request.method,
          workspace: request.workspace,
          params: request.params,
        });
      switch (request.method) {
        case "liveApplication.hosts":
          return discovery();
        case "liveApplication.releaseOwnerActivation":
          return reply({ released: true });
        case "liveApplication.attachWorkspace":
          return reply({
            workspaceId: request.params.workspaceId,
            workspaceHandle:
              request.params.workspaceId === "workspace"
                ? "attached-handle"
                : `attached-${request.params.workspaceId}`,
          });
        case "liveApplication.detachWorkspace":
          if (detachFailure) throw detachFailure;
          return reply({ detached: true });
        case "liveApplication.unloadDocument": {
          if (
            [keptOutbox, ...keptOutboxes.values()].some(
              (queue) => queue && queue.retryDeliveryId !== null,
            )
          )
            return reply({ status: "pending", reason: "delivery-pending" });
          // As the engine's settlement clause, which a queue frozen at its owner's adoption seed excuses.
          if (unsettled.size && !seedFrozen())
            return reply({ status: "pending", reason: "settlement-pending" });
          const next = unloads.shift() ?? { status: "unloaded" };
          if (next instanceof Error) throw next;
          return reply(next);
        }
        // Native registration accepts exactly the binding and the activation it serves.
        case "liveApplication.register": {
          if (Object.keys(request.params).join() !== "binding,activationId")
            throw new Error("INVALID_PARAMS: invalid-live-registration");
          if (registrationRefusal) throw registrationRefusal;
          let registrationId: number;
          if (!registrations) {
            if (!registrationsByObject) registrationId = 7;
            else {
              const objectId = (request.params.binding as { objectId: string }).objectId;
              if (!registrationsByObject.has(objectId))
                registrationsByObject.set(objectId, 7 + registrationsByObject.size);
              registrationId = registrationsByObject.get(objectId)!;
            }
          } else registrationId = registrations.live = ++registrations.next;
          registeredActivations.set(registrationId, request.params.activationId);
          return reply({ registrationId });
        }
        case "liveApplication.ownerState": {
          const registeredActivation = registeredActivations.get(
            request.params.registrationId as number,
          );
          if (otherActivations.has(String(registeredActivation)))
            return reply({
              adoptionId: registeredActivation,
              expectedLocalSequence: 2,
              throughCursor: 0,
              outboxId: null,
              pendingBytes: 0,
              outboxState: "active",
              retryDeliveryId: null,
            });
          return reply({
            adoptionId: engine.adoption.activationId,
            expectedLocalSequence: 2,
            throughCursor: engine.adoption.throughCursor,
            outboxId: native.outboxId,
            pendingBytes: native.outboxId ? nativeBytes() : 0,
            outboxState: native.state,
            retryDeliveryId: native.retryDeliveryId,
          });
        }
        // As the engine's, a preparation needs every queue of the activation to hold nothing deliverable and no Try again.
        case "liveApplication.prepareRetirement": {
          if (engine.prepareFailure) throw engine.prepareFailure;
          validatePreparationParams(request.params);
          const deliverable =
            native.entries.length > 0 &&
            (native.state === "active" || native.retryDeliveryId !== null);
          const granted =
            native.retryDeliveryId !== null ||
            [keptOutbox, ...keptOutboxes.values()].some(
              (queue) => queue && queue.retryDeliveryId !== null,
            );
          if (deliverable || granted)
            return reply(
              granted ? preparationWire.retryOutstanding : preparationWire.nativePending,
            );
          engine.prepared = { ...request.params };
          return reply(preparationWire.prepared);
        }
        case "liveApplication.releaseRetirementPreparation": {
          if (engine.releaseFailure) throw engine.releaseFailure;
          validatePreparationParams(request.params);
          const released = JSON.stringify(engine.prepared) === JSON.stringify(request.params);
          if (released) engine.prepared = undefined;
          return reply(released ? preparationWire.released : preparationWire.notReleased);
        }
        case "liveApplication.reconcileActivation": {
          // Its retirement began, which ends the block.
          engine.prepared = undefined;
          if (engine.refusal) throw engine.refusal;
          if (request.params.journal) {
            engine.journals.push(request.params.journal);
            engine.unproven = [];
          }
          if (engine.unproven.length)
            return reply({ status: "pending", reason: "delivery", deliveries: engine.unproven });
          // A refused seed holds the retirement until the journal proves it absent, and the engine abandons it
          // only when nothing applied it: its queue keeps its quarantine and refusal for the owner's copy.
          if (seedFrozen()) {
            if (!request.params.journal || !engine.abandonableSeed)
              return reply({
                status: "pending",
                reason: "seed-quarantined",
                deliveries: ["refused"],
              });
            for (const queue of [keptOutbox, ...keptOutboxes.values()])
              if (seeded(queue)) Object.assign(queue, { appendKey: "append-1", drained: true });
          }
          const after =
            (request.params.afterReceipt as { journalCursor: number } | null)?.journalCursor ?? 0;
          const cursor = (ack: Record<string, unknown>) => ack.journalCursor as number;
          const all = [...applied.values()]
            .filter(
              (ack) =>
                cursor(ack) > after && cursor(ack) <= (request.params.acceptedThrough as number),
            )
            .sort((a, b) => cursor(a) - cursor(b))
            .map((ack) => ({ ...ack, applicationReplayed: true }));
          const adoption =
            engine.adoption.throughCursor === null ||
            engine.adoption.activationId !== request.params.activationId
              ? null
              : {
                  adoptionId: engine.adoption.activationId,
                  localYDocSequence: 2,
                  terminalCursor: engine.adoption.throughCursor,
                  adoptionReplayed: true,
                };
          const max = request.params.maxApplications as number;
          engine.reconciledThrough = all.length ? cursor(all.at(-1)!) : after;
          return reply({
            status: "reconciled",
            adoption,
            applications: all.slice(0, max),
            hasMoreApplications: all.length > max,
            settle: adoption !== null && engine.settledThrough !== engine.reconciledThrough,
          });
        }
        case "liveApplication.releaseActivation": {
          const adoptedHere = engine.adoption.throughCursor !== null,
            replayed = engine.boundary !== undefined;
          if (adoptedHere && !replayed) {
            if (
              engine.unpushed ||
              ((replies.commit.departed ?? []) as string[]).includes(document.objectId)
            )
              return reply({ status: "pending", reason: "parking" });
            if (engine.releasePending)
              return reply({ status: "pending", reason: engine.releasePending });
            if (engine.unproven.length || engine.settledThrough !== engine.reconciledThrough)
              return reply({ status: "pending", reason: "reconciliation" });
          }
          engine.boundary ??= adoptedHere ? ownerBoundary() : null;
          return reply({ status: "released", replayed, boundary: engine.boundary });
        }
        case "liveApplication.settle": {
          if (seedFrozen())
            throw new EngineRequestError(request.id, {
              code: "INVALID_PARAMS",
              message: "live-application-invalid-input",
              retry: "no",
            } as never);
          const terminal = request.params.terminalReceipt as { journalCursor: number } | null;
          // A retirement's settlement that reached the file leaves output its replica must push before the document parks.
          if (request.params.retirement && settlement.materialized) {
            engine.settledThrough = terminal?.journalCursor ?? 0;
            engine.unpushed++;
          }
          if (settlement.materialized) unsettled.clear();
          return reply({
            status: "settled",
            settlement: {
              settlementId: "settlement",
              previousCursor: 0,
              terminalCursor: terminal?.journalCursor ?? 0,
              applicationCount: 0,
              localYDocSequence: 2,
              momentId: "settled-moment",
              markdownDigest: "c".repeat(64),
              materialized: settlement.materialized,
              collectionReconcileRequired: false,
            },
          });
        }
        case "liveApplication.fenceRestore":
          return reply({ status: "pending", reason: "native-fence-pending" });
        // Unless `fenceCommitted` says the native fence committed, a Decline ends the restore at its old generation,
        // under the binding it began with. After a committed fence, it keeps the fenced generation.
        case "liveApplication.cancelRestoreFence": {
          const basis = JSON.parse(
            String(
              raw
                .prepare(
                  "SELECT basis_json FROM sync_relay_live_restore_operations WHERE operation_id=?",
                )
                .get(request.params.operationId as string)!.basis_json,
            ),
          );
          const newFence = request.params.newFence as number;
          if (!engine.fenceCommitted)
            return reply({
              status: "cancelled",
              hostId: request.params.hostId,
              generation: newFence - 1,
              binding: basis.ownerBinding,
            });
          const saved = f.storage.readStopRestore(stopLookup)!,
            fence = nativeRestoreFence(saved.applied!, newFence, saved.intent);
          const binding = { ...fence.oldBinding, restoreFenceGeneration: newFence },
            endpoint =
              fence.terminal === null
                ? {
                    terminalReceipt: null,
                    eventCount: 0,
                    historyEvidenceDigest: initialAcceptedHistoryDigest(
                      f.history.namespace,
                      document,
                    ),
                  }
                : ((row) => ({
                    terminalReceipt: fence.terminal,
                    eventCount: row.accepted_event_count,
                    historyEvidenceDigest: row.accepted_evidence_digest,
                  }))(
                    raw
                      .prepare(
                        "SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE object_id='object' AND journal_cursor=?",
                      )
                      .get(fence.terminal.journalCursor)!,
                  );
          engine.generation = newFence;
          return reply({
            status: "fenceCancelled",
            hostId: request.params.hostId,
            generation: newFence,
            binding,
            receipt: {
              fence: {
                operation: fence,
                localHeadSequence: fence.appliedSequence,
                recordedAtMs: 55,
              },
              binding,
              endpoint,
              recordedAtMs: 55,
            },
          });
        }
        case "ydoc.ownerOutbox.retry":
          if (request.params.outboxId === NATIVE) {
            native.retryDeliveryId = native.entries[0]!.deliveryId;
            return reply({ retryDeliveryId: native.retryDeliveryId });
          }
          outboxOf(request).retryDeliveryId = "refused";
          return reply({ retryDeliveryId: "refused" });
        case "ydoc.ownerOutbox.quarantine": {
          if (request.params.outboxId === NATIVE) {
            native.state = "quarantined";
            native.retryDeliveryId = null;
            return reply({});
          }
          const queue = outboxOf(request);
          queue.state = "quarantined";
          queue.retryDeliveryId = null;
          return reply({});
        }
        case "ydoc.ownerOutbox.acknowledge": {
          const head = native.entries[0],
            receipts = request.params.receipts as { deliveryId: string }[];
          if (
            request.params.outboxId !== NATIVE ||
            !head ||
            receipts.length !== 1 ||
            receipts[0]!.deliveryId !== head.deliveryId ||
            (native.state === "quarantined" && native.retryDeliveryId !== head.deliveryId)
          ) {
            throw new EngineRequestError(request.id, {
              code: "INVALID_PARAMS",
              message: "owner-outbox-receipt-mismatch",
              retry: "no",
            } as never);
          }
          if (native.loseAcks.has(head.deliveryId)) throw new Error("Acknowledgement lost.");
          native.entries.shift();
          if (native.state === "quarantined") {
            native.state = "active";
            native.retryDeliveryId = null;
          }
          return reply({
            acknowledged: 1,
            pendingBytes: nativeBytes(),
            oldestEntryAtMs: native.entries.length ? 1 : null,
          });
        }
        case "ydoc.ownerOutbox.readPending": {
          if (request.params.outboxId === NATIVE) return reply(nativePage(request.params));
          if (!request.workspace?.startsWith("recovery-")) {
            const currentFailure = recoveryFaults.failCurrentRead;
            if (currentFailure) {
              recoveryFaults.failCurrentRead = undefined;
              throw currentFailure;
            }
            return reply(keptPage(request));
          }
          const open = [...recoveryStores.values()].find(
            (store) => store.handle === request.workspace,
          );
          if (!open || open.closing)
            throw new EngineRequestError(request.id, {
              code: "WORKSPACE_UNAVAILABLE",
              message: "workspace handle is unavailable",
              retry: "no",
            } as never);
          if (recoveryFaults.preparing) {
            recoveryFaults.preparing--;
            return reply({ kind: "preparing" });
          }
          const readFailure = recoveryFaults.failRead;
          if (readFailure) {
            recoveryFaults.failRead = undefined;
            throw readFailure;
          }
          return reply(
            keptPage(request, {
              binding: keptOutbox.binding,
              state: "quarantined",
              retryDeliveryId: null,
              appendKey: open.root,
            }),
          );
        }
        case "liveApplication.openRecoveryStore": {
          const openFailure = recoveryFaults.failOpen;
          if (openFailure) {
            recoveryFaults.failOpen = undefined;
            throw openFailure;
          }
          const { root, workspaceId } = request.params as { root: string; workspaceId: string },
            open = recoveryStores.get(workspaceId);
          if (open && (open.root !== root || open.closing))
            throw new EngineRequestError(request.id, {
              code: "CONFLICT",
              message: "a recovery store is already open for this workspace",
              retry: "no",
            } as never);
          recoveryStores.set(workspaceId, open ?? { root, handle: `recovery-${++recoveryOpens}` });
          if (recoveryFaults.loseOpen) {
            recoveryFaults.loseOpen = false;
            throw new Error("Open reply lost.");
          }
          return reply({ workspaceHandle: recoveryStores.get(workspaceId)!.handle });
        }
        case "liveApplication.closeRecoveryStore": {
          const open = [...recoveryStores].find(([, store]) => store.handle === request.workspace),
            failure = recoveryFaults.failClose;
          if (failure) {
            recoveryFaults.failClose = undefined;
            throw failure;
          }
          if (!open)
            throw new EngineRequestError(request.id, {
              code: "WORKSPACE_UNAVAILABLE",
              message: "workspace handle is unavailable",
              retry: "no",
            } as never);
          const worker = recoveryFaults.worker;
          if (worker && !open[1].closing) {
            open[1].closing = true;
            throw new EngineRequestError(request.id, {
              code: "DEADLINE_EXCEEDED",
              message: "request deadline exceeded",
              retry: "afterBackoff",
            } as never);
          }
          await worker;
          recoveryStores.delete(open[0]);
          return reply({ closed: true });
        }
        case "sync.createHostedReplica":
          if (replies.create)
            throw replies.create === "diverged" ? divergence(request.id) : replies.create;
          return reply({ hosted: true });
        // A push waiting for owner admission pushes nothing.
        case "sync.push": {
          pushed.resolve();
          if (!((replies.push.ownerAdmissionPending ?? []) as unknown[]).length)
            engine.unpushed = 0;
          return reply({ ...pushReply, ...replies.push });
        }
        case "sync.pullHosted": {
          if (replies.diverge) throw divergence(request.id);
          const pass = hostedPass(replies.pass),
            holds = pass.held as { objectId: string }[];
          const held = page(
            holds.map((hold) => hold.objectId),
            request.params.heldAfter as string | undefined,
            replies.heldPerPass,
          );
          departedAfter = request.params.departedAfter as string | undefined;
          const departed = page(pass.departed as string[], departedAfter, replies.departedPerPass);
          return reply({
            ...pass,
            held: holds.filter((hold) => held.listed.includes(hold.objectId)),
            heldThrough: held.through,
            departed: departed.listed,
            departedThrough: departed.through,
          });
        }
        case "sync.materializePendingCursor":
          return reply({ materialized: true });
        case "sync.commitCursor": {
          if (replies.loseCommit) {
            replies.loseCommit = false;
            throw new Error("Commit reply lost.");
          }
          const commit = hostedCommit(replies.commit);
          if (!commit.departed) return reply(commit);
          // A document with output still unpushed cannot park, so its replica lists it departed.
          const listed = commit.departed as string[];
          const departed = page(
            engine.unpushed && !listed.includes(document.objectId)
              ? [...listed, document.objectId].sort()
              : listed,
            departedAfter,
            replies.departedPerPass,
          );
          return reply({ ...commit, departed: departed.listed, departedThrough: departed.through });
        }
      }
      throw new Error(`Unexpected engine request ${request.method}.`);
    });
    return client;
  });
  // An owner live edit, prepared under the current binding. Calling the result commits it as the host's submit does.
  const prepareEdit = (value: string, coordinate: LiveHostConnectionCoordinate) => {
    const live = f.storage.resolveCurrentLiveDocumentBinding({ document, actor }),
      read = f.storage.readLiveUpdateJournalCut({ document });
    if (live.kind !== "current" || read.kind !== "cut") throw new Error("Missing live authority.");
    const doc = new Y.Doc(),
      suffix = read.cut.suffix.map((row) => row.bytes);
    for (const bytes of [read.cut.checkpoint.bytes, ...suffix]) Y.applyUpdate(doc, bytes);
    const vector = Y.encodeStateVector(doc);
    doc.getMap("frontmatter").set("edit", value);
    const updateBytes = Buffer.from(Y.encodeStateAsUpdate(doc, vector));
    doc.destroy();
    const validation = validateJournal({
      document,
      currentPath: live.binding.currentPath,
      checkpoint: read.cut.checkpoint.bytes,
      suffix,
      candidate: updateBytes,
    });
    return () =>
      f.storage.commitLiveUpdateJournal({
        host: coordinate,
        actor,
        expectedAuthority: live.authority,
        metadata: {
          deliveryId: `edit-${value}`,
          updateDigest: sha256(updateBytes),
          binding: live.binding,
        },
        cutToken: read.cut,
        validation,
        updateBytes,
        receivedAtMs: 5,
      });
  };
  const beginRestore = () => {
    const plan = f.storage.readStopRestorePlan({
      document,
      ownerUserId: "owner",
      operationId: "restore",
      shareId: "share",
      grantId: "grant",
      restorePointCursor: 0,
      restorePointReceiptDigest: document.lineageClaimId,
      maxOutputBytes: 1_000_000,
    });
    f.storage.beginStopRestore(plan.intent, 40);
  };
  const nativeEdits = (...values: string[]) => {
    const read = f.storage.readLiveUpdateJournalCut({ document });
    if (read.kind !== "cut") throw new Error("Missing live journal.");
    const doc = new Y.Doc();
    for (const bytes of [read.cut.checkpoint.bytes, ...read.cut.suffix.map((row) => row.bytes)])
      Y.applyUpdate(doc, bytes);
    for (const value of values) {
      const vector = Y.encodeStateVector(doc);
      doc.getMap("frontmatter").set("edit", value);
      native.entries.push({
        sequence: native.nextSequence++,
        deliveryId: `edit-${value}`,
        update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)),
      });
    }
    doc.destroy();
    native.outboxId = NATIVE;
  };
  const host = await startServiceLiveHost({
    ...f,
    ...(options.frameChanges ? { frameChanges: createNamedFrameChanges(16) } : {}),
    ...(options.idleClock ? { idleClock: options.idleClock } : {}),
    ...options.paced?.timers,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });
  cleanup.push(() => host.close());
  // The activation pass publishes readiness before it pushes the hosted replica.
  if (!options.empty) await pushed.promise;
  return {
    f,
    raw,
    host,
    document,
    workspace,
    target,
    pushed,
    unloads,
    replies,
    settlement,
    engine,
    membership,
    keptOutbox,
    keptOutboxes,
    recoveryStores,
    recoveryFaults,
    native,
    nativeEdits,
    nativeHeadBytes,
    requestListeners,
    spawned: () => spawn.mock.calls.length,
    client: () => client,
    ownerRequests: () => ownerRequests,
    ownerCalls: () =>
      client.sendRequest.mock.calls
        .map((call) => (call as unknown[])[0] as { method: string; params: unknown })
        .filter((request) => request.method.startsWith("liveApplication."))
        .map((request) => [request.method, request.params]),
    refuseCapture(error: Error | undefined) {
      refusal = error;
    },
    refuseCaptureAt(path: string, error: Error) {
      refusals.set(path, error);
    },
    otherActivations,
    refuseRegistration(error: Error | undefined) {
      registrationRefusal = error;
    },
    failDetach(error: Error | undefined) {
      detachFailure = error;
    },
    applied,
    lost,
    freshRegistrations() {
      registrations = { next: 100, live: 0 };
    },
    distinctRegistrations() {
      return (registrationsByObject = new Map([[document.objectId, 7]]));
    },
    liveRegistration: () => registrations?.live,
    validateJournal,
    prepareEdit: (value: string) => prepareEdit(value, host.coordinate),
    acceptEdit(value: string, coordinate = host.coordinate) {
      const committed = prepareEdit(value, coordinate)();
      if (committed.result.kind !== "accepted")
        throw new Error(`Live edit was not accepted: ${JSON.stringify(committed.result)}`);
      return committed.result.receipt;
    },
    tip: () =>
      JSON.parse(
        String(
          raw
            .prepare(
              "SELECT tip_receipt_json FROM sync_relay_live_delivery_owners WHERE object_id='object'",
            )
            .get()!.tip_receipt_json,
        ),
      ),
    retiredTip: () =>
      JSON.parse(
        String(
          raw
            .prepare(
              "SELECT tip_receipt_json FROM sync_relay_live_delivery_owner_history WHERE object_id='object'",
            )
            .get()!.tip_receipt_json,
        ),
      ),
    // Starts a new host on the same relay. Its first pass captures and, while capture is refused, leaves no owner.
    async restart() {
      await host.close();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      cleanup.push(async () => log.mockRestore());
      const restarted = await startServiceLiveHost(f);
      cleanup.push(() => restarted.close());
      await vi.waitFor(() => expect(client.captureOwnerActivation).toHaveBeenCalled());
      return restarted;
    },
    park(method: string) {
      parked = { method, entered: deferred<void>(), release: deferred<void>() };
      return parked;
    },
    beginRestore,
    restore() {
      beginRestore();
      f.storage.advanceStopRestoreFence(
        { operationId: "restore", workspaceId: "workspace", ownerUserId: "owner" },
        50,
      );
    },
  };
}

it.each(["drain"] as const)(
  "fails an in-flight public %s and queued public calls as incomplete after a restore fence",
  async (method) => {
    const o = await completedServiceOwner();
    expect(o.host.isDocumentReady(o.document)).toBe(true);
    const parked = o.park("liveApplication.ownerState"),
      inflight = o.host[method](o.document);
    await parked.entered.promise;
    const drains = vi.spyOn(OwnerCommittedDelivery.prototype, "drain"),
      settles = vi.spyOn(OwnerCommittedDelivery.prototype, "settle");
    try {
      const queuedDrain = o.host.drain(o.document),
        queuedSettle = o.host.settle(o.document),
        requests = o.ownerRequests();
      o.restore();
      expect(o.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()).toEqual({
        admission_state: "closed",
      });
      expect(o.host.isDocumentReady(o.document)).toBe(false);
      parked.release.resolve();
      await expect(inflight).rejects.toThrow("Service document activation is incomplete.");
      await expect(queuedDrain).rejects.toThrow("Service document activation is incomplete.");
      await expect(queuedSettle).rejects.toThrow("Service document activation is incomplete.");
      expect(o.ownerRequests()).toBe(requests);
      expect(drains).not.toHaveBeenCalled();
      expect(settles).not.toHaveBeenCalled();
    } finally {
      drains.mockRestore();
      settles.mockRestore();
    }
  },
);

// A drain queued behind a document's work must not log each wait, or someone
// with Edit submitting from several connections could fill the log. Proves: a
// document's application waits log once a minute (the submit line's test
// proves the shared cap's `repeated` count).
it("logs drains that waited over 100 ms for their document once a minute, with fixed words only", async () => {
  let clock = 0;
  const o = await completedServiceOwner({ nowMs: () => clock });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(async () => log.mockRestore());
  const parked = o.park("liveApplication.ownerState"),
    inflight = o.host.drain(o.document);
  await parked.entered.promise;
  // Drains name their wait; a settlement does not.
  const queued = [o.host.drain(o.document), o.host.drain(o.document), o.host.drain(o.document)],
    settled = o.host.settle(o.document);
  clock += 150;
  parked.release.resolve();
  await Promise.allSettled([inflight, ...queued, settled]);
  const waits = log.mock.calls.filter(
    ([message]) => message === "Live document waited for its lock.",
  );
  expect(waits.filter(([, line]) => line.waiter === "application")).toEqual([
    [
      "Live document waited for its lock.",
      { object: "object", waiter: "application", waitedMs: 150 },
    ],
  ]);
});

const stopLookup = { operationId: "restore", workspaceId: "workspace", ownerUserId: "owner" };

const unready = () =>
  new EngineRequestError(1, {
    code: "CONFLICT",
    message: "hosted-document-unready",
    retry: "no",
  } as never);

const appendDocumentRow = (
  raw: InstanceType<typeof DatabaseSync>,
  opKind: "moment.append" | "ydoc.update",
  objectId: string,
) => {
  raw
    .prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
    SELECT 'workspace','device',COUNT(*)+1,?,?,0 FROM sync_relay_log WHERE origin_id='device'`)
    .run(
      opKind,
      JSON.stringify({
        versionId: "main",
        objectId,
        path: "docs/a.md",
        contentKind: "richdoc",
        isBaseState: true,
        lineageClaimId: "d".repeat(64),
        updateBlobSha256: "d".repeat(64),
      }),
    );
};

const engineMethods = (client: { sendRequest: { mock: { calls: unknown[][] } } }) =>
  client.sendRequest.mock.calls.map((call) => (call[0] as { method: string }).method);

it("refuses a restore after a configured restart until its replica checked its origin", async () => {
  const o = await completedServiceOwner({ polling: true });
  await o.host.close();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(async () => log.mockRestore());
  o.replies.create = new Error("Relay unreachable.");
  const restarted = await startServiceLiveHost(o.f);
  cleanup.push(() => restarted.close());
  const creates = () =>
    engineMethods(o.client()).filter((method) => method === "sync.createHostedReplica").length;
  await vi.waitFor(() => expect(creates()).toBeGreaterThan(2));
  o.restore();
  await expect(restarted.stopRestore(stopLookup)).rejects.toThrow(
    "Service restore source is unavailable.",
  );
  expect(new Set(engineMethods(o.client()))).toEqual(
    new Set(["liveApplication.hosts", "sync.createHostedReplica"]),
  );
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
  o.replies.create = undefined;
  await vi.waitFor(() => expect(o.client().captureOwnerActivation).toHaveBeenCalled());
  const methods = engineMethods(o.client()),
    checked = methods.lastIndexOf("sync.createHostedReplica");
  expect(
    methods
      .slice(0, checked)
      .every(
        (method) => method === "liveApplication.hosts" || method === "sync.createHostedReplica",
      ),
  ).toBe(true);
  expect(o.client().sendRequest.mock.invocationCallOrder[checked]).toBeLessThan(
    o.client().captureOwnerActivation.mock.invocationCallOrder[0]!,
  );
  await expect(restarted.stopRestore(stopLookup)).resolves.toEqual({
    kind: "pending",
    reason: "native-fence-pending",
  });
});

async function emptyServiceHost(
  options: {
    frameChanges?: boolean;
    maxDocumentsPerPass?: number;
    adopted?: boolean;
    maxApplications?: number;
    limits?: DrainLimits;
    pollIntervalMs?: number;
    selfHosted?: boolean;
    restore?: boolean;
    idleClock?: IdleClock;
    paced?: Paced;
    requestDeadlineMs?: number;
  } = {},
) {
  const o = await completedServiceOwner({ empty: true, ...options });
  const sibling = { workspaceId: "workspace", objectId: "object", path: "docs/a.md" };
  const other = { workspaceId: "workspace", objectId: "object-b", path: "docs/b.md" };
  const activate = ServiceActivationDriver.prototype.activate,
    loaded = ServiceActivationDriver.prototype.loaded,
    passes = { deliver: true };
  vi.spyOn(ServiceActivationDriver.prototype, "activate").mockImplementation(function (
    this: ServiceActivationDriver,
    ...args
  ) {
    if (!passes.deliver && args[0].path === sibling.path)
      return Promise.resolve({ kind: "pending" as const, reason: "paused" });
    return args[0].path === other.path
      ? Promise.resolve({ kind: "pending" as const, reason: "held" })
      : activate.apply(this, args);
  });
  vi.spyOn(ServiceActivationDriver.prototype, "loaded").mockImplementation(function (
    this: ServiceActivationDriver,
    target,
  ) {
    return target.path === other.path || loaded.call(this, target);
  });
  cleanup.push(async () => {
    vi.restoreAllMocks();
  });
  const attach = {
    method: "liveApplication.attachWorkspace",
    workspace: undefined,
    params: {
      root: o.workspace.root,
      workspaceId: "workspace",
      maxRegistrations: 8,
      relay: { baseUrl: "https://relay.example", bearerToken: "service-token" },
    },
  };
  const detach = {
    method: "liveApplication.detachWorkspace",
    workspace: "attached-handle",
    params: {},
  };
  const pullCount = () =>
    o
      .client()
      .sendRequest.mock.calls.filter(
        (call) => ((call as unknown[])[0] as { method: string }).method === "sync.pullHosted",
      ).length;
  return {
    ...o,
    sibling,
    other,
    attach,
    detach,
    pullCount,
    passes,
    unload: {
      method: "liveApplication.unloadDocument",
      workspace: "attached-handle",
      params: { objectId: other.objectId },
    },
    // Resolves once a pull that began after the current one has been sent, on the second new pull. A ready
    // workspace whose replica waits on nothing pulls only for a relay change; wait on `nextPass` for it.
    nextPull() {
      let seen = 0;
      return new Promise<void>((resolve) => {
        const listener = (method: string) => {
          if (method === "sync.pullHosted" && ++seen === 2) {
            o.requestListeners.delete(listener);
            resolve();
          }
        };
        o.requestListeners.add(listener);
      });
    },
    nextPass: () => afterPasses(o.f),
  };
}
const stay = { departing: [] };
it("answers a held-document read its detach or retired registration overtook as nothing there", async () => {
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const send = o.client().sendRequest,
    through = send.getMockImplementation()! as (...args: unknown[]) => ReturnType<typeof send>;
  let engine: () => Promise<unknown> = async () => null;
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { id: number; method: string };
    return request.method === "sync.heldDocument"
      ? ({ id: request.id, result: await engine() } as never)
      : through(...args);
  });
  const holding = (answer: () => unknown) => {
    const asked = deferred<void>(),
      release = deferred<void>();
    engine = async () => {
      asked.resolve();
      await release.promise;
      return answer();
    };
    return { asked: asked.promise, release: () => release.resolve() };
  };
  const routes = createHeldDocumentRoutes({ storage: o.f.storage, host: () => o.host });
  const read = () =>
    routes(
      new Request("http://relay.test/sync/workspace/held-documents/object"),
      { route: "held-documents", workspaceId: "workspace", objectId: "object" },
      "owner",
    );

  engine = async () => {
    throw new Error("engine connection closed");
  };
  await expect(o.host.heldDocument("workspace", "object", { markdown: false })).rejects.toThrow(
    "engine connection closed",
  );
  await expect(read()).rejects.toThrow("engine connection closed");

  const detaching = holding(() => {
      throw new Error("engine connection closed");
    }),
    detached = read();
  await detaching.asked;
  await o.host.update({ workspaces: [], documents: [], ...stay });
  detaching.release();
  await expect(detached).rejects.toMatchObject({ code: "not_found" });

  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(async () => log.mockRestore());
  const retiring = holding(() => null),
    retired = o.host.heldDocument("workspace", "object", { markdown: false });
  await retiring.asked;
  o.raw.exec(
    "UPDATE sync_relay_session_host_control SET admission_state='closed', registered_connection_id=NULL",
  );
  retiring.release();
  await expect(retired).resolves.toEqual({ invalidated: "registration" });
  await expect(read()).rejects.toMatchObject({ code: "not_found" });
});

it("stops the engine for a held read it answers neither at the deadline nor on cancel", async () => {
  const o = await emptyServiceHost({ frameChanges: true }),
    workspaces = [o.workspace];
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const send = o.client().sendRequest,
    through = send.getMockImplementation()! as (...args: unknown[]) => ReturnType<typeof send>;
  let answersCancel = true;
  const deadlines: number[] = [];
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { id: number; method: string; deadlineMs: number };
    if (request.method !== "sync.heldDocument") return through(...args);
    deadlines.push(request.deadlineMs);
    const cancel = args[3] as AbortSignal;
    // The engine holds the read past its caller's deadline.
    await new Promise((resolve) => cancel.addEventListener("abort", resolve, { once: true }));
    // A healthy engine answers the cancel. A stuck one does not, and the client's own deadline ends the read later.
    if (answersCancel)
      throw new EngineRequestError(request.id, {
        code: "CANCELLED",
        message: "held document answer cancelled",
        retry: "no",
      });
    throw new EngineRequestDeadlineError(request.id, request.method, request.deadlineMs);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(async () => log.mockRestore());

  await expect(o.host.heldDocument("workspace", "object", { markdown: false })).rejects.toThrow(
    "Held read deadline exceeded.",
  );
  expect(deadlines).toEqual([1000 + 15_000]);

  // A caller that joins later does not keep the read past its deadline.
  const first = o.host.heldDocument("workspace", "object", { markdown: false });
  const firstFailed = expect(first).rejects.toThrow("Held read deadline exceeded.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await expect(
    o.host.heldDocument("workspace", "object", { markdown: false }),
  ).rejects.toMatchObject({
    wireError: { code: "CANCELLED" },
  });
  await firstFailed;
  expect(o.host.invalidated.aborted).toBe(false);

  answersCancel = false;
  await expect(o.host.heldDocument("workspace", "object", { markdown: false })).rejects.toThrow(
    "Held read deadline exceeded.",
  );
  await vi.waitFor(() => expect(o.host.invalidated.aborted).toBe(true));
  expect(
    log.mock.calls.filter(([message]) => String(message).startsWith("Live host")),
  ).toContainEqual([
    "Live host stopped an engine that did not answer in time.",
    { method: "sync.heldDocument", deadlineMs: 16_000 },
  ]);
});

it.each([
  [20_000, 40_000],
  [2_147_483_647, 2_147_483_647],
])(
  "gives a held read at least one request deadline after its cancel (%i ms)",
  async (requestDeadlineMs, sent) => {
    const o = await emptyServiceHost({ frameChanges: true, requestDeadlineMs }),
      workspaces = [o.workspace];
    await o.host.update({ workspaces, documents: [o.sibling], ...stay });
    await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
    const send = o.client().sendRequest,
      through = send.getMockImplementation()! as (...args: unknown[]) => ReturnType<typeof send>;
    const asked = deferred<number>();
    send.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as { id: number; method: string; deadlineMs: number };
      if (request.method !== "sync.heldDocument") return through(...args);
      asked.resolve(request.deadlineMs);
      const cancel = args[3] as AbortSignal;
      await new Promise((resolve) => cancel.addEventListener("abort", resolve, { once: true }));
      throw new EngineRequestError(request.id, {
        code: "CANCELLED",
        message: "held document answer cancelled",
        retry: "no",
      });
    });
    const caller = new AbortController();
    const read = o.host.heldDocument("workspace", "object", { markdown: false }, caller.signal);
    const left = expect(read).rejects.toThrow("caller left");
    await expect(asked.promise).resolves.toBe(sent);
    caller.abort(new Error("caller left"));
    await left;
    expect(o.host.invalidated.aborted).toBe(false);
  },
);

it("frees a cancelled held read's slot on the engine's answer, and answers the engine's busy refusal 429 to the owner alone", async () => {
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const send = o.client().sendRequest,
    through = send.getMockImplementation()! as (...args: unknown[]) => ReturnType<typeof send>;
  let engine: (request: { id: number }, cancel?: AbortSignal) => Promise<unknown> = async () =>
    null;
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { id: number; method: string };
    return request.method === "sync.heldDocument"
      ? ({
          id: request.id,
          result: await engine(request, args[3] as AbortSignal | undefined),
        } as never)
      : through(...args);
  });

  const entered = deferred<void>();
  engine = (request, cancel) =>
    new Promise((_resolve, reject) => {
      cancel?.addEventListener(
        "abort",
        () =>
          reject(
            new EngineRequestError(request.id, {
              code: "CANCELLED",
              message: "held document answer cancelled",
              retry: "no",
            }),
          ),
        { once: true },
      );
      entered.resolve();
    });
  const caller = new AbortController();
  const cancelled = o.host.heldDocument("workspace", "object", { markdown: false }, caller.signal);
  await entered.promise;
  const refused = expect(cancelled).rejects.toThrow("caller left");
  caller.abort(new Error("caller left"));
  await refused;
  engine = async () => null;
  // Far inside the 1 s request deadline, which would free it otherwise.
  await vi.waitFor(
    () =>
      expect(o.host.heldDocument("workspace", "object", { markdown: false })).resolves.toBeNull(),
    { timeout: 250 },
  );

  const busy = () =>
    new EngineRequestError(0, {
      code: "OVERLOADED",
      message: "held-read-busy",
      retry: "afterBackoff",
    });
  engine = async () => {
    throw busy();
  };
  await expect(
    o.host.heldDocument("workspace", "object", { markdown: false }),
  ).rejects.toBeInstanceOf(HeldReadBusyError);
  const routes = createHeldDocumentRoutes({ storage: o.f.storage, host: () => o.host });
  const read = () =>
    routes(
      new Request("http://relay.test/sync/workspace/held-documents/object"),
      { route: "held-documents", workspaceId: "workspace", objectId: "object" },
      "owner",
    );
  await expect(read()).rejects.toMatchObject({ code: "held_read_busy" });
  const asked = deferred<void>(),
    release = deferred<void>();
  engine = async () => {
    asked.resolve();
    await release.promise;
    throw busy();
  };
  const lost = read();
  await asked.promise;
  o.raw.exec(
    "UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id='workspace'",
  );
  release.resolve();
  await expect(lost).rejects.toMatchObject({ code: "not_found" });
});

// An empty host with the document shared with Edit, enrolled and ready.
// With `supervised`, the self-host supervisor runs the host as its daemon,
// configured for restore, and sends it every membership update.
// With `polls`, passes run only when the host wakes itself, or the test runs one, as in setup here, and a
// supervisor reconciles only on its own wakes too.
async function enrolledServiceHost({
  freshRegistrations = false,
  frameChanges = false,
  maxApplications = 8,
  limits = {} as DrainLimits,
  supervised = false,
  polls = undefined as ReturnType<typeof heldPolls> | undefined,
  paced = undefined as Paced | undefined,
} = {}) {
  const o = await emptyServiceHost({
    frameChanges,
    maxApplications,
    limits,
    selfHosted: supervised,
    restore: supervised,
    ...(polls ? { pollIntervalMs: HELD_POLL_MS } : {}),
    ...(paced ? { paced } : {}),
  });
  if (freshRegistrations) o.freshRegistrations();
  o.f.storage.ensureOwnedLiveDocument({
    intent: "share",
    workspaceId: "workspace",
    ownerUserId: "owner",
    shareId: "share",
    path: o.sibling.path,
    nowMs: 10,
    guard() {},
  });
  const errors: unknown[] = [];
  let supervisor: Awaited<ReturnType<typeof startSelfHostedLiveHost>> | undefined;
  if (supervised) {
    const data = join(o.f.root, "self-host");
    await mkdir(data);
    supervisor = await startSelfHostedLiveHost({
      trustedAccount: o.f.trustedAccount,
      storage: o.f.storage,
      history: o.f.history,
      root: data,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.test",
      key: new Uint8Array(32).fill(9),
      frameChanges: createNamedFrameChanges(16),
      startHost: async () => o.host,
      onError: (error) => errors.push(error),
      ...(polls || paced ? { reconcileIntervalMs: HELD_RECONCILE_MS } : {}),
    });
    cleanup.push(() => supervisor!.close());
  } else await o.host.update({ workspaces: [o.workspace], documents: [o.sibling], ...stay });
  if (polls) {
    // The supervisor's first update reaches the host on its own, and passes then wait their turn behind it.
    if (supervised)
      await vi.waitFor(
        () =>
          expect(o.membership.map((row) => row.method)).toContain(
            "liveApplication.attachWorkspace",
          ),
        { timeout: 10_000 },
      );
    await polls.until(o.f, () => o.host.isDocumentReady(o.document));
  }
  if (paced) {
    if (supervised)
      await vi.waitFor(
        () =>
          expect(o.membership.map((row) => row.method)).toContain(
            "liveApplication.attachWorkspace",
          ),
        { timeout: 10_000 },
      );
    await paced.until(o.f, () => o.host.isDocumentReady(o.document));
  }
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true), {
    timeout: 10_000,
  });
  const binding = o.f.storage.resolveCurrentLiveDocumentBinding({
    document: o.document,
    actor: { kind: "owner", userId: "owner" },
  });
  if (binding.kind !== "current") throw new Error("Missing live binding.");
  const calls = (from: number) =>
    o
      .ownerCalls()
      .slice(from)
      .map(([method]) => method as string);
  return {
    ...o,
    binding: binding.binding,
    calls,
    supervisor,
    errors,
    stop() {
      expect(
        preparedStop(o.f.storage, {
          workspaceId: "workspace",
          ownerUserId: "owner",
          path: o.sibling.path,
          enabled: false,
          retire: true,
          nowMs: 20,
          guard() {},
        }),
      ).toMatchObject({ enabled: false, retired: true });
    },
    depart: (host = o.host) =>
      host.update({ workspaces: [o.workspace], documents: [], departing: [o.sibling] }),
  };
}

const preparationWire = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/dohc-workspace-engine/tests/retirement-preparation.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  params: Record<string, string | number>;
  prepared: { status: "prepared" };
  nativePending: { status: "pending"; reason: "native-pending" };
  retryOutstanding: { status: "pending"; reason: "retry-outstanding" };
  released: { released: true };
  notReleased: { released: false };
  errors: Record<string, NonNullable<EngineRequestError["wireError"]>>;
};
function validatePreparationParams(params: Record<string, unknown>): void {
  if (
    Object.keys(params).sort().join() !== Object.keys(preparationWire.params).sort().join() ||
    Object.entries(preparationWire.params).some(
      ([key, value]) => typeof params[key] !== typeof value,
    )
  ) {
    throw new Error("INVALID_PARAMS: invalid-retirement-preparation");
  }
}
const ACTIVATION = `ordinary-activation-${"a".repeat(64)}`,
  SUCCESSOR = `ordinary-activation-${"b".repeat(64)}`;
const retirement = [
  "liveApplication.reconcileActivation",
  "liveApplication.settle",
  "liveApplication.releaseActivation",
];
const retiredRow = (o: Awaited<ReturnType<typeof enrolledServiceHost>>) => {
  const row = o.raw
    .prepare(
      "SELECT retired_at_ms,retired_boundary_json FROM sync_relay_service_activations WHERE activation_id=?",
    )
    .get(ACTIVATION)!;
  return {
    retired: row.retired_at_ms !== null,
    boundary:
      row.retired_boundary_json === null
        ? undefined
        : JSON.parse(String(row.retired_boundary_json)),
  };
};
const retiringSettles = (o: Awaited<ReturnType<typeof enrolledServiceHost>>, from: number) =>
  o
    .ownerCalls()
    .slice(from)
    .filter(
      ([method, params]) =>
        method === "liveApplication.settle" && Object.hasOwn(params as object, "retirement"),
    );

it("retires a stopped last document once it settled and published and a pull confirmed it left, without an unload", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const cut = o.f.storage.readLiveUpdateJournalCut({ document: o.document }),
    tip = o.tip();
  o.settlement.materialized = false;
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(retiringSettles(o, sent).length).toBeGreaterThan(0));
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  const pushes = () =>
    o
      .client()
      .sendRequest.mock.calls.filter(
        (call) => ((call as unknown[])[0] as { method: string }).method === "sync.push",
      ).length;
  const pushed = pushes();
  await o.nextPull();
  expect(pushes()).toBeGreaterThan(pushed);
  expect(o.calls(sent)).not.toContain("liveApplication.releaseActivation");
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.drained("workspace")).toBe(false);
  o.settlement.materialized = true;
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  const key = {
    objectId: "object",
    lineageClaimId: o.document.lineageClaimId,
    activationId: ACTIVATION,
    restoreFenceGeneration: o.binding.restoreFenceGeneration,
    acceptedThrough: tip.journalCursor,
  };
  const calls = o.ownerCalls().slice(sent);
  expect(new Set(calls.map(([method]) => method))).toEqual(new Set(retirement));
  expect(calls).toContainEqual([
    "liveApplication.reconcileActivation",
    { ...key, afterReceipt: tip, maxApplications: 8 },
  ]);
  expect(retiringSettles(o, sent).at(-1)).toEqual([
    "liveApplication.settle",
    { retirement: key, terminalReceipt: tip },
  ]);
  expect(calls.at(-1)).toEqual(["liveApplication.releaseActivation", key]);
  const methods = o
    .client()
    .sendRequest.mock.calls.map((call) => ((call as unknown[])[0] as { method: string }).method);
  const released = methods.lastIndexOf("liveApplication.releaseActivation");
  expect(methods.lastIndexOf("sync.push", released)).toBeGreaterThan(
    methods.lastIndexOf("liveApplication.settle", released),
  );
  expect(o.membership.filter((row) => row.method === "liveApplication.unloadDocument")).toEqual([]);
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
  expect(retiredRow(o)).toEqual({ retired: true, boundary: o.engine.boundary });
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
  const delivery = o.f.storage.createLiveCommittedDeliveryStore(o.f.history);
  expect(() => delivery.open({ host: o.host.coordinate, document: o.document })).toThrow(
    "Committed delivery follows a retired owner adoption.",
  );
  expect(
    o.raw.prepare("SELECT COUNT(*) AS bootstraps FROM sync_relay_live_delivery_bootstraps").get(),
  ).toEqual({ bootstraps: 0 });
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  await expect(o.host.detachDrained("workspace")).resolves.toBe(true);
  expect(o.membership.at(-1)).toEqual(o.detach);
  expect(o.f.storage.readLiveUpdateJournalCut({ document: o.document })).toEqual(cut);
  expect(o.client().close).not.toHaveBeenCalled();
});

function keptEdits(o: Awaited<ReturnType<typeof enrolledServiceHost>>) {
  o.keptOutbox.binding = o.binding;
  let refusals = 0;
  const identity = o.workspace.hostedReplication!.identity;
  const refuse = () =>
    o.f.storage.recordServiceKeptEdits({
      identity,
      outboxId: "kept-outbox",
      binding: o.binding,
      reason: "invalid-update",
      headDeliveryId: "refused",
      refusalKey: `refusal-${++refusals}`,
      nowMs: 1,
    });
  refuse();
  const engine = (method: string) =>
    o
      .client()
      .sendRequest.mock.calls.map(
        (call) => (call as unknown[])[0] as { method: string; workspace?: string; params: unknown },
      )
      .filter((request) => request.method === method);
  const other = (outboxId: string, copied = true) => {
    o.keptOutboxes.set(outboxId, {
      binding: o.binding,
      state: "quarantined",
      retryDeliveryId: null,
      appendKey: "append-1",
    });
    o.f.storage.recordServiceKeptEdits({
      identity,
      outboxId,
      binding: o.binding,
      reason: "invalid-update",
      headDeliveryId: "refused",
      refusalKey: `${outboxId}-refusal`,
      nowMs: 1,
    });
    if (copied)
      o.f.storage.confirmServiceKeptEditsCopy({
        workspaceId: "workspace",
        outboxId,
        generation: o.f.storage.readServiceKeptEdits(queue(outboxId))!.generation,
        checkpointDigest: null,
      });
  };
  const queue = (outboxId: string) => ({ workspaceId: "workspace", identity, outboxId });
  return {
    refuse,
    other,
    engine,
    identity,
    queue,
    row: () => o.f.storage.readServiceKeptEdits(queue("kept-outbox")),
  };
}

// Proves: a stopped document whose owner has no recovery copy of edits the
// server kept departs as an ordinary unload, then stays, with its workspace
// attached, through later passes. A Try again granted before Stop ends,
// keeping the queue. Once the owner confirms a copy, its retirement proves the
// refused edit absent from the journal and completes, its workspace drains and
// its rows go. Try again needs the live authority Stop ended; on a hosted
// document it grants the refused head through the host's own connection.

// Proves: the relay refused the owner's adoption seed and nothing applied it. Stop's retirement asks
// the journal, which proves the seed absent; the engine abandons it, and the retirement completes without
// waiting for a recovery copy, which stays asked for. The first Resume activates the successor.

// The accepted state a recovery copy reads, as the engine pages it through the host.
async function keptCheckpoint(
  host: Awaited<ReturnType<typeof enrolledServiceHost>>["host"],
  kept: ServiceKeptEdits,
  store: string,
) {
  type Page = { kind: string; snapshot: string; bytesBase64: string };
  const header = (await host.readKeptEditsPage(kept, undefined, store)) as Page;
  const named = JSON.parse(Buffer.from(header.bytesBase64, "base64").toString("utf8")) as {
    checkpointDigest: string | null;
  };
  const page = (await host.readKeptEditsPage(
    kept,
    { snapshot: header.snapshot, part: "checkpoint", sequence: 0, offset: 0 },
    store,
  )) as Page;
  const bytes = Buffer.from(page.bytesBase64, "base64");
  expect(sha256(bytes)).toBe(named.checkpointDigest);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const text = yDocToMarkdown(doc);
  doc.destroy();
  return { digest: named.checkpointDigest!, text };
}
const acceptedState = (text: string) => {
  const doc = markdownToYDoc(text),
    bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return bytes;
};

it("keeps a frozen seed's stopped document until its owner copies the accepted state with the later edit", async () => {
  const o = await enrolledServiceHost(),
    k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.keptOutbox.checkpoint = acceptedState("Original");
  const early = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  expect(
    o.f.storage.confirmServiceKeptEditsCopy({
      workspaceId: "workspace",
      outboxId: "kept-outbox",
      generation: k.row()!.generation,
      checkpointDigest: early.digest,
    }),
  ).toBe(true);
  o.acceptEdit("recipient");
  await o.host.drain(o.document);
  o.keptOutbox.checkpoint = acceptedState("Original\n\nRecipient text");
  o.stop();
  await o.depart();
  await vi.waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      "Service activation pass failed.",
      expect.stringContaining("recovery copy"),
    ),
  );
  expect(k.row()).toMatchObject({ copied: false });
  await o.nextPull();
  expect(o.host.drained("workspace")).toBe(false);
  const late = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  expect(late.text).toContain("Recipient text");
  expect(
    o.f.storage.confirmServiceKeptEditsCopy({
      workspaceId: "workspace",
      outboxId: "kept-outbox",
      generation: k.row()!.generation,
      checkpointDigest: late.digest,
    }),
  ).toBe(true);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(k.row()).toBeNull();
});

async function rotatedServiceHost() {
  const o = await enrolledServiceHost(),
    k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  expect(
    o.f.storage.rotateWorkspaceIdentity({
      workspaceId: "workspace",
      ownerUserId: "owner",
      replicationEpoch: "epoch-2",
      streamIdentity: "stream-2",
      rotatedAtMs: 10,
    }),
  ).toBe("rotated");
  (o.f.config as unknown as { activation: { pollIntervalMs: number } }).activation.pollIntervalMs =
    60_000;
  await o.f.save();
  const restarted = await startServiceLiveHost({
    ...o.f,
    frameChanges: createNamedFrameChanges(16),
  });
  cleanup.push(() => restarted.close());
  const earlier = k.row()!,
    root = join(o.f.root, "earlier-store");
  const closes = () =>
    k.engine("liveApplication.closeRecoveryStore").map((request) => request.workspace);
  return {
    ...o,
    k,
    restarted,
    earlier,
    root,
    closes,
    read: (kept = earlier, store = root) => restarted.readKeptEditsPage(kept, undefined, store),
  };
}

it("reads an earlier store's kept edits through one recovery handle, and closes it after the last copy", async () => {
  const o = await enrolledServiceHost(),
    k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  k.other("second-outbox", false);
  const older = { replicationEpoch: "epoch-0", streamIdentity: "stream-0" };
  o.f.storage.recordServiceKeptEdits({
    identity: older,
    outboxId: "kept-outbox",
    binding: o.binding,
    reason: "invalid-update",
    headDeliveryId: "refused",
    refusalKey: "older",
    nowMs: 1,
  });
  expect(
    o.f.storage.rotateWorkspaceIdentity({
      workspaceId: "workspace",
      ownerUserId: "owner",
      replicationEpoch: "epoch-2",
      streamIdentity: "stream-2",
      rotatedAtMs: 10,
    }),
  ).toBe("rotated");
  const restarted = await startServiceLiveHost({
    ...o.f,
    frameChanges: createNamedFrameChanges(16),
  });
  cleanup.push(() => restarted.close());
  const rotatedRoot = join(o.f.root, "workspace-rotated");
  await mkdir(rotatedRoot);
  await restarted.update({
    workspaces: [
      {
        ...o.workspace,
        root: rotatedRoot,
        hostedReplication: {
          ...o.workspace.hostedReplication!,
          identity: { replicationEpoch: "epoch-2", streamIdentity: "stream-2" },
        },
      },
    ],
    documents: [],
    departing: [o.sibling],
  });
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true));
  const [earlierRoot, olderRoot] = [join(o.f.root, "earlier-store"), join(o.f.root, "older-store")];
  const row = (outboxId: string, identity = k.identity) =>
    o.f.storage.readServiceKeptEdits({ workspaceId: "workspace", identity, outboxId })!;
  const store = async (kept: ReturnType<typeof row>, root: string, signal?: AbortSignal) => {
    const header = (await restarted.readKeptEditsPage(kept, undefined, root, signal)) as {
      kind: string;
      snapshot: string;
    };
    expect(header).toMatchObject({ kind: "page", part: "header" });
    const entry = (await restarted.readKeptEditsPage(
      kept,
      { snapshot: header.snapshot, part: "entryHeader", sequence: 1, offset: 0 },
      root,
      signal,
    )) as { bytesBase64: string };
    return (
      JSON.parse(Buffer.from(entry.bytesBase64, "base64").toString("utf8")) as { appendKey: string }
    ).appendKey;
  };
  const reads = k.engine("ydoc.ownerOutbox.readPending").length;
  expect(await store(row("kept-outbox"), earlierRoot)).toBe(earlierRoot);
  expect(await store(row("second-outbox"), earlierRoot)).toBe(earlierRoot);
  expect(k.engine("liveApplication.openRecoveryStore").map((request) => request.params)).toEqual([
    { root: earlierRoot, workspaceId: "workspace", ...k.identity },
  ]);
  expect(
    k
      .engine("ydoc.ownerOutbox.readPending")
      .slice(reads)
      .map((request) => request.workspace),
  ).toEqual(["recovery-1", "recovery-1", "recovery-1", "recovery-1"]);
  for (const outboxId of ["kept-outbox", "second-outbox"]) {
    expect(
      o.f.storage.confirmServiceKeptEditsCopy({
        workspaceId: "workspace",
        outboxId,
        generation: row(outboxId).generation,
        checkpointDigest: null,
      }),
    ).toBe(true);
    await restarted.releaseKeptEditsStore(row(outboxId));
    expect(
      k.engine("liveApplication.closeRecoveryStore").map((request) => request.workspace),
    ).toEqual(outboxId === "kept-outbox" ? [] : ["recovery-1"]);
  }
  expect(o.recoveryStores.size).toBe(0);
  expect(await store(row("kept-outbox"), earlierRoot)).toBe(earlierRoot);
  expect(await store(row("kept-outbox", older), olderRoot)).toBe(olderRoot);
  expect(
    k.engine("liveApplication.closeRecoveryStore").map((request) => request.workspace),
  ).toEqual(["recovery-1", "recovery-2"]);
  expect([...o.recoveryStores.values()]).toEqual([{ root: olderRoot, handle: "recovery-3" }]);
  const abandoned = new AbortController(),
    parked = o.park("ydoc.ownerOutbox.readPending");
  const reading = restarted
    .readKeptEditsPage(row("kept-outbox", older), undefined, olderRoot, abandoned.signal)
    .catch(() => undefined);
  await parked.entered.promise;
  abandoned.abort();
  parked.release.resolve();
  await reading;
  expect(
    k.engine("liveApplication.closeRecoveryStore").map((request) => request.workspace),
  ).toEqual(["recovery-1", "recovery-2", "recovery-3"]);
  expect(o.recoveryStores.size).toBe(0);
  expect(
    k
      .engine("ydoc.ownerOutbox.readPending")
      .slice(reads)
      .some((request) => request.workspace === "attached-handle"),
  ).toBe(false);
});

it("opens no earlier store for a read whose refusal changed while it waited", async () => {
  const r = await rotatedServiceHost();
  await expect(r.read({ ...r.earlier, generation: r.earlier.generation + 1_000 })).resolves.toEqual(
    { kind: "readChanged" },
  );
  expect(r.k.engine("liveApplication.openRecoveryStore")).toEqual([]);
});

it("leaves an accepted edit the engine never applied unapplied, and retires through the earlier tip", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const seed = o.tip();
  o.lost.pending = true;
  const edit = o.acceptEdit("unapplied");
  await vi.waitFor(() => expect(o.client().sendLiveApplication).toHaveBeenCalled());
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.applied.has(edit.deliveryId)).toBe(false);
  expect(retiredRow(o).boundary.terminalReceipt).toEqual(seed);
  expect(retiringSettles(o, sent).at(-1)).toEqual([
    "liveApplication.settle",
    {
      retirement: expect.objectContaining({ acceptedThrough: edit.journalCursor }),
      terminalReceipt: seed,
    },
  ]);
  expect(o.ownerCalls().slice(sent).at(-1)).toEqual([
    "liveApplication.releaseActivation",
    expect.objectContaining({ acceptedThrough: edit.journalCursor }),
  ]);
});

// Proves: a departed delivery needs neither live authority nor the connection
// that adopted it, only one with standing now. It records only the host's ACK
// of the next row the journal accepted, whole, under the same adoption and
// binding, and an ACK of the tip again changes nothing.
it("records a departed application only as the next accepted row, for its adoption, on a connection with standing", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const seed = o.tip();
  o.lost.replies = true;
  const edit = o.acceptEdit("stored");
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
  await o.host.close();
  o.stop();
  const register = (connectionId: string) => {
    const host = { ...o.host.coordinate, connectionId };
    expect(
      o.f.storage.registerLiveHost({
        ...host,
        updatedAtMs: Date.now(),
        guard: o.f.storage.captureStanding(),
      }).ok,
    ).toBe(true);
    return host;
  };
  const host = register("departure"),
    store = o.f.storage.createLiveCommittedDeliveryStore(o.f.history);
  const input = { host, document: o.document, adoptionId: `ordinary-activation-${"a".repeat(64)}` };
  expect(store.departedOwnerDelivery(input)).toEqual({ binding: o.binding, tip: seed, next: edit });
  const ack = { ...edit, localYDocSequence: 3, applicationReplayed: true };
  const record =
    (value: unknown, overrides: Partial<typeof input & { binding: typeof o.binding }> = {}) =>
    () =>
      store.recordDepartedApplication({ ...input, binding: o.binding, ...overrides }, value);
  const damaged = "Committed delivery evidence is damaged or conflicts.";
  for (const wrong of [
    { journalCursor: edit.journalCursor + 1 },
    { acceptingHostEpoch: edit.acceptingHostEpoch + 1 },
    { updateDigest: "f".repeat(64) },
    { deliveryId: "another" },
  ]) {
    expect(record({ ...ack, ...wrong })).toThrow(damaged);
  }
  expect(record(ack, { adoptionId: `ordinary-activation-${"b".repeat(64)}` })).toThrow(damaged);
  expect(
    record(ack, {
      binding: { ...o.binding, restoreFenceGeneration: o.binding.restoreFenceGeneration + 1 },
    }),
  ).toThrow(damaged);
  expect(record(ack, { host: { ...host, connectionId: "another" } })).toThrow(
    "Committed delivery stale-session.",
  );
  expect(o.tip()).toEqual(seed);
  expect(record(ack)()).toEqual({ binding: o.binding, tip: edit, next: null });
  expect(record(ack)()).toEqual({ binding: o.binding, tip: edit, next: null });
  expect(record({ ...ack, localYDocSequence: 4 })).toThrow(damaged);
  expect(
    record({ ...ack, deliveryId: "unaccepted", journalCursor: edit.journalCursor + 1 }),
  ).toThrow(damaged);
  expect(o.tip()).toEqual(edit);
  const replacement = register("replacement");
  expect(store.departedOwnerDelivery({ ...input, host: replacement })).toEqual({
    binding: o.binding,
    tip: edit,
    next: null,
  });
  expect(() => store.departedOwnerDelivery(input)).toThrow("Committed delivery stale-session.");
});

// Proves: a retirement resumes after its daemon stops at any point, from its
// durable obligation alone: before the engine reconciled it, after it settled,
// after the engine released it, or after the relay retired it. A released
// activation's release replays its boundary, and a retired one needs nothing more.

// Proves: deleting the last Edit share cuts off admission at once, as Stop
// does, while the owner's frame session is open and a drain waits in the
// engine. The session's next frame, an owner edit prepared before the
// deletion, and the drain all admit nothing. The edit the host applied before
// it settles, the document leaves and its workspace drains.
it("admits nothing after the last Edit share is deleted while a drain waits, and settles what the host applied before", async () => {
  const o = await enrolledServiceHost({ frameChanges: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const session = captureOwnerLiveFrameHost({
    authenticatedUserId: "owner",
    storage: o.f.storage,
    native: await o.host.captureNative(o.binding),
    validate: o.validateJournal,
    bounds: {
      maxClientVectorBytes: 1_000,
      maxSyncOutputBytes: 10_000,
      maxAppliedUpdateBytes: 10_000,
      maxSubmissionBytes: 10_000,
      maxAdmissionBytes: 100_000,
    },
  });
  const edit = o.acceptEdit("before");
  await expect(o.host.drain(o.document)).resolves.toMatchObject({ kind: "done" });
  expect(o.tip()).toEqual(edit);
  const late = o.prepareEdit("after"),
    parked = o.park("liveApplication.ownerState"),
    held = o.host.drain(o.document);
  await parked.entered.promise;
  expect(o.f.storage.revokeShare("share", 30)).toBe(true);
  expect(late().result).toEqual({ kind: "refused", reason: "authority-refused" });
  const frame = Buffer.from("frame");
  await expect(
    session.submit(
      { deliveryId: "frame-after", updateDigest: sha256(frame), updateBytes: frame },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Named host standing changed.");
  expect(session.invalidated.aborted).toBe(true);
  parked.release.resolve();
  await expect(held).rejects.toThrow("Service document activation is incomplete.");
  const cut = o.f.storage.readLiveUpdateJournalCut({ document: o.document }),
    applications = o.client().sendLiveApplication.mock.calls.length;
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.retiredTip()).toEqual(edit);
  expect(
    o
      .ownerCalls()
      .filter(([method]) => method === "liveApplication.settle")
      .at(-1),
  ).toEqual([
    "liveApplication.settle",
    {
      retirement: expect.objectContaining({
        activationId: ACTIVATION,
        acceptedThrough: edit.journalCursor,
      }),
      terminalReceipt: edit,
    },
  ]);
  expect(o.f.storage.readLiveUpdateJournalCut({ document: o.document })).toEqual(cut);
  expect(o.client().sendLiveApplication).toHaveBeenCalledTimes(applications);
});

it("activates a retired activation's successor after Resume, which admits edits only once it completed", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const tip = o.tip(),
    actor = { kind: "owner" as const, userId: "owner" };
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  o.engine.capture = {
    ...o.engine.capture,
    activationId: SUCCESSOR,
    source: { ...o.engine.capture.source, predecessorActivationId: ACTIVATION },
  };
  o.engine.adoption = { activationId: SUCCESSOR, throughCursor: null };
  const complete = ServiceActivationStore.prototype.complete,
    seen: unknown[] = [];
  vi.spyOn(ServiceActivationStore.prototype, "complete").mockImplementation(function (
    this: ServiceActivationStore,
    input,
  ) {
    seen.push([
      o.host.isDocumentReady(o.document),
      o.f.storage.resolveCurrentLiveDocumentBinding({ document: o.document, actor }).kind,
    ]);
    return complete.call(this, input);
  });
  o.f.storage.ensureOwnedLiveDocument({
    intent: "owner-resume",
    workspaceId: "workspace",
    ownerUserId: "owner",
    path: o.sibling.path,
    nowMs: 40,
    guard() {},
  });
  await o.host.update({ workspaces: [o.workspace], documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(seen).toEqual([[false, "refused"]]);
  expect(o.client().captureOwnerActivation).toHaveBeenLastCalledWith(
    expect.anything(),
    "docs/a.md",
    1_000_000,
    expect.any(AbortSignal),
    undefined,
  );
  expect(
    o.raw
      .prepare(
        "SELECT activation_id,predecessor_activation_id,completion_json IS NOT NULL AS completed FROM sync_relay_service_activations ORDER BY rowid",
      )
      .all(),
  ).toEqual([
    { activation_id: ACTIVATION, predecessor_activation_id: null, completed: 1 },
    { activation_id: SUCCESSOR, predecessor_activation_id: ACTIVATION, completed: 1 },
  ]);
  expect(o.client().sendLiveOwnerAdoption).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ adoptionId: SUCCESSOR, terminalReceipt: tip, events: [] }),
    expect.anything(),
    expect.any(AbortSignal),
  );
  expect(o.acceptEdit("after")).toMatchObject({ journalCursor: tip.journalCursor + 1 });
});

// Proves: a session host may still hold the copy it had at Stop, ready but
// missing what the owner wrote while live editing was off. After Resume, the
// successor's pass pulls the hosted feed before it captures, so the successor
// starts from the feed, never from that copy. The two-daemon e2e can't hold
// the host's copy ready across Stop, so it relies on this test.

type Enrolled = Awaited<ReturnType<typeof enrolledServiceHost>>;
const unansweredAfter = (o: Enrolled, method: string, count: number) => {
  const reached = deferred<void>(),
    send = o.client().sendRequest,
    through = send.getMockImplementation()! as (...values: unknown[]) => Promise<unknown>;
  let seen = 0;
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { method: string },
      signal = args[1] as AbortSignal;
    if (request.method !== method || ++seen <= count) return through(...args) as never;
    reached.resolve();
    return new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  });
  return reached.promise;
};
const restartedHost = async (o: Enrolled) => {
  const host = await startServiceLiveHost({ ...o.f, frameChanges: createNamedFrameChanges(16) });
  cleanup.push(() => host.close());
  await o.depart(host);
  return host;
};
const waiting = (reason: string) => [
  "Service activation pass failed.",
  `ServerLogError: Departing live document is waiting: ${reason}`,
];

const moveAway = (o: Enrolled) => {
  const at = o.f.storage.objectIdAtPathInVersion.bind(o.f.storage);
  vi.spyOn(o.f.storage, "objectIdAtPathInVersion").mockImplementation((input) =>
    input.path === o.sibling.path ? "another-object" : at(input),
  );
};
// The current daemon's engine requests that reconcile, release or unload a leaving document. Each daemon has its own client, so these start at its spawn.
const leaving = (o: Enrolled) =>
  o
    .calls(0)
    .filter(
      (method) =>
        method === "liveApplication.reconcileActivation" ||
        method === "liveApplication.releaseActivation" ||
        method === "liveApplication.unloadDocument",
    );
const retirementKey = (o: Enrolled) => {
  const open = readServiceActivationRetirement(o.f.storage as StorageContext, o.document)!;
  return {
    objectId: open.objectId,
    lineageClaimId: open.lineageClaimId,
    activationId: open.activationId,
    restoreFenceGeneration: open.restoreFenceGeneration,
    acceptedThrough: open.acceptedThrough,
  };
};

// Another Edit grant on the share, which keeps the document covered once the restore revokes the fixture's grant.
const anotherEditGrant = (o: Enrolled) =>
  o.raw
    .exec(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,
  created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('editor-grant','share','user','editor',NULL,'edit',1,'active',0,NULL,NULL)`);
// The owner's restore fences the document. The document then moves from its
// enrolled path, and the host restarts, with `replacement` hosted at the old
// path when it is given. Unless `covered` leaves the document covered by
// another Edit grant, or `live` leaves the owner's live session the restore
// kept, each with no retirement open, the owner's Pause after the restore
// began opens its retirement. `paused` has another Edit grant cover it too,
// so the restore's revocation keeps nothing.
// `kept` first records an edit the server refused. Unless `stopped` is false,
// the restore's first step runs before the restart. `pending` has the relay
// accept an edit after the adoption cut that no activation pass delivers.
// `admitted` has the relay admit the restore before the document moves, and
// configures restore preparation on the restarted host. With `polls`, the
// restarted host runs passes only when it wakes itself, or the test runs one,
// as its first passes here.
const movedDuringRestore = async ({
  replacement = false,
  paused = false,
  covered = false,
  live = false,
  kept = false,
  stopped = true,
  pending = false,
  admitted = false,
  polls = undefined as ReturnType<typeof heldPolls> | undefined,
} = {}) => {
  const o = await enrolledServiceHost(),
    k = kept ? keptEdits(o) : undefined;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const restoring = waiting("Waiting for its restore to finish.");
  const passed = async (held = false) => {
    if (held)
      await polls!.until(o.f, () =>
        log.mock.calls.some((call) => call[0] === restoring[0] && call[1] === restoring[1]),
      );
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...restoring));
  };
  if (paused || covered) anotherEditGrant(o);
  if (pending) {
    o.passes.deliver = false;
    o.acceptEdit("pending");
  }
  o.beginRestore();
  if (!covered && !live) {
    o.f.storage.setServiceHostEnrollmentEnabled({
      workspaceId: "workspace",
      path: o.sibling.path,
      ownerUserId: "owner",
      enabled: false,
      nowMs: 60,
      guard() {},
    });
    await o.depart();
    await passed();
  } else expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  if (stopped)
    await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({
      kind: "pending",
      reason: "native-fence-pending",
    });
  const admission = admitted ? await admitMovedRestore(o) : undefined;
  await o.host.close();
  log.mockClear();
  o.passes.deliver = true;
  if (admitted) {
    Object.assign(o.f.config, { restore: RESTORE });
    await o.f.save();
  }
  if (polls) {
    const config = o.f.config as unknown as { activation: Record<string, unknown> };
    config.activation = { ...config.activation, pollIntervalMs: HELD_POLL_MS };
    await o.f.save();
  }
  moveAway(o);
  const other = { ...o.sibling, objectId: "another-object" };
  let driver: ServiceActivationDriver | undefined;
  const addTarget = ServiceActivationDriver.prototype.addTarget;
  vi.spyOn(ServiceActivationDriver.prototype, "addTarget").mockImplementation(function (
    this: ServiceActivationDriver,
    ...args
  ) {
    driver = this;
    return addTarget.apply(this, args);
  });
  if (replacement) o.refuseCaptureAt(o.sibling.path, new Error("Replacement capture refused."));
  const host = replacement
    ? await startServiceLiveHost({ ...o.f, frameChanges: createNamedFrameChanges(16) })
    : await restartedHost(o);
  if (replacement) {
    cleanup.push(() => host.close());
    await host.update({ workspaces: [o.workspace], documents: [other], departing: [o.sibling] });
  }
  await passed(polls !== undefined);
  expect(leaving(o)).toEqual([]);
  expect(host.retains(o.sibling)).toBe(true);
  expect(host.drained("workspace")).toBe(false);
  return { o, host, other, log, k, admission, driver: () => driver };
};
const RESTORE = {
  maxBytes: 1_000_000,
  maxEvents: 10,
  aggregateBytes: 17_000_000,
  workingReserveBytes: 1_000_000,
  maxOperations: 1,
  validation: restorePolicy,
};
const jsonHash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
const admitMovedRestore = async (o: Enrolled) => {
  const before = retirementKey(o);
  return { proposalDigest: await admitRestore(o), before };
};
const admitRestore = async (o: Enrolled) => {
  const store = o.f.storage.createLiveCommittedDeliveryStore(o.f.history);
  const input = {
    ...stopLookup,
    host: o.host.coordinate,
    maxBytes: RESTORE.maxBytes,
    maxEvents: RESTORE.maxEvents,
  };
  const fence = {
    operation: store.pendingStopRestoreFence(input).operation,
    localHeadSequence: 11,
    recordedAtMs: 100,
  };
  store.acknowledgeStopRestoreFence(input, fence);
  const selected = store.captureStopRestorePoint(input),
    accepted = store.captureStopRestoreAcceptedCut(input);
  const point = new Y.Doc({ gc: false }),
    head = new Y.Doc({ gc: false });
  let encoded: Uint8Array;
  try {
    Y.applyUpdate(point, selected.checkpoint.bytes);
    for (const e of selected.events) Y.applyUpdate(point, e.updateBytes);
    Y.applyUpdate(head, accepted.checkpoint.bytes);
    for (const e of accepted.events) Y.applyUpdate(head, e.updateBytes);
    const frozen = Y.encodeStateAsUpdate(head),
      pointBytes = Y.encodeStateAsUpdate(point),
      vector = Y.encodeStateVector(head);
    const used = Y.decodeStateVector(vector);
    let client = 1;
    while (used.has(client)) client++;
    head.clientID = client;
    head.transact(() => {
      const body = head.getXmlFragment("body");
      body.delete(0, body.length);
      body.insert(
        0,
        point
          .getXmlFragment("body")
          .toArray()
          .map((node) => {
            if (!(node instanceof Y.XmlElement || node instanceof Y.XmlText))
              throw new Error("Unexpected fixture body.");
            return node.clone();
          }),
      );
      const fields = head.getMap("frontmatter");
      for (const key of fields.keys()) fields.delete(key);
      for (const [key, value] of point.getMap("frontmatter").entries())
        fields.set(key, structuredClone(value));
    });
    const candidate = Y.encodeStateAsUpdate(head, vector);
    const validated = createLiveMarkdownJournalValidator(restorePolicy)({
      document: o.document,
      currentPath: selected.binding.currentPath,
      checkpoint: frozen,
      suffix: [],
      candidate,
    });
    if (validated.kind !== "accepted") throw new Error(validated.reason);
    const receipt = {
      fence,
      point: resolveLiveRestorePoint(selected, restorePolicy),
      candidateDigest: sha256(candidate),
      frozenStateDigest: sha256(frozen),
      pointStateDigest: sha256(pointBytes),
      finalContentDigest: "d".repeat(64),
      beforeStateVector: [...vector],
      afterStateVector: [...Y.encodeStateVector(head)],
      replacementRanges: [...validated.evidence.candidate.ranges],
      originEvidenceDigest: store.captureStopRestoreOwnerOrigin(input).evidenceDigest,
      selectedHistory: selected.proof,
      acceptedHistory: accepted.proof,
      nativeSources: [],
      nativeSourceManifestDigest: jsonHash([fence, []]),
    };
    encoded = encodeNativeRestoreProposal(
      JSON.stringify(receipt),
      {
        candidateBytes: candidate,
        frozenStateBytes: frozen,
        pointStateBytes: pointBytes,
        nativeSourceBytes: [],
      },
      input,
    );
  } finally {
    point.destroy();
    head.destroy();
  }
  const { proposalDigest } = await store.recordStopRestoreProposal(
    input,
    encoded,
    restoreValidation,
    200,
  );
  await store.admitStopRestoreProposal(input, proposalDigest, restoreValidation, 201);
  return proposalDigest;
};
// The engine's side of the admitted restore's end, on `host`, after the
// document moved. It answers apply, settle and resume from the admission the
// relay holds. `publish` appends the restore's settlement, as the retiring
// host's push does, which the retirement waits for.
const restoreEngine = (o: Enrolled, host: Awaited<ReturnType<typeof startServiceLiveHost>>) => {
  const store = o.f.storage.createLiveCommittedDeliveryStore(o.f.history),
    coordinate = host.coordinate;
  const input = {
    ...stopLookup,
    host: coordinate,
    maxBytes: RESTORE.maxBytes,
    maxEvents: RESTORE.maxEvents,
  };
  const hostCoordinate = {
    hostId: coordinate.hostId,
    hostEpoch: coordinate.hostEpoch,
    instanceId: coordinate.instanceId,
    connectionId: coordinate.connectionId,
  };
  const admission = () => {
    const lifecycle = store.readStopRestoreLifecycle(input);
    if (!lifecycle) throw new Error("Missing restore admission.");
    return lifecycle;
  };
  // The engine's receipts, as admitRestore in liveRestoreDrain.test.ts builds them. The settlement
  // counts only the restore's own application: this journal holds fewer rows than that test's three.
  const answer = (operation: string) => {
    const { preparation, candidateDigest, nativeSourceManifestDigest, admitted } = admission(),
      localHeadSequence = preparation.fence.localHeadSequence + 1;
    const settlementId = "restore-settlement",
      momentId = "restore-moment",
      markdownDigest = preparation.point.markdownDigest;
    if (operation === "apply")
      return {
        fence: preparation.fence,
        candidateDigest,
        nativeSourceManifestDigest,
        admitted,
        localHeadSequence,
        hostCoordinate,
        recordedAtMs: 202,
      };
    if (operation === "settle")
      return {
        settlementId,
        previousCursor: 0,
        terminalCursor: admitted.accepted.receipt.journalCursor,
        applicationCount: 1,
        localYDocSequence: localHeadSequence,
        momentId,
        markdownDigest,
        materialized: true,
        collectionReconcileRequired: false,
      };
    return {
      relayDatabaseNamespace: preparation.fence.operation.relayDatabaseNamespace,
      operationId: stopLookup.operationId,
      binding: admitted.accepted.binding,
      applicationReceipt: admitted.accepted.receipt,
      settlementId,
      momentId,
      markdownDigest,
      localHeadSequence,
      recordedAtMs: 204,
    };
  };
  const sendLiveRestore = vi.fn(async (_request: unknown, operation: string) => ({
    bytes: Buffer.from(JSON.stringify(answer(operation))),
  }));
  Object.assign(o.client(), { sendLiveRestore });
  const publish = async () => {
    const { admitted } = admission(),
      document = o.document,
      terminal = admitted.accepted.receipt.journalCursor,
      binding = { ...admitted.accepted.binding };
    const row = o.raw
      .prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?")
      .get(terminal)!;
    const bytes = row.validation_checkpoint_bytes as Uint8Array;
    const normalized = createLiveMarkdownRegistrationValidator(restorePolicy)({
      document,
      currentPath: binding.currentPath,
      checkpoint: bytes,
    });
    if (normalized.kind !== "accepted") throw new Error(normalized.reason);
    const markdown = Buffer.from(normalized.evidence.projectedMarkdown),
      markdownDigest = sha256(markdown),
      stateDigest = sha256(bytes);
    for (const [digest, content] of [
      [stateDigest, bytes],
      [markdownDigest, markdown],
    ] as const)
      o.f.storage.putBlob({
        workspaceId: document.workspaceId,
        sha256: digest,
        content,
        createdAtMs: 1,
      });
    const before = String(
      o.raw
        .prepare(
          "SELECT baseline_projected_sha256 FROM sync_relay_live_documents WHERE object_id=?",
        )
        .get(document.objectId)!.baseline_projected_sha256,
    );
    const namespace = String(row.relay_database_namespace),
      key = [
        namespace,
        document.workspaceId,
        document.mainVersionId,
        document.objectId,
        document.lineageClaimId,
      ];
    const acceptedEventCount = Number(row.accepted_event_count);
    const record = {
      settlementId: "",
      relayDatabaseNamespace: namespace,
      binding,
      hostCoordinate,
      previousCursor: 0,
      terminalCursor: terminal,
      previousYdocSequence: 0,
      localYdocSequence: 1,
      applicationCount: acceptedEventCount,
      nativeIntervalDigest: sha256(Buffer.from("native-interval-restore")),
      acceptedEventCount,
      acceptedIntervalDigest: jsonHash([
        "live-settlement-accepted-interval-v1",
        key,
        [0, 0, initialAcceptedHistoryDigest(namespace, document)],
        [acceptedEventCount, terminal, row.accepted_evidence_digest],
      ]),
      momentId: "restore-publication",
      markdownDigest,
      sourceStateVectorDigest: sha256(Buffer.from("state-vector-restore")),
      acceptedStateBlobSha256: stateDigest,
      recordedAtMs: 1,
      restoreOperationId: null,
    };
    record.settlementId = nativeSettlementId(record);
    const payload = {
      momentId: record.momentId,
      objectId: document.objectId,
      versionId: "main",
      path: binding.currentPath,
      operation: "write",
      payloadBeforePath: binding.currentPath,
      payloadAfterPath: binding.currentPath,
      payloadBeforeContentKind: "text",
      payloadAfterContentKind: "text",
      payloadBeforeBlobSha256: before,
      payloadAfterBlobSha256: markdownDigest,
      payloadAfterByteLength: markdown.byteLength,
      recordedAtMs: 1,
      settlementReference: {
        formatVersion: 1,
        recordDigest: settlementRecordDigest(record),
        record,
      },
    };
    const op = {
      originSeq: 0,
      opKind: "moment.append",
      payloadJson: stableJsonStringify(payload),
      recordedAtMs: 1,
    };
    await prepareHostedSettlements(o.f.storage as StorageContext, {
      workspaceId: "workspace",
      originId: "proof",
      ops: [op],
    });
    expect(op).toMatchObject({ settlementAdmission: { status: "accepted" } });
    expect(
      o.f.storage.appendLogBatch({ workspaceId: "workspace", originId: "proof", ops: [op] }),
    ).toMatchObject({ inserted: 1 });
  };
  return { sendLiveRestore, publish };
};

// Proves: a moved document's restore that the relay admitted, which no Decline
// can end, completes through the restarted host's route: the relay admitted it
// before the move, and the restarted host records each engine step through
// resume. Once the restore's settlement
// is published, its retirement runs at the key the admission left, not the one
// before it, and completes, and the route ends.
it("completes a moved document's admitted restore through a restarted host, then retires it", async () => {
  const { o, host, admission } = await movedDuringRestore({ admitted: true });
  const { proposalDigest, before } = admission!,
    { sendLiveRestore, publish } = restoreEngine(o, host);
  const complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement");
  await expect(host.completeRestore(stopLookup, proposalDigest)).resolves.toMatchObject({
    kind: "resumed",
    proposalDigest,
  });
  expect(sendLiveRestore.mock.calls.map((call) => call[1])).toEqual(["apply", "settle", "resume"]);
  expect(o.f.storage.readStopRestore(stopLookup)?.phase).toBe("resumed");
  const moved = retirementKey(o);
  expect(moved.acceptedThrough).toBeGreaterThan(before.acceptedThrough);
  expect(retiredRow(o).retired).toBe(false);
  await publish();
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), { timeout: 10_000 });
  expect(retiredRow(o).retired).toBe(true);
  expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ key: moved }));
  expect(complete).not.toHaveBeenCalledWith(expect.objectContaining({ key: before }));
  // The retirement may settle again on each pass that waited for the settlement.
  const settles = retiringSettles(o, 0).map(
    ([, params]) => (params as { retirement: unknown }).retirement,
  );
  expect(settles.length).toBeGreaterThan(0);
  expect(settles).toEqual(settles.map(() => moved));
  expect(leaving(o)).toContain("liveApplication.releaseActivation");
  expect(leaving(o)).not.toContain("liveApplication.unloadDocument");
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(host.retains(o.sibling)).toBe(false);
  await expect(host.completeRestore(stopLookup, proposalDigest)).rejects.toThrow(
    "Service restore source is unavailable.",
  );
});

const ownerCovers = (o: Enrolled) =>
  o.f.storage.serviceHostEnrollmentCovered({
    workspaceId: "workspace",
    objectId: "object",
    ownerUserId: "owner",
    shareId: "share",
    path: o.sibling.path,
  });
const activations = (o: Enrolled) =>
  o.raw
    .prepare("SELECT activation_id FROM sync_relay_service_activations ORDER BY rowid")
    .all()
    .map((row) => row.activation_id);
const ownerBinding = (o: Enrolled) =>
  o.f.storage.resolveCurrentLiveDocumentBinding({
    document: o.document,
    actor: { kind: "owner", userId: "owner" },
  });
const restoreRequest = (o: Enrolled) =>
  o.f.storage.readStopRestorePlan({
    document: o.document,
    ownerUserId: "owner",
    operationId: "restore",
    shareId: "share",
    grantId: "grant",
    restorePointCursor: 0,
    restorePointReceiptDigest: o.document.lineageClaimId,
    maxOutputBytes: 1_000_000,
  }).intent;
const usage = (o: Enrolled) =>
  Number(
    o.raw
      .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'")
      .get()!.usage_bytes,
  );
// The note's text in the relay's accepted journal, applied in order. The mocked engine applies no text, so this is not the native file's.
const journalText = (o: Enrolled) => {
  const read = o.f.storage.readLiveUpdateJournalCut({ document: o.document });
  if (read.kind !== "cut") throw new Error("Missing live journal.");
  const doc = new Y.Doc();
  for (const bytes of [read.cut.checkpoint.bytes, ...read.cut.suffix.map((row) => row.bytes)])
    Y.applyUpdate(doc, bytes);
  const text = yDocToMarkdown(doc);
  doc.destroy();
  return text;
};
const restoredText = (edit?: string) => {
  const doc = markdownToYDoc("Original");
  if (edit !== undefined) doc.getMap("frontmatter").set("edit", edit);
  const text = yDocToMarkdown(doc);
  doc.destroy();
  return text;
};
// Closes the relay database and opens the same file again, as a relay restart does. The fixture's closures read `o.f`, so they use the reopened store.
const reopenRelay = (o: Enrolled) => {
  o.f.closeStorage();
  const reopened = openRelayDeployment(join(o.f.root, "deployment.json"));
  let closed = false;
  const closeStorage = () => {
    if (!closed) {
      reopened.storage.close();
      closed = true;
    }
  };
  cleanup.push(async () => closeStorage());
  Object.assign(o.f, { ...reopened, closeStorage });
};
const hostingAgain = async (
  o: Enrolled,
  previous: Awaited<ReturnType<typeof startServiceLiveHost>>,
) => {
  await previous.close();
  reopenRelay(o);
  Object.assign(o.f.config, { restore: RESTORE });
  await o.f.save();
  const host = await startServiceLiveHost({ ...o.f, frameChanges: createNamedFrameChanges(16) });
  cleanup.push(() => host.close());
  await host.update({ workspaces: [o.workspace], documents: [o.sibling], ...stay });
  return host;
};
const ownerEditsAgain = async (
  o: Enrolled,
  host: Awaited<ReturnType<typeof startServiceLiveHost>>,
  fence: number,
) => {
  await vi.waitFor(() => expect(host.isDocumentReady(o.document)).toBe(true), { timeout: 10_000 });
  expect(activations(o)).toEqual([ACTIVATION]);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(ownerBinding(o)).toMatchObject({
    kind: "current",
    binding: { restoreFenceGeneration: fence },
  });
  expect(
    o.f.storage.resolveCurrentLiveDocumentBinding({
      document: o.document,
      actor: { kind: "named", userId: "reader", grantId: "grant" },
    }).kind,
  ).toBe("refused");
  expect(o.f.storage.getShareGrant("grant")).toMatchObject({ status: "revoked" });
};
const delivered = (o: Enrolled) =>
  o
    .client()
    .sendLiveApplication.mock.calls.map(
      ([, event]) =>
        (event as { metadata: { accepted: { receipt: { deliveryId: string } } } }).metadata.accepted
          .receipt.deliveryId,
    );
const editOnce = async (
  o: Enrolled,
  host: Awaited<ReturnType<typeof startServiceLiveHost>>,
  value: string,
) => {
  const edit = o.acceptEdit(value, host.coordinate);
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true), { timeout: 10_000 });
  expect(await host.settle(o.document)).toMatchObject({
    terminalCursor: edit.journalCursor,
    materialized: true,
  });
  expect(
    o
      .ownerCalls()
      .filter(([method]) => method === "liveApplication.settle")
      .at(-1)?.[1],
  ).toMatchObject({
    terminalReceipt: { deliveryId: edit.deliveryId, journalCursor: edit.journalCursor },
  });
  expect(delivered(o).filter((id) => id === edit.deliveryId)).toHaveLength(1);
  expect(
    o.raw
      .prepare("SELECT count(*) AS count FROM sync_relay_live_update_journal WHERE delivery_id=?")
      .get(edit.deliveryId)!.count,
  ).toBe(1);
  expect(journalText(o)).toBe(restoredText(value));
};

// Proves: the owner keeps editing a note after restoring it, when the restore
// ended its last Edit grant. The restore keeps the owner's live session: its
// activation never retires and no successor starts. Once the restore resumed,
// that session registers at the restored fence, the relay's journal holds the
// restored text, and the owner's next edit is sent once and settled. A relay
// restart that reopens its database while the restore is unfinished, and
// another after it resumed, change none of this. A begin or a completion
// retried after a lost reply records and charges nothing more.
it("keeps the owner editing a note after restoring it, when the restore ended its last Edit grant", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fence = o.binding.restoreFenceGeneration + 1;
  const intent = () =>
    String(
      o.raw
        .prepare(
          "SELECT intent_json FROM sync_relay_live_restore_operations WHERE operation_id='restore'",
        )
        .get()!.intent_json,
    );
  const request = restoreRequest(o),
    begun = o.f.storage.beginStopRestore(request, 40),
    charged = usage(o),
    marked = intent();
  expect(o.f.storage.beginStopRestore(request, 40)).toEqual(begun);
  expect(usage(o)).toBe(charged);
  expect(intent()).toBe(marked);
  expect(
    o.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_restore_operations").get()!.count,
  ).toBe(1);
  expect(marked.split('"keptRun"')).toHaveLength(2);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(JSON.parse(marked)).toMatchObject({
    keptRun: { runToken: 10, ownerUserId: "owner", activationId: ACTIVATION },
  });
  expect(ownerCovers(o)).toBe(true);
  expect(ownerBinding(o).kind).toBe("refused");
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({
    kind: "pending",
    reason: "native-fence-pending",
  });
  const proposalDigest = await admitRestore(o);
  let host = await hostingAgain(o, o.host);
  expect(ownerCovers(o)).toBe(true);
  expect(activations(o)).toEqual([ACTIVATION]);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(true);
  const { publish } = restoreEngine(o, host);
  const resumed = await host.completeRestore(stopLookup, proposalDigest);
  expect(resumed).toMatchObject({ kind: "resumed", proposalDigest });
  const completed = usage(o),
    recorded = intent();
  expect(await host.completeRestore(stopLookup, proposalDigest)).toEqual(resumed);
  expect(usage(o)).toBe(completed);
  expect(intent()).toBe(recorded);
  expect(recorded.split('"keptRun"')).toHaveLength(2);
  await publish();
  await ownerEditsAgain(o, host, fence);
  const registered = o
    .ownerCalls()
    .filter(([method]) => method === "liveApplication.register")
    .map(([, params]) => params);
  expect(registered.at(-1)).toMatchObject({
    activationId: ACTIVATION,
    binding: { restoreFenceGeneration: fence },
  });
  expect(journalText(o)).toBe(restoredText());
  await editOnce(o, host, "after");
  host = await hostingAgain(o, host);
  await ownerEditsAgain(o, host, fence);
  expect(delivered(o)).not.toContain("edit-after");
  expect(journalText(o)).toBe(restoredText("after"));
  await editOnce(o, host, "again");
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
});

// Proves: a restore the owner declines, or cancels, ends the live session it
// kept. Ending it opens the retirement the restore's revocation skipped, at
// the fence the note is left at, and the relay refuses the owner's live
// editing. Once the host lets the note go, the activation retires.

// The retiring host's push of the restored note, which puts the restore in the relay's ordinary history. Returns the
// restored note's complete state.
const pushRestoredUpdate = (o: Enrolled) => {
  const ordinary = new Y.Doc({ gc: false }),
    restored = new Y.Doc({ gc: false });
  for (const bytes of [o.engine.capture.baselineBytes, o.engine.capture.fullState])
    Y.applyUpdate(ordinary, bytes);
  Y.applyUpdate(
    restored,
    o.raw
      .prepare(
        "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal ORDER BY journal_cursor DESC LIMIT 1",
      )
      .get()!.validation_checkpoint_bytes as Uint8Array,
  );
  const update = Buffer.from(Y.encodeStateAsUpdate(restored, Y.encodeStateVector(ordinary))),
    fullState = Buffer.from(Y.encodeStateAsUpdate(restored));
  ordinary.destroy();
  restored.destroy();
  o.raw
    .prepare(
      "INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)",
    )
    .run(sha256(update), update.length, update);
  o.raw
    .prepare(
      "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',3,'ydoc.update',?,3)",
    )
    .run(
      JSON.stringify({
        versionId: "main",
        objectId: "object",
        path: o.sibling.path,
        contentKind: "richdoc",
        isBaseState: false,
        lineageClaimId: o.document.lineageClaimId,
        updateBlobSha256: sha256(update),
      }),
    );
  return fullState;
};
// The note's first text, depth first.
const firstText = (node: Y.XmlFragment | Y.XmlElement): Y.XmlText | null => {
  for (const child of node.toArray()) {
    const found =
      child instanceof Y.XmlText ? child : child instanceof Y.XmlElement ? firstText(child) : null;
    if (found) return found;
  }
  return null;
};
// That push, and the successor's native capture after it: the restored state, sourced from the restore's settlement moment.

const restoredCapture = (o: Enrolled, fullState: Buffer): NativeOwnerActivation => {
  const moment = o.raw
    .prepare(
      "SELECT moment_id,blob_sha256,byte_length FROM sync_relay_object_moments WHERE moment_id='restore-publication'",
    )
    .get()!;
  const head = Number(
    o.raw.prepare("SELECT max(relay_seq) AS head FROM sync_relay_log").get()!.head,
  );
  return {
    ...o.engine.capture,
    activationId: SUCCESSOR,
    fullState,
    source: {
      ...o.engine.capture.source,
      predecessorActivationId: ACTIVATION,
      committedCursor: head,
      sourceMomentId: String(moment.moment_id),
      sourceDigest: String(moment.blob_sha256),
      sourceByteLength: Number(moment.byte_length),
      fullStateDigest: sha256(fullState),
      fullStateByteLength: fullState.length,
    },
  };
};

// The kind of the owner's binding through the pending successor's access,
// while its stored binding names `generation`. The row is put back before this returns.

// Proves: after a restore and Stop, the successor that Resume starts, whose source is the restore's settlement
// moment, reads from a checkpoint folded through that moment. Here the owner's ordinary history reached the restored
// text before the settlement, and a later save of the same text makes the settlement no longer the note's newest file
// moment, so the read proves the settlement. The checkpoint kept the projection of the history before the moment,
// which is the prefix a read from the base validates. Where the checkpoint no longer holds the projection of every
// history after the settlement, or no longer keeps the settlement, the read answers base.
it.each<{ after: string; steps: ("row" | "save")[]; read: "history" | "base" }>([
  { after: "a save", steps: ["save"], read: "history" },
  // More Y.Doc rows after the settlement than the checkpoint's tail keeps.
  {
    after: "a save and 33 Y.Doc rows",
    steps: ["save", ...Array<"row">(33).fill("row")],
    read: "base",
  },
  // A page that ended before a later moment kept the projection of its last row only.
  { after: "two Y.Doc rows and a save", steps: ["row", "row", "save"], read: "base" },
  // As many saves as the checkpoint keeps moments, so it no longer keeps the settlement.
  {
    after: `${CHECKPOINT_MOMENTS} saves`,
    steps: Array<"save">(CHECKPOINT_MOMENTS).fill("save"),
    read: "base",
  },
])(
  "reads a restored note's successor followed by $after from a checkpoint folded through the restore's settlement: $read",
  async ({ steps, read }) => {
    const o = await enrolledServiceHost({ supervised: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    o.beginRestore();
    o.f.storage.advanceStopRestoreFence(stopLookup, 50);
    await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({
      kind: "pending",
      reason: "native-fence-pending",
    });
    const proposalDigest = await admitRestore(o),
      { publish } = restoreEngine(o, o.host);
    await expect(o.host.completeRestore(stopLookup, proposalDigest)).resolves.toMatchObject({
      kind: "resumed",
      proposalDigest,
    });
    const restored = pushRestoredUpdate(o);
    await publish();
    await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true), {
      timeout: 10_000,
    });
    expect(
      preparedStop(o.f.storage, {
        workspaceId: "workspace",
        ownerUserId: "owner",
        path: o.sibling.path,
        enabled: false,
        retire: true,
        nowMs: 300,
        guard() {},
      }),
    ).toMatchObject({ enabled: false, retired: true });
    o.supervisor!.reconcile();
    await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true), { timeout: 10_000 });
    const capture = restoredCapture(o, restored),
      storage = o.f.storage as StorageContext;
    const settlement = Number(
      o.raw
        .prepare("SELECT relay_seq FROM sync_relay_object_moments WHERE moment_id=?")
        .get(capture.source.sourceMomentId)!.relay_seq,
    );
    // The owner's rows after the settlement: saves of the restored text, and Y.Doc rows that type a letter and take it
    // back, so the note's Markdown stays the restored text.
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, capture.fullState);
    const text = firstText(doc.getXmlFragment("body"))!;
    let originSeq = 4,
      cursor = 0;
    const append = (opKind: string, payload: Record<string, unknown>) => {
      o.raw
        .prepare(
          "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',?,?,?,4)",
        )
        .run(
          originSeq++,
          opKind,
          JSON.stringify({
            versionId: "main",
            objectId: "object",
            path: o.sibling.path,
            ...payload,
          }),
        );
      cursor = Number(
        o.raw.prepare("SELECT max(relay_seq) AS head FROM sync_relay_log").get()!.head,
      );
    };
    for (const step of steps) {
      if (step === "row") {
        const before = Y.encodeStateVector(doc);
        doc.transact(() => {
          text.insert(0, "x");
          text.delete(0, 1);
        });
        const update = Buffer.from(Y.encodeStateAsUpdate(doc, before));
        o.raw
          .prepare(
            "INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)",
          )
          .run(sha256(update), update.length, update);
        append("ydoc.update", {
          contentKind: "richdoc",
          isBaseState: false,
          lineageClaimId: o.document.lineageClaimId,
          updateBlobSha256: sha256(update),
        });
      } else {
        const momentId = `saved-after-resume-${originSeq}`;
        append("moment.append", {
          momentId,
          operation: "write",
          payloadAfterPath: o.sibling.path,
          payloadAfterContentKind: "text",
          payloadAfterBlobSha256: capture.source.sourceDigest,
          payloadAfterByteLength: capture.source.sourceByteLength,
        });
        o.raw
          .prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
        VALUES ('workspace','object',?,?,'main',?,?,'text',?,4)`)
          .run(
            cursor,
            momentId,
            o.sibling.path,
            capture.source.sourceDigest,
            capture.source.sourceByteLength,
          );
      }
    }
    const fullState = Buffer.from(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    const source = {
      ...capture.source,
      committedCursor: cursor,
      fullStateDigest: sha256(fullState),
      fullStateByteLength: fullState.length,
    };
    const scope = {
      namespace: source.relayDatabaseNamespace,
      document: o.document,
      replicationEpoch: source.replicationEpoch,
      streamIdentity: source.streamIdentity,
      base: {
        relaySeq: source.baseRelaySeq,
        originId: source.baseOriginId,
        originSeq: source.baseOriginSeq,
      },
      policySha256: checkpointPolicySha256(restorePolicy),
    };
    await expect(
      foldOrdinaryCheckpointPages(storage, {
        scope,
        pages: ORDINARY_FOLD_RUN_PAGES,
        nowMs: () => 500,
        validate: async (work) => validateOrdinaryActivation(work, restorePolicy),
        bounds: { pageRows: ORDINARY_FOLD_PAGE_ROWS, pageBytes: 1_000_000 },
      }),
    ).resolves.toMatchObject({ kind: "folded", reachedCursor: true });
    const folded = readOrdinaryCheckpoint(storage, scope)!;
    expect(folded.throughRelaySeq).toBe(source.committedCursor);
    expect(folded.moments.some((moment) => moment.relaySeq === settlement)).toBe(
      steps.filter((step) => step === "save").length < CHECKPOINT_MOMENTS,
    );
    const input = {
      source,
      document: o.document,
      baselineBytes: capture.baselineBytes,
      fullState,
      checkpoint: scope,
      bounds: { maxCaptureBytes: 1_000_000, maxHistoryEntries: 1_000, maxBytesPerDrain: 1_000_000 },
    };
    const found = readOrdinaryActivationHistory(storage, input);
    if (read === "base") return expect(found.kind).toBe("base");
    if (found.kind !== "history")
      throw new Error(`Expected a history read from the checkpoint, not ${found.kind}.`);
    expect(found.history).toMatchObject({
      from: 0,
      artifact: null,
      checkpoint: { throughRelaySeq: folded.throughRelaySeq },
    });
    expect(found.history.settled).not.toBeNull();
    const validation = validateOrdinaryActivation(
      {
        document: o.document,
        currentPath: source.currentPath,
        baselineBytes: capture.baselineBytes,
        cut: {
          source,
          fullState,
          history: found.history,
          maxBytesPerDrain: input.bounds.maxBytesPerDrain,
        },
      },
      restorePolicy,
    );
    if (validation.kind !== "accepted") throw new Error(validation.message);
    expect(() =>
      verifyOrdinaryActivationCut(storage, {
        ...input,
        history: found.history,
        baseline: validation.baseline,
        proof: validation.proof,
      }),
    ).not.toThrow();
  },
);

// Proves: the owner's restore is charged for the record it stores, and no
// more. A restore that keeps nothing fits in exactly the room it needs, and one
// byte less refuses it. Keeping the owner's live session adds only the bytes of
// its marker. A refused restore records nothing and leaves the Edit grant active.

const endLiveEditing = {
  unshare: (o: Enrolled) => expect(o.f.storage.revokeShare("share", 30)).toBe(true),
  pause: (o: Enrolled) =>
    o.f.storage.setServiceHostEnrollmentEnabled({
      workspaceId: "workspace",
      path: o.sibling.path,
      ownerUserId: "owner",
      enabled: false,
      nowMs: 30,
      guard() {},
    }),
  stop: (o: Enrolled) => o.stop(),
};
// The document moves while hosted, and `end` ends its live editing. Its daemon
// stops while the engine holds the retirement's reconciliation, and a fresh
// host starts with the retirement open, hosting `other` at the old path when
// `replacement` is set. Resolves once that host completed the retirement at
// the key it had when the first daemon stopped.
const movedRetirementAfterRestart = async (
  o: Enrolled,
  end: keyof typeof endLiveEditing,
  { replacement = false } = {},
) => {
  moveAway(o);
  const reached = unansweredAfter(o, "liveApplication.reconcileActivation", 0);
  endLiveEditing[end](o);
  await o.depart();
  await reached;
  const key = retirementKey(o);
  await o.host.close();
  expect(retiredRow(o).retired).toBe(false);
  const complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement");
  const other = { ...o.sibling, objectId: "another-object" };
  let driver: ServiceActivationDriver | undefined;
  const addTarget = ServiceActivationDriver.prototype.addTarget;
  vi.spyOn(ServiceActivationDriver.prototype, "addTarget").mockImplementation(function (
    this: ServiceActivationDriver,
    ...args
  ) {
    driver = this;
    return addTarget.apply(this, args);
  });
  let host;
  if (replacement) {
    o.refuseCaptureAt(o.sibling.path, new Error("Replacement capture refused."));
    const started = await startServiceLiveHost({
      ...o.f,
      frameChanges: createNamedFrameChanges(16),
    });
    cleanup.push(() => started.close());
    await started.update({ workspaces: [o.workspace], documents: [other], departing: [o.sibling] });
    host = started;
  } else host = await restartedHost(o);
  await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true), { timeout: 10_000 });
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ key }));
  return { host, key, other, driver: () => driver };
};
const retirementRequests = (o: Enrolled) => ({
  settles: retiringSettles(o, 0).map(
    ([, params]) => (params as { retirement: unknown }).retirement,
  ),
  releases: o
    .ownerCalls()
    .filter(([method]) => method === "liveApplication.releaseActivation")
    .map(([, params]) => params),
});

it("completes a moved document's retirement after a restart by its own object while another document holds its old path", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { host, key, other, driver } = await movedRetirementAfterRestart(o, "stop", {
    replacement: true,
  });
  expect(key.objectId).toBe(o.document.objectId);
  const { settles, releases } = retirementRequests(o);
  expect(settles.length).toBeGreaterThan(0);
  expect(settles).toEqual(settles.map(() => key));
  expect(releases.length).toBeGreaterThan(0);
  expect(releases).toEqual(releases.map(() => expect.objectContaining(key)));
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), { timeout: 10_000 });
  expect(driver()!.targets.filter((target) => target.path === o.sibling.path)).toEqual([
    expect.objectContaining({ path: o.sibling.path }),
  ]);
  const captures = () =>
      o
        .client()
        .captureOwnerActivation.mock.calls.filter(
          (call) => (call as unknown[])[1] === o.sibling.path,
        ).length,
    seen = captures();
  await vi.waitFor(() => expect(captures()).toBeGreaterThan(seen), { timeout: 10_000 });
  expect(
    o.raw
      .prepare("SELECT COUNT(*) AS count FROM sync_relay_service_activations WHERE object_id=?")
      .get(other.objectId),
  ).toEqual({ count: 0 });
  expect(host.drained("workspace")).toBe(false);
});

const REPLACEMENT_ACTIVATION = `ordinary-activation-${"c".repeat(64)}`;
// A new document at the fixture document's path, with its own lineage and an
// activation the running host completed: adoption, seed and native application,
// as for the fixture document. The fake engine resumes it by its activation ID.
// Its object and activation IDs sort after the fixture document's. `name`,
// `path` and `activationId` give another such document at another path.
const replacementActivation = async (
  o: Enrolled,
  { name = "replacement", path = o.sibling.path, activationId = REPLACEMENT_ACTIVATION } = {},
) => {
  const policy = {
    maxStructVisits: 1_000_000,
    maxValueNodeVisits: 5_000_000,
    maxDecodedPayloadByteVisits: 100_000_000,
    maxStructClientGroupVisits: 1_000_000,
    maxDeleteClientGroupVisits: 1_000_000,
    maxDeleteIntervalVisits: 1_000_000,
    maxIndexOperations: 10_000_000,
  };
  const origin = `${name}-origin`,
    doc = markdownToYDoc(name === "replacement" ? "Replacement" : `Document ${name}`),
    baselineBytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.getMap("frontmatter").set("title", "Replaced");
  const fullState = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  const document = {
    workspaceId: "workspace",
    mainVersionId: "main" as const,
    objectId: `${name}-object`,
    lineageClaimId: sha256(baselineBytes),
  };
  const validated = o.validateJournal({
    document,
    currentPath: path,
    checkpoint: baselineBytes,
    suffix: [],
    candidate: fullState,
  });
  const base = createLiveMarkdownRegistrationValidator(policy)({
    document,
    currentPath: path,
    checkpoint: baselineBytes,
  });
  if (validated.kind !== "accepted" || base.kind !== "accepted")
    throw new Error("Invalid replacement fixture.");
  const relaySeq = (originSeq: number) =>
    Number(
      o.raw
        .prepare(
          `SELECT relay_seq FROM sync_relay_log WHERE origin_id='${origin}' AND origin_seq=?`,
        )
        .get(originSeq)!.relay_seq,
    );
  seedRows(o.raw, () => {
    const log = o.raw.prepare(
      `INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','${origin}',?,?,?,?)`,
    );
    log.run(
      0,
      "moment.append",
      JSON.stringify({
        versionId: "main",
        objectId: document.objectId,
        momentId: `${name}-moment`,
        path,
        operation: "write",
        payloadAfterPath: path,
        payloadAfterContentKind: "text",
        payloadAfterBlobSha256: base.evidence.projectedMarkdownSha256,
        payloadAfterByteLength: base.evidence.projectedMarkdownByteLength,
      }),
      30,
    );
    log.run(
      1,
      "ydoc.update",
      JSON.stringify({
        versionId: "main",
        objectId: document.objectId,
        path,
        contentKind: "richdoc",
        isBaseState: true,
        lineageClaimId: document.lineageClaimId,
        updateBlobSha256: document.lineageClaimId,
      }),
      31,
    );
    log.run(
      2,
      "ydoc.update",
      JSON.stringify({
        versionId: "main",
        objectId: document.objectId,
        path,
        contentKind: "richdoc",
        isBaseState: false,
        lineageClaimId: document.lineageClaimId,
        updateBlobSha256: sha256(fullState),
      }),
      32,
    );
    const blob = o.raw.prepare(
      "INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)",
    );
    blob.run(document.lineageClaimId, baselineBytes.length, baselineBytes);
    blob.run(sha256(fullState), fullState.length, fullState);
    o.raw
      .prepare(
        "INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace',?,?,?,'main',?,?,'text',?,30)",
      )
      .run(
        document.objectId,
        relaySeq(0),
        `${name}-moment`,
        path,
        base.evidence.projectedMarkdownSha256,
        base.evidence.projectedMarkdownByteLength,
      );
  });
  const capture: NativeOwnerActivation = {
    activationId,
    sessionId: `${name}-session`,
    baselineBytes,
    fullState,
    source: {
      version: 1,
      relayDatabaseNamespace: o.f.history.namespace,
      ...document,
      currentPath: path,
      replicationEpoch: "epoch",
      streamIdentity: "stream",
      committedCursor: relaySeq(2),
      baseOriginId: origin,
      baseOriginSeq: 1,
      baseRelaySeq: relaySeq(1),
      sourceMomentId: `moment-ydoc-apply-${sha256(Buffer.from(["workspace", "main", document.objectId, path, origin, "2"].join("\0")))}`,
      sourceDigest: validated.evidence.projectedMarkdownSha256,
      sourceByteLength: validated.evidence.projectedMarkdownByteLength,
      nativeHeadSequence: 2,
      fullStateDigest: sha256(fullState),
      fullStateByteLength: fullState.length,
    },
  };
  const host = o.host.coordinate,
    actor = { kind: "owner" as const, userId: "owner" };
  const store = o.f.storage.createServiceActivationStore(o.f.history);
  await store.prepare({
    capture,
    host,
    registeredAtMs: 33,
    guard() {},
    validate: async (work) => validateOrdinaryActivation(work, policy),
    bounds: { maxCaptureBytes: 1_000_000, maxHistoryEntries: 10, maxBytesPerDrain: 1_000_000 },
  });
  const access = store.pending(document, host),
    delivery = o.f.storage.createLiveCommittedDeliveryStore(o.f.history, access);
  const adoption = delivery.captureOwnerCut({
    host,
    document,
    actor,
    adoptionId: activationId,
    expectedLocalSequence: 2,
    maxBytes: 1_000_000,
    maxEvents: 100,
    throughCursor: 0,
  });
  delivery.acknowledgeOwnerAdoption(adoption, {
    adoptionId: activationId,
    localYDocSequence: 2,
    terminalCursor: 0,
    adoptionReplayed: false,
  });
  const current = o.f.storage.resolveCurrentLiveDocumentBinding({ document, actor }, access),
    cut = o.f.storage.readLiveUpdateJournalCut({ document });
  if (current.kind !== "current" || cut.kind !== "cut")
    throw new Error("Missing replacement activation authority.");
  const seed = o.validateJournal({
    document,
    currentPath: current.binding.currentPath,
    checkpoint: cut.cut.checkpoint.bytes,
    suffix: cut.cut.suffix.map((row) => row.bytes),
    candidate: fullState,
  });
  o.f.storage.commitLiveUpdateJournal(
    {
      host,
      actor,
      expectedAuthority: current.authority,
      metadata: {
        deliveryId: `${name}-seed`,
        updateDigest: sha256(fullState),
        binding: current.binding,
      },
      cutToken: cut.cut,
      validation: seed,
      updateBytes: fullState,
      receivedAtMs: 34,
    },
    access,
  );
  const owner = delivery.openOwnerDelivery({ host, document, actor }),
    event = delivery.nextOwnerApplication(owner)!;
  delivery.acknowledgeOwnerDeliveryApplication(owner, {
    ...event.metadata.accepted.receipt,
    localYDocSequence: 2,
    applicationReplayed: false,
  });
  store.complete({
    document,
    host,
    access,
    nativeState: { adoptionId: activationId, pendingBytes: 0 },
    guard() {},
  });
  o.otherActivations.set(activationId, capture);
  return { ...o.sibling, path, objectId: document.objectId };
};

// Appends real path changes from another device, with unchanged text unless supplied.
const documentMoves = (o: Enrolled) => {
  let sequence = 0;
  return (row: typeof o.sibling, path: string, text?: string) => {
    const before = o.f.storage.objectMoment({
      workspaceId: row.workspaceId,
      objectId: row.objectId,
      versionId: "main",
    });
    if (
      !before ||
      !before.path ||
      before.contentKind !== "text" ||
      before.blobSha256 === null ||
      before.byteLength === null
    )
      throw new Error("Missing document before move.");
    if (!o.f.storage.getBlob(row.workspaceId, before.blobSha256)) {
      const capture = [o.engine.capture, ...o.otherActivations.values()].find(
        (value) => value.source.objectId === row.objectId,
      )!;
      const document = {
        workspaceId: row.workspaceId,
        mainVersionId: "main" as const,
        objectId: row.objectId,
        lineageClaimId: capture.source.lineageClaimId,
      };
      const normalized = createLiveMarkdownRegistrationValidator(restorePolicy)({
        document,
        currentPath: before.path,
        checkpoint: capture.baselineBytes,
      });
      if (normalized.kind !== "accepted") throw new Error(normalized.reason);
      expect(normalized.evidence.projectedMarkdownSha256).toBe(before.blobSha256);
      o.f.storage.putBlob({
        workspaceId: row.workspaceId,
        sha256: before.blobSha256,
        content: Buffer.from(normalized.evidence.projectedMarkdown),
        createdAtMs: 1,
      });
    }
    const after =
      text === undefined
        ? { sha256: before.blobSha256, byteLength: before.byteLength }
        : { sha256: sha256(Buffer.from(text)), byteLength: Buffer.byteLength(text) };
    if (text !== undefined)
      o.f.storage.putBlob({
        workspaceId: row.workspaceId,
        sha256: after.sha256,
        content: Buffer.from(text),
        createdAtMs: 40,
      });
    const payload = {
      momentId: `move-${sequence}`,
      objectId: row.objectId,
      versionId: "main",
      operation: "rename",
      path,
      beforePath: before.path,
      payloadBeforePath: before.path,
      payloadAfterPath: path,
      payloadBeforeContentKind: "text",
      payloadAfterContentKind: "text",
      payloadBeforeBlobSha256: before.blobSha256,
      payloadAfterBlobSha256: after.sha256,
      payloadAfterByteLength: after.byteLength,
      recordedAtMs: 40,
    };
    expect(
      o.f.storage.appendLogBatch({
        workspaceId: row.workspaceId,
        originId: "moving-device",
        ops: [
          {
            originSeq: sequence++,
            opKind: "moment.append",
            payloadJson: JSON.stringify(payload),
            recordedAtMs: 40,
          },
        ],
      }),
    ).toMatchObject({ inserted: 1 });
  };
};

for (const c of [
  {
    moves: 1,
    name: "publishes a settled sibling after an enrolled document moves without losing its Edit grant",
  },
])
  it(c.name, async () => {
    const o = await enrolledServiceHost(),
      k = keptEdits(o),
      workspaces = [o.workspace];
    const log = vi.spyOn(console, "error").mockImplementation(() => {}),
      registrationIds = o.distinctRegistrations();
    const sibling = await replacementActivation(o, { name: "sibling", path: "docs/c.md" });
    const documents = [o.sibling, sibling];
    if (c.moves === 2)
      documents.push(
        await replacementActivation(o, {
          name: "ordinary",
          path: "docs/d.md",
          activationId: `ordinary-activation-${"d".repeat(64)}`,
        }),
      );
    for (const row of documents.slice(1))
      o.f.storage.ensureOwnedLiveDocument({
        intent: "share",
        workspaceId: row.workspaceId,
        ownerUserId: "owner",
        shareId: "share",
        path: row.path,
        nowMs: 35,
        guard() {},
      });
    const documentFor = (row: typeof o.sibling) => {
      const capture = [o.engine.capture, ...o.otherActivations.values()].find(
        (value) => value.source.objectId === row.objectId,
      )!;
      return {
        workspaceId: row.workspaceId,
        mainVersionId: "main" as const,
        objectId: row.objectId,
        lineageClaimId: capture.source.lineageClaimId,
      };
    };
    await o.host.update({ workspaces, documents, ...stay });
    await vi.waitFor(() => {
      for (const row of documents) {
        expect(o.host.settled(row)).toBe(true);
        expect(o.host.isDocumentReady(documentFor(row))).toBe(true);
      }
    });
    const move = documentMoves(o);
    const settlements = vi.spyOn(OwnerCommittedDelivery.prototype, "settle"),
      departedAt = new Map<string, { settlement: number; request: number }>();
    const requests = () =>
      o.client().sendRequest.mock.calls.map(
        (call) =>
          (call as unknown[])[0] as {
            method: string;
            params: {
              registrationId?: number;
              retirement?: { objectId: string };
              terminalReceipt?: { deliveryId: string };
            };
          },
      );
    o.native.binding = o.binding;
    o.nativeEdits("before-move");
    const queued = o.native.entries.map((entry) => ({
      ...entry,
      update: Buffer.from(entry.update),
    }));
    for (let index = 0; index < c.moves; index++) {
      const row = documents[index]!;
      departedAt.set(row.objectId, {
        settlement: settlements.mock.calls.length,
        request: requests().length,
      });
      move(row, `elsewhere/${row.objectId}.md`);
      expect(o.f.storage.serviceHostDocumentEnabled(row)).toBe(true);
      expect(
        o.f.storage.serviceHostEnrollmentCovered({
          workspaceId: row.workspaceId,
          objectId: row.objectId,
          ownerUserId: "owner",
          shareId: "share",
          path: row.path,
        }),
      ).toBe(true);
      expect(o.f.storage.serviceActivationRetirement(row)).toBeNull();
      await o.host.update({
        workspaces,
        documents: documents.slice(index + 1),
        departing: documents.slice(0, index + 1),
      });
      await vi.waitFor(() => expect(o.host.isDocumentReady(documentFor(row))).toBe(false));
      await o.nextPull();
    }
    const remaining = documents.at(-1)!,
      document = documentFor(remaining),
      actor = { kind: "owner" as const, userId: "owner" };
    const current = o.f.storage.resolveCurrentLiveDocumentBinding({ document, actor }),
      read = o.f.storage.readLiveUpdateJournalCut({ document });
    if (current.kind !== "current" || read.kind !== "cut")
      throw new Error("Missing sibling authority.");
    const doc = new Y.Doc(),
      suffix = read.cut.suffix.map((row) => row.bytes);
    for (const bytes of [read.cut.checkpoint.bytes, ...suffix]) Y.applyUpdate(doc, bytes);
    const vector = Y.encodeStateVector(doc);
    doc.getMap("frontmatter").set("edit", "after-moves");
    const updateBytes = Buffer.from(Y.encodeStateAsUpdate(doc, vector));
    doc.destroy();
    const validation = o.validateJournal({
      document,
      currentPath: remaining.path,
      checkpoint: read.cut.checkpoint.bytes,
      suffix,
      candidate: updateBytes,
    });
    const accepted = o.f.storage.commitLiveUpdateJournal({
      host: o.host.coordinate,
      actor,
      expectedAuthority: current.authority,
      metadata: {
        deliveryId: "sibling-after-moves",
        updateDigest: sha256(updateBytes),
        binding: current.binding,
      },
      cutToken: read.cut,
      validation,
      updateBytes,
      receivedAtMs: 50,
    });
    expect(accepted.result.kind).toBe("accepted");
    const settledAt = () =>
      requests().findIndex(
        (request) =>
          request.method === "liveApplication.settle" &&
          request.params.terminalReceipt?.deliveryId === "sibling-after-moves",
      );
    await vi.waitFor(() => expect(settledAt()).toBeGreaterThan(-1));
    await vi.waitFor(() =>
      expect(
        requests()
          .slice(settledAt() + 1)
          .some((request) => request.method === "sync.push"),
        "The workspace must publish the settled sibling after another document moves.",
      ).toBe(true),
    );
    expect(o.client().sendLiveApplication).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          accepted: expect.objectContaining({
            receipt: expect.objectContaining({ deliveryId: "sibling-after-moves" }),
          }),
        }),
      }),
      expect.anything(),
    );
    expect(o.native.entries).toEqual(queued);
    for (const [objectId, from] of departedAt) {
      expect(
        settlements.mock.calls.slice(from.settlement).map(([value]) => value.objectId),
      ).not.toContain(objectId);
      expect(registrationIds.has(objectId)).toBe(true);
      expect(
        requests()
          .slice(from.request)
          .filter(
            (request) =>
              request.method === "liveApplication.settle" &&
              (request.params.registrationId === registrationIds.get(objectId) ||
                request.params.retirement?.objectId === objectId),
          ),
      ).toEqual([]);
    }
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        ...waiting("Waiting for its owner to save a recovery copy of the edits the server kept."),
      ),
    );
    expect(o.host.retains(o.sibling)).toBe(true);
    expect(k.row()).toMatchObject({ copied: false });
    const header = (await o.host.readKeptEditsPage(k.row()!, undefined, o.workspace.root)) as {
      kind: string;
      snapshot: string;
    };
    expect(header).toMatchObject({ kind: "page", part: "header" });
    await expect(
      o.host.readKeptEditsPage(
        k.row()!,
        { snapshot: header.snapshot, part: "update", sequence: 1, offset: 0 },
        o.workspace.root,
      ),
    ).resolves.toMatchObject({
      kind: "page",
      part: "update",
      bytesBase64: Buffer.from([7]).toString("base64"),
    });
    expect(retiredRow(o).retired).toBe(false);
    const captures = o.client().captureOwnerActivation.mock.calls.length;
    move(o.sibling, o.sibling.path);
    await o.host.update({
      workspaces,
      documents: [o.sibling, remaining],
      departing: documents.slice(1, c.moves),
    });
    await vi.waitFor(() =>
      expect(
        o.host.isDocumentReady(o.document),
        "The document must be ready after returning without a pause.",
      ).toBe(true),
    );
    expect(
      o
        .client()
        .captureOwnerActivation.mock.calls.slice(captures)
        .map((call) => (call as unknown[])[1]),
    ).toContain(o.sibling.path);
    expect(
      o
        .client()
        .captureOwnerActivation.mock.calls.slice(captures)
        .map((call) => (call as unknown[])[4]),
    ).toContain(ACTIVATION);
    expect(o.native.entries).toEqual([]);
  });

const readAcceptedEdits = (o: Enrolled) => {
  const { workspaceId, mainVersionId, objectId, lineageClaimId } = o.document;
  const params = [workspaceId, mainVersionId, objectId, lineageClaimId];
  const baseline = o.raw
    .prepare(`SELECT baseline_bytes FROM sync_relay_live_documents
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`)
    .get(...params);
  const updates = o.raw
    .prepare(`SELECT journal_cursor FROM sync_relay_live_update_journal
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? ORDER BY journal_cursor`)
    .all(...params)
    .map((row) =>
      o.f.storage.readCommittedLiveUpdate({
        host: o.host.coordinate,
        document: o.document,
        journalCursor: Number(row.journal_cursor),
      }),
    );
  return {
    baseline: baseline ? Buffer.from(baseline.baseline_bytes as Uint8Array) : null,
    updates,
  };
};
const rebuildEdits = (
  saved: ReturnType<typeof readAcceptedEdits>,
  queued: Enrolled["native"]["entries"],
) => {
  if (!saved.baseline) throw new Error("Missing accepted edits.");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, saved.baseline);
    for (const update of saved.updates) {
      if (update.kind !== "committed") throw new Error("Missing accepted edits.");
      Y.applyUpdate(doc, update.admitted.updateBytes);
    }
    const acceptedText = yDocToMarkdown(doc),
      acceptedEdit = doc.getMap("frontmatter").get("edit");
    for (const entry of queued) Y.applyUpdate(doc, entry.update);
    return {
      acceptedText,
      acceptedEdit,
      queuedText: yDocToMarkdown(doc),
      queuedEdit: doc.getMap("frontmatter").get("edit"),
    };
  } finally {
    doc.destroy();
  }
};

it("keeps accepted edits and queued edits when another device removes an enrolled document", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.lost.pending = true;
  const receipt = o.acceptEdit("before-removal");
  const accepted = o.f.storage.readLiveUpdateJournalCut({ document: o.document });
  expect(accepted.kind).toBe("cut");
  const storedAccepted = readAcceptedEdits(o);
  o.native.binding = o.binding;
  o.nativeEdits("queued-before-removal");
  const queued = o.native.entries.map((entry) => ({ ...entry, update: Buffer.from(entry.update) }));
  expect(queued).toHaveLength(1);
  expect(o.applied.has(receipt.deliveryId)).toBe(false);
  const before = o.f.storage.objectMoment({
    workspaceId: "workspace",
    objectId: o.sibling.objectId,
    versionId: "main",
  })!;
  const normalized = createLiveMarkdownRegistrationValidator(restorePolicy)({
    document: o.document,
    currentPath: o.sibling.path,
    checkpoint: o.engine.capture.baselineBytes,
  });
  if (normalized.kind !== "accepted") throw new Error(normalized.reason);
  expect(normalized.evidence.projectedMarkdownSha256).toBe(before.blobSha256);
  o.f.storage.putBlob({
    workspaceId: "workspace",
    sha256: before.blobSha256!,
    content: Buffer.from(normalized.evidence.projectedMarkdown),
    createdAtMs: 40,
  });
  o.raw
    .prepare(`INSERT INTO sync_relay_current_files(workspace_id,version_id,path,blob_sha256,content_kind,state_relay_seq)
    SELECT workspace_id,version_id,path,blob_sha256,content_kind,relay_seq FROM sync_relay_object_moments
    WHERE workspace_id=? AND object_id=? AND version_id=? ORDER BY relay_seq DESC LIMIT 1`)
    .run("workspace", o.sibling.objectId, "main");
  const currentFile = () =>
    o.raw
      .prepare(
        "SELECT path,blob_sha256 FROM sync_relay_current_files WHERE workspace_id=? AND version_id=? AND path=?",
      )
      .get("workspace", "main", before.path);
  expect(
    currentFile(),
    "The saved file must be available before the document is removed.",
  ).toMatchObject({ path: before.path, blob_sha256: before.blobSha256 });
  expect(
    o.f.storage.appendLogBatch({
      workspaceId: "workspace",
      originId: "removing-device",
      ops: [
        {
          originSeq: 0,
          opKind: "moment.append",
          payloadJson: JSON.stringify({
            versionId: "main",
            objectId: o.sibling.objectId,
            momentId: "removed-document",
            operation: "delete",
            path: before.path,
            payloadBeforePath: before.path,
            payloadBeforeBlobSha256: before.blobSha256,
            recordedAtMs: 40,
          }),
          recordedAtMs: 40,
        },
      ],
    }),
  ).toMatchObject({ inserted: 1 });
  expect(
    currentFile(),
    "The removed document must no longer be available as a saved file.",
  ).toBeUndefined();
  expect(
    o.f.storage.objectMoment({
      workspaceId: "workspace",
      objectId: o.sibling.objectId,
      versionId: "main",
    }),
  ).toMatchObject({ path: null });
  expect(o.f.storage.serviceHostDocumentEnabled(o.sibling)).toBe(true);
  expect(
    o.f.storage.serviceHostEnrollmentCovered({
      workspaceId: "workspace",
      objectId: o.sibling.objectId,
      ownerUserId: "owner",
      shareId: "share",
      path: o.sibling.path,
    }),
  ).toBe(true);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  await o.depart();
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(false));
  await o.nextPass();
  const saved = readAcceptedEdits(o);
  expect(saved, "The accepted edits must stay available after the document is removed.").toEqual(
    storedAccepted,
  );
  expect(
    o.native.entries,
    "The queued edits must stay available after the document is removed.",
  ).toEqual(queued);
  expect(
    o.f.storage.readLiveUpdateJournalCut({ document: o.document }),
    "The removed document must stay unavailable at its former path.",
  ).toEqual({ kind: "refused", reason: "stale-binding" });
  const rebuilt = rebuildEdits(saved, o.native.entries);
  expect(rebuilt.acceptedEdit, "The saved document must still contain the accepted edit.").toBe(
    "before-removal",
  );
  expect(
    rebuilt.queuedEdit,
    "The saved document and queued edits must still contain the latest edit.",
  ).toBe("queued-before-removal");
});

for (const c of [
  { changedText: true, name: "keeps a document inactive when its saved text needs attention" },
  { changedText: false, name: "resumes a document with only its own text" },
])
  it(c.name, async () => {
    const o = await enrolledServiceHost(),
      move = documentMoves(o);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    o.distinctRegistrations();
    const sibling = await replacementActivation(o, { name: "sibling", path: "docs/c.md" });
    const siblingCapture = o.otherActivations.get(REPLACEMENT_ACTIVATION)!;
    const siblingDocument = {
      workspaceId: sibling.workspaceId,
      mainVersionId: "main" as const,
      objectId: sibling.objectId,
      lineageClaimId: siblingCapture.source.lineageClaimId,
    };
    o.f.storage.ensureOwnedLiveDocument({
      intent: "share",
      workspaceId: sibling.workspaceId,
      ownerUserId: "owner",
      shareId: "share",
      path: sibling.path,
      nowMs: 35,
      guard() {},
    });
    const visitor = c.changedText
      ? undefined
      : await replacementActivation(o, {
          name: "visitor",
          path: "docs/visitor.md",
          activationId: `ordinary-activation-${"d".repeat(64)}`,
        });
    if (visitor) move(visitor, "elsewhere/visitor.md");
    await o.host.update({ workspaces: [o.workspace], documents: [o.sibling, sibling], ...stay });
    await vi.waitFor(() => {
      expect(o.host.settled(o.sibling)).toBe(true);
      expect(o.host.isDocumentReady(siblingDocument)).toBe(true);
    });
    const removed = vi.spyOn(ServiceActivationDriver.prototype, "removeTarget");
    o.replies.pass = { departed: [o.sibling.objectId] };
    o.replies.commit = { departed: [o.sibling.objectId] };
    move(o.sibling, "elsewhere/a.md");
    await o.host.update({
      workspaces: [o.workspace],
      documents: [sibling],
      departing: [o.sibling],
    });
    await vi.waitFor(() =>
      expect(removed, "The moved document must leave activation.").toHaveBeenCalledWith(
        expect.objectContaining({ path: o.sibling.path }),
      ),
    );
    await o.nextPull();
    if (visitor) {
      move(visitor, o.sibling.path);
      expect(
        o.f.storage.objectIdAtPathInVersion({
          workspaceId: "workspace",
          versionId: "main",
          path: o.sibling.path,
        }),
      ).toBe(visitor.objectId);
    }
    const sent = o.ownerCalls().length;
    expect(
      o.f.storage.setServiceHostEnrollmentEnabled({
        workspaceId: "workspace",
        path: o.sibling.path,
        ownerUserId: "owner",
        enabled: false,
        nowMs: 50,
        guard() {},
      }),
    ).toMatchObject({ ownerStop: "pause" });
    const key = retirementKey(o);
    await vi.waitFor(() =>
      expect(retiringSettles(o, sent)).toContainEqual([
        "liveApplication.settle",
        expect.objectContaining({ retirement: key }),
      ]),
    );
    o.replies.pass = {};
    o.replies.commit = {};
    await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true));
    if (visitor) move(visitor, "elsewhere/visitor.md");
    const returnedAt = log.mock.calls.length;
    move(o.sibling, o.sibling.path, c.changedText ? "Different text on return\n" : undefined);
    o.engine.capture = {
      ...o.engine.capture,
      activationId: SUCCESSOR,
      source: { ...o.engine.capture.source, predecessorActivationId: ACTIVATION },
    };
    o.engine.adoption = { activationId: SUCCESSOR, throughCursor: null };
    const capture = o.engine.capture;
    const source = {
      ...capture.source,
      committedCursor: Number(
        o.raw
          .prepare("SELECT MAX(relay_seq) AS cursor FROM sync_relay_log WHERE workspace_id=?")
          .get("workspace")!.cursor,
      ),
    };
    const read = () => {
      const found = readOrdinaryActivationHistory(o.f.storage as StorageContext, {
        source,
        document: o.document,
        baselineBytes: capture.baselineBytes,
        fullState: capture.fullState,
        checkpoint: null,
        bounds: { maxCaptureBytes: 1_000_000, maxHistoryEntries: 100, maxBytesPerDrain: 1_000_000 },
      });
      if (found.kind !== "history") throw new Error(`Expected a history read, not ${found.kind}.`);
      return found.history;
    };
    if (c.changedText) {
      expect(read, "The returned document must refuse a move that changed its text.").toThrow(
        "Ordinary activation history replaced the live document.",
      );
    } else {
      expect(read, "The returned document must rebuild its own edits.").not.toThrow();
      const history = read();
      expect(read(), "Reading the returned document again must give the same edits.").toEqual(
        history,
      );
      expect(
        history.rows.map((row) => row.origin_id),
        "The returned document must use only its own edits.",
      ).toEqual(["origin", "origin"]);
      const doc = new Y.Doc();
      try {
        for (const bytes of history.updates) Y.applyUpdate(doc, bytes);
        expect(
          yDocToMarkdown(doc),
          "The other document's text must stay out of the returned document.",
        ).not.toContain("Document visitor");
        const rebuilt = createLiveMarkdownRegistrationValidator(restorePolicy)({
          document: o.document,
          currentPath: o.sibling.path,
          checkpoint: Y.encodeStateAsUpdate(doc),
        });
        expect(rebuilt).toMatchObject({
          kind: "accepted",
          evidence: { projectedMarkdownSha256: capture.source.sourceDigest },
        });
      } finally {
        doc.destroy();
      }
    }
    expect(
      o.f.storage.ensureOwnedLiveDocument({
        intent: "owner-resume",
        workspaceId: "workspace",
        path: o.sibling.path,
        ownerUserId: "owner",
        nowMs: 60,
        guard() {},
      }),
    ).toMatchObject({ enabled: true });
    const pushes = () =>
      o
        .client()
        .sendRequest.mock.calls.filter(
          (call) => ((call as unknown[])[0] as { method: string }).method === "sync.push",
        ).length;
    await o.host.update({ workspaces: [o.workspace], documents: [o.sibling, sibling], ...stay });
    if (c.changedText) {
      await vi.waitFor(() =>
        expect(log.mock.calls.slice(returnedAt)).toContainEqual([
          "Service activation pass failed.",
          "ServerLogError: Ordinary activation history replaced the live document.",
        ]),
      );
      for (let pass = 0; pass < 3; pass++) {
        await o.nextPull();
        expect(
          o.host.isDocumentReady(o.document),
          "The returned document must stay inactive after its text changed.",
        ).toBe(false);
        expect(o.host.isDocumentReady(siblingDocument)).toBe(true);
      }
    } else {
      await vi.waitFor(() =>
        expect(
          o.host.isDocumentReady(o.document),
          "The returned document must activate with its own text.",
        ).toBe(true),
      );
      const pushed = pushes();
      await vi.waitFor(() =>
        expect(
          pushes(),
          "The workspace must publish after the returned document activates.",
        ).toBeGreaterThan(pushed),
      );
    }
  });

for (const c of [
  { kind: "different", name: "keeps a document inactive when the saved file has different text" },
  { kind: "departed", name: "keeps a document inactive while preserving a newer saved file" },
  { kind: "saved", name: "keeps a document inactive with its saved text intact" },
  {
    kind: "saved-matching",
    name: "keeps a document inactive while its saved file needs attention",
  },
  {
    kind: "departed-matching",
    name: "keeps a document inactive without replacing its newer saved text",
  },
  {
    kind: "saved-move",
    name: "keeps a document inactive when its saved text differs from its current edits",
  },
  {
    kind: "saved-move-no-write",
    name: "keeps a document inactive with its different saved text preserved",
  },
  {
    kind: "saved-move-unindexed",
    name: "keeps a document inactive while its different saved text stays available",
  },
  {
    kind: "saved-file-different",
    name: "keeps a document inactive while its saved file has other text",
  },
  {
    kind: "saved-move-departed",
    name: "keeps a document inactive without changing its different saved text",
  },
  {
    kind: "saved-file-current",
    name: "keeps a document inactive with its saved file's different text available",
  },
  {
    kind: "saved-move-selected-write",
    name: "keeps a document inactive while its saved file keeps another device's text",
  },
  {
    kind: "saved-file-unindexed-moves",
    name: "keeps a document inactive with all its different saved text available",
  },
  {
    kind: "saved-file-later-moves",
    name: "keeps a document inactive while preserving all its different saved text",
  },
  {
    kind: "saved-after-return",
    name: "keeps a document inactive with its latest saved text available",
  },
  {
    kind: "saved-after-unindexed-return",
    name: "keeps a document inactive while its saved text remains available",
  },
  {
    kind: "saved-after-indexed-return",
    name: "keeps a document inactive without changing its available saved text",
  },
  {
    kind: "saved-after-stale-write",
    name: "keeps a document inactive with its current saved edits intact",
  },
  { kind: "returned-saved", name: "resumes a document with its latest saved edits" },
  {
    kind: "returned-current",
    name: "resumes a document with its current edits and matching saved text",
  },
  { kind: "current", name: "resumes a document with its current edits" },
] as const)
  it(c.name, async () => {
    const o = await enrolledServiceHost(),
      move = documentMoves(o);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const capture = o.engine.capture;
    const base = createLiveMarkdownRegistrationValidator(restorePolicy)({
      document: o.document,
      currentPath: o.sibling.path,
      checkpoint: capture.baselineBytes,
    });
    if (base.kind !== "accepted") throw new Error(base.reason);
    const resumes =
      c.kind === "current" || c.kind === "returned-current" || c.kind === "returned-saved";
    const writesAfterReturn =
      c.kind === "saved-after-return" ||
      c.kind === "saved-after-stale-write" ||
      c.kind === "returned-saved";
    const repeatsCurrentWrite =
      c.kind === "saved-after-unindexed-return" || c.kind === "saved-after-indexed-return";
    const unindexedMoves =
      c.kind === "saved-file-unindexed-moves" || c.kind === "saved-after-unindexed-return";
    if (!resumes) {
      o.native.binding = o.binding;
      o.nativeEdits("queued-while-inactive");
    }
    const appendWrite = (
      originId: string,
      originSeq: number,
      text: string,
      native = false,
      departed = false,
      payloadRecordedAtMs: number | null = 40,
      beforeBlobSha256?: string,
    ) => {
      const bytes = Buffer.from(text),
        digest = sha256(bytes);
      o.f.storage.putBlob({
        workspaceId: "workspace",
        sha256: digest,
        content: bytes,
        createdAtMs: 40,
      });
      const payload = {
        versionId: "main",
        objectId: o.sibling.objectId,
        path: o.sibling.path,
        operation: "write",
        momentId: native
          ? `moment-ydoc-${sha256(Buffer.from(`${originId}\0${originSeq}`))}`
          : "external-write",
        payloadAfterPath: o.sibling.path,
        payloadAfterContentKind: "text",
        payloadAfterBlobSha256: digest,
        payloadAfterByteLength: bytes.length,
        metadata: {},
        beforePresent: beforeBlobSha256 !== undefined,
        recordedAtMs: payloadRecordedAtMs,
        ...(beforeBlobSha256 === undefined
          ? {}
          : {
              beforePath: o.sibling.path,
              payloadBeforePath: o.sibling.path,
              payloadBeforeContentKind: "text",
              payloadBeforeBlobSha256: beforeBlobSha256,
            }),
      };
      expect(
        o.f.storage.appendLogBatch({
          workspaceId: "workspace",
          originId,
          ops: [
            {
              originSeq,
              opKind: "moment.append",
              payloadJson: JSON.stringify(payload),
              recordedAtMs: 40,
              ...(departed ? { relayAdmission: "departed" as const } : {}),
            },
          ],
        }),
      ).toMatchObject({ inserted: 1 });
    };
    const unindexedMove = (beforePath: string, path: string, originSeq: number) => {
      const payload = {
        momentId: `unindexed-move-${originSeq}`,
        objectId: o.sibling.objectId,
        versionId: "main",
        operation: "rename",
        path,
        beforePath,
        payloadBeforePath: beforePath,
        payloadAfterPath: path,
        payloadBeforeContentKind: "text",
        payloadAfterContentKind: "text",
        payloadBeforeBlobSha256: capture.source.sourceDigest,
        payloadAfterBlobSha256: capture.source.sourceDigest,
        payloadAfterByteLength: capture.source.sourceByteLength,
        ...(unindexedMoves ? {} : { recordedAtMs: null }),
      };
      expect(
        o.f.storage.appendLogBatch({
          workspaceId: "workspace",
          originId: "unindexed-moving-device",
          ops: [
            {
              originSeq,
              opKind: "moment.append",
              payloadJson: JSON.stringify(payload),
              recordedAtMs: 40,
            },
          ],
        }),
      ).toMatchObject({ inserted: 1 });
    };
    if (c.kind === "current") {
      move(o.sibling, "elsewhere/a.md");
      move(o.sibling, o.sibling.path);
      appendWrite("origin", 3, base.evidence.projectedMarkdown, true);
    } else if (c.kind === "saved-move") {
      appendWrite("origin", 3, base.evidence.projectedMarkdown, true);
    } else if (
      c.kind === "saved-file-current" ||
      c.kind === "saved-file-unindexed-moves" ||
      c.kind === "saved-file-later-moves" ||
      c.kind === "returned-current" ||
      repeatsCurrentWrite
    ) {
      const current = createLiveMarkdownRegistrationValidator(restorePolicy)({
        document: o.document,
        currentPath: o.sibling.path,
        checkpoint: capture.fullState,
      });
      if (current.kind !== "accepted") throw new Error(current.reason);
      expect(current.evidence.projectedMarkdownSha256).toBe(capture.source.sourceDigest);
      appendWrite("origin", 3, current.evidence.projectedMarkdown, true);
      if (c.kind !== "returned-current")
        appendWrite(
          "writing-device",
          0,
          "Different saved text\n",
          false,
          false,
          null,
          capture.source.sourceDigest,
        );
    } else if (
      c.kind === "saved-move-unindexed" ||
      c.kind === "saved-move-departed" ||
      c.kind === "saved-file-different"
    ) {
      appendWrite(
        "writing-device",
        0,
        "Different saved text\n",
        false,
        c.kind === "saved-move-departed",
        null,
      );
    } else if (c.kind !== "saved-move-no-write" && !writesAfterReturn) {
      appendWrite(
        "writing-device",
        0,
        "Different saved text\n",
        false,
        false,
        c.kind === "saved-move-selected-write" ? null : 40,
      );
      if (
        c.kind === "departed" ||
        c.kind === "saved" ||
        c.kind === "departed-matching" ||
        c.kind === "saved-matching" ||
        c.kind === "saved-move-selected-write"
      ) {
        expect(
          o.f.storage.appendLogBatch({
            workspaceId: "workspace",
            originId: "origin",
            ops: [
              {
                originSeq: 3,
                opKind: "ydoc.update",
                payloadJson: JSON.stringify({
                  versionId: "main",
                  objectId: o.sibling.objectId,
                  path: o.sibling.path,
                  contentKind: "richdoc",
                  lineageClaimId: o.document.lineageClaimId,
                  isBaseState: false,
                  updateBlobSha256: sha256(capture.fullState),
                }),
                recordedAtMs: 40,
              },
            ],
          }),
        ).toMatchObject({ inserted: 1 });
        appendWrite(
          "origin",
          4,
          c.kind === "saved-matching" || c.kind === "departed-matching"
            ? "Different saved text\n"
            : base.evidence.projectedMarkdown,
          true,
          c.kind === "departed" || c.kind === "departed-matching",
          c.kind === "saved" || c.kind === "saved-matching" ? null : 40,
        );
      }
    }
    const removed = vi.spyOn(ServiceActivationDriver.prototype, "removeTarget");
    o.replies.pass = { departed: [o.sibling.objectId] };
    o.replies.commit = { departed: [o.sibling.objectId] };
    if (c.kind.startsWith("saved-move")) {
      const bytes = Buffer.from("Different saved text\n"),
        digest = sha256(bytes);
      o.f.storage.putBlob({
        workspaceId: "workspace",
        sha256: digest,
        content: bytes,
        createdAtMs: 40,
      });
      expect(
        o.f.storage.appendLogBatch({
          workspaceId: "workspace",
          originId: "saving-device",
          ops: [
            {
              originSeq: 0,
              opKind: "moment.append",
              payloadJson: JSON.stringify({
                versionId: "main",
                objectId: o.sibling.objectId,
                momentId: "saved-move",
                operation: "rename",
                path: "elsewhere/a.md",
                beforePath: o.sibling.path,
                payloadBeforePath: o.sibling.path,
                payloadAfterPath: "elsewhere/a.md",
                payloadBeforeContentKind: "text",
                payloadAfterContentKind: "text",
                payloadBeforeBlobSha256: digest,
                payloadAfterBlobSha256: digest,
                payloadAfterByteLength: bytes.length,
                recordedAtMs: 40,
              }),
              recordedAtMs: 40,
            },
          ],
        }),
      ).toMatchObject({ inserted: 1 });
    } else if (unindexedMoves) unindexedMove(o.sibling.path, "elsewhere/a.md", 0);
    else move(o.sibling, "elsewhere/a.md");
    const pause = () => {
      expect(
        o.f.storage.setServiceHostEnrollmentEnabled({
          workspaceId: "workspace",
          path: o.sibling.path,
          ownerUserId: "owner",
          enabled: false,
          nowMs: 50,
          guard() {},
        }),
      ).toMatchObject({ ownerStop: "pause" });
      return retirementKey(o);
    };
    let sent = o.ownerCalls().length;
    const paused = unindexedMoves ? pause() : undefined;
    await o.depart();
    if (!paused)
      await vi.waitFor(() =>
        expect(removed, "The document must leave activation.").toHaveBeenCalledWith(
          expect.objectContaining({ path: o.sibling.path }),
        ),
      );
    await o.nextPull();
    if (!paused) sent = o.ownerCalls().length;
    const key = paused ?? pause();
    await vi.waitFor(() =>
      expect(retiringSettles(o, sent)).toContainEqual([
        "liveApplication.settle",
        expect.objectContaining({ retirement: key }),
      ]),
    );
    o.replies.pass = {};
    o.replies.commit = {};
    await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true));
    if (paused)
      expect(removed, "The document must leave activation.").toHaveBeenCalledWith(
        expect.objectContaining({ path: o.sibling.path }),
      );
    const returnedAt = log.mock.calls.length;
    if (unindexedMoves) unindexedMove("elsewhere/a.md", o.sibling.path, 1);
    else move(o.sibling, o.sibling.path);
    if (c.kind === "saved-file-later-moves") {
      unindexedMove(o.sibling.path, "elsewhere/a.md", 0);
      unindexedMove("elsewhere/a.md", o.sibling.path, 1);
    }
    if (writesAfterReturn || repeatsCurrentWrite) {
      const current = createLiveMarkdownRegistrationValidator(restorePolicy)({
        document: o.document,
        currentPath: o.sibling.path,
        checkpoint: capture.fullState,
      });
      if (current.kind !== "accepted") throw new Error(current.reason);
      expect(current.evidence.projectedMarkdownSha256).toBe(capture.source.sourceDigest);
      if (repeatsCurrentWrite) appendWrite("origin", 4, current.evidence.projectedMarkdown, true);
      else {
        const before = sha256(Buffer.from(base.evidence.projectedMarkdown));
        appendWrite("origin", 3, current.evidence.projectedMarkdown, true, false, 40, before);
        if (c.kind === "saved-after-return")
          appendWrite(
            "writing-device",
            0,
            "Different saved text\n",
            false,
            false,
            null,
            capture.source.sourceDigest,
          );
        if (c.kind === "saved-after-stale-write")
          appendWrite("origin", 4, base.evidence.projectedMarkdown, true, false, 40, before);
      }
    }
    o.engine.capture = {
      ...capture,
      activationId: SUCCESSOR,
      source: {
        ...capture.source,
        predecessorActivationId: ACTIVATION,
        ...(c.kind === "returned-saved"
          ? { sourceMomentId: `moment-ydoc-${sha256(Buffer.from(["origin", 3].join("\0")))}` }
          : {}),
        ...(c.kind === "saved-file-current" ||
        c.kind === "saved-file-later-moves" ||
        c.kind === "returned-current"
          ? { sourceMomentId: "move-1" }
          : {}),
      },
    };
    o.engine.adoption = { activationId: SUCCESSOR, throughCursor: null };
    const source = {
      ...o.engine.capture.source,
      committedCursor: Number(
        o.raw
          .prepare("SELECT MAX(relay_seq) AS cursor FROM sync_relay_log WHERE workspace_id=?")
          .get("workspace")!.cursor,
      ),
    };
    const bounds = {
      maxCaptureBytes: 1_000_000,
      maxHistoryEntries: 100,
      maxBytesPerDrain: 1_000_000,
    };
    const check = () => {
      const input = {
        source,
        document: o.document,
        baselineBytes: capture.baselineBytes,
        fullState: capture.fullState,
        bounds,
        checkpoint: null,
      };
      const found = readOrdinaryActivationHistory(o.f.storage as StorageContext, input);
      if (found.kind !== "history") throw new Error(`Expected a history read, not ${found.kind}.`);
      const history = found.history;
      const validation = validateOrdinaryActivation(
        {
          document: o.document,
          currentPath: source.currentPath,
          baselineBytes: capture.baselineBytes,
          cut: {
            source,
            fullState: capture.fullState,
            history,
            maxBytesPerDrain: bounds.maxBytesPerDrain,
          },
        },
        restorePolicy,
      );
      if (validation.kind !== "accepted") throw new Error(validation.message);
      return verifyOrdinaryActivationCut(o.f.storage as StorageContext, {
        ...input,
        history,
        baseline: validation.baseline,
        proof: validation.proof,
      });
    };
    const refusal =
      "Ordinary activation found a later ordinary file moment with a divergent projection.";
    const currentFile = () =>
      o.raw
        .prepare(
          "SELECT path,blob_sha256 FROM sync_relay_current_files WHERE workspace_id=? AND version_id=? AND path=?",
        )
        .get(o.document.workspaceId, o.document.mainVersionId, o.sibling.path);
    const storedFile = currentFile(),
      storedAccepted = readAcceptedEdits(o);
    expect(
      storedFile,
      "The saved file must be available before the document resumes.",
    ).toMatchObject({
      path: o.sibling.path,
      blob_sha256:
        c.kind === "returned-current" ||
        c.kind === "returned-saved" ||
        c.kind === "saved-after-stale-write"
          ? capture.source.sourceDigest
          : sha256(
              Buffer.from(
                c.kind === "saved-move" || c.kind === "current"
                  ? base.evidence.projectedMarkdown
                  : "Different saved text\n",
              ),
            ),
    });
    const queued = o.native.entries.map((entry) => ({
      ...entry,
      update: Buffer.from(entry.update),
    }));
    const storedText = rebuildEdits(storedAccepted, queued);
    if (!resumes)
      expect(queued, "The document must have queued edits before it resumes.").toHaveLength(1);
    if (resumes) {
      let failure: unknown;
      try {
        check();
      } catch (error) {
        failure = error;
      }
      expect(
        failure,
        `The document must resume with its current edits. ${failure instanceof Error ? failure.message : String(failure)}`,
      ).toBeUndefined();
    } else
      expect(check, "The saved file must be checked before the document resumes.").toThrow(refusal);
    expect(
      o.f.storage.ensureOwnedLiveDocument({
        intent: "owner-resume",
        workspaceId: "workspace",
        path: o.sibling.path,
        ownerUserId: "owner",
        nowMs: 60,
        guard() {},
      }),
    ).toMatchObject({ enabled: true });
    await o.host.update({ workspaces: [o.workspace], documents: [o.sibling], ...stay });
    if (resumes) {
      await vi.waitFor(() =>
        expect(
          o.host.isDocumentReady(o.document),
          "The document must become ready with its current edits.",
        ).toBe(true),
      );
    } else {
      await vi.waitFor(() =>
        expect(
          log.mock.calls.slice(returnedAt),
          "The document must explain why it cannot resume.",
        ).toContainEqual(["Service activation pass failed.", `ServerLogError: ${refusal}`]),
      );
      for (let pass = 0; pass < 3; pass++) {
        await o.nextPull();
        expect(
          o.host.isDocumentReady(o.document),
          "The document must stay inactive while its saved text needs attention.",
        ).toBe(false);
      }
      expect(
        o.f.storage.objectMoment({
          workspaceId: "workspace",
          objectId: o.sibling.objectId,
          versionId: "main",
        }),
        "The saved file must keep its text.",
      ).toMatchObject({
        path: o.sibling.path,
        blobSha256:
          c.kind === "saved-file-current" ||
          c.kind === "saved-file-unindexed-moves" ||
          c.kind === "saved-file-later-moves" ||
          c.kind === "saved-after-return" ||
          repeatsCurrentWrite
            ? capture.source.sourceDigest
            : sha256(
                Buffer.from(
                  c.kind === "saved-file-different" || c.kind === "saved-after-stale-write"
                    ? base.evidence.projectedMarkdown
                    : "Different saved text\n",
                ),
              ),
      });
      expect(currentFile(), "The saved file must keep its available text.").toEqual(storedFile);
      const saved = readAcceptedEdits(o);
      expect(
        saved,
        "The accepted edits must stay available while the document is inactive.",
      ).toEqual(storedAccepted);
      expect(
        o.native.entries,
        "The queued edits must stay available while the document is inactive.",
      ).toEqual(queued);
      const rebuilt = rebuildEdits(saved, o.native.entries);
      expect(
        rebuilt.acceptedText,
        "The inactive document must still contain the accepted text.",
      ).toBe(storedText.acceptedText);
      expect(
        rebuilt.queuedText,
        "The inactive document and queued edits must still contain the latest text.",
      ).toBe(storedText.queuedText);
    }
  });

// Proves: a restarted host's ordinary recovery of a departing document reads
// only that document's activation, though a moved document's restore keeps its
// own activation at the same path. The replacement's first resume is refused as
// not ready, so it parks; the next pull still lists it departed, and it resumes
// again. Every activation read and engine request of that departure names the
// replacement's object and activation, never the moved document's, whose
// restore and activation stay as they were. The departure then settles,
// publishes and unloads the replacement, as ordinary recovery does.

// Proves: settling a moved document's finished restore route leaves the
// readiness of a replacement now hosted at its old path alone. The route waits
// on an unload the engine holds pending, and a pass activates one document, so
// the replacement and an ordinary document take turns. On every pass the
// replacement stays ready and the workspace pushes before it pulls.

// Proves: reconciliation that names deliveries the engine cannot prove gets the
// journal's answer for each in its next request: the receipt of one the relay
// accepted, and absence for one it never did. The retirement then completes.

// Proves: an activation the engine adopted, but whose adoption reply the relay
// lost before Stop, has no owner at the relay. Its retirement learns the
// adoption from the engine's reconciliation, captures the owner's cut and
// records the adoption, without adopting again, and retires at its boundary.
// A daemon that stops between the capture and the record captures again.
it.each([true])(
  "records an adoption whose reply was lost before Stop during its retirement, after a restart: %s",
  async (restart) => {
    const o = await emptyServiceHost({ adopted: false });
    vi.spyOn(console, "error").mockImplementation(() => {});
    o.f.storage.ensureOwnedLiveDocument({
      intent: "share",
      workspaceId: "workspace",
      ownerUserId: "owner",
      shareId: "share",
      path: o.sibling.path,
      nowMs: 10,
      guard() {},
    });
    const adopt = o.client().sendLiveOwnerAdoption,
      adopted = adopt.getMockImplementation()! as (...values: unknown[]) => Promise<unknown>;
    let ownersWhenLost: unknown,
      cutsWhenLost = 0;
    adopt.mockImplementationOnce(async (...args: unknown[]) => {
      await adopted(...args);
      expect(
        preparedStop(o.f.storage, {
          workspaceId: "workspace",
          ownerUserId: "owner",
          path: o.sibling.path,
          enabled: false,
          retire: true,
          nowMs: 20,
          guard() {},
        }),
      ).toMatchObject({ retired: true });
      ownersWhenLost = o.raw
        .prepare("SELECT COUNT(*) AS owners FROM sync_relay_live_delivery_owners")
        .get();
      cutsWhenLost = cuts.mock.calls.length;
      throw new Error("Adoption reply lost.");
    });
    // Any pass after the lost reply may recover the adoption through the open retirement, so these watch from the start.
    const cuts = vi.spyOn(LiveCommittedDeliveryStore.prototype, "captureOwnerCut");
    const acknowledge = LiveCommittedDeliveryStore.prototype.acknowledgeOwnerAdoption;
    let stopped = restart;
    const acks = vi
      .spyOn(LiveCommittedDeliveryStore.prototype, "acknowledgeOwnerAdoption")
      .mockImplementation(function (this: LiveCommittedDeliveryStore, ...args) {
        if (stopped) throw new Error("Daemon stopped before the adoption was recorded.");
        return acknowledge.apply(this, args);
      });
    await o.host.update({ workspaces: [o.workspace], documents: [o.sibling], ...stay });
    await vi.waitFor(() =>
      expect(adopt.mock.settledResults).toEqual([
        { type: "rejected", value: new Error("Adoption reply lost.") },
      ]),
    );
    expect(ownersWhenLost).toEqual({ owners: 0 });
    await o.host.update({ workspaces: [o.workspace], documents: [], departing: [o.sibling] });
    let host = o.host,
      captured = cutsWhenLost;
    if (restart) {
      await vi.waitFor(() => expect(acks).toHaveBeenCalled());
      await o.host.close();
      captured = cuts.mock.calls.length;
      expect(
        o.raw.prepare("SELECT COUNT(*) AS owners FROM sync_relay_live_delivery_owners").get(),
      ).toEqual({ owners: 0 });
      stopped = false;
      host = await startServiceLiveHost({ ...o.f, frameChanges: createNamedFrameChanges(16) });
      cleanup.push(() => host.close());
      await host.update({ workspaces: [o.workspace], documents: [], departing: [o.sibling] });
    }
    await vi.waitFor(() => expect(host.drained("workspace")).toBe(true));
    expect(
      o.raw
        .prepare(
          "SELECT retired_at_ms IS NOT NULL AS retired,retired_boundary_json FROM sync_relay_service_activations",
        )
        .get(),
    ).toEqual({
      retired: 1,
      retired_boundary_json: JSON.stringify({
        terminalReceipt: null,
        eventCount: 0,
        historyEvidenceDigest: initialAcceptedHistoryDigest(o.f.history.namespace, o.document),
      }),
    });
    expect(acks.mock.results.filter((result) => result.type === "return")).toHaveLength(1);
    expect(cuts).toHaveBeenCalledTimes(captured + 1);
    expect(adopt).toHaveBeenCalledTimes(1);
    if (restart) expect(o.client().sendLiveOwnerAdoption).not.toHaveBeenCalled();
  },
);

// Proves: a retirement records what the engine applied a page at a time, at
// most four pages a pass, and the next pass continues from the tip the last
// one recorded, on this daemon or one started after it stopped. It settles
// once, through the last page, and retires there.
it.each([true])(
  "records a retirement's applications a page at a time across passes and settles once through the last, after a restart: %s",
  async (restart) => {
    const o = await enrolledServiceHost({ maxApplications: 2 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seed = o.tip();
    o.lost.pending = true;
    const edits = Array.from({ length: 9 }, (_, index) => o.acceptEdit(`page-${index}`));
    // The engine applied each, though the relay recorded none.
    for (const edit of edits)
      o.applied.set(edit.deliveryId, { ...edit, localYDocSequence: edit.journalCursor + 1 });
    o.stop();
    const sent = o.ownerCalls().length,
      from = o.client().sendRequest.mock.calls.length;
    // A pass reconciles four pages; this daemon stops before the next pass's reconciliation is answered.
    const stopped = restart
      ? unansweredAfter(o, "liveApplication.reconcileActivation", 4)
      : undefined;
    await o.depart();
    let host = o.host;
    if (stopped) {
      await stopped;
      await o.host.close();
      expect(o.tip()).toEqual(edits[7]);
      expect(retiringSettles(o, sent)).toEqual([]);
      host = await restartedHost(o);
    }
    // Five pages take several passes, each of which pulls first.
    await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), { timeout: 10_000 });
    const requests = o
      .client()
      .sendRequest.mock.calls.slice(restart ? 0 : from)
      .map(
        (call) => (call as unknown[])[0] as { method: string; params: { afterReceipt?: unknown } },
      );
    const reconciles = requests.filter(
      (request) => request.method === "liveApplication.reconcileActivation",
    );
    const pages = restart ? [edits[7]] : [seed, edits[1], edits[3], edits[5], edits[7]];
    expect(reconciles.slice(0, pages.length).map((request) => request.params.afterReceipt)).toEqual(
      pages,
    );
    expect(
      reconciles
        .slice(pages.length)
        .every(
          (request) => JSON.stringify(request.params.afterReceipt) === JSON.stringify(edits[8]),
        ),
    ).toBe(true);
    expect(reconciles[0]!.params).toMatchObject({ maxApplications: 2 });
    if (!restart) {
      // The fifth page waits for the next pass, which pulls first.
      const methods = o
        .client()
        .sendRequest.mock.calls.map(
          (call) => ((call as unknown[])[0] as { method: string }).method,
        );
      const rounds = methods.flatMap((method, index) =>
        method === "liveApplication.reconcileActivation" ? [index] : [],
      );
      expect(methods.slice(rounds[3]! + 1, rounds[4])).toContain("sync.pullHosted");
    }
    expect(retiringSettles(o, restart ? 0 : sent)).toEqual([
      [
        "liveApplication.settle",
        {
          retirement: expect.objectContaining({ acceptedThrough: edits[8]!.journalCursor }),
          terminalReceipt: edits[8],
        },
      ],
    ]);
    expect(retiredRow(o).boundary.terminalReceipt).toEqual(edits[8]);
  },
);

// The pause a host given this interval takes between passes, which only a wake, or `run` below, ends in a test.
async function restartEmpty(o: Awaited<ReturnType<typeof emptyServiceHost>>) {
  await o.host.close();
  const restarted = await startServiceLiveHost({
    ...o.f,
    frameChanges: createNamedFrameChanges(16),
  });
  cleanup.push(() => restarted.close());
  const requests = () =>
    o.client().sendRequest.mock.calls.map((call) => (call as unknown[])[0] as { method: string });
  const count = (method: string) =>
    requests().filter((request) => request.method === method).length;
  return { restarted, requests, count };
}

// Proves: after a restart while the engine holds a document, its catch-up pull
// marks it held before it has an owner, so its workspace keeps pushing and
// pulling, which bring what it waits for, until its capture succeeds.

// Proves: a fresh daemon resumes a departing document an earlier one left,
// before any pull adopts the scope it left, even one a sibling's activation
// would make, then settles, publishes and unloads it. Its replica then drains.

// Proves: a restarted daemon checks its replica's origin before any work on
// its store. A relay ahead there detaches the workspace for good before a
// departing document, stopped or retained, registers, captures, applies or
// settles, and before any pull.

// Proves: a replica that could not check its origin detaches its workspace
// before any work on its store, and the next update attaches it and checks again.

// Proves: a departing document whose retained activation diverged keeps its
// unsettled work in the store. It resumes once, then no more: it stays
// retained and its workspace does not drain.

// Proves: after a restart, a departing document the engine already parked is
// not ready to resume and has nothing here to settle or unload. It is
// forgotten, never captured again, and released once a pull no longer lists it.

// Proves: a document whose fresh capture blocked keeps that block when the
// engine unloads it while idle, and a refused one is not captured again until
// it is unblocked, which allows exactly one more capture. A history past the
// read budget keeps reporting it until it is unblocked. Forgetting its target
// and adding it again, as a Stop does, clears the block, and the document is
// captured again.
it.each([
  ["refused", () => new ServiceActivationTooLarge()],
  [
    "history-over-budget",
    () =>
      new ServiceActivationHistoryOverBudget(
        "Ordinary activation history exceeds its configured entry budget.",
      ),
  ],
] as const)("keeps a %s block through an idle unload", async (block, refusal) => {
  let driver: ServiceActivationDriver | undefined;
  const addTarget = ServiceActivationDriver.prototype.addTarget;
  vi.spyOn(ServiceActivationDriver.prototype, "addTarget").mockImplementation(function (
    this: ServiceActivationDriver,
    ...args
  ) {
    driver = this;
    return addTarget.apply(this, args);
  });
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  // The relay holds no activation for the document, so each pass captures it fresh, and the capture's check refuses it.
  vi.spyOn(ServiceActivationStore.prototype, "read").mockReturnValue(null);
  vi.spyOn(ServiceActivationStore.prototype, "prepare").mockRejectedValue(refusal());
  vi.spyOn(console, "error").mockImplementation(() => {});
  const captures = () => o.client().captureOwnerActivation.mock.calls.length;
  const visits = () =>
    vi
      .mocked(ServiceActivationDriver.prototype.activate)
      .mock.calls.filter((call) => call[0].path === o.sibling.path).length;
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.blocked(o.sibling)).toBe(block));
  driver!.sleep(o.sibling, o.document);
  expect(o.host.blocked(o.sibling)).toBe(block);
  driver!.wake(o.sibling);
  const captured = captures(),
    visited = visits();
  await vi.waitFor(() => expect(visits()).toBeGreaterThan(visited + 2));
  expect(o.host.blocked(o.sibling)).toBe(block);
  if (block === "history-over-budget") {
    expect(o.host.unblock(o.sibling)).toBe(true);
    await vi.waitFor(() => expect(captures()).toBeGreaterThan(captured));
    await vi.waitFor(() => expect(o.host.blocked(o.sibling)).toBe(block));
    driver!.removeTarget(o.sibling);
    driver!.addTarget(o.sibling, o.sibling.objectId);
    expect(o.host.blocked(o.sibling)).toBeUndefined();
    return;
  }
  expect(captures()).toBe(captured);
  expect(o.host.unblock(o.sibling)).toBe(true);
  await vi.waitFor(() => expect(captures()).toBe(captured + 1));
  const retried = visits();
  await vi.waitFor(() => expect(visits()).toBeGreaterThan(retried + 2));
  expect(captures()).toBe(captured + 1);
  expect(o.host.blocked(o.sibling)).toBe("refused");
  driver!.removeTarget(o.sibling);
  driver!.addTarget(o.sibling, o.sibling.objectId);
  expect(o.host.blocked(o.sibling)).toBeUndefined();
  await vi.waitFor(() => expect(captures()).toBe(captured + 2));
});

// A document whose fresh capture blocked with `block`, reclaimed while idle as
// the idle reclaim retires it: with no owner Stop and no demand, and, unless
// `shared`, with no Edit grant left. Resolves once it left the host, or, with
// `whileDeparting`, once that ran as the departure kept its block. A document
// past the read budget is captured twice on a manual clock, so its wait holds
// until the test advances the clock.
async function reclaimedBlocked(
  block: "refused" | "history-over-budget",
  {
    shared = false,
    whileDeparting,
  }: {
    shared?: boolean;
    whileDeparting?: (o: Awaited<ReturnType<typeof emptyServiceHost>>) => void;
  } = {},
) {
  let now = 1_000_000;
  if (block === "history-over-budget") vi.spyOn(Date, "now").mockImplementation(() => now);
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  let driver: ServiceActivationDriver | undefined;
  const addTarget = ServiceActivationDriver.prototype.addTarget;
  vi.spyOn(ServiceActivationDriver.prototype, "addTarget").mockImplementation(function (
    this: ServiceActivationDriver,
    ...args
  ) {
    driver = this;
    return addTarget.apply(this, args);
  });
  o.f.storage.ensureOwnedLiveDocument({
    intent: "share",
    workspaceId: "workspace",
    ownerUserId: "owner",
    shareId: "share",
    path: o.sibling.path,
    nowMs: 10,
    guard() {},
  });
  // The relay holds no activation for the document, so each pass captures it fresh, and the capture's check refuses it.
  vi.spyOn(ServiceActivationStore.prototype, "read").mockReturnValue(null);
  vi.spyOn(ServiceActivationStore.prototype, "prepare").mockRejectedValue(
    block === "refused"
      ? new ServiceActivationTooLarge()
      : new ServiceActivationHistoryOverBudget(
          "Ordinary activation history exceeds its configured entry budget.",
        ),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  const captures = () => o.client().captureOwnerActivation.mock.calls.length;
  const visits = () =>
    vi
      .mocked(ServiceActivationDriver.prototype.activate)
      .mock.calls.filter((call) => call[0].path === o.sibling.path).length;
  // Waits for the activation passes to visit the document a few more times.
  const passes = async () => {
    const visited = visits();
    await vi.waitFor(() => expect(visits()).toBeGreaterThan(visited + 2));
  };
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.blocked(o.sibling)).toBe(block));
  if (block === "history-over-budget") {
    // The second failure starts a wait, which the stopped clock never ends.
    await vi.waitFor(() => expect(captures()).toBe(2));
    await passes();
    expect(captures()).toBe(2);
  }
  if (!shared) expect(o.f.storage.revokeShare("share", 20)).toBe(true);
  // What the idle reclaim writes to the enrollment. The document has no activation, so it opens no retirement.
  o.raw
    .prepare(
      "UPDATE sync_relay_service_host_enrollments SET enabled=0,retired=1,owner_demand=0,demand_at_ms=NULL WHERE workspace_id=? AND object_id=?",
    )
    .run("workspace", o.sibling.objectId);
  if (whileDeparting) {
    const keep = ServiceActivationDriver.prototype.keep;
    const kept = vi.spyOn(ServiceActivationDriver.prototype, "keep").mockImplementation(function (
      this: ServiceActivationDriver,
      ...args
    ) {
      keep.apply(this, args);
      whileDeparting(o);
    });
    await o.host.update({ workspaces, documents: [], departing: [o.sibling] });
    await vi.waitFor(() => expect(kept).toHaveBeenCalled());
  } else {
    await o.host.update({ workspaces, documents: [], departing: [o.sibling] });
    await vi.waitFor(() => expect(o.host.retains(o.sibling)).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true), { timeout: 10_000 });
  }
  // The owner's open or Resume, which enrolls the document again.
  const enrol = (intent: "owner-open" | "owner-resume" = "owner-open") =>
    o.f.storage.ensureOwnedLiveDocument({
      intent,
      workspaceId: "workspace",
      ownerUserId: "owner",
      path: o.sibling.path,
      nowMs: 40,
      guard() {},
    });
  return {
    ...o,
    workspaces,
    captures,
    passes,
    enrol,
    advance(ms: number) {
      now += ms;
    },
    // The block the host keeps for the document's return, read from its activation driver.
    kept: () => driver!.keptBlock({ workspaceId: "workspace", objectId: o.sibling.objectId }),
    // The enrolment, then the host update that adds the document again.
    async reopen(intent: "owner-open" | "owner-resume" = "owner-open") {
      enrol(intent);
      await o.host.update({ workspaces, documents: [o.sibling], ...stay });
    },
  };
}

// Proves: a document reclaimed while idle with a block keeps reporting it
// while it is not hosted, and the host applies the block it kept as an open
// adds the document again, before any pass, so nothing captures in between. A
// refused one is not captured again. One whose history was past the read
// budget keeps the wait it had, so it is captured again only once that wait
// ends, as it would have been had it never left.
it.each(["refused", "history-over-budget"] as const)(
  "keeps a %s block for a document reclaimed while idle, through the next open",
  async (block) => {
    const o = await reclaimedBlocked(block);
    expect(o.host.blocked(o.sibling)).toBe(block);
    expect(o.kept()).toBe(block);
    const captured = o.captures();
    o.enrol();
    expect(o.host.blocked(o.sibling)).toBe(block);
    await o.host.update({ workspaces: o.workspaces, documents: [o.sibling], ...stay });
    expect(o.host.blocked(o.sibling)).toBe(block);
    await o.passes();
    expect(o.host.blocked(o.sibling)).toBe(block);
    expect(o.captures()).toBe(captured);
    if (block === "history-over-budget") {
      o.advance(1_000);
      await vi.waitFor(() => expect(o.captures()).toBe(captured + 1));
      await o.passes();
      expect(o.captures()).toBe(captured + 1);
    }
  },
);

// Proves: a document reclaimed while idle as the last its workspace hosted
// keeps its block after the workspace drains and detaches and its enrollment
// is released, as the supervisor does then, and the next open adds it with
// that block and captures nothing.
it.each(["refused", "history-over-budget"] as const)(
  "keeps a %s block for a document reclaimed while idle as the last its workspace hosted, through the workspace's detach and the next open",
  async (block) => {
    const o = await reclaimedBlocked(block);
    await expect(o.host.detachDrained("workspace")).resolves.toBe(true);
    expect(
      o.f.storage.releaseServiceHostEnrollment({
        workspaceId: "workspace",
        objectId: o.sibling.objectId,
        nowMs: 30,
      }),
    ).not.toBeNull();
    await o.host.update({ workspaces: [], documents: [], ...stay });
    expect(o.kept()).toBe(block);
    const captured = o.captures();
    await o.reopen();
    expect(o.host.blocked(o.sibling)).toBe(block);
    await o.passes();
    expect(o.host.blocked(o.sibling)).toBe(block);
    expect(o.captures()).toBe(captured);
  },
);

// Proves: the owner's one Resume of a document reclaimed while idle with a
// refused block clears it, whether the Resume's unblock comes before or after
// the host adds the document again, and exactly one capture follows.
it.each(["before", "after"] as const)(
  "captures a document reclaimed while idle with a refused block once after one Resume, unblocked %s it is hosted again",
  async (order) => {
    const o = await reclaimedBlocked("refused"),
      captured = o.captures();
    if (order === "before") {
      // As the Resume route unblocks the document before the host reconciles.
      expect(o.host.unblock(o.sibling)).toBe(true);
      expect(o.kept()).toBeUndefined();
      await o.reopen("owner-resume");
    } else {
      await o.reopen("owner-resume");
      await o.passes();
      expect(o.captures()).toBe(captured);
      expect(o.host.unblock(o.sibling)).toBe(true);
    }
    await vi.waitFor(() => expect(o.captures()).toBe(captured + 1));
    await o.passes();
    expect(o.captures()).toBe(captured + 1);
    expect(o.host.blocked(o.sibling)).toBe("refused");
  },
);

// Proves: the owner's Resume of a document reclaimed while idle with a refused
// block, pressed while the host still holds the departing document, also
// clears the block kept for its return, so exactly one capture follows once it
// is hosted again.
it("captures a document reclaimed while idle with a refused block once after a Resume pressed while it departs", async () => {
  let captured = -1,
    unblocked = false;
  const o = await reclaimedBlocked("refused", {
    whileDeparting(held) {
      if (captured >= 0) return;
      captured = held.client().captureOwnerActivation.mock.calls.length;
      // As the Resume route: it enrolls the document again, then unblocks it.
      held.f.storage.ensureOwnedLiveDocument({
        intent: "owner-resume",
        workspaceId: "workspace",
        ownerUserId: "owner",
        path: held.sibling.path,
        nowMs: 40,
        guard() {},
      });
      unblocked = held.host.unblock(held.sibling);
    },
  });
  expect(unblocked).toBe(true);
  await o.host.update({ workspaces: o.workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.captures()).toBe(captured + 1));
  await o.passes();
  expect(o.captures()).toBe(captured + 1);
  expect(o.host.blocked(o.sibling)).toBe("refused");
});

// Proves: the owner's Stop or Pause of a document reclaimed while idle clears
// its block at the next host update, so the owner's Resume captures it again
// with no unblock.
it.each(["Stop", "Pause"] as const)(
  "clears the block of a document reclaimed while idle at the host update after the owner's %s",
  async (action) => {
    const o = await reclaimedBlocked("refused"),
      captured = o.captures();
    expect(o.kept()).toBe("refused");
    if (action === "Stop") {
      expect(
        preparedStop(o.f.storage, {
          workspaceId: "workspace",
          ownerUserId: "owner",
          path: o.sibling.path,
          enabled: false,
          retire: true,
          nowMs: 30,
          guard() {},
        }),
      ).toMatchObject({ ownerStop: "retire" });
    } else {
      expect(
        o.f.storage.setServiceHostEnrollmentEnabled({
          workspaceId: "workspace",
          path: o.sibling.path,
          ownerUserId: "owner",
          enabled: false,
          nowMs: 30,
          guard() {},
        }),
      ).toMatchObject({ ownerStop: "pause" });
    }
    expect(o.kept()).toBe("refused");
    await o.host.update({ workspaces: o.workspaces, documents: [], ...stay });
    expect(o.kept()).toBeUndefined();
    await o.reopen("owner-resume");
    await vi.waitFor(() => expect(o.captures()).toBe(captured + 1));
  },
);

// Proves: deleting the share of a document reclaimed while idle leaves its
// block, which an open then keeps.
it("keeps the block of a document reclaimed while idle after its share is deleted", async () => {
  const o = await reclaimedBlocked("refused", { shared: true }),
    captured = o.captures();
  expect(o.kept()).toBe("refused");
  expect(o.f.storage.revokeShare("share", 30)).toBe(true);
  await o.host.update({ workspaces: o.workspaces, documents: [], ...stay });
  expect(o.kept()).toBe("refused");
  await o.reopen();
  await o.passes();
  expect(o.captures()).toBe(captured);
  expect(o.host.blocked(o.sibling)).toBe("refused");
});

// Proves: once the path of a document reclaimed while idle holds another
// document, or none after a delete, the reclaimed document's block is gone at
// the next host update. The host reads only what the path holds, whoever
// changed it. Another document hosted at that path is captured.
it.each(["another document", "no document"] as const)(
  "clears the block of a document reclaimed while idle once its path holds %s",
  async (holder) => {
    const o = await reclaimedBlocked("refused"),
      captured = o.captures();
    expect(o.kept()).toBe("refused");
    const other = { ...o.sibling, objectId: "another-object" },
      at = o.f.storage.objectIdAtPathInVersion.bind(o.f.storage);
    vi.spyOn(o.f.storage, "objectIdAtPathInVersion").mockImplementation((input) =>
      input.path === o.sibling.path
        ? holder === "another document"
          ? other.objectId
          : undefined
        : at(input),
    );
    await o.host.update({
      workspaces: o.workspaces,
      documents: holder === "another document" ? [other] : [],
      ...stay,
    });
    expect(o.kept()).toBeUndefined();
    expect(o.host.unblock(o.sibling)).toBe(false);
    if (holder === "another document")
      await vi.waitFor(() => expect(o.captures()).toBe(captured + 1));
  },
);

// Proves: a document held for a live edit its session never admitted cannot
// become ready, so it gets one capture and then none. Its workspace keeps
// pushing and pulling, and a sibling keeps its passes. Unblocking allows
// exactly one more capture, which makes it ready once the hold clears.

// Proves: a retained activation the engine refuses as diverged resumes once
// after a restart and then no more, while its workspace keeps pushing and
// pulling. Unblocking resumes it exactly once more.

// Proves: a document with no Y.Doc lineage has nothing to activate, so its
// first capture blocks it and no pass captures it again, while its workspace
// keeps pulling. Unblocking allows exactly one more capture. Any other conflict
// on a first capture keeps it waiting and captured again, waiting longer between
// tries, not on every pass.

// Proves: a document whose capture found no Y.Doc lineage captures once more,
// with no Resume, only once the relay holds a Y.Doc update for it newer than
// any that capture saw. A moment, or another document's update, does not lift
// it. It then activates and stops reporting the block.

// Proves: a document still without lineage after the update that lifted its
// block blocks again, at that update, so it captures once per new update. One
// whose retry meets another conflict is no longer blocked and waits.

// Proves: an update that reached the relay while the capture's pull ran may
// have missed that pull, so it lifts the block that capture left.

// Proves: a target sharing another's catch-up pull blocks at that pull's
// head. A second ownerless target whose document took an update after the
// first target's pull started, and before its own activation read the latest,
// blocks at the head that pull started at, so it captures once more on a
// later pass, and only once.

// The pause a host given this interval takes between passes, which only a wake, or `run` below, ends in a test.
const HELD_POLL_MS = 3_600_000;
// The supervisor's interval between reconciliations in a test that holds them, which only its own wakes end.
const HELD_RECONCILE_MS = 2 * HELD_POLL_MS;
// Watches the activation loop's pauses; start it before the host. `run` ends the pause the loop waits in and
// resolves once the pass after it ends. `until` runs passes so, at most five, until `done` holds. `paused` says
// whether the loop waits in a pause now, and `early` counts pauses the host ended itself, as a wake does.
function heldPolls() {
  const timers = vi.spyOn(globalThis, "setTimeout"),
    cleared = vi.spyOn(globalThis, "clearTimeout"),
    ended = new Set<unknown>();
  cleanup.push(async () => {
    timers.mockRestore();
    cleared.mockRestore();
  });
  const waiting = () => {
    for (let index = timers.mock.calls.length - 1; index >= 0; index--) {
      if (timers.mock.calls[index]![1] !== HELD_POLL_MS) continue;
      const timer: unknown = timers.mock.results[index]?.value;
      if (ended.has(timer) || cleared.mock.calls.some((call) => call[0] === timer))
        return undefined;
      return { timer, end: timers.mock.calls[index]![0] as () => void };
    }
    return undefined;
  };
  // A wake may end the pause first, and the pass it runs counts: the loop waited in the pause when `passed` began.
  const run = async (f: { passEnds: Set<() => void> }) => {
    let passed: Promise<void> | undefined;
    const pause = await vi.waitFor(() => {
      const pause = waiting();
      expect(pause).toBeDefined();
      passed = afterPasses(f, 0);
      return pause!;
    });
    ended.add(pause.timer);
    pause.end();
    await passed;
  };
  return {
    run,
    async until(f: { passEnds: Set<() => void> }, done: () => boolean) {
      for (let pass = 0; pass < 5 && !done(); pass++) await run(f);
    },
    paused: () => waiting() !== undefined,
    early: () =>
      timers.mock.calls.filter((call, index) => {
        const timer: unknown = timers.mock.results[index]?.value;
        return (
          call[1] === HELD_POLL_MS &&
          !ended.has(timer) &&
          cleared.mock.calls.some((clear) => clear[0] === timer)
        );
      }).length,
  };
}

// A clock that moves only when the test advances it, and the timers the host sets on it.
function manualClock() {
  let now = 0;
  const timers: { atMs: number; fire: () => void; over: boolean }[] = [];
  return {
    nowMs: () => now,
    schedule(atMs: number, fire: () => void) {
      const timer = { atMs, fire, over: false };
      timers.push(timer);
      return () => {
        timer.over = true;
      };
    },
    // The deadlines the host's timers wait for now.
    armed: () => timers.filter((timer) => !timer.over).map((timer) => timer.atMs),
    // Moves the clock to `atMs` and fires each timer that fell due.
    advance(atMs: number) {
      now = atMs;
      for (const timer of timers)
        if (!timer.over && timer.atMs <= atMs) {
          timer.over = true;
          timer.fire();
        }
    },
  };
}

// Proves: a diverged replica stops and detaches, its documents stay retained,
// and no later update attaches its store again on this daemon. A new
// identity's store is another store, so it attaches.
it("detaches a diverged workspace for good and retains its documents", async () => {
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.replies.diverge = true;
  await vi.waitFor(() =>
    expect(o.host.diverged()).toEqual([{ workspaceId: "workspace", root: o.workspace.root }]),
  );
  expect(o.membership).toEqual([o.attach, o.detach]);
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  o.replies.diverge = false;
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  expect(o.membership).toEqual([o.attach, o.detach]);
  expect(o.host.diverged()).toEqual([{ workspaceId: "workspace", root: o.workspace.root }]);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  const rotatedRoot = join(o.f.root, "workspace-rotated");
  await mkdir(rotatedRoot);
  expect(
    o.f.storage.rotateWorkspaceIdentity({
      workspaceId: "workspace",
      ownerUserId: "owner",
      replicationEpoch: "epoch-2",
      streamIdentity: "stream-2",
      rotatedAtMs: 10,
    }),
  ).toBe("rotated");
  await o.host.update({
    workspaces: [
      {
        ...o.workspace,
        root: rotatedRoot,
        hostedReplication: {
          ...o.workspace.hostedReplication!,
          identity: { replicationEpoch: "epoch-2", streamIdentity: "stream-2" },
        },
      },
    ],
    documents: [],
    ...stay,
  });
  expect(o.membership).toEqual([
    o.attach,
    o.detach,
    { ...o.attach, params: { ...o.attach.params, root: rotatedRoot } },
  ]);
  // A second divergence, under the new identity, keeps the first store's.
  o.replies.diverge = true;
  await vi.waitFor(() =>
    expect(o.host.diverged()).toEqual([
      { workspaceId: "workspace", root: o.workspace.root },
      { workspaceId: "workspace", root: rotatedRoot },
    ]),
  );
});

// Proves: deleting an account's workspace detaches it at once, unloading
// nothing of its hosted document, and removes its store with the live state
// parked there. Another workspace stays attached with its store.
it("detaches a deleted workspace at once and removes its store", async () => {
  const o = await emptyServiceHost(),
    otherRoot = join(o.f.root, "workspace-2");
  await mkdir(otherRoot);
  await o.host.update({
    workspaces: [o.workspace, { ...o.workspace, root: otherRoot, workspaceId: "workspace-2" }],
    documents: [o.sibling],
    ...stay,
  });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  await writeFile(join(o.workspace.root, "replica.sqlite"), "parked live state");
  await o.host.deleteWorkspaces(["workspace"]);
  expect(o.membership.filter((row) => row.method !== "liveApplication.attachWorkspace")).toEqual([
    o.detach,
  ]);
  expect(existsSync(o.workspace.root)).toBe(false);
  expect(existsSync(otherRoot)).toBe(true);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(o.host.automationLedger("workspace")).toBeNull();
  expect(o.host.automationLedger("workspace-2")).not.toBeNull();
});

it.each([false, true])(
  "detaches a workspace at once when its identity changes, leaving its pending document unsettled (new documents at once: %s)",
  async (newAtOnce) => {
    const o = await emptyServiceHost();
    const siblingRoot = join(o.f.root, "workspace-2"),
      rotatedRoot = join(o.f.root, "workspace-rotated");
    await mkdir(siblingRoot);
    await mkdir(rotatedRoot);
    const sibling = { ...o.workspace, root: siblingRoot, workspaceId: "workspace-2" },
      siblingDocument = { ...o.other, workspaceId: "workspace-2" };
    const rotated = {
      ...o.workspace,
      root: rotatedRoot,
      hostedReplication: {
        ...o.workspace.hostedReplication!,
        identity: { replicationEpoch: "epoch-2", streamIdentity: "stream-2" },
      },
    };
    await o.host.update({
      workspaces: [o.workspace, sibling],
      documents: [o.other, siblingDocument],
      ...stay,
    });
    expect(o.host.retains(o.other)).toBe(true);
    o.membership.splice(0);
    // Settlement under the old identity is refused, so an unload would stay pending forever.
    o.unloads.push({ status: "pending", reason: "settlement-pending" });
    expect(
      o.f.storage.rotateWorkspaceIdentity({
        workspaceId: "workspace",
        ownerUserId: "owner",
        replicationEpoch: "epoch-2",
        streamIdentity: "stream-2",
        rotatedAtMs: 10,
      }),
    ).toBe("rotated");
    const attach = { ...o.attach, params: { ...o.attach.params, root: rotatedRoot } };
    const rotatedSet = {
      workspaces: [rotated, sibling],
      documents: [o.other, siblingDocument],
      ...stay,
    };
    if (!newAtOnce) {
      await o.host.update({ workspaces: [sibling], documents: [siblingDocument], ...stay });
      expect(o.membership).toEqual([o.detach]);
      expect(o.host.settled(o.other)).toBe(false);
      expect(o.host.automationLedger("workspace")).toBeNull();
      // Nothing is left to retry.
      await o.host.update({ workspaces: [sibling], documents: [siblingDocument], ...stay });
      expect(o.membership).toEqual([o.detach]);
    }
    await o.host.update(rotatedSet);
    expect(o.membership).toEqual([o.detach, attach]);
    expect(o.host.retains(o.other)).toBe(true);
    // The sibling workspace keeps its attachment and document throughout.
    expect(o.host.retains(siblingDocument)).toBe(true);
    expect(o.host.automationLedger("workspace-2")).not.toBeNull();
    expect(o.membership.every((row) => row.workspace !== "attached-workspace-2")).toBe(true);
    expect(o.spawned()).toBe(1);
    expect(o.client().close).not.toHaveBeenCalled();
  },
);

it("removes a detached configured root after restart and keeps unrelated roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-configured-root-deletion-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const deleted = join(root, "deleted"),
    kept = join(root, "kept");
  await mkdir(deleted);
  await mkdir(kept);
  await writeFile(join(deleted, "account"), "deleted-person");
  const configPath = join(root, "host.json");
  const hostedReplication = {
    relay: { baseUrl: "https://relay.example", bearerToken: "service-token" },
    identity: { replicationEpoch: "epoch", streamIdentity: "stream" },
    maxPagesPerPull: 8,
  };
  await writeFile(
    configPath,
    JSON.stringify({
      workspaces: [
        { root: deleted, workspaceId: "deleted", maxRegistrations: 1, hostedReplication },
        { root: kept, workspaceId: "kept", maxRegistrations: 1 },
      ],
    }),
  );
  await deleteConfiguredServiceWorkspaceRoots(configPath, ["deleted"]);
  await deleteConfiguredServiceWorkspaceRoots(configPath, ["deleted"]);
  expect(existsSync(deleted)).toBe(false);
  expect(existsSync(kept)).toBe(true);
  await writeFile(
    configPath,
    JSON.stringify({
      workspaces: [
        { root, workspaceId: "deleted", maxRegistrations: 1 },
        { root: kept, workspaceId: "kept", maxRegistrations: 1 },
      ],
    }),
  );
  await expect(deleteConfiguredServiceWorkspaceRoots(configPath, ["deleted"])).rejects.toThrow(
    "overlap",
  );
  expect(existsSync(kept)).toBe(true);
});

// An empty host holding the real document and a held one, on a manual clock.
// Only Date.now is fake: passes run on real timers, and visits to the held
// document count them. `hold` keeps passes from activating the real document.
// `alone` moves the held document to a second workspace, so the real one is alone in its workspace.
// With `polls`, passes run only when the host wakes itself, or the test runs one, as in setup here, and
// idle unloading reads and arms `clock` instead.
async function idleHost(
  options: {
    alone?: boolean;
    polls?: ReturnType<typeof heldPolls>;
    clock?: IdleClock;
    maxDocumentsPerPass?: number;
  } = {},
) {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const o = await emptyServiceHost({
      frameChanges: true,
      ...(options.polls ? { pollIntervalMs: HELD_POLL_MS } : {}),
      ...(options.clock ? { idleClock: options.clock } : {}),
      ...(options.maxDocumentsPerPass ? { maxDocumentsPerPass: options.maxDocumentsPerPass } : {}),
    }),
    workspaces = [o.workspace];
  let other = o.other;
  if (options.alone) {
    const root = join(o.f.root, "workspace-2");
    await mkdir(root);
    workspaces.push({ ...o.workspace, root, workspaceId: "workspace-2" });
    other = { ...o.other, workspaceId: "workspace-2" };
  }
  const activate = vi.mocked(ServiceActivationDriver.prototype.activate),
    through = activate.getMockImplementation()!;
  let held = false;
  activate.mockImplementation(function (this: ServiceActivationDriver, ...args) {
    return held && args[0].path === o.sibling.path
      ? Promise.resolve({ kind: "pending" as const, reason: "held" })
      : through.apply(this, args);
  });
  await o.host.update({ workspaces, documents: [o.sibling, other], ...stay });
  if (options.polls) await options.polls.until(o.f, () => o.host.isDocumentReady(o.document));
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const visits = (path: string) =>
    activate.mock.calls.filter(([target]) => target.path === path).length;
  const requests = () =>
    o
      .client()
      .sendRequest.mock.calls.map(
        (call) => (call as unknown[])[0] as { method: string; params: Record<string, unknown> },
      );
  const methods = () => requests().map((request) => request.method);
  return {
    ...o,
    workspaces,
    editors: liveEditors(o.f.storage),
    requests,
    methods,
    visits,
    hold(value: boolean) {
      held = value;
    },
    advance(ms: number) {
      now += ms;
    },
    async passes(count = 2) {
      const start = visits(o.other.path);
      await vi.waitFor(() => expect(visits(o.other.path)).toBeGreaterThanOrEqual(start + count));
    },
    unloaded: () =>
      o.membership.filter(
        (row) =>
          row.method === "liveApplication.unloadDocument" &&
          (row.params as { objectId: string }).objectId === "object",
      ).length,
    settles: () =>
      requests()
        .filter((request) => request.method === "liveApplication.settle")
        .map((request) => request.params.terminalReceipt),
    binding() {
      const current = o.f.storage.resolveCurrentLiveDocumentBinding({
        document: o.document,
        actor: { kind: "owner", userId: "owner" },
      });
      if (current.kind !== "current") throw new Error("Missing live binding.");
      return current.binding;
    },
  };
}

// A hold of the sibling document for released retained work, as a pass names
// it, bound as the engine's first shared vector is, with `incoming` changed.
const releasedHold = (incoming: Partial<ReleasedLineageBinding["incoming"]> = {}) => {
  const binding = JSON.parse(bindingVectors.valid[0]!.canonical) as ReleasedLineageBinding;
  return {
    objectId: "object",
    reason: "released-lineage-unsettled",
    path: binding.currentPath!,
    bindingDigest: releasedLineageBindingDigest({
      ...binding,
      incoming: { ...binding.incoming, ...incoming },
    }),
    continuation: "frozen",
    bindingStale: false,
  };
};
const digest = (hold: ReturnType<typeof releasedHold>) => hold.bindingDigest;
// The driver a host activates through, once a pass held one of its documents. `heard` hears it after each pass.
const heldDriver = (heard?: (driver: ServiceActivationDriver, window: HostedWindow) => void) => {
  let driver: ServiceActivationDriver | undefined;
  const hold = ServiceActivationDriver.prototype.hold;
  vi.spyOn(ServiceActivationDriver.prototype, "hold").mockImplementation(function (
    this: ServiceActivationDriver,
    ...args
  ) {
    driver = this;
    const dropped = hold.apply(this, args);
    heard?.(this, args[2]);
    return dropped;
  });
  return () => driver;
};

// Proves: a document held for released retained work blocks only its own
// activation, keyed by its binding's digest. It never captures, its workspace
// keeps pushing and pulling, and passes still visit the other document. A
// fresh binding replaces the digest. Resume, and the resolution of another
// binding, one bound to the feed's namespace where this one names none among
// them, leave it held. Only its own binding's resolution lets it capture again.
it("holds a document for released retained work by its binding's digest until that binding is resolved", async () => {
  const o = await emptyServiceHost(),
    workspaces = [o.workspace],
    driver = heldDriver();
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const captures = () => o.client().captureOwnerActivation.mock.calls.length;
  const pushes = () =>
    o
      .client()
      .sendRequest.mock.calls.filter(
        (call) => ((call as unknown[])[0] as { method: string }).method === "sync.push",
      ).length;
  const visits = () =>
    vi
      .mocked(ServiceActivationDriver.prototype.activate)
      .mock.calls.filter((call) => call[0].path === o.other.path).length;
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const unbound = releasedHold({ relayNamespace: null }),
    bound = releasedHold(),
    refreshed = releasedHold({ relayNamespace: null, originSeq: 1 });
  o.replies.pass = { held: [unbound] };
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(unbound)));
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(false));
  const held = captures(),
    pushed = pushes();
  await o.nextPull();
  await o.nextPull();
  expect(captures()).toBe(held);
  expect(pushes()).toBeGreaterThan(pushed);
  // Resume does not resolve it, and it is no block Resume could lift.
  expect(o.host.blocked(o.sibling)).toBeUndefined();
  expect(o.host.unblock(o.sibling)).toBe(false);
  expect(driver()!.clearResolvedHold(o.sibling, digest(bound))).toBe(false);
  o.replies.pass = { held: [refreshed] };
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBe(digest(refreshed)));
  expect(driver()!.clearResolvedHold(o.sibling, digest(unbound))).toBe(false);
  await o.nextPull();
  expect(captures()).toBe(held);
  await o.host.update({ workspaces, documents: [o.sibling, o.other], ...stay });
  const visited = visits();
  await vi.waitFor(() => expect(visits()).toBeGreaterThan(visited + 2));
  expect(captures()).toBe(held);
  o.replies.pass = {};
  o.refuseCapture(undefined);
  expect(driver()!.clearResolvedHold(o.sibling, digest(refreshed))).toBe(true);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(captures()).toBeGreaterThan(held);
  expect(driver()!.releasedHold(o.sibling)).toBeUndefined();
});

// Proves: a pass whose held list was cut says nothing past where it stops.
// A list that names the document refreshes its hold; one that stops before
// it, or starts after it, leaves the hold as it was, cut or not. Only a list
// whose window reaches it frees it, once the engine no longer holds it.
it("keeps a released-lineage hold a cut held list leaves out, until a list that reaches it", async () => {
  const seen: { covers: boolean; digest: string | undefined }[] = [];
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  const driver = heldDriver((held, window) =>
    seen.push({
      covers: hostedWindowCovers(window, "object"),
      digest: held.releasedHold(o.sibling),
    }),
  );
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const hold = releasedHold(),
    refreshed = releasedHold({ originSeq: 1 });
  const waiting = (objectId: string) => ({ objectId, reason: "hosted-backfill-work-waiting" });
  o.replies.pass = { held: [hold] };
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  // Two holds a pass: the first lists "another" and the sibling, the next "zebra" alone.
  o.replies.heldPerPass = 2;
  o.replies.pass = { held: [waiting("another"), refreshed, waiting("zebra")] };
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBe(digest(refreshed)));
  const refreshing = seen.length;
  await o.nextPull();
  await o.nextPull();
  expect(seen.slice(refreshing).some((row) => !row.covers)).toBe(true);
  expect(seen.slice(refreshing).every((row) => row.digest === digest(refreshed))).toBe(true);
  // The engine holds the sibling no more. One hold a pass: lists stop before it until one reaches it.
  const releasing = seen.length;
  o.replies.heldPerPass = 1;
  o.replies.pass = { held: [waiting("another"), waiting("apple")] };
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBeUndefined());
  const freed = seen.findIndex((row, index) => index >= releasing && row.digest === undefined);
  expect(seen.slice(releasing, freed).some((row) => !row.covers)).toBe(true);
  expect(seen.slice(releasing, freed).every((row) => row.digest === digest(refreshed))).toBe(true);
  expect(seen[freed]!.covers).toBe(true);
  o.replies.pass = {};
  o.refuseCapture(undefined);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
});

// A pass that moves more documents from ready to held than its answer fits
// cuts `newlyHeld` silently, and a pass whose commit's reply is lost never
// reaches activation. Either way a live document past its page's held window
// can be in neither list. Proves: such a page drops every owner past its
// window, though it names none of them; the document activates again, where
// the engine refuses it until a list names its hold.
it("drops every owner past the window of a page whose newly held list may leave some out after a lost commit", async () => {
  const seen: { covers: boolean; owned: boolean; held: boolean }[] = [];
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  const driver = heldDriver((held, window) =>
    seen.push({
      covers: hostedWindowCovers(window, "object"),
      owned: held.ownerDocument(o.sibling) !== undefined,
      held: held.releasedHold(o.sibling) !== undefined,
    }),
  );
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const hold = releasedHold(),
    waiting = { objectId: "another", reason: "hosted-backfill-work-waiting" as const };
  const holding = seen.length;
  // One hold a pass, so each first list stops at "another", before the sibling's "object", and no newly held list names it.
  o.replies.heldPerPass = 1;
  o.replies.pass = { held: [waiting, hold] };
  o.replies.loseCommit = true;
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  const dropped = seen.findIndex((row, index) => index >= holding && !row.owned);
  expect(seen[dropped]).toEqual({ covers: false, owned: false, held: false });
  expect(o.host.isDocumentReady(o.document)).toBe(false);
});

// A workspace pushed only once every document it hosts had gone live, so a
// live document's settled edits reached nobody while another document kept
// failing to go live, until that one went live or the live one unloaded idle.
// Proves: a live document's edit, settled on the host, is pushed on the next
// pass while another document in its workspace waits out a backoff after
// failed activations. That document has not gone live or left, and the live
// one has not unloaded.
it("pushes a live document's settled edit on the next pass while another document in its workspace backs off", async () => {
  const o = await emptyServiceHost({ maxDocumentsPerPass: 2 }),
    workspaces = [o.workspace];
  // Both documents activate for real here, the other at a path the relay names it at.
  vi.mocked(ServiceActivationDriver.prototype.activate).mockRestore();
  vi.mocked(ServiceActivationDriver.prototype.loaded).mockRestore();
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await o.pushed.promise;
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  o.raw
    .prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,
    content_kind,byte_length,recorded_at_ms) SELECT 'workspace',?,MAX(relay_seq),'other-moment','main',?,?,'text',0,0
    FROM sync_relay_log WHERE workspace_id='workspace'`)
    .run(o.other.objectId, o.other.path, "e".repeat(64));
  const captures = () =>
    o.client().captureOwnerActivation.mock.calls.filter((call) => call[1] === o.other.path).length;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCaptureAt(o.other.path, new Error("Capture failed."));
  await o.host.update({ workspaces, documents: [o.sibling, o.other], ...stay });
  // The first failure retries on the next pass; the second starts a wait before the next try.
  await vi.waitFor(() => expect(captures()).toBeGreaterThanOrEqual(2));
  expect(errors).toHaveBeenCalledWith("Service activation pass failed.", "Error");
  const edit = o.acceptEdit("while-another-backs-off");
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
  await o.host.settle(o.document);
  const requests = () =>
    o.client().sendRequest.mock.calls.map(
      (call) =>
        (call as unknown[])[0] as {
          method: string;
          params: { terminalReceipt?: { deliveryId?: string } | null };
        },
    );
  const settledAt = requests().findIndex(
    (request) =>
      request.method === "liveApplication.settle" &&
      request.params.terminalReceipt?.deliveryId === edit.deliveryId,
  );
  expect(settledAt).toBeGreaterThan(-1);
  await o.nextPass();
  const after = requests()
    .slice(settledAt + 1)
    .map((request) => request.method);
  expect(after, "The settled edit must be pushed on the next pass.").toContain("sync.push");
  expect(after).not.toContain("liveApplication.unloadDocument");
  expect(o.host.retains(o.other)).toBe(true);
  expect(o.host.settled(o.other)).toBe(false);
  // The other document still holds readiness, so the workspace keeps its pull every pass. A pass that tries
  // the other document again catches up instead, at most once across these three passes since each wait is longer.
  const unreadyPulls = () => o.host.hostedPulls(o.workspace.workspaceId).reasons.unready ?? 0,
    pulled = unreadyPulls();
  await o.nextPass();
  await o.nextPass();
  await o.nextPass();
  expect(
    unreadyPulls(),
    "The workspace must keep pulling every pass while the other document backs off.",
  ).toBeGreaterThanOrEqual(pulled + 2);
});

// A pull after a departure is not its replica's chance to retire it when the
// pull's departed list stops short of it. Proves: while the relay rotates its
// pages, as the self-hosted relay does with a sibling keeping the workspace
// attached, a page keeps its turn until a departed list reaches each of its
// documents, so a parked document is confirmed gone within a few pulls, and
// never while a list names it.
it("confirms a parked document gone while its retired enrollment pages rotate, and never while a list names it", async () => {
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  const left = { workspaceId: "workspace", objectId: "object-z", path: "docs/left.md" };
  const stuck = { workspaceId: "workspace", objectId: "object-a1", path: "docs/stuck.md" };
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const list = (ids: string[]) => {
    o.replies.pass = { departed: ids };
    o.replies.commit = { departed: ids };
  };
  // Each page is one retired enrollment. As on the self-hosted relay, the next page gets its turn once the host says each
  // document on this one had its replica's pull after it departed.
  const pages = [[stuck], [left]];
  let turn = 0;
  const select = () =>
    o.host.update({ workspaces, documents: [o.sibling], departing: pages[turn]! });
  // One pull at a time, then the next selection before the next pass.
  const pull = async () => {
    const parked = o.park("sync.pullHosted");
    await parked.entered.promise;
    const finished = select();
    parked.release.resolve();
    await finished;
  };
  const rotate = async () => {
    if (pages[turn]!.every((row) => o.host.pulledAfterDeparture(row)))
      turn = (turn + 1) % pages.length;
    await select();
  };
  // Two departed documents an answer, so lists alternate between "object-a1".."object-a2" and those after.
  o.replies.departedPerPass = 2;
  const first = o.park("sync.pullHosted");
  await first.entered.promise;
  list(["object-a1", "object-a2", "object-a3", left.objectId]);
  const selected = select();
  first.release.resolve();
  await selected;
  for (let pulls = 0; pulls < 8; pulls++) {
    await pull();
    expect(o.host.retains(left)).toBe(true);
    await rotate();
  }
  // The engine parks it.
  list(["object-a1", "object-a2", "object-a3"]);
  for (let pulls = 1; ; pulls++) {
    await pull();
    if (!o.host.retains(left)) break;
    expect(pulls).toBeLessThan(4);
    await rotate();
  }
});

// The owner's Stop through the running host, as the route asks it: the host
// delivers and prepares the document, then `fence` runs the relay's Stop.
const hostStop = (
  o: Awaited<ReturnType<typeof enrolledServiceHost>>,
  signal?: AbortSignal,
  fence = (prepared?: ServiceHostRetirementPreparation) =>
    o.f.storage.setServiceHostEnrollmentEnabled({
      workspaceId: "workspace",
      ownerUserId: "owner",
      path: o.sibling.path,
      enabled: false,
      retire: true,
      nowMs: 20,
      guard() {},
      ...(prepared ? { prepared } : {}),
    }),
) => o.host.stop({ workspaceId: "workspace", objectId: "object" }, fence, signal);
// The document's own native queue holding `d`, which the relay refused, and
// `e` behind it, with the refusal the server keeps for its owner. Passes
// leave its delivery to the test.
function refusedNative(o: Awaited<ReturnType<typeof enrolledServiceHost>>) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const identity = o.workspace.hostedReplication!.identity,
    queue = { workspaceId: "workspace", identity, outboxId: "native-outbox" };
  Object.assign(o.native, { binding: o.binding, state: "quarantined" });
  o.f.storage.recordServiceKeptEdits({
    identity,
    outboxId: "native-outbox",
    binding: o.binding,
    reason: "invalid-update",
    headDeliveryId: "edit-d",
    refusalKey: "refusal-d",
    nowMs: 1,
  });
  o.nativeEdits("d", "e");
  return {
    row: () => o.f.storage.readServiceKeptEdits(queue),
    async grant() {
      await expect(
        o.host.retryKeptEdits(o.f.storage.readServiceKeptEdits(queue)!, () => {}),
      ).resolves.toBe("granted");
    },
  };
}
// The live journal's cursors for a delivery.
const journaled = (o: Awaited<ReturnType<typeof enrolledServiceHost>>, deliveryId: string) =>
  o.raw
    .prepare(
      "SELECT journal_cursor FROM sync_relay_live_update_journal WHERE delivery_id=? ORDER BY journal_cursor",
    )
    .all(deliveryId)
    .map((row) => Number(row.journal_cursor));
const engineParams = (o: Awaited<ReturnType<typeof enrolledServiceHost>>, method: string) =>
  o
    .ownerCalls()
    .filter(([called]) => called === method)
    .map(([, params]) => params);
const prepared = (o: Awaited<ReturnType<typeof enrolledServiceHost>>) => ({
  objectId: "object",
  activationId: ACTIVATION,
  lineageClaimId: o.document.lineageClaimId,
  restoreFenceGeneration: o.binding.restoreFenceGeneration,
});
// Nothing fenced: no retirement opened and the document's admission stays open.
const stillLive = (o: Awaited<ReturnType<typeof enrolledServiceHost>>) => {
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
  expect(o.f.storage.serviceHostDocumentEnabled(o.sibling)).toBe(true);
  expect(o.f.storage.readServiceHostEnrollment("workspace", o.sibling.path)).toMatchObject({
    enabled: true,
    retired: false,
    ownerStop: null,
  });
};

// Proves: Stop waits while the engine still holds an edit for the relay, even
// one the relay accepted whose acknowledgement was lost, and keeps the
// owner's Try again. It fences and blocks nothing. Once a drain replays that
// edit and delivers the one behind it, the next Stop prepares the activation
// and retires through both. Stopping again replays that retirement.
it("waits to stop while a granted edit's acknowledgement is lost, then retires through it and the edit behind it", async () => {
  const o = await enrolledServiceHost(),
    n = refusedNative(o);
  await n.grant();
  o.native.loseAcks.add("edit-d");
  await expect(o.host.drain(o.document)).rejects.toThrow("Acknowledgement lost.");
  expect(journaled(o, "edit-d")).toHaveLength(1);
  const preparationRequest = {
    id: 900,
    workspace: "attached-handle",
    method: "liveApplication.prepareRetirement",
    params: prepared(o),
  };
  expect((await o.client().sendRequest(preparationRequest)).result).toEqual(
    preparationWire.retryOutstanding,
  );
  await expect(hostStop(o)).resolves.toBe("waiting");
  expect(o.native.entries.map((entry) => entry.deliveryId)).toEqual(["edit-d", "edit-e"]);
  expect(engineParams(o, "liveApplication.prepareRetirement")).toEqual([prepared(o), prepared(o)]);
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([]);
  expect(o.engine.prepared).toBeUndefined();
  stillLive(o);
  expect(n.row()).toMatchObject({ retrying: true });
  expect(o.native).toMatchObject({ state: "quarantined", retryDeliveryId: "edit-d" });
  // The replay acknowledges `d` with the receipt the relay kept, then delivers `e`.
  o.native.loseAcks.clear();
  await o.host.drain(o.document);
  expect(o.native.entries).toEqual([]);
  const [d] = journaled(o, "edit-d"),
    [e] = journaled(o, "edit-e");
  expect(journaled(o, "edit-d")).toEqual([d]);
  expect(e).toBeGreaterThan(d!);
  await expect(hostStop(o)).resolves.toMatchObject({
    enabled: false,
    retired: true,
    acceptedCursor: e,
  });
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toMatchObject({
    activationId: ACTIVATION,
    acceptedThrough: e,
  });
  expect(engineParams(o, "liveApplication.prepareRetirement")).toEqual([
    prepared(o),
    prepared(o),
    prepared(o),
  ]);
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([]);
  await expect(hostStop(o)).resolves.toMatchObject({ retired: true, acceptedCursor: e });
  expect(engineParams(o, "liveApplication.prepareRetirement")).toHaveLength(3);
});

// Proves: a preparation belongs to the connection that made it. A connection
// replaced while the engine prepares fails the fence inside its transaction,
// the block ends, and the old host prepares nothing again.
it("fails the fence and ends the block when the host connection is replaced during preparation", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const parked = o.park("liveApplication.prepareRetirement"),
    stopping = hostStop(o);
  await parked.entered.promise;
  expect(
    o.f.storage.registerLiveHost({
      ...o.host.coordinate,
      connectionId: "replacement",
      updatedAtMs: Date.now(),
      guard: o.f.storage.captureStanding(),
    }).ok,
  ).toBe(true);
  parked.release.resolve();
  await expect(stopping).rejects.toThrow("retired");
  expect(o.engine.prepared).toBeUndefined();
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  stillLive(o);
  await expect(hostStop(o)).rejects.toThrow("retired");
  expect(engineParams(o, "liveApplication.prepareRetirement")).toHaveLength(1);
});

// Proves: a cancelled Stop releases the block and leaves admission open, and
// a later Stop prepares again and retires.
it("releases the block and keeps the document live when Stop is cancelled during preparation", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const cancel = new AbortController(),
    parked = o.park("liveApplication.prepareRetirement"),
    stopping = hostStop(o, cancel.signal);
  await parked.entered.promise;
  cancel.abort();
  parked.release.resolve();
  await expect(stopping).rejects.toThrow();
  expect(o.engine.prepared).toBeUndefined();
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  stillLive(o);
  expect(o.host.invalidated.aborted).toBe(false);
  await expect(hostStop(o)).resolves.toMatchObject({ retired: true });
  expect(engineParams(o, "liveApplication.prepareRetirement")).toHaveLength(2);
});

// Proves: a relay failure after the engine prepared releases the block, and
// a release that fails ends the host's connection, which ends the block.
it("releases the block when the fence fails after preparation, and closes the host when the release fails", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const failing = (): never => {
    throw new Error("Relay storage failed.");
  };
  await expect(hostStop(o, undefined, failing)).rejects.toThrow("Relay storage failed.");
  expect(o.engine.prepared).toBeUndefined();
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  stillLive(o);
  expect(o.host.invalidated.aborted).toBe(false);
  o.engine.releaseFailure = new Error("Release reply lost.");
  await expect(hostStop(o, undefined, failing)).rejects.toThrow("Relay storage failed.");
  await vi.waitFor(() => expect(o.host.invalidated.aborted).toBe(true));
  stillLive(o);
});

// A known preparation refusal cannot fence or strand editing. Its release
// also finishes before a queued Try again can recheck authority and grant.
it.each(Object.entries(preparationWire.errors))(
  "answers a %s preparation refusal without a fence or a held block",
  async (_name, wire) => {
    const o = await enrolledServiceHost(),
      n = refusedNative(o);
    o.engine.prepareFailure = new EngineRequestError(900, wire);
    // A reply may have been lost after the engine installed the block.
    o.engine.prepared = prepared(o);
    const parked = o.park("liveApplication.prepareRetirement"),
      stopping = hostStop(o).catch(errorResponse);
    await parked.entered.promise;
    const granting = o.host.retryKeptEdits(n.row()!, () => {
      expect(o.engine.prepared).toBeUndefined();
      expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([
        prepared(o),
      ]);
    });
    void granting.catch(() => {});
    expect(engineParams(o, "ydoc.ownerOutbox.retry")).toEqual([]);
    parked.release.resolve();
    const response = await stopping;
    expect(response).toBeInstanceOf(Response);
    if (wire.code === "INVALID_PARAMS") {
      expect((response as Response).status).toBe(500);
      expect(await (response as Response).json()).toMatchObject({
        ok: false,
        code: "internal_error",
      });
    } else {
      expect((response as Response).status).toBe(409);
      expect(await (response as Response).json()).toEqual({
        ok: false,
        code: "restore-in-progress",
        error: "Stop live editing is waiting. You can keep editing.",
      });
    }
    expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
    expect(o.engine.prepared).toBeUndefined();
    stillLive(o);
    if (wire.code === "CONFLICT") await expect(granting).resolves.toBe("granted");
    else {
      await granting.catch(() => {});
      expect(o.host.invalidated.aborted).toBe(true);
    }
  },
);

it("replays a committed Stop on a preparation Conflict and refuses the Try again queued behind it", async () => {
  const o = await enrolledServiceHost(),
    n = refusedNative(o);
  o.engine.prepareFailure = new EngineRequestError(900, preparationWire.errors.conflict);
  const parked = o.park("liveApplication.prepareRetirement"),
    stopping = hostStop(o);
  void stopping.catch(() => {});
  await parked.entered.promise;
  const granting = o.host.retryKeptEdits(n.row()!, () => {});
  void granting.catch(() => {});
  expect(engineParams(o, "ydoc.ownerOutbox.retry")).toEqual([]);
  const retired = preparedStop(o.f.storage, {
    workspaceId: "workspace",
    ownerUserId: "owner",
    path: o.sibling.path,
    enabled: false,
    retire: true,
    nowMs: 20,
    guard() {},
  });
  const open = readServiceActivationRetirement(o.f.storage as StorageContext, o.document)!;
  const tip = o.tip(),
    evidence = o.raw
      .prepare(
        "SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?",
      )
      .get(tip.journalCursor)!;
  o.f.storage.createServiceActivationStore(o.f.history).completeRetirement({
    workspaceId: "workspace",
    key: { ...prepared(o), acceptedThrough: open.acceptedThrough },
    boundary: {
      terminalReceipt: tip,
      eventCount: Number(evidence.accepted_event_count),
      historyEvidenceDigest: String(evidence.accepted_evidence_digest),
    },
    host: o.host.coordinate,
    registeredAtMs: Date.now(),
    nowMs: Date.now(),
    guard() {},
  });
  expect(retiredRow(o).retired).toBe(true);
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
  expect(o.f.storage.serviceActivationRetirementDecision(o.document, prepared(o))).toMatchObject({
    activationId: ACTIVATION,
    acceptedThrough: retired!.acceptedCursor,
  });
  expect(
    o.f.storage.serviceActivationRetirementDecision(
      { ...o.document, workspaceId: "other" },
      prepared(o),
    ),
  ).toBeNull();
  expect(
    o.f.storage.serviceActivationRetirementDecision(
      { ...o.document, objectId: "other" },
      prepared(o),
    ),
  ).toBeNull();
  for (const stale of [
    { ...prepared(o), activationId: SUCCESSOR },
    { ...prepared(o), lineageClaimId: "c".repeat(64) },
    { ...prepared(o), restoreFenceGeneration: open.restoreFenceGeneration + 1 },
  ]) {
    expect(o.f.storage.serviceActivationRetirementDecision(o.document, stale)).toBeNull();
  }
  const identity = o.f.storage.getWorkspaceIdentity("workspace")!;
  o.raw
    .prepare(
      "UPDATE sync_relay_workspaces SET stream_identity='other' WHERE workspace_id='workspace'",
    )
    .run();
  expect(o.f.storage.serviceActivationRetirementDecision(o.document, prepared(o))).toBeNull();
  o.raw
    .prepare("UPDATE sync_relay_workspaces SET stream_identity=? WHERE workspace_id='workspace'")
    .run(identity.streamIdentity);
  parked.release.resolve();
  await expect(stopping).resolves.toMatchObject({
    retired: true,
    acceptedCursor: retired!.acceptedCursor,
  });
  await expect(granting).resolves.toBe("unavailable");
  expect(engineParams(o, "ydoc.ownerOutbox.retry")).toEqual([]);
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([]);
  expect(n.row()).toMatchObject({ retrying: false });
});

// A host of ready workspaces with no documents, passing every millisecond. Its mocked engine keeps each hosted
// replica as the engine does: a pull reads the relay log after the replica's cursor and the hosted scope's
// documents, and its commit applies those rows and that scope and moves the cursor. `holdPull` keeps a workspace's
// next pull in flight before it reads the relay, or after, until released. `pushWrites` is how many of a
// workspace's next pushes each append a row, as the host's settled work does.
// Each workspace has one enrolled document, so the relay holds a hosted scope for it, unless `unscoped`.
// `notes` gives the first workspace that many activation targets, eight to a pass as in the live profile. Their
// activation is replaced: each visit sends the engine the two waiting-edit reads a ready note's does and ends done.
// A visit also drains the edit `waiting` holds for its note, into `drained`, as a real activation drains its owner's queue.
// `intervals` are the pause between passes and the longest one while the host is idle.
async function readyHostedHost(
  workspaceIds: readonly string[],
  { unscoped = false, notes = 0, intervals = { pollIntervalMs: 1, idlePollIntervalMs: 1 } } = {},
) {
  const f = await fixture();
  const targets = Array.from({ length: notes }, (_, index) => ({
    workspaceId: workspaceIds[0]!,
    path: `docs/note-${index}.md`,
  }));
  const visited: string[] = [],
    waiting = new Set<string>(),
    drained: string[] = [];
  await configureActivation(f, {
    targets,
    ...intervals,
    ...(notes ? { maxDocumentsPerPass: 8 } : {}),
  });
  if (notes) {
    const activate = vi
      .spyOn(ServiceActivationDriver.prototype, "activate")
      .mockImplementation(async function (this: ServiceActivationDriver, target) {
        const o = this.options;
        for (let read = 0; read < 2; read++) {
          await o.client.sendRequest({
            id: o.nextRequestId(),
            workspace: `handle-${target.workspaceId}`,
            deadlineMs: o.deadlineMs,
            method: "liveApplication.ownerState",
            params: { workspaceId: target.workspaceId, registrationId: 1 },
          });
        }
        visited.push(target.path);
        if (waiting.delete(target.path)) drained.push(target.path);
        return {
          kind: "done",
          document: {
            workspaceId: target.workspaceId,
            mainVersionId: "main",
            objectId: target.path,
            lineageClaimId: "a".repeat(64),
          },
        } as Awaited<ReturnType<ServiceActivationDriver["activate"]>>;
      });
    const ready = vi
      .spyOn(ServiceActivationDriver.prototype, "workspaceReady")
      .mockReturnValue(true);
    cleanup.push(async () => {
      activate.mockRestore();
      ready.mockRestore();
    });
  }
  const base = f.config.workspaces[0]!;
  f.config.workspaces = await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      const root = join(f.root, `root-${workspaceId}`);
      await mkdir(root);
      return { ...base, root, workspaceId, maxRegistrations: 64 };
    }),
  );
  await f.save();
  const raw = new DatabaseSync(join(f.root, "relay", "relay.sqlite"));
  cleanup.push(async () => raw.close());
  for (const workspaceId of workspaceIds) {
    raw
      .prepare(
        "INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES (?,'person',0,'epoch','stream')",
      )
      .run(workspaceId);
    if (unscoped) continue;
    raw
      .prepare(
        'INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,\'person\',\'{"paths":["docs"],"versionId":null}\',0)',
      )
      .run(`share-${workspaceId}`, workspaceId);
    raw
      .prepare(`INSERT INTO sync_relay_service_host_enrollments(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
      created_at_ms,updated_at_ms,accounted_bytes) VALUES (?,'object','docs/note.md','person',?,'epoch','stream',1,0,0,1)`)
      .run(workspaceId, `share-${workspaceId}`);
    expect(f.storage.readServiceHostFeedScope(workspaceId)?.hosted.size).toBe(1);
  }
  const append = (workspaceId: string) =>
    f.storage.appendLogBatch({
      workspaceId,
      originId: "device",
      ops: [
        parseLogOp({
          originSeq: f.storage.maxOriginSeq(workspaceId, "device") + 1,
          opKind: "workspace.init",
          recordedAtMs: 1,
          payload: {},
        }),
      ],
    });
  const relayRows = (workspaceId: string) =>
    f.storage
      .fetchLogPage({ workspaceId, sinceRelaySeq: 0, limit: 1000 })
      .rows.map((row) => row.relaySeq);
  const hostedNow = (workspaceId: string) => [
    ...(f.storage.readServiceHostFeedScope(workspaceId)?.hosted.keys() ?? []),
  ];
  const replicas = new Map(
    workspaceIds.map((workspaceId) => [
      workspaceId,
      {
        cursor: 0,
        applied: [] as number[],
        read: [] as number[],
        next: 0,
        more: false,
        scope: [] as string[],
        reading: [] as string[],
      },
    ]),
  );
  type Held = {
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };
  const holds = { read: new Map<string, Held>(), reply: new Map<string, Held>() };
  const pushWrites = new Map<string, number>(),
    failures = { pulls: 0 };
  let client!: ReturnType<typeof clientFrom>["client"];
  spawn.mockImplementation(async (options) => {
    const captured = clientFrom(options);
    client = captured.client;
    client.sendRequest.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as { method: string; params?: { workspaceId?: string } };
      const workspaceId = request.params?.workspaceId ?? "",
        replica = replicas.get(workspaceId)!;
      switch (request.method) {
        case "liveApplication.hosts":
          return {
            result: {
              relayNamespace: captured.config.relayNamespace,
              host: captured.config.host,
              workspaces: captured.config.workspaces.map((row: { workspaceId: string }) => ({
                workspaceId: row.workspaceId,
                workspaceHandle: `handle-${row.workspaceId}`,
              })),
            },
          } as never;
        case "sync.createHostedReplica":
          return { result: { hosted: true } } as never;
        case "liveApplication.ownerState":
          return { result: { pendingBytes: 0 } } as never;
        case "sync.push": {
          const writes = pushWrites.get(workspaceId) ?? 0;
          if (writes > 0) {
            pushWrites.set(workspaceId, writes - 1);
            append(workspaceId);
          }
          return { result: { ...pushReply, pushed: writes > 0 ? 1 : 0 } } as never;
        }
        case "sync.pullHosted": {
          if (failures.pulls > 0) {
            failures.pulls--;
            throw new Error("The relay did not answer.");
          }
          const gate = async (at: keyof typeof holds) => {
            const held = holds[at].get(workspaceId);
            if (held) {
              holds[at].delete(workspaceId);
              held.entered.resolve();
              await held.release.promise;
            }
          };
          await gate("read");
          const page = f.storage.fetchLogPage({
            workspaceId,
            sinceRelaySeq: replica.cursor,
            limit: 100,
          });
          Object.assign(replica, {
            read: page.rows.map((row) => row.relaySeq),
            next: page.nextCursor,
            more: page.hasMore,
            reading: hostedNow(workspaceId),
          });
          await gate("reply");
          return {
            result: hostedPass({
              fetched: page.rows.length,
              applied: page.rows.length,
              hasMore: page.hasMore,
            }),
          } as never;
        }
        case "sync.materializePendingCursor":
          return { result: { materialized: true } } as never;
        case "sync.commitCursor": {
          replica.applied.push(...replica.read);
          replica.cursor = replica.next;
          replica.scope = replica.reading;
          return { result: hostedCommit({ hasMore: replica.more }) } as never;
        }
      }
      throw new Error(`Unexpected engine request ${request.method}`);
    });
    return client;
  });
  const requests = (method: string, workspaceId: string) =>
    client.sendRequest.mock.calls.filter((call) => {
      const request = (call as unknown[])[0] as {
        method: string;
        params?: { workspaceId?: string };
      };
      return request.method === method && request.params?.workspaceId === workspaceId;
    }).length;
  const pulls = (workspaceId: string) => requests("sync.pullHosted", workspaceId);
  const passes = (count: number) => afterPasses(f, count);
  // The replica applied every row the relay holds and the hosted scope it holds now, and its cursor reached the last row.
  const caughtUp = (workspaceId: string) => {
    const rows = relayRows(workspaceId),
      replica = replicas.get(workspaceId)!;
    expect(replica.applied).toEqual(rows);
    expect(replica.cursor).toBe(rows.at(-1) ?? 0);
    expect(replica.scope).toEqual(hostedNow(workspaceId));
  };
  const holdPull = (workspaceId: string, at: keyof typeof holds = "reply") => {
    const held = { entered: deferred<void>(), release: deferred<void>() };
    holds[at].set(workspaceId, held);
    return held;
  };
  // How many requests of each method the engine was sent.
  const sent = () => {
    const counts: Record<string, number> = {};
    for (const call of client.sendRequest.mock.calls) {
      const { method } = (call as unknown[])[0] as { method: string };
      counts[method] = (counts[method] ?? 0) + 1;
    }
    return counts;
  };
  return {
    f,
    raw,
    append,
    relayRows,
    replicas,
    pushWrites,
    failures,
    pulls,
    passes,
    caughtUp,
    holdPull,
    sent,
    visited,
    waiting,
    drained,
  };
}

// Proves: a burst of writes pulls once, and a write while a pull is in flight, after it read the relay, pulls exactly once more.
it("pulls once for a burst of writes and once more for a write during a pull", async () => {
  const h = await readyHostedHost(["workspace"]);
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  await vi.waitFor(() => expect(h.pulls("workspace")).toBeGreaterThanOrEqual(1));
  await h.passes(2);
  for (let index = 0; index < 5; index++) h.append("workspace");
  await vi.waitFor(() => h.caughtUp("workspace"));
  await h.passes(3);
  expect(h.pulls("workspace")).toBe(2);
  const held = h.holdPull("workspace");
  h.append("workspace");
  await held.entered.promise;
  h.append("workspace");
  expect(h.replicas.get("workspace")!.read).toHaveLength(1);
  held.release.resolve();
  await vi.waitFor(() => h.caughtUp("workspace"));
  await h.passes(3);
  expect(h.pulls("workspace")).toBe(4);
  expect(host.hostedPulls("workspace")).toEqual({ total: 4, reasons: { first: 1, changed: 3 } });
  h.caughtUp("workspace");
});

// Proves: a write to one workspace pulls only that workspace, and writes to two in the same tick pull each once.
it("pulls only the workspace a write reached, and each of two written in one tick", async () => {
  const h = await readyHostedHost(["workspace-a", "workspace-b"]);
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  await vi.waitFor(() => {
    expect(h.pulls("workspace-a")).toBeGreaterThanOrEqual(1);
    expect(h.pulls("workspace-b")).toBeGreaterThanOrEqual(1);
  });
  await h.passes(2);
  h.append("workspace-a");
  await vi.waitFor(() => h.caughtUp("workspace-a"));
  await h.passes(3);
  expect(h.pulls("workspace-a")).toBe(2);
  expect(h.pulls("workspace-b")).toBe(1);
  h.append("workspace-a");
  h.append("workspace-b");
  await vi.waitFor(() => {
    h.caughtUp("workspace-a");
    h.caughtUp("workspace-b");
  });
  await h.passes(3);
  expect(h.pulls("workspace-a")).toBe(3);
  expect(h.pulls("workspace-b")).toBe(2);
  expect(host.hostedPulls("workspace-b")).toEqual({ total: 2, reasons: { first: 1, changed: 1 } });
});

// Lifecycle work and idle deadlines must not wait for the next periodic pass to be found.
// Each test below holds periodic passes, so only the host's own wakes, or a pass the test runs, move it on.

// Proves: reopening a moved document's workspace wakes the pass that gives its restore route back, and
// Decline wakes the passes that end the route, unload what it loaded and drain the workspace, with no periodic pass.
it.each(["detaches and attaches"])(
  "gives a moved document's restore route back after a running host %s its workspace, with passes held",
  async (change) => {
    const polls = heldPolls(),
      { o, host } = await movedDuringRestore({ covered: true, polls });
    const forgetMoved = vi.spyOn(ServiceActivationDriver.prototype, "forgetMoved");
    await vi.waitFor(() => expect(polls.paused()).toBe(true));
    let passed = false;
    const nextPass = () => {
      void afterPasses(o.f, 0).then(() => {
        passed = true;
      });
    };
    if (change === "detaches and attaches") {
      nextPass();
      await host.update({
        workspaces: [{ ...o.workspace, maxRegistrations: 7 }],
        documents: [],
        departing: [o.sibling],
      });
    } else {
      await host.update({ workspaces: [], documents: [], departing: [] });
      await vi.waitFor(() => expect(polls.paused()).toBe(true));
      nextPass();
      await host.update({ workspaces: [o.workspace], documents: [], departing: [o.sibling] });
    }
    expect(forgetMoved).toHaveBeenCalledWith(
      expect.objectContaining({ path: o.sibling.path }),
      o.sibling.objectId,
    );
    expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(true);
    expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
    // The pass the reopening woke gives the route back.
    await vi.waitFor(() => expect(passed).toBe(true));
    expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
    await expect(host.declineRestore(stopLookup)).resolves.toEqual({ kind: "declined" });
    expect(o.ownerCalls().map(([method]) => method)).toContain(
      "liveApplication.cancelRestoreFence",
    );
    await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), { timeout: 10_000 });
    expect(host.retains(o.sibling)).toBe(false);
    expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(false);
    expect(leaving(o)).toContain("liveApplication.unloadDocument");
    expect(leaving(o)).not.toContain("liveApplication.releaseActivation");
    expect(polls.early()).toBeGreaterThan(0);
  },
);

// Proves: a stopped document kept for its recovery copy retires once the copy is saved. The release of the copy's
// store, as the copy route asks, wakes the passes that retire the document, free its rows and drain the workspace.
it("retires a stopped document once its recovery copy is saved, with passes held", async () => {
  const polls = heldPolls(),
    o = await enrolledServiceHost({ polls }),
    k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  const waits = () =>
    errors.mock.calls.some(
      (call) =>
        call[0] === "Service activation pass failed." && String(call[1]).includes("recovery copy"),
    );
  for (let pass = 0; pass < 10 && !waits(); pass++) await polls.run(o.f);
  expect(waits()).toBe(true);
  await vi.waitFor(() => expect(polls.paused()).toBe(true));
  expect(o.calls(sent)).not.toContain("liveApplication.reconcileActivation");
  expect(o.host.drained("workspace")).toBe(false);
  o.engine.unproven = ["refused"];
  expect(
    o.f.storage.confirmServiceKeptEditsCopy({
      workspaceId: "workspace",
      outboxId: "kept-outbox",
      generation: k.row()!.generation,
      checkpointDigest: null,
    }),
  ).toBe(true);
  await o.host.releaseKeptEditsStore(k.row()!);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true), { timeout: 10_000 });
  expect(o.engine.journals).toContainEqual({ receipts: [], absent: ["refused"] });
  expect(o.calls(sent)).toContain("liveApplication.releaseActivation");
  expect(retiredRow(o).retired).toBe(true);
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
  expect(o.host.retains(o.sibling)).toBe(false);
  expect(k.row()).toBeNull();
});

// Proves: a connection that opens while the unload its deadline started is in the engine reloads the document
// once that unload finishes, with passes held.
it("reloads a document opened while the unload its deadline started is in the engine, with passes held", async () => {
  const polls = heldPolls(),
    clock = manualClock(),
    o = await idleHost({ polls, clock });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  o.hold(true);
  const parked = o.park("liveApplication.unloadDocument");
  await vi.waitFor(() => expect(clock.armed()).toContain(600_000));
  clock.advance(600_000);
  await parked.entered.promise;
  o.hold(false);
  const release = o.editors.acquire(o.sibling),
    opening = o.host.captureNative(o.binding());
  parked.release.resolve();
  const native = await opening;
  expect(o.unloaded()).toBe(1);
  expect(native.invalidated.aborted).toBe(false);
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({ kind: "done" });
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  release();
  expect(polls.early()).toBeGreaterThan(0);
});

// An editor's open waits for its turn behind the host's own work. The relay holds that open's place in its
// connection limits until the open returns.
// Proves: an open whose caller gives up while it waits behind an unload in the engine fails at once, before the
// unload finishes, and never reloads the document. An open after it still reloads it, with passes held.
it("lets an open given up while it waits behind an unload go at once, without reloading, with passes held", async () => {
  const polls = heldPolls(),
    clock = manualClock(),
    o = await idleHost({ polls, clock });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  o.hold(true);
  const parked = o.park("liveApplication.unloadDocument");
  await vi.waitFor(() => expect(clock.armed()).toContain(600_000));
  clock.advance(600_000);
  await parked.entered.promise;
  o.hold(false);
  const release = o.editors.acquire(o.sibling),
    gone = new AbortController();
  let left: unknown;
  const abandoned = o.host.captureNative(o.binding(), gone.signal).catch((error: unknown) => {
    left = error;
  });
  gone.abort(new Error("The browser left."));
  await vi.waitFor(() => expect(left).toEqual(new Error("The browser left.")));
  parked.release.resolve();
  await abandoned;
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures);
  const native = await o.host.captureNative(o.binding());
  expect(native.invalidated.aborted).toBe(false);
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  release();
});

// Proves: an idle unload whose reply was lost goes again at its retry deadline, not before, without settling first,
// and a reconnect sends it once more before reloading the document, with passes held.

// Proves: a restore step that reloads a dormant document wakes the pass that visits it again, and one that
// changes nothing a pass continues wakes none, with passes held. Such a wake would only run a pass that
// retries a capture the engine refused. A pass visits both documents: the unload put this one last in pass
// order, so a pass that visits one document visits the other first.

// Measures: a ready workspace whose document unloaded idle runs no idle sweep before a deadline and no lifecycle
// retry, and pulls nothing more, over 100 passes.

// Proves: a retirement that stops at its work budget after its tip moved on wakes the pass that reconciles the
// next pages, until it settles once through the last and retires, with no periodic pass. Seventeen edits two to
// a page take nine pages, four a pass: the confirmation the first pass's pull finds wakes only the second.

// Proves: a membership update that fails partway, here at another workspace's origin check, still wakes the pass
// that starts the departure it began, though each later attempt finds that departure already begun. The departure
// is announced before that failure, so pulls confirm it and the stopped document retires while the other workspace
// never attaches, with no periodic pass.
it("retires a stopped document while another workspace's update keeps failing, with passes held", async () => {
  const polls = heldPolls(),
    o = await enrolledServiceHost({ polls });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const tip = o.tip(),
    key = retiringKey(o, tip);
  const second = {
    ...o.workspace,
    root: join(o.f.root, "workspace-2"),
    workspaceId: "workspace-2",
  };
  await mkdir(second.root);
  await vi.waitFor(() => expect(polls.paused()).toBe(true));
  o.stop();
  const sent = o.ownerCalls().length;
  const update = () =>
    o.host.update({ workspaces: [o.workspace, second], documents: [], departing: [o.sibling] });
  o.replies.create = new Error("Relay unreachable.");
  await expect(update()).rejects.toThrow("Relay unreachable.");
  await expect(update()).rejects.toThrow("Relay unreachable.");
  expect(o.host.automationLedger("workspace-2")).toBeNull();
  // The pass the first failed update woke settles and publishes what the stopped document applied.
  await vi.waitFor(
    () =>
      expect(retiringSettles(o, sent)).toContainEqual([
        "liveApplication.settle",
        { retirement: key, terminalReceipt: tip },
      ]),
    { timeout: 10_000 },
  );
  // A pull after the announcement confirms it left, and it retires.
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true), { timeout: 10_000 });
  expect(o.ownerCalls().slice(sent)).toContainEqual(["liveApplication.releaseActivation", key]);
  expect(retiredRow(o)).toEqual({ retired: true, boundary: o.engine.boundary });
  expect(o.host.retains(o.sibling)).toBe(false);
  expect(polls.early()).toBeGreaterThan(0);
  // The other workspace still cannot attach.
  await expect(update()).rejects.toThrow("Relay unreachable.");
  expect(o.host.automationLedger("workspace-2")).toBeNull();
});

// Proves: a departure that a failing membership update has not taken up yet gets no announcement, so no pull can
// confirm it gone while the daemon keeps nothing for it. Here a fresh daemon would resume a departure an earlier one
// left, but another workspace's attach keeps failing first. Once an update succeeds, it resumes and is confirmed gone.
it("keeps a departure a fresh daemon has not taken up while another workspace's attach keeps failing", async () => {
  const o = await emptyServiceHost(),
    workspaces = [o.workspace];
  await o.host.update({ workspaces, documents: [o.sibling], ...stay });
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const second = {
    ...o.workspace,
    root: join(o.f.root, "workspace-2"),
    workspaceId: "workspace-2",
  };
  await mkdir(second.root);
  const { restarted } = await restartEmpty(o);
  let creates = 0;
  // The first workspace attaches and checks its origin; every create after that fails.
  const failLaterCreates = (method: string) => {
    if (method === "sync.createHostedReplica" && ++creates === 2)
      o.replies.create = new Error("Relay unreachable.");
  };
  o.requestListeners.add(failLaterCreates);
  const update = () =>
    restarted.update({
      workspaces: [o.workspace, second],
      documents: [o.other],
      departing: [o.sibling],
    });
  try {
    await expect(update()).rejects.toThrow("Relay unreachable.");
    // The first workspace stays attached, so this attempt reaches it before the other's attach fails again.
    await expect(update()).rejects.toThrow("Relay unreachable.");
    expect(restarted.automationLedger("workspace")).not.toBeNull();
    expect(restarted.automationLedger("workspace-2")).toBeNull();
    await afterPasses(o.f, 3);
    expect(restarted.retains(o.sibling)).toBe(true);
  } finally {
    o.requestListeners.delete(failLaterCreates);
    o.replies.create = undefined;
  }
  await update();
  await vi.waitFor(() => expect(restarted.retains(o.sibling)).toBe(false), { timeout: 10_000 });
});

// Proves: a ready workspace whose push keeps failing, here while it waits for owner admission, still pulls after
// each refused push. Those pulls confirm a stopped document left, so the relay asks for its release while the push
// still fails. The engine keeps the release pending while the document's settled output is unpushed; once a push
// takes it, the document retires, with no periodic pass.
it("confirms a stopped document's departure while its ready workspace's push keeps failing, with passes held", async () => {
  const polls = heldPolls(),
    o = await enrolledServiceHost({ polls });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const tip = o.tip(),
    key = retiringKey(o, tip);
  await vi.waitFor(() => expect(polls.paused()).toBe(true));
  o.replies.push = {
    ownerAdmissionPending: [
      {
        workspaceId: "workspace",
        originId: "origin",
        originSeq: 3,
        versionId: "main",
        objectId: "object",
        path: "docs/a.md",
      },
    ],
  };
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(
    () =>
      expect(log).toHaveBeenCalledWith(
        "Service activation pass failed.",
        expect.stringContaining("Hosted publication is waiting for owner admission."),
      ),
    { timeout: 10_000 },
  );
  await vi.waitFor(
    () =>
      expect(o.ownerCalls().slice(sent)).toContainEqual(["liveApplication.releaseActivation", key]),
    { timeout: 10_000 },
  );
  // Before a pull confirmed it left, the log said why it waited.
  expect(log).toHaveBeenCalledWith(
    ...waiting(
      "Waiting for its hosted replica to confirm the document left: no pull has started since its departure was announced.",
    ),
  );
  await vi.waitFor(
    () =>
      expect(log).toHaveBeenCalledWith(
        ...waiting("Waiting for its hosted replica to confirm the document parked."),
      ),
    { timeout: 10_000 },
  );
  expect(o.engine.unpushed).toBeGreaterThan(0);
  expect(o.host.retains(o.sibling)).toBe(true);
  o.replies.push = {};
  await polls.until(o.f, () => o.host.drained("workspace"));
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true), { timeout: 10_000 });
  expect(retiredRow(o)).toEqual({ retired: true, boundary: o.engine.boundary });
  expect(o.host.retains(o.sibling)).toBe(false);
  expect(polls.early()).toBeGreaterThan(0);
});

// Proves: a retirement whose departure was already confirmed, and whose publication then pushed a page and has
// more, wakes the pass that pushes the rest and retires it. Nothing else it waits on changes then, so only the
// publication's own wake moves it on, with no periodic pass.

// A host's pauses on a manual clock, which also times its recovery probe. `timers` are the host options that put them
// there, `poll` the pause after a pass that did or left work, and `ceiling` the longest pause while idle. `step`
// moves the clock to the end of the pause the host waits in, and resolves once the pass after it ended and the next
// pause began. `until` steps until `done` holds. `over` steps through `ms` of clock time and resolves to how many
// passes ended in it. `resting` is how long the pause the host waits in has left.
const retiringKey = (o: Enrolled, tip: { journalCursor: number }) => ({
  objectId: "object",
  lineageClaimId: o.document.lineageClaimId,
  activationId: ACTIVATION,
  restoreFenceGeneration: o.binding.restoreFenceGeneration,
  acceptedThrough: tip.journalCursor,
});

function pacedPasses(poll = 250, ceiling = 2_000) {
  const clock = manualClock();
  const timers = {
    nowMs: clock.nowMs,
    pauseTimer: (delayMs: number, fire: () => void) =>
      clock.schedule(clock.nowMs() + delayMs, fire),
  };
  // The clock time at which the pause the host waits in ends. A wake can end a pause before its caller runs, so it
  // resolves only while that pause still stands.
  const paused = async () => {
    for (;;) {
      const due = await vi.waitFor(
        () => {
          expect(clock.armed()).toHaveLength(1);
          return clock.armed()[0]!;
        },
        { interval: 1, timeout: 5_000 },
      );
      if (clock.armed().length === 1 && clock.armed()[0] === due) return due;
    }
  };
  const step = async (f: { passEnds: Set<() => void> }) => {
    const due = await paused(),
      ended = afterPasses(f, 0);
    clock.advance(due);
    await ended;
    await paused();
  };
  return {
    clock,
    timers,
    poll,
    ceiling,
    step,
    async until(f: { passEnds: Set<() => void> }, done: () => boolean) {
      for (let pass = 0; pass < 40 && !done(); pass++) await step(f);
    },
    async over(f: { passEnds: Set<() => void> }, ms: number) {
      let passes = 0;
      const count = () => {
          passes++;
        },
        until = clock.nowMs() + ms;
      f.passEnds.add(count);
      for (let due = await paused(); due <= until; due = await paused()) {
        const ended = afterPasses(f, 0);
        clock.advance(due);
        await ended;
      }
      clock.advance(until);
      f.passEnds.delete(count);
      return passes;
    },
    resting: () => (clock.armed().length === 1 ? clock.armed()[0]! - clock.nowMs() : undefined),
  };
}
type Paced = ReturnType<typeof pacedPasses>;

// Measures: the passes and engine requests of one simulated minute for one, five and twenty ready, quiet notes,
// at an idle interval equal to the poll interval, which runs a pass every poll whether or not the last one found
// anything, and at the live profile's two seconds.
// Proves: an idle host's pause grows until a rotation through its notes takes its idle interval, and the recovery
// probe still pulls every 30 s. Twenty notes take three passes, so their pause stops at a third of the interval.
it.each(
  [1, 5, 20].flatMap((notes): [number, number][] => [
    [notes, 250],
    [notes, 2_000],
  ]),
)(
  "runs %i idle notes for a minute at an idle interval of %i ms",
  async (notes, idlePollIntervalMs) => {
    const paced = pacedPasses(250, idlePollIntervalMs);
    const h = await readyHostedHost(["workspace"], {
      notes,
      intervals: { pollIntervalMs: 250, idlePollIntervalMs },
    });
    const host = await startServiceLiveHost({ ...h.f, ...paced.timers });
    cleanup.push(() => host.close());
    await vi.waitFor(() => h.caughtUp("workspace"));
    for (let pass = 0; pass < 8; pass++) await paced.step(h.f);
    const longest = Math.max(250, Math.floor(idlePollIntervalMs / Math.ceil(notes / 8)));
    await paced.until(h.f, () => paced.resting() === longest);
    const before = h.sent(),
      pulls = host.hostedPulls("workspace").total;
    const passes = await paced.over(h.f, 60_000);
    const requests: Record<string, number> = {};
    for (const [method, count] of Object.entries(h.sent()))
      if (count !== (before[method] ?? 0)) requests[method] = count - (before[method] ?? 0);
    console.info(
      `Idle host, ${notes} notes, idle interval ${idlePollIntervalMs} ms: ${passes} passes in 60 s, engine requests ${JSON.stringify(requests)}`,
    );
    // Each pass asks for the waiting edits of up to eight notes, twice each, and pushes once.
    expect(requests["sync.push"]).toBe(passes);
    expect(requests["liveApplication.ownerState"]).toBe(2 * Math.min(notes, 8) * passes);
    // Only the recovery probe pulled, once every 30 s.
    expect(host.hostedPulls("workspace").total - pulls).toBe(2);
    expect(host.hostedPulls("workspace").reasons.probe).toBeGreaterThanOrEqual(2);
    if (idlePollIntervalMs === 250) expect(passes).toBe(240);
    else {
      // No pause is longer than a rotation's share of the idle interval, and a probe that brings nothing leaves the
      // pause as it is: 30 passes for up to eight notes, and about 90 for twenty.
      expect(passes).toBeGreaterThanOrEqual(Math.floor(60_000 / longest));
      expect(passes).toBeLessThanOrEqual(Math.floor(60_000 / longest) + 2);
    }
  },
);

// A pass visits eight awake notes, so twenty-four take three passes. With every pause at the idle interval, a note
// was visited once in three of them.
// Proves: while the same notes stay awake, an idle host visits each within its idle interval. An edit queued for
// the note the host visited last, which no notice, nudge or wake announces, meets its visit within that interval.
// The activation here is a stand-in that marks the visit; the one-note tests drain through the real delivery.
it("visits a note with an edit no signal announced within the idle interval on an idle host of twenty-four notes", async () => {
  const paced = pacedPasses(),
    h = await readyHostedHost(["workspace"], {
      notes: 24,
      intervals: { pollIntervalMs: paced.poll, idlePollIntervalMs: paced.ceiling },
    });
  const host = await startServiceLiveHost({ ...h.f, ...paced.timers });
  cleanup.push(() => host.close());
  await vi.waitFor(() => h.caughtUp("workspace"));
  // Long enough for the pause to stop growing.
  for (let pass = 0; pass < 12; pass++) await paced.step(h.f);
  const pause = paced.resting()!;
  await paced.step(h.f);
  expect(paced.resting()).toBe(pause);
  // The first note of the pass that just ended waits a whole rotation for its next visit.
  const note = h.visited.at(-8)!,
    queued = paced.clock.nowMs();
  h.waiting.add(note);
  await paced.until(h.f, () => h.drained.includes(note));
  expect(h.drained).toEqual([note]);
  console.info(
    `Idle host, 24 notes: pause ${pause} ms, the note with an unannounced edit visited after ${paced.clock.nowMs() - queued} ms`,
  );
  expect(paced.clock.nowMs() - queued).toBeLessThanOrEqual(paced.ceiling);
});

// Proves: a relay write asks for a pass no sooner than one poll interval after the last one, so a host whose own
// passes write cannot run them back to back, and at once when that long has gone by. A burst of writes runs one pass.
it("runs the pass a relay write asks for one poll interval after the last pass, and at once when that long has gone by", async () => {
  const paced = pacedPasses(),
    h = await readyHostedHost(["workspace"], {
      intervals: { pollIntervalMs: paced.poll, idlePollIntervalMs: paced.ceiling },
    });
  const host = await startServiceLiveHost({ ...h.f, ...paced.timers });
  cleanup.push(() => host.close());
  await vi.waitFor(() => h.caughtUp("workspace"));
  await paced.until(h.f, () => paced.resting() === paced.ceiling);
  expect(paced.resting()).toBe(paced.ceiling);
  let passes = 0;
  h.f.passEnds.add(() => {
    passes++;
  });
  const began = paced.clock.nowMs();
  // Right after a pass, the write only cuts the pause to one poll interval.
  for (let write = 0; write < 50; write++) h.append("workspace");
  await vi.waitFor(() => expect(paced.resting()).toBe(paced.poll));
  expect(passes).toBe(0);
  await paced.step(h.f);
  expect(paced.clock.nowMs()).toBe(began + paced.poll);
  expect(passes).toBe(1);
  h.caughtUp("workspace");
  // The pass pulled, so the next pause is one poll interval, and the pauses after it grow again.
  expect(paced.resting()).toBe(paced.poll);
  await paced.until(h.f, () => paced.resting() === paced.ceiling);
  expect(paced.resting()).toBe(paced.ceiling);
  // More than one poll interval into a long pause, the write runs the pass at once.
  const idle = paced.clock.nowMs();
  paced.clock.advance(idle + paced.poll);
  passes = 0;
  h.append("workspace");
  await vi.waitFor(() => h.caughtUp("workspace"));
  expect(paced.clock.nowMs()).toBe(idle + paced.poll);
  expect(passes).toBe(1);
});

// Proves: a recovery probe that finds nothing new leaves an idle host's pause at its idle interval. One that brings
// a row no notice announced puts it back to the poll interval, so the pass that follows the pull comes as soon as before.
it("keeps an idle host's pause through a recovery probe that brings nothing, and not through one that brings a row", async () => {
  const paced = pacedPasses(),
    h = await readyHostedHost(["workspace"], {
      intervals: { pollIntervalMs: paced.poll, idlePollIntervalMs: paced.ceiling },
    });
  const host = await startServiceLiveHost({ ...h.f, ...paced.timers });
  cleanup.push(() => host.close());
  await vi.waitFor(() => h.caughtUp("workspace"));
  const probes = () => host.hostedPulls("workspace").reasons.probe ?? 0;
  await paced.until(h.f, () => probes() === 1);
  expect(probes()).toBe(1);
  expect(paced.resting()).toBe(paced.ceiling);
  h.raw
    .prepare(
      "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','device',0,'workspace.init','{}',1)",
    )
    .run();
  await paced.until(h.f, () => probes() === 2);
  expect(probes()).toBe(2);
  h.caughtUp("workspace");
  expect(paced.resting()).toBe(paced.poll);
});

// A real hosted note, delivered and settled by the real activation, on a host that reached its idle interval.
// The clock then stands one poll interval into that pause, so the fixed pass is not due for the rest of it.
// `passes` counts the passes that ended since.
async function idleNote(options: { supervised?: boolean } = {}) {
  const paced = pacedPasses(),
    o = await enrolledServiceHost({ paced, frameChanges: true, ...options });
  await paced.until(o.f, () => paced.resting() === paced.ceiling);
  expect(paced.resting()).toBe(paced.ceiling);
  const idle = paced.clock.nowMs();
  paced.clock.advance(idle + paced.poll);
  let passes = 0;
  o.f.passEnds.add(() => {
    passes++;
  });
  const methods = () =>
    o
      .client()
      .sendRequest.mock.calls.map((call) => ((call as unknown[])[0] as { method: string }).method);
  return {
    paced,
    o,
    methods,
    passes: () => passes,
    // Whether the clock still stands where the wake found it, with the fixed pass not yet due.
    held: () => paced.clock.nowMs() === idle + paced.poll,
    idle,
  };
}

// With the real activation and delivery of one note against the test engine.
// Measures: the passes and engine requests of one simulated minute, at idle intervals of 250 ms and 2,000 ms.
// Proves: an idle pass sends the engine only the note's two waiting-edit reads and its workspace's push.
it.each([250, 2_000])(
  "runs one hosted, ready note for a minute at an idle interval of %i ms",
  async (ceiling) => {
    const paced = pacedPasses(250, ceiling),
      o = await enrolledServiceHost({ paced });
    const methods = () =>
      o
        .client()
        .sendRequest.mock.calls.map(
          (call) => ((call as unknown[])[0] as { method: string }).method,
        );
    for (let pass = 0; pass < 8; pass++) await paced.step(o.f);
    await paced.until(o.f, () => paced.resting() === ceiling);
    const sent = methods().length;
    const passes = await paced.over(o.f, 60_000);
    const requests: Record<string, number> = {};
    for (const method of methods().slice(sent)) requests[method] = (requests[method] ?? 0) + 1;
    console.info(
      `Idle host, 1 hosted note, idle interval ${ceiling} ms: ${passes} passes in 60 s, engine requests ${JSON.stringify(requests)}, pulls ${JSON.stringify(o.host.hostedPulls("workspace"))}`,
    );
    expect(requests["sync.push"]).toBe(passes);
    expect(requests["liveApplication.ownerState"]).toBe(2 * passes);
    expect(Object.keys(requests).sort()).toEqual([
      "liveApplication.ownerState",
      "sync.commitCursor",
      "sync.materializePendingCursor",
      "sync.pullHosted",
      "sync.push",
    ]);
    expect(requests["sync.pullHosted"]).toBe(2);
    if (ceiling === 250) expect(passes).toBe(240);
    else {
      expect(passes).toBeGreaterThanOrEqual(30);
      expect(passes).toBeLessThanOrEqual(32);
    }
    expect(o.host.isDocumentReady(o.document)).toBe(true);
  },
);

// Proves: an editor that opens a note on an idle host is served without a pass. With nothing to deliver, the
// connection asks for no pass either, and the pause the host waits in stands.
it("serves an editor that opens a note on an idle host at once, and runs no pass for a connection with nothing to deliver", async () => {
  const { paced, o, passes, held } = await idleNote();
  const close = liveEditors(o.f.storage).acquire(o.sibling);
  const native = await o.host.captureNative(o.binding);
  expect(native.coordinate).toEqual(o.host.coordinate);
  await expect(native.drain(o.document)).resolves.toMatchObject({ kind: "done" });
  close();
  await new Promise((resolve) => setImmediate(resolve));
  expect(passes()).toBe(0);
  expect(paced.resting()).toBe(paced.ceiling - paced.poll);
  expect(held()).toBe(true);
});

// Has the test engine answer a connection's two reads of what the host applied: its opening sync, and the read after
// it, which finds nothing new.
const answerConnectionReads = (o: Enrolled) =>
  Object.assign(o.client(), {
    openLiveAppliedSync: vi.fn(async () => ({
      binding: o.binding,
      position: { journalCursor: 0, eventCount: 0 },
      observedLocalYDocHeadSequence: 0,
      hostVector: Buffer.from([0]),
      missingStateUpdate: Buffer.alloc(0),
    })),
    readNextLiveApplied: vi.fn(async () => null),
  });
// What the host sees of an owner's desktop connection that delivers nothing. The owner route counts the connection
// and captures the note, which drains it. The session drains it again and reads its opening sync. It then reads what
// was applied once now and once after each change notice for the note, as its feed does, until the returned close.
// The reads go through the client the capture gave, with the host's request numbers, as a session's do.
const openIdleOwnerConnection = async (o: Enrolled) => {
  const release = liveEditors(o.f.storage).acquire(o.sibling);
  try {
    const native = await o.host.captureNative(o.binding),
      signal = new AbortController().signal;
    const request = () => ({
      id: native.nextRequestId(),
      workspace: native.workspace,
      registrationId: native.registrationId,
      deadlineMs: native.deadlineMs,
    });
    await native.drain(o.document);
    const opened = await native.client.openLiveAppliedSync(
      request(),
      Buffer.from([0]),
      { maxInputBytes: 1_000, maxOutputBytes: 10_000 },
      signal,
    );
    const read = () => {
      void native.client
        .readNextLiveApplied(request(), opened.position, 10_000, signal)
        .catch(() => {});
    };
    const unsubscribe = native.changes.subscribe(read, o.document);
    read();
    return () => {
      unsubscribe();
      release();
    };
  } catch (error) {
    release();
    throw error;
  }
};

// An idle desktop with a live note opens an owner connection about every 2 s and closes it. Each one counted as an
// editor change and asked for a pass, so the pause between passes never grew on a server with one desktop connected.
// A connection also reads what the host applied when it opens and after every pass that visits its note, and each
// read took a request number no idle pass takes, so a pass beside an open connection was never idle either.
// Proves: with a desktop that reconnects every 2 s and delivers nothing, and whose connection stays open until the
// next one, the pause grows to its idle interval and stays there.
it("lets the pause grow to its idle interval while an idle desktop reconnects every two seconds", async () => {
  const paced = pacedPasses(),
    o = await enrolledServiceHost({ paced, frameChanges: true }),
    engine = answerConnectionReads(o);
  let close = () => {};
  cleanup.push(async () => close());
  // How long the pause the host waits in has left, once it waits in one.
  const resting = () =>
    vi.waitFor(
      () => {
        const left = paced.resting();
        expect(left).toBeDefined();
        return left!;
      },
      { interval: 1, timeout: 5_000 },
    );
  const pauses: number[] = [];
  let connections = 0,
    next = paced.clock.nowMs();
  while (connections < 10) {
    // A pass that falls due before the desktop's next connection runs first.
    if (paced.clock.nowMs() + (await resting()) <= next) {
      await paced.step(o.f);
      pauses.push(await resting());
      continue;
    }
    paced.clock.advance(next);
    close();
    close = await openIdleOwnerConnection(o);
    connections++;
    next += 2_000;
  }
  // Each pass visited the note beside an open connection, whose feed read after it.
  expect(engine.readNextLiveApplied.mock.calls.length).toBeGreaterThan(connections);
  console.info(
    `Idle desktop reconnecting every 2 s: the pauses between passes were ${pauses.join(", ")} ms`,
  );
  expect(pauses.slice(-5)).toEqual(Array.from({ length: 5 }, () => paced.ceiling));
  expect(o.host.isDocumentReady(o.document)).toBe(true);
});

// Proves: a connection whose drain applies an accepted edit still asks for a pass as that drain ends, so the edit
// is settled and published at once. The edit's own relay write asked for a pass long before: passes left the
// note's delivery to the connection, and the host went back to its idle interval with the edit unapplied.
it("settles an edit a connection applies on an idle host at once, with the fixed pass held back", async () => {
  const paced = pacedPasses(),
    o = await enrolledServiceHost({ paced, frameChanges: true });
  o.passes.deliver = false;
  const edit = o.acceptEdit("typed");
  await paced.until(o.f, () => paced.resting() === paced.ceiling);
  expect(paced.resting()).toBe(paced.ceiling);
  expect(o.applied.has(edit.deliveryId)).toBe(false);
  const idle = paced.clock.nowMs();
  paced.clock.advance(idle + paced.poll);
  let passes = 0;
  o.f.passEnds.add(() => {
    passes++;
  });
  o.passes.deliver = true;
  answerConnectionReads(o);
  (await openIdleOwnerConnection(o))();
  expect(o.applied.has(edit.deliveryId)).toBe(true);
  await vi.waitFor(() =>
    expect(engineParams(o, "liveApplication.settle").at(-1)).toMatchObject({
      terminalReceipt: edit,
    }),
  );
  expect(o.tip()).toEqual(edit);
  const methods = () =>
    o
      .client()
      .sendRequest.mock.calls.map((call) => ((call as unknown[])[0] as { method: string }).method);
  await vi.waitFor(() =>
    expect(methods().lastIndexOf("sync.push")).toBeGreaterThan(
      methods().lastIndexOf("liveApplication.settle"),
    ),
  );
  // The settle and the push are sent inside the pass, so wait for the pass itself to end before reading the clock.
  await vi.waitFor(() => expect(passes).toBeGreaterThanOrEqual(1));
  expect(paced.clock.nowMs()).toBe(idle + paced.poll);
});

// Once a minute the supervisor sweeps for notes nobody has used for ten minutes, by calling
// `storage.reclaimIdleLiveDocuments`. The call below is all its sweep does. The sweep's timer is the supervisor's
// own and is no part of this test.
// Proves: a sweep that finds nothing to reclaim writes nothing, so it asks the host for no pass. The pause it lands
// in stands, and the pauses after it grow to the idle interval as they do with no sweep.
it("runs no pass for a reclaim sweep that finds nothing, and lets the pause keep growing", async () => {
  const paced = pacedPasses(),
    o = await enrolledServiceHost({ paced });
  let passes = 0;
  o.f.passEnds.add(() => {
    passes++;
  });
  // A pass that was asked for is not idle, so the pause after it is one poll interval again.
  notifyRelayWrite(o.f.storage);
  await paced.step(o.f);
  expect(paced.resting()).toBe(paced.poll);
  const pauses: number[] = [];
  for (let sweep = 0; sweep < 5; sweep++) {
    const ended = passes,
      left = paced.resting();
    // The note is shared for editing, so the sweep leaves it.
    expect(o.f.storage.reclaimIdleLiveDocuments(Date.now())).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(passes).toBe(ended);
    expect(paced.resting()).toBe(left);
    await paced.step(o.f);
    pauses.push(paced.resting()!);
  }
  expect(pauses).toEqual([500, 1_000, 2_000, 2_000, 2_000]);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
});

// A recovery probe's three requests are credited as idle once the probe ends, after they were sent. A delivery that
// began between the two saw the credit and not the requests, so the credit hid three requests of its own and the
// delivery asked for no pass, though it had settled something. The settlement here is a stand-in that sends three
// settle requests, the number one probe page is credited with.
// Proves: a delivery that settles while a probe is in flight still asks for a pass. It ends in an idle pause, and
// that pause is cut to one poll interval.
it("asks for a pass after a settlement that ran while a recovery probe ended, on an idle host", async () => {
  const paced = pacedPasses(),
    o = await enrolledServiceHost({ paced, frameChanges: true });
  const native = await o.host.captureNative(o.binding);
  await paced.until(o.f, () => paced.resting() === paced.ceiling);
  expect(paced.resting()).toBe(paced.ceiling);
  // How long the pause the host waits in has left, once it waits in one.
  const resting = () =>
    vi.waitFor(
      () => {
        const left = paced.resting();
        expect(left).toBeDefined();
        return left!;
      },
      { interval: 1, timeout: 5_000 },
    );
  // Passes run until one holds its probe's commit, with the probe's three requests sent and no credit yet.
  const probes = o.host.hostedPulls("workspace").reasons.probe ?? 0,
    commit = o.park("sync.commitCursor");
  for (;;) {
    const left = await resting(),
      ended = afterPasses(o.f, 0);
    paced.clock.advance(paced.clock.nowMs() + left);
    if (await Promise.race([ended.then(() => false), commit.entered.promise.then(() => true)]))
      break;
  }
  expect(o.host.hostedPulls("workspace").reasons.probe).toBe(probes + 1);
  const during = paced.clock.nowMs(),
    tip = o.tip();
  vi.spyOn(OwnerCommittedDelivery.prototype, "settle").mockImplementationOnce(
    async (_document, signal) => {
      // The delivery has begun. The probe now ends, its pass is judged idle, and the host waits out its idle interval.
      const passed = afterPasses(o.f, 0);
      commit.release.resolve();
      await passed;
      await vi.waitFor(() => expect(paced.resting()).toBe(paced.ceiling), {
        interval: 1,
        timeout: 5_000,
      });
      for (let request = 0; request < 3; request++) {
        await native.client.sendRequest(
          {
            id: native.nextRequestId(),
            workspace: native.workspace,
            deadlineMs: native.deadlineMs,
            method: "liveApplication.settle",
            params: { registrationId: native.registrationId, terminalReceipt: tip },
          },
          signal,
        );
      }
      return undefined as never;
    },
  );
  await o.host.settle(o.document);
  expect(paced.resting()).toBe(paced.poll);
  expect(paced.clock.nowMs()).toBe(during);
});

// A dormant note's open first pulls what the relay received. The relay was written by another process, so no write
// notice came, and the pull stopped at its page budget: the open is refused, and the note stays dormant with its
// workspace's catch-up unfinished. No connection change asks for a pass any more.
// Proves: that open still asks for the pass that continues the catch-up, which starts at once when the idle pause
// has already lasted one poll interval, and does not wait out the pause.
it("continues the catch-up a dormant note's open left unfinished at once, with the fixed pass held back", async () => {
  const paced = pacedPasses(),
    o = await enrolledServiceHost({ paced, frameChanges: true });
  const unloaded = () =>
    o.membership.filter((row) => row.method === "liveApplication.unloadDocument").length;
  // The note unloads idle, ten minutes after its last connection, and the host goes back to its idle interval.
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  now += 600_000;
  await paced.until(o.f, () => unloaded() === 1);
  expect(unloaded()).toBe(1);
  await paced.until(o.f, () => paced.resting() === paced.ceiling);
  expect(paced.resting()).toBe(paced.ceiling);
  const idle = paced.clock.nowMs(),
    pending = () => o.host.hostedPulls("workspace").reasons.pending ?? 0,
    before = pending();
  paced.clock.advance(idle + paced.poll);
  o.replies.pass = { hasMore: true, fetched: 1, applied: 1 };
  const close = liveEditors(o.f.storage).acquire(o.sibling);
  await expect(o.host.captureNative(o.binding)).rejects.toThrow(
    "Hosted replication has more pages.",
  );
  close();
  // The pass that pulls on runs with the clock where the open found it.
  await vi.waitFor(() => expect(pending()).toBeGreaterThan(before));
  expect(paced.clock.nowMs()).toBe(idle + paced.poll);
});

// Proves: an edit an editor's session commits and delivers on an idle host is settled and published by a pass the
// edit itself wakes, as soon as when passes ran every poll interval.
it("settles and publishes an editor's edit on an idle host at once, with the fixed pass held back", async () => {
  const { o, methods, held } = await idleNote();
  const edit = o.acceptEdit("typed");
  await expect(o.host.drain(o.document)).resolves.toMatchObject({ kind: "done" });
  expect(o.tip()).toEqual(edit);
  await vi.waitFor(() =>
    expect(engineParams(o, "liveApplication.settle").at(-1)).toMatchObject({
      terminalReceipt: edit,
    }),
  );
  await vi.waitFor(() =>
    expect(methods().lastIndexOf("sync.push")).toBeGreaterThan(
      methods().lastIndexOf("liveApplication.settle"),
    ),
  );
  expect(held()).toBe(true);
});

// An owner's desktop that is not in a live session pushes its edit to the relay's log. The host's pull brings it to
// the engine, which queues it for the note's owner, and the next pass admits it.
// Proves: the relay write wakes the pass that pulls, and the pass after it, one poll interval later as before, admits the edit.
it("admits an owner's pushed edit on an idle host one poll interval after the pull its write wakes", async () => {
  const { paced, o, held, idle } = await idleNote();
  o.native.binding = o.binding;
  let queued = false;
  o.requestListeners.add((method) => {
    if (method === "sync.pullHosted" && !queued) {
      queued = true;
      o.nativeEdits("desktop");
    }
  });
  // The relay appends the pushed row and raises its write notice, as `storage.tx` does.
  appendDocumentRow(o.raw, "ydoc.update", o.sibling.objectId);
  notifyRelayWrite(o.f.storage);
  await vi.waitFor(() => expect(queued).toBe(true));
  expect(held()).toBe(true);
  expect(journaled(o, "edit-desktop")).toEqual([]);
  await paced.until(o.f, () => journaled(o, "edit-desktop").length === 1);
  expect(journaled(o, "edit-desktop")).toHaveLength(1);
  console.info(
    `Owner edit admitted ${paced.clock.nowMs() - (idle + paced.poll)} ms after its relay write`,
  );
  expect(paced.clock.nowMs()).toBeLessThanOrEqual(idle + 3 * paced.poll);
});

// Proves: an owner's Stop on an idle host retires the note's activation, and its departure ends, through the passes
// Stop and the membership update wake.
it("stops a note on an idle host at once, with the fixed pass held back", async () => {
  const { o, held } = await idleNote();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sent = o.ownerCalls().length;
  await expect(hostStop(o)).resolves.toMatchObject({ enabled: false, retired: true });
  await vi.waitFor(() => expect(o.calls(sent)).toContain("liveApplication.reconcileActivation"));
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true), { timeout: 10_000 });
  expect(o.calls(sent)).toContain("liveApplication.releaseActivation");
  expect(held()).toBe(true);
});

// Proves: once the relay revokes a note's share, it refuses an edit prepared before, and an idle host retires the
// note's activation at once. The write's notice reaches the supervisor, whose membership update wakes the passes
// that retire it. Neither the host's fixed pass nor the supervisor's periodic reconciliation runs. No editor
// session is open here.
it("refuses an edit and retires a note's activation on an idle host at once when the relay revokes its share", async () => {
  const { o, held } = await idleNote({ supervised: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sent = o.ownerCalls().length,
    late = o.prepareEdit("after");
  expect(o.f.storage.revokeShare("share", 30)).toBe(true);
  // The relay admits nothing more, whatever the host has done.
  expect(late().result).toEqual({ kind: "refused", reason: "authority-refused" });
  await vi.waitFor(() => expect(o.calls(sent)).toContain("liveApplication.releaseActivation"), {
    timeout: 10_000,
  });
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(held()).toBe(true);
});

// The relay's storage writing with no write notice, as another process on the same database does.
const unannounced = (o: Enrolled) =>
  Object.assign(Object.create(o.f.storage) as typeof o.f.storage, {
    tx: <T>(run: () => T) => (o.f.storage as StorageContext).replicaViewTx(run),
  });
// Proves: after a Pause, a Stop or a revocation that reaches the relay database with no notice, as from another
// process, an idle host retires the note's activation at its next fixed pass, within one idle interval. The relay
// refuses an edit prepared before it, on the request path. No editor session is open here.
const unannouncedChanges: [string, (storage: Enrolled["f"]["storage"], o: Enrolled) => void][] = [
  [
    "Pause",
    (storage, o) => {
      storage.setServiceHostEnrollmentEnabled({
        workspaceId: "workspace",
        path: o.sibling.path,
        ownerUserId: "owner",
        enabled: false,
        nowMs: 30,
        guard() {},
      });
    },
  ],
  [
    "Stop",
    (storage, o) => {
      preparedStop(storage, {
        workspaceId: "workspace",
        ownerUserId: "owner",
        path: o.sibling.path,
        enabled: false,
        retire: true,
        nowMs: 30,
        guard() {},
      });
    },
  ],
  [
    "revocation",
    (storage) => {
      expect(storage.revokeShare("share", 30)).toBe(true);
    },
  ],
];
it.each(unannouncedChanges)(
  "retires a note's activation within one idle interval of a %s no notice announced, and refuses an edit",
  async (_change, write) => {
    const { paced, o, passes, idle } = await idleNote();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = o.ownerCalls().length,
      late = o.prepareEdit("after");
    write(unannounced(o), o);
    // No notice came, so no pass ran and the pause stands as it was.
    await new Promise((resolve) => setImmediate(resolve));
    expect(passes()).toBe(0);
    expect(paced.resting()).toBe(paced.ceiling - paced.poll);
    expect(o.calls(sent)).not.toContain("liveApplication.reconcileActivation");
    await paced.step(o.f);
    expect(paced.clock.nowMs()).toBe(idle + paced.ceiling);
    expect(o.calls(sent)).toContain("liveApplication.reconcileActivation");
    expect(o.host.isDocumentReady(o.document)).toBe(false);
    expect(o.host.settled(o.sibling)).toBe(false);
    expect(late().result).toMatchObject({ kind: "refused" });
  },
);
