import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
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

// PR 0M-3 watcher->engine capture E2E. The assertions read the persisted
// SQLite engine store (.dohc/engine/engine.db) directly from the test
// process — the engine-backed history UI is lane 0M-5, so no UI assertions
// here. WAL mode makes a read-only cross-process connection safe while the
// app holds the database.
const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
    close(): void;
  };
};

interface EngineMoment {
  path: string;
  operation: string;
  text: string;
  summary: string | null;
}

function readEngineMoments(rootPath: string): EngineMoment[] {
  const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        `SELECT m.path AS path, m.operation AS operation, b.text AS text,
                m.metadata_summary AS summary
         FROM moments m JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
         ORDER BY m.moment_order`,
      )
      .all() as unknown as EngineMoment[];
  } finally {
    db.close();
  }
}

function engineMomentsOrEmpty(rootPath: string): EngineMoment[] {
  try {
    return readEngineMoments(rootPath);
  } catch {
    // engine.db may not exist yet while the app is still opening.
    return [];
  }
}

test("flagged workspace captures live edits and reconciles closed-period edits into the engine", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });

    // Session 1: edit a file on disk while the app is running — the watcher
    // batch must land in the engine store beside legacy history.
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
    const liveMoment = readEngineMoments(temp.rootPath).find(
      (moment) => moment.path === "notes/engine-live.md",
    );
    expect(liveMoment?.text).toBe("# Engine live\n\nCaptured while running.\n");

    // PR 0M-5 ended the dual-write: the engine is the SOLE recorder for the
    // flagged workspace — no legacy .dohc/history change set may appear.
    // (This assertion previously required legacy records to keep appearing;
    // the flip is the deliberate 0M-5 behavior change.)
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
    const offlineMoment = readEngineMoments(temp.rootPath).find(
      (moment) => moment.path === "notes/engine-offline.md",
    );
    expect(offlineMoment?.text).toBe(
      "# Engine offline\n\nEdited while dohc was closed.\n",
    );
    expect(offlineMoment?.summary).toBe("Reconciled offline edits");

    // Reconciliation is idempotent: the live file from session 1 must not
    // gain a second moment on relaunch (its content is unchanged).
    expect(
      readEngineMoments(temp.rootPath).filter(
        (moment) => moment.path === "notes/engine-live.md",
      ),
    ).toHaveLength(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

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

// WS-H1 cold adoption: a previously-unflagged workspace (no settings file at
// all — the shape every pre-flip workspace has) opens ON THE ENGINE, and the
// startup reconciliation pass captures the existing tree as the engine's
// initial state. Legacy .dohc/history stays on disk as a read-only relic —
// engine history starts from adoption; the legacy records are NOT migrated
// (User Decision 6: replacement, not migration).
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
    const adopted = readEngineMoments(temp.rootPath).find(
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
