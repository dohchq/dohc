import { createDatasetAppRoutes, createDatasetRoutes } from "./datasetRoutes";
import { createMemberAppRoutes, parseMemberAppUpload } from "./memberAppRoutes";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { type AppDatasetBinding, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { parseAppExternalDeclaration } from "@dohc/security-contract/app-external";
import { sealWorkspaceSecret, workspaceSecretKeyring } from "./workspaceSecretCrypto";
import { fixture as appFixture, limits, owner, pushFile } from "./datasetTestFixture";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { AppBackendAction } from "./appBackendRoutes";
import {
  parseAppPublicationCandidate,
  type AppPublicationCandidate,
} from "@dohc/security-contract/app-publication";
import {
  memberAppIdOf,
  setMemberAppSetting,
  withdrawMemberApp,
  writeMemberApp,
} from "./storage/memberApps";
import { disableAppPublication } from "./storage/publications";
import {
  fenceAccount,
  initializeAccountDeletion,
  purgeAccountRows,
} from "./storage/accountDeletion";
import type { AccountSession, AccountSessions } from "@dohc/workspace-auth/session";
import { createPhoneApps } from "./phoneApps";
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
  /** Publishes the fixture's app again, requesting `capabilities`, to the link or to the workspace's members. */
  function publishWith(
    capabilities: AppPublicationCandidate["capabilities"],
    audience: "link" | "workspace" | "owner" = "link",
    external?: AppPublicationCandidate["external"],
    expected?: string | null,
  ) {
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
      ...(external ? { external } : {}),
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
    const head = base.storage.db
      .prepare(
        "SELECT publication_id FROM sync_relay_app_publications WHERE audience='owner' AND active=1 AND owner_state IN ('pending','current') ORDER BY owner_state='pending' DESC LIMIT 1",
      )
      .get();
    const result = base.storage.publishAppPublication({
      workspaceId: "w",
      ownerUserId: "owner",
      ...(audience === "owner"
        ? {
            expectedCurrentPublicationId:
              expected !== undefined ? expected : head ? String(head.publication_id) : null,
          }
        : audience === "workspace"
          ? { shareId: "members" }
          : { shareId: "s", grantId: "g", generation: 1 }),
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

it("reads a share link's app manifest once per call and its warm rules never, however often the call checks them", async () => {
  const f = await fixture();
  await f.activate();
  const publicationId = f.publish(),
    link = f.link("friend");
  await f.invoke(link, id(5), { name: "first" }, publicationId, "first");
  const manifest = f.storage.db
    .prepare("SELECT manifest_sha256 FROM sync_relay_app_publications WHERE publication_id=?")
    .get(publicationId)!.manifest_sha256;
  const rules = f.storage.db
    .prepare("SELECT revision_json FROM dohc_dataset_catalog")
    .get()!.revision_json;
  const parse = JSON.parse;
  let ruleParses = 0;
  vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (text === rules && String(new Error().stack).includes("dataset-host")) ruleParses++;
    return parse(text, reviver);
  });
  const blobs = vi.spyOn(f.storage, "getBlob");
  await f.invoke({ ...link }, id(5), { name: "second" }, publicationId, "second");
  expect(blobs.mock.calls.filter(([, sha256]) => sha256 === manifest)).toHaveLength(1);
  expect(ruleParses).toBe(0);
});

it("refuses a share link's running submit once its link is paused, its app's manifest record changes, or its app is taken down", async () => {
  const f = await fixture();
  await f.activate();
  const publicationId = f.publish(),
    link = f.link("friend");
  await f.invoke(link, id(5), { name: "warm" }, publicationId, "warm");
  const original = f.storage.findLinkSessionByCapabilityHash.bind(f.storage);
  let change: (() => void) | undefined;
  const dispatched = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    const stack = String(new Error().stack);
    Error.stackTraceLimit = limit;
    return stack.includes("supervisor.mjs");
  };
  vi.spyOn(f.storage, "findLinkSessionByCapabilityHash").mockImplementation((...args) => {
    if (change && dispatched()) {
      setImmediate(change);
      change = undefined;
    }
    return original(...args);
  });
  const submit = async (name: string, next: () => void) => {
    change = next;
    await expect(f.invoke({ ...link }, id(5), { name }, publicationId, name)).rejects.toThrow();
    expect(change).toBeUndefined();
  };
  const pause = (pausedAtMs: number | null) =>
    f.storage.setShareLinkWritesPaused({
      shareId: "s",
      workspaceId: "w",
      actorUserId: "owner",
      pausedAtMs,
    });
  await submit("paused", () => pause(20));
  pause(null);
  const manifest = f.storage.db
    .prepare("SELECT manifest_sha256 FROM sync_relay_app_publications WHERE publication_id=?")
    .get(publicationId)!.manifest_sha256;
  const setManifest = (sha256: unknown) =>
    f.storage.db
      .prepare("UPDATE sync_relay_app_publications SET manifest_sha256=? WHERE publication_id=?")
      .run(sha256 as string, publicationId);
  const other = f.publishWith([
    resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: id(1),
        revision: 1,
        revisionSha256: revision.revisionSha256,
        operationIds: [id(5), id(6)],
      },
      revision,
    ),
  ]);
  const swapped = f.storage.db
    .prepare("SELECT manifest_sha256 FROM sync_relay_app_publications WHERE publication_id=?")
    .get(other)!.manifest_sha256;
  await submit("tampered", () => setManifest(swapped));
  setManifest(manifest);
  await f.invoke({ ...link }, id(5), { name: "restored" }, publicationId, "restored");
  await submit("taken-down", () =>
    disableAppPublication(f.storage, { publicationId, reason: "Abuse", nowMs: 30 }),
  );
  const names = (await f.invoke(owner, id(6))).result as Array<{ name: string }>;
  expect(names.map((row) => row.name).sort()).toEqual(["restored", "warm"]);
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

it("refuses a shared app's outside calls once its Collection is gone, as it refuses opening the app", async () => {
  const f = await fixture();
  await f.activate();
  const keyring = workspaceSecretKeyring({ linkKey: "dataset-host-test-key" })!;
  const secret = {
    workspaceId: "w",
    ownerUserId: "owner",
    name: "KEY",
    usage: "http-header" as const,
  };
  f.storage.upsertWorkspaceSecret({
    ...secret,
    mode: "create",
    allowedHosts: ["api.example.com"],
    keyId: keyring.activeId,
    seal: (generation) =>
      sealWorkspaceSecret({
        ...secret,
        keyring,
        keyId: keyring.activeId,
        allowedHosts: ["api.example.com"],
        generation,
        plaintext: "value",
      }),
    nowMs: 10,
  });
  const capability = resolveAppDatasetCapability(
    {
      kind: "dataset",
      datasetId: id(1),
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: [id(5)],
    },
    revision,
  );
  const external = parseAppExternalDeclaration({
    count: {
      method: "GET",
      url: "https://api.example.com/count",
      secret: { name: "KEY", header: "X-Key" },
      access: "viewers",
    },
  });
  const publicationId = f.publishWith([capability], "link", external);
  f.host.bindPublication(owner, { ...scope, publicationId });
  const link = f.link("friend");
  expect(f.host.externalPublication(link, publicationId).caller).toMatchObject({ kind: "link" });
  f.advance(120_000);
  expect(() => f.host.externalPublication(link, publicationId)).toThrow(
    expect.objectContaining(collectionMissing),
  );
});

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
  pushFile(f.storage, "dataset", null, collectionFile());
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
  const collection = async (datasetId: string, folder: string, ownerOnlyRead = false) => {
    const other = describeDatasetRevision({
      definition: {
        ...definition,
        datasetId,
        schemaPath: `${folder}/schema.sql`,
        operationsPath: `${folder}/operations.js`,
        operations: definition.operations.map((operation) =>
          ownerOnlyRead && operation.name === "read"
            ? { ...operation, access: "owner" as const }
            : operation,
        ),
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
    pushFile(f.storage, `dataset-${folder}`, null, {
      path: `${folder}/dataset.json`,
      text: JSON.stringify({ datasetId }),
    });
    return other;
  };
  const app = (revisions = [memberRevision], audience: "link" | "workspace" = "workspace") => {
    const publicationId = f.publishWith(
      revisions.map((value, index) =>
        resolveAppDatasetCapability(
          {
            kind: "dataset",
            ...(revisions.length > 1 ? { alias: `c${index}` } : {}),
            datasetId: value.datasetId,
            revision: 1,
            revisionSha256: value.revisionSha256,
            operationIds: [id(5), id(6), id(7)],
          },
          value,
        ),
      ),
      audience,
    );
    f.host.bindPublication(owner, { workspaceId: "w", publicationId });
    return publicationId;
  };
  return { ...f, level, rule, admin, read, listed, collection, app };
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

it("still runs a member's granted write in a folder they can only view", async () => {
  const f = await memberFixture();
  f.rule("view");
  const edited = await f.invoke(ana, id(7), { id: "x", name: "y" }, undefined, "edit");
  expect(edited.result).toBe(true);
  expect((await f.read()).result).toBe("view");
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
  expect(() =>
    f.host.setDataGrant(ana, { ...scope, grantId: "ana-grant", grant: anaGrant() }),
  ).toThrow(expect.objectContaining({ code: "not_found" }));
  for (const promote of [() => {}, f.admin]) {
    promote();
    expect(() => f.host.archiveDataset(ana, scope)).toThrow(expect.objectContaining(refused));
    expect(() => f.host.lifecycle(ana, scope)).toThrow(expect.objectContaining(refused));
  }
  expect(f.host.lifecycle(owner, scope).archived).toBe(false);
});

it("opens a workspace app to an active member, and never a link-only app", async () => {
  const f = await memberFixture();
  const shared = f.app(),
    linkOnly = f.app([memberRevision], "link");
  expect((await f.invoke(ana, id(6), {}, shared, "shared")).result).toBe("edit");
  await expect(f.invoke(ana, id(6), {}, linkOnly, "link-only")).rejects.toMatchObject({
    code: "not_found",
  });
  expect(f.host.servedPublication(ana, shared)?.capabilities).toHaveLength(1);
  expect(() => f.host.servedPublication(ana, linkOnly)).toThrow(
    expect.objectContaining({ code: "not_found" }),
  );
});

it("closes a workspace app when a folder rule hides one of its Collections or its source", async () => {
  const f = await memberFixture();
  const hidden = await f.collection(id(11), "hidden");
  f.host.setDataGrant(owner, {
    workspaceId: "w",
    datasetId: id(11),
    grantId: "ana-grant",
    grant: anaGrant(hidden.revisionSha256),
  });
  const shared = f.app([memberRevision, hidden]);
  const read = (key: string) => f.invoke(ana, id(6), {}, shared, key);
  expect((await read("both")).result).toBe("edit");
  const { ruleId, revision } = f.rule(null, "hidden");
  await expect(read("one-hidden")).rejects.toMatchObject({ code: "not_found" });
  expect(() => f.host.servedPublication(ana, shared)).toThrow(
    expect.objectContaining({ code: "not_found" }),
  );
  f.storage.changeFolderRule({
    workspaceId: "w",
    actorUserId: "owner",
    change: { kind: "change", ruleId, revision, rule: { members: "edit", people: new Map() } },
    nowMs: 9,
  });
  expect((await read("shown")).result).toBe("edit");
  f.rule(null, "app");
  await expect(read("source-hidden")).rejects.toMatchObject({ code: "not_found" });
});

it("lets only an Edit member run a write through a workspace app, and only one their grant or defaults hold", async () => {
  const f = await memberFixture();
  const shared = f.app();
  const submit = (key: string) => f.invoke(ana, id(5), { name: "Ana" }, shared, key);
  const edit = (key: string) => f.invoke(ana, id(7), { id: "x", name: "y" }, shared, key);
  for (const level of ["view", "comment"] as const) {
    f.level(level);
    await expect(submit(`${level}-submit`)).rejects.toMatchObject(refused);
    await expect(edit(`${level}-edit`)).rejects.toMatchObject(refused);
    expect((await f.invoke(ana, id(6), {}, shared, `${level}-read`)).result).toBe(level);
  }
  f.level("edit");
  await expect(submit("ungranted-submit")).rejects.toMatchObject(refused);
  expect((await edit("edit-edit")).result).toBe(true);
  f.host.setWorkspaceDefaults(owner, {
    ...scope,
    defaults: {
      view: [],
      comment: [],
      edit: [id(5)],
      revision: 1,
      revisionSha256: memberRevision.revisionSha256,
    },
  });
  expect((await submit("edit-submit")).result).toEqual({ accepted: true });
});

it("refuses a member's running write through a workspace app when a default or folder rule lowers it before it commits", async () => {
  const f = await memberFixture(false);
  const defaults = (edit: string[]) =>
    f.host.setWorkspaceDefaults(owner, {
      ...scope,
      defaults: {
        view: [],
        comment: [],
        edit,
        revision: 1,
        revisionSha256: memberRevision.revisionSha256,
      },
    });
  defaults([id(7)]);
  const shared = f.app();
  const original = f.storage.memberReach.bind(f.storage);
  let lower: (() => unknown) | null = null;
  const dispatched = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    const stack = String(new Error().stack);
    Error.stackTraceLimit = limit;
    return stack.includes("supervisor.mjs");
  };
  vi.spyOn(f.storage, "memberReach").mockImplementation((...args) => {
    if (lower && dispatched()) {
      const run = lower;
      lower = null;
      setImmediate(run);
    }
    return original(...args);
  });
  const edit = (key: string) => f.invoke(ana, id(7), { id: "x", name: "y" }, shared, key);
  const { revision } = await edit("edit-0");
  lower = () => defaults([]);
  await expect(edit("edit-1")).rejects.toMatchObject(refused);
  expect(lower).toBeNull();
  defaults([id(7)]);
  expect((await edit("edit-2")).revision).toBe(revision + 1);
  lower = () => f.rule("view");
  await expect(edit("edit-3")).rejects.toMatchObject(refused);
  expect(lower).toBeNull();
});

it("lets an admin set Collection defaults and grant a member existing actions, but never grant owner-only actions", async () => {
  const f = await memberFixture(false);
  expect(
    f.storage.inviteWorkspaceMember({
      workspaceId: "w",
      actorUserId: "owner",
      workspaceName: "Team",
      email: "ben@dohc.test",
      recipientUserId: "ben",
      newMemberId: () => "ben-entry",
      newGrantId: () => "ben-grant",
      newShareId: () => "members",
      nowMs: 8,
    }),
  ).toMatchObject({ ok: true });
  const ben: AppBackendAuth = {
    kind: "named",
    workspaceId: "w",
    userId: "ben",
    grantId: "ben-grant",
  };
  f.admin();
  const ledger = await f.collection(id(21), "ledger", true);
  const grant = (datasetId: string, revisionSha256: string, operationIds: string[]) =>
    f.host.setDataGrant(ana, {
      workspaceId: "w",
      datasetId,
      grantId: "ben-grant",
      grant: { operationIds, discover: true, revision: 1, revisionSha256 },
    });
  const defaults = (datasetId: string, revisionSha256: string, view: string[]) =>
    f.host.setWorkspaceDefaults(ana, {
      workspaceId: "w",
      datasetId,
      defaults: { view, comment: [], edit: [], revision: 1, revisionSha256 },
    });
  await expect(f.invoke(ben, id(6), {}, undefined, "before")).rejects.toMatchObject(refused);
  grant(id(1), memberRevision.revisionSha256, [id(6)]);
  expect((await f.invoke(ben, id(6), {}, undefined, "granted")).result).toBe("edit");
  expect(() => grant(id(21), ledger.revisionSha256, [id(6)])).toThrow(
    "Owner-only Collection actions cannot be granted to anyone else.",
  );
  expect(() => defaults(id(21), ledger.revisionSha256, [id(6)])).toThrow(
    expect.objectContaining({ code: "bad_request" }),
  );
  expect(() => defaults(id(1), memberRevision.revisionSha256, [id(7)])).toThrow(
    expect.objectContaining({ code: "bad_request" }),
  );
  expect(defaults(id(1), memberRevision.revisionSha256, [id(6)])).toEqual({ generation: 1 });
  expect(f.host.permissions(ana, scope).rules).toMatchObject({
    revision: 1,
    revisionSha256: memberRevision.revisionSha256,
    actions: expect.arrayContaining([{ operationId: id(6), name: "read", readOnly: true }]),
  });
  expect(
    f.host.permissions(ana, { workspaceId: "w", datasetId: id(21) }).rules.actions,
  ).not.toContainEqual(expect.objectContaining({ operationId: id(6) }));
});

async function adminRulesFixture(dataGrant = true) {
  const f = await memberFixture(dataGrant);
  const renamed = (n: number) => {
    const next = structuredClone(definition);
    next.tables[0]!.fields[1]!.name = `Name ${n}`;
    next.schemaPath = `registrations/revision-${n}/schema.sql`;
    next.operationsPath = `registrations/revision-${n}/operations.js`;
    return describeDatasetRevision({
      definition: next,
      revision: n,
      schemaSql,
      operationSource: memberSource,
    });
  };
  const prepare = (auth: AppBackendAuth, n: number) =>
    f.host.prepareMigration(auth, {
      workspaceId: "w",
      revision: renamed(n),
      schemaSql,
      operationSource: memberSource,
      expected: f.host.approvedArtifacts(owner, scope).cursor,
      migrationSql: "SELECT 1;",
    });
  const approve = (
    auth: AppBackendAuth,
    preview: { candidateId: string; checkpointSha256: string },
  ) =>
    f.host.approveMigration(auth, {
      ...scope,
      candidateId: preview.candidateId,
      checkpointSha256: preview.checkpointSha256,
    });
  const demote = () =>
    expect(
      f.storage.setWorkspaceMemberRole({
        workspaceId: "w",
        actorUserId: "owner",
        memberId: "ana-entry",
        role: "member",
      }),
    ).toEqual({ ok: true });
  return { ...f, renamed, prepare, approve, demote };
}

it("lets an active Admin read every Collection without a grant until their next request after they're demoted, and never write", async () => {
  const f = await adminRulesFixture(false);
  expect(f.listed().datasets).toEqual([]);
  await expect(f.read()).rejects.toMatchObject(refused);
  f.admin();
  expect(f.listed().datasets.map((dataset) => dataset.datasetId)).toEqual([id(1)]);
  expect(f.host.describe(ana, scope).operations.map((operation) => operation.operationId)).toEqual([
    id(6),
  ]);
  expect((await f.read()).result).toBe("edit");
  await expect(
    f.invoke(ana, id(7), { id: "x", name: "y" }, undefined, "admin-edit"),
  ).rejects.toMatchObject(refused);
  await expect(f.invoke(ana, id(6), {}, f.app(), "admin-app-read")).rejects.toMatchObject(refused);
  f.storage.tx(() =>
    f.storage.db
      .prepare(
        `INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES('ana-edit','s','user','ana',NULL,'edit',1,'active',1,NULL,NULL)`,
      )
      .run(),
  );
  await expect(
    f.invoke({ ...ana, grantId: "ana-edit" }, id(6), {}, undefined, "edit-share-read"),
  ).rejects.toMatchObject(refused);
  const fingerprint = f.host.offlineAccessFingerprint(ana);
  f.demote();
  expect(f.host.offlineAccessFingerprint(ana)).not.toBe(fingerprint);
  expect(f.listed().datasets).toEqual([]);
  await expect(f.read()).rejects.toMatchObject(refused);
});

it("tells someone who isn't an Admin that the server refused their rules request, and an Admin that the Owner's computer keeps the Collection", async () => {
  const f = await adminRulesFixture();
  const route = createDatasetRoutes(f.host, f.storage, { nowMs: () => 10 });
  const approval = (datasetId: string, auth = ana) =>
    route(
      new Request("https://relay.test/approval"),
      { route: "dataset", workspaceId: "w", datasetId, action: "approval" },
      auth as Extract<AppBackendAuth, { kind: "named" }>,
    ).then(
      (response) => response.status,
      (error: { code: string }) => error.code,
    );
  expect(await approval(id(1))).toBe("members_forbidden");
  expect(await approval(id(40))).toBe("members_forbidden");
  f.admin();
  expect(await approval(id(1))).toBe(200);
  expect(await approval(id(40))).toBe("dataset_kept_by_owner");
  const elsewhere = { ...ana, grantId: "another-grant" };
  const named = (auth: object) => auth as Extract<AppBackendAuth, { kind: "named" }>;
  expect(f.host.memberAdmin(named(ana), "w")).toBe(true);
  expect(f.host.memberAdmin(named({ ...ana, grantId: undefined }), "w")).toBe(true);
  expect(await approval(id(40), { ...ana, grantId: undefined })).toBe("dataset_kept_by_owner");
  expect(f.host.memberAdmin(named({ ...ana, launch: {} }), "w")).toBe(false);
  expect(f.host.memberAdmin(named(elsewhere), "w")).toBe(false);
  expect(await approval(id(1), elsewhere)).toBe("not_found");
  expect(await approval(id(40), elsewhere)).toBe("not_found");
  f.demote();
  expect(await approval(id(40))).toBe("members_forbidden");
});

it("lets an Admin read back a Collection whose reads their change left Owner-only, find one with only writes and bulk reads, and still never write", async () => {
  const f = await adminRulesFixture(false);
  f.admin();
  const revision = describeDatasetRevision({
    definition: {
      ...definition,
      operations: definition.operations.map((operation) =>
        operation.operationId === id(6) ? { ...operation, access: "owner" as const } : operation,
      ),
    },
    revision: 2,
    schemaSql,
    operationSource: memberSource,
  });
  await f.approve(
    ana,
    await f.host.prepareMigration(ana, {
      workspaceId: "w",
      revision,
      schemaSql,
      operationSource: memberSource,
      expected: f.host.approvedArtifacts(owner, scope).cursor,
      migrationSql: "SELECT 1;",
    }),
  );
  const run = (operationId: string, input = {}, idempotencyKey = "admin-read") =>
    f.host.invoke(ana, {
      ...scope,
      revision: 2,
      revisionSha256: revision.revisionSha256,
      operationId,
      input,
      idempotencyKey,
    });
  expect((await run(id(6))).result).toBe("edit");
  await expect(run(id(7), { id: "x", name: "y" }, "admin-write")).rejects.toMatchObject(refused);
  const writes = describeDatasetRevision({
    definition: {
      ...definition,
      datasetId: id(41),
      schemaPath: "signups/schema.sql",
      operationsPath: "signups/operations.js",
      operations: definition.operations.map((operation) =>
        operation.readOnly
          ? { ...operation, access: "owner" as const, profile: "bulk" as const }
          : operation,
      ),
    },
    revision: 1,
    schemaSql,
    operationSource: memberSource,
  });
  await f.host.activate(owner, {
    workspaceId: "w",
    revision: writes,
    schemaSql,
    operationSource: memberSource,
    capacityBytes: 1024 * 1024,
  });
  pushFile(f.storage, "dataset-signups", null, {
    path: "signups/dataset.json",
    text: JSON.stringify({ datasetId: id(41) }),
  });
  expect(f.listed().datasets.map((dataset) => dataset.datasetId)).toContain(id(41));
  expect(f.host.describe(ana, { workspaceId: "w", datasetId: id(41) }).operations).toEqual([]);
  f.demote();
  await expect(run(id(6), {}, "demoted-read")).rejects.toMatchObject(refused);
  expect(f.listed().datasets).toEqual([]);
});

it("lets an Admin create a Collection and approve its rules as themselves, never a Member", async () => {
  const f = await adminRulesFixture();
  await expect(f.prepare(ana, 2)).rejects.toMatchObject(refused);
  expect(() => f.host.approvedArtifacts(ana, scope)).toThrow(expect.objectContaining(refused));
  f.admin();
  await f.approve(ana, await f.prepare(ana, 2));
  expect(f.host.approvedArtifacts(owner, scope).revision.revisionSha256).toBe(
    f.renamed(2).revisionSha256,
  );
  expect(f.host.approval(owner, scope)).toEqual({
    revisionSha256: f.renamed(2).revisionSha256,
    approvedBy: { role: "admin", name: null, former: false, approvedAtMs: expect.any(Number) },
    needsOwnerConfirmation: false,
  });
  const created = describeDatasetRevision({
    definition: {
      ...definition,
      datasetId: id(31),
      schemaPath: "crm/schema.sql",
      operationsPath: "crm/operations.js",
    },
    revision: 1,
    schemaSql,
    operationSource: memberSource,
  });
  await f.host.activate(ana, {
    workspaceId: "w",
    revision: created,
    schemaSql,
    operationSource: memberSource,
    capacityBytes: 1024 * 1024,
  });
  expect(f.host.approval(ana, { workspaceId: "w", datasetId: id(31) }).approvedBy).toMatchObject({
    role: "admin",
  });
  expect(() => f.host.archiveDataset(ana, scope)).toThrow(expect.objectContaining(refused));
  const agent: AppBackendAuth = { ...ana, agent: { depth: 1, agentId: "agent" } };
  expect(() => f.host.approvedArtifacts(agent, scope)).toThrow(
    expect.objectContaining({ code: "not_found" }),
  );
});

it("refuses an Admin's approval at its commit when they lose the role after it starts", async () => {
  const f = await adminRulesFixture();
  f.admin();
  const preview = await f.prepare(ana, 2);
  const checks = vi.spyOn(f.storage, "getShareGrant");
  const pending = f.approve(ana, preview);
  expect(checks).toHaveBeenCalled();
  f.demote();
  await expect(pending).rejects.toMatchObject(refused);
  expect(f.host.approvedArtifacts(owner, scope).revision.revisionSha256).toBe(
    memberRevision.revisionSha256,
  );
});

it("keeps a former Admin's approved rules running until the Owner confirms them, without migrating again", async () => {
  const f = await adminRulesFixture();
  f.admin();
  await f.approve(ana, await f.prepare(ana, 2));
  f.demote();
  expect(f.host.approval(owner, scope)).toMatchObject({
    approvedBy: { role: "admin", former: true },
    needsOwnerConfirmation: true,
  });
  expect(() => f.host.approval(ana, scope)).toThrow(expect.objectContaining(refused));
  f.admin();
  expect(() =>
    f.host.confirmApproval(ana, { ...scope, revisionSha256: f.renamed(2).revisionSha256 }),
  ).toThrow(expect.objectContaining(refused));
  f.demote();
  expect(() =>
    f.host.confirmApproval(owner, { ...scope, revisionSha256: memberRevision.revisionSha256 }),
  ).toThrow(expect.objectContaining({ code: "conflict" }));
  const history = f.host.history(owner, scope);
  const route = createDatasetRoutes(f.host, f.storage, { nowMs: () => 10 });
  const call = async (action: "approval" | "confirm-approval", init?: RequestInit) =>
    (
      await route(
        new Request(`https://relay.test/${action}`, init),
        { route: "dataset", ...scope, action },
        { kind: "named", workspaceId: "w", userId: "owner" },
      )
    ).json();
  expect(
    await call("confirm-approval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisionSha256: f.renamed(2).revisionSha256 }),
    }),
  ).toMatchObject({ needsOwnerConfirmation: false });
  expect(await call("approval")).toEqual({
    revisionSha256: f.renamed(2).revisionSha256,
    approvedBy: { role: "owner", name: null, former: false, approvedAtMs: expect.any(Number) },
    needsOwnerConfirmation: false,
  });
  expect(f.host.history(owner, scope)).toEqual(history);
  expect(f.host.approvedArtifacts(owner, scope).revision.revision).toBe(2);
});

it("keeps an approval's role when its Admin's account is deleted, so the Owner still confirms it", async () => {
  const f = await adminRulesFixture();
  f.admin();
  await f.approve(ana, await f.prepare(ana, 2));
  const key = "admin-approval-deletion-key-at-least-32-bytes";
  initializeAccountDeletion(f.storage, key);
  const fenced = fenceAccount(f.storage, key, "ana", "ana@dohc.test");
  purgeAccountRows(f.storage, "ana", "ana@dohc.test", fenced.manifest!);
  expect(
    f.storage.db
      .prepare("SELECT user_id,role FROM dohc_dataset_approvers WHERE approved_revision_hash=?")
      .get(f.renamed(2).revisionSha256),
  ).toEqual({ user_id: null, role: "admin" });
  expect(f.host.approval(owner, scope)).toMatchObject({
    approvedBy: { role: "admin", name: null, former: true },
    needsOwnerConfirmation: true,
  });
});

it("lists a Collection a member reaches only by its defaults, and changes their offline copy's access when the defaults change or the Collection is archived", async () => {
  const f = await memberFixture(false);
  expect(f.listed().datasets).toEqual([]);
  const defaults = (view: string[]) =>
    f.host.setWorkspaceDefaults(owner, {
      ...scope,
      defaults: {
        view,
        comment: [],
        edit: [],
        revision: 1,
        revisionSha256: memberRevision.revisionSha256,
      },
    });
  defaults([id(6)]);
  expect(f.listed().datasets.map((dataset) => dataset.datasetId)).toEqual([id(1)]);
  const fingerprint = f.host.offlineAccessFingerprint(ana);
  defaults([]);
  expect(f.listed().datasets).toEqual([]);
  expect(f.host.offlineAccessFingerprint(ana)).not.toBe(fingerprint);
  defaults([id(6)]);
  const restored = f.host.offlineAccessFingerprint(ana);
  f.host.archiveDataset(owner, scope);
  expect(f.host.offlineAccessFingerprint(ana)).not.toBe(restored);
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
    pushFile(f.storage, `dataset-${folder}`, null, {
      path: `${folder}/dataset.json`,
      text: JSON.stringify({ datasetId }),
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

it("hides a Collection from a member once its dataset.json is deleted and written again elsewhere", async () => {
  const f = await memberFixture();
  f.rule(null, "team");
  pushFile(f.storage, "dataset", collectionFile(), null);
  pushFile(f.storage, "copied", null, collectionFile("team/registrations/dataset.json"));
  expect(f.listed().datasets).toEqual([]);
  await expect(f.read()).rejects.toMatchObject(refused);
});

it("keeps a Collection open to a member when its dataset.json names no Collection", async () => {
  const f = await memberFixture();
  pushFile(f.storage, "dataset", collectionFile(), {
    path: "registrations/dataset.json",
    text: "{}",
  });
  expect((await f.read()).result).toBe("edit");
});

const memberAppSource = Buffer.from("export default 'tracker';\n");
const memberAppBundle = Buffer.from("document.body.textContent='tracker'");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ben: AppBackendAuth = { kind: "named", workspaceId: "w", userId: "ben" };

async function memberAppFixture() {
  const f = await memberFixture();
  expect(
    f.storage.inviteWorkspaceMember({
      workspaceId: "w",
      actorUserId: "owner",
      workspaceName: "Team",
      email: "ben@dohc.test",
      recipientUserId: "ben",
      newMemberId: () => "ben-entry",
      newGrantId: () => "ben-grant",
      newShareId: () => "unused",
      nowMs: 5,
    }),
  ).toMatchObject({ ok: true });
  const grant = (grantId: string, operationIds: string[]) =>
    f.host.setDataGrant(owner, { ...scope, grantId, grant: { ...anaGrant(), operationIds } });
  grant("ben-grant", [id(6), id(7)]);
  const share = (membersCanShare: boolean) =>
    setMemberAppSetting(f.storage, { workspaceId: "w", actorUserId: "owner", membersCanShare });
  share(true);
  const base = f.storage.readAppPublication({
    ...scope,
    publicationId: f.publicationId,
    ownerUserId: "owner",
    limits,
  }).candidate;
  const candidate = (
    operationIds = [id(5), id(6), id(7)],
    revisions = [memberRevision],
    extra?: string,
  ) => {
    const digest = (domain: string, value: unknown) => sha(JSON.stringify([domain, value]));
    const inputs = ["app/index.ts", ...(extra ? [extra] : [])].map((path) => ({
      path,
      sha256: sha(memberAppSource),
      byteLength: memberAppSource.byteLength,
    }));
    const files = [
      {
        path: "bundle.js",
        sha256: sha(memberAppBundle),
        byteLength: memberAppBundle.byteLength,
        contentType: "text/javascript; charset=utf-8",
      },
    ];
    const sourceDigest = digest("dohc-app-source-v2", {
      entry: base.entryPath,
      files: inputs,
      packages: [],
    });
    const dependencyLockDigest = digest("dohc-app-dependencies-v1", inputs);
    const bundleDigest = digest("dohc-app-bundle-v1", files);
    return parseAppPublicationCandidate(
      {
        ...base,
        inputs,
        dependencies: inputs.map((input) => input.path),
        files,
        sourceDigest,
        dependencyLockDigest,
        bundleDigest,
        buildDigest: digest("dohc-app-build-v1", {
          sourceDigest,
          dependencyLockDigest,
          compiler: base.compilerIdentity,
          bundleDigest,
        }),
        capabilities: revisions.map((value, index) =>
          resolveAppDatasetCapability(
            {
              kind: "dataset",
              ...(revisions.length > 1 ? { alias: `c${index}` } : {}),
              datasetId: value.datasetId,
              revision: 1,
              revisionSha256: value.revisionSha256,
              operationIds,
            },
            value,
          ),
        ),
      },
      limits,
    );
  };
  const blobs = new Map([
    [sha(memberAppSource), memberAppSource],
    [sha(memberAppBundle), memberAppBundle],
  ]);
  const publish = (
    operationIds?: string[],
    auth: AppBackendAuth = ana,
    revisions?: Parameters<typeof candidate>[1],
  ) =>
    f.host.publishMemberApp(auth, {
      workspaceId: "w",
      slug: "tracker",
      candidate: candidate(operationIds, revisions),
      blobs,
      agent: null,
    }).publicationId;
  const review = (auth: AppBackendAuth, publicationId: string) =>
    f.host.servedPublication(auth, publicationId, true)!.member!;
  const allow = (auth: AppBackendAuth, publicationId: string) =>
    f.host.consentMemberApp(
      { ...auth, person: true } as AppBackendAuth,
      publicationId,
      review(auth, publicationId).digest,
    );
  return { ...f, grant, share, candidate, blobs, publish, review, allow };
}

const reviewRequired = { code: "member_app_review_required", status: 409 };
const reviewChanged = { code: "member_app_review_changed", status: 409 };

it("shares a Member app only while members may, never as the owner, and runs it within both the author's and the viewer's reach", async () => {
  const f = await memberAppFixture();
  f.share(false);
  expect(() => f.publish()).toThrow(expect.objectContaining({ code: "members_forbidden" }));
  f.share(true);
  expect(() => f.publish(undefined, owner)).toThrow(
    expect.objectContaining({ code: "members_forbidden" }),
  );
  const app = f.publish();
  await expect(f.invoke(ben, id(6), {}, app, "unreviewed")).rejects.toMatchObject(reviewRequired);
  expect(f.review(ben, app)).toMatchObject({
    consent: "none",
    scope: [{ datasetId: id(1), operationIds: [id(6), id(7)].sort(), access: "edit" }],
  });

  expect(f.review(owner, app).scope[0]!.operationIds).toEqual([id(6), id(7)].sort());
  f.allow(owner, app);
  await expect(f.invoke(owner, id(5), { name: "Owner" }, app, "escalate")).rejects.toMatchObject(
    refused,
  );
  expect((await f.invoke(owner, id(6), {}, app, "owner-read")).result).toBe("edit");

  f.grant("ben-grant", [id(6)]);
  f.allow(ben, app);
  expect((await f.invoke(ben, id(6), {}, app, "ben-read")).result).toBe("edit");
  await expect(f.invoke(ben, id(7), { id: "x", name: "y" }, app, "ben-edit")).rejects.toMatchObject(
    refused,
  );
  expect((await f.invoke(ana, id(6), {}, app, "author-read")).result).toBe("edit");
});

it("refuses a Member app's running write, and every later call, once its author loses reach", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  f.allow(ben, app);
  const original = f.storage.memberReach.bind(f.storage);
  let lower: (() => unknown) | null = null;
  const dispatched = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    const stack = String(new Error().stack);
    Error.stackTraceLimit = limit;
    return stack.includes("supervisor.mjs");
  };
  vi.spyOn(f.storage, "memberReach").mockImplementation((...args) => {
    if (lower && dispatched()) {
      const run = lower;
      lower = null;
      setImmediate(run);
    }
    return original(...args);
  });
  const edit = (key: string) => f.invoke(ben, id(7), { id: "x", name: "y" }, app, key);
  const { revision } = await edit("edit-0");
  lower = () => f.grant("ana-grant", [id(6)]);
  await expect(edit("edit-1")).rejects.toMatchObject(refused);
  expect(lower).toBeNull();
  await expect(edit("edit-2")).rejects.toMatchObject(refused);
  expect((await f.invoke(ben, id(6), {}, app, "read")).result).toBe("edit");
  f.allow(ben, app);
  f.grant("ana-grant", [id(6), id(7)]);
  await expect(edit("widened")).rejects.toMatchObject(reviewChanged);
  f.allow(ben, app);
  expect((await edit("edit-3")).revision).toBe(revision + 1);
  expect(
    f.storage.removeWorkspaceMember({
      workspaceId: "w",
      actorUserId: "owner",
      memberId: "ana-entry",
      nowMs: 20,
    }),
  ).toEqual({ ok: true });
  await expect(f.invoke(ben, id(6), {}, app, "author-gone")).rejects.toMatchObject({
    code: "not_found",
  });
});

it("asks a viewer again for a new version, and only a person in a browser can allow it", async () => {
  const f = await memberAppFixture();
  const first = f.publish([id(6)]);
  f.allow(ben, first);
  expect((await f.invoke(ben, id(6), {}, first, "first")).result).toBe("edit");
  const second = f.publish([id(6), id(7)]);
  expect(f.publish([id(6), id(7)])).toBe(second);
  expect(() => f.host.servedPublication(ben, first, true)).toThrow(
    expect.objectContaining({ code: "not_found" }),
  );
  await expect(f.invoke(ben, id(6), {}, second, "second")).rejects.toMatchObject(reviewChanged);
  const { digest } = f.review(ben, second);
  const person = { ...ben, person: true } as AppBackendAuth;
  for (const desktop of [ben, { ...ben, agent: { depth: 1, agentId: "agent" } }])
    expect(() => f.host.consentMemberApp(desktop, second, digest)).toThrow(
      expect.objectContaining({ code: "member_app_person_only", status: 403 }),
    );
  expect(() => f.host.consentMemberApp(person, second, "0".repeat(64))).toThrow(
    expect.objectContaining(reviewChanged),
  );
  f.host.consentMemberApp(person, second, digest);
  expect((await f.invoke(ben, id(6), {}, second, "allowed")).result).toBe("edit");
  expect(f.host.memberApps(ben, { workspaceId: "w", cursor: "m" }).apps).toMatchObject([
    {
      kind: "member",
      publicationId: second,
      publisherUserId: "ana",
      slug: "tracker",
      name: "tracker",
      consent: "current",
      canWithdraw: false,
    },
  ]);
});

it("keeps a Member app's bindings when its publish is retried, and hides it once its Collection is archived", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  const bindings = () =>
    f.storage.db.prepare("SELECT token FROM dohc_dataset_bindings WHERE app_id=?").all(app);
  const before = bindings();
  expect(before).toHaveLength(1);
  expect(f.publish()).toBe(app);
  expect(bindings()).toEqual(before);
  f.allow(ben, app);
  f.host.archiveDataset(owner, scope);
  expect(() => f.review(ben, app)).toThrow(expect.objectContaining({ code: "not_found" }));
  expect(f.host.memberApps(owner, { workspaceId: "w", cursor: "m" }).apps).toMatchObject([
    { publicationId: app, reachable: false },
  ]);
});

it("opens an author's own Member app without review, even one their agent published", async () => {
  const f = await memberAppFixture();
  const agent = { kind: "agent", label: "Helper", labelSource: "agent-declared" } as const;
  const { publicationId } = f.host.publishMemberApp(ana, {
    workspaceId: "w",
    slug: "tracker",
    candidate: f.candidate(),
    blobs: f.blobs,
    agent,
  });
  expect(f.review(ana, publicationId).consent).toBe("current");
  expect((await f.invoke(ana, id(6), {}, publicationId, "agent-made")).result).toBe("edit");
  await expect(f.invoke(ben, id(6), {}, publicationId, "viewer")).rejects.toMatchObject(
    reviewRequired,
  );
});

it("stops a member's Member apps when members may no longer share, but not an admin's", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  f.allow(ben, app);
  f.share(false);
  await expect(f.invoke(ben, id(6), {}, app, "off")).rejects.toMatchObject({ code: "not_found" });
  expect(f.host.memberApps(ben, { workspaceId: "w", cursor: "m" }).apps).toEqual([]);
  f.share(true);
  expect((await f.invoke(ben, id(6), {}, app, "on")).result).toBe("edit");
  f.admin();
  f.share(false);
  expect((await f.invoke(ben, id(6), {}, app, "admin")).result).toBe("edit");
  expect(() =>
    setMemberAppSetting(f.storage, { workspaceId: "w", actorUserId: "ben", membersCanShare: true }),
  ).toThrow(expect.objectContaining({ code: "members_forbidden" }));
});

it("refuses Member apps that read for share links or use owner-only actions, and never opens or binds one as an official app", async () => {
  const f = await memberAppFixture();
  const plain = f.candidate([id(6)]);
  const linkReads = {
    ...plain.capabilities[0]!,
    linkReads: [{ operationId: id(6), fieldIds: [id(3), id(4)] }],
  } as AppPublicationCandidate["capabilities"][number];
  expect(() =>
    f.host.publishMemberApp(ana, {
      workspaceId: "w",
      slug: "tracker",
      candidate: { ...plain, capabilities: [linkReads] },
      blobs: f.blobs,
      agent: null,
    }),
  ).toThrow(expect.objectContaining({ code: "bad_request" }));
  const ownerOnly = await f.collection(id(12), "private", true);
  expect(() => f.publish([id(6)], ana, [memberRevision, ownerOnly])).toThrow(
    expect.objectContaining({ code: "bad_request" }),
  );
  const app = f.publish();
  expect(() => f.host.servedPublication(f.link("visitor"), app)).toThrow();
  expect(() => f.host.bindPublication(owner, { workspaceId: "w", publicationId: app })).toThrow(
    expect.objectContaining({ code: "not_found" }),
  );
  expect(() =>
    f.host.unbindPublication(owner, { workspaceId: "w", datasetId: id(1), publicationId: app }),
  ).toThrow(expect.objectContaining({ code: "not_found" }));
});

it("takes a Member app down and holds its author's publishing", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  f.allow(ben, app);
  disableAppPublication(f.storage, { publicationId: app, reason: "Spam", nowMs: 20 });
  await expect(f.invoke(ben, id(6), {}, app, "taken-down")).rejects.toMatchObject({
    code: "not_found",
  });
  expect(() => f.publish()).toThrow(expect.objectContaining({ code: "conflict" }));
  expect(() => f.publish([id(6)])).toThrow(expect.objectContaining({ code: "conflict" }));
  expect(
    f.storage.db
      .prepare("SELECT active FROM sync_relay_app_publications WHERE publication_id=?")
      .get(app),
  ).toEqual({ active: 0 });
});

it("lets a Member app's author or the owner withdraw it, and no other member", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  expect(() =>
    withdrawMemberApp(f.storage, { workspaceId: "w", actorUserId: "ben", publicationId: app }),
  ).toThrow(expect.objectContaining({ code: "not_found" }));
  withdrawMemberApp(f.storage, { workspaceId: "w", actorUserId: "owner", publicationId: app });
  expect(
    f.storage.db
      .prepare("SELECT count(*) AS n FROM sync_relay_app_publications WHERE publication_id=?")
      .get(app),
  ).toEqual({ n: 0 });
});

