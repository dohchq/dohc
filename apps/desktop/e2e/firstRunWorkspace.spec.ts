import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page } from "playwright";
import { launchApp } from "./launch";

const SCREENSHOT_DIR = "test-results/screenshots/phase-03";

async function launchFirstRun(): Promise<{
  app: ElectronApplication;
  page: Page;
  testHome: string;
}> {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();
  return { app, page, testHome };
}

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

async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(0);
  expect(overflow.y).toBeLessThanOrEqual(0);
}

test("first run creates a real workspace folder and lands in a native shell", async () => {
  const { app, page, testHome } = await launchFirstRun();

  // --- First run: suggests <home>/dohc, no login, cloud sync optional ---
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
  await expect(page.getByText(join(testHome, "dohc"))).toBeVisible();
  await expect(page.getByText(/cloud sync is optional/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /enable dohc cloud sync/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /sign in|log in|sign up/i }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectNoOverflow(page);
  await shot(page, "first-run");

  // --- Create the workspace: a real folder must appear on disk ---
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  const workspaceRoot = join(testHome, "dohc", "personal");
  expect(existsSync(join(workspaceRoot, ".dohc", "manifest.json"))).toBe(true);
  const manifest = JSON.parse(
    readFileSync(join(workspaceRoot, ".dohc", "manifest.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    version: 1,
    kind: "personal",
    mode: "local-first",
  });

  // --- Shell surfaces: sidebar/file tree, status, history timeline ---
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await expect(page.getByTestId("sync-status")).toBeVisible();
  await expect(page.getByTestId("history-timeline")).toBeVisible();
  // History is a panel with a designed empty state, not a paragraph dump.
  await expect(page.getByTestId("history-timeline")).toContainText(
    /no changes yet/i,
  );

  // --- Keyboard: new file ---
  await page.keyboard.press("ControlOrMeta+n");
  const nameInput = page.getByRole("textbox", { name: /file name/i });
  await expect(nameInput).toBeVisible();
  await nameInput.fill("notes/today.md");
  await nameInput.press("Enter");
  await expect(
    page.getByTestId("file-tree").getByText("today.md"),
  ).toBeVisible();
  expect(existsSync(join(workspaceRoot, "notes", "today.md"))).toBe(true);

  // --- The watcher records the change into the visible history timeline ---
  await expect(page.getByTestId("history-timeline")).toContainText(
    /today\.md/i,
    { timeout: 15_000 },
  );
  // The watcher must NEVER record its own .dohc writes (feedback loop): the
  // timeline shows user files only.
  await expect(page.getByTestId("history-timeline")).not.toContainText(".dohc");

  // --- Keyboard: command palette opens, filters, closes ---
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option")).toHaveCount(5);
  await expect(palette).toContainText(/import files/i);
  await expect(palette).toContainText(/connect dohc cloud/i);
  await page.keyboard.type("new");
  await expect(palette.getByRole("option").first()).toContainText(/new/i);
  await shot(page, "command-palette");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // --- Keyboard: quick-open jumps to a file ---
  await page.keyboard.press("ControlOrMeta+p");
  const quickOpen = page.getByTestId("quick-open");
  await expect(quickOpen).toBeVisible();
  await page.keyboard.type("today");
  await expect(quickOpen.getByRole("option").first()).toContainText(
    "notes/today.md",
  );
  await page.keyboard.press("Enter");
  await expect(quickOpen).toHaveCount(0);
  await expect(page.getByTestId("workspace-shell")).toContainText(
    "notes/today.md",
  );
  await shot(page, "file-preview");

  // --- Workspace switcher lists the current workspace ---
  await page.getByTestId("workspace-switcher").click();
  const switcherList = page.getByRole("listbox", { name: /workspaces/i });
  await expect(switcherList.getByRole("option")).toHaveCount(1);
  await expect(switcherList).toContainText("personal");
  await page.getByTestId("workspace-switcher").click();

  // --- Cloud connect is an honest surface, not a gate ---
  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
  await expect(page.getByTestId("cloud-sync-panel")).toContainText(
    /fully functional locally/i,
  );
  await page.mouse.click(10, 10); // backdrop click closes
  await expect(page.getByTestId("cloud-sync-panel")).toHaveCount(0);

  // --- Layout holds at both required sizes, light and dark ---
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await expectNoOverflow(page);
    await shot(page, "workspace-shell");
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.dataset.theme),
    )
    .toBe("dark");
  await expectNoOverflow(page);
  await shot(page, "workspace-shell");
  await page.emulateMedia({ colorScheme: "light" });

  // --- No marketing chrome anywhere in the shell ---
  await expect(
    page.getByText(/get started free|pricing|trusted by/i),
  ).toHaveCount(0);

  await app.close();
});

test("attaching an existing dohc workspace preserves its identity", async () => {
  // Pre-create a workspace folder with a known manifest identity.
  const elsewhere = await mkdtemp(join(tmpdir(), "dohc-existing-"));
  const existingRoot = join(elsewhere, "finance");
  await mkdir(join(existingRoot, ".dohc"), { recursive: true });
  await writeFile(
    join(existingRoot, ".dohc", "manifest.json"),
    JSON.stringify({
      version: 1,
      workspaceId: "ws-keep-this-identity",
      kind: "personal",
      mode: "local-first",
    }),
  );
  await writeFile(join(existingRoot, "budget.md"), "# Budget");

  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app = await launchApp({
    DOHC_TEST_HOME: testHome,
    DOHC_TEST_PICK_PATH: existingRoot,
  });
  const page = await app.firstWindow();

  await page
    .getByRole("button", { name: /open an existing folder/i })
    .click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await expect(page.getByTestId("file-tree")).toContainText("budget.md");

  // Identity preserved: the manifest still carries the original workspaceId.
  const manifest = JSON.parse(
    readFileSync(join(existingRoot, ".dohc", "manifest.json"), "utf8"),
  );
  expect(manifest.workspaceId).toBe("ws-keep-this-identity");

  await app.close();
});

test("returning user lands directly in the shell, not first-run", async () => {
  const { app, page, testHome } = await launchFirstRun();
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await app.close();

  // Relaunch with the same test home: registry remembers the workspace.
  const second = await launchApp({ DOHC_TEST_HOME: testHome });
  const page2 = await second.firstWindow();
  await expect(page2.getByTestId("workspace-shell")).toBeVisible();
  await expect(
    page2.getByRole("button", { name: /create workspace/i }),
  ).toHaveCount(0);
  await second.close();
});
