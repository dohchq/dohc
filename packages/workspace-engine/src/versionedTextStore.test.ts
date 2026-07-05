import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

interface RawSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface RawSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => RawSqliteDb;
};

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
  const counters = { conflict: 0, moment: 0, object: 0, version: 0 };
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

function withRawDb<T>(fn: (db: RawSqliteDb) => T): T {
  const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    return fn(db);
  } finally {
    db.close();
  }
}

function rawRows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return withRawDb((db) => db.prepare(sql).all(...params));
}

function rawExec(sql: string, ...params: unknown[]): void {
  withRawDb((db) => {
    db.prepare(sql).run(...params);
  });
}

function rawCorrupt(sql: string, ...params: unknown[]): void {
  withRawDb((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(sql).run(...params);
  });
}

function momentOperations(workspaceId = "workspace-a"): string[] {
  return rawRows(
    "SELECT operation FROM moments WHERE workspace_id = ? ORDER BY moment_order",
    workspaceId,
  ).map((row) => String(row.operation));
}

function momentIdsAndOperations(workspaceId = "workspace-a"): Array<[string, string]> {
  return rawRows(
    "SELECT moment_id, operation FROM moments WHERE workspace_id = ? ORDER BY moment_order",
    workspaceId,
  ).map((row) => [String(row.moment_id), String(row.operation)]);
}

