import { parseDatasetRevision, resolveAppDatasetCapability, type DatasetRevision } from "@dohc/security-contract/dataset";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { generateDatasetFormFrontend, type DatasetFormField } from "./datasetFormFrontend";

export interface DatasetFormInput {
  approvedRevision: DatasetRevision;
  tableId: string;
  createOperationId: string;
  appRoot: string;
  title?: string;
  fieldIds: string[];
}

/** Generates a consumer app. The caller obtains the revision from the approved host catalog. */
export function generateDatasetFormSources(input: DatasetFormInput): { files: Record<string, string> } {
  const revision = parseDatasetRevision(input.approvedRevision);
  if (!isShareablePath(input.appRoot) || !/^[A-Za-z0-9_@./-]+$/.test(input.appRoot) || input.appRoot.length > 900) {
    throw new Error("Choose a workspace folder for the form app.");
  }
  const table = revision.definition.tables.find(table => table.tableId === input.tableId);
  const operation = revision.definition.operations.find(operation => operation.operationId === input.createOperationId);
  if (!table || !operation || operation.tableId !== table.tableId || operation.kind !== "create" || operation.access !== "link") {
    throw new Error("Choose an approved public create action for this Collection.");
  }
  if (!Array.isArray(input.fieldIds) || !input.fieldIds.length || input.fieldIds.length > 24 || new Set(input.fieldIds).size !== input.fieldIds.length ||
      input.fieldIds.some(id => !operation.fieldIds.includes(id))) {
    throw new Error("Choose 1 to 24 distinct fields allowed by the create action.");
  }
  const required = table.fields.filter(field => operation.fieldIds.includes(field.fieldId) && field.required && !Object.hasOwn(field, "default") &&
    !(field.sqlColumn === table.primaryKey && field.type === "text"));
  if (required.some(field => !input.fieldIds.includes(field.fieldId))) throw new Error("Include every required field allowed by the create action.");
  const fields: DatasetFormField[] = input.fieldIds.map(id => {
    const field = table.fields.find(field => field.fieldId === id)!;
    if (field.type === "relation") throw new Error("This form builder cannot select related records yet. Use a custom app for this field.");
    return { fieldId: field.fieldId, name: field.name, type: field.type,
      required: required.some(required => required.fieldId === field.fieldId), omitWhenEmpty: Object.hasOwn(field, "default") || field.sqlColumn === table.primaryKey,
      ...(Object.hasOwn(field, "default") ? { default: field.default } : {}),
      ...(field.options ? { options: [...field.options] } : {}) };
  });
  if (fields.filter(field => field.type === "attachment").length > 1) throw new Error("This form builder supports 1 file field. Use a custom app for more files.");
  const title = input.title ?? revision.definition.name;
  if (typeof title !== "string" || !title.trim() || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) throw new Error("Use a form title with 1 to 200 characters.");
  const capability = resolveAppDatasetCapability({ kind: "dataset", datasetId: revision.datasetId, revision: revision.revision,
    revisionSha256: revision.revisionSha256, operationIds: [operation.operationId], createFields: [{ operationId: operation.operationId, fieldIds: input.fieldIds }] }, revision);
  const { operations: _, ...binding } = capability;
  const frontend = generateDatasetFormFrontend({ title, operation: operation.name, fields });
  return { files: {
    ...frontend,
    "dohc.json": JSON.stringify({ type: "site", title }, null, 2) + "\n",
    "app.publish.json": JSON.stringify({ entryPath: `${input.appRoot}/frontend.js`,
      inputs: ["frontend.js", "frontend.css"].map(path => `${input.appRoot}/${path}`), packageMap: {}, dataset: binding }, null, 2) + "\n",
  } };
}
