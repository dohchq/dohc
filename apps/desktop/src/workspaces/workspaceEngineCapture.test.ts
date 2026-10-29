import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import {startServerOwnerDelivery} from "./serverOwnerDelivery";
import type { MomentAuthor } from "@dohc/workspace-contracts";
import type {
  MaterializeRelayPullPage,
  RelayMaterializedPath,
} from "@dohc/workspace-contracts/relay";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import { denyRead, restoreRead } from "@dohc/workspace-fs/testing";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { outsideWriteCopies, OutsideWriteCopyError } from "./outsideWriteCopies";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { mockDaemonSessions, mockLiveSessions } from "../testing/liveEngineSessions";
import { createInMemoryWorkspaceActivity as createWorkspaceActivity } from "./workspaceActivity.testSupport";
import {
  DAEMON_CAPTURE_HEALTH_POLL_MS,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  AuthoredTextChangedError,
  MAX_SETTLED_FILE_BYTES,
  UnsupportedWorkspacePathError,
  assertGeneratedMarkdownPath,
  createDefaultDiskWriter,
  createWorkspaceEngineCapture,
  isVolumeSharesNewFilesCause,
  isYDocPathNotInVersionError,
  probeEngineStoreRefusal,
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
  YdocReleasedWithSettleFailureError,
  type ArtifactAssetDescriptor,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
  VERSIONED_METHOD,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { EngineWorkspaceSessions, EngineWorkspaceShuttingDownError } from "@dohc/workspace-engine-client/daemon";
import {
  createCaptureLiveStores,
  EngineCaptureNotSettledError,
  type CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";
import * as Y from "yjs";
import { MAX_DESKTOP_CAPTURE_TEXT_BYTES } from "@dohc/workspace-engine-client/limits";
import { deferred } from "../testing/deferred";
import { duplicateWorkspaceFile } from "./workspaceDuplicate";

import { createTestScratch } from "./testTemp";
import { listLiveDraftRecovery, workspaceDraftStore } from "./liveDraftRecovery";
import { createRelaySyncEngine } from "./relaySyncEngine";
import { fakeLocalStateOpens, openedLocalState } from "../testing/preparedLocalState";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "./workspaceTextLimits";

vi.mock("node:timers/promises", { spy: true });

// The person a restore names, as desktop main reads them.
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

it.each(["text", "delete"])("replays a keyed %s restore without reversing a later edit", async kind => {
  const root = await createTestScratch("dohc-keyed-restore-");
  const sessions = mockLiveSessions(new VersionedLoopbackEngine());
  const store = createCaptureLiveStores({workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID}, sessions).store;
  const target = {workspaceId: WORKSPACE_ID, versionId: "main", path: "notes/file.txt", metadata: {origin: "api" as const}};
  await store.ensureMainVersion({workspaceId: WORKSPACE_ID});
  if (kind === "text") await store.writeTextFile({...target, text: "old"});
  const changed = await store.writeTextFile({...target, text: "new"});
  await write(root, target.path, "new");
  const engine = capture(root, {store, rustEngineSessions: sessions});
  const options = {expectedHeadMomentId: changed.moment.id, requestId: "restore/saved-session-file"};
  const first = await engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER, options);
  const newer = await store.writeTextFile({...target, text: "teammate"});
  await write(root, target.path, "teammate");
  await expect(engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER, {...options, requestId: "another-session"})).rejects.toMatchObject({name: "RestoreHeadChangedError"});
  expect(await engine.restoreFileToBeforeMoment(changed.moment.id, {kind: "human", humanId: "another-owner"}, options)).toEqual(first);
  const moments = await store.listMoments({workspaceId: WORKSPACE_ID, versionId: "main", objectId: changed.moment.objectId, limit: 100});
  expect(moments.moments.filter(m => m.metadata.correlationId === options.requestId && m.metadata.origin === "restore")).toHaveLength(1);
  expect((await store.readTextFile(target))?.objectId).toBe(newer.moment.objectId);
  expect(await readFile(join(root, target.path), "utf8")).toBe("teammate");
  await engine.stop();
});

it.each([["text", "error"], ["text", "conflict"], ["binary", "conflict"], ["binary", "superseded"]] as const)(
  "never adopts an unconfirmed keyed %s restore (%s) on retry", async (kind, outcome) => {
    const root = await createTestScratch("dohc-keyed-restore-unpublished-");
    const loopback = new VersionedLoopbackEngine();
    const send = loopback.sendRequest.bind(loopback);
    const unpublished = new Set<string>();
    vi.spyOn(loopback, "sendRequest").mockImplementation(async request => {
      const response = await send(request);
      const params = request.params as Record<string, JsonValue>;
      // The daemon's request ledger answers as the injected publication ended.
      if (request.method === VERSIONED_METHOD.publicationApplied) {
        return {...response, result: response.result === true && !unpublished.has(params.momentId as string)};
      }
      if ((request.method !== VERSIONED_METHOD.textWrite && request.method !== VERSIONED_METHOD.binaryWrite) || params.origin !== "restore") return response;
      const result = response.result as Record<string, JsonValue>;
      unpublished.add((result.moment as Record<string, JsonValue>).momentId as string);
      return {...response, result: {...result, materialized: false, materializeOutcome: outcome}};
    });
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores({workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID}, sessions).store;
    const target = {workspaceId: WORKSPACE_ID, versionId: "main", path: kind === "text" ? "note.txt" : "image.bin", metadata: {origin: "api" as const}};
    const current = kind === "text" ? "current" : Buffer.from([0, 255, 2]);
    await store.ensureMainVersion({workspaceId: WORKSPACE_ID});
    if (kind === "text") await store.writeTextFile({...target, text: "original"});
    else await store.writeBinaryFile({...target, bytes: Buffer.from([0, 255, 1])});
    const changed = kind === "text"
      ? await store.writeTextFile({...target, text: "current"})
      : await store.writeBinaryFile({...target, bytes: Buffer.from([0, 255, 2])});
    await write(root, target.path, current);
    const engine = capture(root, {store, rustEngineSessions: sessions});
    const options = {expectedHeadMomentId: changed.moment.id, requestId: "restore/unpublished-session-file"};
    try {
      await expect(engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER, options)).rejects.toThrow();
      expect(unpublished.size).toBe(1);
      await expect(engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER, options)).rejects.toMatchObject({name: "RestoreHeadChangedError"});
      expect(await engine.findRestoreReceipt(changed.moment.id, options.requestId)).toBeNull();
      expect(await engine.publicationApplied([...unpublished][0]!, options.requestId)).toBe(false);
      expect(await readFile(join(root, target.path))).toEqual(Buffer.from(current));
    } finally {
      await engine.stop();
    }
  });

// chmod/ACL-based fixtures cannot make a path unreadable for root (root
// ignores file modes), so every test that needs an unreadable path skips
// under uid 0.
const itNonRoot = process.getuid?.() === 0 ? it.skip : it;

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
  onOutsideWriteCopies?: WorkspaceEngineCaptureOptions["onOutsideWriteCopies"];
  onKeptFiles?: WorkspaceEngineCaptureOptions["onKeptFiles"];
  onRetainedCopies?: WorkspaceEngineCaptureOptions["onRetainedCopies"];
  onHeldFiles?: WorkspaceEngineCaptureOptions["onHeldFiles"];
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
    rustEngineSessions:
      rustEngineSessions ?? mockLiveSessions(new VersionedLoopbackEngine()),
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
    ["merges a text file's old spelling before its new one", "notes.md", "Notes.md", ["notes.md", "Notes.md"]],
    ["keeps path order for a rename to another name", "b.md", "a.md", ["a.md", "b.md"]],
    ["merges a dotless i's old spelling first", "\u0131.md", "I.md", ["\u0131.md", "I.md"]],
    ["merges a normalization respelling's old spelling first", "caf\u00e9.md", "cafe\u0301.md", ["caf\u00e9.md", "cafe\u0301.md"]],
  ])("%s", async (_name, from, to, order) => {
    const root = await createTestScratch("dohc-text-merge-order-");
    const loopback = new VersionedLoopbackEngine();
    const send = loopback.sendRequest.bind(loopback);
    const merged: string[] = [];
    vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
      if (request.method === "conflicts.list") {
        return { id: request.id, result: { conflicts: [], nextAfterConflictId: null } };
      }
      if (request.method === VERSIONED_METHOD.versionsMerge) {
        merged.push((request.params as { path: string }).path);
      }
      return await send(request);
    });
    loopback.seedTextFile({ workspace: WORKSPACE_ID, path: from, text: "old\n" });
    await write(root, from, "old\n");
    const sessions = mockLiveSessions(loopback);
    const stores = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    );
    const engine = capture(root, { store: stores.store, rustEngineSessions: sessions });
    try {
      const draftId = (await engine.createVersion("Draft")).activeVersionId;
      await stores.store.deleteTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: draftId,
        path: from,
        metadata: { origin: "api" },
      });
      loopback.seedTextFile({
        workspace: WORKSPACE_ID,
        versionId: draftId,
        path: to,
        text: "new\n",
      });
      await engine.switchVersion("main");

      await engine.mergeVersionIntoMain(draftId);
      expect(merged).toEqual(order);
    } finally {
      await engine.stop();
    }
  });
});

describe("probeEngineStoreRefusal", () => {
  it("probes through the exact attachment session key", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const run = vi.spyOn(sessions, "run");
    const attachmentId = Symbol("attachment");

    await expect(
      probeEngineStoreRefusal(
        { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId },
        sessions,
      ),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalled();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      rootPath: root,
      attachmentId,
    });
  });

  it("rethrows an unrecognized engine error", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const probeError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const sessions = mockLiveSessions(
      new VersionedLoopbackEngine(),
      undefined,
      () => ({ deferredWrites: [], settled: true, running: true, degraded: false, heldFiles: [] }),
      async () => {
        throw probeError;
      },
    );

    await expect(
      probeEngineStoreRefusal(
        {
          workspaceId: WORKSPACE_ID,
          rootPath: root,
          attachmentId: WORKSPACE_ATTACHMENT_ID,
        },
        sessions,
      ),
    ).rejects.toBe(probeError);
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
        const params = request.params as { createOnly?: boolean; path: string; text?: string; bytesBase64?: string; expectedSha256?: string };
        const writing = request.method === VERSIONED_METHOD.textWrite || request.method === VERSIONED_METHOD.textWriteBlob;
        const key = request.idempotencyKey ?? String(request.id);
        if (writing && !completed.has(key)) {
          const current = await readFile(join(root, params.path)).catch(() => null);
          if (params.createOnly && current !== null) throw new VersionedTextStoreError("target-path-exists", "target-path-exists");
          if (params.expectedSha256 !== undefined && (current === null || createHash("sha256").update(current).digest("hex") !== params.expectedSha256)) {
            throw new VersionedTextStoreError("write-precondition-failed", "write-precondition-failed");
          }
        }
        const response = await target.sendRequest(request);
        if (writing && !completed.has(key)) {
          const path = join(root, params.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, params.text ?? Buffer.from(params.bytesBase64!, "base64"), { flag: params.createOnly ? "wx" : "w" });
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
  // DRAINED, not capped. An earlier draft asked for one 500-row page, which
  // returns the newest 500 — so the moment a test recorded more, the reversed
  // array stopped being oldest-first and every count and sequence assertion
  // below would have compared against a truncated page without saying so. A cap
  // here is a limit rejecting valid work; paging costs nothing and removes the
  // question. (Same correction as the moments reader on #417.)
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

// A loopback whose versioned requests reject while `failing` is true — the
// daemon-path stand-in for a broken engine store. Only the calls that carry
// history fail: workspace open/close, capture flush, and watcher status are
// answered by mockLiveSessions before the request reaches here, exactly as a
// live daemon whose store is failing would still answer its lifecycle calls.
function failableLoopback(match: (request: Request) => boolean = () => true): {
  loopback: VersionedLoopbackEngine;
  state: { failing: boolean };
} {
  const real = new VersionedLoopbackEngine();
  const state = { failing: true };
  const loopback = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== "sendRequest") return Reflect.get(target, prop, receiver);
      return async (request: Request) => {
        if (state.failing && match(request)) {
          throw new Error("engine store unavailable");
        }
        return await target.sendRequest(request);
      };
    },
  });
  return { loopback, state };
}

