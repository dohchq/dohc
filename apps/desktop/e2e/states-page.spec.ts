import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

// The states page (@states-page): every shared part in every state, light
// beside dark. Each section of the page is one part, named by its
// `data-part`, and has one baseline per theme in states-page.spec.ts-snapshots,
// `<part>-<theme>-<platform>.png`. A change to a shared part shows up as a
// pixel difference in that part's pair, and in no other unless the part's
// section changes height (see the known exceptions below). Update a pair
// with `--update-snapshots` when the change is the point of the PR.
//
// Every pixel must equal its baseline, compared here from the decoded
// images: Playwright's comparator skips pixels it takes for antialiasing
// and tolerates a per-pixel distance, and either let a one-step token
// change pass. The captures are made deterministic by construction:
// software rendering, no animations or backdrop filters, a viewport as tall
// as the page so nothing scrolls, a pinned color scheme, states forced
// through the browser instead of pointer events, a paused clock so
// acknowledged copies hold, fonts checked, and a whole-page capture
// repeated until two in a row are equal. So the baselines do not cover a
// backdrop blur, an animation's end state, anything only the GPU draws, or
// how a part looks at a display scale other than 100%. Every section is
// held to a whole-pixel height so a height change in one section moves the
// sections below it by whole pixels, which leaves their captures mostly
// alone: a move still changes a few antialiased edge pixels in some parts
// below it, such as the first step's circle in steps and the toasts. Expect
// those parts' pairs to change when a section above them changes height,
// and check that only edge pixels differ. The baselines were
// taken on Windows; Playwright names them per platform.

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
  "surfaces", "buttons", "copy", "segmented", "switch", "state-mark", "chips", "avatars", "badges", "text-inputs",
  "steps", "folder-chip", "hue-control", "color-control", "list-rows", "menu", "document-menu",
  "empty", "loading", "toasts", "notices", "dialog", "menu-radio", "menu-field", "menu-overflow", "menu-danger",
  "editor-groups", "editor-groups-empty",
  "kind-glyph",
  "block-menu", "table-menu",
  "history",
  "file-header",
  "slash-menu",
  "editor-group-focus",
  "frontmatter-as-written",
  "title-bar-status",
  "capture-recovery",
  "about",
  "apps-shelf",
];
// A fixed instant for the page's clock. The capture pauses the clock an
// hour past it, so the real time that passes between installing and
// pausing can never put the pause in the clock's past.
const CLOCK_START = Date.UTC(2026, 6, 8, 9, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

// The GPU rasterizes and composites with run-to-run noise at edges; software
// rendering is the same every run. One CSS pixel is one device pixel: on a
// display scaled to 150%, an odd CSS offset lands on half a device pixel
// and every edge below it re-antialiases, so a 1px move in one section
// changed every part under it. Every invalidated tile rasterizes whole:
// partial raster copies a tile's unchanged pixels forward and redraws the
// rest, and the antialiased edges at that seam rounded differently from
// run to run, by one unit.
const SWITCHES = ["--disable-gpu", "--force-device-scale-factor=1", "--disable-partial-raster"];

type Pixels = Pick<PNG, "width" | "height" | "data">;
type Box = NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;

function decode(png: Buffer): Pixels {
  return PNG.sync.read(png);
}

// What differs between two images, or null when nothing does.
function mismatch(expected: Pixels, actual: Pixels): string | null {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return `is ${actual.width}x${actual.height}, the baseline ${expected.width}x${expected.height}`;
  }
  let differing = 0;
  for (let offset = 0; offset < expected.data.length; offset += 4) {
    if (expected.data.compare(actual.data, offset, offset + 4, offset, offset + 4) !== 0) differing += 1;
  }
  return differing === 0 ? null : `differs in ${differing} pixels`;
}

// The baselines are in CSS pixels, whatever the display's scale.
const CSS_PIXELS = { scale: "css" } as const;
const STILL_CAPTURES = 20;

