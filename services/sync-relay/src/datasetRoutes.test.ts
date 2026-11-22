import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { type DatasetDefinition } from "@dohc/security-contract/dataset";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import {
  APP_PUBLICATION_MAX_BUNDLE_BYTES,
  APP_PUBLICATION_MAX_FILES,
  APP_PUBLICATION_MAX_METADATA_BYTES,
  type AppPublicationLimits,
} from "@dohc/security-contract/app-publication";
import { fixture, limits, pushFile } from "./datasetTestFixture";
import { createSyncRelayHandler, streamsRequestBody } from "./server";
import { hashLinkBearer } from "./linkSecurity";
import { createDatasetJournal } from "@dohc/app-backend-runtime/journal";
import { encodeRecoveryManifest } from "@dohc/app-backend-runtime/recovery";

import { ClientClosedRequest, serveFetchHandler } from "@dohc/service-http";
import { guardRelayResponses } from "./relayResponseStanding";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("transfers a recovery archive over 21 MiB through the production HTTP adapter", async () => {
  const source = await httpFixture(),
    target = await httpFixture();
  expect((await source.activate()).status).toBe(200);
  const owner = { kind: "named" as const, workspaceId: "w", userId: "owner" };
  const scope = { workspaceId: "w", datasetId: id(1) };
  for (let index = 0; index < 6; index++) {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x61 + index);
    bytes.write("%PDF-");
    const uploaded = source.host.ownerUpload(owner, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      idempotencyKey: `large-file-${index}`,
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytesBase64: bytes.toString("base64"),
    });
    await source.host.invoke(owner, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: id(5),
      input: { name: `Large ${index}`, fileId: uploaded.file.fileId },
      idempotencyKey: `large-record-${index}`,
    });
  }
  const journal = createDatasetJournal({
    db: source.storage.db,
    transaction: (run) => source.storage.tx(run),
  });
  const cursor = journal.head(scope, () => {}).cursor;
  journal.fence({ expected: cursor, authorize() {} });
  const archive = await source.host.exportRecovery(owner, scope);
  const server = serveFetchHandler({
    handler: guardRelayResponses(target.storage, target.handler),
    maxBodyBytes: () => 21 * 1024 * 1024,
    streamBody: streamsRequestBody,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing server address");
    const iterator = archive.stream()[Symbol.asyncIterator]();
    let transferred = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else {
          transferred += next.value.byteLength;
          controller.enqueue(next.value);
        }
      },
      async cancel() {
        await iterator.return?.(undefined);
      },
    });
    const manifestSha256 = createHash("sha256")
      .update(
        encodeRecoveryManifest(archive.manifest, {
          maxTotalBytes: source.storage.options.workspaceQuotaBytes,
        }),
      )
      .digest("hex");
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      duplex: "half",
      body,
      headers: {
        authorization: "Bearer owner",
        "content-type": "application/octet-stream",
        "x-dohc-dataset-manifest-sha256": manifestSha256,
        "x-dohc-dataset-source-cursor": JSON.stringify(cursor),
      },
    };
    const response = await fetch(
      `http://127.0.0.1:${address.port}/sync/w/datasets/${id(1)}/imports/large-transfer`,
      init,
    );
    expect(transferred).toBeGreaterThan(21 * 1024 * 1024);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sourceCursor: cursor,
      targetCursor: { revision: cursor.revision + 1 },
    });
    expect(await (await target.invoke()).json()).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({ name: "Large 0", receipt: expect.any(String) }),
      ]),
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.dispose();
  }
}, 60_000);
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(1),
  name: "Requests",
  schemaPath: "data/schema.sql",
  operationsPath: "data/operations.js",
  tables: [
    {
      tableId: id(2),
      name: "Requests",
      sqlName: "requests",
      primaryKey: "id",
      fields: [
        { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
        {
          fieldId: id(4),
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: id(7),
          name: "Receipt",
          sqlColumn: "receipt",
          type: "attachment",
          required: false,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: id(5),
      name: "submit",
      label: "Submit",
      tableId: id(2),
      kind: "create",
      access: "link",
      readOnly: false,
      fieldIds: [id(4)],
    },
    {
      operationId: id(6),
      name: "read",
      label: "Read",
      tableId: id(2),
      kind: "read",
      access: "helper",
      readOnly: true,
      fieldIds: [id(3), id(4)],
    },
    {
      operationId: id(8),
      name: "receipt",
      label: "Receipt",
      tableId: id(2),
      kind: "read",
      access: "helper",
      readOnly: true,
      fieldIds: [id(7)],
    },
  ],
};
const schemaSql =
  "CREATE TABLE requests(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,receipt TEXT);";
const operationSource = `globalThis.operations={submit(ctx,input){if(input.fileId)ctx.files.attach(input.fileId);if(!input.name)ctx.refuse('missing_name','A name is required.');ctx.db.execute('INSERT INTO requests VALUES(?,?,?)',[ctx.requestId,input.name,input.fileId??null]);return {accepted:true};},read(ctx){return ctx.db.query('SELECT * FROM requests ORDER BY id');},receipt(ctx,input){const row=ctx.db.query('SELECT receipt FROM requests WHERE receipt=?',[input.fileId])[0];if(!row)ctx.refuse('missing_receipt','Receipt unavailable.');return {fileId:row.receipt};}};`;
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });

