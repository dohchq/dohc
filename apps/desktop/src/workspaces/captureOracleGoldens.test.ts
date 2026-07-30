// The TS side of the E-shard capture DIFFERENTIAL. It drives the REAL
// TypeScript capture pipeline (the oracle) through the shared fixtures and
// projects normalized per-path state. With DOHC_EMIT_CAPTURE_GOLDENS=1 it
// rewrites tools/rust-engine-program/capture-goldens.json; otherwise it
// asserts the committed goldens still match, so CI catches oracle drift.
// crates/dohc-workspace-engine/tests/capture_differential.rs replays the same
// fixtures against the Rust daemon and compares against the same goldens.
//
// Projection rules (both sides MUST agree):
// - ids and timestamps are excluded (TS uses random UUIDs — ratified);
// - text heads project { kind, text, sha256(utf8), byteLength };
// - binary heads project { kind, sha256(bytes), byteLength } (no bytes);
// - secrets project { kind, byteLength } ONLY — goldens stay non-leaking;
// - absence carries everTracked (any moments/secret_moments rows for the
//   path), distinguishing RETIRED from NEVER-TRACKED — "absent from the
//   list" alone conflates them.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createSecretFileStore, createVersionedTextStore } from "@dohc/workspace-engine";
import { closeTrackedEngineDbHandlesForTest } from "@dohc/workspace-engine/testing";
import { nativeTmpdir } from "./testTemp";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";

const requireModule = createRequire(import.meta.url);
type SqliteDatabase = new (
  path: string,
  options?: { readOnly?: boolean },
) => {
  prepare(sql: string): { get(...args: unknown[]): unknown };
  close(): void;
};
// vitest's vite pipeline cannot statically resolve the node:sqlite builtin —
// and Node 20 (still in the workspace's supported range) does not ship it.
// The oracle test SKIPS visibly there; the rust-engine gate and golden
// regeneration always run on Node 22+.
let DatabaseSync: SqliteDatabase | null = null;
try {
  ({ DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: SqliteDatabase;
  });
} catch {
  DatabaseSync = null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(HERE, "../../../../tools/rust-engine-program/capture-fixtures.json");
const GOLDENS_PATH = join(HERE, "../../../../tools/rust-engine-program/capture-goldens.json");
const WORKSPACE_ID = "capture-differential-oracle";

interface FixtureStep {
  op: "write" | "write-binary" | "delete";
  path: string;
  text?: string;
  bytesBase64?: string;
}
interface FixtureScenario {
  name: string;
  steps: FixtureStep[];
  offline: FixtureStep[];
  watch: string[];
}
interface PathProjection {
  kind: "text" | "binary" | "secret" | "absent";
  text?: string;
  sha256?: string;
  byteLength?: number;
  everTracked: boolean;
}

const roots: string[] = [];

afterEach(async () => {
  // Windows cannot unlink engine.db* files with open sqlite handles (EBUSY).
  closeTrackedEngineDbHandlesForTest();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-capture-golden-"));
  roots.push(root);
  return root;
}

async function applyToDisk(root: string, step: FixtureStep): Promise<void> {
  const absolute = join(root, step.path);
  if (step.op === "delete") {
    await unlink(absolute);
    return;
  }
  await mkdir(dirname(absolute), { recursive: true });
  if (step.op === "write") {
    await writeFile(absolute, step.text ?? "");
  } else {
    await writeFile(absolute, Buffer.from(step.bytesBase64 ?? "", "base64"));
  }
}

function everTracked(root: string, path: string): boolean {
  if (!DatabaseSync) throw new Error("node:sqlite unavailable — test must be skipped");
  const db = new DatabaseSync(join(root, ".dohc/engine/engine.db"), { readOnly: true });
  try {
    const moments = db
      .prepare("SELECT COUNT(*) AS n FROM moments WHERE workspace_id = ? AND path = ?")
      .get(WORKSPACE_ID, path) as { n: number };
    if (moments.n > 0) {
      return true;
    }
    const secretMoments = db
      .prepare("SELECT COUNT(*) AS n FROM secret_moments WHERE workspace_id = ? AND path = ?")
      .get(WORKSPACE_ID, path) as { n: number };
    return secretMoments.n > 0;
  } finally {
    db.close();
  }
}

async function projectScenario(
  root: string,
  scenario: FixtureScenario,
): Promise<Record<string, PathProjection>> {
  const store = createVersionedTextStore(root);
  const secretStore = createSecretFileStore(root);
  try {
    const versionId =
      (await store.getActiveVersion({ workspaceId: WORKSPACE_ID }))?.id ?? "main";
    const secrets = await secretStore.listSecretFiles({ workspaceId: WORKSPACE_ID, versionId });
    const projection: Record<string, PathProjection> = {};
    for (const path of scenario.watch) {
      const tracked = everTracked(root, path);
      const secret = secrets.find((stat) => stat.path === path);
      if (secret) {
        projection[path] = {
          kind: "secret",
          byteLength: secret.byteLength,
          everTracked: tracked,
        };
        continue;
      }
      const snapshot = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId, path });
      if (!snapshot) {
        projection[path] = { kind: "absent", everTracked: tracked };
        continue;
      }
      if (snapshot.contentKind === "binary") {
        const bytes = await store.readBinaryFile({ workspaceId: WORKSPACE_ID, versionId, path });
        projection[path] = {
          kind: "binary",
          sha256: createHash("sha256")
            .update(bytes ?? new Uint8Array())
            .digest("hex"),
          byteLength: bytes?.byteLength ?? 0,
          everTracked: tracked,
        };
        continue;
      }
      const utf8 = Buffer.from(snapshot.text, "utf8");
      projection[path] = {
        kind: "text",
        text: snapshot.text,
        sha256: createHash("sha256").update(utf8).digest("hex"),
        byteLength: utf8.byteLength,
        everTracked: tracked,
      };
    }
    return projection;
  } finally {
    await store.close().catch(() => undefined);
    await secretStore.close().catch(() => undefined);
  }
}

