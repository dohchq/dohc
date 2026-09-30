import { z } from "zod";
import { CreationPartial } from "./creation";
import { APP_BACKEND_UPLOAD_BYTES, parseAppBackendFile, parseAppBackendJson } from "@dohc/security-contract/app-backend";
import { DATASET_MAX_FIELDS, parseDatasetDefinition, parseDatasetRevision, parseDatasetDescription, parseDatasetBindingReference, parseDatasetPath } from "@dohc/security-contract/dataset";

const identity = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const workspace = { workspaceId: z.string().min(1).max(128) };
const datasetPath = z.string().min(1).max(1024).describe("Caller-relative dataset.json path, for example equipment/dataset.json. Old paths break after a move; update the reference.").superRefine((value, context) => {
  try { parseDatasetPath(value); } catch { context.addIssue({ code: "custom", message: value.startsWith("../") ? "This Collection sits outside the MCP folder. Run the MCP server from the workspace root or a folder containing the Collection." : "Use the caller-relative dataset.json path." }); }
});
// Result addresses can name a sibling of the caller folder. They grant no access.
const resultDatasetPath = z.string().min(1).max(4096).superRefine((value, context) => {
  try { parseDatasetPath(value.replace(/^(?:\.\.\/)+/, "")); }
  catch { context.addIssue({ code: "custom", message: "Use a caller-relative dataset.json path." }); }
});
const selection = { ...workspace, datasetPath, expectedDatasetId: identity.describe("The datasetId returned by describe. Refuse the request if the path now names another Collection.").optional() };
const pinned = { ...selection, revision: z.number().int().positive(), revisionSha256: sha256 };
const file = z.unknown().transform((value, context) => {
  try { return parseAppBackendFile(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection file." }); return z.NEVER; }
});
const fileBytes = z.string().max(Math.ceil(APP_BACKEND_UPLOAD_BYTES / 3) * 4);
const json = z.unknown().transform((value, context) => {
  try { return parseAppBackendJson(value, 64 * 1024); }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection input." }); return z.NEVER; }
});
const definition = z.unknown().transform((value, context) => {
  try { return parseDatasetDefinition(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection definition." }); return z.NEVER; }
});
const revision = z.unknown().transform((value, context) => {
  try {
    // Validate immutable source metadata with caller-relative addresses.
    const row = z.object({ definition: z.object({ schemaPath: z.string(), operationsPath: z.string() }).passthrough() }).passthrough().parse(value);
    const { schemaPath, operationsPath } = row.definition;
    const parsed = parseDatasetRevision({ ...row, definition: { ...row.definition,
      schemaPath: schemaPath.replace(/^(?:\.\.\/)+/, ""),
      operationsPath: operationsPath.replace(/^(?:\.\.\/)+/, ""),
    } });
    return { ...parsed, definition: { ...parsed.definition, schemaPath, operationsPath } };
  }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection revision." }); return z.NEVER; }
});
export const DatasetCursor = z.object({ ...workspace, datasetId: identity, hostEpoch: z.string().min(1).max(256), approvedRevisionHash: sha256,
  revision: z.number().int().nonnegative(), digest: sha256 }).strict();
export const DatasetRecoveryPreparation = z.object({ transferId: identity, manifestSha256: sha256, sourceCursor: DatasetCursor, revision }).strict();
export type DatasetRecoveryPreparation = z.infer<typeof DatasetRecoveryPreparation>;
const DatasetDataGrant = z.object({ revision: z.number().int().positive(), revisionSha256: sha256,
  operationIds: z.array(identity).min(1).max(128), discover: z.boolean() }).strict();
export const DatasetPermissionsPage = z.object({ permissions: z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("data"), principal: z.string().min(1).max(256), current: z.boolean(), metadata: DatasetDataGrant }).strict(),
  z.object({ kind: z.literal("app"), principal: z.string().min(1).max(256), current: z.boolean(), metadata: z.unknown().transform(value => parseDatasetBindingReference(value)) }).strict(),
])).max(100), nextCursor: z.string().min(1).max(1024).nullable() }).strict();
export type DatasetPermissionsPage = z.infer<typeof DatasetPermissionsPage>;
export const DatasetSchemaChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("renameCollection"), name: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("renameTable"), tableId: identity, name: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("renameField"), tableId: identity, fieldId: identity, name: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("changeField"), tableId: identity, fieldId: identity,
    type: z.enum(["text", "number", "checkbox", "date", "select", "multi-select", "url", "attachment", "relation"]), required: z.boolean() }).strict(),
  // A button runs an automation on a record. It stores nothing, so adding one changes no SQL.
  z.object({ kind: z.literal("addButton"), tableId: identity, name: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("addField"), tableId: identity, field: z.object({ name: z.string().trim().min(1).max(128),
    type: z.enum(["text", "number", "checkbox", "date", "select", "multi-select", "url", "attachment"]), required: z.boolean(), unique: z.boolean(),
    default: json.optional(), options: z.array(z.string().min(1).max(128)).min(1).max(100).optional() }).strict() }).strict(),
]);
export type DatasetSchemaChange = z.infer<typeof DatasetSchemaChange>;
const migrationValue = z.union([z.null(), z.number(), z.string(), z.object({ type: z.literal("integer"), value: z.string().min(1).max(128) }).strict(), z.object({ type: z.literal("blob"), base64: z.string().max(1024 * 1024) }).strict()]);
const migrationValues = z.record(z.string().max(256), migrationValue);
const migrationRowChange = z.object({ table: z.string().min(1).max(128), kind: z.enum(["insert", "update", "delete"]), key: migrationValues,
  before: migrationValues.nullable(), after: migrationValues.nullable() }).strict();
