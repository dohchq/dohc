import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
  type WorkspaceFileWrite,
} from "./helpers/workspace";

// PR 0N-2 — THE AGENT LOOP AS A TEST. One gesture hands a task to an agent in
// a fresh version: the version menu's "Try in a version…" creates and
// switches to "Try: <task>", starts a dohc-tracked run (0N-1 attribution),
// shows an honest banner while the agent works, and turns the run's end into
// a review card — review the comparison, merge into Main (disk-asserted),
// or set the version aside. Zero git vocabulary anywhere.

// Hermetic driver probing: the gesture must take the bare dohc-tracked-run
// path (this test process acts as the agent) regardless of which agent CLIs
// happen to be installed on the host — a real driver would also make the
// perf measure include agent-process startup, which the budget excludes.
const NO_AGENT_TOOLS_ENV = {
  DOHC_AGENT_CODEX_COMMAND: "/nonexistent/dohc-e2e-no-agent",
  DOHC_AGENT_CLAUDE_ACP_COMMAND: "/nonexistent/dohc-e2e-no-agent",
  DOHC_AGENT_GENERIC_ACP_COMMAND: "/nonexistent/dohc-e2e-no-agent",
};

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
};

function engineSnapshotText(
  rootPath: string,
  versionId: string,
  path: string,
): string | null {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
      readOnly: true,
    });
  } catch {
    // engine.db may not exist yet while the app is still opening.
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT b.text AS text
         FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256
         WHERE s.version_id = ? AND s.path = ?`,
      )
      .get(versionId, path);
    return row ? String(row.text) : null;
  } finally {
    db.close();
  }
}

async function readWorkspaceText(rootPath: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(rootPath, path), "utf8");
  } catch {
    return null;
  }
}

async function expectActiveVersion(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("version-menu-active")).toHaveText(name, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("version-menu-button")).toBeEnabled();
}

// Drives the REAL gesture end to end through the product UI: version menu ->
// "Try in a version…" -> task -> Start. Resolves once the running banner is
// visible, returning the wall-clock milliseconds from Start to banner.
async function startTryGesture(page: Page, task: string): Promise<number> {
  await page.getByTestId("version-menu-button").click();
  await page.getByTestId("version-try").click();
  await expect(page.getByTestId("try-task-dialog")).toBeVisible();
  await page.getByTestId("try-task-input").fill(task);
  // Start enables once the driver probe settles (no drivers in CI -> a bare
  // dohc-tracked run the test process acts as the agent for).
  await expect(page.getByTestId("try-task-start")).toBeEnabled({ timeout: 15_000 });
  const startedAt = Date.now();
  await page.getByTestId("try-task-start").click();
  await expect(page.getByTestId("try-run-banner")).toBeVisible({ timeout: 20_000 });
  return Date.now() - startedAt;
}

async function tryRunState(
  page: Page,
  workspaceId: string,
): Promise<{ runId: string; versionId: string; status: string } | null> {
  return page.evaluate(async ({ id }) => {
    const api = (window as unknown as {
      dohcDesktop: {
        getTryInVersionState(payload: { workspaceId: string }): Promise<{
          state: { runId: string; versionId: string; status: string } | null;
        }>;
      };
    }).dohcDesktop;
    const result = await api.getTryInVersionState({ workspaceId: id });
    return result.state;
  }, { id: workspaceId });
}

async function endAgentRun(
  page: Page,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await page.evaluate(async ({ id, run }) => {
    const api = (window as unknown as {
      dohcDesktop: {
        endAgentRun(payload: { workspaceId: string; runId: string }): Promise<void>;
      };
    }).dohcDesktop;
    await api.endAgentRun({ workspaceId: id, runId: run });
  }, { id: workspaceId, run: runId });
}

test("the loop: try a task in a version, review, and merge lands on Main", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    // The perf-budget corpus: 200 engine-ownable text files.
    const corpus: WorkspaceFileWrite[] = Array.from({ length: 199 }, (_, i) => ({
      path: `notes/file-${String(i).padStart(3, "0")}.md`,
      contents: `note ${i}\n`,
    }));
    corpus.push({ path: "notes/plan.md", contents: "original plan\n" });
    await writeWorkspaceFiles(temp, corpus);

    desktop = await launchDesktopApp({ workspace: temp, env: NO_AGENT_TOOLS_ENV });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await expectActiveVersion(page, "Main");

    // Startup reconciliation must have captured the corpus into Main before
    // the gesture is timed — otherwise the measurement includes first-capture
    // of 200 files instead of the gesture itself.
    await expect
      .poll(() => engineSnapshotText(temp.rootPath, "main", "notes/plan.md"), {
        timeout: 60_000,
      })
      .toBe("original plan\n");

    const task = "Rewrite the plan into a calm summary";
    const uiMs = await startTryGesture(page, task);

    // The banner is honest about what is happening and where.
    await expect(page.getByTestId("try-run-banner-task")).toHaveText(task);
    await expect(page.getByTestId("try-run-banner")).toContainText(
      "in Try: Rewrite the plan into a calm summary",
    );
    await expectActiveVersion(page, "Try: Rewrite the plan into a calm summary");

    // Perf evidence (PR 0N-2 budget: create+switch+run-start < 1s on the
    // 200-file corpus, excluding agent startup). The main-process measure
    // brackets exactly the gesture composition.
    const marks = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktopTest: {
          getDesktopMarks(): Promise<{ measures: Record<string, number> }>;
        };
      }).dohcDesktopTest;
      return api.getDesktopMarks();
    });
    const gestureMs = marks.measures["try-in-version-gesture"];
    const opsMs = marks.measures["try-in-version-ops"];
    const runStartMs = marks.measures["try-in-version-run-start"];
    console.log(
      `[perf] try-in-version gesture (200-file corpus): main-side create+switch+run-start ${gestureMs}ms ` +
        `(workspace open/gate ${opsMs}ms, run start ${runStartMs}ms, ` +
        `fork+activate ${(gestureMs - opsMs - runStartMs).toFixed(0)}ms); ` +
        `Start click -> banner visible ${uiMs}ms`,
    );
    expect(gestureMs).toBeLessThan(1000);

    const running = await tryRunState(page, workspace.workspaceId);
    expect(running).not.toBeNull();
    expect(running?.status).toBe("running");
    const tryVersionId = running?.versionId ?? "";

    // The agent (this test process) edits the workspace while the run is
    // active — the 0N-1 pattern: physical writes, attributed by the run slot.
    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "calm summary\n" },
      { path: "notes/summary.md", contents: "summary of everything\n" },
    ]);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/summary.md");
    await expect
      .poll(
        () => engineSnapshotText(temp.rootPath, tryVersionId, "notes/plan.md"),
        { timeout: 30_000 },
      )
      .toBe("calm summary\n");
    // Main is untouched while the agent works in the try version.
    expect(engineSnapshotText(temp.rootPath, "main", "notes/plan.md")).toBe(
      "original plan\n",
    );

    // The run ends -> the review card appears with the changed-file count.
    await endAgentRun(page, workspace.workspaceId, running?.runId ?? "");
    await expect(page.getByTestId("try-review-card")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("try-review-summary")).toContainText(
      "2 files changed",
    );

    // History attributes the agent's edits (0N-1, signed out => "You's agent").
    const agentRow = page.locator(
      '[data-testid="engine-moment-open"][data-moment-path="notes/summary.md"]',
    );
    await expect(agentRow.first()).toBeVisible();
    await expect(
      agentRow.first().getByTestId("engine-moment-source"),
    ).toHaveText("You's agent");

    // Review changes opens the existing compare tab; the card stays.
    await page.getByTestId("try-review-open-compare").click();
    await expect(page.getByTestId("version-compare-page")).toBeVisible();
    await expect(
      page.locator(
        '[data-testid="version-compare-file"][data-compare-path="notes/plan.md"]',
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("try-review-card")).toBeVisible();

    // Merge into Main through the EXISTING merge flow; after Done, dohc
    // returns to Main so the folder shows the merged result.
    await page.getByTestId("try-review-merge").click();
    await expect(page.getByTestId("version-merge-dialog")).toBeVisible();
    await page.getByTestId("version-merge-confirm").click();
    await expect(page.getByTestId("version-merge-status")).toHaveText(
      /Merged 2 files into Main/,
      { timeout: 30_000 },
    );
    await page.getByTestId("version-merge-done").click();

    await expectActiveVersion(page, "Main");
    await expect(page.getByTestId("try-review-card")).toHaveCount(0);
    // Disk-asserted: Main's folder holds the agent's work.
    await expect
      .poll(() => readWorkspaceText(temp.rootPath, "notes/plan.md"), {
        timeout: 20_000,
      })
      .toBe("calm summary\n");
    expect(await readWorkspaceText(temp.rootPath, "notes/summary.md")).toBe(
      "summary of everything\n",
    );
    expect(engineSnapshotText(temp.rootPath, "main", "notes/plan.md")).toBe(
      "calm summary\n",
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a run that changes nothing says so, and set-aside returns to Main with the version kept", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "docs/readme.md", contents: "hello\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp, env: NO_AGENT_TOOLS_ENV });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await expectActiveVersion(page, "Main");

    const task = "Check the notes for typos";
    await startTryGesture(page, task);
    await expectActiveVersion(page, "Try: Check the notes for typos");

    // The agent finishes without touching anything.
    const running = await tryRunState(page, workspace.workspaceId);
    expect(running?.status).toBe("running");
    await endAgentRun(page, workspace.workspaceId, running?.runId ?? "");

    const card = page.getByTestId("try-review-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("The agent didn't change any files");
    // No merge/review actions for an empty result — just the way back.
    await expect(page.getByTestId("try-review-merge")).toHaveCount(0);
    await expect(page.getByTestId("try-review-open-compare")).toHaveCount(0);

    await page.getByTestId("try-review-back-to-main").click();
    await expectActiveVersion(page, "Main");
    await expect(card).toHaveCount(0);

    // No silent loss: the set-aside version remains in the versions list.
    await page.getByTestId("version-menu-button").click();
    await expect(
      page.locator(
        '[data-testid="version-item"][data-version-name="Try: Check the notes for typos"]',
      ),
    ).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
