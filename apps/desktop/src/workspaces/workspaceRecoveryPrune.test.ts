import { access, lstat, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "./testTemp";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { saveRecoveryRecord, scheduleRecoveryPrune } from "./workspaceDeleteRecovery";

vi.mock("./workspaceMetadata", async original => {
  const actual = await original<typeof import("./workspaceMetadata")>();
  return { ...actual, resolveWorkspaceMetadataDir: vi.fn(actual.resolveWorkspaceMetadataDir) };
});

afterEach(() => vi.restoreAllMocks());

function scheduledPrune(root: string): () => Promise<void> {
  let run: (() => unknown) | undefined;
  const immediate = globalThis.setImmediate;
  const scheduling = vi.spyOn(globalThis, "setImmediate").mockImplementationOnce(callback => {
    run = callback;
    return immediate(() => undefined);
  });
  try {
    scheduleRecoveryPrune(root);
  } finally {
    scheduling.mockRestore();
  }
  if (!run) throw new Error("Prune was not scheduled");
  const scheduled = run;
  return async () => { await scheduled(); };
}

const expiredName = `delete-${"a".repeat(64)}.json`;
const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);

describe("recovery pruning", () => {
  it("leaves removed metadata absent when its scheduled prune runs", async () => {
    const root = await createTestScratch("prune-removed-");
    const metadata = join(root, ".dohc");
    await mkdir(join(metadata, "trash"), { recursive: true });
    const prune = scheduledPrune(root);
    await rm(metadata, { recursive: true });
    await prune();
    await expect(access(metadata)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recreate metadata removed during the prune's lookup", async () => {
    const root = await createTestScratch("prune-raced-");
    const metadata = join(root, ".dohc");
    await mkdir(join(metadata, "trash"), { recursive: true });
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
    const root = await createTestScratch("prune-missing-trash-");
    await mkdir(join(root, ".dohc"));
    await scheduledPrune(root)();
    await expect(access(join(root, ".dohc", "trash"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes expired recovery records while keeping recent records and staged contents", async () => {
    const root = await createTestScratch("prune-existing-");
    const trash = join(root, ".dohc", "trash");
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

  it.each(["inside", "outside"] as const)("does not prune through a trash link pointing %s the workspace", async location => {
    const root = await createTestScratch("prune-linked-");
    const target = location === "inside" ? join(root, "target") : await createTestScratch("prune-outside-");
    await mkdir(target, { recursive: true });
    await mkdir(join(root, ".dohc"));
    const record = join(target, expiredName);
    await writeFile(record, "keep");
    await utimes(record, old, old);
    const trash = join(root, ".dohc", "trash");
    await symlink(target, trash, process.platform === "win32" ? "junction" : "dir");
    await scheduledPrune(root)();
    expect(await readFile(record, "utf8")).toBe("keep");
    expect((await lstat(trash)).isSymbolicLink()).toBe(true);
  });

  it("keeps a non-directory trash entry", async () => {
    const root = await createTestScratch("prune-file-");
    await mkdir(join(root, ".dohc"));
    const trash = join(root, ".dohc", "trash");
    await writeFile(trash, "keep");
    await scheduledPrune(root)();
    expect(await readFile(trash, "utf8")).toBe("keep");
  });

  it("still creates the trash folder when saving a recovery record", async () => {
    const root = await createTestScratch("prune-save-");
    const record = { operationId: "dohc-operation:11111111-1111-4111-8111-111111111111" };
    await saveRecoveryRecord(root, record);
    const { createHash } = await import("node:crypto");
    const name = `delete-${createHash("sha256").update(record.operationId).digest("hex")}.json`;
    expect(JSON.parse(await readFile(join(root, ".dohc", "trash", name), "utf8"))).toEqual(record);
  });
});
