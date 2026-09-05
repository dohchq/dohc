import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
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
