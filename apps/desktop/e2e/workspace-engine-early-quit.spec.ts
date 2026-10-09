import { expect, test } from "@playwright/test";
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

for (const mode of ["quit", "last-window", "crash", "outside-edit", "deleted-file", "write-failure", "refused-import"] as const) {
  test("outage typing survives " + mode + " before replacement publication", async () => {
    test.setTimeout(120_000);
    const temp = await createTempWorkspace();
    let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
    const path = "note.md";
    const gate = join(temp.baseDir, "publication.gate");
    const recovery = join(temp.homeDir, "live-draft-recovery");
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
      await page.keyboard.press("ControlOrMeta+End");
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
      if (mode === "crash") await hardKillAppTree(app.process().pid!);
      else if (mode === "last-window") {
        const window = await app.browserWindow(page);
        await window.evaluate(window => {setImmediate(() => window.close());});
      } else await app.evaluate(({app}) => app.quit());
      await exited;
      if (mode === "crash") await expect(desktop.close()).rejects.toThrow(/Electron exited with (status|signal)/);
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
      desktop = await launchDesktopApp({workspace: temp});
      const reopened = await openWorkspaceFromFirstRun(desktop.page, temp);
      if (mode !== "deleted-file") await waitForWorkspaceFile(desktop.page, reopened.workspaceId, path);
      await test.info().attach("reopened-lineage", {body: JSON.stringify(await withEngineDb(temp.rootPath, db => ({docs: db.prepare("SELECT * FROM ydoc_docs").all(), moments: db.prepare("SELECT moment_id, metadata_origin FROM moments").all()}))), contentType: "application/json"});
      if (mode === "refused-import") {
        await desktop.page.getByTestId("notice-center-toggle").click();
        await expect(desktop.page.getByTestId("notice-center").getByText(AUTHOR_REFUSED_MESSAGE, {exact: true})).toHaveCount(1);
        expect(await checkpointText(temp.homeDir)).toContain(sentinels[2]!);
        return;
      }
      if (mode === "deleted-file") {
        const recoveryStatus = () => desktop!.page.evaluate(async workspaceId =>
          (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.getCaptureRecoveryStatus({workspaceId}), reopened.workspaceId);
        await expect.poll(async () => (await recoveryStatus()).captureRecoveries.length).toBe(1);
        const momentId = (await recoveryStatus()).captureRecoveries[0]!.momentId;
        await expect.poll(() => checkpointText(temp.homeDir)).toBe("");
        await expect(access(join(temp.rootPath, path))).rejects.toThrow();
        await openHistoryView(desktop.page);
        await desktop.page.locator(`[data-testid="engine-moment-open"][data-moment-id="${momentId}"]`).click();
        await expect(desktop.page.getByTestId("engine-diff-lines")).toContainText(sentinels[2]!);
        await desktop.page.getByTestId("engine-diff-copy-typing").click();
        await expect.poll(() => desktop!.app.evaluate(({clipboard}) => clipboard.readText())).toContain(sentinels[2]!);
        await desktop.page.getByTestId("engine-diff-restore-file").click();
        await desktop.page.getByTestId("engine-diff-confirm-restore").click();
        await expect(desktop.page.getByTestId("engine-diff-restore-status")).toContainText("Restored the earlier state");
        await expect.poll(() => readFile(join(temp.rootPath, path), "utf8")).toContain(sentinels[2]!);
      } else if (mode === "outside-edit") {
        await expect.poll(() => withEngineDb(temp.rootPath, db => db.prepare(
          "SELECT b.text AS before_text FROM moments m JOIN blobs b ON b.sha256=m.payload_before_blob_sha256 WHERE m.metadata_origin='capture-recovery'"
        ).all())).toEqual(expect.arrayContaining([expect.objectContaining({before_text: expect.stringContaining(sentinels[2]!)})]));
        expect(await readFile(join(temp.rootPath, path), "utf8")).toBe("# Outside\n\nOUTSIDE_WINS\n");
      } else {
        await explorerRow(desktop.page, path).click();
        const recoveredEditor = desktop.page.getByTestId("markdown-editor");
        for (const sentinel of sentinels) await expect(recoveredEditor).toContainText(sentinel);
        const text = await recoveredEditor.innerText();
        for (const sentinel of sentinels) expect(text.split(sentinel).length - 1).toBe(1);
        await expect.poll(() => readFile(join(temp.rootPath, path), "utf8")).toContain(sentinels[2]!);
        const disk = await readFile(join(temp.rootPath, path), "utf8");
        for (const sentinel of sentinels) expect(disk.split(sentinel).length - 1).toBe(1);
      }
      await expect.poll(() => checkpointText(temp.homeDir)).toBe("");
    } finally {
      await rm(gate, {force: true});
      await cleanupDesktopWorkspace(desktop, temp);
    }
  });
}
