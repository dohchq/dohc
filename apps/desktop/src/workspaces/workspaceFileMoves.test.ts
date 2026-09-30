import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VERSIONED_METHOD, type Request } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "./testTemp";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { createWorkspaceEngineCapture, type AuthoredPathChanges, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { deleteWorkspacePathAs, moveWorkspacePathAs, type PathChangeOptions } from "./workspaceFileMoves";

// Filesystem refusals a test switches on for chosen paths.
const faults = vi.hoisted(() => ({} as {
  unlink?: (path: string) => boolean | Promise<boolean>;
  readdir?: (path: string) => boolean;
  // Runs just before a hard link is made.
  link?: (from: string, to: string) => Promise<void>;
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const refused = (syscall: string, path: string) =>
    Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${path}'`), { code: "EPERM", syscall, path });
  return {
    ...actual,
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
      rustEngineSessions: mockDaemonSessions({ rootPath, workspaceId, loopback: new VersionedLoopbackEngine(),
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
    .map(row => ({ operation: row.operation, path: row.path, agentId: row.author?.kind === "agent" ? row.author.agentId : undefined }))
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
      moveWorkspacePathAs(operation, { fromPath, toPath, ...(overwrite ? { overwrite } : {}) }, by, pathOptions()),
    remove: (path: string, by = named as typeof named | typeof unnamed) => deleteWorkspacePathAs(operation, path, by, pathOptions()) };
}

describe("agent moves and deletes", () => {
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
    expect(outside.every(row => row.author === undefined)).toBe(true);
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

  it("holds capture from before admission until the slow system trash finishes", async () => {
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
    const pending = f.remove("notes");
    await vi.waitFor(() => expect(events).toContain("trash started"));
    expect(events).not.toContain("capture.release");
    trashed.release();
    expect(await pending).toMatchObject({ ok: true });
    const hold = events.indexOf("capture.hold");
    expect(hold).toBeGreaterThan(events.lastIndexOf("capture.flush"));
    expect(events.slice(hold)).toContain(VERSIONED_METHOD.textDelete);
    expect(events.indexOf("capture.release")).toBeGreaterThan(events.indexOf("trash finished"));
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
    expect(await f.remove("dir")).toEqual({ ok: false, deleted: ["dir/1.txt"], path: "dir/2.txt", reason: expect.stringContaining("dir/2.txt") });
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
    const f = await fixture();
    await write(f.rootPath, "a.txt", "mine");
    const seen = await f.start();
    faults.link = async (_from, to) => {
      if (to.endsWith("b.txt")) await write(f.rootPath, "a.txt", "theirs");
    };
    try {
      expect(await f.move("a.txt", "b.txt")).toEqual({ ok: true, fromPath: "a.txt", toPath: "b.txt" });
    } finally { delete faults.link; }
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

  it("keeps a file another program writes at the destination while the staged source cannot be removed", async () => {
    const f = await fixture();
    await write(f.rootPath, "a.txt", "mine");
    const seen = await f.start();
    faults.unlink = async path => {
      if (!path.includes(join(".dohc", "trash")) || !path.endsWith("a.txt")) return false;
      await rm(join(f.rootPath, "b.txt"));
      await write(f.rootPath, "b.txt", "theirs");
      return true;
    };
    try {
      expect(await f.move("a.txt", "b.txt")).toEqual({ ok: true, fromPath: "a.txt", toPath: "b.txt" });
    } finally { delete faults.unlink; }
    expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("theirs");
    // The moved bytes stay in History and in a spare copy in the trash.
    const [spare] = (await f.workspaceTrash()).filter(entry => entry.endsWith("a.txt"));
    expect(await readFile(join(f.rootPath, ".dohc/trash", spare!), "utf8")).toBe("mine");
    await f.settle();
    expect(await f.added(seen)).toEqual([
      { operation: "rename", path: "b.txt", agentId: "Client name" },
      { operation: "write", path: "b.txt", agentId: undefined },
    ]);
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
    expect(await f.remove("note.txt")).toEqual({ ok: true, path: "note.txt", trashed: true });
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
    expect(await f.move("a.txt", "b.txt", named, true)).toEqual({ ok: true, fromPath: "a.txt", toPath: "b.txt" });
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
    const engine: AuthoredPathChanges = {
      recordDisk: vi.fn(async () => undefined),
      rename: vi.fn(async () => { throw new Error("Admission should have refused"); }),
      delete: vi.fn(async () => { throw new Error("Admission should have refused"); }),
      undoDelete: vi.fn(async () => undefined),
    };
    const changePathsAs = vi.fn(async (_paths: readonly string[], _authored: unknown, work: (changes: AuthoredPathChanges) => Promise<unknown>) =>
      await work(engine)) as WorkspaceEngineCapture["changePathsAs"];
    const options: PathChangeOptions = { capture: { changePathsAs }, requestId: "request", trashItem: vi.fn(), markDeleted: vi.fn() };
    return { ...f, changePathsAs, recorded: engine,
      move: (fromPath: string, toPath: string, overwrite?: boolean) =>
        moveWorkspacePathAs(f.operation, { fromPath, toPath, ...(overwrite ? { overwrite } : {}) }, named, options),
      remove: (path: string) => deleteWorkspacePathAs(f.operation, path, named, options) };
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
