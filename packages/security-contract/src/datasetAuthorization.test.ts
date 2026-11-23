import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  datasetDefinitionDigestContent,
  datasetRevisionDigestContent,
  type DatasetDefinition,
  type DatasetRevision,
} from "./dataset";
import { assessAppDatasetDrift, resolveAppDatasetCapability } from "./datasetAuthorization";
import { generateDatasetOperations } from "./datasetOperations";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function makeRevision(
  definition: DatasetDefinition,
  revision: number,
  options: { generated?: boolean; operationSource?: string; schemaSql?: string } = {},
): DatasetRevision {
  const generated = options.generated ?? true;
  const schemaSql = options.schemaSql ?? `schema-v${revision}`;
  const operationSource =
    options.operationSource ??
    (generated ? generateDatasetOperations(definition) : `custom-v${revision}`);
  const draft: DatasetRevision = {
    datasetId: definition.datasetId,
    revision,
    revisionSha256: "0".repeat(64),
    definitionSha256: hash(datasetDefinitionDigestContent(definition)),
    schemaSha256: hash(schemaSql),
    operationsSha256: hash(operationSource),
    definition,
  };
  draft.revisionSha256 = hash(datasetRevisionDigestContent(draft));
  return draft;
}

function baseDefinition(): DatasetDefinition {
  return {
    formatVersion: 1,
    datasetId: id(1),
    name: "Clients",
    schemaPath: "clients/schema.sql",
    operationsPath: "clients/operations.js",
    tables: [
      {
        tableId: id(2),
        name: "Clients",
        sqlName: "clients",
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
          {
            fieldId: id(5),
            name: "Email",
            sqlColumn: "email",
            type: "text",
            required: false,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: id(10),
        name: "listClients",
        label: "List clients",
        tableId: id(2),
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [id(3), id(4)],
      },
      {
        operationId: id(11),
        name: "createClient",
        label: "Create client",
        tableId: id(2),
        kind: "create",
        access: "link",
        readOnly: false,
        fieldIds: [id(4), id(5)],
      },
      {
        operationId: id(12),
        name: "listHelper",
        label: "Helper list",
        tableId: id(2),
        kind: "read",
        access: "helper",
        readOnly: true,
        fieldIds: [id(3), id(4)],
      },
      {
        operationId: id(13),
        name: "ownerAudit",
        label: "Owner audit",
        tableId: id(2),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(3), id(4), id(5)],
      },
    ],
  };
}

