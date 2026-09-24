import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { generateDatasetSources } from "./datasetGenerator";
import { generateDatasetFormSources } from "./datasetFormGenerator";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalAppLaunchHost, type LocalAppLaunchHost } from "./localAppLaunch";

vi.setConfig({ testTimeout: 20_000 });
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "data/schema.sql", operationsPath: "data/operations.js",
  tables: [{ tableId: id(2), name: "Responses", sqlName: "responses", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
    { fieldId: id(5), name: "Receipt", sqlColumn: "receipt", type: "attachment", required: false, unique: false },
  ] }], operations: [
    { operationId: id(6), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4), id(5)] },
    { operationId: id(7), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4), id(5)] },
    { operationId: id(8), name: "fileRead", label: "Read receipt", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(5)] },
  ] };
const roots: string[] = [], hosts: LocalDatasetHost[] = [], launchers: LocalAppLaunchHost[] = [];
afterEach(async () => {
  for (const launcher of launchers.splice(0)) await launcher.close();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const sourceAdapter = (files: Map<string, string>) => sourceCaptureAdapter(files);
async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-dataset-app-")); roots.push(workspaceRoot);
  const host = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot, capacityBytes: 1024 * 1024 }); hosts.push(host);
  const generated = generateDatasetSources(definition);
  const files = new Map(Object.entries(generated.files)); files.set("data/dataset.json", JSON.stringify(definition));
  files.set(definition.operationsPath,files.get(definition.operationsPath)+`\nglobalThis.operations.fileRead=(ctx,input)=>{
    if(input.echo)return {echo:input.fileId};
    if(input.extra)return {fileId:input.fileId,extra:true};
    if(input.guess)return {fileId:input.fileId};
    return {fileId:ctx.db.query('SELECT receipt FROM responses WHERE receipt=?',[input.fileId])[0]?.receipt||null};
  };`);
  const adapter = sourceAdapter(files);
  const prepared = await host.prepare({ descriptorPath: "data/dataset.json", adapter });
  const revision = await host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
  async function prepareApp(appRoot: string, operationIds = [id(6)], fieldIds = [id(4), id(5)]) {
    const generated = generateDatasetFormSources({ approvedRevision: revision, tableId: id(2), createOperationId: id(6), appRoot, fieldIds });
    for (const [path, source] of Object.entries(generated.files)) files.set(`${appRoot}/${path}`, source);
    const manifest = JSON.parse(files.get(`${appRoot}/app.publish.json`)!); manifest.dataset.operationIds = operationIds;
    if (!operationIds.includes(id(6))) delete manifest.dataset.createFields;
    files.set(`${appRoot}/app.publish.json`, JSON.stringify(manifest));
    return prepareLocalAppPublication({ workspaceId: "w", appRoot }, { adapter, compile: compileClosedApp, signal: new AbortController().signal,
      assertCurrent() {}, async resolveDatasetRevision(binding) { return host.approvedArtifacts(binding.datasetId).revision; } });
  }
  const app = await prepareApp("app");
  const published = await host.apps.activate(app, new AbortController().signal);
  const invocation = (name = "Alex", key = "submit-one") => ({ authorityRevision: published.authorityRevision, operation: "submit", idempotencyKey: key, input: { values: { [id(4)]: name } } });
  return { host, workspaceRoot, revision, files, prepareApp, app, published, invocation };
}

