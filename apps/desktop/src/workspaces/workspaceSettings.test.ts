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
import { workspaceEngineEnabled } from "./engineCaptureGate";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  mergeWorkspaceSettings,
  parseWorkspaceSettings,
  workspaceSettingsModified,
  WorkspaceSettingsResult,
} from "./workspaceSettings";
import {
  MAX_WORKSPACE_SETTINGS_FILE_BYTES,
  readWorkspaceSettingsFile,
  saveWorkspaceSettingsFile,
  WORKSPACE_SETTINGS_FILE,
  writeWorkspaceSettingsFile,
} from "./workspaceSettingsFile";
import { startWorkspaceWatch } from "./workspaceWatcher";

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

  it("parses a pre-experimental settings shape without resetting it — and it opens ON THE ENGINE", () => {
    // Files written before the experimental group existed: the strict schema
    // must default the new group instead of silently resetting everything.
    // WS-H1 flag flip: an absent experimental key now reads as engine ON —
    // an old settings file with no experimental group opens flagged.
    const oldShape = {
      version: 1,
      agents: { mcpAutoStart: true, defaultDriverId: "claude", defaultModel: null },
      sites: { defaultPreviewMode: "static" },
      privacy: { confirmExternalLinks: false },
    };
    expect(parseWorkspaceSettings(oldShape)).toEqual({
      ...oldShape,
      experimental: { workspaceEngineAlpha: true },
      files: { attachmentLocation: "per-document", attachmentFolderName: "assets" },
    });
  });

  it("WS-H1 flag flip: the engine defaults ON everywhere absent, and explicit false still opts out", () => {
    // The single-source default: the schema group default, the canonical
    // DEFAULT_WORKSPACE_SETTINGS, and a from-nothing parse must all agree ON.
    expect(DEFAULT_WORKSPACE_SETTINGS.experimental.workspaceEngineAlpha).toBe(true);
    expect(parseWorkspaceSettings(null).experimental.workspaceEngineAlpha).toBe(true);
    expect(
      parseWorkspaceSettings({
        version: 1,
        agents: { mcpAutoStart: false, defaultDriverId: null, defaultModel: null },
        sites: { defaultPreviewMode: "auto" },
        privacy: { confirmExternalLinks: true },
      }).experimental.workspaceEngineAlpha,
    ).toBe(true);
    // The escape hatch: an explicit false is preserved, never coerced on.
    const optedOut = parseWorkspaceSettings({
      ...DEFAULT_WORKSPACE_SETTINGS,
      experimental: { workspaceEngineAlpha: false },
    });
    expect(optedOut.experimental.workspaceEngineAlpha).toBe(false);
    expect(workspaceSettingsModified(optedOut)).toBe(true);
  });

  it("defaults, merges, and round-trips the attachment-location (files) group", () => {
    // Absent files group (old settings files) defaults to per-document/assets.
    expect(DEFAULT_WORKSPACE_SETTINGS.files).toEqual({
      attachmentLocation: "per-document",
      attachmentFolderName: "assets",
    });
    const globalFolder = mergeWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS, {
      files: { attachmentLocation: "global-folder", attachmentFolderName: "attachments" },
    });
    expect(globalFolder.files).toEqual({
      attachmentLocation: "global-folder",
      attachmentFolderName: "attachments",
    });
    // Other groups are untouched, and the shape round-trips through a parse.
    expect(globalFolder.privacy).toEqual(DEFAULT_WORKSPACE_SETTINGS.privacy);
    expect(workspaceSettingsModified(globalFolder)).toBe(true);
    expect(parseWorkspaceSettings(globalFolder)).toEqual(globalFolder);
    // An empty folder name is accepted by the schema (sanitized to a safe
    // segment at use time) rather than resetting the whole file.
    const emptyName = mergeWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS, {
      files: { attachmentFolderName: "" },
    });
    expect(emptyName.files.attachmentFolderName).toBe("");
    expect(parseWorkspaceSettings(emptyName)).toEqual(emptyName);
  });

  it("merges and round-trips the workspace engine opt-out", () => {
    const optedOut = mergeWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS, {
      experimental: { workspaceEngineAlpha: false },
    });
    expect(optedOut.experimental.workspaceEngineAlpha).toBe(false);
    expect(optedOut.privacy).toEqual(DEFAULT_WORKSPACE_SETTINGS.privacy);
    expect(workspaceSettingsModified(optedOut)).toBe(true);
    expect(parseWorkspaceSettings(optedOut)).toEqual(optedOut);
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

  it("an on-disk file from before the experimental group still parses as stored", async () => {
    const root = await tempRoot();
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(
      join(root, ".dohc", WORKSPACE_SETTINGS_FILE),
      JSON.stringify({
        version: 1,
        agents: { mcpAutoStart: true, defaultDriverId: null, defaultModel: null },
        sites: { defaultPreviewMode: "auto" },
        privacy: { confirmExternalLinks: true },
      }),
    );
    const result = await readWorkspaceSettingsFile(root);
    expect(result).toEqual({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        agents: { ...DEFAULT_WORKSPACE_SETTINGS.agents, mcpAutoStart: true },
      },
      source: "stored",
    });
    // WS-H1 flag-flip regression: this pre-experimental on-disk file has no
    // experimental key, and it must OPEN FLAGGED (engine on) — the exact
    // cold-adoption read engineCaptureGate performs at workspace open.
    expect(result.settings.experimental.workspaceEngineAlpha).toBe(true);
  });

  it("an on-disk explicit opt-out (workspaceEngineAlpha: false) survives the default-on flip", async () => {
    const root = await tempRoot();
    await writeWorkspaceSettingsFile(root, {
      ...DEFAULT_WORKSPACE_SETTINGS,
      experimental: { workspaceEngineAlpha: false },
    });
    const result = await readWorkspaceSettingsFile(root);
    expect(result.source).toBe("stored");
    expect(result.settings.experimental.workspaceEngineAlpha).toBe(false);
  });

  it("corrupt, unsupported, and oversized files read as opted out and name the file", async () => {
    // AUDIT-OPTOUT: a file we cannot read may hold the opt-out. Reading it as
    // defaults (engine ON) would record for a workspace that asked for none.
    const corrupt = await tempRoot();
    await writeWorkspaceSettingsFile(corrupt, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(join(corrupt, ".dohc", WORKSPACE_SETTINGS_FILE), "{not json");
    const corruptResult = await readWorkspaceSettingsFile(corrupt);
    expect(corruptResult.source).toBe("recovered");
    expect(corruptResult.settings.experimental.workspaceEngineAlpha).toBe(false);
    expect(corruptResult.warning).toContain(
      join(corrupt, ".dohc", WORKSPACE_SETTINGS_FILE),
    );

    // The same table packages/mcp asserts against isWorkspaceEngineFlagged.
    // Both readers share one schema, so both must answer OFF for every body.
    for (const body of [
      JSON.stringify({ version: 2 }),
      JSON.stringify({ experimental: { workspaceEngineAlpha: "false" } }),
      JSON.stringify({}),
      JSON.stringify([]),
      JSON.stringify(null),
    ]) {
      const invalid = await tempRoot();
      await writeWorkspaceSettingsFile(invalid, DEFAULT_WORKSPACE_SETTINGS);
      await writeFile(join(invalid, ".dohc", WORKSPACE_SETTINGS_FILE), body);
      const invalidResult = await readWorkspaceSettingsFile(invalid);
      expect(invalidResult.source, body).toBe("recovered");
      expect(
        invalidResult.settings.experimental.workspaceEngineAlpha,
        body,
      ).toBe(false);
      expect(invalidResult.warning, body).toContain("could not be read");
    }

    const huge = await tempRoot();
    await writeWorkspaceSettingsFile(huge, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(
      join(huge, ".dohc", WORKSPACE_SETTINGS_FILE),
      JSON.stringify({ padding: "x".repeat(MAX_WORKSPACE_SETTINGS_FILE_BYTES) }),
    );
    const hugeResult = await readWorkspaceSettingsFile(huge);
    expect(hugeResult.source).toBe("recovered");
    expect(hugeResult.settings.experimental.workspaceEngineAlpha).toBe(false);
    expect(hugeResult.warning).toContain("too large");

    // The warning crosses the IPC boundary; a path must not overflow its bound.
    expect(WorkspaceSettingsResult.parse(hugeResult)).toEqual(hugeResult);
  });

  it("an unreadable settings file stops the engine capture gate", async () => {
    // The gate is the reader that decides whether anything is recorded, so the
    // fail-closed read is asserted THROUGH it, not only at the file layer.
    const root = await tempRoot();
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    expect(await workspaceEngineEnabled(root)).toBe(true);

    await writeFile(join(root, ".dohc", WORKSPACE_SETTINGS_FILE), "{not json");
    expect(await workspaceEngineEnabled(root)).toBe(false);
  });

  it("refuses to save over an unreadable file, and reset still replaces it", async () => {
    // #483: a save writes the whole RESOLVED object, and over an unreadable
    // file that object carries the fail-closed opt-out. Writing it would
    // record a deliberate opt-out the user never chose, and the warning would
    // disappear with it. The file must survive the save byte for byte.
    const root = await tempRoot();
    const path = join(root, ".dohc", WORKSPACE_SETTINGS_FILE);
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(path, "{not json");

    const refused = await saveWorkspaceSettingsFile(root, {
      ...DEFAULT_WORKSPACE_SETTINGS,
      files: { ...DEFAULT_WORKSPACE_SETTINGS.files, attachmentLocation: "same-folder" },
    });
    expect(refused.refusal).toBe(
      `dohc did not save workspace settings. dohc cannot read ${path}. Fix that file, or select Reset workspace in Advanced to replace it.`,
    );
    expect(await readFile(path, "utf8")).toBe("{not json");
    // The refusal hands back the file's real state, warning included, so the
    // dialog snaps its controls back instead of showing an unsaved edit.
    expect(refused.source).toBe("recovered");
    expect(refused.warning).toContain(path);
    expect(refused.settings.experimental.workspaceEngineAlpha).toBe(false);
    // The refusal crosses the IPC boundary; a path must not overflow its bound.
    expect(WorkspaceSettingsResult.parse(refused)).toEqual(refused);

    // Reset is the named way out, and it must actually work here.
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    expect((await readWorkspaceSettingsFile(root)).source).toBe("stored");
  });

  it("saves normally over a readable file", async () => {
    const root = await tempRoot();
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    const settings = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      privacy: { confirmExternalLinks: false },
    };
    const saved = await saveWorkspaceSettingsFile(root, settings);
    expect(saved).toEqual({ settings, source: "stored" });
    expect(await readWorkspaceSettingsFile(root)).toEqual({
      settings,
      source: "stored",
    });
  });

  it("saves over a MISSING file — a new workspace is not born refused", async () => {
    const root = await tempRoot();
    const settings = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      privacy: { confirmExternalLinks: false },
    };
    expect(await saveWorkspaceSettingsFile(root, settings)).toEqual({
      settings,
      source: "stored",
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

    const result = await readWorkspaceSettingsFile(root);
    expect(result.source).toBe("recovered");
    expect(result.settings.agents.mcpAutoStart).toBe(false);
    expect(result.settings.experimental.workspaceEngineAlpha).toBe(false);
    expect(result.warning).toContain("not a file dohc can read");
  });
});

describe("workspace settings writes never reach history", () => {
  it("the watcher enqueues the user file into the engine capture but nothing for settings.local.json", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "ws-settings-test",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };

    // Retirement Phase C: the engine capture is the only recorder — assert
    // against what the watcher enqueues into it, not a legacy store.
    const capturedPaths: string[] = [];
    let resolveFirst: (() => void) | null = null;
    const firstRecord = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      engineCapture: () => ({
        captureBatch: (events) => {
          capturedPaths.push(...events.map((event) => event.path));
        },
      }),
      onRecorded: () => {
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

    expect(capturedPaths).toContain("notes.md");
    expect(capturedPaths.some((path) => path.includes(".dohc"))).toBe(false);
    expect(capturedPaths.some((path) => path.includes("settings.local"))).toBe(false);
  });
});
