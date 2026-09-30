import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles } from "./helpers/workspace";

test("@verification-smoke an editor change reaches disk and survives restart", async () => {
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [{ path: "proof.md", contents: "# Verification\n\nOriginal paragraph.\n" }]);
    desktop = await launchDesktopApp({ workspace });
    const opened = await openWorkspaceFromFirstRun(desktop.page, workspace);
    await waitForWorkspaceFile(desktop.page, opened.workspaceId, "proof.md");
    await explorerRow(desktop.page, "proof.md").click();
    const editor = desktop.page.getByTestId("markdown-editor");
    await expect(editor).toContainText("Original paragraph.");
    await editor.click();
    await desktop.page.keyboard.press("ControlOrMeta+End");
    await desktop.page.keyboard.type(" Durable verification edit.");
    await expect(desktop.page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    await expect.poll(() => readFile(join(workspace.rootPath, "proof.md"), "utf8")).toContain("Durable verification edit.");
    await desktop.close();
    desktop = null;
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    await waitForWorkspaceFile(desktop.page, opened.workspaceId, "proof.md");
    await explorerRow(desktop.page, "proof.md").click();
    await expect(desktop.page.getByTestId("markdown-editor")).toContainText("Durable verification edit.");
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await desktop.close();
    desktop = null;
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});

test("@artifact-proof a failing run keeps its desktop evidence", async () => {
  test.skip(process.env.DOHC_QA_ARTIFACT_PROBE !== "1", "Only the artifact verifier invokes this intentional failure.");
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    await expect(desktop.page.getByTestId("first-run-open-share")).toBeVisible();
    await desktop.page.evaluate(() => console.log("verification-artifact-sentinel"));
    expect("intentional artifact probe").toBe("failure required");
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});
