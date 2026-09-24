import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { sourceCaptureAdapter } from "../../../apps/desktop/src/testing/sourceCaptureAdapter";
import { compileClosedApp } from "../../../apps/desktop/src/workspaces/closedAppCompiler";
import { prepareLocalAppPublication } from "../../../apps/desktop/src/workspaces/ownerAppPublication";
import { createLocalDatasetHost, type LocalDatasetHost } from "../../../apps/desktop/src/workspaces/localDatasetHost";
import { createLocalAppLaunchHost, type LocalAppLaunchHost } from "../../../apps/desktop/src/workspaces/localAppLaunch";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Orders", schemaPath: "data/schema.sql", operationsPath: "data/operations.js",
  tables: [{ tableId: id(2), name: "Orders", sqlName: "orders", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Receipt", sqlColumn: "file_id", type: "attachment", required: true, unique: false },
  ] }],
  operations: [
    { operationId: id(5), name: "order", label: "Save order", tableId: id(2), kind: "action", access: "owner", readOnly: false, fieldIds: [id(4)] },
    { operationId: id(6), name: "list", label: "List orders", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(7), name: "receipt", label: "Read receipt", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(4)] },
  ],
};
const frontend = `
const root=document.getElementById('root');root.innerHTML='<h1>Local orders</h1><button id="order">Save order</button><button id="list">List orders</button><button id="receipt">Read receipt</button><button id="full">Check capacity</button><p id="result" role="status">Connecting</p>';
let port;const result=document.getElementById('result');let pending=new Map();
const send=body=>new Promise(resolve=>{pending.set(body.id,resolve);port.postMessage(body);});
addEventListener('message',event=>{if(event.data?.kind!=='dohc-app-channel')return;port=event.ports[0];port.onmessage=event=>{pending.get(event.data.id)?.(event.data);pending.delete(event.data.id);};port.start();result.textContent='Ready';},{once:true});
document.getElementById('order').onclick=async()=>{const upload=await send({id:'upload',op:'backend.upload',idempotencyKey:'receipt-1',name:'receipt.pdf',contentType:'application/pdf',bytesBase64:'JVBERi0='});if(!upload.ok){result.textContent='Access ended';return;}const saved=await send({id:'order',op:'backend.invoke',operation:'order',idempotencyKey:'order-1',input:{fileId:upload.value.file.fileId}});result.textContent=JSON.stringify(saved);};
document.getElementById('full').onclick=async()=>{result.textContent=JSON.stringify(await send({id:'full',op:'backend.invoke',operation:'order',idempotencyKey:'full-1',input:{refuse:true}}));};
document.getElementById('list').onclick=async()=>{result.textContent=JSON.stringify(await send({id:'list',op:'backend.invoke',operation:'list',idempotencyKey:'list-1',input:{}}));};
document.getElementById('receipt').onclick=async()=>{const listed=await send({id:'files',op:'backend.invoke',operation:'list',idempotencyKey:'list-2',input:{}});if(!listed.ok){result.textContent='Access ended';return;}const fileId=listed.value.result.rows[0].file_id;result.textContent=JSON.stringify(await send({id:'receipt',op:'backend.file',fileId,operation:'receipt',input:{fileId}}));};
`;
const backendSource = `globalThis.operations={
order(ctx,input){if(input.refuse)ctx.refuse('capacity_full','This session is full.');ctx.db.execute('INSERT INTO orders VALUES(?,?)',[ctx.requestId,input.fileId]);ctx.files.attach(input.fileId);return {saved:true};},
list(ctx){return {rows:ctx.db.query('SELECT * FROM orders ORDER BY id')};},
receipt(ctx,input){const rows=ctx.db.query('SELECT file_id FROM orders WHERE file_id=?',[input.fileId]);if(!rows.length)ctx.refuse('missing','Receipt unavailable.');return {fileId:rows[0].file_id};}
};`;

async function prepare(host: LocalDatasetHost) {
  const sources = new Map([
    ["data/dataset.json", Buffer.from(JSON.stringify(definition))], ["app/main.ts", Buffer.from(frontend)],
    [definition.operationsPath, Buffer.from(backendSource)], [definition.schemaPath, Buffer.from("CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL,file_id TEXT NOT NULL);")],
  ]);
  const adapter = sourceCaptureAdapter(sources);
  const prepared = await host.prepare({ descriptorPath: "data/dataset.json", adapter });
  const revision = await host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
  const dataset = { kind: "dataset", datasetId: definition.datasetId, revision: revision.revision, revisionSha256: revision.revisionSha256, operationIds: definition.operations.map(operation => operation.operationId) };
  sources.set("app/app.publish.json", Buffer.from(JSON.stringify({ entryPath: "main.ts", inputs: ["main.ts"], packageMap: {}, dataset })));
  return prepareLocalAppPublication({ workspaceId: "w", appRoot: "app" }, { adapter, compile: compileClosedApp, signal: new AbortController().signal, assertCurrent() {}, async resolveDatasetRevision() { return revision; } });
}

