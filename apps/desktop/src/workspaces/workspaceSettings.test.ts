import { chmod, link, lstat, mkdir, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import { describe, expect, it, vi } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  mergeWorkspaceSettings,
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

import { createTestScratch } from "./testTemp";
import { settingsFileNotice } from "../renderer/shell/useSettingsFileNotices";
import { fakeLocalStateOpens } from "../testing/preparedLocalState";
import { LocalStateUnavailableError } from "./workspaceLocalState";

const engine = fakeLocalStateOpens();
let workspaces = 0;
// A workspace whose engine open prepared .dohc/local.
async function openedWorkspace(prefix = "dohc-workspace-settings-") {
  workspaces += 1;
  const workspace = { workspaceId: `settings-${workspaces}`, rootPath: await createTestScratch(prefix) };
  await engine.open(workspace);
  return workspace;
}
const settingsFile = (root: string) => join(root, ".dohc", "local", WORKSPACE_SETTINGS_FILE);

it("applies settings beside one unknown key and names it in one file notice", async () => {
  const workspace = await openedWorkspace("dohc-settings-unknown-key-");
  const root = workspace.rootPath;
  await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);
  const path = settingsFile(root);
  const raw = { ...DEFAULT_WORKSPACE_SETTINGS, sites: { defaultPreviewMode: "static", futurePreview: true } };
  await writeFile(path, JSON.stringify(raw));
  const read = await readWorkspaceSettingsFile(workspace);
  expect(read.source).toBe("stored");
  expect(read.settings.sites.defaultPreviewMode).toBe("static");
  expect(read.ignored).toEqual([{ key: "sites.futurePreview", reason: "unknown" }]);
  expect(settingsFileNotice(".dohc/local/settings.local.json", read)).toBe(
    "dohc ignored sites.futurePreview in .dohc/local/settings.local.json because it is not a setting dohc knows. The other settings apply.",
  );
  await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ sites: raw.sites, privacy: { confirmExternalLinks: false } });
});
// A seam on the one open each settings read makes: `stat` changes what that
// handle reports, and `afterOpen` runs between the open and the read. Pass-
// through until a test arms it.
const openSeam = vi.hoisted(() => ({
  stat: null as null | ((stats: import("node:fs").Stats) => import("node:fs").Stats),
  afterOpen: null as null | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const { stat, afterOpen } = openSeam;
      openSeam.stat = null;
      openSeam.afterOpen = null;
      await afterOpen?.();
      if (!stat) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat") return async () => stat(await target.stat());
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
// What another local user's file reports: anyone's uid but this user's.
const madeByAnotherUser = (stats: import("node:fs").Stats) =>
  Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1 });

// A seam for the write-ordering test below: every settings read resolves the
// metadata directory first, so a gate here can hold one of them
// open while another write is fired. Pass-through until a test arms it.
const metadataGate = vi.hoisted(() => ({ pending: null as Promise<void> | null }));
vi.mock("./workspaceMetadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspaceMetadata")>();
  return {
    ...actual,
    resolveWorkspaceMetadataDir: async (rootPath: string, options?: { create: false }) => {
      const gate = metadataGate.pending;
      if (gate) {
        metadataGate.pending = null;
        await gate;
      }
      return options ? actual.resolveWorkspaceMetadataDir(rootPath, options) : actual.resolveWorkspaceMetadataDir(rootPath);
    },
  };
});


describe("workspace settings model", () => {
  it("defaults and merges the attachment-location (files) group", () => {
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
    // Other groups are untouched.
    expect(globalFolder.privacy).toEqual(DEFAULT_WORKSPACE_SETTINGS.privacy);
    // An empty folder name is accepted by the schema (sanitized to a safe
    // segment at use time) rather than resetting the whole file.
    const emptyName = mergeWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS, {
      files: { attachmentFolderName: "" },
    });
    expect(emptyName.files.attachmentFolderName).toBe("");
  });

});