// The authors each recorded moment carries, oldest first, with null for
// actor-neutral.
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
    const flushIndex = requests.findIndex(
      (request) => request.method === "capture.flush",
    );
    expect(flushIndex, "omit the daemon flush in switchVersion. Source metadata is listed without a capture settlement between the target preflight and the before/after comparison.").toBeGreaterThanOrEqual(0);
    expect(
      requests
        .slice(flushIndex + 1)
        .some((request) => request.method === VERSIONED_METHOD.textList),
    ).toBe(true);
    expect(
      loopback.requests.some(
        (request) => request.method === VERSIONED_METHOD.versionsSetActive,
      ),
    ).toBe(true);
    expect(draft.activeVersionId).not.toBe("main");
    await engine.stop();
  });

  it("flushes daemon capture before resolving a file object id", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "just-saved.md",
      text: "ready for chat",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    const resolve = engine.resolveFileForPath;
    const file = await resolve("just-saved.md");
    const objectId = file?.objectId;
    expect(file?.path).toBe("just-saved.md");
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === "files.resolve",
      );

    expect(objectId).toBeTruthy();
    expect(await engine.filePathForObjectId(objectId!)).toBe("just-saved.md");
    expect(requests.filter(request => request.method === VERSIONED_METHOD.textList)).toHaveLength(0);
    expect(requests.filter(request => request.method === VERSIONED_METHOD.textRead || request.method === VERSIONED_METHOD.textReadBlob)).toHaveLength(0);
    expect(relevant, "remove resolveFileForPath's flushCapture call. The read remains, making this order assertion fail on the missing first entry.").toEqual(["capture.flush", "files.resolve"]);
    await engine.stop();
  });

  it("lists one file's moments in the active version when given its object id", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    for (const [path, text, objectId] of [
      ["plan.md", "# Plan\n", "object-plan"],
      ["other.md", "# Other\n", "object-other"],
      ["plan.md", "# Plan\n\nShip Friday.\n", "object-plan"],
    ] as const) {
      loopback.seedTextFile({ workspace: WORKSPACE_ID, path, text, objectId });
    }
    const engine = capture(root, { rustEngineSessions: mockLiveSessions(loopback, requests) });

    const page = await engine.listMoments({ limit: 10, objectId: "object-plan" });
    expect(page.moments.map((moment) => [moment.path, moment.objectId, moment.protected])).toEqual([
      ["plan.md", "object-plan", false],
      ["plan.md", "object-plan", false],
    ]);
    expect(page.activeVersionId).toBe("main");
    expect(requests.filter((request) => request.method === VERSIONED_METHOD.historyPage)).toEqual([expect.objectContaining({ params: { workspaceId: WORKSPACE_ID, objectId: "object-plan", limit: 10 } })]);
    expect(requests.some((request) => request.method === VERSIONED_METHOD.momentsList)).toBe(false);
    expect((await engine.listMoments({ limit: 10 })).moments).toHaveLength(3);
    const first = await engine.listMoments({ limit: 1, objectId: "object-plan" });
    expect(first.nextCursor).not.toBeNull();
    await engine.listMoments({ limit: 1, objectId: "object-plan", cursor: first.nextCursor! });
    expect(requests.filter(request => request.method === VERSIONED_METHOD.historyPage).at(-1)?.params).toMatchObject({ versionId: "main", cursor: first.nextCursor });
    await engine.stop();
  });

  it.each([
    "ownerPending", "declined", "mismatch", "engine-store-busy", "live-settlement-capacity",
  ] as const)(
    "defers an open adoption (%s) while another record proceeds", async (status) => {
    const root = await createTestScratch("dohc-engine-capture-");
    const path = "tasks/pending.md";
    const objectId = "pending-object";
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: "main", path, objectId, text: "# Body\n" });
    const sessions = mockLiveSessions(loopback);
    const liveStore = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root,
      attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
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
        if (property === "listPendingCollectionAdoptions") return async () => ({
          adoptions: [
            ...(pending ? [{ versionId: "main", recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
              collectionPath: "tasks", filePath: path, objectId: status === "mismatch" ? "stale-object" : objectId }] : []),
            ...(healthyPending ? [{ versionId: "main", recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
              collectionPath: "tasks", filePath: "tasks/healthy.md", objectId: "healthy-object" }] : []),
          ], nextCursor: null,
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
    const open = vi.fn(async (input: EngineYdocProviderSessionOptions) => input.path !== path
      ? { path: input.path, evict: healthyEvict } as unknown as EngineYdocProviderSession : ({
      doc, initialUpdate: Y.encodeStateAsUpdate(doc), contentKind: "richdoc" as const,
      path, objectId, versionId: "main", head: "present" as const, lineage: "existing" as const,
      unsettled: false, close, evict,
      applyLocalUpdate: async (update: Uint8Array) => { Y.applyUpdate(doc, update); },
      adoptCollectionRecord: async () => {
        if (transient && blocked) {
          throw new DaemonRefusalError({ code: "OVERLOADED", message: status, retry: "afterBackoff" }, undefined);
        }
        if (transient) {
          pending = false;
          doc.getMap("frontmatter").set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa");
          return "settled" as const;
        }
        if (status === "ownerPending") doc.getMap("frontmatter").set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa");
        return status === "declined" ? "declined" as const : "ownerPending" as const;
      },
      settleNow: async () => { throw new YdocOwnerDraftPendingError({
        binding: { workspaceId: WORKSPACE_ID, mainVersionId: "main", objectId,
          lineageClaimId: "a".repeat(64), currentPath: path, selectorPaths: [path], restoreFenceGeneration: 0 },
        relayDatabaseNamespace: "relay", revision: 1, acceptedCursor: 0, nativeHeadSequence: 1, nativeUnsettled: false,
        outboxId: "outbox", pendingBytes: 20, state: "active",
      }); },
    }));
    const errors: unknown[] = [];
    const engine = capture(root, { store, rustEngineSessions: sessions, openRustYDocProviderSession: open,
      onError: (_context, error) => errors.push(error) });
    const session = await engine.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    await engine.flush();
    expect(session.doc.getMap("frontmatter").toJSON()).toEqual(status === "ownerPending"
      ? { Name: "Manual", id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa" } : { Name: "Manual" });
    expect(open).toHaveBeenCalledTimes(2);
    // The note open and the record's adoption both read a seed past the
    // in-band cap, up to the WYSIWYG editor's limit (#2521).
    for (const [options] of open.mock.calls) {
      expect(options).toMatchObject({ largeSeed: { workspaceId: WORKSPACE_ID, maxBytes: WYSIWYG_MARKDOWN_THRESHOLD_BYTES } });
    }
    expect(healthyEvict).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(evict).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    healthyPending = true;
    reconcile.mockRejectedValueOnce(new DaemonRefusalError({
      code: "INTERNAL", message: "reconciliation-failed", retry: "no",
    }, undefined));
    await expect(engine.flush()).rejects.toThrow("reconciliation-failed");
    healthyPending = false;
    // Retry after capacity clears, or observe adoption completed by the owner host.
    if (transient) blocked = false;
    else pending = false;
    await engine.flush();
    expect(pending).toBe(false);
    if (transient) expect(session.doc.getMap("frontmatter").get("id")).toBe("rec_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(errors).toEqual([]);
    await session.close({ settle: false });
    await engine.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["OVERLOADED", "engine-store-busy", "afterBackoff", false],
    ["OVERLOADED", "live-settlement-capacity", "afterBackoff", false],
    ["INTERNAL", "live-settlement-capacity", "no", true],
  ] as const)("retries an open adoption refused with %s %s on the next pass", async (code, message, retry, reported) => {
    const root = await createTestScratch("dohc-engine-capture-");
    const path = "tasks/pending.md";
    const objectId = "pending-object";
    const recordId = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: "main", path, objectId, text: "# Body\n" });
    const sessions = mockLiveSessions(loopback);
    const liveStore = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root,
      attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    let pending = true;
    const store = new Proxy(liveStore, {
      get(target, property) {
        if (property === "flushCapture" || property === "reconcileCapture") return async () => undefined;
        if (property === "listPendingCollectionAdoptions") return async () => ({
          adoptions: pending ? [{ versionId: "main", recordId, collectionPath: "tasks", filePath: path, objectId }] : [],
          nextCursor: null,
        });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const refusal = new DaemonRefusalError({ code, message, retry }, undefined);
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("Name", "Manual");
    const close = vi.fn(async () => undefined);
    const evict = vi.fn(async () => undefined);
    let adoptions = 0;
    const adopt = vi.fn(async () => {
      if (++adoptions === 1) throw refusal;
      doc.getMap("frontmatter").set("id", recordId);
      pending = false;
      return "settled" as const;
    });
    const open = vi.fn(async () => ({
      doc, initialUpdate: Y.encodeStateAsUpdate(doc), contentKind: "richdoc" as const,
      path, objectId, versionId: "main", head: "present" as const, lineage: "existing" as const,
      unsettled: false, close, evict,
      applyLocalUpdate: async (update: Uint8Array) => { Y.applyUpdate(doc, update); },
      adoptCollectionRecord: adopt,
      settleNow: async () => undefined,
    }) as unknown as EngineYdocProviderSession);
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, { store, rustEngineSessions: sessions, openRustYDocProviderSession: open,
      onError: (context, error) => errors.push({ context, error }) });
    const session = await engine.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    await engine.flush();
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(pending).toBe(false);
    expect(session.doc.getMap("frontmatter").toJSON()).toEqual({ Name: "Manual", id: recordId });
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(evict).not.toHaveBeenCalled();
    expect(errors).toEqual(reported ? [{ context: `collection adoption of ${path}`, error: refusal }] : []);
    await session.close({ settle: false });
    await engine.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("adopts records discovered by this flush's capture in one fixed second pass", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    let pending = false;
    const calls: string[] = [];
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => { calls.push("capture"); pending = true; },
      listPendingCollectionAdoptions: async () => {
        calls.push("list");
        return { adoptions: pending ? [{ versionId: "main", recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
          collectionPath: "tasks", filePath: "tasks/record.md", objectId: "record" }] : [], nextCursor: null };
      },
      reconcileCapture: async () => { calls.push("reconcile"); pending = false; },
    } as unknown as CaptureVersionedTextStore;
    const sessions = { run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
      task({ client: {}, workspace: "workspace" }) } as unknown as EngineWorkspaceSessions;
    const engine = capture(root, { store, rustEngineSessions: sessions,
      openRustYDocProviderSession: async input => ({path: input.path, evict: async () => { calls.push("evict"); }}) as EngineYdocProviderSession });
    await engine.flush();
    expect(calls).toEqual(["list", "capture", "list", "evict", "reconcile"]);
    expect(pending).toBe(false);
    await engine.stop();
  });

  it("continues draining pending collection adoptions after one adoption fails", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    let listed = false;
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => undefined,
      listPendingCollectionAdoptions: async () => {
        if (listed) return { adoptions: [], nextCursor: null };
        listed = true;
        return {
          adoptions: [
            {
              versionId: "main",
              recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
              collectionPath: "projects",
              filePath: "projects/poisoned.md",
              objectId: "object-poisoned",
            },
            {
              versionId: "main",
              recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
              collectionPath: "projects",
              filePath: "projects/healthy.md",
              objectId: "object-healthy",
            },
          ],
          nextCursor: null,
        };
      },
    } as unknown as CaptureVersionedTextStore;
    const poison = new Error("poisoned adoption");
    let adoptionRuns = 0;
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) => {
        adoptionRuns += 1;
        if (adoptionRuns === 1) throw poison;
        return await task({ client: {}, workspace: "workspace" });
      },
    } as unknown as EngineWorkspaceSessions;
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) =>
        ({ path: options.path, evict: async () => undefined }) as EngineYdocProviderSession,
    });

    await engine.flush();

    expect(adoptionRuns).toBe(2);
    expect(errors).toEqual([
      {
        context: "collection adoption of projects/poisoned.md",
        error: poison,
      },
    ]);
    await engine.stop();
  });

  it.each([
    ["OVERLOADED", "engine-store-busy", "afterBackoff", false],
    ["OVERLOADED", "live-settlement-capacity", "afterBackoff", false],
    ["INTERNAL", "live-settlement-capacity", "no", true],
  ] as const)("retries a %s %s collection adoption provider on a later pass while other items proceed", async (code, message, retry, reported) => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoptions = [
      {
        versionId: "main",
        recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        collectionPath: "projects",
        filePath: "projects/busy.md",
        objectId: "object-busy",
      },
      {
        versionId: "main",
        recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        collectionPath: "projects",
        filePath: "projects/healthy.md",
        objectId: "object-healthy",
      },
    ];
    const completed = new Set<string>();
    const attempts: string[] = [];
    const leasedPaths = new Set<string>();
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => {
        attempts.push("reconcile");
      },
      listPendingCollectionAdoptions: async () => ({
        adoptions: adoptions.filter(
          (adoption) => !completed.has(adoption.filePath),
        ),
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const busy = new DaemonRefusalError({ code, message, retry }, undefined);
    const expectedErrors = reported
      ? [{ context: "collection adoption of projects/busy.md", error: busy }]
      : [];
    const opens = new Map<string, number>();
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) => {
        opens.set(options.path, (opens.get(options.path) ?? 0) + 1);
        leasedPaths.add(options.path);
        let evictions = 0;
        return {
          path: options.path,
          evict: async () => {
            evictions += 1;
            attempts.push(`${options.path}:${evictions}`);
            if (options.path === "projects/busy.md" && evictions === 1) {
              throw busy;
            }
            leasedPaths.delete(options.path);
            completed.add(options.path);
          },
        } as EngineYdocProviderSession;
      },
    });

    await engine.flush();

    expect(completed).toEqual(new Set(["projects/healthy.md", "projects/busy.md"]));
    expect(attempts).toEqual([
      "projects/busy.md:1", "projects/healthy.md:1", "reconcile",
      "projects/busy.md:2", "reconcile",
    ]);
    expect(errors).toEqual(expectedErrors);

    await engine.flush();

    expect(completed).toEqual(
      new Set(["projects/healthy.md", "projects/busy.md"]),
    );
    expect(attempts).toEqual([
      "projects/busy.md:1",
      "projects/healthy.md:1",
      "reconcile",
      "projects/busy.md:2",
      "reconcile",
    ]);
    expect(opens).toEqual(
      new Map([
        ["projects/busy.md", 1],
        ["projects/healthy.md", 1],
      ]),
    );
    expect(errors).toEqual(expectedErrors);
    await engine.stop();
  });

  it("retains the provider after a cancelled eviction and reuses it on a later pass", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/cancelled.md",
      objectId: "object-cancelled",
    };
    const completed = new Set<string>();
    const attempts: string[] = [];
    const leasedPaths = new Set<string>();
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => {
        attempts.push("reconcile");
      },
      listPendingCollectionAdoptions: async () => ({
        adoptions: completed.has(adoption.filePath) ? [] : [adoption],
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const cancelled = new Error("cancelled while ydoc.evict was queued");
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    const errors: Array<{ context: string; error: unknown }> = [];
    let opens = 0;
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        leasedPaths.add(options.path);
        let evictions = 0;
        return {
          path: options.path,
          evict: async () => {
            evictions += 1;
            attempts.push(`${options.path}:${evictions}`);
            if (evictions === 1) throw cancelled;
            leasedPaths.delete(options.path);
            completed.add(options.path);
          },
        } as EngineYdocProviderSession;
      },
    });

    await engine.flush();

    expect(attempts).toEqual(["projects/cancelled.md:1", "projects/cancelled.md:2", "reconcile"]);
    expect(errors).toEqual([
      {
        context: "collection adoption of projects/cancelled.md",
        error: cancelled,
      },
    ]);

    await engine.flush();

    expect(completed).toEqual(new Set(["projects/cancelled.md"]));
    expect(attempts).toEqual([
      "projects/cancelled.md:1",
      "projects/cancelled.md:2",
      "reconcile",
    ]);
    expect(opens).toBe(1);
    await engine.stop();
  });

  it("releases a retained busy collection adoption provider after the file is deleted", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/deleted.md",
      objectId: "object-deleted",
    };
    await write(root, adoption.filePath, "# Deleted\n");
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => undefined,
      listPendingCollectionAdoptions: async () => ({
        adoptions: existsSync(join(root, adoption.filePath)) ? [adoption] : [],
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      undefined,
    );
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    let evictionAttempts = 0;
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async (options) =>
        ({
          path: options.path,
          evict: async () => {
            evictionAttempts += 1;
            if (existsSync(join(root, adoption.filePath))) throw busy;
          },
        }) as EngineYdocProviderSession,
    });

    await engine.flush();
    expect(evictionAttempts).toBe(2);

    await unlink(join(root, adoption.filePath));
    await engine.flush();
    const evictionAttemptsAfterDeletionPass = evictionAttempts;
    await engine.stop();

    expect(evictionAttemptsAfterDeletionPass).toBe(3);
  });

  it("releases a retained collection adoption when its provider path matches a renamed pending item", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const originalAdoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/original.md",
      objectId: "object-renamed",
    };
    const renamedAdoption = {
      ...originalAdoption,
      filePath: "projects/renamed.md",
    };
    let pendingAdoption = originalAdoption;
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => undefined,
      listPendingCollectionAdoptions: async () => ({
        adoptions: [pendingAdoption],
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      undefined,
    );
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    let originalProviderPath = originalAdoption.filePath;
    let originalEvictionAttempts = 0;
    let renamedEvictionAttempts = 0;
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async (options) => {
        if (options.path === originalAdoption.filePath) {
          return {
            get path() {
              return originalProviderPath;
            },
            evict: async () => {
              originalEvictionAttempts += 1;
              if (pendingAdoption === originalAdoption) throw busy;
            },
          } as EngineYdocProviderSession;
        }
        return {
          path: options.path,
          evict: async () => {
            renamedEvictionAttempts += 1;
          },
        } as EngineYdocProviderSession;
      },
    });

    await engine.flush();
    expect(originalEvictionAttempts).toBe(2);

    pendingAdoption = renamedAdoption;
    originalProviderPath = renamedAdoption.filePath;
    await engine.flush();
    const originalEvictionsAfterRenamePass = originalEvictionAttempts;
    const renamedEvictionsAfterRenamePass = renamedEvictionAttempts;
    await engine.stop();

    expect(renamedEvictionsAfterRenamePass).toBe(2);
    expect(originalEvictionsAfterRenamePass).toBe(3);
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
            if (
              options.transport === firstClient &&
              firstProviderEvictions++ === 0
            ) {
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
    expect(evictedTransports).toEqual([
      firstClient,
      firstClient,
      replacementClient,
    ]);
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

  it("flushes daemon capture before reading versions for a merge", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
    });

    const outcome = await engine
      .mergeVersionIntoMain("missing-version")
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === VERSIONED_METHOD.versionsList,
      );

    expect(relevant, "remove mergeVersionIntoMain's daemon flush. The versions read remains, making this order assertion fail on the missing first entry.").toEqual(["capture.flush", VERSIONED_METHOD.versionsList]);
    await engine.stop();
  });

  it("does not rewrite kept text when the resolution returns its new shared moment", async () => {
    const root = await createTestScratch("dohc-kept-text-no-rewrite-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions,
    );
    vi.spyOn(store, "resolveTextConflict").mockResolvedValue({
      conflict: { id: "kept", path: "trip.txt", targetVersionId: "main", chosenFrom: "current" },
      write: { snapshot: { versionId: "main", path: "trip.txt", text: "kept text" } },
      delete: null,
    } as unknown as Awaited<ReturnType<CaptureVersionedTextStore["resolveTextConflict"]>>);
    vi.spyOn(store, "listTextConflicts").mockResolvedValue({ conflicts: [], nextAfterConflictId: null });
    const diskWriter: EngineDiskWriter = {
      writeTextFile: vi.fn(), writeBinaryFile: vi.fn(), deletePath: vi.fn(),
    };
    const engine = capture(root, { store, rustEngineSessions: sessions, diskWriter });
    try {
      await engine.resolveConflict("kept", { kind: "keep-current" });
      expect(diskWriter.writeTextFile).not.toHaveBeenCalled();
      expect(diskWriter.writeBinaryFile).not.toHaveBeenCalled();
      expect(diskWriter.deletePath).not.toHaveBeenCalled();
    } finally { await engine.stop(); }
  });

  it("flushes daemon capture before reading conflicts for resolution", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
    });

    const outcome = await engine
      .resolveConflict("missing-conflict", { kind: "keep-current" })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) => method === "capture.flush" || method === "conflicts.list",
      );

    expect(relevant, "remove resolveConflict's daemon flush. The conflict lookup remains, making this order assertion fail on the missing first entry.").toEqual(["capture.flush", "conflicts.list"]);
    await engine.stop();
  });

  it("flushes daemon capture before reading a moment for restore", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
    });

    const outcome = await engine
      .restoreFileToBeforeMoment("missing-moment", RESTORER)
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === VERSIONED_METHOD.momentsGet,
      );

    expect(relevant, "remove restoreFileToBeforeMoment's daemon flush. The moment read remains, making this order assertion fail on the missing first entry.").toEqual(["capture.flush", VERSIONED_METHOD.momentsGet]);
    await engine.stop();
  });

  it("removes a renamed accepted response and preserves replacements on retry",async()=>{
    const root=await createTestScratch("dohc-response-undo-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const requests:Request[]=[];
    const sessions=mockLiveSessions(new VersionedLoopbackEngine(),requests);
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,authors:[{kind:"public",principalId:"public-a",grantId:"grant"}]}:moment;
    });
    await store.renameTextFile({workspaceId:WORKSPACE_ID,versionId:"main",fromPath:created.snapshot.path,toPath:"responses/moved.md",metadata:{origin:"api"}});
    await write(root,"responses/moved.md","response");
    const engine=capture(root,{store,rustEngineSessions:sessions});
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    requests.length = 0;
    const result=await engine.undoAcceptedAppResponse(selection);
    expect(requests.filter(request => request.method === VERSIONED_METHOD.textList)).toHaveLength(0);
    expect(result.status).toBe("deleted");expect(result.momentId).toBeTruthy();
    expect(existsSync(join(root,"responses/moved.md"))).toBe(false);
    const deletion=requests.findLast(request=>request.method==="versionedText.delete");
    expect(deletion).toMatchObject({idempotencyKey:"undo-a",params:{path:"responses/moved.md",expectedObjectId:created.object.id}});
    expect(deletion?.params).not.toHaveProperty("requestId");
    await engine.stop();
    const reopened=capture(root,{store,rustEngineSessions:sessions});
    // Another object now occupies the deleted path; retries cannot touch it.
    await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/moved.md",text:"replacement",metadata:{origin:"api"}});
    await write(root,"responses/moved.md","replacement");
    const retry=await reopened.undoAcceptedAppResponse(selection);
    expect(retry).toEqual({status:"deleted",momentId:result.momentId});
    expect(await readFile(join(root,"responses/moved.md"),"utf8")).toBe("replacement");
    expect(requests.filter(request=>request.method==="versionedText.delete")).toHaveLength(1);
    await reopened.stop();
  });

  it("names the agent on a response it removes during a run an automation started",async()=>{
    const root=await createTestScratch("dohc-response-agent-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const requests:Request[]=[];
    const sessions=mockLiveSessions(new VersionedLoopbackEngine(),requests);
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,authors:[{kind:"public",principalId:"public-a",grantId:"grant"}]}:moment;
    });
    await write(root,"responses/accepted-a.md","response");
    const engine=capture(root,{store,rustEngineSessions:sessions});
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    expect((await engine.undoAcceptedAppResponse(selection,{kind:"agent",agentId:"dohc-mcp",onBehalfOf:"local",depth:3})).status).toBe("deleted");
    const deletion=requests.findLast(request=>request.method==="versionedText.delete");
    expect(deletion).toMatchObject({
      idempotencyKey:"undo-a",params:{author:{kind:"agent",agentId:"dohc-mcp",onBehalfOf:"local",depth:3}},
    });
    expect(deletion?.params).not.toHaveProperty("requestId");
    await engine.stop();
  });

  it("pages long response history and recovers an interrupted deletion without deleting a restore",async()=>{
    const root=await createTestScratch("dohc-response-recovery-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const requests:Request[]=[];
    const sessions=mockLiveSessions(new VersionedLoopbackEngine(),requests);
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,authors:[{kind:"public",principalId:"public-a",grantId:"grant"}]}:moment;
    });
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    const engine=capture(root,{store,rustEngineSessions:sessions});
    for(let i=0;i<105;i++)await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:created.snapshot.path,text:`response ${i}`,metadata:{origin:"api"}});
    await write(root,created.snapshot.path,"response 104");
    const deleted=await engine.undoAcceptedAppResponse(selection);
    expect(deleted.status).toBe("deleted");
    // Recreate the bytes left by a crash between native commit and materialization.
    await write(root,created.snapshot.path,"response 104");
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual(deleted);
    expect(existsSync(join(root,created.snapshot.path))).toBe(false);
    await engine.restoreFileToBeforeMoment(deleted.momentId!, RESTORER);
    expect(requests.filter(request=>request.method==="versionedText.write").at(-1)?.params).toMatchObject({
      restoreBeforeMomentId: deleted.momentId,
      origin: "restore",
    });
    for(let i=0;i<105;i++)await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:created.snapshot.path,text:`restored ${i}`,metadata:{origin:"api"}});
    await write(root,created.snapshot.path,"restored 104");
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual(deleted);
    expect(await readFile(join(root,created.snapshot.path),"utf8")).toBe("restored 104");
    expect(requests.filter(request=>request.method==="versionedText.delete")).toHaveLength(1);
    await engine.stop();
  });

  it("reports stale disk bytes from a different response delete as a conflict",async()=>{
    const root=await createTestScratch("dohc-response-orphan-");
    const sessions=mockLiveSessions(new VersionedLoopbackEngine());
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,authors:[{kind:"public",principalId:"public-a",grantId:"grant"}]}:moment;
    });
    await store.renameTextFile({workspaceId:WORKSPACE_ID,versionId:"main",fromPath:created.snapshot.path,toPath:"responses/moved.md",metadata:{origin:"api"}});
    await write(root,"responses/moved.md","response");
    await store.deleteTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/moved.md",metadata:{origin:"api"}});
    const engine=capture(root,{store,rustEngineSessions:sessions});
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({status:"conflict"});
    expect(await readFile(join(root,"responses/moved.md"),"utf8")).toBe("response");
    await rm(join(root,"responses/moved.md"));
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({status:"already-absent"});
    await engine.stop();
  });

  it("refuses response removal with forged public attribution or uncaptured disk edits",async()=>{
    const root=await createTestScratch("dohc-response-conflict-");
    const sessions=mockLiveSessions(new VersionedLoopbackEngine());
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    await write(root,created.snapshot.path,"disk edit");
    const engine=capture(root,{store,rustEngineSessions:sessions});
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({status:"conflict"});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,authors:[{kind:"public",principalId:"public-a",grantId:"grant"}]}:moment;
    });
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({status:"conflict"});
    expect(await readFile(join(root,created.snapshot.path),"utf8")).toBe("disk edit");
    await engine.stop();
  });

  it.each(["present", "absent"])("explains a shared live file restore refusal with the artifact %s", async artifact => {
    const root = await createTestScratch("dohc-live-restore-refusal-");
    let deletionAttempts = 0;
    const sessions = mockLiveSessions(new VersionedLoopbackEngine(), undefined, undefined, request => {
      if (request.method === "versionedText.delete") {
        deletionAttempts += 1;
        throw new DaemonRefusalError(
          { code: "INVALID_PARAMS", message: "live-document-binding-active", retry: "no" },
          new Error("daemon response"),
        );
      }
    });
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    const created = await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "shared.md", text: "original", metadata: { origin: "api" } });
    if (artifact === "present") await write(root, "shared.md", "original");
    const engine = capture(root, { store, rustEngineSessions: sessions });
    await expect(engine.restoreFileToBeforeMoment(created.moment.id, RESTORER)).rejects.toThrow("dohc could not restore shared.md. This action is unavailable for shared live files.");
    expect(deletionAttempts).toBe(1);
    expect((await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "shared.md" }))?.text).toBe("original");
    if (artifact === "present") expect(await readFile(join(root, "shared.md"), "utf8")).toBe("original");
    else expect(existsSync(join(root, "shared.md"))).toBe(false);
    await engine.stop();
  });

  it.each(["binary source", "current binary artifact"])("explains a restore refusal from a %s", async route => {
    const root = await createTestScratch("dohc-live-binary-restore-refusal-");
    const binary = Uint8Array.of(0xff, 0x00, 0xfe);
    const refusal = new DaemonRefusalError(
      { code: "INVALID_PARAMS", message: "live-document-binding-active", retry: "no" },
      new Error("daemon response"),
    );
    let refuseBinaryWrites = false;
    let binaryAttempts = 0;
    const sessions = mockLiveSessions(new VersionedLoopbackEngine(), undefined, undefined, request => {
      if (refuseBinaryWrites && (request.method === VERSIONED_METHOD.binaryWrite || request.method === VERSIONED_METHOD.binaryWriteBlob)) {
        binaryAttempts += 1;
        throw refusal;
      }
    });
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path: "shared.md", metadata: { origin: "api" as const } };
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    if (route === "binary source") await store.writeBinaryFile({ ...target, bytes: binary });
    else await store.writeTextFile({ ...target, text: "original" });
    const changed = await store.writeTextFile({ ...target, text: "current" });
    const disk = route === "binary source" ? Buffer.from("current") : Buffer.from(binary);
    await write(root, target.path, disk);
    refuseBinaryWrites = true;
    const engine = capture(root, { store, rustEngineSessions: sessions });
    await expect(engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER)).rejects.toMatchObject({
      message: "dohc could not restore shared.md. This action is unavailable for shared live files. Continue editing at the current location.",
      cause: refusal,
    });
    expect(binaryAttempts).toBe(1);
    expect((await store.readTextFile(target))?.text).toBe("current");
    expect(await readFile(join(root, target.path))).toEqual(disk);
    await engine.stop();
  });

  it.each(["moment", "before", "after"])("admits the %s path inside restore before any mutation", async side => {
    const root = await createTestScratch("dohc-restore-path-admission-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path: "notes/a.md", metadata: { origin: "api" as const } };
    await store.writeTextFile({ ...target, text: "old" });
    const changed = await store.writeTextFile({ ...target, text: "current" });
    await write(root, target.path, "current");
    await write(root, ".dohc/files.toml", '[[rule]]\npath = "private/**"\ntracked = false\n');
    const original = changed.moment;
    vi.spyOn(store, "getMoment").mockResolvedValue({ ...original,
      path: side === "moment" ? "private/a.md" : original.path,
      payload: { before: { ...original.payload.before!, path: side === "before" ? "private/a.md" : target.path },
        after: { ...original.payload.after, path: side === "after" ? "private/a.md" : target.path } },
    });
    const engine = capture(root, { store, rustEngineSessions: sessions });
    try {
      await expect(engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER)).rejects.toThrow("This history moment is no longer available.");
      expect((await store.readTextFile(target))?.text).toBe("current");
      expect((await store.listMoments({ workspaceId: WORKSPACE_ID, limit: 20 })).moments).toHaveLength(2);
      expect(await readFile(join(root, target.path), "utf8")).toBe("current");
    } finally {
      await engine.stop();
    }
  });

  it.each(["untracked", "malformed"])("reads %s policy inside the queued restore before writing", async state => {
    const root = await createTestScratch("dohc-restore-queued-policy-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path: "notes/a.md", metadata: { origin: "api" as const } };
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
    const refused = expect(pendingRestore).rejects.toMatchObject({ name: "RestorePolicyRefusalError",
      reason: state === "malformed" ? "policy-unreadable" : "path-not-admitted",
      message: expect.stringContaining(state === "malformed" ? "files.toml" : "This history moment is no longer available."),
    });
    await write(root, ".dohc/files.toml", state === "malformed" ? "[[rules] invalid" : '[[rule]]\npath = "notes/**"\ntracked = false\n');
    release.resolve();
    await pendingList;
    try {
      await refused;
      expect((await store.readTextFile(target))?.text).toBe("current");
      expect((await originalList({ workspaceId: WORKSPACE_ID, limit: 20 })).moments).toHaveLength(2);
      expect(await readFile(join(root, target.path), "utf8")).toBe("current");
    } finally {
      await engine.stop();
    }
  });

  it("preserves the outside file when History restore publication conflicts", async () => {
    const root = await createTestScratch("dohc-restore-conflict-");
    const loopback = new VersionedLoopbackEngine();
    let conflict = false;
    const send = loopback.sendRequest.bind(loopback);
    vi.spyOn(loopback, "sendRequest").mockImplementation(async request => {
      const response = await send(request);
      if (conflict && request.method === VERSIONED_METHOD.textWrite) {
        await write(root, "note.txt", "outside edit");
        return { ...response, result: { ...(response.result as Record<string, JsonValue>), materialized: false, materializeOutcome: "conflict" } };
      }
      return response;
    });
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path: "note.txt", metadata: { origin: "api" as const } };
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    await store.writeTextFile({ ...target, text: "original" });
    const changed = await store.writeTextFile({ ...target, text: "current" });
    await write(root, target.path, "current");
    conflict = true;
    const engine = capture(root, { store, rustEngineSessions: sessions });
    await expect(engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER)).rejects.toBeInstanceOf(AuthoredTextChangedError);
    expect(await readFile(join(root, target.path), "utf8")).toBe("outside edit");
    await engine.stop();
  });

  it("does not save a Collection file stored as binary as an edit when its bytes are unchanged", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockDaemonSessions({ rootPath: root, workspaceId: WORKSPACE_ID, loopback: new VersionedLoopbackEngine() });
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path: "trip/automations.yaml", metadata: { origin: "api" as const } };
    const current = "version: 1\nautomations: []\n";
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    await store.writeBinaryFile({ ...target, bytes: Buffer.from("version: 1\n") });
    const changed = await store.writeBinaryFile({ ...target, bytes: Buffer.from(current) });
    await write(root, target.path, current);
    const engine = capture(root, { store, rustEngineSessions: sessions });

    await engine.restoreFileToBeforeMoment(changed.moment.id, RESTORER);

    const summaries = (await store.listMoments({ workspaceId: WORKSPACE_ID, limit: 20 })).moments.map(
      (moment) => moment.metadata.summary,
    );
    expect(summaries).not.toContain("Saved latest edits");
    expect(await readFile(join(root, target.path), "utf8")).toBe("version: 1\n");
    await engine.stop();
  });

  it("restores nothing when the current text has the bytes of the binary state before the moment", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path: "trip/automations.yaml", metadata: { origin: "api" as const } };
    const original = "version: 1\nautomations: []\n";
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    await store.writeBinaryFile({ ...target, bytes: Buffer.from(original) });
    const edited = await store.writeTextFile({ ...target, text: "version: 1\n" });
    await store.writeTextFile({ ...target, text: original });
    await write(root, target.path, original);
    const before = (await store.listMoments({ workspaceId: WORKSPACE_ID, limit: 20 })).moments.length;
    const engine = capture(root, { store, rustEngineSessions: sessions });

    await expect(engine.restoreFileToBeforeMoment(edited.moment.id, RESTORER)).resolves.toMatchObject({
      restoredMomentId: edited.moment.id,
    });

    expect((await store.listMoments({ workspaceId: WORKSPACE_ID, limit: 20 })).moments).toHaveLength(before);
    expect((await store.readTextFile(target))?.contentKind).toBe("text");
    await engine.stop();
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
    expect(requests.filter(request => request.method === "capture.flush")).toHaveLength(1);
    expect(closeWorkspace).toHaveBeenCalledTimes(2);
  });

  it("closes both daemon stores without restarting convergence after shutdown begins", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    let settled = true;
    const sessions = mockLiveSessions(loopback, undefined, () => ({ deferredWrites: [],
      settled,
      running: true,
      heldFiles: [], degraded: !settled,
    }));
    const closeWorkspace = vi.spyOn(sessions, "closeWorkspace");
    const engine = capture(root, {
      rustEngineSessions: sessions,
    });

    // createVersion opens both the text and secret daemon adapters.
    await engine.createVersion("Draft");
    settled = false;
    engine.beginShutdown();
    await expect(engine.stop()).resolves.toBeUndefined();
    expect(closeWorkspace).toHaveBeenCalledTimes(2);
  });

  it("does not start a final capture flush after shutdown begins", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    // createVersion opens both the text and secret daemon adapters.
    await engine.createVersion("Draft");
    requests.length = 0;
    engine.beginShutdown();
    await engine.stop();

    expect(
      requests
        .map((request) => request.method)
        .filter(
          (method) => method === "capture.flush" || method === "workspace.close",
        ),
    ).toEqual(["workspace.close"]);
  });

  it("can cancel normal stop's final capture flush when shutdown begins", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const entered = deferred<void>();
    const finish = deferred<void>();
    let stopping = false;
    const sessions = mockLiveSessions(new VersionedLoopbackEngine(), undefined, undefined, async request => {
      if (stopping && request.method === "capture.flush") {
        entered.resolve();
        await finish.promise;
      }
    });
    const close = sessions.closeWorkspace.bind(sessions);
    const closeWorkspace = vi.spyOn(sessions, "closeWorkspace").mockImplementation(async workspace => {
      // Closure must begin before the admitted RPC finishes.
      finish.resolve();
      await close(workspace);
    });
    const engine = capture(root, { rustEngineSessions: sessions });
    await engine.createVersion("Draft");
    stopping = true;
    const stopped = engine.stop();
    try {
      await entered.promise;
      engine.beginShutdown();
      await expect(stopped).resolves.toBeUndefined();
      expect(closeWorkspace).toHaveBeenCalledTimes(2);
    } finally {
      finish.resolve();
      await stopped;
    }
  });

  it.each(["cancelled", "failed"] as const)(
    "releases Collection providers when shutdown reconciliation is %s", async outcome => {
      const root = await createTestScratch("dohc-engine-capture-");
      const failure = new Error("Collection reconciliation failed.");
      let pending = false;
      const evict = vi.fn(async () => { pending = false; });
      const store = {
        ensureMainVersion: async () => undefined,
        listPendingCollectionAdoptions: async () => ({
          adoptions: pending ? [{
            versionId: "main", recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            collectionPath: "tasks", filePath: "tasks/record.md", objectId: "record-object",
          }] : [],
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
        openRustYDocProviderSession: async input => ({ path: input.path, evict }) as unknown as EngineYdocProviderSession,
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
    const bufferedUpdate = Y.encodeStateAsUpdate(
      remoteDoc,
      Y.encodeStateVector(daemonDoc),
    );
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
          settleNow: async () =>
            ({ sha256: "a".repeat(64), content: "" }) as never,
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
    loopback.seedTextFile({workspace: WORKSPACE_ID, versionId: "main", path: "notes/a.md", text: "seed"});
    const draftError = new Error("Draft storage refused.");
    const notices = vi.fn();
    const errors = vi.fn();
    const released = vi.fn();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback), onError: errors,
      preserveUnsentState: async () => {throw draftError;},
      openRustYDocProviderSession: async options => {
        const doc = new Y.Doc();
        return {doc, initialUpdate: Y.encodeStateAsUpdate(doc), objectId: "object-note", contentKind: "richdoc",
          path: options.path, head: "present", lineage: "existing", unsettled: false,
          applyLocalUpdate: async () => undefined, evict: async () => undefined,
          settleNow: async () => ({sha256: "a".repeat(64), content: "seed"}) as never,
          close: async () => { await options.preserveUnsentState!(doc); released(); },
        } as EngineYdocProviderSession;
      },
    });
    const session = await engine.openYDocSession({path: "notes/a.md", onRemoteUpdate: () => undefined, onEditRefused: notices});
    await expect(session.close({settle: false})).rejects.toBe(draftError);
    expect(released).not.toHaveBeenCalled();
    expect(notices).toHaveBeenCalledWith("draft-preservation", "Unsent changes to a.md are not saved. Draft storage refused. Copy them from the open document before you quit dohc.");
    expect(errors).toHaveBeenCalledWith("draft preservation of notes/a.md", draftError);
    await engine.stop();
  });

  // dohc#2308. A replicated document's release can succeed over a refused
  // save, and its session is then gone. Its text, set aside when the save
  // over the deleted file was first refused, stays set aside. A draft the
  // store refuses tells the person.
  it.each(["kept", "refused"] as const)("sets a deleted file's text aside before a replicated release (%s)", async (store) => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({workspace: WORKSPACE_ID, versionId: "main", path: "notes/a.md", text: "seed"});
    const stale = new DaemonRefusalError({code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no"}, undefined);
    const drafts: string[] = [];
    const preserveUnsentState = vi.fn(async ({doc}: {doc: Y.Doc}) => {
      if (store === "refused") throw new Error("Draft storage refused.");
      drafts.push(doc.getText("plainText").toString());
      return "a".repeat(64);
    });
    const discardUnsentState = vi.fn(async () => undefined);
    const notices = vi.fn();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback), onError: () => undefined, preserveUnsentState, discardUnsentState,
      openRustYDocProviderSession: async options => {
        const doc = new Y.Doc();
        return {doc, initialUpdate: Y.encodeStateAsUpdate(doc), objectId: "object-note", contentKind: "plaintext",
          path: options.path, head: "present", lineage: "existing", unsettled: false, lineageClaimId: "claim-1",
          applyLocalUpdate: async (update: Uint8Array) => { Y.applyUpdate(doc, update); }, evict: async () => undefined,
          settleNow: async () => { options.onSettleStart?.(1); options.onSettleError?.(stale, 1); throw stale; },
          close: async () => { throw new YdocReleasedWithSettleFailureError(options.path, stale); },
        } as EngineYdocProviderSession;
      },
    });
    const session = await engine.openYDocSession({path: "notes/a.md", onRemoteUpdate: () => undefined, onEditRefused: notices});
    const editor = new Y.Doc();
    editor.getText("plainText").insert(0, "typed");
    await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor));
    await expect(session.settleNow()).rejects.toBe(stale);
    await expect(session.close()).rejects.toBeInstanceOf(YdocReleasedWithSettleFailureError);
    if (store === "kept") {
      expect(drafts).toEqual(["typed"]);
      expect(preserveUnsentState).toHaveBeenCalledWith(expect.objectContaining({path: "notes/a.md", reason: "deleted"}));
      expect(notices).not.toHaveBeenCalled();
    } else {
      expect(notices).toHaveBeenCalledWith("draft-preservation", "Unsent changes to a.md are not saved. Draft storage refused. Copy them from the open document before you quit dohc.");
    }
    engine.beginShutdown();
    await engine.stop();
    expect(discardUnsentState).not.toHaveBeenCalled();
  });

  // #2463 in a synced workspace. A replicated release succeeds over a save
  // refused because the file changed outside dohc. The close then waits for
  // capture to record the outside version, as a local-only eviction does, and
  // the refused save reads as that change, not as a failed save.
  it("closes a synced note over a change made outside dohc like a local one", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({workspace: WORKSPACE_ID, versionId: "main", path: "notes/a.md", text: "seed"});
    const stale = new DaemonRefusalError({code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no"}, undefined);
    const sessions = mockLiveSessions(loopback);
    const live = createCaptureLiveStores({workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID}, sessions).store;
    let released = false;
    const statusReads: string[][] = [];
    const store = new Proxy(live, {
      get(target, property) {
        if (property === "watcherStatus") {
          return async () => {
            const deferredWrites = released ? [] : ["notes/a.md"];
            statusReads.push(deferredWrites);
            return {running: true, degraded: false, terminal: false, deferredWrites, keptFiles: [], heldFiles: []};
          };
        }
        if (property === "flushCapture") return async () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const states: string[] = [];
    const changedOutside: boolean[] = [];
    const engine = capture(root, {
      rustEngineSessions: sessions, store, onError: () => undefined,
      openRustYDocProviderSession: async options => {
        const doc = new Y.Doc();
        return {doc, initialUpdate: Y.encodeStateAsUpdate(doc), objectId: "object-note", contentKind: "plaintext",
          path: options.path, head: "present", lineage: "existing", unsettled: false, lineageClaimId: "claim-1",
          applyLocalUpdate: async (update: Uint8Array) => { Y.applyUpdate(doc, update); }, evict: async () => undefined,
          settleNow: async () => { options.onSettleStart?.(1); options.onSettleError?.(stale, 1); throw stale; },
          close: async () => { released = true; throw new YdocReleasedWithSettleFailureError(options.path, stale); },
        } as EngineYdocProviderSession;
      },
    });
    const session = await engine.openYDocSession({path: "notes/a.md", onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state), onChangedOutside: (unsaved) => changedOutside.push(unsaved)});
    const editor = new Y.Doc();
    editor.getText("plainText").insert(0, "typed");
    await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor));
    engine.start();
    await vi.waitFor(() => expect(changedOutside).toEqual([true]));
    await expect(session.settleNow()).rejects.toBe(stale);
    await expect(session.close()).resolves.toBeUndefined();
    expect(states.at(-1)).toBe("changed-on-disk");
    // The close answered after capture stopped holding the outside version.
    expect(statusReads.at(-1)).toEqual([]);
    engine.beginShutdown();
    await engine.stop();
  });

  // A save can write the file and still find it gone, deleted again right
  // after Save it again. The draft goes only once the file holds the text.
  it("keeps a deleted file's draft when the file is gone again after a save wrote it", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({workspace: WORKSPACE_ID, versionId: "main", path: "notes/a.md", text: "seed"});
    const stale = new DaemonRefusalError({code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no"}, undefined);
    const preserveUnsentState = vi.fn(async () => "d".repeat(64));
    const discardUnsentState = vi.fn(async () => undefined);
    const states: string[] = [];
    let writes = false;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback), onError: () => undefined, preserveUnsentState, discardUnsentState,
      openRustYDocProviderSession: async options => {
        const doc = new Y.Doc();
        doc.getText("plainText").insert(0, "typed");
        let tokens = 0;
        return {doc, initialUpdate: Y.encodeStateAsUpdate(doc), objectId: "object-note", contentKind: "plaintext",
          path: options.path, head: "present", lineage: "existing", unsettled: false,
          applyLocalUpdate: async () => undefined, evict: async () => undefined,
          settleNow: async () => {
            const token = ++tokens;
            options.onSettleStart?.(token);
            if (!writes) { options.onSettleError?.(stale, token); throw stale; }
            const result = {sha256: createHash("sha256").update("typed").digest("hex"), content: "typed", materialized: true};
            await options.onSettled?.(result as never, token);
            return result as never;
          },
          close: async () => undefined,
        } as EngineYdocProviderSession;
      },
    });
    const session = await engine.openYDocSession({path: "notes/a.md", onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state)});
    await expect(session.settleNow()).rejects.toBe(stale);
    await vi.waitFor(() => expect(preserveUnsentState).toHaveBeenCalledOnce());
    writes = true;
    await session.settleNow();
    expect(states.at(-1)).toBe("changed-on-disk");
    await session.close();
    expect(discardUnsentState).not.toHaveBeenCalled();
    await engine.stop();
  });

  // Document A's draft X became obsolete, and removing it failed. Document B's
  // next draft step retries that removal, and while it is under way A's file
  // is deleted again: A's refused save writes the same draft X, current
  // again. The retry must not delete it.
  it("keeps a draft that is current again while another document's retry removes its older write", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const draftDirectory = await createTestScratch("dohc-engine-capture-drafts-");
    const loopback = new VersionedLoopbackEngine();
    for (const path of ["notes/a.md", "notes/b.md"]) loopback.seedTextFile({workspace: WORKSPACE_ID, versionId: "main", path, text: "seed"});
    const stale = new DaemonRefusalError({code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no"}, undefined);
    const store = workspaceDraftStore(draftDirectory, WORKSPACE_ID, {all: () => [], workspaceIdOf: () => undefined});
    const preserveUnsentState = vi.fn(store.preserveUnsentState);
    let refusals = 1;
    const retry = {held: deferred<void>(), holding: deferred<void>(), done: deferred<void>(), handle: ""};
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
      rustEngineSessions: mockLiveSessions(loopback), onError: () => undefined, preserveUnsentState, discardUnsentState,
      openRustYDocProviderSession: async options => {
        const doc = new Y.Doc();
        doc.getText("plainText").insert(0, "typed");
        let tokens = 0;
        return {doc, initialUpdate: Y.encodeStateAsUpdate(doc), objectId: `object-${options.path}`, contentKind: "plaintext",
          path: options.path, head: "present", lineage: "existing", unsettled: false,
          applyLocalUpdate: async () => undefined, evict: async () => undefined,
          settleNow: async () => {
            const token = ++tokens;
            options.onSettleStart?.(token);
            if (!writes.get(options.path)) { options.onSettleError?.(stale, token); throw stale; }
            const result = {sha256: createHash("sha256").update("typed").digest("hex"), content: "typed", materialized: true};
            await options.onSettled?.(result as never, token);
            return result as never;
          },
          close: async () => undefined,
        } as EngineYdocProviderSession;
      },
    });
    const a = await engine.openYDocSession({path: "notes/a.md", onRemoteUpdate: () => undefined});
    const b = await engine.openYDocSession({path: "notes/b.md", onRemoteUpdate: () => undefined});
    const handleOf = async (call: number) => await preserveUnsentState.mock.results[call]!.value;

    await expect(a.settleNow()).rejects.toBe(stale);
    await vi.waitFor(() => expect(preserveUnsentState).toHaveBeenCalledOnce());
    retry.handle = await handleOf(0);
    // A saves, and the removal of X fails.
    await write(root, "notes/a.md", "typed");
    writes.set("notes/a.md", true);
    await a.settleNow();
    await vi.waitFor(() => expect(discardUnsentState).toHaveBeenCalledOnce());

    // B's draft step retries X's removal, which waits.
    await expect(b.settleNow()).rejects.toBe(stale);
    await retry.holding.promise;
    // A's file is deleted again, and A writes X again.
    await rm(join(root, "notes/a.md"));
    writes.set("notes/a.md", false);
    await expect(a.settleNow()).rejects.toBe(stale);
    await vi.waitFor(() => expect(preserveUnsentState).toHaveBeenCalledTimes(3));
    expect((await handleOf(2)).split(":")[0]).toBe(retry.handle.split(":")[0]);
    retry.held.resolve();
    await retry.done.promise;

    // Notices lists X, the text A's file never got, and B's draft.
    expect((await listLiveDraftRecovery(draftDirectory, WORKSPACE_ID)).map(({path, text}) => `${path}: ${text}`).sort())
      .toEqual(["notes/a.md: typed", "notes/b.md: typed"]);
    await a.close();
    await b.close();
    await engine.stop();
  });

  it("settles and retires every live Y.Doc session before stopping the capture", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "note.md",
      text: "seed",
    });
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "drawing.md",
      text: "seed",
    });
    const order: string[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        const doc = new Y.Doc();
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "richdoc" as const,
          path: options.path,
          head: "present" as const,
          lineage: "existing" as const,
          unsettled: false,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            order.push(`settle:${options.path}`);
            return { sha256: "a".repeat(64), content: "# Edited\n" } as never;
          },
          close: async (closeOptions?: { settle?: boolean }) => {
            order.push(`close:${options.path}:${String(closeOptions?.settle)}`);
          },
        };
      },
    });
    await engine.openYDocSession({
      path: "note.md",
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
    });
    await engine.openYDocSession({
      path: "drawing.md",
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
    });

    await engine.settleAndCloseAllLiveSessions!();
    await engine.stop();

    expect(order).toEqual([
      "settle:note.md",
      "close:note.md:false",
      "settle:drawing.md",
      "close:drawing.md:false",
    ]);
  });

  // The engine owns the.md: it materializes a changed projection and
  // leaves a drifted file alone. The desktop mirrored the settled content
  // over the file anyway, so an edit made outside dohc while the document was
  // open vanished from disk. The desktop no longer writes here at all, and
  // every case below drives the real onSettled against a real file; only the
  // daemon session is a fake, and it calls onSettled exactly where
  // ydocProviderSession's runSettle does.
  function driftFixture(settled: {
    sha256: string;
    content: string | null;
    path?: string;
  }) {
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

  // Open a session on note.md, type the editor text, let the close settle it,
  // and report the save states that settle produced.
  async function settleOnClose(
    root: string,
    settled: { sha256: string; content: string | null },
    onError?: (context: string, error: unknown) => void,
  ): Promise<string[]> {
    const states: string[] = [];
    const engine = capture(root, {
      ...(onError ? { onError } : {}),
      openRustYDocProviderSession: driftFixture(settled),
    });
    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state),
    });
    const editor = new Y.Doc();
    editor.getText("plainText").insert(0, EDITOR_TEXT);
    await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor));
    await session.close();
    await engine.stop();
    return states;
  }

  const EDITOR_TEXT = "typed in dohc\n";

  // The open says "settling" before its settle runs. A settle refused before
  // it starts reports nothing of its own, so the open closes that report.
  it("replaces the open-time Saving… when the settle is refused before it starts", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    await write(root, "note.md", EDITOR_TEXT);
    const states: string[] = [];
    const engine = capture(root, {
      openRustYDocProviderSession: async () =>
        ({
          doc: new Y.Doc(),
          initialUpdate: Y.encodeStateAsUpdate(new Y.Doc()),
          contentKind: "plaintext",
          path: "note.md",
          head: "present" as const,
          lineage: "existing" as const,
          unsettled: true,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            throw new Error("refused before the settle started");
          },
          close: async () => undefined,
        }) as never,
    });
    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state),
    });
    await vi.waitFor(() => expect(states).toEqual(["settling", "error"]));
    await session.close({ settle: false });
    await engine.stop();
  });

  it.each([
    { label: "ordinary", authorCapacity: false, failure: new Error("the settle started and failed") },
    {
      label: "author-capacity",
      authorCapacity: true,
      failure: new DaemonRefusalError(
        { code: "LIMIT_EXCEEDED", message: "ydoc-author-capacity", retry: "no" },
        null,
      ),
    },
    {
      label: "volume-sharing",
      authorCapacity: false,
      failure: new DaemonRefusalError(
        { code: "INTERNAL", message: "volume-shares-new-files", retry: "no" },
        null,
      ),
    },
  ])("reports an $label failure once with its logical save token and its error", async ({ failure, authorCapacity }) => {
    const root = await createTestScratch("dohc-engine-capture-");
    await write(root, "note.md", EDITOR_TEXT);
    const states: Array<{ state: string; token: number; authorCapacity?: boolean }> = [];
    const events: string[] = [];
    const failures: unknown[] = [];
    const engine = capture(root, {
      openRustYDocProviderSession: async (options: EngineYdocProviderSessionOptions) =>
        ({
          doc: new Y.Doc(),
          initialUpdate: Y.encodeStateAsUpdate(new Y.Doc()),
          contentKind: "plaintext",
          path: "note.md",
          head: "present" as const,
          lineage: "existing" as const,
          unsettled: true,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            options.onSettleStart?.(47);
            options.onSettleError?.(failure, 47);
            throw failure;
          },
          close: async () => undefined,
        }) as never,
    });
    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
      onSaveState: (state, token, event, authorCapacity, _readOnlyCause, settleFailure) => {
        states.push({ state, token, authorCapacity });
        events.push(event);
        if (state === "error") failures.push(settleFailure);
      },
    });
    await vi.waitFor(() => expect(states.some(({ state }) => state === "error")).toBe(true));
    await session.close({ settle: false });
    await engine.stop();
    expect(states).toEqual([
      { state: "settling", token: 0, authorCapacity: undefined },
      { state: "settling", token: 1, authorCapacity: undefined },
      { state: "error", token: 1, authorCapacity },
    ]);
    expect(events).toEqual(["status", "start", "outcome"]);
    expect(failures).toEqual([failure]);
    expect(isVolumeSharesNewFilesCause(failures[0])).toBe(failure.message === "volume-shares-new-files");
  });

  it("keeps an edit made outside dohc when the open document's session closes", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = "written outside dohc\n";
    await write(root, "note.md", outside);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      content: EDITOR_TEXT,
    });

    expect(await readFile(join(root, "note.md"), "utf8"), "restore the mirror write and the file reads 'typed in dohc' — the outside edit is gone from disk.").toBe(outside);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // The size the old check gave up at: readDiskTextState returns
  // untracked-content with NO sha past its 5 MiB cap, so a check that trusted
  // it read "no proof of drift" and mirrored 14 bytes over the biggest file in
  // the workspace — reporting "Saved".
  it("keeps an outside edit larger than the capture size cap", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const huge = `${"o".repeat(MAX_ENGINE_CAPTURE_BINARY_BYTES + 1)}\n`;
    await write(root, "note.md", huge);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      content: EDITOR_TEXT,
    });

    expect((await readFile(join(root, "note.md"), "utf8")).length).toBe(
      huge.length,
    );
    expect(states).toEqual(["changed-on-disk"]);
  });

  // An outside DELETE is an intent, not an accident. Writing the document back
  // is the same overwrite in reverse.
  it("does not recreate a file deleted outside dohc", async () => {
    const root = await createTestScratch("dohc-engine-capture-");

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      content: EDITOR_TEXT,
    });

    expect(existsSync(join(root, "note.md"))).toBe(false);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // content === null: the body is past the engine's in-band response cap, so
  // it never rode back over the wire. The settle still reports its sha, so
  // drift is just as answerable there — the old code returned "Saved" without
  // looking.
  it("reports the drift for an over-cap settle whose content never crossed the wire", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = "written outside dohc\n";
    await write(root, "note.md", outside);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8("a body far past the in-band cap"),
      content: null,
    });

    expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // A file bigger than the largest projection the engine can produce cannot BE
  // the settled artifact, so its size answers the question and its bytes are
  // never read — a close must not wait on an unbounded read. The deny-read ACE
  // is the proof: reading would fail (EPERM), which would report "error"
  // instead.
  itNonRoot("answers an oversized file from its size, without reading it", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const absolute = join(root, "note.md");
    await write(root, "note.md", "b".repeat(MAX_SETTLED_FILE_BYTES + 1));
    await denyRead(absolute, "file");

    try {
      const states = await settleOnClose(root, {
        sha256: sha256Utf8(EDITOR_TEXT),
        content: EDITOR_TEXT,
      });

      expect(states).toEqual(["changed-on-disk"]);
    } finally {
      await restoreRead(absolute, 0o644);
    }
  });

  // A file dohc cannot read is not a file dohc knows changed. Sending the user
  // to History over a scanner's transient lock would be a lie about a file
  // that probably holds exactly this document; "error" is the retryable state,
  // and the next settle checks again.
  itNonRoot("reports the retryable error state when the file cannot be read", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const absolute = join(root, "note.md");
    await write(root, "note.md", EDITOR_TEXT);
    await denyRead(absolute, "file");
    const errors: Array<{ context: string; error: unknown }> = [];

    try {
      const states = await settleOnClose(
        root,
        { sha256: sha256Utf8(EDITOR_TEXT), content: EDITOR_TEXT },
        (context, error) => errors.push({ context, error }),
      );

      expect(states).toEqual(["error"]);
      expect(String(errors[0]?.error)).toContain("could not check the file");
    } finally {
      await restoreRead(absolute, 0o644);
    }
  });

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

    expect(states, "drop the containment check and the matching file outside the workspace reports ['saved'].").toEqual(["error"]);
    expect(String(errors[0]?.error)).toContain("outside the workspace");
  });

  // The narrowness guard: the refusal above must fire only on a drifted file.
  it("still reports a plain saved settle when nothing changed the file", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    await write(root, "note.md", EDITOR_TEXT);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      content: EDITOR_TEXT,
    });

    expect(await readFile(join(root, "note.md"), "utf8")).toBe(EDITOR_TEXT);
    expect(states).toEqual(["saved"]);
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

  it.each(["malformed receipt", "file at receipt folder"])("isolates %s from health reports and native kept copies", async damage => {
    vi.useFakeTimers();
    const root = await createTestScratch("copy-record-health-");
    const workspace = { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID };
    await openedLocalState(workspace);
    await write(root, "n.md", "outside");
    const copies = outsideWriteCopies(workspace);
    await copies.beforeWrite("n.md", null, () => undefined, async () => false);
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
        if (property === "watcherStatus") return async () => ({ running: true, degraded: false, terminal: false,
          deferredWrites: [], keptFiles: [["native.md", "saved-native.md"]], retainedCopies: { count: 2, bytes: 20 },
          recoveryUnavailable: true, heldFiles: [] });
        if (property === "listKeptCopies") return async () => native;
        if (property === "listPendingCollectionAdoptions") return adoptions;
        if (property === "flushCapture") return async () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const kept = vi.fn(), retained = vi.fn(), recovery = vi.fn(), held = vi.fn(), outside = vi.fn();
    const outcomes = vi.fn(), errors = vi.fn();
    const engine = capture(root, { store, rustEngineSessions: sessions, onKeptFiles: kept, onRetainedCopies: retained,
      onRecoveryUnavailable: recovery, onHeldFiles: held, onOutsideWriteCopies: outside, onCaptureOutcome: outcomes, onError: errors });
    try {
      engine.start();
      await engine.flush();
      expect(kept).toHaveBeenCalledWith([["native.md", "saved-native.md"]]);
      expect(retained).toHaveBeenCalledWith({ count: 2, bytes: 20 });
      expect(recovery).toHaveBeenCalledWith(true);
      expect(held).toHaveBeenCalledWith([]);
      expect(adoptions).toHaveBeenCalled();
      expect(outcomes).toHaveBeenLastCalledWith(null, null);
      expect(errors).not.toHaveBeenCalled();
      const rows = damage === "malformed receipt" ? originalRows : null;
      expect(outside).toHaveBeenCalledExactlyOnceWith(rows, expect.stringContaining(broken));
      expect(await engine.listKeptCopies()).toEqual({ ...native, ...(rows === null ? {} : { outsideWriteCopies: rows }) });
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
  });

  it("reports a first failed copy-list read without a list, then clears the error on recovery", async () => {
    const root = await createTestScratch("copy-record-unopened-");
    const workspace = { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID };
    const opens = fakeLocalStateOpens();
    await opens.open(workspace);
    await write(root, "n.md", "outside");
    const copies = outsideWriteCopies(workspace);
    await copies.beforeWrite("n.md", null, () => undefined, async () => false);
    const rows = await copies.list();
    opens.close(workspace);
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores(workspace, sessions).store;
    const native = { keptCopies: [], more: false };
    const store = new Proxy(liveStore, {
      get(target, property) {
        if (property === "listKeptCopies") return async () => native;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outside = vi.fn();
    const engine = capture(root, { store, rustEngineSessions: sessions, onOutsideWriteCopies: outside });
    try {
      const first = await engine.listKeptCopies();
      expect(first).toEqual(native);
      expect(first).not.toHaveProperty("outsideWriteCopies");
      expect(outside).toHaveBeenCalledExactlyOnceWith(null, expect.stringContaining("dohc has not finished opening this workspace"));
      await engine.listKeptCopies();
      expect(outside).toHaveBeenCalledOnce();
      await opens.open(workspace);
      expect(await engine.listKeptCopies()).toEqual({ ...native, outsideWriteCopies: rows });
      expect(outside).toHaveBeenLastCalledWith(rows, null);
      opens.close(workspace);
      await rm(join(root, rows[0]![1]));
      expect(await engine.listKeptCopies()).toEqual({ ...native, outsideWriteCopies: rows });
      expect(outside).toHaveBeenLastCalledWith(rows, expect.stringContaining("dohc has not finished opening this workspace"));
    } finally {
      await engine.stop();
      await liveStore.close();
    }
  });

  it.each([false, true])("coalesces blocked capture health polls and resumes after failure=%s", async (failFirst) => {
    vi.useFakeTimers();
    const root = await createTestScratch("dohc-engine-capture-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID });
    const entered = deferred();
    const release = deferred();
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores({
      workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID,
    }, sessions).store;
    const recovery = vi.fn();
    const outside = vi.fn();
    const watcherStatus = vi.fn(async () => {
      if (watcherStatus.mock.calls.length === 1) {
        entered.resolve();
        await release.promise;
        if (failFirst) throw new Error("temporary watcher failure");
      }
      return { running: true, degraded: false, terminal: false, deferredWrites: [], recoveryUnavailable: watcherStatus.mock.calls.length === 1 };
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
      store: daemonStore, rustEngineSessions: sessions,
      onRecoveryUnavailable: recovery, onOutsideWriteCopies: outside,
      onError: () => {}, onCaptureOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      engine.start();
      await entered.promise;
      expect(outside).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(12 * DAEMON_CAPTURE_HEALTH_POLL_MS);
      expect(watcherStatus).toHaveBeenCalledTimes(1);
      release.resolve();
      await engine.flush();
      // One current observation, not twelve obsolete observations queued behind it.
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
  });

  // An engine still taking in a new workspace's files refuses the poll's
  // reads. That is busy, not broken: no outcome changes, and a real error
  // still reports a failure.
  it("keeps the capture outcome while the engine is still updating, and reports a real failure", async () => {
    vi.useFakeTimers();
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores({
      workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID,
    }, sessions).store;
    const updating = () => new DaemonRefusalError(
      { code: "OVERLOADED", message: "Workspace is still updating. Try again.", retry: "afterBackoff" }, undefined);
    let status: "updating" | "ok" = "ok";
    let adoptionsAnswer: "updating" | "fail" | "ok" = "updating";
    const daemonStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "watcherStatus") return async () => {
          if (status === "updating") throw updating();
          return { running: true, degraded: false, terminal: false, deferredWrites: [] };
        };
        if (property === "listPendingCollectionAdoptions") return async () => {
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
      store: daemonStore, rustEngineSessions: sessions,
      onError: () => {}, onCaptureOutcome: (outcome) => outcomes.push(outcome),
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

  // Busy is bounded by the engine's own status. Its refusal cannot hide a
  // degraded watcher, and the early-import deadline answers not running and
  // degraded, which reports a failure whatever the adoptions answer.
  it("reports a degraded or timed-out import while the engine still refuses reads", async () => {
    vi.useFakeTimers();
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores({
      workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID,
    }, sessions).store;
    let watcher = { running: true, degraded: false, terminal: false, deferredWrites: [] as string[] };
    let refuseAdoptions = true;
    const daemonStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "watcherStatus") return async () => watcher;
        if (property === "listPendingCollectionAdoptions") return async () => {
          if (refuseAdoptions) {
            throw new DaemonRefusalError(
              { code: "OVERLOADED", message: "Workspace is still updating. Try again.", retry: "afterBackoff" }, undefined);
          }
          return { adoptions: [], nextCursor: null };
        };
        if (property === "flushCapture") return async () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outcomes: WorkspaceEngineCaptureFailure[] = [];
    const engine = capture(root, {
      store: daemonStore, rustEngineSessions: sessions,
      onError: () => {}, onCaptureOutcome: (outcome) => outcomes.push(outcome),
    });
    const settled = () => engine.flush().catch(() => undefined);
    const poll = async () => {
      await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
      await settled();
    };
    try {
      engine.start();
      await settled();
      expect(outcomes).toEqual([]);
      watcher = { ...watcher, degraded: true };
      await poll();
      expect(outcomes).toEqual(["other"]);

      watcher = { ...watcher, degraded: false };
      refuseAdoptions = false;
      await poll();
      expect(outcomes).toEqual(["other", null]);
      // The deadline's status, with a refusal still in flight.
      watcher = { ...watcher, running: false, degraded: true };
      refuseAdoptions = true;
      await poll();
      expect(outcomes).toEqual(["other", null, "other"]);
    } finally {
      watcher = { running: true, degraded: false, terminal: false, deferredWrites: [] };
      refuseAdoptions = false;
      await engine.stop();
      await liveStore.close();
      vi.useRealTimers();
    }
  });

  // A first import can keep capture working past the settle budget of the
  // adoption drain's reconcile. That is busy too: the poll keeps the outcome,
  // and it still cannot hide a degraded watcher.
  it("keeps the capture outcome while the adoption drain's reconcile has not settled", async () => {
    vi.useFakeTimers();
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores({
      workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID,
    }, sessions).store;
    let watcher = { running: true, degraded: false, terminal: false, deferredWrites: [] as string[] };
    let pending = false;
    let settles = false;
    const daemonStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "watcherStatus") return async () => watcher;
        if (property === "listPendingCollectionAdoptions") return async () => ({
          adoptions: pending ? [{ versionId: "main", recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            collectionPath: "tasks", filePath: "tasks/record.md", objectId: "record" }] : [],
          nextCursor: null,
        });
        if (property === "reconcileCapture") return async () => {
          if (!settles) throw new EngineCaptureNotSettledError(WORKSPACE_ID);
          pending = false;
        };
        if (property === "flushCapture") return async () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outcomes: WorkspaceEngineCaptureFailure[] = [];
    const engine = capture(root, {
      store: daemonStore, rustEngineSessions: sessions,
      openRustYDocProviderSession: async input =>
        ({ path: input.path, evict: async () => undefined }) as unknown as EngineYdocProviderSession,
      onError: () => {}, onCaptureOutcome: (outcome) => outcomes.push(outcome),
    });
    const settled = () => engine.flush().catch(() => undefined);
    const poll = async () => {
      await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
      await settled();
    };
    try {
      engine.start();
      await settled();
      expect(outcomes).toEqual([null]);
      pending = true;
      await poll();
      expect(outcomes).toEqual([null]);

      watcher = { ...watcher, degraded: true };
      await poll();
      expect(outcomes).toEqual([null, "other"]);

      watcher = { ...watcher, degraded: false };
      settles = true;
      await poll();
      expect(outcomes).toEqual([null, "other", null]);
      expect(pending).toBe(false);
    } finally {
      watcher = { running: true, degraded: false, terminal: false, deferredWrites: [] };
      settles = true;
      await engine.stop();
      await liveStore.close();
      vi.useRealTimers();
    }
  });

  it("reports a drive without atomic no-replace renames from the engine's status", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores({
      workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID,
    }, sessions).store;
    const polled = deferred();
    const watcherStatus = vi.fn(async () => {
      polled.resolve();
      return { running: true, degraded: false, terminal: false, deferredWrites: [], noAtomicPlacement: true };
    });
    const daemonStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "watcherStatus") return watcherStatus;
        if (property === "listPendingCollectionAdoptions") {
          return async () => ({ adoptions: [], nextCursor: null });
        }
        if (property === "flushCapture") return async () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const reports: number[] = [];
    const engine = capture(root, {
      store: daemonStore, rustEngineSessions: sessions,
      onError: () => {},
      onAtomicPlacementUnavailable: () => reports.push(1),
    });
    try {
      engine.start();
      await polled.promise;
      await engine.flush();
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      await engine.stop();
      await liveStore.close();
    }
  });

  // The engine refusing the workspace's database is not a degraded
  // watcher. The outcome carries the fence's classification so the product
  // offers the move-aside rebuild instead of "History paused" — and a later
  // pass that reaches the store clears it.
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

  // The move-aside rebuild closes the capture before it moves the store. A
  // refused store was never opened, so the closing flush can only repeat
  // the refusal; the stop must finish anyway or the rebuild never starts.
  it("stops a capture whose store is refused without failing on the closing flush", async () => {
    vi.useFakeTimers();
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      // The engine names the cause after the code.
      const message = "migration-failed: migration v2-baseline was applied from a different definition than this build's";
      const refusal = () =>
        Object.assign(new Error(message), {
          wireError: { code: "INTERNAL", message, retry: "no" },
        });
      const outcomes: WorkspaceEngineCaptureFailure[] = [];
      const details: Array<string | null> = [];
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
        sessions,
      ).store;
      const daemonStore = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus" || property === "flushCapture") {
            return async () => {
              throw refusal();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const engine = capture(root, {
        store: daemonStore,
        rustEngineSessions: sessions,
        onError: () => {},
        onCaptureOutcome: (outcome, detail) => {
          outcomes.push(outcome);
          details.push(detail ?? null);
        },
      });
      try {
        engine.start();
        // flush() ends with the same refused flushCapture; the pass before it
        // already reported the refusal.
        await engine.flush().catch(() => undefined);
        expect(outcomes).toEqual(["migration-failed"]);
        expect(details).toEqual(["migration v2-baseline was applied from a different definition than this build's"]);
        await expect(engine.stop()).resolves.toBeUndefined();
      } finally {
        await liveStore.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // Quit abandons a workspace open that has not finished (#2187). Its store
  // holds nothing yet, so the stop must finish or the workspace close skips
  // the closes after it.
  it("stops a capture at quit whose workspace never finished opening", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
      sessions,
    ).store;
    const unopened = new Proxy(liveStore, {
      get(target, property) {
        if (property === "listPendingCollectionAdoptions" || property === "flushCapture") {
          return async () => { throw new EngineWorkspaceShuttingDownError(); };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const engine = capture(root, { store: unopened, rustEngineSessions: sessions, onError: () => {} });
    try {
      engine.beginShutdown();
      await expect(engine.stop()).resolves.toBeUndefined();
    } finally {
      await liveStore.close();
    }
  });

  it("mutation proof: counts a secret-only daemon version switch", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedSecretFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: ".env",
      text: "VALUE=main\n",
    });
    await write(root, ".env", "VALUE=main\n");
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    const created = await engine.createVersion("Draft");
    const draftId = created.activeVersionId;
    loopback.seedSecretFile({
      workspace: "engine-capture-test",
      versionId: draftId,
      path: ".env",
      text: "VALUE=draft\n",
    });
    await write(root, ".env", "VALUE=draft\n");

    await expect(engine.switchVersion("main")).resolves.toEqual({
      activeVersionId: "main",
      changedFileCount: 1,
    });
    await engine.stop();
  });

  it("validates an unknown switch target from metadata without attempting text hydration", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    loopback.requests.length = 0;

    await expect(engine.switchVersion("missing-version")).rejects.toThrow();
    expect(
      loopback.requests.filter(
        (request) => request.method === "versionedText.read",
      ),
    ).toHaveLength(0);
    await engine.stop();
  });

});

describe("workspaceEngineCapture relay sync materialization", () => {
  it.each([300, 0])("materializes one 500-op page without copies, writes=%s", async writeCount => {
    const root = await createTestScratch("relay-500-recorded-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const changes: RelayMaterializedPath[] = [];
    for (let index = 0; index < 500; index++) {
      loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: `object-${index}`, path: `${index}.md`, text: "recorded before pull" });
      await write(root, `${index}.md`, "recorded before pull");
    }
    // Like sync.pull, record the entire page before its disk projection.
    for (let index = 0; index < 500; index++) {
      const path = `${index}.md`;
      if (index < writeCount) loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: `object-${index}`, path, text: "incoming", origin: "sync" });
      else await store.deleteTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path, metadata: { origin: "sync" } });
      changes.push({ versionId: "main", path, operation: index < writeCount ? "write" : "delete", contentKind: "text" });
    }
    const lists = vi.spyOn(store, "listMoments");
    const gets = vi.spyOn(store, "getMoment");
    const resolves = vi.spyOn(store, "resolveFiles");
    const notice = vi.fn();
    const engine = capture(root, { store, rustEngineSessions: sessions, onOutsideWriteCopies: notice });
    try {
      const started = performance.now();
      await engine.runRelaySync(page => page(changes));
      const elapsedMs = performance.now() - started;
      expect(lists).toHaveBeenCalledTimes(500 + Math.ceil((500 - writeCount) / 100));
      expect(lists.mock.calls.filter(([input]) => input.objectId === undefined)).toHaveLength(Math.ceil((500 - writeCount) / 100));
      expect(gets).not.toHaveBeenCalled();
      expect(resolves).toHaveBeenCalledTimes(Math.ceil(writeCount / 128));
      for (const [input] of resolves.mock.calls) {
        expect(input.versionId).toBe("main");
        expect(input.targets.length).toBeLessThanOrEqual(128);
        expect(Buffer.byteLength(JSON.stringify(input.targets))).toBeLessThanOrEqual(48 * 1024);
      }
      expect((await readdir(root)).filter(name => name.includes("(kept copy"))).toEqual([]);
      expect(notice).not.toHaveBeenCalled();
      for (let index = 0; index < 500; index++) {
        if (index < writeCount) expect(await readFile(join(root, `${index}.md`), "utf8")).toBe("incoming");
        else expect(existsSync(join(root, `${index}.md`))).toBe(false);
      }
      process.stdout.write(`500-op page writes=${writeCount}: ${elapsedMs.toFixed(2)} ms; listMoments=${lists.mock.calls.length}; getMoment=${gets.mock.calls.length}; resolveFiles=${resolves.mock.calls.length}\n`);
    } finally { await engine.stop(); }
  });

  it("batches head resolution by UTF-8 bytes as well as target count", async () => {
    const root = await createTestScratch("relay-resolve-byte-batch-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    const changes: RelayMaterializedPath[] = [];
    for (let index = 0; index < 90; index++) {
      const path = `${"\u6587".repeat(180)}${index}.md`;
      loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: `unicode-${index}`, path, text: "recorded" });
      loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: `unicode-${index}`, path, text: "incoming" });
      await write(root, path, "recorded");
      changes.push({ versionId: "main", path, operation: "write", contentKind: "text" });
    }
    const requests: Request[] = [];
    const notice = vi.fn();
    const engine = liveCapture(root, loopback, { requests, onOutsideWriteCopies: notice });
    try {
      await engine.runRelaySync(page => page(changes));
      const resolves = requests.filter(request => request.method === "files.resolve");
      expect(resolves).toHaveLength(2);
      for (const request of resolves) {
        const params = request.params as { versionId: string; targets: { path: string }[] };
        expect(params.versionId).toBe("main");
        expect(params.targets.length).toBeLessThan(128);
        expect(Buffer.byteLength(JSON.stringify(params.targets))).toBeLessThanOrEqual(48 * 1024);
      }
      expect(notice).not.toHaveBeenCalled();
      expect((await readdir(root)).some(name => name.includes("(kept copy"))).toBe(false);
    } finally { await engine.stop(); }
  });

  it.each([false, true])("handles a History-hidden restore delete conservatively, allHidden=%s", async allHidden => {
    const root = await createTestScratch("relay-hidden-delete-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "deleted-object", path: "n.md", text: "recorded" });
    await write(root, "n.md", "recorded");
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    await store.deleteTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "n.md", metadata: { origin: "restore" } });
    const list = store.listMoments.bind(store);
    // Model list_moments hiding a pending restore-delete-mat_ moment.
    vi.spyOn(store, "listMoments").mockImplementation(async input => {
      const page = await list(input);
      page.moments = page.moments.filter(row => !allHidden && row.operation !== "delete");
      return page;
    });
    const notice = vi.fn();
    const engine = capture(root, { store, rustEngineSessions: sessions, onOutsideWriteCopies: notice });
    try {
      await engine.runRelaySync(page => page([{ versionId: "main", path: "n.md", operation: "delete", contentKind: "text" }]));
      expect(existsSync(join(root, "n.md"))).toBe(false);
      expect(existsSync(join(root, "n (kept copy).md"))).toBe(allHidden);
      if (allHidden) expect(await readFile(join(root, "n (kept copy).md"), "utf8")).toBe("recorded");
      expect(notice).toHaveBeenCalledTimes(allHidden ? 1 : 0);
    } finally { await engine.stop(); }
  });

  it("discovers a delete in the active version and compares recorded hashes across versions", async () => {
    const root = await createTestScratch("relay-delete-version-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "main-object", path: "n.md", text: "Main content" });
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const draft = await store.createNamedVersion({ workspaceId: WORKSPACE_ID, name: "Draft", fromVersionId: "main" });
    loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: draft.id, objectId: "main-object", path: "n.md", text: "recorded on Draft" });
    await store.deleteTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "n.md", metadata: { origin: "sync" } });
    loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: draft.id, objectId: "other-object", path: "n.md", text: "newer unrelated Draft content" });
    await write(root, "n.md", "recorded on Draft");
    const lists = vi.spyOn(store, "listMoments");
    const gets = vi.spyOn(store, "getMoment");
    const resolves = vi.spyOn(store, "resolveFiles");
    const notice = vi.fn();
    const engine = capture(root, { store, rustEngineSessions: sessions, onOutsideWriteCopies: notice });
    try {
      await engine.runRelaySync(page => page([{ versionId: "main", path: "n.md", operation: "delete", contentKind: "text" }]));
      expect(lists.mock.calls.map(([input]) => ({ versionId: input.versionId, objectId: input.objectId }))).toEqual([
        { versionId: "main", objectId: undefined }, { versionId: undefined, objectId: "main-object" },
      ]);
      expect(gets).not.toHaveBeenCalled();
      expect(resolves).not.toHaveBeenCalled();
      expect(existsSync(join(root, "n.md"))).toBe(false);
      expect(existsSync(join(root, "n (kept copy).md"))).toBe(false);
      expect(notice).not.toHaveBeenCalled();
    } finally { await engine.stop(); }
  });

  it("recognizes the hash of a rename into the current path without payload reads", async () => {
    const root = await createTestScratch("relay-renamed-hash-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "renamed-object", path: "old.md", text: "recorded rename" });
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    await store.renameTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", fromPath: "old.md", toPath: "n.md", metadata: { origin: "api" } });
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "renamed-object", path: "n.md", text: "incoming", origin: "sync" });
    await write(root, "n.md", "recorded rename");
    const list = store.listMoments.bind(store);
    vi.spyOn(store, "listMoments").mockImplementation(async input => {
      const page = await list(input);
      page.moments = page.moments.filter(row => row.operation === "rename");
      return page;
    });
    const gets = vi.spyOn(store, "getMoment");
    const notice = vi.fn();
    const engine = capture(root, { store, rustEngineSessions: sessions, onOutsideWriteCopies: notice });
    try {
      await engine.runRelaySync(page => page([{ versionId: "main", path: "n.md", operation: "write", contentKind: "text" }]));
      expect(gets).not.toHaveBeenCalled();
      expect(await readFile(join(root, "n.md"), "utf8")).toBe("incoming");
      expect(existsSync(join(root, "n (kept copy).md"))).toBe(false);
      expect(notice).not.toHaveBeenCalled();
    } finally { await engine.stop(); }
  });

  it("merges 150 recorded files without desktop copies or notices", async () => {
    const root = await createTestScratch("merge-150-recorded-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    const send = loopback.sendRequest.bind(loopback);
    const requests: Request[] = [];
    vi.spyOn(loopback, "sendRequest").mockImplementation(async request => {
      requests.push(request);
      if (request.method === "conflicts.list") return { id: request.id, result: { conflicts: [], nextAfterConflictId: null } };
      const response = await send(request);
      // Model the engine's immediate publication of each text merge.
      if (request.method === VERSIONED_METHOD.versionsMerge) await write(root, (request.params as { path: string }).path, "incoming");
      return response;
    });
    for (let index = 0; index < 150; index++) {
      loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: `merge-object-${index}`, path: `${index}.md`, text: "recorded" });
      await write(root, `${index}.md`, "recorded");
    }
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const draft = await store.createNamedVersion({ workspaceId: WORKSPACE_ID, name: "Draft", fromVersionId: "main" });
    for (let index = 0; index < 150; index++) loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: draft.id, objectId: `merge-object-${index}`, path: `${index}.md`, text: "incoming" });
    const notice = vi.fn();
    const engine = capture(root, { store, rustEngineSessions: sessions, onOutsideWriteCopies: notice });
    requests.length = 0;
    try {
      const started = performance.now();
      await expect(engine.mergeVersionIntoMain(draft.id)).resolves.toMatchObject({ mergedFileCount: 150, conflictCount: 0 });
      const elapsedMs = performance.now() - started;
      const count = (method: string) => requests.filter(request => request.method === method).length;
      expect(count(VERSIONED_METHOD.versionsMerge)).toBe(150);
      expect(count(VERSIONED_METHOD.momentsList)).toBe(0);
      expect(count(VERSIONED_METHOD.momentsGet)).toBe(0);
      expect(count("files.resolve")).toBe(0);
      expect((await readdir(root)).filter(name => name.includes("(kept copy"))).toEqual([]);
      expect(notice).not.toHaveBeenCalled();
      for (let index = 0; index < 150; index++) expect(await readFile(join(root, `${index}.md`), "utf8")).toBe("incoming");
      process.stdout.write(`150-file merge: ${elapsedMs.toFixed(2)} ms; listMoments=0; getMoment=0; resolveFiles=0; merges=150\n`);
    } finally { await engine.stop(); }
  });

  it.each(["missing-size", "wrong-size", "missing-hash"])("checks only recorded hashes, summary=%s", async summary => {
    const root = await createTestScratch("relay-history-no-size-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "note-object", path: "n.md", text: "AGENT-1" });
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "note-object", path: "n.md", text: "OWNER-1", origin: "sync" });
    await write(root, "n.md", "AGENT-1");
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const list = store.listMoments.bind(store);
    vi.spyOn(store, "listMoments").mockImplementation(async input => {
      const page = await list(input);
      for (const row of page.moments) {
        if (summary === "missing-size") delete row.byteLength;
        if (summary === "wrong-size") row.byteLength = 999;
        if (summary === "missing-hash") delete row.sha256;
      }
      return page;
    });
    const get = vi.spyOn(store, "getMoment");
    const engine = capture(root, { store, rustEngineSessions: sessions });
    try {
      await engine.runRelaySync(page => page([{ versionId: "main", path: "n.md", operation: "write", contentKind: "text" }]));
      expect(get).not.toHaveBeenCalled();
      expect(existsSync(join(root, "n (kept copy).md"))).toBe(summary === "missing-hash");
    } finally { await engine.stop(); }
  });

  it.each([false, true])("bounds History lookup to the pulled object, newestMatch=%s", async newestMatch => {
    const root = await createTestScratch("relay-history-bound-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    for (let index = 0; index < 199; index++) {
      loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "note-object", path: "n.md",
        text: newestMatch && index === 198 ? "AGENT-1" : index % 2 === 0 ? "prior-1" : "a longer prior version" });
    }
    for (let index = 0; index < 5_000; index++) {
      loopback.seedTextFile({ workspace: WORKSPACE_ID, path: `other/${index}.md`, text: "AGENT-1" });
    }
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "note-object", path: "n.md", text: "OWNER-1", origin: "sync" });
    await write(root, "n.md", "AGENT-1");
    const requests: Request[] = [];
    const engine = liveCapture(root, loopback, { requests });
    try {
      const started = performance.now();
      await engine.runRelaySync(page => page([{ versionId: "main", path: "n.md", operation: "write", contentKind: "text" }]));
      const elapsedMs = performance.now() - started;
      const lists = requests.filter(request => request.method === VERSIONED_METHOD.momentsList);
      const gets = requests.filter(request => request.method === VERSIONED_METHOD.momentsGet);
      expect(lists.map(request => (request.params as { objectId?: string }).objectId)).toEqual(
        newestMatch ? ["note-object"] : ["note-object", "note-object"]);
      expect(gets).toHaveLength(0);
      expect(requests.filter(request => request.method === "files.resolve")).toHaveLength(1);
      expect(await readFile(join(root, "n.md"), "utf8")).toBe("OWNER-1");
      expect(existsSync(join(root, "n (kept copy).md"))).toBe(!newestMatch);
      if (!newestMatch) expect(await readFile(join(root, "n (kept copy).md"), "utf8")).toBe("AGENT-1");
      process.stdout.write(`History newestMatch=${newestMatch}: ${elapsedMs.toFixed(2)} ms; listMoments=${lists.length}; getMoment=${gets.length}; resolveFiles=1; unrelated=5000; object=200\n`);
    } finally { await engine.stop(); }
  });

  it.each(["recreated", "older-path"] as const)("keeps a copy when History coverage is %s", async coverage => {
    const root = await createTestScratch("relay-history-coverage-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: coverage === "recreated" ? "old-object" : "note-object",
      path: coverage === "older-path" ? "old.md" : "n.md", text: "AGENT-1" });
    loopback.seedTextFile({ workspace: WORKSPACE_ID, objectId: "note-object", path: "n.md", text: "OWNER-1", origin: "sync" });
    await write(root, "n.md", "AGENT-1");
    const engine = liveCapture(root, loopback);
    try {
      await engine.runRelaySync(page => page([{ versionId: "main", path: "n.md", operation: "write", contentKind: "text" }]));
      expect(await readFile(join(root, "n (kept copy).md"), "utf8")).toBe("AGENT-1");
    } finally { await engine.stop(); }
  });

  it.each(["write", "delete"] as const)("does not copy recorded disk bytes on a fresh capture before a pulled %s", async operation => {
    const root = await createTestScratch("relay-recorded-copy-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: "main", objectId: "note-object", path: "n.md", text: "earlier recorded text", origin: "local-file" });
    await write(root, "n.md", "earlier recorded text");
    loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: "main", objectId: "note-object", path: "n.md", text: "new collaborator text", origin: "sync" });
    const notice = vi.fn();
    const engine = liveCapture(root, loopback, { onOutsideWriteCopies: notice });
    try {
      await engine.runRelaySync(page => page([{ versionId: "main", path: "n.md", operation, contentKind: "text" }]));
      expect((await readdir(root)).filter(name => name.includes("(kept copy"))).toEqual([]);
      expect(notice).not.toHaveBeenCalled();
      if (operation === "write") expect(await readFile(join(root, "n.md"), "utf8")).toBe("new collaborator text");
      else expect(existsSync(join(root, "n.md"))).toBe(false);
    } finally { await engine.stop(); }
  });

  it.each(["resolveFiles", "listMoments", "getActiveVersion", "ensureMainVersion"])("stops a relay write with its ordinary History cause when %s fails", async method => {
    const root = await createTestScratch("relay-history-failure-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, path: "n.md", text: "OWNER-1", origin: "sync" });
    await write(root, "n.md", "AGENT-1");
    const sessions = mockLiveSessions(loopback);
    const liveStore = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const failure = new Error(`History ${method} failed`);
    const store = new Proxy(liveStore, {
      get(target, property) {
        if (property === method) return async () => { throw failure; };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const engine = capture(root, { store, rustEngineSessions: sessions, onError: () => undefined });
    const commit = vi.fn(async () => undefined);
    try {
      const run = engine.runRelaySync(page => deliverRelayPage(page, { fastForwardedPaths: [{
        versionId: "main", path: "n.md", operation: "write", contentKind: "text",
      }] }, commit));
      await expect(run).rejects.toThrow(failure.message);
      await expect(run).rejects.not.toBeInstanceOf(OutsideWriteCopyError);
      await expect(run).rejects.not.toThrow("Check that dohc can write");
      expect(commit).not.toHaveBeenCalled();
      expect(await readFile(join(root, "n.md"), "utf8")).toBe("AGENT-1");
      expect(existsSync(join(root, "n (kept copy).md"))).toBe(false);
    } finally { await engine.stop(); await liveStore.close(); }
  });

  it("lets a pulled delete remove a symlink without copying or changing its target", async () => {
    const root = await createTestScratch("relay-link-delete-");
    await write(root, "target.md", "target bytes");
    await symlink(join(root, "target.md"), join(root, "n.md"));
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const commit = vi.fn(async () => undefined);
    try {
      await engine.runRelaySync(page => deliverRelayPage(page, { fastForwardedPaths: [{
        versionId: "main", path: "n.md", operation: "delete", contentKind: "text",
      }] }, commit));
      expect(commit).toHaveBeenCalledOnce();
      expect(existsSync(join(root, "n.md"))).toBe(false);
      expect(await readFile(join(root, "target.md"), "utf8")).toBe("target bytes");
      expect((await readdir(root)).filter(name => name.includes("kept copy"))).toEqual([]);
    } finally { await engine.stop(); }
  });

  it.each([false, true])("reports a successful copy after the disk write even when the write fails=%s or reporting throws", async diskFails => {
    const root = await createTestScratch("relay-copy-report-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    await write(root, "n.md", "AGENT-1");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, path: "n.md", text: "OWNER-1", origin: "sync" });
    const writer = createDefaultDiskWriter(root);
    const steps: string[] = [];
    const engine = liveCapture(root, loopback, {
      diskWriter: { ...writer, writeTextFile: async (path, text) => {
        steps.push("write");
        expect(await readFile(join(root, "n (kept copy).md"), "utf8")).toBe("AGENT-1");
        if (diskFails) throw new Error("disk write refused");
        await writer.writeTextFile(path, text);
      } },
      onOutsideWriteCopies: () => { steps.push("report"); throw new Error("notice report refused"); },
      onError: () => undefined,
    });
    try {
      const run = engine.runRelaySync(page => page([{ versionId: "main", path: "n.md", operation: "write", contentKind: "text" }]));
      if (diskFails) await expect(run).rejects.toThrow("disk write refused");
      else await run;
      expect(steps).toEqual(["write", "report"]);
      expect(await readFile(join(root, "n.md"), "utf8")).toBe(diskFails ? "AGENT-1" : "OWNER-1");
      expect(await outsideWriteCopies({ workspaceId: WORKSPACE_ID, rootPath: root }).list()).toHaveLength(1);
    } finally { await engine.stop(); }
  });

  it.each([false, true])("preserves the outside write before relay commit, copyFails=%s", async copyFails => {
    const root = await createTestScratch("relay-outside-copy-");
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: "main", path: "n.md", text: "OWNER-1", origin: "sync" });
    await write(root, "n.md", "AGENT-1");
    if (copyFails) await write(root, ".dohc/local/outside-write-copies", "not a folder");
    const engine = liveCapture(root, loopback);
    const commit = vi.fn(async () => undefined);
    try {
      const run = engine.runRelaySync(page => deliverRelayPage(page, { fastForwardedPaths: [{
        versionId: "main", path: "n.md", operation: "write", contentKind: "text",
      }] }, commit));
      if (copyFails) {
        await expect(run).rejects.toThrow("dohc could not keep a copy of n.md\nMove .dohc/local/outside-write-copies out of the way, then choose Try again.\nUntil then, dohc leaves n.md as it was.");
        await expect(run).rejects.toThrow(`Blocking file: ${join(root, ".dohc/local/outside-write-copies")}`);
        await expect(run).rejects.toThrow("Cause:");
        expect(commit).not.toHaveBeenCalled();
        expect(await readFile(join(root, "n.md"), "utf8")).toBe("AGENT-1");
      } else {
        await run;
        expect(commit).toHaveBeenCalledOnce();
        expect(await readFile(join(root, "n (kept copy).md"), "utf8")).toBe("AGENT-1");
        expect(await readFile(join(root, "n.md"), "utf8")).toBe("OWNER-1");
      }
    } finally { await engine.stop(); }
  });


  async function deliverRelayPage<T extends {
    fastForwardedPaths: readonly RelayMaterializedPath[];
  }>(
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

  it("initializes the main version before the first relay task", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = liveCapture(root, new VersionedLoopbackEngine(), {
      requests,
    });

    let initializedWhenTaskRan = false;
    await engine.runRelaySync(async (materializePage) => {
      initializedWhenTaskRan = requests.some(
        (request) => request.method === VERSIONED_METHOD.versionsEnsureMain,
      );
      return await deliverRelayPage(materializePage, {
        fastForwardedPaths: [],
      });
    });

    expect(initializedWhenTaskRan).toBe(true);
    await engine.stop();
  });

  it("settles daemon capture after relay materialization before committing the cursor", async () => {
    vi.mocked(delay).mockResolvedValue(undefined);
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      const loopback = new VersionedLoopbackEngine();
      const requests: Request[] = [];
      let settled = true;
      const engine = capture(root, {
        rustEngineSessions: mockLiveSessions(loopback, requests, () => ({ deferredWrites: [],
          settled,
          running: true,
          heldFiles: [], degraded: !settled,
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

      await engine.runRelaySync(async (materializePage) =>
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
        engine.runRelaySync(async (materializePage) =>
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

  it("materializes pull-fast-forwarded text to disk", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    // Simulate the post-pull state: the engine holds remote content the folder
    // does not have yet (pull applies ops to the engine; runRelaySync owns
    // getting them onto disk).
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "remote machine wrote this\n",
      origin: "sync",
    });

    const result = await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, {
        fastForwardedPaths: [
          {
            versionId: "main",
            path: "notes/remote.md",
            operation: "write" as const,
            contentKind: "text" as const,
          },
        ],
      }),
    );
    expect(result.fastForwardedPaths).toHaveLength(1);
    expect(await readFile(join(root, "notes/remote.md"), "utf8")).toBe(
      "remote machine wrote this\n",
    );
    await engine.stop();
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

    await engine.runRelaySync(async (materializePage) =>
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

  it("materializes a remote delete and reports no disk work when nothing fast-forwarded", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: root });
    await write(root, "doomed.md", "here today\n");
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "doomed.md",
      text: "here today\n",
    });

    // Remote deleted the file; pull already applied the delete to the engine.
    await loopback.sendRequest({
      id: -2,
      method: VERSIONED_METHOD.textDelete,
      workspace: WORKSPACE_ID,
      params: {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "doomed.md",
        origin: "sync",
        summary: "remote delete",
      },
    });
    const momentsBefore = (await liveMoments(engine)).length;

    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, {
        fastForwardedPaths: [
          {
            versionId: "main",
            path: "doomed.md",
            operation: "delete" as const,
            contentKind: "text" as const,
          },
        ],
      }),
    );
    expect(existsSync(join(root, "doomed.md"))).toBe(false);

    // A quiescent pass (no fast-forwarded paths) touches nothing.
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, { fastForwardedPaths: [] }),
    );
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(momentsBefore);
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

    await engine.runRelaySync(async (materializePage) =>
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
        expect(await readFile(join(root, ".env"), "utf8")).toBe(
          "ACCESS_TOKEN=protected\r\n",
        );
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
    await engine.runRelaySync(async (materializePage) =>
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
    const { root, engine, draftId } = await protectedVersionFixture(
      "VALUE=main remote\n",
    );

    await rm(join(root, ".env"), { force: true });
    await mkdir(join(root, ".env"));
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
      engine.runRelaySync(async (materializePage) =>
        await deliverRelayPage(materializePage, replay(), commit),
      ),
    ).rejects.toThrow(/Could not update \.env/u);
    expect(commit).not.toHaveBeenCalled();

    await rm(join(root, ".env"), { recursive: true, force: true });
    await write(root, ".env", "VALUE=main remote\n");
    await engine.switchVersion(draftId);
    await write(root, ".env", "VALUE=draft local drift\n");
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, replay(), commit),
    );

    expect(await readFile(join(root, ".env"), "utf8")).toBe(
      "VALUE=draft local drift\n",
    );
    expect(commit).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it("does not replay a protected delete into a version entered after materialization failed", async () => {
    const { root, loopback, engine, draftId } = await protectedVersionFixture(
      "VALUE=main\n",
    );
    await loopback.sendRequest({
      id: -4,
      method: VERSIONED_METHOD.secretsDelete,
      workspace: WORKSPACE_ID,
      params: {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        origin: "sync",
        momentId: "remote-secret-delete-before-version-switch",
      },
    });

    await rm(join(root, ".env"), { force: true });
    await mkdir(join(root, ".env"));
    const commit = vi.fn(async () => {});
    const replay = () => ({
      fastForwardedPaths: [
        {
          versionId: "main",
          path: ".env",
          operation: "delete" as const,
          contentKind: "secret" as const,
        },
      ],
    });
    await expect(
      engine.runRelaySync(async (materializePage) =>
        await deliverRelayPage(materializePage, replay(), commit),
      ),
    ).rejects.toThrow(/Could not update \.env/u);
    expect(commit).not.toHaveBeenCalled();

    await rm(join(root, ".env"), { recursive: true, force: true });
    await engine.switchVersion(draftId);
    await write(root, ".env", "VALUE=draft local drift\n");
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, replay(), commit),
    );

    expect(await readFile(join(root, ".env"), "utf8")).toBe(
      "VALUE=draft local drift\n",
    );
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

    // Block materialization: a directory squats on the file path.
    await mkdir(join(root, "notes/remote.md"), { recursive: true });
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
      engine.runRelaySync(async (materializePage) =>
        await deliverRelayPage(materializePage, pullResult(), commit),
      ),
    ).rejects.toThrow("Could not update notes/remote.md on disk:");
    expect(commit).not.toHaveBeenCalled();

    // Unblock the path: the retry pass materializes and THEN commits.
    await rm(join(root, "notes/remote.md"), { recursive: true, force: true });
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, pullResult(), commit),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "notes/remote.md"), "utf8")).toBe(
      "remote machine wrote this\n",
    );

    // A quiescent pass (chat-only or own-origin ops) still commits: cursor
    // progress must not depend on file materialization work existing.
    const quiescentCommit = vi.fn(async () => {});
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(
        materializePage,
        { fastForwardedPaths: [] },
        quiescentCommit,
      ),
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

