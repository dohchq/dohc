import { createDatasetAppRoutes } from "./datasetRoutes";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { type AppDatasetBinding, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { fixture as appFixture, limits, owner, pushFile } from "./datasetTestFixture";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { AppBackendAction } from "./appBackendRoutes";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { PublicEditRelease } from "@dohc/security-contract";
import {
  createRelayDatasetHost,
  datasetReferenceReadContainsRecord,
  type RelayDatasetHost,
} from "./datasetHost";
import { workspaceUsageBytes } from "./storage/workspaces";
import { createDatasetJournal } from "@dohc/app-backend-runtime/journal";
import { encodeRecoveryManifest } from "@dohc/app-backend-runtime/recovery";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const schemaSql = "CREATE TABLE people(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);";
const operationSource = `globalThis.operations={
  submit(ctx,input){ctx.db.execute('INSERT INTO people VALUES(?,?)',[ctx.requestId,input.name]);return {accepted:true};},
  read(ctx){return ctx.db.query('SELECT * FROM people ORDER BY id');},
  edit(ctx,input){ctx.db.execute('UPDATE people SET name=? WHERE id=?',[input.name,input.id]);return true;}
};`;
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(1),
  name: "Registrations",
  schemaPath: "registrations/schema.sql",
  operationsPath: "registrations/operations.js",
  tables: [
    {
      tableId: id(2),
      name: "People",
      sqlName: "people",
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
      operationId: id(7),
      name: "edit",
      label: "Edit",
      tableId: id(2),
      kind: "edit",
      access: "helper",
      readOnly: false,
      fieldIds: [id(4)],
    },
  ],
};
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const scope = { workspaceId: "w", datasetId: definition.datasetId };
const helper: AppBackendAuth = {
  kind: "named",
  workspaceId: "w",
  userId: "helper",
  grantId: "helper-grant",
};

it("tests the filtered primary key field rather than the row envelope id", () => {
  expect(
    datasetReferenceReadContainsRecord(
      { rows: [{ id: "wrong", values: { [id(3)]: "record" } }] },
      id(3),
      "record",
    ),
  ).toBe(true);
  expect(
    datasetReferenceReadContainsRecord(
      { rows: [{ id: "record", values: { [id(3)]: "wrong" } }] },
      id(3),
      "record",
    ),
  ).toBe(false);
  expect(
    datasetReferenceReadContainsRecord({ rows: [{ id: 7, values: { [id(3)]: "7" } }] }, id(3), 7),
  ).toBe(false);
});

