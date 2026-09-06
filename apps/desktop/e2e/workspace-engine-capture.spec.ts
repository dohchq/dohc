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

    // Session 1: edit a file on disk while the app is running — the daemon
    // watcher must land the batch in the engine store.
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);

    await writeWorkspaceFiles(temp, [
      {
        path: "notes/engine-live.md",
        contents: "# Engine live\n\nCaptured while running.\n",
      },
    ]);
    await waitForWorkspaceFile(
      desktop.page,
      workspace.workspaceId,
      "notes/engine-live.md",
    );

    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) =>
              moment.path === "notes/engine-live.md" && moment.operation === "write",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const liveMoment = engineMomentsOrEmpty(temp.rootPath).find(
      (moment) => moment.path === "notes/engine-live.md",
    );
    expect(liveMoment?.text).toBe("# Engine live\n\nCaptured while running.\n");

    // The engine is the only recorder: no legacy .dohc/history change set
    // may appear.
    const legacyIndex = join(temp.rootPath, ".dohc", "history");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(legacyIndex).catch(() => [])).length).toBe(0);

    await desktop.close();
    desktop = null;

    // Closed period: edit another file while the app is stopped.
    await writeWorkspaceFiles(temp, [
      {
        path: "notes/engine-offline.md",
        contents: "# Engine offline\n\nEdited while dohc was closed.\n",
      },
    ]);

    // Session 2: relaunch — startup reconciliation must capture the
    // closed-period edit as an engine moment.
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);

    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) =>
              moment.path === "notes/engine-offline.md" && moment.operation === "write",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const offlineMoment = engineMomentsOrEmpty(temp.rootPath).find(
      (moment) => moment.path === "notes/engine-offline.md",
    );
    expect(offlineMoment?.text).toBe(
      "# Engine offline\n\nEdited while dohc was closed.\n",
    );
    expect(offlineMoment?.summary).toBe("Reconciled offline edits");

    // Reconciliation is idempotent: the live file from session 1 must not
    // gain a second moment on relaunch (its content is unchanged).
    expect(
      engineMomentsOrEmpty(temp.rootPath).filter(
        (moment) => moment.path === "notes/engine-live.md",
      ),
    ).toHaveLength(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// Cold adoption: a workspace with no settings file opens on the engine, and
// the startup reconciliation pass captures the existing tree as the engine's
// initial state. Legacy .dohc/history stays on disk as a read-only relic;
// engine history starts from adoption and the legacy records are not
// migrated.
test("cold adoption: a workspace with existing files and legacy history reconciles into the engine", async () => {
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

    // No settings file: the engine needs none.
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
