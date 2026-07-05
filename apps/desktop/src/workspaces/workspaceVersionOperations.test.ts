import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVersionedTextStore, type VersionedTextStore } from "@dohc/workspace-engine";
import { nativeTmpdir } from "./testTemp";
import {
  createWorkspaceEngineCapture,
  type EngineDiskWriter,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";

// PR 0M-4 named-version operations: active-version capture routing, the
// switch flow (disk swap, loss-free capture, expected-event suppression,
// mid-switch failure recovery), merge into Main (clean + conflict + each
// resolution kind), and compare.

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
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-version-ops-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface EngineMomentRow {
  versionId: string;
  path: string;
  operation: string;
  text: string;
  summary: string | null;
}

function readEngineMoments(rootPath: string): EngineMomentRow[] {
  const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        `SELECT m.version_id AS versionId, m.path AS path, m.operation AS operation,
                b.text AS text, m.metadata_summary AS summary
         FROM moments m JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
         ORDER BY m.moment_order`,
      )
      .all() as unknown as EngineMomentRow[];
  } finally {
    db.close();
  }
}

async function write(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function writeBytes(root: string, path: string, contents: Uint8Array) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function readText(root: string, path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function capture(root: string, options: {
  onError?: (context: string, error: unknown) => void;
  diskWriter?: EngineDiskWriter;
  store?: VersionedTextStore;
} = {}): WorkspaceEngineCapture {
  return createWorkspaceEngineCapture({
    workspaceId: "version-ops-test",
    rootPath: root,
    ...options,
  });
}

async function versionIdByName(
  engine: WorkspaceEngineCapture,
  name: string,
): Promise<string> {
  const { versions } = await engine.listVersions();
  const version = versions.find((entry) => entry.name === name);
  if (!version) throw new Error(`No version named ${name}`);
  return version.id;
}

describe("active-version capture routing", () => {
  it("captures batches into the active named version, not Main", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();

    const snapshot = await engine.createVersion("Draft");
    expect(snapshot.activeVersionId).not.toBe("main");

    await write(root, "plan.md", "draft text\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.stop();

    const draftWrites = readEngineMoments(root).filter(
      (moment) => moment.path === "plan.md" && moment.text === "draft text\n",
    );
    expect(draftWrites).toHaveLength(1);
    expect(draftWrites[0].versionId).toBe(snapshot.activeVersionId);
  });

  it("reads the active version per task, not cached across a switch", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const engine = capture(root);
    engine.start();
    const created = await engine.createVersion("Draft");

    // Enqueue an edit batch and the switch back to Main without awaiting in
    // between: the batch runs first ON THE CHAIN and must land in Draft.
    await write(root, "plan.md", "draft text\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    const switched = await engine.switchVersion("main");
    await engine.stop();

    expect(switched.activeVersionId).toBe("main");
    const draftMoments = readEngineMoments(root).filter(
      (moment) => moment.text === "draft text\n" && moment.operation === "write",
    );
    expect(draftMoments.map((moment) => moment.versionId)).toEqual([
      created.activeVersionId,
    ]);
  });
});

describe("createVersion", () => {
  it("forks from the latest disk state and becomes active", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();

    // An edit the watcher has not settled yet must be part of the fork.
    await write(root, "plan.md", "v1 text with late edit\n");
    const snapshot = await engine.createVersion("Draft");
    await engine.stop();

    expect(snapshot.versions.map((version) => version.name).sort()).toEqual([
      "Draft",
      "Main",
    ]);
    const draft = snapshot.versions.find((version) => version.name === "Draft");
    expect(draft?.kind).toBe("named");
    expect(snapshot.activeVersionId).toBe(draft?.id);
    // The late edit was captured into Main (the fork source) first.
    const mainMoments = readEngineMoments(root).filter(
      (moment) => moment.versionId === "main" && moment.path === "plan.md",
    );
    expect(mainMoments.at(-1)?.text).toBe("v1 text with late edit\n");
    // Disk is untouched by create+switch.
    expect(await readText(root, "plan.md")).toBe("v1 text with late edit\n");
  });

  it("rejects duplicate names without changing the active version", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    await engine.createVersion("Draft");
    await expect(engine.createVersion("Draft")).rejects.toMatchObject({
      code: "version-name-conflict",
    });
    const { activeVersionId, versions } = await engine.listVersions();
    expect(versions).toHaveLength(2);
    expect(activeVersionId).toBe(await versionIdByName(engine, "Draft"));
    await engine.stop();
  });
});

