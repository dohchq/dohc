import { describe, expect, it } from "vitest";
import { FILE_KIND_RECORDS, fileKindForPath } from "@dohc/workspace-contracts/kinds";

// Independent corpus of the original extension sets, now split into code,
// data and plain-text display kinds. FileInspector's tests pin their shared
// editor.
const CORPUS = {
  markdown: ["md", "markdown"],
  drawing: ["excalidraw"],
  csv: ["csv", "tsv", "tab"],
  json: ["json", "xml", "yaml", "yml", "toml", "ini", "env"],
  text: ["txt", "log"],
  code: [
    "css", "scss", "sass", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs",
    "sql", "sh", "bash", "zsh", "ps1", "py", "rb", "go", "rs", "java", "c",
    "cpp", "h", "hpp", "html", "htm",
  ],
  image: ["png", "jpg", "jpeg", "webp", "gif", "svg"],
  audio: ["m4a", "mp3", "wav", "ogg"],
  pdf: ["pdf"],
  database: ["sqlite", "sqlite3", "db"],
  binary: ["bin", "mdx", "avif", "bmp", "jsonl", "ndjson", "mts", "cts", "mp4", "zip"],
} as const;

describe("file display classification corpus", () => {
  for (const [kind, extensions] of Object.entries(CORPUS)) {
    for (const extension of extensions) {
      it.each([
        `file.${extension}`,
        `folder/file.${extension.toUpperCase()}`,
        `folder.with.dots/file.${extension}`,
        `folder\\file.${extension}`,
        `.${extension}`,
      ])("selects the display record for %s", (path) => {
        const record = fileKindForPath(path);
        expect(record.displayKind).toBe(kind);
        expect(record).toBe(FILE_KIND_RECORDS[kind as keyof typeof CORPUS]);
      });
    }
  }

  it.each(["README", "folder/README", "file.", "folder.md/README", "a.md.bak", "a.constructor", "a.__proto__"])(
    "preserves the fallback for %s", (path) => {
      expect(fileKindForPath(path)).toBe(FILE_KIND_RECORDS.binary);
    },
  );

  it.each([
    ["file.csv", "csv", "text"],
    ["file.json", "json", "text"],
    ["file.yaml", "json", "text"],
    ["file.log", "text", "text"],
    ["file.html", "code", "text"],
    ["file.ts", "code", "text"],
    ["file.excalidraw.json", "json", "text"],
    ["file.svg", "image", "asset"],
    ["file.db", "database", "database"],
    ["file.mdx", "binary", "unsupported"],
  ])("keeps the display and content route for %s", (path, displayKind, content) => {
    expect(fileKindForPath(path)).toMatchObject({ displayKind, opens: { content } });
  });
});
