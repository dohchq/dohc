import { defaultWorkspaceMode } from "@dohc/workspace-core";
import type { VersionedTextStore } from "@dohc/workspace-engine";
import { createVersionedTextStore } from "@dohc/workspace-engine";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { nativeTmpdir } from "./testTemp";
import { createWorkspaceActivity } from "./workspaceActivity";
import {
  EXPECTED_ENGINE_EVENT_EXPIRY_MS,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
  createDefaultDiskWriter,
  createWorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { createChangeSetStore } from "@dohc/workspace-history";
import { startWorkspaceWatch } from "./workspaceWatcher";

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

function readBinaryBlobRows(rootPath: string): Array<{ sha256: string; byteLength: number }> {
  const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT sha256, byte_length AS byteLength FROM binary_blobs ORDER BY sha256")
      .all() as Array<{ sha256: string; byteLength: number }>;
  } finally {
    db.close();
  }
}

function readSnapshotKinds(rootPath: string): Array<{ path: string; contentKind: string }> {
  const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT path, content_kind AS contentKind FROM snapshots ORDER BY path")
      .all() as Array<{ path: string; contentKind: string }>;
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
  onCaptureOutcome?: (outcome: { ok: boolean }) => void;
  activeAgentRun?: () => { agentId: string; onBehalfOf: string; agentRunId: string } | null;
} = {}) {
  return createWorkspaceEngineCapture({
    workspaceId: "engine-capture-test",
    rootPath: root,
    ...options,
  });
}

// PR 0N-1: the author a persisted moment carries (NULL = actor-neutral).
function readEngineMomentAuthors(rootPath: string): Array<Record<string, unknown> | null> {
  const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT m.author_json AS author FROM moments m ORDER BY m.moment_order")
      .all()
      .map((row) =>
        typeof row.author === "string"
          ? (JSON.parse(row.author) as Record<string, unknown>)
          : null,
      );
  } finally {
    db.close();
  }
}