describe("local approved dataset apps", () => {
  it("keeps one exact pending form submission across tabs and restart within its app authority", async () => {
    const f = await fixture(), invocation = f.invocation();
    const other = await f.host.apps.activate(await f.prepareApp("other"), new AbortController().signal);
    const envelope = { authorityRevision: invocation.authorityRevision, operation: invocation.operation };
    const first = await f.host.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "save", idempotencyKey: invocation.idempotencyKey, input: invocation.input }) as { attempt: { token: string; input: unknown } };
    expect(first.attempt.input).toEqual(invocation.input);
    expect(await f.host.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "save", idempotencyKey: "second-tab", input: { values: { [id(4)]: "Other" } } })).toEqual(first);
    await expect(f.host.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "clear", token: "A".repeat(43) })).rejects.toThrow(/Another submission/);
    await expect(f.host.apps.activate(await f.prepareApp("replacement"), new AbortController().signal)).rejects.toThrow(/response is pending/);
    expect(await f.host.apps.request(other.publicationId, "attempt", { authorityRevision: other.authorityRevision, operation: "submit", action: "get" })).toEqual({ attempt: null });
    await f.host.close();
    const restarted = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(restarted);
    expect(await restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "get" })).toEqual(first);
    expect(await restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "clear", token: first.attempt.token })).toEqual({ attempt: null });
    await expect(restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, operation: "list", action: "get" })).rejects.toThrow(/not approved/);
    restarted.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "get" })).rejects.toThrow(/approval changed/);
  });
  it("refuses an uncommitted submission before fencing local writes and allows transfer after confirmation", async () => {
    const f = await fixture(), invocation = f.invocation(), envelope = {authorityRevision: invocation.authorityRevision, operation: invocation.operation};
    await f.host.apps.request(f.published.publicationId, "attempt", {...envelope, action: "save", idempotencyKey: invocation.idempotencyKey, input: invocation.input});
    let imported = false;
    const target = {async importRecovery() {imported = true; throw Error("Target is offline.");}};
    await expect(f.host.transferToShared({datasetId: id(1), targetOrigin: "https://relay.example", target})).rejects.toThrow(/submission is unconfirmed/);
    expect(imported).toBe(false); expect(f.host.transferStatus(id(1))).toBeNull();
    expect(await f.host.apps.request(f.published.publicationId, "invoke", invocation)).toMatchObject({replayed: false});
    await expect(f.host.transferToShared({datasetId: id(1), targetOrigin: "https://relay.example", target})).rejects.toThrow("Target is offline.");
    expect(imported).toBe(true); expect(f.host.transferStatus(id(1))?.state).toBe("ready");
  });
  it("runs a generated form through real loopback transport into its existing Collection", async () => {
    const f = await fixture(), lifetime = new AbortController();
    const launcher = await createLocalAppLaunchHost({ backend: f.host.apps, lifetime: lifetime.signal }); launchers.push(launcher);
    const url = new URL(await launcher.launch(f.published.publicationId, lifetime.signal));
    const post = (path: string, body: unknown, proof?: string) => fetch(url.origin + path, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", ...(proof ? { "x-dohc-app-proof": proof } : {}) }, body: JSON.stringify(body) });
    const session = await (await post("/session", { handoff: url.hash.slice(1) })).json() as { html: string; proof: string };
    expect(session.html).not.toMatch(/CREATE TABLE|globalThis.operations|data\/schema/);
    const { authorityRevision: _, ...invoke } = f.invocation();
    const response = await post("/backend", { id: "one", op: "backend.invoke", ...invoke }, session.proof);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ result: { id: expect.any(String) }, replayed: false });
    const data = await f.host.query({ datasetId: id(1), revision: 1, revisionSha256: f.revision.revisionSha256, operationId: id(7), input: {}, idempotencyKey: "owner-read" });
    expect(data.result).toMatchObject({ rows: [{ values: { [id(4)]: "Alex" } }] });
    const forbidden = await post("/backend", { id: "two", op: "backend.invoke", operation: "list", input: {}, idempotencyKey: "read" }, session.proof);
    expect(forbidden.status).toBe(404);
  });

  it("preserves approved apps and retry results across restart without widening grants", async () => {
    const f = await fixture();
    const first = await f.host.apps.request(f.published.publicationId, "invoke", f.invocation());
    await f.host.close();
    const restarted = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(restarted);
    expect(restarted.apps.list("app")).toMatchObject([{ active: true, datasetCapability: { operationIds: [id(6)] } }]);
    expect(await restarted.apps.request(f.published.publicationId, "invoke", f.invocation())).toEqual({ ...first as object, replayed: true });
    await expect(restarted.apps.request(f.published.publicationId, "invoke", { ...f.invocation(), operation: "list" })).rejects.toThrow(/not approved/);
  });

  it("revokes a publication independently of its Collection and permits a reviewed reactivation", async () => {
    const f = await fixture(); f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    expect(() => f.host.apps.browserPublication(f.published.publicationId)).toThrow();
    expect(f.host.describe(id(1)).name).toBe("Registrations");
    const next = await f.host.apps.activate(f.app, new AbortController().signal);
    expect(next.authorityRevision).toBeGreaterThan(f.published.authorityRevision);
    await expect(f.host.apps.request(next.publicationId, "invoke", f.invocation())).rejects.toThrow();
    expect(await f.host.apps.request(next.publicationId, "invoke", { ...f.invocation(), authorityRevision: next.authorityRevision })).toMatchObject({ replayed: false });
  });

  it("publishes a second app over the same records and requires an approved read result for files", async () => {
    const f = await fixture();
    const uploaded = await f.host.apps.request(f.published.publicationId, "upload", { authorityRevision: f.published.authorityRevision, idempotencyKey: "receipt", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERi0=" }) as { file: { fileId: string } };
    const invoke = f.invocation(); invoke.input.values[id(5)] = uploaded.file.fileId;
    await f.host.apps.request(f.published.publicationId, "invoke", invoke);
    await expect(f.host.apps.readBrowserFile(f.published.publicationId, { authorityRevision: 1, fileId: uploaded.file.fileId, operation: "list", input: {} })).rejects.toThrow(/approved read/);
    const admin = await f.host.apps.activate(await f.prepareApp("admin", [id(7),id(8)]), new AbortController().signal);
    await expect(f.host.apps.readBrowserFile(admin.publicationId, { authorityRevision: admin.authorityRevision, fileId: uploaded.file.fileId, operation: "list", input: {} })).rejects.toThrow(/does not grant/);
    const request={authorityRevision:admin.authorityRevision,fileId:uploaded.file.fileId,operation:"fileRead",input:{fileId:uploaded.file.fileId}};
    expect(await f.host.apps.readBrowserFile(admin.publicationId,request)).toMatchObject({bytesBase64:"JVBERi0="});
    await expect(f.host.apps.readBrowserFile(admin.publicationId,{...request,input:{...request.input,echo:true}})).rejects.toThrow(/does not grant/);
    await expect(f.host.apps.readBrowserFile(admin.publicationId,{...request,input:{...request.input,extra:true}})).rejects.toThrow(/does not grant/);
    const pending=await f.host.upload({datasetId:id(1),revision:1,revisionSha256:f.revision.revisionSha256,idempotencyKey:"owner-pending",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:"JVBERi0="});
    await expect(f.host.apps.readBrowserFile(admin.publicationId,{...request,fileId:pending.file.fileId,input:{fileId:pending.file.fileId,guess:true}})).rejects.toThrow(/unavailable/);
    await expect(f.host.apps.request(admin.publicationId, "upload", { authorityRevision: admin.authorityRevision, idempotencyKey: "other", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERi0=" })).rejects.toThrow(/cannot upload/);
    const disclosure=f.host.apps.readBrowserFile(admin.publicationId,request);
    f.host.apps.withdraw(admin.publicationId,admin.authorityRevision);
    await expect(disclosure).rejects.toThrow();
  });

  it("rejects altered capabilities and bundle bytes before replacing a working app", async () => {
    const f = await fixture();
    const forged = structuredClone(f.app); const cap = forged.candidate.capabilities[0]; if (cap?.kind !== "dataset") throw Error(); cap.operations[0]!.readOnly = true;
    await expect(f.host.apps.activate(forged, new AbortController().signal)).rejects.toThrow();
    const broken = structuredClone(f.app); broken.files[0]!.bytes[0] ^= 1;
    await expect(f.host.apps.activate(broken, new AbortController().signal)).rejects.toThrow(/bundle files changed/);
    expect(f.host.apps.browserPublication(f.published.publicationId).authorityRevision).toBe(f.published.authorityRevision);
  });

  it("refuses a queued operation when app approval ends before its commit", async () => {
    const f = await fixture();
    const pending = f.host.apps.request(f.published.publicationId, "invoke", f.invocation());
    f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(pending).rejects.toThrow();
    const rows = await f.host.query({ datasetId: id(1), revision: 1, revisionSha256: f.revision.revisionSha256, operationId: id(7), input: {}, idempotencyKey: "after-revoke" });
    expect(rows.result).toMatchObject({ rows: [] });
  });

  it("does not let another app attach a staged upload even when it knows its ID", async () => {
    const f = await fixture();
    const upload = { authorityRevision: f.published.authorityRevision, idempotencyKey: "same-key", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERi0=" };
    const first = await f.host.apps.request(f.published.publicationId, "upload", upload) as { file: { fileId: string } };
    const other = await f.host.apps.activate(await f.prepareApp("other"), new AbortController().signal);
    const own = await f.host.apps.request(other.publicationId, "upload", { ...upload, authorityRevision: other.authorityRevision }) as { file: { fileId: string } };
    expect(own.file.fileId).not.toBe(first.file.fileId);
    const input = f.invocation(); input.authorityRevision = other.authorityRevision; input.input.values[id(5)] = first.file.fileId;
    await expect(f.host.apps.request(other.publicationId, "invoke", input)).rejects.toThrow();
    const attach=f.invocation("First app","attach-first");attach.input.values[id(5)]=first.file.fileId;
    await f.host.apps.request(f.published.publicationId,"invoke",attach);
    await expect(f.host.apps.request(other.publicationId,"invoke",{...input,idempotencyKey:"steal-attached"})).rejects.toThrow();
    const native={datasetId:id(1),revision:1,revisionSha256:f.revision.revisionSha256};
    const ownerUpload=await f.host.upload({...native,idempotencyKey:"owner-file",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:"JVBERi0="});
    await f.host.action({...native,operationId:id(6),idempotencyKey:"owner-attach",input:{values:{[id(4)]:"Owner",[id(5)]:ownerUpload.file.fileId}}});
    input.input.values[id(5)]=ownerUpload.file.fileId;
    await expect(f.host.apps.request(other.publicationId,"invoke",{...input,idempotencyKey:"steal-owner-attached"})).rejects.toThrow();
    expect(await f.host.action({...native,operationId:id(6),idempotencyKey:"owner-reuse-app",input:{values:{[id(4)]:"Owner reuse",[id(5)]:first.file.fileId}}})).toMatchObject({replayed:false});
  });

  it("enforces the generated form's field subset even when a client forges the request", async () => {
    const f = await fixture();
    const restricted = await f.host.apps.activate(await f.prepareApp("restricted", [id(6)], [id(4)]), new AbortController().signal);
    const input = f.invocation(); input.authorityRevision = restricted.authorityRevision; input.input.values[id(5)] = "not-allowed";
    await expect(f.host.apps.request(restricted.publicationId, "invoke", input)).rejects.toThrow(/cannot submit those fields/);
    delete input.input.values[id(5)];
    expect(await f.host.apps.request(restricted.publicationId, "invoke", input)).toMatchObject({ replayed: false });
  });
});


it("keeps local form uploads, submissions and selected fields working through rename and restart", async () => {
  const f = await fixture();
  const restricted=await f.host.apps.activate(await f.prepareApp("restricted",[id(6)],[id(4)]),new AbortController().signal);
  const admin=await f.host.apps.activate(await f.prepareApp("admin",[id(7),id(8)]),new AbortController().signal);
  const original=f.host.approvedArtifacts(id(1)), renamed=structuredClone(original.revision.definition);
  renamed.tables[0].fields[1].name="Full name";
  const revision=describeDatasetRevision({definition:renamed,revision:2,schemaSql:original.schemaSql,operationSource:original.operationSource});
  const preview=await f.host.prepareMigrationCandidate({workspaceId:"w",revision,schemaSql:original.schemaSql,operationSource:original.operationSource,expected:original.cursor,migrationSql:"SELECT 1;"});
  await f.host.approveMigrationCandidate({workspaceId:"w",datasetId:id(1),candidateId:preview.candidateId,checkpointSha256:preview.checkpointSha256});
  expect(f.host.apps.list("app")).toMatchObject([{active:true,datasetCapability:{revision:1}}]);
  const uploaded=await f.host.apps.request(f.published.publicationId,"upload",{authorityRevision:1,idempotencyKey:"renamed-receipt",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:"JVBERi0="}) as {file:{fileId:string}};
  const invoke=f.invocation(); invoke.input.values[id(5)]=uploaded.file.fileId;
  const first=await f.host.apps.request(f.published.publicationId,"invoke",invoke);
  await f.host.close();
  const restarted=await createLocalDatasetHost({workspaceId:"w",workspaceRoot:f.workspaceRoot}); hosts.push(restarted);
  expect(restarted.apps.browserPublication(f.published.publicationId)).toBeDefined();
  expect(await restarted.apps.request(f.published.publicationId,"invoke",invoke)).toEqual({...first as object,replayed:true});
  await expect(restarted.apps.request(restricted.publicationId,"invoke",{...invoke,authorityRevision:restricted.authorityRevision})).rejects.toThrow("cannot submit those fields");
  expect(await restarted.apps.readBrowserFile(admin.publicationId,{authorityRevision:admin.authorityRevision,fileId:uploaded.file.fileId,operation:"fileRead",input:{fileId:uploaded.file.fileId}})).toMatchObject({bytesBase64:"JVBERi0="});
  expect(await restarted.apps.request(f.published.publicationId,"invoke",f.invocation("Next","after-restart"))).toMatchObject({replayed:false});
  restarted.apps.withdraw(f.published.publicationId,1);
  await expect(restarted.apps.request(f.published.publicationId,"invoke",invoke)).rejects.toThrow("approval changed");
});
