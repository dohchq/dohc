import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import {
  createShareViewFiles,
  ShareViewMountRollbackError,
  type ResolvedShareViewFilesTarget,
  type PreparedShareViewFilesMount,
  type ShareViewFileChange,
  type ShareViewFilesDependencies,
  type ShareViewFilesStore,
  type ShareViewFilesTarget,
} from "./shareViewFiles";
import type { ShareViewFilesOwnerCapability } from "./shareViewFilesOwner";
import {
  readSharedViewProjectionDebt,
  shareViewFilesProjection,
  withShareViewRefreshLifecycleLock,
} from "./sharedView";
import { SharePinInvalidError } from "./shareViewRecords";
import { resolveRegisteredShareViewFilesTarget } from "./shareViewFilesTarget";
import {
  mountRootFor,
  shareViewFilesMountProjection,
} from "./shareMounts";
import {
  type WorkspaceOperationLease,
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
} from "./workspaceAssets";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "./workspaceTextLimits";
import { createTestScratch } from "./testTemp";
import { readLocalStateFrom } from "./workspaceLocalState";
import { deferred } from "../testing/deferred";

let materializationWriteSchedule: {
  path: string;
  attempts: number;
  firstWriteFinished: () => void;
  releaseFirstWrite: Promise<void>;
  secondWriteError: Error;
} | null = null;
let sidecarRenameFailure: { path: string; error: Error } | null = null;
let sidecarRemoveFailure: { path: string; error: Error } | null = null;
let afterMaterializationWrite: { path: string; run: () => void } | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (async (
      path: Parameters<typeof writeFile>[0],
      data: Parameters<typeof writeFile>[1],
      options?: Parameters<typeof writeFile>[2],
    ) => {
      const schedule = materializationWriteSchedule;
      const scheduled = schedule !== null && String(path) === schedule.path;
      if (scheduled) {
        schedule.attempts += 1;
        if (schedule.attempts === 2) throw schedule.secondWriteError;
      }
      const result = await actual.writeFile(path, data, options);
      const afterWrite = afterMaterializationWrite;
      if (afterWrite !== null && String(path) === afterWrite.path) {
        afterMaterializationWrite = null;
        afterWrite.run();
      }
      if (scheduled && schedule.attempts === 1) {
        schedule.firstWriteFinished();
        await schedule.releaseFirstWrite;
      }
      return result;
    }) as typeof writeFile,
    rename: (async (
      oldPath: Parameters<typeof rename>[0],
      newPath: Parameters<typeof rename>[1],
    ) => {
      const failure = sidecarRenameFailure;
      if (failure !== null && String(newPath) === failure.path) {
        sidecarRenameFailure = null;
        throw failure.error;
      }
      return actual.rename(oldPath, newPath);
    }) as typeof rename,
    rm: (async (
      path: Parameters<typeof rm>[0],
      options?: Parameters<typeof rm>[1],
    ) => {
      const failure = sidecarRemoveFailure;
      if (failure !== null && String(path) === failure.path) {
        sidecarRemoveFailure = null;
        throw failure.error;
      }
      return actual.rm(path, options);
    }) as typeof rm,
  };
});

// Writers of `.dohc/local` ask the engine's open. Here every view counts as
// opened once its `.dohc/local` exists.
const OPENED = { localStateReady: true };
beforeEach(() => {
  readLocalStateFrom({ currentBinding: () => OPENED, localStateOpenAt: async () => ({ current: () => true }) });
});

/** A view the engine has opened: its `.dohc/local` is made. */
async function workspaceRoot(): Promise<string> {
  const root = join(await createTestScratch("share-view-files-"), "workspace");
  await mkdir(join(root, ".dohc", "local"), { recursive: true, mode: 0o700 });
  return root;
}

/** Where a view's refresh records live. */
function recordsDir(rootPath: string): string {
  return join(rootPath, ".dohc", "local", "share-refresh");
}

async function writeRecord(rootPath: string, name: string, content: string): Promise<string> {
  await mkdir(recordsDir(rootPath), { recursive: true, mode: 0o700 });
  const path = join(recordsDir(rootPath), name);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

async function seedPendingMaterializationPaths(
  rootPath: string,
  paths: readonly string[],
): Promise<void> {
  await writeRecord(
    rootPath,
    "pending-materialization.json",
    JSON.stringify({
      counts: Object.fromEntries([...new Set(paths)].map((path) => [path, 1])),
    }),
  );
}

function target(
  rootPath: string,
  access: "view" | "comment" | "edit" = "edit",
): ResolvedShareViewFilesTarget {
  return {
    kind: "standalone",
    workspaceId: "workspace-a",
    storeWorkspaceId: "workspace-a",
    schedulingRootPath: rootPath,
    rootPath,
    shareId: "share-a",
    recipientUserId: "recipient-a",
    granterEmail: "granter@example.com",
    grantedSelector: { paths: [], versionId: "main", access },
    ended: false,
  };
}

function mountTarget(rootPath: string): ResolvedShareViewFilesTarget {
  return {
    ...target(rootPath, "view"),
    kind: "mount",
    workspaceId: "host-a",
    storeWorkspaceId: "host-a:share-a",
    schedulingRootPath: rootPath,
    mountLabel: "granter",
  };
}

function readStore(input: {
  text: string;
  paths?: Array<{ path: string; text: string }>;
}): ShareViewFilesStore {
  const rows = input.paths ?? [{ path: "notes/a.md", text: input.text }];
  return {
    listUnconfirmedSharePaths: vi.fn(async () => ({ paths: rows.map(row => row.path), unchecked: false, checked: 0 })),
    ensureMainVersion: vi.fn(async () => ({ id: "main" })),
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      const row = rows.find((entry) => entry.path === path);
      if (!row) return null;
      const bytes = Buffer.from(row.text, "utf8");
      return {
        path,
        contentKind: "text",
        text: row.text,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
    readBinaryFile: vi.fn(async () => null),
    listTextFileMetadata: vi.fn(async () =>
      rows.map((row, index) => ({
        path: row.path,
        objectId: `object-${index}`,
        contentKind: "text" as const,
        byteLength: Buffer.byteLength(row.text),
        sha256: createHash("sha256").update(row.text).digest("hex"),
        updatedAtMs: 1,
        latestMomentId: `moment-${index}`,
        hasYdocMarker: false,
      })),
    ),
  } as unknown as ShareViewFilesStore;
}

function mutableTextStore(input?: {
  initial?: Array<{ path: string; text: string; pending?: boolean }>;
  afterWrite?: (path: string) => void;
  beforeDelete?: (path: string) => void;
  afterRename?: (fromPath: string, toPath: string) => void;
  afterMetadataRead?: (read: number) => void | Promise<void>;
}): ShareViewFilesStore {
  const rows = new Map<
    string,
    {
      text: string;
      objectId: string;
      latestMomentId: string;
      accepted: boolean;
    }
  >();
  let nextId = 1;
  let metadataReads = 0;
  const moments = new Map<string, { payload: { before: null; after: { path: string; text: string } } }>();
  for (const initial of input?.initial ?? []) {
    const id = nextId++;
    rows.set(initial.path, {
      text: initial.text,
      objectId: `object-${id}`,
      latestMomentId: `moment-${id}`,
      accepted: !initial.pending,
    });
  }
  const snapshots = () =>
    [...rows.entries()].map(([path, row]) => ({
      objectId: row.objectId,
      versionId: "main",
      path,
      contentKind: "text" as const,
      sha256: createHash("sha256").update(row.text).digest("hex"),
      byteLength: Buffer.byteLength(row.text),
      text: row.text,
      updatedAtMs: nextId,
      latestMomentId: row.latestMomentId,
      metadata: { origin: "local-file" as const },
    }));
  return {
    listUnconfirmedSharePaths: vi.fn(async () => ({
      paths: [...rows.entries()].filter(([, row]) => !row.accepted).map(([path]) => path), unchecked: false, checked: 0,
    })),
    ensureMainVersion: vi.fn(async () => ({ id: "main" })),
    listTextFileMetadata: vi.fn(async () => {
      const rows = snapshots().map(
        ({ text: _text, metadata: _metadata, ...row }) => row,
      );
      metadataReads += 1;
      await input?.afterMetadataRead?.(metadataReads);
      return rows;
    }),
    getMoment: vi.fn(async ({ momentId }: { momentId: string }) => moments.get(momentId) ?? { payload: { before: null } }),
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      return snapshots().find((row) => row.path === path) ?? null;
    }),
    readBinaryFile: vi.fn(async () => null),
    writeTextFile: vi.fn(
      async ({ path, text, metadata }: { path: string; text: string; metadata?: { origin: string } }) => {
        const existing = rows.get(path);
        const id = nextId++;
        moments.set(`moment-${id}`, { payload: { before: null, after: { path, text } } });
        rows.set(path, {
          text,
          objectId: existing?.objectId ?? `object-${id}`,
          latestMomentId: `moment-${id}`,
          accepted: metadata?.origin === "sync",
        });
        input?.afterWrite?.(path);
        return {};
      },
    ),
    deleteTextFile: vi.fn(async ({ path }: { path: string }) => {
      input?.beforeDelete?.(path);
      rows.delete(path);
      return {};
    }),
    renameTextFile: vi.fn(
      async ({ fromPath, toPath }: { fromPath: string; toPath: string }) => {
        const row = rows.get(fromPath);
        if (!row) throw new Error(`Missing source: ${fromPath}`);
        rows.delete(fromPath);
        rows.set(toPath, {
          ...row,
          latestMomentId: `moment-${nextId++}`,
          accepted: false,
        });
        input?.afterRename?.(fromPath, toPath);
        return {};
      },
    ),
  } as unknown as ShareViewFilesStore;
}

const unusedReconcilePorts: Pick<
  ShareViewFilesDependencies,
  | "resolveRelay"
  | "pull"
  | "recordRefusals"
  | "markEnded"
  | "updateUnsavedPaths"
  | "retireTarget"
  | "assertProjectionRoot"
  | "createMount"
  | "removeMount"
> = {
  resolveRelay: async () => null,
  pull: async () => {
    throw new Error("Unexpected pull");
  },
  recordRefusals: async () => undefined,
  markEnded: async () => undefined,
  updateUnsavedPaths: async () => undefined,
  retireTarget: async () => undefined,
  assertProjectionRoot: async () => undefined,
  createMount: async () => undefined,
  removeMount: async () => ({ folderLeft: false }),
};