async function httpFixture(
  maxParticipantsPerGrant?: number,
  publications = true,
  hostLimits: AppPublicationLimits = limits,
) {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "relay-dataset-routes-"));
  pushFile(f.storage, "dataset-file", null, {
    path: "data/dataset.json",
    text: JSON.stringify({ datasetId: id(1) }),
  });
  let now = 10;
  const host = await f.storage.createDatasetHost({
    publicEditRelease: undefined,
    directory,
    limits: hostLimits,
    maxParticipantsPerGrant,
    nowMs: () => now,
    onShutdownError(error) {
      throw error;
    },
  });
  cleanups.push(async () => {
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  const linkKey = "dataset-http-test-key",
    token = "T".repeat(43);
  f.storage.mintLinkSession({
    session: {
      sessionId: "dataset-http",
      capabilityHash: hashLinkBearer(token, linkKey),
      grantId: "g",
      generation: 1,
      mintedAtMs: 2,
      expiresAtMs: 1000,
    },
  });
  const handler = createSyncRelayHandler({
    storage: f.storage,
    datasetHost: host,
    ...(publications ? { appPublicationLimits: hostLimits } : {}),
    linkKey,
    nowMs: () => 10,
    resolveActor(request, workspaceId) {
      const credential = request.headers.get("authorization");
      if (
        credential !== "Bearer owner" &&
        credential !== "Bearer helper" &&
        credential !== "Bearer stranger"
      )
        throw new UnauthorizedError();
      return { workspaceId, userId: credential.slice(7) };
    },
  });
  const http = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request(`https://relay/sync/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const publicHeaders = {
    authorization: `LinkCapability ${token}`,
    "x-dohc-link-profile-secret": "P".repeat(43),
  };
  const path = `w/datasets/${id(1)}`;
  const activate = () =>
    http(`${path}/activate`, { revision, schemaSql, operationSource, capacityBytes: 1024 * 1024 });
  const invoke = (operationId = id(6), headers = {}) =>
    http(
      `${path}/invoke`,
      {
        revision: 1,
        revisionSha256: revision.revisionSha256,
        operationId,
        input: {},
        idempotencyKey: "read",
      },
      headers,
    );
  function publish(sourceRevision?: string) {
    const previous = f.storage.readAppPublication({
      workspaceId: "w",
      publicationId: f.publicationId,
      ownerUserId: "owner",
      limits,
    });
    const capability = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: id(1),
        revision: 1,
        revisionSha256: revision.revisionSha256,
        operationIds: [id(5), id(6), id(8)],
      },
      revision,
    );
    const candidate = {
      ...previous.candidate,
      ...(sourceRevision ? { sourceRevision } : {}),
      files: previous.candidate.files.filter((file) => file.path === "bundle.js"),
      capabilities: [capability],
    };
    const digest = (domain: string, value: unknown) =>
      createHash("sha256")
        .update(JSON.stringify([domain, value]))
        .digest("hex");
    candidate.bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
    candidate.buildDigest = digest("dohc-app-build-v1", {
      sourceDigest: candidate.sourceDigest,
      dependencyLockDigest: candidate.dependencyLockDigest,
      compiler: candidate.compilerIdentity,
      bundleDigest: candidate.bundleDigest,
    });
    return f.storage.publishAppPublication({
      workspaceId: "w",
      ownerUserId: "owner",
      shareId: "s",
      grantId: "g",
      generation: 1,
      candidate,
      blobs: [],
      limits,
      nowMs: 10,
    }).publicationId;
  }
  return {
    ...f,
    host,
    handler,
    http,
    path,
    activate,
    invoke,
    publish,
    publicHeaders,
    advance(ms: number) {
      now += ms;
    },
  };
}

it("exposes bounded owner history and denies helpers, strangers, and malformed cursors", async () => {
  const f = await httpFixture();
  await f.activate();
  const result = await f.http(`${f.path}/invoke`, {
    revision: 1,
    revisionSha256: revision.revisionSha256,
    operationId: id(5),
    input: { name: "Private name" },
    idempotencyKey: "private-retry",
  });
  expect(result.status).toBe(200);
  const response = await f.http(`${f.path}/history?limit=1`);
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0].operation).toBe("submit");
  expect(JSON.stringify(page)).not.toMatch(/private-retry|Private name|idempotencyKey|resultJson/);
  expect(
    (await f.http(`${f.path}/history`, undefined, { authorization: "Bearer helper" })).status,
  ).toBe(404);
  expect(
    (await f.http(`${f.path}/history`, undefined, { authorization: "Bearer stranger" })).status,
  ).toBe(404);
  expect((await f.http(`${f.path}/history?beforeRevision=0`)).status).toBe(400);
  expect((await f.http(`${f.path}/history?limit=101`)).status).toBe(400);
  expect((await f.http(`${f.path}/history?after=x`)).status).toBe(400);
});

it("takes the owner's agent on a change it makes, and refuses an agent for anyone else", async () => {
  const f = await httpFixture();
  await f.activate();
  const change = (key: string, agent: unknown) => ({
    revision: 1,
    revisionSha256: revision.revisionSha256,
    operationId: id(5),
    input: { name: "By an agent" },
    idempotencyKey: key,
    agent,
  });
  expect(
    (await f.http(`${f.path}/invoke`, change("agent", { depth: 1, agentId: "a" }))).status,
  ).toBe(200);
  for (const agent of [{ depth: -1 }, { depth: 1.5 }, { depth: 1, extra: true }, "a"])
    expect((await f.http(`${f.path}/invoke`, change("bad", agent))).status).toBe(400);
  expect(
    (
      await f.http(`${f.path}/invoke`, change("helper", { depth: 1 }), {
        authorization: "Bearer helper",
      })
    ).status,
  ).toBe(404);
});

it("approves an app on the owner's computer whose candidate is up to the publication metadata bound", async () => {
  const f = await httpFixture(undefined, true, {
    maxFiles: APP_PUBLICATION_MAX_FILES,
    maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES,
    maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES,
  });
  await f.activate();
  const { candidate: published } = f.storage.readAppPublication({
    workspaceId: "w",
    publicationId: f.publicationId,
    ownerUserId: "owner",
    limits,
  });
  const capability = resolveAppDatasetCapability(
    {
      kind: "dataset",
      datasetId: id(1),
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: [id(5), id(6)],
    },
    revision,
  );
  // A candidate of exactly `bytes` serialized bytes, padded through its compiler version.
  const sized = (bytes: number) => {
    const base = { ...published, capabilities: [capability] };
    const version = "v".repeat(
      bytes - Buffer.byteLength(JSON.stringify(base)) + published.compilerIdentity.version.length,
    );
    const candidate = { ...base, compilerIdentity: { ...base.compilerIdentity, version } };
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBe(bytes);
    return candidate;
  };
  const approve = async (bytes: number) =>
    (await f.http(`${f.path}/binding`, { localApp: sized(bytes) })).status;
  const usage = () =>
    Number(
      f.storage.db
        .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'")
        .get()!.usage_bytes,
    );
  const before = usage();
  expect(await approve(200 * 1024)).toBe(200);
  // The server keeps the candidate, so the workspace's quota counts it.
  expect(usage() - before).toBeGreaterThanOrEqual(200 * 1024);
  expect(await approve(APP_PUBLICATION_MAX_METADATA_BYTES)).toBe(200);
  // Over the bound the candidate is refused, by its parser and then by the body limit.
  expect(await approve(APP_PUBLICATION_MAX_METADATA_BYTES + 1)).toBe(400);
  expect(await approve(APP_PUBLICATION_MAX_METADATA_BYTES + 2 * 1024)).toBe(413);
});

it("runs an app on the owner's computer as that app, within its approval, for the owner alone", async () => {
  const f = await httpFixture();
  await f.activate();
  const { candidate: published } = f.storage.readAppPublication({
    workspaceId: "w",
    publicationId: f.publicationId,
    ownerUserId: "owner",
    limits,
  });
  const capability = resolveAppDatasetCapability(
    {
      kind: "dataset",
      datasetId: id(1),
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: [id(5), id(6)],
    },
    revision,
  );
  const candidate = { ...published, capabilities: [capability] };
  const appId = createHash("sha256")
    .update(JSON.stringify(["dohc-local-dataset-app-v1", "w", candidate]))
    .digest("hex");
  const register = (as = "owner") =>
    f.http(`${f.path}/binding`, { localApp: candidate }, { authorization: `Bearer ${as}` });
  const call = (operation: string, as = "owner", authorityRevision = 1) =>
    f.http(
      `w/app-publications/${appId}/backend/invoke`,
      { authorityRevision, operation, input: { name: "Local" }, idempotencyKey: operation },
      { authorization: `Bearer ${as}` },
    );
  // Not yet approved on the server.
  expect((await call("submit")).status).toBe(404);
  for (const as of ["helper", "stranger"]) expect((await register(as)).status).toBe(404);
  const registered = await register();
  expect(registered.status).toBe(200);
  expect(await registered.json()).toEqual({ publicationId: appId, authorityRevision: 1 });
  expect(await (await call("submit")).json()).toMatchObject({ result: { accepted: true } });
  // The owner's computer names the agent driving it; a published app can't.
  const byAgent = (path: string) =>
    f.http(path, {
      authorityRevision: 1,
      operation: "submit",
      input: { name: "Agent" },
      idempotencyKey: "agent",
      agent: { depth: 1 },
    });
  expect((await byAgent(`w/app-publications/${appId}/backend/invoke`)).status).toBe(200);
  expect((await byAgent(`w/app-publications/${f.publish()}/backend/invoke`)).status).toBe(400);
  // Outside its approval, at a stale approval, or for anyone else, the app reaches nothing.
  expect((await call("receipt")).status).toBe(404);
  expect((await call("submit", "owner", 2)).status).toBe(404);
  for (const as of ["helper", "stranger"]) expect((await call("read", as)).status).toBe(404);
  // Approving the same app again, as another of the owner's computers does, keeps its approval current.
  expect(await (await register()).json()).toEqual({ publicationId: appId, authorityRevision: 1 });
  expect((await call("read")).status).toBe(200);
  // Another Collection's approval is refused.
  expect(
    (
      await f.http(`${f.path}/binding`, {
        localApp: { ...candidate, capabilities: [{ ...capability, datasetId: id(9) }] },
      })
    ).status,
  ).toBe(400);
  expect((await f.http(`${f.path}/binding`, { publicationId: appId, enabled: false })).status).toBe(
    200,
  );
  expect((await call("read")).status).toBe(404);
  // Approved again after its withdrawal, it runs again.
  const again = (await (await register()).json()) as { authorityRevision: number };
  expect((await call("read", "owner", again.authorityRevision)).status).toBe(200);
  // A change sent under the approval it withdrew does not run under the new one.
  expect((await call("read", "owner", 1)).status).toBe(404);
});

it("counts an app approved on the owner's computer toward the workspace's storage, gives its bytes back when it is withdrawn, and counts apps approved before once", async () => {
  const f = await httpFixture();
  await f.activate();
  const { candidate: published } = f.storage.readAppPublication({
    workspaceId: "w",
    publicationId: f.publicationId,
    ownerUserId: "owner",
    limits,
  });
  const capability = resolveAppDatasetCapability(
    {
      kind: "dataset",
      datasetId: id(1),
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: [id(5), id(6)],
    },
    revision,
  );
  const candidate = { ...published, capabilities: [capability] };
  const appId = createHash("sha256")
    .update(JSON.stringify(["dohc-local-dataset-app-v1", "w", candidate]))
    .digest("hex");
  const usage = () => ({
    workspace: Number(
      f.storage.db
        .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'")
        .get()!.usage_bytes,
    ),
    collection: Number(
      f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage").get()!
        .storage_bytes,
    ),
  });
  const approve = () => f.http(`${f.path}/binding`, { localApp: candidate });
  const withdraw = () => f.http(`${f.path}/binding`, { publicationId: appId, enabled: false });
  const app = Buffer.byteLength(JSON.stringify(candidate));
  // The app's row stays after a withdrawal, so it counts from the first approval on.
  const row = Buffer.byteLength(appId) + 256;
  const plus = (bytes: number) => ({
    workspace: before.workspace + bytes,
    collection: before.collection + bytes,
  });
  const before = usage();
  expect((await approve()).status).toBe(200);
  const approved = usage();
  expect(approved.workspace - before.workspace).toBeGreaterThan(app + row);
  // Withdrawn, it gives back the app and its binding, and approved again, it takes them again.
  expect((await withdraw()).status).toBe(200);
  expect(usage()).toEqual(plus(row));
  expect((await approve()).status).toBe(200);
  expect(usage()).toEqual(approved);

  // A server from before apps were counted held this app without counting it. Started again,
  // it counts it once.
  const uncount = (bytes: number) => {
    f.storage.db
      .prepare("UPDATE sync_relay_dataset_usage SET storage_bytes=storage_bytes-?")
      .run(bytes);
    f.storage.db
      .prepare(
        "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id='w'",
      )
      .run(bytes);
  };
  uncount(app + row);
  f.storage.db
    .prepare("DELETE FROM sync_relay_migrations WHERE migration_id='local-dataset-app-storage-v1'")
    .run();
  const start = async () => {
    const directory = await mkdtemp(join(tmpdir(), "relay-dataset-restart-"));
    const host = await f.storage.createDatasetHost({
      publicEditRelease: undefined,
      directory,
      limits,
      onShutdownError(error) {
        throw error;
      },
    });
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  };
  await start();
  expect(usage()).toEqual(approved);
  await start();
  expect(usage()).toEqual(approved);
  expect((await withdraw()).status).toBe(200);
  expect(usage()).toEqual(plus(row));
});

it("runs an app on the owner's computer on a server that publishes no apps", async () => {
  const f = await httpFixture(undefined, false);
  await f.activate();
  const { candidate: published } = f.storage.readAppPublication({
    workspaceId: "w",
    publicationId: f.publicationId,
    ownerUserId: "owner",
    limits,
  });
  const capability = resolveAppDatasetCapability(
    {
      kind: "dataset",
      datasetId: id(1),
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: [id(5), id(6)],
    },
    revision,
  );
  const candidate = { ...published, capabilities: [capability] };
  const appId = createHash("sha256")
    .update(JSON.stringify(["dohc-local-dataset-app-v1", "w", candidate]))
    .digest("hex");
  expect((await f.http(`${f.path}/binding`, { localApp: candidate })).status).toBe(200);
  const backend = (publicationId: string, action: string, body: Record<string, unknown>) =>
    f.http(`w/app-publications/${publicationId}/backend/${action}`, {
      authorityRevision: 1,
      operation: "submit",
      ...body,
    });
  expect(
    await (
      await backend(appId, "invoke", { input: { name: "Local" }, idempotencyKey: "a" })
    ).json(),
  ).toMatchObject({ result: { accepted: true } });
  // A form reads its pending response before it takes one.
  expect(await (await backend(appId, "attempt", { action: "get" })).json()).toEqual({
    attempt: null,
  });
  // A published app still reaches nothing here.
  expect(
    (await backend(f.publicationId, "invoke", { input: { name: "Shared" }, idempotencyKey: "b" }))
      .status,
  ).toBe(404);
});

it("returns the journal after the owner's kept copy with a change, and to no one else", async () => {
  const f = await httpFixture();
  await f.activate();
  const { head: after } = await (await f.http(`${f.path}/replica/capture`)).json();
  const change = {
    revision: 1,
    revisionSha256: revision.revisionSha256,
    operationId: id(5),
    input: { name: "Friend" },
    idempotencyKey: "journal-change",
  };
  const copyAt = (cursor: unknown) => ({ "x-dohc-copy-after": JSON.stringify(cursor) });
  const answer = await (await f.http(`${f.path}/invoke`, change, copyAt(after))).json();
  expect(answer).toMatchObject({
    result: { accepted: true },
    replayed: false,
    catchUp: { records: [{ kind: "event", cursor: { revision: after.revision + 1 } }] },
  });
  const [record] = answer.catchUp.records;
  expect(answer.catchUp.head).toEqual(record.cursor);
  const blob = await f.http(`${f.path}/replica/blob`, {
    record,
    offset: 0,
    length: record.byteLength,
  });
  expect(Buffer.from(answer.catchUp.changesets[0], "base64")).toEqual(
    Buffer.from(await blob.arrayBuffer()),
  );
  // A helper with a grant reads, but never the journal, which holds every change.
  f.storage.tx(() =>
    f.storage.db
      .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('journal-helper','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`)
      .run(),
  );
  await f.http(`${f.path}/grants`, {
    grantId: "journal-helper",
    grant: {
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: [id(6)],
      discover: true,
    },
  });
  const helped = await f.http(
    `${f.path}/invoke`,
    { ...change, operationId: id(6), input: {}, idempotencyKey: "helper-read" },
    {
      authorization: "Bearer helper",
      "x-dohc-dataset-grant": "journal-helper",
      ...copyAt(after),
    },
  );
  expect(helped.status).toBe(200);
  expect(await helped.json()).not.toHaveProperty("catchUp");
  expect(
    (
      await f.http(
        `${f.path}/invoke`,
        { ...change, idempotencyKey: "other-collection" },
        copyAt({ ...after, datasetId: id(9) }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.http(
        `${f.path}/invoke`,
        { ...change, idempotencyKey: "not-json" },
        { "x-dohc-copy-after": "{" },
      )
    ).status,
  ).toBe(400);
});
it("answers a dataset read its client closed as closed, without an error line, and still logs any other failure", async () => {
  const f = await httpFixture();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const read = (handler: typeof f.handler, reason?: unknown) => {
      const closed = new AbortController();
      closed.abort(reason);
      return handler(
        new Request(`https://relay/sync/${f.path}`, {
          headers: { authorization: "Bearer owner" },
          signal: closed.signal,
        }),
      );
    };
    expect((await read(f.handler, new ClientClosedRequest())).status).toBe(499);
    expect(errors).not.toHaveBeenCalled();
    // A connection the server closed itself, as at shutdown, is not a client leaving: it logs and answers 500.
    expect((await read(f.handler)).status).toBe(500);
    expect(errors).toHaveBeenCalledWith("[sync-relay] unhandled error", "AbortError");
    errors.mockClear();
    const failing = createSyncRelayHandler({
      storage: f.storage,
      datasetHost: f.host,
      appPublicationLimits: limits,
      linkKey: "dataset-http-test-key",
      nowMs: () => 10,
      resolveActor() {
        throw new Error("actor lookup failed");
      },
    });
    expect((await read(failing, new ClientClosedRequest())).status).toBe(500);
    expect(errors).toHaveBeenCalledWith("[sync-relay] unhandled error", "Error");
  } finally {
    errors.mockRestore();
  }
});

