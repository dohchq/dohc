import { mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import { describe, expect, it, vi } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
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
  resetWorkspaceSettingsFile,
  saveWorkspaceSettingsFile,
  WORKSPACE_SETTINGS_FILE,
  writeWorkspaceSettingsFile,
} from "./workspaceSettingsFile";
import { startWorkspaceWatch } from "./workspaceWatcher";

import { createTestScratch } from "./testTemp";
// A seam for the write-ordering test below: every settings read and write
// resolves the metadata directory first, so a gate here can hold one of them
// open while another write is fired. Pass-through until a test arms it.
const metadataGate = vi.hoisted(() => ({ pending: null as Promise<void> | null }));
vi.mock("./workspaceMetadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspaceMetadata")>();
  return {
    ...actual,
    resolveWorkspaceMetadataDir: async (rootPath: string) => {
      const gate = metadataGate.pending;
      if (gate) {
        metadataGate.pending = null;
        await gate;
      }
      return actual.resolveWorkspaceMetadataDir(rootPath);
    },
  };
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

  it("parses a settings shape without the files group without resetting it", () => {
    // Files written before the files group existed: the strict schema must
    // default the new group instead of silently resetting everything.
    const oldShape = {
      version: 1,
      agents: { mcpAutoStart: true },
      sites: { defaultPreviewMode: "static" },
      privacy: { confirmExternalLinks: false },
    };
    expect(parseWorkspaceSettings(oldShape)).toEqual({
      ...oldShape,
      files: { attachmentLocation: "per-document", attachmentFolderName: "assets" },
    });
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

});

