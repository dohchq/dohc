import type {
  CollectionIndexedValue,
  CollectionQueryResult,
  CollectionRecord,
  CollectionSchema,
  CollectionSummary,
  CollectionValue,
} from "@dohc/workspace-contracts";

/** One field of every v1 type, for tests. */
export const V1_FIELDS: CollectionSchema["fields"] = [
  { name: "title", type: "text" },
  { name: "estimate", type: "number" },
  { name: "done", type: "checkbox" },
  { name: "due", type: "date" },
  { name: "status", type: "select", options: ["todo", "doing", "shipped"] },
  { name: "tags", type: "multi-select", options: ["alpha", "beta", "gamma"] },
  { name: "owner", type: "person" },
  { name: "blocks", type: "relation", collection: "tasks", many: true },
  { name: "link", type: "url" },
];

export function makeSchema(fields: CollectionSchema["fields"] = V1_FIELDS): CollectionSchema {
  return { name: "Tasks", description: null, fields, views: [] };
}

export function indexedValue(
  field: string,
  value: CollectionValue,
  extra?: Partial<CollectionIndexedValue>,
): CollectionIndexedValue {
  return {
    field,
    value,
    validation: { status: "valid" },
    resolvedRelations: [],
    ...extra,
  };
}

export function makeRecord(
  id: string,
  values: CollectionIndexedValue[] = [],
): CollectionRecord {
  return { id, path: `tasks/${id}.md`, conflicted: false, values };
}

export function makeSummary(): CollectionSummary {
  return { path: "tasks", status: "valid", reasons: [] };
}

export function makeQueryResult(
  records: CollectionRecord[],
  extra?: Partial<CollectionQueryResult>,
): CollectionQueryResult {
  return {
    collection: makeSummary(),
    records,
    groups: null,
    nextCursor: null,
    ...extra,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
