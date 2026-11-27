import { collectionWords } from "@dohc/interface-words/collections";
import { afterEach, describe, expect, it } from "vitest";
import type { DatasetColumnFieldType } from "@dohc/security-contract/dataset";
import {
  dateOf,
  dayOf,
  draftOf,
  draftProblem,
  editorKind,
  recordName,
  rowText,
  shownValue,
  supportsSearch,
  supportsSort,
  valueOf,
} from "./collectionFields";

const files = { "file-1234567890abcdef": "receipt.pdf" };
const shown = (type: DatasetColumnFieldType, value: Parameters<typeof shownValue>[1]) =>
  shownValue({ type }, value, files);

describe("a field's value", () => {
  it("shows text, a number, and a choice or several as plain text", () => {
    expect(shown("text", "Ana")).toEqual({ kind: "text", text: "Ana" });
    expect(shown("number", 12.5)).toEqual({ kind: "text", text: "12.5" });
    expect(shown("select", "Paid")).toEqual({ kind: "text", text: "Paid" });
    expect(shown("multi-select", ["Red", "Blue"])).toEqual({ kind: "text", text: "Red, Blue" });
  });

  it("shows a checkbox as checked or not, whatever it holds", () => {
    expect(shown("checkbox", true)).toEqual({ kind: "check", checked: true });
    expect(shown("checkbox", false)).toEqual({ kind: "check", checked: false });
    expect(shown("checkbox", null)).toEqual({ kind: "check", checked: false });
  });

  it("shows a day, or a day and time, as the locale writes them", () => {
    expect(shown("date", "2026-11-18")).toEqual({
      kind: "text",
      text: new Date(2026, 10, 18).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    });
    const moment = "2026-11-18T09:30:00Z";
    expect(shown("date", moment)).toEqual({
      kind: "text",
      text: new Date(moment).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    });
    expect(shown("date", "soon")).toEqual({ kind: "text", text: "soon" });
  });

  it("shows a web address as a link, a relation by resolved labels or raw IDs, and an attachment by its file's name", () => {
    expect(shown("url", "https://example.com/a")).toEqual({
      kind: "link",
      url: "https://example.com/a",
    });
    expect(shown("relation", "r-1")).toEqual({ kind: "text", text: "r-1" });
    expect(shown("relation", ["r-1", 2])).toEqual({ kind: "text", text: "r-1, 2" });
    expect(shownValue({ type: "relation" }, "r-1", files, { '"r-1"': "Acme Corp" })).toEqual({
      kind: "text",
      text: "Acme Corp",
    });
    expect(
      shownValue({ type: "relation" }, ["r-1", 2], files, { '"r-1"': "Acme Corp", "2": "Globex" }),
    ).toEqual({ kind: "text", text: "Acme Corp, Globex" });
    expect(shown("attachment", "file-1234567890abcdef")).toEqual({
      kind: "text",
      text: "receipt.pdf",
    });
    expect(shown("attachment", "file-without-a-name0")).toEqual({
      kind: "text",
      text: collectionWords.attachedFile,
    });
  });

  it("shows nothing for an empty value", () => {
    for (const value of [undefined, null, "", []])
      expect(shown("text", value)).toEqual({ kind: "empty" });
  });
});

describe("a value in a record's row", () => {
  it("names a checked checkbox by its field, and leaves out an unchecked or empty one", () => {
    expect(rowText({ kind: "check", checked: true }, "Paid")).toBe("Paid");
    expect(rowText({ kind: "check", checked: false }, "Paid")).toBeNull();
    expect(rowText({ kind: "empty" }, "Name")).toBeNull();
    expect(rowText({ kind: "link", url: "https://example.com" }, "Site")).toBe(
      "https://example.com",
    );
    expect(rowText({ kind: "text", text: "Ana" }, "Name")).toBe("Ana");
  });
});

