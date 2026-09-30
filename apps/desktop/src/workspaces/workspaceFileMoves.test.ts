import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonRefusalError, VERSIONED_METHOD, type Request } from "@dohc/workspace-engine-client";
import { EngineDaemonUnavailableError, EngineWorkspaceSessionsClosedError, EngineWorkspaceShuttingDownError } from "@dohc/workspace-engine-client/daemon";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "./testTemp";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { createWorkspaceEngineCapture, type AuthoredPathChanges, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { prepareDeleteWorkspacePathAs, prepareMoveWorkspacePathAs, type PathChangeOptions } from "./workspaceFileMoves";

// Filesystem refusals a test switches on for chosen paths.
const faults = vi.hoisted(() => ({} as {
  unlink?: (path: string) => boolean | Promise<boolean>;
  readdir?: (path: string) => boolean;
  // Runs just before a hard link is made.
  link?: (from: string, to: string) => Promise<void>;
  readPolicy?: () => void;
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const refused = (syscall: string, path: string) =>
    Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${path}'`), { code: "EPERM", syscall, path });
  return {
    ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith(join(".dohc", "files.toml"))) faults.readPolicy?.();
      return actual.readFile(...args);
    }) as typeof actual.readFile,
    unlink: (async (path: Parameters<typeof actual.unlink>[0]) => {
      if (await faults.unlink?.(String(path))) throw refused("unlink", String(path));
      return await actual.unlink(path);
    }) as typeof actual.unlink,
    link: (async (from: Parameters<typeof actual.link>[0], to: Parameters<typeof actual.link>[1]) => {
      await faults.link?.(String(from), String(to));
      return await actual.link(from, to);
    }) as typeof actual.link,
    readdir: ((...args: Parameters<typeof actual.readdir>) => faults.readdir?.(String(args[0]))
      ? Promise.reject(refused("scandir", String(args[0])))
      : actual.readdir(...args)) as typeof actual.readdir,
  };
});