describe("workspaceEngineCapture batch capture", () => {
  it("captures an in-cap binary file as a binary moment", async () => {
    const root = await tempRoot();
    const pngLike = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await write(root, "logo.png", pngLike);
    const engine = capture(root, {});
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    expect(readSnapshotKinds(root)).toEqual([{ path: "logo.png", contentKind: "binary" }]);
    expect(readBinaryBlobRows(root)).toEqual([
      {
        sha256: createHash("sha256").update(pngLike).digest("hex"),
        byteLength: pngLike.byteLength,
      },
    ]);
    expect(readEngineMoments(root)).toHaveLength(1);
    await engine.stop();
  });

  it("skips oversized binary content exactly like other untracked content", async () => {
    const root = await tempRoot();
    await write(root, "huge.png", new Uint8Array(MAX_ENGINE_CAPTURE_BINARY_BYTES + 1));
    const engine = capture(root, {});
    engine.captureBatch([{ path: "huge.png", operation: "update" }]);
    await engine.flush();

    expect(readEngineMoments(root)).toHaveLength(0);
    expect(readBinaryBlobRows(root)).toHaveLength(0);
    await engine.stop();
  });

  it("captures an over-text-cap invalid-UTF-8 text-media file as a binary moment", async () => {
    const root = await tempRoot();
    // 1 MiB of 0xFF: a text-suffixed path over the text cap that is binary
    // in disguise (invalid UTF-8) and within the binary cap. The text cap
    // must not retire it before the binary path can claim it.
    const bytes = Buffer.alloc(1024 * 1024, 0xff);
    await write(root, "blob.md", bytes);
    const engine = capture(root, {});
    engine.captureBatch([{ path: "blob.md", operation: "update" }]);
    await engine.stop();

    expect(readSnapshotKinds(root)).toEqual([{ path: "blob.md", contentKind: "binary" }]);
    expect(readBinaryBlobRows(root)).toEqual([
      {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      },
    ]);
    expect(readEngineMoments(root)).toHaveLength(1);
  });

  it("retires an over-text-cap valid-UTF-8 text file instead of demoting it to binary", async () => {
    const root = await tempRoot();
    await write(root, "big.md", "small\n");
    const engine = capture(root, {});
    engine.captureBatch([{ path: "big.md", operation: "update" }]);
    await engine.flush();

    // Genuine text over the text cap is untracked content (established
    // behavior): the previously tracked path is retired, never stored as
    // binary bytes.
    await write(root, "big.md", "x".repeat(1024 * 1024));
    engine.captureBatch([{ path: "big.md", operation: "update" }]);
    await engine.stop();

    expect(readEngineMoments(root).map((m) => [m.path, m.operation])).toEqual([
      ["big.md", "write"],
      ["big.md", "delete"],
    ]);
    expect(readBinaryBlobRows(root)).toHaveLength(0);
  });

  it("does not record a duplicate moment for unchanged binary recapture", async () => {
    const root = await tempRoot();
    const bytes = Buffer.from([0, 1, 2, 255]);
    await write(root, "logo.png", bytes);
    const engine = capture(root, {});
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    expect(readEngineMoments(root)).toHaveLength(1);
    expect(readBinaryBlobRows(root)).toHaveLength(1);
    await engine.stop();
  });

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

  it("skips secret, ignored, and oversized files while capturing in-cap binary content", async () => {
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

    expect(readEngineMoments(root).map((m) => m.path)).toEqual([
      "logo.png",
      "not-utf8.md",
      "ok.md",
    ]);
    expect(readSnapshotKinds(root)).toEqual([
      { path: "logo.png", contentKind: "binary" },
      { path: "not-utf8.md", contentKind: "binary" },
      { path: "ok.md", contentKind: "text" },
    ]);
  });

  // Symlink containment (CodeRabbit arc gate): the live watcher can emit a
  // symlink LEAF path even though the scanner skips symlinks, and stat()
  // would dereference it OUTSIDE the workspace — foreign content must never
  // enter durable engine history as owned text.
  it("never captures a symlink leaf, even when it dereferences outside the workspace", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "secret.md", "outside secret\n");
    await mkdir(join(root, "notes"), { recursive: true });
    await symlink(join(outside, "secret.md"), join(root, "notes", "today.md"));
    await write(root, "inside.md", "real inside text\n");
    await symlink(join(root, "inside.md"), join(root, "alias.md"));

    const engine = capture(root);
    engine.captureBatch([
      { path: "notes/today.md", operation: "update" },
      { path: "alias.md", operation: "update" },
      { path: "inside.md", operation: "update" },
    ]);
    await engine.stop();

    // Only the real file was captured; neither symlink (outside-pointing or
    // workspace-internal) produced an engine moment.
    expect(readEngineMoments(root).map((m) => [m.path, m.text])).toEqual([
      ["inside.md", "real inside text\n"],
    ]);
  });

  it("retires a tracked path that later becomes a symlink", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "secret.md", "outside secret\n");
    await write(root, "notes.md", "honest text\n");
    const engine = capture(root);
    engine.captureBatch([{ path: "notes.md", operation: "update" }]);
    await engine.flush();

    await unlink(join(root, "notes.md"));
    await symlink(join(outside, "secret.md"), join(root, "notes.md"));
    engine.captureBatch([{ path: "notes.md", operation: "update" }]);
    await engine.stop();

    const moments = readEngineMoments(root);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["notes.md", "write"],
      ["notes.md", "delete"],
    ]);
    // The symlink target's content never entered the store.
    expect(moments.some((m) => m.text.includes("outside secret"))).toBe(false);
  });

  it("preserves identity when a tracked text path becomes in-cap binary content", async () => {
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
      ["data.md", "write"],
    ]);
    // The transition is an honest moment, not a generic update.
    expect(moments[1].summary).toBe("Became a binary file");
    expect(readSnapshotKinds(root)).toEqual([{ path: "data.md", contentKind: "binary" }]);
  });

  it("records an honest moment when a binary path becomes text again", async () => {
    const root = await tempRoot();
    await write(root, "data.md", new Uint8Array([0x00, 0x01, 0x02, 0xff]));
    const engine = capture(root);
    engine.captureBatch([{ path: "data.md", operation: "update" }]);
    await engine.flush();

    await write(root, "data.md", "text again\n");
    engine.captureBatch([{ path: "data.md", operation: "update" }]);
    await engine.stop();

    const moments = readEngineMoments(root);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["data.md", "write"],
      ["data.md", "write"],
    ]);
    expect(moments[1].summary).toBe("Became a text file");
    expect(readSnapshotKinds(root)).toEqual([{ path: "data.md", contentKind: "text" }]);
  });

  it("honors files policy tracked false without deleting prior moments", async () => {
    const root = await tempRoot();
    await write(root, "kept.md", "v1\n");
    const engine = capture(root);
    engine.captureBatch([{ path: "kept.md", operation: "update" }]);
    await engine.flush();
    expect(readEngineMoments(root).map((m) => [m.path, m.text])).toEqual([
      ["kept.md", "v1\n"],
    ]);

    await write(
      root,
      ".dohc/files.toml",
      '[[rule]]\npath = "kept.md"\ntracked = false\n\n[[rule]]\npath = "new.md"\ntracked = false\n',
    );
    await write(root, "kept.md", "v2\n");
    await write(root, "new.md", "new\n");
    engine.captureBatch([
      { path: "kept.md", operation: "update" },
      { path: "new.md", operation: "update" },
    ]);
    await engine.stop();

    expect(readEngineMoments(root).map((m) => [m.path, m.text])).toEqual([
      ["kept.md", "v1\n"],
    ]);
  });

  it("retires a policy-untracked path on the next reconcile pass without touching disk", async () => {
    const root = await tempRoot();
    await write(root, "kept.md", "v1\n");
    const first = capture(root);
    first.captureBatch([{ path: "kept.md", operation: "update" }]);
    await first.stop();

    // Policy lands while the engine is closed; the next session's startup
    // reconciliation must retire the engine snapshot (never-stale rule) with
    // an honest summary while leaving the disk file alone.
    await write(root, ".dohc/files.toml", '[[rule]]\npath = "kept.md"\ntracked = false\n');
    const second = capture(root);
    second.start();
    await second.stop();

    const moments = readEngineMoments(root);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["kept.md", "write"],
      ["kept.md", "delete"],
    ]);
    expect(moments[1].summary).toBe("Stopped tracking by policy");
    await expect(readFile(join(root, "kept.md"), "utf8")).resolves.toBe("v1\n");
  });

  it("surfaces malformed policy through onError without breaking other files", async () => {
    const root = await tempRoot();
    await write(root, ".dohc/files.toml", '[[rule]]\npath = "ignored.md"\nmode = true\n');
    await write(root, "a.md", "alpha\n");
    await write(root, "b.md", "beta\n");
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      onError: (context, error) => {
        errors.push({ context, error });
      },
    });

    engine.captureBatch([
      { path: "a.md", operation: "update" },
      { path: "b.md", operation: "update" },
    ]);
    await engine.stop();

    expect(errors.some((entry) => entry.context.includes("policy validation"))).toBe(true);
    expect(readEngineMoments(root).map((m) => m.path)).toEqual(["a.md", "b.md"]);
  });

  it("refreshes policy files on the next capture pass without watcher invalidation", async () => {
    const root = await tempRoot();
    await write(root, "policy-target.md", "v1\n");
    const engine = capture(root);
    engine.captureBatch([{ path: "policy-target.md", operation: "update" }]);
    await engine.flush();
    expect(readEngineMoments(root).map((m) => m.text)).toEqual(["v1\n"]);

    await write(
      root,
      ".dohc/files.toml",
      '[[rule]]\npath = "policy-target.md"\ntracked = false\n',
    );
    await write(root, "policy-target.md", "v2\n");
    engine.captureBatch([{ path: "policy-target.md", operation: "update" }]);
    await engine.stop();

    expect(readEngineMoments(root).map((m) => m.text)).toEqual(["v1\n"]);
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

  it("falls back to the TypeScript scan path when the flagged kernel cannot spawn", async () => {
    const root = await tempRoot();
    await write(root, "offline.md", "offline edit\n");
    const errors: Array<{ context: string; error: unknown }> = [];
    const previousFlag = process.env.DOHC_KERNEL_SIDECAR;
    const previousBinary = process.env.DOHC_KERNEL_BINARY_PATH;
    process.env.DOHC_KERNEL_SIDECAR = "1";
    process.env.DOHC_KERNEL_BINARY_PATH = join(root, "missing-kernel");
    try {
      const engine = capture(root, {
        onError(context, error) {
          errors.push({ context, error });
        },
      });
      engine.start();
      await engine.stop();
    } finally {
      if (previousFlag === undefined) delete process.env.DOHC_KERNEL_SIDECAR;
      else process.env.DOHC_KERNEL_SIDECAR = previousFlag;
      if (previousBinary === undefined) delete process.env.DOHC_KERNEL_BINARY_PATH;
      else process.env.DOHC_KERNEL_BINARY_PATH = previousBinary;
    }

    expect(readEngineMoments(root).map((m) => [m.path, m.operation])).toEqual([
      ["offline.md", "write"],
    ]);
    expect(errors.some((entry) => entry.context === "kernel scan fallback")).toBe(true);
  });
});

