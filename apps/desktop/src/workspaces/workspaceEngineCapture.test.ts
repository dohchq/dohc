import { createRelaySyncEngine } from "./relaySyncEngine";
import { startServerOwnerDelivery } from "./serverOwnerDelivery";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import type { MomentAuthor } from "@dohc/workspace-contracts";
import type {
  MaterializeRelayPullPage,
  RelayMaterializedPath,
} from "@dohc/workspace-contracts/relay";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, type PathLike } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { outsideWriteCopies } from "./outsideWriteCopies";
import { protectedWriteCopies } from "./protectedWriteCopies";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import {
  DAEMON_CAPTURE_HEALTH_POLL_MS,
  AuthoredTextChangedError,
  UnsupportedWorkspacePathError,
  assertGeneratedMarkdownPath,
  createDefaultDiskWriter,
  createWorkspaceEngineCapture,
  isYDocPathNotInVersionError,
  MergeStoppedPartwayError,
  YDocOpenRacedError,
  YDocSessionUnreleasedError,
  YDocUncapturedArtifactError,
  type WorkspaceEngineCapture,
  type WorkspaceEngineCaptureOptions,
  type WorkspaceEngineCaptureFailure,
  type EngineDiskWriter,
} from "./workspaceEngineCapture";
import {
  DaemonRefusalError,
  YdocOwnerDraftPendingError,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
  VERSIONED_METHOD,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  createCaptureLiveStores,
  type CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";
import * as Y from "yjs";
import { deferred } from "../testing/deferred";
import { duplicateWorkspaceFile } from "./workspaceDuplicate";
import { createTestScratch } from "./testTemp";
import { listLiveDraftRecovery, workspaceDraftStore } from "./liveDraftRecovery";
import { openedLocalState } from "../testing/preparedLocalState";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "./workspaceTextLimits";

vi.mock("node:timers/promises", { spy: true });
vi.mock("node:fs/promises", { spy: true });

const RESTORER = { kind: "human", humanId: "local-person" } as const;

afterEach(async () => {
  vi.restoreAllMocks();
});

interface EngineMomentRow {
  path: string;
  operation: string;
  text: string;
  origin: string;
  summary: string | null;
  correlationId: string | null;
}

async function write(root: string, path: string, contents: string | Uint8Array) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const WORKSPACE_ID = "engine-capture-test";
const WORKSPACE_ATTACHMENT_ID = Symbol("workspace-engine-capture-test");

it.each(["text"])("replays a keyed %s restore without reversing a later edit", async (kind) => {
  const root = await createTestScratch("dohc-keyed-restore-");
  const sessions = mockLiveSessions(new VersionedLoopbackEngine());
  const store = createCaptureLiveStores(
    { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
    sessions,
  ).store;
  const target = {
    workspaceId: WORKSPACE_ID,
    versionId: "main",
    path: "notes/file.txt",
    metadata: { origin: "api" as const },
  };
  await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
  if (kind === "text") await store.writeTextFile({ ...target, text: "old" });
  const changed = await store.writeTextFile({ ...target, text: "new" });
  await write(root, target.path, "new");
  const engine = capture(root, { store, rustEngineSessions: sessions });
  const options = {
    expectedHeadMomentId: changed.moment.id,
    requestId: "restore/saved-session-file",
  };
  const first = await engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER, options);
  const newer = await store.writeTextFile({ ...target, text: "teammate" });
  await write(root, target.path, "teammate");
  await expect(
    engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER, {
      ...options,
      requestId: "another-session",
    }),
  ).rejects.toMatchObject({ name: "RestoreHeadChangedError" });
  expect(
    await engine.restoreFileToBeforeMoment(
      changed.moment.id,
      { kind: "human", humanId: "another-owner" },
      options,
    ),
  ).toEqual(first);
  const moments = await store.listMoments({
    workspaceId: WORKSPACE_ID,
    versionId: "main",
    objectId: changed.moment.objectId,
    limit: 100,
  });
  expect(
    moments.moments.filter(
      (m) => m.metadata.correlationId === options.requestId && m.metadata.origin === "restore",
    ),
  ).toHaveLength(1);
  expect((await store.readTextFile(target))?.objectId).toBe(newer.moment.objectId);
  expect(await readFile(join(root, target.path), "utf8")).toBe("teammate");
  await engine.stop();
});

it.each([["text", "error"]] as readonly (readonly [
  "text" | "binary",
  "error" | "conflict" | "superseded",
])[])("never adopts an unconfirmed keyed %s restore (%s) on retry", async (kind, outcome) => {
  const root = await createTestScratch("dohc-keyed-restore-unpublished-");
  const loopback = new VersionedLoopbackEngine();
  const send = loopback.sendRequest.bind(loopback);
  const unpublished = new Set<string>();
  vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
    const response = await send(request);
    const params = request.params as Record<string, JsonValue>;
    // The daemon's request ledger answers as the injected publication ended.
    if (request.method === VERSIONED_METHOD.publicationApplied) {
      return {
        ...response,
        result: response.result === true && !unpublished.has(params.momentId as string),
      };
    }
    if (
      (request.method !== VERSIONED_METHOD.textWrite &&
        request.method !== VERSIONED_METHOD.binaryWrite) ||
      params.origin !== "restore"
    )
      return response;
    const result = response.result as Record<string, JsonValue>;
    unpublished.add((result.moment as Record<string, JsonValue>).momentId as string);
    return { ...response, result: { ...result, materialized: false, materializeOutcome: outcome } };
  });
  const sessions = mockLiveSessions(loopback);
  const store = createCaptureLiveStores(
    { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
    sessions,
  ).store;
  const target = {
    workspaceId: WORKSPACE_ID,
    versionId: "main",
    path: kind === "text" ? "note.txt" : "image.bin",
    metadata: { origin: "api" as const },
  };
  const current = kind === "text" ? "current" : Buffer.from([0, 255, 2]);
  await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
  if (kind === "text") await store.writeTextFile({ ...target, text: "original" });
  else await store.writeBinaryFile({ ...target, bytes: Buffer.from([0, 255, 1]) });
  const changed =
    kind === "text"
      ? await store.writeTextFile({ ...target, text: "current" })
      : await store.writeBinaryFile({ ...target, bytes: Buffer.from([0, 255, 2]) });
  await write(root, target.path, current);
  const engine = capture(root, { store, rustEngineSessions: sessions });
  const options = {
    expectedHeadMomentId: changed.moment.id,
    requestId: "restore/unpublished-session-file",
  };
  try {
    await expect(
      engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER, options),
    ).rejects.toThrow();
    expect(unpublished.size).toBe(1);
    await expect(
      engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER, options),
    ).rejects.toMatchObject({ name: "RestoreHeadChangedError" });
    expect(await engine.findRestoreReceipt(changed.moment.id, options.requestId)).toBeNull();
    expect(await engine.publicationApplied([...unpublished][0]!, options.requestId)).toBe(false);
    expect(await readFile(join(root, target.path))).toEqual(Buffer.from(current));
  } finally {
    await engine.stop();
  }
});

interface CaptureOptions {
  diskWriter?: EngineDiskWriter;
  preserveUnsentState?: WorkspaceEngineCaptureOptions["preserveUnsentState"];
  discardUnsentState?: WorkspaceEngineCaptureOptions["discardUnsentState"];
  store?: CaptureVersionedTextStore;
  createId?: () => string;
  onError?: (context: string, error: unknown) => void;
  onCaptureOutcome?: (failure: WorkspaceEngineCaptureFailure, detail?: string | null) => void;
  onAtomicPlacementUnavailable?: () => void;
  onRecoveryUnavailable?: (unavailable: boolean) => void;
  onSecretKeyUnavailable?: WorkspaceEngineCaptureOptions["onSecretKeyUnavailable"];
  onOutsideWriteCopies?: WorkspaceEngineCaptureOptions["onOutsideWriteCopies"];
  onProtectedCopies?: (
    copies: readonly (readonly [string, string, number])[] | null,
    readError: string | null,
  ) => void;
  onKeptFiles?: WorkspaceEngineCaptureOptions["onKeptFiles"];
  onRetainedCopies?: WorkspaceEngineCaptureOptions["onRetainedCopies"];
  onHeldFiles?: WorkspaceEngineCaptureOptions["onHeldFiles"];
  onOutsideChanges?: WorkspaceEngineCaptureOptions["onOutsideChanges"];
  rustEngineSessions?: EngineWorkspaceSessions;
  openRustYDocProviderSession?: (
    options: EngineYdocProviderSessionOptions,
  ) => Promise<EngineYdocProviderSession>;
}

function capture(root: string, options: CaptureOptions = {}) {
  const { rustEngineSessions, ...rest } = options;
  return createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    attachmentId: WORKSPACE_ATTACHMENT_ID,
    rustEngineSessions: rustEngineSessions ?? mockLiveSessions(new VersionedLoopbackEngine()),
    ...rest,
  });
}

function caseInsensitiveDisk(root: string, path: string, text: string) {
  const key = (path: string) => path.toLowerCase();
  const files = new Map([[key(join(root, path)), text]]);
  const operations: string[] = [];
  const writer: EngineDiskWriter = {
    async writeTextFile(path, text) {
      operations.push("write");
      files.set(key(path), text);
    },
    async writeBinaryFile() {
      throw new Error("Unexpected binary write");
    },
    async deletePath(path) {
      operations.push("delete");
      files.delete(key(path));
      // A protected write reads the real file first, so it must be gone there too.
      await rm(path, { force: true });
    },
  };
  return { writer, operations, read: (path: string) => files.get(key(join(root, path))) };
}

describe("merge materialization order", () => {
  it("keeps a protected merge's case-variant target on a case-insensitive disk", async () => {
    const root = await createTestScratch("dohc-protected-merge-order-");
    const loopback = new VersionedLoopbackEngine();
    const send = loopback.sendRequest.bind(loopback);
    vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) =>
      request.method === "conflicts.list"
        ? { id: request.id, result: { conflicts: [], nextAfterConflictId: null } }
        : await send(request),
    );
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "foo.env",
      text: "VALUE=main\n",
    });
    await write(root, "foo.env", "VALUE=main\n");
    const sessions = mockLiveSessions(loopback);
    const stores = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    );
    const disk = caseInsensitiveDisk(root, "foo.env", "VALUE=main\n");
    const engine = capture(root, {
      store: stores.store,
      rustEngineSessions: sessions,
      diskWriter: disk.writer,
    });
    try {
      const draftId = (await engine.createVersion("Draft")).activeVersionId;
      await stores.secretStore.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: draftId,
        path: "foo.env",
        metadata: { origin: "api" },
      });
      loopback.seedSecretFile({
        workspace: WORKSPACE_ID,
        versionId: draftId,
        path: "Foo.env",
        text: "VALUE=draft\n",
      });
      await engine.switchVersion("main");

      await expect(engine.mergeVersionIntoMain(draftId)).resolves.toMatchObject({
        mergedFileCount: 2,
        conflictCount: 0,
      });
      expect(disk.read("Foo.env")).toBe("VALUE=draft\n");
      expect(disk.operations).toEqual(["delete", "write"]);
    } finally {
      await engine.stop();
    }
  });

  // The engine places each text merge on disk before the next one starts.

  it.each([
    ["names a failure after a file reached Main as stopped partway", 2, true],
    ["passes on a failure before any file reached Main", 1, false],
  ])("%s", async (_name, failAt, partway) => {
    const root = await createTestScratch("dohc-merge-partway-");
    const loopback = new VersionedLoopbackEngine();
    const send = loopback.sendRequest.bind(loopback);
    let merges = 0;
    vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
      if (request.method === "conflicts.list") {
        return { id: request.id, result: { conflicts: [], nextAfterConflictId: null } };
      }
      if (request.method === VERSIONED_METHOD.versionsMerge && ++merges === failAt)
        throw new Error("disk full");
      return await send(request);
    });
    for (const path of ["a.md", "b.md"]) {
      loopback.seedTextFile({ workspace: WORKSPACE_ID, path, text: "old\n" });
      await write(root, path, "old\n");
    }
    const sessions = mockLiveSessions(loopback);
    const stores = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    );
    const engine = capture(root, { store: stores.store, rustEngineSessions: sessions });
    try {
      const draftId = (await engine.createVersion("Draft")).activeVersionId;
      for (const path of ["a.md", "b.md"]) {
        loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: draftId, path, text: "new\n" });
      }
      await engine.switchVersion("main");

      const failure = await engine.mergeVersionIntoMain(draftId).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ message: expect.stringContaining("disk full") });
      expect(failure instanceof MergeStoppedPartwayError).toBe(partway);
    } finally {
      await engine.stop();
    }
  });
});

// Daemon-path capture: `rustEngineSessions` selects the Rust engine, and the
// VersionedLoopbackEngine behind it holds real state and real sha256 — so the
// history these tests read back is recorded engine state, not a hand-written
// responder. Passing the same loopback to two captures models two sessions
// against one workspace, the way two sessions shared one engine.db before.
function liveCapture(
  root: string,
  loopback: VersionedLoopbackEngine,
  options: Omit<CaptureOptions, "rustEngineSessions"> & { requests?: Request[] } = {},
): WorkspaceEngineCapture {
  const { requests, ...rest } = options;
  const completed = new Set<string>();
  const publishing = new Proxy(loopback, {
    get(target, property, receiver) {
      if (property !== "sendRequest") return Reflect.get(target, property, receiver);
      return async (request: Request) => {
        const params = request.params as {
          createOnly?: boolean;
          path: string;
          text?: string;
          bytesBase64?: string;
          expectedSha256?: string;
        };
        const writing =
          request.method === VERSIONED_METHOD.textWrite ||
          request.method === VERSIONED_METHOD.textWriteBlob;
        const key = request.idempotencyKey ?? String(request.id);
        if (writing && !completed.has(key)) {
          const current = await readFile(join(root, params.path)).catch(() => null);
          if (params.createOnly && current !== null)
            throw new VersionedTextStoreError("target-path-exists", "target-path-exists");
          if (
            params.expectedSha256 !== undefined &&
            (current === null ||
              createHash("sha256").update(current).digest("hex") !== params.expectedSha256)
          ) {
            throw new VersionedTextStoreError(
              "write-precondition-failed",
              "write-precondition-failed",
            );
          }
        }
        const response = await target.sendRequest(request);
        if (writing && !completed.has(key)) {
          const path = join(root, params.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, params.text ?? Buffer.from(params.bytesBase64!, "base64"), {
            flag: params.createOnly ? "wx" : "w",
          });
          completed.add(key);
        }
        return response;
      };
    },
  });
  return capture(root, { rustEngineSessions: mockLiveSessions(publishing, requests), ...rest });
}

