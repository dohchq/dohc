import { randomUUID } from "node:crypto";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
} from "../src/testing/realDaemonWorkspaceSessions";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
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

// Holds main's handler for access rule decisions behind a gate, as
// shared-continuity.spec.ts holds editor updates: Electron looks the handler
// up in ipcMain._invokeHandlers on each invoke. Release puts the original
// back and lets the held call through it.
async function holdDecisions(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const channel = "desktop:decide-access-rule";
    const original = handlers.get(channel);
    if (!original) throw new Error("main has no access rule decision handler");
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const state = {
      entered: 0,
      release: () => {
        handlers.set(channel, original);
        open();
      },
    };
    (globalThis as { __dohcHeldDecisions?: typeof state }).__dohcHeldDecisions = state;
    handlers.set(channel, async (...args) => {
      state.entered += 1;
      await gate;
      return original(...args);
    });
  });
}
const heldDecisions = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as { __dohcHeldDecisions?: { entered: number } }).__dohcHeldDecisions?.entered ??
      0,
  );
const releaseDecisions = (app: ElectronApplication) =>
  app.evaluate(() =>
    (globalThis as { __dohcHeldDecisions?: { release(): void } }).__dohcHeldDecisions?.release(),
  );

const buttonNames = (scope: Locator) =>
  scope
    .getByRole("button")
    .filter({ hasText: /Restore rule|Restoring…|Allow new access|Allowing…|Remove rule|Removing…/ })
    .allTextContents();

test("an access rule changed outside dohc waits for its owner in Notices until they decide @capture-holds", async () => {
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
    const { page, app } = desktop;
    const status = () =>
      page.evaluate(
        async (id) =>
          (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.getSyncStatus({
            workspaceId: id,
          }),
        workspace.workspaceId,
      );
    const toasts = page.getByTestId("workspace-shell-notice");

    // A widening lists who reaches the folder differently, and Restore rule
    // comes first.
    await writeFile(join(temp.rootPath, "team/access.yaml"), EDIT);
    const widened = toasts.filter({ hasText: "Access to team was widened outside dohc" });
    await expect(widened).toHaveCount(1, { timeout: 30_000 });
    await expect(widened).toContainText(
      "Until you choose, dohc doesn't record or share changes in team, and members keep their earlier access.",
    );
    await expect(widened).toContainText("members: View → Edit");
    expect(await buttonNames(widened)).toEqual(["Restore rule", "Allow new access"]);
    await shoot(page, "widened-toast");

    // The workspace's own rule is named as the workspace's, and its removal
    // says what the workspace follows without it.
    await rm(join(temp.rootPath, "access.yaml"));
    const removed = toasts.filter({
      hasText: "The workspace's access rule was removed outside dohc",
    });
    await expect(removed).toHaveCount(1, { timeout: 30_000 });
    await expect(removed).toContainText(
      "Without it, this workspace follows each member's workspace access.",
    );
    await expect(removed).toContainText("members: View → workspace access");
    expect(await buttonNames(removed)).toEqual(["Restore rule", "Remove rule"]);
    await shoot(page, "removed-root-toast");

    const toggle = page.getByTestId("notice-center-toggle");
    const openNotices = async () => {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    };
    await openNotices();
    const rows = page.locator("[data-notice-row]");
    const held = rows.filter({ hasText: "outside dohc" });
    const widenedRow = rows.filter({ hasText: "Access to team was widened outside dohc" });
    const removedRow = rows.filter({
      hasText: "The workspace's access rule was removed outside dohc",
    });
    // The outer folder leads, since an inner folder's decision waits for it.
    await expect(held).toHaveCount(2);
    await expect(held.first()).toContainText(
      "The workspace's access rule was removed outside dohc",
    );
    await expect(widenedRow).toContainText("members: View → Edit");
    await expect(removedRow).toContainText("members: View → workspace access");
    await shoot(page, "notices-rows");

    // Details shows the rule dohc recorded and when dohc noticed the change.
    await removedRow.getByRole("button", { name: "Details" }).click();
    const details = removedRow.locator("pre");
    await expect(details).toContainText("Recorded rule: members: view");
    await expect(details).toContainText(/Noticed: \d{4}-\d\d-\d\dT/);
    await shoot(page, "details");
    await removedRow.getByRole("button", { name: "Hide details" }).click();

    // A decision on team waits for the workspace's own rule. Its refusal
    // says so and shows the outer row; nothing is retried.
    await widenedRow.getByRole("button", { name: "Allow new access" }).click();
    const waits = toasts.filter({ hasText: "Decide this workspace first" });
    await expect(waits).toHaveCount(1, { timeout: 30_000 });
    await expect(waits).toContainText("The workspace's access rule also changed outside dohc.");
    await expect(waits.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await shoot(page, "nested-refusal");
    expect(await readFile(join(temp.rootPath, "team/access.yaml"), "utf8")).toBe(EDIT);
    await waits.getByRole("button", { name: "Show workspace" }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => removedRow.evaluate((row) => row.contains(document.activeElement)))
      .toBe(true);

    // The pressed button reads as working while the other waits.
    await holdDecisions(app);
    await removedRow.getByRole("button", { name: "Restore rule" }).click();
    await expect.poll(() => heldDecisions(app)).toBe(1);
    // A step closes Notices as it runs; the row waits there.
    await openNotices();
    await expect(removedRow.getByRole("button", { name: "Restoring…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(removedRow.getByRole("button", { name: "Restoring…" })).toBeDisabled();
    await expect(removedRow.getByRole("button", { name: "Remove rule" })).toBeDisabled();
    await shoot(page, "busy");
    // Notices lists what arrives while it is open; closed, the result toasts.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await releaseDecisions(app);

    const restored = toasts.filter({ hasText: "Restored the workspace's access rule." });
    await expect(restored).toHaveCount(1, { timeout: 30_000 });
    await expect(restored.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect
      .poll(async () => readFile(join(temp.rootPath, "access.yaml"), "utf8"), { timeout: 30_000 })
      .toBe(VIEW);
    await expect
      .poll(async () => (await status()).heldAccessRules?.map((hold) => hold.folder), {
        timeout: 30_000,
      })
      .toEqual(["team"]);
    await expect(removedRow).toHaveCount(0);

    // Allowing says what took effect, and Undo puts the recorded rule back.
    await openNotices();
    await widenedRow.getByRole("button", { name: "Allow new access" }).click();
    const allowed = toasts.filter({ hasText: "Members now reach team at Edit." });
    await expect(allowed).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(async () => (await status()).heldAccessRules, { timeout: 30_000 })
      .toEqual([]);
    await shoot(page, "success-undo");
    expect(await readFile(join(temp.rootPath, "team/access.yaml"), "utf8")).toBe(EDIT);
    await allowed.getByRole("button", { name: "Undo" }).click();
    await expect
      .poll(async () => readFile(join(temp.rootPath, "team/access.yaml"), "utf8"), {
        timeout: 30_000,
      })
      .toBe(VIEW);
    // Undo is dohc's own change, so no new hold follows it.
    await expect
      .poll(async () => (await status()).heldAccessRules, { timeout: 30_000 })
      .toEqual([]);
    await openNotices();
    await expect(held).toHaveCount(0);
    await expect(page.getByText(/could not/)).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