async function fixture(
  startupExclusive = false,
  prepared = { revision, schemaSql, operationSource },
  publicEditRelease?: PublicEditRelease,
) {
  const { revision, schemaSql, operationSource } = prepared;
  const base = appFixture(),
    directory = await mkdtemp(join(tmpdir(), "relay-dataset-test-"));
  let host: RelayDatasetHost;
  const shutdownErrors: unknown[] = [];
  let now = 10;
  const create = () =>
    createRelayDatasetHost({
      publicEditRelease,
      storage: base.storage,
      directory,
      limits,
      startupExclusive,
      nowMs: () => now,
      onShutdownError(error) {
        shutdownErrors.push(error);
      },
    });
  host = await create();
  cleanups.push(async () => {
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    expect(shutdownErrors).toEqual([]);
  });
  const activate = () =>
    host.activate(owner, {
      ...scope,
      revision,
      schemaSql,
      operationSource,
      capacityBytes: 1024 * 1024,
    });
  const invoke = (
    auth: AppBackendAuth,
    operationId: string,
    input = {},
    publicationId?: string,
    key = "request",
  ) =>
    host.invoke(auth, {
      ...scope,
      revision: revision.revision,
      revisionSha256: revision.revisionSha256,
      operationId,
      input,
      idempotencyKey: key,
      ...(publicationId ? { access: { kind: "app" as const, appId: publicationId } } : {}),
    });
  function addHelper() {
    base.storage.tx(() =>
      base.storage.db
        .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES('helper-grant','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`)
        .run(),
    );
  }
  function publish(operationIds = [id(5)], linkReads?: AppDatasetBinding["linkReads"]) {
    const capability = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: id(1),
        revision: 1,
        revisionSha256: revision.revisionSha256,
        operationIds,
        ...(linkReads ? { linkReads } : {}),
      },
      revision,
    );
    const publicationId = publishWith([capability]);
    host.bindPublication(owner, { ...scope, publicationId });
    return publicationId;
  }
  /** Publishes the fixture's app again, requesting `capabilities`. */
  function publishWith(capabilities: AppPublicationCandidate["capabilities"]) {
    const previous = base.storage.readAppPublication({
      ...scope,
      publicationId: base.publicationId,
      ownerUserId: "owner",
      limits,
    });
    const candidate = {
      ...previous.candidate,
      capabilities,
      files: previous.candidate.files.filter((file) => file.path === "bundle.js"),
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
    const result = base.storage.publishAppPublication({
      workspaceId: "w",
      ownerUserId: "owner",
      shareId: "s",
      grantId: "g",
      generation: 1,
      candidate,
      blobs: [],
      limits,
      nowMs: 10,
    });
    return result.publicationId;
  }
  // These tests move the clock by minutes, so their link sessions outlast it.
  return {
    ...base,
    link: (id: string) => base.link(id, Number.MAX_SAFE_INTEGER),
    get storage() {
      return base.storage;
    },
    directory,
    get host() {
      return host;
    },
    activate,
    invoke,
    publish,
    publishWith,
    addHelper,
    async reopen() {
      await host.close();
      host = await create();
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

it("permanently deletes at the owner authority and releases private storage without deleting source publications", async () => {
  const f = await fixture();
  await f.activate();
  const publicationId = f.publish(),
    link = f.link("friend");
  await f.invoke(link, id(5), { name: "Deleted" }, publicationId);
  f.host.archiveDataset(owner, scope);
  const preview = f.host.deletePreview(owner, scope);
  const request = {
    ...scope,
    expected: preview.cursor,
    reviewToken: preview.reviewToken,
    acknowledge: true as const,
  };
  await expect(f.host.deleteDataset(link, request)).rejects.toThrow();
  const usage = Number(
    f.storage.db
      .prepare(
        "SELECT storage_bytes FROM sync_relay_dataset_usage WHERE workspace_id=? AND dataset_id=?",
      )
      .get(scope.workspaceId, scope.datasetId)!.storage_bytes,
  );
  const before = workspaceUsageBytes(f.storage, "w");
  await expect(f.host.deleteDataset(owner, request)).resolves.toEqual({
    deleted: true,
    datasetId: scope.datasetId,
  });
  expect(workspaceUsageBytes(f.storage, "w")).toBe(before - usage);
  for (const table of [
    "dohc_dataset_catalog",
    "dohc_dataset_bindings",
    "dohc_dataset_events",
    "dohc_dataset_checkpoint_chunks",
    "sync_relay_dataset_files",
    "sync_relay_dataset_usage",
  ])
    expect(f.storage.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
  expect(
    f.storage.db
      .prepare("SELECT 1 FROM sync_relay_app_publications WHERE publication_id=?")
      .get(publicationId),
  ).toBeTruthy();
  await f.reopen();
  await expect(f.activate()).rejects.toThrow("deleted");
  await expect(f.invoke(link, id(5), { name: "Deleted" }, publicationId)).rejects.toThrow();
});

it("keeps public submission separate from discovery and rejects forged cross-workspace bindings", async () => {
  const f = await fixture();
  await f.activate();
  const publicationId = f.publish(),
    link = f.link("friend");
  expect(() => f.host.list(link, { workspaceId: "w" })).toThrow();
  expect(() => f.host.describe(link, scope)).toThrow();
  await expect(f.invoke(link, id(6), {}, publicationId)).rejects.toThrow();
  await expect(f.invoke(link, id(5), { name: "friend" })).rejects.toThrow();
  const otherOwner: AppBackendAuth = { kind: "named", workspaceId: "other", userId: "other-owner" };
  f.storage.claimWorkspace({ workspaceId: "other", ownerUserId: "other-owner", createdAtMs: 1 });
  await expect(
    f.host.activate(otherOwner, { ...scope, revision, schemaSql, operationSource }),
  ).rejects.toThrow();
  await expect(
    f.host.invoke(link, {
      ...scope,
      workspaceId: "other",
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: id(5),
      input: { name: "bad" },
      idempotencyKey: "bad",
      access: { kind: "app", appId: publicationId },
    }),
  ).rejects.toThrow();
  expect(() => f.host.bindPublication(otherOwner, { ...scope, publicationId })).toThrow();
  expect(f.host.list(otherOwner, { workspaceId: "other" }).datasets).toEqual([]);
});

it("allows only explicitly granted helper operations with view-only source access", async () => {
  const f = await fixture();
  await f.activate();
  f.addHelper();
  const publicationId = f.publish([id(5), id(6), id(7)]);
  expect(f.host.list(helper, { workspaceId: "w" }).datasets).toEqual([]);
  await expect(f.invoke(helper, id(6), {}, publicationId)).rejects.toThrow();
  f.host.setDataGrant(owner, {
    ...scope,
    grantId: "helper-grant",
    grant: {
      operationIds: [id(6)],
      discover: true,
      revision: 1,
      revisionSha256: revision.revisionSha256,
    },
  });
  expect((await f.invoke(helper, id(6), {}, publicationId)).result).toEqual([]);
  await expect(
    f.invoke(helper, id(7), { id: "other", name: "bad" }, publicationId),
  ).rejects.toThrow();
  expect(f.host.describe(helper, scope).operations.map((operation) => operation.name)).toEqual([
    "read",
  ]);
  expect(() => f.host.bindPublication(helper, { ...scope, publicationId })).toThrow();
  f.storage.tx(() =>
    f.storage.db
      .prepare(
        "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=10 WHERE grant_id='helper-grant'",
      )
      .run(),
  );
  expect(() => f.host.list(helper, { workspaceId: "w" })).toThrow();
  await expect(f.invoke(helper, id(6), {}, publicationId)).rejects.toThrow();
});

it.each(["invalid principal", "revoked parent", "stale generation"] as const)(
  "refuses named publication access with a %s",
  async (reason) => {
    const f = await fixture();
    await f.activate();
    f.addHelper();
    const publicationId = f.publish([id(6)]);
    f.host.setDataGrant(owner, {
      ...scope,
      grantId: "helper-grant",
      grant: {
        operationIds: [id(6)],
        discover: true,
        revision: 1,
        revisionSha256: revision.revisionSha256,
      },
    });
    if (reason === "revoked parent") {
      f.storage.tx(() => {
        f.storage.db
          .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
        VALUES('publication-parent','s','link',NULL,NULL,'view',1,'active',1,NULL,NULL)`)
          .run();
        f.storage.db
          .prepare(
            "UPDATE sync_relay_share_grants SET principal_kind='user',principal_user_id='reader',parent_grant_id='publication-parent' WHERE grant_id='g'",
          )
          .run();
      });
    }
    for (const auth of [owner, helper])
      expect(f.host.publication(auth, publicationId)).toBeTruthy();
    const readGrant = f.storage.getShareGrant.bind(f.storage);
    const storedGrant = vi.spyOn(f.storage, "getShareGrant");
    try {
      if (reason === "invalid principal") {
        storedGrant.mockImplementation((grantId) => {
          const grant = readGrant(grantId);
          return grantId === "g" && grant
            ? { ...grant, principalUserId: "unexpected-user" }
            : grant;
        });
      } else if (reason === "revoked parent") {
        f.storage.tx(() =>
          f.storage.db
            .prepare(
              "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=10 WHERE grant_id='publication-parent'",
            )
            .run(),
        );
      } else {
        f.storage.tx(() =>
          f.storage.db
            .prepare("UPDATE sync_relay_share_grants SET generation=2 WHERE grant_id='g'")
            .run(),
        );
      }
      for (const auth of [owner, helper]) {
        expect(() => f.host.publication(auth, publicationId)).toThrow();
        await expect(f.invoke(auth, id(6), {}, publicationId)).rejects.toThrow();
      }
      expect(f.host.describe(helper, scope).operations.map((operation) => operation.name)).toEqual([
        "read",
      ]);
    } finally {
      storedGrant.mockRestore();
    }
  },
);

it("rejects cross-workspace grant targets and returns metadata quota on revocation", async () => {
  const f = await fixture();
  await f.activate();
  f.addHelper();
  const before = workspaceUsageBytes(f.storage, "w");
  f.host.setDataGrant(owner, {
    ...scope,
    grantId: "helper-grant",
    grant: {
      operationIds: [id(6)],
      discover: true,
      revision: 1,
      revisionSha256: revision.revisionSha256,
    },
  });
  expect(workspaceUsageBytes(f.storage, "w")).toBeGreaterThan(before);
  f.host.setDataGrant(owner, { ...scope, grantId: "helper-grant", grant: null });
  expect(workspaceUsageBytes(f.storage, "w")).toBe(before);
  f.storage.claimWorkspace({ workspaceId: "other", ownerUserId: "other-owner", createdAtMs: 1 });
  f.storage.createShare({
    share: {
      shareId: "other-share",
      workspaceId: "other",
      granterUserId: "other-owner",
      selectorJson: JSON.stringify({ paths: ["app"], versionId: null }),
      createdAtMs: 1,
    },
    grant: {
      grantId: "other-grant",
      shareId: "other-share",
      principalKind: "user",
      principalUserId: "helper",
      principalEmail: null,
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  expect(() =>
    f.host.setDataGrant(owner, {
      ...scope,
      grantId: "other-grant",
      grant: {
        operationIds: [id(6)],
        discover: true,
        revision: 1,
        revisionSha256: revision.revisionSha256,
      },
    }),
  ).toThrow();
  expect(() =>
    f.host.setDataGrant(owner, {
      ...scope,
      grantId: "missing",
      grant: {
        operationIds: [id(6)],
        discover: true,
        revision: 1,
        revisionSha256: revision.revisionSha256,
      },
    }),
  ).toThrow();
});

it("rolls quota refusal back with the event and receipt, then accepts the same retry", async () => {
  const f = await fixture();
  await f.activate();
  const before = workspaceUsageBytes(f.storage, "w"),
    quota = f.storage.options.workspaceQuotaBytes;
  f.storage.options.workspaceQuotaBytes = before + 10;
  await expect(f.invoke(owner, id(5), { name: "pending" })).rejects.toThrow("quota");
  expect(workspaceUsageBytes(f.storage, "w")).toBe(before);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_events").get()?.n).toBe(0);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_receipts").get()?.n).toBe(0);
  f.storage.options.workspaceQuotaBytes = quota;
  expect((await f.invoke(owner, id(5), { name: "pending" })).revision).toBe(1);
  expect((await f.invoke(owner, id(6))).result).toMatchObject([{ name: "pending" }]);
});

it("rechecks app access after the account sender lookup", async () => {
  const f = await fixture();
  await f.activate();
  const publicationId = f.publish();
  f.addHelper();
  const route = createDatasetAppRoutes(f.host, f.storage, {
    nowMs: () => 10,
    publications: true,
    shareSenderLabel: async () => {
      f.storage.revokeShareGrant({ shareId: "s", grantId: "helper-grant", revokedAtMs: 11 });
      return "Ana (owner@dohc.test)";
    },
  });
  await expect(
    route(
      new Request("https://relay.test/summary"),
      { route: "app-backend", action: "summary", publicationId, workspaceId: "w" },
      helper,
    ),
  ).rejects.toThrow();
});

it("serves an app that requests nothing in the workspace its files, and no backend", async () => {
  const f = await fixture();
  f.addHelper();
  const route = createDatasetAppRoutes(f.host, f.storage, {
    nowMs: () => 10,
    publications: true,
    shareSenderLabel: async () => "Ana (owner@dohc.test)",
  });
  const call = (
    auth: AppBackendAuth,
    action: AppBackendAction,
    { publicationId = f.publicationId, sha256 = "", query = "" } = {},
  ) =>
    route(
      new Request(
        `https://relay.test/${action}${query}`,
        action === "descriptor" || action === "summary" || action === "blob"
          ? {}
          : { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ),
      { route: "app-backend", action, publicationId, workspaceId: "w", ...(sha256 && { sha256 }) },
      auth,
    );
  const { authorityRevision, candidate } = f.storage.readAppPublication({
    ...scope,
    publicationId: f.publicationId,
    ownerUserId: "owner",
    limits,
  });
  const file = candidate.files[0]!;
  const blob = (auth: AppBackendAuth, revision = authorityRevision) =>
    call(auth, "blob", { sha256: file.sha256, query: `?authorityRevision=${revision}` });

  for (const auth of [owner, helper]) {
    expect(await (await call(auth, "descriptor")).json()).toEqual({
      publicationId: f.publicationId,
      authorityRevision,
      files: candidate.files,
    });
    expect(await (await blob(auth)).text()).toBe("document.body.textContent='app'");
    await expect(blob(auth, authorityRevision + 1)).rejects.toThrow();
  }
  expect(await (await call(owner, "summary")).json()).toEqual({
    subjectName: "app",
    sharerName: null,
    access: "owner",
  });
  expect(await (await call(helper, "summary")).json()).toMatchObject({
    sharerName: "Ana (owner@dohc.test)",
    access: "view",
  });
  for (const action of ["activate", "invoke", "upload", "file", "attempt"] as const)
    await expect(call(owner, action)).rejects.toThrow();

  // Nobody else reads its files: a stranger, a link visitor, or a member whose grant was revoked.
  await expect(
    call({ kind: "named", workspaceId: "w", userId: "stranger" }, "descriptor"),
  ).rejects.toThrow();
  await expect(call(f.link("visitor"), "descriptor")).rejects.toThrow();
  f.storage.revokeShareGrant({ shareId: "s", grantId: "helper-grant", revokedAtMs: 11 });
  await expect(call(helper, "descriptor")).rejects.toThrow();
  await expect(blob(helper)).rejects.toThrow();

  // An app that requests a Collection is not one that requests nothing, before or without its approval.
  const collectionApp = f.publishWith([
    {
      kind: "collection-create",
      collectionPath: "responses",
      schemaSha256: "f".repeat(64),
      allowedFields: ["name"],
      requiredFields: ["name"],
      readFields: ["name"],
    },
  ]);
  expect(f.host.servedPublication(owner, collectionApp)).toBeNull();
  await expect(call(owner, "descriptor", { publicationId: collectionApp })).rejects.toThrow();
});

it("rechecks access to an app that requests nothing after the account sender lookup", async () => {
  const f = await fixture();
  f.addHelper();
  const route = createDatasetAppRoutes(f.host, f.storage, {
    nowMs: () => 10,
    publications: true,
    shareSenderLabel: async () => {
      f.storage.revokeShareGrant({ shareId: "s", grantId: "helper-grant", revokedAtMs: 11 });
      return "Ana (owner@dohc.test)";
    },
  });
  await expect(
    route(
      new Request("https://relay.test/summary"),
      {
        route: "app-backend",
        action: "summary",
        publicationId: f.publicationId,
        workspaceId: "w",
      },
      helper,
    ),
  ).rejects.toThrow();
});

it("keeps a published form and its original capability alive after a field rename without republishing", async () => {
  const f = await fixture();
  await f.activate();
  const publicationId = f.publish(),
    link = f.link("rename-friend");
  const published = f.host.publication(link, publicationId)!;
  await f.invoke(link, id(5), { name: "Before rename" }, publicationId, "before");
  const next = structuredClone(definition);
  next.tables[0].fields[1].name = "Full name";
  next.schemaPath = "registrations/revision-2/schema.sql";
  next.operationsPath = "registrations/revision-2/operations.js";
  const renamed = describeDatasetRevision({
    definition: next,
    revision: 2,
    schemaSql,
    operationSource,
  });
  const renamePreview = await f.host.prepareMigration(owner, {
    workspaceId: "w",
    revision: renamed,
    schemaSql,
    operationSource,
    expected: f.host.approvedArtifacts(owner, scope).cursor,
    migrationSql: "SELECT 1;",
  });
  await f.host.approveMigration(owner, {
    ...scope,
    candidateId: renamePreview.candidateId,
    checkpointSha256: renamePreview.checkpointSha256,
  });
  expect(f.host.publication(link, publicationId)!.capability).toEqual(published.capability);
  expect(f.host.publication(link, publicationId)!.authorityRevision).toBe(
    published.authorityRevision,
  );
  await expect(
    f.invoke(link, id(5), { name: "After rename" }, publicationId, "after"),
  ).resolves.toMatchObject({ result: { accepted: true } });
  await expect(
    f.invoke(link, id(5), { name: "Before rename" }, publicationId, "before"),
  ).resolves.toMatchObject({ replayed: true });
  expect((await f.invoke(owner, id(6), {}, undefined, "read")).result).toHaveLength(2);
  await f.reopen();
  expect(f.host.publication(link, publicationId)!.capability).toEqual(published.capability);
  await expect(
    f.invoke(link, id(5), { name: "After restart" }, publicationId, "restart"),
  ).resolves.toMatchObject({ result: { accepted: true } });
  next.operations[0].fieldIds.push(id(3));
  const widened = describeDatasetRevision({
    definition: next,
    revision: 3,
    schemaSql,
    operationSource,
  });
  const widenPreview = await f.host.prepareMigration(owner, {
    workspaceId: "w",
    revision: widened,
    schemaSql,
    operationSource,
    expected: f.host.approvedArtifacts(owner, scope).cursor,
    migrationSql: "SELECT 1;",
  });
  await f.host.approveMigration(owner, {
    ...scope,
    candidateId: widenPreview.candidateId,
    checkpointSha256: widenPreview.checkpointSha256,
  });
  expect(() => f.host.publication(link, publicationId)).toThrow(
    "Its owner must approve this access again",
  );
  await expect(
    f.invoke(link, id(5), { name: "Forbidden" }, publicationId, "forbidden"),
  ).rejects.toThrow();
});

const receiptSchemaSql =
  "CREATE TABLE people(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,receipt TEXT);";
const receiptSource = `globalThis.operations={
  submit(ctx,input){if(input.fileId)ctx.files.attach(input.fileId);ctx.db.execute('INSERT INTO people VALUES(?,?,?)',[ctx.requestId,input.name,input.fileId??null]);return {accepted:true};},
  read(ctx){return ctx.db.query('SELECT * FROM people ORDER BY id');},
  edit(ctx,input){ctx.db.execute('UPDATE people SET name=? WHERE id=?',[input.name,input.id]);return true;}
};`;
const receiptDefinition: DatasetDefinition = {
  ...definition,
  tables: [
    {
      ...definition.tables[0]!,
      fields: [
        ...definition.tables[0]!.fields,
        {
          fieldId: id(8),
          name: "Receipt",
          sqlColumn: "receipt",
          type: "attachment",
          required: false,
          unique: false,
        },
      ],
    },
  ],
};
const receipts = {
  revision: describeDatasetRevision({
    definition: receiptDefinition,
    revision: 1,
    schemaSql: receiptSchemaSql,
    operationSource: receiptSource,
  }),
  schemaSql: receiptSchemaSql,
  operationSource: receiptSource,
};
const receiptBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64");

async function movingCollection() {
  const source = await fixture(false, receipts);
  await source.activate();
  const { file } = source.host.ownerUpload(owner, {
    ...scope,
    revision: 1,
    revisionSha256: receipts.revision.revisionSha256,
    idempotencyKey: "receipt-upload",
    name: "receipt.png",
    contentType: "image/png",
    bytesBase64: receiptBytes,
  });
  await source.invoke(owner, id(5), { name: "Kept", fileId: file.fileId });
  const journal = createDatasetJournal({
    db: source.storage.db,
    transaction: (run) => source.storage.tx(run),
  });
  const sourceCursor = journal.head(scope, () => {}).cursor;
  journal.fence({ expected: sourceCursor, authorize() {} });
  const archive = await source.host.exportRecovery(owner, scope),
    chunks: Uint8Array[] = [];
  const manifestSha256 = createHash("sha256")
    .update(
      encodeRecoveryManifest(archive.manifest, {
        maxTotalBytes: source.storage.options.workspaceQuotaBytes,
      }),
    )
    .digest("hex");
  try {
    for await (const bytes of archive.stream()) chunks.push(bytes);
  } finally {
    await archive.dispose();
  }
  const body = Buffer.concat(chunks);
  return {
    fileId: file.fileId,
    sourceCursor,
    importInto: (host: RelayDatasetHost, activate: boolean, signal?: AbortSignal) =>
      host.importRecovery(owner, {
        ...scope,
        transferId: "move",
        manifestSha256,
        sourceCursor,
        activate,
        signal,
        stream: (async function* () {
          yield body;
        })(),
      }),
  };
}

it("finishes a move whose import stopped when the relay stopped, once the relay starts again (#2903)", async () => {
  const moved = await movingCollection(),
    target = await fixture(true, receipts);
  const usageBefore = workspaceUsageBytes(target.storage, "w");
  const leftover = () => ({
    imports: Number(
      target.storage.db.prepare("SELECT count(*) n FROM dohc_dataset_imports").get()!.n,
    ),
    attachments: Number(
      target.storage.db.prepare("SELECT count(*) n FROM sync_relay_dataset_import_files").get()!.n,
    ),
    stages: Number(
      target.storage.db.prepare("SELECT count(*) n FROM dohc_dataset_checkpoints").get()!.n,
    ),
    usage: workspaceUsageBytes(target.storage, "w"),
    // A usage row left for the Collection refuses creating it on this relay.
    usageRows: Number(
      target.storage.db
        .prepare(
          "SELECT count(*) n FROM sync_relay_dataset_usage WHERE workspace_id=? AND dataset_id=?",
        )
        .get(scope.workspaceId, scope.datasetId)!.n,
    ),
  });
  // The relay stops inside the final install transaction. Records, checkpoints, and the attachment are
  // durable and charged, the transaction rolls back, and the stopped storage cannot run the import's cleanup.
  const stopped = target.storage,
    prepare = stopped.db.prepare.bind(stopped.db);
  const stop = vi.spyOn(stopped.db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("SELECT 1 FROM dohc_dataset_import_checkpoints m JOIN"))
      stopped.invalidate();
    return prepare(sql);
  });
  await expect(moved.importInto(target.host, true)).rejects.toThrow();
  stop.mockRestore();
  const interrupted = leftover();
  expect(stopped.db.prepare("SELECT phase FROM dohc_dataset_imports").get()).toMatchObject({
    phase: "staging",
  });
  expect(interrupted).toMatchObject({ imports: 1, attachments: 1, usageRows: 1 });
  expect(interrupted.stages).toBeGreaterThan(0);
  expect(interrupted.usage).toBeGreaterThan(usageBefore);

  target.restart();
  await target.reopen();
  const restarted = leftover();
  await expect(moved.importInto(target.host, true)).resolves.toMatchObject({
    transferId: "move",
    sourceCursor: moved.sourceCursor,
    targetCursor: { revision: moved.sourceCursor.revision + 1 },
  });
  expect(restarted).toEqual({
    imports: 0,
    attachments: 0,
    stages: 0,
    usage: usageBefore,
    usageRows: 0,
  });
  expect((await target.invoke(owner, id(6))).result).toMatchObject([
    { name: "Kept", receipt: moved.fileId },
  ]);
  expect(
    target.host.ownerReadFile(owner, {
      ...scope,
      revision: 1,
      revisionSha256: receipts.revision.revisionSha256,
      fileId: moved.fileId,
    }),
  ).toMatchObject({ bytesBase64: receiptBytes });
});

const collectionFile = (path = "registrations/dataset.json") => ({
  path,
  text: JSON.stringify({ datasetId: id(1) }),
});
const collectionMissing = { code: "app_collection_missing", statusCode: 410 };

it("keeps an app working while the Collection's folder holds a dataset.json that names no Collection", async () => {
  const f = await fixture();
  await f.activate();
  const publicationId = f.publish(),
    link = f.link("friend");
  const unnamed = {
    path: "registrations/dataset.json",
    text: JSON.stringify({ formatVersion: 1 }),
  };
  pushFile(f.storage, "dataset", null, unnamed);
  await f.invoke(link, id(5), { name: "First" }, publicationId, "first");
  f.advance(120_000);
  await f.invoke(link, id(5), { name: "Still there" }, publicationId, "still-there");
  pushFile(f.storage, "dataset", unnamed, null);
  await f.invoke(link, id(5), { name: "Deleted" }, publicationId, "deleted");
  f.advance(120_000);
  await expect(
    f.invoke(link, id(5), { name: "Refused" }, publicationId, "refused"),
  ).rejects.toMatchObject(collectionMissing);
});

it("keeps an app working, on its own records only, when another Collection takes its moved Collection's old folder (#3186)", async () => {
  const f = await fixture();
  await f.activate();
  f.addHelper();
  pushFile(f.storage, "dataset", null, collectionFile());
  const other = { workspaceId: "w", datasetId: id(9) };
  const otherRevision = describeDatasetRevision({
    definition: { ...definition, datasetId: id(9), name: "Other" },
    revision: 1,
    schemaSql,
    operationSource,
  });
  const invokeOther = (
    auth: AppBackendAuth,
    operationId: string,
    input: Record<string, string>,
    key: string,
    appId?: string,
  ) =>
    f.host.invoke(auth, {
      ...other,
      revision: 1,
      revisionSha256: otherRevision.revisionSha256,
      operationId,
      input,
      idempotencyKey: key,
      ...(appId ? { access: { kind: "app" as const, appId } } : {}),
    });
  await f.host.activate(owner, {
    ...other,
    revision: otherRevision,
    schemaSql,
    operationSource,
    capacityBytes: 1024 * 1024,
  });
  await invokeOther(owner, id(5), { name: "Other record" }, "other");
  const publicationId = f.publish([id(5), id(6)]),
    link = f.link("friend");
  f.host.setDataGrant(owner, {
    ...scope,
    grantId: "helper-grant",
    grant: {
      operationIds: [id(6)],
      discover: true,
      revision: 1,
      revisionSha256: revision.revisionSha256,
    },
  });
  pushFile(
    f.storage,
    "dataset",
    collectionFile(),
    collectionFile("archive/registrations/dataset.json"),
  );
  pushFile(f.storage, "other", null, {
    path: "registrations/dataset.json",
    text: JSON.stringify({ datasetId: id(9) }),
  });
  await f.invoke(link, id(5), { name: "Moved" }, publicationId, "moved");
  f.advance(120_000);
  await f.invoke(link, id(5), { name: "Still moved" }, publicationId, "still-moved");
  const names = (result: unknown) => (result as { name: string }[]).map((row) => row.name).sort();
  expect(names((await f.invoke(helper, id(6), {}, publicationId, "read")).result)).toEqual([
    "Moved",
    "Still moved",
  ]);
  await expect(
    invokeOther(link, id(5), { name: "Leaked" }, "leaked", publicationId),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(invokeOther(helper, id(6), {}, "leaked-read", publicationId)).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(names((await invokeOther(owner, id(6), {}, "other-read")).result)).toEqual([
    "Other record",
  ]);
  pushFile(f.storage, "dataset", collectionFile("archive/registrations/dataset.json"), {
    path: "archive/registrations/dataset.json",
    text: JSON.stringify({ datasetId: id(9) }),
  });
  await f.invoke(link, id(5), { name: "Renamed" }, publicationId, "renamed");
  f.advance(120_000);
  await expect(
    f.invoke(link, id(5), { name: "Refused" }, publicationId, "refused"),
  ).rejects.toMatchObject(collectionMissing);
  await expect(f.invoke(helper, id(6), {}, publicationId, "read-refused")).rejects.toMatchObject(
    collectionMissing,
  );
  expect(names((await f.invoke(owner, id(6))).result)).toEqual(["Moved", "Renamed", "Still moved"]);
});

const memberSource = operationSource.replace(
  "read(ctx){return ctx.db.query('SELECT * FROM people ORDER BY id');}",
  "read(ctx){return ctx.caller.access;}",
);
const memberRevision = describeDatasetRevision({
  definition,
  revision: 1,
  schemaSql,
  operationSource: memberSource,
});
const ana: AppBackendAuth = {
  kind: "named",
  workspaceId: "w",
  userId: "ana",
  grantId: "ana-grant",
};
const anaGrant = (revisionSha256 = memberRevision.revisionSha256) => ({
  operationIds: [id(6), id(7)],
  discover: true,
  revision: 1,
  revisionSha256,
});

async function memberFixture(dataGrant = true) {
  const f = await fixture(false, {
    revision: memberRevision,
    schemaSql,
    operationSource: memberSource,
  });
  await f.activate();
  expect(
    f.storage.inviteWorkspaceMember({
      workspaceId: "w",
      actorUserId: "owner",
      workspaceName: "Team",
      email: "ana@dohc.test",
      recipientUserId: "ana",
      newMemberId: () => "ana-entry",
      newGrantId: () => "ana-grant",
      newShareId: () => "members",
      nowMs: 5,
    }),
  ).toMatchObject({ ok: true });
  const level = (level: "view" | "comment" | "edit") =>
    expect(
      f.storage.setWorkspaceMemberLevel({
        workspaceId: "w",
        actorUserId: "owner",
        level,
        workspaceName: undefined,
        newShareId: () => "unused",
        nowMs: 6,
      }),
    ).toEqual({ ok: true });
  level("edit");
  if (dataGrant) f.host.setDataGrant(owner, { ...scope, grantId: "ana-grant", grant: anaGrant() });
  const rule = (members: "view" | "edit" | null, folder = "registrations") => {
    const result = f.storage.changeFolderRule({
      workspaceId: "w",
      actorUserId: "owner",
      change: { kind: "create", folder, rule: { members, people: new Map() } },
      nowMs: 7,
    });
    if (!result.ok) throw new Error(result.reason);
    return result;
  };
  const admin = () =>
    expect(
      f.storage.setWorkspaceMemberRole({
        workspaceId: "w",
        actorUserId: "owner",
        memberId: "ana-entry",
        role: "admin",
      }),
    ).toEqual({ ok: true });
  let request = 0;
  const read = () => f.invoke(ana, id(6), {}, undefined, `read-${request++}`);
  const listed = (page?: { after?: string; limit?: number }) =>
    f.host.list(ana, { workspaceId: "w", ...page });
  return { ...f, level, rule, admin, read, listed };
}

const refused = { code: "not_authorized" };

it("hides a Collection in a folder a member can't reach, and every call on it", async () => {
  const f = await memberFixture();
  expect(f.listed().datasets.map((dataset) => dataset.datasetId)).toEqual([id(1)]);
  expect((await f.read()).result).toBe("edit");
  const fingerprint = f.host.offlineAccessFingerprint(ana);
  f.rule(null);
  expect(f.listed()).toEqual({ datasets: [], nextCursor: null });
  expect(() => f.host.describe(ana, scope)).toThrow(expect.objectContaining(refused));
  await expect(f.read()).rejects.toMatchObject(refused);
  await expect(
    f.invoke(ana, id(7), { id: "x", name: "y" }, undefined, "edit"),
  ).rejects.toMatchObject(refused);
  expect(() =>
    f.host.dataReadFile(ana, {
      ...scope,
      revision: 1,
      revisionSha256: memberRevision.revisionSha256,
      fileId: "file",
      fieldId: id(4),
      operationId: id(6),
      input: {},
    }),
  ).toThrow(expect.objectContaining(refused));
  expect(
    await f.storage.workReferenceDatasetAccess!({
      workspaceId: "w",
      userId: "ana",
      grantId: "ana-grant",
      target: { kind: "transactionalCollection", datasetId: id(1), tableId: id(2) },
    }),
  ).toBeNull();
  expect(f.host.offlineAccessFingerprint(ana)).not.toBe(fingerprint);
  f.admin();
  expect(f.listed().datasets.map((dataset) => dataset.datasetId)).toEqual([id(1)]);
  expect((await f.read()).result).toBe("edit");
});

it("caps a member's Collection level at their level on its folder, and never raises it", async () => {
  const f = await memberFixture();
  const { ruleId, revision } = f.rule("view");
  expect((await f.read()).result).toBe("view");
  f.level("comment");
  f.storage.changeFolderRule({
    workspaceId: "w",
    actorUserId: "owner",
    change: { kind: "change", ruleId, revision, rule: { members: "edit", people: new Map() } },
    nowMs: 9,
  });
  expect((await f.read()).result).toBe("comment");
});

it("ends a member's held Collection access when a folder rule lowers it", async () => {
  const f = await memberFixture();
  const check = await f.storage.workReferenceDatasetAccess!({
    workspaceId: "w",
    userId: "ana",
    grantId: "ana-grant",
    target: { kind: "transactionalCollection", datasetId: id(1), tableId: id(2) },
  });
  expect(check?.()).toBe(true);
  const fingerprint = f.host.offlineAccessFingerprint(ana);
  f.rule("view");
  expect(check!()).toBe(false);
  expect(f.host.offlineAccessFingerprint(ana)).not.toBe(fingerprint);
});

it("refuses a member's running write when a folder rule hides its Collection before it commits", async () => {
  const f = await memberFixture();
  const original = f.storage.memberReach.bind(f.storage);
  let hide = false;
  const dispatched = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    const stack = String(new Error().stack);
    Error.stackTraceLimit = limit;
    return stack.includes("supervisor.mjs");
  };
  vi.spyOn(f.storage, "memberReach").mockImplementation((...args) => {
    if (hide && dispatched()) {
      hide = false;
      setImmediate(() => f.rule(null));
    }
    return original(...args);
  });
  const edit = (key: string) => f.invoke(ana, id(7), { id: "x", name: "y" }, undefined, key);
  const { revision } = await edit("edit-0");
  hide = true;
  await expect(edit("edit-1")).rejects.toMatchObject(refused);
  expect(hide).toBe(false);
  f.admin();
  expect((await edit("edit-2")).revision).toBe(revision + 1);
});

it("still needs a data grant where a folder rule gives a member Edit", async () => {
  const f = await memberFixture(false);
  f.rule("edit");
  expect(f.listed().datasets).toEqual([]);
  expect(() => f.host.describe(ana, scope)).toThrow(expect.objectContaining(refused));
  await expect(f.read()).rejects.toMatchObject(refused);
});

it("keeps owner-only Collection actions from a member and an admin", async () => {
  const f = await memberFixture();
  f.rule("edit");
  for (const promote of [() => {}, f.admin]) {
    promote();
    expect(() => f.host.archiveDataset(ana, scope)).toThrow(expect.objectContaining(refused));
    expect(() =>
      f.host.setDataGrant(ana, { ...scope, grantId: "ana-grant", grant: anaGrant() }),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => f.host.lifecycle(ana, scope)).toThrow(expect.objectContaining(refused));
  }
  expect(f.host.lifecycle(owner, scope).archived).toBe(false);
});

it("pages a member's Collections past ones they can't reach, without naming them", async () => {
  const f = await memberFixture();
  for (const [datasetId, folder] of [
    [id(11), "hidden"],
    [id(12), "zeta"],
  ] as const) {
    const other = describeDatasetRevision({
      definition: {
        ...definition,
        datasetId,
        schemaPath: `${folder}/schema.sql`,
        operationsPath: `${folder}/operations.js`,
      },
      revision: 1,
      schemaSql,
      operationSource: memberSource,
    });
    await f.host.activate(owner, {
      workspaceId: "w",
      revision: other,
      schemaSql,
      operationSource: memberSource,
      capacityBytes: 1024 * 1024,
    });
    f.host.setDataGrant(owner, {
      workspaceId: "w",
      datasetId,
      grantId: "ana-grant",
      grant: anaGrant(other.revisionSha256),
    });
  }
  f.rule(null, "hidden");
  const first = f.listed({ limit: 1 });
  expect(first.datasets.map((dataset) => dataset.datasetId)).toEqual([id(1)]);
  expect(first.nextCursor).toBe(id(1));
  const second = f.listed({ after: first.nextCursor!, limit: 1 });
  expect(second.datasets.map((dataset) => dataset.datasetId)).toEqual([id(12)]);
  expect(second.nextCursor).toBeNull();
  expect(JSON.stringify([first, second])).not.toContain(id(11));
});

it("hides a Collection from a member once it moves into a folder they can't reach", async () => {
  const f = await memberFixture();
  pushFile(f.storage, "dataset", null, collectionFile());
  f.rule(null, "team");
  expect((await f.read()).result).toBe("edit");
  pushFile(
    f.storage,
    "dataset",
    collectionFile(),
    collectionFile("team/registrations/dataset.json"),
  );
  expect(f.listed().datasets).toEqual([]);
  await expect(f.read()).rejects.toMatchObject(refused);
});
