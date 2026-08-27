export const COLLECTION_SCHEMA_FILENAME = "collection.yaml";
export const RECORD_ID_FRONTMATTER_KEY = "id";
export const RECORD_ID_PREFIX = "rec_";
export const RECORD_ID_RANDOM_BASE32_LENGTH = 26;

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
  | "unknown-field-reference";

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