it("creates and manages one dataset through authenticated routes and the public app broker", async () => {
  const f = await httpFixture();
  expect((await f.activate()).status).toBe(200);
  expect((await (await f.http("w/datasets")).json()).datasets[0].name).toBe("Requests");
  expect((await f.http(f.path)).status).toBe(200);
  const publicationId = f.publish(),
    publicPath = `link/app-publications/${publicationId}/backend/invoke`;
  const listing = await (await f.http("w/app-publications")).json();
  const listed = listing.publications.find(
    (row: { publicationId: string }) => row.publicationId === publicationId,
  );
  expect(listed).toMatchObject({
    datasetCapability: { kind: "dataset", datasetId: id(1), operationIds: [id(5), id(6), id(8)] },
    collectionCapability: null,
  });
  expect(JSON.stringify(listed)).not.toContain(operationSource);
  const body = {
    authorityRevision: 1,
    operation: "submit",
    input: { name: "Friend" },
    idempotencyKey: "submission",
  };
  expect((await f.http(publicPath, body, f.publicHeaders)).status).toBe(404);
  expect((await f.http(`${f.path}/binding`, { publicationId, enabled: true })).status).toBe(200);
  const first = await f.http(publicPath, body, f.publicHeaders);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ result: { accepted: true }, revision: 1 });
  expect(await (await f.http(publicPath, body, f.publicHeaders)).json()).toMatchObject({
    replayed: true,
    revision: 1,
  });
  expect(await (await f.invoke()).json()).toMatchObject({ result: [{ name: "Friend" }] });
  expect((await f.http(publicPath, { ...body, operation: "read" }, f.publicHeaders)).status).toBe(
    404,
  );
  const refusal = await f.http(
    publicPath,
    { ...body, input: {}, idempotencyKey: "missing" },
    f.publicHeaders,
  );
  expect(refusal.status).toBe(409);
  expect(await refusal.json()).toEqual({ code: "missing_name", message: "A name is required." });
  expect((await f.http(`${f.path}/binding`, { publicationId, enabled: false })).status).toBe(200);
  expect((await f.http(publicPath, body, f.publicHeaders)).status).toBe(404);
});

