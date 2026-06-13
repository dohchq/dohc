import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { launchApp, openInTree } from "./launch";

async function seedWorkspace(
  workspaceId: string,
  files: Record<string, string>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-e4-editor-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-e4-editor-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" }),
  );
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return { home, root };
}

async function openSeeded(home: string, root: string) {
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  return { app, page };
}

test("WYSIWYG editor types, runs slash table, completes wikilinks, and saves markdown to disk", async () => {
  test.setTimeout(90_000);
  const { home, root } = await seedWorkspace("e4-editor", {
    "notes/today.md": "# Today\n",
    "notes/linked.md": "# Linked\n",
  });
  const { app, page } = await openSeeded(home, root);

  await openInTree(page, "notes/today.md");
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  const editor = page.getByTestId("markdown-editor");
  await expect(editor).toBeVisible();
  await page.waitForTimeout(50);

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nWYSIWYG words.");
  await expect
    .poll(() => readFileSync(join(root, "notes", "today.md"), "utf8"), {
      timeout: 10_000,
    })
    .toContain("WYSIWYG words.");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n/table");
  await expect(page.getByRole("listbox", { name: "slash commands" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor.locator("table")).toBeVisible();

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n[[lin");
  await expect(page.getByRole("listbox", { name: "page links" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => readFileSync(join(root, "notes", "today.md"), "utf8"), {
      timeout: 10_000,
    })
    .toContain("[[notes/linked]]");

  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
  await expect(page.getByTestId("markdown-editor")).toContainText("WYSIWYG words.");
  await expect(page.getByTestId("markdown-editor")).toContainText("[[notes/linked]]");

  await app.close();
});

test("opening and toggling source on an untouched markdown file does not rewrite bytes", async () => {
  const original = "---\ntitle: Stable\n---\n\n# Stable\n\n- one\n- two\n";
  const { home, root } = await seedWorkspace("e4-stable", {
    "stable.md": original,
  });
  const { app, page } = await openSeeded(home, root);

  await openInTree(page, "stable.md");
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
  await page.waitForTimeout(1_000);

  expect(readFileSync(join(root, "stable.md"), "utf8")).toBe(original);
  await app.close();
});
