import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { engineMomentsOrEmpty } from "./helpers/engineDb";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// WS-H1 flag flip: "unflagged" now means EXPLICITLY OPTED OUT — the default
// (no settings file, or a settings file with no experimental key) is engine
// ON. The opt-out escape hatch must keep working: no engine store may appear.
test("explicitly opted-out workspace never grows an engine store", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: false },
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);

    await writeWorkspaceFiles(temp, [
      { path: "notes/plain.md", contents: "# Plain\n\nNo engine here.\n" },
    ]);
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, "notes/plain.md");

    // The edit is visible to the app (listed above); no engine store appears
    // for an opted-out workspace.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(temp.rootPath, ".dohc", "engine", "engine.db"))).toBe(false);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("cold adoption: a workspace with existing files and legacy history opens flagged and reconciles into the engine", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    // Existing user content from the pre-engine era...
    await writeWorkspaceFiles(temp, [
      { path: "notes/adopted.md", contents: "# Adopted\n\nWritten before the flip.\n" },
      { path: "docs/deep/nested.md", contents: "# Nested\n\nAlso here first.\n" },
    ]);
    // ...and a legacy history relic a real pre-flip workspace would carry.
    const legacyDir = join(temp.rootPath, ".dohc", "history");
    const { mkdir, writeFile, readFile, readdir } = await import("node:fs/promises");
    await mkdir(legacyDir, { recursive: true });
    const legacyRecordPath = join(legacyDir, "legacy-relic.json");
    const legacyRecord = JSON.stringify({ id: "legacy-1", summary: "pre-flip edit" });
    await writeFile(legacyRecordPath, legacyRecord);

    // NO settings file: the absent experimental key must read as engine ON.
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);

    // Startup reconciliation captures the whole existing tree as the
    // engine's initial state.
    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) =>
              (moment.path === "notes/adopted.md" ||
                moment.path === "docs/deep/nested.md") &&
              moment.operation === "write",
          ).length,
        { timeout: 30_000 },
      )
      .toBe(2);
    const adopted = engineMomentsOrEmpty(temp.rootPath).find(
      (moment) => moment.path === "notes/adopted.md",
    );
    expect(adopted?.text).toBe("# Adopted\n\nWritten before the flip.\n");

    // The legacy relic is untouched (read-only relic, not migrated, not
    // deleted) and no new legacy records were written.
    expect(await readFile(legacyRecordPath, "utf8")).toBe(legacyRecord);
    expect(await readdir(legacyDir)).toEqual(["legacy-relic.json"]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
