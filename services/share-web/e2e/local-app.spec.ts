import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as runtime from "@dohc/app-backend-runtime";
import { VersionedLiveAdapter } from "../../../packages/workspace-engine-client/src/index";
import { compileClosedApp } from "../../../apps/desktop/src/workspaces/closedAppCompiler";
import { prepareLocalAppPublication } from "../../../apps/desktop/src/workspaces/ownerAppPublication";
import { createLocalAppBackendHost } from "../../../apps/desktop/src/workspaces/localAppBackend";
import { createLocalAppLaunchHost, type LocalAppLaunchHost } from "../../../apps/desktop/src/workspaces/localAppLaunch";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dataPath = "data/orders.sqlite";
const frontend = `
const root=document.getElementById('root');root.innerHTML='<h1>Local orders</h1><button id="order">Save order</button><button id="list">List orders</button><button id="receipt">Read receipt</button><p id="result" role="status">Connecting</p>';
let port;const result=document.getElementById('result');let pending=new Map();
const send=body=>new Promise(resolve=>{pending.set(body.id,resolve);port.postMessage(body);});
addEventListener('message',event=>{if(event.data?.kind!=='dohc-app-channel')return;port=event.ports[0];port.onmessage=event=>{pending.get(event.data.id)?.(event.data);pending.delete(event.data.id);};port.start();result.textContent='Ready';},{once:true});
document.getElementById('order').onclick=async()=>{const upload=await send({id:'upload',op:'backend.upload',idempotencyKey:'receipt-1',name:'receipt.pdf',contentType:'application/pdf',bytesBase64:'JVBERg=='});if(!upload.ok){result.textContent='Access ended';return;}const saved=await send({id:'order',op:'backend.invoke',operation:'order',idempotencyKey:'order-1',input:{fileId:upload.value.file.fileId}});result.textContent=JSON.stringify(saved);};
document.getElementById('list').onclick=async()=>{result.textContent=JSON.stringify(await send({id:'list',op:'backend.invoke',operation:'list',idempotencyKey:'list-1',input:{}}));};
document.getElementById('receipt').onclick=async()=>{const listed=await send({id:'files',op:'backend.invoke',operation:'list',idempotencyKey:'list-2',input:{}});if(!listed.ok){result.textContent='Access ended';return;}const fileId=listed.value.result.rows[0].file_id;result.textContent=JSON.stringify(await send({id:'receipt',op:'backend.file',fileId,operation:'receipt',input:{fileId}}));};
`;
const backendSource = `globalThis.operations={
order(ctx,input){ctx.db.execute('INSERT INTO orders VALUES(?,?)',[ctx.requestId,input.fileId]);ctx.files.attach(input.fileId);return {saved:true};},
list(ctx){return {rows:ctx.db.query('SELECT * FROM orders ORDER BY id')};},
receipt(ctx,input){const rows=ctx.db.query('SELECT file_id FROM orders WHERE file_id=?',[input.fileId]);if(!rows.length)ctx.refuse('missing','Receipt unavailable.');return {fileId:rows[0].file_id};}
};`;

async function prepare() {
  const backend = { entryPath: "app/backend.ts", schemaPath: "app/schema.sql", dataPath, schemaVersion: 1,
    operations: [{ name: "order", access: "owner", readOnly: false }, { name: "list", access: "owner", readOnly: true }, { name: "receipt", access: "owner", readOnly: true }],
    tables: [{ name: "orders", primaryKey: "id", readOperation: "list", writeOperation: "order" }] };
  const declaration = { entryPath: "app/main.ts", inputs: ["app/main.ts", "app/backend.ts", "app/schema.sql"], packageMap: {}, backend };
  const sources = new Map([
    ["app/app.publish.json", Buffer.from(JSON.stringify(declaration))], ["app/main.ts", Buffer.from(frontend)],
    ["app/backend.ts", Buffer.from(backendSource)], ["app/schema.sql", Buffer.from("CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL,file_id TEXT NOT NULL);")],
  ]);
  const blobs = new Map<string, Uint8Array>();
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    const params = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      const files = [...params.paths as string[]].sort().map(path => {
        const bytes = sources.get(path)!, sha256 = hash(bytes); blobs.set(sha256, bytes);
        return { path, objectId: path, contentKind: "text", sha256, byteLength: bytes.byteLength, latestMomentId: "m" };
      });
      return { id: request.id, result: { workspaceId: "w", versionId: "main", files, totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0), sourceDigest: hash(JSON.stringify(["dohc-source-capture-v1", "w", "main", files])) } };
    }
    const bytes = blobs.get(String(params.sha256))!;
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, "owner", { workspaceId: "w" });
  return prepareLocalAppPublication({ workspaceId: "w", appRoot: "app" }, { adapter, compile: compileClosedApp, signal: new AbortController().signal, assertCurrent() {} });
}

// Real compiled frontend, loopback bootstrap, opaque browser broker, isolated runtime, and durable SQLite store.
test("local app works without an account, survives restart, and stops at shared authority", async ({ browser }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "dohc-local-app-e2e-")), lifetime = new AbortController();
  const backends: Awaited<ReturnType<typeof createLocalAppBackendHost>>[] = [], launchers: LocalAppLaunchHost[] = [];
  try {
    let backend = await createLocalAppBackendHost({ workspaceId: "w", workspaceRoot: root, runtime }); backends.push(backend);
    const publication = await backend.activate(await prepare());
    let launcher = await createLocalAppLaunchHost({ backend, lifetime: lifetime.signal }); launchers.push(launcher);
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
    await launcher.close(); backend.close();
    backend = await createLocalAppBackendHost({ workspaceId: "w", workspaceRoot: root, runtime }); backends.push(backend);
    launcher = await createLocalAppLaunchHost({ backend, lifetime: lifetime.signal }); launchers.push(launcher);
    await page.goto(await launcher.launch(publication.publicationId, lifetime.signal));
    await expect(status).toHaveText("Ready");
    await app.getByRole("button", { name: "List orders" }).click();
    await expect(status).toContainText('"rows":[{');
    const listed = JSON.parse(await status.innerText()); expect(listed.value.result.rows).toHaveLength(1);
    await app.getByRole("button", { name: "Read receipt" }).click();
    await expect(status).toContainText('"bytesBase64":"JVBERg=="');
    backend.setSharedAuthority(dataPath, "shared-publication");
    await app.getByRole("button", { name: "List orders" }).click();
    await expect(status).toContainText('"ok":false');
    await expect(launcher.launch(publication.publicationId, lifetime.signal)).rejects.toThrow(/shared host/);
    await page.reload();
    expect(await page.locator("iframe").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    lifetime.abort(); await Promise.all(launchers.map(launcher => launcher.close()));
    for (const backend of backends) backend.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + "\\") && !resolve(root).startsWith(resolve(tmpdir()) + "/")) throw Error("Invalid test cleanup directory");
    await rm(root, { recursive: true, force: true });
  }
});
