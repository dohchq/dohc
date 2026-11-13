import { createEngineFileResolver, workspaceFileRef } from "./resolveEngineFiles";
import type { WorkspaceFileRef } from "@dohc/workspace-contracts/workspace-ref";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { lstat, mkdir, readFile, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { DaemonRefusalError, VERSIONED_METHOD, type Request } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "./testTemp";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { createWorkspaceEngineCapture, type AuthoredPathChanges, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { deleteWorkspacePathByHand, moveWorkspacePathByHand, prepareDeleteWorkspacePathAs, prepareMoveWorkspacePathAs, putBackStoppedMoves, type PathChangeOptions } from "./workspaceFileMoves";
import { openedLocalState } from "../testing/preparedLocalState";
import { readLocalStateFrom } from "./workspaceLocalState";
import { randomUUID } from "node:crypto";
import { saveRecoveryRecord } from "./workspaceDeleteRecovery";
import { moveIntoWorkspaceTrash } from "./workspaceFiles";
import { resumeWorkspaceLinkRewrites } from "./workspaceLinkRewrites";

// Filesystem refusals a test switches on for chosen paths.
const faults = vi.hoisted(() => ({} as {
  unlink?: (path: string) => boolean | Promise<boolean>;
  readdir?: (path: string) => boolean;
  // Runs just before a hard link is made.
  link?: (from: string, to: string) => Promise<void>;
  // Sees every call that would change the disk.
  mutate?: (syscall: string, path: string) => void;
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const refused = (syscall: string, path: string) =>
    Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${path}'`), { code: "EPERM", syscall, path });
  const seen = <Args extends unknown[], Result>(syscall: string, call: (...args: Args) => Result) =>
    (...args: Args): Result => { faults.mutate?.(syscall, String(args[0])); return call(...args); };
  return {
    ...actual,
    unlink: (async (path: Parameters<typeof actual.unlink>[0]) => {
      faults.mutate?.("unlink", String(path));
      if (await faults.unlink?.(String(path))) throw refused("unlink", String(path));
      return await actual.unlink(path);
    }) as typeof actual.unlink,
    link: (async (from: Parameters<typeof actual.link>[0], to: Parameters<typeof actual.link>[1]) => {
      faults.mutate?.("link", String(from));
      await faults.link?.(String(from), String(to));
      return await actual.link(from, to);
    }) as typeof actual.link,
    rename: seen("rename", actual.rename) as typeof actual.rename,
    mkdir: seen("mkdir", actual.mkdir) as typeof actual.mkdir,
    rmdir: seen("rmdir", actual.rmdir) as typeof actual.rmdir,
    copyFile: seen("copyFile", actual.copyFile) as typeof actual.copyFile,
    readdir: ((...args: Parameters<typeof actual.readdir>) => faults.readdir?.(String(args[0]))
      ? Promise.reject(refused("scandir", String(args[0])))
      : actual.readdir(...args)) as typeof actual.readdir,
  };
});

const named = { kind: "agent", agentId: "Client name", onBehalfOf: "person-local" } as const;
// The person desktop main read: signed out, this installation.
const person = { kind: "human", humanId: "local:installation" } as const;
const unnamed = { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local" } as const;

async function write(root: string, path: string, contents: string | Uint8Array) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const refusedFor = (method: string, path: string) => (request: Request) => {
  if (request.method === method && JSON.stringify(request.params).includes(`"${path}"`)) throw new Error(`History refused ${path}.`);
};

async function fixture(options: {
  nativeMove?: boolean;
  beforeRequest?: (request: Request) => void | Promise<void>;
  afterRequest?: (request: Request) => void | Promise<void>;
} = {}) {
  const rootPath = await createTestScratch("dohc-file-moves-");
  const systemTrash = await createTestScratch("dohc-system-trash-");
  await mkdir(join(rootPath, ".dohc"));
  const workspaceId = "file-moves-test";
  const operation = { workspace: { workspaceId, rootPath, attachmentId: Symbol(), readOnly: false, shareView: undefined as unknown },
    state: {}, signal: new AbortController().signal, assertCurrent: vi.fn() };
  await openedLocalState(operation.workspace);
  let capture: WorkspaceEngineCapture | undefined;
  const attachmentId = Symbol("attachment");
  const sessions = mockDaemonSessions({ rootPath, workspaceId, loopback: new VersionedLoopbackEngine(), nativeMove: options.nativeMove ?? true,
    ...(options.beforeRequest ? { beforeRequest: options.beforeRequest } : {}),
    ...(options.afterRequest ? { afterRequest: options.afterRequest } : {}) });
  const engine = () => {
    capture ??= createWorkspaceEngineCapture({ workspaceId, rootPath, attachmentId, rustEngineSessions: sessions });
    return capture;
  };
  const trashItem = vi.fn(async (absolute: string) => { await rename(absolute, join(systemTrash, basename(absolute))); });
  const markDeleted = vi.fn();
  const pathOptions = (): PathChangeOptions => ({ capture: engine(), requestId: "request", trashItem, markDeleted });
  // The watcher's pass over whatever the disk holds now.
  const settle = async () => { await engine().flush(); };
  const rows = async () => (await engine().listMoments()).moments;
  const start = async () => {
    engine().start();
    await settle();
    return new Set((await rows()).map(row => row.id));
  };
  const added = async (seen: ReadonlySet<string>) => (await rows()).filter(row => !seen.has(row.id))
    .map(row => ({ operation: row.operation, path: row.path, agentId: row.authors?.find(author => author.kind === "agent")?.agentId }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.operation.localeCompare(b.operation));
  const workspaceTrash = async () => existsSync(join(rootPath, ".dohc/local/trash")) ? (await readdir(join(rootPath, ".dohc/local/trash"))).filter(name => !/^(?:delete|move)-[a-f0-9]{64}\.json$/.test(name)) : [];
  // The system trash keeps the workspace trash's entry name, which ends with the file's own name.
  const systemTrashed = async (name: string) => {
    const entry = (await readdir(systemTrash)).find(entry => entry.endsWith(`-${name}`));
    if (entry === undefined) throw new Error(`${name} is not in the system trash`);
    return join(systemTrash, entry);
  };
  const resolveRefs = createEngineFileResolver<{ workspaceId: string; rootPath: string; attachmentId: symbol }>((workspace, work) =>
    sessions.run(workspace, binding => work(new VersionedLiveAdapter(binding.client, binding.workspace, { workspaceId }))));
  const reference = async (path: string) => {
    const objectId = await engine().fileObjectIdForPath(path);
    if (!objectId) throw new Error("Fixture path is untracked: " + path);
    return workspaceFileRef(workspaceId, objectId);
  };
  return { reference, resolve: (refs: WorkspaceFileRef[]) => resolveRefs({ workspaceId, rootPath, attachmentId }, refs), rootPath, systemTrash, systemTrashed, operation, engine, trashItem, markDeleted, settle, rows, start, added, workspaceTrash,
    move: (fromPath: string, toPath: string, by: MomentWriteAuthor = named, overwrite?: boolean) =>
      prepareMoveWorkspacePathAs(operation, { fromPath, toPath, ...(overwrite ? { overwrite } : {}) }, by, pathOptions()).then(finish => finish()),
    moveByHand: (fromPath: string, toPath: string) => moveWorkspacePathByHand(operation, { fromPath, toPath }, person, { ...pathOptions(), capture: engine() }),
    remove: (path: string, by: MomentWriteAuthor = named) => prepareDeleteWorkspacePathAs(operation, path, by, pathOptions()).then(finish => finish()),
    removeByHand: (path: string, capture: PathChangeOptions["capture"] | null = engine()) =>
      deleteWorkspacePathByHand(operation, path, person, { capture, requestId: "request", trashItem, markDeleted }) };
}

describe("agent moves and deletes", () => {
  it("stages the source when the filesystem refuses an exclusive rename", async () => {
    const requests: string[] = [];
    const f = await fixture({ nativeMove: false, beforeRequest: request => { requests.push(request.method); } });
    await write(f.rootPath, "source.txt", "original");
    const seen = await f.start();
    const links: string[] = [];
    faults.link = async (from, to) => {
      if (to !== join(f.rootPath, "target.txt")) return;
      links.push(from);
      expect(dirname(from)).toBe(join(f.rootPath, ".dohc/local/trash"));
      expect(existsSync(join(f.rootPath, "source.txt"))).toBe(false);
      // A save at the vacated source name must survive placement.
      await write(f.rootPath, "source.txt", "new save");
    };
    try {
      expect(await f.move("source.txt", "target.txt")).toMatchObject({ ok: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/), fromPath: "source.txt", toPath: "target.txt" });
      expect(requests).toContain("capture.moveFile");
      expect(links).toHaveLength(1);
      expect(await readFile(join(f.rootPath, "target.txt"), "utf8")).toBe("original");
      expect(await readFile(join(f.rootPath, "source.txt"), "utf8")).toBe("new save");
      expect(await f.workspaceTrash()).toEqual([]);
      await f.settle();
      expect(await f.added(seen)).toContainEqual({ operation: "rename", path: "target.txt", agentId: "Client name" });
    } finally {
      delete faults.link;
      await f.engine().stop();
    }
  });

  it("records one row per file under the agent, named or not, and none for a person's own move", async () => {
    const f = await fixture();
    await write(f.rootPath, "a.txt", "a");
    await write(f.rootPath, "notes/b.txt", "b");
    await write(f.rootPath, "notes/c.md", "# c\n");
    await write(f.rootPath, "photo.bin", new Uint8Array([0, 1, 2, 255]));
    const seen = await f.start();

    // A person's move outside dohc reaches History through the watcher, with no author.
    await rename(join(f.rootPath, "a.txt"), join(f.rootPath, "person.txt"));
    await f.settle();
    const outside = (await f.rows()).filter(row => !seen.has(row.id));
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every(row => row.authors === undefined)).toBe(true);
    for (const row of outside) seen.add(row.id);

    expect(await f.move("person.txt", "agent.txt")).toMatchObject({ ok: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/), fromPath: "person.txt", toPath: "agent.txt" });
    expect(await f.move("notes", "archive/notes", unnamed)).toMatchObject({ ok: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/), fromPath: "notes", toPath: "archive/notes" });
    expect(await f.remove("photo.bin")).toMatchObject({ ok: true, path: "photo.bin", trashed: true });
    await f.settle();

    expect(await f.added(seen)).toEqual([
      { operation: "rename", path: "agent.txt", agentId: "Client name" },
      { operation: "rename", path: "archive/notes/b.txt", agentId: "dohc-mcp" },
      { operation: "rename", path: "archive/notes/c.md", agentId: "dohc-mcp" },
      { operation: "delete", path: "photo.bin", agentId: "Client name" },
    ]);
    expect(await readFile(join(f.rootPath, "archive/notes/c.md"), "utf8")).toBe("# c\n");
    expect(existsSync(join(f.rootPath, "notes"))).toBe(false);
    expect(await readFile(await f.systemTrashed("photo.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await f.workspaceTrash()).toEqual([]);
    expect(f.markDeleted).toHaveBeenCalledWith("photo.bin");
    await f.engine().stop();
  });

  it.each([
    ["files.toml excludes the folder", ".dohc/files.toml", '[[rule]]\npath = "dir/**"\ntracked = false\n'],
    ["a secret file appears in it", "dir/.env", "TOKEN=1"],
    ["a reserved folder appears in it", "dir/.git/HEAD", "ref"],
  ])("refuses once capture is held when %s during the queue", async (_case, path, contents) => {
    const f = await fixture({ beforeRequest: async request => {
      if (request.method === "capture.hold") await write(f.rootPath, path, contents);
    } });
    await write(f.rootPath, "dir/a.txt", "a");
    const seen = await f.start();
    expect(await f.remove("dir")).toMatchObject({ ok: false, deleted: [] });
    expect(await f.move("dir", "moved")).toMatchObject({ ok: false });
    await f.settle();
    expect(await readFile(join(f.rootPath, "dir/a.txt"), "utf8")).toBe("a");
    expect((await f.added(seen)).filter(row => row.agentId !== undefined)).toEqual([]);
    await f.engine().stop();
  });

  it("stops a folder delete at the file History refuses, puts the rest back, and names the files deleted", async () => {
    const f = await fixture({ beforeRequest: refusedFor(VERSIONED_METHOD.textDelete, "dir/2.txt") });
    for (const n of [1, 2, 3]) await write(f.rootPath, `dir/${n}.txt`, String(n));
    const seen = await f.start();
    const result = await f.remove("dir");
    expect(result).toEqual({ ok: false, deleted: ["dir/1.txt"], path: "dir/2.txt", reason: expect.stringContaining("dir/2.txt") });
    expect(result.ok ? "" : result.reason).toContain("dir/1.txt left dir for the workspace trash as .dohc/local/trash/");
    await f.settle();
    expect((await readdir(join(f.rootPath, "dir"))).sort()).toEqual(["2.txt", "3.txt"]);
    expect(f.trashItem).not.toHaveBeenCalled();
    expect(await f.added(seen)).toEqual([{ operation: "delete", path: "dir/1.txt", agentId: "Client name" }]);
    await f.engine().stop();
  });

  it("keeps a new file another program put at a restore path, and names what stayed in the trash", async () => {
    // Another program writes dir/2.txt while History refuses its delete.
    const f = await fixture({ beforeRequest: async request => {
      if (request.method === VERSIONED_METHOD.textDelete && JSON.stringify(request.params).includes('"dir/2.txt"')) {
        await write(f.rootPath, "dir/2.txt", "theirs");
      }
      refusedFor(VERSIONED_METHOD.textDelete, "dir/2.txt")(request);
    } });
    for (const n of [1, 2, 3]) await write(f.rootPath, `dir/${n}.txt`, String(n));
    await f.start();
    const result = await f.remove("dir");
    expect(result).toMatchObject({ ok: false, deleted: ["dir/1.txt"], path: "dir/2.txt", reason: expect.stringContaining("dir/2.txt stay in the workspace trash") });
    expect(await readFile(join(f.rootPath, "dir/2.txt"), "utf8")).toBe("theirs");
    expect(await readFile(join(f.rootPath, "dir/3.txt"), "utf8")).toBe("3");
    const [staged] = await f.workspaceTrash();
    expect(await readFile(join(f.rootPath, ".dohc/local/trash", staged!, "2.txt"), "utf8")).toBe("2");
    await f.engine().stop();
  });

  it("keeps a deleted file in the workspace trash when the system trash refuses it", async () => {
    const f = await fixture();
    await write(f.rootPath, "note.txt", "keep me");
    await f.start();
    f.trashItem.mockRejectedValueOnce(new Error("no system trash on this volume"));
    const result = await f.remove("note.txt");
    expect(result).toMatchObject({ ok: true, path: "note.txt", trashed: false, trashPath: expect.stringMatching(/^\.dohc\/local\/trash\//) });
    const kept = await f.workspaceTrash();
    expect(kept).toHaveLength(1);
    expect(await readFile(join(f.rootPath, ".dohc/local/trash", kept[0]!), "utf8")).toBe("keep me");
    await f.engine().stop();
  });

  it("replaces the destination with overwrite, sending it to the system trash, and refuses without it", async () => {
    const f = await fixture();
    await write(f.rootPath, "a.txt", "new");
    await write(f.rootPath, "b.txt", "old");
    const seen = await f.start();
    expect(await f.move("a.txt", "b.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("already exists") });
    expect(await f.move("a.txt", "b.txt", named, true)).toMatchObject({ ok: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/), fromPath: "a.txt", toPath: "b.txt",
      replaced: { path: "b.txt", trashed: true, withoutHistory: [] } });
    expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("new");
    expect(await readFile(await f.systemTrashed("b.txt"), "utf8")).toBe("old");
    expect(await f.workspaceTrash()).toEqual([]);
    await f.settle();
    expect(await f.added(seen)).toEqual([
      { operation: "delete", path: "b.txt", agentId: "Client name" },
      { operation: "rename", path: "b.txt", agentId: "Client name" },
    ]);
    await f.engine().stop();
  });

  it("separates a rowless replaced destination retained after rollback", async () => {
    const f = await fixture({ afterRequest: async request => {
      if (request.method !== "capture.moveFile") return;
      await write(f.rootPath, "source.png", "theirs");
      throw new Error("Move reply lost");
    } });
    await write(f.rootPath, "source.png", new Uint8Array(6 * 1024 * 1024));
    await write(f.rootPath, "dest.png", new Uint8Array(7 * 1024 * 1024));
    await f.start();
    const result = await f.move("source.png", "dest.png", named, true);
    expect(result).toMatchObject({ ok: false, withoutHistory: ["dest.png"],
      replaced: { path: "dest.png", trashed: false, trashPath: expect.stringMatching(/^\.dohc\/local\/trash\//), withoutHistory: ["dest.png"] } });
    if (result.ok || !result.replaced?.trashPath) throw new Error("Expected retained replacement");
    expect((await readFile(join(f.rootPath, result.replaced.trashPath))).byteLength).toBe(7 * 1024 * 1024);
    expect((await readFile(join(f.rootPath, "dest.png"))).byteLength).toBe(6 * 1024 * 1024);
    expect(await readFile(join(f.rootPath, "source.png"), "utf8")).toBe("theirs");
    expect((await f.workspaceTrash()).filter(name => name.startsWith("replace-"))).toEqual([]);
    await f.engine().stop();
  });

  it("puts back a replaced file a stop left in the workspace trash when the workspace opens", async () => {
    const f = await fixture();
    const workspace = f.operation.workspace;
    await write(f.rootPath, "b.txt", "theirs");
    const record = { operationId: `dohc-operation:${randomUUID()}`, from: "a.txt", to: "b.txt", place: "b.txt", staged: `${Date.now()}-${randomUUID()}-` };
    await saveRecoveryRecord(workspace, record, "replace");
    await moveIntoWorkspaceTrash(workspace, join(f.rootPath, "b.txt"), record.staged);
    // An unfinished move does not expire like an Undo offer.
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    for (const name of await f.workspaceTrash()) if (name.startsWith("replace-")) await utimes(join(f.rootPath, ".dohc/local/trash", name), old, old);
    const open = () => resumeWorkspaceLinkRewrites(workspace, { workspaceId: workspace.workspaceId, history: { rewriteHistoryLinks: vi.fn() } });
    // A disk that refuses the first open leaves the record for the next one.
    faults.mutate = syscall => { if (syscall === "link" || syscall === "copyFile") throw new Error("The disk is busy"); };
    try { await open(); } finally { delete faults.mutate; }
    expect(existsSync(join(f.rootPath, "b.txt"))).toBe(false);
    expect((await f.workspaceTrash()).filter(name => name.startsWith("replace-"))).toHaveLength(1);
    await open();
    expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("theirs");
    expect(await f.workspaceTrash()).toEqual([]);
  });

  it("finishes at the next open when a stop interrupts putting a moved file back, hiding neither file", async () => {
    const f = await fixture();
    const workspace = f.operation.workspace;
    const staged = `${Date.now()}-${randomUUID()}-`;
    await write(f.rootPath, "b.txt", "theirs");
    await moveIntoWorkspaceTrash(workspace, join(f.rootPath, "b.txt"), staged);
    await write(f.rootPath, "b.txt", "mine");
    const at = await lstat(join(f.rootPath, "b.txt"), { bigint: true });
    const record = { operationId: `dohc-operation:${randomUUID()}`, from: "a.txt", to: "b.txt", place: "b.txt", staged, moved: `${at.dev}:${at.ino}` };
    await saveRecoveryRecord(workspace, record, "replace");
    // The stop lands after the moved file has its old name back and before it leaves the new one.
    faults.unlink = path => path === join(f.rootPath, "b.txt");
    try { await putBackStoppedMoves(workspace, () => undefined); } finally { delete faults.unlink; }
    expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("mine");
    expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("mine");
    expect((await f.workspaceTrash()).filter(name => name.startsWith("replace-"))).toHaveLength(1);
    await putBackStoppedMoves(workspace, () => undefined);
    expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("mine");
    expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("theirs");
    expect(await f.workspaceTrash()).toEqual([]);
  });
});

describe("a folder with a live page", () => {
  const refusal = [`dohc can't move "notes" while a page in it has live editing on`,
    "In Live documents, stop live editing for every page in this folder, then move the folder again."].join(String.fromCharCode(10));
  const deleteRefusal = [`dohc can't delete "notes" while a page in it has live editing on`,
    "In Live documents, stop live editing for every page in this folder, then delete the folder again."].join(String.fromCharCode(10));
  // A page this computer owns at notes/page.md. The engine refuses only a folder move or delete over it.
  async function ownedFixture() {
    const methods: string[] = [], checks: Array<{ path: string; change: string | undefined }> = [];
    const f = await fixture({ beforeRequest: request => {
      methods.push(request.method);
      if (request.method !== VERSIONED_METHOD.textCheckMove) return;
      const params = request.params as { path: string; change?: "movePage" | "moveFolder" | "delete" };
      checks.push({ path: params.path, change: params.change });
      if ((params.change === "moveFolder" || params.change === "delete") && "notes/page.md".startsWith(`${params.path}/`)) {
        throw new DaemonRefusalError({ code: "INVALID_PARAMS", message: "live-folder-page-owned", retry: "no" }, null);
      }
    } });
    await write(f.rootPath, "notes/page.md", "page");
    await write(f.rootPath, "drafts/plain.md", "plain");
    const seen = await f.start();
    return { ...f, methods, checks, seen };
  }

  it("refuses the move from the app, the CLI and MCP, with no relay, before anything changes", async () => {
    const f = await ownedFixture();
    const from = f.methods.length;
    expect(await f.move("notes", "moved")).toMatchObject({ ok: false, reason: refusal });
    await expect(f.moveByHand("notes", "moved")).rejects.toMatchObject({ name: "LiveFolderError", message: refusal });
    expect(f.checks.filter(check => check.path === "notes")).toEqual([{ path: "notes", change: "moveFolder" }, { path: "notes", change: "moveFolder" }]);
    expect(f.methods.slice(from).filter(method => method !== VERSIONED_METHOD.textCheckMove && /capture|delete|rename|write/i.test(method))).toEqual([]);
    expect(await readFile(join(f.rootPath, "notes/page.md"), "utf8")).toBe("page");
    expect(existsSync(join(f.rootPath, "moved"))).toBe(false);
    await f.settle();
    expect(await f.added(f.seen)).toEqual([]);
  });

  it("refuses the delete from the app, the CLI and MCP, before anything changes", async () => {
    const f = await ownedFixture();
    const from = f.methods.length;
    expect(await f.remove("notes")).toMatchObject({ ok: false, reason: deleteRefusal });
    await expect(f.removeByHand("notes")).rejects.toMatchObject({ name: "LiveFolderError", message: deleteRefusal });
    expect(f.checks.filter(check => check.path === "notes")).toEqual([{ path: "notes", change: "delete" }, { path: "notes", change: "delete" }]);
    expect(f.methods.slice(from).filter(method => method !== VERSIONED_METHOD.textCheckMove && /capture|delete|rename|write/i.test(method))).toEqual([]);
    expect(f.trashItem).not.toHaveBeenCalled();
    expect(await readFile(join(f.rootPath, "notes/page.md"), "utf8")).toBe("page");
    await f.settle();
    expect(await f.added(f.seen)).toEqual([]);
  });

});

describe("a page this computer owns live", () => {
  const refusal = [`dohc can't move "notes/page.md" while it has live editing on`,
    "In Live documents, stop live editing for this page, then move it again."].join(String.fromCharCode(10));
  const deleteRefusal = [`dohc can't delete "notes/page.md" while it has live editing on`,
    "In Live documents, stop live editing for this page, then delete it again."].join(String.fromCharCode(10));
  // The engine refuses only a page move or delete of notes/page.md.
  async function ownedFixture() {
    const methods: string[] = [], changes: Array<string | undefined> = [];
    const f = await fixture({ beforeRequest: request => {
      methods.push(request.method);
      if (request.method !== VERSIONED_METHOD.textCheckMove) return;
      const params = request.params as { path: string; change?: "movePage" | "moveFolder" | "delete" };
      if (params.path === "notes/page.md") changes.push(params.change);
      if ((params.change === "movePage" || params.change === "delete") && params.path === "notes/page.md") {
        throw new DaemonRefusalError({ code: "INVALID_PARAMS", message: "live-page-owned", retry: "no" }, null);
      }
    } });
    await write(f.rootPath, "notes/page.md", "page");
    await write(f.rootPath, "notes/plain.md", "plain");
    const seen = await f.start();
    return { ...f, methods, changes, seen };
  }

  it("refuses its move from the app, the CLI and MCP, before anything changes", async () => {
    const f = await ownedFixture();
    const from = f.methods.length;
    expect(await f.move("notes/page.md", "notes/renamed.md")).toMatchObject({ ok: false, reason: refusal });
    await expect(f.moveByHand("notes/page.md", "notes/renamed.md")).rejects.toMatchObject({ name: "LivePageOwnedError", message: refusal });
    expect(f.changes).toEqual(["movePage", "movePage"]);
    expect(f.methods.slice(from).filter(method => method !== VERSIONED_METHOD.textCheckMove && /capture|delete|rename|write/i.test(method))).toEqual([]);
    expect(await readFile(join(f.rootPath, "notes/page.md"), "utf8")).toBe("page");
    expect(existsSync(join(f.rootPath, "notes/renamed.md"))).toBe(false);
    await f.settle();
    expect(await f.added(f.seen)).toEqual([]);
  });

  it("refuses its delete from the app, the CLI and MCP, before anything changes", async () => {
    const f = await ownedFixture();
    const from = f.methods.length;
    expect(await f.remove("notes/page.md")).toMatchObject({ ok: false, reason: deleteRefusal });
    await expect(f.removeByHand("notes/page.md")).rejects.toMatchObject({ name: "LivePageOwnedError", message: deleteRefusal });
    expect(f.changes).toEqual(["delete", "delete"]);
    expect(f.methods.slice(from).filter(method => method !== VERSIONED_METHOD.textCheckMove && /capture|delete|rename|write/i.test(method))).toEqual([]);
    expect(f.trashItem).not.toHaveBeenCalled();
    expect(await readFile(join(f.rootPath, "notes/page.md"), "utf8")).toBe("page");
    await f.settle();
    expect(await f.added(f.seen)).toEqual([]);
  });

});

describe("agent move and delete admission", () => {
  // Runs the admission inside a stand-in for the capture seam and fails the
  // test if anything is recorded or the disk is touched.
  async function refusingFixture() {
    const f = await fixture();
    const engine: Omit<AuthoredPathChanges, "policy"> = {
      readDuplicate: async () => null, hasPath: async () => false,
      duplicateFile: async () => { throw new Error("unexpected Duplicate"); },
      recordDisk: vi.fn(async () => []),
      moveFile: vi.fn(async () => false),
      rename: vi.fn(async () => { throw new Error("Admission should have refused"); }),
      delete: vi.fn(async () => { throw new Error("Admission should have refused"); }),
      undoDelete: vi.fn(async () => undefined),
    };
    // The policy is read once the queued change runs, as the capture seam reads it.
    const changePathsAs = vi.fn(async (_paths: readonly string[], _authored: unknown, work: (changes: AuthoredPathChanges) => Promise<unknown>) =>
      await work({ ...engine, policy: await readWorkspaceEnginePolicy(f.rootPath) })) as WorkspaceEngineCapture["changePathsAs"];
    const options: PathChangeOptions = { capture: { changePathsAs }, requestId: "request", trashItem: vi.fn(), markDeleted: vi.fn() };
    return { ...f, changePathsAs, recorded: engine,
      move: (fromPath: string, toPath: string, overwrite?: boolean) =>
        prepareMoveWorkspacePathAs(f.operation, { fromPath, toPath, ...(overwrite ? { overwrite } : {}) }, named, options).then(finish => finish()),
      remove: (path: string) => prepareDeleteWorkspacePathAs(f.operation, path, named, options).then(finish => finish()) };
  }

  it.each(["readOnly", "shareView"] as const)("refuses a %s workspace", async kind => {
    const f = await refusingFixture();
    await write(f.rootPath, "a.txt", "a");
    if (kind === "readOnly") f.operation.workspace.readOnly = true;
    else f.operation.workspace.shareView = {};
    expect(await f.move("a.txt", "b.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("read-only") });
    expect(await f.remove("a.txt")).toMatchObject({ ok: false, deleted: [], reason: expect.stringContaining("read-only") });
    expect(f.changePathsAs).not.toHaveBeenCalled();
  });

  it.each([
    ["a secret file", "app/.env"],
    ["an excluded file", "site/build/out.js"],
    ["a .git folder", "repo/.git/HEAD"],
    ["a node_modules folder", "pkg/node_modules/x/index.js"],
    ["a nested .dohc folder", "copy/.dohc/state.json"],
  ])("refuses a folder that holds %s", async (_case, path) => {
    const f = await refusingFixture();
    await write(f.rootPath, path, "x");
    await write(f.rootPath, ".dohc/files.toml", '[[rule]]\npath = "site/build/**"\ntracked = false\n');
    const folder = path.split("/")[0]!;
    expect(await f.move(folder, "elsewhere")).toMatchObject({ ok: false, reason: expect.stringContaining("History cannot record") });
    expect(await f.remove(folder)).toMatchObject({ ok: false, reason: expect.stringContaining("History cannot record") });
    expect(f.recorded.recordDisk).not.toHaveBeenCalled();
    expect(await readFile(join(f.rootPath, path), "utf8")).toBe("x");
  });

  it("refuses a link, as the path or inside a folder", async () => {
    const f = await refusingFixture();
    await write(f.rootPath, "target.txt", "t");
    await mkdir(join(f.rootPath, "dir"));
    await symlink(join(f.rootPath, "target.txt"), join(f.rootPath, "link.txt"));
    await symlink(join(f.rootPath, "target.txt"), join(f.rootPath, "dir/link.txt"));
    for (const path of ["link.txt", "dir"]) {
      expect(await f.remove(path)).toMatchObject({ ok: false, reason: expect.stringContaining("not links") });
      expect(await f.move(path, "moved")).toMatchObject({ ok: false, reason: expect.stringContaining("not links") });
    }
    // A link onto its own target is not the same entry, so overwrite stays refused.
    expect(await f.move("link.txt", "target.txt", true)).toMatchObject({ ok: false });
    expect(f.recorded.recordDisk).not.toHaveBeenCalled();
    expect(await readFile(join(f.rootPath, "target.txt"), "utf8")).toBe("t");
  });

  it("reads files.toml again once the queued change runs", async () => {
    const f = await refusingFixture();
    await write(f.rootPath, "queued.txt", "a");
    const entered = barrier(), release = barrier();
    const held = withExclusiveWorkspaceOperation(f.rootPath, async () => { entered.release(); await release.promise; });
    await entered.promise;
    const pending = f.remove("queued.txt");
    await write(f.rootPath, ".dohc/files.toml", '[[rule]]\npath = "queued.txt"\ntracked = false\n');
    release.release();
    await held;
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining("History cannot record") });
    expect(f.recorded.recordDisk).not.toHaveBeenCalled();
  });
});

describe("a person's delete", () => {
  it("keeps the entry in the workspace trash when the system trash refuses", async () => {
    const f = await fixture();
    await write(f.rootPath, "tasks/hand.md", "# Hand made\n");
    const seen = await f.start();
    f.trashItem.mockRejectedValueOnce(new Error("No system trash here."));
    try {
      expect(await f.removeByHand("tasks/hand.md")).toMatchObject({ trashed: false });
      expect(existsSync(join(f.rootPath, "tasks/hand.md"))).toBe(false);
      const [staged] = await f.workspaceTrash();
      expect(await readFile(join(f.rootPath, ".dohc/local/trash", staged!), "utf8")).toBe("# Hand made\n");
      expect((await f.rows()).filter(row => !seen.has(row.id))).toMatchObject([
        { operation: "delete", path: "tasks/hand.md", authors: [person] },
      ]);
    } finally { await f.engine().stop(); }
  });

  // From the capture hold on, reading a folder named build fails.
  const unreadableBuild = (request: Request) => {
    if (request.method === "capture.hold") faults.readdir = path => path.endsWith(`${sep}build`);
  };

  it("trashes a mixed folder whole, never following a link or reading a folder History excludes", async () => {
    const f = await fixture({ beforeRequest: unreadableBuild });
    const external = await createTestScratch("dohc-delete-excluded-link-");
    await write(external, "kept.txt", "outside");
    await write(f.rootPath, ".dohc/files.toml", '[[rule]]\npath = "tasks/build/**"\ntracked = false\n');
    await write(f.rootPath, "tasks/hand.md", "# Hand made\n");
    await write(f.rootPath, "tasks/.env", "SECRET=kept private");
    await write(f.rootPath, "tasks/node_modules/pkg.js", "excluded");
    await write(f.rootPath, "tasks/build/out.js", "built");
    await symlink(external, join(f.rootPath, "tasks/link"), process.platform === "win32" ? "junction" : "dir");
    const seen = await f.start();
    try {
      expect(await f.removeByHand("tasks")).toMatchObject({ trashed: true });
      expect(f.trashItem.mock.calls).toEqual([[join(f.rootPath, "tasks")]]);
      expect(await readFile(join(f.systemTrash, "tasks", "build", "out.js"), "utf8")).toBe("built");
      expect(await readFile(join(f.systemTrash, "tasks", ".env"), "utf8")).toBe("SECRET=kept private");
      expect((await lstat(join(f.systemTrash, "tasks", "link"))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(external, "kept.txt"), "utf8")).toBe("outside");
      expect(existsSync(join(f.rootPath, "tasks"))).toBe(false);
      expect((await f.rows()).filter(row => !seen.has(row.id))).toMatchObject([
        { operation: "delete", path: "tasks/hand.md", authors: [person] },
      ]);
    } finally {
      delete faults.readdir;
      await f.engine().stop();
    }
  });
});

// The workspace trash is in `.dohc/local`, which only the engine's open
// prepares. A change that would put something there before then moves nothing.
describe("before the workspace's open prepares .dohc/local", () => {
  const notReady = {
    "not-opened": () => readLocalStateFrom(null),
    "not-excluded": () => readLocalStateFrom({ currentBinding: () => ({ localStateReady: false }), localStateOpenAt: async () => ({ current: () => true }) }),
  };
  const because = {
    "not-opened": "because the workspace has not finished opening. Try again when it opens.",
    "not-excluded": "because it can't keep this workspace's trash out of iCloud Drive. Restart dohc to try again.",
  };

  it.each(["not-opened", "not-excluded"] as const)("refuses an agent's delete and replacing move, and moves nothing (%s)", async refusal => {
    const f = await fixture();
    await write(f.rootPath, "note.txt", "keep me");
    await write(f.rootPath, "source.txt", "source");
    await write(f.rootPath, "dest.txt", "dest");
    await f.start();
    notReady[refusal]();
    expect(await f.remove("note.txt")).toEqual({ ok: false, deleted: [], path: "note.txt",
      reason: `dohc did not move note.txt to the workspace trash ${because[refusal]}` });
    expect(await f.move("source.txt", "dest.txt", named, true)).toMatchObject({ ok: false,
      reason: `dohc did not move dest.txt to the workspace trash ${because[refusal]} dohc put everything back.` });
    expect(await readFile(join(f.rootPath, "note.txt"), "utf8")).toBe("keep me");
    expect(await readFile(join(f.rootPath, "source.txt"), "utf8")).toBe("source");
    expect(await readFile(join(f.rootPath, "dest.txt"), "utf8")).toBe("dest");
    expect(f.trashItem).not.toHaveBeenCalled();
    expect(existsSync(join(f.rootPath, ".dohc/local/trash"))).toBe(false);
    await f.engine().stop();
  });
});

describe("empty-folder rollback admission", () => {
  it.each(["read-only", "share", "stale"] as const)("preserves folders when the workspace is %s", async (refusal) => {
    const rootPath = await createTestScratch("empty-rollback-admission-");
    await mkdir(join(rootPath, "app"));
    const trashItem = vi.fn(async () => undefined);
    await expect(deleteWorkspacePathByHand({
      workspace: { workspaceId: "empty-rollback", rootPath, readOnly: refusal === "read-only",
        ...(refusal === "share" ? { shareView: {} } : {}) },
      assertCurrent: () => { if (refusal === "stale") throw new Error("stale workspace"); },
    }, "app", person, {
      capture: null, requestId: "rollback", trashItem, markDeleted: vi.fn(), emptyFolderOnly: true,
    })).rejects.toThrow(refusal === "stale" ? "stale workspace" : "read-only");
    expect((await lstat(join(rootPath, "app"))).isDirectory()).toBe(true);
    expect(trashItem).not.toHaveBeenCalled();
  });
});

describe("WorkspaceRef move identity", () => {
  it.each(["single", "folder", "binary"])("keeps native identity through a coordinated %s move", async kind => {
    const f = await fixture();
    const from = kind === "folder" ? "dir/a.txt" : kind === "binary" ? "photo.bin" : "a.txt";
    const to = kind === "folder" ? "moved/a.txt" : kind === "binary" ? "renamed.bin" : "renamed.txt";
    await write(f.rootPath, from, kind === "binary" ? new Uint8Array([0, 255]) : "a");
    if (kind === "folder") await write(f.rootPath, "dir/b.txt", "b");
    await f.start();
    try {
      const original = await f.reference(from);
      const sibling = kind === "folder" ? await f.reference("dir/b.txt") : null;
      expect(await f.move(kind === "folder" ? "dir" : from, kind === "folder" ? "moved" : to)).toMatchObject({ ok: true });
      await f.settle();
      expect(await f.resolve([original])).toMatchObject([{ status: "found", path: to, objectId: original.target.objectId }]);
      expect((await f.reference(to)).target).toEqual(original.target);
      if (sibling) expect(await f.resolve([sibling])).toMatchObject([{ status: "found", path: "moved/b.txt", objectId: sibling.target.objectId }]);
    } finally { await f.engine().stop(); }
  });

  it("changes identity after an external mv and never resolves a stale id to a replacement at its old path", async () => {
    const f = await fixture();
    await write(f.rootPath, "a.txt", "a");
    await f.start();
    try {
      const original = await f.reference("a.txt");
      await rename(join(f.rootPath, "a.txt"), join(f.rootPath, "external.txt"));
      await f.settle();
      expect((await f.reference("external.txt")).target).not.toEqual(original.target);
      await write(f.rootPath, "a.txt", "replacement");
      await f.settle();
      expect((await f.reference("a.txt")).target).not.toEqual(original.target);
      expect(await f.resolve([original])).toEqual([{ status: "absent" }]);
    } finally { await f.engine().stop(); }
  });
});

describe("History operation admission",()=>{
  it("refuses reserved caller IDs at authored write, restore and app-response removal",async()=>{
    const f=await fixture();
    await write(f.rootPath,"kept.md","Before");
    await f.start();
    const id="dohc-operation:forged";
    try {
      await expect(f.engine().writeAuthoredFile(join(f.rootPath,"kept.md"),"After",named,{correlationId:id})).rejects.toThrow("Reserved operation id.");
      await expect(f.engine().writeAuthoredFile(join(f.rootPath,"kept.md"),"After",named,{requestId:id})).rejects.toThrow("Reserved operation id.");
      await expect(f.engine().restoreFileToBeforeMoment("before",person,{expectedHeadMomentId:"head",requestId:id})).rejects.toThrow("Reserved operation id.");
      await expect(f.engine().undoAcceptedAppResponse({requestId:id,acceptanceId:"a",objectId:"o",momentId:"m",publicPrincipalId:"p",versionId:"main",collectionPath:"responses",path:"responses/a.md",grantId:"g"})).rejects.toThrow("Reserved operation id.");
      expect(await readFile(join(f.rootPath,"kept.md"),"utf8")).toBe("Before");
    } finally {await f.engine().stop();}
  });
});

describe("a restore of a page this computer owns live", () => {
  it("refuses removing it to before its creation with the restore words, and keeps the page", async () => {
    // The engine refuses the delete a restore to before creation runs.
    const f = await fixture({ beforeRequest: request => {
      if (request.method === VERSIONED_METHOD.textDelete) {
        throw new DaemonRefusalError({ code: "INVALID_PARAMS", message: "live-page-owned", retry: "no" }, null);
      }
    } });
    await write(f.rootPath, "notes/page.md", "page");
    await f.start();
    try {
      const created = (await f.rows()).find(row => row.path === "notes/page.md" && row.operation === "write")!;
      await expect(f.engine().restoreFileToBeforeMoment(created.id, person)).rejects.toMatchObject({ name: "LivePageOwnedError",
        message: [`dohc can't restore "notes/page.md" while it has live editing on`,
          "In Live documents, stop live editing for this page, then restore it again."].join(String.fromCharCode(10)) });
      expect(await readFile(join(f.rootPath, "notes/page.md"), "utf8")).toBe("page");
    } finally { await f.engine().stop(); }
  });

});
