import { parseAppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetRevision } from "@dohc/security-contract/dataset";

/** Only an explicitly reversible edit in the unchanged approved contract can be replayed in reverse. */
export function datasetHistoryUndo(approved: DatasetRevision, operationName: string, revisionHash: string, receipt: unknown) {
  if (revisionHash !== approved.revisionSha256 || typeof receipt !== "string") return undefined;
  const operation = approved.definition.operations.find(item => item.name === operationName);
  if (!operation?.reversible || operation.kind !== "edit" || operation.readOnly) return undefined;
  try {
    const result = parseAppBackendJson(JSON.parse(receipt), 16 * 1024);
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const { id, version, priorValues } = result;
    if (!(typeof id === "string" && id.length > 0 && id.length <= 512 || typeof id === "number" && Number.isSafeInteger(id)) ||
      typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || !priorValues || typeof priorValues !== "object" || Array.isArray(priorValues)) return undefined;
    const table = approved.definition.tables.find(item => item.tableId === operation.tableId);
    const ids = Object.keys(priorValues);
    if (!ids.length || ids.some(fieldId => !operation.fieldIds.includes(fieldId) || !table?.fields.some(field => field.fieldId === fieldId))) return undefined;
    return { operationId: operation.operationId, revision: approved.revision, revisionSha256: approved.revisionSha256,
      recordId: id, expectedVersion: version, fields: ids.map(fieldId => ({ fieldId, name: table!.fields.find(field => field.fieldId === fieldId)!.name, value: priorValues[fieldId]! })) };
  } catch { return undefined; }
}
