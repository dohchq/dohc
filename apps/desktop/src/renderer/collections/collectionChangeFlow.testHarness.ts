import { vi } from "vitest";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { datasetChangeDigest, describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetMigrationCandidate, DatasetRequest } from "@dohc/cli/dataset";
import type { EngineMomentRecord } from "../../ipc/bridgeContract";
import { collectionChangeProposal, type CollectionChangeProposal } from "../../workspaces/collectionChange";
import type { CollectionChangeApi } from "./collectionChangeFlow";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const volunteers: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Volunteers", schemaPath: "volunteers/schema.sql", operationsPath: "volunteers/backend.ts",
  tables: [{ tableId: id(2), name: "Volunteers", sqlName: "volunteers", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Email", sqlColumn: "email", type: "text", required: true, unique: false },
    { fieldId: id(6), name: "Notes", sqlColumn: "notes", type: "text", required: false, unique: false },
  ] }], operations: [{ operationId: id(7), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4), id(6)] }] };
/** Ice made Email unique, then Claude Code added Due date and removed Notes. */
const iceEdit: DatasetDefinition = structuredClone(volunteers);
iceEdit.tables[0]!.fields[1] = { fieldId: id(4), name: "Email", sqlColumn: "email", type: "text", required: true, unique: true };
export const asked: DatasetDefinition = structuredClone(iceEdit);
asked.tables[0]!.fields = [...asked.tables[0]!.fields.filter(field => field.name !== "Notes"), { fieldId: id(9), name: "Due date", sqlColumn: "due", type: "date", required: false, unique: false }];
asked.operations[0]!.fieldIds = [id(3), id(4), id(9)];
const schemaSql = "CREATE TABLE volunteers (id TEXT PRIMARY KEY);", operationSource = "export default {};";
const migrationPath = "volunteers/migrations/004-due-date.sql", migrationSql = "ALTER TABLE volunteers ADD COLUMN due TEXT; ALTER TABLE volunteers DROP COLUMN notes;";
export const proposalPath = `volunteers/changes/${id(50)}.json`;
export const base = describeDatasetRevision({ definition: volunteers, revision: 3, schemaSql, operationSource });
const counts: DatasetMigrationCandidate["preview"]["tables"] = [{ table: "volunteers", beforeRows: 12, afterRows: 12, changedRows: 12, deletedRows: 0,
  beforeValues: { id: 12, email: 12, notes: 12 }, afterValues: { id: 12, email: 12, due: 0 }, clearedValues: { id: 0, email: 0, notes: 12 } }];
export const ice = { name: "Ice", agent: false }, claude = { name: "Claude Code", agent: true };

/**
 * A workspace and its Collection as the bridge answers for them. Preparing
 * reads the files as they are now, as main does. `refuse` makes the next
 * approval throw that error instead.
 */