describe("ShareViewFiles", () => {
  // On a disk that ignores case, notes.md owns the one file and Notes.md is
  // held behind it (#2416). Saving, deleting or moving Notes.md would write
  // over notes.md's file, so each change is refused and nothing changes.
  it("refuses a change to a spelling held behind another one's file", async (context) => {
    const rootPath = await workspaceRoot();
    await writeFile(join(rootPath, "probe.md"), "");
    const ignoresCase = await lstat(join(rootPath, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootPath, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    const registered = target(rootPath);
    const store = mutableTextStore({ initial: [{ path: "notes.md", text: "n\n" }, { path: "Notes.md", text: "N\n" }] });
    await writeFile(join(rootPath, "notes.md"), "n\n");
    await writeRecord(rootPath, "share-collision-record.json", JSON.stringify({ shareId: registered.shareId, paths: ["Notes.md"] }));
    const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store });
    const requested = { kind: "standalone" as const, workspaceId: registered.workspaceId };
    const changes: ShareViewFileChange[] = [
      { kind: "save", path: "Notes.md", text: "edited\n", expectedContentHash: createHash("sha256").update("N\n").digest("hex") },
      { kind: "delete", path: "Notes.md" },
      { kind: "move", fromPath: "Notes.md", toPath: "moved.md" },
    ];
    for (const change of changes) {
      await expect(withStaleSensitiveWorkspaceOperation(rootPath, lease => files.change(lease, requested, change)))
        .rejects.toThrow("dohc did not change Notes.md. This machine treats Notes.md and notes.md as the same name.");
    }
    expect(store.writeTextFile).not.toHaveBeenCalled();
    expect(store.deleteTextFile).not.toHaveBeenCalled();
    expect(await readFile(join(rootPath, "notes.md"), "utf8")).toBe("n\n");
  });

  it.each(["end", "narrow"] as const)("lists unconfirmed changes without protecting them after %s", async restriction => {
    const rootPath = await workspaceRoot();
    const yaml = "tasks/automations.yaml";
    const draft = "tasks/draft.md";
    const accepted = "tasks/accepted.md";
    const registered = { ...target(rootPath), unsavedPaths: undefined as string[] | null | undefined,
      unconfirmedChanges: undefined as { paths: string[]; unchecked: boolean; checked: number } | undefined,
      grantedSelector: { paths: ["tasks"], versionId: null, access: "edit" as "edit" | "view" } };
    const initial = [{ path: yaml, text: "version: 1\nautomations: []\n" },
      { path: draft, text: "Retained record draft\n", pending: true }, { path: accepted, text: "Accepted by the owner\n" }];
    const store = mutableTextStore({ initial });
    await mkdir(join(rootPath, "tasks"), { recursive: true });
    for (const row of initial) await writeFile(join(rootPath, row.path), row.text);
    await writeFile(join(rootPath, yaml), `${initial[0]!.text}# Unsent edit\n`);
    const ports = { ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store,
      updateUnsavedPaths: async (_target: ResolvedShareViewFilesTarget, paths: string[]) => { registered.unsavedPaths = paths; },
      markEnded: async (_target: ResolvedShareViewFilesTarget, paths?: string[] | null, snapshot?: { paths: string[]; unchecked: boolean; checked: number }) => {
        registered.ended = true;
        if (paths !== undefined) registered.unsavedPaths = paths;
        if (snapshot !== undefined) registered.unconfirmedChanges = snapshot;
      },
      resolveRelay: async () => ({ baseUrl: "https://relay.example", token: "token" }),
      pull: vi.fn(async () => ({ fetched: 0, applied: 0, skipped: 0, refusals: [], refusalCount: 0,
        changedPaths: [], nextCursor: 1, commitCursor: async () => undefined })) };
    const files = createShareViewFiles(ports);
    const requested = { kind: "standalone" as const, workspaceId: registered.workspaceId };
    await withStaleSensitiveWorkspaceOperation(rootPath, async lease => {
      if (restriction === "end") await files.end(lease, requested, () => undefined);
      else await files.narrow(lease, requested, () => undefined, async (paths, snapshot) => {
        registered.grantedSelector.access = "view"; registered.unsavedPaths = paths; registered.unconfirmedChanges = snapshot;
      });
    });
    expect(registered.unsavedPaths).toEqual([]);
    expect(registered.unconfirmedChanges).toEqual({ paths: [yaml, draft], unchecked: false, checked: 0 });
    const capturedHead = (await store.readTextFile({ workspaceId: registered.workspaceId, versionId: "main", path: yaml }))!.latestMomentId;
    const saved = JSON.parse(JSON.stringify(registered)) as typeof registered;
    const restarted = createShareViewFiles({ ...ports, resolveTarget: () => saved });
    const moments = vi.mocked(store.writeTextFile).mock.calls.length;
    for (let pass = 0; pass < 3; pass += 1) {
      await withStaleSensitiveWorkspaceOperation(rootPath, lease => restarted.reconcile(lease, requested, "refresh"));
    }
    await withStaleSensitiveWorkspaceOperation(rootPath, lease => restarted.reconcile(lease, requested, "settle"));
    expect(saved.unsavedPaths).toEqual([]);
    expect(saved.unconfirmedChanges).toEqual(registered.unconfirmedChanges);
    expect(store.listUnconfirmedSharePaths).toHaveBeenCalledOnce();
    expect(store.writeTextFile).toHaveBeenCalledTimes(moments);
    expect(await readFile(join(rootPath, yaml), "utf8")).toContain("# Unsent edit");
    expect(await readFile(join(rootPath, draft), "utf8")).toBe(initial[1]!.text);
    if (restriction === "narrow") {
      const ownerText = "later owner update\n";
      const pulling = createShareViewFiles({ ...ports, resolveTarget: () => saved,
        pull: async () => {
          await store.writeTextFile({ workspaceId: saved.workspaceId, versionId: "main", path: yaml,
            text: ownerText, metadata: { origin: "sync" } });
          return { fetched: 1, applied: 1, skipped: 0, refusals: [], refusalCount: 0,
            changedPaths: [{ path: yaml, operation: "write", contentKind: "text" }], nextCursor: 2, commitCursor: async () => undefined };
        } });
      await withStaleSensitiveWorkspaceOperation(rootPath, lease => pulling.reconcile(lease, requested, "refresh"));
      expect(await readFile(join(rootPath, yaml), "utf8")).toBe(ownerText);
      expect(await store.readTextFile({ workspaceId: saved.workspaceId, versionId: "main", path: yaml })).toMatchObject({ text: ownerText });
      expect(await store.getMoment({ workspaceId: saved.workspaceId, momentId: capturedHead })).toMatchObject({
        payload: { after: { path: yaml, text: `${initial[0]!.text}# Unsent edit\n` } },
      });
      expect(store.listUnconfirmedSharePaths).toHaveBeenCalledOnce();
      vi.mocked(store.listUnconfirmedSharePaths).mockRejectedValueOnce(new Error("later check failed"));
      const ending = createShareViewFiles({ ...ports, resolveTarget: () => saved,
        markEnded: async (_target, paths, snapshot) => { saved.ended = true; saved.unsavedPaths = paths; saved.unconfirmedChanges = snapshot; } });
      await withStaleSensitiveWorkspaceOperation(rootPath, lease => ending.end(lease, requested, () => undefined));
      expect(saved.unconfirmedChanges).toEqual({ paths: [yaml, draft], unchecked: true, checked: 0 });
      expect(saved.unsavedPaths).toEqual([]);
    }
  });

  it.each(["end", "narrow"] as const)("keeps capture protection unchanged when status fails during %s", async restriction => {
    const rootPath = await workspaceRoot();
    const path = "notes.md";
    await writeFile(join(rootPath, path), "local edit\n");
    const registered = { ...target(rootPath), unsavedPaths: [] as string[] | null,
      unconfirmedChanges: undefined as { paths: string[]; unchecked: boolean; checked: number } | undefined };
    const store = mutableTextStore({ initial: [{ path, text: "owner version\n" }] });
    vi.mocked(store.listUnconfirmedSharePaths).mockRejectedValueOnce(new Error("status unavailable"));
    const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store,
      markEnded: async (_target, paths, snapshot) => { registered.unsavedPaths = paths!; registered.unconfirmedChanges = snapshot; } });
    await withStaleSensitiveWorkspaceOperation(rootPath, async lease => {
      const requested = { kind: "standalone" as const, workspaceId: registered.workspaceId };
      if (restriction === "end") await files.end(lease, requested, () => undefined);
      else await files.narrow(lease, requested, () => undefined, async (paths, snapshot) => {
        registered.unsavedPaths = paths; registered.unconfirmedChanges = snapshot;
      });
    });
    expect(registered.unsavedPaths).toEqual([]);
    expect(registered.unconfirmedChanges).toEqual({ paths: [], unchecked: true, checked: 0 });
    expect(await store.readTextFile({ workspaceId: registered.workspaceId, versionId: "main", path })).toMatchObject({ text: "local edit\n" });
  });

  it.each(["end", "narrow"] as const)("preserves a recipient-created record's unreadable edits before %s", async restriction => {
    const rootPath = await workspaceRoot();
    const path = "tasks/Created.md";
    const text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\nRecipient draft\n";
    const registered = { ...target(rootPath), unsavedPaths: undefined as string[] | null | undefined,
      grantedSelector: { paths: ["tasks"], versionId: null, access: "edit" as "edit" | "view" } };
    const store = mutableTextStore({ initial: [] });
    const ports = { ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store,
      markEnded: async (_target: ResolvedShareViewFilesTarget, unsavedPaths?: string[] | null) => {
        registered.ended = true; registered.unsavedPaths = unsavedPaths;
      } };
    const files = createShareViewFiles(ports);
    const requested = { kind: "standalone" as const, workspaceId: registered.workspaceId };
    await withStaleSensitiveWorkspaceOperation(rootPath, lease => files.change(lease, requested,
      { kind: "create", path, initialText: text }));
    await writeFile(join(rootPath, path), `${text}Unsent edit\n`);
    const original = fsPromises.lstat;
    const inspect = vi.spyOn(fsPromises, "lstat").mockImplementation((...args) => {
      if (String(args[0]) === join(rootPath, path)) return Promise.reject(Object.assign(new Error("locked"), { code: "EACCES" }));
      return original(...args);
    });
    try {
      await withStaleSensitiveWorkspaceOperation(rootPath, async lease => {
        if (restriction === "end") await files.end(lease, requested, () => undefined);
        else await files.narrow(lease, requested, () => undefined, async unsavedPaths => {
          registered.grantedSelector.access = "view"; registered.unsavedPaths = unsavedPaths;
        });
      });
      expect(registered.unsavedPaths).toEqual([path]);
      const saved = JSON.parse(JSON.stringify(registered)) as typeof registered;
      const restarted = createShareViewFiles({ ...ports, resolveTarget: () => saved });
      await withStaleSensitiveWorkspaceOperation(rootPath, lease => restarted.reconcile(lease, requested, "settle"));
      expect(await readFile(join(rootPath, path), "utf8")).toBe(`${text}Unsent edit\n`);
      expect(saved.unsavedPaths).toEqual([path]);
    } finally { inspect.mockRestore(); }
  });

  it.each(["end", "narrow"] as const)("captures an on-disk Edit change before %s and keeps it after a later read", async restriction => {
    const rootPath = await workspaceRoot();
    const path = "tasks/notes.md";
    const registered = { ...target(rootPath), grantedSelector: { paths: ["tasks"], versionId: null, access: "edit" as "edit" | "view" } };
    const store = mutableTextStore({ initial: [{ path, text: "owner version\n" }] });
    await mkdir(join(rootPath, "tasks"), { recursive: true });
    await writeFile(join(rootPath, path), "recipient agent edit\n");
    const markEnded = vi.fn(async () => { registered.ended = true; });
    const retireTarget = vi.fn(async () => undefined);
    const pull = vi.fn(unusedReconcilePorts.pull);
    const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => registered,
      openStore: () => store, markEnded, retireTarget, pull });
    const requested = { kind: "standalone" as const, workspaceId: registered.workspaceId };
    await withStaleSensitiveWorkspaceOperation(rootPath, async lease => {
      if (restriction === "end") await files.end(lease, requested, () => undefined);
      else await files.narrow(lease, requested, () => undefined, async () => { registered.grantedSelector.access = "view"; });
    });
    expect(store.writeTextFile).toHaveBeenCalledWith(expect.objectContaining({ path, text: "recipient agent edit\n", metadata: { origin: "local-file" } }));
    await withStaleSensitiveWorkspaceOperation(rootPath, lease => files.reconcile(lease, requested, "settle"));
    expect(await readFile(join(rootPath, path), "utf8")).toBe("recipient agent edit\n");
    expect(await store.readTextFile({ workspaceId: registered.workspaceId, versionId: "main", path })).toMatchObject({ text: "recipient agent edit\n" });
    expect(pull).not.toHaveBeenCalled();
    if (restriction === "end") {
      expect(markEnded.mock.invocationCallOrder[0]).toBeLessThan(retireTarget.mock.invocationCallOrder[0]!);
      expect(vi.mocked(store.writeTextFile).mock.invocationCallOrder[0]).toBeLessThan(markEnded.mock.invocationCallOrder[0]!);
    }
  });
  it.each(["end", "narrow"] as const)("publishes %s despite unreadable files and retries them after restart and unlock", async restriction => {
    const rootPath = await workspaceRoot();
    const locked = "tasks/locked.md";
    const good = "tasks/good.md";
    const registered = { ...target(rootPath), unsavedPaths: undefined as string[] | null | undefined,
      grantedSelector: { paths: ["tasks"], versionId: null, access: "edit" as "edit" | "view" } };
    const store = mutableTextStore({ initial: [locked, good].map(path => ({ path, text: "owner version\n" })) });
    await mkdir(join(rootPath, "tasks"), { recursive: true });
    for (const path of [locked, good]) await writeFile(join(rootPath, path), "recipient edit\n");
    // A pending file's inspection failure formerly threw before markEnded.
    await seedPendingMaterializationPaths(rootPath, [locked]);
    const original = fsPromises.lstat;
    const inspect = vi.spyOn(fsPromises, "lstat").mockImplementation((...args) => {
      if (String(args[0]) === join(rootPath, locked)) return Promise.reject(Object.assign(new Error("locked"), { code: "EACCES" }));
      return original(...args);
    });
    const ports = { ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store,
      markEnded: async (_target: ResolvedShareViewFilesTarget, unsavedPaths?: string[] | null) => {
        registered.ended = true; registered.unsavedPaths = unsavedPaths;
      } };
    const files = createShareViewFiles(ports);
    const requested = { kind: "standalone" as const, workspaceId: registered.workspaceId };
    let saved: typeof registered;
    try {
      await withStaleSensitiveWorkspaceOperation(rootPath, async lease => {
        if (restriction === "end") await files.end(lease, requested, () => undefined);
        else await files.narrow(lease, requested, () => undefined, async unsavedPaths => {
          registered.grantedSelector.access = "view"; registered.unsavedPaths = unsavedPaths;
        });
      });
      expect(registered.unsavedPaths).toEqual([locked]);
      expect(store.writeTextFile).toHaveBeenCalledWith(expect.objectContaining({ path: good, text: "recipient edit\n" }));
      expect(restriction === "end" ? registered.ended : registered.grantedSelector.access === "view").toBe(true);
      // Reload the persisted record and update/delete/re-add the canonical file.
      saved = JSON.parse(JSON.stringify(registered)) as typeof registered;
      const restarted = createShareViewFiles({ ...ports, resolveTarget: () => saved,
        updateUnsavedPaths: async (_target, paths) => { saved.unsavedPaths = paths; },
        resolveRelay: async () => ({ baseUrl: "https://relay.example", token: "token" }),
        pull: async () => ({ fetched: 1, applied: 1, skipped: 0, refusals: [], refusalCount: 0,
          changedPaths: [{ path: locked, operation: "write", contentKind: "text" }], nextCursor: 1, commitCursor: async () => undefined }) });
      for (const text of ["new owner version\n", null, "owner re-added\n"]) {
        if (text === null) await store.deleteTextFile({ workspaceId: saved.workspaceId, versionId: "main", path: locked, metadata: { origin: "local-file" } });
        else await store.writeTextFile({ workspaceId: saved.workspaceId, versionId: "main", path: locked, text, metadata: { origin: "local-file" } });
        await withStaleSensitiveWorkspaceOperation(rootPath, lease => restarted.reconcile(lease, requested, "settle"));
        expect(await readFile(join(rootPath, locked), "utf8")).toBe("recipient edit\n");
        await withStaleSensitiveWorkspaceOperation(rootPath, lease => restarted.reconcile(lease, requested, "refresh"));
        expect(await readFile(join(rootPath, locked), "utf8")).toBe("recipient edit\n");
        expect(saved.unsavedPaths).toEqual([locked]);
      }
      } finally { inspect.mockRestore(); }
    const restarted = createShareViewFiles({ ...ports, resolveTarget: () => saved,
      updateUnsavedPaths: async (_target, paths) => { saved.unsavedPaths = paths; },
      resolveRelay: async () => ({ baseUrl: "https://relay.example", token: "token" }),
      pull: async () => {
        await store.writeTextFile({ workspaceId: saved.workspaceId, versionId: "main", path: locked,
          text: "later owner update\n", metadata: { origin: "local-file" } });
        return { fetched: 1, applied: 1, skipped: 0, refusals: [], refusalCount: 0,
          changedPaths: [{ path: locked, operation: "write", contentKind: "text" }], nextCursor: 2, commitCursor: async () => undefined };
      } });
    await withStaleSensitiveWorkspaceOperation(rootPath, lease => restarted.reconcile(lease, requested, "settle"));
    expect(saved!.unsavedPaths).toEqual([]);
    expect(await store.readTextFile({ workspaceId: saved!.workspaceId, versionId: "main", path: locked })).toMatchObject({ text: "recipient edit\n" });
    await withStaleSensitiveWorkspaceOperation(rootPath, lease => restarted.reconcile(lease, requested, "refresh"));
    expect(await readFile(join(rootPath, locked), "utf8")).toBe(restriction === "end" ? "recipient edit\n" : "later owner update\n");
  });

  it("removes a deleted protected path from the persisted exclusions", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes.md";
    const registered = { ...target(rootPath, "view"), unsavedPaths: [path] as string[] | null };
    await writeFile(join(rootPath, path), "recipient edit\n");
    await rm(join(rootPath, path));
    const store = mutableTextStore({ initial: [{ path, text: "owner version\n" }] });
    const updateUnsavedPaths = vi.fn(async (_target, paths: string[]) => { registered.unsavedPaths = paths; });
    const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store, updateUnsavedPaths });
    await withStaleSensitiveWorkspaceOperation(rootPath, lease => files.reconcile(lease,
      { kind: "standalone", workspaceId: registered.workspaceId }, "settle"));
    expect(updateUnsavedPaths).toHaveBeenCalledWith(expect.anything(), []);
    expect(registered.unsavedPaths).toEqual([]);
    expect(await store.readTextFile({ workspaceId: registered.workspaceId, versionId: "main", path })).toBeNull();
    expect(await readdir(rootPath)).not.toContain(path);
  });

  it("ends even if the store fails before capture can enumerate files", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes.md";
    await writeFile(join(rootPath, path), "recipient edit\n");
    const registered = { ...target(rootPath), unsavedPaths: undefined as string[] | null | undefined };
    const store = mutableTextStore({ initial: [{ path, text: "owner version\n" }] });
    vi.mocked(store.listTextFileMetadata).mockRejectedValueOnce(new Error("store unavailable"));
    const pull = vi.fn(unusedReconcilePorts.pull);
    const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store, pull,
      updateUnsavedPaths: async (_target, paths) => { registered.unsavedPaths = paths; },
      markEnded: async (_target, unsavedPaths) => {
        registered.ended = true;
        if (unsavedPaths !== undefined) registered.unsavedPaths = unsavedPaths;
      } });
    const requested = { kind: "standalone" as const, workspaceId: registered.workspaceId };
    await withStaleSensitiveWorkspaceOperation(rootPath, lease => files.end(lease, requested, () => undefined));
    expect(registered).toMatchObject({ ended: true, unsavedPaths: null });
    await withStaleSensitiveWorkspaceOperation(rootPath, lease => files.reconcile(lease, requested, "refresh"));
    expect(await readFile(join(rootPath, path), "utf8")).toBe("recipient edit\n");
    expect(registered.unsavedPaths).toEqual([]);
    expect(store.writeTextFile).toHaveBeenCalledWith(expect.objectContaining({ path, text: "recipient edit\n" }));
    expect(pull).not.toHaveBeenCalled();
  });

  it("reports a full capture failure during refresh and retries before pulling", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes.md";
    await writeFile(join(rootPath, path), "recipient edit\n");
    const registered = { ...target(rootPath, "view"), unsavedPaths: null as string[] | null };
    const store = mutableTextStore({ initial: [{ path, text: "owner version\n" }] });
    const pull = vi.fn(async () => ({ fetched: 0, applied: 0, skipped: 0, refusals: [], refusalCount: 0,
      changedPaths: [], nextCursor: 0, commitCursor: async () => undefined }));
    const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store,
      updateUnsavedPaths: async (_target, paths) => { registered.unsavedPaths = paths; }, pull,
      resolveRelay: async () => ({ baseUrl: "https://relay.example", token: "token" }) });
    const requested = { kind: "standalone" as const, workspaceId: registered.workspaceId };
    vi.mocked(store.listTextFileMetadata).mockRejectedValueOnce(new Error("store unavailable"));
    const failed = await withStaleSensitiveWorkspaceOperation(rootPath, lease => files.reconcile(lease, requested, "refresh"));
    expect(failed).toMatchObject({ kind: "refresh", outcome: { ok: false } });
    expect(registered.unsavedPaths).toBeNull();
    expect(pull).not.toHaveBeenCalled();
    const recovered = await withStaleSensitiveWorkspaceOperation(rootPath, lease => files.reconcile(lease, requested, "refresh"));
    expect(recovered).toMatchObject({ kind: "refresh", outcome: { ok: true, status: "updated" } });
    expect(registered.unsavedPaths).toEqual([]);
    expect(pull).toHaveBeenCalledOnce();
    expect(await readFile(join(rootPath, path), "utf8")).toBe("recipient edit\n");
  });

  it.each([false, true])("reports the cursor internally only after a successful commit (commit fails: %s)", async commitFails => {
    const rootPath = await workspaceRoot();
    const registered = target(rootPath, "view");
    const committing = deferred();
    const committed = deferred();
    const onCursorCommitted = vi.fn();
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => registered,
      openStore: () => mutableTextStore(),
      resolveRelay: async () => ({ baseUrl: "https://relay.example", token: "token" }),
      pull: async () => ({
        fetched: 0, applied: 0, skipped: 0, refusals: [], refusalCount: 0,
        changedPaths: [], nextCursor: 57,
        commitCursor: async () => { committing.resolve(); await committed.promise; },
      }),
    });
    const result = withStaleSensitiveWorkspaceOperation(rootPath, lease => files.reconcile(
      lease, { kind: "standalone", workspaceId: registered.workspaceId }, "refresh", onCursorCommitted,
    ));
    await committing.promise;
    expect(onCursorCommitted).not.toHaveBeenCalled();
    if (commitFails) committed.reject(new Error("cursor commit failed"));
    else committed.resolve();
    const reconciled = await result;
    expect(reconciled).toMatchObject({ kind: "refresh", outcome: { ok: !commitFails } });
    if (reconciled.kind !== "refresh") throw new Error("Expected a refresh result");
    expect(reconciled.outcome).not.toHaveProperty("nextCursor");
    if (commitFails) expect(onCursorCommitted).not.toHaveBeenCalled();
    else {
      expect(onCursorCommitted).toHaveBeenCalledOnce();
      expect(onCursorCommitted).toHaveBeenCalledWith(57);
    }
  });

  it("refuses automation saves on mounted shares", async () => {
    const rootPath = await workspaceRoot();
    const initial = "version: 1\nautomations: []\n";
    const store = mutableTextStore({ initial: [{ path: "Tasks/automations.yaml", text: initial }] });
    const registered = { ...mountTarget(rootPath), grantedSelector: { paths: ["Tasks"], versionId: null as string | null, access: "edit" as "edit" | "view" | "comment" } };
    const requested = { kind: "mount" as const, workspaceId: registered.workspaceId, shareId: registered.shareId! };
    const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => registered, openStore: () => store });
    const save = (path: string) => withStaleSensitiveWorkspaceOperation(rootPath, lease =>
      files.change(lease, requested, { kind: "save", path, text: initial, expectedContentHash: createHash("sha256").update(initial).digest("hex") }));
    await expect(save("Tasks/automations.yaml")).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    await expect(save("Tasks/collection.yaml")).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    for (const access of ["view", "comment"] as const) {
      registered.grantedSelector.access = access;
      await expect(save("Tasks/automations.yaml")).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    }
    registered.grantedSelector.access = "edit";
    registered.grantedSelector.versionId = "saved";
    await expect(save("Tasks/automations.yaml")).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    registered.grantedSelector.versionId = null;
    registered.grantedSelector.paths = ["Tasks/one.md"];
    await expect(save("Tasks/automations.yaml")).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    registered.grantedSelector.paths = ["Tasks"];
    await expect(save("Tasks/automations.yaml")).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    expect(store.writeTextFile).not.toHaveBeenCalled();
  });

  it("does not expose raw share-view mutations and rejects forged ownership", async () => {
    const [sharedView, fileChanges, shareMounts] = await Promise.all([
      import("./sharedView"),
      import("./shareViewFileChanges"),
      import("./shareMounts"),
    ]);
    for (const name of [
      "materializeSharedViewPaths",
      "writeDiskContentToStore",
      "writePendingMaterializationPaths",
      "clearPendingMaterializationPaths",
      "clearPullInFlightMarker",
      "recordCollisionPaths",
      "clearCollisionRecordPaths",
      "captureSharedViewLocalDivergence",
      "captureStandaloneShareViewDivergence",
      "refreshSharedViewOnce",
      "refreshCapturedShareView",
      "reconcileStandaloneShareView",
      "readCollisionRecordPaths",
    ]) {
      expect(sharedView).not.toHaveProperty(name);
    }
    for (const name of [
      "applyShareViewTextWrite",
      "applyShareViewFileCreate",
      "applyShareViewPathMove",
      "applyShareViewPathDelete",
      "applyShareViewFileImport",
    ]) {
      expect(fileChanges).not.toHaveProperty(name);
    }
    for (const name of [
      "createMountDirectory",
      "removeMountFolder",
      "removeShareMountProjection",
    ]) {
      expect(shareMounts).not.toHaveProperty(name);
    }

    const forged = {} as ShareViewFilesOwnerCapability;
    await expect(
      shareMounts.shareViewFilesMountProjection(forged).create(),
    ).rejects.toThrow("ownership admission is inactive");
    const projection = sharedView.shareViewFilesProjection(forged);
    const rootPath = await workspaceRoot();
    expect(() => projection.markPending(rootPath, ["notes/forged.md"])).toThrow(
      "ownership admission is inactive",
    );
    const forgedStore = readStore({ text: "" });
    const lifecycle = sharedView.createShareViewLifecycle(forged);
    expect(() =>
      lifecycle.captureShared({
        rootDir: "unused",
        workspaceId: "unused",
        store: forgedStore,
        allowLocalJournaling: true,
        shareId: "unused",
      }),
    ).toThrow("ownership admission is inactive");
    expect(() =>
      lifecycle.captureStandaloneRefresh({
        rootDir: "unused",
        workspaceId: "unused",
        store: forgedStore,
        pinnedSelector: { paths: [], versionId: "main", access: "edit" },
        shareId: "unused",
        ended: false,
      }),
    ).toThrow("ownership admission is inactive");
    expect(forgedStore.ensureMainVersion).not.toHaveBeenCalled();

    const forgedChanges = fileChanges.createShareViewFileChanges(forged);
    const store = mutableTextStore({
      initial: [{ path: "notes/existing.md", text: "canonical\n" }],
    });
    await expect(
      forgedChanges.writeText({
        relativePath: "notes/existing.md",
        text: "forged\n",
        expectedContentHash: "not-the-current-hash",
        shareViewStore: () => store,
      }),
    ).rejects.toThrow("ownership admission is inactive");
    expect(store.ensureMainVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["edit", "pending"],
    ["view", "pending"],
    ["edit", "collision"],
    ["view", "collision"],
  ] as const)(
    "fails closed for a %s share when %s debt persistence fails after pull",
    async (access, failedRecord) => {
      const rootPath = await workspaceRoot();
      const path = "docs/pull-window.md";
      const store = mutableTextStore();
      const resolved = target(rootPath, access);
      const files = createShareViewFiles({
        ...unusedReconcilePorts,
        resolveTarget: () => resolved,
        openStore: () => store,
        resolveRelay: async () => ({
          baseUrl: "https://relay.example",
          token: "test-token",
        }),
        pull: async (_target, _relay, input) => {
          await mkdir(join(rootPath, "docs"), { recursive: true });
          await writeFile(join(rootPath, path), "recipient bytes\n", "utf8");
          await store.writeTextFile!({
            workspaceId: "workspace-a",
            versionId: "main",
            path,
            text: "new canonical\n",
            metadata: { origin: "sync" },
          });
          if (failedRecord === "pending") {
            sidecarRenameFailure = {
              path: join(
                recordsDir(rootPath),
                "pending-materialization.json",
              ),
              error: new Error("pending marker persistence failed"),
            };
          }
          await input.recordChangedPaths?.([path]);
          if (failedRecord === "collision") {
            sidecarRenameFailure = {
              path: join(
                recordsDir(rootPath),
                "share-collision-record.json",
              ),
              error: new Error("collision persistence failed"),
            };
          }
          await input.recordCollisions?.([path]);
          return {
            fetched: 1,
            applied: 1,
            skipped: 0,
            refusals: [],
            refusalCount: 0,
            changedPaths: [
              { path, operation: "write" as const, contentKind: "text" as const },
            ],
            nextCursor: 1,
            commitCursor: async () => undefined,
          };
        },
      });
      const requested = {
        kind: "standalone" as const,
        workspaceId: "workspace-a",
      };

      try {
        const failed = await withStaleSensitiveWorkspaceOperation(
          rootPath,
          (lease) => files.reconcile(lease, requested, "refresh"),
        );
        expect(failed).toMatchObject({
          kind: "refresh",
          outcome: { ok: false },
        });

        const repaired = await withStaleSensitiveWorkspaceOperation(
          rootPath,
          (lease) => files.reconcile(lease, requested, "repair"),
        );
        expect(repaired).toMatchObject({
          kind: "repair",
          repairedPaths: 0,
          unjournalablePaths: [{ path, reason: "local-collision" }],
        });
        await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe(
          "recipient bytes\n",
        );
        await expect(
          readSharedViewProjectionDebt(rootPath, "share-a"),
        ).resolves.toMatchObject({ pullInFlight: true });
        await expect(
          store.readTextFile!({
            workspaceId: "workspace-a",
            versionId: "main",
            path,
          }),
        ).resolves.toMatchObject({ text: "new canonical\n" });
      } finally {
        sidecarRenameFailure = null;
      }
    },
  );

  it("owns mount creation and rollback with one target-bound live capability", async () => {
    const hostRoot = await workspaceRoot();
    const mountLabel = "granter";
    const prepared: PreparedShareViewFilesMount = {
      kind: "mount",
      workspaceId: "host-a",
      storeWorkspaceId: "host-a:share-a",
      schedulingRootPath: hostRoot,
      rootPath: mountRootFor(hostRoot, mountLabel),
      shareId: "share-a",
      mountLabel,
      granterEmail: "granter@example.com",
      grantedSelector: { paths: [], versionId: "main", access: "view" },
      ended: false,
      relayUrl: "https://relay.example",
      recipientEmail: "recipient@example.com",
    };
    let registered = false;
    let leakedOwner: ShareViewFilesOwnerCapability | null = null;
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => (registered ? prepared : null),
      openStore: () => mutableTextStore(),
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull: async () => {
        throw new Error("first pull failed");
      },
      createMount: async (owner) => {
        leakedOwner = owner;
        await shareViewFilesMountProjection(owner).create();
        // The engine's open of the mount's store makes its `.dohc/local`.
        await mkdir(join(prepared.rootPath, ".dohc", "local"), { recursive: true });
        registered = true;
      },
      removeMount: async (owner) => {
        const removed = await shareViewFilesMountProjection(owner).remove();
        registered = false;
        return removed;
      },
    });

    await expect(
      withExclusiveWorkspaceOperation(hostRoot, (_changed, lease) =>
        files.mount(lease, prepared),
      ),
    ).rejects.toThrow("first pull failed");
    expect(registered).toBe(false);
    await expect(lstat(prepared.rootPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      shareViewFilesMountProjection(leakedOwner!).create(),
    ).rejects.toThrow("ownership admission is inactive");
    const staleStore = mutableTextStore({
      initial: [{ path: "notes/stale.md", text: "canonical\n" }],
    });
    const staleChanges = (await import("./shareViewFileChanges"))
      .createShareViewFileChanges(leakedOwner!);
    await expect(
      staleChanges.writeText({
        relativePath: "notes/stale.md",
        text: "stale write\n",
        expectedContentHash: "not-current",
        shareViewStore: () => staleStore,
      }),
    ).rejects.toThrow("ownership admission is inactive");
    expect(staleStore.ensureMainVersion).not.toHaveBeenCalled();
    expect(registered).toBe(false);
  });

  it("does not claim rollback succeeded when a failed mount folder remains", async () => {
    const hostRoot = await workspaceRoot();
    const prepared: PreparedShareViewFilesMount = {
      kind: "mount",
      workspaceId: "host-a",
      storeWorkspaceId: "host-a:share-a",
      schedulingRootPath: hostRoot,
      rootPath: mountRootFor(hostRoot, "granter"),
      shareId: "share-a",
      mountLabel: "granter",
      granterEmail: null,
      grantedSelector: { paths: [], versionId: "main", access: "view" },
      ended: false,
      relayUrl: "https://relay.example",
      recipientEmail: null,
    };
    let registered = false;
    const rollbackError = new Error("folder busy");
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => (registered ? prepared : null),
      openStore: () => mutableTextStore(),
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull: async () => {
        throw new Error("pull failed");
      },
      createMount: async (owner) => {
        await shareViewFilesMountProjection(owner).create();
        registered = true;
      },
      removeMount: async () => ({
        folderLeft: true,
        error: rollbackError,
      }),
    });

    await expect(
      withExclusiveWorkspaceOperation(hostRoot, (_changed, lease) =>
        files.mount(lease, prepared),
      ),
    ).rejects.toMatchObject({
      name: "ShareViewMountRollbackError",
      rollbackError,
      cause: rollbackError,
    });
    await expect(lstat(prepared.rootPath)).resolves.toBeTruthy();
    expect(registered).toBe(true);
  });

  it("rejects cross-target projection claims before touching the other root", async () => {
    const hostRoot = await workspaceRoot();
    const otherRoot = await workspaceRoot();
    const mountLabel = "granter";
    const prepared: PreparedShareViewFilesMount = {
      kind: "mount",
      workspaceId: "host-a",
      storeWorkspaceId: "host-a:share-a",
      schedulingRootPath: hostRoot,
      rootPath: mountRootFor(hostRoot, mountLabel),
      shareId: "share-a",
      mountLabel,
      granterEmail: null,
      grantedSelector: { paths: [], versionId: "main", access: "view" },
      ended: false,
      relayUrl: "https://relay.example",
      recipientEmail: null,
    };
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => null,
      openStore: () => mutableTextStore(),
      createMount: async (owner) => {
        await import("./sharedView").then((sharedView) =>
          sharedView
            .shareViewFilesProjection(owner)
            .markPending(otherRoot, ["notes/forged.md"]),
        );
      },
    });

    await expect(
      withExclusiveWorkspaceOperation(hostRoot, (_changed, lease) =>
        files.mount(lease, prepared),
      ),
    ).rejects.toThrow("belongs to another target");
    await expect(lstat(recordsDir(otherRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a mount lease admitted for another workspace root", async () => {
    const hostRoot = await workspaceRoot();
    const otherRoot = await workspaceRoot();
    const prepared: PreparedShareViewFilesMount = {
      kind: "mount",
      workspaceId: "host-a",
      storeWorkspaceId: "host-a:share-a",
      schedulingRootPath: hostRoot,
      rootPath: mountRootFor(hostRoot, "granter"),
      shareId: "share-a",
      mountLabel: "granter",
      granterEmail: null,
      grantedSelector: { paths: [], versionId: "main", access: "view" },
      ended: false,
      relayUrl: "https://relay.example",
      recipientEmail: null,
    };
    const createMount = vi.fn(async () => undefined);
    const resolveTarget = vi.fn(() => null);
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget,
      openStore: () => mutableTextStore(),
      createMount,
    });

    await expect(
      withExclusiveWorkspaceOperation(otherRoot, (_changed, lease) =>
        files.mount(lease, prepared),
      ),
    ).rejects.toThrow(
      "Workspace operation lease is inactive or belongs to another root.",
    );
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(createMount).not.toHaveBeenCalled();
  });

  it("keeps detached facade work inside the live admission and lifecycle lock", async () => {
    const hostRoot = await workspaceRoot();
    const prepared: PreparedShareViewFilesMount = {
      kind: "mount",
      workspaceId: "host-a",
      storeWorkspaceId: "host-a:share-a",
      schedulingRootPath: hostRoot,
      rootPath: mountRootFor(hostRoot, "granter"),
      shareId: "share-a",
      mountLabel: "granter",
      granterEmail: null,
      grantedSelector: { paths: [], versionId: "main", access: "view" },
      ended: false,
      relayUrl: "https://relay.example",
      recipientEmail: null,
    };
    await mkdir(prepared.rootPath, { recursive: true });
    const readStarted = deferred();
    const releaseRead = deferred();
    const baseStore = mutableTextStore({
      initial: [{ path: "notes/detached.md", text: "canonical\n" }],
    });
    const store: ShareViewFilesStore = {
      ...baseStore,
      readTextFile: async (input) => {
        readStarted.resolve();
        await releaseRead.promise;
        return baseStore.readTextFile!(input);
      },
    } as ShareViewFilesStore;
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => null,
      openStore: () => store,
      createMount: async (owner) => {
        void shareViewFilesProjection(owner).materialize(
          prepared.rootPath,
          prepared.storeWorkspaceId,
          [
            {
              path: "notes/detached.md",
              operation: "write",
              contentKind: "text",
            },
          ],
          store,
        );
      },
    });

    const mounting = withExclusiveWorkspaceOperation(
      hostRoot,
      (_changed, lease) => files.mount(lease, prepared),
    );
    let settled = false;
    void mounting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await readStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseRead.resolve();
    await expect(mounting).rejects.toThrow("not registered");
    await expect(
      readFile(join(prepared.rootPath, "notes", "detached.md"), "utf8"),
    ).resolves.toBe("canonical\n");
  });

  it("does not mutate canonical state when the real pending mark fails", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/mark-failure.md";
    const before = "before\n";
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), before, "utf8");
    const store = mutableTextStore({ initial: [{ path, text: before }] });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });
    sidecarRenameFailure = {
      path: join(recordsDir(rootPath), "pending-materialization.json"),
      error: new Error("real pending mark failed"),
    };

    try {
      await expect(
        withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
          files.change(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            {
              kind: "save",
              path,
              text: "after\n",
              expectedContentHash: createHash("sha256")
                .update(before)
                .digest("hex"),
            },
          ),
        ),
      ).rejects.toThrow("real pending mark failed");
      expect(store.writeTextFile).not.toHaveBeenCalled();
      await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe(before);
    } finally {
      sidecarRenameFailure = null;
    }
  });

  it("keeps real pending debt when clear fails and repairs it on retry", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/clear-failure.md";
    const before = "before\n";
    const after = "after\n";
    const pendingPath = join(
      recordsDir(rootPath),
      "pending-materialization.json",
    );
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), before, "utf8");
    const store = mutableTextStore({ initial: [{ path, text: before }] });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });
    afterMaterializationWrite = {
      path: join(rootPath, path),
      run: () => {
        sidecarRemoveFailure = {
          path: pendingPath,
          error: new Error("real pending clear failed"),
        };
      },
    };

    try {
      const changed = await withStaleSensitiveWorkspaceOperation(
        rootPath,
        (lease) =>
          files.change(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            {
              kind: "save",
              path,
              text: after,
              expectedContentHash: createHash("sha256")
                .update(before)
                .digest("hex"),
            },
          ),
      );
      expect(changed).toMatchObject({
        status: "committed",
        projection: "pending",
      });
      await expect(
        readSharedViewProjectionDebt(rootPath, "share-a"),
      ).resolves.toMatchObject({ pendingPaths: new Set([path]) });
      await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe(after);

      const repaired = await withStaleSensitiveWorkspaceOperation(
        rootPath,
        (lease) =>
          files.reconcile(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            "repair",
          ),
      );
      expect(repaired).toMatchObject({ kind: "repair", repairedPaths: 1 });
      await expect(
        readSharedViewProjectionDebt(rootPath, "share-a"),
      ).resolves.toMatchObject({ pendingPaths: new Set() });
    } finally {
      afterMaterializationWrite = null;
      sidecarRemoveFailure = null;
    }
  });

  it("reports a partial standalone refresh when capture fails after a commit", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/partial-capture.md";
    const before = "before\n";
    const after = "agent edit\n";
    const pendingPath = join(
      recordsDir(rootPath),
      "pending-materialization.json",
    );
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), after, "utf8");
    await writeRecord(
      rootPath,
      "pending-materialization.json",
      JSON.stringify({ counts: { [path]: 2 } }),
    );
    const store = mutableTextStore({ initial: [{ path, text: before }] });
    const pull = vi.fn(async () => {
      throw new Error("capture failure must stop the pull");
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull,
    });
    sidecarRenameFailure = {
      path: pendingPath,
      error: new Error("pending marker unavailable"),
    };

    try {
      await expect(
        withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
          files.reconcile(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            "refresh",
          ),
        ),
      ).resolves.toEqual({
        kind: "refresh",
        outcome: {
          ok: false,
          changedPaths: 1,
          errorMessage: "pending marker unavailable",
        },
      });
      expect(pull).not.toHaveBeenCalled();
      await expect(
        files.read(
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "text", path },
        ),
      ).resolves.toMatchObject({ text: after });
    } finally {
      sidecarRenameFailure = null;
    }
  });

  it("keeps newer projection debt behind a refresh that has not cleared", async () => {
    const rootPath = await workspaceRoot();
    const path = "docs/late-clear.md";
    const v1 = "version one\n";
    const v2 = "version two\n";
    const firstWriteFinished = deferred();
    const releaseFirstWrite = deferred();
    const secondAdmitted = deferred();
    const projectionFailure = new Error("second projection write failed");
    let resolves = 0;
    const store = mutableTextStore();
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 3) secondAdmitted.resolve();
        return target(rootPath);
      },
      openStore: () => store,
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull: async () => {
        await store.writeTextFile({
          workspaceId: "workspace-a",
          versionId: "main",
          path,
          text: v1,
          metadata: { origin: "sync" },
        });
        return {
          fetched: 1,
          applied: 1,
          skipped: 0,
          refusals: [],
          refusalCount: 0,
          changedPaths: [
            { path, operation: "write" as const, contentKind: "text" as const },
          ],
          nextCursor: 1,
          commitCursor: async () => undefined,
        };
      },
    });
    materializationWriteSchedule = {
      path: join(rootPath, path),
      attempts: 0,
      firstWriteFinished: firstWriteFinished.resolve,
      releaseFirstWrite: releaseFirstWrite.promise,
      secondWriteError: projectionFailure,
    };

    const refreshing = withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
      files.reconcile(
        lease,
        { kind: "standalone", workspaceId: "workspace-a" },
        "refresh",
      ),
    );
    let changing: ReturnType<typeof files.change> | null = null;
    try {
      await firstWriteFinished.promise;
      changing = withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "save",
            path,
            text: v2,
            expectedContentHash: createHash("sha256").update(v1).digest("hex"),
          },
        ),
      );
      await secondAdmitted.promise;

      expect(store.writeTextFile).toHaveBeenCalledTimes(1);
      releaseFirstWrite.resolve();
      await expect(refreshing).resolves.toMatchObject({
        kind: "refresh",
        outcome: { status: "updated" },
      });
      await expect(changing).resolves.toMatchObject({
        status: "committed",
        kind: "save",
        projection: "pending",
        value: { status: "written" },
      });
      await expect(lstat(join(rootPath, path))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        files.projectionStatus({
          kind: "standalone",
          workspaceId: "workspace-a",
        }),
      ).resolves.toEqual({
        state: "pending",
        pendingPathCount: 1,
        pendingPaths: [path],
        collisionPathCount: 0,
        collisionPaths: [],
        pullInFlight: false,
      });
      await expect(
        store.readTextFile({
          workspaceId: "workspace-a",
          versionId: "main",
          path,
        }),
      ).resolves.toMatchObject({ text: v2 });
    } finally {
      releaseFirstWrite.resolve();
      materializationWriteSchedule = null;
      await Promise.allSettled(
        changing === null ? [refreshing] : [refreshing, changing],
      );
    }
  });

  it("rereads authority after waiting for the share lifecycle", async () => {
    const rootPath = await workspaceRoot();
    let current = target(rootPath, "edit");
    const admitted = deferred();
    let resolves = 0;
    const openStore = vi.fn(() => readStore({ text: "unused" }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 1) admitted.resolve();
        return current;
      },
      openStore,
    });

    const releaseLifecycle = deferred();
    const lifecycleHeld = deferred();
    const blocker = withShareViewRefreshLifecycleLock(rootPath, async () => {
      lifecycleHeld.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleHeld.promise;

    const changing = withStaleSensitiveWorkspaceOperation(
      rootPath,
      async (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "create", path: "notes/new.md", initialText: "" },
        ),
    );
    await admitted.promise;
    current = target(rootPath, "view");
    releaseLifecycle.resolve();

    await expect(changing).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    await blocker;
    expect(resolves).toBe(2);
    expect(openStore).not.toHaveBeenCalled();
  });

  it("does not reconcile a share removed while waiting for its lifecycle", async () => {
    const rootPath = await workspaceRoot();
    let current: ResolvedShareViewFilesTarget | null = target(rootPath);
    const admitted = deferred();
    let resolves = 0;
    const openStore = vi.fn(() => readStore({ text: "unused" }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 1) admitted.resolve();
        return current;
      },
      openStore,
    });

    const releaseLifecycle = deferred();
    const lifecycleHeld = deferred();
    const blocker = withShareViewRefreshLifecycleLock(rootPath, async () => {
      lifecycleHeld.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleHeld.promise;

    const reconciling = withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.reconcile(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          "repair",
        ),
    );
    await admitted.promise;
    current = null;
    releaseLifecycle.resolve();

    await expect(reconciling).rejects.toMatchObject({
      name: "ShareViewFilesTargetMissingError",
    });
    await blocker;
    expect(resolves).toBe(2);
    expect(openStore).not.toHaveBeenCalled();
  });

  it("rejects an expired lease before resolving any mutation target", async () => {
    const rootPath = await workspaceRoot();
    const mountRoot = join(rootPath, "mount");
    await mkdir(mountRoot, { recursive: true });
    let expiredLease!: WorkspaceOperationLease;
    await withStaleSensitiveWorkspaceOperation(rootPath, async (lease) => {
      expiredLease = lease;
    });
    const exclusiveStarted = deferred();
    const releaseExclusive = deferred();
    const exclusive = withExclusiveWorkspaceOperation(rootPath, async () => {
      exclusiveStarted.resolve();
      await releaseExclusive.promise;
    });
    await exclusiveStarted.promise;

    const mounted = {
      ...mountTarget(mountRoot),
      schedulingRootPath: rootPath,
    };
    const resolveTarget = vi.fn((requested: ShareViewFilesTarget) =>
      requested.kind === "mount" ? mounted : target(rootPath),
    );
    const store = mutableTextStore();
    const removeMount = vi.fn(async () => ({ folderLeft: false }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget,
      openStore: () => store,
      removeMount,
    });
    const standalone = {
      kind: "standalone" as const,
      workspaceId: "workspace-a",
    };
    const mount = {
      kind: "mount" as const,
      workspaceId: "host-a",
      shareId: "share-a",
    };

    try {
      const outcomes = await Promise.all(
        [
          files.change(expiredLease, standalone, {
            kind: "create",
            path: "notes/new.md",
            initialText: "new\n",
          }),
          files.change(expiredLease, standalone, {
            kind: "move",
            fromPath: "notes/same.md",
            toPath: "notes/same.md",
          }),
          files.change(expiredLease, standalone, {
            kind: "import",
            absolutePaths: [],
            screenAgainstRoots: null,
            targetDir: undefined,
          }),
          files.reconcile(expiredLease, mount, "repair"),
          files.unmount(expiredLease, mount),
        ].map(async (attempt) => {
          try {
            await attempt;
            return "resolved";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }),
      );

      expect(outcomes).toEqual(
        Array(5).fill(
          "Workspace operation lease is inactive or belongs to another root.",
        ),
      );
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(removeMount).not.toHaveBeenCalled();
    } finally {
      releaseExclusive.resolve();
      await exclusive;
    }
  });

  it("reuses its workspace lease when capture orders a path", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/a.md";
    const canonical = "canonical before\n";
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), canonical, "utf8");
    const baseStore = mutableTextStore({
      initial: [{ path, text: canonical }],
    });
    const metadataRead = deferred();
    const releaseMetadata = deferred();
    const pathOrdered = deferred();
    let metadataReads = 0;
    const store: ShareViewFilesStore = {
      ...baseStore,
      listTextFileMetadata: vi.fn(async (input) => {
        const rows = await baseStore.listTextFileMetadata(input);
        metadataReads += 1;
        if (metadataReads === 1) {
          metadataRead.resolve();
          await releaseMetadata.promise;
        }
        return rows;
      }),
      readTextFile: vi.fn(async (input) => {
        pathOrdered.resolve();
        return baseStore.readTextFile(input);
      }),
    };
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });
    const order: string[] = [];

    const changing = withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "save",
            path,
            text: "recipient edit\n",
            expectedContentHash: createHash("sha256")
              .update(canonical)
              .digest("hex"),
          },
        ),
    ).then((outcome) => {
      order.push("change");
      return outcome;
    });
    await metadataRead.promise;
    const exclusive = withExclusiveWorkspaceOperation(rootPath, async () => {
      order.push("exclusive");
    });
    releaseMetadata.resolve();

    // Capture must order the target through the workspace lease already held
    // by ShareViewFiles. Reacquiring the root scheduler here queues this read
    // behind `exclusive`, while `exclusive` waits for `changing`: a deadlock.
    await pathOrdered.promise;
    await expect(changing).resolves.toMatchObject({
      status: "committed",
      kind: "save",
    });
    await exclusive;
    expect(order).toEqual(["change", "exclusive"]);
  });

  it("keeps reconcile behind a save's projection gap", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/a.md";
    const canonical = "canonical before\n";
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), canonical, "utf8");
    const baseStore = mutableTextStore({
      initial: [{ path, text: canonical }],
    });
    const saveStored = deferred();
    const releaseSave = deferred();
    const reconcileWaiting = deferred();
    const store: ShareViewFilesStore = {
      ...baseStore,
      writeTextFile: vi.fn(async (input) => {
        const outcome = await baseStore.writeTextFile(input);
        saveStored.resolve();
        await releaseSave.promise;
        return outcome;
      }),
    };
    let resolves = 0;
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 3) reconcileWaiting.resolve();
        return target(rootPath);
      },
      openStore: () => store,
    });
    const pending: Promise<unknown>[] = [];

    try {
      const changing = withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
          files.change(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            {
              kind: "save",
              path,
              text: "saved in app\n",
              expectedContentHash: createHash("sha256")
                .update(canonical)
                .digest("hex"),
            },
          ),
      );
      pending.push(changing);
      await saveStored.promise;
      await rm(join(rootPath, path));

      const reconciling = withStaleSensitiveWorkspaceOperation(
        rootPath,
        (lease) =>
          files.reconcile(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            "settle",
          ),
      );
      pending.push(reconciling);
      await reconcileWaiting.promise;

      expect(store.listTextFileMetadata).toHaveBeenCalledTimes(1);
      expect(store.deleteTextFile).not.toHaveBeenCalled();
      releaseSave.resolve();

      await expect(changing).resolves.toMatchObject({
        status: "committed",
        kind: "save",
      });
      await expect(reconciling).resolves.toMatchObject({
        kind: "settle",
        capturedPaths: 0,
        repairedPaths: 0,
      });
      expect(await readFile(join(rootPath, path), "utf8")).toBe(
        "saved in app\n",
      );
      expect(store.deleteTextFile).not.toHaveBeenCalled();
    } finally {
      releaseSave.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("reuses an exclusive workspace lease while capturing a delete", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/a.md";
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), "canonical\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path, text: "canonical\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withExclusiveWorkspaceOperation(
      rootPath,
      (_markChanged, lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "delete", path },
        ),
    );

    expect(outcome).toMatchObject({ status: "committed", kind: "delete" });
    await expect(readFile(join(rootPath, path), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("repairs tracked files without replacing recipient-owned directories", async () => {
    const rootPath = await workspaceRoot();
    const trackedPath = join(rootPath, "docs", "note.md");
    await mkdir(trackedPath, { recursive: true });
    await writeFile(join(trackedPath, "mine.md"), "recipient\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path: "docs/note.md", text: "canonical\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath, "view"),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.reconcile(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          "repair",
        ),
    );

    expect(outcome).toMatchObject({
      kind: "repair",
      repairedPaths: 0,
      collisionRecordQuarantined: false,
      unjournalablePaths: [
        { path: "docs/note.md", reason: "non-file-replacement" },
      ],
    });
    await expect(readFile(join(trackedPath, "mine.md"), "utf8")).resolves.toBe(
      "recipient\n",
    );
  });

  it("repairs an ended view locally without resolving a relay", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "note.md"), "changed\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path: "docs/note.md", text: "canonical\n" }],
    });
    const resolveRelay = vi.fn(async () => {
      throw new Error("relay resolution must not run for an ended view");
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => ({ ...target(rootPath, "edit"), ended: true }),
      openStore: () => store,
      resolveRelay,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.reconcile(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          "refresh",
        ),
    );

    expect(outcome).toMatchObject({
      kind: "refresh",
      outcome: {
        ok: true,
        status: "ended",
        changedPaths: 1,
        collisionRecordQuarantined: false,
        unjournalablePaths: [],
      },
    });
    expect(resolveRelay).not.toHaveBeenCalled();
    await expect(
      readFile(join(rootPath, "docs", "note.md"), "utf8"),
    ).resolves.toBe("canonical\n");
  });

  it("repairs an ended mount locally without resolving or pulling a relay", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "note.md"), "changed\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path: "docs/note.md", text: "canonical\n" }],
    });
    const resolveRelay = vi.fn(async () => {
      throw new Error("relay resolution must not run for an ended mount");
    });
    const pull = vi.fn(async () => {
      throw new Error("relay pull must not run for an ended mount");
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => ({ ...mountTarget(rootPath), ended: true }),
      openStore: () => store,
      resolveRelay,
      pull,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.reconcile(
          lease,
          { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
          "refresh",
        ),
    );

    expect(outcome).toMatchObject({
      kind: "refresh",
      outcome: {
        status: "ended",
        changedPaths: 1,
        collisionRecordQuarantined: false,
        unjournalablePaths: [],
      },
    });
    expect(resolveRelay).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    await expect(
      readFile(join(rootPath, "docs", "note.md"), "utf8"),
    ).resolves.toBe("canonical\n");
  });

  it("keeps mounted recipient data after quarantining a malformed collision record", async () => {
    const rootPath = await workspaceRoot();
    const path = "docs/collision.md";
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, path), "recipient data\n", "utf8");
    await writeRecord(rootPath, "share-collision-record.json", "not json");
    const store = mutableTextStore({
      initial: [{ path, text: "granter old\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => mountTarget(rootPath),
      openStore: () => store,
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull: async () => {
        await store.writeTextFile({
          workspaceId: "host-a:share-a",
          versionId: "main",
          path,
          text: "granter new\n",
          metadata: { origin: "sync" },
        });
        return {
          fetched: 1,
          applied: 1,
          skipped: 0,
          refusals: [],
          refusalCount: 0,
          changedPaths: [
            { path, operation: "write" as const, contentKind: "text" as const },
          ],
          nextCursor: 1,
          commitCursor: async () => undefined,
        };
      },
    });
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const result = await withStaleSensitiveWorkspaceOperation(
        rootPath,
        (lease) =>
          files.reconcile(
            lease,
            { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
            "refresh",
          ),
      );
      await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe(
        "recipient data\n",
      );
      await expect(
        files.projectionStatus({
          kind: "mount",
          workspaceId: "host-a",
          shareId: "share-a",
        }),
      ).resolves.toEqual({
        state: "pending",
        pendingPathCount: 1,
        pendingPaths: [path],
        collisionPathCount: 0,
        collisionPaths: [],
        pullInFlight: false,
      });
      expect(result).toMatchObject({
        kind: "refresh",
        outcome: {
          status: "updated",
          changedPaths: 1,
          excludedPaths: [path],
          collisionRecordQuarantined: true,
        },
      });

      await withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.reconcile(
          lease,
          { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
          "repair",
        ),
      );
      await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe(
        "granter new\n",
      );
      await expect(
        files.projectionStatus({
          kind: "mount",
          workspaceId: "host-a",
          shareId: "share-a",
        }),
      ).resolves.toEqual({ state: "current" });
    } finally {
      errorLog.mockRestore();
    }
  });

  // A view's records wait for the engine's open of that view's own store: a
  // standalone view's attachment, or a mount's store in its own folder.
  it("saves in a standalone view only once its attachment's open is ready, and changes nothing before", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/attached.md";
    const before = "before\n";
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), before, "utf8");
    const attachmentId = Symbol("attached view");
    const asked: unknown[] = [];
    let opened = false;
    readLocalStateFrom({
      currentBinding: (view) => {
        asked.push(view);
        return opened && view.attachmentId === attachmentId ? OPENED : null;
      },
      localStateOpenAt: async () => (opened ? { current: () => opened } : null),
    });
    const store = mutableTextStore({ initial: [{ path, text: before }] });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => ({ ...target(rootPath), attachmentId }),
      openStore: () => store,
    });
    const save = () =>
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "save",
            path,
            text: "after\n",
            expectedContentHash: createHash("sha256").update(before).digest("hex"),
          },
        ),
      );

    await expect(save()).rejects.toThrow(
      "dohc did not update these shared files because the workspace has not finished opening. Try again when it opens.",
    );
    expect(store.writeTextFile).not.toHaveBeenCalled();
    await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe(before);
    await expect(lstat(recordsDir(rootPath))).rejects.toMatchObject({ code: "ENOENT" });

    opened = true;
    await expect(save()).resolves.toMatchObject({ status: "committed", projection: "current" });
    await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe("after\n");
    expect(asked).not.toEqual([]);
    for (const view of asked) {
      expect(view).toMatchObject({ workspaceId: "workspace-a", rootPath, attachmentId });
    }
  });

  it("names a mount's own .dohc/local when its open can't keep it out of iCloud Drive", async () => {
    const hostRoot = await workspaceRoot();
    const mounted = {
      ...mountTarget(mountRootFor(hostRoot, "granter")),
      schedulingRootPath: hostRoot,
    };
    await mkdir(join(mounted.rootPath, ".dohc", "local"), { recursive: true });
    const notExcluded = { localStateReady: false };
    readLocalStateFrom({
      currentBinding: (view) =>
        view.workspaceId === "host-a:share-a" &&
        view.rootPath === mounted.rootPath &&
        view.attachmentId === undefined
          ? notExcluded
          : null,
      // The open prepared the folder and could not keep it out of iCloud Drive.
      localStateOpenAt: async (rootPath) => (rootPath === mounted.rootPath ? { current: () => true } : null),
    });
    const pull = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected pull");
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => mounted,
      openStore: () => mutableTextStore(),
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(hostRoot, (lease) =>
        files.reconcile(
          lease,
          { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
          "refresh",
        ),
      ),
    ).rejects.toThrow(
      "dohc did not update these shared files because it can't keep shared-with-me/granter/.dohc/local out of iCloud Drive. Restart dohc to try again.",
    );
    expect(pull).not.toHaveBeenCalled();
    expect(await readdir(join(mounted.rootPath, ".dohc", "local"))).toEqual([]);
  });

  it("propagates a mounted refresh failure", async () => {
    const rootPath = await workspaceRoot();
    const relayFailure = new Error("relay pull failed");
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => mountTarget(rootPath),
      openStore: () => mutableTextStore(),
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull: async () => {
        throw relayFailure;
      },
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.reconcile(
          lease,
          { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
          "refresh",
        ),
      ),
    ).rejects.toBe(relayFailure);
  });

  it("does not unmount a share removed while waiting for its lifecycle", async () => {
    const rootPath = await workspaceRoot();
    let current: ResolvedShareViewFilesTarget | null = mountTarget(rootPath);
    const admitted = deferred();
    let resolves = 0;
    const removeMount = vi.fn(async () => ({ folderLeft: false }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      removeMount,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 1) admitted.resolve();
        return current;
      },
      openStore: () => readStore({ text: "unused" }),
    });

    const releaseLifecycle = deferred();
    const lifecycleHeld = deferred();
    const blocker = withShareViewRefreshLifecycleLock(rootPath, async () => {
      lifecycleHeld.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleHeld.promise;

    const unmounting = withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
      files.unmount(lease, {
        kind: "mount",
        workspaceId: "host-a",
        shareId: "share-a",
      }),
    );
    await admitted.promise;
    current = null;
    releaseLifecycle.resolve();

    await expect(unmounting).rejects.toMatchObject({
      name: "ShareViewFilesTargetMissingError",
    });
    await blocker;
    expect(resolves).toBe(2);
    expect(removeMount).not.toHaveBeenCalled();
  });

  it("reads and lists the canonical store while the projected folder is stale", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, "notes", "a.md"), "stale disk\n", "utf8");
    const store = readStore({
      text: "canonical store\n",
      paths: [
        {
          path: "notes/a.md",
          text: "---\nicon: telescope\n---\ncanonical store\n",
        },
        { path: "docs/nested/b.md", text: "second\n" },
      ],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "notes/a.md" },
      ),
    ).resolves.toMatchObject({
      kind: "text",
      text: "---\nicon: telescope\n---\ncanonical store\n",
      truncated: false,
    });
    await expect(
      files.list({ kind: "standalone", workspaceId: "workspace-a" }),
    ).resolves.toEqual({
      files: [
        { path: "docs/nested/b.md", kind: "file" },
        { path: "notes/a.md", kind: "file", icon: "telescope" },
      ],
      folders: ["docs", "docs/nested", "notes"],
    });
    const indexed = await files.list(
      { kind: "standalone", workspaceId: "workspace-a" },
      { includeContentIdentity: true },
    );
    expect(Reflect.get(indexed.files[0]!, "contentIdentity")).toMatch(
      /^object-\d+:[a-f0-9]{64}:moment-\d+$/,
    );
    expect(store.readTextFile).toHaveBeenCalledTimes(3);
    await files.list({ kind: "standalone", workspaceId: "workspace-a" });
    expect(store.readTextFile).toHaveBeenCalledTimes(3);
  });

  it("omits a partial trailing UTF-8 character from a truncated canonical read", async () => {
    const rootPath = await workspaceRoot();
    const prefix = "x".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES - 1);
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => readStore({ text: `${prefix}😀tail` }),
    });

    const read = await files.read(
      { kind: "standalone", workspaceId: "workspace-a" },
      { kind: "text", path: "notes/a.md" },
    );

    expect(read).toMatchObject({
      kind: "text",
      truncated: true,
      contentHash: null,
    });
    if (read.kind !== "text") throw new Error("expected a text read");
    expect(read.text).toHaveLength(prefix.length);
    expect(read.text.at(-1)).toBe("x");
    expect(read.text).not.toContain("\uFFFD");
  });

  it("keeps canonical reads and listings on the shared-file security floor", async () => {
    const rootPath = await workspaceRoot();
    const store = readStore({
      text: "unused",
      paths: [
        { path: "notes/a.md", text: "shared\n" },
        { path: ".env", text: "SECRET=not-shared\n" },
      ],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: ".env" },
      ),
    ).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    await expect(
      files.list({ kind: "standalone", workspaceId: "workspace-a" }),
    ).resolves.toEqual({
      files: [{ path: "notes/a.md", kind: "file" }],
      folders: ["notes"],
    });
  });

  it("keeps a damaged standalone marker readable while refusing active work", async () => {
    const rootPath = await workspaceRoot();
    const store = readStore({ text: "canonical local copy\n" });
    const damaged = { ...target(rootPath), shareId: null };
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => damaged,
      openStore: () => store,
    });
    const requested = {
      kind: "standalone" as const,
      workspaceId: "workspace-a",
    };

    await expect(
      files.read(requested, { kind: "text", path: "notes/a.md" }),
    ).resolves.toMatchObject({
      text: "canonical local copy\n",
    });
    await expect(files.list(requested)).resolves.toMatchObject({
      files: [{ path: "notes/a.md", kind: "file" }],
    });
    await expect(files.projectionStatus(requested)).resolves.toEqual({
      state: "unavailable",
    });
    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.reconcile(lease, requested, "refresh"),
      ),
    ).rejects.toBeInstanceOf(SharePinInvalidError);
  });

  // The renderer presents these markers as damaged; an Edit grant on one must
  // not reach the local store either. The intact row proves the refusal comes
  // from the damage, not from the setup.
  it.each([
    ["intact", {}, null],
    ["no share id", { shareId: undefined }, SharePinInvalidError],
    ["a share id past the wire bound", { shareId: "s".repeat(201) }, SharedFileReadOnlyError],
    ["no recipient", { recipientUserId: undefined }, SharedFileReadOnlyError],
    ["an empty recipient", { recipientUserId: "" }, SharedFileReadOnlyError],
  ] as const)("admits an Edit write through a registry marker only when it is %s", async (_name, damage, refusal) => {
    const rootPath = await workspaceRoot();
    const store = mutableTextStore();
    const workspace = {
      workspaceId: "workspace-a",
      rootPath,
      shareView: {
        shareId: "share-a",
        recipientUserId: "recipient-a",
        granterEmail: "granter@example.com",
        grantedSelector: { paths: [], versionId: "main", access: "edit" },
        ...damage,
      },
    };
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: (requested) =>
        resolveRegisteredShareViewFilesTarget(workspace, requested),
      openStore: () => store,
    });

    const created = withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
      files.change(
        lease,
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "create", path: "notes/new.md", initialText: "new\n" },
      ),
    );

    if (refusal === null) {
      await expect(created).resolves.toMatchObject({ status: "committed" });
      return;
    }
    await expect(created).rejects.toBeInstanceOf(refusal);
    expect(store.writeTextFile).not.toHaveBeenCalled();
  });

  it("refuses a dynamically chosen import path outside the pinned grant", async () => {
    const rootPath = await workspaceRoot();
    const source = join(rootPath, "outside.txt");
    await writeFile(source, "outside\n", "utf8");
    const store = mutableTextStore();
    const scoped = {
      ...target(rootPath),
      grantedSelector: {
        paths: ["notes"],
        versionId: null,
        access: "edit" as const,
      },
    };
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => scoped,
      openStore: () => store,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "import",
            absolutePaths: [source],
            screenAgainstRoots: null,
            targetDir: undefined,
          },
        ),
      ),
    ).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    expect(store.writeTextFile).not.toHaveBeenCalled();
  });

  it("keeps a mount store warm across canonical reads and listings", async () => {
    const rootPath = await workspaceRoot();
    const store = Object.assign(readStore({ text: "canonical\n" }), {
      close: vi.fn(async () => undefined),
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => mountTarget(rootPath),
      openStore: () => store,
    });
    const requested = {
      kind: "mount" as const,
      workspaceId: "host-a",
      shareId: "share-a",
    };

    await files.read(requested, { kind: "text", path: "notes/a.md" });
    await files.list(requested);

    expect(store.close).not.toHaveBeenCalled();
  });

  it("validates a mount root before canonical or sidecar access", async () => {
    const rootPath = await workspaceRoot();
    const unsafeRoot = new Error("mount root escaped its host workspace");
    const assertProjectionRoot = vi.fn(async () => {
      throw unsafeRoot;
    });
    const openStore = vi.fn(() => readStore({ text: "must not open" }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      assertProjectionRoot,
      resolveTarget: () => mountTarget(rootPath),
      openStore,
    });
    const requested = {
      kind: "mount" as const,
      workspaceId: "host-a",
      shareId: "share-a",
    };
    const operations: Array<{ name: string; run: () => Promise<unknown> }> = [
      {
        name: "read",
        run: () => files.read(requested, { kind: "text", path: "notes/a.md" }),
      },
      { name: "list", run: () => files.list(requested) },
      {
        name: "projection status",
        run: () => files.projectionStatus(requested),
      },
      {
        name: "reconcile",
        run: () =>
          withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
            files.reconcile(lease, requested, "repair"),
          ),
      },
    ];

    for (const operation of operations) {
      assertProjectionRoot.mockClear();
      openStore.mockClear();

      await expect(operation.run(), operation.name).rejects.toBe(unsafeRoot);
      expect(assertProjectionRoot, operation.name).toHaveBeenCalledOnce();
      expect(openStore, operation.name).not.toHaveBeenCalled();
    }
  });

  it("can remove a damaged mount record without validating its folder", async () => {
    const rootPath = await workspaceRoot();
    const removeMount = vi.fn(async () => ({ folderLeft: true }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => ({
        ...mountTarget(rootPath),
        rootPath,
        mountLabel: "../damaged",
      }),
      openStore: () => readStore({ text: "must not open" }),
      assertProjectionRoot: vi.fn(async () => {
        throw new Error("an unusable label has no safe folder to validate");
      }),
      removeMount,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.unmount(lease, {
          kind: "mount",
          workspaceId: "host-a",
          shareId: "share-a",
        }),
      ),
    ).resolves.toEqual({ folderLeft: true });
    expect(removeMount).toHaveBeenCalledTimes(1);
  });

  it("reports bounded durable projection debt", async () => {
    const rootPath = await workspaceRoot();
    await seedPendingMaterializationPaths(
      rootPath,
      Array.from({ length: 25 }, (_, index) => `notes/${index}.md`),
    );
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => readStore({ text: "unused" }),
    });

    await expect(
      files.projectionStatus({
        kind: "standalone",
        workspaceId: "workspace-a",
      }),
    ).resolves.toMatchObject({
      state: "pending",
      pendingPathCount: 25,
      pendingPaths: expect.arrayContaining(["notes/0.md", "notes/1.md"]),
      collisionPathCount: 0,
      pullInFlight: false,
    });
  });

  it.each([
    ["an invalid", "not json"],
    [
      "a stale",
      JSON.stringify({ shareId: "share-old", paths: ["notes/stale.md"] }),
    ],
  ])(
    "leaves %s collision record untouched for capture to quarantine",
    async (_recordKind, serialized) => {
      const rootPath = await workspaceRoot();
      const metadataPath = recordsDir(rootPath);
      const collisionPath = await writeRecord(
        rootPath,
        "share-collision-record.json",
        serialized,
      );
      const store = readStore({ text: "canonical\n" });
      const files = createShareViewFiles({
        ...unusedReconcilePorts,
        resolveTarget: () => target(rootPath),
        openStore: () => store,
      });
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        await expect(
          files.projectionStatus({
            kind: "standalone",
            workspaceId: "workspace-a",
          }),
        ).resolves.toEqual({
          state: "pending",
          pendingPathCount: 0,
          pendingPaths: [],
          collisionPathCount: 0,
          collisionPaths: [],
          pullInFlight: false,
        });
        await expect(readFile(collisionPath, "utf8")).resolves.toBe(serialized);
        expect(await readdir(metadataPath)).toEqual([
          "share-collision-record.json",
        ]);
        expect(errorLog).not.toHaveBeenCalled();

        await expect(
          withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
            files.reconcile(
              lease,
              { kind: "standalone", workspaceId: "workspace-a" },
              "settle",
            ),
          ),
        ).resolves.toMatchObject({
          kind: "settle",
          collisionRecordQuarantined: true,
        });
        expect(errorLog).toHaveBeenCalledOnce();
      } finally {
        errorLog.mockRestore();
      }
      await expect(lstat(collisionPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(metadataPath)).toEqual([
        expect.stringMatching(/^share-collision-record\.json\.invalid-\d+$/),
      ]);
    },
  );

  it("reports a committed change when only its folder projection fails", async () => {
    const rootPath = await workspaceRoot();
    await writeFile(join(rootPath, "blocked"), "recipient file\n", "utf8");
    const store = mutableTextStore();
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "create",
            path: "blocked/new.md",
            initialText: "canonical\n",
          },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      kind: "create",
      value: "blocked/new.md",
      projection: "pending",
    });
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "blocked/new.md" },
      ),
    ).resolves.toMatchObject({ text: "canonical\n" });
    await expect(
      files.projectionStatus({
        kind: "standalone",
        workspaceId: "workspace-a",
      }),
    ).resolves.toMatchObject({ state: "pending", pendingPathCount: 1 });
  });

  it("does not retry a mutation whose daemon response is indeterminate", async () => {
    const rootPath = await workspaceRoot();
    const transportError = Object.assign(new Error("daemon timed out"), {
      code: "transport-error",
    });
    const store = mutableTextStore();
    vi.mocked(store.writeTextFile).mockRejectedValueOnce(transportError);
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "create", path: "notes/new.md", initialText: "maybe\n" },
        ),
    );

    expect(outcome).toMatchObject({
      status: "indeterminate",
      kind: "create",
      projection: "pending",
      possibleEffects: [],
    });
    expect(store.writeTextFile).toHaveBeenCalledTimes(1);
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "notes/new.md" },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors a canonical commit proved after a lost daemon response", async () => {
    const rootPath = await workspaceRoot();
    const transportError = Object.assign(new Error("daemon timed out"), {
      code: "transport-error",
    });
    const store = mutableTextStore({
      afterWrite: () => {
        throw transportError;
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "create", path: "notes/new.md", initialText: "landed\n" },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      kind: "create",
      projection: "pending",
      value: "notes/new.md",
    });
    expect(store.writeTextFile).toHaveBeenCalledTimes(1);
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "notes/new.md" },
      ),
    ).resolves.toMatchObject({ text: "landed\n" });
  });

  it("checks a save against canonical content while its folder is stale", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await seedPendingMaterializationPaths(rootPath, ["notes/a.md"]);
    const canonical = "canonical before\n";
    const store = mutableTextStore({
      initial: [{ path: "notes/a.md", text: canonical }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "save",
            path: "notes/a.md",
            text: "recipient edit\n",
            expectedContentHash: createHash("sha256")
              .update(canonical)
              .digest("hex"),
          },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      projection: "current",
    });
    await expect(
      readFile(join(rootPath, "notes", "a.md"), "utf8"),
    ).resolves.toBe("recipient edit\n");
  });

  it("captures an unmarked agent edit before checking a save conflict", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "notes"), { recursive: true });
    const canonical = "canonical before\n";
    await writeFile(join(rootPath, "notes", "a.md"), canonical, "utf8");
    const store = mutableTextStore({
      initial: [{ path: "notes/a.md", text: canonical }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });
    await writeFile(join(rootPath, "notes", "a.md"), "agent edit\n", "utf8");

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "save",
            path: "notes/a.md",
            text: "recipient edit\n",
            expectedContentHash: createHash("sha256")
              .update(canonical)
              .digest("hex"),
          },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      value: {
        status: "conflict",
        currentContentHash: createHash("sha256")
          .update("agent edit\n")
          .digest("hex"),
      },
    });
    await expect(
      readFile(join(rootPath, "notes", "a.md"), "utf8"),
    ).resolves.toBe("agent edit\n");
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "notes/a.md" },
      ),
    ).resolves.toMatchObject({ text: "agent edit\n" });
  });

  it("reports the exact canonical prefix when a folder delete stops part way", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "a.md"), "a\n", "utf8");
    await writeFile(join(rootPath, "docs", "b.md"), "b\n", "utf8");
    let deletes = 0;
    const store = mutableTextStore({
      initial: [
        { path: "docs/a.md", text: "a\n" },
        { path: "docs/b.md", text: "b\n" },
      ],
      beforeDelete: () => {
        deletes += 1;
        if (deletes === 2) throw new Error("engine refused the second delete");
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "delete", path: "docs" },
        ),
    );

    expect(outcome).toMatchObject({
      status: "partial",
      projection: "pending",
      effects: [{ path: "docs/a.md", before: "present", after: "absent" }],
    });
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/a.md" },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/b.md" },
      ),
    ).resolves.toMatchObject({ text: "b\n" });
  });

  it("rethrows a failed folder move after every landed rename is put back", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs", "plans"), { recursive: true });
    await writeFile(join(rootPath, "docs", "plans", "a.md"), "a\n", "utf8");
    await writeFile(join(rootPath, "docs", "plans", "b.md"), "b\n", "utf8");
    let renames = 0;
    const store = mutableTextStore({
      initial: [
        { path: "docs/plans/a.md", text: "a\n" },
        { path: "docs/plans/b.md", text: "b\n" },
      ],
      afterRename: () => {
        renames += 1;
        if (renames === 2) throw new Error("engine refused the folder move");
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "move",
            fromPath: "docs/plans",
            toPath: "docs/roadmap",
          },
        ),
      ),
    ).rejects.toThrow("engine refused the folder move");
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/plans/a.md" },
      ),
    ).resolves.toMatchObject({ text: "a\n" });
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/plans/b.md" },
      ),
    ).resolves.toMatchObject({ text: "b\n" });
  });

  it("refuses a move through a physical alias into its source before changing the store", async () => {
    const rootPath = await workspaceRoot();
    const plans = join(rootPath, "docs", "plans");
    await mkdir(plans, { recursive: true });
    await writeFile(join(plans, "a.md"), "a\n", "utf8");
    await symlink(plans, join(rootPath, "docs", "alias"), "junction");
    const store = mutableTextStore({
      initial: [{ path: "docs/plans/a.md", text: "a\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "move",
            fromPath: "docs/plans",
            toPath: "docs/alias/archive",
          },
        ),
      ),
    ).rejects.toThrow("Cannot move a path into itself: docs/plans");

    expect(store.renameTextFile).not.toHaveBeenCalled();
    await expect(readFile(join(plans, "a.md"), "utf8")).resolves.toBe("a\n");
    await expect(
      readSharedViewProjectionDebt(rootPath, "share-a"),
    ).resolves.toMatchObject({ pendingPaths: new Set() });
  });

  it("refuses when the physical source disappears before move identity preflight", async () => {
    const rootPath = await workspaceRoot();
    const plans = join(rootPath, "docs", "Plans");
    await mkdir(plans, { recursive: true });
    await writeFile(join(plans, "a.md"), "a\n", "utf8");
    let metadataReads = 0;
    const store = mutableTextStore({
      initial: [{ path: "docs/Plans/a.md", text: "a\n" }],
      afterMetadataRead: (read) => {
        // Three reads finish capture, the before-snapshot, and the move seam's
        // source set. Removal waits for that seam's exact physical probe below.
        metadataReads = read;
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const originalRealpath = fsPromises.realpath.bind(fsPromises);
    let removedAtSourcePreflight = 0;
    const realpath = vi
      .spyOn(fsPromises, "realpath")
      .mockImplementation(async (path) => {
        if (
          metadataReads >= 3 &&
          removedAtSourcePreflight === 0 &&
          String(path) === plans
        ) {
          removedAtSourcePreflight += 1;
          await rm(plans, { recursive: true });
        }
        return originalRealpath(path);
      });
    try {
      await expect(
        withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
          files.change(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            {
              kind: "move",
              fromPath: "docs/Plans",
              toPath: "docs/plans/archive",
            },
          ),
        ),
      ).rejects.toThrow("missing from this shared view");

      expect(removedAtSourcePreflight).toBe(1);
      expect(store.renameTextFile).not.toHaveBeenCalled();
      await expect(
        readSharedViewProjectionDebt(rootPath, "share-a"),
      ).resolves.toMatchObject({ pendingPaths: new Set() });
    } finally {
      realpath.mockRestore();
    }
  });

  it("lists folders a fixed number of times before a case-only folder rename", async (context) => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs", "plans"), { recursive: true });
    if (!(await lstat(join(rootPath, "docs", "Plans")).then(() => true, () => false))) context.skip("this disk keeps case apart");
    const initial = Array.from({ length: 12 }, (_, index) => ({ path: `docs/plans/${index}.md`, text: "body\n" }));
    for (const file of initial) await writeFile(join(rootPath, file.path), file.text);
    const listing = vi.spyOn(fsPromises, "readdir");
    let beforeMutation = 0;
    const store = mutableTextStore({
      initial,
      afterRename: () => { beforeMutation ||= listing.mock.calls.filter(([path]) => String(path) === rootPath).length; },
    });
    const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => target(rootPath), openStore: () => store });
    try {
      await withStaleSensitiveWorkspaceOperation(rootPath, (lease) => files.change(
        lease, { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "move", fromPath: "docs/plans", toPath: "docs/Plans" },
      ));
      expect(beforeMutation).toBe(2);
      expect(store.renameTextFile).toHaveBeenCalledTimes(initial.length);
    } finally {
      listing.mockRestore();
    }
  });

  for (const kind of ["folder", "file"] as const) {
    it(`keeps a case-only ${kind} rename when realpath keeps lookup case`, async (context) => {
      const rootPath = await workspaceRoot();
      const from = kind === "folder" ? "docs/plans" : "docs/plans/a.md";
      const to = kind === "folder" ? "docs/Plans" : "docs/plans/A.md";
      const plans = join(rootPath, "docs", "plans");
      await mkdir(plans, { recursive: true });
      await writeFile(join(plans, "a.md"), "a\n", "utf8");
      if (!(await lstat(join(rootPath, to)).then(() => true, () => false))) context.skip("this disk keeps case apart");
      const store = mutableTextStore({
        initial: [{ path: "docs/plans/a.md", text: "a\n" }],
      });
      const files = createShareViewFiles({
        ...unusedReconcilePorts,
        resolveTarget: () => target(rootPath),
        openStore: () => store,
      });

      const originalRealpath = fsPromises.realpath.bind(fsPromises);
      // Linux resolves links but keeps lookup case on a disk that ignores it.
      const realpath = vi
        .spyOn(fsPromises, "realpath")
        .mockImplementation(async (path) => {
          const resolved = await originalRealpath(path);
          return String(path).startsWith(`${rootPath}${sep}`) ? String(path) : resolved;
        });
      try {
        await expect(
          withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
            files.change(
              lease,
              { kind: "standalone", workspaceId: "workspace-a" },
              {
                kind: "move",
                fromPath: from,
                toPath: to,
              },
            ),
          ),
        ).resolves.toMatchObject({ status: "committed", value: to });

        expect(store.renameTextFile).toHaveBeenCalledWith(
          expect.objectContaining({
            fromPath: "docs/plans/a.md",
            toPath: kind === "folder" ? "docs/Plans/a.md" : to,
          }),
        );
        await expect(readdir(kind === "folder" ? join(rootPath, "docs") : plans)).resolves.toEqual([kind === "folder" ? "Plans" : "A.md"]);
        await expect(readFile(join(rootPath, kind === "folder" ? "docs/Plans/a.md" : to), "utf8")).resolves.toBe("a\n");
      } finally {
        realpath.mockRestore();
      }
    });
  }

  it("refuses a move into a case alias's missing tail before changing the store", async (context) => {
    const rootPath = await workspaceRoot();
    const plans = join(rootPath, "docs", "Plans");
    await mkdir(plans, { recursive: true });
    await writeFile(join(plans, "a.md"), "a\n");
    if (!(await lstat(join(rootPath, "docs", "plans")).then(() => true, () => false))) context.skip("this disk keeps case apart");
    const store = mutableTextStore({ initial: [{ path: "docs/Plans/a.md", text: "a\n" }] });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });
    const originalRealpath = fsPromises.realpath.bind(fsPromises);
    const realpath = vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => {
      const resolved = await originalRealpath(path);
      return String(path).startsWith(`${rootPath}${sep}`) ? String(path) : resolved;
    });
    try {
      await expect(withStaleSensitiveWorkspaceOperation(rootPath, (lease) => files.change(
        lease,
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "move", fromPath: "docs/Plans", toPath: "docs/plans/archive/Deep" },
      ))).rejects.toThrow("Cannot move a path into itself: docs/Plans");
      expect(store.renameTextFile).not.toHaveBeenCalled();
      await expect(readFile(join(plans, "a.md"), "utf8")).resolves.toBe("a\n");
      await expect(readSharedViewProjectionDebt(rootPath, "share-a")).resolves.toMatchObject({ pendingPaths: new Set() });
    } finally {
      realpath.mockRestore();
    }
  });

  it("refuses a move when the disk cannot name its source before changing the store", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"));
    await writeFile(join(rootPath, "docs", "before.md"), "body\n");
    const originalLstat = fsPromises.lstat.bind(fsPromises);
    const spelling = vi.spyOn(fsPromises, "lstat");
    const store = mutableTextStore({
      initial: [{ path: "docs/before.md", text: "body\n" }],
      afterMetadataRead: (read) => {
        if (read >= 3) spelling.mockImplementation((path, options) => {
          if (String(path) === join(rootPath, "docs", "before.md")) throw new Error("identity unavailable");
          return originalLstat(path, options);
        });
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });
    try {
      await expect(withStaleSensitiveWorkspaceOperation(rootPath, (lease) => files.change(
        lease,
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "move", fromPath: "docs/before.md", toPath: "docs/after.md" },
      ))).rejects.toThrow("dohc did not rename docs/before.md to docs/after.md. dohc could not tell which files on disk they are. Check both paths in your file manager before trying again.");
      expect(store.renameTextFile).not.toHaveBeenCalled();
      await expect(readFile(join(rootPath, "docs", "before.md"), "utf8")).resolves.toBe("body\n");
      await expect(readSharedViewProjectionDebt(rootPath, "share-a")).resolves.toMatchObject({ pendingPaths: new Set() });
    } finally {
      spelling.mockRestore();
    }
  });

  it("does not compensate a rename after an indeterminate daemon response", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "before.md"), "body\n", "utf8");
    const transportError = Object.assign(new Error("daemon timed out"), {
      code: "transport-error",
    });
    const store = mutableTextStore({
      initial: [{ path: "docs/before.md", text: "body\n" }],
      afterRename: () => {
        throw transportError;
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "move",
            fromPath: "docs/before.md",
            toPath: "docs/after.md",
          },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      projection: "pending",
    });
    expect(store.renameTextFile).toHaveBeenCalledTimes(1);
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/after.md" },
      ),
    ).resolves.toMatchObject({ text: "body\n" });
  });

  it("does not report a rejected same-path move as committed", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "note.md"), "body\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path: "docs/note.md", text: "body\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "move",
            fromPath: "docs/note.md",
            toPath: "docs/note.md",
          },
        ),
      ),
    ).rejects.toThrow("Cannot move a path into itself");
    expect(store.renameTextFile).not.toHaveBeenCalled();
  });

});