describe("switchVersion", () => {
  it("swaps disk content between versions and loses nothing from either side", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const logoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await writeBytes(root, "logo.png", logoBytes);
    const engine = capture(root);
    engine.start();
    await engine.flush();

    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft text\n");
    await write(root, "draft-only.md", "only in draft\n");
    // The switch itself captures unsettled disk edits — no captureBatch here.
    const toMain = await engine.switchVersion("main");
    expect(toMain.activeVersionId).toBe("main");
    expect(await readText(root, "plan.md")).toBe("v1 text\n");
    expect(existsSync(join(root, "draft-only.md"))).toBe(false);
    // Binary files are untouched by switching — byte-for-byte, not merely
    // still present (a truncating/rewriting switch must fail this).
    expect(existsSync(join(root, "logo.png"))).toBe(true);
    expect(new Uint8Array(await readFile(join(root, "logo.png")))).toEqual(logoBytes);

    const draftId = await versionIdByName(engine, "Draft");
    const backToDraft = await engine.switchVersion(draftId);
    expect(backToDraft.activeVersionId).toBe(draftId);
    expect(await readText(root, "plan.md")).toBe("draft text\n");
    expect(await readText(root, "draft-only.md")).toBe("only in draft\n");
    await engine.stop();
  });

  it("suppresses engine re-capture of its own switch writes via expected events", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    // Boundary signal for suppression: after the switch, processing the
    // simulated watcher event must never touch the engine store for the
    // path at all. "No new moments" alone would pass vacuously (the disk
    // content equals the engine tip, so an unsuppressed capture records
    // nothing either) — the read counter is what fails when suppression
    // breaks.
    const store = createVersionedTextStore(root);
    let planReads = 0;
    const countingStore: VersionedTextStore = {
      ...store,
      async readTextFile(input) {
        if (input.path === "plan.md") planReads += 1;
        return store.readTextFile(input);
      },
    };
    const engine = capture(root, { store: countingStore });
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft text\n");
    await engine.switchVersion("main");

    const momentsBefore = readEngineMoments(root).length;
    planReads = 0;
    // Simulate the watcher observing the switch's disk writes: the expected
    // event registrations must swallow them — zero new engine moments AND
    // zero engine reads for the suppressed path.
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.stop();
    expect(planReads).toBe(0);
    expect(readEngineMoments(root)).toHaveLength(momentsBefore);
    expect(
      sha256Utf8(await readText(root, "plan.md")),
    ).toBe(sha256Utf8("v1 text\n"));
  });

  it("is a no-op when switching to the already-active version", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    const before = readEngineMoments(root).length;
    const result = await engine.switchVersion("main");
    expect(result).toEqual({ activeVersionId: "main", changedFileCount: 0 });
    expect(readEngineMoments(root)).toHaveLength(before);
    await engine.stop();
  });

  it("fails closed on an unknown version id without touching disk or active version", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await expect(engine.switchVersion("no-such-version")).rejects.toMatchObject({
      code: "version-not-found",
    });
    expect(await readText(root, "plan.md")).toBe("v1 text\n");
    expect((await engine.listVersions()).activeVersionId).toBe("main");
    await engine.stop();
  });

  it("recovers honestly from a mid-switch disk failure", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "main a\n");
    await write(root, "b.md", "main b\n");
    const failures: string[] = [];
    let failOn: string | null = null;
    const diskWriter: EngineDiskWriter = {
      async writeTextFile(absolutePath, text) {
        if (failOn && absolutePath.endsWith(failOn)) {
          throw new Error("injected disk failure");
        }
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, text, "utf8");
      },
      async deletePath(absolutePath) {
        await rm(absolutePath, { force: true });
      },
    };
    const engine = capture(root, {
      diskWriter,
      onError: (context) => {
        failures.push(context);
      },
    });
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "a.md", "draft a\n");
    await write(root, "b.md", "draft b\n");
    engine.captureBatch([
      { path: "a.md", operation: "update" },
      { path: "b.md", operation: "update" },
    ]);
    await engine.flush();

    // Fail the second file's write while switching back to Main.
    failOn = "b.md";
    await expect(engine.switchVersion("main")).rejects.toThrow(
      /Could not update b\.md/,
    );
    await engine.flush();

    // The crash-honest invariant: Main is recorded active, and Main's engine
    // tip mirrors the ACTUAL (partial) disk state — a.md switched, b.md not.
    const { activeVersionId } = await engine.listVersions();
    expect(activeVersionId).toBe("main");
    expect(await readText(root, "a.md")).toBe("main a\n");
    expect(await readText(root, "b.md")).toBe("draft b\n");
    const mainTipForB = readEngineMoments(root)
      .filter((moment) => moment.versionId === "main" && moment.path === "b.md")
      .at(-1);
    expect(mainTipForB?.text).toBe("draft b\n");

    // Nothing was lost: Draft still holds both edits, and switching remains
    // functional once the disk recovers.
    failOn = null;
    const draftId = await versionIdByName(engine, "Draft");
    await engine.switchVersion(draftId);
    expect(await readText(root, "a.md")).toBe("draft a\n");
    expect(await readText(root, "b.md")).toBe("draft b\n");
    // The interrupted switch honestly recorded the partial disk state as
    // Main's new tip (b.md = "draft b"), so switching back shows that tip —
    // while the pre-failure content stays recoverable in Main's history.
    await engine.switchVersion("main");
    expect(await readText(root, "a.md")).toBe("main a\n");
    expect(await readText(root, "b.md")).toBe("draft b\n");
    expect(
      readEngineMoments(root).some(
        (moment) =>
          moment.versionId === "main" &&
          moment.path === "b.md" &&
          moment.text === "main b\n",
      ),
    ).toBe(true);
    await engine.stop();
  });
});

