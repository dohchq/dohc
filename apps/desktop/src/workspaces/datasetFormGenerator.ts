import { DATASET_MAX_FIELDS, datasetColumnFields, parseDatasetRevision, type DatasetRevision } from "@dohc/security-contract/dataset";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { APP_BACKEND_OPERATION_FILES } from "@dohc/security-contract/app-backend";
import { generateDatasetFormFrontend, type DatasetFormField } from "./datasetFormFrontend";

export interface DatasetFormInput {
  approvedRevision: DatasetRevision;
  tableId: string;
  createOperationId: string;
  appRoot: string;
  title?: string;
  fieldIds: string[];
  relationChoices?: Array<{ fieldId: string; operationId: string; labelFieldId: string }>;
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
  if (!Array.isArray(input.fieldIds) || !input.fieldIds.length || input.fieldIds.length > DATASET_MAX_FIELDS || new Set(input.fieldIds).size !== input.fieldIds.length ||
      input.fieldIds.some(id => !operation.fieldIds.includes(id))) {
    throw new Error(`Choose 1 to ${DATASET_MAX_FIELDS} distinct fields allowed by the create action.`);
  }
  // A form fills columns. Operations list no buttons.
  const columns = datasetColumnFields(table);
  const required = columns.filter(field => operation.fieldIds.includes(field.fieldId) && field.required && !Object.hasOwn(field, "default") &&
    !(field.sqlColumn === table.primaryKey && field.type === "text"));
  if (required.some(field => !input.fieldIds.includes(field.fieldId))) throw new Error("Include every required field allowed by the create action.");
  const choices = input.relationChoices ?? [];
  if (!Array.isArray(choices) || choices.length > input.fieldIds.length || new Set(choices.map(choice => choice.fieldId)).size !== choices.length ||
      choices.some(choice => !input.fieldIds.includes(choice.fieldId) || columns.find(field => field.fieldId === choice.fieldId)?.type !== "relation")) {
    throw new Error("Choose a public read action for each related-record field.");
  }
  const relationOperations: string[] = [];
  const fields: DatasetFormField[] = input.fieldIds.map(id => {
    const field = columns.find(field => field.fieldId === id)!;
    let relation: DatasetFormField["relation"];
    if (field.type === "relation") {
      const choice = choices.find(choice => choice.fieldId === id);
      const read = revision.definition.operations.find(action => action.operationId === choice?.operationId);
      const target = revision.definition.tables.find(candidate => candidate.tableId === field.relation!.tableId)!;
      const key = datasetColumnFields(target).find(candidate => candidate.fieldId === field.relation!.fieldId)!;
      const label = datasetColumnFields(target).find(candidate => candidate.fieldId === choice?.labelFieldId);
      // A form grants the read operation itself, not merely the fields its picker displays.
      if (!read || read.kind !== "read" || !read.readOnly || read.access !== "link" || read.tableId !== target.tableId || !label ||
          !["text", "number", "select"].includes(label.type) || !read.fieldIds.includes(key.fieldId) || !read.fieldIds.includes(label.fieldId) ||
          read.fieldIds.some(fieldId => fieldId !== key.fieldId && fieldId !== label.fieldId)) {
        throw new Error("Choose an approved public read action exposing only the related record key and label.");
      }
      relationOperations.push(read.operationId);
      relation = { operation: read.name, keyFieldId: key.fieldId, labelFieldId: label.fieldId, keyType: key.type as "text" | "number", many: field.relation!.many };
    }
    return { fieldId: field.fieldId, name: field.name, type: field.type,
      required: required.some(required => required.fieldId === field.fieldId), omitWhenEmpty: Object.hasOwn(field, "default") || field.sqlColumn === table.primaryKey,
      ...(Object.hasOwn(field, "default") ? { default: field.default } : {}),
      ...(relation ? { relation } : {}),
      ...(field.options ? { options: [...field.options] } : {}) };
  });
  const title = input.title ?? revision.definition.name;
  if (fields.filter(field => field.type === "attachment" && field.required).length > APP_BACKEND_OPERATION_FILES) {
    throw new Error(`A response can include ${APP_BACKEND_OPERATION_FILES} files. Make additional file fields optional before creating this form.`);
  }
  if (typeof title !== "string" || !title.trim() || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) throw new Error("Use a form title with 1 to 200 characters.");
  const capability = resolveAppDatasetCapability({ kind: "dataset", datasetId: revision.datasetId, revision: revision.revision,
    revisionSha256: revision.revisionSha256, operationIds: [...new Set([operation.operationId, ...relationOperations])], createFields: [{ operationId: operation.operationId, fieldIds: input.fieldIds }] }, revision);
  const { operations: _, ...binding } = capability;
  const frontend = generateDatasetFormFrontend({ title, operation: operation.name, fields });
  return { files: {
    ...frontend,
    "dohc.json": JSON.stringify({ version: 1, type: "site", title }, null, 2) + "\n",
    "app.publish.json": JSON.stringify({ version: 1, entryPath: "frontend.js", inputs: ["frontend.js", "frontend.css"], packageMap: {}, dataset: binding }, null, 2) + "\n",
  } };
}
