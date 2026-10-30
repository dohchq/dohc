import { holdSystemClipboard } from "./helpers/systemClipboard";
import { DOCUMENT_END } from "./helpers/keys";
import { test, expect } from "@playwright/test";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin } from "../src/testPins";
import {
  momentTextsForPath,
  replicationOpKindCount,
  replicationOpKindsMentioning,
  withEngineDb,
  ydocUpdateCount,
} from "./helpers/engineDb";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openHistoryView,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// WS-G2-C-2 editor-on-engine round trip. A rich markdown file edits
// through the engine Y.Doc provider (recordUpdate +
// debounced settle). The load-bearing proof: a
// live edit journals only as ydoc.update — not a duplicate moment.append that
// would collide (P0D) with the ydoc.update stream on a shared workspace — and
// the .md + engine.db reflect it, and a reopen resumes the rich content. The
// SQLite readers (withEngineDb / ydocUpdateCount / replication* / moment*) live
// in ./helpers/engineDb — shared with workspace-collab-decoupling.spec so the
// load-bearing "no double-journal" scaffolding can never drift.

async function openEngineDoc(page: import("@playwright/test").Page, path: string): Promise<void> {
  const segments = path.split("/");
  // Expand each parent folder, then open the file.
  for (let i = 0; i < segments.length - 1; i += 1) {
    await explorerRow(page, segments.slice(0, i + 1).join("/")).click();
  }
  await explorerRow(page, path).click();
  // Engine mode has no read/source Edit gate — the WYSIWYG editor is the whole
  // surface. Wait for it to take over (the local-editor Edit toggle disappears
  // once the engine session is live) so a keystroke can never land on the brief
  // pre-open local editor.
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
}

// The kept typing's notice: its toast, then its row in Notices.
function recoveryToast(page: import("@playwright/test").Page) {
  return page.getByTestId("workspace-shell-notice").filter({hasText: "Text kept in History"});
}