describe("workspaceEngineCapture capture-failure notice", () => {
  it("mutation proof: daemon startup open failure raises the capture outcome", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const { loopback, state } = failableLoopback();
    const outcomes: boolean[] = [];
    const errors: string[] = [];
    let resolveOutcome!: () => void;
    const outcomeReported = new Promise<void>((resolve) => {
      resolveOutcome = resolve;
    });
    let resolveError!: () => void;
    const errorReported = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const engine = liveCapture(root, loopback, {
      onCaptureOutcome: (failure) => {
        outcomes.push(failure === null);
        resolveOutcome();
      },
      onError: (context) => {
        errors.push(context);
        resolveError();
      },
    });

    engine.start();
    await Promise.all([outcomeReported, errorReported]);

    expect(outcomes).toEqual([false]);
    expect(errors).toEqual(["daemon capture health"]);
    state.failing = false;
    await engine.stop();
  });

  it("keeps a workspace without a capture unaffected", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-no-capture-notice",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({ capture: null, shareView: false }),
    });
    await activity.open(workspace);
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBeUndefined();
    await activity.stopAll();
    // Not-open workspaces report a clean status too.
    expect(activity.getStatus("never-opened").historyCaptureFailed).toBeUndefined();
  });
});

describe("workspaceEngineCapture lifecycle via workspaceActivity", () => {
  it("registerExpectedEngineEvents reaches the open workspace's capture", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-expected",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const loopback = new VersionedLoopbackEngine();
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (w) => ({
        shareView: false,
        capture: createWorkspaceEngineCapture({
          workspaceId: w.workspaceId,
          rootPath: w.rootPath,
          attachmentId: w.attachmentId,
          rustEngineSessions: mockLiveSessions(loopback),
        }),
      }),
    });
    await activity.open(workspace);
    const cancel = activity.registerExpectedEngineEvents(workspace.workspaceId, [
      { path: "a.md" },
    ]);
    expect(typeof cancel).toBe("function");
    cancel?.();
    await activity.stopAll();

    expect(() =>
      activity.registerExpectedEngineEvents("not-open", [
        { path: "a.md" },
      ]),
    ).toThrow(/not open/i);
  });
});

