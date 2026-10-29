import { createEngineFileResolver, workspaceFileRef } from "./resolveEngineFiles";
import type { WorkspaceFileRef } from "@dohc/workspace-contracts/workspace-ref";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import * as fsPromises from "node:fs/promises";
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { DaemonRefusalError, VERSIONED_METHOD, type Request } from "@dohc/workspace-engine-client";
import { EngineDaemonUnavailableError, EngineWorkspaceSessionsClosedError, EngineWorkspaceShuttingDownError } from "@dohc/workspace-engine-client/daemon";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "./testTemp";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { createWorkspaceEngineCapture, type AuthoredPathChanges, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { admitPath, deleteWorkspacePathByHand, moveWorkspacePathByHand, prepareDeleteWorkspacePathAs, prepareMoveWorkspacePathAs, type PathChangeOptions } from "./workspaceFileMoves";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import { desktopRecordEditContext } from "./desktopRecordEdits";
import { listEngineMomentsForIpc } from "../ipc/engineHistoryIpc";
import { neutralHistoryPresentations } from "../testing/historyPageFixture";
import { engineMomentSourceLabel } from "../renderer/workbench/EngineHistory";
import { openedLocalState } from "../testing/preparedLocalState";
import { datalessCandidates, withICloudCheck } from "../testing/iCloudCheck";
import { readLocalStateFrom } from "./workspaceLocalState";
import { forceStoredNameListing } from "../testing/storedNameListing";
import * as storedEntryPaths from "./storedEntryPath";

vi.mock("./storedEntryPath", async importOriginal => ({ ...await importOriginal<typeof import("./storedEntryPath")>() }));

// Filesystem refusals a test switches on for chosen paths.
const faults = vi.hoisted(() => ({} as {
  unlink?: (path: string) => boolean | Promise<boolean>;
  readdir?: (path: string) => boolean;
  // Runs just before a hard link is made.
  link?: (from: string, to: string) => Promise<void>;
  readPolicy?: () => void;
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
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith(join(".dohc", "files.toml"))) faults.readPolicy?.();
      return actual.readFile(...args);
    }) as typeof actual.readFile,
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
  for (const folder of [false, true]) {
    for (const sameName of [false, true]) {
      it(`keeps a local symlink destination in its own folder for a ${folder ? "folder" : "file"} ${sameName ? "drag" : "rename"}`, async () => {
        const f = await fixture();
        const from = folder ? "a/notes" : "a/notes.md";
        const to = `b/${sameName ? "notes" : "link"}${folder ? "" : ".md"}`;
        await write(f.rootPath, folder ? `${from}/content.md` : from, "body");
        await mkdir(join(f.rootPath, "b"));
        await symlink(join(f.rootPath, from), join(f.rootPath, to), folder ? "dir" : "file");
        const seen = await f.start();
        try {
          await expect(f.moveByHand(from, to)).rejects.toThrow(folder ? /EPERM|ENOTDIR/u : `${to} already exists.`);
          expect(await readdir(join(f.rootPath, "a"))).toEqual([folder ? "notes" : "notes.md"]);
          expect(await readdir(join(f.rootPath, "b"))).toEqual([sameName ? (folder ? "notes" : "notes.md") : (folder ? "link" : "link.md")]);
          expect((await lstat(join(f.rootPath, to))).isSymbolicLink()).toBe(true);
          expect(await readFile(join(f.rootPath, folder ? `${from}/content.md` : from), "utf8")).toBe("body");
          expect(await f.added(seen)).toEqual([]);
        } finally { await f.engine().stop(); }
      });
    }
  }

  describe("stored endpoint names", () => {
    const platform = process.platform;
    afterEach(() => {
      vi.restoreAllMocks();
      Object.defineProperty(process, "platform", { value: platform });
    });
    const lookupCase = (root: string) => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const original = fsPromises.realpath.bind(fsPromises);
      vi.spyOn(fsPromises, "realpath").mockImplementation(async path => {
        const resolved = await original(path);
        return String(path).startsWith(`${root}${sep}`) ? String(path) : resolved;
      });
    };
    const probeCase = async (root: string, context: { skip(note: string): void }) => {
      await write(root, "Notes.md", "body");
      if (!existsSync(join(root, "notes.md"))) context.skip("this disk keeps case apart");
    };

    for (const operation of ["move", "delete"] as const) {
      it(`passes an alias ${operation} endpoint to capture under its stored name`, async context => {
        const f = await fixture();
        await probeCase(f.rootPath, context);
        await f.start();
        lookupCase(f.rootPath);
        const capture = vi.spyOn(f.engine(), "changePathsAs");
        try {
          const result = operation === "move" ? await f.move("notes.md", "other.md") : await f.remove("notes.md");
          expect(result).toMatchObject({ ok: true });
          expect(capture.mock.calls[0]?.[0][0]).toBe("Notes.md");
        } finally { await f.engine().stop(); }
      });
    }

    for (const overwrite of [false, true]) {
      it(`completes a Linux case-only rename with overwrite ${overwrite}`, async context => {
        const f = await fixture();
        await probeCase(f.rootPath, context);
        const seen = await f.start();
        lookupCase(f.rootPath);
        try {
          expect(await f.move("Notes.md", "notes.md", named, overwrite)).toMatchObject({ ok: true });
          expect(await readdir(f.rootPath)).toContain("notes.md");
          expect(await f.added(seen)).toContainEqual({ operation: "rename", path: "notes.md", agentId: named.agentId });
        } finally { await f.engine().stop(); }
      });
    }

    it("refuses a Linux CLI move that only retypes the source folder before recording a move", async context => {
      const requests: string[] = [];
      const f = await fixture({ beforeRequest: request => { requests.push(request.method); } });
      await write(f.rootPath, "Docs/a.md", "body");
      if (!existsSync(join(f.rootPath, "docs/a.md"))) context.skip("this disk keeps case apart");
      const seen = await f.start();
      requests.length = 0;
      lookupCase(f.rootPath);
      const mutation = vi.spyOn(fsPromises, "rename");
      try {
        expect(await f.move("docs/a.md", "Docs/a.md")).toEqual({ ok: false, path: "docs/a.md",
          reason: "Cannot move docs/a.md to Docs/a.md: one holds the other. Choose a destination outside both." });
        expect(mutation).not.toHaveBeenCalled();
        expect(requests).not.toContain(VERSIONED_METHOD.textRename);
        expect(await f.added(seen)).toEqual([]);
        expect(await readdir(join(f.rootPath, "Docs"))).toEqual(["a.md"]);
        expect(await readFile(join(f.rootPath, "Docs", "a.md"), "utf8")).toBe("body");
      } finally { await f.engine().stop(); }
    });

    for (const byHand of [false, true]) {
      it(`keeps the stored parent in History for a case-only ${byHand ? "local" : "CLI"} rename through an alias parent`, async context => {
        const f = await fixture();
        await write(f.rootPath, "Docs/notes.md", "body");
        if (!existsSync(join(f.rootPath, "docs/notes.md"))) context.skip("this disk keeps case apart");
        const seen = await f.start();
        lookupCase(f.rootPath);
        try {
          if (byHand) expect(await f.moveByHand("docs/notes.md", "docs/Notes.md")).toMatchObject({ path: "docs/Notes.md" });
          else expect(await f.move("docs/notes.md", "docs/Notes.md")).toMatchObject({ ok: true });
          expect(await f.added(seen)).toContainEqual({ operation: "rename", path: "Docs/Notes.md", agentId: byHand ? undefined : named.agentId });
          expect(await readdir(join(f.rootPath, "Docs"))).toEqual(["Notes.md"]);
        } finally { await f.engine().stop(); }
      });

      it(`reads the stored source ${byHand ? "three" : "two"} times for an ordinary ${byHand ? "local" : "CLI"} move`, async () => {
        const f = await fixture();
        await write(f.rootPath, "Docs/a.md", "body");
        await f.start();
        lookupCase(f.rootPath);
        const stored = vi.spyOn(storedEntryPaths, "storedEntryPath");
        try {
          if (byHand) await f.moveByHand("Docs/a.md", "archive.md");
          else expect(await f.move("Docs/a.md", "archive.md")).toMatchObject({ ok: true });
          expect(stored.mock.calls.filter(([, path]) => path === join(f.rootPath, "Docs", "a.md"))).toHaveLength(byHand ? 3 : 2);
        } finally { vi.restoreAllMocks(); await f.engine().stop(); }
      });
    }

    for (const native of [false, true]) {
      for (const byHand of [false, true]) {
        it(`allows a ${byHand ? "local" : "CLI"} alias source parent when the destination keeps its stored name with ${native ? "native" : "Linux"} realpath`, async context => {
          const f = await fixture();
          await write(f.rootPath, "Docs/a.md", "body");
          if (!existsSync(join(f.rootPath, "docs/a.md"))) context.skip("this disk keeps case apart");
          const seen = await f.start();
          if (!native) lookupCase(f.rootPath);
          const stored = vi.spyOn(storedEntryPaths, "storedEntryPath");
          try {
            if (byHand) expect(await f.moveByHand("docs/a.md", "Docs/b.md")).toMatchObject({ path: "Docs/b.md" });
            else expect(await f.move("docs/a.md", "Docs/b.md")).toMatchObject({ ok: true });
            expect(await f.added(seen)).toContainEqual({ operation: "rename", path: "Docs/b.md", agentId: byHand ? undefined : named.agentId });
            if (byHand) expect(stored.mock.calls.filter(([, path]) => [join(f.rootPath, "docs"), join(f.rootPath, "Docs")].includes(path))).toHaveLength(4);
          } finally { await f.engine().stop(); }
        });
      }
    }

    it("reports a missing CLI source when only the destination parent exists", async context => {
      const f = await fixture();
      await write(f.rootPath, "docs/b.md", "body");
      if (existsSync(join(f.rootPath, "Docs/b.md"))) context.skip("this disk ignores case");
      await f.start();
      lookupCase(f.rootPath);
      try {
        expect(await f.move("Docs/a.md", "docs/a.md")).toMatchObject({ ok: false,
          reason: "Nothing is at Docs/a.md. List the folder to see what is there." });
      } finally { await f.engine().stop(); }
    });

    it("keeps real case-colliding hard-link names distinct during admission", async context => {
      const root = await createTestScratch("dohc-case-links-");
      await write(root, "Notes.md", "body");
      if (existsSync(join(root, "notes.md"))) context.skip("this disk ignores case");
      await fsPromises.link(join(root, "Notes.md"), join(root, "notes.md"));
      lookupCase(root);
      const listing = vi.spyOn(fsPromises, "readdir");
      expect((await admitPath(root, "Notes.md")).physical).toBe("Notes.md");
      expect((await admitPath(root, "notes.md")).physical).toBe("notes.md");
      expect(listing).not.toHaveBeenCalled();
    });

    for (const unknown of [false, true]) {
      it(`${unknown ? "accepts an unreadable result after" : "refuses a no-op"} case-only rename`, async context => {
        const requests: string[] = [];
        const f = await fixture({ beforeRequest: request => { requests.push(request.method); } });
        await probeCase(f.rootPath, context);
        await f.start();
        lookupCase(f.rootPath);
        const original = fsPromises.rename.bind(fsPromises);
        const listing = fsPromises.readdir.bind(fsPromises);
        vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
          if (String(from) !== join(f.rootPath, "Notes.md")) return original(from, to);
          if (unknown) {
            await original(from, to);
            vi.spyOn(fsPromises, "readdir").mockImplementation((path, options) => {
              if (String(path) === f.rootPath) throw Object.assign(new Error("unreadable"), { code: "EIO" });
              return listing(path, options);
            });
          }
        });
        try {
          const result = await f.move("Notes.md", "notes.md");
          if (unknown) {
            expect(result).toMatchObject({ ok: true });
            expect(requests).toContain(VERSIONED_METHOD.textRename);
          } else {
            expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("This disk kept the name Notes.md.") });
            expect(requests).not.toContain(VERSIONED_METHOD.textRename);
            expect(await readFile(join(f.rootPath, "Notes.md"), "utf8")).toBe("body");
          }
        } finally { vi.restoreAllMocks(); await f.engine().stop(); }
      });
    }

    for (const native of [false, true]) {
      for (const destination of ["docs/a.md", "docs/b.md"]) {
        it(`refuses a CLI parent case change to ${destination} with ${native ? "native" : "Linux"} realpath`, async context => {
          const f = await fixture();
          await write(f.rootPath, "Docs/a.md", "body");
          if (!existsSync(join(f.rootPath, "docs/a.md"))) context.skip("this disk keeps case apart");
          await f.start();
          if (native) Object.defineProperty(process, "platform", { value: platform });
          else lookupCase(f.rootPath);
          const mutation = vi.spyOn(fsPromises, "rename");
          try {
            expect(await f.move("Docs/a.md", destination)).toMatchObject({ ok: false,
              reason: `dohc did not move Docs/a.md to ${destination}. The folder is named Docs, not docs. Use that name, or rename the folder first.` });
            expect(mutation).not.toHaveBeenCalled();
          } finally { await f.engine().stop(); }
        });
      }
    }

    it.each(["move", "delete"])("refuses unknown CLI %s endpoint identity before capture", async operation => {
      const f = await fixture();
      await write(f.rootPath, "a.md", "body");
      await f.start();
      lookupCase(f.rootPath);
      forceStoredNameListing(join(f.rootPath, "a.md"));
      vi.spyOn(fsPromises, "readdir").mockRejectedValue(Object.assign(new Error("unreadable"), { code: "EIO" }));
      const capture = vi.spyOn(f.engine(), "changePathsAs");
      try {
        const result = operation === "move" ? await f.move("a.md", "b.md") : await f.remove("a.md");
        expect(result).toMatchObject({ ok: false, reason: operation === "move"
          ? expect.stringContaining("dohc could not tell which files or folders on disk")
          : "dohc did not delete a.md. dohc could not tell which file or folder on disk it is. Check it in your file manager before trying again." });
        expect(capture).not.toHaveBeenCalled();
      } finally { vi.restoreAllMocks(); await f.engine().stop(); }
    });

    it("names the first changed folder in a nested CLI move", async context => {
      const f = await fixture();
      await write(f.rootPath, "base/Docs/sub/a.md", "body");
      if (!existsSync(join(f.rootPath, "base/docs/sub/a.md"))) context.skip("this disk keeps case apart");
      await f.start();
      lookupCase(f.rootPath);
      try {
        expect(await f.move("base/dOCS/sub/a.md", "base/docs/sub/b.md")).toMatchObject({ ok: false,
          reason: "dohc did not move base/dOCS/sub/a.md to base/docs/sub/b.md. The folder is named Docs, not docs. Use that name, or rename the folder first." });
      } finally { await f.engine().stop(); }
    });

    it("refuses unknown CLI parent identity before capture", async context => {
      const f = await fixture();
      await write(f.rootPath, "Docs/a.md", "body");
      if (!existsSync(join(f.rootPath, "docs/a.md"))) context.skip("this disk keeps case apart");
      await f.start();
      lookupCase(f.rootPath);
      vi.spyOn(fsPromises, "readdir").mockRejectedValue(Object.assign(new Error("unreadable"), { code: "EIO" }));
      const capture = vi.spyOn(f.engine(), "changePathsAs");
      try {
        expect(await f.move("Docs/a.md", "docs/b.md")).toMatchObject({ ok: false,
          reason: expect.stringContaining("dohc could not tell which files or folders on disk") });
        expect(capture).not.toHaveBeenCalled();
      } finally { vi.restoreAllMocks(); await f.engine().stop(); }
    });
  });

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

  it.each([
    ["a control character", { ...named, agentId: "Client\u0085name" }],
    ["an oversized field", { ...named, agentId: "x".repeat(513) }],
  ])("refuses an author with %s before anything on disk changes", async (_case, author) => {
    const methods: string[] = [];
    const f = await fixture({ beforeRequest: request => { methods.push(request.method); } });
    await write(f.rootPath, "a.txt", "a");
    await write(f.rootPath, "dir/b.txt", "b");
    await write(f.rootPath, "dest/c.txt", "c");
    const seen = await f.start();
    methods.length = 0;
    // Every disk change dohc attempts, so a rollback cannot hide one.
    const attempted: string[] = [];
    faults.mutate = (syscall, path) => { attempted.push(`${syscall} ${path}`); };
    try {
      expect(await f.move("a.txt", "moved.txt", author)).toEqual({ ok: false, path: "a.txt", reason: "invalid-metadata" });
      expect(await f.move("dir", "dest", author, true)).toEqual({ ok: false, path: "dir", reason: "invalid-metadata" });
      expect(await f.remove("dir", author)).toEqual({ ok: false, deleted: [], path: "dir", reason: "invalid-metadata" });
    } finally { delete faults.mutate; }
    expect(attempted).toEqual([]);
    // The preflight refuses; from there no document settles, capture never flushes or holds, and nothing is recorded.
    expect(methods.filter(method => method === VERSIONED_METHOD.textCheckMove)).toHaveLength(3);
    const preflight = methods.slice(methods.indexOf(VERSIONED_METHOD.textCheckMove));
    expect(preflight.filter(method => method.startsWith("ydoc.") || method.startsWith("capture."))).toEqual([]);
    for (const method of [VERSIONED_METHOD.textRename, VERSIONED_METHOD.textDelete, VERSIONED_METHOD.textRollback]) {
      expect(methods).not.toContain(method);
    }
    expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(f.rootPath, "dir/b.txt"), "utf8")).toBe("b");
    expect(await readFile(join(f.rootPath, "dest/c.txt"), "utf8")).toBe("c");
    expect(existsSync(join(f.rootPath, "moved.txt"))).toBe(false);
    expect(await f.workspaceTrash()).toEqual([]);
    expect(f.trashItem).not.toHaveBeenCalled();
    await f.settle();
    expect(await f.added(seen)).toEqual([]);
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

  it("keeps a file another program writes at the source while the move places the file", async () => {
    const f = await fixture({ beforeRequest: async request => {
      if (request.method === VERSIONED_METHOD.textRename) await write(f.rootPath, "a.txt", "theirs");
    } });
    await write(f.rootPath, "a.txt", "mine");
    const seen = await f.start();
    expect(await f.move("a.txt", "b.txt")).toMatchObject({ ok: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/), fromPath: "a.txt", toPath: "b.txt" });
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
      if (request.method === VERSIONED_METHOD.textDelete) faults.readdir = path => path.includes(join(".dohc", "local", "trash"));
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
    expect((await readdir(join(f.rootPath, ".dohc/local/trash", staged!))).sort()).toEqual(["1.txt", "2.txt"]);
    await f.engine().stop();
  });

  it("puts a file back even when its staged name cannot be removed, leaving a spare copy in the trash", async () => {
    const f = await fixture({ beforeRequest: request => {
      if (request.method === VERSIONED_METHOD.textDelete) faults.unlink = path => path.includes(join(".dohc", "local", "trash")) && path.endsWith("2.txt");
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
    expect(await readdir(join(f.rootPath, ".dohc/local/trash", staged!))).toEqual(["2.txt"]);
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
    expect((await readdir(join(f.rootPath, ".dohc/local/trash", staged!))).sort()).toEqual(["1.txt", "2.txt"]);
    await f.engine().stop();
  });

  it("sends the deleted file to the system trash, never a new file another program put at its place", async () => {
    // Another program writes note.txt once History has recorded the delete.
    const f = await fixture({ afterRequest: async request => {
      if (request.method === VERSIONED_METHOD.textDelete) await write(f.rootPath, "note.txt", "theirs");
    } });
    await write(f.rootPath, "note.txt", "mine");
    await f.start();
    expect(await f.remove("note.txt")).toMatchObject({ ok: true, path: "note.txt", trashed: true });
    expect(f.trashItem).toHaveBeenCalledOnce();
    expect(f.trashItem.mock.calls[0]?.[0]).toContain(join(".dohc", "local", "trash"));
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
    expect(result).toMatchObject({ ok: true, path: "note.txt", trashed: false, trashPath: expect.stringMatching(/^\.dohc\/local\/trash\//) });
    const kept = await f.workspaceTrash();
    expect(kept).toHaveLength(1);
    expect(await readFile(join(f.rootPath, ".dohc/local/trash", kept[0]!), "utf8")).toBe("keep me");
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

  // iCloud Drive can leave a file's bytes only in iCloud. An agent's delete
  // stages in .dohc/local/trash, which iCloud Drive skips, so it moves
  // nothing whose dataless flag is set. A sparse file is the candidate.
  it.skipIf(process.platform === "win32")("refuses an agent's delete of a file or folder only in iCloud Drive, and moves nothing", async () => {
    const f = await fixture();
    await write(f.rootPath, "notes/kept.md", "here");
    for (const path of ["evicted.bin", "notes/evicted.bin"]) { await write(f.rootPath, path, ""); await truncate(join(f.rootPath, path), 4096); }
    await f.start();
    await withICloudCheck(datalessCandidates, async () => {
      expect(await f.remove("evicted.bin")).toEqual({ ok: false, deleted: [], path: "evicted.bin",
        reason: "dohc did not move evicted.bin to the workspace trash because it is only in iCloud Drive. Download it, then try again." });
      expect(await f.remove("notes")).toEqual({ ok: false, deleted: [], path: "notes",
        reason: "dohc did not move notes to the workspace trash because some of it is only in iCloud Drive. Download it, then try again." });
    });
    expect((await lstat(join(f.rootPath, "evicted.bin"))).size).toBe(4096);
    expect((await lstat(join(f.rootPath, "notes/evicted.bin"))).size).toBe(4096);
    expect(await readFile(join(f.rootPath, "notes/kept.md"), "utf8")).toBe("here");
    expect(await f.workspaceTrash()).toEqual([]);
    expect(f.trashItem).not.toHaveBeenCalled();
    await f.engine().stop();
  });

  // A failed move goes back through the workspace trash. When it can't go
  // there, it stays where it was moved, and the note says why.
  it.skipIf(process.platform === "win32").each([
    ["part of it is only in iCloud Drive", "because some of it is only in iCloud Drive"],
    ["the workspace trash is not ready", "because dohc could not move it to the workspace trash to put it back"],
  ] as const)("says why a failed move stays at its target when %s", async (cause, because) => {
    const f = await fixture({ beforeRequest: refusedFor(VERSIONED_METHOD.textRename, "dir/2.txt") });
    for (const n of [1, 2]) await write(f.rootPath, `dir/${n}.txt`, String(n));
    await write(f.rootPath, "dir/evicted.bin", "");
    await truncate(join(f.rootPath, "dir/evicted.bin"), 4096);
    await f.start();
    if (cause === "the workspace trash is not ready") readLocalStateFrom(null);
    const result = await withICloudCheck(datalessCandidates, () => f.move("dir", "moved"));
    expect(result).toMatchObject({ ok: false, path: "dir",
      reason: `History refused dir/2.txt. History still shows moved/2.txt at dir/2.txt. It stays at moved, ${because}. Rename it back yourself.` });
    expect((await readdir(join(f.rootPath, "moved"))).sort()).toEqual(["1.txt", "2.txt", "evicted.bin"]);
    expect(existsSync(join(f.rootPath, "dir"))).toBe(false);
    expect(await f.workspaceTrash()).toEqual([]);
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
    expect(await f.move("keep.txt", "Keep.txt")).toMatchObject({ ok: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/), fromPath: "keep.txt", toPath: "Keep.txt" });
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
    expect(await f.engine().fileObjectIdForPath("dir/large.png")).toBeNull();
    expect(await f.engine().fileObjectIdForPath("dir/large.txt")).toBeNull();
    const result = change === "move" ? await f.move("dir", "moved") : await f.remove("dir");
    const base = change === "move" ? "moved" : "dir";
    expect(await f.engine().fileObjectIdForPath(base + "/large.png")).toBeNull();
    expect(await f.engine().fileObjectIdForPath(base + "/large.txt")).toBeNull();
    expect(result).toMatchObject({ ok: true, withoutHistory: [base + "/people.csv"] });
    const kept = change === "move" ? join(f.rootPath, "moved") : await f.systemTrashed("dir");
    const retained = await readFile(join(kept, "people.csv"));
    expect(retained.byteLength).toBe(csv.byteLength);
    expect(retained.equals(csv)).toBe(true);
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
    const retained = await readFile(kept);
    expect(retained.byteLength).toBe(oversized.byteLength);
    expect(retained.equals(oversized)).toBe(true);
    expect(result.replaced.trashPath).toEqual(accepts ? undefined : expect.stringMatching(/^\.dohc\/local\/trash\//));
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
      const pending = f.engine().changePathsAs(["a.txt"], { operation: "delete", author: named, operationId: "dohc-operation:renew-test" },
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

describe("a person's delete", () => {
  it("settles, trashes the entry from its own place, then records the delete under the person", async () => {
    const trace: string[] = [];
    const f = await fixture({ beforeRequest: request => { trace.push(request.method); } });
    await write(f.rootPath, "tasks/hand.md", "# Hand made\n");
    const seen = await f.start();
    try {
      // An outside edit stays nobody's.
      await write(f.rootPath, "tasks/hand.md", "# Outside edit\n");
      await f.settle();
      const outside = (await f.rows()).filter(row => !seen.has(row.id));
      expect(outside.length).toBeGreaterThan(0);
      expect(outside.every(row => row.authors === undefined)).toBe(true);
      for (const row of outside) seen.add(row.id);
      trace.length = 0;
      f.trashItem.mockImplementationOnce(async (absolute: string) => {
        trace.push("trash");
        await rename(absolute, join(f.systemTrash, basename(absolute)));
      });
      expect(await f.removeByHand("tasks/hand.md")).toMatchObject({ trashed: true });
      // The system trash holds it from its own place, so its Restore returns it there.
      expect(f.trashItem.mock.calls).toEqual([[join(f.rootPath, "tasks/hand.md")]]);
      expect(await readFile(join(f.systemTrash, "hand.md"), "utf8")).toBe("# Outside edit\n");
      expect(existsSync(join(f.rootPath, "tasks/hand.md"))).toBe(false);
      expect(await f.workspaceTrash()).toEqual([]);
      expect(trace.indexOf("capture.hold")).toBeLessThan(trace.indexOf("trash"));
      expect(trace.indexOf("trash")).toBeLessThan(trace.indexOf(VERSIONED_METHOD.textDelete));
      expect((await f.rows()).filter(row => !seen.has(row.id))).toMatchObject([
        { operation: "delete", path: "tasks/hand.md", metadata: { origin: "local-file" }, authors: [person] },
      ]);
      // History shows it as the person's own file edit.
      const history = await listEngineMomentsForIpc(() => f.engine().listMoments(),
        { agent: () => undefined, person: () => "Ice", automation: () => null, named: () => "", presentations: neutralHistoryPresentations });
      if (!("moments" in history)) throw new Error("History was updating.");
      const shown = history.moments.find(moment => moment.operation === "delete" && moment.path === "tasks/hand.md");
      expect(shown).toMatchObject({ origin: "local-file", authors: [person] });
      expect(engineMomentSourceLabel(shown!)).toBe("Local file edit");
      expect(f.markDeleted).toHaveBeenCalledWith("tasks/hand.md");
    } finally { await f.engine().stop(); }
  });

  it("records the author as submitted, whatever its caller changes while the change waits", async () => {
    const f = await fixture();
    await write(f.rootPath, "tasks/hand.md", "# Hand made\n");
    const seen = await f.start();
    try {
      const authored = { operation: "delete" as const,
        author: { kind: "human" as const, humanId: "local:installation" }, operationId: "dohc-operation:snapshot" };
      const changing = f.engine().changePathsAs(["tasks/hand.md"], authored, async engine => {
        await rm(join(f.rootPath, "tasks/hand.md"));
        return await engine.delete("tasks/hand.md");
      }, () => ["tasks/hand.md"]);
      authored.author.humanId = "account-mallory";
      await changing;
      expect((await f.rows()).filter(row => !seen.has(row.id))).toMatchObject([
        { operation: "delete", path: "tasks/hand.md", authors: [person] },
      ]);
    } finally { await f.engine().stop(); }
  });

  it("refuses, moving nothing, when the path leads somewhere else once capture is held", async () => {
    let swapped = false;
    const f = await fixture({
      beforeRequest: async request => {
        if (request.method !== "capture.hold" || swapped) return;
        swapped = true;
        // Another program points the alias at another folder while the open document settles.
        await rename(join(f.rootPath, "alias"), join(f.rootPath, "alias-before"));
        await symlink(join(f.rootPath, "other"), join(f.rootPath, "alias"), process.platform === "win32" ? "junction" : "dir");
      },
    });
    await write(f.rootPath, "notes/a.md", "notes");
    await write(f.rootPath, "other/a.md", "other");
    await symlink(join(f.rootPath, "notes"), join(f.rootPath, "alias"), process.platform === "win32" ? "junction" : "dir");
    const seen = await f.start();
    try {
      await expect(f.removeByHand("alias/a.md")).rejects.toThrow("alias/a.md now leads somewhere else.");
      expect(swapped).toBe(true);
      expect(f.trashItem).not.toHaveBeenCalled();
      expect(f.markDeleted).not.toHaveBeenCalled();
      expect(await readFile(join(f.rootPath, "notes/a.md"), "utf8")).toBe("notes");
      expect(await readFile(join(f.rootPath, "other/a.md"), "utf8")).toBe("other");
      expect((await f.rows()).filter(row => !seen.has(row.id) && row.authors !== undefined)).toEqual([]);
    } finally { await f.engine().stop(); }
  });

  it("leaves the entry in the trash, whole, when History refuses its delete", async () => {
    const f = await fixture({ beforeRequest: refusedFor(VERSIONED_METHOD.textDelete, "tasks/hand.md") });
    await write(f.rootPath, "tasks/hand.md", "# Hand made\n");
    const seen = await f.start();
    try {
      await expect(f.removeByHand("tasks/hand.md")).rejects.toThrow("tasks/hand.md is in the system trash.");
      expect(await readFile(join(f.systemTrash, "hand.md"), "utf8")).toBe("# Hand made\n");
      expect(existsSync(join(f.rootPath, "tasks/hand.md"))).toBe(false);
      expect(f.markDeleted).toHaveBeenCalledWith("tasks/hand.md");
      expect((await f.rows()).filter(row => !seen.has(row.id) && row.authors !== undefined)).toEqual([]);
    } finally { await f.engine().stop(); }
  });

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

  it("trashes the entry recoverably without History when capture is unavailable", async () => {
    const f = await fixture();
    await write(f.rootPath, "tasks/hand.md", "# Hand made\n");
    const seen = await f.start();
    try {
      expect(await f.removeByHand("tasks/hand.md", null)).toMatchObject({ trashed: true });
      expect(await readFile(join(f.systemTrash, "hand.md"), "utf8")).toBe("# Hand made\n");
      expect(f.markDeleted).toHaveBeenCalledWith("tasks/hand.md");
      expect((await f.rows()).filter(row => !seen.has(row.id) && row.authors !== undefined)).toEqual([]);
    } finally { await f.engine().stop(); }
  });

  it("trashes a link as itself and never reaches what it leads to", async () => {
    const f = await fixture();
    const external = await createTestScratch("dohc-delete-link-");
    await write(external, "kept.txt", "outside");
    await mkdir(join(f.rootPath, "tasks"));
    await symlink(external, join(f.rootPath, "tasks/link"), process.platform === "win32" ? "junction" : "dir");
    const seen = await f.start();
    try {
      expect(await f.removeByHand("tasks/link")).toMatchObject({ trashed: true });
      expect(f.trashItem.mock.calls).toEqual([[join(f.rootPath, "tasks/link")]]);
      expect((await lstat(join(f.systemTrash, "link"))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(external, "kept.txt"), "utf8")).toBe("outside");
      expect((await f.rows()).filter(row => !seen.has(row.id) && row.authors !== undefined)).toEqual([]);
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

  // Windows refuses control characters in names, so only other hosts can hold one.
  it.skipIf(process.platform === "win32")("trashes a path the engine cannot address, as before History", async () => {
    const f = await fixture();
    const seen = await f.start();
    await write(f.rootPath, "notes/bell\u0007.md", "ring");
    try {
      expect(await f.removeByHand("notes/bell\u0007.md")).toMatchObject({ trashed: true });
      expect(f.trashItem.mock.calls).toHaveLength(1);
      expect(f.trashItem.mock.calls[0]?.[0].endsWith("bell\u0007.md")).toBe(true);
      expect(existsSync(join(f.rootPath, "notes/bell\u0007.md"))).toBe(false);
      expect((await f.rows()).filter(row => !seen.has(row.id))).toEqual([]);
    } finally { await f.engine().stop(); }
  });

  it("leaves a new entry that appears at the place alone", async () => {
    const f = await fixture({
      afterRequest: async request => {
        if (request.method === VERSIONED_METHOD.textDelete) await write(f.rootPath, "tasks/hand.md", "new");
      },
    });
    await write(f.rootPath, "tasks/hand.md", "# Hand made\n");
    const seen = await f.start();
    try {
      expect(await f.removeByHand("tasks/hand.md")).toMatchObject({ trashed: true });
      expect(await readFile(join(f.rootPath, "tasks/hand.md"), "utf8")).toBe("new");
      expect(await readFile(join(f.systemTrash, "hand.md"), "utf8")).toBe("# Hand made\n");
      expect((await f.rows()).filter(row => !seen.has(row.id) && row.operation === "delete")).toMatchObject([
        { path: "tasks/hand.md", authors: [person] },
      ]);
    } finally { await f.engine().stop(); }
  });
});

it("records a hand-made record as a local file edit under the person main read, signed out or in", async () => {
  const f = await fixture();
  await mkdir(join(f.rootPath, "tasks"));
  const seen = await f.start();
  const context = (humanId: string) => desktopRecordEditContext({
    capture: f.engine(), workspaceRoot: f.rootPath,
    person: { kind: "human", humanId },
    withAdapter: async () => null, onCaptureSettled: () => () => undefined, signal: new AbortController().signal,
  });
  try {
    // The renderer's caller names a display label, never the person.
    await context("local:installation").createFile("tasks/offline.md", "# Offline\n", createLocalChangeAuthor("Someone else"));
    await context("account-alice").createFile("tasks/signed-in.md", "# Signed in\n", createLocalChangeAuthor("Someone else"));
    const created = (await f.rows()).filter(row => !seen.has(row.id))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(created).toMatchObject([
      { path: "tasks/offline.md", metadata: { origin: "local-file" }, authors: [{ kind: "human", humanId: "local:installation" }] },
      { path: "tasks/signed-in.md", metadata: { origin: "local-file" }, authors: [{ kind: "human", humanId: "account-alice" }] },
    ]);
  } finally {
    await f.engine().stop();
  }
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

  it("lets a person's delete and a plain move finish without Undo, and say so", async () => {
    const f = await fixture();
    await write(f.rootPath, "a.txt", "a");
    await write(f.rootPath, "b.txt", "b");
    await write(f.rootPath, "c.txt", "c");
    await f.start();
    readLocalStateFrom(null);
    // The system trash is the reverse path.
    expect(await f.removeByHand("a.txt")).toMatchObject({ trashed: true, undo: { available: false,
      reason: "Delete finished. dohc could not save Undo information. Restore files from History or the system trash." } });
    expect(await readFile(join(f.systemTrash, "a.txt"), "utf8")).toBe("a");
    // Without the system trash there is none, so nothing moves.
    f.trashItem.mockRejectedValueOnce(new Error("no system trash on this volume"));
    await expect(f.removeByHand("b.txt")).rejects.toThrow(`dohc did not move b.txt to the workspace trash ${because["not-opened"]}`);
    expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("b");
    expect(await f.move("c.txt", "d.txt")).toMatchObject({ ok: true, undo: { available: false,
      reason: "Rename finished. dohc could not save Undo information. Rename it back yourself." } });
    expect(await readFile(join(f.rootPath, "d.txt"), "utf8")).toBe("c");
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

  it("changes identity after delete and recreate", async () => {
    const f = await fixture();
    await write(f.rootPath, "a.txt", "a");
    await f.start();
    try {
      const original = await f.reference("a.txt");
      await f.remove("a.txt");
      await f.settle();
      await write(f.rootPath, "a.txt", "a");
      await f.settle();
      expect((await f.reference("a.txt")).target).not.toEqual(original.target);
      expect(await f.resolve([original])).toEqual([{ status: "absent" }]);
    } finally { await f.engine().stop(); }
  });

  it("does not claim a failed folder move reached its destination", async () => {
    const f = await fixture({ beforeRequest: refusedFor(VERSIONED_METHOD.textRename, "dir/2.txt") });
    for (const n of [1, 2]) await write(f.rootPath, "dir/" + n + ".txt", String(n));
    await f.start();
    try {
      const refs = await Promise.all([f.reference("dir/1.txt"), f.reference("dir/2.txt")]);
      expect(await f.move("dir", "moved")).toMatchObject({ ok: false });
      await f.settle();
      const results = await f.resolve(refs);
      expect(results[0]).toMatchObject({ status: "found", path: "dir/1.txt", objectId: refs[0]!.target.objectId });
      expect(results.every(file => file.status === "absent" || (file.status === "found" && file.path.startsWith("dir/")))).toBe(true);
      expect(await f.engine().fileObjectIdForPath("moved/1.txt")).toBeNull();
    } finally { await f.engine().stop(); }
  });
});

describe("History operation admission",()=>{
  it("mints distinct operation IDs for move, agent delete and person delete",async()=>{
    const requests:Request[]=[];
    const f=await fixture({beforeRequest:request=>{requests.push(request);}});
    for(const name of ["move.txt","agent.txt","person.txt"]) await write(f.rootPath,name,name);
    await f.start();
    try {
      const moved = await f.move("move.txt","moved.txt");
      expect(moved).toMatchObject({ok:true});
      const removed = await f.remove("agent.txt");
      expect(removed).toMatchObject({ok:true});
      const personRemoved = await f.removeByHand("person.txt");
      expect(personRemoved).toMatchObject({trashed:true});
      const ids=requests.filter(r=>r.method==="capture.hold").map(r=>(r.params as {operationId?:string}).operationId).filter(id=>id!==undefined);
      expect(ids).toHaveLength(3);
      expect([moved, removed, personRemoved].map(result => "operationId" in result ? result.operationId : undefined)).toEqual(ids);
      expect(new Set(ids).size).toBe(3);
      for(const id of ids) expect(id).toMatch(/^dohc-operation:[a-f0-9-]{36}$/);
      for(const r of requests.filter(r=>r.method==="versionedText.rename" || r.method==="versionedText.delete")) expect(r.params).not.toHaveProperty("correlationId");
    } finally {await f.engine().stop();}
  });
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

it("limits move metadata reads to its roots and removes stale descendants without touching prefix siblings", async () => {
  let held = false;
  const requests: Request[] = [];
  const f = await fixture({ beforeRequest: async request => {
    requests.push(request);
    if (request.method === "capture.hold") { held = true; await rm(join(f.rootPath, "dir/stale.txt")); }
  } });
  for (const path of ["dir/kept.txt", "dir/stale.txt", "directory/sibling.txt"]) await write(f.rootPath, path, path);
  await f.start(); requests.length = 0;
  try {
    const sibling = await f.engine().fileObjectIdForPath("directory/sibling.txt");
    expect(await f.move("dir", "moved")).toMatchObject({ ok: true });
    expect(held).toBe(true);
    const holdIndex = requests.findIndex(request => request.method === "capture.hold");
    const lists = requests.slice(holdIndex).filter(request => request.method === VERSIONED_METHOD.textList);
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every(request => ["dir/", "moved/"].includes((request.params as { afterPath?: string }).afterPath ?? ""))).toBe(true);
    expect(await f.engine().fileObjectIdForPath("dir/stale.txt")).toBeNull();
    expect(await f.engine().fileObjectIdForPath("directory/sibling.txt")).toBe(sibling);
    expect(await f.engine().fileObjectIdForPath("moved/kept.txt")).not.toBeNull();
  } finally { await f.engine().stop(); }
});

it("cleans an exact root head that becomes oversized under the capture hold", async () => {
  const f = await fixture({ beforeRequest: async request => {
    if (request.method === "capture.hold") await write(f.rootPath, "a.txt", "x".repeat(11 * 1024 * 1024));
  } });
  await write(f.rootPath, "a.txt", "tracked first"); await f.start();
  try {
    expect(await f.engine().fileObjectIdForPath("a.txt")).not.toBeNull();
    expect(await f.move("a.txt", "b.txt")).toMatchObject({ ok: true, withoutHistory: ["b.txt"] });
    expect(await f.engine().fileObjectIdForPath("a.txt")).toBeNull();
    expect(await f.engine().fileObjectIdForPath("b.txt")).toBeNull();
    expect((await readFile(join(f.rootPath, "b.txt"))).length).toBe(11 * 1024 * 1024);
  } finally { await f.engine().stop(); }
});
