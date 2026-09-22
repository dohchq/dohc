import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { fixture, limits } from "../../../../services/sync-relay/src/datasetTestFixture";
import { createSyncRelayHandler } from "../../../../services/sync-relay/src/server";
import { createDatasetHandler } from "../ipc/datasetIpc";
import { createNamedDatasetData } from "./namedDataset";
import { createNamedDatasetCacheRegistry } from "./namedDatasetCache";
import { datasetCopyOwnerKey } from "./ownerDatasetCopyRegistry";
import { namedDatasetFetch } from "./namedDatasetTransport";
import type { CloudCredentials } from "./cloudCredentialStore";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
it("keeps two named recipients' projected pages isolated over real HTTP, through restart/offline and known revocation", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "named-pages-relay-"));
  const host = await f.storage.createDatasetHost({ directory: join(directory, "host"), limits, onShutdownError(error) { throw error; } });
  const actor = { kind: "named" as const, workspaceId: "w", userId: "owner" };
  const schemaSql = `CREATE TABLE registrations(id TEXT PRIMARY KEY NOT NULL,person TEXT NOT NULL,name TEXT NOT NULL,secret TEXT NOT NULL);
    INSERT INTO registrations VALUES('a','alice','Alice visible','ALICE PRIVATE'),('b','bob','Bob visible','BOB PRIVATE');`;
  const operationSource = `globalThis.operations={read(ctx){const rows=ctx.db.query('SELECT id,name FROM registrations WHERE person=? ORDER BY id',[ctx.caller.userId]);return {rows,count:rows.length,nextCursor:null};},edit(){return null;}};`;
  const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "schema.sql", operationsPath: "actions.js",
    tables: [{ tableId: id(2), name: "Registrations", sqlName: "registrations", primaryKey: "id", fields: [
      { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
      { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
      { fieldId: id(5), name: "Secret", sqlColumn: "secret", type: "text", required: true, unique: false },
    ] }], operations: [
      { operationId: id(6), name: "read", label: "Read", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)] },
      { operationId: id(7), name: "edit", label: "Edit", tableId: id(2), kind: "edit", access: "helper", readOnly: false, fieldIds: [id(4)] },
    ] };
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const handler = createSyncRelayHandler({ storage: f.storage, datasetHost: host, nowMs: () => 10,
    resolveActor(request, workspaceId) {
      const token = request.headers.get("authorization");
      if (token !== "Bearer alice" && token !== "Bearer bob") throw Error("Unknown account");
      return { workspaceId, userId: token.slice(7) };
    } });
  const server = serveFetchHandler({ handler, maxBodyBytes: () => 1024 * 1024, oversized: () => new Response(null, { status: 413 }), failure: () => new Response(null, { status: 500 }) });
  const listen = (port = 0) => new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  const stop = () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  const registries: ReturnType<typeof createNamedDatasetCacheRegistry>[] = [];
  try {
    await host.activate(actor, { workspaceId: "w", revision, schemaSql, operationSource });
    for (const user of ["alice", "bob"]) {
      f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
        VALUES(?, 's','user',?,NULL,'view',1,'active',1,NULL,NULL)`).run(`${user}-grant`, user));
      host.setDataGrant(actor, { workspaceId: "w", datasetId: id(1), grantId: `${user}-grant`,
        grant: { revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(6), id(7)], discover: true } });
    }
    await listen(); const address = server.address(); if (!address || typeof address === "string") throw Error("No server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = async (user: string) => {
      const credentials: CloudCredentials = { serverUrl: origin, relayUrl: origin, userId: user, token: user, email: `${user}@example.test` };
      const owner = datasetCopyOwnerKey(credentials), registry = createNamedDatasetCacheRegistry({ directory: () => join(directory, user) });
      registries.push(registry); await registry.credentialsChanged(owner);
      const shareView = { shareId: "s", relayUrl: origin, grantedSelector: { paths: ["app"], versionId: null, access: "view" } };
      const data = () => createNamedDatasetData({ workspaceId: "local", shareView, credentials, signal: new AbortController().signal,
        credentialGeneration: 1, currentCredentialGeneration: () => 1, assertCurrent() {}, relayJson: async () => { throw Error("Unexpected transport"); },
        offline: { cache: registry.scope({ owner, binding: ["local", "s", origin], assertCurrent() {} }),
          relayResponse: (credentials, path, init) => namedDatasetFetch(() => fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${credentials.token}` } })),
        } });
      const workspace = { workspaceId: "local", shareView };
      const ipc = createDatasetHandler({
        async withWorkspaceOperation(_caller: string, workspaceId, work) { if (workspaceId !== "local") throw Error("Wrong workspace"); return work({ workspace, signal: new AbortController().signal, assertCurrent() {} }); },
        namedDataForWorkspace: async () => data(), hostForWorkspace: vi.fn(), withAdapter: vi.fn(), createSources: vi.fn(),
      });
      const read = (input = {}) => ipc("renderer", { action: "invoke", workspaceId: "local", datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256,
        operationId: id(6), input, idempotencyKey: "read" });
      return { data, registry, read };
    };
    const alice = await client("alice"), bob = await client("bob");
    expect((await alice.data().describe(id(1))).tables[0]!.fields.map(field => field.name)).toEqual(["ID", "Name"]);
    expect(await alice.read()).toMatchObject({ kind: "invoked", result: { rows: [{ id: "a", name: "Alice visible" }], count: 1 }, copy: { offline: false, coverage: "saved-pages" } });
    expect(await bob.read()).toMatchObject({ kind: "invoked", result: { rows: [{ id: "b", name: "Bob visible" }], count: 1 } });
    for (const user of ["alice", "bob"]) {
      const bytes = await readFile(join(directory, user, "pages.json"), "utf8");
      for (const forbidden of ["PRIVATE", "operationSource", "schemaSql", user === "alice" ? "Bob visible" : "Alice visible"]) expect(bytes).not.toContain(forbidden);
    }
    await alice.registry.close(); await bob.registry.close(); await stop();
    const restartedAlice = await client("alice"), restartedBob = await client("bob");
    expect(await restartedAlice.read()).toMatchObject({ result: { rows: [{ id: "a" }] }, copy: { offline: true, coverage: "saved-pages" } });
    expect(await restartedBob.read()).toMatchObject({ result: { rows: [{ id: "b" }] }, copy: { offline: true, coverage: "saved-pages" } });
    await expect(restartedAlice.read({ after: "not-saved" })).rejects.toThrow(/not saved/);
    await expect(restartedAlice.data().invoke({ datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256, operationId: id(7), input: {}, idempotencyKey: "edit" })).rejects.toThrow(/offline/);
    f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE grant_id='alice-grant'").run());
    await listen(address.port);
    await expect(restartedAlice.read()).rejects.toThrow(/access or rules changed/);
    expect(await restartedBob.read()).toMatchObject({ result: { rows: [{ id: "b" }] }, copy: { offline: false } });
    await stop();
    await expect(restartedAlice.read()).rejects.toThrow(/not saved/);
    await expect(readFile(join(directory, "alice", "pages.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (server.listening) await stop();
    await Promise.all(registries.map(registry => registry.close()));
    await host.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
}, 30_000);