async function restoreRestartTyping(desktop: Awaited<ReturnType<typeof launchDesktopApp>>, rootPath: string, workspaceId: string, path: string, human: string, external: string, open: "notice" | "history") {
  const {page, app} = desktop;
  let recoveryId = "";
  await expect.poll(async () => {
    const status = await page.evaluate(async workspaceId => {
      const api = (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop;
      return api.getCaptureRecoveryStatus({workspaceId});
    }, workspaceId);
    recoveryId = status.captureRecoveries.find(recovery => recovery.path === path)?.momentId ?? "";
    return recoveryId;
  }, {timeout: 30_000}).not.toBe("");
  const detail = await page.evaluate(async input => (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.readEngineMoment(input), {workspaceId, momentId: recoveryId});
  expect(detail.moment?.beforeText).toContain(human);
  expect(detail.moment?.afterText).toContain(external);
  await expect.poll(() => momentTextsForPath(rootPath, path)).toEqual(expect.arrayContaining([expect.stringContaining(external)]));
  const orders = withEngineDb(rootPath, db => db.prepare("SELECT r.moment_order AS recoveryOrder,c.moment_order AS captureOrder FROM moments r JOIN moments c ON c.moment_id=r.metadata_correlation_id WHERE r.moment_id=?").get(recoveryId) as {recoveryOrder: number; captureOrder: number});
  if (!orders) throw new Error("recovery must link to its committed outside capture");
  expect(orders.captureOrder).toBeLessThan(orders.recoveryOrder);
  expect(await readFile(join(rootPath,path), "utf8")).toContain(external);
  if (open === "notice") {
    const toast = recoveryToast(page);
    await expect(toast).toContainText(`The file "${path}" changed outside dohc. Your text is in History. Open the recovery change and choose Restore.`, {timeout: 30_000});
    await toast.getByTestId("workspace-shell-error-action").click();
    await expect(page.getByTestId(activityPin("history"))).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("engine-moment-diff-page")).toHaveAttribute("data-moment-id", recoveryId);
    await expect(page.getByTestId("engine-diff-source")).toHaveText("Text kept");
  } else {
    await openHistoryView(page);
    await page.locator(`[data-testid="engine-moment-open"][data-moment-id="${recoveryId}"]`).click();
  }
  await expect(page.getByTestId("engine-diff-lines")).toContainText(human);
  // A shared live file's way back: Copy your version copies the kept file whole.
  await holdSystemClipboard(test.info(), async (remainingMs) => {
    await page.getByTestId("engine-diff-copy-typing").click({ timeout: remainingMs() });
    // Windows hands clipboard text back with CRLF line endings.
    await expect.poll(async () => (await app.evaluate(({clipboard}) => clipboard.readText())).replace(/\r\n/g, "\n"), { timeout: remainingMs() }).toBe(detail.moment?.beforeText);
  });
  // Opening the recovery and copying it keep it listed until Restore.
  const kept = await page.evaluate(async workspaceId => (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.getCaptureRecoveryStatus({workspaceId}), workspaceId);
  expect(kept.captureRecoveries.map(recovery => recovery.momentId)).toContain(recoveryId);
  await page.getByTestId("engine-diff-restore-file").click();
  await expect(page.getByTestId("engine-diff-restore-status")).toContainText("Restored the earlier state");
  await expect.poll(() => readFile(join(rootPath,path), "utf8")).toContain(human);
  await expect.poll(() => page.evaluate(async workspaceId => (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.getCaptureRecoveryStatus({workspaceId}), workspaceId)).toEqual({captureRecoveries: []});
  // The restore cleared the recovery, so its notice goes too.
  await expect(recoveryToast(page)).toHaveCount(0);
  await page.getByTestId("notice-center-toggle").click();
  await expect(page.locator("[data-notice-row]").filter({hasText: "Text kept in History"})).toHaveCount(0);
  await page.getByTestId("notice-center-toggle").click();
}

test("rich doc edits through the engine Y.Doc: settle lands on .md + engine.db, only ydoc.update journals, reopen resumes", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "Engine-journaled sentence, no double capture.";

  try {
    await writeWorkspaceFiles(temp, [
      { path: "notes/rich.md", contents: "# Rich\n\nBase paragraph.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;

    // No websocket may ever open — the engine provider is relay-free.
    const webSockets: string[] = [];
    page.on("websocket", (ws) => webSockets.push(ws.url()));

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/rich.md");

    await openEngineDoc(page, "notes/rich.md");

    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(sentinel);

    // The debounced settle projects the edit into engine.db and writes the.md.
    await expect
      .poll(async () => await readFile(join(temp.rootPath, "notes/rich.md"), "utf8").catch(() => ""), {
        timeout: 20_000,
      })
      .toContain(sentinel);

    // engine.db reflects it: the CRDT lineage exists (ydoc.update ops) and the
    // settle projected a history moment carrying the text.
    await expect.poll(() => ydocUpdateCount(temp.rootPath), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => momentTextsForPath(temp.rootPath, "notes/rich.md").some((t) => t.includes(sentinel)), {
        timeout: 20_000,
      })
      .toBe(true);

    // The load-bearing assertion: the edit replicates as ydoc.update ops, and
    // the watcher's observation of the settle's own.md write was deferred — so
    // the typed sentence never became a moment.append (a double-journal that on
    // a shared workspace would collide as a P0D). Since a ydoc.update payload is
    // opaque, the sentinel plaintext must appear in NO replication op at all.
    // Post-cutover a LOCAL workspace journals no outbound replication ops at
    // all (emit_outbound requires Regime::Replicated), so on this fixture the
    // replication-op assertions below are structural only — the LOAD-BEARING
    // double-journal check is the moments table: the settle projects exactly
    // one sentinel moment, and a capture re-observing the settle's own.md
    // self-write (the P0D class) would append a second.
    expect(
      momentTextsForPath(temp.rootPath, "notes/rich.md").filter((t) =>
        t.includes(sentinel),
      ),
    ).toHaveLength(1);
    const opKindsWithSentinel = replicationOpKindsMentioning(temp.rootPath, sentinel);
    expect(opKindsWithSentinel).not.toContain("moment.append");
    expect(opKindsWithSentinel).toEqual([]);
    expect(replicationOpKindCount(temp.rootPath, "conflict.open")).toBe(0);
    expect(webSockets).toEqual([]);

    // Reopen resumes the rich content (a replicated doc never prunes; it resumes
    // from its CRDT lineage / the projected .md).
    await explorerRow(page, "notes").click();
    await openEngineDoc(page, "notes/rich.md");
    await expect(page.getByTestId("markdown-editor")).toContainText(sentinel);

    // "View markdown as source": the header toggle flips to a READ-ONLY
    // projection of the engine Y.Doc through the same yDocToMarkdown the
    // settle uses — raw markup (the `#` the editor renders as a heading) is
    // visible as text, and the surface refuses edits (the derived markdown
    // cache must never become an editable source of truth).
    await page.getByTestId("markdown-source-toggle").click();
    const sourceView = page.getByTestId("markdown-source-view");
    await expect(sourceView).toBeVisible();
    await expect(sourceView).toContainText("# Rich");
    await expect(sourceView).toContainText(sentinel);
    await expect(sourceView.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    // The WYSIWYG editor is hidden, not unmounted (undo/cursor survive).
    await expect(page.getByTestId("markdown-editor")).toBeHidden();
    // Toggling back restores the WYSIWYG editor with the same content.
    await page.getByTestId("markdown-source-toggle").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible();
    await expect(page.getByTestId("markdown-editor")).toContainText(sentinel);

    // History says how the typed sentence arrived. The settle names no
    // author, so the row names the live edit and not a person.
    await openHistoryView(page);
    await expect(
      page
        .locator('[data-testid="engine-moment-open"][data-moment-path="notes/rich.md"]')
        .first()
        .getByTestId("engine-moment-source"),
    ).toHaveText("Live edit");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

async function quitDesktop(desktop: Awaited<ReturnType<typeof launchDesktopApp>>) {
  const startedAt = process.hrtime.bigint();
  const exited = new Promise<{ exitedAt: bigint; exitCode: number | null }>(resolve =>
    desktop.app.process().once("exit", exitCode => resolve({exitedAt: process.hrtime.bigint(), exitCode})));
  const streamsClosed = new Promise<void>(resolve => desktop.app.process().once("close", () => resolve()));
  await desktop.app.evaluate(({app}) => {
    process.env.DOHC_TEST_QUIT_TIMING = "1";
    app.quit();
  });
  const {exitedAt, exitCode} = await exited;
  // Child-process close follows stdout drain, so the main-process mark is complete.
  await streamsClosed;
  const output = desktop.logs.filter(entry => entry.source === "main" && entry.level === "stdout").map(entry => entry.text).join("");
  const marks = [...output.matchAll(/DOHC_TEST_WILL_QUIT:(\d+)/g)];
  expect(marks).toHaveLength(1);
  const willQuitToExitMs = Number(exitedAt - BigInt(marks[0]![1]!)) / 1e6;
  await test.info().attach("quit-duration", {
    body: JSON.stringify({
      requestToExitMs: Number(exitedAt - startedAt) / 1e6, willQuitToExitMs, exitCode,
      budgetMs: 6000, budgetStartsAt: "will-quit", budgetMarginMs: 6000 - willQuitToExitMs,
    }), contentType: "application/json",
  });
  await desktop.close();
}

test("@restart-durability-idle-external an external edit to an idle open document is imported after restart", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{path: "notes/rich.md", contents: "# Rich\n\nBase paragraph.\n"}]);
    desktop = await launchDesktopApp({workspace: temp});
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, "notes/rich.md");
    await openEngineDoc(desktop.page, "notes/rich.md");
    await writeWorkspaceFiles(temp, [{path: "notes/rich.md", contents: "# Rich\n\nWritten outside dohc.\n"}]);
    await quitDesktop(desktop);
    desktop = await launchDesktopApp({workspace: temp});
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await expect(desktop.page.getByTestId("markdown-editor")).toContainText("Written outside dohc.");
    await expect.poll(() => momentTextsForPath(temp.rootPath, "notes/rich.md")).toEqual(expect.arrayContaining([expect.stringContaining("Written outside dohc.")]));
  } finally {await cleanupDesktopWorkspace(desktop, temp);}
});

// The `<stem> (recovered …).md` siblings beside `<stem>.md` in one folder.
async function recoveredSiblings(rootPath: string, folder: string, stem: string): Promise<string[]> {
  const prefix = `${stem} (recovered `;
  const names = await readdir(join(rootPath, folder));
  return names.filter(name => name.startsWith(prefix) && name.endsWith(".md")).map(name => `${folder}/${name}`);
}

test("@restart-durability-overlapping-typing overlapping typing on an externally edited document survives restart as a recovered copy", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const external = "External agent wrote this straight to disk while the editor was open.";
  const human = "Human continued typing in the open document.";
  const path = "notes/rich.md";
  try {
    await writeWorkspaceFiles(temp, [{path, contents: "# Rich\n\nBase paragraph.\n"}]);
    desktop = await launchDesktopApp({workspace: temp});
    const {page} = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, path);
    await openEngineDoc(page, path);
    await expect(page.getByTestId("markdown-editor")).toContainText("Base paragraph.");
    await writeWorkspaceFiles(temp, [{path, contents: `# Rich\n\n${external}\n`}]);
    // The live lease defers capture. Settlement must preserve the outside bytes.
    await page.getByTestId("markdown-editor").click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(human);
    // The outside-write signal can reach main before or after the refused save.
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", /^(error|changed-on-disk)$/);
    expect(await readFile(join(temp.rootPath, path), "utf8")).toContain(external);
    await expect(page.getByTestId("markdown-editor")).toContainText(human);
    await quitDesktop(desktop);
    // Teardown captured the outside bytes and folded the closed document onto
    // them. The typing is not lost with it: it comes back as an ordinary
    // sibling file, complete, that the explorer lists and History explains.
    desktop = await launchDesktopApp({workspace: temp});
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, path);
    await expect(desktop.page.getByTestId("markdown-editor")).toContainText(external);
    await expect(desktop.page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    expect(await readFile(join(temp.rootPath, path), "utf8")).toBe(`# Rich\n\n${external}\n`);
    await expect.poll(() => recoveredSiblings(temp.rootPath, "notes", "rich")).toHaveLength(1);
    const [recovered] = await recoveredSiblings(temp.rootPath, "notes", "rich");
    const copy = await readFile(join(temp.rootPath, recovered!), "utf8");
    expect(copy.split("\n").filter(line => line.length > 0)).toEqual(["# Rich", `Base paragraph.${human}`]);
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, recovered!);
    await expect(explorerRow(desktop.page, recovered!)).toBeVisible();
    expect(momentTextsForPath(temp.rootPath, recovered!)).toEqual([copy]);
    await restoreRestartTyping(desktop, temp.rootPath, workspace.workspaceId, path, human, external, "notice");
    // History explains the sibling on screen, not only in the database: the
    // row names the recovery and credits the live edit, not a person.
    await openHistoryView(desktop.page);
    const recoveredRow = desktop.page.locator(`[data-testid="engine-moment-open"][data-moment-path="${recovered!}"]`).first();
    await expect(recoveredRow).toContainText(`Recovered unsaved edits from ${path} after a later write changed the file.`);
    await expect(recoveredRow.getByTestId("engine-moment-source")).toHaveText("Live edit");
    await quitDesktop(desktop);
  } finally {await cleanupDesktopWorkspace(desktop, temp);}
});

test("@restart-durability-capture-before-reopen kept typing survives capture before the renderer reopens after restart", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const external = "External agent wrote this straight to disk while the editor was open.";
  const human = "Human continued typing in the open document.";
  const path = "notes/rich.md";
  try {
    await writeWorkspaceFiles(temp, [{path, contents: "# Rich\n\nBase paragraph.\n"}]);
    desktop = await launchDesktopApp({workspace: temp});
    const {page} = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, path);
    await openEngineDoc(page, path);
    await expect(page.getByTestId("markdown-editor")).toContainText("Base paragraph.");
    await writeWorkspaceFiles(temp, [{path, contents: `# Rich\n\n${external}\n`}]);
    // The live lease defers capture. Settlement must preserve the outside bytes.
    await page.getByTestId("markdown-editor").click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(human);
    // The outside-write signal can reach main before or after the refused save.
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", /^(error|changed-on-disk)$/);
    expect(await readFile(join(temp.rootPath, path), "utf8")).toContain(external);
    await expect(page.getByTestId("markdown-editor")).toContainText(human);
    await quitDesktop(desktop);
    // Workbench state lives in the workspace, independently of the Electron profile.
    // Remove only this test's reopen intent so capture has no renderer lease.
    await rm(join(temp.rootPath, ".dohc", "local", "ui-state.json"), { force: true });
    desktop = await launchDesktopApp({workspace: { ...temp, baseDir: join(temp.baseDir, "fresh-profile") }});
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await expect(desktop.page.getByTestId("markdown-editor")).toHaveCount(0);
    // This existing read flushes capture before an editor can hold a lease.
    await desktop.page.evaluate(async ({ workspaceId, path }) => {
      const api = (window as unknown as { dohcDesktop: {
        chatFileMentionsPage(input: { workspaceId: string; subject: { path: string } }): Promise<unknown>;
      } }).dohcDesktop;
      await api.chatFileMentionsPage({ workspaceId, subject: { path } });
    }, { workspaceId: workspace.workspaceId, path });
    await expect(desktop.page.getByTestId("markdown-editor")).toHaveCount(0);
    await openEngineDoc(desktop.page, path);
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, path);
    await expect(desktop.page.getByTestId("markdown-editor")).toContainText(external);
    await expect(desktop.page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    expect(await readFile(join(temp.rootPath, path), "utf8")).toBe(`# Rich\n\n${external}\n`);
    await expect.poll(() => recoveredSiblings(temp.rootPath, "notes", "rich")).toHaveLength(1);
    const [recovered] = await recoveredSiblings(temp.rootPath, "notes", "rich");
    const copy = await readFile(join(temp.rootPath, recovered!), "utf8");
    expect(copy.split("\n").filter(line => line.length > 0)).toEqual(["# Rich", `Base paragraph.${human}`]);
    await restoreRestartTyping(desktop, temp.rootPath, workspace.workspaceId, path, human, external, "history");
    await quitDesktop(desktop);
  } finally {await cleanupDesktopWorkspace(desktop, temp);}
});

