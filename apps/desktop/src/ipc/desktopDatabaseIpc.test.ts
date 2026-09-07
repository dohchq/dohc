import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  applyDatabaseEdit, createWorkspaceDatabaseWorkerOwner,
  readPreparedDatabaseSnapshot, readDatabaseSnapshotFromBytes,
  readPreparedDatabasePage, readDatabasePageFromBytes,
} from "../workspaces/workspaceDatabase";
import type { OwnedWorkspaceDatabaseReader } from "../workspaces/ownedWorkspaceFileReader";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";

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

const channels = [CHANNELS.readWorkspaceDatabase, CHANNELS.readWorkspaceDatabasePage, CHANNELS.applyDatabaseEdit, CHANNELS.importToDatabase];
const readPayload = { workspaceId: "workspace-a", relativePath: "data.sqlite" };
const pagePayload = { ...readPayload, table: "items", offset: 0 };
const editPayload = { ...readPayload, edit: { table: "items", op: "update" as const, pkColumn: "id", rowId: "1", payload: { value: "changed" } } };
const importPayload = { workspaceId: "workspace-a", sourceRelativePath: "data.csv", databaseRelativePath: "data.sqlite", tableName: "items" };
const payloadFor = (channel: string) => channel === CHANNELS.importToDatabase ? importPayload
  : channel === CHANNELS.applyDatabaseEdit ? editPayload
    : channel === CHANNELS.readWorkspaceDatabasePage ? pagePayload : readPayload;
const mount = { shareId: "share-db", label: "alice", granterEmail: null, relayUrl: "https://relay.example.com", grantedSelector: { access: "view" as const, paths: [], versionId: null } };
const sharedView = { shareId: "share-db", granterEmail: null, genericChatWritable: false, grantedSelector: { access: "view" as const, paths: [], versionId: null } };