export function world() {
  const files: Record<string, string> = { "volunteers/dataset.json": JSON.stringify(asked, null, 2), [volunteers.schemaPath]: schemaSql,
    [volunteers.operationsPath]: operationSource, [migrationPath]: migrationSql };
  // A file edit and the author History names it by, if any.
  const moment = (n: number, path: string, recordedAtMs: number, author: Pick<EngineMomentRecord, "agentAuthorName" | "personAuthorName" | "linkAuthor">, afterText: string) =>
    ({ id: `m${n}`, path, recordedAtMs, operation: "write" as const, origin: "local-file" as const, ...author, afterText });
  const moments = [
    moment(1, "volunteers/dataset.json", 500, { personAuthorName: "Ice" }, JSON.stringify(volunteers)),
    moment(2, "volunteers/dataset.json", 1_000, { personAuthorName: "Ice" }, JSON.stringify(iceEdit)),
    moment(3, "volunteers/dataset.json", 2_000, { agentAuthorName: "Claude Code" }, JSON.stringify(asked)),
    moment(4, migrationPath, 2_100, { agentAuthorName: "Claude Code" }, migrationSql),
  ];
  let head: DatasetRevision = base;
  const saved = new Map([[base.revisionSha256, base]]);
  const calls: DatasetRequest[] = [];
  const reads: string[] = [];
  const control = { refuse: null as unknown };
  const prepare = () => {
    const revision = describeDatasetRevision({ definition: JSON.parse(files["volunteers/dataset.json"]!), revision: head.revision + 1, schemaSql: files[volunteers.schemaPath]!, operationSource: files[volunteers.operationsPath]! });
    const migration = files[migrationPath]!;
    const candidate = { changeSha256: datasetChangeDigest({ revisionSha256: revision.revisionSha256, migrationSql: migration }), preview: { tables: counts } } as unknown as DatasetMigrationCandidate;
    return { kind: "migration-prepared" as const, preparationId: id(60), previousRevision: head, revision, schemaSql: files[volunteers.schemaPath]!,
      operationSource: files[volunteers.operationsPath]!, migrationSql: migration, approvalDigest: "a".repeat(64), candidate };
  };
  let prepared: ReturnType<typeof prepare> | null = null;
  const api = {
    readWorkspaceText: async ({ relativePath }: { relativePath: string }) => {
      reads.push(relativePath);
      const text = files[relativePath];
      if (text === undefined) throw new Error("This file is missing.");
      return { text, truncated: false as const, contentHash: "0".repeat(64) };
    },
    listFileChats: async ({ path }: { path: string }) => ({ fileObjectId: path, threads: [] }),
    listEngineMoments: async ({ objectId }: { objectId?: string }) => ({ moments: moments.filter(entry => entry.path === objectId).sort((a, b) => b.recordedAtMs - a.recordedAtMs) }),
    readEngineMoment: async ({ momentId }: { momentId: string }) => ({ moment: { afterText: moments.find(entry => entry.id === momentId)!.afterText } }),
    dataset: vi.fn(async (request: DatasetRequest) => {
      calls.push(request);
      if (request.action === "describe") return { kind: "description", dataset: { datasetId: head.datasetId, name: head.definition.name, revision: head.revision, revisionSha256: head.revisionSha256, tables: [], operations: [], datasetPath: "volunteers/dataset.json" } };
      if (request.action === "historyRevision") {
        const revision = saved.get(request.revisionSha256);
        if (!revision) throw new Error("This saved revision is unavailable. Choose another change from History.");
        return { kind: "history-revision", revision, schemaSql, operationSource };
      }
      if (request.action === "prepareMigration") return prepared = prepare();
      if (request.action === "discardMigration") { prepared = null; return { kind: "migration-discarded" }; }
      if (request.action === "approveMigration") {
        if (control.refuse !== null) throw control.refuse;
        if (!prepared || request.changeSha256 !== prepared.candidate.changeSha256) throw new Error("This change differs from the one you were asked to apply.");
        head = prepared.revision; saved.set(head.revisionSha256, head); prepared = null;
        return { kind: "migrated" };
      }
      throw new Error(`Unexpected ${request.action}`);
    }),
  } as unknown as CollectionChangeApi;
  return { api, files, moments, calls, reads, moment, control, head: () => head, actions: () => calls.map(call => call.action) };
}
export type World = ReturnType<typeof world>;

/** Claude Code's message asks for the change the files make now. */
export const ask = (place: World): CollectionChangeProposal => {
  const next = describeDatasetRevision({ definition: asked, revision: 4, schemaSql, operationSource });
  const candidate = { changeSha256: datasetChangeDigest({ revisionSha256: next.revisionSha256, migrationSql }), preview: { tables: counts } } as unknown as DatasetMigrationCandidate;
  const proposal = collectionChangeProposal({ previousRevision: base, revision: next, operationSource, migrationSql, candidate },
    { datasetPath: "volunteers/dataset.json", migrationPath, note: null });
  place.files[proposalPath] = JSON.stringify(proposal, null, 2);
  return proposal;
};
export const fixtureSources = { schemaSql, operationSource, migrationSql };
