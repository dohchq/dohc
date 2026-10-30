import {LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES} from "@dohc/live-session-contract/live-frame";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { createDesktopEngine, type ServerOwnerDelivery } from "./desktopEngine";
import type { JsonValue, OwnerYDocOutboxRecovery } from "@dohc/workspace-engine-client";
import { EngineRelayClient } from "./engineRelayClient";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import type { RegistryEntry } from "./registryStore";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "./testTemp";
import { localStateDir } from "./workspaceLocalState";
import { createUnwrittenReleases, recoverySnapshot, type UnwrittenRelease, type UnwrittenReleases } from "./ownerLiveReleases";
import { directDocumentProjection } from "./documentProjection";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readServerKeptEditsQueue, ServerKeptEditsConflict, ServerRecoveryCopyRefusedError, type OwnerLiveQuarantineRecord } from "./ownerLiveQuarantine";
import { liveRecoveryUpdates, parseLiveRecoveryPackage } from "./ownerLiveRecoveryCopy";
import * as Y from "yjs";
import type { LiveObjectBinding } from "@dohc/workspace-engine-client";

const ownerHostMock = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn() }));
vi.mock("./desktopOwnerHost", () => ({ readDesktopOwnerHostConfig: ownerHostMock.read, startDesktopOwnerHost: ownerHostMock.start }));

const ownerDeliveryMock = vi.hoisted(() => ({read: vi.fn(), start: vi.fn(), pass: vi.fn()}));
vi.mock("./desktopOwnerDelivery", () => ({readDesktopOwnerDeliveryConfig: ownerDeliveryMock.read, startDesktopOwnerDelivery: ownerDeliveryMock.start}));
vi.mock("./nativeOwnerDelivery", async () => ({runNativeOwnerDeliveryPass: ownerDeliveryMock.pass,
  OwnerKnownRefusals: (await vi.importActual<typeof import("./ownerYDocOutbox")>("./ownerYDocOutbox")).OwnerKnownRefusals}));
// Stands in for the engine's durable owner queues, which outlive every desktop process.
const quarantineMock = vi.hoisted(() => ({read: vi.fn(), retry: vi.fn(), queue: vi.fn()}));
vi.mock("./ownerLiveQuarantine", async importOriginal => ({...await importOriginal<typeof import("./ownerLiveQuarantine")>(),
  readOwnerLiveQuarantines: quarantineMock.read, retryOwnerLiveQuarantine: quarantineMock.retry, readOwnerLiveQueue: quarantineMock.queue}));
// Use the Linux x64 installation layout on every test host.
vi.mock("./installedReaderConfig", async importOriginal => {
  const { installedReaderConfig } = await importOriginal<typeof import("./installedReaderConfig")>();
  return { installedReaderConfig: (resources: string | undefined) => installedReaderConfig(resources, "linux", "x64") };
});

type State = {
  collectionAutomations: { notifyClaimed: Mock<() => void>; failuresChanged: Mock<() => void>; pauseForEngineRestart: Mock<() => void>; resumeAfterEngineRestart: Mock<() => void> };
};
type Dependencies = Parameters<typeof createDesktopEngine<State>>[0];

function workspaceIdOf(request: Request): unknown {
  return typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)
    ? request.params.workspaceId : undefined;
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
    if (request.method === "workspace.close" && request.workspace === "smoke") this.smokeClosed.resolve();
    return { id: request.id, result: request.method === "workspace.open"
      ? { workspace: String(workspaceIdOf(request)).startsWith("desktop-startup-smoke-") ? "smoke" : "workspace-handle" }
      : request.method === "workspace.close" ? { closed: true }
      : request.method === "ydoc.ownerStop.list" ? { stops: [] }
      : request.method === "engine.ping" ? { ok: true } : null };
  }

  onEvent(handler: (event: Event) => void) {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  emit(name: string, payload: Event["payload"]) {
    for (const handler of this.handlers) handler({ seq: 1, sessionGeneration: 1, name, payload });
  }
  close() { this.closed.resolve(); }
  waitForExit() { return this.exitWait; }
}