// The daemon-path equivalent of readEngineMoments: the same six facts, read
// through the engine's own timeline API. Oldest first, matching the raw
// `ORDER BY moment_order` query. Protected (secret) rows are dropped here
// exactly as a query against the text `moments` table dropped them.
async function liveMoments(engine: WorkspaceEngineCapture): Promise<EngineMomentRow[]> {
  // Drained, not capped. One 500-row page returns the newest 500, so once a
  // test records more, the reversed array stops being oldest-first and every
  // count and sequence assertion below compares against a truncated page
  // without saying so. Paging costs nothing and removes the question.
  const summaries: Awaited<ReturnType<WorkspaceEngineCapture["listMoments"]>>["moments"] = [];
  let cursor: import("@dohc/workspace-engine-client").HistoryCursor | undefined;
  for (;;) {
    const page = await engine.listMoments({
      ...(cursor === undefined ? {} : { cursor }),
    });
    summaries.push(...page.moments);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const rows: EngineMomentRow[] = [];
  for (const summary of [...summaries].reverse()) {
    if (summary.protected) continue;
    const detail = await engine.readMoment(summary.id);
    // A null detail must fail, not collapse to an empty body: `text: ""` for a
    // missing read makes a readMoment regression look like an empty file, which
    // several assertions below would accept.
    if (detail === null) {
      throw new Error(`readMoment returned null for ${summary.id} (${summary.path})`);
    }
    const payload = detail.protected === false ? detail.moment.payload : undefined;
    rows.push({
      path: summary.path,
      operation: summary.operation,
      text: payload?.after.text ?? "",
      origin: summary.metadata.origin,
      summary: summary.metadata.summary ?? null,
      correlationId: summary.metadata.correlationId ?? null,
    });
  }
  return rows;
}

async function liveMomentAuthors(
  engine: WorkspaceEngineCapture,
): Promise<Array<MomentAuthor[] | null>> {
  const page = await engine.listMoments({ limit: 500 });
  return [...page.moments]
    .reverse()
    .filter((moment) => !moment.protected)
    .map((moment) => moment.authors ?? null);
}

describe("workspaceEngineCapture batch capture", () => {
  it("uses the daemon as the sole capture and version-switch materialization owner", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "note.md",
      text: "main",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    engine.start();
    await engine.flush();
    engine.observeFileEvents([{ path: "note.md", operation: "update" }]);
    await engine.flush();
    expect(
      loopback.requests.some(
        (request) =>
          request.method === VERSIONED_METHOD.textWrite ||
          request.method === VERSIONED_METHOD.textDelete,
      ),
    ).toBe(false);

    const draft = await engine.createVersion("Draft");
    loopback.requests.length = 0;
    requests.length = 0;
    const result = await engine.switchVersion("main");

    expect(result).toEqual({
      activeVersionId: "main",
      changedFileCount: 0,
    });
    expect(
      loopback.requests.some(
        (request) =>
          request.method === VERSIONED_METHOD.textRead ||
          request.method === VERSIONED_METHOD.binaryRead ||
          request.method === VERSIONED_METHOD.textWrite ||
          request.method === VERSIONED_METHOD.textDelete,
      ),
    ).toBe(false);
    const flushIndex = requests.findIndex((request) => request.method === "capture.flush");
    expect(
      flushIndex,
      "omit the daemon flush in switchVersion. Source metadata is listed without a capture settlement between the target preflight and the before/after comparison.",
    ).toBeGreaterThanOrEqual(0);
    expect(
      requests
        .slice(flushIndex + 1)
        .some((request) => request.method === VERSIONED_METHOD.textList),
    ).toBe(true);
    expect(
      loopback.requests.some((request) => request.method === VERSIONED_METHOD.versionsSetActive),
    ).toBe(true);
    expect(draft.activeVersionId).not.toBe("main");
    await engine.stop();
  });

  it.each(["ownerPending", "engine-store-busy"] as readonly (
    | "ownerPending"
    | "declined"
    | "mismatch"
    | "engine-store-busy"
    | "live-settlement-capacity"
  )[])("defers an open adoption (%s) while another record proceeds", async (status) => {
    const root = await createTestScratch("dohc-engine-capture-");
    const path = "tasks/pending.md";
    const objectId = "pending-object";
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path,
      objectId,
      text: "# Body\n",
    });
    const sessions = mockLiveSessions(loopback);
    const liveStore = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    let pending = true;
    const transient = status === "engine-store-busy" || status === "live-settlement-capacity";
    let blocked = true;
    let healthyPending = true;
    const reconcile = vi.fn(async () => {
      healthyPending = false;
    });
    const store = new Proxy(liveStore, {
      get(target, property) {
        if (property === "flushCapture") return async () => undefined;
        if (property === "reconcileCapture") return reconcile;
        if (property === "listPendingCollectionAdoptions")
          return async () => ({
            adoptions: [
              ...(pending
                ? [
                    {
                      versionId: "main",
                      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                      collectionPath: "tasks",
                      filePath: path,
                      objectId: status === "mismatch" ? "stale-object" : objectId,
                    },
                  ]
                : []),
              ...(healthyPending
                ? [
                    {
                      versionId: "main",
                      recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
                      collectionPath: "tasks",
                      filePath: "tasks/healthy.md",
                      objectId: "healthy-object",
                    },
                  ]
                : []),
            ],
            nextCursor: null,
          });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("Name", "Manual");
    const close = vi.fn(async () => undefined);
    const evict = vi.fn(async () => undefined);
    const healthyEvict = vi.fn(async () => undefined);
    const open = vi.fn(async (input: EngineYdocProviderSessionOptions) =>
      input.path !== path
        ? ({ path: input.path, evict: healthyEvict } as unknown as EngineYdocProviderSession)
        : {
            doc,
            initialUpdate: Y.encodeStateAsUpdate(doc),
            contentKind: "richdoc" as const,
            path,
            objectId,
            versionId: "main",
            head: "present" as const,
            lineage: "existing" as const,
            unsettled: false,
            close,
            evict,
            applyLocalUpdate: async (update: Uint8Array) => {
              Y.applyUpdate(doc, update);
            },
            adoptCollectionRecord: async () => {
              if (transient && blocked) {
                throw new DaemonRefusalError(
                  { code: "OVERLOADED", message: status, retry: "afterBackoff" },
                  undefined,
                );
              }
              if (transient) {
                pending = false;
                doc.getMap("frontmatter").set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa");
                return "settled" as const;
              }
              if (status === "ownerPending")
                doc.getMap("frontmatter").set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa");
              return status === "declined" ? ("declined" as const) : ("ownerPending" as const);
            },
            settleNow: async () => {
              throw new YdocOwnerDraftPendingError({
                binding: {
                  workspaceId: WORKSPACE_ID,
                  mainVersionId: "main",
                  objectId,
                  lineageClaimId: "a".repeat(64),
                  currentPath: path,
                  selectorPaths: [path],
                  restoreFenceGeneration: 0,
                },
                relayDatabaseNamespace: "relay",
                revision: 1,
                acceptedCursor: 0,
                nativeHeadSequence: 1,
                nativeUnsettled: false,
                outboxId: "outbox",
                pendingBytes: 20,
                state: "active",
              });
            },
          },
    );
    const errors: unknown[] = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: open,
      onError: (_context, error) => errors.push(error),
    });
    const session = await engine.openYDocSession({
      path,
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
    });
    await engine.flush();
    expect(session.doc.getMap("frontmatter").toJSON()).toEqual(
      status === "ownerPending"
        ? { Name: "Manual", id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa" }
        : { Name: "Manual" },
    );
    expect(open).toHaveBeenCalledTimes(2);
    // The note open and the record's adoption both read a seed past the
    // in-band cap, up to the WYSIWYG editor's limit.
    for (const [options] of open.mock.calls) {
      expect(options).toMatchObject({
        largeSeed: { workspaceId: WORKSPACE_ID, maxBytes: WYSIWYG_MARKDOWN_THRESHOLD_BYTES },
      });
    }
    expect(healthyEvict).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(evict).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    healthyPending = true;
    reconcile.mockRejectedValueOnce(
      new DaemonRefusalError(
        {
          code: "INTERNAL",
          message: "reconciliation-failed",
          retry: "no",
        },
        undefined,
      ),
    );
    await expect(engine.flush()).rejects.toThrow("reconciliation-failed");
    healthyPending = false;
    if (transient) blocked = false;
    else pending = false;
    await engine.flush();
    expect(pending).toBe(false);
    if (transient)
      expect(session.doc.getMap("frontmatter").get("id")).toBe("rec_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(errors).toEqual([]);
    await session.close({ settle: false });
    await engine.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("releases the old collection adoption provider before reopening after a transport rebind", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/rebound.md",
      objectId: "object-rebound",
    };
    let completed = false;
    let reconciles = 0;
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => {
        reconciles += 1;
      },
      listPendingCollectionAdoptions: async () => ({
        adoptions: completed ? [] : [adoption],
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const firstClient = {};
    const replacementClient = {};
    const transportFailure = Object.assign(new Error("daemon transport replaced"), {
      code: "transport-error",
    });
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) => {
        try {
          return await task({ client: firstClient, workspace: "first-workspace" });
        } catch (error) {
          if (error !== transportFailure) throw error;
          return await task({
            client: replacementClient,
            workspace: "replacement-workspace",
          });
        }
      },
    } as unknown as EngineWorkspaceSessions;
    const openedTransports: unknown[] = [];
    const evictedTransports: unknown[] = [];
    const activeTransports = new Set<unknown>();
    const activeProviderCountsAtOpen: number[] = [];
    let firstProviderEvictions = 0;
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) => {
        activeProviderCountsAtOpen.push(activeTransports.size);
        if (activeTransports.size > 0) {
          throw new DaemonRefusalError(
            {
              code: "INVALID_PARAMS",
              message: "ydoc-session-busy",
              retry: "no",
            },
            undefined,
          );
        }
        openedTransports.push(options.transport);
        activeTransports.add(options.transport);
        return {
          path: options.path,
          evict: async () => {
            evictedTransports.push(options.transport);
            if (options.transport === firstClient && firstProviderEvictions++ === 0) {
              throw transportFailure;
            }
            activeTransports.delete(options.transport);
            completed = true;
          },
        } as EngineYdocProviderSession;
      },
    });

    await engine.flush();

    expect(completed).toBe(true);
    expect(openedTransports).toEqual([firstClient, replacementClient]);
    expect(evictedTransports).toEqual([firstClient, firstClient, replacementClient]);
    expect(activeProviderCountsAtOpen).toEqual([0, 0]);
    expect(activeTransports.size).toBe(0);
    expect(reconciles).toBe(1);
    expect(errors).toEqual([]);
    await engine.stop();
  });

  it("serializes overlapping collection adoption drains and preserves a busy provider", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/busy-overlap.md",
      objectId: "object-busy-overlap",
    };
    const firstListingEntered = deferred();
    const releaseListings = deferred();
    let activeListings = 0;
    let maxActiveListings = 0;
    let completed = false;
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => undefined,
      listPendingCollectionAdoptions: async () => {
        activeListings += 1;
        maxActiveListings = Math.max(maxActiveListings, activeListings);
        firstListingEntered.resolve();
        await releaseListings.promise;
        activeListings -= 1;
        return {
          adoptions: completed ? [] : [adoption],
          nextCursor: null,
        };
      },
    } as unknown as CaptureVersionedTextStore;
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      undefined,
    );
    const sessionBusy = new DaemonRefusalError(
      {
        code: "INVALID_PARAMS",
        message: "ydoc-session-busy",
        retry: "no",
      },
      undefined,
    );
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    let opens = 0;
    let evictionAttempts = 0;
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        if (opens > 1) throw sessionBusy;
        return {
          path: options.path,
          evict: async () => {
            evictionAttempts += 1;
            if (evictionAttempts === 1) throw busy;
            completed = true;
          },
        } as EngineYdocProviderSession;
      },
    });

    const firstFlush = engine.flush();
    await firstListingEntered.promise;
    const overlappingFlush = engine.flush();
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    releaseListings.resolve();
    await Promise.all([firstFlush, overlappingFlush]);

    await engine.flush();

    expect(maxActiveListings).toBe(1);
    expect(opens).toBe(1);
    expect(evictionAttempts).toBe(2);
    expect(completed).toBe(true);
    expect(errors).toEqual([]);
    await engine.stop();
  });

  it("removes a renamed accepted response and preserves replacements on retry", async () => {
    const root = await createTestScratch("dohc-response-undo-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const requests: Request[] = [];
    const sessions = mockLiveSessions(new VersionedLoopbackEngine(), requests);
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    const created = await store.writeTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: "responses/accepted-a.md",
      text: "response",
      metadata: { origin: "api" },
    });
    const getMoment = store.getMoment.bind(store);
    vi.spyOn(store, "getMoment").mockImplementation(async (input) => {
      const moment = await getMoment(input);
      return moment?.id === created.moment.id
        ? { ...moment, authors: [{ kind: "public", principalId: "public-a", grantId: "grant" }] }
        : moment;
    });
    await store.renameTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      fromPath: created.snapshot.path,
      toPath: "responses/moved.md",
      metadata: { origin: "api" },
    });
    await write(root, "responses/moved.md", "response");
    const engine = capture(root, { store, rustEngineSessions: sessions });
    const selection = {
      acceptanceId: "accepted-a",
      objectId: created.object.id,
      momentId: created.moment.id,
      path: created.snapshot.path,
      collectionPath: "responses",
      versionId: "main",
      publicPrincipalId: "public-a",
      grantId: "grant",
      requestId: "undo-a",
    };
    requests.length = 0;
    const result = await engine.undoAcceptedAppResponse(selection);
    expect(requests.filter((request) => request.method === VERSIONED_METHOD.textList)).toHaveLength(
      0,
    );
    expect(result.status).toBe("deleted");
    expect(result.momentId).toBeTruthy();
    expect(existsSync(join(root, "responses/moved.md"))).toBe(false);
    const deletion = requests.findLast((request) => request.method === "versionedText.delete");
    expect(deletion).toMatchObject({
      idempotencyKey: "undo-a",
      params: { path: "responses/moved.md", expectedObjectId: created.object.id },
    });
    expect(deletion?.params).not.toHaveProperty("requestId");
    await engine.stop();
    const reopened = capture(root, { store, rustEngineSessions: sessions });
    // Another object now occupies the deleted path; retries cannot touch it.
    await store.writeTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: "responses/moved.md",
      text: "replacement",
      metadata: { origin: "api" },
    });
    await write(root, "responses/moved.md", "replacement");
    const retry = await reopened.undoAcceptedAppResponse(selection);
    expect(retry).toEqual({ status: "deleted", momentId: result.momentId });
    expect(await readFile(join(root, "responses/moved.md"), "utf8")).toBe("replacement");
    expect(requests.filter((request) => request.method === "versionedText.delete")).toHaveLength(1);
    await reopened.stop();
  });

  it("pages response history and recovers an interrupted deletion without deleting a restore", async () => {
    const root = await createTestScratch("dohc-response-recovery-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const requests: Request[] = [];
    const sessions = mockLiveSessions(new VersionedLoopbackEngine(), requests);
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    const created = await store.writeTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: "responses/accepted-a.md",
      text: "response",
      metadata: { origin: "api" },
    });
    const listMoments = store.listMoments.bind(store);
    vi.spyOn(store, "listMoments").mockImplementation((input) =>
      listMoments({ ...input, limit: Math.min(input.limit ?? 2, 2) }),
    );
    const getMoment = store.getMoment.bind(store);
    vi.spyOn(store, "getMoment").mockImplementation(async (input) => {
      const moment = await getMoment(input);
      return moment?.id === created.moment.id
        ? { ...moment, authors: [{ kind: "public", principalId: "public-a", grantId: "grant" }] }
        : moment;
    });
    const selection = {
      acceptanceId: "accepted-a",
      objectId: created.object.id,
      momentId: created.moment.id,
      path: created.snapshot.path,
      collectionPath: "responses",
      versionId: "main",
      publicPrincipalId: "public-a",
      grantId: "grant",
      requestId: "undo-a",
    };
    const engine = capture(root, { store, rustEngineSessions: sessions });
    for (let i = 0; i < 3; i++)
      await store.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: created.snapshot.path,
        text: `response ${i}`,
        metadata: { origin: "api" },
      });
    await write(root, created.snapshot.path, "response 2");
    const deleted = await engine.undoAcceptedAppResponse(selection);
    expect(deleted.status).toBe("deleted");
    // Recreate the bytes left by a crash between native commit and materialization.
    await write(root, created.snapshot.path, "response 2");
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual(deleted);
    expect(existsSync(join(root, created.snapshot.path))).toBe(false);
    await engine.restoreFileToBeforeMoment(deleted.momentId!, RESTORER);
    expect(
      requests.filter((request) => request.method === "versionedText.write").at(-1)?.params,
    ).toMatchObject({
      restoreBeforeMomentId: deleted.momentId,
      origin: "restore",
    });
    for (let i = 0; i < 3; i++)
      await store.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: created.snapshot.path,
        text: `restored ${i}`,
        metadata: { origin: "api" },
      });
    await write(root, created.snapshot.path, "restored 2");
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual(deleted);
    expect(await readFile(join(root, created.snapshot.path), "utf8")).toBe("restored 2");
    expect(requests.filter((request) => request.method === "versionedText.delete")).toHaveLength(1);
    await engine.stop();
  });

  it("refuses response removal with forged public attribution or uncaptured disk edits", async () => {
    const root = await createTestScratch("dohc-response-conflict-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    const created = await store.writeTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: "responses/accepted-a.md",
      text: "response",
      metadata: { origin: "api" },
    });
    await write(root, created.snapshot.path, "disk edit");
    const engine = capture(root, { store, rustEngineSessions: sessions });
    const selection = {
      acceptanceId: "accepted-a",
      objectId: created.object.id,
      momentId: created.moment.id,
      path: created.snapshot.path,
      collectionPath: "responses",
      versionId: "main",
      publicPrincipalId: "public-a",
      grantId: "grant",
      requestId: "undo-a",
    };
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({ status: "conflict" });
    const getMoment = store.getMoment.bind(store);
    vi.spyOn(store, "getMoment").mockImplementation(async (input) => {
      const moment = await getMoment(input);
      return moment?.id === created.moment.id
        ? { ...moment, authors: [{ kind: "public", principalId: "public-a", grantId: "grant" }] }
        : moment;
    });
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({ status: "conflict" });
    expect(await readFile(join(root, created.snapshot.path), "utf8")).toBe("disk edit");
    await engine.stop();
  });

  it.each(["present"])(
    "explains a shared live file restore refusal with the artifact %s",
    async (artifact) => {
      const root = await createTestScratch("dohc-live-restore-refusal-");
      let deletionAttempts = 0;
      const sessions = mockLiveSessions(
        new VersionedLoopbackEngine(),
        undefined,
        undefined,
        (request) => {
          if (request.method === "versionedText.delete") {
            deletionAttempts += 1;
            throw new DaemonRefusalError(
              { code: "INVALID_PARAMS", message: "live-document-binding-active", retry: "no" },
              new Error("daemon response"),
            );
          }
        },
      );
      const store = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
        sessions,
      ).store;
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      const created = await store.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "shared.md",
        text: "original",
        metadata: { origin: "api" },
      });
      if (artifact === "present") await write(root, "shared.md", "original");
      const engine = capture(root, { store, rustEngineSessions: sessions });
      await expect(engine.restoreFileToBeforeMoment(created.moment.id, RESTORER)).rejects.toThrow(
        "dohc could not restore shared.md. This action is unavailable for shared live files.",
      );
      expect(deletionAttempts).toBe(1);
      expect(
        (
          await store.readTextFile({
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            path: "shared.md",
          })
        )?.text,
      ).toBe("original");
      if (artifact === "present")
        expect(await readFile(join(root, "shared.md"), "utf8")).toBe("original");
      else expect(existsSync(join(root, "shared.md"))).toBe(false);
      await engine.stop();
    },
  );

  it.each(["moment"])("admits the %s path inside restore before any mutation", async (side) => {
    const root = await createTestScratch("dohc-restore-path-admission-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    const target = {
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: "notes/a.md",
      metadata: { origin: "api" as const },
    };
    await store.writeTextFile({ ...target, text: "old" });
    const changed = await store.writeTextFile({ ...target, text: "current" });
    await write(root, target.path, "current");
    await write(root, ".dohc/files.toml", '[[rule]]\npath = "private/**"\ntracked = false\n');
    const original = changed.moment;
    vi.spyOn(store, "getMoment").mockResolvedValue({
      ...original,
      path: side === "moment" ? "private/a.md" : original.path,
      payload: {
        before: {
          ...original.payload.before!,
          path: side === "before" ? "private/a.md" : target.path,
        },
        after: { ...original.payload.after, path: side === "after" ? "private/a.md" : target.path },
      },
    });
    const engine = capture(root, { store, rustEngineSessions: sessions });
    try {
      await expect(engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER)).rejects.toThrow(
        "This history moment is no longer available.",
      );
      expect((await store.readTextFile(target))?.text).toBe("current");
      expect(
        (await store.listMoments({ workspaceId: WORKSPACE_ID, limit: 20 })).moments,
      ).toHaveLength(2);
      expect(await readFile(join(root, target.path), "utf8")).toBe("current");
    } finally {
      await engine.stop();
    }
  });

  it.each(["untracked", "malformed"])(
    "reads %s policy inside the queued restore before writing",
    async (state) => {
      const root = await createTestScratch("dohc-restore-queued-policy-");
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const store = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
        sessions,
      ).store;
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      const target = {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "notes/a.md",
        metadata: { origin: "api" as const },
      };
      await store.writeTextFile({ ...target, text: "old" });
      const changed = await store.writeTextFile({ ...target, text: "current" });
      await write(root, target.path, "current");
      const entered = deferred<void>();
      const release = deferred<void>();
      const originalList = store.listMoments.bind(store);
      vi.spyOn(store, "flushCapture").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const engine = capture(root, { store, rustEngineSessions: sessions });
      const pendingList = engine.flush();
      await entered.promise;
      const pendingRestore = engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER);
      const refused = expect(pendingRestore).rejects.toMatchObject({
        name: "RestorePolicyRefusalError",
        reason: state === "malformed" ? "policy-unreadable" : "path-not-admitted",
        message: expect.stringContaining(
          state === "malformed" ? "files.toml" : "This history moment is no longer available.",
        ),
      });
      await write(
        root,
        ".dohc/files.toml",
        state === "malformed"
          ? "[[rules] invalid"
          : '[[rule]]\npath = "notes/**"\ntracked = false\n',
      );
      release.resolve();
      await pendingList;
      try {
        await refused;
        expect((await store.readTextFile(target))?.text).toBe("current");
        expect((await originalList({ workspaceId: WORKSPACE_ID, limit: 20 })).moments).toHaveLength(
          2,
        );
        expect(await readFile(join(root, target.path), "utf8")).toBe("current");
      } finally {
        await engine.stop();
      }
    },
  );

  it("preserves the outside file when History restore publication conflicts", async () => {
    const root = await createTestScratch("dohc-restore-conflict-");
    const loopback = new VersionedLoopbackEngine();
    let conflict = false;
    const send = loopback.sendRequest.bind(loopback);
    vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
      const response = await send(request);
      if (conflict && request.method === VERSIONED_METHOD.textWrite) {
        await write(root, "note.txt", "outside edit");
        return {
          ...response,
          result: {
            ...(response.result as Record<string, JsonValue>),
            materialized: false,
            materializeOutcome: "conflict",
          },
        };
      }
      return response;
    });
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    const target = {
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: "note.txt",
      metadata: { origin: "api" as const },
    };
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    await store.writeTextFile({ ...target, text: "original" });
    const changed = await store.writeTextFile({ ...target, text: "current" });
    await write(root, target.path, "current");
    conflict = true;
    const engine = capture(root, { store, rustEngineSessions: sessions });
    await expect(
      engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER),
    ).rejects.toBeInstanceOf(AuthoredTextChangedError);
    expect(await readFile(join(root, target.path), "utf8")).toBe("outside edit");
    await engine.stop();
  });

  it("keeps a live note's held outside change as a copy and puts the note's text back", async () => {
    const root = await createTestScratch("dohc-keep-outside-change-");
    const workspace = {
      workspaceId: WORKSPACE_ID,
      rootPath: root,
      attachmentId: WORKSPACE_ATTACHMENT_ID,
    };
    await openedLocalState(workspace);
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores(workspace, sessions).store;
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path: "note.md" };
    await liveStore.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    await liveStore.writeTextFile({ ...target, text: "the note\n", metadata: { origin: "api" } });
    await write(root, "note.md", "written outside dohc\n");
    // The engine holds the change until a capture finds the note's text in the file.
    let held = [{ path: "note.md", firstObservedAtMs: 1 }];
    // Captures an open editor's session deferred.
    let deferred: string[] = [];
    const store = new Proxy(liveStore, {
      get(target, property) {
        if (property === "watcherStatus")
          return async () => ({
            running: true,
            degraded: false,
            terminal: false,
            deferredWrites: deferred,
            outsideChanges: held,
          });
        // Capture elsewhere in the workspace has not settled until Keep's own
        // write puts the note's text back.
        if (property === "flushCapture")
          return async () => {
            // The editor closed, so the capture it deferred runs and is held.
            if (deferred.length > 0) {
              held = deferred.map((path) => ({ path, firstObservedAtMs: 2 }));
              deferred = [];
              return;
            }
            if ((await readFile(join(root, "note.md"), "utf8")) !== "the note\n")
              throw new Error("Capture has not settled.");
            held = [];
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outsideChanges = vi.fn();
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onOutsideChanges: outsideChanges,
    });
    try {
      await expect(engine.keepOutsideChange("other.md")).resolves.toBe(false);
      await expect(engine.keepOutsideChange("note.md")).resolves.toBe(true);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe("the note\n");
      const copies = (await readdir(root)).filter((name) => name !== "note.md" && name !== ".dohc");
      expect(copies).toHaveLength(1);
      expect(await readFile(join(root, copies[0]!), "utf8")).toBe("written outside dohc\n");
      expect(outsideChanges).toHaveBeenLastCalledWith([]);
      await expect(engine.keepOutsideChange("note.md")).resolves.toBe(false);

      // A Stop closed an editor whose session deferred the capture of a second change.
      await write(root, "note.md", "written outside again\n");
      deferred = ["note.md"];
      await expect(engine.keepOutsideChange("note.md")).resolves.toBe(true);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe("the note\n");
      const kept = (await readdir(root)).filter((name) => name !== "note.md" && name !== ".dohc");
      expect(kept).toHaveLength(2);
    } finally {
      await engine.stop();
      await liveStore.close();
    }
  });

  it("cancels an unsettled flush before queued session retirement and refuses later flushes", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const polling = deferred<void>();
    let settled = true;
    const sessions = mockLiveSessions(loopback, requests, () => {
      if (!settled) polling.resolve();
      return { deferredWrites: [], settled, running: true, heldFiles: [], degraded: !settled };
    });
    const closeWorkspace = vi.spyOn(sessions, "closeWorkspace");
    const engine = capture(root, { rustEngineSessions: sessions });
    await engine.createVersion("Draft");
    requests.length = 0;
    settled = false;
    const flushing = engine.flush().catch((error: unknown) => error);
    await polling.promise;
    engine.beginShutdown();
    const lateFlush = engine.flush().catch((error: unknown) => error);
    expect(await lateFlush).toMatchObject({ name: "AbortError" });
    const retiring = engine.settleAndCloseAllLiveSessions();
    expect(await flushing).toMatchObject({ name: "AbortError" });
    expect(await lateFlush).toMatchObject({ name: "AbortError" });
    await retiring;
    await engine.stop();
    expect(requests.filter((request) => request.method === "capture.flush")).toHaveLength(1);
    expect(closeWorkspace).toHaveBeenCalledTimes(2);
  });

  it("keeps saves accepted before shutdown and refuses other waiting work and later saves", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const person = { kind: "human", humanId: "local-person" } as const;
    const admitted = deferred<void>();
    const release = deferred<void>();
    try {
      const kept = engine
        .writeAuthoredFile(join(root, "kept.md"), "kept\n", person, {
          beforeWrite: async () => {
            admitted.resolve();
            await release.promise;
          },
        })
        .catch((error: unknown) => error);
      await admitted.promise;
      // Both wait behind the running save when quit starts.
      const count = engine.compareVersionsChangedCount("main").catch((error: unknown) => error);
      const queued = engine
        .writeAuthoredFile(join(root, "queued.md"), "queued\n", person)
        .catch((error: unknown) => error);
      engine.beginShutdown();
      const late = engine
        .writeAuthoredFile(join(root, "late.md"), "late\n", person)
        .catch((error: unknown) => error);
      release.resolve();
      expect(await kept).toMatchObject({ materializeOutcome: "applied" });
      expect(await count, "Work that isn't a save still stops at quit").toMatchObject({
        name: "AbortError",
      });
      expect(await queued, "A save queued before quit still lands").toMatchObject({
        materializeOutcome: "applied",
      });
      expect(await late).toMatchObject({ name: "AbortError" });
      expect(await readFile(join(root, "kept.md"), "utf8")).toBe("kept\n");
      expect(await readFile(join(root, "queued.md"), "utf8")).toBe("queued\n");
      expect(existsSync(join(root, "late.md"))).toBe(false);
    } finally {
      release.resolve();
      await engine.stop();
    }
  });

  it.each(["failed"] as readonly ("cancelled" | "failed")[])(
    "releases Collection providers when shutdown reconciliation is %s",
    async (outcome) => {
      const root = await createTestScratch("dohc-engine-capture-");
      const failure = new Error("Collection reconciliation failed.");
      let pending = false;
      const evict = vi.fn(async () => {
        pending = false;
      });
      const store = {
        ensureMainVersion: async () => undefined,
        listPendingCollectionAdoptions: async () => ({
          adoptions: pending
            ? [
                {
                  versionId: "main",
                  recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                  collectionPath: "tasks",
                  filePath: "tasks/record.md",
                  objectId: "record-object",
                },
              ]
            : [],
          nextCursor: null,
        }),
        // Reconciliation can start a convergence flush after evicting a provider.
        reconcileCapture: async () => {
          if (outcome === "failed") throw failure;
          await engine.flush();
        },
      } as unknown as CaptureVersionedTextStore;
      const engine = capture(root, {
        store,
        openRustYDocProviderSession: async (input) =>
          ({ path: input.path, evict }) as unknown as EngineYdocProviderSession,
      });
      await engine.flush();
      pending = true;
      engine.beginShutdown();
      const stopped = engine.stop();
      if (outcome === "cancelled") await expect(stopped).resolves.toBeUndefined();
      else await expect(stopped).rejects.toBe(failure);
      expect(evict).toHaveBeenCalledTimes(1);
      expect(pending).toBe(false);
    },
  );

  it("mutation proof: installs remote updates buffered during the initial Y.Doc open", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "note.md",
      text: "seed",
    });
    const baseDoc = new Y.Doc();
    baseDoc.getText("content").insert(0, "base");
    const staleInitialUpdate = Y.encodeStateAsUpdate(baseDoc);
    const daemonDoc = new Y.Doc();
    Y.applyUpdate(daemonDoc, staleInitialUpdate);
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, staleInitialUpdate);
    remoteDoc.getText("content").insert(4, "+remote");
    const bufferedUpdate = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(daemonDoc));
    const forwarded: Uint8Array[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        Y.applyUpdate(daemonDoc, bufferedUpdate);
        options.onRemoteUpdate(bufferedUpdate);
        return {
          doc: daemonDoc,
          initialUpdate: staleInitialUpdate,
          contentKind: "plaintext",
          path: "note.md",
          head: "present" as const,
          lineage: "existing" as const,
          unsettled: false,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => ({ sha256: "a".repeat(64), content: "" }) as never,
          close: async () => undefined,
        };
      },
    });

    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: (update) => forwarded.push(update),
    });
    const rendererDoc = new Y.Doc();
    Y.applyUpdate(rendererDoc, session.initialUpdate);

    expect(rendererDoc.getText("content").toString()).toBe("base+remote");
    expect(forwarded).toEqual([bufferedUpdate]);
    await session.close({ settle: false });
    await engine.stop();
  });

  it("reports failed draft preservation through the existing edit error hook and refuses release", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/a.md",
      text: "seed",
    });
    const draftError = new Error("Draft storage refused.");
    const notices = vi.fn();
    const errors = vi.fn();
    const released = vi.fn();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      onError: errors,
      preserveUnsentState: async () => {
        throw draftError;
      },
      openRustYDocProviderSession: async (options) => {
        const doc = new Y.Doc();
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          objectId: "object-note",
          contentKind: "richdoc",
          path: options.path,
          head: "present",
          lineage: "existing",
          unsettled: false,
          applyLocalUpdate: async () => undefined,
          evict: async () => undefined,
          settleNow: async () => ({ sha256: "a".repeat(64), content: "seed" }) as never,
          close: async () => {
            await options.preserveUnsentState!(doc);
            released();
          },
        } as EngineYdocProviderSession;
      },
    });
    const session = await engine.openYDocSession({
      path: "notes/a.md",
      onRemoteUpdate: () => undefined,
      onEditRefused: notices,
    });
    await expect(session.close({ settle: false })).rejects.toBe(draftError);
    expect(released).not.toHaveBeenCalled();
    expect(notices).toHaveBeenCalledWith(
      "draft-preservation",
      "Unsent changes to a.md are not saved. Draft storage refused. Copy them from the open document before you quit dohc.",
    );
    expect(errors).toHaveBeenCalledWith("draft preservation of notes/a.md", draftError);
    await engine.stop();
  });

  it("keeps a draft that is current again while another document's retry removes its older write", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const draftDirectory = await createTestScratch("dohc-engine-capture-drafts-");
    const loopback = new VersionedLoopbackEngine();
    for (const path of ["notes/a.md", "notes/b.md"])
      loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: "main", path, text: "seed" });
    const stale = new DaemonRefusalError(
      { code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" },
      undefined,
    );
    const store = workspaceDraftStore(draftDirectory, WORKSPACE_ID, {
      all: () => [],
      workspaceIdOf: () => undefined,
    });
    const preserveUnsentState = vi.fn(store.preserveUnsentState);
    let refusals = 1;
    const retry = {
      held: deferred<void>(),
      holding: deferred<void>(),
      done: deferred<void>(),
      handle: "",
    };
    const discardUnsentState = vi.fn(async (handle: string) => {
      if (refusals-- > 0) throw new Error("The draft store is busy.");
      if (handle !== retry.handle) return await store.discardUnsentState(handle);
      retry.holding.resolve();
      await retry.held.promise;
      await store.discardUnsentState(handle);
      retry.done.resolve();
    });
    const writes = new Map<string, boolean>();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      onError: () => undefined,
      preserveUnsentState,
      discardUnsentState,
      openRustYDocProviderSession: async (options) => {
        const doc = new Y.Doc();
        doc.getText("plainText").insert(0, "typed");
        let tokens = 0;
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          objectId: `object-${options.path}`,
          contentKind: "plaintext",
          path: options.path,
          head: "present",
          lineage: "existing",
          unsettled: false,
          applyLocalUpdate: async () => undefined,
          evict: async () => undefined,
          settleNow: async () => {
            const token = ++tokens;
            options.onSettleStart?.(token);
            if (!writes.get(options.path)) {
              options.onSettleError?.(stale, token);
              throw stale;
            }
            const result = {
              sha256: createHash("sha256").update("typed").digest("hex"),
              content: "typed",
              materialized: true,
            };
            await options.onSettled?.(result as never, token);
            return result as never;
          },
          close: async () => undefined,
        } as EngineYdocProviderSession;
      },
    });
    const a = await engine.openYDocSession({ path: "notes/a.md", onRemoteUpdate: () => undefined });
    const b = await engine.openYDocSession({ path: "notes/b.md", onRemoteUpdate: () => undefined });
    const handleOf = async (call: number) => await preserveUnsentState.mock.results[call]!.value;

    await expect(a.settleNow()).rejects.toBe(stale);
    await vi.waitFor(() => expect(preserveUnsentState).toHaveBeenCalledOnce());
    retry.handle = await handleOf(0);
    await write(root, "notes/a.md", "typed");
    writes.set("notes/a.md", true);
    await a.settleNow();
    await vi.waitFor(() => expect(discardUnsentState).toHaveBeenCalledOnce());

    await expect(b.settleNow()).rejects.toBe(stale);
    await retry.holding.promise;
    await rm(join(root, "notes/a.md"));
    writes.set("notes/a.md", false);
    await expect(a.settleNow()).rejects.toBe(stale);
    await vi.waitFor(() => expect(preserveUnsentState).toHaveBeenCalledTimes(3));
    expect((await handleOf(2)).split(":")[0]).toBe(retry.handle.split(":")[0]);
    retry.held.resolve();
    await retry.done.promise;

    expect(
      (await listLiveDraftRecovery(draftDirectory, WORKSPACE_ID))
        .map(({ path, text }) => `${path}: ${text}`)
        .sort(),
    ).toEqual(["notes/a.md: typed", "notes/b.md: typed"]);
    await a.close();
    await b.close();
    await engine.stop();
  });

  // The engine owns the.md: it materializes a changed projection and
  // leaves a drifted file alone. The desktop mirrored the settled content
  // over the file anyway, so an edit made outside dohc while the document was
  // open vanished from disk. The desktop no longer writes here at all, and
  // every case below drives the real onSettled against a real file; only the
  // daemon session is a fake, and it calls onSettled exactly where
  // ydocProviderSession's runSettle does.
  function driftFixture(settled: { sha256: string; content: string | null; path?: string }) {
    return async (options: EngineYdocProviderSessionOptions) => {
      const doc = new Y.Doc();
      return {
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext",
        path: settled.path ?? "note.md",
        // Stated by hand: `as never` below stops tsc checking this literal, and
        // an absent `head` would silently disable the absent-head refusal for
        // every drift case here.
        head: "present" as const,
        // A fresh document: an existing lineage would settle once at open.
        lineage: "absent" as const,
        evict: async () => undefined,
        applyLocalUpdate: async () => undefined,
        settleNow: async () => {
          await options.onSettled?.({ ...settled, materialized: true } as never, 1);
          return settled as never;
        },
        close: async (closeOptions?: { settle?: boolean }) => {
          if (closeOptions?.settle === false) return;
          await options.onSettled?.({ ...settled, materialized: true } as never, 2);
        },
      } as never;
    };
  }

  const EDITOR_TEXT = "typed in dohc\n";

  // Containment, the same invariant the disk writer holds: a parent directory
  // replaced by a link out of the workspace must not be read through. A file
  // out there whose bytes matched would otherwise report a save — and arm a
  // self-write suppression — for an artifact that is not in the workspace.
  it("refuses to read the settled file through a folder that leaves the workspace", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await write(outside, "note.md", EDITOR_TEXT);
    let linked = true;
    try {
      // A junction needs no privilege on Windows; symlink elsewhere.
      await symlink(
        join(outside),
        join(root, "notes"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      linked = false;
    }
    if (!linked) return;

    const states: string[] = [];
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: driftFixture({
        sha256: sha256Utf8(EDITOR_TEXT),
        content: EDITOR_TEXT,
        path: "notes/note.md",
      }),
    });
    const session = await engine.openYDocSession({
      path: "notes/note.md",
      onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state),
    });
    await session.close();
    await engine.stop();

    expect(
      states,
      "drop the containment check and the matching file outside the workspace reports ['saved'].",
    ).toEqual(["error"]);
    expect(String(errors[0]?.error)).toContain("outside the workspace");
  });

  it("mutation proof: polls daemon watcher degradation after startup", async () => {
    vi.useFakeTimers();
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      let degraded = false;
      const outcomes: boolean[] = [];
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(
        {
          workspaceId: WORKSPACE_ID,
          rootPath: root,
          attachmentId: WORKSPACE_ATTACHMENT_ID,
        },
        sessions,
      ).store;
      const daemonStore = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus") {
            return async () => ({
              running: true,
              degraded,
              terminal: false,
              deferredWrites: [],
            });
          }
          if (property === "flushCapture") return async () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const engine = capture(root, {
        store: daemonStore,
        rustEngineSessions: sessions,
        onCaptureOutcome: (failure) => outcomes.push(failure === null),
      });
      try {
        engine.start();
        await engine.flush();
        degraded = true;
        await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
        await engine.flush();

        expect(outcomes).toEqual([true, false]);
      } finally {
        try {
          await engine.stop();
        } finally {
          await liveStore.close();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["malformed receipt"])(
    "isolates %s from health reports and native kept copies",
    async (damage) => {
      vi.useFakeTimers();
      const root = await createTestScratch("copy-record-health-");
      const workspace = {
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        attachmentId: WORKSPACE_ATTACHMENT_ID,
      };
      await openedLocalState(workspace);
      await write(root, "n.md", "outside");
      const copies = outsideWriteCopies(workspace);
      await copies.beforeWrite(
        "n.md",
        null,
        () => undefined,
        async () => false,
      );
      const originalRows = await copies.list();
      const folder = join(root, ".dohc/local/outside-write-copies");
      const broken = damage === "malformed receipt" ? join(folder, "broken.json") : folder;
      if (damage === "file at receipt folder") await rm(folder, { recursive: true });
      await writeFile(broken, "invalid");
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(workspace, sessions).store;
      const adoptions = vi.fn(async () => ({ adoptions: [], nextCursor: null }));
      const native = { keptCopies: [{ id: 1, path: "native.md", keptAtMs: 1 }], more: false };
      const store = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus")
            return async () => ({
              running: true,
              degraded: false,
              terminal: false,
              deferredWrites: [],
              keptFiles: [["native.md", "saved-native.md"]],
              retainedCopies: { count: 2, bytes: 20 },
              recoveryUnavailable: true,
              secretKeyUnavailable: "key-missing",
              heldFiles: [],
            });
          if (property === "listKeptCopies") return async () => native;
          if (property === "listPendingCollectionAdoptions") return adoptions;
          if (property === "flushCapture") return async () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const kept = vi.fn(),
        retained = vi.fn(),
        recovery = vi.fn(),
        secretKey = vi.fn(),
        held = vi.fn(),
        outside = vi.fn();
      const outcomes = vi.fn(),
        errors = vi.fn();
      const engine = capture(root, {
        store,
        rustEngineSessions: sessions,
        onKeptFiles: kept,
        onRetainedCopies: retained,
        onRecoveryUnavailable: recovery,
        onSecretKeyUnavailable: secretKey,
        onHeldFiles: held,
        onOutsideWriteCopies: outside,
        onCaptureOutcome: outcomes,
        onError: errors,
      });
      try {
        engine.start();
        await engine.flush();
        expect(kept).toHaveBeenCalledWith([["native.md", "saved-native.md"]]);
        expect(retained).toHaveBeenCalledWith({ count: 2, bytes: 20 });
        expect(recovery).toHaveBeenCalledWith(true);
        expect(secretKey).toHaveBeenCalledWith("key-missing");
        expect(held).toHaveBeenCalledWith([]);
        expect(adoptions).toHaveBeenCalled();
        expect(outcomes).toHaveBeenLastCalledWith(null, null);
        expect(errors).not.toHaveBeenCalled();
        const rows = damage === "malformed receipt" ? originalRows : null;
        expect(outside).toHaveBeenCalledExactlyOnceWith(rows, expect.stringContaining(broken));
        expect(await engine.listKeptCopies()).toEqual({
          ...native,
          ...(rows === null ? {} : { outsideWriteCopies: rows }),
          protectedCopies: [],
        });
        await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
        await engine.flush();
        expect(outside).toHaveBeenCalledOnce();
        expect(held).toHaveBeenCalledTimes(2);
        await rm(broken);
        if (damage === "file at receipt folder") await mkdir(folder);
        await engine.listKeptCopies();
        expect(outside).toHaveBeenLastCalledWith(rows ?? [], null);
      } finally {
        await engine.stop();
        await liveStore.close();
        vi.useRealTimers();
      }
    },
  );

  it.each([true])(
    "coalesces blocked capture health polls and resumes after failure=%s",
    async (failFirst) => {
      vi.useFakeTimers();
      const root = await createTestScratch("dohc-engine-capture-");
      await openedLocalState({
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        attachmentId: WORKSPACE_ATTACHMENT_ID,
      });
      const entered = deferred();
      const release = deferred();
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(
        {
          workspaceId: WORKSPACE_ID,
          rootPath: root,
          attachmentId: WORKSPACE_ATTACHMENT_ID,
        },
        sessions,
      ).store;
      const recovery = vi.fn();
      const outside = vi.fn();
      const watcherStatus = vi.fn(async () => {
        if (watcherStatus.mock.calls.length === 1) {
          entered.resolve();
          await release.promise;
          if (failFirst) throw new Error("temporary watcher failure");
        }
        return {
          running: true,
          degraded: false,
          terminal: false,
          deferredWrites: [],
          recoveryUnavailable: watcherStatus.mock.calls.length === 1,
        };
      });
      const adoptions = vi.fn(async () => ({ adoptions: [], nextCursor: null }));
      const outcomes: WorkspaceEngineCaptureFailure[] = [];
      const daemonStore = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus") return watcherStatus;
          if (property === "listPendingCollectionAdoptions") return adoptions;
          if (property === "flushCapture") return async () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const engine = capture(root, {
        store: daemonStore,
        rustEngineSessions: sessions,
        onRecoveryUnavailable: recovery,
        onOutsideWriteCopies: outside,
        onError: () => {},
        onCaptureOutcome: (outcome) => outcomes.push(outcome),
      });
      try {
        engine.start();
        await entered.promise;
        expect(outside).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(12 * DAEMON_CAPTURE_HEALTH_POLL_MS);
        expect(watcherStatus).toHaveBeenCalledTimes(1);
        release.resolve();
        await engine.flush();
        expect(watcherStatus).toHaveBeenCalledTimes(1);
        expect(adoptions).toHaveBeenCalledTimes(failFirst ? 2 : 3);
        expect(outcomes).toHaveLength(1);
        expect(outside.mock.calls).toEqual(failFirst ? [] : [[[], null]]);
        await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
        await engine.flush();
        expect(watcherStatus).toHaveBeenCalledTimes(2);
        expect(outcomes.at(-1)).toBeNull();
        expect(recovery.mock.calls).toEqual(failFirst ? [[false]] : [[true], [false]]);
        expect(outside).toHaveBeenCalledExactlyOnceWith([], null);
        await engine.stop();
        await vi.advanceTimersByTimeAsync(2 * DAEMON_CAPTURE_HEALTH_POLL_MS);
        expect(watcherStatus).toHaveBeenCalledTimes(2);
      } finally {
        release.resolve();
        await engine.stop();
        await liveStore.close();
        vi.useRealTimers();
      }
    },
  );

  it("keeps the capture outcome while the engine is still updating, and reports a real failure", async () => {
    vi.useFakeTimers();
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores(
      {
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        attachmentId: WORKSPACE_ATTACHMENT_ID,
      },
      sessions,
    ).store;
    const updating = () =>
      new DaemonRefusalError(
        {
          code: "OVERLOADED",
          message: "Workspace is still updating. Try again.",
          retry: "afterBackoff",
        },
        undefined,
      );
    let status: "updating" | "ok" = "ok";
    let adoptionsAnswer: "updating" | "fail" | "ok" = "updating";
    const daemonStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "watcherStatus")
          return async () => {
            if (status === "updating") throw updating();
            return { running: true, degraded: false, terminal: false, deferredWrites: [] };
          };
        if (property === "listPendingCollectionAdoptions")
          return async () => {
            if (adoptionsAnswer === "updating") throw updating();
            if (adoptionsAnswer === "fail") throw new Error("store gone");
            return { adoptions: [], nextCursor: null };
          };
        if (property === "flushCapture") return async () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outcomes: WorkspaceEngineCaptureFailure[] = [];
    const engine = capture(root, {
      store: daemonStore,
      rustEngineSessions: sessions,
      onError: () => {},
      onCaptureOutcome: (outcome) => outcomes.push(outcome),
    });
    // The flush queues behind the poll, so its settling means the poll ran.
    // It drains the same adoptions, so it can be refused too.
    const settled = () => engine.flush().catch(() => undefined);
    const poll = async () => {
      await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
      await settled();
    };
    try {
      engine.start();
      await settled();
      expect(outcomes).toEqual([]);
      status = "updating";
      await poll();
      expect(outcomes).toEqual([]);

      status = "ok";
      adoptionsAnswer = "fail";
      await poll();
      expect(outcomes).toEqual(["other"]);
      adoptionsAnswer = "updating";
      await poll();
      expect(outcomes).toEqual(["other"]);
      adoptionsAnswer = "ok";
      await poll();
      expect(outcomes).toEqual(["other", null]);
    } finally {
      status = "ok";
      adoptionsAnswer = "ok";
      await engine.stop();
      await liveStore.close();
      vi.useRealTimers();
    }
  });

  it("carries the store refusal on the health outcome and clears it on recovery", async () => {
    vi.useFakeTimers();
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      let refuse = true;
      const outcomes: WorkspaceEngineCaptureFailure[] = [];
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(
        {
          workspaceId: WORKSPACE_ID,
          rootPath: root,
          attachmentId: WORKSPACE_ATTACHMENT_ID,
        },
        sessions,
      ).store;
      const daemonStore = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus") {
            return async () => {
              if (refuse) {
                // The wire shape a refused workspace.open reaches the desktop
                // in: an INTERNAL error whose message is the storage code.
                throw Object.assign(new Error("foreign-database"), {
                  wireError: {
                    code: "INTERNAL",
                    message: "foreign-database",
                    retry: "no",
                  },
                });
              }
              return { running: true, degraded: false, terminal: false, deferredWrites: [] };
            };
          }
          if (property === "flushCapture") return async () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const engine = capture(root, {
        store: daemonStore,
        rustEngineSessions: sessions,
        onError: () => {},
        onCaptureOutcome: (outcome) => outcomes.push(outcome),
      });
      try {
        engine.start();
        await engine.flush();
        expect(outcomes).toEqual(["foreign-database"]);

        refuse = false;
        await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
        await engine.flush();
        expect(outcomes).toEqual(["foreign-database", null]);
      } finally {
        try {
          await engine.stop();
        } finally {
          await liveStore.close();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("workspaceEngineCapture relay sync materialization", () => {
  it("applies a pulled delete after this device's folder was removed", async () => {
    const root = await createTestScratch("relay-delete-missing-folder-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      objectId: "page",
      path: "notes/page.md",
      text: "recorded",
    });
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    await store.deleteTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: "notes/page.md",
      metadata: { origin: "sync" },
    });
    const notice = vi.fn();
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onOutsideWriteCopies: notice,
    });
    try {
      await engine.runRelaySync((page) =>
        page([
          { versionId: "main", path: "notes/page.md", operation: "delete", contentKind: "text" },
        ]),
      );
      expect(existsSync(join(root, "notes"))).toBe(false);
      expect(notice).not.toHaveBeenCalled();
    } finally {
      await engine.stop();
    }
  });

  it("merges 3 recorded files without desktop copies or notices", async () => {
    const root = await createTestScratch("merge-3-recorded-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    const send = loopback.sendRequest.bind(loopback);
    const requests: Request[] = [];
    vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
      requests.push(request);
      if (request.method === "conflicts.list")
        return { id: request.id, result: { conflicts: [], nextAfterConflictId: null } };
      const response = await send(request);
      // Model the engine's immediate publication of each text merge.
      if (request.method === VERSIONED_METHOD.versionsMerge)
        await write(root, (request.params as { path: string }).path, "incoming");
      return response;
    });
    for (let index = 0; index < 3; index++) {
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        objectId: `merge-object-${index}`,
        path: `${index}.md`,
        text: "recorded",
      });
      await write(root, `${index}.md`, "recorded");
    }
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    const draft = await store.createNamedVersion({
      workspaceId: WORKSPACE_ID,
      name: "Draft",
      fromVersionId: "main",
    });
    for (let index = 0; index < 3; index++)
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        versionId: draft.id,
        objectId: `merge-object-${index}`,
        path: `${index}.md`,
        text: "incoming",
      });
    const notice = vi.fn();
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onOutsideWriteCopies: notice,
    });
    requests.length = 0;
    try {
      const started = performance.now();
      await expect(engine.mergeVersionIntoMain(draft.id)).resolves.toMatchObject({
        mergedFileCount: 3,
        conflictCount: 0,
      });
      const elapsedMs = performance.now() - started;
      const count = (method: string) =>
        requests.filter((request) => request.method === method).length;
      expect(count(VERSIONED_METHOD.versionsMerge)).toBe(3);
      expect(count(VERSIONED_METHOD.momentsList)).toBe(0);
      expect(count(VERSIONED_METHOD.momentsGet)).toBe(0);
      expect(count("files.resolve")).toBe(0);
      expect((await readdir(root)).filter((name) => name.includes("(kept copy"))).toEqual([]);
      expect(notice).not.toHaveBeenCalled();
      for (let index = 0; index < 3; index++)
        expect(await readFile(join(root, `${index}.md`), "utf8")).toBe("incoming");
      process.stdout.write(
        `3-file merge: ${elapsedMs.toFixed(2)} ms; listMoments=0; getMoment=0; resolveFiles=0; merges=3\n`,
      );
    } finally {
      await engine.stop();
    }
  });

  it.each(["recreated"] as readonly ("recreated" | "older-path")[])(
    "keeps a copy when History coverage is %s",
    async (coverage) => {
      const root = await createTestScratch("relay-history-coverage-");
      await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
      const loopback = new VersionedLoopbackEngine();
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        objectId: coverage === "recreated" ? "old-object" : "note-object",
        path: coverage === "older-path" ? "old.md" : "n.md",
        text: "AGENT-1",
      });
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        objectId: "note-object",
        path: "n.md",
        text: "OWNER-1",
        origin: "sync",
      });
      await write(root, "n.md", "AGENT-1");
      const engine = liveCapture(root, loopback);
      try {
        await engine.runRelaySync((page) =>
          page([{ versionId: "main", path: "n.md", operation: "write", contentKind: "text" }]),
        );
        expect(await readFile(join(root, "n (kept copy).md"), "utf8")).toBe("AGENT-1");
      } finally {
        await engine.stop();
      }
    },
  );

  // dohc removes a folder only when nothing but empty folders is left in it.
  // A file it doesn't track keeps the folder, so the page stops there.
  it("merges 150 recorded files without desktop copies or notices", async () => {
    const root = await createTestScratch("merge-150-recorded-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    const send = loopback.sendRequest.bind(loopback);
    const requests: Request[] = [];
    vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
      requests.push(request);
      if (request.method === "conflicts.list")
        return { id: request.id, result: { conflicts: [], nextAfterConflictId: null } };
      const response = await send(request);
      // Model the engine's immediate publication of each text merge.
      if (request.method === VERSIONED_METHOD.versionsMerge)
        await write(root, (request.params as { path: string }).path, "incoming");
      return response;
    });
    for (let index = 0; index < 150; index++) {
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        objectId: `merge-object-${index}`,
        path: `${index}.md`,
        text: "recorded",
      });
      await write(root, `${index}.md`, "recorded");
    }
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    const draft = await store.createNamedVersion({
      workspaceId: WORKSPACE_ID,
      name: "Draft",
      fromVersionId: "main",
    });
    for (let index = 0; index < 150; index++)
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        versionId: draft.id,
        objectId: `merge-object-${index}`,
        path: `${index}.md`,
        text: "incoming",
      });
    const notice = vi.fn();
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onOutsideWriteCopies: notice,
    });
    requests.length = 0;
    try {
      const started = performance.now();
      await expect(engine.mergeVersionIntoMain(draft.id)).resolves.toMatchObject({
        mergedFileCount: 150,
        conflictCount: 0,
      });
      const elapsedMs = performance.now() - started;
      const count = (method: string) =>
        requests.filter((request) => request.method === method).length;
      expect(count(VERSIONED_METHOD.versionsMerge)).toBe(150);
      expect(count(VERSIONED_METHOD.momentsList)).toBe(0);
      expect(count(VERSIONED_METHOD.momentsGet)).toBe(0);
      expect(count("files.resolve")).toBe(0);
      expect((await readdir(root)).filter((name) => name.includes("(kept copy"))).toEqual([]);
      expect(notice).not.toHaveBeenCalled();
      for (let index = 0; index < 150; index++)
        expect(await readFile(join(root, `${index}.md`), "utf8")).toBe("incoming");
      process.stdout.write(
        `150-file merge: ${elapsedMs.toFixed(2)} ms; listMoments=0; getMoment=0; resolveFiles=0; merges=150\n`,
      );
    } finally {
      await engine.stop();
    }
  });

  it("keeps a folder that still holds a file dohc doesn't track", async () => {
    const root = await createTestScratch("relay-folder-to-file-kept-");
    await write(root, "d/a.md", "a\n");
    await write(root, "d/sub/untracked.txt", "mine\n");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "d/a.md",
      text: "a\n",
      origin: "sync",
    });
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "d",
      text: "now a file\n",
      origin: "sync",
    });
    const engine = liveCapture(root, loopback, { onError: () => undefined });
    const commit = vi.fn(async () => undefined);
    try {
      await expect(
        engine.runRelaySync((page) =>
          deliverRelayPage(
            page,
            {
              fastForwardedPaths: [
                { versionId: "main", path: "d/a.md", operation: "delete", contentKind: "text" },
                { versionId: "main", path: "d", operation: "write", contentKind: "text" },
              ],
            },
            commit,
          ),
        ),
      ).rejects.toThrow(/Could not update d on disk/);
      expect(commit).not.toHaveBeenCalled();
      expect(await readFile(join(root, "d/sub/untracked.txt"), "utf8")).toBe("mine\n");
      expect(await readdir(join(root, "d"))).toEqual(["sub"]);
    } finally {
      await engine.stop();
    }
  });

  it.each([false, true])(
    "preserves the outside write before relay commit, copyFails=%s",
    async (copyFails) => {
      const root = await createTestScratch("relay-outside-copy-");
      await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
      const loopback = new VersionedLoopbackEngine();
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        versionId: "main",
        path: "n.md",
        text: "OWNER-1",
        origin: "sync",
      });
      await write(root, "n.md", "AGENT-1");
      if (copyFails) await write(root, ".dohc/local/outside-write-copies", "not a folder");
      const engine = liveCapture(root, loopback);
      const commit = vi.fn(async () => undefined);
      try {
        const run = engine.runRelaySync((page) =>
          deliverRelayPage(
            page,
            {
              fastForwardedPaths: [
                {
                  versionId: "main",
                  path: "n.md",
                  operation: "write",
                  contentKind: "text",
                },
              ],
            },
            commit,
          ),
        );
        if (copyFails) {
          await expect(run).rejects.toThrow(
            "dohc could not keep a copy of n.md\nMove .dohc/local/outside-write-copies out of the way, then choose Try again.\nUntil then, dohc leaves n.md as it was.",
          );
          await expect(run).rejects.toThrow(
            `Blocking file: ${join(root, ".dohc/local/outside-write-copies")}`,
          );
          await expect(run).rejects.toThrow("Cause:");
          expect(commit).not.toHaveBeenCalled();
          expect(await readFile(join(root, "n.md"), "utf8")).toBe("AGENT-1");
        } else {
          await run;
          expect(commit).toHaveBeenCalledOnce();
          expect(await readFile(join(root, "n (kept copy).md"), "utf8")).toBe("AGENT-1");
          expect(await readFile(join(root, "n.md"), "utf8")).toBe("OWNER-1");
        }
      } finally {
        await engine.stop();
      }
    },
  );

  async function protectedCopyFiles(root: string): Promise<string[]> {
    const dir = join(root, ".dohc/local/protected-copies");
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => readFile(join(dir, name), "utf8")),
    );
  }

  async function filesOutsideDohcHolding(root: string, text: string): Promise<string[]> {
    const found: string[] = [];
    for (const name of await readdir(root, { recursive: true })) {
      const path = String(name).split("\\").join("/");
      if (path === ".dohc" || path.startsWith(".dohc/")) continue;
      const entry = await lstat(join(root, path));
      if (entry.isFile() && (await readFile(join(root, path), "utf8")).includes(text))
        found.push(path);
    }
    return found;
  }

  async function protectedPullFixture(
    change: "write" | "removal",
    history: readonly string[],
    disk: string,
  ) {
    const root = await createTestScratch("relay-protected-copy-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    for (const text of history)
      loopback.seedSecretFile({ workspace: WORKSPACE_ID, versionId: "main", path: ".env", text });
    await write(root, ".env", disk);
    const sessions = mockLiveSessions(loopback);
    const operation = change === "write" ? ("write" as const) : ("delete" as const);
    if (change === "write") {
      loopback.seedSecretFile({
        workspace: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "TOKEN=theirs\n",
        origin: "sync",
      });
    } else {
      const { secretStore } = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
        sessions,
      );
      await secretStore.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        metadata: { origin: "sync" },
      });
    }
    const page = (commit: () => Promise<void>) => (materializePage: MaterializeRelayPullPage) =>
      deliverRelayPage(
        materializePage,
        {
          fastForwardedPaths: [
            { versionId: "main", path: ".env", operation, contentKind: "secret" as const },
          ],
        },
        commit,
      );
    return { root, loopback, sessions, page };
  }

  it.each(["write"] as readonly ("write" | "removal")[])(
    "keeps a change History lacks in a protected file before a pulled %s",
    async (change) => {
      const { root, sessions, page } = await protectedPullFixture(
        change,
        ["TOKEN=saved\n"],
        "TOKEN=mine\n",
      );
      const reported: unknown[] = [];
      const engine = capture(root, {
        rustEngineSessions: sessions,
        onOutsideWriteCopies: (...args) => {
          reported.push(args);
        },
        onProtectedCopies: (...args) => {
          reported.push(args);
        },
        onError: (context, error) => {
          reported.push([context, String(error)]);
        },
      });
      const commit = vi.fn(async () => undefined);
      try {
        await engine.runRelaySync(page(commit));
        expect(commit).toHaveBeenCalledOnce();
        if (change === "write")
          expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=theirs\n");
        else expect(existsSync(join(root, ".env"))).toBe(false);
        const copies = await protectedCopyFiles(root);
        expect(copies).toHaveLength(1);
        expect(copies[0]).toContain("TOKEN=mine");
        expect(await filesOutsideDohcHolding(root, "TOKEN=mine")).toEqual([]);
        expect(JSON.stringify(reported)).not.toContain("TOKEN=mine");
      } finally {
        await engine.stop();
      }
    },
  );

  it("leaves a protected file as it was and holds the pull when dohc cannot keep its copy", async () => {
    const { root, sessions, page } = await protectedPullFixture(
      "write",
      ["TOKEN=saved\n"],
      "TOKEN=mine\n",
    );
    await write(root, ".dohc/local/protected-copies", "not a folder");
    const engine = capture(root, { rustEngineSessions: sessions, onError: () => undefined });
    const commit = vi.fn(async () => undefined);
    try {
      const run = engine.runRelaySync(page(commit));
      await expect(run).rejects.toThrow(
        "dohc could not keep a copy of .env\nMove .dohc/local/protected-copies out of the way, then choose Try again.\nUntil then, dohc leaves .env as it was.",
      );
      await expect(run).rejects.not.toThrow("TOKEN=mine");
      expect(commit).not.toHaveBeenCalled();
      expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=mine\n");
    } finally {
      await engine.stop();
    }
  });

  it.each(["write"] as readonly ("write" | "removal")[])(
    "leaves protected text over 1 MB as it is before a pulled %s, since Restore could not bring it back",
    async (change) => {
      const big = `TOKEN=${"x".repeat(1024 * 1024)}\n`;
      const { root, sessions, page } = await protectedPullFixture(change, ["TOKEN=saved\n"], big);
      const engine = capture(root, { rustEngineSessions: sessions });
      const commit = vi.fn(async () => undefined);
      try {
        await engine.runRelaySync(page(commit));
        expect(commit).toHaveBeenCalledOnce();
        expect(await readFile(join(root, ".env"), "utf8")).toBe(big);
        expect(await protectedCopyFiles(root)).toEqual([]);
      } finally {
        await engine.stop();
      }
    },
  );

  it("keeps and restores no protected text through a folder swapped for an outside link after the check", async () => {
    const root = await createTestScratch("relay-protected-copy-");
    const outside = await createTestScratch("relay-protected-copy-");
    await write(outside, ".env", "TOKEN=outside\n");
    await write(root, "real/.env", "TOKEN=inside\n");
    const type = process.platform === "win32" ? "junction" : "dir";
    const link = join(root, "linked");
    try {
      await symlink(join(root, "real"), link, type);
    } catch {
      return;
    }
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    // The first read of linked/.env itself finds the folder already swapped.
    let swap = true;
    vi.mocked(lstat).mockImplementation((async (path: PathLike) => {
      if (swap && String(path) === join(link, ".env")) {
        swap = false;
        await actual.rm(link);
        await actual.symlink(outside, link, type);
      }
      return await actual.lstat(path);
    }) as typeof lstat);
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "linked/.env",
      text: "TOKEN=theirs\n",
      origin: "sync",
    });
    const sessions = mockLiveSessions(loopback);
    const engine = capture(root, { rustEngineSessions: sessions, onError: () => undefined });
    try {
      await engine
        .runRelaySync((materializePage) =>
          deliverRelayPage(materializePage, {
            fastForwardedPaths: [
              {
                versionId: "main",
                path: "linked/.env",
                operation: "write" as const,
                contentKind: "secret" as const,
              },
            ],
          }),
        )
        .catch(() => undefined);
      expect((await protectedCopyFiles(root)).join()).not.toContain("TOKEN=outside");

      swap = true;
      await actual.rm(link);
      await actual.symlink(join(root, "real"), link, type);
      const copies = protectedWriteCopies({ workspaceId: WORKSPACE_ID, rootPath: root });
      await copies.keep("linked/.env", "TOKEN=mine\n", "main");
      for (const [, id] of await copies.list())
        await engine.restoreProtectedCopy(id).catch(() => undefined);
      const { secretStore } = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
        sessions,
      );
      expect(
        await secretStore.secretTextRecorded({
          workspaceId: WORKSPACE_ID,
          path: "linked/.env",
          text: "TOKEN=outside\n",
        }),
      ).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it("keeps one protected copy across a stopped write, its redelivery and a later pull, and reports it after the restart", async () => {
    const { root, loopback, page } = await protectedPullFixture(
      "write",
      ["TOKEN=saved\n"],
      "TOKEN=mine\n",
    );
    const writer = createDefaultDiskWriter(root);
    const commit = vi.fn(async () => undefined);
    const first = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      diskWriter: {
        ...writer,
        writeTextFile: async () => {
          throw new Error("disk write refused");
        },
      },
      onError: () => undefined,
    });
    await expect(first.runRelaySync(page(commit))).rejects.toThrow("disk write refused");
    await first.stop();
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=mine\n");
    expect(await protectedCopyFiles(root)).toHaveLength(1);
    // A new start, as after dohc stopped before its notice: the copy is already kept.
    const reported: (readonly (readonly [string, string, number])[] | null)[] = [];
    const second = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      onProtectedCopies: (copies) => {
        reported.push(copies);
      },
    });
    try {
      await second.runRelaySync(page(commit));
      expect(commit).toHaveBeenCalledOnce();
      expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=theirs\n");
      second.start();
      await vi.waitFor(() =>
        expect(reported.at(-1)).toEqual([[".env", expect.any(String), expect.any(Number)]]),
      );
      loopback.seedSecretFile({
        workspace: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "TOKEN=theirs-2\n",
        origin: "sync",
      });
      await second.runRelaySync(page(commit));
      expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=theirs-2\n");
      const copies = await protectedCopyFiles(root);
      expect(copies).toHaveLength(1);
      expect(copies[0]).toContain("TOKEN=mine");
    } finally {
      await second.stop();
    }
  });

  it("restores a kept protected change on top of History, keeps the synced text there, and discards another for good", async () => {
    const { root, sessions, page } = await protectedPullFixture(
      "write",
      ["TOKEN=saved\n"],
      "TOKEN=mine\n",
    );
    const engine = capture(root, { rustEngineSessions: sessions });
    const { secretStore } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    );
    try {
      await engine.runRelaySync(page(async () => undefined));
      const kept = await protectedWriteCopies({ workspaceId: WORKSPACE_ID, rootPath: root }).list();
      expect(kept).toEqual([[".env", expect.any(String), expect.any(Number)]]);
      const id = kept[0]![1];

      await expect(engine.restoreProtectedCopy(id)).resolves.toEqual({
        path: ".env",
        status: "restored",
      });
      expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=mine\n");
      expect(await protectedCopyFiles(root)).toEqual([]);
      const [tip] = await secretStore.listSecretFiles({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
      });
      const restored = await secretStore.getSecretMoment({
        workspaceId: WORKSPACE_ID,
        momentId: tip!.latestMomentId,
      });
      expect(restored?.metadata).toMatchObject({
        origin: "restore",
        summary: "Restored your change to .env",
      });
      expect(
        await secretStore.secretTextRecorded({
          workspaceId: WORKSPACE_ID,
          path: ".env",
          text: "TOKEN=theirs\n",
        }),
      ).toBe(true);
      await expect(engine.restoreProtectedCopy(id)).rejects.toMatchObject({
        name: "ProtectedCopyFinalError",
        message: "This kept change is no longer available.",
      });

      const elsewhere = protectedWriteCopies({ workspaceId: WORKSPACE_ID, rootPath: root });
      await elsewhere.keep(".env", "TOKEN=elsewhere\n", "trip");
      const tripId = (await elsewhere.list())[0]![1];
      await expect(engine.restoreProtectedCopy(tripId)).rejects.toThrow(
        "Your change was kept in a different version. Switch to that version to restore it.",
      );
      expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=mine\n");
      await expect(engine.discardProtectedCopy(tripId)).resolves.toEqual({
        path: ".env",
        status: "discarded",
      });
      expect(await protectedCopyFiles(root)).toEqual([]);
      await expect(engine.discardProtectedCopy(tripId)).rejects.toMatchObject({
        name: "ProtectedCopyFinalError",
        message: "This kept change is no longer available.",
      });

      await elsewhere.keep(".env", "x".repeat(1024 * 1024 + 1), "main");
      const bigId = (await elsewhere.list())[0]![1];
      await expect(engine.restoreProtectedCopy(bigId)).rejects.toMatchObject({
        name: "ProtectedCopyFinalError",
        message: "Your change is over the 1 MB limit for protected files.",
      });
      expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=mine\n");
    } finally {
      await engine.stop();
    }
  });

  async function deliverRelayPage<
    T extends {
      fastForwardedPaths: readonly RelayMaterializedPath[];
    },
  >(
    materializePage: MaterializeRelayPullPage,
    result: T,
    commit: () => Promise<void> = async () => undefined,
  ): Promise<T> {
    await materializePage(result.fastForwardedPaths);
    await commit();
    return result;
  }

  async function protectedVersionFixture(mainText: string) {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: ".env",
      text: mainText,
      origin: "sync",
    });
    await write(root, ".env", mainText);
    const engine = liveCapture(root, loopback);
    const draftId = (await engine.createVersion("Draft")).activeVersionId;
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: draftId,
      path: ".env",
      text: "VALUE=draft engine\n",
      origin: "local-file",
    });
    await engine.switchVersion("main");
    return { root, loopback, engine, draftId };
  }

  it("settles daemon capture after relay materialization before committing the cursor", async () => {
    vi.mocked(delay).mockResolvedValue(undefined);
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      const loopback = new VersionedLoopbackEngine();
      const requests: Request[] = [];
      let settled = true;
      const engine = capture(root, {
        rustEngineSessions: mockLiveSessions(loopback, requests, () => ({
          deferredWrites: [],
          settled,
          running: true,
          heldFiles: [],
          degraded: !settled,
        })),
      });
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        versionId: "main",
        objectId: "remote-note-object",
        path: "notes/remote.md",
        text: "remote machine wrote this\n",
        origin: "sync",
      });
      let flushedWhenCommitted = false;

      await engine.runRelaySync(
        async (materializePage) =>
          await deliverRelayPage(
            materializePage,
            {
              fastForwardedPaths: [
                {
                  versionId: "main",
                  path: "notes/remote.md",
                  operation: "write" as const,
                  contentKind: "text" as const,
                },
              ],
            },
            async () => {
              flushedWhenCommitted = requests.some(
                (request) => request.method === "capture.reconcile",
              );
            },
          ),
      );

      expect(flushedWhenCommitted).toBe(true);

      settled = false;
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        versionId: "main",
        objectId: "remote-note-object",
        path: "notes/remote.md",
        text: "new remote text\n",
        origin: "sync",
      });
      const commitWhileUnsettled = vi.fn(async () => {});
      await expect(
        engine.runRelaySync(
          async (materializePage) =>
            await deliverRelayPage(
              materializePage,
              {
                fastForwardedPaths: [
                  {
                    versionId: "main",
                    path: "notes/remote.md",
                    operation: "write" as const,
                    contentKind: "text" as const,
                  },
                ],
              },
              commitWhileUnsettled,
            ),
        ),
      ).rejects.toThrow("did not settle");
      expect(commitWhileUnsettled).not.toHaveBeenCalled();

      settled = true;
      await engine.stop();
    } finally {
      vi.mocked(delay).mockRestore();
    }
  });

  it("materializes a pull-fast-forwarded binary path from authoritative bytes", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    loopback.seedBinaryFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "assets/excalidraw/abc/asset.png",
      bytes,
      origin: "sync",
    });

    await engine.runRelaySync(
      async (materializePage) =>
        await deliverRelayPage(materializePage, {
          fastForwardedPaths: [
            {
              versionId: "main",
              path: "assets/excalidraw/abc/asset.png",
              operation: "write" as const,
              contentKind: "binary" as const,
            },
          ],
        }),
    );

    expect(await readFile(join(root, "assets/excalidraw/abc/asset.png"))).toEqual(
      Buffer.from(bytes),
    );
    await engine.stop();
  });

  it("materializes protected writes and deletes before committing the relay cursor", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: ".env",
      text: "ACCESS_TOKEN=protected\r\n",
      origin: "sync",
    });
    const commitOrder: string[] = [];

    await engine.runRelaySync(
      async (materializePage) =>
        await deliverRelayPage(
          materializePage,
          {
            fastForwardedPaths: [
              {
                versionId: "main",
                path: ".env",
                operation: "write" as const,
                contentKind: "secret" as const,
              },
            ],
          },
          async () => {
            expect(await readFile(join(root, ".env"), "utf8")).toBe("ACCESS_TOKEN=protected\r\n");
            commitOrder.push("write");
          },
        ),
    );

    await loopback.sendRequest({
      id: -3,
      method: VERSIONED_METHOD.secretsDelete,
      workspace: WORKSPACE_ID,
      params: {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        origin: "sync",
        momentId: "remote-secret-delete",
      },
    });
    await engine.runRelaySync(
      async (materializePage) =>
        await deliverRelayPage(
          materializePage,
          {
            fastForwardedPaths: [
              {
                versionId: "main",
                path: ".env",
                operation: "delete" as const,
                contentKind: "secret" as const,
              },
            ],
          },
          async () => {
            expect(existsSync(join(root, ".env"))).toBe(false);
            commitOrder.push("delete");
          },
        ),
    );

    expect(commitOrder).toEqual(["write", "delete"]);
    await engine.stop();
  });

  it("does not replay a protected write into a version entered after materialization failed", async () => {
    const { root, engine, draftId } = await protectedVersionFixture("VALUE=main remote\n");

    await rm(join(root, ".env"), { force: true });
    await write(root, ".env/keep.txt", "mine\n");
    const commit = vi.fn(async () => {});
    const replay = () => ({
      fastForwardedPaths: [
        {
          versionId: "main",
          path: ".env",
          operation: "write" as const,
          contentKind: "secret" as const,
        },
      ],
    });
    await expect(
      engine.runRelaySync(
        async (materializePage) => await deliverRelayPage(materializePage, replay(), commit),
      ),
    ).rejects.toThrow(/Could not update \.env/u);
    expect(commit).not.toHaveBeenCalled();

    await rm(join(root, ".env"), { recursive: true, force: true });
    await write(root, ".env", "VALUE=main remote\n");
    await engine.switchVersion(draftId);
    await write(root, ".env", "VALUE=draft local drift\n");
    await engine.runRelaySync(
      async (materializePage) => await deliverRelayPage(materializePage, replay(), commit),
    );

    expect(await readFile(join(root, ".env"), "utf8")).toBe("VALUE=draft local drift\n");
    expect(commit).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  // Data-safety gate finding: the relay fetch cursor must only commit after
  // the pulled state is safely on disk. A failed materialization leaves the
  // cursor un-advanced so the next pass retries the same ops.
  it("commits the relay fetch cursor only after disk materialization succeeds", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "remote machine wrote this\n",
      origin: "sync",
    });

    await write(root, "notes/remote.md/keep.txt", "mine\n");
    const commit = vi.fn(async () => {});
    const pullResult = () => ({
      fastForwardedPaths: [
        {
          versionId: "main",
          path: "notes/remote.md",
          operation: "write" as const,
          contentKind: "text" as const,
        },
      ],
    });
    await expect(
      engine.runRelaySync(
        async (materializePage) => await deliverRelayPage(materializePage, pullResult(), commit),
      ),
    ).rejects.toThrow("Could not update notes/remote.md on disk:");
    expect(commit).not.toHaveBeenCalled();

    await rm(join(root, "notes/remote.md"), { recursive: true, force: true });
    await engine.runRelaySync(
      async (materializePage) => await deliverRelayPage(materializePage, pullResult(), commit),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "notes/remote.md"), "utf8")).toBe(
      "remote machine wrote this\n",
    );

    // A quiescent pass (chat-only or own-origin ops) still commits: cursor
    // progress must not depend on file materialization work existing.
    const quiescentCommit = vi.fn(async () => {});
    await engine.runRelaySync(
      async (materializePage) =>
        await deliverRelayPage(materializePage, { fastForwardedPaths: [] }, quiescentCommit),
    );
    await engine.stop();
    expect(quiescentCommit).toHaveBeenCalledTimes(1);
  });
});

