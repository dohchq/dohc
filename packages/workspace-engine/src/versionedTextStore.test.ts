import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_VERSIONED_TEXT_FILE_BYTES,
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  VersionedTextStoreError,
  createVersionedTextStore,
} from "./versionedTextStore";
import { createTestableVersionedTextStore as createVersionedTextStoreForTest } from "./testing";

let root: string;
let now = 1000;

beforeEach(async () => {
  root = "";
  root = await mkdtemp(join(tmpdir(), "dohc-versioned-text-"));
  now = 1000;
});

afterEach(async () => {
  if (!root) return;
  const currentRoot = root;
  root = "";
  await rm(currentRoot, { recursive: true, force: true });
});

function storeWithDeterministicIds() {
  const counters = { moment: 0, object: 0, version: 0 };
  return createVersionedTextStore(root, {
    nowMs: () => {
      now += 10;
      return now;
    },
    createId: (kind) => {
      counters[kind] += 1;
      return `${kind}-${counters[kind]}`;
    },
  });
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type TestableVersionedTextStoreOptions = NonNullable<
  Parameters<typeof createVersionedTextStoreForTest>[1]
> & {
  testHooks?: Parameters<typeof createVersionedTextStoreForTest>[2];
};

function createTestableVersionedTextStore(options: TestableVersionedTextStoreOptions) {
  const { testHooks, ...runtimeOptions } = options;
  return createVersionedTextStoreForTest(root, runtimeOptions, testHooks);
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

async function expectStoreError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VersionedTextStoreError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected VersionedTextStoreError with code ${code}.`);
}

async function ensureStoreStateDir(): Promise<void> {
  await mkdir(dirname(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH)), { recursive: true });
}

function storeLockDir(): string {
  return join(root, `${VERSIONED_TEXT_STORE_RELATIVE_PATH}.lock`);
}

const localFileWrite = { origin: "local-file" as const, summary: "local save" };
const apiWrite = { origin: "api" as const, correlationId: "request-1" };
const unsafeWorkspacePaths = [
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  "../escape.md",
  "%2e%2e/escape.md",
  "%252e%252e%252fescape.md",
  "..\\escape.md",
  "..%5cescape.md",
  "/tmp/escape.md",
  "%2ftmp%2fescape.md",
  "C:\\tmp\\escape.md",
];

describe("versioned text store", () => {
  it("creates Main and a named version with isolated text for the same file", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const firstWrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Main draft\n",
      metadata: localFileWrite,
    });

    const version = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Idea branch",
      fromVersionId: main.id,
    });

    expect(version).toMatchObject({
      id: "version-1",
      kind: "named",
      forkPoint: { versionId: "main", momentId: firstWrite.moment.id },
    });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: version.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: firstWrite.object.id,
      text: "Main draft\n",
    });

    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Main keeps going\n",
      metadata: localFileWrite,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: version.id,
      path: "notes/today.md",
      text: "Named version diverges\n",
      metadata: apiWrite,
    });

    const mainSnapshot = await store.readTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
    });
    const namedSnapshot = await store.readTextFile({
      workspaceId: "workspace-a",
      versionId: version.id,
      path: "notes/today.md",
    });

    expect(mainSnapshot).toMatchObject({
      objectId: firstWrite.object.id,
      text: "Main keeps going\n",
      metadata: localFileWrite,
    });
    expect(namedSnapshot).toMatchObject({
      objectId: firstWrite.object.id,
      text: "Named version diverges\n",
      metadata: apiWrite,
    });
    expect(await store.listVersions({ workspaceId: "workspace-a" })).toHaveLength(2);
  });

  it("renames a file inside one version without changing its stable object id", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Keep this identity\n",
      metadata: localFileWrite,
    });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Rename experiment",
      fromVersionId: main.id,
    });

    const rename = await store.renameTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      fromPath: "notes/today.md",
      toPath: "archive/today.md",
      metadata: { origin: "local-file", summary: "renamed in named version" },
    });

    expect(rename.object.id).toBe(write.object.id);
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ objectId: write.object.id, text: "Keep this identity\n" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "archive/today.md",
      }),
    ).resolves.toBeNull();
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
      }),
    ).resolves.toBeNull();
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "archive/today.md",
      }),
    ).resolves.toMatchObject({ objectId: write.object.id, text: "Keep this identity\n" });
  });

  it("rolls back a rename mutation to the original source path without recording a new moment", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Keep this identity\n",
      metadata: localFileWrite,
    });
    const rename = await store.renameTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      fromPath: "notes/today.md",
      toPath: "archive/today.md",
      metadata: { origin: "local-file", summary: "renamed in main" },
    });

    await store.rollbackTextFileMutation({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "archive/today.md",
      mutationMomentId: rename.moment.id,
    });

    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: write.object.id,
      latestMomentId: write.moment.id,
      text: "Keep this identity\n",
    });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "archive/today.md",
      }),
    ).resolves.toBeNull();
    const reloadedAfterRenameRollback = createVersionedTextStore(root);
    await expect(
      reloadedAfterRenameRollback.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: write.object.id,
      latestMomentId: write.moment.id,
      text: "Keep this identity\n",
    });
    await expect(
      reloadedAfterRenameRollback.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "archive/today.md",
      }),
    ).resolves.toBeNull();
    const raw = JSON.parse(await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8"));
    expect(
      raw.workspaces["workspace-a"].moments.map(
        (moment: { operation: string }) => moment.operation,
      ),
    ).toEqual(["write"]);
  });

  it("rolls back write mutations without recording a new moment", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const created = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/new.md",
      text: "New draft\n",
      metadata: localFileWrite,
    });

    await store.rollbackTextFileMutation({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/new.md",
      mutationMomentId: created.moment.id,
    });

    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/new.md",
      }),
    ).resolves.toBeNull();
    const reloadedAfterCreateRollback = createVersionedTextStore(root);
    await expect(
      reloadedAfterCreateRollback.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/new.md",
      }),
    ).resolves.toBeNull();
    let raw = JSON.parse(await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8"));
    expect(raw.workspaces["workspace-a"].moments).toHaveLength(0);

    const base = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/existing.md",
      text: "Original\n",
      metadata: localFileWrite,
    });
    const overwrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/existing.md",
      text: "Overwritten\n",
      metadata: apiWrite,
    });

    await store.rollbackTextFileMutation({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/existing.md",
      mutationMomentId: overwrite.moment.id,
    });

    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/existing.md",
      }),
    ).resolves.toMatchObject({
      objectId: base.object.id,
      latestMomentId: base.moment.id,
      text: "Original\n",
    });
    const reloadedAfterOverwriteRollback = createVersionedTextStore(root);
    await expect(
      reloadedAfterOverwriteRollback.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/existing.md",
      }),
    ).resolves.toMatchObject({
      objectId: base.object.id,
      latestMomentId: base.moment.id,
      text: "Original\n",
    });
    raw = JSON.parse(await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8"));
    expect(
      raw.workspaces["workspace-a"].moments.map(
        (moment: { id: string; operation: string }) => [moment.id, moment.operation],
      ),
    ).toEqual([[base.moment.id, "write"]]);
  });

  it("does not validate unused legacy rollback text for modern mutation moments", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const base = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/existing.md",
      text: "Original\n",
      metadata: localFileWrite,
    });
    const overwrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/existing.md",
      text: "Overwritten\n",
      metadata: apiWrite,
    });

    await store.rollbackTextFileMutation({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/existing.md",
      mutationMomentId: overwrite.moment.id,
      legacyBeforeText: "x".repeat(MAX_VERSIONED_TEXT_FILE_BYTES + 1),
    });

    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/existing.md",
      }),
    ).resolves.toMatchObject({
      objectId: base.object.id,
      latestMomentId: base.moment.id,
      text: "Original\n",
    });
  });

  it("rolls back a delete mutation without recording a new moment", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Restore me\n",
      metadata: localFileWrite,
    });
    const deleted = await store.deleteTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      metadata: localFileWrite,
    });

    await store.rollbackTextFileMutation({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      mutationMomentId: deleted.moment.id,
    });

    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: write.object.id,
      latestMomentId: write.moment.id,
      text: "Restore me\n",
    });
    const reloadedAfterDeleteRollback = createVersionedTextStore(root);
    await expect(
      reloadedAfterDeleteRollback.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: write.object.id,
      latestMomentId: write.moment.id,
      text: "Restore me\n",
    });
    const raw = JSON.parse(await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8"));
    expect(
      raw.workspaces["workspace-a"].moments.map(
        (moment: { operation: string }) => moment.operation,
      ),
    ).toEqual(["write"]);
  });

  it("rolls back legacy fork mutations against inherited ancestor snapshots", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const base = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Inherited base\n",
      metadata: localFileWrite,
    });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: main.id,
      name: "Forked work",
    });
    const namedWrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "notes/today.md",
      text: "Failed fork write\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    const rawMoment = raw.workspaces["workspace-a"].moments.find(
      (moment: { id: string }) => moment.id === namedWrite.moment.id,
    );
    delete rawMoment.before;
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);

    const reloaded = createVersionedTextStore(root);
    await reloaded.rollbackTextFileMutation({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "notes/today.md",
      mutationMomentId: namedWrite.moment.id,
      legacyBeforeText: "Inherited base\n",
    });

    await expect(
      reloaded.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: base.object.id,
      latestMomentId: base.moment.id,
      text: "Inherited base\n",
    });
  });

  it("rejects rollback when a named version depends on the mutation moment", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Fork point\n",
      metadata: localFileWrite,
    });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Depends on write",
      fromVersionId: main.id,
    });

    await expectStoreError(
      store.rollbackTextFileMutation({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
        mutationMomentId: write.moment.id,
      }),
      "invalid-input",
    );
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Fork point\n" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Fork point\n" });
  });

  it("rejects rollback when a child forks exactly at the mutation moment", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Fork point\n",
      metadata: localFileWrite,
    });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Fork point child",
      fromVersionId: main.id,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "notes/other.md",
      text: "Independent child work\n",
      metadata: apiWrite,
    });

    await expectStoreError(
      store.rollbackTextFileMutation({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
        mutationMomentId: write.moment.id,
      }),
      "invalid-input",
    );
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Fork point\n" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/other.md",
      }),
    ).resolves.toMatchObject({ text: "Independent child work\n" });
  });

  it("rejects delete rollback when a later fork depends on the tombstone", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Will be deleted\n",
      metadata: localFileWrite,
    });
    const deleted = await store.deleteTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      metadata: localFileWrite,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/other.md",
      text: "Fork after delete\n",
      metadata: localFileWrite,
    });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Depends on delete tombstone",
      fromVersionId: main.id,
    });

    await expectStoreError(
      store.rollbackTextFileMutation({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
        mutationMomentId: deleted.moment.id,
      }),
      "invalid-input",
    );
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toBeNull();
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/other.md",
      }),
    ).resolves.toMatchObject({ objectId: expect.any(String), text: "Fork after delete\n" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
      }),
    ).resolves.toBeNull();
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/other.md",
      }),
    ).resolves.toMatchObject({ objectId: expect.any(String), text: "Fork after delete\n" });
    expect(write.object.id).toBe(deleted.object.id);
  });

  it("rejects rollback when another version keeps the moment as a mutation preimage", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const first = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Shared base\n",
      metadata: localFileWrite,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/other.md",
      text: "Fork marker\n",
      metadata: localFileWrite,
    });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Local rewrite",
      fromVersionId: main.id,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "notes/today.md",
      text: "Named rewrite\n",
      metadata: apiWrite,
    });

    await expectStoreError(
      store.rollbackTextFileMutation({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
        mutationMomentId: first.moment.id,
      }),
      "invalid-input",
    );
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Named rewrite\n" });
  });

  it("rejects rollback when a descendant inherits an ancestor object mutation", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Shared base\n",
      metadata: localFileWrite,
    });
    const ancestor = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Ancestor rewrite",
      fromVersionId: main.id,
    });
    const ancestorWrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: ancestor.id,
      path: "notes/today.md",
      text: "Ancestor text\n",
      metadata: apiWrite,
    });
    const descendant = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Descendant rewrite",
      fromVersionId: ancestor.id,
    });

    await expectStoreError(
      store.rollbackTextFileMutation({
        workspaceId: "workspace-a",
        versionId: ancestor.id,
        path: "notes/today.md",
        mutationMomentId: ancestorWrite.moment.id,
      }),
      "invalid-input",
    );
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: descendant.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Ancestor text\n" });
  });

  it("rejects same-path renames without recording history", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Already there\n",
      metadata: localFileWrite,
    });

    await expect(
      store.renameTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        fromPath: "notes/today.md",
        toPath: "notes/today.md",
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: write.object.id,
      latestMomentId: write.moment.id,
      text: "Already there\n",
      metadata: localFileWrite,
    });
    const raw = JSON.parse(await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8"));
    expect(raw.workspaces["workspace-a"].moments).toHaveLength(1);
  });

  it("keeps path aliases isolated between versions", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Main identity\n",
      metadata: localFileWrite,
    });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Rename experiment",
      fromVersionId: main.id,
    });
    await store.renameTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      fromPath: "notes/today.md",
      toPath: "archive/today.md",
      metadata: apiWrite,
    });

    const mainArchive = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "archive/today.md",
      text: "Main can reuse target path\n",
      metadata: localFileWrite,
    });

    expect(mainArchive.object.id).not.toBe(write.object.id);
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "archive/today.md",
      }),
    ).resolves.toMatchObject({ objectId: write.object.id, text: "Main identity\n" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "archive/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: mainArchive.object.id,
      text: "Main can reuse target path\n",
    });
  });

  it("denies operations when records belong to another workspace", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/private.md",
      text: "Private text\n",
      metadata: localFileWrite,
    });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Private version",
      fromVersionId: main.id,
    });
    await store.ensureMainVersion({ workspaceId: "workspace-b" });

    await expect(
      store.writeTextFile({
        workspaceId: "workspace-b",
        versionId: named.id,
        path: "notes/today.md",
        text: "wrong workspace\n",
        metadata: localFileWrite,
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-b",
        versionId: named.id,
        path: "notes/private.md",
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      store.renameTextFile({
        workspaceId: "workspace-b",
        versionId: named.id,
        fromPath: "notes/private.md",
        toPath: "notes/renamed.md",
        metadata: localFileWrite,
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      store.deleteTextFile({
        workspaceId: "workspace-b",
        versionId: named.id,
        path: "notes/private.md",
        metadata: localFileWrite,
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      store.rollbackTextFileMutation({
        workspaceId: "workspace-b",
        versionId: named.id,
        path: "notes/private.md",
        mutationMomentId: write.moment.id,
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      store.listTextFiles({
        workspaceId: "workspace-b",
        versionId: named.id,
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      store.getObject({
        workspaceId: "workspace-b",
        objectId: write.object.id,
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      store.createNamedVersion({
        workspaceId: "workspace-b",
        fromVersionId: named.id,
        name: "Wrong workspace fork",
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
  });

  it("rejects reserved or unsafe workspace paths before they enter the store", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });

    for (const path of unsafeWorkspacePaths) {
      await expect(
        store.writeTextFile({
          workspaceId: "workspace-a",
          versionId: main.id,
          path,
          text: "nope\n",
          metadata: localFileWrite,
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
    }
  });

  it("rejects reserved or unsafe rename paths before they enter the store", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Safe text\n",
      metadata: localFileWrite,
    });

    for (const path of unsafeWorkspacePaths) {
      await expect(
        store.renameTextFile({
          workspaceId: "workspace-a",
          versionId: main.id,
          fromPath: path,
          toPath: "notes/renamed.md",
          metadata: localFileWrite,
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(
        store.renameTextFile({
          workspaceId: "workspace-a",
          versionId: main.id,
          fromPath: "notes/today.md",
          toPath: path,
          metadata: localFileWrite,
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
    }
  });

  it("rejects invalid write metadata without writing a file", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const named = await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: main.id,
      name: "Bad metadata fork",
    });

    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
        text: "Bad metadata\n",
        metadata: { origin: "api", summary: 123 } as unknown as typeof apiWrite,
      }),
    ).rejects.toMatchObject({ code: "invalid-metadata" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
      }),
    ).resolves.toBeNull();
  });

  it("stores only actor-neutral write metadata fields", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const metadata = {
      origin: "api" as const,
      summary: "safe summary",
      extra: "should be dropped",
      toJSON: () => ({
        origin: "api",
        summary: "toJSON summary should not win",
        extra: "toJSON leak",
      }),
    } as unknown as typeof apiWrite;

    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Metadata test\n",
      metadata,
    });

    expect(write.snapshot.metadata).toEqual({ origin: "api", summary: "safe summary" });
    const raw = await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8");
    expect(raw).toContain("safe summary");
    expect(raw).not.toContain("should be dropped");
    expect(raw).not.toContain("toJSON leak");
    expect(raw).not.toContain("toJSON summary should not win");
  });

  it("rejects non-string text before persisting", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });

    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
        text: 123 as unknown as string,
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "invalid-text" });

    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toBeNull();
    await expect(
      store.listTextFiles({
        workspaceId: "workspace-a",
        versionId: main.id,
      }),
    ).resolves.toEqual([]);
    const raw = JSON.parse(await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8"));
    expect(raw.workspaces["workspace-a"].moments).toHaveLength(0);
  });

  it("rejects oversized or non-round-trippable text before persisting", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    async function expectNoInvalidWritesPersisted() {
      await expect(
        store.readTextFile({
          workspaceId: "workspace-a",
          versionId: main.id,
          path: "notes/huge.md",
        }),
      ).resolves.toBeNull();
      await expect(
        store.readTextFile({
          workspaceId: "workspace-a",
          versionId: main.id,
          path: "notes/bad-string.md",
        }),
      ).resolves.toBeNull();
      await expect(
        store.listTextFiles({
          workspaceId: "workspace-a",
          versionId: main.id,
        }),
      ).resolves.toEqual([]);
      const raw = JSON.parse(await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8"));
      expect(raw.workspaces["workspace-a"].moments).toHaveLength(0);
    }

    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/huge.md",
        text: "x".repeat(MAX_VERSIONED_TEXT_FILE_BYTES + 1),
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "invalid-text" });
    await expectNoInvalidWritesPersisted();

    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/bad-string.md",
        text: "bad \uD800\n",
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "invalid-text" });
    await expectNoInvalidWritesPersisted();
  });

  it("rejects non-string workspace, version name, and path inputs with typed errors", async () => {
    const store = storeWithDeterministicIds();

    await expectStoreError(
      store.ensureMainVersion({ workspaceId: 123 as unknown as string }),
      "invalid-workspace",
    );
    await expectStoreError(store.ensureMainVersion({ workspaceId: "" }), "invalid-workspace");
    await expectStoreError(
      store.ensureMainVersion({ workspaceId: " workspace-a" }),
      "invalid-workspace",
    );
    await expectStoreError(
      store.ensureMainVersion({ workspaceId: "workspace-a " }),
      "invalid-workspace",
    );

    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await expectStoreError(
      store.createNamedVersion({
        workspaceId: "workspace-a",
        fromVersionId: main.id,
        name: 123 as unknown as string,
      }),
      "invalid-version-name",
    );
    await expectStoreError(
      store.createNamedVersion({
        workspaceId: "workspace-a",
        fromVersionId: main.id,
        name: "",
      }),
      "invalid-version-name",
    );
    await expectStoreError(
      store.createNamedVersion({
        workspaceId: "workspace-a",
        fromVersionId: main.id,
        name: " Draft",
      }),
      "invalid-version-name",
    );
    await expectStoreError(
      store.createNamedVersion({
        workspaceId: "workspace-a",
        fromVersionId: main.id,
        name: "Draft ",
      }),
      "invalid-version-name",
    );
    await expectStoreError(
      store.createNamedVersion({
        workspaceId: "workspace-a",
        fromVersionId: " bad-version",
        name: "Bad version id",
      }),
      "invalid-version",
    );

    await expectStoreError(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: 123 as unknown as string,
        text: "Bad path\n",
        metadata: apiWrite,
      }),
      "invalid-path",
    );
    await expectStoreError(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: "bad\u0000version",
        path: "notes/today.md",
        text: "Bad version\n",
        metadata: apiWrite,
      }),
      "invalid-version",
    );
    await expectStoreError(
      store.getObject({
        workspaceId: "workspace-a",
        objectId: " bad-object",
      }),
      "invalid-object",
    );
  });

  it("rejects empty roots and non-finite store clocks", async () => {
    let rootError: unknown;
    try {
      createVersionedTextStore("");
    } catch (error) {
      rootError = error;
    }
    expect(rootError).toBeInstanceOf(VersionedTextStoreError);
    expect(rootError).toMatchObject({ code: "invalid-root" });
    let paddedRootError: unknown;
    try {
      createVersionedTextStore(` ${root}`);
    } catch (error) {
      paddedRootError = error;
    }
    expect(paddedRootError).toBeInstanceOf(VersionedTextStoreError);
    expect(paddedRootError).toMatchObject({ code: "invalid-root" });

    const badClock = createVersionedTextStore(root, { nowMs: () => Number.NaN });
    await expectStoreError(
      badClock.ensureMainVersion({ workspaceId: "workspace-a" }),
      "invalid-timestamp",
    );

    let clock = 1000;
    const store = createVersionedTextStore(root, {
      nowMs: () => {
        clock += 10;
        return clock;
      },
      createId: (kind) => `${kind}-clock-test`,
    });
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    clock = Number.POSITIVE_INFINITY;
    await expectStoreError(
      store.createNamedVersion({
        workspaceId: "workspace-a",
        fromVersionId: main.id,
        name: "Bad clock",
      }),
      "invalid-timestamp",
    );
  });

  it("rejects missing public method input envelopes with typed errors", async () => {
    const store = storeWithDeterministicIds();
    const missingInput = null as never;

    await expectStoreError(store.ensureMainVersion(missingInput), "invalid-input");
    await expectStoreError(store.getMainVersion(missingInput), "invalid-input");
    await expectStoreError(store.createNamedVersion(missingInput), "invalid-input");
    await expectStoreError(store.listVersions(missingInput), "invalid-input");
    await expectStoreError(store.writeTextFile(missingInput), "invalid-input");
    await expectStoreError(store.readTextFile(missingInput), "invalid-input");
    await expectStoreError(store.listTextFiles(missingInput), "invalid-input");
    await expectStoreError(store.renameTextFile(missingInput), "invalid-input");
    await expectStoreError(store.deleteTextFile(missingInput), "invalid-input");
    await expectStoreError(store.rollbackTextFileMutation(missingInput), "invalid-input");
    await expectStoreError(store.getObject(missingInput), "invalid-input");
  });

  it("handles workspace ids that overlap object prototype keys", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "__proto__" });
    await store.writeTextFile({
      workspaceId: "__proto__",
      versionId: main.id,
      path: "notes/today.md",
      text: "Own-key workspace\n",
      metadata: localFileWrite,
    });

    const reloaded = createVersionedTextStore(root);
    await expect(
      reloaded.readTextFile({
        workspaceId: "__proto__",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Own-key workspace\n" });
  });

  it("reloads nested forks that inherit snapshots from an ancestor version", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Ancestor text\n",
      metadata: apiWrite,
    });
    const firstFork = await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: main.id,
      name: "First fork",
    });
    const secondFork = await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: firstFork.id,
      name: "Second fork",
    });

    const reloaded = createVersionedTextStore(root);
    await expect(
      reloaded.readTextFile({
        workspaceId: "workspace-a",
        versionId: secondFork.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: write.object.id,
      latestMomentId: write.moment.id,
      text: "Ancestor text\n",
    });
  });

  it("rejects duplicate generated version ids before mutation", async () => {
    const store = createVersionedTextStore(root, {
      nowMs: () => {
        now += 10;
        return now;
      },
      createId: (kind) => (kind === "version" ? "version-fixed" : `${kind}-unused`),
    });
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });

    await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: main.id,
      name: "First version",
    });
    await expect(
      store.createNamedVersion({
        workspaceId: "workspace-a",
        fromVersionId: main.id,
        name: "Second version",
      }),
    ).rejects.toMatchObject({ code: "duplicate-id" });

    await expect(store.listVersions({ workspaceId: "workspace-a" })).resolves.toHaveLength(2);
  });

  it("rejects duplicate generated version ids across workspaces", async () => {
    const store = createVersionedTextStore(root, {
      nowMs: () => {
        now += 10;
        return now;
      },
      createId: (kind) => (kind === "version" ? "version-fixed" : `${kind}-unused`),
    });
    const firstMain = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const secondMain = await store.ensureMainVersion({ workspaceId: "workspace-b" });

    await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: firstMain.id,
      name: "First version",
    });
    await expect(
      store.createNamedVersion({
        workspaceId: "workspace-b",
        fromVersionId: secondMain.id,
        name: "Second version",
      }),
    ).rejects.toMatchObject({ code: "duplicate-id" });
  });

  it("rejects duplicate generated object ids across workspaces", async () => {
    let momentCounter = 0;
    const store = createVersionedTextStore(root, {
      nowMs: () => {
        now += 10;
        return now;
      },
      createId: (kind) => {
        if (kind === "object") return "object-fixed";
        if (kind === "moment") {
          momentCounter += 1;
          return `moment-${momentCounter}`;
        }
        return "version-unused";
      },
    });
    const firstMain = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const secondMain = await store.ensureMainVersion({ workspaceId: "workspace-b" });

    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: firstMain.id,
      path: "notes/first.md",
      text: "First workspace\n",
      metadata: apiWrite,
    });
    await expect(
      store.writeTextFile({
        workspaceId: "workspace-b",
        versionId: secondMain.id,
        path: "notes/second.md",
        text: "Second workspace\n",
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "duplicate-id" });
  });

  it("rejects blank generated ids before persistence", async () => {
    const store = createVersionedTextStore(root, {
      nowMs: () => {
        now += 10;
        return now;
      },
      createId: () => " ",
    });
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });

    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
        text: "Bad id\n",
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "invalid-generated-id" });
  });

  it("rejects duplicate generated object ids before mutation", async () => {
    let momentCounter = 0;
    const store = createVersionedTextStore(root, {
      nowMs: () => {
        now += 10;
        return now;
      },
      createId: (kind) => {
        if (kind === "object") return "object-fixed";
        if (kind === "moment") {
          momentCounter += 1;
          return `moment-${momentCounter}`;
        }
        return "version-unused";
      },
    });
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/a.md",
      text: "A\n",
      metadata: apiWrite,
    });

    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/b.md",
        text: "B\n",
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "duplicate-id" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/b.md",
      }),
    ).resolves.toBeNull();
  });

  it("rejects duplicate generated moment ids before mutation", async () => {
    let objectCounter = 0;
    const store = createVersionedTextStore(root, {
      nowMs: () => {
        now += 10;
        return now;
      },
      createId: (kind) => {
        if (kind === "object") {
          objectCounter += 1;
          return `object-${objectCounter}`;
        }
        if (kind === "moment") return "moment-fixed";
        return "version-unused";
      },
    });
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/a.md",
      text: "A\n",
      metadata: apiWrite,
    });

    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/b.md",
        text: "B\n",
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "duplicate-id" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/b.md",
      }),
    ).resolves.toBeNull();
  });

  it("persists inspectable JSON and reloads the same object/version state", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Durable text\n",
      metadata: localFileWrite,
    });

    const raw = await readFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "utf8");
    expect(raw).toContain("\n  ");
    expect(JSON.parse(raw).schemaVersion).toBe(1);

    const reloaded = createVersionedTextStore(root);
    await expect(
      reloaded.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      objectId: write.object.id,
      text: "Durable text\n",
    });
  });

  it("leaves the in-memory cache unchanged when persistence fails", async () => {
    const counters = { moment: 0, object: 0, version: 0 };
    let failNextPersist = false;
    const store = createTestableVersionedTextStore({
      nowMs: () => {
        now += 10;
        return now;
      },
      createId: (kind) => {
        counters[kind] += 1;
        return `${kind}-${counters[kind]}`;
      },
      testHooks: {
        beforePersist: () => {
          if (failNextPersist) {
            failNextPersist = false;
            throw new Error("injected persist failure");
          }
        },
      },
    });
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/stable.md",
      text: "Durable text\n",
      metadata: localFileWrite,
    });

    failNextPersist = true;
    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/unpersisted.md",
        text: "Should not leak through cache\n",
        metadata: apiWrite,
      }),
    ).rejects.toMatchObject({ code: "persist-failed" });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/unpersisted.md",
      }),
    ).resolves.toBeNull();
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/stable.md",
      }),
    ).resolves.toMatchObject({ text: "Durable text\n" });
  });

  it("fails closed on corrupt persisted state", async () => {
    await ensureStoreStateDir();
    await writeFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "{\"schemaVersion\":2}\n");
    const store = createVersionedTextStore(root);

    await expect(store.getMainVersion({ workspaceId: "workspace-a" })).rejects.toBeInstanceOf(
      VersionedTextStoreError,
    );
    await expect(store.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("maps malformed persisted JSON to the store corruption error", async () => {
    await ensureStoreStateDir();
    await writeFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "{\"schemaVersion\":");
    const store = createVersionedTextStore(root);

    await expect(store.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("treats literal persisted null as corrupt state", async () => {
    await ensureStoreStateDir();
    await writeFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "null\n");
    const store = createVersionedTextStore(root);

    await expect(store.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects persisted state with duplicate main versions", async () => {
    await ensureStoreStateDir();
    await writeFile(
      join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH),
      `${JSON.stringify({
        schemaVersion: 1,
        workspaces: {
          "workspace-a": {
            mainVersionId: "main",
            versions: {
              main: {
                id: "main",
                workspaceId: "workspace-a",
                kind: "main",
                name: "Main",
                createdAtMs: 1,
              },
              other: {
                id: "other",
                workspaceId: "workspace-a",
                kind: "main",
                name: "Other main",
                createdAtMs: 2,
              },
            },
            objects: {},
            pathAliases: { main: {}, other: {} },
            snapshots: { main: {}, other: {} },
            moments: [],
          },
        },
      })}\n`,
    );
    const store = createVersionedTextStore(root);

    await expect(store.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects persisted named versions that use the reserved main id", async () => {
    await ensureStoreStateDir();
    await writeFile(
      join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH),
      `${JSON.stringify({
        schemaVersion: 1,
        workspaces: {
          "workspace-a": {
            mainVersionId: "real-main",
            versions: {
              "real-main": {
                id: "real-main",
                workspaceId: "workspace-a",
                kind: "main",
                name: "Main",
                createdAtMs: 1,
              },
              main: {
                id: "main",
                workspaceId: "workspace-a",
                kind: "named",
                name: "Reserved name",
                createdAtMs: 2,
                forkPoint: { versionId: "real-main" },
              },
            },
            objects: {},
            pathAliases: { "real-main": {}, main: {} },
            snapshots: { "real-main": {}, main: {} },
            moments: [],
          },
        },
      })}\n`,
    );
    const store = createVersionedTextStore(root);

    await expect(store.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects persisted state with duplicate version names", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const version = await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: main.id,
      name: "Other",
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].versions[version.id].name = "Main";
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects persisted versions whose kind and fork point disagree", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const version = await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: main.id,
      name: "Other",
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const validRaw = JSON.parse(await readFile(statePath, "utf8"));
    const corruptions = [
      (raw: typeof validRaw) => {
        raw.workspaces["workspace-a"].versions.main.forkPoint = { versionId: version.id };
      },
      (raw: typeof validRaw) => {
        delete raw.workspaces["workspace-a"].versions[version.id].forkPoint;
      },
    ];

    for (const corrupt of corruptions) {
      const raw = JSON.parse(JSON.stringify(validRaw));
      corrupt(raw);
      await writeFile(statePath, `${JSON.stringify(raw)}\n`);
      const reloaded = createVersionedTextStore(root);
      await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
        code: "state-corrupt",
      });
    }
  });

  it("rejects persisted identifiers and version names that are not normalized", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const validRaw = JSON.parse(await readFile(statePath, "utf8"));
    const corruptions = [
      (raw: typeof validRaw) => {
        raw.workspaces[" workspace-a"] = raw.workspaces["workspace-a"];
        delete raw.workspaces["workspace-a"];
      },
      (raw: typeof validRaw) => {
        raw.workspaces["workspace-a"].mainVersionId = " main";
      },
      (raw: typeof validRaw) => {
        raw.workspaces["workspace-a"].versions.main.name = " Main";
      },
    ];

    for (const corrupt of corruptions) {
      const raw = JSON.parse(JSON.stringify(validRaw));
      corrupt(raw);
      await writeFile(statePath, `${JSON.stringify(raw)}\n`);
      const reloaded = createVersionedTextStore(root);
      await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
        code: "state-corrupt",
      });
    }
  });

  it("strips unknown persisted fields before returning public records", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Public text\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].versions.main.extra = "hidden-version-field";
    raw.workspaces["workspace-a"].objects[write.object.id].extra = "hidden-object-field";
    raw.workspaces["workspace-a"].snapshots.main[write.object.id].extra = "hidden-snapshot-field";
    raw.workspaces["workspace-a"].snapshots.main[write.object.id].metadata.extra =
      "hidden-metadata-field";
    raw.workspaces["workspace-a"].moments[0].extra = "hidden-moment-field";
    raw.workspaces["workspace-a"].moments[0].metadata.extra = "hidden-moment-metadata-field";
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    const reloadedMain = await reloaded.getMainVersion({ workspaceId: "workspace-a" });
    const object = await reloaded.getObject({
      workspaceId: "workspace-a",
      objectId: write.object.id,
    });
    const snapshot = await reloaded.readTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
    });

    expect(reloadedMain).not.toHaveProperty("extra");
    expect(object).not.toHaveProperty("extra");
    expect(snapshot).not.toHaveProperty("extra");
    expect(snapshot?.metadata).not.toHaveProperty("extra");
  });

  it("rejects persisted object and moment ids that are blank", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Safe path\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].objects[write.object.id].id = "";
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const objectReload = createVersionedTextStore(root);
    await expect(objectReload.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject(
      { code: "state-corrupt" },
    );

    raw.workspaces["workspace-a"].objects[write.object.id].id = write.object.id;
    raw.workspaces["workspace-a"].moments[0].id = "";
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const momentReload = createVersionedTextStore(root);
    await expect(momentReload.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject(
      { code: "state-corrupt" },
    );
  });

  it("rejects unsafe persisted alias paths", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Safe path\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].pathAliases.main = {
      "../escape.md": write.object.id,
    };
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects persisted aliases that disagree with snapshot paths", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Safe path\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].pathAliases.main = {
      "notes/other.md": write.object.id,
    };
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects duplicate persisted snapshot paths in the same version", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const first = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/first.md",
      text: "First\n",
      metadata: apiWrite,
    });
    const second = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/second.md",
      text: "Second\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].snapshots.main[second.object.id].path = "notes/first.md";
    raw.workspaces["workspace-a"].pathAliases.main["notes/first.md"] = second.object.id;
    delete raw.workspaces["workspace-a"].pathAliases.main["notes/second.md"];
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects persisted objects that no version can read", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].objects["object-orphan"] = {
      id: "object-orphan",
      workspaceId: "workspace-a",
      createdAtMs: 1,
    };
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
    await expect(
      reloaded.getObject({ workspaceId: "workspace-a", objectId: "object-orphan" }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects moment-derived files missing their snapshot and alias", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Visible file\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].snapshots.main = {};
    raw.workspaces["workspace-a"].pathAliases.main = {};
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects unsafe persisted snapshot and moment paths", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Safe path\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].snapshots.main[write.object.id].path = "../escape.md";
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const snapshotReload = createVersionedTextStore(root);
    await expect(
      snapshotReload.getMainVersion({ workspaceId: "workspace-a" }),
    ).rejects.toMatchObject({ code: "state-corrupt" });

    raw.workspaces["workspace-a"].snapshots.main[write.object.id].path = "notes/today.md";
    raw.workspaces["workspace-a"].moments[0].path = "../escape.md";
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const momentReload = createVersionedTextStore(root);
    await expect(momentReload.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject(
      { code: "state-corrupt" },
    );
  });

  it("rejects oversized or non-round-trippable persisted text", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Safe text\n",
      metadata: apiWrite,
    });
    const rewrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Rewritten text\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    const legacyOversizedText = "x".repeat(MAX_VERSIONED_TEXT_FILE_BYTES + 1);
    raw.workspaces["workspace-a"].snapshots.main[write.object.id].text = legacyOversizedText;
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const snapshotReload = createVersionedTextStore(root);
    await expect(
      snapshotReload.getMainVersion({ workspaceId: "workspace-a" }),
    ).rejects.toMatchObject({ code: "state-corrupt" });

    raw.workspaces["workspace-a"].snapshots.main[write.object.id].text = "Rewritten text\n";
    const rawRewriteMoment = raw.workspaces["workspace-a"].moments.find(
      (moment: { id: string }) => moment.id === rewrite.moment.id,
    );
    expect(rawRewriteMoment).toBeDefined();
    rawRewriteMoment!.before.text = "\uD800";
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const momentReload = createVersionedTextStore(root);
    await expect(momentReload.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject(
      { code: "state-corrupt" },
    );
  });

  it("rejects snapshots with stale same-version latest moments", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const firstWrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "First\n",
      metadata: apiWrite,
    });
    const secondWrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Second\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].snapshots.main[secondWrite.object.id].latestMomentId =
      firstWrite.moment.id;
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects snapshots whose timestamp or metadata disagree with their latest moment", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Safe path\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const validRaw = JSON.parse(await readFile(statePath, "utf8"));
    const corruptions = [
      (raw: typeof validRaw) => {
        raw.workspaces["workspace-a"].snapshots.main[write.object.id].updatedAtMs += 1;
      },
      (raw: typeof validRaw) => {
        raw.workspaces["workspace-a"].snapshots.main[write.object.id].metadata.correlationId =
          "other-request";
      },
    ];

    for (const corrupt of corruptions) {
      const raw = JSON.parse(JSON.stringify(validRaw));
      corrupt(raw);
      await writeFile(statePath, `${JSON.stringify(raw)}\n`);
      const reloaded = createVersionedTextStore(root);
      await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
        code: "state-corrupt",
      });
    }
  });

  it("rejects inherited snapshots that do not match the fork-point lineage", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Forked text\n",
      metadata: apiWrite,
    });
    const version = await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: main.id,
      name: "Fork",
    });
    const laterWrite = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Main moved on\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    raw.workspaces["workspace-a"].versions[version.id].forkPoint.momentId = laterWrite.moment.id;
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(
      reloaded.listTextFiles({ workspaceId: "workspace-a", versionId: version.id }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects explicit null before snapshots that erase inherited history", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Inherited text\n",
      metadata: apiWrite,
    });
    const version = await store.createNamedVersion({
      workspaceId: "workspace-a",
      fromVersionId: main.id,
      name: "Fork",
    });
    const write = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: version.id,
      path: "notes/today.md",
      text: "Fork rewrite\n",
      metadata: apiWrite,
    });
    const statePath = join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    const rawMoment = raw.workspaces["workspace-a"].moments.find(
      (moment: { id: string }) => moment.id === write.moment.id,
    );
    rawMoment.before = null;
    await writeFile(statePath, `${JSON.stringify(raw)}\n`);
    const reloaded = createVersionedTextStore(root);

    await expect(
      reloaded.listTextFiles({ workspaceId: "workspace-a", versionId: version.id }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("maps malformed nested workspace state to the store corruption error", async () => {
    await ensureStoreStateDir();
    await writeFile(
      join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH),
      `${JSON.stringify({
        schemaVersion: 1,
        workspaces: {
          "workspace-a": {
            mainVersionId: "main",
            versions: {
              main: {
                id: "main",
                workspaceId: "workspace-a",
                kind: "main",
                name: "Main",
                createdAtMs: 1,
              },
            },
            objects: {
              "object-1": {
                id: "object-1",
                workspaceId: "workspace-a",
                createdAtMs: 1,
              },
            },
            pathAliases: { main: { "notes/a.md": "object-1" } },
            snapshots: {
              main: {
                "object-1": {
                  objectId: "object-1",
                  versionId: "other-version",
                  path: "notes/a.md",
                  text: "A\n",
                  updatedAtMs: 1,
                  latestMomentId: "moment-1",
                  metadata: { origin: "api" },
                },
              },
            },
            moments: [],
          },
        },
      })}\n`,
    );
    const store = createVersionedTextStore(root);

    await expect(store.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("reclaims stale lock owners before writing", async () => {
    await ensureStoreStateDir();
    const lockDir = storeLockDir();
    const ownerPath = join(lockDir, "owner.json");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        token: "stale-token",
        pid: 123,
        createdAtMs: 0,
        heartbeatAtMs: 0,
      })}\n`,
    );
    const store = createTestableVersionedTextStore({
      testHooks: {
        lockStaleMs: 1,
        lockTimeoutMs: 1000,
      },
    });

    await expect(store.ensureMainVersion({ workspaceId: "workspace-a" })).resolves.toMatchObject({
      workspaceId: "workspace-a",
    });
    await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats unreadable stale lock owners as missing owners", async () => {
    await ensureStoreStateDir();
    const lockDir = storeLockDir();
    const ownerPath = join(lockDir, "owner.json");
    await mkdir(ownerPath, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    await utimes(ownerPath, old, old);
    const store = createTestableVersionedTextStore({
      testHooks: {
        lockStaleMs: 1,
        lockTimeoutMs: 1000,
      },
    });

    await expect(store.ensureMainVersion({ workspaceId: "workspace-a" })).resolves.toMatchObject({
      workspaceId: "workspace-a",
    });
    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits behind malformed fresh lock owners", async () => {
    await ensureStoreStateDir();
    const lockDir = storeLockDir();
    const ownerPath = join(lockDir, "owner.json");
    await mkdir(lockDir, { recursive: true });
    await writeFile(ownerPath, "{not-json", "utf8");
    const fresh = new Date();
    await utimes(lockDir, fresh, fresh);
    const store = createTestableVersionedTextStore({
      testHooks: {
        lockStaleMs: 60_000,
        lockTimeoutMs: 75,
      },
    });

    await expect(store.ensureMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "persist-failed",
    });
    await expect(readFile(ownerPath, "utf8")).resolves.toBe("{not-json");
  });

  it("waits behind a fresh store-lock reclaimer lease", async () => {
    await ensureStoreStateDir();
    const reclaimerPath = `${storeLockDir()}.reclaimer`;
    await mkdir(reclaimerPath, { recursive: true });
    const store = createTestableVersionedTextStore({
      testHooks: {
        lockStaleMs: 60_000,
        lockTimeoutMs: 75,
      },
    });

    await expect(store.ensureMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "persist-failed",
    });

    await rm(reclaimerPath, { recursive: true, force: true });
    await expect(store.ensureMainVersion({ workspaceId: "workspace-a" })).resolves.toMatchObject({
      workspaceId: "workspace-a",
    });
  });

  it("expires stale store-lock reclaimer leases before writing", async () => {
    await ensureStoreStateDir();
    const reclaimerPath = `${storeLockDir()}.reclaimer`;
    await mkdir(reclaimerPath, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(reclaimerPath, old, old);
    const store = createTestableVersionedTextStore({
      testHooks: {
        lockStaleMs: 1_000,
        lockTimeoutMs: 1000,
      },
    });

    await expect(store.ensureMainVersion({ workspaceId: "workspace-a" })).resolves.toMatchObject({
      workspaceId: "workspace-a",
    });
    await expect(stat(reclaimerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires stale store-lock reclaimers with unreadable owner metadata", async () => {
    await ensureStoreStateDir();
    const reclaimerPath = `${storeLockDir()}.reclaimer`;
    const ownerPath = join(reclaimerPath, "owner.json");
    await mkdir(ownerPath, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(ownerPath, old, old);
    await utimes(reclaimerPath, old, old);
    const store = createTestableVersionedTextStore({
      testHooks: {
        lockStaleMs: 1_000,
        lockTimeoutMs: 1000,
      },
    });

    await expect(store.ensureMainVersion({ workspaceId: "workspace-a" })).resolves.toMatchObject({
      workspaceId: "workspace-a",
    });
    await expect(stat(reclaimerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits behind a stale-looking store-lock reclaimer with a fresh owner", async () => {
    await ensureStoreStateDir();
    const reclaimerPath = `${storeLockDir()}.reclaimer`;
    const ownerPath = join(reclaimerPath, "owner.json");
    await mkdir(reclaimerPath, { recursive: true });
    const freshOwnerNow = Date.now();
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        token: "active-reclaimer",
        pid: process.pid,
        createdAtMs: freshOwnerNow,
        heartbeatAtMs: freshOwnerNow,
      })}\n`,
    );
    const old = new Date(freshOwnerNow - 120_000);
    await utimes(reclaimerPath, old, old);
    const store = createTestableVersionedTextStore({
      testHooks: {
        lockStaleMs: 60_000,
        lockTimeoutMs: 75,
      },
    });

    await expect(store.ensureMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "persist-failed",
    });
    expect((await stat(reclaimerPath)).isDirectory()).toBe(true);
  });

  it("does not release a lock directory that was replaced after acquisition", async () => {
    let replaceLockOnPersist = false;
    const lockDir = storeLockDir();
    const ownerPath = join(lockDir, "owner.json");
    const store = createTestableVersionedTextStore({
      testHooks: {
        beforePersist: async () => {
          if (!replaceLockOnPersist) return;
          replaceLockOnPersist = false;
          const originalOwner = await readFile(ownerPath, "utf8");
          await rename(lockDir, `${lockDir}.replaced-test`);
          await mkdir(lockDir, { recursive: true });
          await writeFile(ownerPath, originalOwner, "utf8");
        },
      },
    });
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });

    replaceLockOnPersist = true;
    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/replaced-lock.md",
        text: "Should not persist\n",
        metadata: localFileWrite,
      }),
    ).rejects.toMatchObject({ code: "persist-failed" });
    expect((await stat(lockDir)).isDirectory()).toBe(true);
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/replaced-lock.md",
      }),
    ).resolves.toBeNull();
    const reloaded = createVersionedTextStore(root);
    await expect(
      reloaded.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/replaced-lock.md",
      }),
    ).resolves.toBeNull();
  });

  it("fences atomic publish against lock replacement after temp write", async () => {
    let replaceLockBeforePublish = false;
    const lockDir = storeLockDir();
    const ownerPath = join(lockDir, "owner.json");
    const store = createTestableVersionedTextStore({
      testHooks: {
        beforeAtomicPublish: async () => {
          if (!replaceLockBeforePublish) return;
          replaceLockBeforePublish = false;
          const originalOwner = await readFile(ownerPath, "utf8");
          await rename(lockDir, `${lockDir}.publish-replaced-test`);
          await mkdir(lockDir, { recursive: true });
          await writeFile(ownerPath, originalOwner, "utf8");
        },
      },
    });
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });

    replaceLockBeforePublish = true;
    await expect(
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/fenced-publish.md",
        text: "Should not publish\n",
        metadata: localFileWrite,
      }),
    ).rejects.toMatchObject({ code: "persist-failed" });
    expect((await stat(lockDir)).isDirectory()).toBe(true);
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/fenced-publish.md",
      }),
    ).resolves.toBeNull();
    const reloaded = createVersionedTextStore(root);
    await expect(
      reloaded.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/fenced-publish.md",
      }),
    ).resolves.toBeNull();
  });

  it("serializes writes across store instances for the same root", async () => {
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    const secondBlocked = createDeferred();
    let secondWriteQueued = false;
    let pauseFirstWrite = false;
    let pauseSecondWrite = false;
    let firstLoadedWritableState = 0;
    let secondLoadedWritableState = 0;
    const first = createTestableVersionedTextStore({
      nowMs: () => {
        now += 10;
        return now;
      },
      testHooks: {
        afterLoadWritableState: async () => {
          if (!pauseFirstWrite) return;
          firstLoadedWritableState += 1;
          await firstGate.promise;
        },
      },
    });
    const second = createTestableVersionedTextStore({
      nowMs: () => {
        now += 10;
        return now;
      },
      testHooks: {
        onWriteQueued: () => {
          secondWriteQueued = true;
          secondBlocked.resolve();
        },
        afterLoadWritableState: async () => {
          if (!pauseSecondWrite) return;
          secondLoadedWritableState += 1;
          await secondGate.promise;
        },
      },
    });
    const main = await first.ensureMainVersion({ workspaceId: "workspace-a" });

    pauseFirstWrite = true;
    pauseSecondWrite = true;
    const pendingWrites: Promise<unknown>[] = [];
    try {
      const firstWrite = first.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/first.md",
        text: "First instance\n",
        metadata: localFileWrite,
      });
      pendingWrites.push(firstWrite);
      await waitFor(() => firstLoadedWritableState >= 1, 5_000);

      const secondWrite = second.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "notes/second.md",
        text: "Second instance\n",
        metadata: apiWrite,
      });
      pendingWrites.push(secondWrite);
      await waitFor(() => secondWriteQueued, 5_000);
      await secondBlocked.promise;
      expect(secondLoadedWritableState).toBe(0);

      firstGate.resolve();
      await waitFor(() => secondLoadedWritableState >= 1, 5_000);
      secondGate.resolve();
      await Promise.all([firstWrite, secondWrite]);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await Promise.allSettled(pendingWrites);
    }

    const reloaded = createVersionedTextStore(root);
    await expect(
      reloaded.listTextFiles({ workspaceId: "workspace-a", versionId: main.id }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "notes/first.md", text: "First instance\n" }),
        expect.objectContaining({ path: "notes/second.md", text: "Second instance\n" }),
      ]),
    );
  });
});