function fixture(options: {ownerLiveReleases?: UnwrittenReleases} = {}) {
  const rows = new Map<string, RegistryEntry>();
  const states = new Map<string, State>();
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => rows.get(id) ?? null,
    canonicalizeRoot: resolve,
    createState: (binding): State => {
      const state = { collectionAutomations: { notifyClaimed: vi.fn(), failuresChanged: vi.fn(), pauseForEngineRestart: vi.fn(), resumeAfterEngineRestart: vi.fn() } };
      states.set(binding.workspaceId, state);
      return state;
    },
  });
  const client = new Client();
  let launch: (options: EngineClientSpawnOptions) => Promise<EngineDaemonClient> = async () => client;
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
      list: async id => unwritten.filter(row => row.workspaceId === id),
      put: async (release, recovery) => {
        recoveries.set(release.objectId, recovery);
        unwritten.splice(0, unwritten.length, ...unwritten.filter(row => row.objectId !== release.objectId), release);
      },
      recovery: async (_id, objectId) => recoveries.get(objectId) ?? null,
      endRetry: async (id, objectId) => {
        unwritten.splice(0, unwritten.length, ...unwritten.map(row => row.workspaceId === id && row.objectId === objectId ? {...row, retry: false} : row));
      },
      written: async (id, objectId, {snapshot}) => {
        if (!unwritten.some(row => row.workspaceId === id && row.objectId === objectId && row.retry && snapshot !== null && row.snapshot === snapshot)) return;
        recoveries.delete(objectId);
        unwritten.splice(0, unwritten.length, ...unwritten.filter(row => row.workspaceId !== id || row.objectId !== objectId));
      },
      remove: async (id, objectId) => {
        if (!unwritten.some(row => row.workspaceId === id && row.objectId === objectId)) return;
        recoveries.delete(objectId);
        unwritten.splice(0, unwritten.length, ...unwritten.filter(row => row.workspaceId !== id || row.objectId !== objectId));
      },
    },
    documentProjection: directDocumentProjection,
    resourcesBasePath: () => "resources",
    findWorkspace: id => rows.get(id) ?? null,
    app: { isPackaged: false, getAppPath: vi.fn(() => "app-root") },
    dialog: { showErrorBox: vi.fn() },
    process: { env: {}, resourcesPath: "resources" },
    createRustEngineDaemon: vi.fn((input) => {
      daemonOptions = input;
      const daemon = createRustEngineDaemon({ ...input,
        fileExists: () => true, launch: (spawnOptions) => { spawns.push(spawnOptions); return launch(spawnOptions); },
        sleep: async () => undefined,
        pingIntervalMs: 60_000, healthyResetMs: 60_000,
      });
      daemons.push(daemon);
      configureDaemon(daemon);
      return daemon;
    }),
    defaultEngineBinaryPath: vi.fn(() => resolve("test-engine")),
    isQuitting: () => quitting,
    recordEngineProblem: vi.fn(),
    workspaceAuthorities: authorities,
    collectionAutomations: { current: (id) => rows.has(id) ? states.get(id)?.collectionAutomations : undefined },
    notifyRenderer: vi.fn(), noteNoAtomicPlacement: vi.fn(), noteWriteDeferred: vi.fn(),
    launchMarks: { daemonReady: vi.fn() }, desktopMarks: { markOnce: vi.fn() },
    logLaunchMarksOnce: vi.fn(),
  };
  const engine = createDesktopEngine(dependencies);
  return {
    engine, dependencies, client, rows, states, authorities, daemons, spawns, unwritten, recoveries,
    options: () => daemonOptions,
    setQuitting: (value: boolean) => { quitting = value; },
    setLaunch: (value: typeof launch) => { launch = value; },
    setDaemon: (value: typeof configureDaemon) => { configureDaemon = value; },
    async addWorkspace(workspaceId: string) {
      const workspace: RegistryEntry = { workspaceId, rootPath: resolve(workspaceId), kind: "personal", mode: "local-first" };
      rows.set(workspaceId, workspace);
      authorities.acquire(workspaceId).release();
      return workspace;
    },
    async close() {
      quitting = true;
      try { await engine.closeAllRelayTransportWorkspaces(); }
      finally {
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
const unexpectedKeptEdits = async (): Promise<unknown> => {throw new Error("Unexpected kept edits request.");};
/** A server-owned workspace whose delivery offers these documents, for quarantine tests. The server keeps `kept`. */
async function quarantinedOwner(documents: {path: string; objectId: string}[],
  server: {kept?: () => unknown[]; keptCursor?: number; keptEdits?: ServerSession["keptEdits"]; keptEditsPage?: ServerSession["keptEditsPage"]} = {}) {
  const f = fixture(), credentials = new AbortController();
  Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
  const rootPath = await createTestScratch("dohc-owner-quarantine-");
  f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
  const bindingOf = (path: string, objectId: string) => ({workspaceId: "owner", mainVersionId: "main", objectId, lineageClaimId: "a".repeat(64),
    currentPath: path, selectorPaths: [path], restoreFenceGeneration: 1});
  const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
    frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
      maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
    attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
  f.dependencies.serverOwnerDelivery = {prepare: async () => config, workspaceIds: () => ["owner"], hasRefusals: () => undefined,
    connect: async () => ({bearer: "token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal, assertCurrent() {},
      retire: async () => 0, refusals: async () => {}, keptEdits: server.keptEdits ?? unexpectedKeptEdits, keptEditsPage: server.keptEditsPage ?? unexpectedKeptEdits,
      documents: async () => ({ok: true, documents: documents.map(({path, objectId}) =>
        ({path, status: "ready", document: {binding: bindingOf(path, objectId), relayDatabaseNamespace: "namespace", shareId: "share"}})),
        ...(server.kept ? {keptEdits: server.kept()} : {}), ...(server.keptCursor === undefined ? {} : {keptEditsCursor: server.keptCursor})})})};
  const workspace = () => f.authorities.withAuthority("owner", lease =>
    ({workspaceId: "owner", rootPath: lease.binding.canonicalRootPath, attachmentId: lease.binding.attachmentId}));
  return {f, credentials, binding: bindingOf("notes/plan.md", "object"), workspace};
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A refused queue read with its checkpoint: the server accepted the first edit, then refused the one that builds on it. */
// `accepted` is a recipient's accepted edit the checkpoint holds.
function recoveryQueue(binding: LiveObjectBinding, accepted?: string, pending?: string) {
  const doc = new Y.Doc(); doc.getMap("frontmatter").set("title", "Plan");
  const baseUpdate = Y.encodeStateAsUpdate(doc);
  doc.getMap("frontmatter").set("status", "accepted");
  if (accepted !== undefined) doc.getMap("frontmatter").set("note", accepted);
  const checkpoint = Y.encodeStateAsUpdate(doc), before = Y.encodeStateVector(doc);
  doc.getMap("frontmatter").set("status", "kept");
  if (pending !== undefined) doc.getMap("frontmatter").set("note", pending);
  const update = Y.encodeStateAsUpdate(doc, before); doc.destroy();
  return {update, queue: {outboxId: "outbox", binding, baseUpdate, baseUpdateDigest: digest(baseUpdate), checkpoint, checkpointDigest: digest(checkpoint), state: "quarantined" as const,
    pendingBytes: update.byteLength, oldestEntryAtMs: 1, quarantineReason: "capacity-refused", observedBinding: null, retryDeliveryId: null,
    entries: [{sequence: 2, appendKey: "append", deliveryId: "delivery", updateDigest: digest(update), update, byteLength: update.byteLength, createdAtMs: 1}]}};
}
/**
 * Serves a refused queue as the server's engine pages it, a few bytes per
 * page, so a read follows every cursor through every part. A cursor from
 * another snapshot reads as changed.
 */
function servedPages(queue: OwnerYDocOutboxRecovery, chunk = 3) {
  const snapshot = digest(Buffer.from(`snapshot:${queue.outboxId}`));
  const cursor = (part: string, sequence = 0, offset = 0) => ({snapshot, part, sequence, offset});
  const first = queue.entries[0];
  const header = {outboxId: queue.outboxId, binding: queue.binding, baseUpdateDigest: queue.baseUpdateDigest, baseByteLength: queue.baseUpdate.byteLength,
    state: queue.state, pendingBytes: queue.pendingBytes, pendingEntryCount: queue.entries.length, nextSequence: (queue.entries.at(-1)?.sequence ?? 0) + 1,
    oldestEntryAtMs: queue.oldestEntryAtMs, quarantineReason: queue.quarantineReason, observedBinding: queue.observedBinding, retryDeliveryId: queue.retryDeliveryId,
    firstEntryCursor: first ? cursor("entryHeader", first.sequence) : null, checkpointDigest: queue.checkpoint ? digest(queue.checkpoint) : null,
    frozenAtRefusedSeed: false, recoveryCheckpointDigest: null};
  const parts = new Map<string, {bytes: Uint8Array; next: ReturnType<typeof cursor> | null}>([
    ["header:0", {bytes: Buffer.from(JSON.stringify(header)), next: cursor("base")}], ["base:0", {bytes: queue.baseUpdate, next: header.firstEntryCursor}]]);
  queue.entries.forEach(({update, ...entry}, index) => {
    const following = queue.entries[index + 1];
    parts.set(`entryHeader:${entry.sequence}`, {bytes: Buffer.from(JSON.stringify(entry)), next: cursor("update", entry.sequence)});
    parts.set(`update:${entry.sequence}`, {bytes: update, next: following ? cursor("entryHeader", following.sequence) : null});
  });
  if (queue.checkpoint) parts.set("checkpoint:0", {bytes: queue.checkpoint, next: null});
  return (requested: JsonValue | undefined) => {
    const at = (requested as ReturnType<typeof cursor> | undefined) ?? cursor("header");
    if (at.snapshot !== snapshot) return {kind: "readChanged"};
    const part = parts.get(`${at.part}:${at.sequence}`)!, bytes = part.bytes.subarray(at.offset, at.offset + chunk), end = at.offset + bytes.byteLength;
    return {kind: "page", ...at, totalBytes: part.bytes.byteLength, digest: digest(part.bytes), bytesBase64: Buffer.from(bytes).toString("base64"),
      nextCursor: end < part.bytes.byteLength ? cursor(at.part, at.sequence, end) : part.next};
  };
}
const keptBinding = {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "notes/plan.md", selectorPaths: ["notes/plan.md"], restoreFenceGeneration: 1};
const releasedStop = {binding: keptBinding, document: {mainVersionId: "main", objectId: "object", currentPath: "notes/plan.md"},
  relayDatabaseNamespace: "namespace", retirementOwed: false, state: "released"};
/** A release as the engine answers it: its Stop names the kept edits the request named. */
const releaseAnswer = (materialized: boolean) => (request: Request): Response => {
  const {keptSnapshot} = request.params as {keptSnapshot?: string};
  return {id: request.id, result: {stops: [{...releasedStop, ...(keptSnapshot === undefined ? {} : {keptSnapshot}), materialized}]}};
};
const releaseConflict = (request: Request): Response => {
  throw new EngineRequestError(request.id, {code: "INVALID_PARAMS", message: "owner-stop-conflict", retry: "no"});
};
const stopMethods = (methods: string[]) => methods.filter(method => method.startsWith("ydoc.ownerStop.") && method !== "ydoc.ownerStop.list");
// The engine lists a Stop only while it waits, owes the server a retirement, or deferred its release.
const listedStop = (stop: {state: string; retirementOwed: boolean; deferred?: unknown}) => stop.state === "requested" || stop.retirementOwed || stop.deferred !== undefined;
/** The refused queue a restore can repeat with fewer edits: its binding and head stay, its second edit goes. */
function twoEditQueue(binding: LiveObjectBinding) {
  const {queue, update} = recoveryQueue(binding);
  const doc = new Y.Doc(); Y.applyUpdate(doc, queue.checkpoint); Y.applyUpdate(doc, update);
  const before = Y.encodeStateVector(doc); doc.getMap("frontmatter").set("reviewer", "kept too");
  const second = Y.encodeStateAsUpdate(doc, before); doc.destroy();
  return {first: queue, both: {...queue, pendingBytes: queue.pendingBytes + second.byteLength, entries: [...queue.entries,
    {sequence: 3, appendKey: "append-2", deliveryId: "delivery-2", updateDigest: digest(second), update: second, byteLength: second.byteLength, createdAtMs: 2}]}};
}
/**
 * A Stop's record of refused edits it could not write, from queue "outbox"
 * at head "delivery", with its stored package, in a real file. The engine's
 * reader is stood in for as it lists them: hidden only behind that queue
 * while it holds the same edits. Each launch is a new desktop process on the
 * same records.
 */
async function keptRelease(path = "notes/plan.md", stored: ReturnType<typeof recoveryQueue>["queue"] = recoveryQueue(keptBinding).queue) {
  const rootPath = await createTestScratch("dohc-unwritten-");
  const file = join(await createTestScratch("dohc-unwritten-state-"), "owner-live-releases.json");
  const {liveRecoveryPackage} = await import("./ownerLiveRecoveryCopy");
  await createUnwrittenReleases(() => file).put({workspaceId: "owner", objectId: "object", path, reason: "invalid-update", binding: keptBinding, headDeliveryId: "delivery",
    snapshot: recoverySnapshot(stored), retry: true}, JSON.stringify(liveRecoveryPackage(stored, {path, reason: "invalid-update", storedOn: "this-computer"})));
  const engine = {queues: [] as OwnerLiveQuarantineRecord[], snapshots: new Map<string, string>(), stops: [] as (typeof releasedStop)[],
    release: releaseConflict as (request: Request) => Response};
  quarantineMock.read.mockImplementation(async (_client, _handle, options?: {unwritten?: UnwrittenRelease[]}) => [...engine.queues,
    ...(options?.unwritten ?? []).filter(release => !engine.queues.some(row => row.objectId === release.objectId && row.headDeliveryId === release.headDeliveryId &&
      row.outboxId !== null && engine.snapshots.get(row.outboxId) === release.snapshot))
      .map(release => ({objectId: release.objectId, path: release.path, reason: release.reason, outboxId: null, binding: release.binding,
        headDeliveryId: release.headDeliveryId, recovery: release.retry ? "not-written" : "cannot-write"}))]);
  const launch = async () => {
    const f = fixture({ownerLiveReleases: createUnwrittenReleases(() => file)});
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const methods: string[] = [];
    f.client.respond = async request => {
      methods.push(request.method);
      // As the engine resolves it: a document names its own Stop; a path every Stop that had it, and two refuse.
      if (request.method === "ydoc.ownerStop.clear") {
        const {path, document} = request.params as {path?: string; document?: {objectId: string}};
        const cleared = engine.stops.filter(stop => document ? stop.document.objectId === document.objectId
          : stop.document.currentPath === path || stop.binding.currentPath === path);
        if (cleared.length > 1) throw new EngineRequestError(request.id, {code: "INVALID_PARAMS", message: "owner-stop-conflict", retry: "no"});
        engine.stops = engine.stops.filter(stop => !cleared.includes(stop));
        return {id: request.id, result: {stops: cleared}};
      }
      if (request.method === "ydoc.ownerStop.release") return engine.release(request);
      return {id: request.id, result: request.method === "workspace.open" ? {workspace: "workspace-handle"} : request.method === "ydoc.ownerStop.list" ? {stops: engine.stops.filter(listedStop)}
        : request.method === "workspace.close" ? {closed: true} : request.method === "engine.ping" ? {ok: true} : null};
    };
    await f.engine.start();
    const workspace = {workspaceId: "owner", rootPath};
    await f.engine.sessions!.run(workspace, async () => undefined);
    await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).not.toEqual([]));
    return {f, workspace, methods};
  };
  const records = () => createUnwrittenReleases(() => file);
  const packageFile = join(dirname(file), `owner-live-recovery-${createHash("sha256").update("owner\0object").digest("hex")}.dohc-recovery.json`);
  return {engine, launch, records, rootPath, packageFile};
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("desktop engine construction", () => {
  it("derives reader paths from main's resources base when getAppPath points at dist/main", async () => {
    const f = fixture(), resources = await createTestScratch("reader-resources-");
    const generation = "a".repeat(64);
    mkdirSync(resolve(resources, "engine-reader"));
    writeFileSync(resolve(resources, "engine-reader/selection.json"), JSON.stringify({ generation }));
    f.dependencies.resourcesBasePath = () => resources;
    vi.mocked(f.dependencies.app.getAppPath).mockReturnValue(resolve("unrelated/dist/main"));
    try {
      await f.engine.start();
      const config = JSON.parse(f.options().readerConfig!);
      expect(config.bundle).toBe(resolve(resources, "engine-reader", generation, "reader.cjs"));
      expect(config.manifest).toBe(resolve(resources, "engine-reader", generation, "manifest.json"));
    } finally { await f.close(); }
  });
  it("notifies after a workspace binding opens, including reopening", async () => {
    const f = fixture();
    const opened = vi.fn();
    f.dependencies.onWorkspaceOpened = opened;
    const workspace = { workspaceId: "notice-test-workspace", rootPath: await createTestScratch("notice-open-") };
    try {
      await f.engine.start();
      expect(opened).not.toHaveBeenCalled();
      const sessions = f.engine.sessions!;
      await sessions.run(workspace, async () => undefined);
      expect(opened).toHaveBeenCalledExactlyOnceWith("notice-test-workspace");
      await sessions.run(workspace, async () => undefined);
      expect(opened).toHaveBeenCalledTimes(1);
      await sessions.closeWorkspace(workspace);
      await sessions.run(workspace, async () => undefined);
      expect(opened).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });
  it("lets writers into .dohc/local only while the open that prepared it stands", async () => {
    const f = fixture();
    const workspace = { workspaceId: "local-state-workspace", rootPath: await createTestScratch("local-state-open-") };
    mkdirSync(resolve(workspace.rootPath, ".dohc", "local"), { recursive: true });
    let localStateReady = true;
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async request => request.method === "workspace.open" && workspaceIdOf(request) === workspace.workspaceId
      ? { id: request.id, result: { workspace: "local-state-handle", localStateReady } } : originalSend(request);
    try {
      await f.engine.start();
      const sessions = f.engine.sessions!;
      await expect(localStateDir(workspace)).rejects.toThrow("dohc has not finished opening this workspace.");
      await sessions.run(workspace, async () => undefined);
      await expect(localStateDir(workspace)).resolves.toMatch(/local$/);
      await sessions.closeWorkspace(workspace);
      await expect(localStateDir(workspace)).rejects.toThrow("dohc has not finished opening this workspace.");
      localStateReady = false;
      await sessions.run(workspace, async () => undefined);
      await expect(localStateDir(workspace)).rejects.toThrow("out of iCloud Drive");
    } finally { await f.close(); }
  });

  const remote = { serverUrl: "https://server.test", ownerUserId: "owner" };
  it.each<[string, Partial<RegistryEntry>, boolean]>([
    ["a saved pause", { pausedRemote: remote }, true],
    ["a folder reopened as local work", {}, true],
    ["ordinary sync with no session", { remote }, false],
    ["a join still bootstrapping", { joinBootstrapPending: true }, false],
    ["a received share", { shareView: { shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: ["docs"], versionId: null, access: "view" } } }, false],
  ])("owner opens with %s ask to abandon an unfinished pull: %s", async (_case, entry, abandons) => {
    const f = fixture();
    const workspace = { workspaceId: "local-only", rootPath: await createTestScratch("abandon-open-") };
    f.rows.set(workspace.workspaceId, { ...workspace, kind: "personal", mode: "local-first", ...entry });
    try {
      await f.engine.start();
      const sessions = f.engine.sessions!;
      await sessions.run(workspace, async () => undefined);
      await sessions.closeWorkspace(workspace);
      // A capture-free open is temporary and never asks.
      await sessions.run({ ...workspace, captureMode: "none" }, async () => undefined);
      const opens = f.client.requests
        .filter(request => request.method === "workspace.open" && workspaceIdOf(request) === "local-only")
        .map(request => request.params);
      expect(opens).toHaveLength(2);
      if (abandons) expect(opens[0]).toMatchObject({ abandonOrdinaryPull: true });
      else expect(opens[0]).not.toHaveProperty("abandonOrdinaryPull");
      expect(opens[1]).not.toHaveProperty("abandonOrdinaryPull");
    } finally { await f.close(); }
  });

  it.each(["opens a workspace", "settles idle"] as const)("runs the startup smoke only when the launch %s", async (launch) => {
    const f = fixture();
    const workspace = { workspaceId: "smoke-gate-workspace", rootPath: await createTestScratch("smoke-gate-") };
    try {
      await f.engine.start();
      if (launch === "opens a workspace") await f.engine.sessions!.run(workspace, async () => undefined);
      f.engine.launchSettled();
      await expect(f.options().startupSmoke).resolves.toBe(launch === "settles idle" ? "run" : "skip");
      if (launch === "settles idle") await f.client.smokeClosed.promise;
    } finally { await f.close(); }
  });

  it("passes account changes to relay-session cleanup", async () => {
    const f = fixture();
    try {
      expect(await f.engine.start()).toBe(true);
      const close = vi.spyOn(f.engine.relayClient!, "closeAll").mockResolvedValue(undefined);
      await f.engine.closeAllRelayTransportWorkspaces({ accountChanged: true });
      expect(close).toHaveBeenCalledWith({ accountChanged: true });
    } finally {
      await f.close();
    }
  });

  it.each(["forgotten", "paused"])("discovers remaining configured owners after another workspace is %s", async mode => {
    const f = fixture();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    for (const workspaceId of ["first","second"]) {
      const rootPath = await createTestScratch(`dohc-owner-workspace-close-${workspaceId}-`);
      f.rows.set(workspaceId,{workspaceId,rootPath,kind:"personal",mode:"local-first"});
    }
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
    f.dependencies.existingOwnerFor = vi.fn(() => {throw new Error("No editor in this discovery test.");});
    ownerHostMock.read.mockReturnValue({nativeConfigPath:"native-config",workspaceIds:["first","second"],transport:{aggregateBytes:1024,maxUploads:1}});
    ownerHostMock.start.mockImplementation(() => ({stop:vi.fn()}));
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async request => request.method === "workspace.open" && ["first","second"].includes(String(workspaceIdOf(request)))
      ? {id:request.id,result:{workspace:`handle-${workspaceIdOf(request)}`}} : originalSend(request);
    try {
      expect(f.authorities.workspaceIds()).toEqual([]);
      expect(await f.engine.start()).toBe(true);
      const discover = ownerHostMock.start.mock.calls.at(-1)![0].bindings;
      expect((await discover()).workspaces).toHaveLength(2);
      if (mode === "forgotten") {
        await f.authorities.invalidate("first"); f.rows.delete("first");
      } else {
        await f.engine.withOwnerHostPaused(async () => {
          f.rows.set("first", { ...f.rows.get("first")!, pausedRemote: { serverUrl: "https://server.test", ownerUserId: "owner" } });
        });
      }
      const remaining = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(remaining.workspaces).toEqual([{workspaceId:"second",workspaceHandle:"handle-second"}]);
      expect(() => remaining.assertCurrent()).not.toThrow();
      if (mode === "paused") {
        await f.engine.withOwnerHostPaused(async () => {
          const resumed = { ...f.rows.get("first")! };
          delete resumed.pausedRemote;
          f.rows.set("first", resumed);
        });
        expect((await ownerHostMock.start.mock.calls.at(-1)![0].bindings()).workspaces).toHaveLength(2);
        await f.authorities.invalidate("first"); f.rows.delete("first");
      }
      await f.authorities.invalidate("second"); f.rows.delete("second");
      await expect(ownerHostMock.start.mock.calls.at(-1)![0].bindings()).rejects.toThrow("Owner host has no registered workspaces.");
    } finally {await f.close(); ownerHostMock.read.mockReset(); ownerHostMock.start.mockReset();}
  });

  it.each(["closed", "reopened"])("rejects discovered owner handles after a capture directly closes its %s session", async mode => {
    const f = fixture();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-owner-capture-close-");
    f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
    f.dependencies.existingOwnerFor = vi.fn(() => { throw new Error("No editor in this discovery test."); });
    ownerHostMock.read.mockReturnValue({ nativeConfigPath: "native-config", workspaceIds: ["owner"], transport: { aggregateBytes: 1024, maxUploads: 1 } });
    ownerHostMock.start.mockImplementation(() => ({ stop: vi.fn() }));
    let handles = 0;
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async input => input.method === "workspace.open" && workspaceIdOf(input) === "owner"
      ? { id: input.id, result: { workspace: `owner-${++handles}` } } : originalSend(input);
    try {
      expect(await f.engine.start()).toBe(true);
      const lease = f.authorities.acquire("owner");
      const workspace = { workspaceId: "owner", rootPath, attachmentId: lease.binding.attachmentId };
      lease.release();
      const discover = ownerHostMock.start.mock.calls.at(-1)![0].bindings;
      const captured = await discover();
      expect(() => captured.assertCurrent()).not.toThrow();
      // Temporary dispatch capture closes its store after the paused relay close.
      await f.engine.sessions!.closeWorkspace(workspace);
      if (mode === "reopened") await f.engine.sessions!.run(workspace, async () => undefined);
      expect(() => captured.assertCurrent()).toThrow();
      const current = await discover();
      expect(current.client).toBe(captured.client);
      expect(current.workspaces[0].workspaceHandle).not.toBe(captured.workspaces[0].workspaceHandle);
      expect(() => current.assertCurrent()).not.toThrow();
      expect(() => captured.assertCurrent()).toThrow();
    } finally { await f.close(); ownerHostMock.read.mockReset(); ownerHostMock.start.mockReset(); }
  });

  it.each(["initial", "credential", "cloud", "rejecting-close", "quitting"])("retires discovered owner bindings before the first relay request after %s rebind", async mode => {
    const f = fixture();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-owner-relay-rebind-");
    f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
    f.dependencies.existingOwnerFor = vi.fn(() => { throw new Error("No editor in this discovery test."); });
    ownerHostMock.read.mockReturnValue({ nativeConfigPath: "native-config", workspaceIds: ["owner"], transport: { aggregateBytes: 1024, maxUploads: 1 } });
    const stops: ReturnType<typeof vi.fn>[] = [];
    ownerHostMock.start.mockImplementation(() => { const stop = vi.fn(); stops.push(stop); return { stop }; });
    let handles = 0, blockedHandle: string | undefined;
    let request: Promise<unknown> | undefined;
    const closing = deferred(), closeEntered = deferred();
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async input => {
      if (input.method === "workspace.open" && workspaceIdOf(input) === "owner") {
        f.client.requests.push(input);
        return { id: input.id, result: { workspace: `owner-${++handles}` } };
      }
      if (input.method === "workspace.close" && input.workspace === blockedHandle) {
        closeEntered.resolve(); await closing.promise;
        if (mode === "rejecting-close") throw new Error("injected binding close failure");
      }
      if (input.method === "sync.probe") { f.client.requests.push(input); return { id: input.id, result: { hasContent: true } }; }
      return originalSend(input);
    };
    try {
      expect(await f.engine.start()).toBe(true);
      const lease = f.authorities.acquire("owner");
      const workspace = { workspaceId: "owner", rootPath, attachmentId: lease.binding.attachmentId };
      lease.release();
      let relay = f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "first-token" } });
      const rotated = mode === "credential" || mode === "cloud";
      if (rotated) await relay.probe();
      if (mode === "cloud") await f.engine.closeAllRelayTransportWorkspaces();
      if (rotated) relay = f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "second-token" } });
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
      expect(f.client.requests.filter(row => row.method === "sync.probe").at(-1)?.workspace).toBe(current.workspaces[0].workspaceHandle);
      const opened = f.client.requests.filter(row => row.method === "workspace.open" && workspaceIdOf(row) === "owner").at(-1)!;
      expect(opened.params).toMatchObject({ relay: { bearerToken: rotated ? "second-token" : "first-token" } });
      const starts = ownerHostMock.start.mock.calls.length;
      await relay.probe();
      expect(ownerHostMock.start).toHaveBeenCalledTimes(starts);
    } finally {
      closing.resolve(); await request?.catch(() => undefined); await f.close(); ownerHostMock.read.mockReset(); ownerHostMock.start.mockReset();
    }
  });

  it.each(["workspace", "cloud", "overlapping-cloud", "shutdown"])("retires owner discovery during %s close and resumes only while running", async mode => {
    const f = fixture();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-owner-host-rotation-");
    f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
    f.dependencies.existingOwnerFor = vi.fn(() => { throw new Error("No editor in this discovery test."); });
    const stopped: ReturnType<typeof vi.fn>[] = [];
    ownerHostMock.read.mockReturnValue({ nativeConfigPath: "native-config", workspaceIds: ["owner"], transport: { aggregateBytes: 1024, maxUploads: 1 } });
    ownerHostMock.start.mockImplementation(() => { const stop = vi.fn(); stopped.push(stop); return { stop }; });
    let handles = 0;
    const closing = deferred(), closeEntered = deferred();
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async request => {
      if (request.method === "workspace.open" && workspaceIdOf(request) === "owner") return { id: request.id, result: { workspace: `owner-${++handles}` } };
      if (request.method === "workspace.close" && request.workspace === "owner-1") { closeEntered.resolve(); await closing.promise; }
      return originalSend(request);
    };
    try {
      expect(await f.engine.start()).toBe(true);
      const lease = f.authorities.acquire("owner");
      const workspace = { workspaceId: "owner", rootPath, attachmentId: lease.binding.attachmentId };
      lease.release();
      f.engine.relayClient!.bind({...workspace, relay: {baseUrl: "https://relay.test", token: "first-token"}});
      const first = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(first.workspaces).toEqual([{ workspaceId: "owner", workspaceHandle: "owner-1" }]);
      const close = mode === "cloud" ? f.engine.closeAllRelayTransportWorkspaces() : f.engine.closeRelayTransportWorkspace(workspace);
      await closeEntered.promise;
      expect(stopped[0]).toHaveBeenCalledOnce();
      expect(() => first.assertCurrent()).toThrow("This live editing session ended.");
      if (mode === "shutdown") f.setQuitting(true);
      const shutdownDone = mode === "shutdown" || mode === "overlapping-cloud" ? f.engine.closeAllRelayTransportWorkspaces() : Promise.resolve();
      f.options().onLaunch?.();
      expect(ownerHostMock.start).toHaveBeenCalledTimes(1);
      closing.resolve(); await close; await shutdownDone;
      expect(ownerHostMock.start).toHaveBeenCalledTimes(mode === "shutdown" ? 1 : 2);
      if (mode === "shutdown") {
        f.options().onLaunch?.();
        expect(ownerHostMock.start).toHaveBeenCalledTimes(1);
        return;
      }
      f.engine.relayClient!.bind({...workspace, relay: {baseUrl: "https://relay.test", token: "second-token"}});
      const next = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(next.workspaces).toEqual([{ workspaceId: "owner", workspaceHandle: "owner-2" }]);
      expect(() => next.assertCurrent()).not.toThrow();
      expect(next.client).toBe(first.client);
      await f.engine.closeAllRelayTransportWorkspaces();
      expect(() => next.assertCurrent()).toThrow("This live editing session ended.");
      const reopened = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(reopened.workspaces).toEqual([{ workspaceId: "owner", workspaceHandle: "owner-3" }]);
      expect(() => reopened.assertCurrent()).not.toThrow();
    } finally {
      closing.resolve(); await f.close(); ownerHostMock.read.mockReset(); ownerHostMock.start.mockReset();
    }
  });

  it("creates no daemon until start and publishes sessions only after the held handshake", async () => {
    const f = fixture(); const held = deferred(); const entered = deferred();
    f.setLaunch(async () => { entered.resolve(); await held.promise; return f.client; });
    expect(await f.engine.startup).toBe(false);
    expect(f.dependencies.createRustEngineDaemon).not.toHaveBeenCalled();
    expect(f.engine.daemon).toBeNull();
    expect(() => f.engine.requireEngineSessions()).toThrow("sessions are unavailable");
    const started = f.engine.start();
    try {
      await entered.promise;
      expect(f.engine.startup).toBe(started);
      expect(f.engine.daemon).toBe(f.daemons[0]);
      expect(f.engine.sessions).toBeNull(); expect(f.engine.relayClient).toBeNull();
      expect(f.dependencies.launchMarks.daemonReady).not.toHaveBeenCalled();
      held.resolve();
      expect(await started).toBe(true);
      expect(f.engine.sessions).toBeInstanceOf(EngineWorkspaceSessions);
      expect(f.engine.requireEngineSessions()).toBe(f.engine.sessions);
      expect(f.engine.relayClient).toBeInstanceOf(EngineRelayClient);
      expect(f.dependencies.defaultEngineBinaryPath).toHaveBeenCalledWith({
        isPackaged: false, appPath: "app-root", resourcesPath: "resources",
      });
      expect(f.dependencies.launchMarks.daemonReady).toHaveBeenCalledOnce();
      expect(f.dependencies.desktopMarks.markOnce).toHaveBeenCalledWith("daemon-ready");
      expect(f.dependencies.logLaunchMarksOnce).toHaveBeenCalledOnce();
    } finally { held.resolve(); await started; await f.close(); }
  });

  it.each([
    [{ DOHC_DESKTOP_TEST: "1", DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "1234" }, false, 1234],
    [{ DOHC_DESKTOP_TEST: "1", DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "1234" }, true, undefined],
    [{ DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "1234" }, false, undefined],
    [{ DOHC_DESKTOP_TEST: "1", DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "0" }, false, undefined],
    [{ DOHC_DESKTOP_TEST: "1", DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "Infinity" }, false, undefined],
  ] as const)("reads test restart overrides at start for %j, packaged %s", async (env, packaged, backoff) => {
    const f = fixture();
    Object.assign(f.dependencies.process.env, env); Object.assign(f.dependencies.app, { isPackaged: packaged });
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().initialBackoffMs).toBe(backoff);
      expect(f.options().maxBackoffMs).toBe(backoff);
    } finally { await f.close(); }
  });

  it("contains binary path failure, and shows the startup dialog", async () => {
    const f = fixture(); const error = new Error("binary path failed");
    f.dependencies.defaultEngineBinaryPath = () => { throw error; };
    const engine = createDesktopEngine(f.dependencies);
    try {
      expect(await engine.start()).toBe(false);
      expect(f.dependencies.createRustEngineDaemon).not.toHaveBeenCalled();
      expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("Rust engine failed to start",
        "binary path failed\n\nThe desktop cannot start without the Rust engine.");
      expect(f.dependencies.recordEngineProblem).toHaveBeenCalledWith(error, "startup");
      expect(engine.daemon).toBeNull(); expect(engine.sessions).toBeNull(); expect(engine.relayClient).toBeNull();
    } finally { await f.close(); }
  });

  it("waits for failed-start stop before clearing constructed handles and reporting the failure", async () => {
    const f = fixture(); const held = deferred();
    f.client.exitWait = held.promise;
    const error = new Error("marks failed");
    f.dependencies.launchMarks.daemonReady = () => { throw error; };
    let settled = false;
    const started = f.engine.start();
    void started.then(() => { settled = true; });
    try {
      await f.client.closed.promise;
      expect(f.engine.daemon).toBe(f.daemons[0]);
      expect(f.engine.sessions).toBeInstanceOf(EngineWorkspaceSessions);
      expect(f.engine.relayClient).toBeInstanceOf(EngineRelayClient);
      expect(settled).toBe(false);
      held.resolve();
      expect(await started).toBe(false);
      expect(f.engine.daemon).toBeNull(); expect(f.engine.sessions).toBeNull(); expect(f.engine.relayClient).toBeNull();
    } finally { held.resolve(); await started; await f.close(); }
  });

  it("contains stop rejection on failed start and still reports the failure", async () => {
    const f = fixture(); const stopError = new Error("stop failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.dependencies.launchMarks.daemonReady = () => { throw "non-error startup failure"; };
    const engine = f.engine;
    f.setDaemon((daemon) => { vi.spyOn(daemon, "stop").mockRejectedValueOnce(stopError); });
    try {
      expect(await engine.start()).toBe(false);
      expect(logged).toHaveBeenCalledWith("[desktop] Rust engine daemon stop after failed start:", stopError);
      expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("Rust engine failed to start",
        "Unknown Rust engine startup error.\n\nThe desktop cannot start without the Rust engine.");
      expect(engine.daemon).toBeNull();
    } finally {
      await f.close();
    }
  });
});