it("ends an author's Member apps when their account is deleted", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  f.allow(ben, app);
  const key = "member-app-deletion-key-at-least-32-bytes";
  initializeAccountDeletion(f.storage, key);
  fenceAccount(f.storage, key, "ana", "ana@dohc.test");
  await expect(f.invoke(ben, id(6), {}, app, "deleted")).rejects.toMatchObject({
    code: "not_found",
  });
  expect(
    f.storage.db
      .prepare("SELECT active FROM sync_relay_app_publications WHERE publication_id=?")
      .get(app),
  ).toEqual({ active: 0 });
});

/** The workspace owner's phone, over the real dataset host: its app operations, and launches as share-web redeems them. */
function ownerPhone(f: Pick<Awaited<ReturnType<typeof memberFixture>>, "storage" | "host">) {
  const ended: string[] = [];
  let launches = 0;
  const phone = createPhoneApps({
    storage: f.storage,
    limits,
    sessions: { phoneSessionIsCurrent: async () => true } as unknown as AccountSessions,
    launchable: true,
    nowMs: () => 1e12,
    endShareWebLaunches: (hashes) => ended.push(...hashes),
    served: (auth, publicationId, reviewing) =>
      f.host.servedPublication(auth, publicationId, reviewing),
    authorName: async (userId) => `${userId} (${userId}@dohc.test)`,
  });
  const caller: AccountSession = {
    userId: "owner",
    sessionId: "phone-session",
    clientKind: "phone",
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  const run = async (operation: string, input: object) =>
    phone.run(
      caller,
      "w",
      operation,
      input,
      (await phone.names("w", operation, input)) ?? undefined,
    ) as Record<string, unknown>;
  const scope = (publicationId: string) => ({ workspaceId: "w", publicationId });
  // The phone's grant, share-web's redemption, and the launch's own authority on the backend.
  const open = async (publicationId: string): Promise<AppBackendAuth> => {
    const { grant } = (await run("appLaunch", { publicationId, authorityRevision: 1 })) as {
      grant: string;
    };
    const redeemed = await phone.redeem(
      new Request("https://relay.test/redeem", {
        method: "POST",
        body: JSON.stringify({ grant, launchHost: `launch-${launches++}.apps.test` }),
      }),
      scope(publicationId),
    );
    const { launchId } = (await redeemed.json()) as { launchId: string };
    const { userId, guard } = await phone.authorizeLaunch(launchId, scope(publicationId));
    return { kind: "named", workspaceId: "w", userId, launch: guard };
  };
  return { phone, run, open, ended };
}
const changed = { code: "conflict" };

it("lets the owner list, review, approve and open an official app over several Collections on a phone", async () => {
  const f = await memberFixture();
  const second = await f.collection(id(11), "second");
  const app = f.app([memberRevision, second]);
  const { run, open } = ownerPhone(f);
  expect((await run("apps", {})).apps).toContainEqual(
    expect.objectContaining({ publicationId: app, approved: false }),
  );
  const review = await run("appReview", { publicationId: app });
  expect(review).toMatchObject({ author: null, consent: null, revocable: false });
  expect(
    (review.capabilities as { datasetId: string; operations: unknown[] }[]).map((value) => [
      value.datasetId,
      value.operations.length,
    ]),
  ).toEqual([
    [id(1), 3],
    [id(11), 3],
  ]);
  await run("appApprove", { publicationId: app, authorityRevision: 1 });
  const launch = await open(app);
  const added = (datasetId: string) =>
    f.host.invoke(launch, {
      workspaceId: "w",
      datasetId,
      revision: 1,
      revisionSha256: (datasetId === id(1) ? memberRevision : second).revisionSha256,
      operationId: id(5),
      input: { name: "From the phone" },
      idempotencyKey: `phone-${datasetId}`,
      access: { kind: "app", appId: app },
    });
  expect((await added(id(1))).revision).toBeGreaterThan(0);
  expect((await added(id(11))).revision).toBeGreaterThan(0);
  expect(f.host.appEventRevisions(launch, app, 1).collections).toEqual([
    { dataset: "c0", datasetId: id(1), revision: f.host.datasetRevision("w", id(1)) },
    { dataset: "c1", datasetId: id(11), revision: f.host.datasetRevision("w", id(11)) },
  ]);
});

it("tells a member which of a workspace app's Collections changed only where they can read, and nothing once one is hidden", async () => {
  const f = await memberFixture();
  const second = await f.collection(id(11), "second");
  f.host.setDataGrant(owner, {
    workspaceId: "w",
    datasetId: id(11),
    grantId: "ana-grant",
    grant: { ...anaGrant(second.revisionSha256), operationIds: [id(7)] },
  });
  const shared = f.app([memberRevision, second]);
  const both = [
    { dataset: "c0", datasetId: id(1), revision: f.host.datasetRevision("w", id(1)) },
    { dataset: "c1", datasetId: id(11), revision: f.host.datasetRevision("w", id(11)) },
  ];
  expect(f.host.appEventRevisions(owner, shared, 1)).toEqual({
    workspaceId: "w",
    actor: "named:w:owner",
    collections: both,
  });
  expect(f.host.appEventRevisions(ana, shared, 1)).toEqual({
    workspaceId: "w",
    actor: "named:w:ana",
    collections: [both[0]],
  });
  expect(() => f.host.appEventRevisions(ana, shared, 2)).toThrow(
    expect.objectContaining({ code: "not_found" }),
  );
  f.rule(null, "second");
  expect(() => f.host.appEventRevisions(ana, shared, 1)).toThrow(
    expect.objectContaining({ code: "not_found" }),
  );
  expect(f.host.appEventRevisions(owner, shared, 1).collections).toEqual(both);
});

it("tells a Member app's viewer only about Collections both they and the author can read", async () => {
  const f = await memberAppFixture();
  const second = await f.collection(id(11), "second");
  for (const [grantId, operationIds] of [
    ["ana-grant", [id(6), id(7)]],
    ["ben-grant", [id(7)]],
  ] as const)
    f.host.setDataGrant(owner, {
      workspaceId: "w",
      datasetId: id(11),
      grantId,
      grant: { ...anaGrant(second.revisionSha256), operationIds: [...operationIds] },
    });
  const app = f.publish(undefined, ana, [memberRevision, second]);
  f.allow(ben, app);
  f.allow(owner, app);
  expect(f.host.appEventRevisions(ben, app, 1)).toMatchObject({
    actor: "named:w:ben",
    collections: [{ dataset: "c0", datasetId: id(1) }],
  });
  expect(f.host.appEventRevisions(owner, app, 1).collections).toHaveLength(2);
});

it("lets the owner review a Member app on a phone and open it only once allowed, within both reaches", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  const { run, open, ended } = ownerPhone(f);
  const listed = await run("memberApps", {});
  expect(listed).toEqual({
    memberApps: [
      {
        publicationId: app,
        authorityRevision: 1,
        appRoot: expect.any(String),
        sourceRevision: expect.any(String),
        approved: false,
        name: "tracker",
        author: { name: "ana (ana@dohc.test)" },
        consent: "none",
      },
    ],
    nextCursor: null,
  });
  expect((await run("apps", {})).apps).not.toContainEqual(
    expect.objectContaining({ publicationId: app }),
  );
  const review = await run("appReview", { publicationId: app });
  // Declared: add, read and edit. Ana holds only read and edit, so the owner reviews those.
  expect(review).toMatchObject({
    name: "tracker",
    author: { name: "ana (ana@dohc.test)" },
    consent: "none",
    revocable: false,
    approval: null,
    capabilities: [
      {
        datasetId: id(1),
        access: "edit",
        operationIds: [id(6), id(7)],
        operations: [{ name: "read" }, { name: "edit" }],
      },
    ],
    sources: [{ path: "app/index.ts", byteLength: memberAppSource.byteLength }],
  });
  expect(await run("appSource", { publicationId: app, path: "app/index.ts" })).toEqual({
    path: "app/index.ts",
    available: true,
    text: memberAppSource.toString(),
  });

  const launch = () => run("appLaunch", { publicationId: app, authorityRevision: 1 });
  await expect(launch()).rejects.toMatchObject(changed);
  const digest = review.scopeDigest as string;
  await expect(
    run("appApprove", { publicationId: app, authorityRevision: 1, scopeDigest: "0".repeat(64) }),
  ).rejects.toMatchObject(changed);
  await expect(
    run("appApprove", { publicationId: app, authorityRevision: 1 }),
  ).rejects.toMatchObject({ code: "bad_request" });
  await run("appApprove", { publicationId: app, authorityRevision: 1, scopeDigest: digest });
  expect(f.review(owner, app).consent).toBe("current");

  let auth = await open(app);
  const call = (operationId: string, key: string, input: object = {}) =>
    f.invoke(auth, operationId, input, app, key);
  // A named caller at Edit, as any viewer: never the owner, so the declared add Ana can't run is refused too.
  expect((await call(id(6), "read")).result).toBe("edit");
  await expect(call(id(5), "add", { name: "Owner" })).rejects.toMatchObject(refused);
  expect((await call(id(7), "edit", { id: "x", name: "y" })).revision).toBeGreaterThan(0);

  // Ana gains add: the app now reaches more than the owner allowed, so it waits for a new review.
  f.grant("ana-grant", [id(5), id(6), id(7)]);
  await expect(call(id(6), "widened")).rejects.toMatchObject(reviewChanged);
  await expect(launch()).rejects.toMatchObject(changed);
  expect(await run("memberApps", {})).toMatchObject({
    memberApps: [{ approved: false, consent: "changed" }],
  });
  const wider = (await run("appReview", { publicationId: app })) as {
    scopeDigest: string;
    revocable: boolean;
  };
  expect(wider.revocable).toBe(true);
  await run("appApprove", {
    publicationId: app,
    authorityRevision: 1,
    scopeDigest: wider.scopeDigest,
  });
  // The launch from before the review never resumes; a new one opens with what was allowed.
  expect(ended).toHaveLength(1);
  await expect(call(id(6), "stale-launch")).rejects.toMatchObject({ code: "not_found" });
  auth = await open(app);
  expect((await call(id(6), "allowed-again")).result).toBe("edit");

  // Ana loses edit: the launch keeps only what both still reach.
  f.grant("ana-grant", [id(6)]);
  await expect(call(id(7), "narrowed", { id: "x", name: "z" })).rejects.toMatchObject(refused);
  expect((await call(id(6), "narrowed-read")).result).toBe("edit");

  // Ana leaves: the app is out of reach, on the backend and on the phone.
  expect(
    f.storage.removeWorkspaceMember({
      workspaceId: "w",
      actorUserId: "owner",
      memberId: "ana-entry",
      nowMs: 20,
    }),
  ).toEqual({ ok: true });
  await expect(call(id(6), "author-gone")).rejects.toMatchObject({ code: "not_found" });
  await expect(launch()).rejects.toMatchObject({ code: "not_found" });
  expect((await run("memberApps", {})).memberApps).toEqual([]);
});

