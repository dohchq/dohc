import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import { afterEach, describe, expect, it } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  parseWorkspaceSettings,
  workspaceSettingsModified,
} from "./workspaceSettings";
import {
  MAX_WORKSPACE_SETTINGS_FILE_BYTES,
  readWorkspaceSettingsFile,
  WORKSPACE_SETTINGS_FILE,
  writeWorkspaceSettingsFile,
} from "./workspaceSettingsFile";
import { createChangeSetStore, startWorkspaceWatch } from "./workspaceWatcher";

const roots: string[] = [];
const tempBase = tmpdir().startsWith("/mnt/") ? "/tmp" : tmpdir();

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tempBase, "dohc-workspace-settings-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace settings model", () => {
  it("falls back to defaults for missing, foreign, or future shapes", () => {
    expect(parseWorkspaceSettings(null)).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(parseWorkspaceSettings({ version: 2 })).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(parseWorkspaceSettings({ version: 1, token: "secret" })).toEqual(
      DEFAULT_WORKSPACE_SETTINGS,
    );
    expect(workspaceSettingsModified(DEFAULT_WORKSPACE_SETTINGS)).toBe(false);
    expect(
      workspaceSettingsModified({
        ...DEFAULT_WORKSPACE_SETTINGS,
        privacy: { confirmExternalLinks: false },
      }),
    ).toBe(true);
  });
});

describe("workspace settings file store", () => {
  it("round-trips settings through .dohc/settings.local.json", async () => {
    const root = await tempRoot();
    const settings = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      agents: { ...DEFAULT_WORKSPACE_SETTINGS.agents, mcpAutoStart: true },
    };
    await writeWorkspaceSettingsFile(root, settings);
    expect(await readWorkspaceSettingsFile(root)).toEqual({
      settings,
      source: "stored",
    });
    const raw = await readFile(join(root, ".dohc", WORKSPACE_SETTINGS_FILE), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("a missing file reads as defaults", async () => {
    expect(await readWorkspaceSettingsFile(await tempRoot())).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default",
    });
  });

  it("corrupt, unsupported, and oversized files recover to defaults", async () => {
    const corrupt = await tempRoot();
    await writeWorkspaceSettingsFile(corrupt, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(join(corrupt, ".dohc", WORKSPACE_SETTINGS_FILE), "{not json");
    expect(await readWorkspaceSettingsFile(corrupt)).toMatchObject({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "recovered",
    });

    const future = await tempRoot();
    await writeWorkspaceSettingsFile(future, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(join(future, ".dohc", WORKSPACE_SETTINGS_FILE), JSON.stringify({ version: 2 }));
    expect(await readWorkspaceSettingsFile(future)).toMatchObject({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "recovered",
    });

    const huge = await tempRoot();
    await writeWorkspaceSettingsFile(huge, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(
      join(huge, ".dohc", WORKSPACE_SETTINGS_FILE),
      JSON.stringify({ padding: "x".repeat(MAX_WORKSPACE_SETTINGS_FILE_BYTES) }),
    );
    expect(await readWorkspaceSettingsFile(huge)).toMatchObject({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "recovered",
    });
  });

  it("refuses to write through a symlinked .dohc and never lands files outside", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(root, ".dohc"), "dir");

    await expect(
      writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS),
    ).rejects.toThrow(/\.dohc/);
    await expect(readWorkspaceSettingsFile(root)).rejects.toThrow(/\.dohc/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses to read a symlinked settings file", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    const outsideSettings = join(outside, "settings.local.json");
    await writeFile(
      outsideSettings,
      JSON.stringify({
        ...DEFAULT_WORKSPACE_SETTINGS,
        agents: { ...DEFAULT_WORKSPACE_SETTINGS.agents, mcpAutoStart: true },
      }),
    );
    await unlink(join(root, ".dohc", WORKSPACE_SETTINGS_FILE));
    await symlink(outsideSettings, join(root, ".dohc", WORKSPACE_SETTINGS_FILE));

    expect(await readWorkspaceSettingsFile(root)).toMatchObject({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "recovered",
    });
  });
});

describe("workspace settings writes never reach history", () => {
  it("the watcher records the user file but nothing for settings.local.json", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "ws-settings-test",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };

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

    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(join(root, "notes.md"), "# Notes\n");
    await firstRecord;

    await writeWorkspaceSettingsFile(root, {
      ...DEFAULT_WORKSPACE_SETTINGS,
      privacy: { confirmExternalLinks: false },
    });
    await handle.stop();

    expect(recorded).toBe(1);
    const records = await createChangeSetStore(root).list();
    expect(records).toHaveLength(1);
    expect(records[0].files.map((file) => file.path)).toEqual(["notes.md"]);
  });
});
