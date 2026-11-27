import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityPin, settingsNavPin } from "../src/testPins";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openHistoryView,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

async function seedAgent(homeDir: string): Promise<string> {
  const settings: DesktopUserSettings = {
    ...DEFAULT_USER_SETTINGS,
    agents: {
      rover: { name: "Rover", hue: "olive", changesFiles: true, enabled: false, timeoutMinutes: 5 },
    },
  };
  await writeFile(join(homeDir, USER_SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
  return "rover";
}

async function startAgentRun(
  page: import("@playwright/test").Page,
  workspaceId: string,
  agentId: string,
): Promise<string> {
  return page.evaluate(
    async ({ id, agent }) => {
      const api = (
        window as unknown as {
          dohcDesktop: {
            startAgentRun(payload: {
              workspaceId: string;
              agentId: string;
            }): Promise<{ id: string }>;
          };
        }
      ).dohcDesktop;
      const run = await api.startAgentRun({ workspaceId: id, agentId: agent });
      return run.id;
    },
    { id: workspaceId, agent: agentId },
  );
}

async function endAgentRun(
  page: import("@playwright/test").Page,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await page.evaluate(
    async ({ id, run }) => {
      const api = (
        window as unknown as {
          dohcDesktop: {
            endAgentRun(payload: { workspaceId: string; runId: string }): Promise<void>;
          };
        }
      ).dohcDesktop;
      await api.endAgentRun({ workspaceId: id, runId: run });
    },
    { id: workspaceId, run: runId },
  );
}

async function setTheme(page: import("@playwright/test").Page, theme: "light" | "dark") {
  await page.getByTestId(activityPin("settings")).click();
  await page.getByTestId(settingsNavPin("appearance")).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await openHistoryView(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("groups a multi-file agent run in History and undoes only safe files after confirmation", async () => {
  const shotDir = process.env.PR5_SHOT_DIR;
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const agentId = await seedAgent(temp.homeDir);
    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "Initial plan\n" },
      { path: "notes/budget.md", contents: "Initial budget\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    await openHistoryView(page);
    await expect(
      page
        .locator('[data-testid="engine-moment-group"], [data-testid="engine-moment-open"]')
        .first(),
    ).toBeVisible();

    const runId = await startAgentRun(page, workspace.workspaceId, agentId);
    await writeWorkspaceFiles(temp, [{ path: "notes/plan.md", contents: "Rover plan update\n" }]);
    await expect(
      page
        .locator('[data-testid="engine-moment-open"][data-moment-path="notes/plan.md"]')
        .first()
        .getByTestId("engine-moment-source"),
    ).toHaveText("Rover");

    await writeWorkspaceFiles(temp, [
      { path: "notes/budget.md", contents: "Rover budget update\n" },
    ]);
    const roverGroup = page
      .getByTestId("engine-moment-group")
      .filter({ has: page.getByTestId("engine-moment-group-source").filter({ hasText: "Rover" }) });
    await expect(roverGroup).toBeVisible();
    await expect(roverGroup.getByTestId("engine-moment-group-toggle")).toContainText("2 files");

    await writeWorkspaceFiles(temp, [
      { path: "notes/checklist.md", contents: "Rover checklist\n" },
    ]);
    await expect(roverGroup.getByTestId("engine-moment-group-toggle")).toContainText("3 files");
    await expect(roverGroup.getByTestId("engine-moment-group-toggle")).toContainText("Agent run");
    await endAgentRun(page, workspace.workspaceId, runId);

    // A later edit by the user on budget.md must be skipped when undoing Rover's run.
    await writeWorkspaceFiles(temp, [
      { path: "notes/budget.md", contents: "User budget update\n" },
    ]);
    await expect(
      page
        .locator('[data-testid="engine-moment-open"][data-moment-path="notes/budget.md"]')
        .first()
        .getByTestId("engine-moment-source"),
    ).toHaveText("Local file edit");

    // Expand Rover's grouped run and verify Undo run… appears.
    await roverGroup.getByTestId("engine-moment-group-toggle").click();
    await expect(roverGroup.getByTestId("engine-moment-undo-run")).toBeVisible();

    if (shotDir) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const theme of ["light", "dark"] as const) {
        await setTheme(page, theme);
        const toggle = roverGroup.getByTestId("engine-moment-group-toggle");
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        await expect(roverGroup.getByTestId("engine-moment-undo-run")).toBeVisible();
        await page.screenshot({ path: join(shotDir, `history-group-${theme}.png`) });

        await roverGroup.getByTestId("engine-moment-undo-run").click();
        const dialog = page.getByTestId("agent-run-undo-dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId("agent-run-undo-confirm")).toBeVisible();
        await page.screenshot({ path: join(shotDir, `undo-dialog-${theme}.png`) });
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toBeHidden();
      }
      await setTheme(page, "light");
      const toggle = roverGroup.getByTestId("engine-moment-group-toggle");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
    }

    await roverGroup.getByTestId("engine-moment-undo-run").click();
    const dialog = page.getByTestId("agent-run-undo-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Undo changes from Rover");
    await expect(dialog).toContainText(
      "Files saved while Rover was running on the active version.",
    );
    await expect(
      dialog.locator(
        '[data-testid="agent-run-undo-restorable-item"][data-undo-path="notes/plan.md"]',
      ),
    ).toContainText("Restore earlier version");
    await expect(
      dialog.locator(
        '[data-testid="agent-run-undo-restorable-item"][data-undo-path="notes/checklist.md"]',
      ),
    ).toContainText("Remove created file");
    await expect(
      dialog.locator(
        '[data-testid="agent-run-undo-skipped-item"][data-skip-path="notes/budget.md"]',
      ),
    ).toContainText("Changed again after this agent run.");

    const confirm = dialog.getByTestId("agent-run-undo-confirm");
    await expect(confirm).toHaveText("Undo 2 files");
    await confirm.click();
    await expect(dialog).toBeHidden();

    // Verify disk state: plan.md restored, checklist.md removed, budget.md preserved.
    await expect
      .poll(async () => readFile(join(temp.rootPath, "notes/plan.md"), "utf8"))
      .toBe("Initial plan\n");
    await expect.poll(() => existsSync(join(temp.rootPath, "notes/checklist.md"))).toBe(false);
    expect(await readFile(join(temp.rootPath, "notes/budget.md"), "utf8")).toBe(
      "User budget update\n",
    );

    // Verify History records the grouped restore pass.
    const restoreGroup = page
      .getByTestId("engine-moment-group")
      .filter({ hasText: "Undid agent run" });
    await expect(restoreGroup).toBeVisible();
    await expect(restoreGroup.getByTestId("engine-moment-group-toggle")).toContainText("2 files");

    if (shotDir) {
      for (const theme of ["light", "dark"] as const) {
        await setTheme(page, theme);
        await expect(restoreGroup).toBeVisible();
        await page.screenshot({ path: join(shotDir, `history-restored-${theme}.png`) });
      }
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("offers Undo run on an agent run that made one change and restores that file", async () => {
  const shotDir = process.env.PR5_SHOT_DIR;
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const agentId = await seedAgent(temp.homeDir);
    await writeWorkspaceFiles(temp, [{ path: "notes/plan.md", contents: "Initial plan\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    await openHistoryView(page);
    await expect(page.getByTestId("engine-moment-open").first()).toBeVisible();

    const runId = await startAgentRun(page, workspace.workspaceId, agentId);
    await writeWorkspaceFiles(temp, [{ path: "notes/plan.md", contents: "Rover plan update\n" }]);
    const roverRun = page.getByTestId("engine-moment-run").filter({
      has: page.getByTestId("engine-moment-source").filter({ hasText: "Rover" }),
    });
    await expect(roverRun.getByTestId("engine-moment-run-toggle")).toHaveText("1 change");
    await endAgentRun(page, workspace.workspaceId, runId);

    await roverRun.getByTestId("engine-moment-run-toggle").click();
    await expect(roverRun.getByTestId("engine-moment-undo-run")).toBeVisible();
    if (shotDir) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const theme of ["light", "dark"] as const) {
        await setTheme(page, theme);
        const toggle = roverRun.getByTestId("engine-moment-run-toggle");
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        await expect(roverRun.getByTestId("engine-moment-undo-run")).toBeVisible();
        await page.screenshot({ path: join(shotDir, `history-single-run-${theme}.png`) });
      }
      await setTheme(page, "light");
      const toggle = roverRun.getByTestId("engine-moment-run-toggle");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }

    await roverRun.getByTestId("engine-moment-undo-run").click();
    const dialog = page.getByTestId("agent-run-undo-dialog");
    await expect(dialog).toContainText("Undo changes from Rover");
    await expect(
      dialog.locator(
        '[data-testid="agent-run-undo-restorable-item"][data-undo-path="notes/plan.md"]',
      ),
    ).toContainText("Restore earlier version");
    const confirm = dialog.getByTestId("agent-run-undo-confirm");
    await expect(confirm).toHaveText("Undo 1 file");
    await confirm.click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => readFile(join(temp.rootPath, "notes/plan.md"), "utf8"))
      .toBe("Initial plan\n");
    await expect(page.getByText("Undid agent run").first()).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
