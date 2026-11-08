import { editorTabTestId } from "../src/testPins";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

type Rgb = [number, number, number];

// A CSS color as the page paints it over Canvas, the fill forced colors give
// every surface. macOS resolves the forced Highlight with alpha.
async function resolveColor(page: Page, css: string): Promise<Rgb> {
  const [color, canvas] = await page.evaluate((value) => [value, "Canvas"].map((entry) => {
    const probe = document.createElement("span");
    probe.style.color = entry;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }), css);
  const [r, g, b, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
  const backdrop = canvas.match(/[\d.]+/g)!.map(Number);
  return [r, g, b].map((channel, index) => Math.round(channel * alpha + backdrop[index] * (1 - alpha))) as Rgb;
}

function near(actual: Rgb, expected: Rgb): boolean {
  return actual.every((channel, index) => Math.abs(channel - expected[index]) <= 16);
}

type Edge = "top" | "right" | "bottom" | "left";

// The edges of a group that show `color` at their middle, within the 2px
// band just inside the edge, read in device pixels from the window. A
// device pixel either side of the band allows for pixel snapping.
async function edgesShowing(page: Page, group: Locator, color: Rgb): Promise<Edge[]> {
  const box = (await group.boundingBox())!;
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const shot = PNG.sync.read(await page.screenshot());
  const shows = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) return false;
    const offset = (y * shot.width + x) * 4;
    return near([shot.data[offset], shot.data[offset + 1], shot.data[offset + 2]], color);
  };
  const band = Math.round(2 * scale);
  const inward = Array.from({ length: band + 2 }, (_, index) => index - 1);
  const [left, top] = [Math.round(box.x * scale), Math.round(box.y * scale)];
  const [right, bottom] = [Math.round((box.x + box.width) * scale) - 1, Math.round((box.y + box.height) * scale) - 1];
  const [middleX, middleY] = [Math.round((box.x + box.width / 2) * scale), Math.round((box.y + box.height / 2) * scale)];
  const found: Edge[] = [];
  if (inward.some((step) => shows(middleX, top + step))) found.push("top");
  if (inward.some((step) => shows(right - step, middleY))) found.push("right");
  if (inward.some((step) => shows(middleX, bottom - step))) found.push("bottom");
  if (inward.some((step) => shows(left + step, middleY))) found.push("left");
  return found;
}

// With the ring gone, the top edge of an active group in a split still
// shows its mark, so only the other three edges must lose the ring.
async function expectRing(page: Page, group: Locator, color: Rgb, shown: boolean) {
  await expect
    .poll(async () => {
      const edges = await edgesShowing(page, group, color);
      return shown ? edges : edges.filter((edge) => edge !== "top");
    }, { message: `edges showing the ring` })
    .toEqual(shown ? ["top", "right", "bottom", "left"] : []);
}

async function expectActiveMark(page: Page, active: Locator, inactive: Locator, color: Rgb) {
  await expect
    .poll(async () => [
      (await edgesShowing(page, active, color)).includes("top"),
      (await edgesShowing(page, inactive, color)).includes("top"),
    ], { message: "the mark on the active group, then on the other" })
    .toEqual([true, false]);
}

async function dragTabTo(page: Page, tab: Locator, group: Locator) {
  const from = (await tab.boundingBox())!;
  const to = (await group.boundingBox())!;
  // Press near the tab's start, as a person would: in a narrow group the
  // tab-row actions cover the rest of the tab.
  await page.mouse.move(from.x + Math.min(16, from.width / 2), from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 8 });
  await page.mouse.up();
}

// Reaches a group's open tab from the keyboard: Tab from the group lands on
// it. A click clears the keyboard mark and .focus() leaves it as it was, so
// only a key sets the mark that draws focus for a keyboard user.
async function tabToGroupTab(page: Page, group: Locator, tab: Locator) {
  await group.focus();
  await page.keyboard.press("Tab");
  await expect(tab).toBeFocused();
}