export const DatasetMigrationPreviewPage = z.object({ changes: z.array(migrationRowChange).max(100), nextCursor: z.string().min(1).max(1024).nullable() }).strict();
const migrationPreview = z.object({ tables: z.array(z.object({ table: z.string().min(1).max(128), beforeRows: z.number().int().nonnegative(), afterRows: z.number().int().nonnegative(), changedRows: z.number().int().nonnegative() }).strict()).max(128), firstPage: DatasetMigrationPreviewPage }).strict();
export const DatasetMigrationCandidate = z.object({ candidateId: identity, expected: DatasetCursor, approvedRevisionHash: sha256, checkpointSha256: sha256,
  expiresAtMs: z.number().int().positive(), preview: migrationPreview }).strict();
export type DatasetMigrationPreviewPage = z.infer<typeof DatasetMigrationPreviewPage>;
export type DatasetMigrationCandidate = z.infer<typeof DatasetMigrationCandidate>;
export const DatasetLifecycleState = z.object({ archived: z.boolean(), generation: z.number().int().nonnegative(), reason: z.string().max(1024).optional() }).strict();
export const DatasetLifecyclePage = z.object({ archived: z.boolean(), generation: z.number().int().nonnegative(), reason: z.string().max(1024),
  apps: z.array(z.object({ appId: z.string().min(1).max(256), binding: z.unknown().transform(value => parseDatasetBindingReference(value)) }).strict()).max(100),
  nextCursor: z.string().min(1).max(256).nullable() }).strict();
