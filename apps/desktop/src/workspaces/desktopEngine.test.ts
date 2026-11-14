import { LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES } from "@dohc/live-session-contract/live-frame";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Event, Request, Response } from "@dohc/workspace-engine-client";
import {
  createRustEngineDaemon,
  EngineClient,
  EngineRequestError,
  EngineWorkspaceSessions,
  type EngineDaemonClient,
  type EngineDaemonLifecycleOptions,
  type EngineClientSpawnOptions,
} from "@dohc/workspace-engine-client/daemon";
import { createDesktopEngine, OWNER_FULL_PASS_MS, type ServerOwnerDelivery } from "./desktopEngine";
import type { JsonValue, OwnerYDocOutboxRecovery } from "@dohc/workspace-engine-client";
import { EngineRelayClient } from "./engineRelayClient";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import type { RegistryEntry } from "./registryStore";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "./testTemp";
import { localStateDir } from "./workspaceLocalState";
import {
  createUnwrittenReleases,
  recoverySnapshot,
  type UnwrittenRelease,
  type UnwrittenReleases,
} from "./ownerLiveReleases";
import { directDocumentProjection } from "./documentProjection";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  readServerKeptEditsQueue,
  ServerKeptEditsConflict,
  type OwnerLiveQuarantineRecord,
} from "./ownerLiveQuarantine";
import { liveRecoveryUpdates, parseLiveRecoveryPackage } from "./ownerLiveRecoveryCopy";
import * as Y from "yjs";
import type { LiveObjectBinding } from "@dohc/workspace-engine-client";

const ownerHostMock = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn() }));
vi.mock("./desktopOwnerHost", () => ({
  readDesktopOwnerHostConfig: ownerHostMock.read,
  startDesktopOwnerHost: ownerHostMock.start,
}));

const ownerDeliveryMock = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn(), pass: vi.fn() }));
vi.mock("./desktopOwnerDelivery", () => ({
  readDesktopOwnerDeliveryConfig: ownerDeliveryMock.read,
  startDesktopOwnerDelivery: ownerDeliveryMock.start,
}));
vi.mock("./nativeOwnerDelivery", async () => ({
  runNativeOwnerDeliveryPass: ownerDeliveryMock.pass,
  OwnerKnownRefusals: (
    await vi.importActual<typeof import("./ownerYDocOutbox")>("./ownerYDocOutbox")
  ).OwnerKnownRefusals,
}));
// Stands in for the engine's durable owner queues, which outlive every desktop process.
const quarantineMock = vi.hoisted(() => ({ read: vi.fn(), retry: vi.fn(), queue: vi.fn() }));
vi.mock("./ownerLiveQuarantine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ownerLiveQuarantine")>()),
  readOwnerLiveQuarantines: quarantineMock.read,
  retryOwnerLiveQuarantine: quarantineMock.retry,
  readOwnerLiveQueue: quarantineMock.queue,
}));
// Use the Linux x64 installation layout on every test host.
vi.mock("./installedReaderConfig", async (importOriginal) => {
  const { installedReaderConfig } =
    await importOriginal<typeof import("./installedReaderConfig")>();
  return {
    installedReaderConfig: (resources: string | undefined) =>
      installedReaderConfig(resources, "linux", "x64"),
  };
});

type State = {
  collectionAutomations: {
    notifyClaimed: Mock<() => void>;
    failuresChanged: Mock<() => void>;
    pauseForEngineRestart: Mock<() => void>;
    resumeAfterEngineRestart: Mock<() => void>;
  };
};
type Dependencies = Parameters<typeof createDesktopEngine<State>>[0];

function workspaceIdOf(request: Request): unknown {
  return typeof request.params === "object" &&
    request.params !== null &&
    !Array.isArray(request.params)
    ? request.params.workspaceId
    : undefined;
}

class Client implements EngineDaemonClient {
  readonly requests: Request[] = [];
  readonly handlers = new Set<(event: Event) => void>();
  readonly smokeClosed = deferred();
  readonly closed = deferred();
  exitWait: Promise<void> = Promise.resolve();
  respond?: (request: Request) => Promise<Response>;

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    if (this.respond) return this.respond(request);
    if (request.method === "workspace.close" && request.workspace === "smoke")
      this.smokeClosed.resolve();
    return {
      id: request.id,
      result:
        request.method === "workspace.open"
          ? {
              workspace: String(workspaceIdOf(request)).startsWith("desktop-startup-smoke-")
                ? "smoke"
                : "workspace-handle",
              // As the engine says once it has kept .dohc/local out of sync.
              localStateReady: true,
            }
          : request.method === "workspace.close"
            ? { closed: true }
            : request.method === "ydoc.ownerStop.list"
              ? { stops: [] }
              : request.method === "engine.ping"
                ? { ok: true }
                : null,
    };
  }

  onEvent(handler: (event: Event) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  emit(name: string, payload: Event["payload"]) {
    for (const handler of this.handlers) handler({ seq: 1, sessionGeneration: 1, name, payload });
  }
  close() {
    this.closed.resolve();
  }
  waitForExit() {
    return this.exitWait;
  }
}

function fixture(options: { ownerLiveReleases?: UnwrittenReleases } = {}) {
  const rows = new Map<string, RegistryEntry>();
  const states = new Map<string, State>();
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => rows.get(id) ?? null,
    canonicalizeRoot: resolve,
    createState: (binding): State => {
      const state = {
        collectionAutomations: {
          notifyClaimed: vi.fn(),
          failuresChanged: vi.fn(),
          pauseForEngineRestart: vi.fn(),
          resumeAfterEngineRestart: vi.fn(),
        },
      };
      states.set(binding.workspaceId, state);
      return state;
    },
  });
  const client = new Client();
  let launch: (options: EngineClientSpawnOptions) => Promise<EngineDaemonClient> = async () =>
    client;
  let daemonOptions!: EngineDaemonLifecycleOptions;
  let configureDaemon = (_daemon: ReturnType<typeof createRustEngineDaemon>) => {};
  const daemons: ReturnType<typeof createRustEngineDaemon>[] = [];
  const spawns: EngineClientSpawnOptions[] = [];
  let quitting = false;
  // Stands in for the durable file of releases whose file write is not confirmed.
  const unwritten: UnwrittenRelease[] = [];
  const recoveries = new Map<string, string>();
  const dependencies: Dependencies = {
    ownerLiveReleases: options.ownerLiveReleases ?? {
      list: async (id) => unwritten.filter((row) => row.workspaceId === id),
      put: async (release, recovery) => {
        recoveries.set(release.objectId, recovery);
        unwritten.splice(
          0,
          unwritten.length,
          ...unwritten.filter((row) => row.objectId !== release.objectId),
          release,
        );
      },
      recovery: async (_id, objectId) => recoveries.get(objectId) ?? null,
      endRetry: async (id, objectId) => {
        unwritten.splice(
          0,
          unwritten.length,
          ...unwritten.map((row) =>
            row.workspaceId === id && row.objectId === objectId ? { ...row, retry: false } : row,
          ),
        );
      },
      written: async (id, objectId, { snapshot }) => {
        if (
          !unwritten.some(
            (row) =>
              row.workspaceId === id &&
              row.objectId === objectId &&
              row.retry &&
              snapshot !== null &&
              row.snapshot === snapshot,
          )
        )
          return;
        recoveries.delete(objectId);
        unwritten.splice(
          0,
          unwritten.length,
          ...unwritten.filter((row) => row.workspaceId !== id || row.objectId !== objectId),
        );
      },
      remove: async (id, objectId) => {
        if (!unwritten.some((row) => row.workspaceId === id && row.objectId === objectId)) return;
        recoveries.delete(objectId);
        unwritten.splice(
          0,
          unwritten.length,
          ...unwritten.filter((row) => row.workspaceId !== id || row.objectId !== objectId),
        );
      },
    },
    documentProjection: directDocumentProjection,
    resourcesBasePath: () => "resources",
    findWorkspace: (id) => rows.get(id) ?? null,
    app: { isPackaged: false, getAppPath: vi.fn(() => "app-root") },
    dialog: { showErrorBox: vi.fn() },
    process: { env: {}, resourcesPath: "resources", platform: "win32" },
    createRustEngineDaemon: vi.fn((input) => {
      daemonOptions = input;
      const daemon = createRustEngineDaemon({
        ...input,
        fileExists: () => true,
        launch: (spawnOptions) => {
          spawns.push(spawnOptions);
          return launch(spawnOptions);
        },
        sleep: async () => undefined,
        pingIntervalMs: 60_000,
        healthyResetMs: 60_000,
      });
      daemons.push(daemon);
      configureDaemon(daemon);
      return daemon;
    }),
    defaultEngineBinaryPath: vi.fn(() => resolve("test-engine")),
    isQuitting: () => quitting,
    recordEngineProblem: vi.fn(),
    workspaceAuthorities: authorities,
    collectionAutomations: {
      current: (id) => (rows.has(id) ? states.get(id)?.collectionAutomations : undefined),
    },
    notifyRenderer: vi.fn(),
    noteNoAtomicPlacement: vi.fn(),
    noteWriteDeferred: vi.fn(),
    launchMarks: { daemonReady: vi.fn() },
    desktopMarks: { markOnce: vi.fn() },
    logLaunchMarksOnce: vi.fn(),
  };
  const engine = createDesktopEngine(dependencies);
  return {
    engine,
    dependencies,
    client,
    rows,
    states,
    authorities,
    daemons,
    spawns,
    unwritten,
    recoveries,
    options: () => daemonOptions,
    setQuitting: (value: boolean) => {
      quitting = value;
    },
    setLaunch: (value: typeof launch) => {
      launch = value;
    },
    setDaemon: (value: typeof configureDaemon) => {
      configureDaemon = value;
    },
    async addWorkspace(workspaceId: string) {
      const workspace: RegistryEntry = {
        workspaceId,
        rootPath: resolve(workspaceId),
        kind: "personal",
        mode: "local-first",
      };
      rows.set(workspaceId, workspace);
      authorities.acquire(workspaceId).release();
      return workspace;
    },
    async close() {
      quitting = true;
      try {
        await engine.closeAllRelayTransportWorkspaces();
      } finally {
        await Promise.all(daemons.map((daemon) => daemon.stop()));
        await authorities.close();
      }
    },
  };
}

