export const COLLECTION_SCHEMA_FILENAME = "collection.yaml";
export const RECORD_ID_FRONTMATTER_KEY = "id";

export type CollectionFieldType =
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "select"
  | "multi-select"
  | "person"
  | "relation"
  | "url"
  | "button";

interface ScalarFieldDefinition {
  name: string;
  type: "text" | "number" | "checkbox" | "date" | "person" | "url";
}

interface SelectFieldDefinition {
  name: string;
  type: "select" | "multi-select";
  options: string[];
}

export interface RelationFieldDefinition {
  name: string;
  type: "relation";
  collection: string;
  many: boolean;
}

/** Shows a button on each record. It stores no value. */
interface ButtonFieldDefinition {
  name: string;
  type: "button";
}

export type FieldDefinition =
  | ScalarFieldDefinition
  | SelectFieldDefinition
  | RelationFieldDefinition
  | ButtonFieldDefinition;

export type ViewKind = "table" | "board" | "calendar";
type ViewSortDirection = "asc" | "desc";

export interface ViewSort {
  field: string;
  direction: ViewSortDirection;
}

export interface ViewDefinition {
  name: string;
  kind: ViewKind;
  groupBy: string | null;
  sort: ViewSort[];
  visibleFields: string[] | null;
  dateField: string | null;
}

export interface CollectionSchema {
  name: string | null;
  description: string | null;
  fields: FieldDefinition[];
  views: ViewDefinition[];
}

export const COLLECTION_SCHEMA_REASON_CODES = [
  "invalid-yaml",
  "root-not-mapping",
  "unsupported-version",
  "invalid-version",
  "root-collection-unsupported",
  "unknown-property",
  "expected-text",
  "expected-mapping",
  "expected-sequence",
  "expected-boolean",
  "missing-property",
  "unknown-field-type",
  "unknown-view-kind",
  "invalid-sort-direction",
  "empty-value",
  "duplicate-value",
  "field-name-collision",
  "reserved-field-name",
  "invalid-relation-target",
  "unknown-field-reference",
  "schema-collection-limit-exceeded",
  "record-too-large-for-adoption",
  "unsupported-field-reference",
] as const;

type CollectionSchemaReasonCode =
  (typeof COLLECTION_SCHEMA_REASON_CODES)[number];

export interface CollectionSchemaReason {
  code: CollectionSchemaReasonCode;
  path: string;
}

export function collectionVersionError(reasons: readonly CollectionSchemaReason[], file = COLLECTION_SCHEMA_FILENAME, reader: "dohc" | "sync service" = "dohc"): string | null {
  if (reasons.some(reason => reason.code === "unsupported-version")) {
    return `${file} uses a newer version. Update ${reader === "sync service" ? "the sync service" : "dohc"} to read this file.`;
  }
  if (reasons.some(reason => reason.code === "invalid-version")) {
    return `${file} has an invalid version. Set version to 1.`;
  }
  return null;
}

export interface CollectionSchemaParseResult {
  status: "valid" | "degraded";
  schema: CollectionSchema;
  reasons: CollectionSchemaReason[];
}

export const FIELD_VALUE_REASON_CODES = [
  "expected-text",
  "expected-number",
  "number-not-finite",
  "unsupported-tag",
  "value-depth-exceeded",
  "expected-boolean",
  "expected-sequence",
  "invalid-date",
  "unknown-option",
  "duplicate-value",
  "empty-person-id",
  "invalid-record-id",
  "invalid-url",
  "expected-empty",
] as const;

export type FieldValueReasonCode = (typeof FIELD_VALUE_REASON_CODES)[number];

interface FieldValueReason {
  code: FieldValueReasonCode;
  path: string;
}

export type FieldValueValidation =
  | { status: "valid" }
  | { status: "flagged"; reason: FieldValueReason };

export type CollectionValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | CollectionValue[]
  | { [key: string]: CollectionValue };

type CollectionStatus = CollectionSchemaParseResult["status"];

export interface CollectionSummary {
  path: string;
  status: CollectionStatus;
  reasons: CollectionSchemaReason[];
  /**
   * How many degradation reasons a byte-bounded `collections.list` page
   * dropped from `reasons`. Absent when the list is complete; the full list
   * stays readable through `collections.get`.
   */
  omittedReasons?: number;
}

interface CollectionDetails extends CollectionSummary {
  schema: CollectionSchema;
  recordCount: number;
}

type CollectionIndexedValueValidation =
  | FieldValueValidation
  | { status: "untyped" };

interface CollectionResolvedRelation {
  recordId: string;
  label: string;
}

export interface CollectionIndexedValue {
  field: string;
  value: CollectionValue;
  validation: CollectionIndexedValueValidation;
  resolvedRelations: CollectionResolvedRelation[];
}

export interface CollectionRecord {
  id: string;
  path: string;
  conflicted: boolean;
  values: CollectionIndexedValue[];
}

export interface CollectionRecordGroup {
  value: CollectionValue;
  records: CollectionRecord[];
}

type CollectionFilterOperator = "equals" | "contains";

export interface CollectionQueryFilter {
  field: string;
  operator: CollectionFilterOperator;
  value: CollectionValue;
}

export interface CollectionQuerySort {
  field: string;
  direction: ViewSortDirection;
}

interface CollectionQueryCursorValue {
  present: boolean;
  value: CollectionValue;
}

export interface CollectionQueryCursor {
  sortValues: CollectionQueryCursorValue[];
  recordPath: string;
  recordId: string;
}

export interface CollectionListResult {
  collections: CollectionSummary[];
}

export interface CollectionGetParams {
  collectionPath: string;
}

export type CollectionGetResult = CollectionDetails;

export interface CollectionQueryParams {
  collectionPath: string;
  filter?: CollectionQueryFilter;
  sort?: CollectionQuerySort[];
  groupBy?: string;
  resolveRelations?: boolean;
  limit?: number;
  cursor?: CollectionQueryCursor;
}

export interface CollectionQueryResult {
  collection: CollectionSummary;
  records: CollectionRecord[];
  groups: CollectionRecordGroup[] | null;
  nextCursor: CollectionQueryCursor | null;
}

export interface CollectionGetRecordParams {
  collectionPath: string;
  recordId: string;
  historyLimit: number;
  beforeHistoryId?: number;
}

interface CollectionHistoryValue {
  present: boolean;
  value: CollectionValue;
}

type CollectionChangeActorKind = "human" | "agent" | "automation";

interface CollectionFieldHistoryEntry {
  historyId: number;
  field: string;
  previous: CollectionHistoryValue;
  next: CollectionHistoryValue;
  authorOriginId: string | null;
  /** Declared actor kind, `null` for an unattributed write. */
  actorKind: CollectionChangeActorKind | null;
  /** The principal the actor acted for, `null` when undeclared. */
  onBehalfOf: string | null;
  /** Automation-chain depth, `null` for an unattributed write. */
  depth: number | null;
  recordedAtMs: number;
}

export interface CollectionGetRecordResult {
  collection: CollectionSummary;
  record: CollectionRecord;
  history: CollectionFieldHistoryEntry[];
  /**
   * Exclusive continuation cursor: pass as `beforeHistoryId` to read the next
   * newest-first history page. `null` when this page reached the oldest entry.
   */
  nextBeforeHistoryId: number | null;
}
