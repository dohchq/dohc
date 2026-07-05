import { defaultWorkspaceMode } from "@dohc/workspace-core";
import type { VersionedTextStore } from "@dohc/workspace-engine";
import { createVersionedTextStore } from "@dohc/workspace-engine";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { nativeTmpdir } from "./testTemp";
import { createWorkspaceActivity } from "./workspaceActivity";
import {
  EXPECTED_ENGINE_EVENT_EXPIRY_MS,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
  createWorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { createChangeSetStore, startWorkspaceWatch } from "./workspaceWatcher";

// node:sqlite via createRequire, matching the engine store: vitest's vite
// pipeline cannot statically resolve the node:sqlite builtin yet.
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

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-capture-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface EngineMomentRow {
  path: string;
  operation: string;
  text: string;
  origin: string;
  summary: string | null;
  correlationId: string | null;
}

// Assert against the persisted engine.db itself (not the in-process store),
// so the tests prove what a fresh process — or the E2E suite — would read.
function readEngineMoments(rootPath: string): EngineMomentRow[] {
  const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        `SELECT m.path AS path, m.operation AS operation, b.text AS text,
                m.metadata_origin AS origin, m.metadata_summary AS summary,
                m.metadata_correlation_id AS correlationId
         FROM moments m JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
         ORDER BY m.moment_order`,
      )
      .all() as unknown as EngineMomentRow[];
  } finally {
    db.close();
  }
}

async function write(root: string, path: string, contents: string | Uint8Array) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function capture(root: string, options: {
  store?: VersionedTextStore;
  now?: () => number;
  onError?: (context: string, error: unknown) => void;
} = {}) {
  return createWorkspaceEngineCapture({
    workspaceId: "engine-capture-test",
    rootPath: root,
    ...options,
  });
}

describe("workspaceEngineCapture batch capture", () => {
  it("captures a settled write into the engine main version", async () => {
    const root = await tempRoot();
    await write(root, "notes/today.md", "# Today\n");
    const engine = capture(root);
    engine.captureBatch([{ path: "notes/today.md", operation: "update" }]);
    await engine.stop();

    expect(readEngineMoments(root)).toEqual([
      {
        path: "notes/today.md",
        operation: "write",
        text: "# Today\n",
        origin: "local-file",
        summary: null,
        correlationId: null,
      },
    ]);
  });

  it("coalesces rapid writes to one file into one engine record per physical state", async () => {
    const root = await tempRoot();
    const engine = capture(root);

    // Two rapid writes settle into ONE watcher batch carrying the final
    // content — the engine records exactly one moment for it.
    await write(root, "a.md", "draft 1\n");
    await write(root, "a.md", "draft 2\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();
    expect(readEngineMoments(root)).toHaveLength(1);
    expect(readEngineMoments(root)[0].text).toBe("draft 2\n");

    // A second batch observing the SAME content (e.g. touch, re-save) is a
    // no-op — never a duplicate engine record for one physical state.
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();
    expect(readEngineMoments(root)).toHaveLength(1);

    // New content records again.
    await write(root, "a.md", "draft 3\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.stop();
    expect(readEngineMoments(root)).toHaveLength(2);
  });

  it("captures deletes for engine-tracked files and skips deletes for unknown paths", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "gone soon\n");
    const engine = capture(root);
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();

    await unlink(join(root, "a.md"));
    engine.captureBatch([
      { path: "a.md", operation: "delete" },
      { path: "never-tracked.md", operation: "delete" },
    ]);
    await engine.stop();

    const moments = readEngineMoments(root);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["a.md", "write"],
      ["a.md", "delete"],
    ]);
  });

  it("skips secret, ignored, binary, and oversized files entirely", async () => {
    const root = await tempRoot();
    await write(root, ".env", "SECRET=1\n");
    await write(root, "config/.env", "SECRET=2\n");
    await write(root, "prod.env", "SECRET=3\n");
    await write(root, "node_modules/pkg/index.js", "ignored\n");
    await write(root, "logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await write(root, "not-utf8.md", new Uint8Array([0xff, 0xfe, 0x00, 0xc3]));
    await write(root, "huge.md", "x".repeat(MAX_ENGINE_CAPTURE_TEXT_BYTES + 1));
    await write(root, "ok.md", "tracked\n");

    const engine = capture(root);
    engine.captureBatch([
      { path: ".env", operation: "update" },
      { path: "config/.env", operation: "update" },
      { path: "prod.env", operation: "update" },
      { path: "node_modules/pkg/index.js", operation: "update" },
      { path: "logo.png", operation: "update" },
      { path: "not-utf8.md", operation: "update" },
      { path: "huge.md", operation: "update" },
      { path: "ok.md", operation: "update" },
    ]);
    await engine.stop();

    expect(readEngineMoments(root).map((m) => m.path)).toEqual(["ok.md"]);
  });

  it("retires a tracked path that stops being engine-ownable text", async () => {
    const root = await tempRoot();
    await write(root, "data.md", "text at first\n");
    const engine = capture(root);
    engine.captureBatch([{ path: "data.md", operation: "update" }]);
    await engine.flush();

    await write(root, "data.md", new Uint8Array([0x00, 0x01, 0x02, 0xff]));
    engine.captureBatch([{ path: "data.md", operation: "update" }]);
    await engine.stop();

    const moments = readEngineMoments(root);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["data.md", "write"],
      ["data.md", "delete"],
    ]);
    expect(moments[1].summary).toBe("Stopped tracking non-text content");
  });
});