it("refuses a phone launch of a Member app once it is withdrawn, taken down, or sharing stops, and revokes everywhere", async () => {
  const f = await memberAppFixture();
  const { run, open, ended } = ownerPhone(f);
  const allow = async (publicationId: string) => {
    const { scopeDigest } = (await run("appReview", { publicationId })) as { scopeDigest: string };
    await run("appApprove", { publicationId, authorityRevision: 1, scopeDigest });
  };
  const app = f.publish();
  await allow(app);
  const auth = await open(app);
  const read = (key: string) => f.invoke(auth, id(6), {}, app, key);
  expect((await read("allowed")).result).toBe("edit");

  f.share(false);
  await expect(read("sharing-off")).rejects.toMatchObject({ code: "not_found" });
  f.share(true);
  expect((await read("sharing-on")).result).toBe("edit");

  // Revoke ends the phone's launch and the owner's allowing on every device.
  expect(await run("appRevoke", { publicationId: app })).toEqual({ revoked: true });
  expect(ended).toHaveLength(1);
  await expect(read("revoked")).rejects.toThrow();
  expect(f.review(owner, app).consent).toBe("none");
  await expect(f.invoke(owner, id(6), {}, app, "desktop")).rejects.toMatchObject(reviewRequired);

  await allow(app);
  const allowed = await open(app);
  // Ana gains add and the owner allows it in the browser: the phone's launch from before never resumes.
  f.grant("ana-grant", [id(5), id(6), id(7)]);
  f.allow(owner, app);
  await expect(f.invoke(allowed, id(6), {}, app, "allowed-in-browser")).rejects.toMatchObject({
    code: "not_found",
  });
  f.grant("ana-grant", [id(6), id(7)]);
  const reopened = await open(app);
  withdrawMemberApp(f.storage, { workspaceId: "w", actorUserId: "owner", publicationId: app });
  await expect(f.invoke(reopened, id(6), {}, app, "withdrawn")).rejects.toThrow();
  await expect(
    run("appLaunch", { publicationId: app, authorityRevision: 1 }),
  ).rejects.toMatchObject({ code: "not_found" });
  // Shared again, the same version is a new publication with the same ID: the old approval doesn't carry over.
  expect(f.publish()).toBe(app);
  expect((await run("memberApps", {})).memberApps).toMatchObject([
    { approved: false, consent: "none" },
  ]);
  // Allowed again in the browser, it still waits for the phone's own approval.
  f.allow(owner, app);
  expect((await run("memberApps", {})).memberApps).toMatchObject([
    { approved: false, consent: "current" },
  ]);
  await expect(
    run("appLaunch", { publicationId: app, authorityRevision: 1 }),
  ).rejects.toMatchObject(changed);
  await expect(f.invoke(reopened, id(6), {}, app, "republished")).rejects.toThrow();

  await allow(app);
  const last = await open(app);
  disableAppPublication(f.storage, { publicationId: app, reason: "Abuse", nowMs: 30 });
  await expect(f.invoke(last, id(6), {}, app, "taken-down")).rejects.toThrow();
  expect((await run("memberApps", {})).memberApps).toEqual([]);
});

