import { expect, test, type Page } from "@playwright/test";
import { addFileChanges, createChangeSet } from "@dohc/workspace-core";
import { createChangeSetStore } from "@dohc/workspace-history";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchApp } from "./launch";

// Phase E5 catch-up gate: the History view summarizes workspace changes since
// the user last marked themselves caught-up, then persists that cursor in
// .dohc/ui-state.json.

const SCREENSHOT_DIR = "test-results/screenshots/e5-catch-up";

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

async function seedWorkspace(
  workspaceId: string,
  files: Record<string, string>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-e5-catch-up-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-e5-catch-up-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" }),
  );
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
  }
  return { home, root };
}

async function openSeeded(home: string, root?: string) {
  const app = await launchApp({
    DOHC_TEST_HOME: home,
    ...(root ? { DOHC_TEST_PICK_PATH: root } : {}),
  });
  const page = await app.firstWindow();
  if (root) {
    await page.getByRole("button", { name: /open an existing folder/i }).click();
  }
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  return { app, page };
}

test("catch-up summarizes unseen history and persists the caught-up cursor", async () => {
  const { home, root } = await seedWorkspace("e5-catch-up", {
    "notes/plan.md": "# Plan\n",
  });
  await createChangeSetStore(root).record(
    addFileChanges(
      createChangeSet({
        kind: "user-edit",
        author: { kind: "user", userId: "ice" },
        summary: "Edited plan",
      }),
      [{ path: "notes/plan.md", operation: "write" }],
    ),
    { id: "seed-plan", recordedAtMs: 1000 },
  );

  const { app, page } = await openSeeded(home, root);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("activity-history").click();
  const catchUp = page.getByTestId("side-panel").getByTestId("catch-up-summary");

  await expect(catchUp).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(catchUp.getByTestId("catch-up-line")).toContainText(
    "ice edited notes/plan.md",
  );

  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await shot(page, "catch-up");
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await shot(page, "catch-up");
  }

  await catchUp.getByTestId("catch-up-mark-seen").click();
  await expect(catchUp).toContainText("You're caught up.");
  const uiStatePath = join(root, ".dohc", "ui-state.json");
  await expect
    .poll(
      () => {
        try {
          const state = JSON.parse(readFileSync(uiStatePath, "utf8")) as {
            lastCatchUpSeenAtMs?: number;
            lastCatchUpSeenChangeSetId?: string;
            lastCatchUpSeenHistoryIndex?: number;
          };
          return [
            state.lastCatchUpSeenAtMs ?? 0,
            state.lastCatchUpSeenChangeSetId ?? "",
            state.lastCatchUpSeenHistoryIndex ?? -1,
          ].join(":");
        } catch {
          return "";
        }
      },
      { timeout: 5000 },
    )
    .toBe("1000:seed-plan:0");
  await app.close();

  const second = await openSeeded(home);
  const secondCatchUp = second.page
    .getByTestId("history-timeline")
    .getByTestId("catch-up-summary");
  await expect(secondCatchUp).toContainText("You're caught up.");
  await expect(secondCatchUp.getByTestId("catch-up-line")).toHaveCount(0);
  await second.app.close();

  await writeFile(join(root, "notes", "skewed.md"), "# Skewed\n");
  await createChangeSetStore(root).record(
    addFileChanges(
      createChangeSet({
        kind: "user-edit",
        author: { kind: "user", userId: "ice" },
        summary: "Edited skewed note",
      }),
      [{ path: "notes/skewed.md", operation: "write" }],
    ),
    { id: "clock-skewed", recordedAtMs: 500 },
  );

  const third = await openSeeded(home);
  const thirdCatchUp = third.page
    .getByTestId("history-timeline")
    .getByTestId("catch-up-summary");
  await expect(thirdCatchUp.getByTestId("catch-up-line")).toContainText(
    "ice edited notes/skewed.md",
  );
  await third.app.close();
});

test("catch-up explains visible conflict files without Git markers", async () => {
  const { home, root } = await seedWorkspace("e5-catch-up-conflict", {
    "notes/plan.md": "# Local plan\n",
    "notes/plan.md.conflict": "# Other version\n",
  });

  const { app, page } = await openSeeded(home, root);
  await page.getByTestId("activity-history").click();
  const conflict = page
    .getByTestId("side-panel")
    .getByTestId("catch-up-conflict");

  await expect(conflict).toContainText("Both sides changed notes/plan.md");
  await expect(conflict).toContainText("notes/plan.md.conflict stores the other version");
  await expect(conflict).not.toContainText("<<<<<<<");
  await app.close();
});
