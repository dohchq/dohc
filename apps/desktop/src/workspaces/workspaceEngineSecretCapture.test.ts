import type { SecretFileStore, VersionedTextStore } from "@dohc/workspace-engine";
import { createSecretFileStore, createVersionedTextStore } from "@dohc/workspace-engine";
import { closeTrackedEngineDbHandlesForTest } from "@dohc/workspace-engine/testing";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeTmpdir } from "./testTemp";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";

// Secret-backed files through the DESKTOP capture pipeline (PR 08): secret
// paths are captured encrypted with metadata-only moments, follow version
// switch/merge/restore, and never leak plaintext into engine.db.

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
    close(): void;
  };
};

const MARKER = "DESKTOP_SECRET_MARKER_31337";
const ENV_A = `API_KEY=${MARKER}\n`;
const ENV_B = `API_KEY=${MARKER}\nEXTRA=b\n`;

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-secret-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  // Windows cannot unlink engine.db* files with open sqlite handles (EBUSY),
  // so release every tracked engine handle before removing the temp roots.
  closeTrackedEngineDbHandlesForTest();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function write(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function readText(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return null;
  }
}

// Deterministic clocks shared by both injected stores so interleave windows
// in listMoments are stable under test.
function stores(root: string): {
  store: VersionedTextStore;
  secretStore: SecretFileStore;
  tick: () => number;
} {
  let now = 1_000_000;
  const tick = () => {
    now += 10;
    return now;
  };
  return {
    store: createVersionedTextStore(root, { nowMs: tick }),
    secretStore: createSecretFileStore(root, { nowMs: tick }),
    tick,
  };
}

function capture(root: string, injected?: ReturnType<typeof stores>) {
  return createWorkspaceEngineCapture({
    workspaceId: "engine-secret-test",
    rootPath: root,
    ...(injected ? { store: injected.store, secretStore: injected.secretStore } : {}),
  });
}

function engineDbFiles(root: string): string[] {
  const base = join(root, ".dohc/engine/engine.db");
  return [base, `${base}-wal`, `${base}-shm`];
}

async function engineDbBytes(root: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const path of engineDbFiles(root)) {
    try {
      chunks.push(await readFile(path));
    } catch {
      // Absent WAL/SHM contribute nothing.
    }
  }
  return Buffer.concat(chunks);
}

function readTextStorePaths(root: string): string[] {
  const db = new DatabaseSync(join(root, ".dohc/engine/engine.db"), { readOnly: true });
  try {
    return db
      .prepare("SELECT path FROM snapshots")
      .all()
      .map((row) => String(row.path));
  } finally {
    db.close();
  }
}

