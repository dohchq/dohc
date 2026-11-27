import { describe, expect, it } from "vitest";
import {
  readChangeAnswer,
  readCreateAnswer,
  readDeleteAnswer,
  readDescription,
  readPage,
  readRelationOptions,
  type CollectionField,
  type CollectionTable,
} from "./phoneCollections";

const D = "00000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);
const name: CollectionField = {
  fieldId: "f-name",
  name: "Name",
  type: "text",
  options: [],
  editable: true,
  reversible: true,
};
const paid: CollectionField = {
  fieldId: "f-paid",
  name: "Paid",
  type: "checkbox",
  options: [],
  editable: false,
  reversible: false,
};
const status: CollectionField = {
  fieldId: "f-status",
  name: "Status",
  type: "select",
  options: ["Unpaid", "Paid"],
  editable: true,
  reversible: false,
};
const table: CollectionTable = {
  tableId: "t-1",
  name: "People",
  primaryFieldId: "f-name",
  fields: [name, paid, status],
  createFields: [],
  canCreate: true,
  canDelete: false,
};
const described = {
  datasetId: D,
  name: "Registrations",
  revision: 3,
  revisionSha256: SHA,
  // A text field's options, which the phone has no use for.
  tables: [{ ...table, fields: [{ ...name, options: ["x"] }, paid, status] }],
};

describe("a Collection's description", () => {
  it("reads its rules' stamp, its tables and fields, and leaves out what the phone doesn't show", () => {
    expect(readDescription(described, D)).toEqual({
      datasetId: D,
      name: "Registrations",
      revision: 3,
      revisionSha256: SHA,
      tables: [table],
    });
  });

  it("refuses another Collection, an unknown field type, and a primary field it doesn't list", () => {
    expect(readDescription(described, "other")).toBeNull();
    const withType = (type: string) => ({
      ...described,
      tables: [{ ...table, fields: [{ ...name, type }] }],
    });
    expect(readDescription(withType("formula"), D)).toBeNull();
    expect(readDescription(withType("button"), D)).toBeNull();
    expect(
      readDescription({ ...described, tables: [{ ...table, primaryFieldId: "f-gone" }] }, D),
    ).toBeNull();
  });

  it("refuses a description without its stamp, a field without its edit flags, and a choice without options", () => {
    expect(readDescription({ ...described, revision: 0 }, D)).toBeNull();
    expect(readDescription({ ...described, revisionSha256: "abc" }, D)).toBeNull();
    const withField = (field: object) => ({
      ...described,
      tables: [{ ...table, fields: [name, field] }],
    });
    const { editable: _, ...unflagged } = paid;
    expect(readDescription(withField(unflagged), D)).toBeNull();
    expect(readDescription(withField({ ...status, options: undefined }), D)).toBeNull();
    expect(readDescription(withField({ ...status, options: ["Paid", 7] }), D)).toBeNull();
  });

  it("refuses a table without whether it takes new records and deletions", () => {
    const { canCreate: _, ...noCreate } = table;
    const { canDelete: __, ...noDelete } = table;
    expect(readDescription({ ...described, tables: [noCreate] }, D)).toBeNull();
    expect(readDescription({ ...described, tables: [noDelete] }, D)).toBeNull();
    expect(readDescription({ ...described, tables: [{ ...table, canDelete: 1 }] }, D)).toBeNull();
  });

  it("never marks a field reversible that the phone can't edit", () => {
    const field = { ...paid, reversible: true };
    expect(
      readDescription({ ...described, tables: [{ ...table, fields: [name, field] }] }, D)?.tables[0]
        ?.fields[1],
    ).toMatchObject({ editable: false, reversible: false });
  });

  it("reads createFields with defaults, options, and relation shape, and rejects malformed ones", () => {
    const createFields = [
      { fieldId: "f-code", name: "Code", type: "text", required: true },
      {
        fieldId: "f-status",
        name: "Status",
        type: "select",
        required: true,
        default: "Paid",
        options: ["Unpaid", "Paid"],
      },
      {
        fieldId: "f-org",
        name: "Org",
        type: "relation",
        required: true,
        relation: { many: false },
      },
    ];
    const parsed = readDescription({ ...described, tables: [{ ...table, createFields }] }, D);
    expect(parsed?.tables[0]?.createFields).toEqual([
      { fieldId: "f-code", name: "Code", type: "text", required: true, options: [] },
      {
        fieldId: "f-status",
        name: "Status",
        type: "select",
        required: true,
        default: "Paid",
        options: ["Unpaid", "Paid"],
      },
      {
        fieldId: "f-org",
        name: "Org",
        type: "relation",
        required: true,
        options: [],
        relation: { many: false },
      },
    ]);
    expect(
      readDescription(
        {
          ...described,
          tables: [
            {
              ...table,
              createFields: [{ fieldId: "f-org", name: "Org", type: "relation", required: true }],
            },
          ],
        },
        D,
      ),
    ).toBeNull();
    const { createFields: _, ...withoutCreateFields } = table;
    expect(readDescription({ ...described, tables: [withoutCreateFields] }, D)).toBeNull();
  });
});

