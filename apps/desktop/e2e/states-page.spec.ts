import { holdSystemClipboard } from "./helpers/systemClipboard";
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
// pixel difference in that part's pair and in no other. Update a pair with
// `--update-snapshots` when the change is the point of the PR.
//
// Every pixel must equal its baseline, compared here from the decoded
// images: Playwright's comparator skips pixels it takes for antialiasing
// and tolerates a per-pixel distance, and either let a one-step token
// change pass. The captures are made deterministic by construction:
// software rendering, no animations or backdrop filters, a viewport as tall
// as the page so nothing scrolls, a pinned color scheme, states forced
// through the browser instead of pointer events, the pointer parked outside
// every part, a paused clock so acknowledged copies hold, fonts checked,
// each part captured alone at the top of its pane, and each capture
// repeated until two in a row are equal.
// So the baselines do not cover a backdrop blur, an animation's end state,
// anything only the GPU draws, or how a part looks at a display scale other
// than 100%. The baselines were taken on Windows; Playwright names them per
// platform.
//
// A second pass captures each part among all the others and holds it to the
// same baseline, roughly (IN_CONTEXT_LEVELS): it catches a part whose styles
// change how other parts paint, which no part alone can show.

const STATES_PAGE_HASH = "#/dev/states";
const WIDTH = 1440;
// The parts sit 32px apart. Each capture takes half of that around its
// part, room for a shadow or a focus ring at its edge. A part's padding
// (SHADOW_ROOM in StatesPage.tsx) and this room hold its whole shadow, so
// among the others no neighbor reaches into its capture.
const BLEED = 16;
const THEMES = ["light", "dark"] as const;
// Every part the page has, so a section dropped by mistake fails here
// instead of leaving its baselines unread.
const PARTS = [
  "surfaces", "buttons", "copy", "segmented", "switch", "state-mark", "chips", "avatars", "badges", "text-inputs",
  "steps", "folder-chip", "hue-control", "color-control", "native-controls", "list-rows", "collections-rows", "menu", "document-menu",
  "empty", "loading", "toasts", "notices", "dialog", "menu-radio", "menu-field", "menu-overflow", "menu-danger",
  "editor-groups", "editor-groups-empty",
  "kind-glyph",
  "block-menu", "table-menu",
  "history",
  "history-timeline",
  "tab-row-actions",
  "slash-menu",
  "editor-group-focus",
  "title-bar-status",
  "capture-recovery",
  "recovery-row",
  "about",
  "about-links",
  "sharing",
  "usage-record",
  "word-diff",
  "apps-shelf",
  "chat-rows",
  "settings-frame",
  "theme-picker",
  "zoom-stepper",
  "settings-keyboard",
  "settings-privacy",
  "rails",
  "composer-sending",
  "about-conversation",
  "about-conversation-links",
  "file-view-actions",
  "offers",
  "csv-bound",
  "page-identity",
  "settings-sync",
  "data-grid",
  "tab-strip-overflow",
  "tab-glyphs",
  "composer-poll",
  "chat-messages",
  "ref",
  "agent-color",
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

// The same comparison from the encoded files. Equal files are equal images,
// so the common case skips decoding both.
function pngMismatch(expected: Buffer, actual: Buffer): string | null {
  return expected.equals(actual) ? null : mismatch(decode(expected), decode(actual));
}

// Among the others, a part sits elsewhere on the raster's tiles than alone,
// and the rounded corners and icons a tile's edge crosses antialias a little
// differently. Across four page positions, at most 21 pixels of a capture
// (in buttons, with its many rounded corners) moved by more than 16 levels
// in a channel, and none by more than 62. A part whose styles change how
// others paint moves far more: #1983's mask on a tab strip dropped subpixel
// text across the page, and moved 1,328 pixels of buttons by more than 16.
// The limit is three times the worst noise and a twentieth of #1983's 1,328.
const IN_CONTEXT_LEVELS = 16;
const IN_CONTEXT_PIXELS = 64;

// What differs between a part captured among the others and its baseline,
// or null when no more than IN_CONTEXT_PIXELS pixels differ by more than
// IN_CONTEXT_LEVELS in a channel.
function farFrom(expected: Pixels, actual: Pixels): string | null {
  if (expected.width !== actual.width || expected.height !== actual.height) return mismatch(expected, actual);
  let far = 0;
  for (let offset = 0; offset < expected.data.length; offset += 4) {
    for (let channel = offset; channel < offset + 4; channel += 1) {
      if (Math.abs(expected.data[channel]! - actual.data[channel]!) > IN_CONTEXT_LEVELS) {
        far += 1;
        break;
      }
    }
  }
  return far <= IN_CONTEXT_PIXELS ? null : `differs by more than ${IN_CONTEXT_LEVELS} levels in ${far} pixels`;
}

// A part's box with BLEED around it, its height rounded up to a whole pixel.
function around(box: Box): Box {
  return { x: box.x - BLEED, y: box.y - BLEED, width: box.width + 2 * BLEED, height: Math.ceil(box.height) + 2 * BLEED };
}

// The baselines are in CSS pixels, whatever the display's scale.
const CSS_PIXELS = { scale: "css" } as const;
const STILL_CAPTURES = 20;

// Captures `clip` until two captures in a row are equal, so no part is
// compared while it is still settling. When none are, `unsettled` says how
// the last two differ.
async function captureStill(page: Page, clip: Box): Promise<{ pixels: Buffer; unsettled: string | null }> {
  let pixels = await page.screenshot({ ...CSS_PIXELS, clip });
  let unsettled: string | null = null;
  for (let captures = 1; captures < STILL_CAPTURES; captures += 1) {
    const next = await page.screenshot({ ...CSS_PIXELS, clip });
    unsettled = pngMismatch(pixels, next);
    pixels = next;
    if (unsettled === null) break;
  }
  return { pixels, unsettled };
}

// Shows one part in each pane and hides the rest. Chromium rasterizes the
// page in tiles, and a rounded corner or an icon that a tile's edge crosses
// antialiases a little differently, so a part captured in place changed
// whenever a part above it changed height. Alone, a part sits at the top of
// its pane wherever it is on the page, and no neighbor's shadow reaches
// into its capture.
async function showOnly(page: Page, name: string): Promise<void> {
  await page.evaluate((name) => {
    const style =
      document.getElementById("states-only") ??
      document.head.appendChild(Object.assign(document.createElement("style"), { id: "states-only" }));
    style.textContent = `[data-part]:not([data-part="${name}"]) { display: none; }`;
  }, name);
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
  const difference = baseline ? pngMismatch(baseline, actual) : null;
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
// descendant to force instead. Focus draws only while the keyboard moves, so
// the root takes the keyboard's mark first.
type Cdp = Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>;
async function forceMarkedStates(cdp: Cdp, scope: string): Promise<void> {
  await cdp.send("Runtime.evaluate", { expression: "document.documentElement.toggleAttribute('data-keyboard-nav', true)" });
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: `${scope} [data-force-state]`,
  });
  // Each command waits a round trip on a page this tall, so they go out
  // together; the browser still runs them in order.
  const forced = await Promise.all(nodeIds.map(async (nodeId) => {
    const { attributes } = await cdp.send("DOM.getAttributes", { nodeId });
    const marks = new Map<string, string>();
    for (let index = 0; index < attributes.length; index += 2) {
      marks.set(attributes[index] ?? "", attributes[index + 1] ?? "");
    }
    const state = marks.get("data-force-state");
    if (!state) return null;
    const target = marks.get("data-force-target");
    const targetId = target
      ? (await cdp.send("DOM.querySelector", { nodeId, selector: target })).nodeId
      : nodeId;
    if (!targetId) throw new Error(`no element matches data-force-target="${target}"`);
    return { nodeId: targetId, forcedPseudoClasses: state.split(" ") };
  }));
  await Promise.all(forced.map((force) => force && cdp.send("CSS.forcePseudoState", force)));
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
async function press(page: Page, button: Locator, timeout?: number): Promise<void> {
  await button.focus({ timeout });
  await page.keyboard.press("Enter");
}

// E2E windows ignore OS mouse events. Park Playwright's CDP pointer on the
// page's header, outside every part and control, so captures have no hover.
const PARKED = { x: 2, y: 2 };
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(PARKED.x, PARKED.y);
  const clear = await page.evaluate(({ x, y }) => {
    const under = document.elementFromPoint(x, y);
    return under !== null && under.closest("[data-part], a, button, input, [tabindex]") === null;
  }, PARKED);
  expect(clear, "the parked pointer must rest outside every part and control").toBe(true);
}

