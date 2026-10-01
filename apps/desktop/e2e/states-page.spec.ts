import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

// The states page (@states-page): every shared part in every state, light
// beside dark. Each section of the page is one part, named by its
// `data-part`, and has one baseline per theme in states-page.spec.ts-snapshots,
// `<part>-<theme>-<platform>.png`. A change to a shared part shows up as a
// pixel difference in that part's pair and no other. Update a pair with
// `--update-snapshots` when the change is the point of the PR.
//
// The captures are made deterministic by construction: a viewport as tall
// as the page so nothing scrolls, a pinned color scheme, reduced motion and
// disabled animations, states forced through the browser instead of pointer
// events, a paused clock so acknowledged copies hold, and a check that Inter
// and IBM Plex Mono are in before comparing. The baselines were taken on
// Windows; Playwright names them per platform.

const STATES_PAGE_HASH = "#/dev/states";
const WIDTH = 1440;
// The parts sit 32px apart. Each capture takes half of that around its
// part, so a shadow or a focus ring at the edge is in the picture and the
// neighbors are not.
const BLEED = 16;
const THEMES = ["light", "dark"] as const;
// Every part the page has, so a section dropped by mistake fails here
// instead of leaving its baselines unread.
const PARTS = [
  "surfaces", "buttons", "copy", "segmented", "switch", "chips", "avatars", "badges", "text-inputs",
  "steps", "folder-chip", "hue-control", "color-control", "list-rows", "menu", "document-menu",
  "empty", "loading", "toasts", "notices", "dialog",
];
// A fixed instant for the page's clock. The capture pauses the clock an
// hour past it, so the real time that passes between installing and
// pausing can never put the pause in the clock's past.
const CLOCK_START = Date.UTC(2026, 6, 8, 9, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

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

// Every element marked `data-force-state` under `scope` gets that
// pseudo-class forced through the browser, so the part's own :hover,
// :focus-visible or :focus rules apply. `data-force-target` names a
// descendant to force instead.
type Cdp = Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>;
async function forceMarkedStates(cdp: Cdp, scope: string): Promise<void> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: `${scope} [data-force-state]`,
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

// Opened from the keyboard, so no pointer is left over the trigger or lands
// on a row, and no pointer press reaches the listeners that close a menu.
// Focus then leaves the menu for the page: a menu closes when focus moves to
// another element, not when it goes to the page, and the row the part marks
// is drawn by a forced :focus rather than by the keyboard's focus ring.
async function openMenu(page: Page, trigger: Locator, menu: Locator): Promise<void> {
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// Closed from its trigger, which Escape reaches while focus is inside the
// menu's frame. Focus then leaves the trigger, so no ring outlives the part.
async function closeMenu(page: Page, trigger: Locator, menu: Locator): Promise<void> {
  await trigger.focus();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// Pressed from the keyboard for the same reason. The part says what it says
// on its own: the capture only presses it and waits for the answer.
async function press(page: Page, button: Locator): Promise<void> {
  await button.focus();
  await page.keyboard.press("Enter");
}

// The gate requires this test by its own tag: the route check below shares
// @states-page and must not stand in for the pixels.
test("@states-page @states-baselines every shared part matches its baseline in both themes", async () => {
  test.skip(process.platform !== "win32", "the baselines were taken on Windows");
  test.setTimeout(240_000);
  await withDesktop({ DOHC_DEV_TOOLS: "1" }, async (page) => {
    await page.setViewportSize({ width: WIDTH, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    // Until the viewport grows to the page, a scrollbar would narrow the
    // layout, and the height measured from it would be the wrong one.
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

    // The page's clock is faked from here. Real time passes while the fonts
    // and the viewport are checked below, and the clock runs with it until
    // it is paused ahead of now.
    await page.clock.install({ time: CLOCK_START });

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

    // The viewport grows to the whole page, so no capture scrolls a part
    // into view and a menu placed at viewport coordinates stays under its
    // trigger.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: WIDTH, height });

    // An acknowledged copy says "Copied" for a moment and then reverts on
    // its own timer. The clock is paused so the moment holds for the
    // capture; the parts are unchanged.
    await page.clock.pauseAt(CLOCK_START + HOUR_MS);

    for (const theme of THEMES) {
      const pane = page.getByTestId(`states-${theme}`);
      const copied = pane.getByTestId(`states-copy-copied-${theme}`);
      await press(page, copied);
      await expect(copied).toHaveText("Copied");
      const refused = pane.getByTestId(`states-copy-refused-${theme}`);
      await press(page, refused);
      await expect(refused).toHaveText("Couldn't copy");
      const details = pane.getByTestId(`states-copy-details-copied-${theme}`);
      await press(page, details);
      await expect(details).toHaveText("Copied");
      const detailsIcon = pane.getByTestId(`states-copy-details-icon-copied-${theme}`);
      await press(page, detailsIcon);
      await expect(detailsIcon).toHaveAttribute("title", "Copied");
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");

    const seen = new Set<string>();
    for (const theme of THEMES) {
      const pane = page.getByTestId(`states-${theme}`);
      for (const part of await pane.locator("[data-part]").all()) {
        const name = await part.getAttribute("data-part");
        const box = await part.boundingBox();
        if (!name || !box) throw new Error("every part needs a data-part name and a box on the page");
        if (seen.has(`${name}-${theme}`)) throw new Error(`two parts are named ${name}`);
        seen.add(`${name}-${theme}`);
        // One menu is open at a time: opening another moves focus and closes
        // the first. A part with a menu opens it for its own capture, and its
        // rows can be marked only while they exist.
        const trigger = part.locator("[aria-haspopup='menu']");
        const menu = part.getByRole("menu");
        const hasMenu = (await trigger.count()) === 1;
        if (hasMenu) await openMenu(page, trigger, menu);
        await forceMarkedStates(cdp, `[data-testid="states-${theme}"] [data-part="${name}"]`);
        await expect(page).toHaveScreenshot(`${name}-${theme}.png`, {
          clip: { x: box.x - BLEED, y: box.y - BLEED, width: box.width + 2 * BLEED, height: box.height + 2 * BLEED },
        });
        if (hasMenu) await closeMenu(page, trigger, menu);
      }
    }
    expect([...seen].sort()).toEqual(PARTS.flatMap((part) => THEMES.map((theme) => `${part}-${theme}`)).sort());
  });
});

test("@states-page the page stays closed without the dev-tools grant", async () => {
  test.setTimeout(120_000);
  await withDesktop({ DOHC_DEV_TOOLS: "0" }, async (page) => {
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    // The route reads the hash on hashchange. Its listener was added when
    // the app mounted, so it runs before one added now; when this one has
    // run, the route has already answered the hash.
    await page.evaluate(
      (hash) =>
        new Promise<void>((resolve) => {
          window.addEventListener("hashchange", () => resolve(), { once: true });
          window.location.hash = hash;
        }),
      STATES_PAGE_HASH,
    );
    await expect(page).toHaveURL(/#\/dev\/states$/);
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    await expect(page.getByTestId("states-page")).toHaveCount(0);
  });
});