describe("desktop engine restart coordination", () => {
  it("pauses Collection automations before publication and resumes them after launch", async () => {
    const f = fixture();
    await f.addWorkspace("workspace");
    const collection = f.states.get("workspace")!.collectionAutomations;
    collection.pauseForEngineRestart.mockImplementation(() => {
      expect(f.engine.sessions).toBeNull();
      expect(collection.resumeAfterEngineRestart).not.toHaveBeenCalled();
    });
    try {
      expect(await f.engine.start()).toBe(true);
      expect(collection.pauseForEngineRestart).toHaveBeenCalledOnce();
      expect(collection.resumeAfterEngineRestart).toHaveBeenCalledOnce();
      expect(f.engine.daemon!.currentClient()).toBe(f.client);
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith();
    } finally { await f.close(); }
  });

  it("refreshes Notices when local Markdown recovery changes its held obligations", async () => {
    const f = fixture();
    const changed = vi.fn();
    f.dependencies.onRefusalsChanged = changed;
    try {
      await f.engine.start();
      f.client.emit("sync.refusalsChanged", {workspaceId: "workspace"});
      expect(changed).toHaveBeenCalledOnce();
      f.client.emit("ydoc.remoteUpdate", {sessionId: "editor", resyncRequired: true});
      expect(changed).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("keeps the composed session and relay owners through a real daemon restart", async () => {
    const f = fixture(); const relaunched = deferred();
    await f.addWorkspace("workspace");
    try {
      await f.engine.start(); f.engine.launchSettled(); await f.client.smokeClosed.promise;
      const sessions = f.engine.sessions; const relay = f.engine.relayClient; const daemon = f.engine.daemon;
      const replacement = new Client();
      f.setLaunch(async () => replacement);
      vi.mocked(f.dependencies.notifyRenderer).mockImplementation(() => { relaunched.resolve(); });
      f.spawns[0]!.onExit!(1, null);
      await relaunched.promise;
      expect(f.engine.daemon).toBe(daemon);
      expect(daemon!.currentClient()).toBe(replacement);
      expect(f.engine.sessions).toBe(sessions); expect(f.engine.relayClient).toBe(relay);
      expect(f.dependencies.launchMarks.daemonReady).toHaveBeenCalledOnce();
      // The Collection executor paused before each daemon was published and
      // resumed once it answered: at the first start and at the restart.
      const collection = f.states.get("workspace")!.collectionAutomations;
      expect(collection.pauseForEngineRestart).toHaveBeenCalledTimes(2);
      expect(collection.resumeAfterEngineRestart).toHaveBeenCalledTimes(2);
      replacement.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      expect(collection.notifyClaimed).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("waits for the startup smoke cap after progress stalls before reporting an engine failure", async () => {
    const f = fixture();
    const opened = deferred();
    const cancel = vi.fn(async (_requestId: number) => {});
    let openId!: number;
    const client: EngineDaemonClient = {
      reportsProgress: () => true,
      async sendRequest(request, _signal, onProgress, cancelSignal) {
        if (request.method === "workspace.open" && String(workspaceIdOf(request)).startsWith("desktop-startup-smoke-")) {
          openId = request.id;
          cancelSignal?.addEventListener("abort", () => {void cancel(request.id);}, {once: true});
          onProgress?.();
          opened.resolve();
          return await new Promise<Response>(() => {});
        }
        return await f.client.sendRequest(request);
      },
      onEvent: handler => f.client.onEvent(handler),
      close: () => f.client.close(),
      waitForExit: () => f.client.waitForExit(),
    };
    const close = vi.spyOn(client, "close");
    f.setLaunch(async () => client);
    try {
      vi.useFakeTimers();
      await f.engine.start();
      f.engine.launchSettled();
      await opened.promise;
      await vi.advanceTimersByTimeAsync(11_000);
      expect(cancel).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(f.engine.daemon!.currentClient()).toBe(client);
      expect(f.dependencies.recordEngineProblem).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(109_010);
      await vi.waitFor(() => expect(f.dependencies.recordEngineProblem).toHaveBeenCalled(), { timeout: 15_000 });
      expect(cancel).toHaveBeenCalledWith(openId);
      expect(close).toHaveBeenCalledOnce();
      expect(f.dependencies.recordEngineProblem).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "Rust engine workspace.open timed out after 120000ms." }), "restarting",
      );
      expect(f.dependencies.dialog.showErrorBox).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("records one crash problem per engine crash, then the final verdict", async () => {
    const f = fixture();
    const exit = new Error("exited"); const attempt = new Error("attempt failed"); const verdict = new Error("limit");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await f.engine.start();
      const record = vi.mocked(f.dependencies.recordEngineProblem);
      f.options().onFailure!(exit, false);
      f.options().onFailure!(attempt, false);
      f.options().onFailure!(attempt, false);
      f.options().onFailure!(verdict, true);
      expect(record.mock.calls).toEqual([[exit, "restarting"], [verdict, "stopped"]]);
      // A launch ends the crash, so the next failure is a new problem.
      f.options().onLaunch!();
      f.options().onFailure!(exit, false);
      expect(record).toHaveBeenCalledTimes(3);
      expect(record).toHaveBeenLastCalledWith(exit, "restarting");
    } finally { await f.close(); }
  });

  it("reads quitting state on terminal failure", async () => {
    const f = fixture();
    const error = new Error("terminal failure");
    try {
      await f.engine.start();
      f.options().onFailure!(error, true);
      expect(f.dependencies.recordEngineProblem).toHaveBeenCalledWith(error, "stopped");
      expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("The workspace engine stopped",
        "dohc stopped restarting the workspace engine.\n\nRestart dohc. If this happens again, review the desktop logs. If it continues, reinstall dohc.");
      vi.mocked(f.dependencies.dialog.showErrorBox).mockClear();
      f.options().onFailure!(error, false);
      expect(f.dependencies.recordEngineProblem).toHaveBeenLastCalledWith(error, "restarting");
      f.setQuitting(true);
      f.options().onFailure!(error, true);
      // A failure while dohc quits is the quit, not a crash.
      expect(f.dependencies.recordEngineProblem).toHaveBeenCalledTimes(2);
      expect(f.dependencies.dialog.showErrorBox).not.toHaveBeenCalled();
      expect(f.engine.sessions).not.toBeNull();
    } finally { await f.close(); }
  });
});

describe("desktop engine composed sessions and events", () => {
  it("uses the 120 second workspace open deadline and the same relay route owner", async () => {
    const f = fixture();
    const workspace = { workspaceId: "workspace", rootPath: await createTestScratch("dohc-desktop-engine-") };
    try {
      await f.engine.start();
      f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "token" } });
      await f.engine.sessions!.run(workspace, async () => undefined);
      const request = f.client.requests.find((item) => item.method === "workspace.open" && workspaceIdOf(item) === "workspace");
      expect(request).toMatchObject({ deadlineMs: 120_000, params: {
        workspaceId: "workspace", relay: { baseUrl: "https://relay.test", bearerToken: "token" },
      } });
      expect(() => f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).toThrow("different relay origin");
      await f.engine.closeRelayTransportWorkspace(workspace);
      expect(() => f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).not.toThrow();
    } finally { await f.close(); }
  });

  it.each(["workspace", "all"])("releases %s routes after failed startup cleared the client", async (scope) => {
    const f = fixture();
    let retiredRelay!: EngineRelayClient;
    const workspace = { workspaceId: "workspace", rootPath: resolve("workspace") };
    f.dependencies.launchMarks.daemonReady = () => {
      retiredRelay = f.engine.relayClient!;
      retiredRelay.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "token" } });
      throw new Error("startup failed after relay construction");
    };
    try {
      expect(await f.engine.start()).toBe(false);
      expect(f.engine.relayClient).toBeNull();
      expect(() => retiredRelay.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).toThrow("different relay origin");
      if (scope === "workspace") await f.engine.closeRelayTransportWorkspace("workspace");
      else await f.engine.closeAllRelayTransportWorkspaces();
      expect(() => retiredRelay.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).not.toThrow();
    } finally { await f.close(); }
  });

  it("waits for actual session closure before releasing a relay origin", async () => {
    const f = fixture(); const held = deferred(); const entered = deferred();
    const workspace = { workspaceId: "workspace", rootPath: await createTestScratch("dohc-desktop-engine-") };
    let closing: Promise<void> | undefined;
    try {
      await f.engine.start(); f.engine.launchSettled(); await f.client.smokeClosed.promise;
      f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "token" } });
      await f.engine.sessions!.run(workspace, async () => undefined);
      f.client.respond = async (request) => {
        if (request.method === "workspace.close" && request.workspace === "workspace-handle") { entered.resolve(); await held.promise; }
        return { id: request.id, result: request.method === "workspace.close" ? { closed: true } : null };
      };
      closing = f.engine.closeRelayTransportWorkspace(workspace);
      await entered.promise;
      expect(() => f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).toThrow("different relay origin");
      held.resolve(); await closing;
      expect(() => f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).not.toThrow();
    } finally { held.resolve(); await closing; await f.close(); }
  });

  it("routes automation events to the current workspace, and Collection projections and a finished first read to the renderer", async () => {
    const f = fixture(); await f.addWorkspace("workspace");
    try {
      await f.engine.start();
      const collection = f.states.get("workspace")!.collectionAutomations;
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "failed" });
      expect(collection.notifyClaimed).toHaveBeenCalledOnce();
      f.client.emit("capture.noAtomicPlacement", { workspaceId: "workspace" });
      expect(f.dependencies.noteNoAtomicPlacement).toHaveBeenCalledWith("workspace");
      f.client.emit("capture.writeDeferred", { workspaceId: "workspace", path: "notes.md" });
      expect(f.dependencies.noteWriteDeferred).toHaveBeenCalledExactlyOnceWith("workspace", "notes.md");
      expect(collection.failuresChanged).toHaveBeenCalledOnce();
      f.client.emit("capture.noAtomicPlacement", { workspaceId: "workspace" });
      expect(f.dependencies.noteNoAtomicPlacement).toHaveBeenCalledWith("workspace");
      f.rows.delete("workspace");
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      expect(collection.notifyClaimed).toHaveBeenCalledOnce();
      vi.useFakeTimers();
      vi.mocked(f.dependencies.notifyRenderer).mockClear();
      f.client.emit("capture.momentRecorded", { workspaceId: "workspace", paths: ["notes.md"], appliedCount: 1, notOwnedCount: 0 });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.dependencies.notifyRenderer).not.toHaveBeenCalled();
      f.client.emit("collections.projected", { workspaceId: "workspace", paths: ["Log/a.md"], projectedCount: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({ workspaceId: "workspace", paths: ["Log/a.md"], pathSetChanged: false });
      // The engine answers what it refused while it read a new workspace's
      // files, so the whole workspace reads again.
      vi.mocked(f.dependencies.notifyRenderer).mockClear();
      f.client.emit("capture.initialSettled", { workspaceId: "workspace" });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace", pathSetChanged: false });
    } finally { vi.useRealTimers(); await f.close(); }
  });
});