// The gate requires this test by its own tag: the route check below shares
// @states-page and must not stand in for the pixels.
test("@states-page @states-baselines every shared part matches its baseline in both themes", async () => {
  test.skip(process.platform !== "win32", "the baselines were taken on Windows");
  // About 110s unloaded (1.8 min in gate logs) and 140s in a slower gate
  // run before the pass among the others, which took 50-70s more in a
  // harness run. The limit is about twice the slower run with it: a loaded
  // host still passes, and a hang fails within seven minutes.
  test.setTimeout(420_000);
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

    await holdSystemClipboard(test.info(), async (remainingMs) => {
      for (const theme of THEMES) {
        const pane = page.getByTestId(`states-${theme}`);
        for (const [answer, words] of [["copied", "Copied"], ["failed", "Couldn't copy"]] as const) {
          const withWords = pane.getByTestId(`states-copy-words-${answer}-${theme}`);
          await press(page, withWords, remainingMs());
          await expect(withWords).toHaveText(words, { timeout: remainingMs() });
          const icon = pane.getByTestId(`states-copy-icon-${answer}-${theme}`);
          await press(page, icon, remainingMs());
          await expect(icon).toHaveAttribute("title", words, { timeout: remainingMs() });
        }
        const field = pane.getByTestId(`states-copy-field-copied-${theme}`);
        await press(page, field, remainingMs());
        await expect(field).toHaveAttribute("title", "Copied", { timeout: remainingMs() });
      }
    });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // A send shows its ring only after a second on the timer the page started
    // when it mounted, before the clock was faked. Three composers per theme.
    await expect(page.locator('[data-part="composer-sending"] button[aria-busy="true"]')).toHaveCount(2 * 3);

    const failures: string[] = [];
    // A tab row keeps Share and the document's controls inside itself at any
    // width, and its save state gives way before the tab's file name: the
    // name is cut only once the save state shows little more than an
    // ellipsis (under 13px; the ellipsis is 9.5px of 11px Inter). A row whose
    // save state shows no words draws the same width as the loading row. The
    // narrow specimen must really have cut its save state short, or the check
    // proves nothing.
    for (const theme of THEMES) {
      const part = page.getByTestId(`states-${theme}`).locator('[data-part="tab-row-actions"]');
      const widths: number[] = [];
      for (const row of await part.getByTestId("editor-tabs").all()) {
        const edge = await row.evaluate((el) => el.getBoundingClientRect().right);
        const actions = row.getByTestId("editor-tab-actions");
        const rights = await actions
          .locator("button")
          .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right));
        if (rights.length === 0) failures.push(`a tab row (${theme}) has no document actions`);
        if (rights.some((right) => right > edge + 0.5)) failures.push(`a document control (${theme}) runs past its tab row`);
        const order = await row.evaluate((el) => {
          const list = el.querySelector('[role="tablist"]')!.getBoundingClientRect();
          const tab = el.querySelector('[role="tab"][data-active]');
          const name = tab?.querySelector(".truncate");
          const box = tab?.getBoundingClientRect();
          const label = el.querySelector('[data-testid="editor-tab-actions"] [data-view-status] .truncate');
          const nameCut =
            !!name && (name.scrollWidth > name.clientWidth || (!!box && (box.right > list.right + 0.5 || box.left < list.left - 0.5)));
          const actionsBox = el.querySelector('[data-testid="editor-tab-actions"]')!.getBoundingClientRect();
          return { nameCut, statusWidth: label?.clientWidth ?? 0, worded: !!label, actionsWidth: actionsBox.width };
        });
        if (order.nameCut && order.statusWidth >= 13) {
          failures.push(`a tab row (${theme}) cut its file name while its save state still had ${order.statusWidth}px of words`);
        }
        if (!order.worded) widths.push(order.actionsWidth);
      }
      if (widths.length > 0 && Math.max(...widths) - Math.min(...widths) > 0.5) {
        failures.push(`the tab rows without save-state words (${theme}) draw different widths: ${widths.join(", ")}`);
      }
      const label = page.getByTestId(`states-tab-row-actions-cut-${theme}`).locator(".truncate");
      if (!(await label.evaluate((el) => el.scrollWidth > el.clientWidth))) {
        failures.push(`the narrow tab row's save state (${theme}) is not cut short`);
      }
    }
    // An overflowing strip fades only the edges it can still scroll past,
    // 24px each, and its active tab sits clear of them. Each specimen must
    // really overflow the way its label says, or its capture proves nothing.
    for (const theme of THEMES) {
      for (const [at, left, right] of [["start", false, true], ["middle", true, true], ["end", true, false]] as const) {
        const strip = page.getByTestId(`states-tab-strip-overflow-${at}-${theme}`).getByRole("tablist");
        const shown = await strip.evaluate((el) => {
          const list = el.getBoundingClientRect();
          const tab = el.querySelector('[role="tab"][data-active]')?.getBoundingClientRect();
          return {
            left: el.hasAttribute("data-overflow-left"),
            right: el.hasAttribute("data-overflow-right"),
            before: tab ? tab.left - list.left : -1,
            after: tab ? list.right - tab.right : -1,
          };
        });
        if (shown.left !== left || shown.right !== right) {
          failures.push(`the strip at the ${at} (${theme}) fades left ${shown.left} and right ${shown.right}`);
        }
        if (shown.before < (left ? 24 : 0) || shown.after < (right ? 24 : 0)) {
          failures.push(`the strip at the ${at} (${theme}) shows its active tab under a fade or cut`);
        }
      }
    }

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");

    const seen = new Set<string>();
    const plainParts = new Set<string>();
    const menuParts = new Set<string>();
    for (const theme of THEMES) {
      for (const part of await page.getByTestId(`states-${theme}`).locator("[data-part]").all()) {
        const name = await part.getAttribute("data-part");
        if (!name) throw new Error("every part needs a data-part name");
        if (seen.has(`${name}-${theme}`)) throw new Error(`two parts are named ${name}`);
        seen.add(`${name}-${theme}`);
        const menus = (await part.getAttribute("data-menus")) === "rest" ? 0 : await part.locator("[aria-haspopup='menu']").count();
        if (menus > 1) throw new Error(`${name} (${theme}) has ${menus} menus; a part opens one`);
        (menus === 1 ? menuParts : plainParts).add(name);
      }
    }
    // Before any capture, so a part missing from a pane fails here instead
    // of waiting out the timeout for its box.
    expect([...seen].sort()).toEqual(PARTS.flatMap((part) => THEMES.map((theme) => `${part}-${theme}`)).sort());

    const partIn = (theme: string, name: string) => page.getByTestId(`states-${theme}`).locator(`[data-part="${name}"]`);
    // Runs `check` on every part in both themes, alone or among the others.
    // A menu's rows exist only while it is open, so a part with a menu is
    // marked after it opens its menu. A part marked data-menus="rest" holds
    // menus without being about them, and is captured with them closed.
    // Each marking pass starts from a fresh DOM.getDocument, which clears the
    // states forced before it, so the menu parts come last. One menu is open
    // at a time: opening another moves focus and closes the first.
    const checkEvery = async (alone: boolean, check: (name: string, theme: string) => Promise<void>) => {
      await forceMarkedStates(cdp, `[data-testid="states-page"] [data-part]:is([data-menus="rest"], :not(:has([aria-haspopup="menu"])))`);
      for (const name of plainParts) {
        if (alone) await showOnly(page, name);
        for (const theme of THEMES) await check(name, theme);
      }
      for (const name of menuParts) {
        if (alone) await showOnly(page, name);
        for (const theme of THEMES) {
          const trigger = partIn(theme, name).locator("[aria-haspopup='menu']");
          const menu = partIn(theme, name).getByRole("menu");
          await openMenu(page, trigger, menu);
          await forceMarkedStates(cdp, `[data-testid="states-${theme}"] [data-part="${name}"]`);
          await check(name, theme);
          await closeMenu(page, trigger, menu);
        }
      }
    };

    // A part shown alone must equal its baseline. It must keep its box while
    // it settles, or the capture would be cut to the box it had before.
    await parkPointer(page);
    await checkEvery(true, async (name, theme) => {
      const box = await partIn(theme, name).boundingBox();
      if (!box) throw new Error(`${name} (${theme}) has no box on the page`);
      const { pixels, unsettled } = await captureStill(page, around(box));
      if (unsettled !== null) {
        failures.push(`${name}-${theme} did not settle in ${STILL_CAPTURES} captures; the last one ${unsettled}`);
        return;
      }
      const settled = await partIn(theme, name).boundingBox();
      if (JSON.stringify(settled) !== JSON.stringify(box)) {
        failures.push(`${name}-${theme} moved from ${JSON.stringify(box)} to ${JSON.stringify(settled)} while it settled`);
        return;
      }
      const failure = await compareWithBaseline(`${name}-${theme}`, pixels);
      if (failure) failures.push(failure);
    });

    // Then every part among the others, held roughly to the baseline the
    // pass above compared or wrote. A part that starts on a fraction of a
    // pixel antialiases every edge differently, so each part's height is
    // rounded up first, and every part starts on a whole pixel. The heights
    // are taken at rest, since the menu passes cleared the forced states; a
    // forced state that changes a part's height fails on its size. The
    // viewport grows again to the taller page.
    const roundedHeight = await page.evaluate(() => {
      document.getElementById("states-only")?.remove();
      const parts = [...document.querySelectorAll<HTMLElement>("[data-part]")];
      const heights = parts.map((part) => Math.ceil(part.getBoundingClientRect().height));
      for (const [index, part] of parts.entries()) part.style.height = `${heights[index]}px`;
      return document.documentElement.scrollHeight;
    });
    await page.setViewportSize({ width: WIDTH, height: roundedHeight });
    await parkPointer(page);
    await checkEvery(false, async (name, theme) => {
      const path = test.info().snapshotPath(`${name}-${theme}.png`);
      if (!existsSync(path)) return;
      const expected = decode(readFileSync(path));
      const box = await partIn(theme, name).boundingBox();
      if (!box) throw new Error(`${name} (${theme}) has no box on the page`);
      // One capture is enough when it is near. One that is not is retaken
      // until it holds still, so a page still settling cannot fail it.
      let actual = await page.screenshot({ ...CSS_PIXELS, clip: around(box) });
      let far = farFrom(expected, decode(actual));
      if (far !== null) {
        const { pixels, unsettled } = await captureStill(page, around(box));
        actual = pixels;
        far = unsettled === null ? farFrom(expected, decode(pixels)) : `did not settle in ${STILL_CAPTURES} captures; the last one ${unsettled}`;
      }
      if (far === null) return;
      const actualPath = test.info().outputPath(`${name}-${theme}-among-others-actual.png`);
      writeFileSync(actualPath, actual);
      await test.info().attach(`${name}-${theme}-among-others-actual`, { path: actualPath, contentType: "image/png" });
      failures.push(`${name}-${theme} among the other parts ${far}; the capture is at ${actualPath}`);
    });
    expect(failures, "every part must equal its baseline").toEqual([]);
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
