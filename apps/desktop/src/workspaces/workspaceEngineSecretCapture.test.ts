import type { SecretFileStore, VersionedTextStore } from "@dohc/workspace-engine";
import { createSecretFileStore, createVersionedTextStore } from "@dohc/workspace-engine";
import { closeTrackedEngineDbHandlesForTest } from "@dohc/workspace-engine/testing";
import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type Request,
} from "@dohc/workspace-engine-client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { nativeTmpdir } from "./testTemp";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";

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

// Deterministic COLLIDING clock shared by both injected stores. The daemon
// stamps one wall time per reconcile pass, so TIED timestamps are the normal
// regime, not an edge case. A strictly increasing counter makes every
// timestamp distinct, which leaves the half-open interleave window in
// listMoments ([lowerMs, upperMs)) untested: invert either of its comparisons
// and the interleave test below still passes.
// Each logical write reads the clock exactly once, so holding one value for
// two reads ties every secret moment to an adjacent text moment — including
// one on a page seam, which is the only place the two comparisons differ.
const READS_PER_CLOCK_TICK = 2;

function stores(root: string): {
  store: VersionedTextStore;
  secretStore: SecretFileStore;
  tick: () => number;
} {
  let now = 1_000_000;
  let reads = 0;
  const tick = () => {
    if (reads % READS_PER_CLOCK_TICK === 0) now += 10;
    reads += 1;
    return now;
  };
  return {
    store: createVersionedTextStore(root, { nowMs: tick }),
    secretStore: createSecretFileStore(root, { nowMs: tick }),
    tick,
  };
}

// The LEGACY in-process engine (no `rustEngineSessions` ⇒ `useRustEngine` is
// false), on the real AES-256-GCM secret store. Only the suites below that
// prove something about bytes at rest still use it — see the comment on
// "secret encryption at rest".
function capture(root: string, injected?: ReturnType<typeof stores>) {
  return createWorkspaceEngineCapture({
    workspaceId: "engine-secret-test",
    rootPath: root,
    ...(injected ? { store: injected.store, secretStore: injected.secretStore } : {}),
  });
}

// The DAEMON path: `rustEngineSessions` is what selects the Rust engine, and
// the loopback behind it holds real secret/version/moment state, so what these
// tests read back is recorded state and not a hand-written responder. Passing
// `requests` is what lets a test PROVE the path it took instead of inferring
// it from a result the legacy engine would also produce.
function daemonCapture(
  root: string,
  loopback: VersionedLoopbackEngine,
  requests?: Request[],
): WorkspaceEngineCapture {
  return createWorkspaceEngineCapture({
    workspaceId: "engine-secret-test",
    rootPath: root,
    rustEngineSessions: mockLiveSessions(loopback, requests),
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

describe("secret capture through the desktop pipeline (daemon path)", () => {
  it("captures live .env batches, coalesces no-op rewrites, and retires deletions", async () => {
    const root = await tempRoot();
    await write(root, ".env", ENV_A);
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
    engine.start();
    await engine.flush();

    // Positive proof of the path: a relapse to the legacy in-process engine
    // never opens a daemon workspace and never writes the secret over the
    // wire, so the suite cannot go quietly green on the engine it left.
    const methods = requests.map((request) => request.method);
    expect(methods).toContain("workspace.open");
    expect(methods).toContain(VERSIONED_METHOD.secretsWrite);

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
    expect(requests.map((request) => request.method)).toContain(
      VERSIONED_METHOD.secretsDelete,
    );
    await engine.stop();
  });

  it("a version that never had .env removes it from disk on switch and restores it on the way back", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
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

    // Both halves of the claim went over the wire: the fork carried the
    // secret tips, and the plaintext that landed back on disk came from the
    // engine's single authorized materialization rather than a leftover file.
    const methods = requests.map((request) => request.method);
    expect(methods).toContain(VERSIONED_METHOD.secretsFork);
    expect(methods).toContain(VERSIONED_METHOD.secretsMaterialize);
    await engine.stop();
  });

  it("compareVersions reports protected changes without contents", async () => {
    const root = await tempRoot();
    await write(root, ".env", ENV_A);
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
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
    // The comparison the assertions above read was answered by the engine's
    // protected comparison, not by a text diff of a plaintext row.
    expect(requests.map((request) => request.method)).toContain(
      VERSIONED_METHOD.secretsCompare,
    );
    // Absence claim: `currentText`/`incomingText` are the fields a text change
    // carries, so this catches a protected change routed as text.
    expect(JSON.stringify(changes).includes(MARKER)).toBe(false);
    await engine.stop();
  });
});

// These stay on the LEGACY in-process engine on purpose, and must not be
// ported to `mockLiveSessions`.
//
// The first three are about what reaches DISK: they read the raw
// `.dohc/engine/engine.db` (+wal/shm) bytes, or open the DB directly through
// `readTextStorePaths`, and assert a plaintext marker is ABSENT.
// `VersionedLoopbackEngine` has no encryption at all — it holds secrets as
// plaintext strings in a Map and never writes engine.db — so on the daemon
// fixture those assertions would stay green while proving nothing, and each
// title's claim about the encrypted path would be false. Porting them deletes
// the leak proof and keeps the check mark.
//
// The last two are legacy for their own reasons, stated on each test.
describe("secret capture through the desktop pipeline (encryption at rest)", () => {
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

  // Legacy on purpose. Restore reads the encrypted BEFORE-state back out and
  // materializes it as plaintext on disk, so the decrypt is the thing under
  // test — on the loopback the before-state is already a plaintext Map entry
  // and the round-trip cannot fail. The marker check on the recorded moment is
  // an absence claim, and an absence claim is worthless against a fixture that
  // never had ciphertext to get wrong.
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

  // Legacy on purpose, and NOT because of encryption: this test needs the
  // colliding clock injected above (#406), and the daemon fixture cannot be
  // given one. `VersionedLoopbackEngine` stamps every secret moment with its
  // own `this.clock++` and accepts no `nowMs` for the secret methods, so
  // timestamps there are always distinct — exactly the regime the comment on
  // READS_PER_CLOCK_TICK says leaves the half-open interleave window untested
  // (see #403). Ported, the seam-tie assertion below would go green on a
  // timeline that no longer has a tie in it.
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
    const seamMs: number[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await engine.listMoments({
        limit: 2,
        ...(cursor !== undefined ? { beforeMomentOrder: cursor } : {}),
      });
      seen.push(...page.moments.map((moment) => moment.id));
      if (page.nextBeforeMomentOrder === null) break;
      // A page's oldest TEXT moment is its own inclusive lower bound and the
      // next page's exclusive upper bound: the seam between two windows.
      const textOnPage = page.moments.filter((moment) => !moment.protected);
      const oldestText = textOnPage[textOnPage.length - 1];
      if (oldestText) seamMs.push(oldestText.recordedAtMs);
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
    // A protected moment sits ON a seam, so the assertions below exercise both
    // window comparisons: `> lowerMs` would drop it from every page and
    // `<= upperMs` would put it on two. Without this tie the checks are blind
    // to either inversion, so guard the tie rather than trust the clock.
    expect(
      all.moments.filter(
        (moment) => moment.protected && seamMs.includes(moment.recordedAtMs),
      ).length,
    ).toBeGreaterThan(0);
    for (const id of protectedIds) {
      expect(seen.filter((seenId) => seenId === id)).toHaveLength(1);
    }
    // Text moments all present too (6 edits + initial reconcile of doc.md
    // does not exist yet at start, so exactly 6).
    expect(seen.length).toBe(all.moments.length);
    await engine.stop();
  });
});