describe("workspaceEngineCapture expected engine events", () => {
  it("suppresses engine re-capture of a registered engine-originated write, once", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    await write(root, "restored.md", "engine wrote this\n");

    engine.registerExpectedEngineEvents([
      {
        path: "restored.md",
        operation: "write",
        sha256: sha256Utf8("engine wrote this\n"),
      },
    ]);
    engine.captureBatch([{ path: "restored.md", operation: "update" }]);
    await engine.flush();
    expect(readEngineMoments(root)).toHaveLength(0);

    // Consumed: the same observation again is a real capture.
    engine.captureBatch([{ path: "restored.md", operation: "update" }]);
    await engine.stop();
    expect(readEngineMoments(root)).toHaveLength(1);
  });

  it("does not suppress a later USER edit with different content", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    engine.registerExpectedEngineEvents([
      { path: "a.md", operation: "write", sha256: sha256Utf8("engine content\n") },
    ]);
    // The user overwrote the path before the batch settled: content differs,
    // so the registration must NOT swallow the user's edit.
    await write(root, "a.md", "user content\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.stop();
    const moments = readEngineMoments(root);
    expect(moments).toHaveLength(1);
    expect(moments[0].text).toBe("user content\n");
  });

  it("expires registrations and honors cancellation", async () => {
    const root = await tempRoot();
    let nowMs = 1_000_000;
    const engine = capture(root, { now: () => nowMs });
    await write(root, "expired.md", "stale\n");

    engine.registerExpectedEngineEvents([
      { path: "expired.md", operation: "write", sha256: sha256Utf8("stale\n") },
    ]);
    nowMs += EXPECTED_ENGINE_EVENT_EXPIRY_MS + 1;
    engine.captureBatch([{ path: "expired.md", operation: "update" }]);
    await engine.flush();
    expect(readEngineMoments(root)).toHaveLength(1);

    await write(root, "cancelled.md", "cancelled\n");
    const cancel = engine.registerExpectedEngineEvents([
      { path: "cancelled.md", operation: "write", sha256: sha256Utf8("cancelled\n") },
    ]);
    cancel();
    engine.captureBatch([{ path: "cancelled.md", operation: "update" }]);
    await engine.stop();
    expect(readEngineMoments(root).map((m) => m.path)).toEqual([
      "expired.md",
      "cancelled.md",
    ]);
  });

  it("suppresses a registered engine-originated delete", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    await write(root, "a.md", "content\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();

    // Engine restore deleted the file on disk AND recorded its own moment;
    // the watcher's observation must not double-record the delete.
    await unlink(join(root, "a.md"));
    engine.registerExpectedEngineEvents([{ path: "a.md", operation: "delete" }]);
    engine.captureBatch([{ path: "a.md", operation: "delete" }]);
    await engine.stop();
    expect(readEngineMoments(root).map((m) => m.operation)).toEqual(["write"]);
  });
});

