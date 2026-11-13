import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseOpLogPath } from "@dohc/workspace-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDesktopDatabaseIpcHandlers } from "./desktopDatabaseIpc";
import { CHANNELS } from "./channels";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import type { ShareViewFiles } from "../workspaces/shareViewFiles";
import { workspaceWriteRefusal } from "../workspaces/shareWriteGate";
import {
  createWorkspaceDatabaseAccess, createWorkspaceDatabaseWorkerOwner,
  readPreparedDatabaseSnapshot, readDatabaseSnapshotFromBytes,
  readPreparedDatabasePage, readDatabasePageFromBytes,
} from "../workspaces/workspaceDatabase";
import type { OwnedWorkspaceDatabaseReader } from "../workspaces/ownedWorkspaceFileReader";
import { createTestScratch } from "../workspaces/testTemp";
import { fakeLocalStateOpens, openedLocalState } from "../testing/preparedLocalState";
import { deleteWorkspacePathByHand } from "../workspaces/workspaceFileMoves";
import { readDeleteRecovery } from "../workspaces/workspaceDeleteRecovery";
import { readWorkspaceEnginePolicy } from "../workspaces/workspaceEnginePolicyFile";
import { databaseImportOperations, ImportToDatabaseResult } from "./bridgeContract";
import { deferred } from "../testing/deferred";
import { withExclusiveWorkspaceOperation } from "../workspaces/workspaceAssets";

