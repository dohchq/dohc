import { CLI_COMMANDS } from "@dohc/cli/args";

const id = "00000000-0000-4000-8000-000000000001";
const tableId = "00000000-0000-4000-8000-000000000002";
const fieldId = "00000000-0000-4000-8000-000000000003";
const operationId = "00000000-0000-4000-8000-000000000004";
const hash = "a".repeat(64);
const cursor = { workspaceId: "workspace", datasetId: id, hostEpoch: "epoch", approvedRevisionHash: hash, revision: 1, digest: hash };
const jsonFields: Readonly<Record<string, unknown>> = {
  workspaceId: "workspace", datasetPath: "equipment/dataset.json", appRoot: "app",
  sourcePath: "equipment.dohc-recovery", savePath: "equipment.dohc-recovery",
  transferId: id, manifestSha256: hash, sourceCursor: cursor, oldHostStopped: true,
  expected: cursor, reviewToken: hash, acknowledge: true, reference: hash,
  grantId: id, grant: { revision: 1, revisionSha256: hash, operationIds: [id], discover: true }, principalKey: "principal",
  revision: 1, revisionSha256: hash, fieldId: id, tableId: id, operationId: id,
  idempotencyKey: "request-1", name: "photo.png", contentType: "image/png", bytesBase64: "",
  fileId: "abcdefghijklmnop", createOperationId: id, fieldIds: [id], labelFieldId: id,
  definition: {
    formatVersion: 1, datasetId: id, name: "Equipment", schemaPath: "equipment/schema.sql", operationsPath: "equipment/actions.ts",
    tables: [{ tableId, name: "Equipment", sqlName: "equipment", primaryKey: "id",
      fields: [{ fieldId, name: "ID", sqlColumn: "id", type: "text", required: true, unique: true }] }],
    operations: [{ operationId, name: "list", label: "List equipment", tableId, kind: "read", access: "owner", readOnly: true, fieldIds: [fieldId] }],
  },
  descriptorPath: "equipment/dataset.json", preparationId: id,
  targetRevisionSha256: hash, changedRevisionSha256: hash, migrationPath: "equipment/migration.sql",
  change: { kind: "renameCollection", name: "New name" }, approvalDigest: hash, input: {},
  publicationId: hash, shareId: id, approvalId: id, candidateDigest: hash, expectedAuthorityRevision: 1,
};

export const CLI_DISPATCH_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  "links edges": [],
  "links in": ['{"path":"a.md"}'],
  "links resolve": ["a.md", '[{"kind":"wikilink","literal":"b"}]'],
  "sync stop": [],
  "access refresh": [],
  "access object": ['{"kind":"path","path":"Notes/a.md"}'],
  "access sharing": ["received"],
  "share copy": ["share", "grant"],
  "document read": ["Notes/a.md"],
  "document edit": ["Notes/a.md", "--text", "Updated"],
  "document create": ["Notes/new.md"],
  "document chats": ["Notes/a.md"],
  "document comment": ["Notes/a.md", "--title", "Review", "--text", "Comment"],
  "document kept-edits": [],
  "document save-recovery-copy": ["Notes/a.md"],
  "document retry-kept-edits": ["Notes/a.md", "outbox:delivery:0"],
  "document stop-again": ["Notes/a.md", "release:a:0"],
  "chat file-mentions": [],
  "chat links": ["general"],
  "chat groups": [], "chat threads": ["group"], "chat inbox": [], "chat show": ["thread"],
  "chat post": ["group", "Post"], "chat reply": ["thread", "Reply"], "chat react": ["message", "thumbsup"],
  "chat grep": ["pattern"], "chat export": ["--out", "exports"],
  "file duplicate": ["Notes/a.md"],
  "history operation": ["dohc-operation:11111111-1111-4111-8111-111111111111"], "history undo": ["dohc-operation:11111111-1111-4111-8111-111111111111"],
  "history list": [], "history show": ["change"],
  "automation list": ["Tasks"], "automation buttons": ["Tasks"],
  "automation switch": ["Tasks", "stamp", "on", "--base", hash, "--submit-id", "switch-1"],
  "automation runs": ["Tasks", "stamp"], "automation run": ["Tasks", "stamp", "run"],
  "automation retry": ["Tasks", "stamp", "run"], "automation press": ["Tasks", "button", "record"],
  "account deletePreview": [], "account delete": ["--server", "https://dohc.example.com", "--preview-token", "token"],
  // JSON verb parsers declare their socket dispatch after validating these request fields.
  ...Object.fromEntries(Object.entries(CLI_COMMANDS).flatMap(([group, command]) =>
    Object.entries(command.verbs).filter(([, verb]) => verb.fields).map(([name, verb]) => [
      `${group} ${name}`,
      [JSON.stringify(Object.fromEntries(Object.keys(verb.fields!).filter(field => Object.hasOwn(jsonFields, field)).map(field => [field, jsonFields[field]])))],
    ]))),
};