describe("createDefaultDiskWriter symlink containment", () => {
  // The engine's own materialization writes (switch/merge/restore) must stay
  // inside the workspace even against adversarial symlinks on disk.
  it("refuses to write through a symlink leaf", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await write(outside, "target.md", "original outside content\n");
    await symlink(join(outside, "target.md"), join(root, "notes.md"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "notes.md"), "engine text\n"),
    ).rejects.toThrow(/symlink/);
    // The symlink target outside the workspace was never touched.
    expect(await readFile(join(outside, "target.md"), "utf8")).toBe(
      "original outside content\n",
    );
  });

  it("refuses to mkdir through a symlinked ancestor pointing outside the workspace", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await symlink(outside, join(root, "escape"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "escape", "deep", "file.md"), "x\n"),
    ).rejects.toThrow(/escaped the workspace root/);
    // mkdir -p never created directories on the far side of the symlink.
    expect(existsSync(join(outside, "deep"))).toBe(false);
  });

  it("writes normally inside the workspace, creating missing directories", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "a", "b", "c.md"), "nested\n");
    expect(await readFile(join(root, "a", "b", "c.md"), "utf8")).toBe("nested\n");
  });

  it("writes into a directory whose NAME starts with '..'", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "..cache", "c.md"), "cached\n");
    expect(await readFile(join(root, "..cache", "c.md"), "utf8"), "..-segment: a bare '..-prefix' isInside refuses this real contained name.").toBe("cached\n");
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
});