describe("a page of records", () => {
  const row = (id: string | number, values: Record<string, unknown> = {}) => ({
    id,
    version: 1,
    values,
  });
  const page = (fields: Record<string, unknown>) => ({
    status: "ready",
    rows: [row("a", { "f-name": "Ana", "f-paid": true, "f-secret": "x" })],
    nextCursor: { id: "a", value: "Ana" },
    files: { "file-1": "receipt.pdf" },
    relations: { "f-org": { '"c-1"': "Acme" } },
    ...fields,
  });

  it("keeps each record's version, its described fields, the cursor, file names, and relation labels", () => {
    expect(readPage(page({}), table)).toEqual({
      status: "ready",
      rows: [{ id: "a", version: 1, values: { "f-name": "Ana", "f-paid": true } }],
      next: { id: "a", value: "Ana" },
      files: { "file-1": "receipt.pdf" },
      relations: { "f-org": { '"c-1"': "Acme" } },
    });
    expect(readPage(page({ nextCursor: null }), table)).toMatchObject({ next: null });
    expect(readPage(page({ rows: [row(7)] }), table)).toMatchObject({
      rows: [{ id: 7, values: {} }],
    });
  });

  it("reads a record with no version as one the phone can't change", () => {
    expect(readPage(page({ rows: [{ id: "a", values: {} }] }), table)).toMatchObject({
      rows: [{ id: "a", version: null }],
    });
    expect(readPage(page({ rows: [{ ...row("a"), version: 1.5 }] }), table)).toMatchObject({
      rows: [{ id: "a", version: null }],
    });
  });

  it("reads the refusal of a table nothing reads or whose custom read rejects search/sort", () => {
    expect(readPage({ status: "refused", reason: "no-read" }, table)).toEqual({
      status: "refused",
    });
    expect(readPage({ status: "refused", reason: "unsupported-query" }, table)).toEqual({
      status: "unsupported-query",
    });
    expect(readPage({ status: "refused", reason: "other" }, table)).toBeNull();
  });

  it("refuses a page with a repeated or invalid record, too many records, or a bad cursor", () => {
    expect(readPage(page({ rows: [row("a"), row("a")] }), table)).toBeNull();
    expect(readPage(page({ rows: [row(1.5)] }), table)).toBeNull();
    expect(readPage(page({ rows: [row("")] }), table)).toBeNull();
    expect(readPage(page({ rows: [{ id: "a", values: [] }] }), table)).toBeNull();
    expect(
      readPage(page({ rows: Array.from({ length: 51 }, (_, n) => row(n)) }), table),
    ).toBeNull();
    expect(readPage(page({ nextCursor: { id: "a" } }), table)).toBeNull();
    expect(readPage(page({ nextCursor: undefined }), table)).toBeNull();
    expect(readPage(page({ files: undefined }), table)).toBeNull();
    expect(readPage(page({ relations: undefined }), table)).toBeNull();
  });
});

