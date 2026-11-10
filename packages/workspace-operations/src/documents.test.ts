import { describe, expect, it } from "vitest";
import { listFiles, readDocument, readText, type DocumentsHost, type FilesHost, type FileTextRead, type WorkspaceFile } from "./documents";

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

function files(entries: Array<WorkspaceFile & { text?: string }>, fail?: Error): FilesHost & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads, maxTextBytes: 8, errorDetail: "operation-only",
    list: async () => {
      if (fail) throw fail;
      return entries.map(({ text: _text, ...file }) => file);
    },
    readText: async (path): Promise<FileTextRead> => {
      reads.push(path);
      if (fail) throw fail;
      const file = entries.find((entry) => entry.path === path);
      if (!file) return { kind: "missing" };
      return file.text === undefined ? { kind: "binary" } : { kind: "text", text: file.text, byteLength: new TextEncoder().encode(file.text).length };
    },
  };
}
const file = (path: string, text?: string): WorkspaceFile & { text?: string } =>
  ({ path, objectId: `object-${path}`, contentKind: text === undefined ? "binary" : "text", byteLength: text?.length ?? 3, ...(text === undefined ? {} : { text }) });

describe("listFiles", () => {
  const host = files([
    file("notes/b.md", "B"), file("Notes/a.md", "a"), file("notes/a.md", "A"), file("notes/deep/c.md", "C"),
    file("notes/.DS_Store"), file(".dohc/engine/state"), file("photo.png"), file("notes.md", "n"),
  ]);
  const paths = (result: Awaited<ReturnType<typeof listFiles>>) => result.ok ? { files: result.files.map((entry) => entry.path), folders: result.folders } : result;

  it("lists every file and folder in lexical order, leaving out ignored segments", async () => {
    expect(paths(await listFiles(host, {}, "darwin"))).toEqual({
      files: ["Notes/a.md", "notes.md", "notes/a.md", "notes/b.md", "notes/deep/c.md", "photo.png"],
      folders: ["Notes", "notes", "notes/deep"],
    });
  });

  it("matches the scope literally and case-sensitively, and only its direct entries when not recursive", async () => {
    expect(paths(await listFiles(host, { path: "notes" }, "darwin")))
      .toEqual({ files: ["notes/a.md", "notes/b.md", "notes/deep/c.md"], folders: ["notes", "notes/deep"] });
    expect(paths(await listFiles(host, { path: "./notes/", recursive: false }, "darwin")))
      .toEqual({ files: ["notes/a.md", "notes/b.md"], folders: ["notes", "notes/deep"] });
    expect(paths(await listFiles(host, { path: "notes/a.md" }, "darwin"))).toEqual({ files: ["notes/a.md"], folders: [] });
    expect(paths(await listFiles(host, { path: "NOTES" }, "darwin"))).toEqual({ files: [], folders: [] });
    expect(paths(await listFiles(host, { path: ".", recursive: false }, "darwin")))
      .toEqual({ files: ["notes.md", "photo.png"], folders: ["Notes", "notes"] });
  });

  it("refuses a scope by the read path rules, and words a host failure by its detail", async () => {
    expect(await listFiles(host, { path: "../x" }, "darwin")).toEqual({ ok: false, reason: "path rejected (traversal): ../x" });
    expect(await listFiles(host, { path: ".dohc/engine" }, "darwin")).toEqual({ ok: false, reason: "path rejected (reserved): .dohc/engine" });
    expect(await listFiles(files([], new Error("/srv/engine.db is locked")), {}, "darwin")).toEqual({ ok: false, reason: "failed to list files" });
  });
});

describe("readText", () => {
  const host = files([file("notes/a.md", "Alfama"), file("notes/long.txt", "123456789"), file("photo.png")]);

  it("reads a text file at its normalized path", async () => {
    expect(await readText(host, "./notes//a.md", "darwin")).toEqual({ ok: true, path: "notes/a.md", text: "Alfama" });
  });

  it("refuses a binary file and one over the host's limit by name, and answers a missing one", async () => {
    expect(await readText(host, "photo.png", "darwin")).toEqual({ ok: false, reason: "dohc: photo.png is not a text file.", refusal: "binary" });
    expect(await readText(host, "notes/long.txt", "darwin"))
      .toEqual({ ok: false, reason: "dohc: notes/long.txt is larger than 8 bytes.", refusal: "too-large" });
    expect(await readText(host, "notes/none.md", "darwin")).toEqual({ ok: false, reason: "dohc: No file at notes/none.md." });
  });

  it("refuses a path by the read path rules without reading, and words a host failure by its detail", async () => {
    const reads = host.reads.length;
    expect(await readText(host, ".dohc/engine/state", "darwin")).toEqual({ ok: false, reason: "path rejected (reserved): .dohc/engine/state" });
    expect(await readText(host, "notes/.DS_Store", "darwin")).toEqual({ ok: false, reason: "path rejected (reserved): notes/.DS_Store" });
    expect(host.reads.slice(reads)).toEqual([]);
    expect(await readText(files([], new Error("/srv/engine.db is locked")), "a.md", "darwin")).toEqual({ ok: false, reason: "failed to read file: a.md" });
  });
});