describe("assessAppDatasetDrift", () => {
  it("marks current bindings compatible and preserves access across rename-only previews only when currently valid", () => {
    const rev1 = makeRevision(baseDefinition(), 1);
    const cap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: rev1.datasetId,
        revision: rev1.revision,
        revisionSha256: rev1.revisionSha256,
        operationIds: [id(10), id(11)],
      },
      rev1,
    );
    expect(assessAppDatasetDrift(cap, rev1, { scope: "local", bindingCurrent: true })).toEqual({
      status: "compatible",
      reasons: [],
    });

    const renamedDef = structuredClone(rev1.definition);
    renamedDef.name = "Customer Directory";
    const rev2 = makeRevision(renamedDef, 2, {
      schemaSql: "schema-v1",
      operationSource: generateDatasetOperations(rev1.definition),
    });
    expect(
      assessAppDatasetDrift(cap, rev2, {
        scope: "local",
        bindingCurrent: true,
        preservesAccess: true,
      }),
    ).toEqual({ status: "compatible", reasons: [] });

    expect(
      assessAppDatasetDrift(cap, rev2, {
        scope: "local",
        bindingCurrent: false,
        preservesAccess: true,
        pinnedRevision: rev1,
      }),
    ).toEqual({ status: "needs-refresh", reasons: [] });
  });

  it("marks local apps and create-only share-link forms needs-refresh when an optional field is added", () => {
    const rev1 = makeRevision(baseDefinition(), 1);
    const nextDef = structuredClone(rev1.definition);
    nextDef.tables[0]!.fields.push({
      fieldId: id(6),
      name: "Notes",
      sqlColumn: "notes",
      type: "text",
      required: false,
      unique: false,
    });
    nextDef.operations[1]!.fieldIds.push(id(6));
    const rev2 = makeRevision(nextDef, 2);

    const localCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: rev1.datasetId,
        revision: rev1.revision,
        revisionSha256: rev1.revisionSha256,
        operationIds: [id(13)],
      },
      rev1,
    );
    expect(
      assessAppDatasetDrift(localCap, rev2, {
        scope: "local",
        bindingCurrent: true,
        preservesAccess: false,
        pinnedRevision: rev1,
      }),
    ).toEqual({ status: "needs-refresh", reasons: [] });

    const formCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: rev1.datasetId,
        revision: rev1.revision,
        revisionSha256: rev1.revisionSha256,
        operationIds: [id(11)],
        createFields: [{ operationId: id(11), fieldIds: [id(4), id(5)] }],
      },
      rev1,
    );
    expect(
      assessAppDatasetDrift(formCap, rev2, {
        scope: "link",
        bindingCurrent: true,
        preservesAccess: false,
        pinnedRevision: rev1,
      }),
    ).toEqual({ status: "needs-refresh", reasons: [] });

    const typeChangedDef = structuredClone(rev1.definition);
    const emailField = typeChangedDef.tables[0]!.fields.find((f) => f.fieldId === id(5))!;
    if (emailField.type !== "button") emailField.type = "number";
    const typeChangedDrift = assessAppDatasetDrift(formCap, makeRevision(typeChangedDef, 2), {
      scope: "link",
      bindingCurrent: true,
      preservesAccess: false,
      pinnedRevision: rev1,
    });
    expect(typeChangedDrift.status).toBe("incompatible");
    expect(typeChangedDrift.reasons[0]).toContain("changed the input format for Email");

    const requiredDef = structuredClone(rev1.definition);
    const reqEmail = requiredDef.tables[0]!.fields.find((f) => f.fieldId === id(5))!;
    if (reqEmail.type !== "button") reqEmail.required = true;
    const requiredDrift = assessAppDatasetDrift(formCap, makeRevision(requiredDef, 2), {
      scope: "link",
      bindingCurrent: true,
      preservesAccess: false,
      pinnedRevision: rev1,
    });
    expect(requiredDrift.status).toBe("incompatible");
    expect(requiredDrift.reasons).toContain('Action "Create client" now requires Email.');
  });

  it("marks share-link reads incompatible when a migration adds exposed fields, widens access, or changes custom code", () => {
    const rev1 = makeRevision(baseDefinition(), 1);
    const linkReadCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: rev1.datasetId,
        revision: rev1.revision,
        revisionSha256: rev1.revisionSha256,
        operationIds: [id(10)],
      },
      rev1,
    );

    const widenedDef = structuredClone(rev1.definition);
    widenedDef.tables[0]!.fields.push({
      fieldId: id(6),
      name: "Private Notes",
      sqlColumn: "private_notes",
      type: "text",
      required: false,
      unique: false,
    });
    widenedDef.operations[0]!.fieldIds.push(id(6));
    const rev2 = makeRevision(widenedDef, 2);

    const addedFieldDrift = assessAppDatasetDrift(linkReadCap, rev2, {
      scope: "link",
      bindingCurrent: true,
      preservesAccess: false,
      pinnedRevision: rev1,
    });
    expect(addedFieldDrift.status).toBe("incompatible");
    expect(addedFieldDrift.reasons[0]).toContain("Private Notes");
    expect(addedFieldDrift.reasons[0]).not.toContain(id(6));

    const missingHistoryDrift = assessAppDatasetDrift(linkReadCap, rev2, {
      scope: "link",
      bindingCurrent: false,
    });
    expect(missingHistoryDrift.status).toBe("incompatible");
    expect(missingHistoryDrift.reasons[0]).toMatch(/Previous Collection rules are unavailable/);

    const ownerToHelperDef = structuredClone(rev1.definition);
    ownerToHelperDef.operations[3]!.access = "helper";
    const ownerCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: rev1.datasetId,
        revision: rev1.revision,
        revisionSha256: rev1.revisionSha256,
        operationIds: [id(13)],
      },
      rev1,
    );
    const widenedAccess = assessAppDatasetDrift(ownerCap, makeRevision(ownerToHelperDef, 2), {
      scope: "link",
      bindingCurrent: false,
      pinnedRevision: rev1,
    });
    expect(widenedAccess.status).toBe("incompatible");
    expect(widenedAccess.reasons[0]).toContain("changed who can run it");

    const customRev1 = makeRevision(baseDefinition(), 1, {
      generated: false,
      operationSource: "v1",
    });
    const customRev2 = makeRevision(baseDefinition(), 2, {
      generated: false,
      operationSource: "v2",
    });
    const customCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: customRev1.datasetId,
        revision: customRev1.revision,
        revisionSha256: customRev1.revisionSha256,
        operationIds: [id(11)],
      },
      customRev1,
    );
    const customDrift = assessAppDatasetDrift(customCap, customRev2, {
      scope: "link",
      bindingCurrent: false,
      pinnedRevision: customRev1,
    });
    expect(customDrift.status).toBe("incompatible");
    expect(customDrift.reasons[0]).toMatch(/Custom action code changed/);

    const customToGenerated = assessAppDatasetDrift(
      customCap,
      makeRevision(baseDefinition(), 2, { generated: true }),
      {
        scope: "link",
        bindingCurrent: false,
        pinnedRevision: customRev1,
      },
    );
    expect(customToGenerated.status).toBe("incompatible");
    expect(customToGenerated.reasons[0]).toMatch(/Custom action code changed/);
  });

  it("flags removed operations, dropped createFields columns, changed linkReads, ignores server-filled custom columns, and caps reasons at 16", () => {
    const rev1 = makeRevision(baseDefinition(), 1);
    const linkReadsCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: rev1.datasetId,
        revision: rev1.revision,
        revisionSha256: rev1.revisionSha256,
        operationIds: [id(11), id(12)],
        createFields: [{ operationId: id(11), fieldIds: [id(4), id(5)] }],
        linkReads: [{ operationId: id(12), fieldIds: [id(3), id(4)] }],
      },
      rev1,
    );
    const brokenDef = structuredClone(rev1.definition);
    brokenDef.tables[0]!.fields = brokenDef.tables[0]!.fields.filter((f) => f.fieldId !== id(5));
    brokenDef.operations[1]!.fieldIds = [id(4)];
    brokenDef.operations[2]!.fieldIds = [id(3), id(4)];
    brokenDef.operations[3]!.fieldIds = [id(3), id(4)];
    const drift = assessAppDatasetDrift(linkReadsCap, makeRevision(brokenDef, 2), {
      scope: "link",
      bindingCurrent: false,
      pinnedRevision: rev1,
    });
    expect(drift.status).toBe("incompatible");
    expect(drift.reasons).toContain('Action "Create client" can no longer submit Email.');

    const changedReadDef = structuredClone(rev1.definition);
    changedReadDef.operations[2]!.fieldIds = [id(3), id(4), id(5)];
    const changedRead = assessAppDatasetDrift(linkReadsCap, makeRevision(changedReadDef, 2), {
      scope: "link",
      bindingCurrent: false,
      pinnedRevision: rev1,
    });
    expect(changedRead.reasons).toContain('Read fields for "Helper list" changed.');

    const customServerColDef = baseDefinition();
    customServerColDef.tables[0]!.fields.push({
      fieldId: id(7),
      name: "Created By",
      sqlColumn: "created_by",
      type: "text",
      required: true,
      unique: false,
    });
    const customServerRev1 = makeRevision(customServerColDef, 1, {
      generated: false,
      operationSource: "custom-v1",
    });
    const customServerCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: customServerRev1.datasetId,
        revision: 1,
        revisionSha256: customServerRev1.revisionSha256,
        operationIds: [id(11)],
        createFields: [{ operationId: id(11), fieldIds: [id(4)] }],
      },
      customServerRev1,
    );
    const customServerNextDef = structuredClone(customServerColDef);
    customServerNextDef.tables[0]!.fields.push({
      fieldId: id(8),
      name: "Notes",
      sqlColumn: "notes",
      type: "text",
      required: false,
      unique: false,
    });
    const customLocalDrift = assessAppDatasetDrift(
      customServerCap,
      makeRevision(customServerNextDef, 2, { generated: false, operationSource: "custom-v1" }),
      {
        scope: "local",
        bindingCurrent: true,
        preservesAccess: false,
        pinnedRevision: customServerRev1,
      },
    );
    expect(customLocalDrift).toEqual({ status: "needs-refresh", reasons: [] });

    const manyDef = baseDefinition();
    manyDef.operations = Array.from({ length: 20 }, (_, i) => ({
      operationId: id(100 + i),
      name: `read_${i}`,
      label: `Read ${i}`,
      tableId: id(2),
      kind: "read" as const,
      access: "owner" as const,
      readOnly: true,
      fieldIds: [id(3), id(4)],
    }));
    const manyRev1 = makeRevision(manyDef, 1);
    const manyCap = resolveAppDatasetCapability(
      {
        kind: "dataset",
        datasetId: manyRev1.datasetId,
        revision: manyRev1.revision,
        revisionSha256: manyRev1.revisionSha256,
        operationIds: manyDef.operations.map((op) => op.operationId),
      },
      manyRev1,
    );
    const emptyOpsDef = structuredClone(manyDef);
    emptyOpsDef.operations = [
      {
        operationId: id(200),
        name: "other",
        label: "Other",
        tableId: id(2),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(3)],
      },
    ];
    const capped = assessAppDatasetDrift(manyCap, makeRevision(emptyOpsDef, 2), {
      scope: "local",
      bindingCurrent: false,
      pinnedRevision: manyRev1,
    });
    expect(capped.status).toBe("incompatible");
    expect(capped.reasons).toHaveLength(16);
    expect(capped.reasons[15]).toBe("And 5 more changes.");
  });
});