describe("workspace settings file store", () => {
  it("round-trips settings through .dohc/settings.local.json", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
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
    expect(await readWorkspaceSettingsFile(await createTestScratch("dohc-workspace-settings-"))).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default",
    });
  });

  it("an on-disk file from before the files group still parses as stored", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(
      join(root, ".dohc", WORKSPACE_SETTINGS_FILE),
      JSON.stringify({
        version: 1,
        agents: { mcpAutoStart: true },
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
  });

  it("corrupt, unsupported, and oversized files read as recovered and name the file", async () => {
    const corrupt = await createTestScratch("dohc-workspace-settings-");
    await writeWorkspaceSettingsFile(corrupt, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(join(corrupt, ".dohc", WORKSPACE_SETTINGS_FILE), "{not json");
    const corruptResult = await readWorkspaceSettingsFile(corrupt);
    expect(corruptResult.source).toBe("recovered");
    expect(corruptResult.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(corruptResult.warning).toContain(
      join(corrupt, ".dohc", WORKSPACE_SETTINGS_FILE),
    );
    expect(corruptResult.warning).toContain("Reset workspace");

    for (const body of [
      JSON.stringify({ version: 2 }),
      JSON.stringify([]),
      JSON.stringify(null),
    ]) {
      const invalid = await createTestScratch("dohc-workspace-settings-");
      await writeWorkspaceSettingsFile(invalid, DEFAULT_WORKSPACE_SETTINGS);
      await writeFile(join(invalid, ".dohc", WORKSPACE_SETTINGS_FILE), body);
      const invalidResult = await readWorkspaceSettingsFile(invalid);
      expect(invalidResult.source, body).toBe("recovered");
      expect(invalidResult.settings, body).toEqual(DEFAULT_WORKSPACE_SETTINGS);
      expect(invalidResult.warning, body).toContain("could not be read");
    }

    const huge = await createTestScratch("dohc-workspace-settings-");
    await writeWorkspaceSettingsFile(huge, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(
      join(huge, ".dohc", WORKSPACE_SETTINGS_FILE),
      JSON.stringify({ padding: "x".repeat(MAX_WORKSPACE_SETTINGS_FILE_BYTES) }),
    );
    const hugeResult = await readWorkspaceSettingsFile(huge);
    expect(hugeResult.source).toBe("recovered");
    expect(hugeResult.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(hugeResult.warning).toContain("too large");

    // The warning crosses the IPC boundary; a path must not overflow its bound.
    expect(WorkspaceSettingsResult.parse(hugeResult)).toEqual(hugeResult);
  });

  it("turns off only an unknown key or a value dohc cannot use, and a save keeps them", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    const path = join(root, ".dohc", WORKSPACE_SETTINGS_FILE);
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(path, JSON.stringify({
      sites: { defaultPreviewMode: "static" },
      privacy: { confirmExternalLinks: "false" },
      theme: "dark",
    }));
    const read = await readWorkspaceSettingsFile(root);
    expect(read).toEqual({
      settings: { ...DEFAULT_WORKSPACE_SETTINGS, sites: { defaultPreviewMode: "static" } },
      source: "stored",
      ignored: [
        { key: "privacy.confirmExternalLinks", reason: "invalid" },
        { key: "theme", reason: "unknown" },
      ],
    });
    expect(WorkspaceSettingsResult.parse(read)).toEqual(read);

    const saved = await saveWorkspaceSettingsFile(root, { files: { attachmentFolderName: "media" } });
    expect(saved).toEqual({
      ...read,
      settings: { ...read.settings, files: { ...read.settings.files, attachmentFolderName: "media" } },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      sites: { defaultPreviewMode: "static" },
      privacy: { confirmExternalLinks: "false" },
      theme: "dark",
      files: { attachmentFolderName: "media" },
    });
  });

  it("an untrustworthy .dohc FOLDER reads as recovered and names the folder", async () => {
    // The metadata resolver refuses a non-directory .dohc by throwing, and
    // its contract says readers stay tolerant.
    const root = await createTestScratch("dohc-workspace-settings-");
    await writeFile(join(root, ".dohc"), "a file squatting the metadata dir");
    const result = await readWorkspaceSettingsFile(root);
    expect(result.source).toBe("recovered");
    expect(result.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(result.warning).toContain(join(root, ".dohc"));
    expect(result.warning).toContain(".dohc folder");
  });

  it("refuses to save over an unreadable file, and reset still replaces it", async () => {
    // Over an unreadable file the caller's resolved settings are the
    // defaults, so saving any control would write them over the file and
    // the warning would disappear with it. The file must survive the save
    // byte for byte.
    const root = await createTestScratch("dohc-workspace-settings-");
    const path = join(root, ".dohc", WORKSPACE_SETTINGS_FILE);
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(path, "{not json");

    const refused = await saveWorkspaceSettingsFile(root, {
      files: { attachmentLocation: "same-folder" },
    });
    expect(refused.refusal).toBe(
      `dohc did not save workspace settings. dohc cannot read ${path}. Fix that file. Or select Reset workspace in Advanced to replace it.`,
    );
    expect(await readFile(path, "utf8")).toBe("{not json");
    // The refusal hands back the file's real state, warning included, so the
    // dialog snaps its controls back instead of showing an unsaved edit.
    expect(refused.source).toBe("recovered");
    expect(refused.warning).toContain(path);
    expect(refused.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    // The refusal crosses the IPC boundary; a path must not overflow its bound.
    expect(WorkspaceSettingsResult.parse(refused)).toEqual(refused);

    // Reset is the named way out, and it must actually work here.
    await resetWorkspaceSettingsFile(root);
    expect((await readWorkspaceSettingsFile(root)).source).toBe("stored");
  });

  it("applies a save to the file as it is now, not to the caller's copy", async () => {
    // The recovery path the refusal prescribes: the user repairs the file
    // while the Settings dialog still holds the resolved copy from before the
    // repair. The next save must not write that copy back over the repair.
    const root = await createTestScratch("dohc-workspace-settings-");
    const path = join(root, ".dohc", WORKSPACE_SETTINGS_FILE);
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(path, "{not json");
    expect(
      (await saveWorkspaceSettingsFile(root, { files: { attachmentLocation: "same-folder" } }))
        .refusal,
    ).toBeTruthy();

    // The user repairs the file outside dohc with a distinctive value in a
    // group this save does not touch.
    const repaired = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      sites: { defaultPreviewMode: "static" as const },
    };
    await writeWorkspaceSettingsFile(root, repaired);

    const saved = await saveWorkspaceSettingsFile(root, {
      files: { attachmentLocation: "same-folder" },
    });
    expect(saved.settings).toEqual({
      ...repaired,
      files: { ...repaired.files, attachmentLocation: "same-folder" },
    });
    // What lands on disk is the repaired file plus the one edited control.
    const onDisk = await readWorkspaceSettingsFile(root);
    expect(onDisk.settings.sites.defaultPreviewMode).toBe("static");
    expect(onDisk.settings.files.attachmentLocation).toBe("same-folder");
  });

  it("saves normally over a readable file, touching only the patched keys", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    await writeWorkspaceSettingsFile(root, {
      ...DEFAULT_WORKSPACE_SETTINGS,
      files: { attachmentLocation: "global-folder", attachmentFolderName: "media" },
    });
    const saved = await saveWorkspaceSettingsFile(root, {
      privacy: { confirmExternalLinks: false },
    });
    expect(saved.source).toBe("stored");
    expect(saved.settings.privacy.confirmExternalLinks).toBe(false);
    // A sibling group, and a sibling key inside the patched group, survive.
    expect(saved.settings.files).toEqual({
      attachmentLocation: "global-folder",
      attachmentFolderName: "media",
    });
    expect(await readWorkspaceSettingsFile(root)).toEqual(saved);
  });

  it("saves over a missing file — a new workspace is not born refused", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    expect(
      await saveWorkspaceSettingsFile(root, { privacy: { confirmExternalLinks: false } }),
    ).toEqual({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        privacy: { confirmExternalLinks: false },
      },
      source: "stored",
    });
  });

  it("keeps both patches when two saves overlap", async () => {
    // Two controls changed before the first save settles: without a queue both
    // read the same old file and the later merge drops the earlier patch —
    // while the dialog reports it saved.
    const root = await createTestScratch("dohc-workspace-settings-");
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);

    const [first, second] = await Promise.all([
      saveWorkspaceSettingsFile(root, { privacy: { confirmExternalLinks: false } }),
      saveWorkspaceSettingsFile(root, { files: { attachmentFolderName: "media" } }),
    ]);
    expect(first.refusal).toBeUndefined();
    expect(second.refusal).toBeUndefined();

    const onDisk = await readWorkspaceSettingsFile(root);
    expect(onDisk.settings.privacy.confirmExternalLinks).toBe(false);
    expect(onDisk.settings.files.attachmentFolderName).toBe("media");
  });

  it("a reset lands last over a save already in flight", async () => {
    // Reset shares the save queue. Off it, a patch already reading the file
    // writes its merge back after the reset returns, so the dialog says the
    // reset landed while the file sits somewhere the user never asked for.
    const root = await createTestScratch("dohc-workspace-settings-");
    await writeWorkspaceSettingsFile(root, {
      ...DEFAULT_WORKSPACE_SETTINGS,
      files: { attachmentLocation: "global-folder", attachmentFolderName: "media" },
    });

    let release!: () => void;
    metadataGate.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = saveWorkspaceSettingsFile(root, {
      privacy: { confirmExternalLinks: false },
    });
    // Let the save reach the gate, so the reset is fired at a save in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reset = resetWorkspaceSettingsFile(root);
    release();

    const [saved, wasReset] = await Promise.all([save, reset]);
    expect(saved.settings.privacy.confirmExternalLinks).toBe(false);
    expect(wasReset.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    // The file ends where the user's last instruction put it. (The renderer
    // drops the older save's reply: SettingsDialog bumps the same request
    // token for a reset, so the stale response never repaints.)
    expect(await readWorkspaceSettingsFile(root)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
  });

  it("resets over a DIRECTORY sitting at the settings path", async () => {
    // The refusal points the user at Reset, so Reset has to work for every
    // state the reader calls unreadable — including a directory, which the
    // atomic rename cannot land on.
    const root = await createTestScratch("dohc-workspace-settings-");
    const path = join(root, ".dohc", WORKSPACE_SETTINGS_FILE);
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await rm(path);
    await mkdir(path);
    await writeFile(join(path, "squatter.txt"), "not settings");

    expect((await readWorkspaceSettingsFile(root)).warning).toContain(
      "not a file dohc can read",
    );
    expect(
      (await saveWorkspaceSettingsFile(root, { privacy: { confirmExternalLinks: false } }))
        .refusal,
    ).toBeTruthy();

    // What the Reset control does. The directory is moved, never deleted: the
    // user asked to replace their settings, not to lose whatever sat at that
    // path — so every descendant survives, in the workspace trash dohc already
    // teaches for anything it removes.
    const reset = await resetWorkspaceSettingsFile(root);
    expect(reset.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(reset.warning).toBe(
      "dohc replaced workspace settings. The folder that was in their place is now in this workspace's .dohc/trash.",
    );
    const trashed = await readdir(join(root, ".dohc", "trash"));
    expect(trashed).toHaveLength(1);
    expect(
      await readFile(join(root, ".dohc", "trash", trashed[0]!, "squatter.txt"), "utf8"),
    ).toBe("not settings");
    expect(await readWorkspaceSettingsFile(root)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
    // And saving works again afterwards.
    expect(
      (await saveWorkspaceSettingsFile(root, { privacy: { confirmExternalLinks: false } }))
        .settings.privacy.confirmExternalLinks,
    ).toBe(false);
  });

  it("a reset over a FILE squatting .dohc/trash names the squatter, never a raw errno", async () => {
    // Reset moves the settings-path squatter into .dohc/trash. A plain file
    // at .dohc/trash made that mkdir throw raw "EEXIST: file already exists,
    // mkdir …" straight into the Settings dialog, while reset is the
    // advertised recovery from an unreadable settings file. The refusal must
    // name .dohc/trash, what squats it, and the way out.
    const root = await createTestScratch("dohc-workspace-settings-");
    const path = join(root, ".dohc", WORKSPACE_SETTINGS_FILE);
    await writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS);
    await rm(path);
    await mkdir(path); // a directory squats the settings path: file unreadable
    await writeFile(join(root, ".dohc", "trash"), "squatting");

    await expect(resetWorkspaceSettingsFile(root)).rejects.toThrow(
      "dohc could not move this to the workspace trash. A file is at .dohc/trash, which must be a real folder. Remove or rename that file. Then retry.",
    );
    // Nothing partial landed: the settings path still reads as recovered.
    expect((await readWorkspaceSettingsFile(root)).source).toBe("recovered");
  });

  // Reset is what an unreadable settings file tells the user to reach for, and
  // it runs through the metadata resolver first. A FILE at .dohc used to be
  // refused in developer vocabulary ("must be a real directory inside the
  // workspace") — the wrong noun for this surface, and no next step.
  it("a reset when a FILE squats .dohc names the squatter in the same words", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    await writeFile(join(root, ".dohc"), "squatting");

    await expect(resetWorkspaceSettingsFile(root)).rejects.toThrow(
      "dohc could not open this workspace's .dohc folder. A file is at .dohc, which must be a real folder. Remove or rename that file. Then retry.",
    );
    // The squatter is never touched: dohc names it and stops.
    expect(await readFile(join(root, ".dohc"), "utf8")).toBe("squatting");
  });

  it("refuses to write through a symlinked .dohc and never lands files outside", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    const outside = await createTestScratch("dohc-workspace-settings-");
    await symlink(outside, join(root, ".dohc"), "dir");

    await expect(
      writeWorkspaceSettingsFile(root, DEFAULT_WORKSPACE_SETTINGS),
    ).rejects.toThrow(
      "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry.",
    );
    // The READ stays tolerant, like the symlinked-file case below: recover
    // to defaults with a warning naming the folder, and never follow the
    // link. Nothing is read from or written into the link target.
    const read = await readWorkspaceSettingsFile(root);
    expect(read.source).toBe("recovered");
    expect(read.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(read.warning).toContain(join(root, ".dohc"));
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses to read a symlinked settings file", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    const outside = await createTestScratch("dohc-workspace-settings-");
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
    expect(result.warning).toContain("not a file dohc can read");
  });
});

describe("workspace settings writes never reach history", () => {
  it("the watcher enqueues the user file into the engine capture but nothing for settings.local.json", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    const workspace: CreatedWorkspace = {
      workspaceId: "ws-settings-test",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };

    // The engine capture is the only recorder — assert
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