// Agent-attributed capture: while a dohc-tracked agent run is active the
// daemon stamps its captures with that author; an authored write carries its
// own author instead.
describe("workspaceEngineCapture agent attribution", () => {
  it("returns stable object and moment ids from authored text and binary retries", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const author = { kind: "agent", agentId: "local-app", onBehalfOf: "local" } as const;
    try {
      for (const [name, content] of [["record.md", "record\n"], ["record.bin", new Uint8Array([0, 255])]] as const) {
        const options = { createOnly: true, requestId: 'request-' + name, momentId: 'moment-' + name, versionId: "main" };
        const first = await engine.writeAuthoredFile(join(root, name), content, author, options);
        expect(first).toMatchObject({ objectId: expect.any(String), momentId: options.momentId, deduped: false });
        const retry = await engine.writeAuthoredFile(join(root, name), content, author, options);
        expect(retry).toMatchObject({ objectId: first.objectId, momentId: first.momentId, deduped: true });
      }
    } finally { await engine.stop(); }
  });

  it("refuses a saved-version authored retry instead of writing into a newly active version", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = liveCapture(root, loopback, { requests });
    const author = { kind: "agent", agentId: "local-app", onBehalfOf: "local" } as const;
    try {
      const draft = await engine.createVersion("Draft");
      await expect(engine.writeAuthoredFile(join(root, "pending.md"), "pending\n", author,
        { createOnly: true, requestId: "saved-request", momentId: "saved-moment", versionId: "main" })).rejects.toMatchObject({ code: "invalid-version" });
      expect(requests.findLast(request => request.method === VERSIONED_METHOD.textWrite)).toMatchObject({ params: { versionId: "main" } });
      expect(draft.activeVersionId).not.toBe("main");
      expect(await readFile(join(root, "pending.md"), "utf8").catch(() => null)).toBeNull();
    } finally { await engine.stop(); }
  });

  const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1", depth: 0 };

  it("publishes large authored text through the engine and replays a create", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = liveCapture(root, loopback, { requests });
    const text = "a".repeat(128 * 1024 - 1) + "€";
    const author = { kind: "agent", agentId: "agent", onBehalfOf: "local" } as const;
    await engine.writeAuthoredFile(join(root, "large.txt"), Buffer.from(text), author, { createOnly: true, requestId: "stable" });
    expect(await readFile(join(root, "large.txt"), "utf8")).toBe(text);
    expect(requests.find(request => request.method === VERSIONED_METHOD.textWriteBlob)?.idempotencyKey).toBe("stable");
    await engine.writeAuthoredFile(join(root, "large.txt"), text, author, { createOnly: true, requestId: "stable" });
    expect(await liveMomentAuthors(engine)).toEqual([[author]]);
    await engine.stop();
  });

  it("sends binary content with its author, precondition, and batch correlation", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = liveCapture(root, new VersionedLoopbackEngine(), { requests });
    const author = { kind: "agent", agentId: "Client", onBehalfOf: "local", depth: 2 } as const;
    const outcome = await engine.writeAuthoredFile(join(root, "bytes.bin"), new Uint8Array([0, 255, 1]), author,
      { createOnly: true, requestId: "binary", correlationId: "batch" });
    expect(outcome.materializeOutcome).toBe("applied");
    const request = requests.find(request => request.method === VERSIONED_METHOD.binaryWrite);
    expect(request).toMatchObject({ idempotencyKey: "binary", params: { bytes: [0, 255, 1], author, createOnly: true, correlationId: "batch" } });
    expect(request?.params).not.toHaveProperty("requestId");
    expect(requests.findIndex(request => request.method === "capture.flush")).toBeLessThan(requests.indexOf(request!));
    expect(await liveMomentAuthors(engine)).toEqual([[author]]);
    await engine.stop();
  });

  it("records an authored write under its own author, not the ambient run", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    await engine.setActiveAgentRun(run);
    const author = { kind: "agent", agentId: "test-agent", onBehalfOf: "local", agentRunId: "spawn-123" } as const;

    await engine.writeAuthoredFile(join(root, "output.txt"), "Written by an agent\n", author);

    expect(await readFile(join(root, "output.txt"), "utf8")).toBe("Written by an agent\n");
    expect(await liveMomentAuthors(engine)).toEqual([[author]]);
    await engine.stop();
  });

  it("writes an authored change only while the file is as it was read", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const target = join(root, "automations.yaml");
    await writeFile(target, "version: 1\n");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    // The loopback engine models agent authors; the daemon takes an automation's the same way.
    const author = { kind: "agent", agentId: "test-agent", onBehalfOf: "local", agentRunId: "spawn" } as const;

    await expect(engine.writeAuthoredFile(target, "changed\n", author, { expectedContentHash: hash("something else\n") }))
      .rejects.toBeInstanceOf(AuthoredTextChangedError);
    expect(await readFile(target, "utf8")).toBe("version: 1\n");

    await engine.writeAuthoredFile(target, "version: 1\nautomations: []\n", author, { expectedContentHash: hash("version: 1\n") });
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
    await expect(readFile(join(canonical, "output.txt"), "utf8")).resolves.toBe(
      "canonical\n",
    );
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
    expect(collision).toMatchObject({ code: "target-path-exists", message: "File already exists: exclusive.txt" });
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
      const outcome = await engine.writeAuthoredFile(
        targetPath,
        "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n",
        { kind: "agent", agentId: "plugin:records", onBehalfOf: "local", agentRunId: "create" },
        { createOnly: true },
      ).then(() => "created", (error: unknown) => ({ refused: String(error) }));
      expect(injected).toBe(true);
      expect.soft(outcome).not.toBe("created");
      expect.soft(outcome).toEqual({ refused: expect.stringMatching(/exist/i) });
      expect.soft(await readFile(targetPath, "utf8")).toBe(competingText);
      expect.soft(requests.filter(request => request.method === VERSIONED_METHOD.textWrite)).toEqual([
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
    const blocker = engine.writeAuthoredFile(
      join(root, "queue-blocker.txt"),
      "block\n",
      { kind: "agent", agentId: "test-agent", onBehalfOf: "local", agentRunId: "spawn" },
    );
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

  it("accepts authored text beyond the capture inline boundary", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const author = {
      kind: "agent" as const,
      agentId: "test-agent",
      onBehalfOf: "local",
      agentRunId: "spawn",
    };

    await expect(
      engine.writeAuthoredFile(
        join(root, "at-limit.txt"),
        "x".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES),
        author,
      ),
    ).resolves.toMatchObject({ resolvedAbsolutePath: join(root, "at-limit.txt"), materializeOutcome: "applied", objectId: expect.any(String), momentId: expect.any(String), deduped: false });
    await expect(
      engine.writeAuthoredFile(
        join(root, "over-limit.txt"),
        "x".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES + 1),
        author,
      ),
    ).resolves.toMatchObject({ resolvedAbsolutePath: join(root, "over-limit.txt"), materializeOutcome: "applied", objectId: expect.any(String), momentId: expect.any(String), deduped: false });
    await engine.stop();
  });

  it("mutation proof: daemon author state is set before work and flushed before clear", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    await engine.setActiveAgentRun(run);
    await engine.setActiveAgentRun(null);
    // A run an automation woke names its chain depth; a person's names none.
    await engine.setActiveAgentRun({ ...run, agentRunId: "run-woken", depth: 3 });

    const authorRequests = requests.filter((request) =>
      request.method === "capture.setAuthor" ||
      request.method === "capture.flush",
    );
    expect(authorRequests.map((request) => request.method)).toEqual([
      "capture.setAuthor",
      "capture.flush",
      "capture.setAuthor",
      "capture.setAuthor",
    ]);
    const { depth: _personDepth, ...person } = run;
    expect(authorRequests[0]?.params).toEqual({
      author: { kind: "agent", ...person },
    });
    expect(authorRequests[2]?.params).toEqual({ author: null });
    expect(authorRequests[3]?.params).toEqual({
      author: { kind: "agent", ...person, agentRunId: "run-woken", depth: 3 },
    });
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
        rustEngineSessions: mockLiveSessions(loopback, requests, () => ({ deferredWrites: [],
          settled,
          running: true,
          heldFiles: [], degraded: !settled,
        })),
      });

      await engine.setActiveAgentRun(run);
      await expect(engine.setActiveAgentRun(null)).rejects.toThrow("did not settle");
      const methods = requests
        .filter(
          (request) =>
            request.method === "capture.flush" ||
            request.method === "capture.setAuthor",
        )
        .map((request) => request.method);
      // The guarantee is that authorship is never cleared behind an unsettled
      // flush — not how many times the flush was asked. flushCapture now polls
      // for quiescence, as the daemon documents and every Rust consumer does,
      // so pinning the exact call count would fail on the retries while proving
      // nothing extra. Pin the guarantee instead: the run was stamped once, the
      // clear never happened, and nothing but flushes ran in between.
      expect(methods[0]).toBe("capture.setAuthor");
      expect(methods.filter((method) => method === "capture.setAuthor")).toEqual([
        "capture.setAuthor",
      ]);
      expect(methods.slice(1).every((method) => method === "capture.flush")).toBe(
        true,
      );
      expect(methods.length).toBeGreaterThan(1);

      settled = true;
      await engine.setActiveAgentRun(null);
      expect(
        requests.filter((request) => request.method === "capture.setAuthor").at(-1)
          ?.params,
      ).toEqual({ author: null });
      await engine.stop();
    } finally {
      vi.mocked(delay).mockRestore();
    }
  });

});