it("archives and restores a dataset with its rows, app bindings, and retry receipts intact", async () => {
  const f = await httpFixture();
  await f.activate();
  const publicationId = f.publish(),
    secondPublicationId = f.publish("a".repeat(64));
  for (const app of [publicationId, secondPublicationId])
    expect((await f.http(`${f.path}/binding`, { publicationId: app, enabled: true })).status).toBe(
      200,
    );
  const publicPath = `link/app-publications/${publicationId}/backend/invoke`;
  const submission = {
    authorityRevision: 1,
    operation: "submit",
    input: { name: "Retained" },
    idempotencyKey: "retained-submission",
  };
  expect((await f.http(publicPath, submission, f.publicHeaders)).status).toBe(200);
  const page = await (await f.http(`${f.path}/lifecycle?limit=1`)).json();
  expect(page).toMatchObject({
    archived: false,
    generation: 0,
    apps: [{ appId: [publicationId, secondPublicationId].sort()[0] }],
  });
  expect(page.nextCursor).toBe(page.apps[0].appId);
  const next = await (await f.http(`${f.path}/lifecycle?limit=1&after=${page.nextCursor}`)).json();
  expect(next.apps.map((app: { appId: string }) => app.appId)).toEqual([
    [publicationId, secondPublicationId].sort()[1],
  ]);
  expect(next.nextCursor).toBeNull();

  const archived = await f.http(`${f.path}/archive`, {});
  expect(archived.status).toBe(200);
  expect(await archived.json()).toMatchObject({ archived: true, generation: 1 });
  const usage = f.storage.db
    .prepare("SELECT storage_bytes FROM sync_relay_dataset_usage")
    .get()!.storage_bytes;
  expect(await (await f.http(`${f.path}/archive`, {})).json()).toMatchObject({
    archived: true,
    generation: 1,
  });
  expect(
    f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage").get()!.storage_bytes,
  ).toBe(usage);
  expect(await (await f.http("w/datasets")).json()).toEqual({ datasets: [], nextCursor: null });
  expect(await (await f.http("w/datasets?includeArchived=true")).json()).toMatchObject({
    datasets: [{ datasetId: id(1), archived: true }],
  });
  expect((await f.http(f.path)).status).toBe(409);
  expect(await (await f.http(`${f.path}?includeArchived=true`)).json()).toMatchObject({
    datasetId: id(1),
    archived: true,
    operations: [],
  });
  expect((await f.invoke()).status).toBe(409);
  expect(
    (await f.http(publicPath, { ...submission, idempotencyKey: "while-archived" }, f.publicHeaders))
      .status,
  ).toBe(409);

  expect(await (await f.http(`${f.path}/restore`, {})).json()).toEqual({
    archived: false,
    generation: 2,
  });
  expect(await (await f.http(`${f.path}/restore`, {})).json()).toEqual({
    archived: false,
    generation: 2,
  });
  expect(await (await f.http(publicPath, submission, f.publicHeaders)).json()).toMatchObject({
    replayed: true,
    revision: 1,
  });
  expect(await (await f.invoke()).json()).toMatchObject({ result: [{ name: "Retained" }] });
  expect(await (await f.http(`${f.path}/lifecycle`)).json()).toMatchObject({
    archived: false,
    generation: 2,
    apps: expect.arrayContaining([
      { appId: publicationId, binding: expect.any(Object) },
      { appId: secondPublicationId, binding: expect.any(Object) },
    ]),
  });
  f.storage.tx(() =>
    f.storage.db
      .prepare("DELETE FROM sync_relay_dataset_usage WHERE workspace_id='w' AND dataset_id=?")
      .run(id(1)),
  );
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM dohc_dataset_lifecycle").get()!.n).toBe(0);
});