describe("assertGeneratedMarkdownPath host-unsafe rejection (materialize boundary)", () => {
  it("throws a typed unsupported-name error only when the host is Windows", () => {
    // Windows-illegal names that can arrive from a sync peer and cannot be
    // materialized on a Windows disk.
    for (const path of ["nul.md", "notes.md:hidden.md", "DOHC~1.md"]) {
      expect(() => assertGeneratedMarkdownPath(path, "win32")).toThrow(
        UnsupportedWorkspacePathError,
      );
      try {
        assertGeneratedMarkdownPath(path, "win32");
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedWorkspacePathError);
        expect((error as UnsupportedWorkspacePathError).code).toBe("unsupported-name");
        expect((error as UnsupportedWorkspacePathError).workspacePath).toBe(path);
      }
      // Same names are host-legal off Windows: no typed rejection.
      expect(assertGeneratedMarkdownPath(path, "linux")).toBe(path);
    }
  });

  it("still rejects genuinely-unsafe generated paths generically on every host", () => {
    expect(() => assertGeneratedMarkdownPath("../escape.md", "linux")).toThrow(
      /safe visible Markdown path/,
    );
    expect(() => assertGeneratedMarkdownPath("notes/plan.txt", "linux")).toThrow(
      /safe visible Markdown path/,
    );
  });
});