// Captures the whole page until two captures in a row are equal, so no part
// is compared while the page is still settling.
async function waitForStillPage(page: Page): Promise<void> {
  let previous = decode(await page.screenshot(CSS_PIXELS));
  let difference: string | null = null;
  for (let captures = 1; captures < STILL_CAPTURES; captures += 1) {
    const next = decode(await page.screenshot(CSS_PIXELS));
    difference = mismatch(previous, next);
    if (difference === null) return;
    previous = next;
  }
  throw new Error(`the page did not settle in ${STILL_CAPTURES} captures; the last one ${difference}`);
}

// Compares a capture with its baseline and honors --update-snapshots the
// way Playwright does: `missing` writes an absent baseline and still fails,
// `changed` writes an absent or differing one and passes, `all` writes every
// one and passes. A failure leaves the capture beside the test output as
// `<name>-actual.png`.
async function compareWithBaseline(name: string, actual: Buffer): Promise<string | null> {
  const info = test.info();
  const path = info.snapshotPath(`${name}.png`);
  const mode = info.config.updateSnapshots;
  const baseline = existsSync(path) ? readFileSync(path) : null;
  const difference = baseline ? mismatch(decode(baseline), decode(actual)) : null;
  const write = baseline === null ? mode !== "none" : mode === "all" || (mode === "changed" && difference !== null);
  if (write) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
  }
  const pass = baseline === null ? mode === "changed" || mode === "all" : difference === null || write;
  if (pass) return null;
  const actualPath = info.outputPath(`${name}-actual.png`);
  writeFileSync(actualPath, actual);
  await info.attach(`${name}-actual`, { path: actualPath, contentType: "image/png" });
  const reason = baseline === null ? `has no baseline${write ? "; one was written, run again" : ""}` : difference;
  return `${name} ${reason}; the capture is at ${actualPath}`;
}

