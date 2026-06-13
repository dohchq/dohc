import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchApp } from "./launch";

// Phase E5 graph gate: local-first workspace graph from markdown links.
// It proves wikilinks, relative markdown links, unresolved-link notice, and
// click-to-open through the same tab path as Explorer/Search.

const SCREENSHOT_DIR = "test-results/screenshots/e5-graph";

async function seedWorkspace(
  workspaceId: string,
  files: Record<string, string>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-e5-graph-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-e5-graph-")), "workspace");
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

test("graph view builds a local markdown link map and opens documents", async () => {
  const { home, root } = await seedWorkspace("e5-graph", {
    "index.md": [
      "# Index",
      "[[Project]]",
      "[Decision](archive/decision.md)",
      "[[Missing note]]",
    ].join("\n"),
    "notes/project.md": "# Project\n[Decision](../archive/decision.md)\n",
    "archive/decision.md": "# Decision\n",
    "notes/raw.txt": "[[Project]]",
  });
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  await page.getByTestId("activity-graph").click();
  await expect(page.getByTestId("graph-view")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(page.getByTestId("graph-doc-count")).toHaveText("3 docs");
  await expect(page.getByTestId("graph-link-count")).toHaveText("3 links");
  await expect(page.getByTestId("graph-unresolved-count")).toContainText(
    "1 unresolved",
  );
  await expect(page.getByTestId("graph-edge")).toHaveCount(3);

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/graph-view--1280x800--light.png`,
  });

  await page
    .locator('[data-testid="graph-file-row"][data-path="archive/decision.md"]')
    .click();
  await expect(page.getByTestId("tab-archive/decision.md")).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.getByText("Decision").first()).toBeVisible();

  await app.close();
});
