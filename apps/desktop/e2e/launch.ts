import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright";

// Single source for launching the built desktop app in E2E. Keeps the
// dist path, the WSL --no-sandbox flag, and the test env in one place.
export async function launchApp(
  env: Record<string, string> = {},
): Promise<ElectronApplication> {
  const args = ["apps/desktop/dist/main/main.js"];
  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
  // EVERY launch gets a distinct userData dir: the single-instance lock keys
  // on it (so two clients can run CONCURRENTLY for live co-editing), and
  // renderer-origin state (localStorage, e.g. the stored theme) must never
  // leak between tests or runs. Test-only app state (registry, credentials,
  // window state) already lives under DOHC_TEST_HOME.
  const userData =
    env.DOHC_TEST_USER_DATA ?? (await mkdtemp(join(tmpdir(), "dohc-e2e-ud-")));
  args.push(`--user-data-dir=${userData}`);
  return electron.launch({
    args,
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1", ...env },
  });
}

// THE navigation helper for the nested explorer tree (Phase E3): expands
// each folder segment of `path` (skipping ones already expanded), waits for
// the leaf row, and clicks it — the spec-side twin of the old flat-list
// `getByText("<full/path>").click()`. Pass { click: false } to only REVEAL
// the row (visibility assertions, e.g. files arriving via cloud sync — the
// timeout covers late-arriving rows under an already-expanded folder).
export async function openInTree(
  page: Page,
  path: string,
  options: { click?: boolean; timeout?: number } = {},
): Promise<Locator> {
  const { click = true, timeout = 15_000 } = options;
  const tree = page.getByTestId("file-tree");
  const segments = path.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const folderPath = segments.slice(0, i + 1).join("/");
    // tree-row scoped: a PINNED row carries the same data-path.
    const folder = tree.locator(
      `[data-testid="tree-row"][data-path="${folderPath}"][data-kind="folder"]`,
    );
    await folder.waitFor({ state: "visible", timeout });
    // Converge instead of single-shot: clicking TOGGLES expansion, and the
    // read-then-click can race an app-side expansion update (e.g. the
    // post-rename remap landing between the read and the click would turn
    // this click into a COLLAPSE). Re-read and re-toggle until expanded.
    const deadline = Date.now() + timeout;
    while ((await folder.getAttribute("aria-expanded")) !== "true") {
      if (Date.now() > deadline) {
        throw new Error(`openInTree: could not expand folder "${folderPath}"`);
      }
      await folder.click();
      await page.waitForTimeout(100);
    }
  }
  const leaf = tree.locator(`[data-testid="tree-row"][data-path="${path}"]`);
  await leaf.waitFor({ state: "visible", timeout });
  if (click) await leaf.click();
  return leaf;
}