async function harness() {
  const rootPath = realpathSync(await createTestScratch("desktop-database-ipc-"));
  const workspace: RegistryEntry = { workspaceId: "workspace-a", rootPath, kind: "personal", mode: "local-first" };
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
  const edit = vi.fn<Dependencies["editWorkspaceDatabaseInWorker"]>((input) => applyDatabaseEdit(
    input.rootPath, input.relativePath, input.edit, input.author, input.nowMs,
    { worker, signal: input.signal, createId: () => input.operationId! },
  ));
  const readOwner = vi.fn<ShareViewFiles["read"]>(async () => ({ kind: "asset", bytes: Buffer.from("id,value\n1,owner value\n"), mediaType: "text/csv" }));
  const writable = vi.fn((candidate: RegistryEntry) => {
    const refusal = workspaceWriteRefusal(registry.find(candidate.workspaceId)?.shareView);
    if (refusal) throw new Error(refusal);
  });
  const handlers = new Map<string, (event: { sender: Sender }, payload: unknown) => Promise<unknown>>();
  registerDesktopDatabaseIpcHandlers<Sender, { sender: Sender }, RegistryEntry>({
    registerHandler: (channel, handler) => { if (handlers.has(channel)) throw new Error("Duplicate channel"); handlers.set(channel, handler); },
    assertTrustedSender: (event) => { if (event.sender.id === -1) throw new Error("Untrusted renderer"); },
    withRendererWorkspaceOperation, assertWritableWorkspace: writable,
    shareViewFiles: { read: readOwner }, workerDatabaseReader: reader, editWorkspaceDatabaseInWorker: edit,
  });
  const invoke = (channel: string, payload: unknown = payloadFor(channel), value = sender) => Promise.resolve().then(() => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("Unknown channel");
    return handler({ sender: value }, payload);
  });
  return {
    workspace, registry, authority, renderers, sender, signals, worker, reader, edit,
    workerRead, workerPage, workerBytes, workerPageBytes, readOwner, writable, handlers, invoke,
    seed: async () => { await writeFile(join(rootPath, "data.csv"), "id,value\n1,local value\n2,next value\n"); return invoke(CHANNELS.importToDatabase); },
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

  it("rejects malformed payloads before workspace admission", async () => {
    const h = await harness();
    for (const channel of channels) await expect(h.invoke(channel, null)).rejects.toThrow();
    expect(h.signals).toEqual([]);
    expect(h.writable).not.toHaveBeenCalled();
  });

  it.each(channels)("rejects another renderer before %s work", async (channel) => {
    const h = await harness();
    await expect(h.invoke(channel, payloadFor(channel), new Sender(8))).rejects.toThrow("changed workspaces");
    expect(h.reader).not.toHaveBeenCalled();
    expect(h.edit).not.toHaveBeenCalled();
    expect(h.readOwner).not.toHaveBeenCalled();
    expect(h.writable).not.toHaveBeenCalled();
  });

  it("imports local data and reads its snapshot and page through the worker under the admitted signal", async () => {
    const h = await harness();
    await expect(h.seed()).resolves.toEqual({ path: "data.sqlite", tableName: "items", rowCount: 2 });
    await expect(h.invoke(CHANNELS.readWorkspaceDatabase, { ...readPayload, rootPath: "C:/untrusted" })).resolves.toMatchObject({ tables: [{ name: "items", rows: [expect.objectContaining({ value: "local value" }), expect.objectContaining({ value: "next value" })] }] });
    await expect(h.invoke(CHANNELS.readWorkspaceDatabasePage, { ...pagePayload, offset: 1 })).resolves.toMatchObject({ table: "items", offset: 1, rows: [expect.objectContaining({ value: "next value" })] });
    expect(h.workerRead).toHaveBeenCalledWith({ absolutePath: join(h.workspace.rootPath, "data.sqlite"), path: "data.sqlite", signal: h.signals[1] });
    expect(h.workerPage).toHaveBeenCalledWith({ absolutePath: join(h.workspace.rootPath, "data.sqlite"), path: "data.sqlite", table: "items", offset: 1, signal: h.signals[2] });
    expect(h.reader.mock.calls.map(([signal]) => signal)).toEqual(h.signals.slice(1));
    expect(h.readOwner).not.toHaveBeenCalled();
  });

  it("edits the admitted database and records local-user metadata with the supplied clock and generated ID", async () => {
    const h = await harness();
    await h.seed();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await expect(h.invoke(CHANNELS.applyDatabaseEdit, { ...editPayload, rootPath: "C:/untrusted", author: { kind: "agent" } })).resolves.toMatchObject({ path: "data.sqlite", table: "items", version: 1, page: { rows: [expect.objectContaining({ value: "changed" }), expect.objectContaining({ value: "next value" })] } });
    expect(h.edit).toHaveBeenCalledTimes(1);
    expect(h.edit.mock.calls[0]?.[0]).toEqual({ rootPath: h.workspace.rootPath, relativePath: "data.sqlite", edit: editPayload.edit, author: { kind: "user", userId: "local" }, nowMs: 1_700_000_000_000, operationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), signal: h.signals[1] });
    const log = (await readFile(join(h.workspace.rootPath, databaseOpLogPath("data.sqlite")), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(log).toEqual([expect.objectContaining({ operationId: h.edit.mock.calls[0]![0].operationId, appliedAt: 1_700_000_000_000, author: { kind: "user", userId: "local" }, payload: { value: "changed" } })]);
  });

  it.each([CHANNELS.applyDatabaseEdit, CHANNELS.importToDatabase])("refuses shared-view writes before %s work", async (channel) => {
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
    await expect(h.invoke(CHANNELS.importToDatabase, { ...importPayload, sourceRelativePath: "shared-with-me/alice/data.csv" })).resolves.toMatchObject({ rowCount: 1 });
    expect(h.readOwner).toHaveBeenCalledWith({ kind: "mount", workspaceId: "workspace-a", shareId: "share-db" }, { kind: "asset", path: "data.csv" });
    await expect(h.invoke(CHANNELS.readWorkspaceDatabase)).resolves.toMatchObject({ tables: [{ rows: [expect.objectContaining({ value: "owner value" })] }] });
  });

  it("reads standalone share database bytes through the same worker signal", async () => {
    const h = await harness();
    await h.seed();
    const bytes = await readFile(join(h.workspace.rootPath, "data.sqlite"));
    h.registry.setShareView(h.workspace.workspaceId, sharedView);
    h.readOwner.mockResolvedValue({ kind: "asset", bytes, mediaType: "application/vnd.sqlite3" });
    await expect(h.invoke(CHANNELS.readWorkspaceDatabase)).resolves.toMatchObject({ tables: [{ name: "items" }] });
    await expect(h.invoke(CHANNELS.readWorkspaceDatabasePage)).resolves.toMatchObject({ table: "items", offset: 0 });
    expect(h.readOwner).toHaveBeenCalledWith({ kind: "standalone", workspaceId: "workspace-a" }, { kind: "asset", path: "data.sqlite" });
    expect(h.workerBytes).toHaveBeenCalledWith({ bytes, path: "data.sqlite", signal: h.signals[1] });
    expect(h.workerPageBytes).toHaveBeenCalledWith({ bytes, path: "data.sqlite", table: "items", offset: 0, signal: h.signals[2] });
    expect(h.workerRead).not.toHaveBeenCalled();
  });

  it("refuses an import from an unowned leftover projection", async () => {
    const h = await harness();
    h.registry.setShareMounts(h.workspace.workspaceId, []);
    await mkdir(join(h.workspace.rootPath, "shared-with-me", "alice"), { recursive: true });
    await writeFile(join(h.workspace.rootPath, "shared-with-me", "alice", "data.csv"), "id,value\n1,stale\n");
    await expect(h.invoke(CHANNELS.importToDatabase, { ...importPayload, sourceRelativePath: "shared-with-me/alice/data.csv" })).rejects.toThrow(/no share owns it/i);
    expect(h.readOwner).not.toHaveBeenCalled();
    expect(existsSync(join(h.workspace.rootPath, "data.sqlite"))).toBe(false);
  });

  it.each(["sourceRelativePath", "databaseRelativePath"] as const)("rejects an import escape in %s", async (field) => {
    const h = await harness();
    await writeFile(join(h.workspace.rootPath, "data.csv"), "id,value\n1,local\n");
    await expect(h.invoke(CHANNELS.importToDatabase, { ...importPayload, [field]: "../escape.csv" })).rejects.toThrow();
    expect(existsSync(join(h.workspace.rootPath, "data.sqlite"))).toBe(false);
  });

  it("refuses to replace an existing imported database", async () => {
    const h = await harness();
    await h.seed();
    const before = await readFile(join(h.workspace.rootPath, "data.sqlite"));
    await expect(h.invoke(CHANNELS.importToDatabase)).rejects.toThrow();
    expect(await readFile(join(h.workspace.rootPath, "data.sqlite"))).toEqual(before);
  });

  it.each([CHANNELS.readWorkspaceDatabase, CHANNELS.readWorkspaceDatabasePage])("rejects a local path escape before %s reaches the worker", async (channel) => {
    const h = await harness();
    await expect(h.invoke(channel, { ...pagePayload, relativePath: "../outside.sqlite" })).rejects.toThrow();
    expect(h.workerRead).not.toHaveBeenCalled();
    expect(h.workerPage).not.toHaveBeenCalled();
  });

  it.each(["renderer", "attachment"] as const)("rejects a held import response after %s retirement", async (retirement) => {
    const h = await harness();
    h.registry.setShareMounts(h.workspace.workspaceId, [mount]);
    const reached = deferred<void>();
    const release = deferred<void>();
    h.readOwner.mockImplementation(async () => { reached.resolve(); await release.promise; return { kind: "asset", bytes: Buffer.from("id,value\n1,owner\n"), mediaType: "text/csv" }; });
    const pending = h.invoke(CHANNELS.importToDatabase, { ...importPayload, sourceRelativePath: "shared-with-me/alice/data.csv" });
    const rejected = expect(pending).rejects.toThrow();
    let drained: Promise<void> | undefined;
    try {
      await reached.promise;
      if (retirement === "renderer") await h.switchWorkspace();
      else drained = h.authority.invalidate("workspace-a");
    } finally {
      release.resolve();
      await Promise.all([rejected, drained]);
    }
    expect(h.readOwner).toHaveBeenCalledTimes(1);
  });

  it.each([CHANNELS.readWorkspaceDatabase, CHANNELS.applyDatabaseEdit])("forwards physical retirement to the held %s worker operation", async (channel) => {
    const h = await harness();
    await h.seed();
    const reached = deferred<void>();
    const release = deferred<void>();
    if (channel === CHANNELS.readWorkspaceDatabase) h.workerRead.mockImplementation(async () => { reached.resolve(); await release.promise; return { path: "data.sqlite", tables: [] }; });
    else h.edit.mockImplementation(async () => { reached.resolve(); await release.promise; return { path: "data.sqlite", table: "items", page: { offset: 0, rows: [], nextOffset: null }, version: 1 }; });
    const pending = h.invoke(channel);
    const rejected = expect(pending).rejects.toThrow();
    let drained: Promise<void> | undefined;
    try {
      await reached.promise;
      const forwarded = channel === CHANNELS.readWorkspaceDatabase ? h.workerRead.mock.calls[0]![0].signal : h.edit.mock.calls[0]![0].signal;
      expect(forwarded).toBe(h.signals[1]);
      expect(forwarded?.aborted).toBe(false);
      drained = h.authority.invalidate("workspace-a");
      expect(forwarded?.aborted).toBe(true);
    } finally {
      release.resolve();
      await Promise.all([rejected, drained]);
    }
  });
});
