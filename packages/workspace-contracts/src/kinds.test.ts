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

  it("provides opening, action and reference metadata for every file kind", () => {
    for (const [kind, record] of Object.entries(FILE_KIND_RECORDS)) {
      expect(record.displayKind).toBe(kind);
      expect(record.displayNameRule).toBe("basename");
      expect(record.opens.surface).toBe("tab");
      expect(record.reference.shape).toBe("workspace-path");
      expect(record.actions).toContain("open");
    }
  });

  it("keeps text reads confined to the existing editors", () => {
    expect(Object.values(FILE_KIND_RECORDS)
      .filter((record) => record.opens.content === "text")
      .map((record) => record.displayKind)).toEqual(["markdown", "drawing", "csv", "json", "text", "code"]);
  });

  it("offers document serialization only for the Markdown view", () => {
    for (const record of Object.values(FILE_KIND_RECORDS)) {
      expect((record.actions as readonly string[]).includes("export-html")).toBe(record.displayKind === "markdown");
    }
  });

  // Names and Lucide IDs follow the drawing's kind list and icon map. Kinds
  // absent from that list keep their existing file labels and fallback glyph.
  it.each([
    ["plan.md", "Document", "file-text"],
    ["rows.csv", "CSV table", "file-spreadsheet"],
    ["main.ts", "Code or text", "file-code"],
    ["notes.txt", "Code or text", "file-text"],
    ["config.json", "Code or text", "file-text"],
    ["plan.excalidraw", "Drawing", "pen-tool"],
    ["photo.png", "Image", "image"],
    ["data.sqlite", "Database", "database"],
    ["memo.mp3", "Audio", "file-text"],
    ["paper.pdf", "Document", "file-text"],
    ["archive.bin", "File", "file-text"],
  ])("uses the drawing's name and glyph for %s", (path, name, glyphId) => {
    expect(fileKindForPath(path)).toMatchObject({ name, glyphId });
  });

  it.each(["txt", "log", "env", "ini", "html", "htm", "xml", "yaml", "yml", "toml"])(
    "uses a text glyph for %s while retaining text loading", (extension) => {
      expect(fileKindForPath(`file.${extension}`)).toMatchObject({
        displayKind: "text", glyphId: "file-text", opens: { content: "text" },
      });
    },
  );

  it.each(["js", "tsx", "css", "py", "rs", "sh", "sql"])(
    "uses a code glyph for %s while retaining text loading", (extension) => {
      expect(fileKindForPath(`file.${extension}`)).toMatchObject({
        displayKind: "code", glyphId: "file-code", opens: { content: "text" },
      });
    },
  );
});