it("restricts lifecycle management and archived discovery to owners and rejects malformed requests", async () => {
  const f = await httpFixture();
  await f.activate();
  f.storage.tx(() =>
    f.storage.db
      .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('helper-grant','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`)
      .run(),
  );
  const helper = { authorization: "Bearer helper", "x-dohc-dataset-grant": "helper-grant" };
  expect(
    (
      await f.http(`${f.path}/grants`, {
        grantId: "helper-grant",
        grant: {
          revision: 1,
          revisionSha256: revision.revisionSha256,
          operationIds: [id(6)],
          discover: true,
        },
      })
    ).status,
  ).toBe(200);
  for (const headers of [helper, { authorization: "Bearer stranger" }]) {
    expect((await f.http(`${f.path}/lifecycle`, undefined, headers)).status).toBe(404);
    for (const action of ["archive", "restore"])
      expect((await f.http(`${f.path}/${action}`, {}, headers)).status).toBe(404);
    expect((await f.http("w/datasets?includeArchived=true", undefined, headers)).status).toBe(404);
    expect((await f.http(`${f.path}?includeArchived=true`, undefined, headers)).status).toBe(404);
  }
  for (const query of [
    "includeArchived=1",
    "includeArchived=",
    "includeArchived=TRUE",
    "includeArchived=true&includeArchived=false",
  ]) {
    expect((await f.http(`w/datasets?${query}`)).status).toBe(400);
    expect((await f.http(`${f.path}?${query}`)).status).toBe(400);
  }
  for (const suffix of [
    "?limit=1",
    "?after=x",
    "/lifecycle?includeArchived=true",
    "/lifecycle?limit=101",
    "/lifecycle?after=",
    "/lifecycle?limit=1&limit=2",
  ]) {
    expect((await f.http(`${f.path}${suffix}`)).status).toBe(400);
  }
  for (const action of ["archive", "restore"]) {
    expect((await f.http(`${f.path}/${action}`)).status).toBe(405);
    expect((await f.http(`${f.path}/${action}`, { userId: "owner" })).status).toBe(400);
    expect((await f.http(`${f.path}/${action}?includeArchived=true`, {})).status).toBe(400);
  }
  expect((await f.http(`${f.path}/lifecycle`, {})).status).toBe(405);
  expect((await f.http("w/datasets?includeArchived=false", undefined, helper)).status).toBe(200);
  await f.http(`${f.path}/archive`, {});
  expect(await (await f.http("w/datasets", undefined, helper)).json()).toEqual({
    datasets: [],
    nextCursor: null,
  });
});

it("mediates named native file uploads and downloads through explicitly granted attachment actions", async () => {
  const f = await httpFixture();
  const nativeDefinition = structuredClone(definition);
  nativeDefinition.datasetId = id(20);
  nativeDefinition.operations[0]!.fieldIds.push(id(7));
  nativeDefinition.operations[1]!.fieldIds.push(id(7));
  const nativeSource = operationSource.replace(
    "return ctx.db.query('SELECT * FROM requests ORDER BY id');",
    `return {rows:ctx.db.query('SELECT * FROM requests ORDER BY id').map(row=>({id:row.id,values:{'${id(7)}':row.receipt}}))};`,
  );
  const nativeRevision = describeDatasetRevision({
    definition: nativeDefinition,
    revision: 1,
    schemaSql,
    operationSource: nativeSource,
  });
  const ownerPath = `w/datasets/${id(20)}`,
    namedPath = `shares/s/datasets/${id(20)}`,
    headers = { authorization: "Bearer helper" };
  expect(
    (
      await f.http(`${ownerPath}/activate`, {
        revision: nativeRevision,
        schemaSql,
        operationSource: nativeSource,
      })
    ).status,
  ).toBe(200);
  f.storage.tx(() =>
    f.storage.db
      .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('native-files','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`)
      .run(),
  );
  const pinned = { revision: 1, revisionSha256: nativeRevision.revisionSha256 };
  const bytesBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
  const upload = {
    ...pinned,
    fieldId: id(7),
    name: "receipt.png",
    contentType: "image/png",
    bytesBase64,
    idempotencyKey: "native-upload",
  };
  expect((await f.http(`${namedPath}/upload`, upload, headers)).status).toBe(404);
  await f.http(`${ownerPath}/grants`, {
    grantId: "native-files",
    grant: { ...pinned, operationIds: [id(5), id(6)], discover: true },
  });
  const response = await f.http(`${namedPath}/upload`, upload, headers);
  expect(response.status).toBe(200);
  const { file } = await response.json();
  const read = {
    ...pinned,
    fileId: file.fileId,
    read: { operationId: id(6), fieldId: id(7), input: {} },
  };
  expect((await f.http(`${namedPath}/file`, read, headers)).status).toBe(404);
  expect(
    (
      await f.http(
        `${namedPath}/invoke`,
        {
          ...pinned,
          operationId: id(5),
          input: { name: "Helper", fileId: file.fileId },
          idempotencyKey: "native-submit",
        },
        headers,
      )
    ).status,
  ).toBe(200);
  expect(await (await f.http(`${namedPath}/file`, read, headers)).json()).toEqual({
    file,
    bytesBase64,
  });
  expect(
    (
      await f.http(
        `${namedPath}/file`,
        { ...read, read: { ...read.read, fieldId: id(4) } },
        headers,
      )
    ).status,
  ).toBe(404);
  expect((await f.http(`${namedPath}/upload`, { ...upload, fieldId: id(4) }, headers)).status).toBe(
    404,
  );
  await f.http(`${ownerPath}/grants`, { grantId: "native-files", grant: null });
  expect((await f.http(`${namedPath}/file`, read, headers)).status).toBe(404);
});

it("rejects ambient credentials and forged request authority before changing data", async () => {
  const f = await httpFixture();
  await f.activate();
  const credentialCases: Record<string, string>[] = [
    { cookie: "ambient" },
    { authorization: "" },
    f.publicHeaders,
    { authorization: "Bearer stranger" },
  ];
  for (const headers of credentialCases) {
    expect([401, 404]).toContain((await f.http(f.path, undefined, headers)).status);
  }
  expect(
    (
      await f.http(`${f.path}/invoke`, {
        revision: 1,
        revisionSha256: revision.revisionSha256,
        operationId: id(5),
        input: { name: "bad" },
        idempotencyKey: "bad",
        userId: "owner",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.http(`${f.path}/activate`, {
        revision: { ...revision, datasetId: id(9) },
        schemaSql,
        operationSource,
      })
    ).status,
  ).toBe(400);
  expect((await f.http(`${f.path}?workspaceId=other`)).status).toBe(400);
  expect((await f.http("w/datasets?limit=1&limit=2")).status).toBe(400);
  const stale = await f.http(`${f.path}/invoke`, {
    revision: 2,
    revisionSha256: revision.revisionSha256,
    operationId: id(6),
    input: {},
    idempotencyKey: "stale",
  });
  expect(stale.status).toBe(409);
  expect(await (await f.invoke()).json()).toMatchObject({ result: [] });
});

const upload = {
  authorityRevision: 1,
  idempotencyKey: "receipt-upload",
  name: "receipt.png",
  contentType: "image/png",
  bytesBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64"),
};
async function attachmentsFixture() {
  const f = await httpFixture();
  await f.activate();
  const publicationId = f.publish();
  const app = (action: string, body: unknown, headers = f.publicHeaders) =>
    f.http(`link/app-publications/${publicationId}/backend/${action}`, body, headers);
  const named = (action: string, body: unknown) =>
    f.http(`w/app-publications/${publicationId}/backend/${action}`, body);
  const bind = (enabled: boolean) => f.http(`${f.path}/binding`, { publicationId, enabled });
  return { ...f, app, named, bind, publicationId };
}

it("uploads and atomically attaches a receipt, then discloses bytes only through the approved read operation", async () => {
  const f = await attachmentsFixture();
  expect((await f.app("upload", upload)).status).toBe(404);
  await f.bind(true);
  const uploaded = await f.app("upload", upload);
  expect(uploaded.status).toBe(200);
  const { file } = await uploaded.json();
  expect(await (await f.app("upload", upload)).json()).toMatchObject({ file, replayed: true });
  expect((await f.app("upload", { ...upload, name: "changed.png" })).status).toBe(409);
  const read = {
    authorityRevision: 1,
    operation: "receipt",
    fileId: file.fileId,
    input: { fileId: file.fileId },
  };
  expect((await f.named("file", read)).status).toBe(409);
  const submit = {
    authorityRevision: 1,
    operation: "submit",
    input: { name: "Friend", fileId: file.fileId },
    idempotencyKey: "receipt-submit",
  };
  expect((await f.app("invoke", submit)).status).toBe(200);
  const usage = f.storage.db
    .prepare("SELECT storage_bytes FROM sync_relay_dataset_usage")
    .get()!.storage_bytes;
  expect(await (await f.app("invoke", submit)).json()).toMatchObject({ replayed: true });
  expect(
    f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage").get()!.storage_bytes,
  ).toBe(usage);
  expect((await f.app("file", read)).status).toBe(404);
  expect((await f.named("file", { ...read, operation: "read" })).status).toBe(404);
  expect(await (await f.named("file", read)).json()).toEqual({
    file,
    bytesBase64: upload.bytesBase64,
  });
  f.storage.tx(() =>
    f.storage.db
      .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('file-helper','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`)
      .run(),
  );
  const helper = () =>
    f.http(`w/app-publications/${f.publicationId}/backend/file`, read, {
      authorization: "Bearer helper",
      "x-dohc-dataset-grant": "file-helper",
    });
  expect((await helper()).status).toBe(404);
  await f.http(`${f.path}/grants`, {
    grantId: "file-helper",
    grant: {
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: [id(8)],
      discover: false,
    },
  });
  expect(await (await helper()).json()).toEqual({ file, bytesBase64: upload.bytesBase64 });
  await f.http(`${f.path}/grants`, { grantId: "file-helper", grant: null });
  expect((await helper()).status).toBe(404);
  await f.bind(false);
  expect((await f.named("file", read)).status).toBe(404);
  expect((await f.app("upload", upload)).status).toBe(404);
});

it("keeps staged files private to their caller and rolls attachment back with a refused operation", async () => {
  const f = await attachmentsFixture();
  await f.bind(true);
  const { file } = await (await f.app("upload", upload)).json();
  const submit = {
    authorityRevision: 1,
    operation: "submit",
    input: { name: "Other", fileId: file.fileId },
    idempotencyKey: "submit",
  };
  const second = { ...f.publicHeaders, "x-dohc-link-profile-secret": "Q".repeat(43) };
  expect((await f.app("invoke", submit, second)).status).toBe(503);
  const another = await (await f.app("upload", upload, second)).json();
  expect(another.file.fileId).not.toBe(file.fileId);
  const otherApp = f.publish("a".repeat(64));
  await f.http(`${f.path}/binding`, { publicationId: otherApp, enabled: true });
  expect(
    (await f.http(`link/app-publications/${otherApp}/backend/invoke`, submit, f.publicHeaders))
      .status,
  ).toBe(503);
  expect((await f.app("invoke", { ...submit, input: { fileId: file.fileId } })).status).toBe(409);
  expect(
    f.storage.db
      .prepare("SELECT attached_revision FROM sync_relay_dataset_files WHERE file_id=?")
      .get(file.fileId)!.attached_revision,
  ).toBeNull();
  const quota = f.storage.db
    .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'")
    .get()!.usage_bytes;
  expect(
    (await f.app("upload", { ...upload, bytesBase64: Buffer.from("not a png").toString("base64") }))
      .status,
  ).toBe(400);
  expect(
    f.storage.db
      .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'")
      .get()!.usage_bytes,
  ).toBe(quota);
  f.advance(86_400_001);
  // Owner credentials remain valid after public link expiry and trigger bounded staged-file cleanup.
  expect((await f.named("upload", { ...upload, idempotencyKey: "owner-new" })).status).toBe(200);
  expect(
    f.storage.db
      .prepare("SELECT file_id FROM sync_relay_dataset_files WHERE file_id=?")
      .get(file.fileId),
  ).toBeUndefined();
  f.storage.tx(() =>
    f.storage.db.prepare("DELETE FROM sync_relay_dataset_usage WHERE workspace_id='w'").run(),
  );
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_files").get()!.n).toBe(
    0,
  );
});

it("retains the first participant attempt across lost replies and clears only its captured token", async () => {
  const f = await httpFixture();
  await f.activate();
  const publicationId = f.publish();
  await f.http(`${f.path}/binding`, { publicationId, enabled: true });
  const path = `link/app-publications/${publicationId}/backend`;
  const request = (action: object, headers = f.publicHeaders) =>
    f.http(`${path}/attempt`, { authorityRevision: 1, operation: "submit", ...action }, headers);
  expect(await (await request({ action: "get" })).json()).toEqual({ attempt: null });
  const save = { action: "save", idempotencyKey: "original", input: { name: "Friend" } };
  const first = await request(save);
  expect(first.status).toBe(200);
  const saved = await first.json();
  expect(saved.attempt).toMatchObject({ idempotencyKey: "original", input: { name: "Friend" } });
  expect(
    await (
      await request({ ...save, idempotencyKey: "other-tab", input: { name: "Changed" } })
    ).json(),
  ).toEqual(saved);
  expect(await (await request({ action: "get" })).json()).toEqual(saved);
  const invoke = {
    authorityRevision: 1,
    operation: "submit",
    idempotencyKey: saved.attempt.idempotencyKey,
    input: saved.attempt.input,
  };
  expect((await f.http(`${path}/invoke`, invoke, f.publicHeaders)).status).toBe(200);
  expect(await (await f.http(`${path}/invoke`, invoke, f.publicHeaders)).json()).toMatchObject({
    revision: 1,
    replayed: true,
  });
  expect(await (await f.invoke()).json()).toMatchObject({ result: [{ name: "Friend" }] });
  expect(
    await (
      await request(
        { action: "get" },
        { ...f.publicHeaders, "x-dohc-link-profile-secret": "Q".repeat(43) },
      )
    ).json(),
  ).toEqual({ attempt: null });
  expect((await request({ action: "clear", token: "x".repeat(43) })).status).not.toBe(200);
  expect(await (await request({ action: "get" })).json()).toEqual(saved);
  expect(await (await request({ action: "clear", token: saved.attempt.token })).json()).toEqual({
    attempt: null,
  });
  const next = await (await request({ ...save, idempotencyKey: "next" })).json();
  expect(next.attempt.token).not.toBe(saved.attempt.token);
  expect((await request({ action: "clear", token: saved.attempt.token })).status).not.toBe(200);
  expect((await request({ ...save, principalKey: "other" })).status).toBe(400);
  await f.http(`${f.path}/binding`, { publicationId, enabled: false });
  expect((await request({ action: "get" })).status).toBe(404);
});

it("requires an owner and a current, acknowledged deletion review", async () => {
  const f = await httpFixture();
  await f.activate();
  const publicationId = f.publish();
  await f.http(`${f.path}/binding`, { publicationId, enabled: true });
  expect(await (await f.http(`${f.path}/deletion-status`)).json()).toEqual({ deleted: false });
  const response = await f.http(`${f.path}/delete-preview?limit=1`);
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview).toMatchObject({
    name: "Requests",
    irreversible: true,
    apps: [{ appId: publicationId }],
  });
  const request = { expected: preview.cursor, reviewToken: preview.reviewToken, acknowledge: true };
  for (const user of ["helper", "stranger"]) {
    expect(
      (await f.http(`${f.path}/deletion-status`, undefined, { authorization: `Bearer ${user}` }))
        .status,
    ).toBe(404);
    expect(
      (await f.http(`${f.path}/delete-preview`, undefined, { authorization: `Bearer ${user}` }))
        .status,
    ).toBe(404);
    expect(
      (await f.http(`${f.path}/delete`, request, { authorization: `Bearer ${user}` })).status,
    ).toBe(404);
  }
  expect((await f.http(`${f.path}/delete-preview?limit=101`)).status).toBe(400);
  expect((await f.http(`${f.path}/delete-preview?limit=1&limit=2`)).status).toBe(400);
  for (const invalid of [
    { ...request, acknowledge: false },
    { ...request, acknowledge: undefined },
    { ...request, reviewToken: undefined },
    { ...request, expected: { ...preview.cursor, datasetId: id(9) } },
    { ...request, force: true },
  ])
    expect((await f.http(`${f.path}/delete`, invalid)).status).toBe(400);
  await f.http(`${f.path}/invoke`, {
    revision: 1,
    revisionSha256: revision.revisionSha256,
    operationId: id(5),
    input: { name: "Latest" },
    idempotencyKey: "latest",
  });
  const stale = await f.http(`${f.path}/delete`, request);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ ok: false, code: "conflict", error: "conflict" });
  const live = await (await f.http(`${f.path}/delete-preview`)).json();
  const refused = await f.http(`${f.path}/delete`, {
    expected: live.cursor,
    reviewToken: live.reviewToken,
    acknowledge: true,
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    code: "conflict",
    error: "This Collection isn't archived. Archive it before you delete it permanently.",
  });
  expect((await f.http(`${f.path}/archive`, {})).status).toBe(200);
  const current = await (await f.http(`${f.path}/delete-preview`)).json();
  expect(
    await (
      await f.http(`${f.path}/delete`, {
        expected: current.cursor,
        reviewToken: current.reviewToken,
        acknowledge: true,
      })
    ).json(),
  ).toEqual({ deleted: true, datasetId: id(1) });
  expect(await (await f.http(`${f.path}/deletion-status`)).json()).toEqual({ deleted: true });
  expect((await f.http(`${f.path}/deletion-status?after=x`)).status).toBe(400);
  expect((await f.invoke()).status).not.toBe(200);
  expect((await f.activate()).status).not.toBe(200);
});

it("exposes immutable approved rule history only through the owner route", async () => {
  const f = await httpFixture();
  expect((await f.activate()).status).toBe(200);
  const path = `${f.path}/history-revision?revisionSha256=${revision.revisionSha256}`;
  const response = await f.http(path);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revision, schemaSql, operationSource });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await f.http(path, undefined, { authorization: "Bearer helper" })).status).toBe(404);
  expect((await f.http(path, undefined, { authorization: "Bearer stranger" })).status).toBe(404);
  expect((await f.http(`${f.path}/history-revision?revisionSha256=invalid`)).status).toBe(400);
  expect((await f.http(`${path}&revisionSha256=${revision.revisionSha256}`)).status).toBe(400);
});