function memberAppUpload(header: unknown, blobs: Array<Uint8Array>) {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.byteLength);
  return new Uint8Array(Buffer.concat([length, json, ...blobs]));
}

it("takes a Member app only with every file and source byte it names, each matching its digest", async () => {
  const f = await memberAppFixture();
  const candidate = f.candidate([id(6)]);
  const ordered = [...f.blobs.keys()].sort().map((key) => f.blobs.get(key)!);
  const header = { slug: "tracker", candidate };
  expect(parseMemberAppUpload(memberAppUpload(header, ordered), limits)).toMatchObject({
    slug: "tracker",
    agent: null,
  });
  const badRequest = expect.objectContaining({ code: "bad_request" });
  expect(() =>
    parseMemberAppUpload(
      memberAppUpload(
        header,
        ordered.filter((bytes) => bytes !== memberAppBundle),
      ),
      limits,
    ),
  ).toThrow(badRequest);
  const tampered = ordered.map((bytes) => Buffer.from(bytes).fill(120));
  expect(() => parseMemberAppUpload(memberAppUpload(header, tampered), limits)).toThrow(badRequest);
  expect(() =>
    parseMemberAppUpload(memberAppUpload(header, [...ordered, Buffer.from("x")]), limits),
  ).toThrow(badRequest);
  expect(() =>
    parseMemberAppUpload(memberAppUpload({ ...header, slug: "Tracker!" }, ordered), limits),
  ).toThrow(badRequest);
});

