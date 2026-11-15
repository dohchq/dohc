import { randomUUID } from "node:crypto";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
} from "../src/testing/realDaemonWorkspaceSessions";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { expect, test, type Page } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const VIEW = "members: view\n";
const EDIT = "members: edit\n";

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({ path: test.info().outputPath(`${name}-${theme}.png`) });
  }
}

test("an access rule changed outside dohc waits for its owner in Notices until Restore rule @capture-holds", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "access.yaml", contents: VIEW },
      { path: "plan.md", contents: "Plan.\n" },
      { path: "team/access.yaml", contents: VIEW },
      { path: "team/a.md", contents: "Team.\n" },
    ]);
    const workspaceId = randomUUID();
    await seedWorkspaceManifest(temp, workspaceId);
    // Both rules reach History before the desktop opens, so the changes
    // below are judged against them.
    const lifecycle = createRealDaemonLifecycle({ command: resolveEngineBinary(), maxRestarts: 0 });
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const seeded = { workspaceId, rootPath: temp.rootPath, attachmentId: Symbol("seed") };
    await lifecycle.start();
    try {
      await sessions.run(seeded, async ({ client, workspace: handle }) => {
        const adapter = new VersionedLiveAdapter(client, handle, { workspaceId });
        await expect
          .poll(
            async () => {
              await adapter.flushCapture();
              const { moments } = await adapter.listMoments({ workspaceId, limit: 50 });
              return moments
                .map((moment) => moment.path)
                .filter((path) => path.endsWith("access.yaml"))
                .sort();
            },
            { timeout: 30_000 },
          )
          .toEqual(["access.yaml", "team/access.yaml"]);
      });
    } finally {
      await sessions.closeWorkspace(seeded);
      await lifecycle.stop();
    }

    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    const status = () =>
      page.evaluate(
        async (id) =>
          (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.getSyncStatus({
            workspaceId: id,
          }),
        workspace.workspaceId,
      );

    await writeFile(join(temp.rootPath, "team/access.yaml"), EDIT);
    const widened = page
      .getByTestId("workspace-shell-notice")
      .filter({ hasText: "Access for team was widened outside dohc" });
    await expect(widened).toHaveCount(1, { timeout: 30_000 });
    await expect(widened.getByRole("button", { name: "Allow" })).toBeVisible();
    await expect(widened.getByRole("button", { name: "Restore rule" })).toBeVisible();
    await shoot(page, "widened-toast");

    await rm(join(temp.rootPath, "access.yaml"));
    // The workspace's own rule is named by the workspace, as the title bar names it.
    const name = temp.rootPath.split(/[\\/]/).pop()!;
    const removed = page
      .getByTestId("workspace-shell-notice")
      .filter({ hasText: "was removed outside dohc" });
    await expect(removed).toHaveCount(1, { timeout: 30_000 });
    await expect(removed).toContainText(`The access rule for ${name} was removed outside dohc`);
    await expect(removed.getByRole("button", { name: "Remove access" })).toBeVisible();
    await shoot(page, "removed-toast");

    const toggle = page.getByTestId("notice-center-toggle");
    const openNotices = async () => {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    };
    await openNotices();
    const rows = page.locator("[data-notice-row]");
    const widenedRow = rows.filter({ hasText: "Access for team was widened outside dohc" });
    const removedRow = rows.filter({ hasText: "was removed outside dohc" });
    await expect(widenedRow).toHaveCount(1);
    await expect(removedRow).toHaveCount(1);
    await shoot(page, "notices");

    // The workspace's own rule is above team's, so it is decided first: a
    // rule cannot change under a folder whose rule waits for its owner.
    await removedRow.getByRole("button", { name: "Restore rule" }).click();
    await expect
      .poll(async () => readFile(join(temp.rootPath, "access.yaml"), "utf8"), { timeout: 30_000 })
      .toBe(VIEW);
    await expect
      .poll(async () => (await status()).heldAccessRules?.map((hold) => hold.folder), {
        timeout: 30_000,
      })
      .toEqual(["team"]);
    await openNotices();
    await expect(removedRow).toHaveCount(0);
    await widenedRow.getByRole("button", { name: "Restore rule" }).click();
    await expect
      .poll(async () => readFile(join(temp.rootPath, "team/access.yaml"), "utf8"), {
        timeout: 30_000,
      })
      .toBe(VIEW);
    await expect
      .poll(async () => (await status()).heldAccessRules, { timeout: 30_000 })
      .toEqual([]);
    await openNotices();
    await expect(rows.filter({ hasText: "outside dohc" })).toHaveCount(0);
    await expect(
      page.getByTestId("workspace-shell-notice").filter({ hasText: "could not" }),
    ).toHaveCount(0);
    expect((await status()).heldAccessRules).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