describe("workspaceEngineCapture startup reconciliation", () => {
  it("captures closed-period edits and deletions, idempotently", async () => {
    const root = await tempRoot();
    await write(root, "kept.md", "unchanged\n");
    await write(root, "edited.md", "before\n");
    await write(root, "deleted.md", "doomed\n");
    await write(root, ".env", "SECRET=1\n");

    // First session: engine learns the workspace via reconciliation.
    const first = capture(root);
    first.start();
    await first.stop();
    expect(readEngineMoments(root).map((m) => m.path).sort()).toEqual([
      "deleted.md",
      "edited.md",
      "kept.md",
    ]);

    // Closed period: one edit, one delete, one new file.
    await write(root, "edited.md", "after\n");
    await unlink(join(root, "deleted.md"));
    await write(root, "created.md", "new\n");

    const second = capture(root);
    second.start();
    await second.stop();
    const afterSecond = readEngineMoments(root);
    const reconciled = afterSecond.slice(3);
    expect(
      reconciled.map((m) => [m.path, m.operation]).sort(),
    ).toEqual([
      ["created.md", "write"],
      ["deleted.md", "delete"],
      ["edited.md", "write"],
    ]);
    // Actor-neutral local provenance, one correlation id per pass.
    for (const moment of reconciled) {
      expect(moment.origin).toBe("local-file");
      expect(moment.summary).toBe("Reconciled offline edits");
      expect(moment.correlationId).toMatch(/^reconcile-/);
    }
    expect(new Set(reconciled.map((m) => m.correlationId)).size).toBe(1);

    // Idempotent: running reconciliation again adds nothing new.
    const third = capture(root);
    third.start();
    await third.stop();
    expect(readEngineMoments(root)).toHaveLength(afterSecond.length);
  });

  it("serializes reconciliation before a live watcher batch on one chain", async () => {
    const root = await tempRoot();
    await write(root, "offline.md", "offline edit\n");

    const order: string[] = [];
    const store = createVersionedTextStore(root);
    const trackedStore: VersionedTextStore = {
      ...store,
      async listTextFiles(input) {
        // Reconciliation's final phase; slow it so an unserialized batch
        // capture would interleave ahead of it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push("reconcile:listTextFiles");
        return store.listTextFiles(input);
      },
      async writeTextFile(input) {
        order.push(`write:${input.path}`);
        return store.writeTextFile(input);
      },
    };

    const engine = capture(root, { store: trackedStore });
    engine.start();
    await write(root, "live.md", "live edit\n");
    engine.captureBatch([{ path: "live.md", operation: "update" }]);
    await engine.stop();

    expect(order).toEqual([
      "write:offline.md",
      "reconcile:listTextFiles",
      "write:live.md",
    ]);
  });
});

