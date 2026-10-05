import { describe, expect, it } from "vitest";
import { FILE_KIND_RECORDS, fileKindForPath } from "./kinds";

describe("file kind records", () => {
  it("gives each extension one display owner", () => {
    const owners = new Map<string, string>();
    for (const [kind, record] of Object.entries(FILE_KIND_RECORDS)) {
      for (const extension of record.extensions) {
        expect(extension).toBe(extension.toLowerCase());
        expect(owners.has(extension), `${extension} belongs to both ${owners.get(extension)} and ${kind}`).toBe(false);
        owners.set(extension, kind);
      }
    }
  });

  it("provides display, opening, action and reference metadata for every file kind", () => {
    expect(Object.keys(FILE_KIND_RECORDS)).toEqual([
      "markdown", "drawing", "csv", "json", "text", "image", "audio", "pdf", "database", "binary",
    ]);
    for (const [kind, record] of Object.entries(FILE_KIND_RECORDS)) {
      expect(record.displayKind).toBe(kind);
      expect(record.glyphId).not.toBe("");
      expect(record.displayNameRule).toBe("basename");
      expect(record.opens.surface).toBe("tab");
      expect(record.opens.view).toBe(kind);
      expect(record.reference.shape).toBe("workspace-path");
      expect(record.actions).toContain("open");
    }
  });

  it("keeps text reads confined to the existing five text views", () => {
    expect(Object.values(FILE_KIND_RECORDS)
      .filter((record) => record.opens.content === "text")
      .map((record) => record.displayKind)).toEqual(["markdown", "drawing", "csv", "json", "text"]);
  });

  it("offers document serialization only for the Markdown view", () => {
    for (const record of Object.values(FILE_KIND_RECORDS)) {
      expect((record.actions as readonly string[]).includes("export-html")).toBe(record.displayKind === "markdown");
    }
  });

  it("ignores extension names inherited from a poisoned object prototype", () => {
    Object.defineProperty(Object.prototype, "poisonedextension", {
      configurable: true,
      value: FILE_KIND_RECORDS.markdown,
    });
    try {
      expect(fileKindForPath("file.poisonedextension")).toBe(FILE_KIND_RECORDS.binary);
    } finally {
      delete (Object.prototype as Record<string, unknown>).poisonedextension;
    }
  });
});
