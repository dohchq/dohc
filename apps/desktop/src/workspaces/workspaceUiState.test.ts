import { readdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  MAX_UI_STATE_FILE_BYTES,
  readUiStateFile,
  writeUiStateFile,
} from "./workspaceUiState";
import type { WorkspaceUiState } from "../ipc/bridgeContract";

import { createTestScratch } from "./testTemp";
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  return { ...actual, rename: vi.fn(actual.rename) };
});

const tempBase = tmpdir().startsWith("/mnt/") ? "/tmp" : tmpdir();
afterEach(async () => {
  vi.restoreAllMocks();
});

const STATE: WorkspaceUiState = {
  version: 3,
  activeView: "explorer",
  sidebarVisible: true,
  sidebarWidth: 240,
  editorGroups: [{
    id: "primary",
    tabs: ["notes/a.md", "tab://graph"],
    activeTab: "tab://graph",
    size: 1,
  }],
  activeEditorGroup: "primary",
  chatsVisible: false,
  chatsWidth: 320,
  openEditorsHeight: 126,
  expandedFolders: [],
  pinned: [],
  recentFiles: ["notes/a.md"],
  collectionViews: {},
};


describe("ui-state file store", () => {
  it("round-trips state through .dohc/ui-state.json", async () => {
    const root = await createTestScratch("dohc-ui-state-");
    await writeUiStateFile(root, STATE);
    expect(await readUiStateFile(root)).toEqual(STATE);
    // Pretty-printed JSON with a trailing newline, like every .dohc file.
    const raw = await readFile(join(root, ".dohc", "ui-state.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("serializes a burst of writes and leaves the latest complete state", async () => {
    const root = await createTestScratch("dohc-ui-state-");
    await Promise.all(
      Array.from({ length: 40 }, (_, sequence) =>
        writeUiStateFile(root, { ...STATE, sidebarWidth: 300 + sequence }),
      ),
    );

    expect(await readUiStateFile(root)).toEqual({
      ...STATE,
      sidebarWidth: 339,
    });
    expect(
      (await readdir(join(root, ".dohc"))).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  it("retries a transient Windows rename failure and completes the write", async () => {
    const root = await createTestScratch("dohc-ui-state-");
    const transient = Object.assign(new Error("file is temporarily busy"), {
      code: "EBUSY",
    });
    const renameMock = vi.mocked(rename);
    renameMock.mockClear();
    renameMock.mockRejectedValueOnce(transient);

    await expect(writeUiStateFile(root, STATE)).resolves.toBeUndefined();

    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(await readUiStateFile(root)).toEqual(STATE);
  });

  it("a missing or corrupt file reads as null, never an error", async () => {
    const root = await createTestScratch("dohc-ui-state-");
    expect(await readUiStateFile(root)).toBeNull();
    await writeUiStateFile(root, STATE);
    await writeFile(join(root, ".dohc", "ui-state.json"), "{not json");
    expect(await readUiStateFile(root)).toBeNull();
  });

  it("an oversized on-disk file reads as null — stat-capped before read+parse", async () => {
    const root = await createTestScratch("dohc-ui-state-");
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
    const root = await createTestScratch("dohc-ui-state-");
    const outside = await createTestScratch("dohc-ui-state-");
    await symlink(outside, join(root, ".dohc"), "dir");

    await expect(writeUiStateFile(root, STATE)).rejects.toThrow(
      "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry.",
    );
    expect(await readUiStateFile(root)).toBeNull();
    // The escape target stayed untouched: no ui-state.json, no temp files.
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses to read a symlinked ui-state file", async () => {
    const root = await createTestScratch("dohc-ui-state-");
    const outside = await createTestScratch("dohc-ui-state-");
    await writeUiStateFile(root, STATE);
    const outsideState = join(outside, "ui-state.json");
    await writeFile(outsideState, JSON.stringify({ ...STATE, sidebarWidth: 999 }));
    await unlink(join(root, ".dohc", "ui-state.json"));
    await symlink(outsideState, join(root, ".dohc", "ui-state.json"));

    expect(await readUiStateFile(root)).toBeNull();
  });
});