describe("compareVersions", () => {
  it("includes unsettled on-disk edits and reports statuses", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    await write(root, "keep.md", "same\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    // Unsettled disk edits — compare must still see them.
    await write(root, "plan.md", "draft text\n");
    await write(root, "added.md", "new in draft\n");

    const draftId = await versionIdByName(engine, "Draft");
    const changes = await engine.compareVersions(draftId);
    expect(changes).toEqual([
      { path: "added.md", status: "added", incomingText: "new in draft\n" },
      {
        path: "plan.md",
        status: "modified",
        currentText: "v1 text\n",
        incomingText: "draft text\n",
      },
    ]);

    await engine.switchVersion("main");
    const noChanges = await engine.compareVersions("main");
    expect(noChanges).toEqual([]);
    await engine.stop();
  });
});

describe("mergeVersionIntoMain", () => {
  it("merges a clean version into Main and materializes when Main is active", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft text\n");
    await engine.switchVersion("main");
    expect(await readText(root, "plan.md")).toBe("v1 text\n");

    const draftId = await versionIdByName(engine, "Draft");
    const result = await engine.mergeVersionIntoMain(draftId);
    expect(result.conflicts).toEqual([]);
    expect(result.mergedFileCount).toBe(1);
    // Main is active: the merged content lands on disk.
    expect(await readText(root, "plan.md")).toBe("draft text\n");

    // The merge's own disk write must not re-capture.
    const momentsBefore = readEngineMoments(root).length;
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.stop();
    expect(readEngineMoments(root)).toHaveLength(momentsBefore);
  });

  it("does not touch the disk when a named version is active", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft text\n");
    // Second version to stay on while merging Draft.
    await engine.switchVersion("main");
    await engine.createVersion("Other");
    await write(root, "plan.md", "other text\n");

    const draftId = await versionIdByName(engine, "Draft");
    const result = await engine.mergeVersionIntoMain(draftId);
    expect(result.mergedFileCount).toBe(1);
    // Disk still shows the ACTIVE version (Other), not Main's merged state.
    expect(await readText(root, "plan.md")).toBe("other text\n");
    // ...but Main's engine state has the merge.
    const mainTip = readEngineMoments(root)
      .filter((moment) => moment.versionId === "main" && moment.path === "plan.md")
      .at(-1);
    expect(mainTip?.text).toBe("draft text\n");
    // Data durability: the merge captured Other's UNSETTLED edit into
    // Other's own tip first — a later switch away can't lose "other text".
    const otherId = await versionIdByName(engine, "Other");
    const otherTip = readEngineMoments(root)
      .filter((moment) => moment.versionId === otherId && moment.path === "plan.md")
      .at(-1);
    expect(otherTip?.text).toBe("other text\n");
    // Switching away and back materializes exactly that captured edit.
    await engine.switchVersion("main");
    expect(await readText(root, "plan.md")).toBe("draft text\n");
    await engine.switchVersion(otherId);
    expect(await readText(root, "plan.md")).toBe("other text\n");
    await engine.stop();
  });

  it("records a conflict preserving both sides when both versions changed", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "base line\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft line\n");
    await engine.switchVersion("main");
    await write(root, "plan.md", "main line\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    const result = await engine.mergeVersionIntoMain(draftId);
    expect(result.mergedFileCount).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.path).toBe("plan.md");
    expect(conflict.base.text).toBe("base line\n");
    expect(conflict.current.text).toBe("main line\n");
    expect(conflict.incoming.text).toBe("draft line\n");
    // Main's disk state is untouched while the conflict is open.
    expect(await readText(root, "plan.md")).toBe("main line\n");
    expect(await engine.listOpenConflicts()).toHaveLength(1);
    await engine.stop();
  });

  it("resolves conflicts by keep-current, apply-incoming, and apply-merged", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "base a\n");
    await write(root, "b.md", "base b\n");
    await write(root, "c.md", "base c\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    for (const path of ["a.md", "b.md", "c.md"]) {
      await write(root, path, `draft ${path}\n`);
    }
    await engine.switchVersion("main");
    for (const path of ["a.md", "b.md", "c.md"]) {
      await write(root, path, `main ${path}\n`);
    }
    engine.captureBatch([
      { path: "a.md", operation: "update" },
      { path: "b.md", operation: "update" },
      { path: "c.md", operation: "update" },
    ]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    const merge = await engine.mergeVersionIntoMain(draftId);
    expect(merge.conflicts).toHaveLength(3);
    const byPath = new Map(merge.conflicts.map((conflict) => [conflict.path, conflict]));

    const kept = await engine.resolveConflict(byPath.get("a.md")!.id, {
      kind: "keep-current",
    });
    expect(kept.conflict.resolution).toBe("kept-current");
    expect(kept.remaining).toHaveLength(2);
    expect(await readText(root, "a.md")).toBe("main a.md\n");

    const incoming = await engine.resolveConflict(byPath.get("b.md")!.id, {
      kind: "apply-incoming",
    });
    expect(incoming.conflict.resolution).toBe("applied-incoming");
    // Main is active: applying the incoming side updates the disk.
    expect(await readText(root, "b.md")).toBe("draft b.md\n");

    const merged = await engine.resolveConflict(byPath.get("c.md")!.id, {
      kind: "apply-merged",
      text: "combined c\n",
    });
    expect(merged.conflict.resolution).toBe("applied-merged");
    expect(merged.remaining).toHaveLength(0);
    expect(await readText(root, "c.md")).toBe("combined c\n");
    expect(await engine.listOpenConflicts()).toHaveLength(0);

    // Resolution disk writes never re-capture.
    const momentsBefore = readEngineMoments(root).length;
    engine.captureBatch([
      { path: "b.md", operation: "update" },
      { path: "c.md", operation: "update" },
    ]);
    await engine.stop();
    expect(readEngineMoments(root)).toHaveLength(momentsBefore);
  });

  it("re-running a merge resumes open conflicts instead of duplicating them", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "base\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft\n");
    await engine.switchVersion("main");
    await write(root, "plan.md", "main\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    const first = await engine.mergeVersionIntoMain(draftId);
    expect(first.conflicts).toHaveLength(1);

    // User closed the conflict panel; merging again surfaces the SAME open
    // conflict — duplicates never pile up.
    const second = await engine.mergeVersionIntoMain(draftId);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0].id).toBe(first.conflicts[0].id);
    expect(await engine.listOpenConflicts()).toHaveLength(1);
    await engine.stop();
  });

  it("rejects merging Main into Main", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await expect(engine.mergeVersionIntoMain("main")).rejects.toThrow(
      /Only a named version/,
    );
    await engine.stop();
  });
});