it("keeps link reads inside the share target gate and tracked-path floor, including ended local shares", async () => {
  const rootPath = await workspaceRoot();
  const requested = { kind: "standalone" as const, workspaceId: "workspace-a" };
  let current: ResolvedShareViewFilesTarget | null = { ...target(rootPath), ended: true };
  const page = { versionId: "main", subject: { path: "notes/a.md", objectId: "a" }, entries: [
    { source: "notes/b.md", title: "B", ordinal: 0, span: [0, 5] as [number, number], line: 1, snippet: "[[a]]", highlightStart: 0, highlightEnd: 5 },
    { source: ".env", title: "secret", ordinal: 0, span: [0, 5] as [number, number], line: 1, snippet: "[[a]]", highlightStart: 0, highlightEnd: 5 },
  ], unchecked: ["notes/c.md", ".env"], nextCursor: null, complete: false, indexBuilding: false, mountsCovered: true };
  const store = Object.assign(readStore({ text: "" }), {
    incomingLinks: vi.fn(async () => page),
    resolveLinks: vi.fn(async () => ({ versionId: "main", results: [{ path: "notes/a.md", fragment: null }, { path: ".env", fragment: null }, { path: null, create: "notes/new.md", fragment: null }, { path: null, create: ".env.local", fragment: null }], mountsCovered: true })),
  });
  const openStore = vi.fn(() => store);
  const files = createShareViewFiles({ ...unusedReconcilePorts, resolveTarget: () => current, openStore });
  expect(await files.linksIn(requested, { subject: { path: "notes/a.md" } })).toMatchObject({ entries: [page.entries[0]], unchecked: ["notes/c.md"] });
  expect(await files.linksResolve(requested, { source: "notes/b.md", literals: [{ kind: "wikilink", literal: "a" }, { kind: "wikilink", literal: ".env" }] })).toMatchObject({ results: [{ path: "notes/a.md", fragment: null }, null, { path: null, create: "notes/new.md", fragment: null }, null] });
  await expect(files.linksResolve(requested, { source: ".env", literals: [] })).rejects.toBeInstanceOf(SharedFileReadOnlyError);
  await withShareViewRefreshLifecycleLock(rootPath, async () => {
    const pending = files.linksIn(requested, { subject: { path: "notes/a.md" } });
    current = null;
    return { pending };
  }).then(async ({ pending }) => { await expect(pending).rejects.toThrow(); });
  expect(openStore).toHaveBeenCalledTimes(3);
});