describe("workspaceEngineCapture sole recorder (PR 0M-5)", () => {
  it("records flagged-workspace batches into the engine only — no legacy change set", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-sole-recorder",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const engine = capture(root);
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

    const moments = readEngineMoments(root);
    expect(moments.map((moment) => moment.path)).toEqual(["notes.md"]);
    expect(moments[0].text).toBe("# Notes\n");
    expect(await createChangeSetStore(root).list()).toHaveLength(0);
  });

  it("records NOTHING without an engine capture (retirement Phase C: opt-out has no recorder)", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "opted-out-no-recorder",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      onRecorded: () => resolveRecorded?.(),
    });
    await handle.ready;
    await write(root, "notes.md", "# Notes\n");
    // The batch still settles (UI refresh / cloud queue), but no history of
    // any kind is written: no legacy change sets, no engine store.
    await recorded;
    await handle.stop();

    expect(await createChangeSetStore(root).list()).toHaveLength(0);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, ".dohc", "engine", "engine.db"))).toBe(false);
  });
});

describe("workspaceEngineCapture failure isolation", () => {
  // PR 0M-5 ended the 0M-3 interim dual-write: with the engine as the sole
  // recorder, an engine-store failure surfaces via onError and the watcher
  // keeps running, but no legacy change set is written for the flagged
  // workspace (fail visible, no second source of truth — the disk stays the
  // source and the next reconcile pass recovers the missed capture). This
  // test previously asserted the legacy fail-open record; the change is the
  // deliberate 0M-5 behavior flip.
  it("surfaces engine failures without crashing the watcher and without a legacy record", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-fail-visible",
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

    let recordedCount = 0;
    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      engineCapture: () => engine,
      onRecorded: () => {
        recordedCount += 1;
        resolveRecorded?.();
      },
    });
    await handle.ready;
    await write(root, "notes.md", "# Notes\n");
    await recorded;
    await handle.stop();
    await engine.stop();

    // The watcher survived and completed the batch, the failure surfaced,
    // and NO legacy change set was written for the flagged workspace.
    expect(recordedCount).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    const records = await createChangeSetStore(root).list();
    expect(records).toHaveLength(0);
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

describe("workspaceEngineCapture capture-failure notice (PR 0M-7)", () => {
  // A real store wrapped so every method throws while `failing` is true —
  // flip it to simulate an engine store that recovers.
  function flakyStore(root: string) {
    const real = createVersionedTextStore(root);
    const state = { failing: true };
    const store = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (state.failing) throw new Error("engine store unavailable");
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as VersionedTextStore;
    return { store, state };
  }

  it("reports a failed outcome per failing capture pass and success on recovery", async () => {
    const root = await tempRoot();
    await write(root, "note.md", "v1\n");
    const { store, state } = flakyStore(root);
    const outcomes: boolean[] = [];
    const engine = capture(root, {
      store,
      onError: () => {},
      onCaptureOutcome: ({ ok }) => outcomes.push(ok),
    });

    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.flush();
    expect(outcomes).toEqual([false]);

    state.failing = false;
    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.stop();
    expect(outcomes).toEqual([false, true]);
    // The recovered pass really captured: a transient open failure must not
    // be cached forever.
    expect(readEngineMoments(root).map((m) => m.path)).toEqual(["note.md"]);
  });

  it("reports a failed outcome when only one path in a batch fails", async () => {
    const root = await tempRoot();
    await write(root, "good.md", "fine\n");
    await write(root, "bad.md", "poison\n");
    const real = createVersionedTextStore(root);
    const poisonedStore: VersionedTextStore = {
      ...real,
      async writeTextFile(input) {
        if (input.path === "bad.md") throw new Error("poisoned path");
        return real.writeTextFile(input);
      },
    };
    const outcomes: boolean[] = [];
    const engine = capture(root, {
      store: poisonedStore,
      onError: () => {},
      onCaptureOutcome: ({ ok }) => outcomes.push(ok),
    });
    engine.captureBatch([
      { path: "bad.md", operation: "update" },
      { path: "good.md", operation: "update" },
    ]);
    await engine.stop();
    expect(outcomes).toEqual([false]);
  });

  it("raises the workspace notice once without spam and clears it when capture recovers", async () => {
    const root = await tempRoot();
    await write(root, "note.md", "v1\n");
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-notice",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const { store, state } = flakyStore(root);
    let notifyCount = 0;
    const activity = createWorkspaceActivity(
      () => {
        notifyCount += 1;
      },
      {
        captureFor: (w, hooks) =>
          createWorkspaceEngineCapture({
            workspaceId: w.workspaceId,
            rootPath: w.rootPath,
            store,
            onError: () => {},
            onCaptureOutcome: hooks.onCaptureOutcome,
          }),
      },
    );
    await activity.open(workspace);
    const engineCapture = activity.engineCaptureFor(workspace.workspaceId);
    expect(engineCapture).not.toBeNull();
    // Startup reconciliation fails against the broken store: the notice is
    // raised (one notify for the transition).
    await engineCapture!.flush();
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBe(true);
    const notifiesAtRaise = notifyCount;
    expect(notifiesAtRaise).toBeGreaterThan(0);

    // Repeated failures keep the flag raised but never re-notify (no spam).
    engineCapture!.captureBatch([{ path: "note.md", operation: "update" }]);
    await engineCapture!.flush();
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBe(true);
    expect(notifyCount).toBe(notifiesAtRaise);

    // A later successful capture clears the notice (one more notify).
    state.failing = false;
    engineCapture!.captureBatch([{ path: "note.md", operation: "update" }]);
    await engineCapture!.flush();
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBe(false);
    expect(notifyCount).toBe(notifiesAtRaise + 1);

    await activity.stopAll();
  }, 15_000);

  it("keeps unflagged workspaces unaffected", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-unflagged-notice",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => null,
    });
    await activity.open(workspace);
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBe(false);
    await activity.stopAll();
    // Not-open workspaces report a clean status too.
    expect(activity.getStatus("never-opened").historyCaptureFailed).toBe(false);
  }, 15_000);
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