describe("workspace settings file store", () => {
  it("round-trips settings through .dohc/local/settings.local.json", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const settings = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      sites: { defaultPreviewMode: "static" as const },
    };
    await writeWorkspaceSettingsFile(workspace, settings);
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings,
      source: "stored",
    });
    const raw = await readFile(settingsFile(root), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("ignores an old .dohc/settings.local.json and leaves it as it was", async () => {
    const workspace = await openedWorkspace();
    const old = join(workspace.rootPath, ".dohc", WORKSPACE_SETTINGS_FILE);
    const oldSettings = `${JSON.stringify({ ...DEFAULT_WORKSPACE_SETTINGS, privacy: { confirmExternalLinks: false } })}\n`;
    await writeFile(old, oldSettings);
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default",
    });
    await saveWorkspaceSettingsFile(workspace, { sites: { defaultPreviewMode: "static" } });
    expect(JSON.parse(await readFile(settingsFile(workspace.rootPath), "utf8"))).toMatchObject({
      sites: { defaultPreviewMode: "static" },
      privacy: { confirmExternalLinks: true },
    });
    expect(await readFile(old, "utf8")).toBe(oldSettings);
  });

  it("refuses a save or reset until the engine prepared .dohc/local, says why, and makes nothing", async () => {
    const workspace = { workspaceId: "settings-unopened", rootPath: await createTestScratch("dohc-workspace-settings-") };
    const patch = { privacy: { confirmExternalLinks: false } };
    await expect(saveWorkspaceSettingsFile(workspace, patch)).rejects.toThrow(
      "dohc did not save this workspace's settings because the workspace has not finished opening. Try again when it opens.",
    );
    await expect(resetWorkspaceSettingsFile(workspace)).rejects.toThrow(
      "dohc did not reset this workspace's settings because the workspace has not finished opening. Try again when it opens.",
    );
    expect(await lstat(join(workspace.rootPath, ".dohc")).catch(() => null)).toBeNull();

    // The open could not keep the folder out of iCloud Drive.
    await engine.open(workspace, false);
    await expect(saveWorkspaceSettingsFile(workspace, patch)).rejects.toThrow(
      "dohc did not save this workspace's settings because it can't keep this computer's settings out of iCloud Drive. Restart dohc to try again.",
    );
    await expect(resetWorkspaceSettingsFile(workspace)).rejects.toThrow(
      "dohc did not reset this workspace's settings because it can't keep this computer's settings out of iCloud Drive. Restart dohc to try again.",
    );
    expect(await readdir(join(workspace.rootPath, ".dohc", "local"))).toEqual([]);
  });

  // These settings change what dohc does, such as whether a link opens
  // without asking, so only a file this user owns is used. Node reports no
  // owner on Windows.
  it.skipIf(process.platform === "win32")("uses a settings file another user made in no case, and Reset replaces it", async () => {
    const workspace = await openedWorkspace();
    await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } });
    const path = settingsFile(workspace.rootPath);
    // This user's file is read before the engine opens the workspace.
    engine.close(workspace);
    expect((await readWorkspaceSettingsFile(workspace)).settings.privacy.confirmExternalLinks).toBe(false);
    // Another user's file is not, even while the engine's open stands.
    await engine.open(workspace);
    openSeam.stat = madeByAnotherUser;
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read.source).toBe("recovered");
    expect(read.settings.privacy.confirmExternalLinks).toBe(true);
    expect(read.warning).toBe(
      `Another user made the workspace settings file. dohc is using default settings. Fix ${path}. Or select Reset workspace in Advanced to replace it.`,
    );
    // Reset writes a fresh file of this user's in its place.
    await resetWorkspaceSettingsFile(workspace);
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
  });

  it.skipIf(process.platform === "win32")("does not use a .dohc/local another user swapped in after the open", async () => {
    const workspace = await openedWorkspace();
    const folder = join(workspace.rootPath, ".dohc", "local");
    await rm(folder, { recursive: true });
    await mkdir(folder);
    await writeFile(settingsFile(workspace.rootPath), JSON.stringify({
      ...DEFAULT_WORKSPACE_SETTINGS,
      privacy: { confirmExternalLinks: false },
    }));
    // Everything in the swapped folder is the other user's.
    const someoneElse = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    try {
      // With every uid but this user's, .dohc itself reads as theirs too.
      const read = await readWorkspaceSettingsFile(workspace);
      expect(read.settings.privacy.confirmExternalLinks).toBe(true);
      expect(read.warning).toMatch(
        /^This workspace's \.dohc(\/local)? belongs to another user, so dohc is using default settings\. Make it and everything in it yours again, then try again\.$/,
      );
    } finally {
      someoneElse.mockRestore();
    }
  });

  it("reads the file it opened, even when a link takes its place before the read", async () => {
    const workspace = await openedWorkspace();
    await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } });
    const path = settingsFile(workspace.rootPath);
    const outside = join(await createTestScratch("dohc-workspace-settings-"), "settings.local.json");
    await writeFile(outside, JSON.stringify({ ...DEFAULT_WORKSPACE_SETTINGS, sites: { defaultPreviewMode: "static" } }));
    openSeam.afterOpen = async () => {
      await unlink(path);
      await symlink(outside, path);
    };
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read.source).toBe("stored");
    expect(read.settings.privacy.confirmExternalLinks).toBe(false);
    expect(read.settings.sites.defaultPreviewMode).toBe("auto");
  });

  // Reset replaces only the settings file. A problem with the folder that
  // holds it names its own way out, and taking it works.
  it("names a way out of a linked .dohc/local that works, and never offers Reset", async () => {
    const workspace = await openedWorkspace();
    const folder = join(workspace.rootPath, ".dohc", "local");
    const elsewhere = await createTestScratch("dohc-workspace-settings-");
    await rm(folder, { recursive: true });
    await symlink(elsewhere, folder, "dir");
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read.warning).toBe(
      "This workspace's .dohc/local is a link, so dohc is using default settings. Put what it links to in its place, then try again.",
    );
    expect((await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } })).refusal).toBe(
      "dohc did not save workspace settings because this workspace's .dohc/local is a link. Put what it links to in its place, then try again.",
    );
    await unlink(folder);
    await rename(elsewhere, folder);
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default",
    });
  });

  // A folder dohc can't look into is not one without settings. chmod can't
  // hide a folder from root, and Windows has no such mode.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "names a .dohc dohc can't look into, rather than read its settings as missing",
    async () => {
      const workspace = await openedWorkspace();
      await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } });
      const dohc = join(workspace.rootPath, ".dohc");
      await chmod(dohc, 0o600);
      try {
        const read = await readWorkspaceSettingsFile(workspace);
        expect(read.source).toBe("recovered");
        expect(read.warning).toBe(
          "This workspace's .dohc/local can't be read, so dohc is using default settings. Make sure you can open it, then try again.",
        );
        expect((await saveWorkspaceSettingsFile(workspace, { sites: { defaultPreviewMode: "static" } })).refusal).toBe(
          "dohc did not save workspace settings because this workspace's .dohc/local can't be read. Make sure you can open it, then try again.",
        );
      } finally {
        await chmod(dohc, 0o700);
      }
      expect((await readWorkspaceSettingsFile(workspace)).settings.privacy.confirmExternalLinks).toBe(false);
    },
  );

  it("names the folder, not Reset, for a linked .dohc/local holding a malformed file of this user's", async () => {
    const workspace = await openedWorkspace();
    const folder = join(workspace.rootPath, ".dohc", "local");
    const elsewhere = await createTestScratch("dohc-workspace-settings-");
    await writeFile(join(elsewhere, WORKSPACE_SETTINGS_FILE), "{not json", { mode: 0o600 });
    await rm(folder, { recursive: true });
    await symlink(elsewhere, folder, "dir");
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read.warning).toBe(
      "This workspace's .dohc/local is a link, so dohc is using default settings. Put what it links to in its place, then try again.",
    );
    expect((await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } })).refusal).toBe(
      "dohc did not save workspace settings because this workspace's .dohc/local is a link. Put what it links to in its place, then try again.",
    );
  });

  // Another user could rewrite such a file in place without changing its
  // owner. On a Mac every local user is in staff. Node reports no mode on
  // Windows.
  it.skipIf(process.platform === "win32")("refuses a settings file other users can write, and Reset writes one only this user can", async () => {
    const workspace = await openedWorkspace();
    await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } });
    const path = settingsFile(workspace.rootPath);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o664);
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read.settings.privacy.confirmExternalLinks).toBe(true);
    expect(read.warning).toBe(
      `Other users can change the workspace settings file. dohc is using default settings. Fix ${path}. Or select Reset workspace in Advanced to replace it.`,
    );
    await resetWorkspaceSettingsFile(workspace);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
  });

  it("refuses a settings file with a second name, and Reset leaves it one", async () => {
    const workspace = await openedWorkspace();
    await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } });
    const path = settingsFile(workspace.rootPath);
    const second = join(await createTestScratch("dohc-workspace-settings-"), "second-name.json");
    await link(path, second);
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read.settings.privacy.confirmExternalLinks).toBe(true);
    expect(read.warning).toBe(
      `The workspace settings file has a second name elsewhere. dohc is using default settings. Fix ${path}. Or select Reset workspace in Advanced to replace it.`,
    );
    await resetWorkspaceSettingsFile(workspace);
    expect((await lstat(path)).nlink).toBe(1);
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
    // The other name keeps what it had.
    expect(JSON.parse(await readFile(second, "utf8")).privacy.confirmExternalLinks).toBe(false);
  });

  it("a missing file reads as defaults", async () => {
    expect(await readWorkspaceSettingsFile({ workspaceId: "settings-missing", rootPath: await createTestScratch("dohc-workspace-settings-") })).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default",
    });
  });

  it("an on-disk file from before the files group still parses as stored", async () => {
    // Files from that time also carry the retired agents group: it is named
    // as unknown, and the settings beside it still apply.
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(
      settingsFile(root),
      JSON.stringify({
        version: 1,
        agents: { mcpAutoStart: true },
        sites: { defaultPreviewMode: "static" },
        privacy: { confirmExternalLinks: false },
      }),
    );
    const result = await readWorkspaceSettingsFile(workspace);
    expect(result).toEqual({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        sites: { defaultPreviewMode: "static" },
        privacy: { confirmExternalLinks: false },
      },
      source: "stored",
      ignored: [{ key: "agents", reason: "unknown" }],
    });
  });

  it("corrupt, unsupported, and oversized files read as recovered and name the file", async () => {
    const corruptWorkspace = await openedWorkspace();
    const corrupt = corruptWorkspace.rootPath;
    await writeWorkspaceSettingsFile(corruptWorkspace, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(settingsFile(corrupt), "{not json");
    const corruptResult = await readWorkspaceSettingsFile(corruptWorkspace);
    expect(corruptResult.source).toBe("recovered");
    expect(corruptResult.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(corruptResult.warning).toContain(
      settingsFile(corrupt),
    );
    expect(corruptResult.warning).toContain("Reset workspace");

    for (const body of [
      JSON.stringify({ version: 2 }),
      JSON.stringify([]),
      JSON.stringify(null),
    ]) {
      const invalidWorkspace = await openedWorkspace();
    const invalid = invalidWorkspace.rootPath;
      await writeWorkspaceSettingsFile(invalidWorkspace, DEFAULT_WORKSPACE_SETTINGS);
      await writeFile(settingsFile(invalid), body);
      const invalidResult = await readWorkspaceSettingsFile(invalidWorkspace);
      expect(invalidResult.source, body).toBe("recovered");
      expect(invalidResult.settings, body).toEqual(DEFAULT_WORKSPACE_SETTINGS);
      expect(invalidResult.warning, body).toContain("could not be read");
    }

    const hugeWorkspace = await openedWorkspace();
    const huge = hugeWorkspace.rootPath;
    await writeWorkspaceSettingsFile(hugeWorkspace, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(
      settingsFile(huge),
      JSON.stringify({ padding: "x".repeat(MAX_WORKSPACE_SETTINGS_FILE_BYTES) }),
    );
    const hugeResult = await readWorkspaceSettingsFile(hugeWorkspace);
    expect(hugeResult.source).toBe("recovered");
    expect(hugeResult.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(hugeResult.warning).toContain("too large");

    // The warning crosses the IPC boundary; a path must not overflow its bound.
    expect(WorkspaceSettingsResult.parse(hugeResult)).toEqual(hugeResult);
  });

  it("turns off only an unknown key or a value dohc cannot use, and a save keeps them", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const path = settingsFile(root);
    await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(path, JSON.stringify({
      sites: { defaultPreviewMode: "static" },
      privacy: { confirmExternalLinks: "false" },
      theme: "dark",
    }));
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read).toEqual({
      settings: { ...DEFAULT_WORKSPACE_SETTINGS, sites: { defaultPreviewMode: "static" } },
      source: "stored",
      ignored: [
        { key: "privacy.confirmExternalLinks", reason: "invalid" },
        { key: "theme", reason: "unknown" },
      ],
    });
    expect(WorkspaceSettingsResult.parse(read)).toEqual(read);

    const saved = await saveWorkspaceSettingsFile(workspace, { files: { attachmentFolderName: "media" } });
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
    const squatted = { workspaceId: "squatted", rootPath: root };
    const result = await readWorkspaceSettingsFile(squatted);
    expect(result.source).toBe("recovered");
    expect(result.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(result.warning).toBe(
      "This workspace's .dohc is not a folder, so dohc is using default settings. Rename or move it, then try again.",
    );
    // Its way out works.
    await rename(join(root, ".dohc"), join(root, "moved-aside"));
    expect((await readWorkspaceSettingsFile(squatted)).source).toBe("default");
  });

  it("refuses to save over an unreadable file, and reset still replaces it", async () => {
    // Over an unreadable file the caller's resolved settings are the
    // defaults, so saving any control would write them over the file and
    // the warning would disappear with it. The file must survive the save
    // byte for byte.
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const path = settingsFile(root);
    await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(path, "{not json");

    const refused = await saveWorkspaceSettingsFile(workspace, {
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
    await resetWorkspaceSettingsFile(workspace);
    expect((await readWorkspaceSettingsFile(workspace)).source).toBe("stored");
  });

  it("applies a save to the file as it is now, not to the caller's copy", async () => {
    // The recovery path the refusal prescribes: the user repairs the file
    // while the Settings dialog still holds the resolved copy from before the
    // repair. The next save must not write that copy back over the repair.
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const path = settingsFile(root);
    await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);
    await writeFile(path, "{not json");
    expect(
      (await saveWorkspaceSettingsFile(workspace, { files: { attachmentLocation: "same-folder" } }))
        .refusal,
    ).toBeTruthy();

    // The user repairs the file outside dohc with a distinctive value in a
    // group this save does not touch.
    const repaired = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      sites: { defaultPreviewMode: "static" as const },
    };
    await writeWorkspaceSettingsFile(workspace, repaired);

    const saved = await saveWorkspaceSettingsFile(workspace, {
      files: { attachmentLocation: "same-folder" },
    });
    expect(saved.settings).toEqual({
      ...repaired,
      files: { ...repaired.files, attachmentLocation: "same-folder" },
    });
    // What lands on disk is the repaired file plus the one edited control.
    const onDisk = await readWorkspaceSettingsFile(workspace);
    expect(onDisk.settings.sites.defaultPreviewMode).toBe("static");
    expect(onDisk.settings.files.attachmentLocation).toBe("same-folder");
  });

  it("saves normally over a readable file, touching only the patched keys", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    await writeWorkspaceSettingsFile(workspace, {
      ...DEFAULT_WORKSPACE_SETTINGS,
      files: { attachmentLocation: "global-folder", attachmentFolderName: "media" },
    });
    const saved = await saveWorkspaceSettingsFile(workspace, {
      privacy: { confirmExternalLinks: false },
    });
    expect(saved.source).toBe("stored");
    expect(saved.settings.privacy.confirmExternalLinks).toBe(false);
    // A sibling group, and a sibling key inside the patched group, survive.
    expect(saved.settings.files).toEqual({
      attachmentLocation: "global-folder",
      attachmentFolderName: "media",
    });
    expect(await readWorkspaceSettingsFile(workspace)).toEqual(saved);
  });

  it("saves over a missing file — a new workspace is not born refused", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    expect(
      await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } }),
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
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);

    const [first, second] = await Promise.all([
      saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } }),
      saveWorkspaceSettingsFile(workspace, { files: { attachmentFolderName: "media" } }),
    ]);
    expect(first.refusal).toBeUndefined();
    expect(second.refusal).toBeUndefined();

    const onDisk = await readWorkspaceSettingsFile(workspace);
    expect(onDisk.settings.privacy.confirmExternalLinks).toBe(false);
    expect(onDisk.settings.files.attachmentFolderName).toBe("media");
  });

  it("a reset lands last over a save already in flight", async () => {
    // Reset shares the save queue. Off it, a patch already reading the file
    // writes its merge back after the reset returns, so the dialog says the
    // reset landed while the file sits somewhere the user never asked for.
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    await writeWorkspaceSettingsFile(workspace, {
      ...DEFAULT_WORKSPACE_SETTINGS,
      files: { attachmentLocation: "global-folder", attachmentFolderName: "media" },
    });

    let release!: () => void;
    metadataGate.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = saveWorkspaceSettingsFile(workspace, {
      privacy: { confirmExternalLinks: false },
    });
    // Let the save reach the gate, so the reset is fired at a save in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reset = resetWorkspaceSettingsFile(workspace);
    release();

    const [saved, wasReset] = await Promise.all([save, reset]);
    expect(saved.settings.privacy.confirmExternalLinks).toBe(false);
    expect(wasReset.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    // The file ends where the user's last instruction put it. (The renderer
    // drops the older save's reply: SettingsDialog bumps the same request
    // token for a reset, so the stale response never repaints.)
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
  });

  it("resets over a DIRECTORY sitting at the settings path", async () => {
    // The refusal points the user at Reset, so Reset has to work for every
    // state the reader calls unreadable — including a directory, which the
    // atomic rename cannot land on.
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const path = settingsFile(root);
    await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);
    await rm(path);
    await mkdir(path);
    await writeFile(join(path, "squatter.txt"), "not settings");

    expect((await readWorkspaceSettingsFile(workspace)).warning).toContain(
      "not a file dohc can read",
    );
    expect(
      (await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } }))
        .refusal,
    ).toBeTruthy();

    // What the Reset control does. The directory is moved, never deleted: the
    // user asked to replace their settings, not to lose whatever sat at that
    // path — so every descendant survives, in the workspace trash dohc already
    // teaches for anything it removes.
    // An old `.dohc/trash` is not the trash any more.
    await mkdir(join(root, ".dohc", "trash"));
    const reset = await resetWorkspaceSettingsFile(workspace);
    expect(reset.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(reset.warning).toBe(
      "dohc replaced workspace settings. The folder that was in their place is now in this workspace's .dohc/local/trash.",
    );
    const trashed = await readdir(join(root, ".dohc", "local", "trash"));
    expect(trashed).toHaveLength(1);
    expect(
      await readFile(join(root, ".dohc", "local", "trash", trashed[0]!, "squatter.txt"), "utf8"),
    ).toBe("not settings");
    expect(await readdir(join(root, ".dohc", "trash"))).toEqual([]);
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
    // And saving works again afterwards.
    expect(
      (await saveWorkspaceSettingsFile(workspace, { privacy: { confirmExternalLinks: false } }))
        .settings.privacy.confirmExternalLinks,
    ).toBe(false);
  });

  it("a reset over a FILE squatting .dohc/local/trash names the squatter, never a raw errno", async () => {
    // Reset moves the settings-path squatter into .dohc/local/trash. A plain
    // file there made that mkdir throw raw "EEXIST: file already exists,
    // mkdir …" straight into the Settings dialog, while reset is the
    // advertised recovery from an unreadable settings file. The refusal must
    // name .dohc/local/trash, what squats it, and the way out.
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const path = settingsFile(root);
    await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);
    await rm(path);
    await mkdir(path); // a directory squats the settings path: file unreadable
    await writeFile(join(root, ".dohc", "local", "trash"), "squatting");

    await expect(resetWorkspaceSettingsFile(workspace)).rejects.toThrow(
      "dohc could not move this to the workspace trash. A file is at .dohc/local/trash, which must be a real folder. Remove or rename that file. Then retry.",
    );
    // Nothing partial landed: the settings path still reads as recovered.
    expect((await readWorkspaceSettingsFile(workspace)).source).toBe("recovered");
  });

  // The engine refuses to open a workspace whose .dohc is a FILE, so its
  // .dohc/local is never prepared and a reset is refused before it touches
  // anything.
  it("a reset when a FILE squats .dohc changes nothing", async () => {
    const root = await createTestScratch("dohc-workspace-settings-");
    await writeFile(join(root, ".dohc"), "squatting");

    await expect(resetWorkspaceSettingsFile({ workspaceId: "squatted", rootPath: root })).rejects.toThrow(
      "dohc did not reset this workspace's settings because the workspace has not finished opening. Try again when it opens.",
    );
    // The squatter is never touched: dohc names it and stops.
    expect(await readFile(join(root, ".dohc"), "utf8")).toBe("squatting");
  });

  it("refuses to write through a symlinked .dohc and never lands files outside", async () => {
    // The engine prepared .dohc/local, then something put a link at .dohc.
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const outside = await createTestScratch("dohc-workspace-settings-");
    await rm(join(root, ".dohc"), { recursive: true });
    await symlink(outside, join(root, ".dohc"), "dir");

    await expect(
      writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS),
    ).rejects.toBeInstanceOf(LocalStateUnavailableError);
    // The READ stays tolerant, like the symlinked-file case below: recover
    // to defaults with a warning naming the folder, and never follow the
    // link. Nothing is read from or written into the link target.
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read.source).toBe("recovered");
    expect(read.settings).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(read.warning).toBe(
      "This workspace's .dohc is a link, so dohc is using default settings. Put what it links to in its place, then try again.",
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses to read a symlinked settings file", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const outside = await createTestScratch("dohc-workspace-settings-");
    await writeWorkspaceSettingsFile(workspace, DEFAULT_WORKSPACE_SETTINGS);
    const outsideSettings = join(outside, "settings.local.json");
    await writeFile(
      outsideSettings,
      JSON.stringify({
        ...DEFAULT_WORKSPACE_SETTINGS,
        privacy: { confirmExternalLinks: false },
      }),
    );
    await unlink(settingsFile(root));
    await symlink(outsideSettings, settingsFile(root));

    const result = await readWorkspaceSettingsFile(workspace);
    expect(result.source).toBe("recovered");
    expect(result.settings.privacy.confirmExternalLinks).toBe(true);
    expect(result.warning).toContain("not a file dohc can read");

    // Reset, which the warning offers, moves the link aside and writes a
    // fresh file. What the link pointed at is left alone.
    const reset = await resetWorkspaceSettingsFile(workspace);
    expect(reset.warning).toBe(
      "dohc replaced workspace settings. The link that was in their place is now in this workspace's .dohc/local/trash.",
    );
    expect(await readWorkspaceSettingsFile(workspace)).toEqual({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
    expect(JSON.parse(await readFile(outsideSettings, "utf8")).privacy.confirmExternalLinks).toBe(false);
  });
});
