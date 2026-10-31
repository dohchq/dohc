import { holdSystemClipboard } from "./helpers/systemClipboard";
import { DOCUMENT_END } from "./helpers/keys";
import { test, expect } from "@playwright/test";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { CHECKPOINT_FAILURE_MESSAGE, AUTHOR_REFUSED_MESSAGE } from "../src/workspaces/typingRecoveryWords";
import { launchDesktopApp } from "./helpers/desktopApp";
import { engineDaemonPids, hardKillPid, hardKillAppTree } from "./helpers/daemonKill";
import { withEngineDb } from "./helpers/engineDb";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openHistoryView, openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles } from "./helpers/workspace";

const sentinels = ["EARLY_QUIT_ONE_741", "EARLY_QUIT_TWO_852", "EARLY_QUIT_THREE_963"];
async function checkpointText(home: string): Promise<string> {
  const directory = join(home, "live-draft-recovery");
  const names = await readdir(directory).catch(() => []);
  return (await Promise.all(names.filter(n => n.endsWith(".json")).map(n => readFile(join(directory, n), "utf8")))).join(" ");
}

for (const mode of ["quit", "last-window", "crash", "crash-reopen-before-import", "outside-edit", "deleted-file", "write-failure", "refused-import"] as const) {
  test("outage typing survives " + mode + " before replacement publication", async () => {
    test.setTimeout(120_000);
    const temp = await createTempWorkspace();
    let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
    const path = "note.md";
    const gate = join(temp.baseDir, "publication.gate");
    const recovery = join(temp.homeDir, "live-draft-recovery");
    const importGate = join(temp.baseDir, "typing-import.gate");
    try {
      await writeWorkspaceFiles(temp, [{path, contents: "# Note\n\nAnchor.\n"}]);
      await writeFile(gate, "gate");
      desktop = await launchDesktopApp({workspace: temp, env: {DOHC_TEST_ENGINE_PUBLICATION_GATE: gate}});
      const {page, app} = desktop;
      const workspace = await openWorkspaceFromFirstRun(page, temp);
      await waitForWorkspaceFile(page, workspace.workspaceId, path);
      await explorerRow(page, path).click();
      const editor = page.getByTestId("markdown-editor");
      await expect(editor).toBeVisible();
      await editor.click();
      await page.keyboard.press(DOCUMENT_END);
      await page.keyboard.type(" WARMUP");
      await expect.poll(() => readFile(join(temp.rootPath, path), "utf8")).toContain("WARMUP");
      if (mode === "write-failure") {
        await rm(recovery, {recursive: true, force: true});
        await writeFile(recovery, "blocked recovery directory");
      }
      const pids = await engineDaemonPids(app.process().pid!);
      expect(pids.length).toBeGreaterThan(0);
      for (const pid of pids) await hardKillPid(pid);
      await expect.poll(() => access(gate + ".waiting").then(() => true, () => false)).toBe(true);
      for (const sentinel of sentinels) await page.keyboard.type(" " + sentinel);
      if (mode === "write-failure") {
        await page.getByTestId("notice-center-toggle").click();
        await expect(page.getByTestId("notice-center").getByText(CHECKPOINT_FAILURE_MESSAGE, {exact: true})).toHaveCount(1);
        await page.getByTestId("notice-center-toggle").click();
        await page.evaluate(() => {
          const scope = window as unknown as {dohcDesktop: DohcDesktopBridge; typingQuitCancelled: boolean};
          scope.typingQuitCancelled = false;
          scope.dohcDesktop.onExitRound(message => {
            if (message.kind === "cancelled") scope.typingQuitCancelled = true;
          });
        });
        await app.evaluate(({app}) => app.quit());
        await expect.poll(() => page.evaluate(() => (window as unknown as {typingQuitCancelled: boolean}).typingQuitCancelled)).toBe(true);
        expect(app.process().exitCode).toBeNull();
        await expect(editor).toContainText(sentinels[2]!);
        await rm(recovery);
        await page.evaluate(async workspaceId => {
          await (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.typingRecovery({workspaceId, action: "flush"});
        }, workspace.workspaceId);
      }
      await expect.poll(() => checkpointText(temp.homeDir)).toContain(sentinels[2]!);
      await test.info().attach("outage-checkpoint", {body: await checkpointText(temp.homeDir), contentType: "application/json"});
      // Electron owns the unload veto; Playwright only observes the dialog.
      page.on("dialog", () => undefined);
      const exited = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
      if (mode === "crash" || mode === "crash-reopen-before-import") await hardKillAppTree(app.process().pid!);
      else if (mode === "last-window") {
        const window = await app.browserWindow(page);
        // A Mac app keeps running after its last window closes, so the person quits it next.
        const closed = process.platform === "darwin" ? page.waitForEvent("close") : null;
        await window.evaluate(window => {setImmediate(() => window.close());});
        if (closed) {
          await closed;
          await app.evaluate(({app}) => app.quit());
        }
      } else await app.evaluate(({app}) => app.quit());
      await exited;
      if (mode === "crash" || mode === "crash-reopen-before-import") await expect(desktop.close()).rejects.toThrow(/Electron exited with (status|signal)/);
      else await desktop.close();
      desktop = null;
      await rm(gate, {force: true});
      if (mode === "outside-edit") await writeFile(join(temp.rootPath, path), "# Outside\n\nOUTSIDE_WINS\n");
      if (mode === "deleted-file") await rm(join(temp.rootPath, path));
      if (mode === "refused-import") {
        const names = (await readdir(recovery)).filter(name => name.endsWith(".json"));
        expect(names).toHaveLength(1);
        const file = join(recovery, names[0]!);
        const checkpoint = JSON.parse(await readFile(file, "utf8"));
        checkpoint.updates[0].actorOriginId = "remote-person";
        checkpoint.updates[0].attribution = {actorKind: "human", onBehalfOf: "local-person", depth: 0};
        await writeFile(file, JSON.stringify(checkpoint));
      }
      if (mode === "crash-reopen-before-import") await writeFile(importGate,"held");
      desktop = await launchDesktopApp({workspace: temp, env: mode === "crash-reopen-before-import" ? {DOHC_TEST_TYPING_IMPORT_GATE:importGate} : {}});
      const reopened = await openWorkspaceFromFirstRun(desktop.page, temp);
      if (mode !== "deleted-file") await waitForWorkspaceFile(desktop.page, reopened.workspaceId, path);
      if (mode === "crash-reopen-before-import") {
        await expect.poll(()=>access(importGate+".waiting").then(()=>true,()=>false)).toBe(true);
        // The pending checkpoint must never enter the persistent set-aside rows.
        expect(await desktop.page.evaluate(async workspaceId =>
          (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.listLiveDraftRecovery({workspaceId}), reopened.workspaceId)).toEqual([]);
        await desktop.page.getByTestId("notice-center-toggle").click();
        await expect(desktop.page.getByTestId("notice-center")).toBeVisible();
        await expect(desktop.page.getByTestId("notice-set-aside-edits")).toHaveCount(0);
        await desktop.page.getByTestId("notice-center-toggle").click();
        await explorerRow(desktop.page,path).click();
        await expect.poll(()=>access(importGate+".opened").then(()=>true,()=>false)).toBe(true);
        expect(await checkpointText(temp.homeDir)).toContain(sentinels[2]!);
        await rm(importGate);
      }
      await test.info().attach("reopened-lineage", {body: JSON.stringify(await withEngineDb(temp.rootPath, db => ({docs: db.prepare("SELECT * FROM ydoc_docs").all(), moments: db.prepare("SELECT moment_id, metadata_origin FROM moments").all()}))), contentType: "application/json"});
      if (mode === "refused-import") {
        await desktop.page.getByTestId("notice-center-toggle").click();
        await expect(desktop.page.getByTestId("notice-center").getByText(AUTHOR_REFUSED_MESSAGE, {exact: true})).toHaveCount(1);
        const row=desktop.page.getByTestId("notice-center").locator('[data-testid^="notice-shell-error-"]').filter({hasText:AUTHOR_REFUSED_MESSAGE});
        await row.getByRole("button",{name:"Dismiss notice",exact:true}).click();
        await expect(desktop.page.getByTestId("notice-center").getByText(AUTHOR_REFUSED_MESSAGE,{exact:true})).toHaveCount(0);
        expect(await checkpointText(temp.homeDir)).toContain(sentinels[2]!);
        await expect.poll(()=>desktop!.page.evaluate(async workspaceId =>
          (window as unknown as {dohcDesktop:DohcDesktopBridge}).dohcDesktop.typingRecovery({workspaceId,action:"read"}),reopened.workspaceId)).toEqual({failures:[]});
        await desktop.page.evaluate(async workspaceId =>
          (window as unknown as {dohcDesktop:DohcDesktopBridge}).dohcDesktop.typingRecovery({workspaceId,action:"retry"}),reopened.workspaceId);
        await expect(desktop.page.getByTestId("notice-center").getByText(AUTHOR_REFUSED_MESSAGE,{exact:true})).toHaveCount(0);
        await desktop.close();desktop=null;
        desktop=await launchDesktopApp({workspace:temp});await openWorkspaceFromFirstRun(desktop.page,temp);
        const typingToast=desktop.page.getByTestId("workspace-shell-error").filter({hasText:AUTHOR_REFUSED_MESSAGE});
        await expect(typingToast).toBeVisible();
        await typingToast.getByRole("button",{name:"Dismiss workspace error",exact:true}).click();
        await desktop.page.getByTestId("notice-center-toggle").click();
        await expect(desktop.page.getByTestId("notice-center").getByText(AUTHOR_REFUSED_MESSAGE,{exact:true})).toHaveCount(1);
        expect(await checkpointText(temp.homeDir)).toContain(sentinels[2]!);
        await holdSystemClipboard(test.info(), async (remainingMs) => {
          await desktop!.page.getByTestId("notice-center").getByRole("button",{name:"Copy your typing",exact:true}).click({ timeout: remainingMs() });
          await expect.poll(()=>desktop!.app.evaluate(({clipboard})=>clipboard.readText()), { timeout: remainingMs() }).toContain(sentinels[2]!);
          expect(await checkpointText(temp.homeDir)).toContain(sentinels[2]!);
          await desktop!.app.evaluate(({clipboard})=>clipboard.writeText("OTHER_CLIPBOARD_TEXT"));
        });
        expect(await checkpointText(temp.homeDir)).toContain(sentinels[2]!);
        await expect(desktop.page.getByTestId("notice-center")).toHaveCount(0);
        const openedEditor=desktop.page.getByTestId("markdown-editor");
        if(await openedEditor.count() === 0) await explorerRow(desktop.page,path).click();
        await expect(openedEditor).toBeVisible();
        await expect(typingToast).toHaveCount(0);
        await desktop.page.getByTestId("notice-center-toggle").click();
        const discard = desktop.page.getByTestId("notice-center").getByRole("button",{name:"Discard your typing",exact:true});
        await discard.click();
        await expect(desktop.page.getByTestId("typing-discard-dialog")).toContainText("This cannot be undone.");
        expect(await checkpointText(temp.homeDir)).toContain(sentinels[2]!);
        for(const theme of ["light","dark"] as const) {
          await desktop.page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
          await expect(desktop.page.locator("html")).toHaveAttribute("data-theme",theme);
          await test.info().attach(`typing-discard-${theme}`,{body:await desktop.page.screenshot(),contentType:"image/png"});
        }
        await desktop.page.keyboard.press("Escape");
        await expect(desktop.page.getByTestId("typing-discard-dialog")).toHaveCount(0);
        expect(await checkpointText(temp.homeDir)).toContain(sentinels[2]!);
        await desktop.page.getByTestId("notice-center-toggle").click();
        await discard.click();
        await desktop.page.getByTestId("typing-discard-confirm").click();
        await expect.poll(()=>checkpointText(temp.homeDir)).toBe("");
        return;
      }
      if (mode === "deleted-file") {
        const recoveryStatus = () => desktop!.page.evaluate(async workspaceId =>
          (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.getCaptureRecoveryStatus({workspaceId}), reopened.workspaceId);
        await expect.poll(async () => (await recoveryStatus()).captureRecoveries.length).toBe(1);
        const record = (await recoveryStatus()).captureRecoveries[0]!;
        expect(record.deleted).toBe(true);
        const momentId = record.momentId;
        await expect(desktop.page.getByTestId("workspace-shell-notice").filter({hasText:`The file "${path}" was deleted.`})).toHaveCount(1);
        await expect.poll(() => checkpointText(temp.homeDir)).toBe("");
        await expect(access(join(temp.rootPath, path))).rejects.toThrow();
        await openHistoryView(desktop.page);
        await expect(desktop.page.getByTestId("engine-history-list").getByText("Text kept",{exact:true})).toHaveCount(1);
        await desktop.page.locator(`[data-testid="engine-moment-open"][data-moment-id="${momentId}"]`).click();
        await expect(desktop.page.getByTestId("engine-diff-lines")).toContainText(sentinels[2]!);
        await holdSystemClipboard(test.info(), async (remainingMs) => {
          await desktop!.page.getByTestId("engine-diff-copy-typing").click({ timeout: remainingMs() });
          await expect.poll(() => desktop!.app.evaluate(({clipboard}) => clipboard.readText()), { timeout: remainingMs() }).toContain(sentinels[2]!);
        });
        await desktop.page.getByTestId("engine-diff-restore-file").click();
        await expect(desktop.page.getByTestId("engine-diff-restore-status")).toContainText("Restored the earlier state");
        await expect.poll(() => readFile(join(temp.rootPath, path), "utf8")).toContain(sentinels[2]!);
        const restored = await readFile(join(temp.rootPath,path),"utf8");
        for(const sentinel of sentinels) expect(restored.split(sentinel).length-1).toBe(1);
      } else if (mode === "outside-edit") {
        await expect.poll(() => withEngineDb(temp.rootPath, db => db.prepare(
          "SELECT b.text AS before_text FROM moments m JOIN blobs b ON b.sha256=m.payload_before_blob_sha256 WHERE m.metadata_origin='capture-recovery'"
        ).all())).toEqual(expect.arrayContaining([expect.objectContaining({before_text: expect.stringContaining(sentinels[2]!)})]));
        expect(await readFile(join(temp.rootPath, path), "utf8")).toBe("# Outside\n\nOUTSIDE_WINS\n");
      } else {
        const recoveredEditor = desktop.page.getByTestId("markdown-editor");
        if(mode !== "crash-reopen-before-import" && await recoveredEditor.count() === 0) await explorerRow(desktop.page, path).click();
        await expect(recoveredEditor).toBeVisible();
        for (const sentinel of sentinels) await expect(recoveredEditor).toContainText(sentinel);
        const text = await recoveredEditor.innerText();
        for (const sentinel of sentinels) expect(text.split(sentinel).length - 1).toBe(1);
        await expect.poll(() => readFile(join(temp.rootPath, path), "utf8")).toContain(sentinels[2]!);
        const disk = await readFile(join(temp.rootPath, path), "utf8");
        for (const sentinel of sentinels) expect(disk.split(sentinel).length - 1).toBe(1);
      }
      await expect.poll(() => checkpointText(temp.homeDir)).toBe("");
      if (mode === "crash-reopen-before-import") {
        await desktop.page.getByTestId("notice-center-toggle").click();
        await expect(desktop.page.getByTestId("notice-center")).toBeVisible();
        await expect(desktop.page.getByTestId("notice-set-aside-edits")).toHaveCount(0);
      }
    } finally {
      await rm(gate, {force: true});
      await rm(importGate, {force:true});
      await cleanupDesktopWorkspace(desktop, temp);
    }
  });
}