describe("workspaceEngineCapture failure isolation", () => {
  it("keeps legacy watcher history recording when the engine store fails", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-fail-open",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const errors: string[] = [];
    const failingStore = new Proxy({} as VersionedTextStore, {
      get:
        () =>
        async () => {
          throw new Error("engine store unavailable");
        },
    });
    const engine = capture(root, {
      store: failingStore,
      onError: (context) => {
        errors.push(context);
      },
    });

    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      engineCapture: () => engine,
      onRecorded: () => resolveRecorded?.(),
    });
    await handle.ready;
    await write(root, "notes.md", "# Notes\n");
    await recorded;
    await handle.stop();
    await engine.stop();

    // Legacy history recorded the edit even though every engine call threw.
    const records = await createChangeSetStore(root).list();
    expect(records).toHaveLength(1);
    expect(records[0].files.map((file) => file.path)).toEqual(["notes.md"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("one bad path does not drop the rest of the batch", async () => {
    const root = await tempRoot();
    await write(root, "good.md", "fine\n");
    await write(root, "bad.md", "poison\n");
    const store = createVersionedTextStore(root);
    const poisonedStore: VersionedTextStore = {
      ...store,
      async writeTextFile(input) {
        if (input.path === "bad.md") throw new Error("poisoned path");
        return store.writeTextFile(input);
      },
    };
    const errors: string[] = [];
    const engine = capture(root, {
      store: poisonedStore,
      onError: (context) => {
        errors.push(context);
      },
    });
    engine.captureBatch([
      { path: "bad.md", operation: "update" },
      { path: "good.md", operation: "update" },
    ]);
    await engine.stop();

    expect(readEngineMoments(root).map((m) => m.path)).toEqual(["good.md"]);
    expect(errors).toEqual(["batch capture of bad.md"]);
  });
});

describe("workspaceEngineCapture lifecycle via workspaceActivity", () => {
  it("attaches per open workspace and flushes the last capture on stopAll", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-lifecycle",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    let captureBuilds = 0;
    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const activity = createWorkspaceActivity(
      () => resolveRecorded?.(),
      {
        captureFor: (w) => {
          captureBuilds += 1;
          return createWorkspaceEngineCapture({
            workspaceId: w.workspaceId,
            rootPath: w.rootPath,
          });
        },
      },
    );

    await activity.open(workspace);
    // Re-opening must not build a second engine instance (singleton per open).
    await activity.open(workspace);
    expect(captureBuilds).toBe(1);

    await write(root, "flushed.md", "must survive shutdown\n");
    await recorded;
    // stopAll joins the shutdown chain: watcher final flush, then capture
    // drain — the last capture is durably in engine.db when it resolves.
    await activity.stopAll();

    const moments = readEngineMoments(root);
    expect(moments.some((m) => m.path === "flushed.md")).toBe(true);
  }, 15_000);

  it("registerExpectedEngineEvents reaches the open workspace's capture", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-expected",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (w) =>
        createWorkspaceEngineCapture({
          workspaceId: w.workspaceId,
          rootPath: w.rootPath,
        }),
    });
    await activity.open(workspace);
    const cancel = activity.registerExpectedEngineEvents(workspace.workspaceId, [
      { path: "a.md", operation: "delete" },
    ]);
    expect(typeof cancel).toBe("function");
    cancel?.();
    await activity.stopAll();

    expect(() =>
      activity.registerExpectedEngineEvents("not-open", [
        { path: "a.md", operation: "delete" },
      ]),
    ).toThrow(/not open/i);
  }, 15_000);
});

describe("workspaceEngineCapture performance evidence (PR 0M-3)", () => {
  it("measures 100-file burst capture latency", async () => {
    const root = await tempRoot();
    const events = [] as Array<{ path: string; operation: "update" }>;
    for (let index = 0; index < 100; index += 1) {
      const path = `burst/file-${String(index).padStart(3, "0")}.md`;
      await write(root, path, `# File ${index}\n\ncontent ${index}\n`);
      events.push({ path, operation: "update" });
    }
    const engine = capture(root);
    const startedAt = performance.now();
    engine.captureBatch(events);
    await engine.flush();
    const elapsedMs = performance.now() - startedAt;
    await engine.stop();

    expect(readEngineMoments(root)).toHaveLength(100);
    console.log(
      `[perf] watcher-batch engine capture, 100-file burst: ${elapsedMs.toFixed(1)}ms ` +
        `(${(elapsedMs / 100).toFixed(2)}ms/file) on ${cpus()[0]?.model ?? "unknown CPU"}, ` +
        `node ${process.version}, ${process.platform}`,
    );
  }, 60_000);

  it("measures startup reconciliation for 1,000 files with 10 changed", async () => {
    const root = await tempRoot();
    const paths: string[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const path = `corpus/dir-${index % 20}/file-${String(index).padStart(4, "0")}.md`;
      await write(root, path, `# Doc ${index}\n\nbody ${index}\n`);
      paths.push(path);
    }
    // Session one seeds the engine.
    const first = capture(root);
    first.start();
    await first.stop();
    expect(readEngineMoments(root)).toHaveLength(1000);

    // Closed period: 10 files change.
    for (let index = 0; index < 10; index += 1) {
      await write(root, paths[index * 97], `# Doc changed\n\nedited ${index}\n`);
    }
    const second = capture(root);
    const startedAt = performance.now();
    second.start();
    await second.flush();
    const elapsedMs = performance.now() - startedAt;
    await second.stop();

    expect(readEngineMoments(root)).toHaveLength(1010);
    console.log(
      `[perf] startup reconciliation, 1,000 files / 10 changed: ${elapsedMs.toFixed(1)}ms ` +
        `on ${cpus()[0]?.model ?? "unknown CPU"}, node ${process.version}, ${process.platform}`,
    );
  }, 120_000);
});
