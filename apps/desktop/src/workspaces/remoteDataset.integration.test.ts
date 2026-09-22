import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { fixture, limits } from "../../../../services/sync-relay/src/appBackendTestFixture";
import { createSyncRelayHandler } from "../../../../services/sync-relay/src/server";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createRemoteDatasetData } from "./remoteDataset";
import { readDatasetResponse } from "../ipc/readDatasetResponse";

it("manages the authoritative relay Collection through the desktop owner adapter", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "desktop-remote-dataset-"));
  const host = await f.storage.createDatasetHost({ directory, limits, onShutdownError(error) { throw error; } });
  const controller = new AbortController();
  try {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "private/schema.sql", operationsPath: "private/actions.js",
      tables: [{ tableId: id(2), name: "Registrations", sqlName: "registrations", primaryKey: "id", fields: [
        { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
        { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
        { fieldId: id(5), name: "Receipt", sqlColumn: "receipt", type: "attachment", required: false, unique: false },
      ] }], operations: [
        { operationId: id(6), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4), id(5)] },
        { operationId: id(7), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4), id(5)] },
      ] };
    const schemaSql = "CREATE TABLE registrations(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,receipt TEXT);";
    const operationSource = `globalThis.operations={submit(ctx,input){if(!input.name)ctx.refuse('name_required','Enter your name.');ctx.files.attach(input.fileId);ctx.db.execute('INSERT INTO registrations VALUES(?,?,?)',[ctx.requestId,input.name,input.fileId]);return {accepted:true};},list(ctx){return ctx.db.query('SELECT * FROM registrations ORDER BY id');}};`;
    const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
    await host.activate({ kind: "named", workspaceId: "w", userId: "owner" }, { workspaceId: "w", revision, schemaSql, operationSource });
    const handler = createSyncRelayHandler({ storage: f.storage, datasetHost: host, appBackendsEnabled: true, appPublicationLimits: limits,
      resolveActor(request, workspaceId) { if (request.headers.get("authorization") !== "Bearer token") throw Error("Wrong credentials"); return { workspaceId, userId: "owner" }; } });
    const data = createRemoteDatasetData({ workspaceId: "w", credentials: { serverUrl: "https://account", relayUrl: "https://relay", token: "token", userId: "owner", email: "owner@example.test" },
      credentialGeneration: 1, currentCredentialGeneration: () => 1, signal: controller.signal, assertCurrent() {},
      async relayJson(credentials, path, init) {
        const response = await handler(new Request(`https://relay${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${credentials.token}` } }));
        const action = path.split("/").at(-1)!;
        const value = await readDatasetResponse(response, action === "datasets" ? "list" : action, controller.signal);
        if (!response.ok) throw Error(`Relay ${response.status}`);
        return value;
      } });
    expect((await data.list({})).datasets.map(row => row.name)).toEqual(["Registrations"]);
    expect((await data.describe(id(1))).datasetId).toBe(id(1));
    expect((await data.approvedArtifacts(id(1))).revision).toEqual(revision);
    f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES('helper-grant','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`).run());
    await data.setGrant!({ action: "setGrant", workspaceId: "w", datasetId: id(1), grantId: "helper-grant",
      grant: { revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(6)], discover: true } });
    const access = await data.permissions!({ action: "permissions", workspaceId: "w", datasetId: id(1) });
    expect(access.permissions).toHaveLength(1);
    expect(access.permissions[0]).toMatchObject({ kind: "data", current: true, metadata: { operationIds: [id(6)] } });
    await data.setGrant!({ action: "removeGrant", workspaceId: "w", datasetId: id(1), principalKey: access.permissions[0]!.principal });
    expect((await data.permissions!({ action: "permissions", workspaceId: "w", datasetId: id(1) })).permissions).toHaveLength(0);
    const pinned = { workspaceId: "w", datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256 };
    const bytesBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
    const upload = { ...pinned, action: "upload" as const, fieldId: id(5), name: "receipt.png", contentType: "image/png", bytesBase64, idempotencyKey: "receipt" };
    const { file } = await data.upload(upload);
    expect(await data.upload(upload)).toMatchObject({ file, replayed: true });
    const submit = { ...pinned, operationId: id(6), input: { name: "Mom", fileId: file.fileId }, idempotencyKey: "register" };
    expect(await data.invoke(submit)).toMatchObject({ result: { accepted: true }, revision: 1 });
    expect(await data.invoke(submit)).toMatchObject({ replayed: true, revision: 1 });
    expect(await data.invoke({ ...pinned, operationId: id(7), input: {}, idempotencyKey: "read" })).toMatchObject({ result: [{ name: "Mom", receipt: file.fileId }] });
    expect(await data.file({ ...pinned, action: "file", fileId: file.fileId })).toEqual({ file, bytesBase64 });
    await expect(data.invoke({ ...submit, input: {}, idempotencyKey: "missing" })).rejects.toMatchObject({ refusal: { code: "name_required", message: "Enter your name." } });
  } finally { controller.abort(); await host.close(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
});