describe("private owner peer lifecycle", () => {
  it.each(["credentials", "daemon", "workspace"])("holds the workspace session until %s cancellation settles", async mode => {
    const f = fixture(), credentials = new AbortController(), entered = deferred(), settled = deferred();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-owner-peer-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const document = {binding: {workspaceId: "owner"}, outboxId: "pending"};
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      relayUrl: "https://relay.example.test", documents: [document]};
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG = "peer-config";
    f.dependencies.ownerDeliveryCredentials = () => ({bearer: "actual-token", accountId: "owner-account", relayUrl: config.relayUrl, signal: credentials.signal});
    ownerDeliveryMock.read.mockReturnValue(config);
    let active: Promise<unknown> | undefined, lifetime!: AbortController;
    ownerDeliveryMock.start.mockImplementation(options => {
      lifetime = new AbortController();
      return {stop: async () => {lifetime.abort(); await active?.catch(() => undefined);}};
    });
    let passOptions!: Parameters<typeof import("./nativeOwnerDelivery")["runNativeOwnerDeliveryPass"]>[0];
    ownerDeliveryMock.pass.mockImplementation(async options => {passOptions = options; entered.resolve(); await settled.promise; options.assertCurrent(); return "retry";});
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().privateOwnerHost).toEqual({configPath: "native-config", client: config.nativeClient});
      const run = ownerDeliveryMock.start.mock.calls.at(-1)![0].runPass;
      active = run(document, lifetime.signal);
      await entered.promise;
      expect(passOptions.bearer).toBe("actual-token");
      expect(passOptions.accountId).toBe("owner-account");
      if (mode === "credentials") credentials.abort();
      let closed = false;
      const closing = Promise.resolve(mode === "daemon" ? f.options().beforePublish!(new AbortController().signal) : f.engine.closeRelayTransportWorkspace("owner")).then(() => {closed = true;});
      expect(passOptions.signal.aborted).toBe(true);
      expect(() => passOptions.assertCurrent()).toThrow();
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(f.client.requests.filter(request => request.method === "workspace.close" && request.workspace === "workspace-handle")).toHaveLength(0);
      settled.resolve(); await active?.catch(() => undefined); await closing;
      expect(closed).toBe(true);
    } finally {settled.resolve(); await f.close(); ownerDeliveryMock.read.mockReset(); ownerDeliveryMock.start.mockReset(); ownerDeliveryMock.pass.mockReset();}
  });

  it("rejects conflicting native ingress budgets before launching the daemon", async () => {
    const f = fixture();
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "host-config";
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG = "peer-config";
    f.dependencies.existingOwnerFor = vi.fn();
    f.dependencies.ownerDeliveryCredentials = () => null;
    ownerHostMock.read.mockReturnValue({nativeConfigPath: "native-config", workspaceIds: ["owner"], transport: {aggregateBytes: 100_000_000, maxUploads: 2}});
    ownerDeliveryMock.read.mockReturnValue({nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 3}, documents: []});
    try {expect(await f.engine.start()).toBe(false); expect(f.dependencies.createRustEngineDaemon).not.toHaveBeenCalled();}
    finally {await f.close(); ownerHostMock.read.mockReset(); ownerDeliveryMock.read.mockReset();}
  });
});