describe("a field's editor", () => {
  const field = (type: DatasetColumnFieldType, options: string[] = []) => ({ type, options });
  const choices = ["Unpaid", "Paid", "Waived"];

  it("edits the types the phone has an editor for, including readable relations, and not attachments or unreadable relations", () => {
    for (const type of [
      "text",
      "number",
      "url",
      "checkbox",
      "select",
      "multi-select",
      "date",
    ] as const)
      expect(editorKind({ type })).toBe(type);
    expect(editorKind({ type: "relation", relation: { many: false } })).toBe("relation");
    expect(editorKind({ type: "relation", relation: { many: true } })).toBe("relation");
    expect(editorKind({ type: "relation" })).toBeNull();
    expect(editorKind({ type: "attachment" })).toBeNull();
  });

  it("starts from the record's value", () => {
    expect(draftOf({ type: "text" }, "Ana")).toBe("Ana");
    expect(draftOf({ type: "text" }, null)).toBe("");
    expect(draftOf({ type: "number" }, 12.5)).toBe("12.5");
    expect(draftOf({ type: "url" }, undefined)).toBe("");
    expect(draftOf({ type: "checkbox" }, true)).toBe(true);
    expect(draftOf({ type: "checkbox" }, null)).toBe(false);
    expect(draftOf({ type: "select" }, "Paid")).toEqual(["Paid"]);
    expect(draftOf({ type: "select" }, null)).toEqual([]);
    expect(draftOf({ type: "multi-select" }, ["Paid", 3])).toEqual(["Paid"]);
  });

  it("saves typed text as it is, and an empty field as null", () => {
    expect(valueOf(field("text"), " Ana ")).toEqual({ value: " Ana " });
    expect(valueOf(field("text"), "")).toEqual({ value: null });
  });

  it("saves a number as typed, with a decimal point or comma, and nothing for text that isn't one", () => {
    expect(valueOf(field("number"), " 12.5 ")).toEqual({ value: 12.5 });
    expect(valueOf(field("number"), "-3")).toEqual({ value: -3 });
    expect(valueOf(field("number"), "2,5")).toEqual({ value: 2.5 });
    expect(valueOf(field("number"), "1e3")).toEqual({ value: 1000 });
    expect(valueOf(field("number"), "")).toEqual({ value: null });
    // Never NaN, Infinity, or the null either would send as.
    for (const typed of ["12a", "1.2.3", "Infinity", "NaN", "0x10", "1e999", "-"])
      expect(valueOf(field("number"), typed), typed).toBeNull();
  });

  it("saves a web address as typed, for the Collection to check", () => {
    expect(valueOf(field("url"), " https://dohc.example/a?b ")).toEqual({
      value: "https://dohc.example/a?b",
    });
    expect(valueOf(field("url"), "dohc.example")).toEqual({ value: "dohc.example" });
    expect(valueOf(field("url"), " ")).toEqual({ value: null });
  });

  it("saves a switch as true or false", () => {
    expect(valueOf(field("checkbox"), true)).toEqual({ value: true });
    expect(valueOf(field("checkbox"), false)).toEqual({ value: false });
  });

  it("saves one choice, or none, and several in the options' order", () => {
    expect(valueOf(field("select", choices), ["Paid"])).toEqual({ value: "Paid" });
    expect(valueOf(field("select", choices), [])).toEqual({ value: null });
    // A choice the field no longer has is left out.
    expect(valueOf(field("select", choices), ["Gone"])).toEqual({ value: null });
    expect(valueOf(field("multi-select", choices), ["Waived", "Unpaid"])).toEqual({
      value: ["Unpaid", "Waived"],
    });
    expect(valueOf(field("multi-select", choices), [])).toEqual({ value: [] });
  });

  it("starts a date from the record's day, or today", () => {
    expect(draftOf({ type: "date" }, "2026-11-14")).toBe("2026-11-14");
    for (const value of [null, undefined, "", "2026-02-30", "2026-11-18T09:30:00Z"])
      expect(draftOf({ type: "date" }, value), String(value)).toBe(dayOf(new Date()));
  });

  it("saves a picked day, and Clear as null, and keeps form dates empty when asked", () => {
    expect(valueOf(field("date"), "2026-11-14")).toEqual({ value: "2026-11-14" });
    expect(valueOf(field("date"), "")).toEqual({ value: null });
    expect(draftOf({ type: "date" }, undefined, { emptyDate: true })).toBe("");
  });

  it("handles single and many relations in drafts and saved values", () => {
    const single = { type: "relation" as const, options: [], relation: { many: false } };
    const many = { type: "relation" as const, options: [], relation: { many: true } };
    expect(draftOf(single, "c-1")).toEqual(["c-1"]);
    expect(draftOf(single, 7)).toEqual([7]);
    expect(draftOf(single, null)).toEqual([]);
    expect(draftOf(many, ["t-1", 2, ""])).toEqual(["t-1", 2]);
    expect(valueOf(single, ["c-1"])).toEqual({ value: "c-1" });
    expect(valueOf(single, [])).toEqual({ value: null });
    expect(valueOf(many, ["t-1", 2])).toEqual({ value: ["t-1", 2] });
    expect(valueOf(many, [])).toEqual({ value: [] });
  });

  it("checks required fields, numbers, urls, and relation limits in new-record forms", () => {
    expect(draftProblem({ name: "Name", type: "text", required: true, options: [] }, "")).toBe(
      collectionWords.enterField("Name"),
    );
    expect(
      draftProblem(
        { name: "Org", type: "relation", required: true, options: [], relation: { many: false } },
        [],
      ),
    ).toBe(collectionWords.chooseField("Org"));
    expect(
      draftProblem({ name: "Amount", type: "number", required: false, options: [] }, "abc"),
    ).toBe(collectionWords.enterNumber);
    expect(
      draftProblem({ name: "Site", type: "url", required: false, options: [] }, "ftp://x"),
    ).toBe(collectionWords.enterUrl);
    expect(
      draftProblem({ name: "Site", type: "url", required: false, options: [] }, "https://dohc.dev"),
    ).toBeNull();
    expect(
      draftProblem(
        { name: "Tags", type: "relation", required: false, options: [], relation: { many: true } },
        Array.from({ length: 101 }, (_, i) => `t-${i}`),
      ),
    ).toBe(collectionWords.tooManyRelations);
  });

  it("preserves decimal relation keys through drafts and values", () => {
    const single = { type: "relation" as const, options: [], relation: { many: false } };
    const many = { type: "relation" as const, options: [], relation: { many: true } };
    expect(draftOf(single, 1.5)).toEqual([1.5]);
    expect(valueOf(single, [1.5])).toEqual({ value: 1.5 });
    expect(draftOf(many, [1.5, 2.25])).toEqual([1.5, 2.25]);
    expect(valueOf(many, [1.5, 2.25])).toEqual({ value: [1.5, 2.25] });
  });

  it("identifies searchable and sortable fields accurately", () => {
    expect(supportsSearch([{ type: "number" }, { type: "checkbox" }])).toBe(false);
    expect(supportsSearch([{ type: "select" }])).toBe(true);
    expect(supportsSort({ type: "text" })).toBe(true);
    expect(supportsSort({ type: "attachment" })).toBe(false);
    expect(supportsSort({ type: "multi-select" })).toBe(false);
    expect(supportsSort({ type: "relation", relation: { many: false } })).toBe(true);
    expect(supportsSort({ type: "relation", relation: { many: true } })).toBe(false);
    expect(supportsSort({ type: "relation" })).toBe(false);
  });
});