describe("createDefaultDiskWriter symlink containment", () => {
  it("refuses to write through a symlink leaf", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await write(outside, "target.md", "original outside content\n");
    await symlink(join(outside, "target.md"), join(root, "notes.md"));

    const writer = createDefaultDiskWriter(root);
    await expect(writer.writeTextFile(join(root, "notes.md"), "engine text\n")).rejects.toThrow(
      /symlink/,
    );
    expect(await readFile(join(outside, "target.md"), "utf8")).toBe("original outside content\n");
  });

  it("refuses to mkdir through a symlinked ancestor pointing outside the workspace", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await symlink(outside, join(root, "escape"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "escape", "deep", "file.md"), "x\n"),
    ).rejects.toThrow(/escaped the workspace root/);
    expect(existsSync(join(outside, "deep"))).toBe(false);
  });

  it("writes normally inside the workspace, creating missing directories", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "a", "b", "c.md"), "nested\n");
    expect(await readFile(join(root, "a", "b", "c.md"), "utf8")).toBe("nested\n");
    expect(await readdir(join(root, "a", "b"))).toEqual(["c.md"]);
  });

  it("deleting a symlink leaf removes the link, not its target", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await write(outside, "keep.md", "must survive\n");
    await symlink(join(outside, "keep.md"), join(root, "gone.md"));

    const writer = createDefaultDiskWriter(root);
    await writer.deletePath(join(root, "gone.md"));
    expect(existsSync(join(root, "gone.md"))).toBe(false);
    expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("must survive\n");
  });

  it("deletes under an absent folder chain without creating it, twice", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const writer = createDefaultDiskWriter(root);
    for (const path of [join(root, "notes", "before.md"), join(root, "a", "b", "c", "deep.md")]) {
      await writer.deletePath(path);
      await writer.deletePath(path);
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a delete through an alias of .dohc", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    await write(root, ".dohc/settings.json", "{}\n");
    await symlink(join(root, ".dohc"), join(root, "meta"), "dir");
    const writer = createDefaultDiskWriter(root);
    for (const path of [
      join(root, "meta", "settings.json"),
      join(root, "meta", "absent", "x.md"),
    ]) {
      await expect(writer.deletePath(path)).rejects.toThrow(
        /Engine delete path leads to a reserved area/,
      );
    }
    expect(await readdir(join(root, ".dohc"))).toEqual(["settings.json"]);
  });
});

