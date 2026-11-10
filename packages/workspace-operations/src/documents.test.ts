import { describe, expect, it } from "vitest";
import { readDocument, type DocumentsHost } from "./documents";

function documents(files: Record<string, string>): DocumentsHost & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read: async (path) => {
      reads.push(path);
      const markdown = files[path];
      if (markdown === undefined) throw new Error(`${path} is not a document`);
      return { path, markdown };
    },
  };
}

describe("readDocument", () => {
  it("reads a document at its normalized path", async () => {
    const host = documents({ "notes/a.md": "# A\n" });
    expect(await readDocument(host, "./notes//a.md", "darwin")).toEqual({ ok: true, path: "notes/a.md", markdown: "# A\n" });
    expect(host.reads).toEqual(["notes/a.md"]);
  });

  it("answers a workspace without documents before checking the path", async () => {
    expect(await readDocument(undefined, "../escape.md", "darwin"))
      .toEqual({ ok: false, reason: "documents are not available in this workspace" });
  });

  it("refuses a path under the platform's rules without reading", async () => {
    const host = documents({});
    expect(await readDocument(host, ".dohc/engine/state", "darwin"))
      .toEqual({ ok: false, reason: "path rejected (reserved): .dohc/engine/state" });
    expect(await readDocument(host, "a:b.md", "win32"))
      .toEqual({ ok: false, reason: "path rejected (unsupported-name): a:b.md" });
    expect(host.reads).toEqual([]);
  });

  it("rejects with the host's failure, which the caller words", async () => {
    await expect(readDocument(documents({}), "notes/missing.md", "darwin")).rejects.toThrow("notes/missing.md is not a document");
  });
});