describe("Rust engine session selection", () => {
  it.each(["owner-outbox", "shutdown"])("does not wake watched uploads after %s acknowledgement", async mode => {
    const root = await createTestScratch("dohc-durable-lane-");
    const loopback = new VersionedLoopbackEngine();
    await write(root, "note.md", "existing");
    loopback.seedTextFile({workspace: WORKSPACE_ID, versionId: "main", path: "note.md", text: "existing"});
    const entered = deferred<void>(), journal = deferred<void>();
    const engine = capture(root, {rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async options => {
        const doc = new Y.Doc();
        return {doc, initialUpdate: Y.encodeStateAsUpdate(doc), contentKind: "plaintext", path: "note.md",
          head: "present", lineage: "existing", evict: async () => {}, close: async () => {},
          applyLocalUpdate: async (_update: Uint8Array, applyOptions: {idempotencyKey: string}) => {
            entered.resolve(); await journal.promise;
            options.onLocalUpdateAcknowledged?.(applyOptions.idempotencyKey, mode === "owner-outbox" ? "owner-outbox" : "journal");
          }, settleNow: vi.fn()} as never;
      }});
    const changed = vi.fn(); engine.onDurableLocalChange(changed);
    let report!: (value: {hasMore: boolean; watched: boolean}) => void;
    const push = vi.fn(async () => ({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []}));
    const sync = createRelaySyncEngine({rootDir: root, relay: {baseUrl: "http://relay.test", token: "t"}, capture: engine,
      operations: {push, pull: async () => ({fetched: 0, applied: 0, skipped: 0, conflictsOpened: 0, fastForwardedPaths: [], nextCursor: 0, sharingDeclined: []}), claim: async () => {}, recoverOrigin: vi.fn()},
      onChange: vi.fn(), waitForChange: (_since, signal) => new Promise((resolve, reject) => {
        report = resolve; signal.addEventListener("abort", () => reject(signal.reason), {once: true});
      })});
    const ownerPass = vi.fn(async () => ({documentCount: 0, acknowledged: false}));
    const owner = startServerOwnerDelivery({workspaceIds: () => [WORKSPACE_ID], attemptTimeoutMs: 5000, retryDelayMs: 10_000, runPass: ownerPass, onError: vi.fn()});
    const retry = vi.spyOn(owner, "retry");
    const session = await engine.openYDocSession({path: "note.md", onRemoteUpdate: () => {}});
    const editor = new Y.Doc(); editor.getText("content").insert(0, "edit");
    try {
      await sync.start(); await vi.waitFor(() => expect(report).toBeTypeOf("function"));
      report({hasMore: false, watched: true});
      await vi.waitFor(() => expect(ownerPass).toHaveBeenCalledTimes(1));
      const recording = session.applyDecidedLocalUpdate(() => Y.encodeStateAsUpdate(editor));
      await entered.promise;
      if (mode === "shutdown") engine.beginShutdown();
      journal.resolve(); await recording;
      // Flush the sync chain too, without introducing an ordinary push.
      await sync.stop();
      expect(changed).not.toHaveBeenCalled();
      expect(push).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
      expect(ownerPass).toHaveBeenCalledTimes(1);
    } finally {
      journal.resolve(); await sync.stop(); await owner.stop();
      await session.close({settle: false}); await engine.stop(); editor.destroy();
    }
  });

  it("reports a workspace durable edit after the journal resolves, without forcing a settle", async () => {
    const root = await createTestScratch("dohc-durable-wake-");
    const loopback = new VersionedLoopbackEngine();
    await write(root, "note.md", "existing");
    loopback.seedTextFile({workspace: WORKSPACE_ID, versionId: "main", path: "note.md", text: "existing"});
    const journal = deferred<void>();
    const entered = deferred<void>();
    const settle = vi.fn();
    const engine = capture(root, {rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async () => {
        const doc = new Y.Doc();
        return {doc, initialUpdate: Y.encodeStateAsUpdate(doc), contentKind: "plaintext", path: "note.md",
          head: "present", lineage: "existing", evict: async () => {}, close: async () => {},
          applyLocalUpdate: async () => {entered.resolve(); await journal.promise;}, settleNow: settle} as never;
      }});
    const changed = vi.fn(); const detach = engine.onDurableLocalChange(changed);
    const session = await engine.openYDocSession({path: "note.md", onRemoteUpdate: () => {}});
    const editor = new Y.Doc(); editor.getText("content").insert(0, "edit");
    session.applyLocalUpdate(Y.encodeStateAsUpdate(editor)); await entered.promise;
    expect(changed).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
    journal.resolve(); await engine.flush();
    expect(changed).toHaveBeenCalledExactlyOnceWith("note.md"); expect(settle).not.toHaveBeenCalled();
    detach(); editor.getText("content").insert(4, "more");
    session.applyLocalUpdate(Y.encodeStateAsUpdate(editor)); await engine.flush();
    expect(changed).toHaveBeenCalledTimes(1);
    await session.close({settle: false}); await engine.stop(); editor.destroy();
  });
  // An injected store can observe capture operations, but it cannot select the
  // retired in-process Y.Doc provider.
  async function openWith(
    root: string,
  ): Promise<{ providerOpened: number; storeReads: number }> {
    const loopback = new VersionedLoopbackEngine();
    const sessions = mockLiveSessions(loopback);
    const liveStore = createCaptureLiveStores(
      {
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        attachmentId: WORKSPACE_ATTACHMENT_ID,
      },
      sessions,
    ).store;
    let storeReads = 0;
    const observedStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "readTextFile") {
          return async (input: Parameters<typeof liveStore.readTextFile>[0]) => {
            storeReads += 1;
            return await liveStore.readTextFile(input);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let providerOpened = 0;
    const engine = capture(root, {
      store: observedStore,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async () => {
        providerOpened += 1;
        const doc = new Y.Doc();
        doc.getText("content").insert(0, "daemon");
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: "note.md",
          head: "present" as const,
          lineage: "existing" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "b".repeat(64), content: "daemon" }) as never,
          close: async () => undefined,
        } as never;
      },
    });
    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
    });
    await session.close({ settle: false });
    await engine.stop();
    await liveStore.close();
    return { providerOpened, storeReads };
  }

  it("uses the Rust provider session when a store is injected", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const { providerOpened } = await openWith(root);
    expect(providerOpened).toBe(1);
  });
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
// Both tests stage the interleaving rather than race it. The daemon request
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
        settleNow: async () =>
          ({ sha256: "c".repeat(64), content: "" }) as never,
        close: async () => undefined,
      } as never;
    };
  }

  it("opens a document and publishes an authored file while a relay push waits", async () => {
    const root = await createTestScratch("dohc-drain-interleave-");
    const loopback = new VersionedLoopbackEngine();
    const path = "note.md";
    await write(root, path, "existing document");
    loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: "main", path, text: "existing document" });
    const events: string[] = [];
    const engine = liveCapture(root, loopback, {
      openRustYDocProviderSession: async options => {
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
      rootDir: root, relay: { baseUrl: "http://relay.test", token: "test" }, capture: engine,
      onChange: () => undefined,
      operations: {
        claim: async () => undefined,
        recoverOrigin: async () => { throw new Error("unexpected origin recovery"); },
        push: async () => {
          pushes += 1;
          events.push(`push ${pushes}`);
          if (pushes === 1) { entered.resolve(); await release.promise; }
          else { continued.resolve(); await releaseContinuation.promise; }
          return { pushed: 1, hasMore: pushes === 1, originsPushed: [], ownerAdmissionPending: [], sharingDeclined: [] };
        },
        pull: async () => {
          events.push("pull");
          return { fetched: 0, applied: 0, skipped: 0, conflictsOpened: 0,
            fastForwardedPaths: [], nextCursor: pushes, sharingDeclined: [] };
        },
      },
    });
    try {
      const pass = sync.start();
      await entered.promise;
      // Neither waits for the push on the relay.
      const session = await engine.openYDocSession({ path, onRemoteUpdate: () => undefined });
      await engine.writeAuthoredFile(join(root, "agent.txt"), "authored content",
        { kind: "agent", agentId: "agent", onBehalfOf: "local" });
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

  it("exposes replacement assets after a live lineage resync", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const path = "drawings/replaced-assets.excalidraw";
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const losing: ArtifactAssetDescriptor = {
      id: "losing-image",
      mimeType: "image/png",
      created: 1,
      ref: `assets/excalidraw/${"a".repeat(64)}/${"b".repeat(64)}.png`,
      sha256: "a".repeat(64),
    };
    const winning: ArtifactAssetDescriptor = {
      id: "winning-image",
      mimeType: "image/png",
      created: 2,
      ref: `assets/excalidraw/${"c".repeat(64)}/${sha256}.png`,
      sha256,
    };
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path,
      text: '{"type":"excalidraw","elements":[],"appState":{},"files":{}}',
    });
    loopback.seedBinaryFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: winning.ref,
      bytes: Array.from(bytes),
      origin: "sync",
    });
    let replaceLineage!: () => void;
    let activeAssets: readonly ArtifactAssetDescriptor[] = [losing];
    let lineageClaimId = "losing-claim";
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        const doc = new Y.Doc();
        const provider = {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          get lineageClaimId() {
            return lineageClaimId;
          },
          contentKind: "scene" as const,
          path: options.path,
          head: "present" as const,
          lineage: "existing" as const,
          unsettled: false,
          get artifactAssets() {
            return activeAssets;
          },
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => ({
            sha256: "c".repeat(64),
            content: "",
          }) as never,
          close: async () => undefined,
        } satisfies EngineYdocProviderSession;
        replaceLineage = () => {
          activeAssets = [winning];
          lineageClaimId = "winning-claim";
          options.onLineageReplaced?.(new Y.Doc(), []);
        };
        return provider;
      },
    });
    const replacements: Uint8Array[] = [];
    const session = await engine.openYDocSession({
      path,
      onRemoteUpdate: () => undefined,
      onLineageReplaced: (update) => replacements.push(update),
    });

    replaceLineage();

    expect(replacements).toHaveLength(1);
    expect(session.artifactAssets).toEqual([winning]);
    await expect(session.readArtifactAsset(winning)).resolves.toEqual({
      descriptor: winning,
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
    const sessions = mockLiveSessions(
      loopback,
      undefined,
      undefined,
      async (request) => {
        if (request.method !== VERSIONED_METHOD.versionsSetActive) return;
        const params = request.params as { versionId?: string };
        // createVersion's own set-active is not the switch under test.
        if (params.versionId !== "main") return;
        switchReachedMaterialization.resolve();
        await releaseSwitch.promise;
      },
    );
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
    expect(openedVersionIds, "drop the enqueueResult wrapper from openYDocSession. The open reads the active version while set-active is still blocked and opens the provider on [draftVersionId] — a live session on the version the user left, which the switch's sweep had already passed and could not vacate.").toEqual([]);

    releaseSwitch.resolve();
    const session = await opening;
    await switching;

    // Whatever the user types next belongs to the version they are looking at.
    expect(openedVersionIds).toEqual(["main"]);
    await session.close({ settle: false });
    await engine.stop();
  });

  // The loopback has no conflict ledger, and mergeVersionIntoMain reads one
  // unconditionally to resume an already-open conflict. An empty page is the
  // honest answer for a workspace that has never conflicted, and it keeps the
  // merge under test a real merge instead of a rejected one.
  class MergeableLoopbackEngine extends VersionedLoopbackEngine {
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

  it("opens a session only after a running merge has finished reading and writing heads", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new MergeableLoopbackEngine();
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
    const sessions = mockLiveSessions(
      loopback,
      undefined,
      undefined,
      async (request) => {
        if (request.method !== "conflicts.list") return;
        order.push("merge:reads-heads");
        mergeReachedHeads.resolve();
        await releaseMerge.promise;
      },
    );
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
    expect(order, "drop the enqueueResult wrapper from openYDocSession. The open lands inside the merge, so this reads ['merge:reads-heads', 'ydoc:open'] — a session seeded from a head the merge is in the middle of replacing, and invisible to the sweep that was supposed to vacate it.").toEqual(["merge:reads-heads"]);

    releaseMerge.resolve();
    const session = await opening;
    await merging;

    expect(order).toEqual(["merge:reads-heads", "ydoc:open"]);
    await session.close({ settle: false });
    await engine.stop();
  });

  it("still opens a session on the active version when no version operation is running", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: recordingProvider(openedVersionIds),
    });

    const first = await engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    await first.close({ settle: false });
    const created = await engine.createVersion("Draft");
    const second = await engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });

    expect(openedVersionIds).toEqual(["main", created.activeVersionId]);
    await second.close({ settle: false });
    await engine.stop();
  });
});

