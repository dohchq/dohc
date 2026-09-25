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
  referencedFieldIndex: number;
  expectedReasons: CollectionSchemaParseResult["reasons"];
}

interface SchemaReasonLimitVector {
  name: string;
  itemCount: number;
  expectedReasonCount: number;
  expectedTerminalReason: CollectionSchemaParseResult["reasons"][number];
}

interface SchemaOptionLimitVector {
  name: string;
  itemCount: number;
  expectedItemCount: number;
  expectedReasons: CollectionSchemaParseResult["reasons"];
}

const schemaVectors = schemaFixtureJson.vectors as SchemaVector[];
const fieldValueVectors = fieldValueFixtureJson.vectors as FieldValueVector[];
const recordIdVectors = recordIdFixtureJson.vectors as RecordIdVector[];
const schemaLimitVectors = schemaLimitFixtureJson.vectors as SchemaLimitVector[];
const reasonLimitVectors = schemaLimitFixtureJson.reasonVectors as SchemaReasonLimitVector[];
const optionLimitVectors = schemaLimitFixtureJson.optionVectors as SchemaOptionLimitVector[];

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

  it("treats hostile YAML mapping keys as data without prototype inheritance", () => {
    const parsed = parseCollectionSchema([
      "__proto__:",
      "  name: inherited-name",
      "constructor: root-constructor",
      "prototype: root-prototype",
      "fields:",
      "  Inherited type:",
      "    __proto__:",
      "      type: number",
      "  Nested hostile:",
      "    type: text",
      "    __proto__: nested-proto",
      "  __proto__:",
      "    type: text",
      "  constructor:",
      "    type: text",
      "  prototype:",
      "    type: text",
    ].join("\n"));

    expect(parsed.schema.name).toBeNull();
    expect(parsed.schema.fields).toEqual([
      { name: "Nested hostile", type: "text" },
      { name: "__proto__", type: "text" },
      { name: "constructor", type: "text" },
      { name: "prototype", type: "text" },
    ]);
    expect(parsed.reasons).toEqual(expect.arrayContaining([
      { code: "unknown-property", path: "/__proto__" },
      { code: "unknown-property", path: "/constructor" },
      { code: "unknown-property", path: "/prototype" },
      { code: "missing-property", path: "/fields/Inherited type/type" },
      { code: "unknown-property", path: "/fields/Nested hostile/__proto__" },
    ]));
    expect(({} as { name?: unknown }).name).toBeUndefined();
  });

  it("drops each view reference that sorts, groups, or dates by a button", () => {
    const parsed = parseCollectionSchema([
      "fields:",
      "  Due:",
      "    type: date",
      "  Mark paid:",
      "    type: button",
      "views:",
      "  - name: Board",
      "    kind: board",
      "    groupBy: Mark paid",
      "    visibleFields: [Mark paid]",
      "  - name: Calendar",
      "    kind: calendar",
      "    dateField: Mark paid",
      "    sort: [{ field: Due, direction: asc }, { field: Mark paid, direction: desc }]",
    ].join("\n"));

    expect(parsed.status).toBe("degraded");
    expect(parsed.reasons).toEqual([
      { code: "unsupported-field-reference", path: "/views/0/groupBy" },
      { code: "unsupported-field-reference", path: "/views/1/sort/1/field" },
      { code: "unsupported-field-reference", path: "/views/1/dateField" },
    ]);
    expect(parsed.schema.views.map(({ groupBy, sort, visibleFields, dateField }) => ({
      groupBy,
      sort,
      visibleFields,
      dateField,
    }))).toEqual([
      { groupBy: null, sort: [], visibleFields: ["Mark paid"], dateField: null },
      { groupBy: null, sort: [{ field: "Due", direction: "asc" }], visibleFields: null, dateField: null },
    ]);
  });

  it.each(schemaLimitVectors)("matches $name", ({
    itemCount,
    expectedItemCount,
    referencedFieldIndex,
    expectedReasons,
  }) => {
    const fields = Array.from(
      { length: itemCount },
      (_, index) => `  field_${index}:\n    type: text`,
    ).join("\n");
    const views = Array.from(
      { length: itemCount },
      (_, index) =>
        `  - name: View ${index}\n    kind: table${
          index === 0 ? `\n    groupBy: field_${referencedFieldIndex}` : ""
        }`,
    ).join("\n");

    const parsed = parseCollectionSchema(`fields:\n${fields}\nviews:\n${views}\n`);

    expect(parsed.status).toBe("degraded");
    expect(parsed.schema.fields).toHaveLength(expectedItemCount);
    expect(parsed.schema.views).toHaveLength(expectedItemCount);
    expect(parsed.schema.views[0]?.groupBy).toBeNull();
    expect(parsed.reasons).toEqual(expectedReasons);
  });

  it.each(reasonLimitVectors)("matches $name", ({
    itemCount,
    expectedReasonCount,
    expectedTerminalReason,
  }) => {
    const fields = Array.from(
      { length: itemCount },
      (_, index) => `  invalid_${index}: value`,
    ).join("\n");

    const parsed = parseCollectionSchema(`fields:\n${fields}\n`);

    expect(parsed.status).toBe("degraded");
    expect(parsed.schema.fields).toEqual([]);
    expect(parsed.reasons).toHaveLength(expectedReasonCount);
    expect(parsed.reasons.at(-1)).toEqual(expectedTerminalReason);
  });

  it.each(optionLimitVectors)("matches $name", ({
    itemCount,
    expectedItemCount,
    expectedReasons,
  }) => {
    const options = Array.from(
      { length: itemCount },
      (_, index) => `option_${index}`,
    );
    const parsed = parseCollectionSchema(
      `fields:\n  status:\n    type: select\n    options: ${JSON.stringify(options)}\n`,
    );

    expect(parsed.status).toBe("degraded");
    expect(parsed.schema.fields).toEqual([
      {
        name: "status",
        type: "select",
        options: options.slice(0, expectedItemCount),
      },
    ]);
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

  it.each([
    ["out-of-safe-range integer", 9_007_199_254_740_993n],
    ["out-of-safe-range integral float", 1e20],
  ])("accepts %s as a number-field value", (_name, value) => {
    expect(
      validateFieldValue(
        { name: "estimate", type: "number" },
        value,
      ),
    ).toEqual({ status: "valid" });
  });
});

describe("Record id contract vectors", () => {
  it.each(recordIdVectors)("classifies $value", ({ value, valid }) => {
    expect(isRecordId(value)).toBe(valid);
  });
});
