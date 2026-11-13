import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { engineMomentsOrEmpty } from "./helpers/engineDb";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("captures live edits and reconciles closed-period edits into the engine", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);

    await writeWorkspaceFiles(temp, [
      {
        path: "notes/engine-live.md",
        contents: "# Engine live\n\nCaptured while running.\n",
      },
    ]);
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, "notes/engine-live.md");

    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) => moment.path === "notes/engine-live.md" && moment.operation === "write",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const liveMoment = engineMomentsOrEmpty(temp.rootPath).find(
      (moment) => moment.path === "notes/engine-live.md",
    );
    expect(liveMoment?.text).toBe("# Engine live\n\nCaptured while running.\n");

    const legacyIndex = join(temp.rootPath, ".dohc", "history");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(legacyIndex).catch(() => [])).length).toBe(0);

    await desktop.close();
    desktop = null;

    await writeWorkspaceFiles(temp, [
      {
        path: "notes/engine-offline.md",
        contents: "# Engine offline\n\nEdited while dohc was closed.\n",
      },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);

    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) => moment.path === "notes/engine-offline.md" && moment.operation === "write",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const offlineMoment = engineMomentsOrEmpty(temp.rootPath).find(
      (moment) => moment.path === "notes/engine-offline.md",
    );
    expect(offlineMoment?.text).toBe("# Engine offline\n\nEdited while dohc was closed.\n");
    expect(offlineMoment?.summary).toBe("Changed while dohc was closed");

    expect(
      engineMomentsOrEmpty(temp.rootPath).filter(
        (moment) => moment.path === "notes/engine-live.md",
      ),
    ).toHaveLength(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("cold adoption: a workspace with existing files and legacy history reconciles into the engine", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      { path: "notes/adopted.md", contents: "# Adopted\n\nWritten before the flip.\n" },
      { path: "docs/deep/nested.md", contents: "# Nested\n\nAlso here first.\n" },
    ]);
    const legacyDir = join(temp.rootPath, ".dohc", "history");
    const { mkdir, writeFile, readFile, readdir } = await import("node:fs/promises");
    await mkdir(legacyDir, { recursive: true });
    const legacyRecordPath = join(legacyDir, "legacy-relic.json");
    const legacyRecord = JSON.stringify({ id: "legacy-1", summary: "pre-flip edit" });
    await writeFile(legacyRecordPath, legacyRecord);

    // No settings file: the engine needs none.
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);

    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) =>
              (moment.path === "notes/adopted.md" || moment.path === "docs/deep/nested.md") &&
              moment.operation === "write",
          ).length,
        { timeout: 30_000 },
      )
      .toBe(2);
    const adopted = engineMomentsOrEmpty(temp.rootPath).find(
      (moment) => moment.path === "notes/adopted.md",
    );
    expect(adopted?.text).toBe("# Adopted\n\nWritten before the flip.\n");

    expect(await readFile(legacyRecordPath, "utf8")).toBe(legacyRecord);
    expect(await readdir(legacyDir)).toEqual(["legacy-relic.json"]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