// Real compiled frontend, loopback bootstrap, opaque browser broker, isolated runtime, and durable SQLite store.
test("local app works without an account, survives restart, and stops at shared authority", async ({ browser }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "dohc-local-app-e2e-")), lifetime = new AbortController();
  const backends: LocalDatasetHost[] = [], launchers: LocalAppLaunchHost[] = [];
  try {
    let backend = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot: root }); backends.push(backend);
    const publication = await backend.apps.activate(await prepare(backend), lifetime.signal);
    let launcher = await createLocalAppLaunchHost({ backend: backend.apps, lifetime: lifetime.signal }); launchers.push(launcher);
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, reducedMotion: "reduce" });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = await launcher.launch(publication.publicationId, lifetime.signal);
    await page.goto(url);
    const app = page.frameLocator("iframe"), status = app.getByRole("status");
    await expect(status).toHaveText("Ready");
    expect(page.url()).toBe(new URL(url).origin + "/bootstrap");
    await app.getByRole("button", { name: "Save order" }).click();
    await expect(status).toContainText('"saved":true');
    await app.getByRole("button", { name: "Save order" }).click();
    await expect(status).toContainText('"replayed":true');
    const child = page.frames().find(frame => frame !== page.mainFrame())!;
    expect(await child.evaluate(() => {
      const blocked = (read: () => unknown) => { try { read(); return false; } catch { return true; } };
      return { parent: blocked(() => parent.document.body), cookies: blocked(() => document.cookie), storage: blocked(() => localStorage.length) };
    })).toEqual({ parent: true, cookies: true, storage: true });
    expect(await page.evaluate(async () => (await fetch("/backend", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status)).toBe(404);
    await page.screenshot({ path: testInfo.outputPath("local-app.png"), fullPage: true });
    await launcher.close(); await backend.close();
    backend = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot: root }); backends.push(backend);
    launcher = await createLocalAppLaunchHost({ backend: backend.apps, lifetime: lifetime.signal }); launchers.push(launcher);
    await page.goto(await launcher.launch(publication.publicationId, lifetime.signal));
    await expect(status).toHaveText("Ready");
    await app.getByRole("button", { name: "List orders" }).click();
    await expect(status).toContainText('"rows":[{');
    const listed = JSON.parse(await status.innerText()); expect(listed.value.result.rows).toHaveLength(1);
    await app.getByRole("button", { name: "Read receipt" }).click();
    await expect(status).toContainText('"bytesBase64":"JVBERi0="');
    await app.getByRole("button", { name: "Check capacity" }).click();
    await expect(status).toContainText('"error":{"code":"capacity_full","message":"This session is full."}');
    await page.reload();
    await expect(status).toHaveText("Ready");
    await app.getByRole("button", { name: "List orders" }).click();
    await expect(status).toContainText('"rows":[{');
    for (let count = 0; count < 17; count++) {
      const tab = await context.newPage(), launch = await launcher.launch(publication.publicationId, lifetime.signal);
      await tab.goto(launch); await expect(tab.frameLocator("iframe").getByRole("status")).toHaveText("Ready");
      expect(await tab.evaluate(async () => (await fetch("/close", { method: "POST", headers: {
        "x-dohc-app-proof": sessionStorage.getItem("dohc-local-app-proof")!,
      } })).status)).toBe(204);
      await tab.close();
      await expect.poll(async () => { try { await fetch(new URL(launch).origin + "/bootstrap"); return false; } catch { return true; } }).toBe(true);
    }
    await expect(backend.transferToShared({ datasetId: definition.datasetId, targetOrigin: "https://relay.example", target: {
      async importRecovery() { throw new Error("The sharing server is offline."); },
    } })).rejects.toThrow("The sharing server is offline.");
    expect(backend.transferStatus(definition.datasetId)?.state).toBe("ready");
    await app.getByRole("button", { name: "List orders" }).click();
    await expect(status).toContainText('"ok":false');
    await expect(launcher.launch(publication.publicationId, lifetime.signal)).rejects.toThrow();
    await page.reload();
    expect(await page.locator("iframe").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    lifetime.abort(); await Promise.all(launchers.map(launcher => launcher.close()));
    for (const backend of backends) await backend.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + "\\") && !resolve(root).startsWith(resolve(tmpdir()) + "/")) throw Error("Invalid test cleanup directory");
    await rm(root, { recursive: true, force: true });
  }
});