describe("createDefaultDiskWriter replaces a file whole", () => {
  const actualFs = () => vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const restoreFs = () => {
    for (const mocked of [open, rename, rm, writeFile]) vi.mocked(mocked).mockRestore();
  };

  it("keeps the old bytes and leaves no temp file when a write fails partway", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    await write(root, "notes.md", "old");
    const fs = await actualFs();
    const diskFull = Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
    });
    // Every write stops after two bytes, as a full disk leaves it.
    vi.mocked(writeFile).mockImplementation(async (file, data) => {
      await fs.writeFile(file, String(data).slice(0, 2));
      throw diskFull;
    });
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await fs.open(...args);
      handle.writeFile = async (data) => {
        await handle.write(String(data).slice(0, 2));
        throw diskFull;
      };
      return handle;
    });
    try {
      await expect(
        createDefaultDiskWriter(root).writeTextFile(join(root, "notes.md"), "new contents\n"),
      ).rejects.toBe(diskFull);
    } finally {
      restoreFs();
    }
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("old");
    expect(await readdir(root)).toEqual(["notes.md"]);
  });

  // A Linux ACL's mask shows as the group bits, and Node can't read the ACL,
  // so copying the group or other bits could let someone read what it denied.
  it.skipIf(process.platform === "win32")(
    "keeps only the owner's bits of a replaced file",
    async () => {
      const root = await createTestScratch("dohc-engine-capture-");
      await write(root, "run.sh", "old");
      await chmod(join(root, "run.sh"), 0o754);
      await write(root, "shared.md", "old");
      await chmod(join(root, "shared.md"), 0o640);
      const writer = createDefaultDiskWriter(root);
      await writer.writeBinaryFile(join(root, "run.sh"), new Uint8Array([1, 2]));
      await writer.writeTextFile(join(root, "shared.md"), "new\n");
      expect((await stat(join(root, "run.sh"))).mode & 0o777, "run.sh").toBe(0o700);
      expect((await stat(join(root, "shared.md"))).mode & 0o777, "shared.md").toBe(0o600);
      expect(await readFile(join(root, "run.sh"))).toEqual(Buffer.from([1, 2]));
      expect(await readFile(join(root, "shared.md"), "utf8")).toBe("new\n");
    },
  );

  it.each([
    [
      "deleted",
      (writer: EngineDiskWriter, path: string) => writer.deletePath(path),
      [] as string[],
    ],
    [
      "written again",
      (writer: EngineDiskWriter, path: string) => writer.writeTextFile(path, "TOKEN=rotated\n"),
      [".env"],
    ],
  ])(
    "leaves no copy of a secret a crashed write left behind once the path is %s",
    async (_, next, left) => {
      const root = await createTestScratch("dohc-engine-capture-");
      await write(root, ".env", "TOKEN=old\n");
      const writer = createDefaultDiskWriter(root);
      // The app stops after the temp is flushed and before the rename, so
      // nothing renames or removes the temp. The mocked `rm` is the cleanup in
      // atomicReplaceFile's catch; an earlier `rm` in the write would use it up.
      vi.mocked(rename).mockRejectedValueOnce(new Error("the app stopped"));
      vi.mocked(rm).mockResolvedValueOnce(undefined);
      try {
        await expect(writer.writeTextFile(join(root, ".env"), "TOKEN=secret\n")).rejects.toThrow(
          "the app stopped",
        );
      } finally {
        restoreFs();
      }
      const crashed = (await readdir(root)).filter((name) => name.startsWith(".dohc-write-"));
      expect(crashed).toHaveLength(1);
      expect(await readFile(join(root, crashed[0]!), "utf8")).toBe("TOKEN=secret\n");

      await next(writer, join(root, ".env"));
      expect(await readdir(root)).toEqual(left);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a link before the engine's writer sees the write",
    async () => {
      const root = await createTestScratch("dohc-engine-capture-");
      const outside = await createTestScratch("dohc-engine-capture-");
      await write(outside, "keep.md", "must survive\n");
      await symlink(join(outside, "keep.md"), join(root, "link.md"));
      await write(root, ".dohc/settings.json", "{}\n");
      await symlink(join(root, ".dohc"), join(root, "meta"), "dir");
      const writer = createDefaultDiskWriter(root, async () => {
        throw new Error("the engine's writer was called");
      });
      await expect(writer.writeTextFile(join(root, "link.md"), "x")).rejects.toThrow(
        /through a symlink/,
      );
      await expect(writer.writeTextFile(join(root, "meta", "x.md"), "x")).rejects.toThrow(
        /Engine write path leads to a reserved area/,
      );
      expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("must survive\n");
    },
  );
});

