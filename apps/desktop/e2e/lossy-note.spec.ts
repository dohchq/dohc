import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import {
  CLI_PROTOCOL_VERSION,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import { readHistoryMoments } from "./helpers/history";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openHistoryView,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

// A lossy note (CONTEXT.md) opens read-only, with no engine session, and
// nothing that skips the editor writes it either. The README holds the four
// forms #2458 found in the app.

const README = [
  "# Readme",
  "",
  "<details>",
  "<summary>More</summary>",
  "",
  "Hidden until opened.",
  "</details>",
  "",
  "See [the docs][docs].",
  "",
  "![logo](/docs/logo.png)",
  "",
  "1. Install:",
  "",
  "       pnpm install",
  "",
  "[docs]: https://example.com/docs",
  "",
].join("\n");
const OUTSIDE = README.replace("Hidden until opened.", "Changed by an agent's own tools.");
// Bytes dohc writes for this note, so it opens for editing at once.
const PLAN = "# Plan\n\n- [ ] Book flights\n\n**Budget:** $1,200\n";

const sha256 = async (rootPath: string, path: string) =>
  createHash("sha256").update(await readFile(join(rootPath, path))).digest("hex");

async function agentCli<Verb extends CliVerb>(
  temp: TempWorkspace,
  verb: Verb,
  args: Omit<Extract<CliRequestWithoutToken, { verb: Verb }>["args"], "cwd" | "actor">,
): Promise<CliResultByVerb[Verb]> {
  const request = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb,
    args: { cwd: temp.rootPath, actor: "agent" as const, ...args },
  } as unknown as Extract<CliRequestWithoutToken, { verb: Verb }>;
  return await sendCliRequest<Verb>(request, { stateDir: temp.homeDir });
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.screenshot({ path: test.info().outputPath(`${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
}

test("@lossy-note a lossy note opens read-only, takes no edit it didn't choose, and edits anyway after a warning", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "readme.md", contents: README },
      { path: "plan.md", contents: PLAN },
    ]);
    const original = await sha256(temp.rootPath, "readme.md");
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const opened = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, opened.workspaceId, "readme.md");
    await waitForWorkspaceFile(page, opened.workspaceId, "plan.md");

    // A note dohc wrote opens straight into the editor.
    await explorerRow(page, "plan.md").click();
    await expect(page.getByTestId("markdown-source-toggle")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");
    await expect(page.getByTestId("lossy-note-notice")).toHaveCount(0);

    // The README shows its text at once, read-only, and says why.
    await explorerRow(page, "readme.md").click();
    const notice = page.getByTestId("lossy-note-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("dohc can't edit this document yet without changing parts it can't show.");
    await expect(page.getByTestId("view-markdown")).toContainText("Hidden until opened.");
    await expect(page.getByTestId("markdown-editor")).toHaveCount(0);
    await expect(page.getByTestId("markdown-edit-toggle")).toBeDisabled();
    await shoot(page, "lossy-note-notice");
    // Keyboard: the notice's actions take focus.
    await page.getByTestId("lossy-note-open-externally").focus();
    await expect(page.getByTestId("lossy-note-open-externally")).toBeFocused();

    // Typing reaches nothing.
    await page.getByTestId("view-markdown").getByText("See the docs.").click();
    await page.keyboard.type("Typed into a lossy note.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("view-markdown")).not.toContainText("Typed into a lossy note.");

    // An agent reads the file as it is, and its edit is refused.
    await waitForCliEndpoint(temp.homeDir);
    await expect(agentCli(temp, "documentRead", { path: "readme.md" }))
      .resolves.toMatchObject({ ok: true, path: "readme.md", markdown: README });
    await expect(agentCli(temp, "documentEdit", {
      agent: "e2e-agent", path: "readme.md", find: "Hidden until opened.", replacement: "Shown.",
    })).resolves.toMatchObject({
      ok: false,
      reason: "dohc can't change readme.md without also changing parts it can't show, such as raw HTML or reference links. Edit the file directly instead.",
    });
    expect(await sha256(temp.rootPath, "readme.md")).toBe(original);

    // An agent's own file tools still change it: History records the change
    // and the open view shows the new text.
    const before = (await readHistoryMoments(page, opened.workspaceId, "readme.md"))?.length ?? 0;
    await writeWorkspaceFiles(temp, [{ path: "readme.md", contents: OUTSIDE }]);
    await expect(page.getByTestId("view-markdown")).toContainText("Changed by an agent's own tools.");
    await expect(notice).toBeVisible();
    await expect.poll(async () => (await readHistoryMoments(page, opened.workspaceId, "readme.md"))?.length ?? 0)
      .toBe(before + 1);
    const outside = await sha256(temp.rootPath, "readme.md");

    // Edit anyway warns first. Escape and Cancel change nothing.
    const editAnyway = page.getByTestId("lossy-note-edit-anyway");
    await editAnyway.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Edit this document anyway?" });
    await expect(dialog).toContainText("Saving rewrites the parts dohc can't show, such as raw HTML or reference links. History keeps the original.");
    await shoot(page, "lossy-note-edit-anyway");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("markdown-editor")).toHaveCount(0);

    await editAnyway.click();
    await page.getByTestId("lossy-note-edit-anyway-confirm").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    await expect(notice).toHaveCount(0);
    await editor.getByText("Changed by an agent's own tools.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Edited anyway.");
    await expect(editor).toContainText("Edited anyway.");
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    await expect.poll(() => sha256(temp.rootPath, "readme.md")).not.toBe(outside);

    // History gives back the file from before the edit, byte for byte.
    await openHistoryView(page);
    await expect.poll(async () => (await readHistoryMoments(page, opened.workspaceId, "readme.md"))?.length ?? 0)
      .toBe(before + 2);
    const moments = (await readHistoryMoments(page, opened.workspaceId, "readme.md"))!;
    const edit = moments.reduce((newest, moment) => moment.momentOrder > newest.momentOrder ? moment : newest);
    await page.locator(`[data-testid="engine-moment-open"][data-moment-id="${edit.id}"]`).click();
    await page.getByTestId("engine-diff-restore-file").click();
    await page.getByTestId("engine-diff-confirm-restore").click();
    await expect(page.getByTestId("engine-diff-restore-status")).toContainText("Restored the earlier state");
    // On a mismatch, the assertion prints the exact difference.
    await expect.poll(() => readFile(join(temp.rootPath, "readme.md"), "utf8")).toBe(OUTSIDE);
    expect(await sha256(temp.rootPath, "readme.md")).toBe(outside);

    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await desktop.close();
    desktop = null;
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
