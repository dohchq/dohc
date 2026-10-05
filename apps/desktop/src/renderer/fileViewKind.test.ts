import { describe, expect, it } from "vitest";
import { FILE_KIND_RECORDS, fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { classifyForView } from "./fileViewKind";

// Independent corpus of the pre-registry dispatch, including every extension
// in its five sets and every extension handled before those sets.
const CORPUS = {
  markdown: ["md", "markdown"],
  drawing: ["excalidraw"],
  csv: ["csv", "tsv", "tab"],
  json: ["json"],
  text: [
    "txt", "html", "htm", "xml", "css", "scss", "sass", "less", "js", "jsx",
    "ts", "tsx", "mjs", "cjs", "yaml", "yml", "toml", "ini", "env", "log",
    "sql", "sh", "bash", "zsh", "ps1", "py", "rb", "go", "rs", "java", "c",
    "cpp", "h", "hpp",
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
      ])("preserves the display and opening record for %s", (path) => {
        expect(classifyForView(path)).toBe(kind);
        expect(fileKindForPath(path)).toBe(FILE_KIND_RECORDS[kind as keyof typeof CORPUS]);
        expect(fileKindForPath(path).opens.view).toBe(kind);
      });
    }
  }

  it.each(["README", "folder/README", "file.", "folder.md/README", "a.md.bak", "a.constructor", "a.__proto__"])(
    "preserves the fallback for %s", (path) => {
      expect(classifyForView(path)).toBe("binary");
      expect(fileKindForPath(path)).toBe(FILE_KIND_RECORDS.binary);
    },
  );

  it.each(["csv", "json", "txt", "yaml", "svg", "db", "mdx", "excalidraw.json"])(
    "does not infer live-document eligibility from the display record for %s", (extension) => {
      expect(liveDocumentKindForPath(`file.${extension}`)).toBeNull();
    },
  );

  it("keeps the live content kind distinct from its display kind", () => {
    expect(fileKindForPath("file.md").displayKind).toBe("markdown");
    expect(liveDocumentKindForPath("file.md")).toBe("richdoc");
    expect(fileKindForPath("file.excalidraw").displayKind).toBe("drawing");
    expect(liveDocumentKindForPath("file.excalidraw")).toBe("scene");
  });
});