test("renaming a property of a live document keeps its place and comments through save and reopen", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  // One file with comments and quoting, and one in canonical form.
  const files = [
    {
      path: "trip.md", to: "cost", source: 1,
      written: '---\n# Monthly\nbudget:  100 # euros\n# Wi-Fi password\n"wifi": hunter2\n---\n\n# Trip\n\nBase paragraph.',
      renamed: '---\n# Monthly\ncost:  100 # euros\n# Wi-Fi password\n"wifi": hunter2\n---\n\n# Trip\n\nBase paragraph.',
    },
    {
      // The pills show every line, so the properties offer no Source button.
      path: "plan.md", to: "yearly", source: 0,
      written: "---\nbudget: 100\nwifi: hunter2\n---\n\n# Plan\n\nBase paragraph.",
      renamed: "---\nyearly: 100\nwifi: hunter2\n---\n\n# Plan\n\nBase paragraph.",
    },
  ];
  const fileText = (path: string) => readFile(join(temp.rootPath, path), "utf8");
  // An open document stays mounted while hidden, so read the visible panel.
  const panel = (page: import("@playwright/test").Page) => page.locator('[data-testid="properties-panel"]:visible');
  const names = (page: import("@playwright/test").Page) =>
    panel(page).getByTestId("property-key").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  try {
    await writeWorkspaceFiles(temp, files.map(({path, written}) => ({path, contents: written})));
    desktop = await launchDesktopApp({workspace: temp});
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    for (const {path, to, renamed, source} of files) {
      await waitForWorkspaceFile(desktop.page, workspace.workspaceId, path);
      await openEngineDoc(desktop.page, path);
      await expect(panel(desktop.page).getByTestId("properties-source")).toHaveCount(source);
      const name = panel(desktop.page).getByLabel("Property 1 name");
      await expect(name).toHaveValue("budget");
      await name.fill("");
      // One key at a time, as a person types: each letter renames the property.
      await name.pressSequentially(to);
      await expect.poll(() => fileText(path), {timeout: 20_000}).toBe(renamed);
      expect(await names(desktop.page)).toEqual([to, "wifi"]);
    }
    await quitDesktop(desktop);

    desktop = await launchDesktopApp({workspace: temp});
    await openWorkspaceFromFirstRun(desktop.page, temp);
    for (const {path, to, renamed} of files) {
      await waitForWorkspaceFile(desktop.page, workspace.workspaceId, path);
      await openEngineDoc(desktop.page, path);
      await expect(panel(desktop.page).getByLabel(`Property ${to} value`)).toHaveValue("100");
      expect(await names(desktop.page)).toEqual([to, "wifi"]);
      expect(await fileText(path)).toBe(renamed);
    }
    await quitDesktop(desktop);
  } finally {await cleanupDesktopWorkspace(desktop, temp);}
});