async function withDesktop(
  env: NodeJS.ProcessEnv,
  flow: (page: Page) => Promise<void>,
): Promise<void> {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp, env, switches: SWITCHES });
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
// is drawn by a forced :focus rather than by the keyboard's focus ring. A
// menu paints hover only once a pointer has moved over it, so the list is
// told one has, without a pointer that would land on a row.
async function openMenu(page: Page, trigger: Locator, menu: Locator): Promise<void> {
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await menu.dispatchEvent("mousemove", { movementX: 1, movementY: 0 });
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
    expect(await page.evaluate(() => window.devicePixelRatio), "the baselines are one device pixel per CSS pixel").toBe(1);
    await page.setViewportSize({ width: WIDTH, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    // Until the viewport grows to the page, a scrollbar would narrow the
    // layout, and the height measured from it would be the wrong one. No
    // animation: reduced motion only shortens one, and a finished animation
    // that holds its last keyframe keeps its element on a compositor layer
    // whose edges blend differently from run to run. No backdrop filter: a
    // blur reads what the compositor last drew beneath it. Appended
    // directly: addStyleTag waits for the sheet to load, and that wait
    // fails when any font in the page is still refusing to load.
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent =
        "html { scrollbar-width: none; } *, ::before, ::after { animation: none !important; backdrop-filter: none !important; }";
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
      for (const [answer, words] of [["copied", "Copied"], ["failed", "Couldn't copy"]] as const) {
        const withWords = pane.getByTestId(`states-copy-words-${answer}-${theme}`);
        await press(page, withWords);
        await expect(withWords).toHaveText(words);
        const icon = pane.getByTestId(`states-copy-icon-${answer}-${theme}`);
        await press(page, icon);
        await expect(icon).toHaveAttribute("title", words);
      }
      const field = pane.getByTestId(`states-copy-field-copied-${theme}`);
      await press(page, field);
      await expect(field).toHaveAttribute("title", "Copied");
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    // A menu's rows exist only while it is open, so a part with a menu is
    // marked after it opens its menu. A part marked data-menus="rest" holds
    // menus without being about them, and is captured with them closed.
    await forceMarkedStates(cdp, `[data-testid="states-page"] [data-part]:is([data-menus="rest"], :not(:has([aria-haspopup="menu"])))`);
    await waitForStillPage(page);

    const seen = new Set<string>();
    const failures: string[] = [];
    const capture = async (name: string, theme: string, box: Box) => {
      const pixels = await page.screenshot({
        ...CSS_PIXELS,
        clip: { x: box.x - BLEED, y: box.y - BLEED, width: box.width + 2 * BLEED, height: box.height + 2 * BLEED },
      });
      const failure = await compareWithBaseline(`${name}-${theme}`, pixels);
      if (failure) failures.push(failure);
    };
    const menuParts: { name: string; theme: string; part: Locator; box: Box }[] = [];
    for (const theme of THEMES) {
      const pane = page.getByTestId(`states-${theme}`);
      for (const part of await pane.locator("[data-part]").all()) {
        const name = await part.getAttribute("data-part");
        const box = await part.boundingBox();
        if (!name || !box) throw new Error("every part needs a data-part name and a box on the page");
        // A part's pixels depend on where in a pixel it starts, so a
        // fractional offset in one section would change every part below it.
        if (!Number.isInteger(box.x) || !Number.isInteger(box.y)) {
          throw new Error(`${name} (${theme}) starts at a fractional pixel: ${box.x}, ${box.y}`);
        }
        if (seen.has(`${name}-${theme}`)) throw new Error(`two parts are named ${name}`);
        seen.add(`${name}-${theme}`);
        const menus = (await part.getAttribute("data-menus")) === "rest" ? 0 : await part.locator("[aria-haspopup='menu']").count();
        if (menus > 1) throw new Error(`${name} (${theme}) has ${menus} menus; a part opens one`);
        if (menus === 1) menuParts.push({ name, theme, part, box });
        else await capture(name, theme, box);
      }
    }
    // Each marking pass starts from a fresh DOM.getDocument, which clears the
    // states forced before it, so the menu parts are captured last. One menu is open at a time: opening
    // another moves focus and closes the first.
    for (const { name, theme, part, box } of menuParts) {
      const trigger = part.locator("[aria-haspopup='menu']");
      const menu = part.getByRole("menu");
      await openMenu(page, trigger, menu);
      await forceMarkedStates(cdp, `[data-testid="states-${theme}"] [data-part="${name}"]`);
      await waitForStillPage(page);
      await capture(name, theme, box);
      await closeMenu(page, trigger, menu);
    }
    // A file header keeps Share and the document's controls inside itself at
    // any width, and its save state gives way before its file name: the path
    // is cut only once the save state shows no more than one character and an
    // ellipsis (13px of 11px mono). The narrow specimen must really have cut
    // its save state short, or the check proves nothing.
    for (const theme of THEMES) {
      const part = page.getByTestId(`states-${theme}`).locator('[data-part="file-header"]');
      for (const header of await part.locator("header").all()) {
        const edge = await header.evaluate((el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight));
        const rights = await header.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right));
        if (rights.some((right) => right > edge + 0.5)) failures.push(`a file header control (${theme}) runs past its header`);
        const order = await header.evaluate((el) => {
          const path = el.querySelector(":scope > span");
          const label = el.querySelector(":scope > div .truncate");
          return { pathCut: !!path && path.scrollWidth > path.clientWidth, statusWidth: label?.clientWidth ?? 0 };
        });
        if (order.pathCut && order.statusWidth >= 13) {
          failures.push(`a file header (${theme}) cut its file name while its save state still had ${order.statusWidth}px of words`);
        }
      }
      const label = page.getByTestId(`states-file-header-pending-${theme}`).locator(".truncate");
      if (!(await label.evaluate((el) => el.scrollWidth > el.clientWidth))) {
        failures.push(`the narrow file header's save state (${theme}) is not cut short`);
      }
    }
    expect(failures, "every part must equal its baseline").toEqual([]);
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
