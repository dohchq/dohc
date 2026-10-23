import {expect,test} from "@playwright/test";
import {DOCUMENT_END} from "./helpers/keys";
import {access,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {DohcDesktopBridge} from "../src/ipc/bridgeContract";
import {launchDesktopApp} from "./helpers/desktopApp";
import {engineDaemonPids,hardKillPid} from "./helpers/daemonKill";
import {cleanupDesktopWorkspace,createTempWorkspace,explorerRow,openWorkspaceFromFirstRun,waitForWorkspaceFile,writeWorkspaceFiles} from "./helpers/workspace";
import {withEngineDb} from "./helpers/engineDb";
test("a live rebind replays outage originals without a recovery moment or Notice",async()=>{
 test.setTimeout(120_000);const temp=await createTempWorkspace();let desktop:Awaited<ReturnType<typeof launchDesktopApp>>|null=null;const path="note.md";const gate=join(temp.baseDir,"publication.gate");const sentinels=["REBIND_ONE_174","REBIND_TWO_285","REBIND_THREE_396"];
 try {
 await writeWorkspaceFiles(temp,[{path,contents:"# Note\n\nAnchor.\n"}]);await writeFile(gate,"gate");desktop=await launchDesktopApp({workspace:temp,env:{DOHC_TEST_ENGINE_PUBLICATION_GATE:gate}});
 const {page,app}=desktop;const workspace=await openWorkspaceFromFirstRun(page,temp);await waitForWorkspaceFile(page,workspace.workspaceId,path);await explorerRow(page,path).click();const editor=page.getByTestId("markdown-editor");await expect(editor).toBeVisible();await editor.click();await page.keyboard.press(DOCUMENT_END);await page.keyboard.type(" WARMUP");await expect.poll(()=>readFile(join(temp.rootPath,path),"utf8")).toContain("WARMUP");
 const pids=await engineDaemonPids(app.process().pid!);expect(pids.length).toBeGreaterThan(0);for(const pid of pids)await hardKillPid(pid);await expect.poll(()=>access(gate+".waiting").then(()=>true,()=>false)).toBe(true);
 for(const sentinel of sentinels)await page.keyboard.type(" "+sentinel);
 const checkpoints=async()=>{const directory=join(temp.homeDir,"live-draft-recovery");return (await Promise.all((await readdir(directory).catch(()=>[])).filter(n=>n.endsWith(".json")).map(n=>readFile(join(directory,n),"utf8")))).join(" ");};
 await expect.poll(checkpoints).toContain(sentinels[2]!);await rm(gate);
 await expect.poll(()=>readFile(join(temp.rootPath,path),"utf8")).toContain(sentinels[2]!);await expect.poll(checkpoints).toBe("");
 const disk=await readFile(join(temp.rootPath,path),"utf8");const text=await editor.innerText();for(const sentinel of sentinels){expect(disk.split(sentinel).length-1).toBe(1);expect(text.split(sentinel).length-1).toBe(1);}
 const status=await page.evaluate(async workspaceId=>(window as unknown as {dohcDesktop:DohcDesktopBridge}).dohcDesktop.getCaptureRecoveryStatus({workspaceId}),workspace.workspaceId);expect(status.captureRecoveries).toEqual([]);
 expect(await withEngineDb(temp.rootPath,db=>db.prepare("SELECT count(*) AS count FROM moments WHERE metadata_origin='capture-recovery'").get())).toEqual({count:0});
 await expect(page.getByTestId("workspace-shell-notice").filter({hasText:"Text kept in History"})).toHaveCount(0);await page.getByTestId("notice-center-toggle").click();await expect(page.getByTestId("notice-center").getByText("Text kept in History",{exact:true})).toHaveCount(0);
 }finally{await rm(gate,{force:true});await cleanupDesktopWorkspace(desktop,temp);}
});
