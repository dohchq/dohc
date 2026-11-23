import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { AppDatasetCapability, DatasetDefinition } from "@dohc/security-contract/dataset";
import { discoverDatasetBoundApps } from "./datasetBoundApps";
import type { LocalAppRow } from "./localAppStore";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");

function makeDef(datasetId: string, name: string): DatasetDefinition {
  return {
    formatVersion: 1,
    datasetId,
    name,
    schemaPath: "data/schema.sql",
    operationsPath: "data/operations.js",
    tables: [
      {
        tableId: id(2),
        name: "Items",
        sqlName: "items",
        primaryKey: "id",
        fields: [
          {
            fieldId: id(3),
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
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
        operationId: id(10),
        name: "listItems",
        label: "List items",
        tableId: id(2),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(3), id(4)],
      },
      {
        operationId: id(11),
        name: "submitItem",
        label: "Submit item",
        tableId: id(2),
        kind: "create",
        access: "link",
        readOnly: false,
        fieldIds: [id(4)],
      },
    ],
  };
}

function makeCandidate(
  appRoot: string,
  capabilities: AppDatasetCapability[],
): AppPublicationCandidate {
  return {
    appRoot,
    versionId: "main",
    sourceRevision: sha(`src:${appRoot}`),
    sourceDigest: sha(`sd:${appRoot}`),
    dependencyLockDigest: sha(`lock:${appRoot}`),
    bundleDigest: sha(`bundle:${appRoot}`),
    buildDigest: sha(`build:${appRoot}`),
    entryPath: `${appRoot}/index.html`,
    inputs: [{ path: `${appRoot}/index.html`, sha256: sha(`in:${appRoot}`), byteLength: 10 }],
    packageMap: {},
    dependencies: [`${appRoot}/index.html`],
    compilerIdentity: { recipe: "test", version: "1", binarySha256: sha("compiler") },
    files: [
      {
        path: "bundle.js",
        sha256: sha(`out:${appRoot}`),
        byteLength: 10,
        contentType: "text/javascript; charset=utf-8",
      },
    ],
    capabilities,
  };
}

describe("discoverDatasetBoundApps", () => {
  const def1 = makeDef(id(1), "Orders");
  const rev1 = describeDatasetRevision({
    definition: def1,
    revision: 1,
    schemaSql: "CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT NOT NULL);",
    operationSource: generateDatasetOperations(def1),
  });
  const def2 = structuredClone(def1);
  def2.tables[0]!.fields.push({
    fieldId: id(5),
    name: "Notes",
    sqlColumn: "notes",
    type: "text",
    required: false,
    unique: false,
  });
  const rev2 = describeDatasetRevision({
    definition: def2,
    revision: 2,
    schemaSql: "CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT);",
    operationSource: generateDatasetOperations(def2),
  });
  const otherDef = makeDef(id(99), "Contacts");
  const otherRev = describeDatasetRevision({
    definition: otherDef,
    revision: 1,
    schemaSql: "CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT NOT NULL);",
    operationSource: generateDatasetOperations(otherDef),
  });

  it("short-circuits without opening local store or relay when permissions has no app bindings", async () => {
    const lookupLocalApps = vi.fn();
    const readShareLinkPublication = vi.fn();
    const result = await discoverDatasetBoundApps({
      datasetId: rev1.datasetId,
      targetRevision: rev2,
      previousRevision: rev1,
      permissionsPage: async () => ({
        permissions: [
          {
            kind: "data",
            principal: "user:1",
            current: true,
            metadata: {
              revision: 1,
              revisionSha256: rev1.revisionSha256,
              operationIds: [id(10)],
              discover: true,
            },
          },
        ],
        nextCursor: null,
      }),
      lookupLocalApps,
      readShareLinkPublication,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ boundApps: [] });
    expect(lookupLocalApps).not.toHaveBeenCalled();
    expect(readShareLinkPublication).not.toHaveBeenCalled();
  });

  it("discovers multi-Collection local apps and active share-link apps while skipping withdrawn links", async () => {
    const localCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: rev1.datasetId,
        alias: "orders",
        revision: 1,
        revisionSha256: rev1.revisionSha256,
        operationIds: [id(10)],
      },
      rev1,
    );
    const otherCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: otherRev.datasetId,
        alias: "contacts",
        revision: 1,
        revisionSha256: otherRev.revisionSha256,
        operationIds: [id(10)],
      },
      otherRev,
    );
    const linkCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: rev1.datasetId,
        revision: 1,
        revisionSha256: rev1.revisionSha256,
        operationIds: [id(11)],
      },
      rev1,
    );
    const localPubId = sha("local-multi");
    const linkPubId = sha("link-active");
    const withdrawnPubId = sha("link-withdrawn");
    const endedLinkPubId = sha("link-ended");

    const localRow: LocalAppRow = {
      kind: "dataset",
      publicationId: localPubId,
      appRoot: "apps/control-tower",
      resourceId: "",
      authorityRevision: 3,
      candidate: makeCandidate("apps/control-tower", [localCap, otherCap]),
      storageBytes: 100,
      active: true,
    };

    const result = await discoverDatasetBoundApps({
      datasetId: rev1.datasetId,
      targetRevision: rev2,
      previousRevision: rev1,
      permissionsPage: async () => ({
        permissions: [
          {
            kind: "app",
            principal: localPubId,
            current: true,
            metadata: {
              kind: "dataset",
              datasetId: rev1.datasetId,
              revision: 1,
              revisionSha256: rev1.revisionSha256,
              operationIds: [id(10)],
            },
          },
          {
            kind: "app",
            principal: linkPubId,
            current: true,
            metadata: {
              kind: "dataset",
              datasetId: rev1.datasetId,
              revision: 1,
              revisionSha256: rev1.revisionSha256,
              operationIds: [id(11)],
            },
          },
          {
            kind: "app",
            principal: withdrawnPubId,
            current: false,
            metadata: {
              kind: "dataset",
              datasetId: rev1.datasetId,
              revision: 1,
              revisionSha256: rev1.revisionSha256,
              operationIds: [id(11)],
            },
          },
          {
            kind: "app",
            principal: endedLinkPubId,
            current: true,
            metadata: {
              kind: "dataset",
              datasetId: rev1.datasetId,
              revision: 1,
              revisionSha256: rev1.revisionSha256,
              operationIds: [id(11)],
            },
          },
        ],
        nextCursor: null,
      }),
      lookupLocalApps: async (ids) =>
        new Map(ids.includes(localPubId) ? [[localPubId, localRow]] : []),
      readShareLinkPublication: async (pubId) => {
        if (pubId === linkPubId) {
          return {
            publicationId: linkPubId,
            active: true,
            linkCurrent: true,
            authorityRevision: 2,
            shareId: "share-1",
            grantId: "grant-1",
            candidate: makeCandidate("apps/order-form", [linkCap]),
          };
        }
        if (pubId === endedLinkPubId) {
          return {
            publicationId: endedLinkPubId,
            active: true,
            linkCurrent: false,
            authorityRevision: 5,
            shareId: "share-ended",
            grantId: "grant-ended",
            candidate: makeCandidate("apps/ended-form", [linkCap]),
          };
        }
        return {
          publicationId: withdrawnPubId,
          active: false,
          linkCurrent: true,
          authorityRevision: 4,
          shareId: "share-old",
          grantId: "grant-old",
          candidate: makeCandidate("apps/old-form", [linkCap]),
        };
      },
      signal: new AbortController().signal,
    });

    expect(result.boundAppsIncomplete).toBeUndefined();
    expect(result.boundApps).toEqual([
      {
        scope: "link",
        publicationId: linkPubId,
        authorityRevision: 2,
        appRoot: "apps/order-form",
        shareId: "share-1",
        grantId: "grant-1",
        pinnedRevision: 1,
        pinnedRevisionSha256: rev1.revisionSha256,
        operationIds: [id(11)],
        status: "needs-refresh",
      },
      {
        scope: "local",
        publicationId: localPubId,
        authorityRevision: 3,
        appRoot: "apps/control-tower",
        alias: "orders",
        pinnedRevision: 1,
        pinnedRevisionSha256: rev1.revisionSha256,
        operationIds: [id(10)],
        status: "needs-refresh",
      },
    ]);
  });

  it("marks boundAppsIncomplete when another device's app is missing locally and on the relay or when caller aborts", async () => {
    const remoteDevicePubId = sha("device-a-local");
    const incomplete = await discoverDatasetBoundApps({
      datasetId: rev1.datasetId,
      targetRevision: rev1,
      permissionsPage: async () => ({
        permissions: [
          {
            kind: "app",
            principal: remoteDevicePubId,
            current: true,
            metadata: {
              kind: "dataset",
              datasetId: rev1.datasetId,
              revision: 1,
              revisionSha256: rev1.revisionSha256,
              operationIds: [id(10)],
            },
          },
        ],
        nextCursor: null,
      }),
      lookupLocalApps: async () => new Map(),
      readShareLinkPublication: async () => null,
      signal: new AbortController().signal,
    });
    expect(incomplete).toEqual({ boundApps: [], boundAppsIncomplete: true });

    const ac = new AbortController();
    ac.abort(new Error("switched workspace"));
    await expect(
      discoverDatasetBoundApps({
        datasetId: rev1.datasetId,
        targetRevision: rev1,
        permissionsPage: async () => ({ permissions: [], nextCursor: null }),
        signal: ac.signal,
      }),
    ).rejects.toThrow(/switched workspace/);
  });
});