class Sender {
  constructor(readonly id: number) {}
  isDestroyed() { return false; }
  once(_event: "destroyed", _listener: () => void): this { return this; }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

const undoChannel = "desktop:undo-database-import";
const channels = [CHANNELS.readWorkspaceDatabase, CHANNELS.readWorkspaceDatabasePage, CHANNELS.applyDatabaseEdit, databaseImportOperations.importToDatabase.channel, undoChannel];
const readPayload = { workspaceId: "workspace-a", relativePath: "data.sqlite" };
const pagePayload = { ...readPayload, table: "items", offset: 0 };
const editPayload = { ...readPayload, edit: { table: "items", op: "update" as const, pkColumn: "id", rowId: "1", payload: { value: "changed" } } };
const importPayload = { workspaceId: "workspace-a", sourceRelativePath: "data.csv", databaseRelativePath: "data.sqlite", tableName: "items" };
const payloadFor = (channel: string) => channel === undoChannel ? { workspaceId: "workspace-a", operationId: "unknown" } : channel === databaseImportOperations.importToDatabase.channel ? importPayload
  : channel === CHANNELS.applyDatabaseEdit ? editPayload
    : channel === CHANNELS.readWorkspaceDatabasePage ? pagePayload : readPayload;
const mount = { shareId: "share-db", label: "alice", granterEmail: null, relayUrl: "https://relay.example.com", grantedSelector: { access: "view" as const, paths: [], versionId: null } };
const sharedView = { shareId: "share-db", granterEmail: null, genericChatWritable: false, grantedSelector: { access: "view" as const, paths: [], versionId: null } };

async function harness() {
  const rootPath = realpathSync(await createTestScratch("desktop-database-ipc-"));
  const workspace: RegistryEntry = { workspaceId: "workspace-a", rootPath, kind: "personal", mode: "local-first" };
  await openedLocalState(workspace);
  const registry = createRegistryStore(join(rootPath, "registry.json"));
  registry.register(workspace);
  const authority = createWorkspaceAuthorityOwner({ findWorkspace: registry.find, canonicalizeRoot: (path) => realpathSync(path), createState: () => ({}) });
  const sender = new Sender(7);
  const lease = authority.acquire(workspace.workspaceId);
  const physical = { ...workspace, attachmentId: lease.binding.attachmentId };
  lease.release();
  const renderers = new RendererWorkspaceSessionOwner<Sender>({ retirement: {
    retireSender: () => ({ requiredForAdmission: Promise.resolve(), detachedFromAdmission: Promise.resolve() }),
    retireWorkspace: async () => undefined,
  } });
  await renderers.open(sender, physical, "document-1");
  const signals: AbortSignal[] = [];
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<
    Sender, RegistryEntry & { attachmentId: symbol }, {}, NonNullable<ReturnType<typeof renderers.current>>
  >({
    currentSession: (value) => renderers.current(value),
    withPhysicalOperation: (id, work) => authority.withOperation(id, (operation) => {
      signals.push(operation.signal);
      return work(operation);
    }),
  });
  const worker = createWorkspaceDatabaseWorkerOwner();
  cleanups.push(async () => { await worker.dispose(); await authority.close(); });
  const workerRead = vi.spyOn(worker, "readPath");
  const workerPage = vi.spyOn(worker, "readPagePath");
  const workerBytes = vi.spyOn(worker, "readBytes");
  const workerPageBytes = vi.spyOn(worker, "readPageBytes");
  const reader = vi.fn((signal?: AbortSignal): OwnedWorkspaceDatabaseReader => ({
    readPrepared: (path, source) => readPreparedDatabaseSnapshot(path, source, { worker, signal }),
    readBytes: (path, bytes) => readDatabaseSnapshotFromBytes(path, bytes, { worker, signal }),
    readPagePrepared: (path, source, table, offset) => readPreparedDatabasePage(path, source, table, offset, { worker, signal }),
    readPageBytes: (path, bytes, table, offset) => readDatabasePageFromBytes(path, bytes, table, offset, { worker, signal }),
  }));
  type Dependencies = Parameters<typeof registerDesktopDatabaseIpcHandlers<Sender, { sender: Sender }, RegistryEntry>>[0];
  const edit = vi.fn<Dependencies["editWorkspaceDatabaseInWorker"]>(createWorkspaceDatabaseAccess(worker).editWorkspaceDatabaseInWorker);
  const readOwner = vi.fn<ShareViewFiles["read"]>(async () => ({ kind: "asset", bytes: Buffer.from("id,value\n1,owner value\n"), mediaType: "text/csv" }));
  const writable = vi.fn((candidate: RegistryEntry) => {
    const refusal = workspaceWriteRefusal(registry.find(candidate.workspaceId)?.shareView);
    if (refusal) throw new Error(refusal);
  });
  const handlers = new Map<string, (event: { sender: Sender }, payload: unknown) => Promise<unknown>>();
  const deleted = vi.fn();
  const captureDeletes = vi.fn();
  const capture = { changePathsAs: vi.fn(async (_paths, _author, work) => work({
    policy: await readWorkspaceEnginePolicy(rootPath), recordDisk: async () => ["data.sqlite"], delete: captureDeletes,
  })) } as unknown as NonNullable<Parameters<typeof deleteWorkspacePathByHand>[3]["capture"]>;
  const remove = vi.fn<Dependencies["deleteDatabaseImport"]>(async (operation, path, markChanged, admit) => deleteWorkspacePathByHand(
    { workspace: operation.workspace, assertCurrent: () => operation.signal.throwIfAborted() }, path,
    { kind: "human", humanId: "local:test" },
    { capture, requestId: "undo-import", markDeleted: deleted, trashItem: async () => { throw new Error("No system trash in test"); }, markChanged, admit },
  ));
  registerDesktopDatabaseIpcHandlers<Sender, { sender: Sender }, RegistryEntry>({
    registerHandler: (channel, handler) => { if (handlers.has(channel)) throw new Error("Duplicate channel"); handlers.set(channel, handler); },
    assertTrustedSender: (event) => { if (event.sender.id === -1) throw new Error("Untrusted renderer"); },
    withRendererWorkspaceOperation, assertWritableWorkspace: writable,
    shareViewFiles: { read: readOwner }, workerDatabaseReader: reader, editWorkspaceDatabaseInWorker: edit, deleteDatabaseImport: remove,
  });
  const invoke = (channel: string, payload: unknown = payloadFor(channel), value = sender) => Promise.resolve().then(() => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("Unknown channel");
    return handler({ sender: value }, payload);
  });
  return {
    workspace, registry, authority, renderers, sender, signals, worker, reader, edit, remove, deleted, capture, captureDeletes,
    workerRead, workerPage, workerBytes, workerPageBytes, readOwner, writable, handlers, invoke,
    seed: async () => { await writeFile(join(rootPath, "data.csv"), "id,value\n1,local value\n2,next value\n"); return invoke(databaseImportOperations.importToDatabase.channel); },
    switchWorkspace: () => renderers.open(sender, { ...physical, workspaceId: "workspace-b", attachmentId: Symbol("other") }, "document-1"),
  };
}

