import { CORE_SCHEMA, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import fieldValueFixtureJson from "../../../crates/dohc-engine-domain/tests/fixtures/collection-field-values.json";
import recordIdFixtureJson from "../../../crates/dohc-engine-domain/tests/fixtures/collection-record-ids.json";
import schemaFixtureJson from "../../../crates/dohc-engine-domain/tests/fixtures/collection-schemas.json";
import type {
  CollectionSchemaParseResult,
  FieldDefinition,
  FieldValueValidation,
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

const schemaVectors = schemaFixtureJson.vectors as SchemaVector[];
const fieldValueVectors = fieldValueFixtureJson.vectors as FieldValueVector[];
const recordIdVectors = recordIdFixtureJson.vectors as RecordIdVector[];

describe("Collection schema contract vectors", () => {
  it.each(schemaVectors)("matches $name", ({ yaml, expected }) => {
    expect(() => parseCollectionSchema(yaml)).not.toThrow();
    expect(parseCollectionSchema(yaml)).toEqual(expected);
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
});

describe("Record id contract vectors", () => {
  it.each(recordIdVectors)("classifies $value", ({ value, valid }) => {
    expect(isRecordId(value)).toBe(valid);
  });
});