it("shows a Member app's reach and source for review, and its bundle only once allowed", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  const route = createDatasetAppRoutes(f.host, f.storage, {
    nowMs: () => 10,
    publications: true,
    shareSenderLabel: async () => "Ana (ana@dohc.test)",
  });
  const call = (
    action: AppBackendAction,
    init: RequestInit = {},
    sha256 = "",
    query = "",
    auth: AppBackendAuth = ben,
  ) =>
    route(
      new Request(`https://relay.test/${action}${query}`, init),
      {
        route: "app-backend",
        action,
        publicationId: app,
        workspaceId: "w",
        ...(sha256 && { sha256 }),
      },
      auth,
    );
  const summary = (await (await call("summary")).json()) as {
    review: { scopeDigest: string; consent: string };
  };
  expect(summary).toMatchObject({
    subjectName: "tracker",
    sharerName: "Ana (ana@dohc.test)",
    access: "member",
    review: {
      consent: "none",
      collections: [
        {
          name: "Registrations",
          access: "edit",
          operations: [
            { name: "read", readOnly: true },
            { name: "edit", readOnly: false },
          ],
        },
      ],
      source: [{ path: "app/index.ts" }],
    },
  });
  const blob = (bytes: Uint8Array) => call("blob", {}, sha(bytes), "?authorityRevision=1");
  expect(await (await blob(memberAppSource)).text()).toBe(memberAppSource.toString());
  await expect(blob(memberAppBundle)).rejects.toThrow();
  const descriptor = await call("descriptor");
  expect(descriptor.status).toBe(409);
  expect(await descriptor.json()).toMatchObject({ code: "member_app_review_required" });

  const consent = (auth: AppBackendAuth) =>
    call(
      "consent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeDigest: summary.review.scopeDigest }),
      },
      "",
      "",
      auth,
    );
  const desktop = await consent(ben);
  expect(desktop.status).toBe(403);
  expect(await desktop.json()).toMatchObject({ code: "member_app_person_only" });
  expect(await (await consent({ ...ben, person: true } as AppBackendAuth)).json()).toMatchObject({
    consent: "current",
  });
  expect(await (await blob(memberAppBundle)).text()).toBe(memberAppBundle.toString());
  await expect(
    call("activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorityRevision: 1 }),
    }),
  ).rejects.toThrow();
});