describe("desktop database IPC composition", () => {
  it("registers read, page, edit, and import in order and checks trust before parsing", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual(channels);
    for (const channel of channels) await expect(h.invoke(channel, null, new Sender(-1))).rejects.toThrow("Untrusted renderer");
    expect(h.signals).toEqual([]);
    expect(h.reader).not.toHaveBeenCalled();
    expect(h.edit).not.toHaveBeenCalled();
    expect(h.readOwner).not.toHaveBeenCalled();
  });

  it("rejects another renderer before database edit work", async () => {
    const channel = CHANNELS.applyDatabaseEdit;
    const h = await harness();
    await expect(h.invoke(channel, payloadFor(channel), new Sender(8))).rejects.toThrow("changed workspaces");
    expect(h.reader).not.toHaveBeenCalled();
    expect(h.edit).not.toHaveBeenCalled();
    expect(h.readOwner).not.toHaveBeenCalled();
    expect(h.writable).not.toHaveBeenCalled();
  });

  it("edits the admitted database and records local-user metadata with the supplied clock and generated ID", async () => {
    const h = await harness();
    await h.seed();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await expect(h.invoke(CHANNELS.applyDatabaseEdit, { ...editPayload, rootPath: "C:/untrusted", author: { kind: "agent" } })).resolves.toMatchObject({ path: "data.sqlite", table: "items", version: 1, page: { rows: [expect.objectContaining({ value: "changed" }), expect.objectContaining({ value: "next value" })] } });
    expect(h.edit).toHaveBeenCalledTimes(1);
    expect(h.edit.mock.calls[0]?.[0]).toEqual({ workspace: expect.objectContaining({ workspaceId: h.workspace.workspaceId, rootPath: h.workspace.rootPath }), relativePath: "data.sqlite", edit: editPayload.edit, author: { kind: "user", userId: "local" }, nowMs: 1_700_000_000_000, operationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), signal: h.signals[1] });
    const log = (await readFile(join(h.workspace.rootPath, databaseOpLogPath("data.sqlite")), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(log).toEqual([expect.objectContaining({ operationId: h.edit.mock.calls[0]![0].operationId, appliedAt: 1_700_000_000_000, author: { kind: "user", userId: "local" }, payload: { value: "changed" } })]);
  });

  it("refuses shared-view writes before database edit work", async () => {
    const channel = CHANNELS.applyDatabaseEdit;
    const h = await harness();
    h.registry.setShareView(h.workspace.workspaceId, sharedView);
    await expect(h.invoke(channel)).rejects.toThrow("shared view");
    expect(h.writable).toHaveBeenCalledTimes(1);
    expect(h.edit).not.toHaveBeenCalled();
    expect(h.readOwner).not.toHaveBeenCalled();
    expect(existsSync(join(h.workspace.rootPath, "data.sqlite"))).toBe(false);
  });

  it("imports from the mount owner rather than its changed projection", async () => {
    const h = await harness();
    h.registry.setShareMounts(h.workspace.workspaceId, [mount]);
    await mkdir(join(h.workspace.rootPath, "shared-with-me", "alice"), { recursive: true });
    await writeFile(join(h.workspace.rootPath, "shared-with-me", "alice", "data.csv"), "id,value\n1,projection value\n");
    await expect(h.invoke(databaseImportOperations.importToDatabase.channel, { ...importPayload, sourceRelativePath: "shared-with-me/alice/data.csv" })).resolves.toMatchObject({ rowCount: 1 });
    expect(h.readOwner).toHaveBeenCalledWith({ kind: "mount", workspaceId: "workspace-a", shareId: "share-db" }, { kind: "asset", path: "data.csv" });
    await expect(h.invoke(CHANNELS.readWorkspaceDatabase)).resolves.toMatchObject({ tables: [{ rows: [expect.objectContaining({ value: "owner value" })] }] });
  });

  it("refuses an import from an unowned leftover projection", async () => {
    const h = await harness();
    h.registry.setShareMounts(h.workspace.workspaceId, []);
    await mkdir(join(h.workspace.rootPath, "shared-with-me", "alice"), { recursive: true });
    await writeFile(join(h.workspace.rootPath, "shared-with-me", "alice", "data.csv"), "id,value\n1,stale\n");
    await expect(h.invoke(databaseImportOperations.importToDatabase.channel, { ...importPayload, sourceRelativePath: "shared-with-me/alice/data.csv" })).rejects.toThrow(/no share owns it/i);
    expect(h.readOwner).not.toHaveBeenCalled();
    expect(existsSync(join(h.workspace.rootPath, "data.sqlite"))).toBe(false);
  });

  it("rejects an import escape in sourceRelativePath", async () => {
    const h = await harness();
    await writeFile(join(h.workspace.rootPath, "data.csv"), "id,value\n1,local\n");
    await expect(h.invoke(databaseImportOperations.importToDatabase.channel, { ...importPayload, sourceRelativePath: "../escape.csv" })).rejects.toThrow();
    expect(existsSync(join(h.workspace.rootPath, "data.sqlite"))).toBe(false);
  });

  it("refuses to replace an existing imported database", async () => {
    const h = await harness();
    await h.seed();
    const before = await readFile(join(h.workspace.rootPath, "data.sqlite"));
    await expect(h.invoke(databaseImportOperations.importToDatabase.channel)).rejects.toThrow();
    expect(await readFile(join(h.workspace.rootPath, "data.sqlite"))).toEqual(before);
  });

  it("rejects a held import response after renderer retirement", async () => {
    const h = await harness();
    h.registry.setShareMounts(h.workspace.workspaceId, [mount]);
    const reached = deferred<void>();
    const release = deferred<void>();
    h.readOwner.mockImplementation(async () => { reached.resolve(); await release.promise; return { kind: "asset", bytes: Buffer.from("id,value\n1,owner\n"), mediaType: "text/csv" }; });
    const pending = h.invoke(databaseImportOperations.importToDatabase.channel, { ...importPayload, sourceRelativePath: "shared-with-me/alice/data.csv" });
    const rejected = expect(pending).rejects.toThrow();
    try {
      await reached.promise;
      await h.switchWorkspace();
    } finally {
      release.resolve();
      await rejected;
    }
    expect(h.readOwner).toHaveBeenCalledTimes(1);
  });
});