describe("secret capture through the desktop pipeline", () => {
  it("captures .env encrypted with a metadata-only moment and no text-store entry", async () => {
    const root = await tempRoot();
    await write(root, "notes.md", "plain notes\n");
    await write(root, ".env", ENV_A);
    const engine = capture(root);
    engine.start();
    await engine.flush();

    const page = await engine.listMoments();
    const protectedMoments = page.moments.filter((moment) => moment.protected);
    expect(protectedMoments).toHaveLength(1);
    expect(protectedMoments[0].path).toBe(".env");
    expect(protectedMoments[0].metadata.summary).toBe("Updated .env");
    // Metadata-only: the summary row has no content-bearing field.
    expect(JSON.stringify(protectedMoments[0]).includes(MARKER)).toBe(false);

    // The protected diff detail is metadata-only too.
    const detail = await engine.readMoment(protectedMoments[0].id);
    expect(detail?.protected).toBe(true);
    expect(JSON.stringify(detail).includes(MARKER)).toBe(false);

    // The plaintext text store never holds the secret path.
    expect(readTextStorePaths(root)).not.toContain(".env");
    await engine.stop();

    // ADVERSARIAL: dump engine.db (+wal/shm) bytes — plaintext marker absent.
    const bytes = await engineDbBytes(root);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.includes(Buffer.from(MARKER, "utf8"))).toBe(false);
    expect(
      bytes.includes(Buffer.from(Buffer.from(ENV_A, "utf8").toString("base64"), "utf8")),
    ).toBe(false);
  });

  it("captures live .env batches, coalesces no-op rewrites, and retires deletions", async () => {
    const root = await tempRoot();
    await write(root, ".env", ENV_A);
    const engine = capture(root);
    engine.start();
    await engine.flush();

    // Same content again: no second moment (content-equality no-op).
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();
    let page = await engine.listMoments();
    expect(page.moments.filter((moment) => moment.protected)).toHaveLength(1);

    // Real change: one more metadata-only moment.
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();
    page = await engine.listMoments();
    expect(page.moments.filter((moment) => moment.protected)).toHaveLength(2);

    // Deletion retires the protected state with a moment.
    await rm(join(root, ".env"));
    engine.captureBatch([{ path: ".env", operation: "delete" }]);
    await engine.flush();
    page = await engine.listMoments();
    const protectedMoments = page.moments.filter((moment) => moment.protected);
    expect(protectedMoments).toHaveLength(3);
    expect(protectedMoments[0].operation).toBe("delete");
    expect(protectedMoments[0].metadata.summary).toBe("Deleted .env");
    await engine.stop();
  });

  it("secrets follow a version switch (the product win) without leaking plaintext", async () => {
    const root = await tempRoot();
    await write(root, "notes.md", "main notes\n");
    await write(root, ".env", ENV_A);
    const engine = capture(root);
    engine.start();
    await engine.flush();

    // Create+switch to a named version; edit the secret there.
    const created = await engine.createVersion("Experiment");
    const experimentId = created.activeVersionId;
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    // Switch back to Main: .env on disk returns to Main's copy.
    await engine.switchVersion("main");
    expect(await readText(root, ".env")).toBe(ENV_A);

    // The watcher's observation of the materialized write is expected —
    // no duplicate protected moment.
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    // Switch forward again: the experiment's copy comes back.
    await engine.switchVersion(experimentId);
    expect(await readText(root, ".env")).toBe(ENV_B);

    const page = await engine.listMoments();
    expect(JSON.stringify(page).includes(MARKER)).toBe(false);
    await engine.stop();

    const bytes = await engineDbBytes(root);
    expect(bytes.includes(Buffer.from(MARKER, "utf8"))).toBe(false);
  });

  it("a version that never had .env removes it from disk on switch and restores it on the way back", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    engine.start();
    await engine.flush();
    // Fork Experiment while no secret exists.
    const created = await engine.createVersion("Experiment");
    const experimentId = created.activeVersionId;
    // Back on Main, gain a secret.
    await engine.switchVersion("main");
    await write(root, ".env", ENV_A);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    await engine.switchVersion(experimentId);
    expect(await readText(root, ".env")).toBeNull();
    await engine.switchVersion("main");
    expect(await readText(root, ".env")).toBe(ENV_A);
    await engine.stop();
  });

  it("compareVersions reports protected changes without contents", async () => {
    const root = await tempRoot();
    await write(root, ".env", ENV_A);
    const engine = capture(root);
    engine.start();
    await engine.flush();
    const created = await engine.createVersion("Experiment");
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    const changes = await engine.compareVersions(created.activeVersionId);
    const secretChange = changes.find((change) => change.path === ".env");
    expect(secretChange).toMatchObject({ status: "modified", protected: true });
    expect(secretChange?.currentText).toBeUndefined();
    expect(secretChange?.incomingText).toBeUndefined();
    expect(JSON.stringify(changes).includes(MARKER)).toBe(false);
    await engine.stop();
  });

  it("merges a version's secret into Main through the encrypted path and materializes it", async () => {
    const root = await tempRoot();
    await write(root, ".env", ENV_A);
    const engine = capture(root);
    engine.start();
    await engine.flush();
    const created = await engine.createVersion("Experiment");
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    // Merge while Main is ACTIVE so the merged secret must land on disk.
    await engine.switchVersion("main");
    expect(await readText(root, ".env")).toBe(ENV_A);
    const result = await engine.mergeVersionIntoMain(created.activeVersionId);
    expect(result.conflicts).toHaveLength(0);
    expect(result.mergedFileCount).toBeGreaterThanOrEqual(1);
    expect(await readText(root, ".env")).toBe(ENV_B);

    // Secrets NEVER create conflict records (conflict records carry side
    // texts — protected contents must not ride them).
    expect(await engine.listOpenConflicts()).toEqual([]);
    await engine.stop();

    const bytes = await engineDbBytes(root);
    expect(bytes.includes(Buffer.from(MARKER, "utf8"))).toBe(false);
  });

  it("restores a protected file to before a moment through the encrypted path", async () => {
    const root = await tempRoot();
    await write(root, ".env", ENV_A);
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    const page = await engine.listMoments();
    const editMoment = page.moments.find(
      (moment) => moment.protected && moment.operation === "write",
    );
    expect(editMoment).toBeDefined();
    const result = await engine.restoreFileToBeforeMoment(editMoment?.id ?? "");
    expect(result.restored).toBe("text");
    expect(result.path).toBe(".env");
    expect(await readText(root, ".env")).toBe(ENV_A);

    // The materialized write consumes its expected event: no re-capture.
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();
    const after = await engine.listMoments();
    expect(after.moments[0].id).toBe(result.restoredMomentId);
    expect(after.moments[0].metadata.summary).toBe("Restored .env");
    expect(JSON.stringify(after).includes(MARKER)).toBe(false);
    await engine.stop();
  });

  it("interleaves protected moments into paged timelines without duplication or loss", async () => {
    const root = await tempRoot();
    const injected = stores(root);
    const engine = capture(root, injected);
    engine.start();
    await engine.flush();

    // Alternate text and secret edits so protected rows land between text
    // pages: 6 text moments, a secret moment after every second one.
    for (let index = 0; index < 6; index += 1) {
      await write(root, "doc.md", `revision ${index}\n`);
      engine.captureBatch([{ path: "doc.md", operation: "update" }]);
      await engine.flush();
      if (index % 2 === 1) {
        await write(root, ".env", `KEY=${index}\n`);
        engine.captureBatch([{ path: ".env", operation: "update" }]);
        await engine.flush();
      }
    }

    // Page through with a small limit and collect every moment id.
    const seen: string[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await engine.listMoments({
        limit: 2,
        ...(cursor !== undefined ? { beforeMomentOrder: cursor } : {}),
      });
      seen.push(...page.moments.map((moment) => moment.id));
      if (page.nextBeforeMomentOrder === null) break;
      cursor = page.nextBeforeMomentOrder;
    }
    // No duplicates across pages.
    expect(new Set(seen).size).toBe(seen.length);
    // Every protected moment shows up exactly once.
    const all = await engine.listMoments({ limit: 500 });
    const protectedIds = all.moments
      .filter((moment) => moment.protected)
      .map((moment) => moment.id);
    expect(protectedIds).toHaveLength(3);
    for (const id of protectedIds) {
      expect(seen.filter((seenId) => seenId === id)).toHaveLength(1);
    }
    // Text moments all present too (6 edits + initial reconcile of doc.md
    // does not exist yet at start, so exactly 6).
    expect(seen.length).toBe(all.moments.length);
    await engine.stop();
  });
});
