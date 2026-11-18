import { describe, expect, it } from "vitest";
import { readDescription, readPage, type CollectionTable } from "./phoneCollections";

const D = "00000000-0000-4000-8000-000000000001";
const table: CollectionTable = {
  tableId: "t-1",
  name: "People",
  primaryFieldId: "f-name",
  fields: [
    { fieldId: "f-name", name: "Name", type: "text" },
    { fieldId: "f-paid", name: "Paid", type: "checkbox" },
  ],
};
const described = {
  datasetId: D,
  name: "Registrations",
  tables: [{ ...table, fields: table.fields.map((field) => ({ ...field, options: ["x"] })) }],
};

describe("a Collection's description", () => {
  it("reads its tables and fields, and leaves out what the phone doesn't show", () => {
    expect(readDescription(described, D)).toEqual({
      datasetId: D,
      name: "Registrations",
      tables: [table],
    });
  });

  it("refuses another Collection, an unknown field type, and a primary field it doesn't list", () => {
    expect(readDescription(described, "other")).toBeNull();
    const withType = (type: string) => ({
      ...described,
      tables: [{ ...table, fields: [{ fieldId: "f-name", name: "Name", type }] }],
    });
    expect(readDescription(withType("formula"), D)).toBeNull();
    expect(readDescription(withType("button"), D)).toBeNull();
    expect(
      readDescription({ ...described, tables: [{ ...table, primaryFieldId: "f-gone" }] }, D),
    ).toBeNull();
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

  it("keeps the described fields of each record, the cursor and the file names", () => {
    expect(readPage(page({}), table)).toEqual({
      status: "ready",
      rows: [{ id: "a", values: { "f-name": "Ana", "f-paid": true } }],
      next: { id: "a", value: "Ana" },
      files: { "file-1": "receipt.pdf" },
    });
    expect(readPage(page({ nextCursor: null }), table)).toMatchObject({ next: null });
    expect(readPage(page({ rows: [row(7)] }), table)).toMatchObject({
      rows: [{ id: 7, values: {} }],
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