it("serves owner-only metadata History and validates its boolean query", async () => {
  const f = await httpFixture();
  expect((await f.activate()).status).toBe(200);
  await f.host.invoke(
    { kind: "named", workspaceId: "w", userId: "owner" },
    {
      workspaceId: "w",
      datasetId: id(1),
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: id(5),
      input: { name: "Private" },
      idempotencyKey: "metadata",
    },
  );
  const response = await f.http(`${f.path}/history?metadataOnly=true`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    lineage: expect.stringMatching(/^[a-f0-9]{64}$/),
    archived: false,
    olderRecordedAtMs: expect.any(Number),
    entries: [{ revision: 1 }],
  });
  expect((await f.http(`${f.path}/history?metadataOnly=false`)).status).toBe(200);
  for (const query of ["metadataOnly=1", "metadataOnly=true&metadataOnly=false"])
    expect((await f.http(`${f.path}/history?${query}`)).status).toBe(400);
  expect(
    (
      await f.http(`${f.path}/history?metadataOnly=true`, undefined, {
        authorization: "Bearer helper",
      })
    ).status,
  ).toBe(404);
});

it("admits a Collection request only once its body has arrived", async () => {
  const f = await httpFixture();
  expect((await f.activate()).status).toBe(200);
  const publicationId = f.publish();
  expect((await f.http(`${f.path}/binding`, { publicationId, enabled: true })).status).toBe(200);
  const appPath = `link/app-publications/${publicationId}/backend/invoke`;
  const submission = {
    authorityRevision: 1,
    operation: "submit",
    input: { name: "Friend" },
    idempotencyKey: "submission",
  };
  const stall = async (path: string, headers: Record<string, string>) => {
    let sender!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const read = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      duplex: "half",
      headers: { authorization: "Bearer owner", "content-type": "application/json", ...headers },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          sender = controller;
          controller.enqueue(new TextEncoder().encode("{"));
        },
        pull() {
          reading();
        },
      }),
    };
    const response = f.handler(new Request(`https://relay/sync/${path}`, init));
    await read;
    return { close: () => sender.close(), response };
  };
  // Slow senders must not hold the relay's Collection copy slot, or a caller's slots.
  const cases: Array<[string, number, Record<string, string>, () => Promise<Response>]> = [
    [`${f.path}/replica/page`, 1, {}, () => f.http(`${f.path}/replica/capture`)],
    [`${f.path}/invoke`, 4, {}, () => f.invoke()],
    [appPath, 4, f.publicHeaders, () => f.http(appPath, submission, f.publicHeaders)],
  ];
  for (const [path, count, headers, admitted] of cases) {
    const stalled = await Promise.all(Array.from({ length: count }, () => stall(path, headers)));
    expect((await admitted()).status).toBe(200);
    for (const request of stalled) {
      request.close();
      expect((await request.response).status).toBe(400);
    }
  }
});