describe("createDefaultDiskWriter symlink containment", () => {
  // The engine's own materialization writes (switch/merge/restore) must stay
  // inside the workspace even against adversarial symlinks on disk.
  it("refuses to write through a symlink leaf", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "target.md", "original outside content\n");
    await symlink(join(outside, "target.md"), join(root, "notes.md"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "notes.md"), "engine text\n"),
    ).rejects.toThrow(/symlink/);
    // The symlink target outside the workspace was never touched.
    expect(await readFile(join(outside, "target.md"), "utf8")).toBe(
      "original outside content\n",
    );
  });

  it("refuses to mkdir through a symlinked ancestor pointing outside the workspace", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(root, "escape"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "escape", "deep", "file.md"), "x\n"),
    ).rejects.toThrow(/escaped the workspace root/);
    // mkdir -p never created directories on the far side of the symlink.
    expect(existsSync(join(outside, "deep"))).toBe(false);
  });

  it("writes normally inside the workspace, creating missing directories", async () => {
    const root = await tempRoot();
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "a", "b", "c.md"), "nested\n");
    expect(await readFile(join(root, "a", "b", "c.md"), "utf8")).toBe("nested\n");
  });

  it("deleting a symlink leaf removes the link, not its target", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "keep.md", "must survive\n");
    await symlink(join(outside, "keep.md"), join(root, "gone.md"));

    const writer = createDefaultDiskWriter(root);
    await writer.deletePath(join(root, "gone.md"));
    expect(existsSync(join(root, "gone.md"))).toBe(false);
    expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("must survive\n");
  });
});

