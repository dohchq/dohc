import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { readUiStateFile, writeUiStateFile } from "./workspaceUiState";
import { createChangeSetStore, startWorkspaceWatch } from "./workspaceWatcher";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-ui-state-"));
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