describe("workspaceEngineCapture agent attribution", () => {
  it("returns stable object and moment ids from authored text and binary retries", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const author = { kind: "agent", agentId: "local-app", onBehalfOf: "local" } as const;
    try {
      for (const [name, content] of [
        ["record.md", "record\n"],
        ["record.bin", new Uint8Array([0, 255])],
      ] as const) {
        const options = {
          createOnly: true,
          requestId: "request-" + name,
          momentId: "moment-" + name,
          versionId: "main",
        };
        const first = await engine.writeAuthoredFile(join(root, name), content, author, options);
        expect(first).toMatchObject({
          objectId: expect.any(String),
          momentId: options.momentId,
          deduped: false,
        });
        const retry = await engine.writeAuthoredFile(join(root, name), content, author, options);
        expect(retry).toMatchObject({
          objectId: first.objectId,
          momentId: first.momentId,
          deduped: true,
        });
      }
    } finally {
      await engine.stop();
    }
  });

  it("refuses a saved-version authored retry instead of writing into a newly active version", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = liveCapture(root, loopback, { requests });
    const author = { kind: "agent", agentId: "local-app", onBehalfOf: "local" } as const;
    try {
      const draft = await engine.createVersion("Draft");
      await expect(
        engine.writeAuthoredFile(join(root, "pending.md"), "pending\n", author, {
          createOnly: true,
          requestId: "saved-request",
          momentId: "saved-moment",
          versionId: "main",
        }),
      ).rejects.toMatchObject({ code: "invalid-version" });
      expect(
        requests.findLast((request) => request.method === VERSIONED_METHOD.textWrite),
      ).toMatchObject({ params: { versionId: "main" } });
      expect(draft.activeVersionId).not.toBe("main");
      expect(await readFile(join(root, "pending.md"), "utf8").catch(() => null)).toBeNull();
    } finally {
      await engine.stop();
    }
  });

  const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1", depth: 0 };

  it("writes an authored change only while the file is as it was read", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const target = join(root, "automations.yaml");
    await writeFile(target, "version: 1\n");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    // The loopback engine models agent authors; the daemon takes an automation's the same way.
    const author = {
      kind: "agent",
      agentId: "test-agent",
      onBehalfOf: "local",
      agentRunId: "spawn",
    } as const;

    await expect(
      engine.writeAuthoredFile(target, "changed\n", author, {
        expectedContentHash: hash("something else\n"),
      }),
    ).rejects.toBeInstanceOf(AuthoredTextChangedError);
    expect(await readFile(target, "utf8")).toBe("version: 1\n");

    await engine.writeAuthoredFile(target, "version: 1\nautomations: []\n", author, {
      expectedContentHash: hash("version: 1\n"),
    });
    expect(await readFile(target, "utf8")).toBe("version: 1\nautomations: []\n");
    expect(await liveMomentAuthors(engine)).toContainEqual([author]);
    await engine.stop();
  });

  it("records the canonical path when an authored write uses an in-workspace alias", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const canonical = join(root, "canonical");
    await mkdir(canonical);
    await symlink(
      canonical,
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const engine = liveCapture(root, new VersionedLoopbackEngine());

    const result = await engine.writeAuthoredFile(
      join(root, "alias", "output.txt"),
      "canonical\n",
      { kind: "agent", agentId: "test-agent", onBehalfOf: "local", agentRunId: "spawn" },
    );

    expect(result.resolvedAbsolutePath).toBe(join(canonical, "output.txt"));
    await expect(readFile(join(canonical, "output.txt"), "utf8")).resolves.toBe("canonical\n");
    expect((await liveMoments(engine)).map((moment) => moment.path)).toEqual([
      "canonical/output.txt",
    ]);
    await engine.stop();
  });

  it("serializes concurrent create-only authored writes so exactly one wins", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const target = join(root, "exclusive.txt");
    const author = {
      kind: "agent" as const,
      agentId: "test-agent",
      onBehalfOf: "local",
      agentRunId: "spawn",
    };

    const attempts = await Promise.allSettled([
      engine.writeAuthoredFile(target, "first", author, { createOnly: true }),
      engine.writeAuthoredFile(target, "second", author, { createOnly: true }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const collision = attempts.find((attempt) => attempt.status === "rejected")?.reason;
    expect(collision).toBeInstanceOf(VersionedTextStoreError);
    expect(collision).toMatchObject({
      code: "target-path-exists",
      message: "File already exists: exclusive.txt",
    });
    await expect(readFile(target, "utf8")).resolves.toMatch(/^(?:first|second)$/);
    await engine.stop();
  });

  it("refuses an authored create when an ordinary file wins after the existence check", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const targetPath = join(root, "record.md");
    const competingText = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\nKeep this record.\n";
    const realLoopback = new VersionedLoopbackEngine();
    let injected = false;
    const requests: Request[] = [];
    const loopback = new Proxy(realLoopback, {
      get(target, property, receiver) {
        if (property !== "sendRequest") return Reflect.get(target, property, receiver);
        return async (request: Request) => {
          if (!injected && request.method === VERSIONED_METHOD.versionsActive) {
            injected = true;
            await writeFile(targetPath, competingText, { flag: "wx" });
          }
          return target.sendRequest(request);
        };
      },
    });
    const engine = liveCapture(root, loopback, { requests });
    try {
      const outcome = await engine
        .writeAuthoredFile(
          targetPath,
          "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n",
          { kind: "agent", agentId: "plugin:records", onBehalfOf: "local", agentRunId: "create" },
          { createOnly: true },
        )
        .then(
          () => "created",
          (error: unknown) => ({ refused: String(error) }),
        );
      expect(injected).toBe(true);
      expect.soft(outcome).not.toBe("created");
      expect.soft(outcome).toEqual({ refused: expect.stringMatching(/exist/i) });
      expect.soft(await readFile(targetPath, "utf8")).toBe(competingText);
      expect
        .soft(requests.filter((request) => request.method === VERSIONED_METHOD.textWrite))
        .toEqual([
          expect.objectContaining({ params: expect.objectContaining({ createOnly: true }) }),
        ]);
      expect(await liveMoments(engine)).toEqual([]);
    } finally {
      await engine.stop();
    }
  });

  it("rechecks panel cancellation after an authored write reaches the capture queue", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const realLoopback = new VersionedLoopbackEngine();
    const entered = deferred();
    const release = deferred();
    let blocked = false;
    const loopback = new Proxy(realLoopback, {
      get(target, property, receiver) {
        if (property !== "sendRequest") return Reflect.get(target, property, receiver);
        return async (request: Request) => {
          if (!blocked && request.method === VERSIONED_METHOD.textWrite) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return target.sendRequest(request);
        };
      },
    });
    const engine = liveCapture(root, loopback);
    const blocker = engine.writeAuthoredFile(join(root, "queue-blocker.txt"), "block\n", {
      kind: "agent",
      agentId: "test-agent",
      onBehalfOf: "local",
      agentRunId: "spawn",
    });
    await entered.promise;

    const controller = new AbortController();
    const pending = engine.writeAuthoredFile(
      join(root, "cancelled.txt"),
      "must not land\n",
      { kind: "agent", agentId: "test-agent", onBehalfOf: "local", agentRunId: "spawn" },
      { signal: controller.signal },
    );
    controller.abort();
    release.resolve();

    await expect(pending).rejects.toThrow("The write was cancelled.");
    await blocker;
    expect(existsSync(join(root, "cancelled.txt"))).toBe(false);
    await engine.stop();
  });

  it("mutation proof: an unsettled flush refuses to clear daemon authorship", async () => {
    vi.mocked(delay).mockResolvedValue(undefined);
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      const requests: Request[] = [];
      const loopback = new VersionedLoopbackEngine();
      let settled = false;
      const engine = capture(root, {
        rustEngineSessions: mockLiveSessions(loopback, requests, () => ({
          deferredWrites: [],
          settled,
          running: true,
          heldFiles: [],
          degraded: !settled,
        })),
      });

      await engine.setActiveAgentRun(run);
      await expect(engine.setActiveAgentRun(null)).rejects.toThrow("did not settle");
      const methods = requests
        .filter(
          (request) => request.method === "capture.flush" || request.method === "capture.setAuthor",
        )
        .map((request) => request.method);
      expect(methods[0]).toBe("capture.setAuthor");
      expect(methods.filter((method) => method === "capture.setAuthor")).toEqual([
        "capture.setAuthor",
      ]);
      expect(methods.slice(1).every((method) => method === "capture.flush")).toBe(true);
      expect(methods.length).toBeGreaterThan(1);

      settled = true;
      await engine.setActiveAgentRun(null);
      expect(
        requests.filter((request) => request.method === "capture.setAuthor").at(-1)?.params,
      ).toEqual({ author: null });
      await engine.stop();
    } finally {
      vi.mocked(delay).mockRestore();
    }
  });
});

