import { collectionWords } from "@dohc/interface-words/collections";
import { describe, expect, it } from "vitest";
import type { CollectionFieldType } from "../server/phoneCollections";
import { rowText, shownValue } from "./collectionFields";

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