beforeEach(() => {
  quarantineMock.read.mockReset().mockResolvedValue([]);
  quarantineMock.retry.mockReset().mockResolvedValue(undefined);
  quarantineMock.queue.mockReset();
});

type ServerSession = NonNullable<Awaited<ReturnType<ServerOwnerDelivery["connect"]>>>;
const unexpectedKeptEdits = async (): Promise<unknown> => {
  throw new Error("Unexpected kept edits request.");
};
const unexpectedOpen = async (): Promise<"hosted" | "refused"> => {
  throw new Error("Unexpected owner open.");
};
/**
 * A server-owned workspace whose delivery offers these documents, for quarantine tests. The server keeps `kept`.
 * `listed` sees each list read's `fresh` flag after the list is read, and can hold back its answer.
 */
async function quarantinedOwner(
  documents: { path: string; objectId: string; head?: () => number }[],
  server: {
    kept?: () => unknown[];
    keptCursor?: number;
    keptEdits?: ServerSession["keptEdits"];
    keptEditsPage?: ServerSession["keptEditsPage"];
    open?: ServerSession["open"];
    listed?: (fresh: boolean | undefined) => Promise<void> | void;
    assertCurrent?: () => void;
    onConnect?: () => void;
  } = {},
) {
  const f = fixture(),
    credentials = new AbortController();
  Object.setPrototypeOf(
    f.client,
    Object.defineProperties(
      Object.create(EngineClient.prototype),
      Object.getOwnPropertyDescriptors(Client.prototype),
    ),
  );
  const rootPath = await createTestScratch("dohc-owner-quarantine-");
  mkdirSync(resolve(rootPath, ".dohc", "local"), { recursive: true });
  f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
  const bindingOf = (path: string, objectId: string) => ({
    workspaceId: "owner",
    mainVersionId: "main",
    objectId,
    lineageClaimId: "a".repeat(64),
    currentPath: path,
    selectorPaths: [path],
    restoreFenceGeneration: 1,
  });
  const config = {
    nativeConfigPath: "native-config",
    nativeClient: { aggregateBytes: 100_000_000, maxUploads: 2 },
    frames: {
      receive: {
        maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES,
        maxStateVectorBytes: 1024,
        maxUpdateBytes: 4096,
        maxSyncBytes: 4096,
      },
      maxQueuedBytes: 4096,
      maxQueuedFrames: 32,
      maxControlBytes: 4096,
      maxControlFrames: 8,
      maxAssemblyBytes: 4096,
    },
    attemptTimeoutMs: 30_000,
    retryDelayMs: 10_000,
  };
  f.dependencies.serverOwnerDelivery = {
    prepare: async () => config,
    workspaceIds: () => ["owner"],
    hasRefusals: () => undefined,
    connect: async () => {
      server.onConnect?.();
      return {
        bearer: "token",
        accountId: "owner-account",
        relayUrl: "https://relay.test",
        signal: credentials.signal,
        assertCurrent: server.assertCurrent ?? (() => {}),
        retire: async () => 0,
        refusals: async () => {},
        keptEdits: server.keptEdits ?? unexpectedKeptEdits,
        keptEditsPage: server.keptEditsPage ?? unexpectedKeptEdits,
        open: server.open ?? unexpectedOpen,
        documents: async (_signal, fresh) => {
          const answer = {
            ok: true,
            documents: documents.map(({ path, objectId, head }) => ({
              path,
              status: "ready",
              document: { binding: bindingOf(path, objectId), relayDatabaseNamespace: "namespace" },
              ...(head ? { head: head() } : {}),
            })),
            ...(server.kept ? { keptEdits: server.kept() } : {}),
            ...(server.keptCursor === undefined ? {} : { keptEditsCursor: server.keptCursor }),
          };
          await server.listed?.(fresh);
          return answer;
        },
      };
    },
  };
  const workspace = () =>
    f.authorities.withAuthority("owner", (lease) => ({
      workspaceId: "owner",
      rootPath: lease.binding.canonicalRootPath,
      attachmentId: lease.binding.attachmentId,
    }));
  return { f, credentials, binding: bindingOf("notes/plan.md", "object"), workspace };
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A refused queue read with its checkpoint: the server accepted the first edit, then refused the one that builds on it. */
// `accepted` is a recipient's accepted edit the checkpoint holds.
function recoveryQueue(binding: LiveObjectBinding, accepted?: string, pending?: string) {
  const doc = new Y.Doc();
  doc.getMap("frontmatter").set("title", "Plan");
  const baseUpdate = Y.encodeStateAsUpdate(doc);
  doc.getMap("frontmatter").set("status", "accepted");
  if (accepted !== undefined) doc.getMap("frontmatter").set("note", accepted);
  const checkpoint = Y.encodeStateAsUpdate(doc),
    before = Y.encodeStateVector(doc);
  doc.getMap("frontmatter").set("status", "kept");
  if (pending !== undefined) doc.getMap("frontmatter").set("note", pending);
  const update = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return {
    update,
    queue: {
      outboxId: "outbox",
      binding,
      baseUpdate,
      baseUpdateDigest: digest(baseUpdate),
      checkpoint,
      checkpointDigest: digest(checkpoint),
      state: "quarantined" as const,
      pendingBytes: update.byteLength,
      oldestEntryAtMs: 1,
      quarantineReason: "capacity-refused",
      observedBinding: null,
      retryDeliveryId: null,
      entries: [
        {
          sequence: 2,
          appendKey: "append",
          deliveryId: "delivery",
          updateDigest: digest(update),
          update,
          byteLength: update.byteLength,
          createdAtMs: 1,
        },
      ],
    },
  };
}
/**
 * Serves a refused queue as the server's engine pages it, a few bytes per
 * page, so a read follows every cursor through every part. A cursor from
 * another snapshot reads as changed.
 */
function servedPages(queue: OwnerYDocOutboxRecovery, chunk = 64) {
  const snapshot = digest(Buffer.from(`snapshot:${queue.outboxId}`));
  const cursor = (part: string, sequence = 0, offset = 0) => ({ snapshot, part, sequence, offset });
  const first = queue.entries[0];
  const header = {
    outboxId: queue.outboxId,
    binding: queue.binding,
    baseUpdateDigest: queue.baseUpdateDigest,
    baseByteLength: queue.baseUpdate.byteLength,
    state: queue.state,
    pendingBytes: queue.pendingBytes,
    pendingEntryCount: queue.entries.length,
    nextSequence: (queue.entries.at(-1)?.sequence ?? 0) + 1,
    oldestEntryAtMs: queue.oldestEntryAtMs,
    quarantineReason: queue.quarantineReason,
    observedBinding: queue.observedBinding,
    retryDeliveryId: queue.retryDeliveryId,
    firstEntryCursor: first ? cursor("entryHeader", first.sequence) : null,
    checkpointDigest: queue.checkpoint ? digest(queue.checkpoint) : null,
    frozenAtRefusedSeed: false,
    recoveryCheckpointDigest: null,
  };
  const parts = new Map<string, { bytes: Uint8Array; next: ReturnType<typeof cursor> | null }>([
    ["header:0", { bytes: Buffer.from(JSON.stringify(header)), next: cursor("base") }],
    ["base:0", { bytes: queue.baseUpdate, next: header.firstEntryCursor }],
  ]);
  queue.entries.forEach(({ update, ...entry }, index) => {
    const following = queue.entries[index + 1];
    parts.set(`entryHeader:${entry.sequence}`, {
      bytes: Buffer.from(JSON.stringify(entry)),
      next: cursor("update", entry.sequence),
    });
    parts.set(`update:${entry.sequence}`, {
      bytes: update,
      next: following ? cursor("entryHeader", following.sequence) : null,
    });
  });
  if (queue.checkpoint) parts.set("checkpoint:0", { bytes: queue.checkpoint, next: null });
  return (requested: JsonValue | undefined) => {
    const at = (requested as ReturnType<typeof cursor> | undefined) ?? cursor("header");
    if (at.snapshot !== snapshot) return { kind: "readChanged" };
    const part = parts.get(`${at.part}:${at.sequence}`)!,
      bytes = part.bytes.subarray(at.offset, at.offset + chunk),
      end = at.offset + bytes.byteLength;
    return {
      kind: "page",
      ...at,
      totalBytes: part.bytes.byteLength,
      digest: digest(part.bytes),
      bytesBase64: Buffer.from(bytes).toString("base64"),
      nextCursor: end < part.bytes.byteLength ? cursor(at.part, at.sequence, end) : part.next,
    };
  };
}
const keptBinding = {
  workspaceId: "owner",
  mainVersionId: "main",
  objectId: "object",
  lineageClaimId: "a".repeat(64),
  currentPath: "notes/plan.md",
  selectorPaths: ["notes/plan.md"],
  restoreFenceGeneration: 1,
};
const releasedStop = {
  binding: keptBinding,
  document: { mainVersionId: "main", objectId: "object", currentPath: "notes/plan.md" },
  relayDatabaseNamespace: "namespace",
  retirementOwed: false,
  state: "released",
};
/** A release as the engine answers it: its Stop names the kept edits the request named. */
const releaseAnswer =
  (materialized: boolean) =>
  (request: Request): Response => {
    const { keptSnapshot } = request.params as { keptSnapshot?: string };
    return {
      id: request.id,
      result: {
        stops: [
          {
            ...releasedStop,
            ...(keptSnapshot === undefined ? {} : { keptSnapshot }),
            materialized,
          },
        ],
      },
    };
  };
const releaseConflict = (request: Request): Response => {
  throw new EngineRequestError(request.id, {
    code: "INVALID_PARAMS",
    message: "owner-stop-conflict",
    retry: "no",
  });
};
const stopMethods = (methods: string[]) =>
  methods.filter(
    (method) => method.startsWith("ydoc.ownerStop.") && method !== "ydoc.ownerStop.list",
  );
const listedStop = (stop: { state: string; retirementOwed: boolean; deferred?: unknown }) =>
  stop.state === "requested" || stop.retirementOwed || stop.deferred !== undefined;
/**
 * A Stop's record of refused edits it could not write, from queue "outbox"
 * at head "delivery", with its stored package, in a real file. The engine's
 * reader is stood in for as it lists them: hidden only behind that queue
 * while it holds the same edits. Each launch is a new desktop process on the
 * same records.
 */
async function keptRelease(
  path = "notes/plan.md",
  stored: ReturnType<typeof recoveryQueue>["queue"] = recoveryQueue(keptBinding).queue,
) {
  const rootPath = await createTestScratch("dohc-unwritten-");
  mkdirSync(resolve(rootPath, ".dohc", "local"), { recursive: true });
  const file = join(await createTestScratch("dohc-unwritten-state-"), "owner-live-releases.json");
  const { liveRecoveryPackage } = await import("./ownerLiveRecoveryCopy");
  await createUnwrittenReleases(() => file).put(
    {
      workspaceId: "owner",
      objectId: "object",
      path,
      reason: "invalid-update",
      binding: keptBinding,
      headDeliveryId: "delivery",
      snapshot: recoverySnapshot(stored),
      retry: true,
    },
    JSON.stringify(
      liveRecoveryPackage(stored, { path, reason: "invalid-update", storedOn: "this-computer" }),
    ),
  );
  const engine = {
    queues: [] as OwnerLiveQuarantineRecord[],
    snapshots: new Map<string, string>(),
    stops: [] as (typeof releasedStop)[],
    release: releaseConflict as (request: Request) => Response,
  };
  quarantineMock.read.mockImplementation(
    async (_client, _handle, options?: { unwritten?: UnwrittenRelease[] }) => [
      ...engine.queues,
      ...(options?.unwritten ?? [])
        .filter(
          (release) =>
            !engine.queues.some(
              (row) =>
                row.objectId === release.objectId &&
                row.headDeliveryId === release.headDeliveryId &&
                row.outboxId !== null &&
                engine.snapshots.get(row.outboxId) === release.snapshot,
            ),
        )
        .map((release) => ({
          objectId: release.objectId,
          path: release.path,
          reason: release.reason,
          outboxId: null,
          binding: release.binding,
          headDeliveryId: release.headDeliveryId,
          recovery: release.retry ? "not-written" : "cannot-write",
        })),
    ],
  );
  const launch = async () => {
    const f = fixture({ ownerLiveReleases: createUnwrittenReleases(() => file) });
    Object.setPrototypeOf(
      f.client,
      Object.defineProperties(
        Object.create(EngineClient.prototype),
        Object.getOwnPropertyDescriptors(Client.prototype),
      ),
    );
    const methods: string[] = [];
    f.client.respond = async (request) => {
      methods.push(request.method);
      // As the engine resolves it: a document names its own Stop; a path every Stop that had it, and two refuse.
      if (request.method === "ydoc.ownerStop.clear") {
        const { path, document } = request.params as {
          path?: string;
          document?: { objectId: string };
        };
        const cleared = engine.stops.filter((stop) =>
          document
            ? stop.document.objectId === document.objectId
            : stop.document.currentPath === path || stop.binding.currentPath === path,
        );
        if (cleared.length > 1)
          throw new EngineRequestError(request.id, {
            code: "INVALID_PARAMS",
            message: "owner-stop-conflict",
            retry: "no",
          });
        engine.stops = engine.stops.filter((stop) => !cleared.includes(stop));
        return { id: request.id, result: { stops: cleared } };
      }
      if (request.method === "ydoc.ownerStop.release") return engine.release(request);
      return {
        id: request.id,
        result:
          request.method === "workspace.open"
            ? { workspace: "workspace-handle", localStateReady: true }
            : request.method === "ydoc.ownerStop.list"
              ? { stops: engine.stops.filter(listedStop) }
              : request.method === "workspace.close"
                ? { closed: true }
                : request.method === "engine.ping"
                  ? { ok: true }
                  : null,
      };
    };
    await f.engine.start();
    const workspace = { workspaceId: "owner", rootPath };
    await f.engine.sessions!.run(workspace, async () => undefined);
    await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).not.toEqual([]));
    return { f, workspace, methods };
  };
  const records = () => createUnwrittenReleases(() => file);
  const packageFile = join(
    dirname(file),
    `owner-live-recovery-${createHash("sha256").update("owner\0object").digest("hex")}.dohc-recovery.json`,
  );
  return { engine, launch, records, rootPath, packageFile };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("desktop engine construction", () => {
  it("lets writers into .dohc/local only while the open that prepared it stands", async () => {
    const f = fixture();
    const workspace = {
      workspaceId: "local-state-workspace",
      rootPath: await createTestScratch("local-state-open-"),
    };
    mkdirSync(resolve(workspace.rootPath, ".dohc", "local"), { recursive: true });
    let localStateReady = true;
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async (request) =>
      request.method === "workspace.open" && workspaceIdOf(request) === workspace.workspaceId
        ? { id: request.id, result: { workspace: "local-state-handle", localStateReady } }
        : originalSend(request);
    try {
      await f.engine.start();
      const sessions = f.engine.sessions!;
      await expect(localStateDir(workspace)).rejects.toThrow(
        "dohc has not finished opening this workspace.",
      );
      await sessions.run(workspace, async () => undefined);
      await expect(localStateDir(workspace)).resolves.toMatch(/local$/);
      await sessions.closeWorkspace(workspace);
      await expect(localStateDir(workspace)).rejects.toThrow(
        "dohc has not finished opening this workspace.",
      );
      localStateReady = false;
      await sessions.run(workspace, async () => undefined);
      await expect(localStateDir(workspace)).rejects.toThrow("out of iCloud Drive");
    } finally {
      await f.close();
    }
  });

  const remote = { serverUrl: "https://server.test", ownerUserId: "owner" };
  it.each<[string, Partial<RegistryEntry>, boolean]>([
    ["a saved pause", { pausedRemote: remote }, true],
    ["a folder reopened as local work", {}, true],
    ["ordinary sync with no session", { remote }, false],
    ["a join still bootstrapping", { joinBootstrapPending: true }, false],
    [
      "a received share",
      {
        shareView: {
          shareId: "share",
          granterEmail: null,
          genericChatWritable: false,
          grantedSelector: { paths: ["docs"], versionId: null, access: "view" },
        },
      },
      false,
    ],
  ])(
    "owner opens with %s ask to abandon an unfinished pull: %s",
    async (_case, entry, abandons) => {
      const f = fixture();
      const workspace = {
        workspaceId: "local-only",
        rootPath: await createTestScratch("abandon-open-"),
      };
      f.rows.set(workspace.workspaceId, {
        ...workspace,
        kind: "personal",
        mode: "local-first",
        ...entry,
      });
      try {
        await f.engine.start();
        const sessions = f.engine.sessions!;
        await sessions.run(workspace, async () => undefined);
        await sessions.closeWorkspace(workspace);
        await sessions.run({ ...workspace, captureMode: "none" }, async () => undefined);
        const opens = f.client.requests
          .filter(
            (request) =>
              request.method === "workspace.open" && workspaceIdOf(request) === "local-only",
          )
          .map((request) => request.params);
        expect(opens).toHaveLength(2);
        if (abandons) expect(opens[0]).toMatchObject({ abandonOrdinaryPull: true });
        else expect(opens[0]).not.toHaveProperty("abandonOrdinaryPull");
        expect(opens[1]).not.toHaveProperty("abandonOrdinaryPull");
      } finally {
        await f.close();
      }
    },
  );

  it.each(["closed", "reopened"])(
    "rejects discovered owner handles after a capture directly closes its %s session",
    async (mode) => {
      const f = fixture();
      Object.setPrototypeOf(
        f.client,
        Object.defineProperties(
          Object.create(EngineClient.prototype),
          Object.getOwnPropertyDescriptors(Client.prototype),
        ),
      );
      const rootPath = await createTestScratch("dohc-owner-capture-close-");
      f.rows.set("owner", {
        workspaceId: "owner",
        rootPath,
        kind: "personal",
        mode: "local-first",
      });
      f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
      f.dependencies.existingOwnerFor = vi.fn(() => {
        throw new Error("No editor in this discovery test.");
      });
      ownerHostMock.read.mockReturnValue({
        nativeConfigPath: "native-config",
        workspaceIds: ["owner"],
        transport: { aggregateBytes: 1024, maxUploads: 1 },
      });
      ownerHostMock.start.mockImplementation(() => ({ stop: vi.fn() }));
      let handles = 0;
      const originalSend = f.client.sendRequest.bind(f.client);
      f.client.sendRequest = async (input) =>
        input.method === "workspace.open" && workspaceIdOf(input) === "owner"
          ? { id: input.id, result: { workspace: `owner-${++handles}` } }
          : originalSend(input);
      try {
        expect(await f.engine.start()).toBe(true);
        const lease = f.authorities.acquire("owner");
        const workspace = {
          workspaceId: "owner",
          rootPath,
          attachmentId: lease.binding.attachmentId,
        };
        lease.release();
        const discover = ownerHostMock.start.mock.calls.at(-1)![0].bindings;
        const captured = await discover();
        expect(() => captured.assertCurrent()).not.toThrow();
        await f.engine.sessions!.closeWorkspace(workspace);
        if (mode === "reopened") await f.engine.sessions!.run(workspace, async () => undefined);
        expect(() => captured.assertCurrent()).toThrow();
        const current = await discover();
        expect(current.client).toBe(captured.client);
        expect(current.workspaces[0].workspaceHandle).not.toBe(
          captured.workspaces[0].workspaceHandle,
        );
        expect(() => current.assertCurrent()).not.toThrow();
        expect(() => captured.assertCurrent()).toThrow();
      } finally {
        await f.close();
        ownerHostMock.read.mockReset();
        ownerHostMock.start.mockReset();
      }
    },
  );

  it.each(["credential"])(
    "retires discovered owner bindings before the first relay request after %s rebind",
    async (mode) => {
      const f = fixture();
      Object.setPrototypeOf(
        f.client,
        Object.defineProperties(
          Object.create(EngineClient.prototype),
          Object.getOwnPropertyDescriptors(Client.prototype),
        ),
      );
      const rootPath = await createTestScratch("dohc-owner-relay-rebind-");
      f.rows.set("owner", {
        workspaceId: "owner",
        rootPath,
        kind: "personal",
        mode: "local-first",
      });
      f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
      f.dependencies.existingOwnerFor = vi.fn(() => {
        throw new Error("No editor in this discovery test.");
      });
      ownerHostMock.read.mockReturnValue({
        nativeConfigPath: "native-config",
        workspaceIds: ["owner"],
        transport: { aggregateBytes: 1024, maxUploads: 1 },
      });
      const stops: ReturnType<typeof vi.fn>[] = [];
      ownerHostMock.start.mockImplementation(() => {
        const stop = vi.fn();
        stops.push(stop);
        return { stop };
      });
      let handles = 0,
        blockedHandle: string | undefined;
      let request: Promise<unknown> | undefined;
      const closing = deferred(),
        closeEntered = deferred();
      const originalSend = f.client.sendRequest.bind(f.client);
      f.client.sendRequest = async (input) => {
        if (input.method === "workspace.open" && workspaceIdOf(input) === "owner") {
          f.client.requests.push(input);
          return { id: input.id, result: { workspace: `owner-${++handles}` } };
        }
        if (input.method === "workspace.close" && input.workspace === blockedHandle) {
          closeEntered.resolve();
          await closing.promise;
          if (mode === "rejecting-close") throw new Error("injected binding close failure");
        }
        if (input.method === "sync.probe") {
          f.client.requests.push(input);
          return { id: input.id, result: { hasContent: true } };
        }
        return originalSend(input);
      };
      try {
        expect(await f.engine.start()).toBe(true);
        const lease = f.authorities.acquire("owner");
        const workspace = {
          workspaceId: "owner",
          rootPath,
          attachmentId: lease.binding.attachmentId,
        };
        lease.release();
        let relay = f.engine.relayClient!.bind({
          ...workspace,
          relay: { baseUrl: "https://relay.test", token: "first-token" },
        });
        const rotated = mode === "credential" || mode === "cloud";
        if (rotated) await relay.probe();
        if (mode === "cloud") await f.engine.closeAllRelayTransportWorkspaces();
        if (rotated)
          relay = f.engine.relayClient!.bind({
            ...workspace,
            relay: { baseUrl: "https://relay.test", token: "second-token" },
          });
        const discovered = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
        blockedHandle = discovered.workspaces[0].workspaceHandle;
        const priorStop = stops.at(-1)!;
        request = relay.probe();
        await closeEntered.promise;
        expect(() => discovered.assertCurrent()).toThrow("This live editing session ended.");
        expect(priorStop).toHaveBeenCalledOnce();
        const startsBeforeClose = ownerHostMock.start.mock.calls.length;
        if (mode === "quitting") f.setQuitting(true);
        closing.resolve();
        await expect(request).resolves.toEqual({ hasContent: true });
        if (mode === "quitting") {
          expect(ownerHostMock.start).toHaveBeenCalledTimes(startsBeforeClose);
          return;
        }
        const current = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
        expect(() => current.assertCurrent()).not.toThrow();
        expect(current.client).toBe(discovered.client);
        expect(current.workspaces[0].workspaceHandle).not.toBe(blockedHandle);
        expect(
          f.client.requests.filter((row) => row.method === "sync.probe").at(-1)?.workspace,
        ).toBe(current.workspaces[0].workspaceHandle);
        const opened = f.client.requests
          .filter((row) => row.method === "workspace.open" && workspaceIdOf(row) === "owner")
          .at(-1)!;
        expect(opened.params).toMatchObject({
          relay: { bearerToken: rotated ? "second-token" : "first-token" },
        });
        const starts = ownerHostMock.start.mock.calls.length;
        await relay.probe();
        expect(ownerHostMock.start).toHaveBeenCalledTimes(starts);
      } finally {
        closing.resolve();
        await request?.catch(() => undefined);
        await f.close();
        ownerHostMock.read.mockReset();
        ownerHostMock.start.mockReset();
      }
    },
  );

  it("waits for failed-start stop before clearing constructed handles and reporting the failure", async () => {
    const f = fixture();
    const held = deferred();
    f.client.exitWait = held.promise;
    const error = new Error("marks failed");
    f.dependencies.launchMarks.daemonReady = () => {
      throw error;
    };
    let settled = false;
    const started = f.engine.start();
    void started.then(() => {
      settled = true;
    });
    try {
      await f.client.closed.promise;
      expect(f.engine.daemon).toBe(f.daemons[0]);
      expect(f.engine.sessions).toBeInstanceOf(EngineWorkspaceSessions);
      expect(f.engine.relayClient).toBeInstanceOf(EngineRelayClient);
      expect(settled).toBe(false);
      held.resolve();
      expect(await started).toBe(false);
      expect(f.engine.daemon).toBeNull();
      expect(f.engine.sessions).toBeNull();
      expect(f.engine.relayClient).toBeNull();
    } finally {
      held.resolve();
      await started;
      await f.close();
    }
  });
});