async function runScenario(scenario: FixtureScenario): Promise<Record<string, PathProjection>> {
  const root = await tempRoot();
  const errors: unknown[] = [];
  const onError = (context: string, error: unknown) => {
    errors.push({ context, error });
  };

  let engine = createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    onError,
  });
  engine.start();
  await engine.flush();
  for (const step of scenario.steps) {
    await applyToDisk(root, step);
    engine.captureBatch([
      { path: step.path, operation: step.op === "delete" ? "delete" : "update" },
    ]);
    // Flush PER STEP so ordering is real: without it a write-then-delete
    // would coalesce and the write would never be observed.
    await engine.flush();
  }
  await engine.stop();

  if (scenario.offline.length > 0) {
    for (const step of scenario.offline) {
      await applyToDisk(root, step);
    }
    // A fresh engine's startup reconciliation is what notices offline
    // mutations — the same contract the Rust rehydration seed implements.
    engine = createWorkspaceEngineCapture({ workspaceId: WORKSPACE_ID, rootPath: root, onError });
    engine.start();
    await engine.flush();
    await engine.stop();
  }

  // A broken oracle must fail loudly, not emit a golden of an empty
  // workspace: flush() never rejects, so collected errors are the signal.
  expect(errors, `oracle errors in ${scenario.name}`).toEqual([]);
  return projectScenario(root, scenario);
}

it.skipIf(!DatabaseSync)(
  "capture goldens match the TypeScript oracle",
  { timeout: 120_000 },
  async () => {
    const fixtures = JSON.parse(await readFile(FIXTURES_PATH, "utf8")) as {
      scenarios: FixtureScenario[];
    };
    const produced: Record<string, Record<string, PathProjection>> = {};
    for (const scenario of fixtures.scenarios) {
      produced[scenario.name] = await runScenario(scenario);
    }

    if (process.env.DOHC_EMIT_CAPTURE_GOLDENS === "1") {
      await writeFile(GOLDENS_PATH, `${JSON.stringify({ scenarios: produced }, null, 2)}\n`);
      return;
    }
    const goldens = JSON.parse(await readFile(GOLDENS_PATH, "utf8")) as {
      scenarios: Record<string, Record<string, PathProjection>>;
    };
    expect(produced).toEqual(goldens.scenarios);
  },
);
