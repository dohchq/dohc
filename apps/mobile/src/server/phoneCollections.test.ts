import { describe, expect, it } from "vitest";
import {
  readChangeAnswer,
  readDescription,
  readPage,
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

  it("never marks a field reversible that the phone can't edit", () => {
    const field = { ...paid, reversible: true };
    expect(
      readDescription({ ...described, tables: [{ ...table, fields: [name, field] }] }, D)?.tables[0]
        ?.fields[1],
    ).toMatchObject({ editable: false, reversible: false });
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
    ...fields,
  });

  it("keeps each record's version, its described fields, the cursor and the file names", () => {
    expect(readPage(page({}), table)).toEqual({
      status: "ready",
      rows: [{ id: "a", version: 1, values: { "f-name": "Ana", "f-paid": true } }],
      next: { id: "a", value: "Ana" },
      files: { "file-1": "receipt.pdf" },
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

  it("reads the refusal of a table nothing reads", () => {
    expect(readPage({ status: "refused", reason: "no-read" }, table)).toEqual({
      status: "refused",
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
