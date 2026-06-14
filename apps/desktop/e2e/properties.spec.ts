import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchApp, openInTree } from "./launch";

// Phase E5 properties gate: markdown frontmatter gets a friendly contextual
// editor, while id/title remain system-owned metadata.

const SCREENSHOT_DIR = "test-results/screenshots/e5-properties";

async function seedWorkspace(
  workspaceId: string,
  files: Record<string, string>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-e5-properties-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-e5-properties-")), "workspace");
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

test("properties panel edits user frontmatter and preserves system fields", async () => {
  const { home, root } = await seedWorkspace("e5-properties", {
    "notes/plan.md": "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n",
  });

  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await openInTree(page, "notes/plan.md");

  await page.getByTestId("markdown-properties-toggle").click();
  const panel = page.getByTestId("properties-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("property-key")).toHaveValue("status");

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/properties-panel--1280x800--light.png`,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/properties-panel--1280x800--dark.png`,
  });
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/properties-panel--1536x960--light.png`,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/properties-panel--1536x960--dark.png`,
  });

  await panel.getByTestId("property-value").fill("ready");
  await expect
    .poll(() => readFileSync(join(root, "notes", "plan.md"), "utf8"), {
      timeout: 10_000,
    })
    .toBe("---\nid: note-1\ntitle: Plan\nstatus: ready\n---\n\n# Plan\n");

  await panel.getByTestId("property-add").click();
  await panel.getByLabel("Property 2 name").fill("owner");
  await panel.getByLabel("Property owner value").fill("ice");
  await expect
    .poll(() => readFileSync(join(root, "notes", "plan.md"), "utf8"), {
      timeout: 10_000,
    })
    .toBe(
      "---\nid: note-1\ntitle: Plan\nstatus: ready\nowner: ice\n---\n\n# Plan\n",
    );

  await app.close();
});
