import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  MAX_UI_STATE_FILE_BYTES,
  readUiStateFile,
  writeUiStateFile,
} from "./workspaceUiState";
import { createChangeSetStore, startWorkspaceWatch } from "./workspaceWatcher";

const roots: string[] = [];
const tempBase = tmpdir().startsWith("/mnt/") ? "/tmp" : tmpdir();
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tempBase, "dohc-ui-state-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const STATE = {
  version: 1,
  activeView: "explorer",
  sidebarVisible: true,
  sidebarWidth: 320,
  tabs: ["notes/a.md"],
  activeTab: "notes/a.md",
  historyVisible: true,
};

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("ui-state file store", () => {
  it("round-trips state through .dohc/ui-state.json", async () => {
    const root = await tempRoot();
    await writeUiStateFile(root, STATE);
    expect(await readUiStateFile(root)).toEqual(STATE);
    // Pretty-printed JSON with a trailing newline, like every .dohc file.
    const raw = await readFile(join(root, ".dohc", "ui-state.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("a missing or corrupt file reads as null, never an error", async () => {
    const root = await tempRoot();
    expect(await readUiStateFile(root)).toBeNull();
    await writeUiStateFile(root, STATE);
    await writeFile(join(root, ".dohc", "ui-state.json"), "{not json");
    expect(await readUiStateFile(root)).toBeNull();
  });

  it("an oversized on-disk file reads as null — stat-capped BEFORE read+parse", async () => {
    const root = await tempRoot();
    await writeUiStateFile(root, STATE);
    // Valid JSON, hostile size: a workspace can carry any bytes it likes —
    // the cap must refuse it before JSON.parse ever sees the payload.
    const huge = JSON.stringify({
      ...STATE,
      padding: "x".repeat(MAX_UI_STATE_FILE_BYTES),
    });
    await writeFile(join(root, ".dohc", "ui-state.json"), huge);
    expect(await readUiStateFile(root)).toBeNull();
  });

  // A malicious attached workspace can ship `.dohc` as a SYMLINK to a
  // user-writable directory outside the workspace. Following it would land
  // main-process metadata writes outside the boundary — both the write and
  // the read must refuse, and nothing may appear in the symlink's target.
  it("refuses to write through a symlinked .dohc and never lands files outside", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(root, ".dohc"), "dir");

    await expect(writeUiStateFile(root, STATE)).rejects.toThrow(/\.dohc/);
    expect(await readUiStateFile(root)).toBeNull();
    // The escape target stayed untouched: no ui-state.json, no temp files.
    expect(await readdir(outside)).toEqual([]);
  });
});

// THE invariant this file exists for: ui-state writes land under .dohc, which
// the watcher ignores at any depth — persisting workbench chrome state must
// NEVER produce a history record (feedback loop, timeline noise, sync upload).
describe("ui-state writes never reach history", () => {
  it("the watcher records the user file but nothing for ui-state.json", async () => {
    const root = await tempRoot();
    const workspace = {
      workspaceId: "ws-ui-state-test",
      rootPath: root,
      kind: "personal",
      mode: "local-first",
    } as CreatedWorkspace;

    let recorded = 0;
    let resolveFirst: (() => void) | null = null;
    const firstRecord = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      onRecorded: () => {
        recorded += 1;
        resolveFirst?.();
      },
    });
    await handle.ready;

    // Interleave a ui-state write with a real user write in the same window.
    await writeUiStateFile(root, STATE);
    await writeFile(join(root, "notes.md"), "# Notes\n");
    await firstRecord;

    // A ui-state-ONLY write afterwards must not settle into a record.
    await writeUiStateFile(root, { ...STATE, sidebarWidth: 400 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.stop();

    expect(recorded).toBe(1);
    const records = await createChangeSetStore(root).list();
    expect(records).toHaveLength(1);
    const paths = records[0].files.map((file) => file.path);
    expect(paths).toContain("notes.md");
    expect(paths.some((path) => path.includes(".dohc"))).toBe(false);
    expect(paths.some((path) => path.includes("ui-state"))).toBe(false);
  });
});

describe("workspace watcher history snapshots", () => {
  it("records bounded before and after text for readable file edits", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "notes.md"), "# Notes\nBefore\n");
    const workspace = {
      workspaceId: "ws-history-snapshot-test",
      rootPath: root,
      kind: "personal",
      mode: "local-first",
    } as CreatedWorkspace;

    let resolveFirst: (() => void) | null = null;
    const firstRecord = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      onRecorded: () => resolveFirst?.(),
    });
    await handle.ready;

    await writeFile(join(root, "notes.md"), "# Notes\nAfter\n");
    await firstRecord;
    await handle.stop();

    const records = await createChangeSetStore(root).list();
    expect(records).toHaveLength(1);
    expect(records[0].files[0]).toMatchObject({
      path: "notes.md",
      operation: "write",
      mediaType: "text/markdown",
      before: { text: "# Notes\nBefore\n", truncated: false },
      after: { text: "# Notes\nAfter\n", truncated: false },
    });
  });

  it("records matching local restore operations with history provenance", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "notes.md"), "after\n");
    const workspace = {
      workspaceId: "ws-history-restore-operation-test",
      rootPath: root,
      kind: "personal",
      mode: "local-first",
    } as CreatedWorkspace;

    let resolveFirst: (() => void) | null = null;
    const firstRecord = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      activeLocalOperation: () => ({
        paths: ["notes.md"],
        summary: "Restored notes.md from history",
        provenance: {
          source: "history-restore",
          restoreOfChangeSetId: "change-before",
          restoreOfPath: "notes.md",
          restoreDirection: "restore",
        },
        expectedEvents: [
          {
            path: "notes.md",
            operation: "update",
            sha256: sha256Text("before\n"),
          },
        ],
      }),
      onRecorded: () => resolveFirst?.(),
    });
    await handle.ready;

    await writeFile(join(root, "notes.md"), "before\n");
    await firstRecord;
    await handle.stop();

    const records = await createChangeSetStore(root).list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "history-restore",
      summary: "Restored notes.md from history",
      provenance: {
        source: "history-restore",
        restoreOfChangeSetId: "change-before",
        restoreOfPath: "notes.md",
        restoreDirection: "restore",
      },
    });
  });

  it("does not consume a local restore operation when the settled event mismatches", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "notes.md"), "after\n");
    const workspace = {
      workspaceId: "ws-history-restore-mismatch-test",
      rootPath: root,
      kind: "personal",
      mode: "local-first",
    } as CreatedWorkspace;

    let resolveFirst: (() => void) | null = null;
    const firstRecord = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      activeLocalOperation: () => ({
        paths: ["notes.md"],
        summary: "Restored notes.md from history",
        provenance: {
          source: "history-restore",
          restoreOfChangeSetId: "change-before",
          restoreOfPath: "notes.md",
          restoreDirection: "restore",
        },
        expectedEvents: [
          {
            path: "notes.md",
            operation: "update",
            sha256: sha256Text("before\n"),
          },
        ],
      }),
      onRecorded: () => resolveFirst?.(),
    });
    await handle.ready;

    await writeFile(join(root, "notes.md"), "manual edit\n");
    await firstRecord;
    await handle.stop();

    const records = await createChangeSetStore(root).list();
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe("user-edit");
    expect(records[0].provenance).toBeUndefined();
  });
});