function momentPayloads(workspaceId = "workspace-a") {
  return rawRows(
    `SELECT m.payload_before_path, before_blob.text AS before_text,
            m.payload_after_path, after_blob.text AS after_text
     FROM moments m
     LEFT JOIN blobs before_blob ON before_blob.sha256 = m.payload_before_blob_sha256
     JOIN blobs after_blob ON after_blob.sha256 = m.payload_after_blob_sha256
     WHERE m.workspace_id = ?
     ORDER BY m.moment_order`,
    workspaceId,
  ).map((row) => ({
    before: row.payload_before_path
      ? { path: String(row.payload_before_path), text: String(row.before_text) }
      : null,
    after: { path: String(row.payload_after_path), text: String(row.after_text) },
  }));
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
    expect(momentOperations()).toEqual(["write"]);
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
    expect(momentOperations()).toHaveLength(0);

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
    expect(momentIdsAndOperations()).toEqual([[base.moment.id, "write"]]);
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
    expect(momentOperations()).toEqual(["write"]);
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
    rawExec(
      `UPDATE moments
       SET before_present = 0, before_object_id = NULL, before_version_id = NULL,
           before_path = NULL, before_blob_sha256 = NULL, before_updated_at_ms = NULL,
           before_latest_moment_id = NULL, before_metadata_origin = NULL,
           before_metadata_summary = NULL, before_metadata_correlation_id = NULL
       WHERE workspace_id = ? AND moment_id = ?`,
      "workspace-a",
      namedWrite.moment.id,
    );

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
    expect(momentOperations()).toHaveLength(1);
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
      store.writeTextFile({
        workspaceId: "workspace-a",
        versionId: named.id,
        path: "notes/today.md",
        text: "Bad metadata\n",
        metadata: { origin: "api", summary: "x".repeat(16 * 1024 + 1) },
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
    expect(rawRows("SELECT metadata_summary FROM snapshots")[0]).toEqual({
      metadata_summary: "safe summary",
    });
  });

  it("persists restorable before and after text on write and rename moments", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const first = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "First\n",
      metadata: apiWrite,
    });
    const second = await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/today.md",
      text: "Second\n",
      metadata: localFileWrite,
    });
    const rename = await store.renameTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      fromPath: "notes/today.md",
      toPath: "archive/today.md",
      metadata: apiWrite,
    });

    expect(first.moment.payload).toEqual({
      before: null,
      after: { path: "notes/today.md", text: "First\n" },
    });
    expect(second.moment.payload).toEqual({
      before: { path: "notes/today.md", text: "First\n" },
      after: { path: "notes/today.md", text: "Second\n" },
    });
    expect(rename.moment.payload).toEqual({
      before: { path: "notes/today.md", text: "Second\n" },
      after: { path: "archive/today.md", text: "Second\n" },
    });

    expect(momentPayloads()).toEqual([
      first.moment.payload,
      second.moment.payload,
      rename.moment.payload,
    ]);
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
    expect(momentOperations()).toHaveLength(0);
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
      expect(momentOperations()).toHaveLength(0);
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

    expect(rawRows("SELECT version FROM schema_version WHERE id = 1")).toEqual([{ version: 1 }]);
    expect(
      rawRows(
        `SELECT s.path, b.text
         FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256
         WHERE s.workspace_id = ? AND s.version_id = ?`,
        "workspace-a",
        main.id,
      ),
    ).toEqual([{ path: "notes/today.md", text: "Durable text\n" }]);

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
    const counters = { conflict: 0, moment: 0, object: 0, version: 0 };
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

  it("fails closed on an unknown SQLite schema version", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    rawExec("UPDATE schema_version SET version = 2 WHERE id = 1");
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toBeInstanceOf(
      VersionedTextStoreError,
    );
    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("fails closed when a required SQLite table is missing", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    withRawDb((db) => db.exec("DROP TABLE snapshots"));
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("fails closed when SQLite bytes are not a valid database", async () => {
    await ensureStoreStateDir();
    await writeFile(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), "not sqlite");
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
    rawExec("UPDATE versions SET name = 'Main' WHERE workspace_id = ? AND version_id = ?", "workspace-a", version.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("rejects persisted versions whose kind and fork point disagree", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const version = await store.createNamedVersion({ workspaceId: "workspace-a", fromVersionId: main.id, name: "Other" });

    rawExec("UPDATE versions SET fork_version_id = ? WHERE workspace_id = ? AND version_id = 'main'", version.id, "workspace-a");
    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });

    rawExec("UPDATE versions SET fork_version_id = NULL WHERE workspace_id = ? AND version_id = 'main'", "workspace-a");
    rawExec("UPDATE versions SET fork_version_id = NULL WHERE workspace_id = ? AND version_id = ?", "workspace-a", version.id);
    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects persisted identifiers and version names that are not normalized", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    rawExec("UPDATE versioned_workspaces SET main_version_id = ' main' WHERE workspace_id = ?", "workspace-a");

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("stores metadata in typed columns without leaking unknown fields", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const metadata = { origin: "api" as const, summary: "safe summary", extra: "should be dropped" } as unknown as typeof apiWrite;

    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Public text\n", metadata });

    expect(rawRows("SELECT metadata_origin, metadata_summary, metadata_correlation_id FROM snapshots")).toEqual([
      { metadata_origin: "api", metadata_summary: "safe summary", metadata_correlation_id: null },
    ]);
  });

  it("loads persisted paths under ignored scan segments while rejecting new writes there", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Legacy path\n", metadata: apiWrite });
    const legacyPath = "pkg/node_modules/legacy.md";
    rawExec("UPDATE path_aliases SET path = ? WHERE workspace_id = ? AND version_id = ? AND object_id = ?", legacyPath, "workspace-a", main.id, write.object.id);
    rawExec("UPDATE snapshots SET path = ? WHERE workspace_id = ? AND version_id = ? AND object_id = ?", legacyPath, "workspace-a", main.id, write.object.id);
    rawExec("UPDATE moments SET path = ?, payload_after_path = ? WHERE workspace_id = ? AND moment_id = ?", legacyPath, legacyPath, "workspace-a", write.moment.id);
    const reloaded = createVersionedTextStore(root);

    await expect(reloaded.listTextFiles({ workspaceId: "workspace-a", versionId: main.id })).resolves.toMatchObject([{ path: legacyPath, text: "Legacy path\n" }]);
    await expect(reloaded.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: legacyPath, text: "still blocked for new writes\n", metadata: apiWrite })).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("rejects persisted aliases and snapshots that disagree", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Safe path\n", metadata: apiWrite });
    rawExec("UPDATE path_aliases SET path = 'notes/other.md' WHERE workspace_id = ? AND version_id = ? AND object_id = ?", "workspace-a", main.id, write.object.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects duplicate persisted snapshot paths in the same version", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/first.md", text: "First\n", metadata: apiWrite });
    const second = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/second.md", text: "Second\n", metadata: apiWrite });
    rawExec("UPDATE snapshots SET path = 'notes/first.md' WHERE workspace_id = ? AND version_id = ? AND object_id = ?", "workspace-a", main.id, second.object.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects moment-derived files missing their snapshot and alias", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Visible file\n", metadata: apiWrite });
    rawExec("DELETE FROM snapshots WHERE workspace_id = ?", "workspace-a");
    rawExec("DELETE FROM path_aliases WHERE workspace_id = ?", "workspace-a");

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects unsafe persisted snapshot paths", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Safe path\n", metadata: apiWrite });
    rawExec("UPDATE snapshots SET path = '../escape.md' WHERE workspace_id = ? AND version_id = ? AND object_id = ?", "workspace-a", main.id, write.object.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects snapshots whose timestamp disagrees with their latest moment", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Safe path\n", metadata: apiWrite });
    rawExec("UPDATE snapshots SET updated_at_ms = updated_at_ms + 1 WHERE workspace_id = ? AND version_id = ? AND object_id = ?", "workspace-a", main.id, write.object.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects inherited snapshots that do not match the fork-point lineage", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Forked text\n", metadata: apiWrite });
    const version = await store.createNamedVersion({ workspaceId: "workspace-a", fromVersionId: main.id, name: "Fork" });
    const laterWrite = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Main moved on\n", metadata: apiWrite });
    rawExec("UPDATE versions SET fork_moment_id = ? WHERE workspace_id = ? AND version_id = ?", laterWrite.moment.id, "workspace-a", version.id);

    await expect(createVersionedTextStore(root).listTextFiles({ workspaceId: "workspace-a", versionId: version.id })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects explicit null before snapshots that erase inherited history", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Inherited text\n", metadata: apiWrite });
    const version = await store.createNamedVersion({ workspaceId: "workspace-a", fromVersionId: main.id, name: "Fork" });
    const write = await store.writeTextFile({ workspaceId: "workspace-a", versionId: version.id, path: "notes/today.md", text: "Fork rewrite\n", metadata: apiWrite });
    rawExec("UPDATE moments SET before_present = 1 WHERE workspace_id = ? AND moment_id = ?", "workspace-a", write.moment.id);

    await expect(createVersionedTextStore(root).listTextFiles({ workspaceId: "workspace-a", versionId: version.id })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("deduplicates identical text bodies in content-addressed blobs", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/a.md", text: "Same body\n", metadata: apiWrite });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/b.md", text: "Same body\n", metadata: apiWrite });

    expect(rawRows("SELECT COUNT(*) AS count FROM blobs WHERE text = ?", "Same body\n")).toEqual([{ count: 1 }]);
  });

  it("fails closed when the schema version row is missing", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    rawExec("DELETE FROM schema_version WHERE id = 1");

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("fails closed when the blobs table is missing", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    withRawDb((db) => db.exec("DROP TABLE blobs"));

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("fails closed when the moments table is missing", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    withRawDb((db) => db.exec("DROP TABLE moments"));

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects unsafe persisted alias paths", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Safe path\n", metadata: apiWrite });
    rawExec("UPDATE path_aliases SET path = '../escape.md' WHERE workspace_id = ? AND object_id = ?", "workspace-a", write.object.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects blank persisted object ids", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Safe path\n", metadata: apiWrite });
    rawCorrupt("UPDATE file_objects SET object_id = '' WHERE workspace_id = ? AND object_id = ?", "workspace-a", write.object.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects blank persisted moment ids", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Safe path\n", metadata: apiWrite });
    rawExec("UPDATE moments SET moment_id = '' WHERE workspace_id = ?", "workspace-a");

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects orphaned persisted objects", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });
    rawExec("INSERT INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?, ?, ?)", "workspace-a", "object-orphan", 1);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects snapshots with stale latest moments", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const first = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "First\n", metadata: apiWrite });
    const second = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Second\n", metadata: apiWrite });
    rawExec("UPDATE snapshots SET latest_moment_id = ? WHERE workspace_id = ? AND object_id = ?", first.moment.id, "workspace-a", second.object.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects snapshots whose metadata disagrees with their latest moment", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const write = await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Safe path\n", metadata: apiWrite });
    rawExec("UPDATE snapshots SET metadata_correlation_id = 'other-request' WHERE workspace_id = ? AND object_id = ?", "workspace-a", write.object.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects moments whose payload path disagrees with the moment path", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Safe path\n", metadata: apiWrite });
    rawExec("UPDATE moments SET payload_after_path = 'notes/other.md' WHERE workspace_id = ?", "workspace-a");

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects fork points that reference missing moments", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    const named = await store.createNamedVersion({ workspaceId: "workspace-a", fromVersionId: main.id, name: "Fork" });
    rawExec("UPDATE versions SET fork_moment_id = 'moment-missing' WHERE workspace_id = ? AND version_id = ?", "workspace-a", named.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("rejects fork base rows that point at unsafe paths", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/today.md", text: "Base\n", metadata: apiWrite });
    const named = await store.createNamedVersion({ workspaceId: "workspace-a", fromVersionId: main.id, name: "Fork" });
    rawExec("UPDATE fork_base_snapshots SET path = '../escape.md' WHERE workspace_id = ? AND version_id = ?", "workspace-a", named.id);

    await expect(createVersionedTextStore(root).getMainVersion({ workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("keeps both stores in one engine database file", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });

    expect(rawRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('snapshots', 'chat_threads') ORDER BY name")).toEqual([
      { name: "chat_threads" },
      { name: "snapshots" },
    ]);
  });

  it("creates the engine database at the shared SQLite path", async () => {
    const store = storeWithDeterministicIds();
    await store.ensureMainVersion({ workspaceId: "workspace-a" });

    await expect(stat(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH))).resolves.toMatchObject({
      mode: expect.any(Number),
    });
  });

  it("commits many concurrent writes from two store instances without loss", async () => {
    const first = storeWithDeterministicIds();
    const second = createVersionedTextStore(root);
    const main = await first.ensureMainVersion({ workspaceId: "workspace-a" });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).writeTextFile({
          workspaceId: "workspace-a",
          versionId: main.id,
          path: `notes/concurrent-${index}.md`,
          text: `Concurrent ${index}\n`,
          metadata: apiWrite,
        }),
      ),
    );

    await expect(first.listTextFiles({ workspaceId: "workspace-a", versionId: main.id })).resolves.toHaveLength(20);
  });

  it("deduplicates unchanged rewrites to the same blob body", async () => {
    const store = storeWithDeterministicIds();
    const main = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/a.md", text: "Same body\n", metadata: apiWrite });
    await store.writeTextFile({ workspaceId: "workspace-a", versionId: main.id, path: "notes/a.md", text: "Same body\n", metadata: apiWrite });

    expect(rawRows("SELECT COUNT(*) AS count FROM blobs WHERE text = ?", "Same body\n")).toEqual([{ count: 1 }]);
  });

  // SQLite's WAL file locks replace the old directory heartbeat/reclaimer lock.
  // There is no separate lock owner path to become stale; the guarantee that
  // matters here is that interleaved store instances commit whole transactions
  // without losing each other's writes.
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
