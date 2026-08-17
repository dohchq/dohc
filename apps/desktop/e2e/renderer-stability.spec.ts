import { expect, test } from "@playwright/test";
import { launchDesktopApp, type DesktopLogEntry } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Renderer stability (bullet 11: "the app crashes a lot when just playing
// around and clicking stuff — blank screen"). Two regression gates:
//
//   1. An aggressive click-around session (open/close/switch tabs across
//      every file kind, toggle panels and views, quick-open, history rail)
//      must leave the shell mounted with ZERO uncaught renderer errors —
//      any pageerror here is exactly the class of throw that used to unmount
//      the whole React tree to a blank window.
//   2. A real renderer-process crash must RECOVER: main's render-process-gone
//      handler reloads the window instead of leaving it permanently blank.

function rendererErrors(logs: DesktopLogEntry[]): string[] {
  return logs
    .filter(
      (entry) =>
        entry.source === "renderer" &&
        (entry.level === "pageerror" ||
          // The boundary/global reporters log crashes through console.error —
          // a contained crash is still a bug during a plain click-around.
          (entry.level === "error" &&
            /\[desktop\] (renderer crash|uncaught renderer error|unhandled promise rejection)/.test(
              entry.text,
            ))),
    )
    .map((entry) => `${entry.level}: ${entry.text}`);
}

test("aggressive click-around keeps the shell mounted with no renderer errors", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      {
        path: "notes/alpha.md",
        contents: "# Alpha\n\nSome **rich** text with a [[beta]] link.\n\n- a\n- b\n",
      },
      { path: "notes/beta.md", contents: "# Beta\n\n| a | b |\n| - | - |\n| 1 | 2 |\n" },
      { path: "data/table.csv", contents: "name,count\nalpha,1\nbeta,2\n" },
      { path: "config.json", contents: '{\n  "ok": true\n}\n' },
      { path: "readme.txt", contents: "plain text file\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    const shell = page.getByTestId("workspace-shell");
    const paths = [
      "notes/alpha.md",
      "notes/beta.md",
      "data/table.csv",
      "config.json",
      "readme.txt",
    ];

    // Reveal the folders once, then hammer the hot paths.
    for (const folder of ["notes", "data"]) {
      await explorerRow(page, folder).click();
    }

    for (let round = 0; round < 2; round += 1) {
      // Open every file kind (markdown WYSIWYG, csv table, json/text editors).
      for (const path of paths) {
        await explorerRow(page, path).click();
        await expect(page.getByTestId(`tab-${path}`)).toBeVisible();
      }

      // Rapid tab switching straight across the strip.
      for (const path of paths) {
        await page.getByTestId(`tab-${path}`).click();
      }

      // Panel toggles: sidebar off/on, activity views, history rail off/on.
      await page.keyboard.press("Control+b");
      await page.keyboard.press("Control+b");
      for (const view of ["search", "graph", "history", "explorer"]) {
        await page.getByTestId(`activity-${view}`).click();
      }
      const railToggle = page.getByTestId("history-collapse");
      if (await railToggle.isVisible()) {
        await railToggle.click();
        await page.getByTestId("history-restore").click();
      }

      // Quick-open in and out.
      await page.keyboard.press("Control+p");
      await expect(page.getByTestId("quick-open")).toBeVisible();
      await page.keyboard.press("Escape");

      // Close every tab from the strip while views remount underneath.
      for (const path of [...paths].reverse()) {
        await page
          .getByTestId(`tab-${path}`)
          .getByRole("button", { name: /^Close / })
          .click();
        await expect(page.getByTestId(`tab-${path}`)).toHaveCount(0);
      }
    }

    // The whole session must end with the shell alive and the renderer clean:
    // no crash screen, no contained boundary card, no uncaught errors.
    await expect(shell).toBeVisible();
    await expect(page.getByTestId("app-crash-screen")).toHaveCount(0);
    await expect(page.locator("[data-testid^='error-boundary-']")).toHaveCount(0);
    expect(rendererErrors(desktop.logs)).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a crashed renderer reloads back to the workspace instead of staying blank", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      { path: "hello.md", contents: "# Hello\n\ncontent\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);

    // Kill the renderer process for real — exactly the "blank window" failure
    // users hit. Before the render-process-gone handler this stayed blank
    // forever; now main reloads the window.
    await desktop.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
    });

    // Assert recovery from the MAIN process (the Playwright page object is
    // attached to the crashed renderer). executeJavaScript can HANG when the
    // webContents is mid-crash/mid-reload, so every probe races a short
    // in-main timeout — the next poll tick simply asks again.
    await expect
      .poll(
        () =>
          desktop!.app.evaluate(async ({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            if (
              !window ||
              window.webContents.isCrashed() ||
              window.webContents.isLoading()
            ) {
              return false;
            }
            const mounted = window.webContents
              .executeJavaScript(
                "Boolean(document.querySelector('[data-testid=\"workspace-shell\"]'))",
              )
              .catch(() => false);
            const probeTimeout = new Promise<false>((resolve) =>
              setTimeout(() => resolve(false), 1_000),
            );
            return (await Promise.race([mounted, probeTimeout])) as boolean;
          }),
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true);

    // The handler must have logged the crash + reload decision.
    expect(
      desktop.logs.some((entry) =>
        entry.text.includes("[desktop] renderer process gone"),
      ),
    ).toBe(true);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
