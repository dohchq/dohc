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
  | "url";

export interface ScalarFieldDefinition {
  name: string;
  type: "text" | "number" | "checkbox" | "date" | "person" | "url";
}

export interface SelectFieldDefinition {
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

export type FieldDefinition =
  | ScalarFieldDefinition
  | SelectFieldDefinition
  | RelationFieldDefinition;

export type ViewKind = "table" | "board" | "calendar";
export type ViewSortDirection = "asc" | "desc";

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

export type CollectionSchemaReasonCode =
  | "invalid-yaml"
  | "root-not-mapping"
  | "root-collection-unsupported"
  | "unknown-property"
  | "expected-text"
  | "expected-mapping"
  | "expected-sequence"
  | "expected-boolean"
  | "missing-property"
  | "unknown-field-type"
  | "unknown-view-kind"
  | "invalid-sort-direction"
  | "empty-value"
  | "duplicate-value"
  | "reserved-field-name"
  | "invalid-relation-target"
  | "unknown-field-reference"
  | "record-too-large-for-adoption";

export interface CollectionSchemaReason {
  code: CollectionSchemaReasonCode;
  path: string;
}

export interface CollectionSchemaParseResult {
  status: "valid" | "degraded";
  schema: CollectionSchema;
  reasons: CollectionSchemaReason[];
}

export type FieldValueReasonCode =
  | "expected-text"
  | "expected-number"
  | "number-not-finite"
  | "expected-boolean"
  | "expected-sequence"
  | "invalid-date"
  | "unknown-option"
  | "duplicate-value"
  | "empty-person-id"
  | "invalid-record-id"
  | "invalid-url";

export interface FieldValueReason {
  code: FieldValueReasonCode;
  path: string;
}

export type FieldValueValidation =
  | { status: "valid" }
  | { status: "flagged"; reason: FieldValueReason };

export type CollectionJsonValue =
  | null
  | boolean
  | number
  | string
  | CollectionJsonValue[]
  | { [key: string]: CollectionJsonValue };

export type CollectionStatus = CollectionSchemaParseResult["status"];

export interface CollectionSummary {
  path: string;
  status: CollectionStatus;
  reasons: CollectionSchemaReason[];
}

export interface CollectionDetails extends CollectionSummary {
  schema: CollectionSchema;
  recordCount: number;
}

export type CollectionIndexedValueValidation =
  | FieldValueValidation
  | { status: "untyped" };

export interface CollectionResolvedRelation {
  recordId: string;
  label: string;
}

export interface CollectionIndexedValue {
  field: string;
  value: CollectionJsonValue;
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
  value: CollectionJsonValue;
  records: CollectionRecord[];
}

export type CollectionFilterOperator = "equals" | "contains";

export interface CollectionQueryFilter {
  field: string;
  operator: CollectionFilterOperator;
  value: CollectionJsonValue;
}

export interface CollectionQuerySort {
  field: string;
  direction: ViewSortDirection;
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
}

export interface CollectionQueryResult {
  collection: CollectionSummary;
  records: CollectionRecord[];
  groups: CollectionRecordGroup[] | null;
}

export interface CollectionGetRecordParams {
  collectionPath: string;
  recordId: string;
  historyLimit: number;
  beforeHistoryId?: number;
}

export interface CollectionHistoryValue {
  present: boolean;
  value: CollectionJsonValue;
}

export interface CollectionFieldHistoryEntry {
  historyId: number;
  field: string;
  previous: CollectionHistoryValue;
  next: CollectionHistoryValue;
  authorOriginId: string | null;
  recordedAtMs: number;
}

export interface CollectionGetRecordResult {
  collection: CollectionSummary;
  record: CollectionRecord;
  history: CollectionFieldHistoryEntry[];
}
