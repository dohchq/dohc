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
import { activityPin, desktopPins } from "../src/testPins";
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
  // Rows show their time at rest; a pointer over one shows its dismiss button.
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    // Controls fade their colors into the new theme; a capture mid-fade
    // shows light fills under dark-theme text.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
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

// Answers the Members page's list as the relay would for a workspace whose
// members get `memberLevel`. No relay runs here, so without this the level
// can't be read.
async function supplyMembers(
  app: ElectronApplication,
  memberLevel: "view" | "comment" | "edit",
): Promise<void> {
  await app.evaluate(({ ipcMain }, level) => {
    type Handler = (...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    if (!handlers.has("desktop:workspace-members")) throw new Error("main has no Members handler");
    handlers.set("desktop:workspace-members", async (_event, input) => ({
      status: "ready",
      view: {
        workspaceId: (input as { workspaceId: string }).workspaceId,
        workspaceName: "Workspace",
        viewer: { memberId: "owner", role: "owner" },
        memberLevel: level,
        inviteLink: null,
        people: [],
      },
    }));
  }, memberLevel);
}

const buttonNames = (scope: Locator) =>
  scope
    .getByRole("button")
    .filter({
      hasText:
        /Restore rule|Restoring…|Allow new access|Allowing…|Remove rule|Removing…|Open Members/,
    })
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
      "Until you choose, dohc doesn't record or share changes in team.",
    );
    await expect(widened).toContainText("Restoring keeps the rule from outside dohc as a copy.");
    await expect(widened).toContainText("Members: View → Edit");
    expect(await buttonNames(widened)).toEqual(["Restore rule", "Allow new access"]);
    await shoot(page, "widened-toast");

    // The workspace's own rule is named as the workspace's. Without it,
    // members get the level set in Members settings, which dohc can't read
    // with no relay, so the notice says where it is set.
    await rm(join(temp.rootPath, "access.yaml"));
    const removed = toasts.filter({
      hasText: "The workspace's access rule was removed outside dohc",
    });
    await expect(removed).toHaveCount(1, { timeout: 30_000 });
    await expect(removed).toContainText(
      "Without it, members get the level set in Members settings. dohc can't read that level now.",
    );
    await expect(removed).toContainText("Members: View → set in Members settings");
    await expect(removed).not.toContainText("workspace access");
    expect(await buttonNames(removed)).toEqual(["Restore rule", "Remove rule", "Open Members"]);
    await shoot(page, "removed-root-unread-toast");

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
    await expect(held.first()).toContainText(
      "The workspace's access rule was removed outside dohc",
    );
    await expect(widenedRow).toContainText("Members: View → Edit");
    await expect(removedRow).toContainText("Members: View → set in Members settings");
    await shoot(page, "notices-rows");

    // Details leads with the rule dohc recorded, when dohc noticed the
    // change, and what members keep meanwhile, then each change. The row
    // shows the notice's own words, so Details leaves them out.
    await removedRow.getByRole("button", { name: "Details" }).click();
    const details = removedRow.locator("pre");
    await expect(details).toHaveText(
      /^Recorded rule: members: view\nNoticed: \S[^\n]*\nUntil you choose: Members keep their earlier access\.\nChange: Members: View → set in Members settings\n/,
    );
    await shoot(page, "details");
    await removedRow.getByRole("button", { name: "Hide details" }).click();

    // Open Members goes where the level is set.
    await removedRow.getByRole("button", { name: "Open Members" }).click();
    await expect(page.getByTestId("settings-members")).toBeVisible();
    await shoot(page, "open-members");
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.getByTestId("settings-members")).toHaveCount(0);
    await openNotices();

    // A choice on team waits for the workspace's own rule. Notices stays
    // open on it, and its row says so with nothing to retry.
    await widenedRow.getByRole("button", { name: "Allow new access" }).click();
    const waits = rows.filter({ hasText: "Choose for the workspace's access rule first" });
    await expect(waits).toHaveCount(1, { timeout: 30_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(waits).toContainText(
      "dohc didn't apply your choice for team. The workspace's access rule also changed outside dohc.",
    );
    await expect(waits.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await shoot(page, "nested-refusal");
    expect(await readFile(join(temp.rootPath, "team/access.yaml"), "utf8")).toBe(EDIT);
    await waits.getByRole("button", { name: "Show its notice" }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => removedRow.evaluate((row) => row.contains(document.activeElement)))
      .toBe(true);

    // The pressed button reads as working while the other waits, in Notices
    // as the person left it, with focus on the row.
    await holdDecisions(app);
    await removedRow.getByRole("button", { name: "Restore rule" }).click();
    await expect.poll(() => heldDecisions(app)).toBe(1);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(removedRow.getByRole("button", { name: "Restoring…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(removedRow.getByRole("button", { name: "Restoring…" })).toBeDisabled();
    await expect(removedRow.getByRole("button", { name: "Remove rule" })).toBeDisabled();
    expect(await removedRow.evaluate((row) => row.contains(document.activeElement))).toBe(true);
    await shoot(page, "busy-in-notices");
    await releaseDecisions(app);

    // The outcome files in Notices and takes focus. The choice that waited
    // for the workspace's rule waits for nothing now, so its row goes.
    const restored = rows.filter({ hasText: "Restored the workspace's access rule." });
    await expect(restored).toHaveCount(1, { timeout: 30_000 });
    await expect(restored).toContainText("Restored the workspace's access rule. Members can view.");
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
    await expect(waits).toHaveCount(0);
    await expect
      .poll(() => restored.evaluate((row) => row.contains(document.activeElement)))
      .toBe(true);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await shoot(page, "outcome-in-notices");

    // Allowing says what took effect, and Undo puts the recorded rule back
    // through the engine.
    await widenedRow.getByRole("button", { name: "Allow new access" }).click();
    const allowed = rows.filter({ hasText: "Members can now edit team." });
    await expect(allowed).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(async () => (await status()).heldAccessRules, { timeout: 30_000 })
      .toEqual([]);
    await shoot(page, "success-undo");
    expect(await readFile(join(temp.rootPath, "team/access.yaml"), "utf8")).toBe(EDIT);
    await allowed.getByRole("button", { name: "Undo" }).click();
    const undone = toasts.filter({ hasText: "team follows its earlier access rule again." });
    await expect(undone).toHaveCount(1, { timeout: 30_000 });
    await shoot(page, "undone");
    await expect
      .poll(async () => readFile(join(temp.rootPath, "team/access.yaml"), "utf8"), {
        timeout: 30_000,
      })
      .toBe(VIEW);
    // Undo is dohc's own change, so no new hold follows it.
    await expect
      .poll(async () => (await status()).heldAccessRules, { timeout: 30_000 })
      .toEqual([]);

    // An Undo after the rule changed again is refused. Trying again meets
    // the same rule, so the refusal points to History instead.
    await writeFile(join(temp.rootPath, "team/access.yaml"), EDIT);
    await expect
      .poll(async () => (await status()).heldAccessRules?.map((hold) => hold.folder), {
        timeout: 30_000,
      })
      .toEqual(["team"]);
    await openNotices();
    await widenedRow.getByRole("button", { name: "Allow new access" }).click();
    await expect(allowed).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(async () => (await status()).heldAccessRules, { timeout: 30_000 })
      .toEqual([]);
    await writeFile(join(temp.rootPath, "team/access.yaml"), "members: comment\n");
    await allowed.getByRole("button", { name: "Undo" }).click();
    const undoRefused = page
      .getByTestId("workspace-shell-error")
      .filter({ hasText: "dohc could not undo your choice for team" });
    await expect(undoRefused).toHaveCount(1, { timeout: 30_000 });
    await expect(undoRefused).toContainText(
      "The access rule for team changed since you chose. Its earlier versions are in History.",
    );
    await expect(undoRefused.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(undoRefused.getByRole("button", { name: "Open History" })).toBeVisible();
    await shoot(page, "undo-refused");
    expect(await readFile(join(temp.rootPath, "team/access.yaml"), "utf8")).toBe(
      "members: comment\n",
    );
    await openNotices();
    await expect(held).toHaveCount(0);

    // With the level readable, a root removal names it, and Remove rule says
    // what members can now do. The test supplies the Members answer.
    await supplyMembers(app, "comment");
    await rm(join(temp.rootPath, "access.yaml"));
    const resolvedRow = rows.filter({
      hasText: "The workspace's access rule was removed outside dohc",
    });
    await expect(resolvedRow).toHaveCount(1, { timeout: 30_000 });
    await expect(resolvedRow).toContainText("Members: View → Comment", { timeout: 30_000 });
    await expect(resolvedRow).toContainText(
      "Without it, members get the level set in Members settings.",
    );
    await expect(resolvedRow).not.toContainText("can't read that level");
    expect(await buttonNames(resolvedRow)).toEqual(["Restore rule", "Remove rule"]);
    // dohc holds the workspace's rule again, so the earlier Restore's Undo
    // goes. Its words stay.
    await expect(restored).toHaveCount(1);
    await expect(restored.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await shoot(page, "removed-root-resolved");

    // The level changes in Settings after the row showed it. Coming back
    // from Settings reads it again, and the row updates where it stands.
    await supplyMembers(app, "edit");
    await page.getByTestId(activityPin("settings")).click();
    await expect(page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.getByTestId(desktopPins.settingsDialog)).toHaveCount(0);
    await openNotices();
    await expect(resolvedRow).toContainText("Members: View → Edit", { timeout: 30_000 });
    await expect(resolvedRow).toHaveCount(1);
    await shoot(page, "level-read-again");

    // Another window changes it again before the owner chooses. Remove rule
    // reads it first, so the choice does not run and the row shows the level
    // it would give now.
    await supplyMembers(app, "view");
    await resolvedRow.getByRole("button", { name: "Remove rule" }).click();
    await expect(resolvedRow).toContainText("Members: View, no change", { timeout: 30_000 });
    await expect(resolvedRow.getByRole("button", { name: "Remove rule" })).toBeEnabled();
    expect((await status()).heldAccessRules?.map((hold) => hold.folder)).toEqual([""]);
    await expect(rows.filter({ hasText: "Removed the workspace's access rule." })).toHaveCount(0);
    await shoot(page, "level-changed-before-choice");
    await resolvedRow.getByRole("button", { name: "Remove rule" }).click();
    const removedDone = rows.filter({
      hasText: "Removed the workspace's access rule. Members can now view.",
    });
    await expect(removedDone).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(async () => (await status()).heldAccessRules, { timeout: 30_000 })
      .toEqual([]);
    await expect(resolvedRow).toHaveCount(0);
    await shoot(page, "removed-root-resolved-done");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