class ConflictFreeLoopbackEngine extends VersionedLoopbackEngine {
  override async sendRequest(request: Request): Promise<Response> {
    if (request.method === "conflicts.list") {
      return {
        id: request.id,
        result: { conflicts: [], nextAfterConflictId: null },
      };
    }
    return await super.sendRequest(request);
  }
}

describe("Rust engine session selection", () => {
  it.each(["owner-outbox", "shutdown"])(
    "does not wake watched uploads after %s acknowledgement",
    async (mode) => {
      const root = await createTestScratch("dohc-durable-lane-");
      const loopback = new ConflictFreeLoopbackEngine();
      await write(root, "note.md", "existing");
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        versionId: "main",
        path: "note.md",
        text: "existing",
      });
      const entered = deferred<void>(),
        journal = deferred<void>();
      const engine = capture(root, {
        rustEngineSessions: mockLiveSessions(loopback),
        openRustYDocProviderSession: async (options) => {
          const doc = new Y.Doc();
          return {
            doc,
            initialUpdate: Y.encodeStateAsUpdate(doc),
            contentKind: "plaintext",
            path: "note.md",
            head: "present",
            lineage: "existing",
            evict: async () => {},
            close: async () => {},
            applyLocalUpdate: async (
              _update: Uint8Array,
              applyOptions: { idempotencyKey: string },
            ) => {
              entered.resolve();
              await journal.promise;
              options.onLocalUpdateAcknowledged?.(
                applyOptions.idempotencyKey,
                mode === "owner-outbox" ? "owner-outbox" : "journal",
              );
            },
            settleNow: vi.fn(),
          } as never;
        },
      });
      const changed = vi.fn();
      engine.onDurableLocalChange(changed);
      let report!: (value: { hasMore: boolean; watched: boolean }) => void;
      const push = vi.fn(async () => ({
        pushed: 1,
        hasMore: false,
        originsPushed: [],
        sharingDeclined: [],
        ownerAdmissionPending: [],
      }));
      const sync = createRelaySyncEngine({
        rootDir: root,
        relay: { baseUrl: "http://relay.test", token: "t" },
        capture: engine,
        operations: {
          push,
          pull: async () => ({
            fetched: 0,
            applied: 0,
            skipped: 0,
            conflictsOpened: 0,
            fastForwardedPaths: [],
            nextCursor: 0,
            sharingDeclined: [],
          }),
          claim: async () => {},
          recoverOrigin: vi.fn(),
        },
        onChange: vi.fn(),
        waitForChange: (_since, signal) =>
          new Promise((resolve, reject) => {
            report = resolve;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      });
      const ownerPass = vi.fn(async () => ({ documentCount: 0, acknowledged: false }));
      const owner = startServerOwnerDelivery({
        workspaceIds: () => [WORKSPACE_ID],
        attemptTimeoutMs: 5000,
        retryDelayMs: 10_000,
        runPass: ownerPass,
        onError: vi.fn(),
      });
      const retry = vi.spyOn(owner, "retry");
      const session = await engine.openYDocSession({ path: "note.md", onRemoteUpdate: () => {} });
      const editor = new Y.Doc();
      editor.getText("content").insert(0, "edit");
      try {
        await sync.start();
        await vi.waitFor(() => expect(report).toBeTypeOf("function"));
        report({ hasMore: false, watched: true });
        await vi.waitFor(() => expect(ownerPass).toHaveBeenCalledTimes(1));
        const recording = session.applyDecidedLocalUpdate(() => Y.encodeStateAsUpdate(editor));
        await entered.promise;
        if (mode === "shutdown") engine.beginShutdown();
        journal.resolve();
        await recording;
        // Flush the sync chain too, without introducing an ordinary push.
        await sync.stop();
        expect(changed).not.toHaveBeenCalled();
        expect(push).toHaveBeenCalledTimes(1);
        expect(retry).not.toHaveBeenCalled();
        expect(ownerPass).toHaveBeenCalledTimes(1);
      } finally {
        journal.resolve();
        await sync.stop();
        await owner.stop();
        await session.close({ settle: false });
        await engine.stop();
        editor.destroy();
      }
    },
  );
});

// A Y.Doc session's version binding and its registry entry are decided
// one daemon round trip apart: `openYDocSession` reads the active version,
// opens the provider, and only then records the session as live. Off the
// capture chain, a version operation running inside that gap swept a registry
// the session had not reached yet — so the sweep vacated nothing, and the
// session went live against the version the user had just LEFT. Everything
// typed into it settled into that version's lineage and materialized its
// projection over the folder the operation had just written.
//
// The test stages the interleaving rather than racing it. The daemon request
// that marks "this version operation is past its live-session sweep" blocks,
// the open is issued inside that window, and the window is then held open for
// a full daemon round trip the test drives itself (`listVersions`) — strictly
// more turns than an unserialized open needs to reach the provider. So an
// empty provider log at that point is PROOF the open is queued behind the
// chain, not evidence that it happened to be slower.
describe("workspaceEngineCapture Y.Doc session ordering against version operations", () => {
  function recordingProvider(openedVersionIds: string[]) {
    return async (
      options: EngineYdocProviderSessionOptions,
    ): Promise<EngineYdocProviderSession> => {
      openedVersionIds.push(options.versionId);
      const doc = new Y.Doc();
      return {
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext",
        path: options.path,
        // `as never` below stops tsc checking this literal, so these two are
        // stated by hand. Without them `head` was undefined here and the
        // absent-head refusal never ran in this test at all.
        head: "present" as const,
        lineage: "existing" as const,
        evict: async () => undefined,
        applyLocalUpdate: async () => undefined,
        settleNow: async () => ({ sha256: "c".repeat(64), content: "" }) as never,
        close: async () => undefined,
      } as never;
    };
  }

  it("opens a document and publishes an authored file while a relay push waits", async () => {
    const root = await createTestScratch("dohc-drain-interleave-");
    const loopback = new ConflictFreeLoopbackEngine();
    const path = "note.md";
    await write(root, path, "existing document");
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path,
      text: "existing document",
    });
    const events: string[] = [];
    const engine = liveCapture(root, loopback, {
      openRustYDocProviderSession: async (options) => {
        events.push("document opened");
        return recordingProvider([])(options);
      },
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const continued = deferred<void>();
    const releaseContinuation = deferred<void>();
    let pushes = 0;
    const sync = createRelaySyncEngine({
      rootDir: root,
      relay: { baseUrl: "http://relay.test", token: "test" },
      capture: engine,
      onChange: () => undefined,
      operations: {
        claim: async () => undefined,
        recoverOrigin: async () => {
          throw new Error("unexpected origin recovery");
        },
        push: async () => {
          pushes += 1;
          events.push(`push ${pushes}`);
          if (pushes === 1) {
            entered.resolve();
            await release.promise;
          } else {
            continued.resolve();
            await releaseContinuation.promise;
          }
          return {
            pushed: 1,
            hasMore: pushes === 1,
            originsPushed: [],
            ownerAdmissionPending: [],
            sharingDeclined: [],
          };
        },
        pull: async () => {
          events.push("pull");
          return {
            fetched: 0,
            applied: 0,
            skipped: 0,
            conflictsOpened: 0,
            fastForwardedPaths: [],
            nextCursor: pushes,
            sharingDeclined: [],
          };
        },
      },
    });
    try {
      const pass = sync.start();
      await entered.promise;
      // Neither waits for the push on the relay.
      const session = await engine.openYDocSession({ path, onRemoteUpdate: () => undefined });
      await engine.writeAuthoredFile(join(root, "agent.txt"), "authored content", {
        kind: "agent",
        agentId: "agent",
        onBehalfOf: "local",
      });
      events.push("authored write");
      expect(events).toEqual(["push 1", "document opened", "authored write"]);
      expect(await readFile(join(root, "agent.txt"), "utf8")).toBe("authored content");
      release.resolve();
      await pass;
      await continued.promise;
      expect(events).toEqual(["push 1", "document opened", "authored write", "pull", "push 2"]);
      releaseContinuation.resolve();
      await sync.stop();
      expect(events.at(-1)).toBe("pull");
      await session.close({ settle: false });
    } finally {
      release.resolve();
      releaseContinuation.resolve();
      await sync.stop();
      await engine.stop();
    }
  });

  it("hydrates a live artifact asset by its workspace-scoped blob after its head is retired", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const path = "drawings/asset-recovery.excalidraw";
    const assetPath = `assets/excalidraw/${"a".repeat(64)}/${"b".repeat(64)}.png`;
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path,
      text: '{"type":"excalidraw","elements":[],"appState":{},"files":{}}',
    });
    loopback.seedBinaryFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: assetPath,
      bytes: Array.from(bytes),
      origin: "sync",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        const doc = new Y.Doc();
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "scene",
          path: options.path,
          head: "present",
          lineage: "existing",
          artifactAssets: [
            {
              id: "image-file",
              mimeType: "image/png",
              created: 1,
              ref: assetPath,
              sha256,
            },
          ],
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => ({ sha256: "c".repeat(64), content: "" }) as never,
          close: async () => undefined,
        } as never;
      },
    });
    const session = await engine.openYDocSession({ path, onRemoteUpdate: () => undefined });
    await loopback.sendRequest({
      id: -1,
      method: VERSIONED_METHOD.textDelete,
      workspace: WORKSPACE_ID,
      params: { versionId: "main", path: assetPath, origin: "api" },
    });

    const descriptor = session.artifactAssets?.[0];
    expect(descriptor).toBeDefined();
    await expect(session.readArtifactAsset(descriptor!)).resolves.toEqual({
      descriptor,
      bytes,
    });
    await session.close({ settle: false });
    await engine.stop();
  });

  it("opens a session against the version a running switch is ENTERING, never the one it is leaving", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const switchReachedMaterialization = deferred();
    const releaseSwitch = deferred();
    // The daemon materializes the entered version inside versions.setActive,
    // so blocking that request holds the switch exactly where the issue puts
    // it: past the live-session sweep, still rewriting the folder.
    const sessions = mockLiveSessions(loopback, undefined, undefined, async (request) => {
      if (request.method !== VERSIONED_METHOD.versionsSetActive) return;
      const params = request.params as { versionId?: string };
      // createVersion's own set-active is not the switch under test.
      if (params.versionId !== "main") return;
      switchReachedMaterialization.resolve();
      await releaseSwitch.promise;
    });
    const engine = capture(root, {
      rustEngineSessions: sessions,
      openRustYDocProviderSession: recordingProvider(openedVersionIds),
    });

    // Create-and-switch leaves "Draft" active; the switch under test returns
    // to Main, so the two versions are distinguishable in the assertion.
    const created = await engine.createVersion("Draft");
    const draftVersionId = created.activeVersionId;
    expect(draftVersionId).not.toBe("main");

    const switching = engine.switchVersion("main");
    await switchReachedMaterialization.promise;
    const opening = engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    // Hold the window open for two full daemon round trips. The open's own
    // active-version read was issued first and travels the same transport, so
    // an off-chain open has already reached the provider by the time these
    // return.
    await engine.listVersions();
    await engine.listVersions();
    expect(
      openedVersionIds,
      "drop the enqueueResult wrapper from openYDocSession. The open reads the active version while set-active is still blocked and opens the provider on [draftVersionId] — a live session on the version the user left, which the switch's sweep had already passed and could not vacate.",
    ).toEqual([]);

    releaseSwitch.resolve();
    const session = await opening;
    await switching;

    expect(openedVersionIds).toEqual(["main"]);
    await session.close({ settle: false });
    await engine.stop();
  });

  // The loopback has no conflict ledger, and mergeVersionIntoMain reads one
  // unconditionally to resume an already-open conflict. An empty page is the
  // honest answer for a workspace that has never conflicted, and it keeps the
  // merge under test a real merge instead of a rejected one.
  it("opens a session only after a running merge has finished reading and writing heads", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new ConflictFreeLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const order: string[] = [];
    const mergeReachedHeads = deferred();
    const releaseMerge = deferred();
    // conflicts.list runs after the merge's sweep and flush, before it reads
    // or writes a single head — the "merging immediately after an edit" window.
    const sessions = mockLiveSessions(loopback, undefined, undefined, async (request) => {
      if (request.method !== "conflicts.list") return;
      order.push("merge:reads-heads");
      mergeReachedHeads.resolve();
      await releaseMerge.promise;
    });
    const engine = capture(root, {
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async (options) => {
        order.push("ydoc:open");
        return await recordingProvider(openedVersionIds)(options);
      },
    });

    const created = await engine.createVersion("Draft");
    const draftVersionId = created.activeVersionId;
    const merging = engine.mergeVersionIntoMain(draftVersionId);
    await mergeReachedHeads.promise;
    const opening = engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    // Same verification staging as the switch test: two round trips the test
    // drives itself, so an unserialized open has provably reached the provider.
    await engine.listVersions();
    await engine.listVersions();
    expect(
      order,
      "drop the enqueueResult wrapper from openYDocSession. The open lands inside the merge, so this reads ['merge:reads-heads', 'ydoc:open'] — a session seeded from a head the merge is in the middle of replacing, and invisible to the sweep that was supposed to vacate it.",
    ).toEqual(["merge:reads-heads"]);

    releaseMerge.resolve();
    const session = await opening;
    await merging;

    expect(order).toEqual(["merge:reads-heads", "ydoc:open"]);
    await session.close({ settle: false });
    await engine.stop();
  });
});

