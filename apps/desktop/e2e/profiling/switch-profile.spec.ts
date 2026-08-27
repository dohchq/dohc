import { expect, test, type Page } from "@playwright/test";
import { launchDesktopApp, type LaunchedDesktopApp } from "../helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceRegistry,
  waitForWorkspaceReady,
} from "../helpers/workspace";
import { startLongTaskObserver, stopLongTaskObserver } from "./cdpCapture";
import {
  prepareFixture,
  readRendererMarks,
  readSwitchTimeline,
  writeProfileArtifact,
} from "./harness";

const WORKSPACE_A_ID = "profile-switch-a";
const WORKSPACE_B_ID = "profile-switch-b";
const COMPLETION_PHASES = [
  "session-admitted",
  "files-painted",
  "files-revalidated",
  "history-ready",
  "restored-active-surface-ready",
] as const;

function switcherOption(page: Page, workspaceId: string) {
  return page
    .locator(
      `[data-testid="workspace-switcher-option"][data-workspace-id="${workspaceId}"]`,
    )
    .getByRole("button");
}

async function switchWorkspace(page: Page, workspaceId: string): Promise<number> {
  const before = await readSwitchTimeline(page);
  const previousOrdinal = before.at(-1)?.ordinal ?? 0;
  await page.getByTestId("workspace-switcher").click();
  await switcherOption(page, workspaceId).click();
  await waitForWorkspaceReady(page);
  await expect
    .poll(
      async () => {
        const entry = (await readSwitchTimeline(page)).at(-1);
        return Boolean(
          entry &&
            entry.ordinal > previousOrdinal &&
            COMPLETION_PHASES.every((phase) => entry.phases[phase] !== undefined),
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  return (await readSwitchTimeline(page)).at(-1)!.ordinal;
}

test("profiles ten A to B to A workspace switch cycles", async () => {
  const workspaceA = await prepareFixture("large-flat", WORKSPACE_A_ID, { engine: false });
  const workspaceB = await prepareFixture("large-deep", WORKSPACE_B_ID, { engine: false });
  const sandbox = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  try {
    await seedWorkspaceRegistry(sandbox, [
      { workspaceId: WORKSPACE_A_ID, rootPath: workspaceA.rootPath },
      { workspaceId: WORKSPACE_B_ID, rootPath: workspaceB.rootPath },
    ]);
    desktop = await launchDesktopApp({
      workspace: {
        baseDir: sandbox.baseDir,
        homeDir: sandbox.homeDir,
        rootPath: workspaceA.rootPath,
      },
    });
    const { page } = desktop;
    const active = await openWorkspaceFromFirstRun(page, { rootPath: workspaceA.rootPath });
    expect(active.workspaceId).toBe(WORKSPACE_A_ID);

    // Open both once before measuring. The 20-entry ring then contains exactly
    // the ten measured B/A cycles and drops these warm-up entries.
    await switchWorkspace(page, WORKSPACE_B_ID);
    await switchWorkspace(page, WORKSPACE_A_ID);
    const baselineOrdinal = (await readSwitchTimeline(page)).at(-1)?.ordinal ?? 0;

    await startLongTaskObserver(page);
    const startedAt = performance.now();
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await switchWorkspace(page, WORKSPACE_B_ID);
      await switchWorkspace(page, WORKSPACE_A_ID);
    }
    const elapsedMs = performance.now() - startedAt;
    const longTasks = await stopLongTaskObserver(page);
    const timeline = (await readSwitchTimeline(page)).filter(
      ({ ordinal }) => ordinal > baselineOrdinal,
    );
    expect(timeline).toHaveLength(20);

    await writeProfileArtifact("switch-profile", {
      fixture: {
        a: { name: "large-flat", workspaceId: WORKSPACE_A_ID },
        b: { name: "large-deep", workspaceId: WORKSPACE_B_ID },
        seed: workspaceA.manifest.seed,
      },
      measurements: {
        cycles: 10,
        switches: timeline.length,
        elapsedMs,
        timeline,
        rendererMarks: await readRendererMarks(page),
        longTasks,
        reactCommitCount: null,
        reactCommitCountSource: "unavailable",
      },
    });
  } finally {
    await cleanupDesktopWorkspace(desktop, sandbox);
  }
});