// WS-G2-C-2 gate fix 2 — a version op while a rich doc is live must settle +
// close the session FIRST. Otherwise the live session keeps its old versionId
// and a later settle writes a stale projection into the now-active version
// (two-canonical / two-lineage corruption). Here a version is created through
// the product bridge while the editor is open; the fix flushes the in-flight
// edit and releases the session before materializing.
test("creating a version while a rich doc is live flushes + closes the session (no stale projection, edit preserved)", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "Edit that a version op must flush before switching.";

  try {
    await writeWorkspaceFiles(temp, [
      { path: "notes/rich.md", contents: "# Rich\n\nBase paragraph.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/rich.md");
    await openEngineDoc(page, "notes/rich.md");

    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(sentinel);

    // Create a version through the bridge while the doc is still live. The main-
    // process version op awaits settleAndCloseLiveYDocSessions first — the call
    // only resolves after the live session flushed + released.
    const created = await page.evaluate(async (workspaceId) => {
      const api = (window as unknown as {
        dohcDesktop: {
          createWorkspaceVersion(p: { workspaceId: string; name: string }): Promise<unknown>;
        };
      }).dohcDesktop;
      await api.createWorkspaceVersion({ workspaceId, name: "snapshot" });
      return true;
    }, workspace.workspaceId);
    expect(created).toBe(true);

    // The in-flight edit was flushed by the forced settle-on-close (not lost to
    // the fork-from-disk), so it is a durable moment and on disk.
    await expect
      .poll(() => momentTextsForPath(temp.rootPath, "notes/rich.md").some((t) => t.includes(sentinel)), {
        timeout: 20_000,
      })
      .toBe(true);
    expect(await readFile(join(temp.rootPath, "notes/rich.md"), "utf8")).toContain(sentinel);

    // A second (named) version now exists — the op completed past the flush.
    expect(
      withEngineDb(temp.rootPath, (db) =>
        Number(
          (db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number } | undefined)?.n ?? 0,
        ),
      ),
    ).toBeGreaterThanOrEqual(2);

    // Reopening the doc works cleanly (the reservation was released — no leaked
    // single-canonical) and still shows the edit.
    await explorerRow(page, "notes").click();
    await openEngineDoc(page, "notes/rich.md");
    await expect(page.getByTestId("markdown-editor")).toContainText(sentinel);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