export const DatasetDeletePreview = DatasetLifecyclePage.extend({ cursor: DatasetCursor, reviewToken: sha256, name: z.string().min(1).max(128), irreversible: z.literal(true) }).strict();
export type DatasetDeletePreview = z.infer<typeof DatasetDeletePreview>;
export const DatasetDeleted = z.object({ deleted: z.literal(true), datasetId: identity }).strict();
export type DatasetDeleted = z.infer<typeof DatasetDeleted>;
export type DatasetLifecyclePage = z.infer<typeof DatasetLifecyclePage>;
export type DatasetLifecycleState = z.infer<typeof DatasetLifecycleState>;
export const DatasetPendingAttemptsPage = z.object({ datasetId: identity, entries: z.array(z.object({ reference: sha256, operation: z.string().min(1).max(200), recordedAtMs: z.number().int().min(0).max(8_640_000_000_000_000).nullable(), revision: z.number().int().positive().nullable(), outcome: z.enum(["committed", "unconfirmed"]), attachmentCount: z.number().int().nonnegative() }).strict()).max(100), nextAfter: z.number().int().positive().nullable() }).strict();
export type DatasetPendingAttemptsPage = z.infer<typeof DatasetPendingAttemptsPage>;
export const DatasetRequest = z.discriminatedUnion("action", [
  z.object({ ...workspace, action: z.literal("prepareRecovery"), sourcePath: z.string().min(1).max(4096).optional() }).strict(),
  z.object({ ...workspace, action: z.literal("claimRecovery"), transferId: identity, manifestSha256: sha256, sourceCursor: DatasetCursor, oldHostStopped: z.literal(true) }).strict(),
  z.object({ ...workspace, action: z.literal("discardRecovery"), transferId: identity }).strict(),
  z.object({ ...selection, action: z.literal("history"), beforeRevision: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...workspace, action: z.literal("list"), after: identity.optional(), limit: z.number().int().min(1).max(100).optional(), includeArchived: z.boolean().optional() }).strict(),
  z.object({ ...selection, action: z.literal("describe"), includeArchived: z.boolean().optional() }).strict(),
  z.object({ ...selection, action: z.literal("lifecycle"), after: z.string().min(1).max(256).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...selection, action: z.literal("deletePreview"), after: z.string().min(1).max(256).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...selection, action: z.literal("delete"), expected: DatasetCursor, reviewToken: sha256, acknowledge: z.literal(true) }).strict(),
  z.object({ ...selection, action: z.literal("archive") }).strict(),
  z.object({ ...selection, action: z.literal("restore") }).strict(),
  z.object({ ...selection, action: z.literal("pendingAttempts"), after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...selection, action: z.literal("reconcileAttempt"), reference: sha256, acknowledge: z.literal(true) }).strict(),
  z.object({ ...selection, action: z.literal("cancelAttempt"), reference: sha256, acknowledge: z.literal(true) }).strict(),
  z.object({ ...selection, action: z.literal("permissions"), after: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...selection, action: z.literal("setGrant"), grantId: z.string().min(1).max(256), grant: DatasetDataGrant }).strict(),
  z.object({ ...selection, action: z.literal("removeGrant"), principalKey: z.string().min(1).max(256) }).strict(),
  z.object({ ...selection, action: z.literal("export"), savePath: z.string().min(1).max(4096).optional(), overwrite: z.boolean().optional() }).strict(),
  z.object({ ...pinned, action: z.literal("upload"), fieldId: identity, idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    name: z.string().min(1).max(255), contentType: z.string().min(1).max(128), bytesBase64: fileBytes }).strict(),
  z.object({ ...pinned, action: z.literal("file"), fileId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    read: z.object({ operationId: identity, fieldId: identity, input: json }).strict().optional() }).strict(),
  z.object({ ...selection, action: z.literal("createForm"), revision: z.number().int().positive(), revisionSha256: sha256,
    tableId: identity, createOperationId: identity, appRoot: z.string().min(1).max(900), title: z.string().min(1).max(200).optional(),
    fieldIds: z.array(identity).min(1).max(DATASET_MAX_FIELDS),
    relationChoices: z.array(z.object({ fieldId: identity, operationId: identity, labelFieldId: identity }).strict()).max(DATASET_MAX_FIELDS).optional() }).strict(),
  z.object({ ...pinned, action: z.literal("prepareRelationChoices"), tableId: identity, fieldId: identity, labelFieldId: identity }).strict(),
  z.object({ ...workspace, action: z.literal("create"), definition }).strict(),
  z.object({ ...workspace, action: z.literal("prepare"), descriptorPath: z.string().min(1).max(1024) }).strict(),
  z.object({ ...workspace, action: z.literal("approve"), preparationId: identity, revisionSha256: sha256 }).strict(),
  z.object({ ...workspace, action: z.literal("discard"), preparationId: identity }).strict(),
  z.object({ ...selection, action: z.literal("historyRevision"), revisionSha256: sha256 }).strict(),
  z.object({ ...pinned, action: z.literal("prepareHistoryRestore"), targetRevisionSha256: sha256, changedRevisionSha256: sha256 }).strict(),
  z.object({ ...selection, action: z.literal("prepareMigration"), migrationPath: z.string().min(1).max(1024) }).strict(),
  z.object({ ...workspace, action: z.literal("migrationPreviewPage"), preparationId: identity, after: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...pinned, action: z.literal("prepareSchemaChange"), change: DatasetSchemaChange }).strict(),
  z.object({ ...workspace, action: z.literal("approveMigration"), preparationId: identity, revisionSha256: sha256, approvalDigest: sha256 }).strict(),
  z.object({ ...workspace, action: z.literal("discardMigration"), preparationId: identity }).strict(),
  z.object({ ...selection, action: z.literal("invoke"), operationId: identity, revision: z.number().int().positive(), revisionSha256: sha256,
    input: json, idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict(),
]);
export type DatasetRequest = z.infer<typeof DatasetRequest>;
export const DatasetPreparation = z.object({ preparationId: identity, revision, sourceDigest: sha256 }).strict();
export type DatasetPreparation = z.infer<typeof DatasetPreparation>;
export const DatasetMigrationPreparation = z.object({ preparationId: identity, previousRevision: revision, revision, expected: DatasetCursor, candidate: DatasetMigrationCandidate,
  sourceDigest: sha256, approvalDigest: sha256, schemaSql: z.string().max(256 * 1024), operationSource: z.string().max(256 * 1024),
  migrationSql: z.string().min(1).max(256 * 1024), expiresAtMs: z.number().int().positive() }).strict();
export type DatasetMigrationPreparation = z.infer<typeof DatasetMigrationPreparation>;
export const DatasetCopyStatus = z.object({ offline: z.boolean(), savedAtMs: z.number().int().nonnegative(), coverage: z.literal("saved-pages").optional() }).strict();
export type DatasetCopyStatus = z.infer<typeof DatasetCopyStatus>;
export const DatasetInvocationResult = z.object({
  result: z.unknown().transform((value, context) => {
    try { return parseAppBackendJson(value, 256 * 1024); }
    catch { context.addIssue({ code: "custom", message: "Invalid Collection result." }); return z.NEVER; }
  }), revision: z.number().int().nonnegative(), replayed: z.boolean(), copy: DatasetCopyStatus.optional(),
}).strict();
export type DatasetInvocationResult = z.infer<typeof DatasetInvocationResult>;
const DatasetHistoryUndo = z.object({ operationId: identity, revision: z.number().int().positive(), revisionSha256: sha256,
  recordId: z.union([z.string().min(1).max(512), z.number().int().safe()]), expectedVersion: z.number().int().positive().safe(),
  fields: z.array(z.object({ fieldId: identity, name: z.string().min(1).max(128), value: json }).strict()).min(1).max(128) }).strict();
export const DatasetHistoryRevision = z.object({ revision, schemaSql: z.string().max(256 * 1024), operationSource: z.string().max(256 * 1024) }).strict();
export type DatasetHistoryRevision = z.infer<typeof DatasetHistoryRevision>;
export const DatasetHistoryPage = z.object({ datasetId: identity, headRevision: z.number().int().nonnegative(),
  entries: z.array(z.object({ revision: z.number().int().positive(), operation: z.string().min(1).max(64), callerReference: sha256.nullable(),
    recordedAtMs: z.number().int().min(0).max(8_640_000_000_000_000).nullable(), approvedRevisionHash: sha256, changesetBytes: z.number().int().nonnegative(), attachmentCount: z.number().int().nonnegative(), undo: DatasetHistoryUndo.optional(),
    // The automation that made the change. The desktop adds its name from the Collection's automations.yaml.
    automation: z.object({ automationId: z.string().min(1).max(1024), depth: z.number().int().min(1).max(4), name: z.string().min(1).max(120).optional() }).strict().optional(),
    schema: z.object({ previousRevisionHash: sha256, revisionHash: sha256 }).strict().optional() }).strict()).max(100),
  nextBeforeRevision: z.number().int().positive().nullable() }).strict();
export type DatasetHistoryPage = z.infer<typeof DatasetHistoryPage>;
const description = z.unknown().transform((value, context) => {
  try {
    const { datasetPath: path, datasetAddressStatus, ...metadata } = value as Record<string, unknown>;
    const status = z.enum(["available", "missing", "ambiguous"]).optional().parse(datasetAddressStatus);
    return { ...parseDatasetDescription(metadata), datasetPath: path === null ? null : resultDatasetPath.parse(path), ...(status ? { datasetAddressStatus: status } : {}) };
  }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection description." }); return z.NEVER; }
});
export type AddressedDatasetDescription = z.infer<typeof description>;
export const DatasetResult = z.discriminatedUnion("kind", [
  DatasetHistoryRevision.extend({ kind: z.literal("history-revision") }).strict(),
  DatasetDeletePreview.extend({ kind: z.literal("delete-preview") }).strict(),
  DatasetDeleted.extend({ kind: z.literal("deleted") }).strict(),
  DatasetLifecyclePage.extend({ kind: z.literal("lifecycle") }).strict(),
  DatasetLifecycleState.extend({ kind: z.literal("lifecycle-updated") }).strict(),
  DatasetPendingAttemptsPage.extend({ kind: z.literal("pending-attempts") }).strict(),
  z.object({ kind: z.literal("attempt-reconciled"), cleared: z.literal(true) }).strict(),
  z.object({ kind: z.literal("attempt-cancelled"), cancelled: z.literal(true) }).strict(),
  z.object({ kind: z.literal("recovery-prepared"), recovery: DatasetRecoveryPreparation.nullable() }).strict(),
  z.object({ kind: z.literal("recovery-claimed"), transferId: identity, manifestSha256: sha256, sourceCursor: DatasetCursor, targetCursor: DatasetCursor, datasetPath: resultDatasetPath.nullable(), sourceError: z.string().max(1024).optional() }).strict(),
  z.object({ kind: z.literal("recovery-discarded") }).strict(),
  DatasetHistoryPage.extend({ kind: z.literal("history") }).strict(),
  z.object({ kind: z.literal("list"), datasets: z.array(description).max(100), nextCursor: identity.nullable() }).strict(),
  z.object({ kind: z.literal("description"), dataset: description, copy: DatasetCopyStatus.optional() }).strict(),
  DatasetPermissionsPage.extend({ kind: z.literal("permissions") }).strict(),
  z.object({ kind: z.literal("grant-updated") }).strict(),
  z.object({ kind: z.literal("exported"), savedPath: z.string().min(1).max(4096).nullable() }).strict(),
  CreationPartial,
  z.object({ kind: z.literal("form-created"), appRoot: z.string().min(1).max(900), paths: z.array(z.string().min(1).max(1024)).min(1).max(4) }).strict(),
  DatasetPreparation.extend({ kind: z.literal("prepared") }).strict(),
  z.object({ kind: z.literal("approved"), revision }).strict(),
  DatasetInvocationResult.extend({ kind: z.literal("invoked") }).strict(),
  z.object({ kind: z.literal("refused"), code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), message: z.string().max(1024) }).strict(),
  z.object({ kind: z.literal("uploaded"), file, replayed: z.boolean() }).strict(),
  z.object({ kind: z.literal("file"), file, bytesBase64: fileBytes }).strict(),
  z.object({ kind: z.literal("discarded") }).strict(),
  DatasetMigrationPreparation.extend({ kind: z.literal("migration-prepared") }).strict(),
  DatasetMigrationPreviewPage.extend({ kind: z.literal("migration-preview-page") }).strict(),
  z.object({ kind: z.literal("migrated"), revision, cursor: DatasetCursor }).strict(),
  z.object({ kind: z.literal("migration-discarded") }).strict(),
]);
export type DatasetResult = z.infer<typeof DatasetResult>;