// Right after launch the engine may still be preparing `.dohc/local`, which
// holds an edit's operation counter.
describe("a database edit during the engine's open", () => {
  it("waits for the open outside the workspace lease, so other workspace operations go on", async () => {
    const h = await harness();
    await h.seed();
    const opens = fakeLocalStateOpens();
    const opening = opens.start(h.workspace);
    const pending = h.invoke(CHANNELS.applyDatabaseEdit);
    try {
      await vi.waitFor(() => expect(opens.waits()).toBe(1));
      let other = false;
      void withExclusiveWorkspaceOperation(h.workspace.rootPath, async () => { other = true; });
      await vi.waitFor(() => expect(other).toBe(true));
      expect(h.edit).not.toHaveBeenCalled();
    } finally { await opening.finish(); }
    await expect(pending).resolves.toMatchObject({ version: 1 });
  });
});

describe("database import Undo", () => {
  const seed = async (h: Awaited<ReturnType<typeof harness>>) => ImportToDatabaseResult.parse(await h.seed());
  const undo = (h: Awaited<ReturnType<typeof harness>>, operationId: string) =>
    h.invoke(undoChannel, { workspaceId: h.workspace.workspaceId, operationId, relativePath: "data.csv" });

  it("deletes unchanged bytes through trash, records History, and preserves delete recovery", async () => {
    const h = await harness(), result = await seed(h);
    const bytes = await readFile(join(h.workspace.rootPath, result.path));
    const answer = await undo(h, result.operationId);
    expect(existsSync(join(h.workspace.rootPath, result.path))).toBe(false);
    expect(existsSync(join(h.workspace.rootPath, "data.csv"))).toBe(true);
    expect(h.deleted).toHaveBeenCalledWith(result.path);
    expect(h.captureDeletes).toHaveBeenCalledWith(result.path);
    expect(h.capture.changePathsAs).toHaveBeenCalledWith([result.path],
      expect.objectContaining({ operation: "delete", author: { kind: "human", humanId: "local:test" } }),
      expect.any(Function), expect.any(Function));
    const deletion = answer as { operationId: string; trashed: boolean };
    expect(deletion.trashed).toBe(false);
    const recovery = await readDeleteRecovery(h.workspace.rootPath, deletion.operationId);
    expect(recovery).toMatchObject({ base: result.path, tracked: true });
    expect(await readFile(join(h.workspace.rootPath, ".dohc", "local", "trash", recovery!.staged!))).toEqual(bytes);
    await expect(undo(h, result.operationId)).rejects.toThrow("Cannot undo this import. Undo is no longer available. Delete the database yourself if you don't want it.");
  });

  it("keeps a file whose sha256 changed", async () => {
    const h = await harness(), result = await seed(h);
    const path = join(h.workspace.rootPath, result.path), bytes = await readFile(path);
    bytes[100] = bytes[100]! ^ 1;
    await writeFile(path, bytes);
    const changed = await readFile(path);
    await expect(undo(h, result.operationId)).rejects.toThrow("Cannot undo this import. data.sqlite changed after the import. Keep it or delete it yourself.");
    expect(await readFile(path)).toEqual(changed);
  });

  it("keeps Undo available when a sidecar appears during delete preparation", async () => {
    const h = await harness(), result = await seed(h);
    const sidecar = join(h.workspace.rootPath, result.path + "-wal");
    const remove = h.remove.getMockImplementation()!;
    h.remove.mockImplementationOnce(async (...args) => {
      await writeFile(sidecar, "");
      return remove(...args);
    });
    await expect(undo(h, result.operationId)).rejects.toThrow("Close programs using the database, then try again.");
    expect(existsSync(join(h.workspace.rootPath, result.path))).toBe(true);
    expect(h.deleted).not.toHaveBeenCalled();
    await rm(sidecar);
    await expect(undo(h, result.operationId)).resolves.toBeDefined();
    expect(existsSync(join(h.workspace.rootPath, result.path))).toBe(false);
  });

  it("refuses an alias substituted for the imported file", async () => {
    const h = await harness(), result = await seed(h);
    const bytes = await readFile(join(h.workspace.rootPath, result.path));
    await rm(join(h.workspace.rootPath, result.path));
    await writeFile(join(h.workspace.rootPath, "other.sqlite"), bytes);
    await symlink(join(h.workspace.rootPath, "other.sqlite"), join(h.workspace.rootPath, result.path));
    await expect(undo(h, result.operationId)).rejects.toThrow("Cannot undo this import. data.sqlite is no longer the imported file. Keep it or delete it yourself.");
  });
});