describe("relation options", () => {
  it("reads options, cursor, and unsupported search flag, and rejects duplicates", () => {
    expect(
      readRelationOptions({
        options: [
          { value: "c-1", label: "Acme" },
          { value: 1.5, label: "Globex" },
        ],
        nextCursor: { id: 2, value: 2 },
      }),
    ).toEqual({
      options: [
        { value: "c-1", label: "Acme" },
        { value: 1.5, label: "Globex" },
      ],
      next: { id: 2, value: 2 },
      searchUnsupported: false,
    });
    expect(readRelationOptions({ options: [], nextCursor: null, searchUnsupported: true })).toEqual(
      { options: [], next: null, searchUnsupported: true },
    );
    expect(
      readRelationOptions({
        options: [
          { value: "c-1", label: "Acme" },
          { value: "c-1", label: "Other" },
        ],
        nextCursor: null,
      }),
    ).toBeNull();
  });
});

describe("the answer to a change", () => {
  it("reads a saved change with its prior value, or without one", () => {
    expect(readChangeAnswer({ saved: { version: 2, priorValue: "Unpaid" } })).toEqual({
      kind: "saved",
      version: 2,
      priorValue: "Unpaid",
    });
    expect(readChangeAnswer({ saved: { version: 2, priorValue: null } })).toEqual({
      kind: "saved",
      version: 2,
      priorValue: null,
    });
    expect(readChangeAnswer({ saved: { version: 2 } })).toEqual({ kind: "saved", version: 2 });
  });

  it("reads a refusal and a rules change", () => {
    expect(
      readChangeAnswer({ refused: { code: "stale_record", message: "This record changed." } }),
    ).toEqual({ kind: "refused", code: "stale_record", message: "This record changed." });
    expect(readChangeAnswer({ rulesChanged: true })).toEqual({ kind: "rulesChanged" });
  });

  it("refuses an answer it can't read", () => {
    expect(readChangeAnswer(null)).toBeNull();
    expect(readChangeAnswer({})).toBeNull();
    expect(readChangeAnswer({ saved: { version: 0 } })).toBeNull();
    expect(readChangeAnswer({ saved: { version: "2" } })).toBeNull();
    expect(readChangeAnswer({ refused: { code: "", message: "x" } })).toBeNull();
    expect(readChangeAnswer({ refused: { code: "x" } })).toBeNull();
    expect(readChangeAnswer({ rulesChanged: "yes" })).toBeNull();
  });
});

describe("the answer to a new record or a deletion", () => {
  it("reads a new record's key", () => {
    expect(readCreateAnswer({ saved: { id: "r-1", version: 1 } })).toEqual({
      kind: "saved",
      id: "r-1",
    });
    expect(readCreateAnswer({ saved: { id: 7, version: 1 } })).toEqual({ kind: "saved", id: 7 });
  });

  it("reads a deletion, and either's refusal and rules change", () => {
    expect(readDeleteAnswer({ saved: {} })).toEqual({ kind: "saved" });
    const refused = { refused: { code: "stale_record", message: "This record changed." } };
    expect(readDeleteAnswer(refused)).toEqual({ kind: "refused", ...refused.refused });
    expect(readCreateAnswer({ rulesChanged: true })).toEqual({ kind: "rulesChanged" });
  });

  it("refuses an answer it can't read", () => {
    expect(readCreateAnswer({ saved: { id: "", version: 1 } })).toBeNull();
    expect(readCreateAnswer({ saved: { id: "r-1", version: 0 } })).toBeNull();
    expect(readCreateAnswer({ saved: { version: 1 } })).toBeNull();
    expect(readDeleteAnswer({ saved: true })).toBeNull();
    expect(readDeleteAnswer({})).toBeNull();
  });
});