// PR 0N-1 agent-attributed capture: a batch settled while a dohc-tracked
// agent run is active carries agent authorship into its engine moments;
// everything else stays actor-neutral (the raw external-CLI principle is
// unchanged — an absent run means an absent author).
describe("workspaceEngineCapture agent attribution", () => {
  const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" };

  it("stamps captured writes and deletes with the active run's author", async () => {
    const root = await tempRoot();
    await write(root, "notes/plan.md", "# Plan\n");
    await write(root, "notes/scratch.md", "scratch\n");
    const engine = capture(root, { activeAgentRun: () => run });
    engine.captureBatch([
      { path: "notes/plan.md", operation: "update" },
      { path: "notes/scratch.md", operation: "update" },
    ]);
    await engine.flush();
    await unlink(join(root, "notes/scratch.md"));
    engine.captureBatch([{ path: "notes/scratch.md", operation: "delete" }]);
    await engine.stop();

    const authored = {
      kind: "agent",
      agentId: "dohc-mcp",
      onBehalfOf: "local",
      agentRunId: "run-1",
    };
    expect(readEngineMomentAuthors(root)).toEqual([authored, authored, authored]);
    expect(readEngineMoments(root).map((m) => m.operation)).toEqual([
      "write",
      "write",
      "delete",
    ]);
    // Attribution is a moment fact only: origin metadata stays actor-neutral.
    expect(readEngineMoments(root).map((m) => m.origin)).toEqual([
      "local-file",
      "local-file",
      "local-file",
    ]);
  });

  it("keeps ordinary batches actor-neutral when no run is active", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "one\n");
    const engine = capture(root, { activeAgentRun: () => null });
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.stop();
    expect(readEngineMomentAuthors(root)).toEqual([null]);
  });

  it("reads the slot at settle: a run ending before the chain drains still owns its batch, later batches are neutral", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "one\n");
    let active: typeof run | null = run;
    const engine = capture(root, { activeAgentRun: () => active });

    // Batch settles (captureBatch called) while the run is active...
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    // ...and the run ends BEFORE the capture chain executes the batch.
    active = null;
    await engine.flush();
    expect(readEngineMomentAuthors(root)).toEqual([
      { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" },
    ]);

    // A batch that settles after the run ended is the local user's.
    await write(root, "a.md", "two\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.stop();
    expect(readEngineMomentAuthors(root)).toEqual([
      { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" },
      null,
    ]);
  });

  it("keeps reconciliation actor-neutral even while a run is active", async () => {
    const root = await tempRoot();
    await write(root, "offline.md", "edited while closed\n");
    const engine = capture(root, { activeAgentRun: () => run });
    engine.start();
    await engine.stop();
    expect(readEngineMoments(root).map((m) => [m.path, m.summary])).toEqual([
      ["offline.md", "Reconciled offline edits"],
    ]);
    expect(readEngineMomentAuthors(root)).toEqual([null]);
  });
});