it("shares a Personal app whose folder name members can't reach, and refuses files outside its folder", async () => {
  const f = await memberAppFixture();
  f.rule(null, "app");
  const app = f.publish();
  f.allow(ben, app);
  expect((await f.invoke(ben, id(6), {}, app, "personal")).result).toBe("edit");
  const outside = f.candidate([id(6)], undefined, "notes/index.ts");
  expect(() =>
    f.host.publishMemberApp(ana, {
      workspaceId: "w",
      slug: "tracker",
      candidate: outside,
      blobs: f.blobs,
      agent: null,
    }),
  ).toThrow(expect.objectContaining({ code: "bad_request" }));
  const manifest = Buffer.from(JSON.stringify(outside)),
    manifestHash = sha(manifest),
    stored = memberAppIdOf("w", "ana", "notes", manifestHash);
  f.storage.tx(() =>
    writeMemberApp(f.storage, {
      workspaceId: "w",
      slug: "notes",
      candidate: outside,
      blobs: f.blobs,
      agent: null,
      publisherUserId: "ana",
      publicationId: stored,
      manifest,
      manifestHash,
      nowMs: 9,
    }),
  );
  for (const viewer of [ana, ben])
    expect(() => f.review(viewer, stored)).toThrow(expect.objectContaining({ code: "not_found" }));
});