describe("workspaceEngineCapture absent-head refusal against replication", () => {
  it("binds instead of refusing when a replicated update reached the session", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("content").insert(0, "written by a peer");
    const peerUpdate = Y.encodeStateAsUpdate(remoteDoc);
    const settles: string[] = [];
    let closedWithSettle: boolean | undefined;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        // After the open resolves, inside the awaited disk check. A timer beats
        // an lstat round trip, so the update lands where the race puts it —
        // which is what makes the recheck's POSITION testable, not just its
        // existence.
        // Delivered during the open, which the generation buffers and replays
        // the moment it installs — after the daemon has answered
        // head/lineage absent, before the guard runs. That is deterministic.
        // An arrival inside the awaited disk check is the
        // same defect one tick later, and the guard reads the count once after
        // that await, so both arrivals take the identical path. Racing an lstat
        // with a timer is not stageable, so this stages the half that is.
        options.onRemoteUpdate(peerUpdate);
        return {
          doc: remoteDoc,
          initialUpdate: Y.encodeStateAsUpdate(remoteDoc),
          contentKind: "plaintext",
          path: options.path,
          // The daemon's answer at open time: nothing committed, nothing
          // durable. The peer's update is still in flight behind it.
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "d".repeat(64), content: "written by a peer" } as never;
          },
          close: async (closeOptions?: { settle?: boolean }) => {
            closedWithSettle = closeOptions?.settle;
          },
        } as never;
      },
    });

    // The path is in neither the version nor on disk — every input the refusal
    // keys on says "missing". Only the peer's update says otherwise.
    const session = await engine.openYDocSession({
      path: "peer-created.md",
      onRemoteUpdate: () => undefined,
    });

    expect(session.path).toBe("peer-created.md");
    expect(settles).toEqual([]);
    expect(closedWithSettle).toBeUndefined();
    await expect(readFile(join(root, "peer-created.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await session.close({ settle: false });
    await engine.stop();
  });

  it("refuses without settling, and without calling it missing, when an update wins the release gap", async () => {
    // The narrower seam: the count is read, THEN the release is queued through
    // the operation chain, so an update can still arrive before the close
    // reaches the daemon. The daemon answers UnsettledClose — "content arrived
    // after all". The session cannot be handed back (its provider already
    // closed itself and dropped every subscription) and cannot be reopened (a
    // refused close reinserts the daemon entry with its lease held).
    //
    // Two things must be true of the answer. It may never call the path
    // missing, because something is writing it, and it may never leave the
    // surface writable over a session the daemon still holds.
    //
    // The orphan evicts when its close is refused, so the daemon does not
    // hold the session and the second hazard cannot arise. What remains is
    // the first, and `YDocOpenRacedError` is exactly it: this open's answer is
    // already stale, open it again — and the next open binds the lineage the
    // eviction preserved. The path this test guards is that the refusal is
    // decided by the refused close, not by a second look at the disk.
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const settles: string[] = [];
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        let deliver: (() => void) | null = () => options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "e".repeat(64), content: "arrived from a peer" } as never;
          },
          close: async (closeOptions?: { settle?: boolean; settleOnRefusal?: boolean }) => {
            closeCalls.push({ ...closeOptions });
            // The update lands in the gap the release was queued across, and
            // the daemon refuses because the lineage is now dirty.
            if (deliver) {
              deliver();
              deliver = null;
              throw new DaemonRefusalError(
                {
                  code: "INVALID_PARAMS",
                  message: "ydoc-unsettled-close",
                  retry: "no",
                },
                undefined,
              );
            }
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({ path: "peer-created.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(
      refusal,
      "drop the `dischargedByEvict` arm (#665) -> the recheck finds the path still absent and the refusal claims the version does not have a file a peer is writing into it.",
    ).toBeInstanceOf(YDocOpenRacedError);
    expect(isYDocPathNotInVersionError(refusal)).toBe(false);
    // The lease is gone, so the surface may fall back. That is what makes the
    // raced refusal safe here, where a held lease would need the unreleased one.
    expect(refusal).not.toBeInstanceOf(YDocSessionUnreleasedError);
    expect(evicts).toBe(1);
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    expect(settles).toEqual([]);
    await expect(readFile(join(root, "peer-created.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await engine.stop();
  });

  it("does not evict an orphan when its close fails for an unrelated reason", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const settles: string[] = [];
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        let deliver: (() => void) | null = () => options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return {
              sha256: "f".repeat(64),
              content: "arrived from a peer",
            } as never;
          },
          close: async (closeOptions?: { settle?: boolean; settleOnRefusal?: boolean }) => {
            closeCalls.push({ ...closeOptions });
            if (deliver) {
              deliver();
              deliver = null;
              throw new DaemonRefusalError(
                {
                  code: "INVALID_PARAMS",
                  message: "ydoc-something-else",
                  retry: "no",
                },
                undefined,
              );
            }
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({
        path: "peer-created.md",
        onRemoteUpdate: () => undefined,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(YDocSessionUnreleasedError);
    expect(refusal).not.toBeInstanceOf(YDocOpenRacedError);
    expect(evicts).toBe(0);
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    expect(settles).toEqual([]);
    await expect(readFile(join(root, "peer-created.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await engine.stop();
  });

  it("keeps refusing an uncaptured artifact even when a replicated update arrived", async () => {
    // Replication-as-existence is safe for a path with nothing on disk. It is
    // not safe when the file is there with bytes capture has not ingested: this
    // bind carries no seed, so its doc holds only the replicated update, and
    // settling it would write that over the user's file — while this same
    // capture chain is what keeps the watcher from ingesting those bytes.
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    await writeFile(join(root, "uncaptured.md"), "bytes the watcher has not seen", "utf8");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const settles: string[] = [];
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        // Delivered during the open, so the count is already non-zero when the
        // rules run. This input must not bypass the refusal.
        options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "f".repeat(64), content: "arrived from a peer" } as never;
          },
          close: async (closeOptions?: { settle?: boolean; settleOnRefusal?: boolean }) => {
            closeCalls.push({ ...closeOptions });
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({ path: "uncaptured.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(YDocUncapturedArtifactError);
    expect(settles).toEqual([]);
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    expect(await readFile(join(root, "uncaptured.md"), "utf8")).toBe(
      "bytes the watcher has not seen",
    );
    await engine.stop();
  });
});

it("records a person's own write as a local file edit, and an agent's under its run's person", async () => {
  const root = await createTestScratch("dohc-person-authored-");
  const requests: Request[] = [];
  const engine = capture(root, {
    rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
  });
  const person = { kind: "human", humanId: "local:installation" } as const;
  // A run Bob's synced edit started works for Bob, whoever is signed in here.
  const agent = {
    kind: "agent" as const,
    agentId: "agent-a",
    onBehalfOf: "bob",
    agentRunId: "run-a",
  };
  await engine.writeAuthoredFile(join(root, "hand.md"), "hand\n", person, { createOnly: true });
  const written = engine.writeAuthoredFile(join(root, "agent.txt"), "agent text\n", agent);
  Object.assign(agent, { onBehalfOf: "mallory", agentRunId: "run-other" });
  await written;
  expect(
    requests
      .filter((request) => request.method === VERSIONED_METHOD.textWrite)
      .map((request) => [
        (request.params as { path: string }).path,
        (request.params as { origin: string }).origin,
      ]),
  ).toEqual([
    ["hand.md", "local-file"],
    ["agent.txt", "api"],
  ]);
  expect(await liveMomentAuthors(engine)).toEqual([
    [person],
    [{ kind: "agent", agentId: "agent-a", onBehalfOf: "bob", agentRunId: "run-a" }],
  ]);
  await engine.stop();
});

it.each(["pending-placement", "replaced"] as readonly (
  | "pending-placement"
  | "undone"
  | "deleted"
  | "renamed"
  | "superseded"
  | "replaced"
)[])("checks the real Duplicate receipt guard when the copy is %s", async (state) => {
  const root = await createTestScratch("duplicate-receipt-guard-");
  const loopback = new VersionedLoopbackEngine();
  const requests: Request[] = [];
  const sessions = mockLiveSessions(loopback, requests);
  const store = createCaptureLiveStores(
    { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
    sessions,
  ).store;
  const operationId = "dohc-operation:11111111-1111-4111-8111-111111111111";
  const path = "copy.md";
  const target = { workspaceId: WORKSPACE_ID, versionId: "main", path };
  await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
  await store.writeTextFile({
    ...target,
    text: "copied",
    metadata: { origin: "api", correlationId: operationId },
  });
  // The loopback has no operation ledger. Only its header is supplied here;
  // identity resolution and moment reads use the loopback's actual state.
  vi.spyOn(store, "readHistoryOperation").mockResolvedValue({
    operationId,
    versionId: "main",
    momentCount: 1,
    kind: "file-duplicate",
  });
  const engine = capture(root, { store, rustEngineSessions: sessions });
  const readReceipt = () =>
    engine.changePathsAs(
      ["source.md"],
      { operation: "duplicate", operationId, author: RESTORER },
      async (held) => {
        requests.length = 0;
        const result = await held.readDuplicate(operationId, path);
        expect(requests.every((request) => request.method !== VERSIONED_METHOD.historyPage)).toBe(
          true,
        );
        const moments = requests.filter(
          (request) => request.method === VERSIONED_METHOD.momentsList,
        );
        expect(moments.length).toBeLessThanOrEqual(1);
        if (moments.length) expect(moments[0]?.params).toMatchObject({ limit: 1 });
        return result;
      },
      () => [],
    );
  try {
    // Valid even before any copy exists on disk.
    expect(await readReceipt()).toEqual({ path });
    if (state === "pending-placement") return;
    if (state === "undone" || state === "deleted" || state === "replaced") {
      await store.deleteTextFile({
        ...target,
        metadata: { origin: state === "undone" ? "restore" : "api" },
      });
    }
    if (state === "renamed") {
      await store.renameTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        fromPath: path,
        toPath: "renamed.md",
        metadata: { origin: "api" },
      });
    }
    if (state === "superseded" || state === "replaced") {
      await store.writeTextFile({
        ...target,
        text: "later",
        metadata: { origin: "api", correlationId: "later-operation" },
      });
    }
    expect(await readReceipt()).toBeNull();
  } finally {
    await engine.stop();
  }
});

it("drops an undone pending-placement receipt through the real guard before a fresh Duplicate", async () => {
  const root = await createTestScratch("duplicate-pending-undo-receipt-");
  await writeFile(join(root, "source.md"), "Original");
  const loopback = new VersionedLoopbackEngine();
  const sessions = mockLiveSessions(loopback);
  const store = createCaptureLiveStores(
    { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
    sessions,
  ).store;
  await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
  // Only the operation header is supplied; the receipt guard reads actual heads and moments.
  vi.spyOn(store, "readHistoryOperation").mockImplementation(async ({ operationId }) => ({
    operationId,
    versionId: "main",
    momentCount: 1,
    kind: "file-duplicate",
  }));
  const engine = capture(root, { store, rustEngineSessions: sessions });
  const commits: string[] = [];
  const pendingCapture: Pick<WorkspaceEngineCapture, "changePathsAs"> = {
    changePathsAs: (paths, authored, work, removed) =>
      engine.changePathsAs(
        paths,
        authored,
        (held) =>
          work({
            ...held,
            recordDisk: async (_path, files) => [...files],
            duplicateFile: async (_from, path) => {
              commits.push(authored.operationId!);
              await store.writeTextFile({
                workspaceId: WORKSPACE_ID,
                versionId: "main",
                path,
                text: "Original",
                metadata: { origin: "api", correlationId: authored.operationId },
              });
              const materialized = commits.length > 1;
              if (materialized) await writeFile(join(root, path), "Original");
              return { path, materialized };
            },
          }),
        removed,
      ),
  };
  const operation = {
    workspace: { workspaceId: WORKSPACE_ID, rootPath: root },
    assertCurrent() {},
  };
  await openedLocalState(operation.workspace);
  const run = () => duplicateWorkspaceFile(operation, "source.md", RESTORER, pendingCapture);
  const directory = join(root, ".dohc/local/duplicate-pending");
  try {
    const pending = await run();
    expect(pending.materialized).toBe(false);
    expect(existsSync(join(root, pending.path))).toBe(false);
    const receipt = join(directory, (await readdir(directory))[0]!);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
      operationId: pending.operationId,
    });
    // The Rust pending-create proof exercises the Undo transaction and placement.
    // Apply its resulting head here, without ever writing the cancelled copy.
    await store.deleteTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: pending.path,
      metadata: { origin: "restore" },
    });
    const fresh = await run();
    expect(fresh.operationId).not.toBe(pending.operationId);
    expect(fresh.path).toBe(pending.path);
    expect(commits).toEqual([pending.operationId, fresh.operationId]);
    expect(await readdir(directory)).toEqual([]);
    expect(await readFile(join(root, fresh.path), "utf8")).toBe("Original");
  } finally {
    await engine.stop();
  }
});
