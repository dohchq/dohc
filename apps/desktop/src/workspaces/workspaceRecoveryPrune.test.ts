import { access, lstat, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { openedLocalState } from "../testing/preparedLocalState";
import { createTestScratch } from "./testTemp";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { saveRecoveryRecord, scheduleRecoveryPrune, waitForRecoveryPrune } from "./workspaceDeleteRecovery";

vi.mock("./workspaceMetadata", async original => {
  const actual = await original<typeof import("./workspaceMetadata")>();
  return { ...actual, resolveWorkspaceMetadataDir: vi.fn(actual.resolveWorkspaceMetadataDir) };
});

afterEach(() => vi.restoreAllMocks());

const workspaceAt = (rootPath: string) => ({ workspaceId: "prune", rootPath });

// A workspace whose engine open prepared `.dohc/local`.
async function opened(prefix: string) {
  const root = await createTestScratch(prefix);
  await openedLocalState(workspaceAt(root));
  return root;
}

function scheduledPrune(root: string): () => Promise<void> {
  let run: (() => unknown) | undefined;
  const immediate = globalThis.setImmediate;
  const scheduling = vi.spyOn(globalThis, "setImmediate").mockImplementationOnce(callback => {
    run = callback;
    return immediate(() => undefined);
  });
  try {
    scheduleRecoveryPrune(workspaceAt(root));
  } finally {
    scheduling.mockRestore();
  }
  if (!run) throw new Error("Prune was not scheduled");
  const scheduled = run;
  return async () => {
    scheduled();
    await waitForRecoveryPrune(root);
  };
}

const expiredName = `delete-${"a".repeat(64)}.json`;
const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);

describe("recovery pruning", () => {
  it("leaves removed metadata absent when its scheduled prune runs", async () => {
    const root = await opened("prune-removed-");
    const metadata = join(root, ".dohc");
    await mkdir(join(metadata, "local", "trash"), { recursive: true });
    const prune = scheduledPrune(root);
    await rm(metadata, { recursive: true });
    await prune();
    await expect(access(metadata)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recreate metadata removed during the prune's lookup", async () => {
    const root = await opened("prune-raced-");
    const metadata = join(root, ".dohc");
    await mkdir(join(metadata, "local", "trash"), { recursive: true });
    const entered = deferred(), release = deferred();
    const lookup = vi.mocked(resolveWorkspaceMetadataDir);
    const actual = lookup.getMockImplementation()!;
    lookup.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return actual(...args);
    });
    const pruning = scheduledPrune(root)();
    try {
      await entered.promise;
      await rm(metadata, { recursive: true });
    } finally {
      release.resolve();
      await pruning;
    }
    await expect(access(metadata)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a missing trash folder absent", async () => {
    const root = await opened("prune-missing-trash-");
    await scheduledPrune(root)();
    await expect(access(join(root, ".dohc", "local", "trash"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([".dohc", ".dohc/local"])("keeps a linked %s and its expired recovery records untouched", async linked => {
    const root = await opened("prune-linked-metadata-");
    const target = join(root, "metadata-target");
    const trash = join(target, ...(linked === ".dohc" ? ["local", "trash"] : ["trash"]));
    await mkdir(trash, { recursive: true });
    const record = join(trash, expiredName);
    await writeFile(record, "keep");
    await utimes(record, old, old);
    const link = join(root, linked);
    await rm(link, { recursive: true });
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await scheduledPrune(root)();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(record, "utf8")).toBe("keep");
    expect((await readdir(root)).sort()).toEqual([".dohc", "metadata-target"]);
    expect(await readdir(trash)).toEqual([expiredName]);
  });

  it("keeps a metadata file without replacing it with recovery storage", async () => {
    const root = await opened("prune-metadata-file-");
    const metadata = join(root, ".dohc");
    await rm(metadata, { recursive: true });
    await writeFile(metadata, "keep");
    await scheduledPrune(root)();
    expect((await lstat(metadata)).isFile()).toBe(true);
    expect(await readFile(metadata, "utf8")).toBe("keep");
    expect(await readdir(root)).toEqual([".dohc"]);
  });

  it("removes expired recovery records while keeping recent records and staged contents", async () => {
    const root = await opened("prune-existing-");
    const trash = join(root, ".dohc", "local", "trash");
    await mkdir(trash, { recursive: true });
    const recent = `move-${"b".repeat(64)}.json`;
    const staged = "delete-staged-notes";
    for (const name of [expiredName, recent, staged]) await writeFile(join(trash, name), name);
    await utimes(join(trash, expiredName), old, old);
    await utimes(join(trash, staged), old, old);
    await scheduledPrune(root)();
    await expect(access(join(trash, expiredName))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(trash, recent), "utf8")).toBe(recent);
    expect(await readFile(join(trash, staged), "utf8")).toBe(staged);
  });

  it.each([false, true])("prunes only once the workspace's open prepares .dohc/local, and never the old .dohc/trash (opened=%s)", async open => {
    const root = await createTestScratch("prune-not-opened-");
    const trash = join(root, ".dohc", "local", "trash"), oldTrash = join(root, ".dohc", "trash");
    for (const dir of [trash, oldTrash]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, expiredName), "keep");
      await utimes(join(dir, expiredName), old, old);
    }
    if (open) await openedLocalState(workspaceAt(root));
    await scheduledPrune(root)();
    if (open) await expect(access(join(trash, expiredName))).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(join(trash, expiredName), "utf8")).toBe("keep");
    expect(await readFile(join(oldTrash, expiredName), "utf8")).toBe("keep");
  });

  it.each(["inside", "outside"] as const)("does not prune through a trash link pointing %s the workspace", async location => {
    const root = await opened("prune-linked-");
    const target = location === "inside" ? join(root, "target") : await createTestScratch("prune-outside-");
    await mkdir(target, { recursive: true });
    const record = join(target, expiredName);
    await writeFile(record, "keep");
    await utimes(record, old, old);
    const trash = join(root, ".dohc", "local", "trash");
    await symlink(target, trash, process.platform === "win32" ? "junction" : "dir");
    await scheduledPrune(root)();
    expect(await readFile(record, "utf8")).toBe("keep");
    expect((await lstat(trash)).isSymbolicLink()).toBe(true);
  });

  it("keeps a non-directory trash entry", async () => {
    const root = await opened("prune-file-");
    const trash = join(root, ".dohc", "local", "trash");
    await writeFile(trash, "keep");
    await scheduledPrune(root)();
    expect(await readFile(trash, "utf8")).toBe("keep");
  });

  it("still creates the trash folder, private, when saving a recovery record", async () => {
    const root = await opened("prune-save-");
    const record = { operationId: "dohc-operation:11111111-1111-4111-8111-111111111111" };
    await saveRecoveryRecord(workspaceAt(root), record);
    const { createHash } = await import("node:crypto");
    const name = `delete-${createHash("sha256").update(record.operationId).digest("hex")}.json`;
    const trash = join(root, ".dohc", "local", "trash");
    expect(JSON.parse(await readFile(join(trash, name), "utf8"))).toEqual(record);
    if (process.platform !== "win32") {
      expect((await lstat(trash)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(trash, name))).mode & 0o777).toBe(0o600);
    }
    await expect(access(join(root, ".dohc", "trash"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