it("supports multi-Collection local apps on the relay, enforces isolation and deletion cleanup, and refuses >1 Collection on shared links", async () => {
  const f = await httpFixture();
  expect((await f.activate()).status).toBe(200);

  // Activate a second Collection in the same workspace.
  const secondDef: DatasetDefinition = {
    formatVersion: 1,
    datasetId: id(101),
    name: "Workouts",
    schemaPath: "workouts/schema.sql",
    operationsPath: "workouts/operations.js",
    tables: [
      {
        tableId: id(102),
        name: "Workouts",
        sqlName: "workouts",
        primaryKey: "id",
        fields: [
          {
            fieldId: id(103),
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: id(104),
            name: "Title",
            sqlColumn: "title",
            type: "text",
            required: true,
            unique: false,
          },
          {
            fieldId: id(107),
            name: "Proof",
            sqlColumn: "proof",
            type: "attachment",
            required: false,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: id(105),
        name: "submit",
        label: "Log",
        tableId: id(102),
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [id(104)],
      },
      {
        operationId: id(106),
        name: "read",
        label: "Read",
        tableId: id(102),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(103), id(104)],
      },
      {
        operationId: id(108),
        name: "receipt",
        label: "Proof",
        tableId: id(102),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(107)],
      },
    ],
  };
  const secondSchema =
    "CREATE TABLE workouts(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,proof TEXT);";
  const secondSource = `globalThis.operations={submit(ctx,input){ctx.db.execute('INSERT INTO workouts VALUES(?,?,?)',[ctx.requestId,input.title,null]);return {ok:true};},read(ctx){return ctx.db.query('SELECT * FROM workouts ORDER BY id');},receipt(ctx,input){return {fileId:input.fileId};}};`;
  const secondRevision = describeDatasetRevision({
    definition: secondDef,
    revision: 1,
    schemaSql: secondSchema,
    operationSource: secondSource,
  });
  pushFile(f.storage, "dataset-file-2", null, {
    path: "workouts/dataset.json",
    text: JSON.stringify({ datasetId: id(101) }),
  });
  expect(
    (
      await f.http(`w/datasets/${id(101)}/activate`, {
        revision: secondRevision,
        schemaSql: secondSchema,
        operationSource: secondSource,
        capacityBytes: 1024 * 1024,
      })
    ).status,
  ).toBe(200);

  const basePub = f.storage.readAppPublication({
    workspaceId: "w",
    publicationId: f.publicationId,
    ownerUserId: "owner",
    limits,
  });
  const cap1 = resolveAppDatasetCapability(
    {
      kind: "dataset",
      alias: "expenses",
      datasetId: id(1),
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: [id(5), id(6), id(8)],
    },
    revision,
  );
  const cap2 = resolveAppDatasetCapability(
    {
      kind: "dataset",
      alias: "workouts",
      datasetId: id(101),
      revision: 1,
      revisionSha256: secondRevision.revisionSha256,
      operationIds: [id(105), id(106), id(108)],
    },
    secondRevision,
  );
  const digest = (domain: string, value: unknown) =>
    createHash("sha256")
      .update(JSON.stringify([domain, value]))
      .digest("hex");
  const files = basePub.candidate.files.filter((file) => file.path === "bundle.js");
  const bundleDigest = digest("dohc-app-bundle-v1", files);
  const buildDigest = digest("dohc-app-build-v1", {
    sourceDigest: basePub.candidate.sourceDigest,
    dependencyLockDigest: basePub.candidate.dependencyLockDigest,
    compiler: basePub.candidate.compilerIdentity,
    bundleDigest,
  });
  const multiCandidate = {
    ...basePub.candidate,
    files,
    bundleDigest,
    buildDigest,
    capabilities: [cap1, cap2],
  };

  // Shared link publication MUST refuse >1 Collection (Decision 1A).
  expect(
    (
      await f.http("w/app-publications", {
        shareId: basePub.owner.shareId,
        grantId: basePub.owner.grantId,
        expectedGrantGeneration: basePub.owner.generation,
        candidate: multiCandidate,
      })
    ).status,
  ).toBe(400);

  // Local workspace approval via /sync/w/local-apps succeeds for the owner.
  const approvedRes = await f.http("w/local-apps", { localApp: multiCandidate });
  expect(approvedRes.status).toBe(200);
  const approved = (await approvedRes.json()) as {
    publicationId: string;
    authorityRevision: number;
  };
  const backendBase = `w/app-publications/${approved.publicationId}/backend`;

  // Missing alias returns 400; unknown alias returns 404.
  expect(
    (
      await f.http(`${backendBase}/invoke`, {
        authorityRevision: approved.authorityRevision,
        operation: "read",
        input: {},
        idempotencyKey: "no-alias",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.http(`${backendBase}/invoke`, {
        authorityRevision: approved.authorityRevision,
        dataset: "other",
        operation: "read",
        input: {},
        idempotencyKey: "bad-alias",
      })
    ).status,
  ).toBe(404);

  // Upload to expenses, attach, read via expenses, and verify workouts cannot read expenses' fileId.
  const upRes = await f.http(`${backendBase}/upload`, {
    authorityRevision: approved.authorityRevision,
    dataset: "expenses",
    idempotencyKey: "up-1",
    name: "receipt.pdf",
    contentType: "application/pdf",
    bytesBase64: "JVBERi0=",
  });
  expect(upRes.status).toBe(200);
  const uploaded = (await upRes.json()) as { file: { fileId: string } };
  expect(
    (
      await f.http(`${backendBase}/invoke`, {
        authorityRevision: approved.authorityRevision,
        dataset: "expenses",
        operation: "submit",
        input: { name: "Coffee", fileId: uploaded.file.fileId },
        idempotencyKey: "sub-1",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.http(`${backendBase}/invoke`, {
        authorityRevision: approved.authorityRevision,
        dataset: "workouts",
        operation: "submit",
        input: { title: "Run 5k" },
        idempotencyKey: "wrk-1",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.http(`${backendBase}/file`, {
        authorityRevision: approved.authorityRevision,
        dataset: "expenses",
        fileId: uploaded.file.fileId,
        operation: "receipt",
        input: { fileId: uploaded.file.fileId },
      })
    ).status,
  ).toBe(200);
  // Cross-Collection file read MUST be refused.
  expect(
    (
      await f.http(`${backendBase}/file`, {
        authorityRevision: approved.authorityRevision,
        dataset: "workouts",
        fileId: uploaded.file.fileId,
        operation: "receipt",
        input: { fileId: uploaded.file.fileId },
      })
    ).status,
  ).toBe(404);

  // Archiving Collection 2 deactivates the whole app (including Collection 1 requests).
  expect((await f.http(`w/datasets/${id(101)}/archive`, {})).status).toBe(200);
  expect(
    (
      await f.http(`${backendBase}/invoke`, {
        authorityRevision: approved.authorityRevision,
        dataset: "expenses",
        operation: "read",
        input: {},
        idempotencyKey: "after-archive",
      })
    ).status,
  ).toBe(404);

  // Restoring Collection 2 re-enables the app; withdrawing via /local-apps revokes all bindings.
  expect((await f.http(`w/datasets/${id(101)}/restore`, {})).status).toBe(200);
  expect(
    (
      await f.http(`${backendBase}/invoke`, {
        authorityRevision: approved.authorityRevision,
        dataset: "expenses",
        operation: "read",
        input: {},
        idempotencyKey: "after-restore",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.http("w/local-apps", {
        publicationId: approved.publicationId,
        enabled: false,
      })
    ).status,
  ).toBe(200);
  expect(
    f.storage.db
      .prepare("SELECT count(*) AS n FROM dohc_dataset_bindings WHERE workspace_id=? AND app_id=?")
      .get("w", approved.publicationId)!.n,
  ).toBe(0);

  // Re-approving increments authorityRevision, and permanently deleting Collection 2 cleans up Collection 1's binding.
  const reapprovedRes = await f.http("w/local-apps", { localApp: multiCandidate });
  expect(reapprovedRes.status).toBe(200);
  const reapproved = (await reapprovedRes.json()) as {
    publicationId: string;
    authorityRevision: number;
  };
  expect(reapproved.authorityRevision).toBe(approved.authorityRevision + 1);
  expect((await f.http(`w/datasets/${id(101)}/archive`, {})).status).toBe(200);
  const delPreview = (await (await f.http(`w/datasets/${id(101)}/delete-preview`)).json()) as {
    cursor: unknown;
    reviewToken: string;
  };
  expect(
    (
      await f.http(`w/datasets/${id(101)}/delete`, {
        expected: delPreview.cursor,
        reviewToken: delPreview.reviewToken,
        acknowledge: true,
      })
    ).status,
  ).toBe(200);
  expect(
    f.storage.db
      .prepare(
        "SELECT 1 FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?",
      )
      .get("w", id(1), reapproved.publicationId),
  ).toBeUndefined();
});