describe("desktop engine restart coordination", () => {
  it("keeps the composed session and relay owners through a real daemon restart", async () => {
    const f = fixture();
    const relaunched = deferred();
    await f.addWorkspace("workspace");
    try {
      await f.engine.start();
      f.engine.launchSettled();
      await f.client.smokeClosed.promise;
      const sessions = f.engine.sessions;
      const relay = f.engine.relayClient;
      const daemon = f.engine.daemon;
      const replacement = new Client();
      f.setLaunch(async () => replacement);
      vi.mocked(f.dependencies.notifyRenderer).mockImplementation(() => {
        relaunched.resolve();
      });
      f.spawns[0]!.onExit!(1, null);
      await relaunched.promise;
      expect(f.engine.daemon).toBe(daemon);
      expect(daemon!.currentClient()).toBe(replacement);
      expect(f.engine.sessions).toBe(sessions);
      expect(f.engine.relayClient).toBe(relay);
      expect(f.dependencies.launchMarks.daemonReady).toHaveBeenCalledOnce();
      // The Collection executor paused before each daemon was published and
      // resumed once it answered: at the first start and at the restart.
      const collection = f.states.get("workspace")!.collectionAutomations;
      expect(collection.pauseForEngineRestart).toHaveBeenCalledTimes(2);
      expect(collection.resumeAfterEngineRestart).toHaveBeenCalledTimes(2);
      replacement.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      expect(collection.notifyClaimed).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });
});

describe("desktop engine composed sessions and events", () => {
  it("uses the 120 second workspace open deadline and the same relay route owner", async () => {
    const f = fixture();
    const workspace = {
      workspaceId: "workspace",
      rootPath: await createTestScratch("dohc-desktop-engine-"),
    };
    try {
      await f.engine.start();
      f.engine.relayClient!.bind({
        ...workspace,
        relay: { baseUrl: "https://relay.test", token: "token" },
      });
      await f.engine.sessions!.run(workspace, async () => undefined);
      const request = f.client.requests.find(
        (item) => item.method === "workspace.open" && workspaceIdOf(item) === "workspace",
      );
      expect(request).toMatchObject({
        deadlineMs: 120_000,
        params: {
          workspaceId: "workspace",
          relay: { baseUrl: "https://relay.test", bearerToken: "token" },
        },
      });
      expect(() =>
        f.engine.relayClient!.bind({
          ...workspace,
          relay: { baseUrl: "https://other.test", token: "token" },
        }),
      ).toThrow("different relay origin");
      await f.engine.closeRelayTransportWorkspace(workspace);
      expect(() =>
        f.engine.relayClient!.bind({
          ...workspace,
          relay: { baseUrl: "https://other.test", token: "token" },
        }),
      ).not.toThrow();
    } finally {
      await f.close();
    }
  });
});

describe("private owner peer lifecycle", () => {
  it.each(["credentials"])(
    "holds the workspace session until %s cancellation settles",
    async (mode) => {
      const f = fixture(),
        credentials = new AbortController(),
        entered = deferred(),
        settled = deferred();
      Object.setPrototypeOf(
        f.client,
        Object.defineProperties(
          Object.create(EngineClient.prototype),
          Object.getOwnPropertyDescriptors(Client.prototype),
        ),
      );
      const rootPath = await createTestScratch("dohc-owner-peer-");
      f.rows.set("owner", {
        workspaceId: "owner",
        rootPath,
        kind: "personal",
        mode: "local-first",
      });
      const document = { binding: { workspaceId: "owner" }, outboxId: "pending" };
      const config = {
        nativeConfigPath: "native-config",
        nativeClient: { aggregateBytes: 100_000_000, maxUploads: 2 },
        relayUrl: "https://relay.example.test",
        documents: [document],
      };
      f.dependencies.process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG = "peer-config";
      f.dependencies.ownerDeliveryCredentials = () => ({
        bearer: "actual-token",
        accountId: "owner-account",
        relayUrl: config.relayUrl,
        signal: credentials.signal,
      });
      ownerDeliveryMock.read.mockReturnValue(config);
      let active: Promise<unknown> | undefined, lifetime!: AbortController;
      ownerDeliveryMock.start.mockImplementation((options) => {
        lifetime = new AbortController();
        return {
          stop: async () => {
            lifetime.abort();
            await active?.catch(() => undefined);
          },
        };
      });
      let passOptions!: Parameters<
        (typeof import("./nativeOwnerDelivery"))["runNativeOwnerDeliveryPass"]
      >[0];
      ownerDeliveryMock.pass.mockImplementation(async (options) => {
        passOptions = options;
        entered.resolve();
        await settled.promise;
        options.assertCurrent();
        return "retry";
      });
      try {
        expect(await f.engine.start()).toBe(true);
        expect(f.options().privateOwnerHost).toEqual({
          configPath: "native-config",
          client: config.nativeClient,
        });
        const run = ownerDeliveryMock.start.mock.calls.at(-1)![0].runPass;
        active = run(document, lifetime.signal);
        await entered.promise;
        expect(passOptions.bearer).toBe("actual-token");
        expect(passOptions.accountId).toBe("owner-account");
        if (mode === "credentials") credentials.abort();
        let closed = false;
        const closing = Promise.resolve(
          mode === "daemon"
            ? f.options().beforePublish!(new AbortController().signal)
            : f.engine.closeRelayTransportWorkspace("owner"),
        ).then(() => {
          closed = true;
        });
        expect(passOptions.signal.aborted).toBe(true);
        expect(() => passOptions.assertCurrent()).toThrow();
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(
          f.client.requests.filter(
            (request) =>
              request.method === "workspace.close" && request.workspace === "workspace-handle",
          ),
        ).toHaveLength(0);
        settled.resolve();
        await active?.catch(() => undefined);
        await closing;
        expect(closed).toBe(true);
      } finally {
        settled.resolve();
        await f.close();
        ownerDeliveryMock.read.mockReset();
        ownerDeliveryMock.start.mockReset();
        ownerDeliveryMock.pass.mockReset();
      }
    },
  );
});

describe("server owner peer lifecycle", () => {
  it("keeps local work available when optional owner ingress preparation fails", async () => {
    const f = fixture();
    f.dependencies.serverOwnerDelivery = {
      prepare: async () => {
        throw new Error("readonly profile");
      },
      workspaceIds: () => ["owner"],
      hasRefusals: () => undefined,
      connect: async () => null,
    };
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().privateOwnerHost).toBeUndefined();
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("restart-required");
    } finally {
      await f.close();
    }
  });

  it("names a refused document in its own quarantine, keeps the workspace delivering, and counts each Try again as a new incident", async () => {
    const f = fixture(),
      credentials = new AbortController();
    Object.setPrototypeOf(
      f.client,
      Object.defineProperties(
        Object.create(EngineClient.prototype),
        Object.getOwnPropertyDescriptors(Client.prototype),
      ),
    );
    const rootPath = await createTestScratch("dohc-server-owner-quarantine-");
    mkdirSync(resolve(rootPath, ".dohc", "local"), { recursive: true });
    f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
    const binding = {
      workspaceId: "owner",
      mainVersionId: "main",
      objectId: "object",
      lineageClaimId: "a".repeat(64),
      currentPath: "notes/plan.md",
      selectorPaths: ["notes/plan.md"],
      restoreFenceGeneration: 1,
    };
    const document = { binding, relayDatabaseNamespace: "namespace" };
    const config = {
      nativeConfigPath: "native-config",
      nativeClient: { aggregateBytes: 100_000_000, maxUploads: 2 },
      frames: {
        receive: {
          maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES,
          maxStateVectorBytes: 1024,
          maxUpdateBytes: 4096,
          maxSyncBytes: 4096,
        },
        maxQueuedBytes: 4096,
        maxQueuedFrames: 32,
        maxControlBytes: 4096,
        maxControlFrames: 8,
        maxAssemblyBytes: 4096,
      },
      attemptTimeoutMs: 30_000,
      retryDelayMs: 10_000,
    };
    f.dependencies.serverOwnerDelivery = {
      prepare: async () => config,
      workspaceIds: () => ["owner"],
      hasRefusals: () => undefined,
      connect: async () => ({
        bearer: "token",
        accountId: "owner-account",
        relayUrl: "https://relay.test",
        signal: credentials.signal,
        assertCurrent() {},
        retire: async () => 0,
        refusals: async () => {},
        keptEdits: unexpectedKeptEdits,
        keptEditsPage: unexpectedKeptEdits,
        open: unexpectedOpen,
        documents: async () => ({
          ok: true,
          // A list with a head: refusals are read outside the note's pass all the same.
          documents: [{ path: "notes/plan.md", status: "ready", document, head: 0 }],
        }),
      }),
    };
    const refused = (recovery: "paused" | "retrying") => [
      {
        objectId: "object",
        path: "notes/plan.md",
        reason: "invalid-update",
        outboxId: "outbox",
        binding,
        headDeliveryId: "delivery",
        recovery,
      },
    ];
    quarantineMock.read.mockResolvedValue(refused("paused"));
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveQuarantines("owner")).toEqual([
          {
            objectId: "object",
            path: "notes/plan.md",
            reason: "invalid-update",
            storedOn: "this-computer",
            incident: "outbox:delivery:0",
            recovery: "paused",
          },
        ]),
      );
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("active"));
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBeUndefined();
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({ workspaceId: "owner" });
      // The workspace as a renderer operation names it.
      const workspace = await f.authorities.withAuthority("owner", (lease) => ({
        workspaceId: "owner",
        rootPath: lease.binding.canonicalRootPath,
        attachmentId: lease.binding.attachmentId,
      }));
      await expect(
        f.engine.retryOwnerLiveQuarantine(workspace, "object", "outbox:delivery:9"),
      ).rejects.toThrow("This document changed.");
      expect(quarantineMock.retry).not.toHaveBeenCalled();
      quarantineMock.read
        .mockResolvedValueOnce(refused("paused"))
        .mockResolvedValue(refused("retrying"));
      await f.engine.retryOwnerLiveQuarantine(workspace, "object", "outbox:delivery:0");
      expect(quarantineMock.retry).toHaveBeenCalledExactlyOnceWith(
        expect.any(EngineClient),
        "workspace-handle",
        refused("paused")[0],
      );
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([
        { incident: "outbox:delivery:1", recovery: "retrying" },
      ]);
      quarantineMock.read.mockResolvedValue(refused("paused"));
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([
          { incident: "outbox:delivery:1", recovery: "paused" },
        ]),
      );
      await expect(
        f.engine.retryOwnerLiveQuarantine(workspace, "object", "outbox:delivery:0"),
      ).rejects.toThrow("This document changed.");
      quarantineMock.read.mockResolvedValue([]);
      ownerDeliveryMock.pass.mockResolvedValue("acknowledged");
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]));
    } finally {
      credentials.abort();
      await f.close();
      ownerDeliveryMock.pass.mockReset();
    }
  });

  it("drops an owner open's answer when its session ended meanwhile, and asks again in the next session", async () => {
    let ended = false;
    const open = vi.fn(
      async (_path: string, _signal: AbortSignal): Promise<"hosted" | "refused"> => {
        if (open.mock.calls.length === 1) ended = true;
        return "refused";
      },
    );
    const { f, credentials } = await quarantinedOwner(
      [{ path: "notes/plan.md", objectId: "object" }],
      {
        open,
        assertCurrent: () => {
          if (ended) throw new Error("This live editing session ended.");
        },
        onConnect: () => {
          ended = false;
        },
      },
    );
    f.dependencies.ownerPendingPaths = () => ["notes/draft.md"];
    ownerDeliveryMock.pass.mockResolvedValue("empty");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalled());
      expect(open).toHaveBeenCalledTimes(2);
      const before = ownerDeliveryMock.pass.mock.calls.length;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(ownerDeliveryMock.pass.mock.calls.length).toBeGreaterThan(before),
      );
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      credentials.abort();
      errors.mockRestore();
      await f.close();
      ownerDeliveryMock.pass.mockReset();
    }
  });

  // The list's head lets a pass skip a note's connection; a head that missed an edit lasts until the note's first turn after OWNER_FULL_PASS_MS.
  it("passes the list's head after a note's full pass, and opens the connection again every few minutes and after a failed pass", async () => {
    let head = 7;
    const { f, credentials } = await quarantinedOwner([
      { path: "notes/plan.md", objectId: "object", head: () => head },
      { path: "notes/other.md", objectId: "other" },
    ]);
    quarantineMock.read.mockResolvedValue([]);
    let nowMs = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let planResult = "empty";
    ownerDeliveryMock.pass.mockImplementation(async (options) =>
      options.document.binding.currentPath === "notes/plan.md" ? planResult : "empty",
    );
    // What the next pass of plan.md is given as the server's head.
    const nextPlanHead = async () => {
      for (;;) {
        const before = ownerDeliveryMock.pass.mock.calls.length;
        f.engine.retryOwnerDelivery("owner");
        await vi.waitFor(() =>
          expect(ownerDeliveryMock.pass.mock.calls.length).toBeGreaterThan(before),
        );
        const options = ownerDeliveryMock.pass.mock.calls.at(-1)![0];
        if (options.document.binding.currentPath !== "notes/plan.md") {
          expect(options.serverHead).toBeUndefined();
          continue;
        }
        return "serverHead" in options ? options.serverHead : "full";
      }
    };
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalled());
      // The first pass of each note opens its connection; later ones carry the head.
      expect(
        ownerDeliveryMock.pass.mock.calls.find(
          ([options]) => options.document.binding.currentPath === "notes/plan.md",
        )?.[0].serverHead,
      ).toBeUndefined();
      expect(await nextPlanHead()).toBe(7);
      head = 9;
      expect(await nextPlanHead()).toBe(9);
      // The head stayed put while an edit arrived: the note's first turn after OWNER_FULL_PASS_MS still opens.
      nowMs += OWNER_FULL_PASS_MS;
      expect(await nextPlanHead()).toBe("full");
      expect(await nextPlanHead()).toBe(9);
      // A clock set back does not hold off the next full pass.
      nowMs -= 60_000;
      expect(await nextPlanHead()).toBe("full");
      expect(await nextPlanHead()).toBe(9);
      planResult = "retry";
      expect(await nextPlanHead()).toBe(9);
      planResult = "empty";
      expect(await nextPlanHead()).toBe("full");
      expect(await nextPlanHead()).toBe(9);
    } finally {
      clock.mockRestore();
      credentials.abort();
      await f.close();
      ownerDeliveryMock.pass.mockReset();
      quarantineMock.read.mockReset();
    }
  });

  // The engine refuses a note's next edit once too many wait to reach the server, before any pass reports it.
  it("names a note whose edits the engine paused until a pass empties its queue", async () => {
    const { f, credentials } = await quarantinedOwner([
      { path: "notes/plan.md", objectId: "object" },
      { path: "notes/other.md", objectId: "other" },
    ]);
    quarantineMock.read.mockResolvedValue([]);
    let plan = "retry";
    ownerDeliveryMock.pass.mockImplementation(async (options) =>
      options.document.binding.currentPath === "notes/plan.md" ? plan : "empty",
    );
    // Each pass waits for the one before it, so a later pass starting means the earlier one finished.
    const passAgain = async (times: number) => {
      for (let pass = 0; pass < times; pass++) {
        const before = ownerDeliveryMock.pass.mock.calls.length;
        f.engine.retryOwnerDelivery("owner");
        await vi.waitFor(() =>
          expect(ownerDeliveryMock.pass.mock.calls.length).toBeGreaterThan(before),
        );
      }
    };
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying"));
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBeUndefined();
      const passes = ownerDeliveryMock.pass.mock.calls.length;
      f.engine.noteOwnerLiveEditsPaused("owner", "notes/plan.md");
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("unsent-edits-limit");
      expect(f.engine.ownerLivePausedPaths("owner")).toEqual(["notes/plan.md"]);
      expect(ownerDeliveryMock.pass).toHaveBeenCalledTimes(passes);
      plan = "acknowledged";
      await passAgain(5);
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("unsent-edits-limit");
      plan = "empty";
      await passAgain(2);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("active"));
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBeUndefined();
      expect(f.engine.ownerLivePausedPaths("owner")).toEqual([]);
    } finally {
      credentials.abort();
      await f.close();
      ownerDeliveryMock.pass.mockReset();
      quarantineMock.read.mockReset();
    }
  });

  it.each([true, false])(
    "follows background Stop recovery in the notices when the release writes the file: %s",
    async (materialized) => {
      const { f, credentials, binding, workspace } = await quarantinedOwner([]);
      const stopRow = (state: "requested" | "released") => ({
        binding,
        document: { mainVersionId: "main", objectId: "object", currentPath: "notes/plan.md" },
        relayDatabaseNamespace: "namespace",
        retirementOwed: state === "requested",
        state,
        ...(state === "released" ? { materialized } : {}),
      });
      let released = false,
        failRelease = true;
      f.client.respond = async (request) => {
        if (request.method === "ydoc.ownerStop.release") {
          if (failRelease) throw new Error("dohc could not write the file.");
          released = true;
          const { keptSnapshot } = request.params as { keptSnapshot?: string };
          expect(keptSnapshot).toBe(f.unwritten[0]?.snapshot);
          return { id: request.id, result: { stops: [{ ...stopRow("released"), keptSnapshot }] } };
        }
        if (request.method === "ydoc.ownerStop.list")
          return { id: request.id, result: { stops: released ? [] : [stopRow("requested")] } };
        if (request.method === "ydoc.ownerStop.request")
          return { id: request.id, result: { stops: [stopRow("requested")] } };
        return {
          id: request.id,
          result:
            request.method === "workspace.open"
              ? { workspace: "workspace-handle", localStateReady: true }
              : request.method === "engine.ping"
                ? { ok: true }
                : null,
        };
      };
      const queue = [
        {
          objectId: "object",
          path: "notes/plan.md",
          reason: "invalid-update",
          outboxId: "outbox",
          binding,
          headDeliveryId: "delivery",
          recovery: "stopping",
        },
      ];
      quarantineMock.read.mockImplementation(async () => (released ? [] : queue));
      const kept = recoveryQueue(binding);
      quarantineMock.queue.mockResolvedValue(kept.queue);
      vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await f.engine.start()).toBe(true);
        await vi.waitFor(() => expect(f.engine.ownerLiveStopFailures("owner")).toHaveLength(1));
        expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{ recovery: "stopping" }]);
        // Written before the release, in case it commits and then fails.
        expect(f.unwritten).toMatchObject([
          { workspaceId: "owner", objectId: "object", reason: "invalid-update" },
        ]);
        expect(JSON.parse(f.recoveries.get("object")!)).toMatchObject({
          path: "notes/plan.md",
          checkpoint: { sha256: digest(kept.queue.checkpoint) },
        });
        failRelease = false;
        f.engine.retryOwnerDelivery("owner");
        await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]));
        expect(f.engine.ownerLiveStopFailures("owner")).toEqual([]);
        // Only a release that wrote the file ends the record; otherwise its notice and Try again stay.
        expect(f.unwritten).toHaveLength(materialized ? 0 : 1);
        expect(quarantineMock.read).toHaveBeenLastCalledWith(
          expect.anything(),
          "workspace-handle",
          expect.objectContaining({
            unwritten: materialized ? [] : [expect.objectContaining({ objectId: "object" })],
          }),
        );
        if (materialized) return;
        const queueReads = quarantineMock.queue.mock.calls.length;
        // Without a readable copy the record and its notice stay, for Try again.
        vi.spyOn(directDocumentProjection, "run").mockRejectedValueOnce(new Error("worker failed"));
        expect(
          await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "notes/plan.md"),
        ).toEqual({
          copyPath: null,
          packagePath: ".dohc/local/live-recovery/notes/plan (recovered).dohc-recovery.json",
          notInNote: 0,
          storedOn: "this-computer",
          keptEdits: "kept",
        });
        expect(f.unwritten).toHaveLength(1);
        const saved = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "notes/plan.md");
        // The first package keeps its name, so Try again takes the next one.
        expect(saved).toEqual({
          copyPath: "notes/plan (recovered 2).md",
          packagePath: ".dohc/local/live-recovery/notes/plan (recovered 2).dohc-recovery.json",
          notInNote: 0,
          storedOn: "this-computer",
          keptEdits: "ended",
        });
        expect(
          await readFile(join(f.rows.get("owner")!.rootPath, saved.copyPath!), "utf8"),
        ).toContain("kept");
        expect(quarantineMock.queue).toHaveBeenCalledTimes(queueReads);
      } finally {
        credentials.abort();
        await f.close();
        quarantineMock.read.mockReset();
        quarantineMock.queue.mockReset();
        vi.restoreAllMocks();
      }
    },
  );

  it.each([
    ["a restart, then a Try again that writes the file", "materialized"],
    ["a restart, then a Try again that fails again", "failed"],
    ["an engine store reset, then a Try again that finds no release left", "conflict"],
  ] as const)(
    "keeps the edits a release owed to a renamed file through %s, until the file or a recovery copy holds them",
    async (_title, outcome) => {
      // The record keeps the path the document had when it stopped; it has since been renamed.
      const kept = await keptRelease("notes/old plan.md");
      if (outcome !== "conflict") kept.engine.release = releaseAnswer(outcome === "materialized");
      try {
        await (await kept.launch()).f.close();
        const second = await kept.launch();
        try {
          expect(second.f.engine.ownerLiveQuarantines("owner")).toMatchObject([
            { objectId: "object", path: "notes/old plan.md", recovery: "not-written" },
          ]);
          const released = await second.f.engine.retryOwnerLiveRelease(second.workspace, "object");
          expect(stopMethods(second.methods)).toEqual(["ydoc.ownerStop.release"]);
          expect(released === "requested" ? released : released?.materialized).toBe(
            outcome === "conflict" ? undefined : outcome === "materialized",
          );
        } finally {
          await second.f.close();
        }
        if (outcome === "materialized") {
          expect(await kept.records().list("owner")).toEqual([]);
          expect(await kept.records().recovery("owner", "object")).toBeNull();
          return;
        }
        // After a restart the row stays, offering Try again only while the engine may still hold the release.
        const { f, workspace, methods } = await kept.launch();
        try {
          expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([
            { recovery: outcome === "conflict" ? "cannot-write" : "not-written" },
          ]);
          if (outcome === "conflict")
            await expect(f.engine.retryOwnerLiveRelease(workspace, "object")).rejects.toThrow(
              "This document changed.",
            );
          expect(await kept.records().recovery("owner", "object")).toEqual(expect.any(String));
          const saved = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/old plan.md");
          expect(saved.keptEdits).toBe("ended");
          expect(await readFile(join(kept.rootPath, saved.copyPath!), "utf8")).toContain("kept");
          expect(await readFile(join(kept.rootPath, saved.packagePath), "utf8")).toContain(
            "dohc.live-recovery",
          );
          expect(stopMethods(methods)).toEqual([]);
          expect(await kept.records().list("owner")).toEqual([]);
          expect(await kept.records().recovery("owner", "object")).toBeNull();
          await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]));
        } finally {
          await f.close();
        }
      } finally {
        quarantineMock.read.mockReset();
      }
    },
  );

  it("saves exactly the kept edits a row's incident names", async () => {
    const kept = await keptRelease();
    kept.engine.queues = [
      {
        objectId: "object",
        path: "notes/plan.md",
        reason: "invalid-update",
        outboxId: "rebuilt-outbox",
        binding: keptBinding,
        headDeliveryId: "rebuilt-delivery",
        recovery: "paused",
      },
    ];
    quarantineMock.queue.mockResolvedValue({
      ...recoveryQueue(keptBinding).queue,
      outboxId: "rebuilt-outbox",
    });
    const { f, workspace } = await kept.launch();
    const outboxOf = async (packagePath: string) =>
      (JSON.parse(await readFile(join(kept.rootPath, packagePath), "utf8")) as { outboxId: string })
        .outboxId;
    try {
      const [queueRow, recordRow] = f.engine.ownerLiveQuarantines("owner");
      expect([queueRow?.incident, recordRow?.incident]).toEqual([
        "rebuilt-outbox:rebuilt-delivery:0",
        `release:${"a".repeat(64)}:1`,
      ]);
      const queued = await f.engine.saveOwnerLiveRecoveryCopy(
        workspace,
        "notes/plan.md",
        queueRow!.incident,
      );
      expect(queued.keptEdits).toBe("kept");
      expect(await outboxOf(queued.packagePath)).toBe("rebuilt-outbox");
      expect(await kept.records().list("owner")).toHaveLength(1);
      for (const stale of ["rebuilt-outbox:rebuilt-delivery:9", "server:rebuilt-outbox:1"]) {
        await expect(
          f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md", stale),
        ).rejects.toThrow("This document changed.");
      }
      const record = await f.engine.saveOwnerLiveRecoveryCopy(
        workspace,
        "notes/plan.md",
        recordRow!.incident,
      );
      expect(record.keptEdits).toBe("ended");
      expect(await outboxOf(record.packagePath)).toBe("outbox");
      expect(await kept.records().list("owner")).toEqual([]);
      await expect(
        f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md", recordRow!.incident),
      ).rejects.toThrow("This document changed.");
    } finally {
      await f.close();
      quarantineMock.read.mockReset();
      quarantineMock.queue.mockReset();
    }
  });

  it("refuses a release and a save of a queue the engine cannot read, keeps its row, and reads it again on Try again", async () => {
    const { f, credentials, binding, workspace } = await quarantinedOwner([]);
    const refused = new EngineRequestError(1, {
      code: "INVALID_PARAMS",
      message: "owner-outbox-accepted-state-incomplete",
      retry: "no",
    });
    const unreadable = {
      objectId: "object",
      path: "notes/plan.md",
      reason: refused.message,
      outboxId: "outbox",
      binding,
      headDeliveryId: null,
      recovery: "unreadable",
    };
    let readable = false;
    quarantineMock.read.mockImplementation(
      async (_client, _handle, options?: { strict?: (queue: LiveObjectBinding) => boolean }) => {
        if (readable)
          return [
            {
              ...unreadable,
              reason: "invalid-update",
              headDeliveryId: "delivery",
              recovery: "paused",
            },
          ];
        if (options?.strict?.(binding)) throw refused;
        return [unreadable];
      },
    );
    quarantineMock.queue.mockResolvedValue(recoveryQueue(binding).queue);
    f.client.respond = async (request) => ({
      id: request.id,
      result:
        request.method === "ydoc.ownerStop.release"
          ? { stops: [{ ...releasedStop, binding, materialized: false }] }
          : request.method === "workspace.open"
            ? { workspace: "workspace-handle", localStateReady: true }
            : request.method === "ydoc.ownerStop.list"
              ? { stops: [] }
              : request.method === "engine.ping"
                ? { ok: true }
                : null,
    });
    try {
      expect(await f.engine.start()).toBe(true);
      const owner = await workspace();
      await f.engine.refreshOwnerLiveQuarantines(owner);
      const row = {
        objectId: "object",
        path: "notes/plan.md",
        reason: "owner-outbox-accepted-state-incomplete",
        storedOn: "this-computer",
        incident: "unreadable:outbox",
        recovery: "unreadable",
      };
      expect(f.engine.ownerLiveQuarantines("owner")).toEqual([row]);
      await expect(f.engine.releaseOwnerLiveStop(owner, binding, 0)).rejects.toBe(refused);
      expect(f.client.requests.map((request) => request.method)).not.toContain(
        "ydoc.ownerStop.release",
      );
      expect(quarantineMock.queue).not.toHaveBeenCalled();
      expect(f.unwritten).toEqual([]);
      await expect(f.engine.saveOwnerLiveRecoveryCopy(owner, "notes/plan.md")).rejects.toBe(
        refused,
      );
      await expect(
        f.engine.saveOwnerLiveRecoveryCopy(owner, "notes/plan.md", row.incident),
      ).rejects.toBe(refused);
      expect(f.engine.ownerLiveQuarantines("owner")).toEqual([row]);
      await expect(f.engine.retryOwnerLiveQuarantine(owner, "object", row.incident)).rejects.toBe(
        refused,
      );
      readable = true;
      await f.engine.retryOwnerLiveQuarantine(owner, "object", row.incident);
      expect(quarantineMock.retry).not.toHaveBeenCalled();
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([
        { recovery: "paused", incident: "outbox:delivery:0" },
      ]);
    } finally {
      credentials.abort();
      await f.close();
      quarantineMock.read.mockReset();
      quarantineMock.queue.mockReset();
    }
  });

  it("lists and saves restore-fenced typing with its old incident after the binding advances", async () => {
    const { f, credentials, binding, workspace } = await quarantinedOwner([
      { path: "notes/plan.md", objectId: "object" },
    ]);
    const old = { ...binding, restoreFenceGeneration: 0 };
    const row = {
      objectId: "object",
      path: "notes/plan.md",
      reason: "restore-fenced",
      outboxId: "old-queue",
      binding: old,
      headDeliveryId: "old-delivery",
      recovery: "paused",
      saveOnly: true,
    };
    quarantineMock.read.mockResolvedValue([row]);
    const { queue } = recoveryQueue(old, undefined, "Owner typed during the hold.");
    quarantineMock.queue.mockResolvedValue({
      ...queue,
      outboxId: row.outboxId,
      quarantineReason: row.reason,
      observedBinding: binding,
      entries: queue.entries.map((entry) => ({ ...entry, deliveryId: row.headDeliveryId })),
    });
    ownerDeliveryMock.pass.mockResolvedValue("empty");
    try {
      expect(await f.engine.start()).toBe(true);
      const owner = await workspace();
      const root = f.rows.get("owner")!.rootPath;
      await mkdir(join(root, "notes"), { recursive: true });
      await writeFile(join(root, row.path), "Restored text.");
      await f.engine.refreshOwnerLiveQuarantines(owner);
      const incident = "old-queue:old-delivery:0";
      expect(f.engine.ownerLiveQuarantines("owner")).toEqual([
        {
          objectId: "object",
          path: row.path,
          reason: row.reason,
          storedOn: "this-computer",
          incident,
          recovery: "paused",
          saveOnly: true,
        },
      ]);
      await expect(f.engine.retryOwnerLiveQuarantine(owner, "object", incident)).rejects.toThrow(
        "These edits were kept after a restore and cannot be sent again. Save a recovery copy using this path and incident.",
      );
      expect(quarantineMock.retry).not.toHaveBeenCalled();
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(owner, row.path, incident);
      expect(await readFile(join(root, saved.copyPath!), "utf8")).toContain(
        "Owner typed during the hold.",
      );
      expect(await readFile(join(root, row.path), "utf8")).toBe("Restored text.");
      expect(
        parseLiveRecoveryPackage(await readFile(join(root, saved.packagePath), "utf8")),
      ).toMatchObject({ outboxId: row.outboxId, binding: old, reason: "restore-fenced" });
      expect(saved.keptEdits).toBe("kept");
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{ incident, saveOnly: true }]);
      await expect(
        f.engine.saveOwnerLiveRecoveryCopy(owner, row.path, "old-queue:new-delivery:0"),
      ).rejects.toThrow("This document changed.");
    } finally {
      credentials.abort();
      await f.close();
      ownerDeliveryMock.pass.mockReset();
    }
  });

  it("saves edits the server keeps from the server's queue, then confirms the copy, and tries them again on the server", async () => {
    let kept = [
      {
        objectId: "object",
        path: "notes/plan.md",
        outboxId: "server-outbox",
        reason: "invalid-update",
        generation: 1,
        store: "store",
        recovery: "paused",
      },
    ];
    const requests: {
      action: string;
      outboxId: string;
      generation: number;
      checkpointDigest?: string | null;
    }[] = [];
    const served = {
      ...recoveryQueue(keptBinding, "Recipient text").queue,
      outboxId: "server-outbox",
    };
    const pages = servedPages(served);
    const { f, credentials, workspace } = await quarantinedOwner(
      [{ path: "notes/plan.md", objectId: "object", head: () => 0 }],
      {
        kept: () => kept,
        keptEdits: async (input) => {
          if (input.action === "page") {
            if (input.cursor === undefined)
              requests.push({
                action: "page",
                outboxId: input.outboxId,
                generation: input.generation,
              });
            return { ok: true, page: pages(input.cursor) };
          }
          requests.push(input);
          kept = [{ ...kept[0]!, recovery: input.action === "copied" ? "copied" : "retrying" }];
          return { ok: true };
        },
      },
    );
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveQuarantines("owner")).toEqual([
          {
            objectId: "object",
            path: "notes/plan.md",
            reason: "invalid-update",
            storedOn: "server",
            incident: "server:server-outbox:1",
            recovery: "paused",
          },
        ]),
      );
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "notes/plan.md");
      expect(saved).toEqual({
        copyPath: "notes/plan (recovered).md",
        packagePath: ".dohc/local/live-recovery/notes/plan (recovered).dohc-recovery.json",
        notInNote: 0,
        storedOn: "server",
        keptEdits: "copied",
      });
      const root = f.rows.get("owner")!.rootPath;
      const stored = await readFile(join(root, saved.packagePath), "utf8");
      expect(JSON.parse(stored)).toMatchObject({
        storedOn: "server",
        outboxId: "server-outbox",
        checkpoint: { sha256: served.checkpointDigest },
      });
      const rebuilt = new Y.Doc();
      for (const part of liveRecoveryUpdates(parseLiveRecoveryPackage(stored)))
        Y.applyUpdate(rebuilt, part);
      expect(rebuilt.getMap("frontmatter").toJSON()).toMatchObject({
        note: "Recipient text",
        status: "kept",
      });
      rebuilt.destroy();
      expect(await readFile(join(root, saved.copyPath!), "utf8")).toContain("Recipient text");
      // The copy was on disk before the server heard of it, and the server hears which checkpoint it holds.
      expect(requests).toEqual([
        { action: "page", outboxId: "server-outbox", generation: 1 },
        {
          action: "copied",
          outboxId: "server-outbox",
          generation: 1,
          checkpointDigest: served.checkpointDigest,
        },
      ]);
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([
        { storedOn: "server", recovery: "copied" },
      ]);
      expect(quarantineMock.queue).not.toHaveBeenCalled();
      await expect(
        f.engine.retryOwnerLiveQuarantine(await workspace(), "object", "server:server-outbox:0"),
      ).rejects.toThrow("This document changed.");
      await f.engine.retryOwnerLiveQuarantine(
        await workspace(),
        "object",
        "server:server-outbox:1",
      );
      expect(requests.at(-1)).toEqual({
        action: "retry",
        outboxId: "server-outbox",
        generation: 1,
      });
      expect(quarantineMock.retry).not.toHaveBeenCalled();
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{ recovery: "retrying" }]);
    } finally {
      credentials.abort();
      await f.close();
      ownerDeliveryMock.pass.mockReset();
    }
  });

  it("assembles the server's queue from bounded pages with every byte and author, and refuses one that changed", async () => {
    const { queue } = recoveryQueue(keptBinding);
    const served: OwnerYDocOutboxRecovery = {
      ...queue,
      outboxId: "server-outbox",
      entries: queue.entries.map((entry) => ({
        ...entry,
        personEdit: true as const,
        agentDeclaration: { agentId: "agent", onBehalfOf: null, depth: 1 },
        nativeSource: {
          binding: keptBinding,
          adoptionId: "adoption",
          nativeSequence: 2,
          updateDigest: entry.updateDigest,
          origin: {
            kind: "nativeUpdate" as const,
            actorOriginId: "origin",
            actorKind: "agent",
            onBehalfOf: "owner",
            chainDepth: 1,
            recordedAtMs: 1,
          },
        },
      })),
    };
    const row = {
      objectId: "object",
      path: "notes/plan.md",
      outboxId: "server-outbox",
      reason: "invalid-update",
      generation: 1,
      store: "store",
      recovery: "paused" as const,
    };
    const pages = servedPages(served, 32);
    let reads = 0;
    expect(
      await readServerKeptEditsQueue(row, async (cursor) => {
        reads++;
        return { ok: true, page: pages(cursor) };
      }),
    ).toEqual(served);
    expect(reads).toBeGreaterThan(10);
    let turn = 0;
    await expect(
      readServerKeptEditsQueue(row, async (cursor) => ({
        ok: true,
        page: turn++ === 0 ? pages(cursor) : { kind: "readChanged" },
      })),
    ).rejects.toBeInstanceOf(ServerKeptEditsConflict);
  });

  it("discovers and saves a later row of the server's kept edits, and keeps the last complete list when a page fails", async () => {
    const row = (index: number) => ({
      objectId: `object-${index}`,
      path: `notes/plan-${index}.md`,
      outboxId: `server-outbox-${index}`,
      reason: "invalid-update",
      generation: index,
      store: "store",
      recovery: "paused",
    });
    const firstPage = Array.from({ length: 2 }, (_, index) => row(index + 1));
    let failing = false;
    const pageRequests: number[] = [],
      actions: string[] = [];
    const last = row(3),
      pages = servedPages({
        ...recoveryQueue({ ...keptBinding, objectId: last.objectId }).queue,
        outboxId: last.outboxId,
      });
    const { f, credentials, workspace } = await quarantinedOwner(
      [{ path: "notes/plan-1.md", objectId: "object-1", head: () => 0 }],
      {
        kept: () => firstPage,
        keptCursor: 2,
        keptEditsPage: async (after) => {
          pageRequests.push(after);
          if (failing) throw new Error("Owner kept edits discovery failed.");
          return { ok: true, keptEdits: [last, firstPage[0]], nextCursor: null };
        },
        keptEdits: async (input) => {
          actions.push(input.action);
          if (input.action === "page") return { ok: true, page: pages(input.cursor) };
          return { ok: true };
        },
      },
    );
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toHaveLength(3));
      expect(pageRequests[0]).toBe(2);
      expect(
        f.engine.ownerLiveQuarantines("owner").filter((found) => found.objectId === "object-1"),
      ).toHaveLength(1);
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), last.path);
      expect(saved).toMatchObject({ storedOn: "server", keptEdits: "copied" });
      expect(actions.at(-1)).toBe("copied");
      failing = true;
      const before = pageRequests.length;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(pageRequests.length).toBeGreaterThan(before));
      expect(f.engine.ownerLiveQuarantines("owner")).toHaveLength(3);
    } finally {
      credentials.abort();
      await f.close();
      ownerDeliveryMock.pass.mockReset();
    }
  });
  describe("a move's owner catch-up", () => {
    const bindingOf = (path: string, objectId: string) => ({
      workspaceId: "owner",
      mainVersionId: "main",
      objectId,
      lineageClaimId: "a".repeat(64),
      currentPath: path,
      selectorPaths: [path],
      restoreFenceGeneration: 1,
    });
    const ready = (path: string, objectId: string) => ({
      path,
      objectId,
      status: "ready",
      document: { binding: bindingOf(path, objectId), relayDatabaseNamespace: "namespace" },
    });
    const observed = () =>
      ownerDeliveryMock.pass.mock.calls
        .filter(([options]) => options.observedOnly === true)
        .map(([options]) => options.document.binding.objectId as string);
    async function owner(rows: () => unknown[]) {
      const f = fixture(),
        credentials = new AbortController();
      Object.setPrototypeOf(
        f.client,
        Object.defineProperties(
          Object.create(EngineClient.prototype),
          Object.getOwnPropertyDescriptors(Client.prototype),
        ),
      );
      const rootPath = await createTestScratch("dohc-owner-catch-up-");
      f.rows.set("owner", {
        workspaceId: "owner",
        rootPath,
        kind: "personal",
        mode: "local-first",
      });
      const config = {
        nativeConfigPath: "native-config",
        nativeClient: { aggregateBytes: 100_000_000, maxUploads: 2 },
        frames: {
          receive: {
            maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES,
            maxStateVectorBytes: 1024,
            maxUpdateBytes: 4096,
            maxSyncBytes: 4096,
          },
          maxQueuedBytes: 4096,
          maxQueuedFrames: 32,
          maxControlBytes: 4096,
          maxControlFrames: 8,
          maxAssemblyBytes: 4096,
        },
        attemptTimeoutMs: 30_000,
        retryDelayMs: 10_000,
      };
      f.dependencies.serverOwnerDelivery = {
        prepare: async () => config,
        workspaceIds: () => ["owner"],
        hasRefusals: () => undefined,
        connect: async () => ({
          bearer: "token",
          accountId: "owner-account",
          relayUrl: "https://relay.test",
          signal: credentials.signal,
          assertCurrent() {},
          retire: async () => 0,
          refusals: async () => {},
          keptEdits: unexpectedKeptEdits,
          keptEditsPage: unexpectedKeptEdits,
          open: unexpectedOpen,
          documents: async () => ({ ok: true, documents: rows() }),
        }),
      };
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.liveDocumentPaths("owner")).toBeDefined());
      return { f, credentials };
    }

    it.each(["session", "quitting", "restart"])(
      "answers false when the %s ends during the owner sync",
      async (ending) => {
        const held = deferred<string>();
        ownerDeliveryMock.pass.mockImplementation(async (options) =>
          options.observedOnly ? held.promise : "empty",
        );
        const { f, credentials } = await owner(() => [ready("a.md", "a"), ready("b.md", "b")]);
        try {
          const answer = f.engine.ownerCatchUp("owner", ["a", "b"], new AbortController().signal);
          await vi.waitFor(() => expect(observed()).toEqual(["a"]));
          if (ending === "session") credentials.abort();
          if (ending === "quitting") f.setQuitting(true);
          const restarting =
            ending === "restart" ? f.engine.closeAllRelayTransportWorkspaces() : undefined;
          held.resolve("acknowledged");
          await restarting;
          expect(await answer).toBe(false);
          expect(observed()).toEqual(["a"]);
        } finally {
          await f.close();
          ownerDeliveryMock.pass.mockReset();
        }
      },
    );
  });

  it("reports a document the server refused ahead of every other reason but one it cannot start or whose server copy diverged", async () => {
    const f = fixture(),
      credentials = new AbortController();
    Object.setPrototypeOf(
      f.client,
      Object.defineProperties(
        Object.create(EngineClient.prototype),
        Object.getOwnPropertyDescriptors(Client.prototype),
      ),
    );
    const rootPath = await createTestScratch("dohc-server-owner-refused-");
    f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
    const document = {
      binding: {
        workspaceId: "owner",
        mainVersionId: "main",
        objectId: "object",
        lineageClaimId: "a".repeat(64),
        currentPath: "a.md",
        selectorPaths: ["a.md"],
        restoreFenceGeneration: 1,
      },
      relayDatabaseNamespace: "namespace",
    };
    const refused = { path: "refused.md", status: "unavailable", reason: "session-host-refused" };
    const unopened = {
      path: "unopened.md",
      status: "unavailable",
      reason: "live-document-without-lineage",
    };
    const divergedRow = {
      path: "diverged.md",
      status: "unavailable",
      reason: "session-host-diverged",
    };
    const edited = { path: "edited.md", status: "unavailable", reason: "live-edit-unadmitted" };
    const held = { path: "held.md", status: "unavailable", reason: "conflict-parent-withheld" };
    const long = { path: "long.md", status: "unavailable", reason: "live-history-over-budget" };
    const failing = {
      path: "failing.md",
      status: "unavailable",
      reason: "live-start-failing",
      failure: { word: "engine-refused", since: "2026-11-13T01:00:00.000Z" },
    };
    const others = [
      { path: "changed.md", status: "unavailable", reason: "workspace-changed" },
      { path: "moved.md", status: "unavailable", reason: "document-unavailable" },
    ];
    const ready = { path: "a.md", status: "ready", document };
    // The server says the workspace diverged whenever any of its rows does, and after its owner stopped every one.
    let rows: unknown[] = others,
      diverged = false;
    const config = {
      nativeConfigPath: "native-config",
      nativeClient: { aggregateBytes: 100_000_000, maxUploads: 2 },
      frames: {
        receive: {
          maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES,
          maxStateVectorBytes: 1024,
          maxUpdateBytes: 4096,
          maxSyncBytes: 4096,
        },
        maxQueuedBytes: 4096,
        maxQueuedFrames: 32,
        maxControlBytes: 4096,
        maxControlFrames: 8,
        maxAssemblyBytes: 4096,
      },
      attemptTimeoutMs: 30_000,
      retryDelayMs: 10_000,
    };
    f.dependencies.serverOwnerDelivery = {
      prepare: async () => config,
      workspaceIds: () => ["owner"],
      hasRefusals: () => undefined,
      connect: async () => ({
        bearer: "token",
        accountId: "owner-account",
        relayUrl: "https://relay.test",
        signal: credentials.signal,
        assertCurrent() {},
        retire: async () => 0,
        refusals: async () => {},
        keptEdits: unexpectedKeptEdits,
        keptEditsPage: unexpectedKeptEdits,
        open: unexpectedOpen,
        documents: async () => ({ ok: true, diverged, documents: rows }),
      }),
    };
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("workspace-changed"),
      );
      rows = [...others, failing];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-start-failing"),
      );
      // A document whose history the server can't check outranks it: the server would keep failing that one.
      rows = [...others, failing, long];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-history-over-budget"),
      );
      rows = [...others, refused];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, ...others];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable"),
      );
      rows = [ready, ...others, refused];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [...others, refused, unopened];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"),
      );
      rows = [ready, refused];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"),
      );
      rows = [ready, ...others, unopened, refused];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // A diverged server copy outranks all of them, with or without a frozen document.
      // Each step changes the reason, so no step passes on the one before it.
      rows = [...others, refused, unopened, divergedRow];
      diverged = true;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, unopened];
      diverged = false;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"),
      );
      rows = [ready, divergedRow, ...others, unopened, refused];
      diverged = true;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, ...others];
      diverged = false;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable"),
      );
      rows = [ready, refused, divergedRow];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"),
      );
      rows = [ready, ...others];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable"),
      );
      rows = [ready, ...others, edited];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-edit-unadmitted"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [...others, edited, refused];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"),
      );
      rows = [held, { path: "preparing.md", status: "preparing" }];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("conflict-parent-withheld"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, ...others, edited, held];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-edit-unadmitted"),
      );
      rows = [ready, ...others, held];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("conflict-parent-withheld"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, held, refused];
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"),
      );
      rows = [];
      diverged = true;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() =>
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"),
      );
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      diverged = false;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBeUndefined());
    } finally {
      credentials.abort();
      await f.close();
      ownerDeliveryMock.pass.mockReset();
    }
  });
});