// The absent-head refusal reads the disk, and that read is
// awaited. On a shared workspace a replicated `onRemoteUpdate` can land inside
// that await: a peer is writing this very path. Two things then stop being
// true at once — the version does have the document, so "not in this version"
// is false; and the lineage is dirty, so the refusal's `close({settle:false})`
// is answered with UnsettledClose and the provider escalates it to a settling
// close, materializing the path the refusal was about to call missing. The
// refusal would create the phantom it exists to prevent.
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
        // The window codex named (arrival inside the awaited disk check) is the
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
    // Nothing was settled or materialized by a refusal that never happened.
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
    // Two things must be true of the answer, and #665 changed which refusal
    // carries them. It may never call the path missing — something IS writing
    // it — and it may never leave the surface writable over a session the
    // daemon still holds.
    //
    // The orphan now evicts when its close is refused, so the daemon no longer
    // holds the session and the second hazard is gone with it. What remains is
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
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
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

    expect(refusal, "drop the `dischargedByEvict` arm (#665) -> the recheck finds the path still absent and the refusal claims the version does not have a file a peer is writing into it.").toBeInstanceOf(YDocOpenRacedError);
    expect(isYDocPathNotInVersionError(refusal)).toBe(false);
    // The lease is gone, so the surface may fall back — that is what makes the
    // raced refusal safe here where #564 needed the unreleased one.
    expect(refusal).not.toBeInstanceOf(YDocSessionUnreleasedError);
    expect(evicts).toBe(1);
    // And the release never escalated, so nothing was materialized.
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    expect(settles).toEqual([]);
    await expect(readFile(join(root, "peer-created.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await engine.stop();
  });

  it("clears dead-session health when orphan eviction discharges it", async () => {
    // A handed-out session can never become an orphan: only the absent-head
    // refusal below sets that state, before open returns. Stage daemon death at
    // that boundary through the provider's real reconnect callback instead.
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    const outcomes: boolean[] = [];
    const reconnectFailure = Object.assign(new Error("daemon exited"), {
      code: "transport-error",
    });
    const replacementFailure = new Error("replacement daemon unavailable");
    const unsettled = new DaemonRefusalError(
      {
        code: "INVALID_PARAMS",
        message: "ydoc-unsettled-close",
        retry: "no",
      },
      undefined,
    );
    let opens = 0;
    let evicts = 0;
    let reportedDeath = false;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      onCaptureOutcome: (failure) => outcomes.push(failure === null),
      onError: () => undefined,
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        if (opens > 1) throw replacementFailure;
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          // Read first just after the session is installed.
          get lineage() {
            if (!reportedDeath) {
              reportedDeath = true;
              options.onSessionError?.(reconnectFailure);
            }
            return "absent" as const;
          },
          unsettled: false,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "f".repeat(64), content: "" }) as never,
          close: async () => {
            throw unsettled;
          },
        };
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

    expect(refusal, "delete `clearDeadYDocSession` from the orphan evict -> the last outcome stays false.").toBeInstanceOf(YDocOpenRacedError);
    expect(opens).toBe(2);
    expect(outcomes).toEqual([false, true]);
    expect(evicts, "drop the `releaseObligation` branch from the wrapper's `evict()` -> the obligated session's lease remains held forever.").toBe(1);
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
        let deliver: (() => void) | null = () =>
          options.onRemoteUpdate(peerUpdate);
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
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
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
    await expect(
      readFile(join(root, "peer-created.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await engine.stop();
  });

  it("does not claim the version is missing a file an agent created during the release", async () => {
    // The disk read is one syscall and the release that follows awaits a daemon
    // round trip. This chain serializes ENGINE work, not the filesystem, so an
    // agent or an external editor can create the path inside that window — and
    // the queued watcher then captures a file the user was just told does not
    // exist. Staged on the close, which is the window.
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    const settles: string[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => ({
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
          return { sha256: "a".repeat(64), content: "" } as never;
        },
        close: async () => {
          // The agent's write lands while the release is in flight.
          await writeFile(join(root, "agent-made.md"), "written by an agent", "utf8");
        },
      }) as never,
    });

    const refusal = await engine
      .openYDocSession({ path: "agent-made.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // The file is there now, so "this version doesn't have this file" would be
    // a false statement to the user.
    expect(isYDocPathNotInVersionError(refusal)).toBe(false);
    expect(refusal).toBeInstanceOf(YDocOpenRacedError);
    // And the agent's bytes were never touched.
    expect(await readFile(join(root, "agent-made.md"), "utf8")).toBe(
      "written by an agent",
    );
    expect(settles).toEqual([]);
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
        // rules run — the exact input that used to bypass this refusal.
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
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
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
    // The bytes the empty bind would have erased are untouched.
    expect(await readFile(join(root, "uncaptured.md"), "utf8")).toBe(
      "bytes the watcher has not seen",
    );
    await engine.stop();
  });

  it("refuses an uncaptured artifact again after orphan eviction resurrects its lineage", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    // The default policy tracks this short Markdown file, so capture will reach it.
    const path = "resurrected.md";
    const original = "already on disk, never captured";
    const resurrected = "resurrected and settled";
    await writeFile(join(root, path), original, "utf8");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, resurrected);
    const settled: string[] = [];
    let opens = 0;
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: opens === 1 ? ("absent" as const) : ("existing" as const),
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settled.push(resurrected);
            await writeFile(join(root, path), resurrected, "utf8");
            return { sha256: "7".repeat(64), content: resurrected } as never;
          },
          close: async () => {
            throw new DaemonRefusalError(
              {
                code: "INVALID_PARAMS",
                message: "ydoc-unsettled-close",
                retry: "no",
              },
              undefined,
            );
          },
        } as never;
      },
    });

    await expect(
      engine.openYDocSession({ path, onRemoteUpdate: () => undefined }),
    ).rejects.toBeInstanceOf(YDocUncapturedArtifactError);
    expect(evicts).toBe(1);
    expect(await readFile(join(root, path), "utf8")).toBe(original);

    await expect(
      engine.openYDocSession({ path, onRemoteUpdate: () => undefined }),
    ).rejects.toBeInstanceOf(YDocUncapturedArtifactError);
    expect(opens).toBe(2);
    expect(evicts).toBe(2);
    expect(settled).toEqual([]);
    expect(await readFile(join(root, path), "utf8")).toBe(original);
    await engine.stop();
  });
});