describe("database import Undo isolation", () => {
  it("refuses an id in another admitted workspace and keeps the original Undo available", async () => {
    const h = await harness();
    const result = ImportToDatabaseResult.parse(await h.seed());
    const otherRoot = await createTestScratch("undo-other-");
    h.registry.register({ workspaceId: "workspace-b", rootPath: otherRoot, kind: "personal", mode: "local-first" });
    const open = async (workspaceId: string) => {
      const lease = h.authority.acquire(workspaceId);
      try {
        await h.renderers.open(h.sender, { ...h.registry.find(workspaceId)!, attachmentId: lease.binding.attachmentId }, "document-1");
      } finally { lease.release(); }
    };
    await open("workspace-b");
    await expect(h.invoke(undoChannel, { workspaceId: "workspace-b", operationId: result.operationId }))
      .rejects.toThrow("Cannot undo this import in another workspace. Open the workspace where you imported it.");
    expect(h.remove).not.toHaveBeenCalled();
    await open("workspace-a");
    await expect(h.invoke(undoChannel, { workspaceId: "workspace-a", operationId: result.operationId })).resolves.toBeDefined();
  });

  it("consumes the id even when History fails after trashing, so a replacement survives retry", async () => {
    const h = await harness();
    const result = ImportToDatabaseResult.parse(await h.seed());
    h.captureDeletes.mockRejectedValueOnce(new Error("History refused"));
    const input = { workspaceId: "workspace-a", operationId: result.operationId };
    await expect(h.invoke(undoChannel, input)).rejects.toThrow("History refused");
    await writeFile(join(h.workspace.rootPath, result.path), "replacement");
    await expect(h.invoke(undoChannel, input)).rejects.toThrow("Cannot undo this import. Undo is no longer available. Delete the database yourself if you don't want it.");
    expect(await readFile(join(h.workspace.rootPath, result.path), "utf8")).toBe("replacement");
    expect(h.remove).toHaveBeenCalledTimes(1);
  });
});