describe("server owner peer lifecycle", () => {
  it("delivers another document when a requested Stop release is corrupt", async () => {
    const f = fixture(), credentials = new AbortController();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-stop-isolation-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const binding = {workspaceId: "owner", mainVersionId: "main", objectId: "broken", lineageClaimId: "a".repeat(64),
      currentPath: "broken.md", selectorPaths: ["broken.md"], restoreFenceGeneration: 1};
    const row = {binding, document: {mainVersionId: "main", objectId: "broken", currentPath: "broken.md"},
      retirementOwed: true, relayDatabaseNamespace: "namespace", state: "requested" as const};
    const document = {binding: {...binding, objectId: "working", currentPath: "working.md", selectorPaths: ["working.md"]},
      relayDatabaseNamespace: "namespace", shareId: "share"};
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    const client = f.client as unknown as EngineClient;
    vi.spyOn(client, "ownerYDocStopList").mockResolvedValue([row]);
    vi.spyOn(client, "ownerYDocStopRequest").mockResolvedValue(row);
    vi.spyOn(client, "ownerYDocRelease").mockRejectedValue(new Error("owner-stop-corrupt"));
    const documents = vi.fn(async () => ({ok: true, documents: [{path: "working.md", status: "ready", document}]}));
    f.dependencies.serverOwnerDelivery = {prepare: async () => config, workspaceIds: () => ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal,
        assertCurrent() {}, retire: async () => 0, refusals: async () => {}, keptEdits: unexpectedKeptEdits, keptEditsPage: unexpectedKeptEdits, documents})};
    ownerDeliveryMock.pass.mockResolvedValue("acknowledged");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledWith(expect.objectContaining({document})));
      expect(documents).toHaveBeenCalled();
      expect(f.engine.ownerLiveStopFailures("owner")).toEqual([{objectId: "broken", path: "broken.md", detail: "owner-stop-corrupt"}]);
      f.engine.clearOwnerLiveStopFailure("owner",{objectId:"broken"});
      expect(f.engine.ownerLiveStopFailures("owner")).toEqual([]);
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });
  it("keeps local work available when optional owner ingress preparation fails", async () => {
    const f = fixture();
    f.dependencies.serverOwnerDelivery = {prepare: async () => {throw new Error("readonly profile");}, workspaceIds: () => ["owner"], hasRefusals: () => undefined, connect: async () => null};
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().privateOwnerHost).toBeUndefined();
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("restart-required");
    } finally {await f.close();}
  });
  it.each(["retry", "frozen"])("reports preparing and %s once, and an explicit retry clears the failed document after recovery", async outcome => {
    const f = fixture(), credentials = new AbortController();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-server-owner-status-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const document = {binding: {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1}, relayDatabaseNamespace: "namespace", shareId: "share"};
    let status = "preparing";
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    const changed = vi.fn();
    f.dependencies.notifyOwnerDeliveryChanged = changed;
    f.dependencies.serverOwnerDelivery = {prepare: async () => config, workspaceIds: () => credentials.signal.aborted ? [] : ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal, assertCurrent() {},
        retire: async () => 0, refusals: async () => {}, keptEdits: unexpectedKeptEdits, keptEditsPage: unexpectedKeptEdits,
        documents: async () => ({ok: true, documents: [{path: "a.md", status, document},
          ...(outcome === "frozen" ? [{path: "b.md", status, document: {...document, binding: {...document.binding, objectId: "other", currentPath: "b.md"}}}] : [])]})})};
    ownerDeliveryMock.pass.mockResolvedValue(outcome);
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("preparing"));
      status = "ready"; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying"));
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBe(outcome === "frozen" ? "document-unavailable" : undefined);
      if (outcome === "frozen") {
        ownerDeliveryMock.pass.mockImplementation(async options => options.document.binding.currentPath === "a.md" ? "frozen" : "empty");
        f.engine.retryOwnerDelivery("owner");
        await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledWith(expect.objectContaining({document: expect.objectContaining({binding: expect.objectContaining({currentPath: "b.md"})})})));
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable");
      }
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledTimes(2));
      expect(changed).toHaveBeenCalledTimes(2);
      ownerDeliveryMock.pass.mockResolvedValueOnce("acknowledged").mockResolvedValue("empty"); f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("active"));
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({workspaceId: "owner"});
      expect(changed).toHaveBeenCalledTimes(3);
      credentials.abort(); expect(f.engine.ownerLiveDeliveryStatus("owner")).toBeUndefined();
    } finally {await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  // A document whose edits the server refused for good names itself, with
  // where its edits are, instead of the workspace's moved-or-removed reason.
  it("names a refused document in its own quarantine, keeps the workspace delivering, and counts each Try again as a new incident", async () => {
    const f = fixture(), credentials = new AbortController();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-server-owner-quarantine-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const binding = {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "notes/plan.md", selectorPaths: ["notes/plan.md"], restoreFenceGeneration: 1};
    const document = {binding, relayDatabaseNamespace: "namespace", shareId: "share"};
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    f.dependencies.serverOwnerDelivery = {prepare: async () => config, workspaceIds: () => ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal, assertCurrent() {},
        retire: async () => 0, refusals: async () => {}, keptEdits: unexpectedKeptEdits, keptEditsPage: unexpectedKeptEdits, documents: async () => ({ok: true, documents: [{path: "notes/plan.md", status: "ready", document}]})})};
    const refused = (recovery: "paused" | "retrying") => [{objectId: "object", path: "notes/plan.md", reason: "invalid-update",
      outboxId: "outbox", binding, headDeliveryId: "delivery", recovery}];
    quarantineMock.read.mockResolvedValue(refused("paused"));
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([{objectId: "object", path: "notes/plan.md",
        reason: "invalid-update", storedOn: "this-computer", incident: "outbox:delivery:0", recovery: "paused"}]));
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("active"));
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBeUndefined();
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({workspaceId: "owner"});
      // The workspace as a renderer operation names it.
      const workspace = await f.authorities.withAuthority("owner", lease =>
        ({workspaceId: "owner", rootPath: lease.binding.canonicalRootPath, attachmentId: lease.binding.attachmentId}));
      // A Try again names the incident the owner saw; a stale one opens nothing.
      await expect(f.engine.retryOwnerLiveQuarantine(workspace, "object", "outbox:delivery:9")).rejects.toThrow("This document changed.");
      expect(quarantineMock.retry).not.toHaveBeenCalled();
      quarantineMock.read.mockResolvedValueOnce(refused("paused")).mockResolvedValue(refused("retrying"));
      await f.engine.retryOwnerLiveQuarantine(workspace, "object", "outbox:delivery:0");
      expect(quarantineMock.retry).toHaveBeenCalledExactlyOnceWith(expect.any(EngineClient), "workspace-handle", refused("paused")[0]);
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{incident: "outbox:delivery:1", recovery: "retrying"}]);
      // The server refuses the attempt again: the same document, a new incident.
      quarantineMock.read.mockResolvedValue(refused("paused"));
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{incident: "outbox:delivery:1", recovery: "paused"}]));
      await expect(f.engine.retryOwnerLiveQuarantine(workspace, "object", "outbox:delivery:0")).rejects.toThrow("This document changed.");
      // Recovered: the queue is gone, and so is the quarantine.
      quarantineMock.read.mockResolvedValue([]);
      ownerDeliveryMock.pass.mockResolvedValue("acknowledged");
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]));
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  // The desktop process keeps nothing: reopening the workspace reads the
  // refused queue again from the engine, before any delivery pass runs.
  it("shows an unresolved quarantine again after a restart, from the engine's durable queues", async () => {
    const binding = {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "notes/plan.md", selectorPaths: ["notes/plan.md"], restoreFenceGeneration: 1};
    quarantineMock.read.mockResolvedValue([{objectId: "object", path: "notes/plan.md", reason: "invalid-update",
      outboxId: "outbox", binding, headDeliveryId: "delivery", recovery: "paused"}]);
    const rootPath = await createTestScratch("dohc-quarantine-restart-");
    for (let launch = 0; launch < 2; launch++) {
      const f = fixture();
      Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
      try {
        await f.engine.start();
        expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]);
        await f.engine.sessions!.run({workspaceId: "owner", rootPath}, async () => undefined);
        await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([{objectId: "object", path: "notes/plan.md",
          reason: "invalid-update", storedOn: "this-computer", incident: "outbox:delivery:0", recovery: "paused"}]));
        expect(ownerDeliveryMock.pass).not.toHaveBeenCalled();
      } finally {await f.close();}
    }
  });

  // A Stop that waits for the server, or a release whose file write is not
  // confirmed, is read again on open: the first from the engine's Stop rows,
  // the second from this computer's durable record.
  it.each(["stopping", "not-written"] as const)("shows a %s document again after a restart", async recovery => {
    const binding = {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "notes/plan.md", selectorPaths: ["notes/plan.md"], restoreFenceGeneration: 1};
    const rootPath = await createTestScratch("dohc-quarantine-stop-restart-");
    const file = join(await createTestScratch("dohc-unwritten-releases-"), "owner-live-releases.json");
    if (recovery === "not-written") await createUnwrittenReleases(() => file).put({workspaceId: "owner", objectId: "object", path: "notes/plan.md", reason: "invalid-update", binding, headDeliveryId: "delivery", snapshot: "5".repeat(64), retry: true}, "{}");
    quarantineMock.read.mockImplementation(async (_client, _handle, options: {unwritten?: unknown[]}) => recovery === "stopping"
      ? [{objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId: "outbox", binding, headDeliveryId: "delivery", recovery}]
      : (options.unwritten ?? []).map(() => ({objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId: null, binding, headDeliveryId: null, recovery})));
    try {
      for (let launch = 0; launch < 2; launch++) {
        const f = fixture({ownerLiveReleases: createUnwrittenReleases(() => file)});
        Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
        try {
          await f.engine.start();
          await f.engine.sessions!.run({workspaceId: "owner", rootPath}, async () => undefined);
          await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([{objectId: "object", path: "notes/plan.md", reason: "invalid-update",
            storedOn: "this-computer", recovery, incident: recovery === "stopping" ? "outbox:delivery:0" : `release:${"a".repeat(64)}:1`}]));
        } finally {await f.close();}
      }
    } finally {quarantineMock.read.mockReset();}
  });

  // A parked document is revisited on every pass; its quarantine is read only
  // when a pass could have changed it.
  it("does not read a parked quarantine again on every frozen pass, nor on an unrelated acceptance", async () => {
    const {f, credentials, binding} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}, {path: "other.md", objectId: "other"}]);
    quarantineMock.read.mockResolvedValue([{objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId: "outbox", binding, headDeliveryId: "delivery", recovery: "paused"}]);
    ownerDeliveryMock.pass.mockImplementation(async options => options.document.binding.objectId === "object" ? "frozen" : "acknowledged");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toHaveLength(1));
      await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledTimes(2));
      const reads = quarantineMock.read.mock.calls.length;
      for (let pass = 3; pass <= 8; pass++) {
        f.engine.retryOwnerDelivery("owner");
        await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledTimes(pass));
      }
      expect(quarantineMock.read.mock.calls.length).toBe(reads);
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset(); quarantineMock.read.mockReset();}
  });

  it("reads a new refusal of the current queue beside its save-only queue", async () => {
    const {f, credentials, binding} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}]);
    const retained = {objectId: "object", path: "notes/plan.md", reason: "restore-fenced", outboxId: "old-queue",
      binding: {...binding, restoreFenceGeneration: 0}, headDeliveryId: "old-head", recovery: "paused", saveOnly: true};
    quarantineMock.read.mockResolvedValue([retained]);
    ownerDeliveryMock.pass.mockResolvedValue("empty");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("active"));
      expect(f.engine.ownerLiveQuarantines("owner")).toHaveLength(1);
      quarantineMock.read.mockResolvedValue([retained, {objectId: "object", path: "notes/plan.md", reason: "invalid-update",
        outboxId: "current", binding, headDeliveryId: "current-head", recovery: "paused"}]);
      ownerDeliveryMock.pass.mockResolvedValue("frozen");
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toHaveLength(2));
      expect(f.engine.ownerLiveQuarantines("owner")[1]).toMatchObject({reason: "invalid-update", incident: "current:current-head:0"});
    } finally {credentials.abort(); await f.close();}
  });

  it("marks the current note frozen when only an older save-only queue names its path", async () => {
    const {f, credentials, binding} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}]);
    quarantineMock.read.mockResolvedValue([{objectId: "object", path: "notes/plan.md", reason: "restore-fenced", outboxId: "old-queue",
      binding: {...binding, restoreFenceGeneration: 0}, headDeliveryId: "old-head", recovery: "paused", saveOnly: true}]);
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying"));
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable");
    } finally {credentials.abort(); await f.close();}
  });

  it.each(["empty", "acknowledged"])("discovers the set-aside queue when enrollment commits in a %s pass", async outcome => {
    const {f, credentials, binding} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}]);
    quarantineMock.read.mockResolvedValue([]);
    ownerDeliveryMock.pass.mockResolvedValue("empty");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("active"));
      expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]);
      const retained = {objectId: "object", path: "notes/plan.md", reason: "restore-fenced", outboxId: "old-queue",
        binding: {...binding, restoreFenceGeneration: 0}, headDeliveryId: "old-head", recovery: "paused", saveOnly: true};
      ownerDeliveryMock.pass.mockImplementationOnce(async (options: Parameters<typeof import("./nativeOwnerDelivery")["runNativeOwnerDeliveryPass"]>[0]) => {
        quarantineMock.read.mockResolvedValue([retained]);
        await options.onEnrolled?.();
        return outcome;
      }).mockResolvedValue(outcome);
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{saveOnly: true, incident: "old-queue:old-head:0"}]));
      const reads = quarantineMock.read.mock.calls.length;
      const passes = ownerDeliveryMock.pass.mock.calls.length;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledTimes(passes + 1));
      expect(quarantineMock.read).toHaveBeenCalledTimes(reads);
    } finally {credentials.abort(); await f.close();}
  });

  // The release failed, so the notice said the Stop waits; reconciliation
  // finishes it in the background with no live document left to deliver.
  it.each([true, false])("follows background Stop recovery in the notices when the release writes the file: %s", async materialized => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([]);
    const stopRow = (state: "requested" | "released") => ({binding, document: {mainVersionId: "main", objectId: "object", currentPath: "notes/plan.md"},
      relayDatabaseNamespace: "namespace", retirementOwed: state === "requested", state, ...(state === "released" ? {materialized} : {})});
    let released = false, failRelease = true;
    f.client.respond = async request => {
      if (request.method === "ydoc.ownerStop.release") {
        if (failRelease) throw new Error("dohc could not write the file.");
        released = true;
        // The Stop keeps the snapshot of the kept edits the record holds.
        const {keptSnapshot} = request.params as {keptSnapshot?: string};
        expect(keptSnapshot).toBe(f.unwritten[0]?.snapshot);
        return {id: request.id, result: {stops: [{...stopRow("released"), keptSnapshot}]}};
      }
      if (request.method === "ydoc.ownerStop.list") return {id: request.id, result: {stops: released ? [] : [stopRow("requested")]}};
      if (request.method === "ydoc.ownerStop.request") return {id: request.id, result: {stops: [stopRow("requested")]}};
      return {id: request.id, result: request.method === "workspace.open" ? {workspace: "workspace-handle"} : request.method === "engine.ping" ? {ok: true} : null};
    };
    const queue = [{objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId: "outbox", binding, headDeliveryId: "delivery", recovery: "stopping"}];
    quarantineMock.read.mockImplementation(async () => released ? [] : queue);
    const kept = recoveryQueue(binding);
    quarantineMock.queue.mockResolvedValue(kept.queue);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveStopFailures("owner")).toHaveLength(1));
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "stopping"}]);
      // Written before the release, in case it commits and then fails.
      expect(f.unwritten).toMatchObject([{workspaceId: "owner", objectId: "object", reason: "invalid-update"}]);
      expect(JSON.parse(f.recoveries.get("object")!)).toMatchObject({path: "notes/plan.md", checkpoint: {sha256: digest(kept.queue.checkpoint)}});
      failRelease = false;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]));
      expect(f.engine.ownerLiveStopFailures("owner")).toEqual([]);
      // Only a release that wrote the file ends the record; otherwise its notice and Try again stay.
      expect(f.unwritten).toHaveLength(materialized ? 0 : 1);
      expect(quarantineMock.read).toHaveBeenLastCalledWith(expect.anything(), "workspace-handle",
        expect.objectContaining({unwritten: materialized ? [] : [expect.objectContaining({objectId: "object"})]}));
      if (materialized) return;
      // The queue is gone, and Save recovery copy still rebuilds the kept edits from what was saved before the release.
      const queueReads = quarantineMock.queue.mock.calls.length;
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "notes/plan.md");
      expect(saved).toEqual({copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer", keptEdits: "ended"});
      expect(await readFile(join(f.rows.get("owner")!.rootPath, saved.copyPath!), "utf8")).toContain("kept");
      expect(quarantineMock.queue).toHaveBeenCalledTimes(queueReads);
    } finally {credentials.abort(); await f.close(); quarantineMock.read.mockReset(); quarantineMock.queue.mockReset(); vi.restoreAllMocks();}
  });

  // The background release failed before it committed, so the engine's Stop
  // still waits. Try again cannot settle a release that never happened: it
  // keeps the record's Try again, and reconciliation still finishes the Stop.
  it("keeps Try again for a release that never committed, and lets reconciliation finish the Stop", async () => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([]);
    const stopRow = (state: "requested" | "released") => ({binding, document: {mainVersionId: "main", objectId: "object", currentPath: "notes/plan.md"},
      relayDatabaseNamespace: "namespace", retirementOwed: state === "requested", state});
    let released = false, failRelease = true;
    const releases: {acceptedCursor?: number; keptSnapshot?: string}[] = [];
    f.client.respond = async request => {
      if (request.method === "ydoc.ownerStop.release") {
        const params = request.params as {acceptedCursor?: number; keptSnapshot?: string};
        releases.push(params);
        // A waiting Stop takes only a release at the relay's cursor, never a Try again.
        if (params.acceptedCursor === undefined) return releaseConflict(request);
        if (failRelease) throw new Error("dohc could not write the file.");
        released = true;
        return {id: request.id, result: {stops: [{...stopRow("released"), keptSnapshot: params.keptSnapshot, materialized: true}]}};
      }
      if (request.method === "ydoc.ownerStop.list") return {id: request.id, result: {stops: released ? [] : [stopRow("requested")]}};
      if (request.method === "ydoc.ownerStop.request") return {id: request.id, result: {stops: [stopRow("requested")]}};
      return {id: request.id, result: request.method === "workspace.open" ? {workspace: "workspace-handle"} : request.method === "engine.ping" ? {ok: true} : null};
    };
    quarantineMock.read.mockImplementation(async () => released ? [] :
      [{objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId: "outbox", binding, headDeliveryId: "delivery", recovery: "stopping"}]);
    quarantineMock.queue.mockResolvedValue(recoveryQueue(binding).queue);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveStopFailures("owner")).toHaveLength(1));
      const snapshot = f.unwritten[0]?.snapshot;
      expect(f.unwritten).toMatchObject([{objectId: "object", retry: true}]);
      await expect(f.engine.retryOwnerLiveRelease(await workspace(), "object")).resolves.toBe("requested");
      expect(f.unwritten).toMatchObject([{objectId: "object", snapshot, retry: true}]);
      failRelease = false;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]));
      expect(f.engine.ownerLiveStopFailures("owner")).toEqual([]);
      // The background release named the same edits, which the file now holds.
      expect(releases.at(-1)).toMatchObject({acceptedCursor: 0, keptSnapshot: snapshot});
      expect(f.unwritten).toEqual([]);
    } finally {credentials.abort(); await f.close(); quarantineMock.read.mockReset(); quarantineMock.queue.mockReset(); vi.restoreAllMocks();}
  });

  // A release took refused edits but could not write the file. A restart, or
  // an engine store reset that forgets the release, keeps the record and its
  // stored package. Try again settles that release again by the record's
  // binding and never asks for a new Stop. When the engine no longer holds
  // the release, only Save recovery copy remains, and the record ends once it
  // has written the stored package.
  it.each([
    ["a restart, then a Try again that writes the file", "materialized"],
    ["a restart, then a Try again that fails again", "failed"],
    ["an engine store reset, then a Try again that finds no release left", "conflict"],
  ] as const)("keeps the edits a release owed to a renamed file through %s, until the file or a recovery copy holds them", async (_title, outcome) => {
    // The record keeps the path the document had when it stopped; it has since been renamed.
    const kept = await keptRelease("notes/old plan.md");
    if (outcome !== "conflict") kept.engine.release = releaseAnswer(outcome === "materialized");
    try {
      await (await kept.launch()).f.close();
      // Nothing was exported before the Try again.
      const second = await kept.launch();
      try {
        expect(second.f.engine.ownerLiveQuarantines("owner")).toMatchObject([{objectId: "object", path: "notes/old plan.md", recovery: "not-written"}]);
        const released = await second.f.engine.retryOwnerLiveRelease(second.workspace, "object");
        expect(stopMethods(second.methods)).toEqual(["ydoc.ownerStop.release"]);
        expect(released === "requested" ? released : released?.materialized).toBe(outcome === "conflict" ? undefined : outcome === "materialized");
      } finally {await second.f.close();}
      if (outcome === "materialized") {
        expect(await kept.records().list("owner")).toEqual([]);
        expect(await kept.records().recovery("owner", "object")).toBeNull();
        return;
      }
      // After a restart the row stays, offering Try again only while the engine may still hold the release.
      const {f, workspace, methods} = await kept.launch();
      try {
        expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: outcome === "conflict" ? "cannot-write" : "not-written"}]);
        if (outcome === "conflict") await expect(f.engine.retryOwnerLiveRelease(workspace, "object")).rejects.toThrow("This document changed.");
        expect(await kept.records().recovery("owner", "object")).toEqual(expect.any(String));
        // Save recovery copy writes the stored package into the workspace, which ends the record.
        const saved = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/old plan.md");
        expect(saved.keptEdits).toBe("ended");
        expect(await readFile(join(kept.rootPath, saved.copyPath!), "utf8")).toContain("kept");
        expect(await readFile(join(kept.rootPath, saved.packagePath), "utf8")).toContain("dohc.live-recovery");
        expect(stopMethods(methods)).toEqual([]);
        expect(await kept.records().list("owner")).toEqual([]);
        expect(await kept.records().recovery("owner", "object")).toBeNull();
        // Nothing is left to route a Stop of the live document into a release.
        await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]));
      } finally {await f.close();}
    } finally {quarantineMock.read.mockReset();}
  });

  // Resume clears the Stop that held the release, so Try again has nothing
  // left to settle: the record keeps its package for Save recovery copy, and
  // the next Stop of the live document is an ordinary one.
  it("ends Try again for the release a Resume cleared, and keeps its package", async () => {
    const kept = await keptRelease();
    kept.engine.stops = [releasedStop];
    const {f, workspace, methods} = await kept.launch();
    try {
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "not-written"}]);
      await f.engine.clearOwnerLiveStop(workspace, releasedStop.document);
      expect(await kept.records().list("owner")).toMatchObject([{objectId: "object", headDeliveryId: "delivery", retry: false}]);
      expect(await kept.records().recovery("owner", "object")).toEqual(expect.any(String));
      await f.engine.refreshOwnerLiveQuarantines(workspace);
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "cannot-write"}]);
      await expect(f.engine.retryOwnerLiveRelease(workspace, "object")).rejects.toThrow("This document changed.");
      expect(stopMethods(methods)).toEqual(["ydoc.ownerStop.clear"]);
    } finally {await f.close(); quarantineMock.read.mockReset();}
  });

  // Document A stopped at notes/plan.md, then moved; B now has that path and
  // its own Stop. Resume of B clears B's Stop by its document, where a path
  // would name both. A's Stop and its record's Try again stay.
  it("clears only the resumed document's Stop when another document's Stop kept its path", async () => {
    const kept = await keptRelease();
    const moved = {...releasedStop, document: {...releasedStop.document, currentPath: "notes/moved.md"}};
    const other = {...releasedStop, binding: {...keptBinding, objectId: "other"}, document: {...releasedStop.document, objectId: "other"}};
    kept.engine.stops = [moved, other];
    const {f, workspace} = await kept.launch();
    try {
      await f.engine.clearOwnerLiveStop(workspace, other.document);
      expect(kept.engine.stops).toEqual([moved]);
      expect(await kept.records().list("owner")).toMatchObject([{objectId: "object", retry: true}]);
    } finally {await f.close(); quarantineMock.read.mockReset();}
  });

  // After an engine store reset the document binds again under the identical
  // binding. A Try again finds no release left; a later ordinary Stop writes
  // the reset document, which never had the kept edits. Only Save ends the record.
  it("keeps a record the engine no longer holds through a later Stop that writes the file, until Save", async () => {
    const kept = await keptRelease();
    const {f, workspace} = await kept.launch();
    try {
      expect(await f.engine.retryOwnerLiveRelease(workspace, "object")).toBeUndefined();
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "cannot-write"}]);
      kept.engine.release = releaseAnswer(true);
      expect(await f.engine.releaseOwnerLiveStop(workspace, keptBinding, 0)).toMatchObject({materialized: true});
      expect(await kept.records().list("owner")).toMatchObject([{objectId: "object", retry: false}]);
      expect(await kept.records().recovery("owner", "object")).toEqual(expect.any(String));
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md");
      expect(saved.keptEdits).toBe("ended");
      expect(await readFile(join(kept.rootPath, saved.copyPath!), "utf8")).toContain("kept");
      expect(await kept.records().list("owner")).toEqual([]);
    } finally {await f.close(); quarantineMock.read.mockReset();}
  });

  // An engine snapshot saved after an older Stop S1 finished is restored over
  // a newer Stop's record R2 under the same binding. Try again settles S1,
  // whose release took other edits: R2 and its package stay, for Save only.
  // A later release of S1 that names no kept edits ends nothing either.
  it("keeps a newer record when Try again settles an older finished Stop restored under the same binding", async () => {
    const {both, first} = twoEditQueue(keptBinding);
    const kept = await keptRelease("notes/plan.md", both);
    kept.engine.release = request => ({id: request.id, result: {stops: [{...releasedStop, keptSnapshot: recoverySnapshot(first), materialized: true}]}});
    const {f, workspace, methods} = await kept.launch();
    try {
      expect(await f.engine.retryOwnerLiveRelease(workspace, "object")).toBeUndefined();
      expect(stopMethods(methods)).toEqual(["ydoc.ownerStop.release"]);
      expect(await kept.records().list("owner")).toMatchObject([{objectId: "object", snapshot: recoverySnapshot(both), retry: false}]);
      expect(await kept.records().recovery("owner", "object")).toEqual(expect.any(String));
      kept.engine.release = releaseAnswer(true);
      await f.engine.releaseOwnerLiveStop(workspace, keptBinding, 0);
      expect(await kept.records().list("owner")).toMatchObject([{objectId: "object", snapshot: recoverySnapshot(both)}]);
      expect(await kept.records().recovery("owner", "object")).toEqual(expect.any(String));
    } finally {await f.close(); quarantineMock.read.mockReset();}
  });

  // After an engine store reset the server refused a new queue under the
  // identical binding. It is not the queue the record came from, so it
  // neither hides the record nor lets a Stop replace the earlier package.
  it("keeps an earlier package beside a queue rebuilt under the identical binding: Stop waits, and Save writes the earlier edits first", async () => {
    const kept = await keptRelease();
    kept.engine.queues = [{objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId: "rebuilt-outbox", binding: keptBinding,
      headDeliveryId: "rebuilt-delivery", recovery: "paused"}];
    quarantineMock.queue.mockResolvedValue({...recoveryQueue(keptBinding).queue, outboxId: "rebuilt-outbox"});
    const {f, workspace, methods} = await kept.launch();
    try {
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "paused", incident: "rebuilt-outbox:rebuilt-delivery:0"}, {recovery: "not-written"}]);
      await expect(f.engine.releaseOwnerLiveStop(workspace, keptBinding, 0)).rejects.toThrow("Save a recovery copy of notes/plan.md first.");
      // Refused before the whole queue is read, and before any release.
      expect(quarantineMock.queue).not.toHaveBeenCalled();
      expect(stopMethods(methods)).toEqual([]);
      expect(JSON.parse((await kept.records().recovery("owner", "object"))!)).toMatchObject({outboxId: "outbox"});
      const first = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md");
      expect(first.keptEdits).toBe("ended");
      expect(JSON.parse(await readFile(join(kept.rootPath, first.packagePath), "utf8"))).toMatchObject({outboxId: "outbox"});
      expect(await kept.records().list("owner")).toEqual([]);
      // Then the rebuilt queue, which stays.
      const second = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md");
      expect(second.keptEdits).toBe("kept");
      expect(JSON.parse(await readFile(join(kept.rootPath, second.packagePath), "utf8"))).toMatchObject({outboxId: "rebuilt-outbox"});
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "paused"}]);
    } finally {await f.close(); quarantineMock.read.mockReset(); quarantineMock.queue.mockReset();}
  });

  // Restoring an earlier engine state repeats the binding and the head with
  // fewer edits behind them. The stored package holds the edits the restored
  // queue lacks: a Stop cannot replace it, the list shows both, and Save writes it first.
  it("keeps the stored package when a restored queue repeats its binding and head with fewer edits", async () => {
    const {both, first} = twoEditQueue(keptBinding);
    const kept = await keptRelease("notes/plan.md", both);
    kept.engine.queues = [{objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId: "outbox", binding: keptBinding,
      headDeliveryId: "delivery", recovery: "paused"}];
    kept.engine.snapshots.set("outbox", recoverySnapshot(first));
    quarantineMock.queue.mockResolvedValue(first);
    const {f, workspace, methods} = await kept.launch();
    const updates = (text: string) => (JSON.parse(text) as {updates: unknown[]}).updates.length;
    try {
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "paused"}, {recovery: "not-written"}]);
      await expect(f.engine.releaseOwnerLiveStop(workspace, keptBinding, 0)).rejects.toThrow("Save a recovery copy of notes/plan.md first.");
      expect(stopMethods(methods)).toEqual([]);
      expect(updates((await kept.records().recovery("owner", "object"))!)).toBe(2);
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md");
      expect(saved.keptEdits).toBe("ended");
      expect(updates(await readFile(join(kept.rootPath, saved.packagePath), "utf8"))).toBe(2);
      const queued = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md");
      expect(queued.keptEdits).toBe("kept");
      expect(updates(await readFile(join(kept.rootPath, queued.packagePath), "utf8"))).toBe(1);
    } finally {await f.close(); quarantineMock.read.mockReset(); quarantineMock.queue.mockReset();}
  });

  // Save from a row writes what that row shows, so its result and toast name what was exported.
  it("saves exactly the kept edits a row's incident names", async () => {
    const kept = await keptRelease();
    kept.engine.queues = [{objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId: "rebuilt-outbox", binding: keptBinding,
      headDeliveryId: "rebuilt-delivery", recovery: "paused"}];
    quarantineMock.queue.mockResolvedValue({...recoveryQueue(keptBinding).queue, outboxId: "rebuilt-outbox"});
    const {f, workspace} = await kept.launch();
    const outboxOf = async (packagePath: string) => (JSON.parse(await readFile(join(kept.rootPath, packagePath), "utf8")) as {outboxId: string}).outboxId;
    try {
      const [queueRow, recordRow] = f.engine.ownerLiveQuarantines("owner");
      expect([queueRow?.incident, recordRow?.incident]).toEqual(["rebuilt-outbox:rebuilt-delivery:0", `release:${"a".repeat(64)}:1`]);
      const queued = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md", queueRow!.incident);
      expect(queued.keptEdits).toBe("kept");
      expect(await outboxOf(queued.packagePath)).toBe("rebuilt-outbox");
      expect(await kept.records().list("owner")).toHaveLength(1);
      for (const stale of ["rebuilt-outbox:rebuilt-delivery:9", "server:rebuilt-outbox:1"]) {
        await expect(f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md", stale)).rejects.toThrow("This document changed.");
      }
      const record = await f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md", recordRow!.incident);
      expect(record.keptEdits).toBe("ended");
      expect(await outboxOf(record.packagePath)).toBe("outbox");
      expect(await kept.records().list("owner")).toEqual([]);
      await expect(f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md", recordRow!.incident)).rejects.toThrow("This document changed.");
    } finally {await f.close(); quarantineMock.read.mockReset(); quarantineMock.queue.mockReset();}
  });

  // After an owner restore, the earlier generation's refused queue stays
  // listed beside the current one. A release takes only the current one, so
  // only its edits are packaged.
  it("packages only the refused queue of the generation a release takes", async () => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([]);
    const row = (outboxId: string, restoreFenceGeneration: number) => ({objectId: "object", path: "notes/plan.md", reason: "invalid-update", outboxId,
      binding: {...binding, restoreFenceGeneration}, headDeliveryId: `${outboxId}-delivery`, recovery: "paused"});
    quarantineMock.read.mockResolvedValue([row("earlier-outbox", 0), row("outbox", 1)]);
    quarantineMock.queue.mockResolvedValue(recoveryQueue(binding).queue);
    f.client.respond = async request => ({id: request.id, result: request.method === "ydoc.ownerStop.release"
      ? {stops: [{...releasedStop, binding, materialized: false}]}
      : request.method === "workspace.open" ? {workspace: "workspace-handle"} : request.method === "ydoc.ownerStop.list" ? {stops: []}
        : request.method === "engine.ping" ? {ok: true} : null});
    try {
      expect(await f.engine.start()).toBe(true);
      await f.engine.releaseOwnerLiveStop(await workspace(), binding, 0);
      expect(quarantineMock.queue).toHaveBeenCalledExactlyOnceWith(expect.any(EngineClient), "workspace-handle", expect.objectContaining({outboxId: "outbox"}));
      expect(f.unwritten).toMatchObject([{headDeliveryId: "outbox-delivery"}]);
    } finally {credentials.abort(); await f.close(); quarantineMock.read.mockReset(); quarantineMock.queue.mockReset();}
  });

  // While the engine refuses to read a document's queue head, nothing could
  // keep the edits a release takes, so the release refuses and Save reports
  // the engine's refusal. The row stays, and Try again reads it again.
  it("refuses a release and a save of a queue the engine cannot read, keeps its row, and reads it again on Try again", async () => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([]);
    const refused = new EngineRequestError(1, {code: "INVALID_PARAMS", message: "owner-outbox-accepted-state-incomplete", retry: "no"});
    const unreadable = {objectId: "object", path: "notes/plan.md", reason: refused.message, outboxId: "outbox", binding, headDeliveryId: null, recovery: "unreadable"};
    let readable = false;
    // As the reader answers: an unreadable row, unless the read is strict for that queue.
    quarantineMock.read.mockImplementation(async (_client, _handle, options?: {strict?: (queue: LiveObjectBinding) => boolean}) => {
      if (readable) return [{...unreadable, reason: "invalid-update", headDeliveryId: "delivery", recovery: "paused"}];
      if (options?.strict?.(binding)) throw refused;
      return [unreadable];
    });
    quarantineMock.queue.mockResolvedValue(recoveryQueue(binding).queue);
    f.client.respond = async request => ({id: request.id, result: request.method === "ydoc.ownerStop.release"
      ? {stops: [{...releasedStop, binding, materialized: false}]}
      : request.method === "workspace.open" ? {workspace: "workspace-handle"} : request.method === "ydoc.ownerStop.list" ? {stops: []}
        : request.method === "engine.ping" ? {ok: true} : null});
    try {
      expect(await f.engine.start()).toBe(true);
      const owner = await workspace();
      await f.engine.refreshOwnerLiveQuarantines(owner);
      const row = {objectId: "object", path: "notes/plan.md", reason: "owner-outbox-accepted-state-incomplete", storedOn: "this-computer",
        incident: "unreadable:outbox", recovery: "unreadable"};
      expect(f.engine.ownerLiveQuarantines("owner")).toEqual([row]);
      await expect(f.engine.releaseOwnerLiveStop(owner, binding, 0)).rejects.toBe(refused);
      expect(f.client.requests.map(request => request.method)).not.toContain("ydoc.ownerStop.release");
      expect(quarantineMock.queue).not.toHaveBeenCalled();
      expect(f.unwritten).toEqual([]);
      await expect(f.engine.saveOwnerLiveRecoveryCopy(owner, "notes/plan.md")).rejects.toBe(refused);
      await expect(f.engine.saveOwnerLiveRecoveryCopy(owner, "notes/plan.md", row.incident)).rejects.toBe(refused);
      // A failed strict read keeps the row, and Try again fails with the same refusal while it stands.
      expect(f.engine.ownerLiveQuarantines("owner")).toEqual([row]);
      await expect(f.engine.retryOwnerLiveQuarantine(owner, "object", row.incident)).rejects.toBe(refused);
      readable = true;
      await f.engine.retryOwnerLiveQuarantine(owner, "object", row.incident);
      expect(quarantineMock.retry).not.toHaveBeenCalled();
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "paused", incident: "outbox:delivery:0"}]);
    } finally {credentials.abort(); await f.close(); quarantineMock.read.mockReset(); quarantineMock.queue.mockReset();}
  });

  // Nothing is left to protect, and the record would refuse every later Stop of the document.
  it("removes a record whose stored package is missing, and says so", async () => {
    const kept = await keptRelease();
    await rm(kept.packageFile);
    const {f, workspace} = await kept.launch();
    try {
      await expect(f.engine.saveOwnerLiveRecoveryCopy(workspace, "notes/plan.md"))
        .rejects.toThrow("The kept edits dohc stored for notes/plan.md are missing from this computer, so dohc removed their notice.");
      expect(await kept.records().list("owner")).toEqual([]);
      expect(f.engine.ownerLiveQuarantines("owner")).toEqual([]);
    } finally {await f.close(); quarantineMock.read.mockReset();}
  });

  // A record that can only be saved does not hide edits the server keeps for the same document.
  it("lists the server's kept edits beside a record that can only be saved", async () => {
    const kept = await keptRelease();
    await kept.records().endRetry("owner", "object", keptBinding);
    const {f, credentials} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}], {kept: () =>
      [{objectId: "object", path: "notes/plan.md", outboxId: "server-outbox", reason: "invalid-update", generation: 1, store: "store", recovery: "paused"}]});
    f.dependencies.ownerLiveReleases = kept.records();
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([
        {storedOn: "this-computer", recovery: "cannot-write"}, {storedOn: "server", recovery: "paused", incident: "server:server-outbox:1"}]));
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset(); quarantineMock.read.mockReset();}
  });

  // Save recovery copy reads the whole queue and writes next to the file. It
  // asks the engine for nothing that changes the queue.
  it("lists and saves restore-fenced typing with its old incident after the binding advances", async () => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}]);
    const old = {...binding, restoreFenceGeneration: 0};
    const row = {objectId: "object", path: "notes/plan.md", reason: "restore-fenced", outboxId: "old-queue", binding: old,
      headDeliveryId: "old-delivery", recovery: "paused", saveOnly: true};
    quarantineMock.read.mockResolvedValue([row]);
    const {queue} = recoveryQueue(old, undefined, "Owner typed during the hold.");
    quarantineMock.queue.mockResolvedValue({...queue, outboxId: row.outboxId, quarantineReason: row.reason,
      observedBinding: binding, entries: queue.entries.map(entry => ({...entry, deliveryId: row.headDeliveryId}))});
    ownerDeliveryMock.pass.mockResolvedValue("empty");
    try {
      expect(await f.engine.start()).toBe(true);
      const owner = await workspace();
      const root = f.rows.get("owner")!.rootPath;
      await mkdir(join(root, "notes"), {recursive: true});
      await writeFile(join(root, row.path), "Restored text.");
      await f.engine.refreshOwnerLiveQuarantines(owner);
      const incident = "old-queue:old-delivery:0";
      expect(f.engine.ownerLiveQuarantines("owner")).toEqual([{objectId: "object", path: row.path, reason: row.reason,
        storedOn: "this-computer", incident, recovery: "paused", saveOnly: true}]);
      await expect(f.engine.retryOwnerLiveQuarantine(owner, "object", incident)).rejects.toThrow("These edits were kept after a restore and cannot be sent again. Save a recovery copy using this path and incident.");
      expect(quarantineMock.retry).not.toHaveBeenCalled();
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(owner, row.path, incident);
      expect(await readFile(join(root, saved.copyPath!), "utf8")).toContain("Owner typed during the hold.");
      expect(await readFile(join(root, row.path), "utf8")).toBe("Restored text.");
      expect(parseLiveRecoveryPackage(await readFile(join(root, saved.packagePath), "utf8")))
        .toMatchObject({outboxId: row.outboxId, binding: old, reason: "restore-fenced"});
      expect(saved.keptEdits).toBe("kept");
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{incident, saveOnly: true}]);
      await expect(f.engine.saveOwnerLiveRecoveryCopy(owner, row.path, "old-queue:new-delivery:0")).rejects.toThrow("This document changed.");
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  it("releases the current document without claiming an unreadable restore queue", async () => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([]);
    const old = {...binding, restoreFenceGeneration: 0};
    quarantineMock.read.mockImplementation(async (_client, _handle, options: {strict?: (binding: LiveObjectBinding) => boolean}) => {
      if (options.strict?.(old)) throw new Error("owner-outbox-accepted-state-incomplete");
      return [{objectId: old.objectId, path: old.currentPath, reason: "owner-outbox-accepted-state-incomplete", outboxId: "old-queue",
        binding: old, headDeliveryId: null, recovery: "unreadable", saveOnly: true}];
    });
    f.client.respond = async request => request.method === "ydoc.ownerStop.release" ? releaseAnswer(true)(request)
      : {id: request.id, result: request.method === "workspace.open" ? {workspace: "workspace-handle"}
        : request.method === "ydoc.ownerStop.list" ? {stops: []} : request.method === "engine.ping" ? {ok: true} : null};
    try {
      expect(await f.engine.start()).toBe(true);
      await expect(f.engine.releaseOwnerLiveStop(await workspace(), binding, 1)).resolves.toMatchObject({materialized: true});
      expect(quarantineMock.queue).not.toHaveBeenCalled();
      expect(f.unwritten).toEqual([]);
    } finally {credentials.abort(); await f.close();}
  });

  it("keeps the save-only incident listed after releasing the current binding", async () => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([]);
    const retained = {objectId: "object", path: "notes/plan.md", reason: "restore-fenced", outboxId: "old-queue",
      binding: {...binding, restoreFenceGeneration: 0}, headDeliveryId: "old-head", recovery: "paused", saveOnly: true};
    quarantineMock.read.mockResolvedValue([retained]);
    let released = false;
    f.client.respond = async request => {
      if (request.method === "ydoc.ownerStop.release") {released = true; return releaseAnswer(true)(request);}
      return {id: request.id, result: request.method === "workspace.open" ? {workspace: "workspace-handle"}
        : request.method === "ydoc.ownerStop.list" ? {stops: []} : request.method === "engine.ping" ? {ok: true} : null};
    };
    try {
      expect(await f.engine.start()).toBe(true);
      const owner = await workspace();
      await f.engine.releaseOwnerLiveStop(owner, binding, 1);
      expect(released).toBe(true);
      await f.engine.refreshOwnerLiveQuarantines(owner);
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{saveOnly: true, incident: "old-queue:old-head:0"}]);
      expect(quarantineMock.queue).not.toHaveBeenCalled();
      expect(f.unwritten).toEqual([]);
    } finally {credentials.abort(); await f.close();}
  });

  it("rereads an unreadable save-only queue on Try again without granting delivery", async () => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([]);
    const old = {...binding, restoreFenceGeneration: 0};
    const retained = {objectId: "object", path: old.currentPath, reason: "restore-fenced", outboxId: "old-queue",
      binding: old, headDeliveryId: "old-head", recovery: "paused", saveOnly: true};
    quarantineMock.read.mockImplementation(async (_client, _handle, options: {strict?: (binding: LiveObjectBinding) => boolean}) =>
      options.strict?.(old) ? [retained] : [{...retained, reason: "incomplete", headDeliveryId: null, recovery: "unreadable"}]);
    try {
      expect(await f.engine.start()).toBe(true);
      const owner = await workspace();
      await f.engine.refreshOwnerLiveQuarantines(owner);
      const incident = f.engine.ownerLiveQuarantines("owner")[0]!.incident;
      expect(incident).toMatch(/^unreadable:/);
      await f.engine.retryOwnerLiveQuarantine(owner, "object", incident);
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{saveOnly: true, recovery: "paused"}]);
      expect(quarantineMock.retry).not.toHaveBeenCalled();
    } finally {credentials.abort(); await f.close();}
  });

  it("saves a recovery copy without touching the queue, which stays quarantined", async () => {
    const {f, credentials, binding, workspace} = await quarantinedOwner([]);
    const row = {objectId: "object", path: "notes/plan.md", reason: "capacity-refused", outboxId: "outbox", binding, headDeliveryId: "delivery", recovery: "stopped-kept"};
    quarantineMock.read.mockResolvedValue([row]);
    const {queue, update} = recoveryQueue(binding);
    quarantineMock.queue.mockResolvedValue(queue);
    try {
      expect(await f.engine.start()).toBe(true);
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "notes/plan.md");
      expect(saved).toEqual({copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer", keptEdits: "kept"});
      const recovery = JSON.parse(await readFile(join(f.rows.get("owner")!.rootPath, saved.packagePath), "utf8"));
      expect(recovery.updates.map((entry: {base64: string}) => Buffer.from(entry.base64, "base64"))).toEqual([Buffer.from(update)]);
      expect(await readFile(join(f.rows.get("owner")!.rootPath, saved.copyPath!), "utf8")).toContain("kept");
      expect(quarantineMock.queue).toHaveBeenCalledExactlyOnceWith(expect.any(EngineClient), "workspace-handle", row);
      expect(f.client.requests.map(request => request.method).filter(method => /ownerStop\.(request|release|clear|retired)|ownerOutbox\./.test(method))).toEqual([]);
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "stopped-kept"}]);
      await expect(f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "other.md")).rejects.toThrow("dohc has no kept edits for this file.");
    } finally {credentials.abort(); await f.close(); quarantineMock.read.mockReset(); quarantineMock.queue.mockReset();}
  });

  // Edits the server keeps for a document it hosts: the server's list names
  // them, Save recovery copy writes the server's queue beside the document and
  // only then tells the server, and Try again names the server's refusal.
  it("saves edits the server keeps from the server's queue, then confirms the copy, and tries them again on the server", async () => {
    let kept = [{objectId: "object", path: "notes/plan.md", outboxId: "server-outbox", reason: "invalid-update", generation: 1, store: "store", recovery: "paused"}];
    const requests: {action: string; outboxId: string; generation: number; checkpointDigest?: string | null}[] = [];
    const served = {...recoveryQueue(keptBinding, "Recipient text").queue, outboxId: "server-outbox"};
    const pages = servedPages(served);
    const {f, credentials, workspace} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}], {kept: () => kept,
      keptEdits: async input => {
        if (input.action === "page") {
          if (input.cursor === undefined) requests.push({action: "page", outboxId: input.outboxId, generation: input.generation});
          return {ok: true, page: pages(input.cursor)};
        }
        requests.push(input);
        kept = [{...kept[0]!, recovery: input.action === "copied" ? "copied" : "retrying"}];
        return {ok: true};
      }});
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toEqual([{objectId: "object", path: "notes/plan.md",
        reason: "invalid-update", storedOn: "server", incident: "server:server-outbox:1", recovery: "paused"}]));
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "notes/plan.md");
      expect(saved).toEqual({copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "server", keptEdits: "copied"});
      const root = f.rows.get("owner")!.rootPath;
      const stored = await readFile(join(root, saved.packagePath), "utf8");
      expect(JSON.parse(stored)).toMatchObject({storedOn: "server", outboxId: "server-outbox", checkpoint: {sha256: served.checkpointDigest}});
      // The package rebuilds the recipient's accepted edit and the kept one.
      const rebuilt = new Y.Doc();
      for (const part of liveRecoveryUpdates(parseLiveRecoveryPackage(stored))) Y.applyUpdate(rebuilt, part);
      expect(rebuilt.getMap("frontmatter").toJSON()).toMatchObject({note: "Recipient text", status: "kept"});
      rebuilt.destroy();
      expect(await readFile(join(root, saved.copyPath!), "utf8")).toContain("Recipient text");
      // The copy was on disk before the server heard of it, and the server hears which checkpoint it holds.
      expect(requests).toEqual([{action: "page", outboxId: "server-outbox", generation: 1},
        {action: "copied", outboxId: "server-outbox", generation: 1, checkpointDigest: served.checkpointDigest}]);
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{storedOn: "server", recovery: "copied"}]);
      // The engine on this computer was never asked for the server's queue.
      expect(quarantineMock.queue).not.toHaveBeenCalled();
      await expect(f.engine.retryOwnerLiveQuarantine(await workspace(), "object", "server:server-outbox:0")).rejects.toThrow("This document changed.");
      await f.engine.retryOwnerLiveQuarantine(await workspace(), "object", "server:server-outbox:1");
      expect(requests.at(-1)).toEqual({action: "retry", outboxId: "server-outbox", generation: 1});
      expect(quarantineMock.retry).not.toHaveBeenCalled();
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{recovery: "retrying"}]);
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  // Proves: a page read returns every byte and every recorded author of the
  // queue, across many small pages, and a queue that changed between pages
  // answers changed instead of a copy.
  it("assembles the server's queue from bounded pages with every byte and author, and refuses one that changed", async () => {
    const {queue} = recoveryQueue(keptBinding);
    const served: OwnerYDocOutboxRecovery = {...queue, outboxId: "server-outbox", entries: queue.entries.map(entry => ({...entry, personEdit: true as const,
      agentDeclaration: {agentId: "agent", onBehalfOf: null, depth: 1}, nativeSource: {binding: keptBinding, adoptionId: "adoption", nativeSequence: 2, updateDigest: entry.updateDigest,
        origin: {kind: "nativeUpdate" as const, actorOriginId: "origin", actorKind: "agent", onBehalfOf: "owner", chainDepth: 1, recordedAtMs: 1}}}))};
    const row = {objectId: "object", path: "notes/plan.md", outboxId: "server-outbox", reason: "invalid-update", generation: 1, store: "store", recovery: "paused" as const};
    const pages = servedPages(served, 2);
    let reads = 0;
    expect(await readServerKeptEditsQueue(row, async cursor => {reads++; return {ok: true, page: pages(cursor)};})).toEqual(served);
    expect(reads).toBeGreaterThan(10);
    let turn = 0;
    // The queue changes after the first page, so the engine answers the next as changed.
    await expect(readServerKeptEditsQueue(row, async cursor => ({ok: true, page: turn++ === 0 ? pages(cursor) : {kind: "readChanged"}})))
      .rejects.toBeInstanceOf(ServerKeptEditsConflict);
  });

  // Proves: while the server prepares the earlier copy of the workspace that
  // holds a queue, the read asks for the same page again after a wait, then
  // reads the queue whole. One the server keeps preparing past the desktop's
  // own limit fails as a recovery copy the server could not prepare.
  it("asks again while the server prepares an earlier copy, and gives up past its limit", async () => {
    const {queue} = recoveryQueue(keptBinding);
    const served = {...queue, outboxId: "server-outbox"};
    const row = {objectId: "object", path: "notes/plan.md", outboxId: "server-outbox", reason: "invalid-update", generation: 1, store: "store", recovery: "paused" as const, earlier: true as const};
    const pages = servedPages(served), cursors: unknown[] = [];
    let preparing = 2;
    const waits: number[] = [];
    expect(await readServerKeptEditsQueue(row, async cursor => {
      cursors.push(cursor);
      return {ok: true, page: preparing-- > 0 ? {kind: "preparing"} : pages(cursor)};
    }, async ms => {waits.push(ms);})).toEqual(served);
    expect(waits).toEqual([1_000, 1_000]);
    expect(cursors.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    const refused = readServerKeptEditsQueue(row, async () => ({ok: true, page: {kind: "preparing"}}), async () => {});
    await expect(refused).rejects.toBeInstanceOf(ServerRecoveryCopyRefusedError);
    await expect(refused).rejects.toMatchObject({code: "server", message: "Ask the server administrator to check the server, then try again."});
  });

  // Proves: the desktop lists every row the server keeps, past its first page,
  // and saves and confirms one only that later page names. A later page that
  // fails keeps the last complete list.
  it("discovers and saves row 257 of the server's kept edits, and keeps the last complete list when a page fails", async () => {
    const row = (index: number) => ({objectId: `object-${index}`, path: `notes/plan-${index}.md`, outboxId: `server-outbox-${index}`, reason: "invalid-update",
      generation: index, store: "store", recovery: "paused"});
    const firstPage = Array.from({length: 256}, (_, index) => row(index + 1));
    let failing = false;
    const pageRequests: number[] = [], actions: string[] = [];
    const last = row(257), pages = servedPages({...recoveryQueue({...keptBinding, objectId: last.objectId}).queue, outboxId: last.outboxId});
    const {f, credentials, workspace} = await quarantinedOwner([{path: "notes/plan-1.md", objectId: "object-1"}], {kept: () => firstPage, keptCursor: 256,
      keptEditsPage: async after => {
        pageRequests.push(after);
        if (failing) throw new Error("Owner kept edits discovery failed.");
        return {ok: true, keptEdits: [last, firstPage[0]], nextCursor: null};
      },
      keptEdits: async input => {
        actions.push(input.action);
        if (input.action === "page") return {ok: true, page: pages(input.cursor)};
        return {ok: true};
      }});
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toHaveLength(257));
      expect(pageRequests[0]).toBe(256);
      // A row listed on both pages appears once.
      expect(f.engine.ownerLiveQuarantines("owner").filter(found => found.objectId === "object-1")).toHaveLength(1);
      const saved = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), last.path);
      expect(saved).toMatchObject({storedOn: "server", keptEdits: "copied"});
      expect(actions.at(-1)).toBe("copied");
      failing = true;
      const before = pageRequests.length;
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(pageRequests.length).toBeGreaterThan(before));
      expect(f.engine.ownerLiveQuarantines("owner")).toHaveLength(257);
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  // Proves: a refusal the server answers changed or gone loses its cached row.
  // A Try again the server refuses because an earlier copy of the workspace
  // keeps the edits leaves the row saveable, and a later Try again of that row
  // is refused here without asking the server again.
  it("drops a server row the server answers changed, and marks one whose edits an earlier copy keeps", async () => {
    let answer: "changed" | "earlier" = "changed";
    const kept = [{objectId: "object", path: "notes/plan.md", outboxId: "server-outbox", reason: "invalid-update", generation: 1, store: "store", recovery: "paused"},
      {objectId: "object-2", path: "notes/other.md", outboxId: "server-outbox-2", reason: "invalid-update", generation: 2, store: "store", recovery: "paused"}];
    const keptEdits = vi.fn(async () => {throw new ServerKeptEditsConflict(answer === "earlier");});
    const {f, credentials, workspace} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}], {kept: () => kept, keptEdits});
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toHaveLength(2));
      await expect(f.engine.retryOwnerLiveQuarantine(await workspace(), "object", "server:server-outbox:1")).rejects.toThrow("This document changed.");
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{objectId: "object-2"}]);
      answer = "earlier";
      await expect(f.engine.retryOwnerLiveQuarantine(await workspace(), "object-2", "server:server-outbox-2:2")).rejects.toThrow("Save a recovery copy to get them back.");
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([{objectId: "object-2", recovery: "paused", earlier: true}]);
      const asked = keptEdits.mock.calls.length;
      await expect(f.engine.retryOwnerLiveQuarantine(await workspace(), "object-2", "server:server-outbox-2:2")).rejects.toThrow("Save a recovery copy to get them back.");
      expect(keptEdits).toHaveBeenCalledTimes(asked);
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  // Proves: the server's rows of two copies of the workspace that share an
  // outbox ID stay two rows. Saving the earlier copy's row reads that copy's
  // queue, writes its package and confirms that row alone, which then reads as
  // copied and still earlier, so it offers no Try again; the current copy's
  // row stays as it was until its own save.
  it("saves the earlier copy's row of two copies that share an outbox ID from that copy, and confirms only that row", async () => {
    const {both, first} = twoEditQueue(keptBinding);
    const served = new Map([[1, servedPages({...both, outboxId: "server-outbox"})], [2, servedPages({...first, outboxId: "server-outbox"})]]);
    const row = {objectId: "object", path: "notes/plan.md", outboxId: "server-outbox", reason: "invalid-update"};
    let kept = [{...row, generation: 1, store: "earlier", recovery: "paused", earlier: true}, {...row, generation: 2, store: "current", recovery: "paused"}];
    const actions: unknown[] = [];
    const {f, credentials, workspace} = await quarantinedOwner([{path: "notes/plan.md", objectId: "object"}], {kept: () => kept,
      keptEdits: async input => {
        if (input.action === "page") return {ok: true, page: served.get(input.generation)!(input.cursor)};
        actions.push(input);
        kept = kept.map(candidate => candidate.generation === input.generation ? {...candidate, recovery: "copied"} : candidate);
        return {ok: true};
      }});
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    const updates = async (packagePath: string) =>
      (JSON.parse(await readFile(join(f.rows.get("owner")!.rootPath, packagePath), "utf8")) as {updates: unknown[]}).updates.length;
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([
        {incident: "server:server-outbox:1", recovery: "paused", earlier: true}, {incident: "server:server-outbox:2", recovery: "paused"}]));
      const earlier = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "notes/plan.md", "server:server-outbox:1");
      expect(earlier).toMatchObject({storedOn: "server", keptEdits: "copied"});
      expect(await updates(earlier.packagePath)).toBe(2);
      // Each copy confirms the checkpoint its own header named; both queues build on one checkpoint.
      const checkpointDigest = digest(both.checkpoint!);
      expect(actions).toEqual([{action: "copied", outboxId: "server-outbox", generation: 1, checkpointDigest}]);
      expect(f.engine.ownerLiveQuarantines("owner")).toMatchObject([
        {incident: "server:server-outbox:1", recovery: "copied", earlier: true}, {incident: "server:server-outbox:2", recovery: "paused"}]);
      expect(f.engine.ownerLiveQuarantines("owner")[1]).not.toHaveProperty("earlier");
      await expect(f.engine.retryOwnerLiveQuarantine(await workspace(), "object", "server:server-outbox:1")).rejects.toThrow("Save a recovery copy to get them back.");
      expect(actions).toHaveLength(1);
      const current = await f.engine.saveOwnerLiveRecoveryCopy(await workspace(), "notes/plan.md", "server:server-outbox:2");
      expect(await updates(current.packagePath)).toBe(1);
      expect(actions).toEqual([{action: "copied", outboxId: "server-outbox", generation: 1, checkpointDigest},
        {action: "copied", outboxId: "server-outbox", generation: 2, checkpointDigest}]);
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  // Proves: a document the server refused names the workspace's reason over
  // every other, including a frozen document that clears on its own, and
  // stops naming it once the server no longer reports it. Only a document the
  // server cannot start until its owner opens it outranks a refusal, and a
  // diverged server copy, which only the server's operator can continue, outranks both.
  it("reports a document the server refused ahead of every other reason but one it cannot start or whose server copy diverged", async () => {
    const f = fixture(), credentials = new AbortController();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-server-owner-refused-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const document = {binding: {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1}, relayDatabaseNamespace: "namespace", shareId: "share"};
    const refused = {path: "refused.md", status: "unavailable", reason: "session-host-refused"};
    const unopened = {path: "unopened.md", status: "unavailable", reason: "live-document-without-lineage"};
    const divergedRow = {path: "diverged.md", status: "unavailable", reason: "session-host-diverged"};
    const edited = {path: "edited.md", status: "unavailable", reason: "live-edit-unadmitted"};
    const held = {path: "held.md", status: "unavailable", reason: "conflict-parent-withheld"};
    const others = [{path: "changed.md", status: "unavailable", reason: "workspace-changed"}, {path: "moved.md", status: "unavailable", reason: "document-unavailable"}];
    const ready = {path: "a.md", status: "ready", document};
    // The server says the workspace diverged whenever any of its rows does, and after its owner stopped every one.
    let rows: unknown[] = others, diverged = false;
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    f.dependencies.serverOwnerDelivery = {prepare: async () => config, workspaceIds: () => ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal, assertCurrent() {},
        retire: async () => 0, refusals: async () => {}, keptEdits: unexpectedKeptEdits, keptEditsPage: unexpectedKeptEdits, documents: async () => ({ok: true, diverged, documents: rows})})};
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("workspace-changed"));
      // With no document to deliver.
      rows = [...others, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // A frozen document outranks the server's other reasons, but not a refusal.
      rows = [ready, ...others]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable"));
      rows = [ready, ...others, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // A document the server cannot start until its owner opens it goes first, with or without a frozen one.
      rows = [...others, refused, unopened]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"));
      rows = [ready, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      rows = [ready, ...others, unopened, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // A diverged server copy outranks all of them, with or without a frozen document.
      // Each step changes the reason, so no step passes on the one before it.
      rows = [...others, refused, unopened, divergedRow]; diverged = true; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, unopened]; diverged = false; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"));
      rows = [ready, divergedRow, ...others, unopened, refused]; diverged = true; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, ...others]; diverged = false; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable"));
      // A document edited while live editing was off outranks a frozen one and
      // the server's other reasons, but not a refusal a Resume can still help.
      rows = [ready, ...others, edited]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-edit-unadmitted"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [...others, edited, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      rows = [held, {path: "preparing.md", status: "preparing"}]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("conflict-parent-withheld"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, ...others, edited, held]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-edit-unadmitted"));
      rows = [ready, ...others, held]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("conflict-parent-withheld"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, held, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      // The owner stopped every document, and the server still reports its diverged copy.
      rows = []; diverged = true; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // The server no longer reports it.
      diverged = false; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBeUndefined());
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  it.each(["credentials", "daemon", "workspace"])("discovers ready documents and holds the session until %s cancellation settles", async mode => {
    const f = fixture(), credentials = new AbortController(), entered = deferred(), settled = deferred();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-server-owner-peer-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const document = {binding: {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1}, relayDatabaseNamespace: "namespace", shareId: "share"};
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    const documents = vi.fn(async () => ({ok: true, documents: [{path: "a.md", status: "ready", document}]}));
    f.dependencies.serverOwnerDelivery = {prepare: vi.fn(async () => config), workspaceIds: () => ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "actual-token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal,
        assertCurrent: () => credentials.signal.throwIfAborted(), documents, retire: async () => 0, refusals: async () => {}, keptEdits: unexpectedKeptEdits, keptEditsPage: unexpectedKeptEdits})};
    let passOptions!: Parameters<typeof import("./nativeOwnerDelivery")["runNativeOwnerDeliveryPass"]>[0];
    ownerDeliveryMock.pass.mockImplementation(async options => {passOptions = options; entered.resolve(); await settled.promise; options.assertCurrent(); return "empty";});
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().privateOwnerHost).toEqual({configPath: "native-config", client: config.nativeClient});
      await entered.promise;
      expect(passOptions.document).toEqual(document);
      expect(passOptions.bearer).toBe("actual-token");
      expect(passOptions.accountId).toBe("owner-account");
      if (mode === "credentials") credentials.abort();
      let closed = false;
      const closing = Promise.resolve(mode === "daemon" ? f.options().beforePublish!(new AbortController().signal) : f.engine.closeRelayTransportWorkspace("owner")).then(() => {closed = true;});
      expect(passOptions.signal.aborted).toBe(true);
      expect(() => passOptions.assertCurrent()).toThrow();
      await Promise.resolve(); expect(closed).toBe(false);
      settled.resolve(); await closing;
      expect(closed).toBe(true);
      if (mode === "daemon") {
        ownerDeliveryMock.pass.mockResolvedValue("empty");
        f.options().onLaunch!();
        await vi.waitFor(() => expect(documents).toHaveBeenCalledTimes(2));
      }
    } finally {settled.resolve(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });
});