it.each(["agent", "typing"])("reopens after a daemon crash by replaying original pending authors instead of a mixed delta (%s)", async mode => {
  const root = await createTestScratch("dohc-authored-replay-");
  const loopback = new VersionedLoopbackEngine();
  const path = "notes/originals.txt";
  loopback.seedTextFile({ workspace: WORKSPACE_ID, versionId: "main", path, text: "abc" });
  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, "abc");
  const initial = Y.encodeStateAsUpdate(seed);
  const source = new Y.Doc();
  Y.applyUpdate(source, initial);
  const originals: Uint8Array[] = [];
  source.on("update", update => originals.push(new Uint8Array(update)));
  source.getText("plainText").delete(0, 1);
  source.getText("plainText").insert(2, "d");
  let opens = 0;
  let available = false;
  const replayed: Array<{ update: Uint8Array; options: Parameters<EngineYdocProviderSession["applyLocalUpdate"]>[1] }> = [];
  const attempted: typeof replayed = [];
  const engine = capture(root, {
    rustEngineSessions: mockLiveSessions(loopback),
    openRustYDocProviderSession: async options => {
      opens += 1;
      if (opens > 1 && !available) throw new Error("daemon is restarting");
      const first = opens === 1;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, initial);
      return {
        doc, initialUpdate: initial, contentKind: "plaintext", path: options.path,
        head: "present", lineage: "existing", unsettled: false,
        async applyLocalUpdate(update, applyOptions) {
          const captured = { update: new Uint8Array(update), options: structuredClone(applyOptions) };
          Y.applyUpdate(doc, update);
          if (first) {
            attempted.push(captured);
            throw Object.assign(new Error("daemon exited"), { code: "transport-error" });
          }
          replayed.push(captured);
          options.onLocalUpdateAcknowledged?.(applyOptions?.idempotencyKey ?? "", "journal");
        },
        settleNow: async () => ({ momentId: "moment-a", path: options.path, sha256: "a".repeat(64), content: doc.getText("plainText").toString(), materialized: true,
          projection: { contentKind: "plaintext", sourceStateVectorSha256: "b".repeat(64), destructive: false } }),
        close: async () => undefined, evict: async () => undefined,
      } satisfies EngineYdocProviderSession;
    },
  });
  const session = await engine.openYDocSession({ path, onRemoteUpdate: () => undefined });
  const alice = { actorOriginId: "alice-agent", attribution: { actorKind: "agent" as const, onBehalfOf: "alice", depth: 1 } };
  if (mode === "typing") {
    session.applyLocalUpdate(originals[0]!, undefined, { ...alice, idempotencyKey: "renderer-alice" });
    await session.applyDecidedLocalUpdate(() => null);
  } else {
    await session.applyDecidedLocalUpdate(() => originals[0]!, undefined, alice);
  }
  const attribution = { actorKind: "automation" as const, onBehalfOf: "bob", depth: 3,
    run: { claimId: "run-b", automationName: "Original name" } };
  const bob = { actorOriginId: "bob-automation", attribution };
  let second: Promise<boolean>;
  if (mode === "typing") {
    session.applyLocalUpdate(originals[1]!, undefined, { ...bob, idempotencyKey: "renderer-bob" });
    second = session.applyDecidedLocalUpdate(() => null);
  } else {
    second = session.applyDecidedLocalUpdate(() => originals[1]!, undefined, bob);
  }
  attribution.run.automationName = "Renamed";
  attribution.depth = 8;
  await second;
  available = true;
  await expect(session.settleNow()).resolves.toMatchObject({ content: "bcd" });
  expect(replayed).toHaveLength(2);
  expect(replayed.map(record => record.update)).toEqual(originals);
  expect(replayed[0]?.options).toMatchObject(attempted[0]?.options ?? {});
  expect(replayed[1]?.options).toMatchObject({ actorOriginId: "bob-automation",
    attribution: { onBehalfOf: "bob", depth: 3, run: { claimId: "run-b", automationName: "Original name" } } });
  expect(replayed.every(record => typeof record.options?.idempotencyKey === "string")).toBe(true);
  const replayCount = replayed.length;
  await session.settleNow();
  expect(replayed).toHaveLength(replayCount);
  await session.close({ settle: false });
  await engine.stop();
  seed.destroy(); source.destroy();
});

it("records a person's own write as a local file edit, and an agent's under its run's person", async () => {
  const root = await createTestScratch("dohc-person-authored-");
  const requests: Request[] = [];
  const engine = capture(root, { rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests) });
  const person = { kind: "human", humanId: "local:installation" } as const;
  // A run Bob's synced edit started works for Bob, whoever is signed in here.
  const agent = { kind: "agent" as const, agentId: "agent-a", onBehalfOf: "bob", agentRunId: "run-a" };
  await engine.writeAuthoredFile(join(root, "hand.md"), "hand\n", person, { createOnly: true });
  const written = engine.writeAuthoredFile(join(root, "agent.txt"), "agent text\n", agent);
  // The caller changes its object while the write waits for its turn.
  Object.assign(agent, { onBehalfOf: "mallory", agentRunId: "run-other" });
  await written;
  expect(requests.filter(request => request.method === VERSIONED_METHOD.textWrite)
    .map(request => [(request.params as { path: string }).path, (request.params as { origin: string }).origin]))
    .toEqual([["hand.md", "local-file"], ["agent.txt", "api"]]);
  expect(await liveMomentAuthors(engine)).toEqual([[person],
    [{ kind: "agent", agentId: "agent-a", onBehalfOf: "bob", agentRunId: "run-a" }]]);
  await engine.stop();
});

it("names the run's person as capture's author, whoever is signed in here", async () => {
  const root = await createTestScratch("dohc-run-person-");
  const requests: Request[] = [];
  const engine = capture(root, { rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests) });
  const run = { agentId: "dohc-mcp", onBehalfOf: "bob", agentRunId: "run-bob", depth: 2 };
  const setting = engine.setActiveAgentRun(run);
  // The caller changes its object while the change waits for its turn.
  Object.assign(run, { onBehalfOf: "mallory", agentRunId: "run-other", depth: 0 });
  await setting;
  expect(requests.find(request => request.method === "capture.setAuthor")?.params).toEqual({
    author: { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "bob", agentRunId: "run-bob", depth: 2 },
  });
  await engine.stop();
});

it("checks one root copy name with one bounded identity lookup, including binary History-only files", async () => {
  const root = await createTestScratch("duplicate-bounded-name-");
  const loopback = new VersionedLoopbackEngine();
  loopback.seedBinaryFile({workspace: WORKSPACE_ID, path: "copy.png", bytes: [0, 255], objectId: "binary-copy"});
  const requests: Request[] = [];
  const engine = capture(root, {rustEngineSessions: mockLiveSessions(loopback, requests)});
  try {
    await engine.changePathsAs(["source.png"], {operation: "duplicate", operationId: "dohc-operation:11111111-1111-4111-8111-111111111111", author: RESTORER}, async held => {
      requests.length = 0;
      expect(await held.hasPath("copy.png")).toBe(true);
      expect(requests.map(request => [request.method, request.params])).toEqual([
        ["files.resolve", {versionId: "main", targets: [{path: "copy.png"}]}],
      ]);
    }, () => []);
  } finally {await engine.stop();}
});

it.each(["pending-placement", "undone", "deleted", "renamed", "superseded", "replaced"] as const)(
  "checks the real Duplicate receipt guard when the copy is %s", async state => {
    const root = await createTestScratch("duplicate-receipt-guard-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const sessions = mockLiveSessions(loopback, requests);
    const store = createCaptureLiveStores({workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID}, sessions).store;
    const operationId = "dohc-operation:11111111-1111-4111-8111-111111111111";
    const path = "copy.md";
    const target = {workspaceId: WORKSPACE_ID, versionId: "main", path};
    await store.ensureMainVersion({workspaceId: WORKSPACE_ID});
    await store.writeTextFile({...target, text: "copied", metadata: {origin: "api", correlationId: operationId}});
    // The loopback has no operation ledger. Only its header is supplied here;
    // identity resolution and moment reads use the loopback's actual state.
    vi.spyOn(store, "readHistoryOperation").mockResolvedValue({operationId, versionId: "main", momentCount: 1, kind: "file-duplicate"});
    const engine = capture(root, {store, rustEngineSessions: sessions});
    const readReceipt = () => engine.changePathsAs(["source.md"], {operation: "duplicate", operationId, author: RESTORER}, async held => {
      requests.length = 0;
      const result = await held.readDuplicate(operationId, path);
      expect(requests.every(request => request.method !== VERSIONED_METHOD.historyPage)).toBe(true);
      const moments = requests.filter(request => request.method === VERSIONED_METHOD.momentsList);
      expect(moments.length).toBeLessThanOrEqual(1);
      if (moments.length) expect(moments[0]?.params).toMatchObject({limit: 1});
      return result;
    }, () => []);
    try {
      // Valid even before any copy exists on disk.
      expect(await readReceipt()).toEqual({path});
      if (state === "pending-placement") return;
      if (state === "undone" || state === "deleted" || state === "replaced") {
        await store.deleteTextFile({...target, metadata: {origin: state === "undone" ? "restore" : "api"}});
      }
      if (state === "renamed") {
        await store.renameTextFile({workspaceId: WORKSPACE_ID, versionId: "main", fromPath: path, toPath: "renamed.md", metadata: {origin: "api"}});
      }
      if (state === "superseded" || state === "replaced") {
        await store.writeTextFile({...target, text: "later", metadata: {origin: "api", correlationId: "later-operation"}});
      }
      expect(await readReceipt()).toBeNull();
    } finally {await engine.stop();}
  },
);

it("drops an undone pending-placement receipt through the real guard before a fresh Duplicate", async () => {
  const root = await createTestScratch("duplicate-pending-undo-receipt-");
  await writeFile(join(root, "source.md"), "Original");
  const loopback = new VersionedLoopbackEngine();
  const sessions = mockLiveSessions(loopback);
  const store = createCaptureLiveStores({workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID}, sessions).store;
  await store.ensureMainVersion({workspaceId: WORKSPACE_ID});
  // Only the operation header is supplied; the receipt guard reads actual heads and moments.
  vi.spyOn(store, "readHistoryOperation").mockImplementation(async ({operationId}) => ({operationId, versionId: "main", momentCount: 1, kind: "file-duplicate"}));
  const engine = capture(root, {store, rustEngineSessions: sessions});
  const commits: string[] = [];
  const pendingCapture: Pick<WorkspaceEngineCapture, "changePathsAs"> = {
    changePathsAs: (paths, authored, work, removed) => engine.changePathsAs(paths, authored, held => work({
      ...held,
      recordDisk: async (_path, files) => [...files],
      duplicateFile: async (_from, path) => {
        commits.push(authored.operationId!);
        await store.writeTextFile({workspaceId: WORKSPACE_ID, versionId: "main", path, text: "Original", metadata: {origin: "api", correlationId: authored.operationId}});
        const materialized = commits.length > 1;
        if (materialized) await writeFile(join(root, path), "Original");
        return {path, materialized};
      },
    }), removed),
  };
  const operation = {workspace: {workspaceId: WORKSPACE_ID, rootPath: root}, assertCurrent() {}};
  await openedLocalState(operation.workspace);
  const run = () => duplicateWorkspaceFile(operation, "source.md", RESTORER, pendingCapture);
  const directory = join(root, ".dohc/local/duplicate-pending");
  try {
    const pending = await run();
    expect(pending.materialized).toBe(false);
    expect(existsSync(join(root, pending.path))).toBe(false);
    const receipt = join(directory, (await readdir(directory))[0]!);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({operationId: pending.operationId});
    // The Rust pending-create proof exercises the Undo transaction and placement.
    // Apply its resulting head here, without ever writing the cancelled copy.
    await store.deleteTextFile({workspaceId: WORKSPACE_ID, versionId: "main", path: pending.path, metadata: {origin: "restore"}});
    const fresh = await run();
    expect(fresh.operationId).not.toBe(pending.operationId);
    expect(fresh.path).toBe(pending.path);
    expect(commits).toEqual([pending.operationId, fresh.operationId]);
    expect(await readdir(directory)).toEqual([]);
    expect(await readFile(join(root, fresh.path), "utf8")).toBe("Original");
  } finally {await engine.stop();}
});
