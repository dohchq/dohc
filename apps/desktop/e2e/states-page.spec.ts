import { expect, test, type Page } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

// The states page (@states-page): every shared part in every state, light
// beside dark. One baseline per theme lives in states-page.spec.ts-snapshots;
// a change to a shared part shows up here as a pixel difference. Update the
// baselines with `--update-snapshots` when the change is the point of the PR.
//
// The captures are made deterministic by construction: a fixed viewport with
// no scrollbar, a pinned color scheme, reduced motion and disabled
// animations, states forced through the browser instead of pointer events,
// and a check that Inter and IBM Plex Mono are in before comparing. The
// baselines were taken on Windows; Playwright names them per platform.

const STATES_PAGE_HASH = "#/dev/states";

async function withDesktop(
  env: NodeJS.ProcessEnv,
  flow: (page: Page) => Promise<void>,
): Promise<void> {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp, env });
    await flow(desktop.page);
  } finally {
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
}

// Every element marked `data-force-state` gets that pseudo-class forced
// through the browser, so the part's own :hover, :focus-visible or :focus
// rules apply. `data-force-target` names a descendant to force instead.
async function forceMarkedStates(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: "[data-force-state]",
  });
  for (const nodeId of nodeIds) {
    const { attributes } = await cdp.send("DOM.getAttributes", { nodeId });
    const marks = new Map<string, string>();
    for (let index = 0; index < attributes.length; index += 2) {
      marks.set(attributes[index] ?? "", attributes[index + 1] ?? "");
    }
    const state = marks.get("data-force-state");
    if (!state) continue;
    const target = marks.get("data-force-target");
    const targetId = target
      ? (await cdp.send("DOM.querySelector", { nodeId, selector: target })).nodeId
      : nodeId;
    if (!targetId) throw new Error(`no element matches data-force-target="${target}"`);
    await cdp.send("CSS.forcePseudoState", { nodeId: targetId, forcedPseudoClasses: state.split(" ") });
  }
}

// Opened from the keyboard: a pointer left over the trigger would land on a
// menu item when the opened menu scrolls itself into view, and move the
// selection with it.
async function openDocumentMenu(page: Page, pane: ReturnType<Page["getByTestId"]>): Promise<void> {
  await pane.getByRole("button", { name: "Document actions" }).focus();
  await page.keyboard.press("Enter");
  await expect(pane.getByRole("menu", { name: "Document actions" })).toBeVisible();
}

test("@states-page every shared part matches its baseline in both themes", async () => {
  test.skip(process.platform !== "win32", "the baselines were taken on Windows");
  test.setTimeout(120_000);
  await withDesktop({ DOHC_DEV_TOOLS: "1" }, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    // The page is taller than the viewport. A scrollbar would narrow the
    // layout while the capture measures and widen it while it paints.
    // Appended directly: addStyleTag waits for the sheet to load, and that
    // wait fails when any font in the page is still refusing to load.
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "html { scrollbar-width: none; }";
      document.head.append(style);
    });
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();

    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, STATES_PAGE_HASH);
    await expect(page.getByTestId("states-page")).toBeVisible();
    // The page holds the document light so its light pane reads light tokens.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // `fonts.check` answers true for a family no font declares, so ask the
    // loaded faces themselves.
    await page.evaluate(() => document.fonts.ready);
    const loaded = await page.evaluate(() =>
      [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => face.family.replaceAll('"', "")),
    );
    expect(loaded, "the UI fonts must be loaded before pixels are compared").toEqual(
      expect.arrayContaining(["Inter Variable", "IBM Plex Mono"]),
    );

    await forceMarkedStates(page);

    // The document menu opens on a click and closes on a click outside, so
    // each pane's capture opens its own.
    const light = page.getByTestId("states-light");
    const dark = page.getByTestId("states-dark");
    await openDocumentMenu(page, light);
    await expect(light).toHaveScreenshot("states-light.png");
    await openDocumentMenu(page, dark);
    await expect(dark).toHaveScreenshot("states-dark.png");
  });
});

test("@states-page the page stays closed without the dev-tools grant", async () => {
  test.setTimeout(120_000);
  await withDesktop({ DOHC_DEV_TOOLS: "0" }, async (page) => {
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    await page.evaluate(async (hash) => {
      window.location.hash = hash;
      // hashchange is a task, and the route renders on it. Two frames
      // later, whatever it rendered is on the screen.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, STATES_PAGE_HASH);
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    await expect(page.getByTestId("states-page")).toHaveCount(0);
  });
});