it("filters edge file metadata, both endpoints, and unchecked paths through the projected share lease", async () => {
  const rootPath=await workspaceRoot();
  const requested={kind:"standalone" as const,workspaceId:"workspace-a"};
  let current: ResolvedShareViewFilesTarget | null={...target(rootPath),ended:true};
  const page={versionId:"main",files:[{objectId:"a",path:"notes/a.md",title:"A"},{objectId:"secret",path:".env",title:"Secret"}],
    entries:[{source:"notes/a.md",target:"notes/b.md",kind:"markdown" as const,ordinal:0},
      {source:"notes/a.md",target:".env",kind:"markdown" as const,ordinal:1},
      {source:".env",target:"notes/a.md",kind:"markdown" as const,ordinal:2}],
    unchecked:["notes/pending.md",".env"],complete:false,indexBuilding:false,mountsCovered:true,nextCursor:"sealed"};
  const store=Object.assign(readStore({text:""}),{linkEdges:vi.fn(async()=>page)});
  const openStore=vi.fn(()=>store);
  const files=createShareViewFiles({...unusedReconcilePorts,resolveTarget:()=>current,openStore});
  expect(await files.linksEdges(requested,{})).toEqual({...page,files:[page.files[0]],entries:[page.entries[0]],unchecked:["notes/pending.md"]});
  await withShareViewRefreshLifecycleLock(rootPath,async()=>{
    const pending=files.linksEdges(requested,{cursor:"sealed"});
    current=null;
    return {pending};
  }).then(async({pending})=>{await expect(pending).rejects.toThrow();});
  expect(openStore).toHaveBeenCalledOnce();
});
