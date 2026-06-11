import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, openInTree } from "./launch";

// The local editing loop: edit in source mode, autosave through the bounded
// write IPC, the file on disk IS the result, and the watcher records it into
// history like any other writer.
test("markdown edits autosave to disk and land in history", async () => {
  const home = await mkdtemp(join(tmpdir(), "dohc-edit-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-edit-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: "edit-ws", kind: "personal", mode: "local-first" }),
  );
  await writeFile(join(root, "notes", "today.md"), "# Today\n");

  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  await openInTree(page, "notes/today.md");
  await expect(page.getByTestId("view-markdown")).toBeVisible();

  // Enter source mode, append a line, let the autosave settle.
  await page.getByTestId("markdown-edit-toggle").click();
  const editor = page.getByTestId("markdown-editor");
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nWritten in the desktop editor.");
  await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved", {
    timeout: 10_000,
  });

  // The on-disk file is the canonical result of the edit.
  expect(readFileSync(join(root, "notes", "today.md"), "utf8")).toContain(
    "Written in the desktop editor.",
  );

  // Back to the document: the rendered view shows the new content.
  await page.getByTestId("markdown-edit-toggle").click();
  await expect(page.getByTestId("view-markdown")).toContainText(
    "Written in the desktop editor.",
  );

  // The watcher records the edit into the visible history timeline.
  await expect(page.getByTestId("history-timeline")).toContainText(/today\.md/i, {
    timeout: 15_000,
  });

  await app.close();
});
