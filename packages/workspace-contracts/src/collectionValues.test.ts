import { CORE_SCHEMA, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import fieldValueFixtureJson from "../../../crates/dohc-engine-domain/tests/fixtures/collection-field-values.json";
import recordIdFixtureJson from "../../../crates/dohc-engine-domain/tests/fixtures/collection-record-ids.json";
import reasonCodeFixtureJson from "../../../crates/dohc-engine-domain/tests/fixtures/collection-reason-codes.json";
import schemaLimitFixtureJson from "../../../crates/dohc-engine-domain/tests/fixtures/collection-schema-limits.json";
import schemaFixtureJson from "../../../crates/dohc-engine-domain/tests/fixtures/collection-schemas.json";
import type {
  CollectionSchemaParseResult,
  FieldDefinition,
  FieldValueValidation,
} from "./collection";
import {
  COLLECTION_SCHEMA_REASON_CODES,
  FIELD_VALUE_REASON_CODES,
} from "./collection";
import {
  isRecordId,
  parseCollectionSchema,
  validateFieldValue,
} from "./collectionValues";

interface SchemaVector {
  name: string;
  yaml: string;
  expected: CollectionSchemaParseResult;
}

interface FieldValueVector {
  name: string;
  field: FieldDefinition;
  valueYaml: string;
  expected: FieldValueValidation;
}

interface RecordIdVector {
  value: string;
  valid: boolean;
}

interface SchemaLimitVector {
  name: string;
  itemCount: number;
  expectedItemCount: number;
  expectedReasons: CollectionSchemaParseResult["reasons"];
}

const schemaVectors = schemaFixtureJson.vectors as SchemaVector[];
const fieldValueVectors = fieldValueFixtureJson.vectors as FieldValueVector[];
const recordIdVectors = recordIdFixtureJson.vectors as RecordIdVector[];
const schemaLimitVectors = schemaLimitFixtureJson.vectors as SchemaLimitVector[];

describe("Collection reason-code contract", () => {
  it("matches the shared full reason-code set", () => {
    expect(COLLECTION_SCHEMA_REASON_CODES).toEqual(
      reasonCodeFixtureJson.schemaReasonCodes,
    );
    expect(FIELD_VALUE_REASON_CODES).toEqual(
      reasonCodeFixtureJson.fieldValueReasonCodes,
    );
  });
});

describe("Collection schema contract vectors", () => {
  it.each(schemaVectors)("matches $name", ({ yaml, expected }) => {
    expect(() => parseCollectionSchema(yaml)).not.toThrow();
    expect(parseCollectionSchema(yaml)).toEqual(expected);
  });

  it.each(["", "fields: ["])("returns fresh arrays for empty schema result from %j", (yaml) => {
    const first = parseCollectionSchema(yaml);
    first.schema.fields.push({ name: "Title", type: "text" });
    first.schema.views.push({
      name: "All",
      kind: "table",
      groupBy: null,
      sort: [],
      visibleFields: null,
      dateField: null,
    });

    const second = parseCollectionSchema(yaml);
    expect(second.schema.fields).toEqual([]);
    expect(second.schema.views).toEqual([]);
  });

  it.each(schemaLimitVectors)("matches $name", ({ itemCount, expectedItemCount, expectedReasons }) => {
    const fields = Array.from(
      { length: itemCount },
      (_, index) => `  field_${index}:\n    type: text`,
    ).join("\n");
    const views = Array.from(
      { length: itemCount },
      (_, index) => `  - name: View ${index}\n    kind: table`,
    ).join("\n");

    const parsed = parseCollectionSchema(`fields:\n${fields}\nviews:\n${views}\n`);

    expect(parsed.status).toBe("degraded");
    expect(parsed.schema.fields).toHaveLength(expectedItemCount);
    expect(parsed.schema.views).toHaveLength(expectedItemCount);
    expect(parsed.reasons).toEqual(expectedReasons);
  });
});

describe("Field value contract vectors", () => {
  it.each(fieldValueVectors)("matches $name", ({ field, valueYaml, expected }) => {
    const value: unknown = load(valueYaml, { schema: CORE_SCHEMA, json: true });
    const beforeField = JSON.stringify(field);
    const beforeValue = JSON.stringify(value);
    expect(validateFieldValue(field, value)).toEqual(expected);
    expect(JSON.stringify(field)).toBe(beforeField);
    expect(JSON.stringify(value)).toBe(beforeValue);
  });

  it("accepts a lossless integer as a number-field value", () => {
    expect(
      validateFieldValue(
        { name: "estimate", type: "number" },
        9_007_199_254_740_993n,
      ),
    ).toEqual({ status: "valid" });
  });
});

describe("Record id contract vectors", () => {
  it.each(recordIdVectors)("classifies $value", ({ value, valid }) => {
    expect(isRecordId(value)).toBe(valid);
  });
});