const named = { kind: "agent", agentId: "Client name", onBehalfOf: "person-local" } as const;
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
  const operation = { workspace: { rootPath, attachmentId: Symbol(), readOnly: false, shareView: undefined as unknown },
    state: {}, signal: new AbortController().signal, assertCurrent: vi.fn() };
  const workspaceId = "file-moves-test";
  let capture: WorkspaceEngineCapture | undefined;
  const engine = () => {
    capture ??= createWorkspaceEngineCapture({ workspaceId, rootPath, attachmentId: Symbol("attachment"),
      rustEngineSessions: mockDaemonSessions({ rootPath, workspaceId, loopback: new VersionedLoopbackEngine(), nativeMove: options.nativeMove ?? true,
        ...(options.beforeRequest ? { beforeRequest: options.beforeRequest } : {}),
        ...(options.afterRequest ? { afterRequest: options.afterRequest } : {}) }) });
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
  const workspaceTrash = async () => existsSync(join(rootPath, ".dohc/trash")) ? await readdir(join(rootPath, ".dohc/trash")) : [];
  // The system trash keeps the workspace trash's entry name, which ends with the file's own name.
  const systemTrashed = async (name: string) => {
    const entry = (await readdir(systemTrash)).find(entry => entry.endsWith(`-${name}`));
    if (entry === undefined) throw new Error(`${name} is not in the system trash`);
    return join(systemTrash, entry);
  };
  return { rootPath, systemTrash, systemTrashed, operation, engine, trashItem, markDeleted, settle, rows, start, added, workspaceTrash,
    move: (fromPath: string, toPath: string, by = named as typeof named | typeof unnamed, overwrite?: boolean) =>
      prepareMoveWorkspacePathAs(operation, { fromPath, toPath, ...(overwrite ? { overwrite } : {}) }, by, pathOptions()).then(finish => finish()),
    remove: (path: string, by = named as typeof named | typeof unnamed) => prepareDeleteWorkspacePathAs(operation, path, by, pathOptions()).then(finish => finish()) };
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
      expect(dirname(from)).toBe(join(f.rootPath, ".dohc/trash"));
      expect(existsSync(join(f.rootPath, "source.txt"))).toBe(false);
      // A save at the vacated source name must survive placement.
      await write(f.rootPath, "source.txt", "new save");
    };
    try {
      expect(await f.move("source.txt", "target.txt")).toEqual({ ok: true, fromPath: "source.txt", toPath: "target.txt" });
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

    expect(await f.move("person.txt", "agent.txt")).toEqual({ ok: true, fromPath: "person.txt", toPath: "agent.txt" });
    expect(await f.move("notes", "archive/notes", unnamed)).toEqual({ ok: true, fromPath: "notes", toPath: "archive/notes" });
    expect(await f.remove("photo.bin")).toEqual({ ok: true, path: "photo.bin", trashed: true });
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

  it.each(["move", "delete"] as const)("records a file capture has not seen yet before the agent's %s", async change => {
    // The file lands after capture's last pass, inside the watcher's debounce.
    const f = await fixture({ beforeRequest: async request => {
      if (request.method === "capture.hold") await write(f.rootPath, "notes/new.txt", "newborn");
    } });
    await write(f.rootPath, "notes/a.txt", "a");
    const seen = await f.start();
    const result = change === "move" ? await f.move("notes", "moved") : await f.remove("notes");
    expect(result).toMatchObject({ ok: true });
    await f.settle();
    const agent = change === "move" ? "rename" : "delete";
    const where = (path: string) => change === "move" ? `moved/${path}` : `notes/${path}`;
    expect(await f.added(seen)).toEqual([
      { operation: agent, path: where("a.txt"), agentId: "Client name" },
      { operation: agent, path: where("new.txt"), agentId: "Client name" },
      { operation: "write", path: "notes/new.txt", agentId: undefined },
    ].sort((a, b) => a.path.localeCompare(b.path) || a.operation.localeCompare(b.operation)));
    await f.engine().stop();
  });

  it.each(["delete", "overwrite"] as const)("releases capture before a slow system trash on %s", async change => {
    const events: string[] = [];
    const f = await fixture({ beforeRequest: request => { events.push(request.method); } });
    await write(f.rootPath, "notes/a.txt", "a");
    await f.start();
    events.length = 0;
    const trashed = barrier();
    f.trashItem.mockImplementationOnce(async absolute => {
      events.push("trash started");
      await trashed.promise;
      await rename(absolute, join(f.systemTrash, basename(absolute)));
      events.push("trash finished");
    });
    await write(f.rootPath, "source.txt", "source");
    const pending = change === "delete" ? f.remove("notes") : f.move("source.txt", "notes", named, true);
    await vi.waitFor(() => expect(events).toContain("trash started"));
    expect(events).toContain("capture.release");
    await write(f.rootPath, "next.txt", "next");
    expect(await f.remove("next.txt")).toMatchObject({ ok: true });
    trashed.release();
    expect(await pending).toMatchObject({ ok: true });
    const hold = events.indexOf("capture.hold");
    expect(hold).toBeGreaterThan(events.indexOf("capture.flush"));
    expect(events.slice(hold)).toContain(VERSIONED_METHOD.textDelete);
    expect(events.indexOf("capture.release")).toBeLessThan(events.indexOf("trash started"));
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
    expect(result.ok ? "" : result.reason).toContain("dir/1.txt left dir for the workspace trash as .dohc/trash/");
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
    expect(await readFile(join(f.rootPath, ".dohc/trash", staged!, "2.txt"), "utf8")).toBe("2");
    await f.engine().stop();
  });

  it("keeps a file another program writes at the source while the move places the file", async () => {
    const f = await fixture({ beforeRequest: async request => {
      if (request.method === VERSIONED_METHOD.textRename) await write(f.rootPath, "a.txt", "theirs");
    } });
    await write(f.rootPath, "a.txt", "mine");
    const seen = await f.start();
    expect(await f.move("a.txt", "b.txt")).toEqual({ ok: true, fromPath: "a.txt", toPath: "b.txt" });
    expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("mine");
    expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("theirs");
    // Their file reaches History through the watcher, without an author.
    await f.settle();
    expect(await f.added(seen)).toEqual([
      { operation: "write", path: "a.txt", agentId: undefined },
      { operation: "rename", path: "b.txt", agentId: "Client name" },
    ]);
    await f.engine().stop();
  });

  it("moves a single binary without staging, linking, or copying", async () => {
    const f = await fixture();
    await write(f.rootPath, "photo.bin", new Uint8Array(32 * 1024));
    await f.start();
    faults.link = async () => { throw new Error("this filesystem has no hard links"); };
    try {
      expect(await f.move("photo.bin", "archive/photo.bin")).toMatchObject({ ok: true });
    } finally { delete faults.link; }
    expect(existsSync(join(f.rootPath, "photo.bin"))).toBe(false);
    expect((await readFile(join(f.rootPath, "archive/photo.bin"))).byteLength).toBe(32 * 1024);
    expect(await f.workspaceTrash()).toEqual([]);
    await f.engine().stop();
  });

  it("keeps a staged folder whole in the trash when it cannot be read back, and makes nothing at its place", async () => {
    const f = await fixture({ beforeRequest: request => {
      if (request.method === VERSIONED_METHOD.textDelete) faults.readdir = path => path.includes(join(".dohc", "trash"));
      refusedFor(VERSIONED_METHOD.textDelete, "dir/1.txt")(request);
    } });
    for (const n of [1, 2]) await write(f.rootPath, `dir/${n}.txt`, String(n));
    await f.start();
    let result: Awaited<ReturnType<typeof f.remove>> | undefined;
    try {
      result = await f.remove("dir");
    } finally { delete faults.readdir; }
    expect(result).toMatchObject({ ok: false, deleted: [], reason: expect.stringContaining("dir/1.txt, dir/2.txt stay in the workspace trash") });
    expect(existsSync(join(f.rootPath, "dir"))).toBe(false);
    const [staged] = await f.workspaceTrash();
    expect((await readdir(join(f.rootPath, ".dohc/trash", staged!))).sort()).toEqual(["1.txt", "2.txt"]);
    await f.engine().stop();
  });

  it("puts a file back even when its staged name cannot be removed, leaving a spare copy in the trash", async () => {
    const f = await fixture({ beforeRequest: request => {
      if (request.method === VERSIONED_METHOD.textDelete) faults.unlink = path => path.includes(join(".dohc", "trash")) && path.endsWith("2.txt");
      refusedFor(VERSIONED_METHOD.textDelete, "dir/1.txt")(request);
    } });
    for (const n of [1, 2]) await write(f.rootPath, `dir/${n}.txt`, String(n));
    await f.start();
    let result: Awaited<ReturnType<typeof f.remove>> | undefined;
    try {
      result = await f.remove("dir");
    } finally { delete faults.unlink; }
    expect(result).toMatchObject({ ok: false, deleted: [], path: "dir/1.txt" });
    expect(result?.ok === false ? result.reason : "").not.toContain("workspace trash");
    expect(await readFile(join(f.rootPath, "dir/1.txt"), "utf8")).toBe("1");
    expect(await readFile(join(f.rootPath, "dir/2.txt"), "utf8")).toBe("2");
    const [staged] = await f.workspaceTrash();
    expect(await readdir(join(f.rootPath, ".dohc/trash", staged!))).toEqual(["2.txt"]);
    await f.engine().stop();
  });

  it("does not replace even an empty folder another program made at the restore path", async () => {
    const f = await fixture({ beforeRequest: async request => {
      if (request.method === VERSIONED_METHOD.textDelete) await mkdir(join(f.rootPath, "dir"));
      refusedFor(VERSIONED_METHOD.textDelete, "dir/1.txt")(request);
    } });
    for (const n of [1, 2]) await write(f.rootPath, `dir/${n}.txt`, String(n));
    await f.start();
    expect(await f.remove("dir")).toMatchObject({ ok: false, deleted: [], path: "dir/1.txt",
      reason: expect.stringContaining("stay in the workspace trash") });
    expect(await readdir(join(f.rootPath, "dir"))).toEqual([]);
    const [staged] = await f.workspaceTrash();
    expect((await readdir(join(f.rootPath, ".dohc/trash", staged!))).sort()).toEqual(["1.txt", "2.txt"]);
    await f.engine().stop();
  });

  it("sends the deleted file to the system trash, never a new file another program put at its place", async () => {
    // Another program writes note.txt once History has recorded the delete.
    const f = await fixture({ afterRequest: async request => {
      if (request.method === VERSIONED_METHOD.textDelete) await write(f.rootPath, "note.txt", "theirs");
    } });
    await write(f.rootPath, "note.txt", "mine");
    await f.start();
    expect(await f.remove("note.txt")).toEqual({ ok: true, path: "note.txt", trashed: true });
    expect(f.trashItem).toHaveBeenCalledOnce();
    expect(f.trashItem.mock.calls[0]?.[0]).toContain(join(".dohc", "trash"));
    expect(await readFile(join(f.rootPath, "note.txt"), "utf8")).toBe("theirs");
    expect(await readFile(await f.systemTrashed("note.txt"), "utf8")).toBe("mine");
    await f.engine().stop();
  });

  it("keeps a deleted file in the workspace trash when the system trash refuses it", async () => {
    const f = await fixture();
    await write(f.rootPath, "note.txt", "keep me");
    await f.start();
    f.trashItem.mockRejectedValueOnce(new Error("no system trash on this volume"));
    const result = await f.remove("note.txt");
    expect(result).toMatchObject({ ok: true, path: "note.txt", trashed: false, trashPath: expect.stringMatching(/^\.dohc\/trash\//) });
    const kept = await f.workspaceTrash();
    expect(kept).toHaveLength(1);
    expect(await readFile(join(f.rootPath, ".dohc/trash", kept[0]!), "utf8")).toBe("keep me");
    await f.engine().stop();
  });

  it("moves the folder back when History refuses a rename", async () => {
    const f = await fixture({ beforeRequest: refusedFor(VERSIONED_METHOD.textRename, "dir/2.txt") });
    for (const n of [1, 2]) await write(f.rootPath, `dir/${n}.txt`, String(n));
    await f.start();
    expect(await f.move("dir", "moved")).toEqual({ ok: false, path: "dir", reason: expect.stringContaining("put everything back") });
    expect((await readdir(join(f.rootPath, "dir"))).sort()).toEqual(["1.txt", "2.txt"]);
    expect(existsSync(join(f.rootPath, "moved"))).toBe(false);
    await f.engine().stop();
  });

  it("replaces the destination with overwrite, sending it to the system trash, and refuses without it", async () => {
    const f = await fixture();
    await write(f.rootPath, "a.txt", "new");
    await write(f.rootPath, "b.txt", "old");
    const seen = await f.start();
    expect(await f.move("a.txt", "b.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("already exists") });
    expect(await f.move("a.txt", "b.txt", named, true)).toEqual({ ok: true, fromPath: "a.txt", toPath: "b.txt",
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

  it.each([
    ["the source's rename", VERSIONED_METHOD.textRename, "a.txt"],
    ["a destination file's delete", VERSIONED_METHOD.textDelete, "dest/2.txt"],
  ])("puts both paths back when History refuses %s during an overwrite", async (_case, method, path) => {
    const f = await fixture({ beforeRequest: refusedFor(method, path) });
    await write(f.rootPath, "a.txt", "source");
    for (const n of [1, 2]) await write(f.rootPath, `dest/${n}.txt`, String(n));
    await f.start();
    const result = await f.move("a.txt", "dest", named, true);
    expect(result).toEqual({ ok: false, path: "a.txt", reason: expect.stringContaining("put everything back") });
    expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("source");
    expect(await readFile(join(f.rootPath, "dest/1.txt"), "utf8")).toBe("1");
    expect(await readFile(join(f.rootPath, "dest/2.txt"), "utf8")).toBe("2");
    expect(await f.workspaceTrash()).toEqual([]);
    await f.engine().stop();
  });

  it("reaches the entry on disk through another case of its name, where the disk ignores case", async () => {
    const f = await fixture();
    await write(f.rootPath, "probe.txt", "p");
    if (!existsSync(join(f.rootPath, "PROBE.TXT"))) return;
    await write(f.rootPath, "notes.txt", "n");
    await write(f.rootPath, "draft.txt", "d");
    await write(f.rootPath, "a/b.txt", "b");
    await write(f.rootPath, "keep.txt", "k");
    const seen = await f.start();
    expect(await f.remove("Notes.txt")).toMatchObject({ ok: true });
    expect(await f.move("Draft.txt", "moved.txt")).toMatchObject({ ok: true });
    // A rename of case alone still renames.
    expect(await f.move("keep.txt", "Keep.txt")).toEqual({ ok: true, fromPath: "keep.txt", toPath: "Keep.txt" });
    // The destination names the folder that holds the source.
    expect(await f.move("a/b.txt", "A", named, true)).toMatchObject({ ok: false, reason: expect.stringContaining("one holds the other") });
    await f.settle();
    expect(await f.added(seen)).toEqual([
      { operation: "rename", path: "Keep.txt", agentId: "Client name" },
      { operation: "rename", path: "moved.txt", agentId: "Client name" },
      { operation: "delete", path: "notes.txt", agentId: "Client name" },
    ]);
    expect(await readdir(f.rootPath)).toContain("Keep.txt");
    expect(await readFile(join(f.rootPath, "a/b.txt"), "utf8")).toBe("b");
    await f.engine().stop();
  });

  it("refuses when a folder link on the path points somewhere else once capture is held", async () => {
    const kind = process.platform === "win32" ? "junction" : "dir";
    // Each hold swaps where the link points.
    let holds = 0;
    const f = await fixture({ beforeRequest: async request => {
      if (request.method !== "capture.hold") return;
      holds += 1;
      await rm(join(f.rootPath, "link"));
      await symlink(join(f.rootPath, holds % 2 ? "two" : "one"), join(f.rootPath, "link"), kind);
    } });
    await write(f.rootPath, "one/a.txt", "one");
    await write(f.rootPath, "two/a.txt", "two");
    await symlink(join(f.rootPath, "one"), join(f.rootPath, "link"), kind);
    const seen = await f.start();
    expect(await f.remove("link/a.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("now leads somewhere else") });
    expect(await f.move("link/a.txt", "moved.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("now leads somewhere else") });
    expect(await readFile(join(f.rootPath, "one/a.txt"), "utf8")).toBe("one");
    expect(await readFile(join(f.rootPath, "two/a.txt"), "utf8")).toBe("two");
    await f.settle();
    expect((await f.added(seen)).filter(row => row.agentId !== undefined)).toEqual([]);
    await f.engine().stop();
  });

  it.each([
    ["workspace gone", new DaemonRefusalError({ code: "WORKSPACE_UNAVAILABLE", message: "gone", retry: "no" }, undefined)],
    ["session expired", new DaemonRefusalError({ code: "SESSION_EXPIRED", message: "expired", retry: "no" }, undefined)],
    ["reconnect required", new DaemonRefusalError({ code: "INTERNAL", message: "reconnect", retry: "afterReconnect" }, undefined)],
    ["transport lost", Object.assign(new Error("crashed"), { code: "transport-error" })],
    ["daemon unavailable", new EngineDaemonUnavailableError("crashed")],
    ["sessions closed", new EngineWorkspaceSessionsClosedError()],
    ["sessions shutting down", new EngineWorkspaceShuttingDownError()],
  ])("ends the capture chain when release finds %s", async (_name, error) => {
    let releases = 0;
    const f = await fixture({ beforeRequest: request => {
      if (request.method === "capture.release") { releases += 1; throw error; }
    } });
    await write(f.rootPath, "a.txt", "a");
    await f.start();
    expect(await f.remove("a.txt")).toMatchObject({ ok: true });
    // The adapter replays a reconnect-required mutation once before returning its refusal.
    expect(releases).toBe(_name === "reconnect required" ? 2 : 1);
    await f.engine().stop();
  });

  it.each(["move", "delete"] as const)("%s reads one policy snapshot under the hold", async change => {
    let reads = 0;
    const f = await fixture({ beforeRequest: request => {
      if (request.method === "capture.hold") faults.readPolicy = () => { reads += 1; };
      if (request.method === "capture.release") delete faults.readPolicy;
    } });
    await write(f.rootPath, "a.txt", "a");
    await write(f.rootPath, ".dohc/files.toml", "rule = []\n");
    await f.start();
    try {
      expect(change === "move" ? await f.move("a.txt", "b.txt") : await f.remove("a.txt")).toMatchObject({ ok: true });
      expect(reads).toBe(1);
    } finally { delete faults.readPolicy; await f.engine().stop(); }
  });

  it.each(["move", "delete"] as const)("%s allows Latin-1 CSV text inside a folder without a History row", async change => {
    const f = await fixture();
    // Above the binary cap but below the text cap: capture leaves this text rowless.
    const csv = Buffer.from("name\n" + "René\n".repeat(1_260_000), "latin1");
    await write(f.rootPath, "dir/people.csv", csv);
    await write(f.rootPath, "dir/a.txt", "a");
    const seen = await f.start();
    const result = change === "move" ? await f.move("dir", "moved") : await f.remove("dir");
    const base = change === "move" ? "moved" : "dir";
    expect(result).toMatchObject({ ok: true, withoutHistory: [base + "/people.csv"] });
    const kept = change === "move" ? join(f.rootPath, "moved") : await f.systemTrashed("dir");
    expect(await readFile(join(kept, "people.csv"))).toEqual(csv);
    await f.settle();
    expect(await f.added(seen)).toEqual([
      { operation: change === "move" ? "rename" : "delete", path: base + "/a.txt", agentId: "Client name" },
    ]);
    await f.engine().stop();
  });

  it.each([false, true])("reports a replaced oversized destination separately, system trash accepts: %s", async accepts => {
    const f = await fixture();
    const oversized = new Uint8Array(6 * 1024 * 1024);
    await write(f.rootPath, "source.png", oversized);
    await write(f.rootPath, "dest.png", oversized);
    await f.start();
    if (!accepts) f.trashItem.mockRejectedValueOnce(new Error("Trash refused"));
    const result = await f.move("source.png", "dest.png", named, true);
    expect(result).toMatchObject({ ok: true, withoutHistory: ["dest.png"],
      replaced: { path: "dest.png", trashed: accepts, withoutHistory: ["dest.png"] } });
    if (!result.ok || !result.replaced) throw new Error("Expected replacement");
    const kept = accepts ? await f.systemTrashed("dest.png") : join(f.rootPath, result.replaced.trashPath!);
    expect(await readFile(kept)).toEqual(Buffer.from(oversized));
    expect(result.replaced.trashPath).toEqual(accepts ? undefined : expect.stringMatching(/^\.dohc\/trash\//));
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
      replaced: { path: "dest.png", trashed: false, trashPath: expect.stringMatching(/^\.dohc\/trash\//), withoutHistory: ["dest.png"] } });
    if (result.ok || !result.replaced?.trashPath) throw new Error("Expected retained replacement");
    expect((await readFile(join(f.rootPath, result.replaced.trashPath))).byteLength).toBe(7 * 1024 * 1024);
    expect((await readFile(join(f.rootPath, "dest.png"))).byteLength).toBe(6 * 1024 * 1024);
    expect(await readFile(join(f.rootPath, "source.png"), "utf8")).toBe("theirs");
    await f.engine().stop();
  });

  it.each([false, true])("checks the disk after a lost move reply, source occupied: %s", async occupied => {
    const f = await fixture({ afterRequest: async request => {
      if (request.method !== "capture.moveFile") return;
      if (occupied) await write(f.rootPath, "a.txt", "theirs");
      throw new Error("Move reply lost");
    } });
    await write(f.rootPath, "a.txt", "mine");
    const seen = await f.start();
    const result = await f.move("a.txt", "b.txt");
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(occupied ? "stays at b.txt" : "put everything back") });
    expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe(occupied ? "theirs" : "mine");
    expect(existsSync(join(f.rootPath, "b.txt"))).toBe(occupied);
    if (occupied) expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("mine");
    await f.settle();
    expect((await f.added(seen)).filter(row => row.agentId !== undefined)).toEqual(
      occupied ? [{ operation: "rename", path: "b.txt", agentId: "Client name" }] : []);
    await f.engine().stop();
  });

  it.each(["move", "delete"] as const)("%s allows an oversized binary and text file with no History row", async change => {
    const f = await fixture();
    await write(f.rootPath, "dir/a.txt", "a");
    await write(f.rootPath, "dir/large.png", new Uint8Array(6 * 1024 * 1024));
    await write(f.rootPath, "dir/large.txt", "x".repeat(11 * 1024 * 1024));
    const seen = await f.start();
    const result = change === "move" ? await f.move("dir", "moved") : await f.remove("dir");
    const base = change === "move" ? "moved" : "dir";
    expect(result).toMatchObject({ ok: true, withoutHistory: [base + "/large.png", base + "/large.txt"] });
    expect(existsSync(join(f.rootPath, "dir"))).toBe(false);
    await f.settle();
    expect((await f.added(seen)).filter(row => row.agentId !== undefined)).toEqual([
      { operation: change === "move" ? "rename" : "delete", path: base + "/a.txt", agentId: "Client name" },
    ]);
    await f.engine().stop();
  });

  it.each([false, true])("reports oversized files after move rollback with an occupied source: %s", async occupied => {
    const f = await fixture({ beforeRequest: async request => {
      if (request.method === VERSIONED_METHOD.textRename && JSON.stringify(request.params).includes('"dir/a.txt"')) {
        if (occupied) await write(f.rootPath, "dir/large.png", "new content");
        throw new Error("History refused the rename.");
      }
    } });
    await write(f.rootPath, "dir/a.txt", "a");
    await write(f.rootPath, "dir/large.png", new Uint8Array(6 * 1024 * 1024));
    await f.start();
    const result = await f.move("dir", "moved");
    const retained = (occupied ? "moved" : "dir") + "/large.png";
    expect(result).toMatchObject({ ok: false, withoutHistory: [retained] });
    expect((await readFile(join(f.rootPath, retained))).byteLength).toBe(6 * 1024 * 1024);
    if (occupied) expect(await readFile(join(f.rootPath, "dir/large.png"), "utf8")).toBe("new content");
    await f.engine().stop();
  });

  it("reports rowless files already removed when a folder delete stops", async () => {
    const f = await fixture({ beforeRequest: refusedFor(VERSIONED_METHOD.textDelete, "dir/1.txt") });
    await write(f.rootPath, "dir/0.png", new Uint8Array(6 * 1024 * 1024));
    await write(f.rootPath, "dir/1.txt", "one");
    await f.start();
    const result = await f.remove("dir");
    expect(result).toMatchObject({ ok: false, deleted: [], withoutHistory: ["dir/0.png"], path: "dir/1.txt", reason: expect.stringContaining("no History row") });
    expect(existsSync(join(f.rootPath, "dir/0.png"))).toBe(false);
    expect(await readFile(join(f.rootPath, "dir/1.txt"), "utf8")).toBe("one");
    await f.engine().stop();
  });

  it("does not report restored destination files as deleted when History undo fails", async () => {
    const f = await fixture({ beforeRequest: request => {
      refusedFor(VERSIONED_METHOD.textDelete, "dest/2.txt")(request);
      refusedFor(VERSIONED_METHOD.textRollback, "dest/1.txt")(request);
    } });
    await write(f.rootPath, "a.txt", "source");
    for (const n of [1, 2]) await write(f.rootPath, "dest/" + n + ".txt", String(n));
    await f.start();
    const result = await f.move("a.txt", "dest", named, true);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("back at dest/1.txt") });
    expect(result.ok ? undefined : result.deleted).toBeUndefined();
    expect(await readFile(join(f.rootPath, "dest/1.txt"), "utf8")).toBe("1");
    await f.settle();
    expect((await f.rows()).filter(row => row.path === "dest/1.txt").some(row => row.operation === "write")).toBe(true);
    await f.engine().stop();
  });

  it("renews the lease while its caller works and stops renewing after release", async () => {
    const methods: string[] = [];
    const f = await fixture({ beforeRequest: request => { methods.push(request.method); } });
    await write(f.rootPath, "a.txt", "a");
    await f.start();
    const entered = barrier(), finish = barrier();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = f.engine().changePathsAs(["a.txt"], { operation: "delete", author: named, correlationId: "renew-test" },
        async () => { entered.release(); await finish.promise; }, () => []);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(methods.filter(method => method === "capture.renew")).toHaveLength(1);
      finish.release();
      await pending;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(methods.filter(method => method === "capture.renew")).toHaveLength(1);
    } finally { finish.release(); vi.useRealTimers(); await f.engine().stop(); }
  });

  it.each([2, 4])("keeps sending a release the busy engine refused %i times until it lands", async failures => {
    let failuresLeft = failures;
    const methods: string[] = [];
    const f = await fixture({ beforeRequest: request => {
      methods.push(request.method);
      if (request.method === "capture.release" && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("OVERLOADED: the engine is busy");
      }
    } });
    await write(f.rootPath, "a.txt", "a");
    await write(f.rootPath, "b.txt", "b");
    await f.start();
    methods.length = 0;
    expect(await f.remove("a.txt")).toMatchObject({ ok: true });
    // The change returned only after a release landed.
    expect(failuresLeft).toBe(0);
    expect(methods.filter(method => method === "capture.release").length).toBeGreaterThanOrEqual(failures + 1);
    expect(methods).not.toContain("workspace.close");
    expect(await f.remove("b.txt")).toMatchObject({ ok: true });
    await f.engine().stop();
  });

  it("keeps releasing through a stop until the engine confirms, and stops only afterwards", async () => {
    let stopping: Promise<void> | undefined;
    const events: string[] = [];
    const f = await fixture({ beforeRequest: request => {
      if (request.method === "capture.release" && stopping === undefined) {
        // The capture starts stopping while the engine is too busy to release.
        stopping = f.engine().stop();
        throw new Error("OVERLOADED: the engine is busy");
      }
      if (request.method === "capture.release") events.push("released");
      if (stopping !== undefined && request.method === "capture.flush") events.push("flushed");
    } });
    await write(f.rootPath, "a.txt", "a");
    await f.start();
    expect(await f.remove("a.txt")).toMatchObject({ ok: true });
    expect(stopping).toBeDefined();
    await stopping;
    // The release landed before the stop's own flush went through the gate.
    expect(events[0]).toBe("released");
  });

  it("refuses to overwrite a folder that holds the source, before anything changes", async () => {
    const f = await fixture();
    await write(f.rootPath, "a/b/c.txt", "c");
    await write(f.rootPath, "a/other.txt", "other");
    const seen = await f.start();
    expect(await f.move("a/b", "a", named, true)).toMatchObject({ ok: false, reason: expect.stringContaining("one holds the other") });
    await f.settle();
    expect(await readFile(join(f.rootPath, "a/b/c.txt"), "utf8")).toBe("c");
    expect(await readFile(join(f.rootPath, "a/other.txt"), "utf8")).toBe("other");
    expect(await f.added(seen)).toEqual([]);
    await f.engine().stop();
  });
});

describe("agent move and delete admission", () => {
  // Runs the admission inside a stand-in for the capture seam and fails the
  // test if anything is recorded or the disk is touched.
  async function refusingFixture() {
    const f = await fixture();
    const engine: Omit<AuthoredPathChanges, "policy"> = {
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

  it.each(["../escape.txt", ".dohc/engine", "shared-with-me/a.txt", ".env", "notes.md/../../x"])("refuses %s", async path => {
    const f = await refusingFixture();
    await write(f.rootPath, "a.txt", "a");
    expect(await f.move(path, "moved.txt")).toMatchObject({ ok: false });
    expect(await f.move("a.txt", path)).toMatchObject({ ok: false });
    expect(await f.remove(path)).toMatchObject({ ok: false });
    expect(f.recorded.recordDisk).not.toHaveBeenCalled();
    expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("a");
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

  it("refuses a move into an excluded or secret destination", async () => {
    const f = await refusingFixture();
    await write(f.rootPath, "a.txt", "a");
    await write(f.rootPath, ".dohc/files.toml", '[[rule]]\npath = "hidden/**"\ntracked = false\n');
    expect(await f.move("a.txt", "hidden/a.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("History cannot record") });
    // Overwrite deletes the destination, so a secret inside it refuses the move too.
    await write(f.rootPath, "dest/.env", "TOKEN=1");
    expect(await f.move("a.txt", "dest", true)).toMatchObject({ ok: false, reason: expect.stringContaining("History cannot record") });
    expect(f.recorded.recordDisk).not.toHaveBeenCalled();
  });

  it("checks where a link leads as well as how the path is spelled", async () => {
    const f = await refusingFixture();
    await write(f.rootPath, "secrets/.env", "TOKEN=1");
    const outside = await createTestScratch("dohc-moves-outside-");
    await symlink(join(f.rootPath, "secrets"), join(f.rootPath, "alias"), process.platform === "win32" ? "junction" : "dir");
    await symlink(outside, join(f.rootPath, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(await f.remove("alias/.env")).toMatchObject({ ok: false });
    expect(await f.remove("escape/x.txt")).toMatchObject({ ok: false });
    expect(f.recorded.recordDisk).not.toHaveBeenCalled();
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