it("lists the official apps a person can open, then Member apps, across pages the viewer can't see into", async () => {
  const f = await memberAppFixture();
  const official = f.app([await f.collection(id(12), "private")]);
  f.rule(null, "private");
  const app = f.publish();
  expect(f.host.memberApps(ben, { workspaceId: "w" })).toEqual({ apps: [], nextCursor: "m" });
  expect(f.host.memberApps(owner, { workspaceId: "w" })).toMatchObject({
    apps: [{ kind: "workspace", publicationId: official, reachable: true, canWithdraw: false }],
    nextCursor: "m",
  });
  expect(f.host.memberApps(ben, { workspaceId: "w", cursor: "m" })).toMatchObject({
    apps: [{ kind: "member", publicationId: app, consent: "none", canWithdraw: false }],
    nextCursor: null,
  });
  f.share(false);
  expect(f.host.memberApps(ana, { workspaceId: "w", cursor: "m" }).apps).toMatchObject([
    { publicationId: app, reachable: false, canWithdraw: true },
  ]);
});

it("lets every member read the sharing switch and only the Owner and Admins change it", async () => {
  const f = await memberAppFixture();
  const app = f.publish();
  const official = f.app([await f.collection(id(12), "team")]);
  const route = createMemberAppRoutes({
    host: f.host,
    storage: f.storage,
    limits,
    shareWebOrigin: "https://share.test",
    authorName: async (userId) => ({ ana: "Ana", owner: "Olive" })[userId] ?? null,
  });
  const call = (action: "apps" | "settings", userId: string, body?: unknown) =>
    route(
      new Request(`https://relay.test/${action}`, {
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
      { route: "member-apps", workspaceId: "w", action },
      userId,
    );
  expect(await (await call("settings", "ben")).json()).toEqual({ membersCanShare: true });
  await expect(call("settings", "stranger")).rejects.toMatchObject({ code: "not_found" });
  await expect(call("settings", "stranger", { membersCanShare: false })).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(call("settings", "ben", { membersCanShare: false })).rejects.toMatchObject({
    code: "members_forbidden",
  });
  expect(await (await call("settings", "owner", { membersCanShare: false })).json()).toEqual({
    membersCanShare: false,
  });
  f.share(true);
  f.allow(ben, app);
  expect(await (await call("apps", "ben")).json()).toMatchObject({
    apps: [{ kind: "workspace", publicationId: official, authorName: "Olive" }],
    nextCursor: "m",
  });
  const page = new URL("https://relay.test/apps?cursor=m");
  const listed = await route(
    new Request(page),
    { route: "member-apps", workspaceId: "w", action: "apps" },
    "ben",
  );
  expect(await listed.json()).toMatchObject({
    apps: [
      {
        publicationId: app,
        authorName: "Ana",
        consent: "current",
        url: `https://share.test/s/apps/w/${app}`,
      },
    ],
  });
});

it("opens an Owner Publication only on its owner's phone, makes a version current only once its Collections are bound, and keeps a running launch through a replacement", async () => {
  const f = await memberFixture();
  const version = (operationIds: string[]) =>
    f.publishWith(
      [
        resolveAppDatasetCapability(
          {
            kind: "dataset",
            datasetId: memberRevision.datasetId,
            revision: 1,
            revisionSha256: memberRevision.revisionSha256,
            operationIds,
          },
          memberRevision,
        ),
      ],
      "owner",
    );
  const desktop: AppBackendAuth = {
    kind: "named",
    workspaceId: "w",
    userId: "owner",
    device: "desktop",
  };
  const missing = expect.objectContaining({ code: "not_found" });
  const { run, open } = ownerPhone(f);
  const catalog = async () =>
    ((await run("apps", {})).apps as { publicationId: string }[]).map((row) => row.publicationId);
  const app = version([id(5), id(6), id(7)]);
  expect(await catalog()).not.toContain(app);
  await expect(run("appReview", { publicationId: app })).rejects.toMatchObject({
    code: "not_found",
  });
  expect(() => f.host.bindPublication(owner, { workspaceId: "w", publicationId: app })).toThrow(
    missing,
  );
  expect(f.host.bindPublication(desktop, { workspaceId: "w", publicationId: app })).toEqual([
    memberRevision.datasetId,
  ]);
  const phone = (auth: AppBackendAuth, grantId?: string): AppBackendAuth =>
    auth.kind === "named" ? { ...auth, ...(grantId ? { grantId } : {}), device: "phone" } : auth;
  for (const auth of [owner, ana, phone(ana), phone(owner, "ana-grant"), f.link("visitor")])
    expect(() => f.host.servedPublication(auth, app)).toThrow(missing);
  const add = (auth: AppBackendAuth, appId: string, key: string) =>
    f.host.invoke(auth, {
      workspaceId: "w",
      datasetId: memberRevision.datasetId,
      revision: 1,
      revisionSha256: memberRevision.revisionSha256,
      operationId: id(5),
      input: { name: "From the phone" },
      idempotencyKey: key,
      access: { kind: "app", appId },
    });
  await expect(add(owner, app, "desktop")).rejects.toMatchObject({ code: "not_found" });
  expect((await run("apps", {})).apps).toContainEqual(
    expect.objectContaining({ publicationId: app, audience: "owner", approved: false }),
  );
  expect(await run("appReview", { publicationId: app })).toMatchObject({ audience: "owner" });
  await run("appApprove", { publicationId: app, authorityRevision: 1 });
  const launch = await open(app);
  expect((await add(launch, app, "first")).revision).toBeGreaterThan(0);
  const next = version([id(5), id(6)]);
  expect(await catalog()).toContain(app);
  expect(await catalog()).not.toContain(next);
  await expect(run("appReview", { publicationId: next })).rejects.toMatchObject({
    code: "not_found",
  });
  const newest = version([id(5)]);
  expect(() => f.host.bindPublication(desktop, { workspaceId: "w", publicationId: next })).toThrow(
    missing,
  );
  expect(await catalog()).toContain(app);
  expect((await add(launch, app, "while-pending")).revision).toBeGreaterThan(0);
  f.host.bindPublication(desktop, { workspaceId: "w", publicationId: newest });
  expect(await catalog()).toContain(newest);
  expect(await catalog()).not.toContain(app);
  expect(() => f.host.bindPublication(desktop, { workspaceId: "w", publicationId: app })).toThrow(
    expect.objectContaining({ code: "conflict" }),
  );
  expect((await add(launch, app, "still-open")).revision).toBeGreaterThan(0);
  await expect(run("appReview", { publicationId: app })).rejects.toMatchObject({
    code: "not_found",
  });
});

it("keeps staged owner versions in order, keeps a running launch on a version sent again, and withdraws pending versions with their app", async () => {
  const f = await memberFixture();
  const version = (operationIds: string[], expected?: string | null) =>
    f.publishWith(
      [
        resolveAppDatasetCapability(
          {
            kind: "dataset",
            datasetId: memberRevision.datasetId,
            revision: 1,
            revisionSha256: memberRevision.revisionSha256,
            operationIds,
          },
          memberRevision,
        ),
      ],
      "owner",
      undefined,
      expected,
    );
  const desktop: AppBackendAuth = {
    kind: "named",
    workspaceId: "w",
    userId: "owner",
    device: "desktop",
  };
  const bind = (publicationId: string) =>
    f.host.bindPublication(desktop, { workspaceId: "w", publicationId });
  const conflict = expect.objectContaining({ code: "conflict" });
  const { run, open } = ownerPhone(f);
  const catalog = async () =>
    ((await run("apps", {})).apps as { publicationId: string }[]).map((row) => row.publicationId);
  const a = version([id(5), id(6), id(7)]);
  bind(a);
  await run("appApprove", { publicationId: a, authorityRevision: 1 });
  const launch = await open(a);
  const b = version([id(5), id(6)]);
  const staged = f.storage.listAppPublications({
    workspaceId: "w",
    ownerUserId: "owner",
    limits,
    audience: "owner",
  }).publications;
  expect(staged).toContainEqual(
    expect.objectContaining({ publicationId: b, ownerState: "pending" }),
  );
  expect(() => version([id(5)], a)).toThrow(conflict);
  const c = version([id(5)], b);
  expect(() => version([id(5), id(6)], a)).toThrow(conflict);
  bind(c);
  expect(await catalog()).toContain(c);
  expect(await catalog()).not.toContain(a);
  expect(version([id(5), id(6), id(7)], c)).toBe(a);
  const added = await f.host.invoke(launch, {
    workspaceId: "w",
    datasetId: memberRevision.datasetId,
    revision: 1,
    revisionSha256: memberRevision.revisionSha256,
    operationId: id(5),
    input: { name: "From the phone" },
    idempotencyKey: "after-resend",
    access: { kind: "app", appId: a },
  });
  expect(added.revision).toBeGreaterThan(0);
  f.storage.withdrawAppPublication({
    workspaceId: "w",
    publicationId: c,
    ownerUserId: "owner",
    expectedAuthorityRevision: 1,
  });
  expect(() => bind(a)).toThrow(expect.objectContaining({ code: "not_found" }));
  expect(await catalog()).not.toContain(a);
});

it("keeps the current owner version current when it is sent again over a staged one", async () => {
  const f = await memberFixture();
  const version = (operationIds: string[], expected?: string | null) =>
    f.publishWith(
      [
        resolveAppDatasetCapability(
          {
            kind: "dataset",
            datasetId: memberRevision.datasetId,
            revision: 1,
            revisionSha256: memberRevision.revisionSha256,
            operationIds,
          },
          memberRevision,
        ),
      ],
      "owner",
      undefined,
      expected,
    );
  const desktop: AppBackendAuth = {
    kind: "named",
    workspaceId: "w",
    userId: "owner",
    device: "desktop",
  };
  const { run } = ownerPhone(f);
  const catalog = async () =>
    ((await run("apps", {})).apps as { publicationId: string }[]).map((row) => row.publicationId);
  const a = version([id(5), id(6), id(7)]);
  f.host.bindPublication(desktop, { workspaceId: "w", publicationId: a });
  const b = version([id(5), id(6)], a);
  expect(version([id(5), id(6), id(7)], b)).toBe(a);
  expect(await catalog()).toContain(a);
  const owned = f.storage.listAppPublications({
    workspaceId: "w",
    ownerUserId: "owner",
    limits,
    audience: "owner",
  }).publications;
  expect(owned).toContainEqual(
    expect.objectContaining({ publicationId: a, ownerState: "current" }),
  );
  expect(owned).not.toContainEqual(expect.objectContaining({ publicationId: b }));
});