describe("switch performance evidence (PR 0M-4)", () => {
  it("measures switch latency for a 200-file workspace with 20 differing files", async () => {
    const root = await tempRoot();
    for (let index = 0; index < 200; index += 1) {
      await write(
        root,
        `corpus/dir-${index % 10}/file-${String(index).padStart(3, "0")}.md`,
        `# Doc ${index}\n\nbody ${index}\n`,
      );
    }
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    for (let index = 0; index < 20; index += 1) {
      const file = index * 10;
      await write(
        root,
        `corpus/dir-${file % 10}/file-${String(file).padStart(3, "0")}.md`,
        `# Doc ${file}\n\nedited in draft\n`,
      );
    }
    // Settle the draft edits so the measured switch is the steady-state cost.
    engine.captureBatch(
      Array.from({ length: 20 }, (_, index) => ({
        path: `corpus/dir-${(index * 10) % 10}/file-${String(index * 10).padStart(3, "0")}.md`,
        operation: "update" as const,
      })),
    );
    await engine.flush();

    const startedAt = performance.now();
    const result = await engine.switchVersion("main");
    const elapsedMs = performance.now() - startedAt;
    expect(result.changedFileCount).toBe(20);
    await engine.stop();

    console.log(
      `[perf] version switch, 200 files / 20 differing: ${elapsedMs.toFixed(1)}ms ` +
        `on ${cpus()[0]?.model ?? "unknown CPU"}, node ${process.version}, ${process.platform}`,
    );
  }, 120_000);
});