describe("a date field's day", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  // UTC+14 and UTC-11: a local midnight read or written through UTC lands on the day before or after.
  for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"])
    it(`keeps the calendar day both ways in ${tz}`, () => {
      process.env.TZ = tz;
      const picked = dateOf("2026-11-14");
      expect(picked?.getFullYear()).toBe(2026);
      expect(picked?.getMonth()).toBe(10);
      expect(picked?.getDate()).toBe(14);
      expect(dayOf(picked!)).toBe("2026-11-14");
      // A pick late on the 14th, local time, is still the 14th.
      expect(dayOf(new Date(2026, 10, 14, 23, 59))).toBe("2026-11-14");
      expect(dayOf(new Date(2026, 10, 14, 0, 0))).toBe("2026-11-14");
    });

  it("proves the zone took: Kiritimati's local midnight is the day before in UTC", () => {
    process.env.TZ = "Pacific/Kiritimati";
    expect(dateOf("2026-11-14")?.toISOString().slice(0, 10)).toBe("2026-11-13");
  });

  it("reads only a real day", () => {
    for (const day of ["2026-02-30", "2026-13-01", "26-11-14", "2026-11-14T00:00", ""])
      expect(dateOf(day), day).toBeNull();
    expect(dayOf(dateOf("0099-01-02")!)).toBe("0099-01-02");
  });
});

describe("recordName", () => {
  const name = {
    fieldId: "f-name",
    name: "Name",
    type: "text",
    options: [],
    editable: true,
    reversible: true,
  } as const;
  it("names a record by its naming field, or Untitled when that's empty or only spaces", () => {
    expect(recordName(name, { "f-name": "Seed signup" }, {})).toBe("Seed signup");
    expect(recordName(name, { "f-name": "   " }, {})).toBe(collectionWords.untitledRecord);
    expect(recordName(name, {}, {})).toBe(collectionWords.untitledRecord);
    expect(recordName(null, {}, {})).toBe(collectionWords.untitledRecord);
  });
});
