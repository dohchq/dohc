import { collectionWords } from "@dohc/interface-words/collections";
import { describe, expect, it } from "vitest";
import type { CollectionFieldType } from "../server/phoneCollections";
import { draftOf, editorKind, rowText, shownValue, valueOf } from "./collectionFields";

const files = { "file-1234567890abcdef": "receipt.pdf" };
const shown = (type: CollectionFieldType, value: Parameters<typeof shownValue>[1]) =>
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

  it("shows a web address as a link, a relation as its record IDs, and an attachment by its file's name", () => {
    expect(shown("url", "https://example.com/a")).toEqual({
      kind: "link",
      url: "https://example.com/a",
    });
    expect(shown("relation", "r-1")).toEqual({ kind: "text", text: "r-1" });
    expect(shown("relation", ["r-1", 2])).toEqual({ kind: "text", text: "r-1, 2" });
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
  const field = (type: CollectionFieldType, required = false, options: string[] = []) => ({
    type,
    name: "Status",
    required,
    options,
  });
  const choices = ["Unpaid", "Paid", "Waived"];

  it("edits the types the phone has an editor for, and not a date, a relation or an attachment", () => {
    for (const type of ["text", "number", "url", "checkbox", "select", "multi-select"] as const)
      expect(editorKind({ type })).toBe(type);
    for (const type of ["date", "relation", "attachment"] as const)
      expect(editorKind({ type })).toBeNull();
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

  it("saves typed text as it is, and an empty field as null unless the field needs a value", () => {
    expect(valueOf(field("text"), " Ana ")).toEqual({ value: " Ana " });
    expect(valueOf(field("text"), "")).toEqual({ value: null });
    expect(valueOf(field("text", true), "")).toEqual({
      problem: collectionWords.enterValue("Status"),
    });
  });

  it("saves a number as typed, with a decimal point or comma, and says when it isn't one", () => {
    expect(valueOf(field("number"), " 12.5 ")).toEqual({ value: 12.5 });
    expect(valueOf(field("number"), "-3")).toEqual({ value: -3 });
    expect(valueOf(field("number"), "2,5")).toEqual({ value: 2.5 });
    expect(valueOf(field("number"), "1e3")).toEqual({ value: 1000 });
    expect(valueOf(field("number"), "")).toEqual({ value: null });
    for (const typed of ["12a", "1.2.3", "Infinity", "0x10", "1e999", "-"])
      expect(valueOf(field("number"), typed), typed).toEqual({
        problem: collectionWords.enterNumber,
      });
  });

  it("saves a web address the Collection takes, and says when it isn't one", () => {
    expect(valueOf(field("url"), " https://dohc.example/a?b ")).toEqual({
      value: "https://dohc.example/a?b",
    });
    for (const typed of ["dohc.example", "ftp://dohc.example", "https://", "https://a b"])
      expect(valueOf(field("url"), typed), typed).toEqual({
        problem: collectionWords.enterWebAddress,
      });
  });

  it("saves a switch as true or false", () => {
    expect(valueOf(field("checkbox"), true)).toEqual({ value: true });
    expect(valueOf(field("checkbox"), false)).toEqual({ value: false });
  });

  it("saves one choice, or none, and several in the options' order", () => {
    expect(valueOf(field("select", false, choices), ["Paid"])).toEqual({ value: "Paid" });
    expect(valueOf(field("select", false, choices), [])).toEqual({ value: null });
    expect(valueOf(field("select", true, choices), [])).toEqual({
      problem: collectionWords.enterValue("Status"),
    });
    // A choice the field no longer has is left out.
    expect(valueOf(field("select", false, choices), ["Gone"])).toEqual({ value: null });
    expect(valueOf(field("multi-select", false, choices), ["Waived", "Unpaid"])).toEqual({
      value: ["Unpaid", "Waived"],
    });
    expect(valueOf(field("multi-select", true, choices), [])).toEqual({ value: [] });
  });
});