test("editor groups keep mixed surfaces visible, resize, and collapse", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      { path: "brief.md", contents: "# Brief\n\nKeep this visible.\n" },
      { path: "data.csv", contents: "name,value\nAda,1\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await explorerRow(page, "brief.md").click();
    await expect(page.getByTestId("view-markdown")).toBeVisible();
    await page.getByTestId("create-editor-group-right").click();
    const leftGroup = page.getByRole("region", { name: "Editor group 1" });
    const rightGroup = page.getByRole("region", { name: "Editor group 2" });
    await expect(rightGroup).toBeVisible();
    await expect(leftGroup.getByTestId(editorTabTestId("brief.md"))).toBeVisible();
    await expect(rightGroup.getByTestId(editorTabTestId("brief.md"))).toBeVisible();
    await expect(leftGroup.getByTestId("view-markdown")).toBeVisible();
    await expect(rightGroup.getByTestId("view-markdown")).toBeVisible();

    await explorerRow(page, "data.csv").click();
    const markdown = leftGroup.getByTestId("view-markdown");
    const csv = rightGroup.getByTestId("view-csv");
    await expect(markdown).toBeVisible();
    await expect(csv).toBeVisible();

    const markdownBox = await markdown.boundingBox();
    const csvBox = await csv.boundingBox();
    expect(markdownBox).not.toBeNull();
    expect(csvBox).not.toBeNull();
    expect(markdownBox!.x + markdownBox!.width).toBeLessThanOrEqual(csvBox!.x + 1);

    const separator = page.getByRole("separator", { name: "Resize editor groups" });
    const before = Number(await separator.getAttribute("aria-valuenow"));
    await separator.focus();
    await separator.press("ArrowRight");
    await expect
      .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
      .toBeGreaterThan(before);

    const csvTabBox = await rightGroup.getByTestId(editorTabTestId("data.csv")).boundingBox();
    const leftBox = await leftGroup.boundingBox();
    expect(csvTabBox).not.toBeNull();
    expect(leftBox).not.toBeNull();
    await page.mouse.move(
      csvTabBox!.x + csvTabBox!.width / 2,
      csvTabBox!.y + csvTabBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(leftBox!.x + leftBox!.width / 2, leftBox!.y + 60, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(leftGroup.getByTestId(editorTabTestId("data.csv"))).toBeVisible();
    await expect(rightGroup.getByTestId(editorTabTestId("data.csv"))).toHaveCount(0);

    const lastTab = rightGroup.getByTestId(editorTabTestId("brief.md"));
    await lastTab.focus();
    await page.keyboard.press("ControlOrMeta+w");
    await expect(rightGroup).toHaveCount(0);
    await expect(leftGroup).toBeFocused();
    await expect(page.getByTestId(editorTabTestId("brief.md"))).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a group focused by a keyboard close shows its whole ring, and the active group keeps its mark in forced colors", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [{ path: "a.md", contents: "# Alpha\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const group = (number: number) => page.getByRole("region", { name: `Editor group ${number}` });
    const accent = await resolveColor(page, "var(--dohc-accent)");

    // One group: closing its last tab from the keyboard leaves it empty and
    // focused, with the ring on every edge.
    await explorerRow(page, "a.md").click();
    const onlyTab = page.getByTestId(editorTabTestId("a.md"));
    await expect(onlyTab).toHaveAttribute("aria-selected", "true");
    await tabToGroupTab(page, group(1), onlyTab);
    await page.keyboard.press("Delete");
    await expect(onlyTab).toHaveCount(0);
    await expect(group(1)).toBeFocused();
    await expectRing(page, group(1), accent, true);

    // A split of two groups with a tab each. Closing the right group's last
    // tab from the keyboard collapses it, and the left group takes focus
    // with its ring drawn over its open file.
    await explorerRow(page, "a.md").click();
    await group(1).getByTestId("create-editor-group-right").click();
    await tabToGroupTab(page, group(2), group(2).getByTestId(editorTabTestId("a.md")));
    await page.keyboard.press("Delete");
    await expect(group(2)).toHaveCount(0);
    await expect(group(1)).toBeFocused();
    await expect(group(1).getByTestId("view-markdown")).toBeVisible();
    await expectRing(page, group(1), accent, true);

    // Three groups, the middle one emptied by moving its tab to the left
    // group. Closing the right group's last tab from the keyboard collapses
    // it and focuses the empty middle group, still split beside a group with
    // a tab.
    await group(1).getByTestId("create-editor-group-right").click();
    await group(2).getByTestId("create-editor-group-right").click();
    await expect(group(3)).toBeVisible();
    await dragTabTo(page, group(2).getByTestId(editorTabTestId("a.md")), group(1));
    await expect(group(2).getByRole("tab")).toHaveCount(0);
    await tabToGroupTab(page, group(3), group(3).getByTestId(editorTabTestId("a.md")));
    await page.keyboard.press("Delete");
    await expect(group(3)).toHaveCount(0);
    await expect(group(2)).toBeFocused();
    await expect(group(2)).toHaveAttribute("aria-current", "true");
    await expectRing(page, group(2), accent, true);

    // Focus leaves the groups: the ring goes, and the active group's mark
    // stays on the empty group alone.
    await explorerRow(page, "a.md").focus();
    await expectRing(page, group(2), accent, false);
    await expectActiveMark(page, group(2), group(1), accent);

    // Forced colors drop fills. The mark stays, in the system Highlight
    // color, on the empty group and then on the group with a tab when it
    // becomes active.
    await page.emulateMedia({ forcedColors: "active" });
    const highlight = await resolveColor(page, "Highlight");
    await expectActiveMark(page, group(2), group(1), highlight);
    await group(1).getByTestId(editorTabTestId("a.md")).click();
    await expect(group(1)).toHaveAttribute("aria-current", "true");
    await explorerRow(page, "a.md").focus();
    await expectActiveMark(page, group(1), group(2), highlight);

    // A keyboard close in forced colors: the left group collapses and the
    // empty group left alone takes focus with its ring on every edge.
    await tabToGroupTab(page, group(1), group(1).getByTestId(editorTabTestId("a.md")));
    await page.keyboard.press("Delete");
    await expect(group(2)).toHaveCount(0);
    await expect(group(1)).toBeFocused();
    await expectRing(page, group(1), highlight, true);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
