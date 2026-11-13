import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileName } from "./cacheFiles";
import {
  createNoticeFiles,
  NOTICE_LIST_FOLDER,
  NOTICE_MARKS_FOLDER,
  NOTICE_MARKS_FORMAT,
} from "./noticeFiles";

// A file system in memory. A write lands half its text first and can be held there, as a closed app would leave it.
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  folders: new Set<string>(),
  heldWrites: null as Promise<void> | null,
}));
vi.mock("expo-file-system", () => {
  type Part = string | { readonly uri: string };
  const uriOf = (parts: readonly Part[]) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf("/"));
  class File {
    readonly uri: string;
    constructor(...parts: Part[]) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return disk.files.has(this.uri);
    }
    async text() {
      const text = disk.files.get(this.uri);
      if (text === undefined) throw new Error("The file couldn't be opened.");
      return text;
    }
    async write(text: string) {
      if (!disk.folders.has(parentOf(this.uri))) throw new Error("The folder doesn't exist.");
      disk.files.set(this.uri, text.slice(0, Math.floor(text.length / 2)));
      if (disk.heldWrites) await disk.heldWrites;
      disk.files.set(this.uri, text);
    }
    async move(to: File) {
      const text = disk.files.get(this.uri);
      if (text === undefined) throw new Error("path does not exist");
      disk.files.delete(this.uri);
      disk.files.set(to.uri, text);
    }
    delete() {
      if (!disk.files.delete(this.uri)) throw new Error("path does not exist");
    }
  }
  class Directory {
    readonly uri: string;
    constructor(...parts: Part[]) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return disk.folders.has(this.uri);
    }
    create() {
      disk.folders.add(this.uri);
    }
    delete() {
      disk.folders.delete(this.uri);
      for (const path of [...disk.files.keys()])
        if (path.startsWith(`${this.uri}/`)) disk.files.delete(path);
    }
  }
  return { Directory, File, Paths: { cache: "cache", document: "document" } };
});

const SCOPE = JSON.stringify(["https://dohc.example.com", "u1", "phone"]);
const OTHER = JSON.stringify(["https://dohc.example.com", "u2", "phone"]);
const marksPath = (scope: string) => `document/${NOTICE_MARKS_FOLDER}/${fileName(scope)}.json`;
const hold = () => {
  let release!: () => void;
  disk.heldWrites = new Promise<void>((done) => {
    release = done;
  });
  return () => {
    disk.heldWrites = null;
    release();
  };
};
const mark = { noticeId: "a", mark: "dismissed", atMs: 5 };

beforeEach(() => {
  disk.files.clear();
  disk.folders.clear();
  disk.heldWrites = null;
});

describe("the Notice files", () => {
  it("keep waiting marks in Documents, apart from the list in Caches, for the next launch", async () => {
    const first = createNoticeFiles();
    await first.writeMarks(SCOPE, [mark]);
    first.writeList(SCOPE, () => [{ noticeId: "a" }]);
    await first.flush();
    expect([...disk.files.keys()].sort()).toEqual([
      `cache/${NOTICE_LIST_FOLDER}/${fileName(SCOPE)}.json`,
      marksPath(SCOPE),
    ]);
    const next = createNoticeFiles();
    expect(await next.readMarks(SCOPE)).toEqual([mark]);
    expect(await next.readList(SCOPE)).toEqual([{ noticeId: "a" }]);
  });

  it("read nothing from another account's file, or another format's, and delete it", async () => {
    disk.folders.add(`document/${NOTICE_MARKS_FOLDER}`);
    disk.files.set(
      marksPath(SCOPE),
      JSON.stringify({ format: NOTICE_MARKS_FORMAT, scope: OTHER, marks: [mark] }),
    );
    expect(await createNoticeFiles().readMarks(SCOPE)).toBeNull();
    expect(disk.files.has(marksPath(SCOPE))).toBe(false);
    disk.files.set(
      marksPath(SCOPE),
      JSON.stringify({ format: NOTICE_MARKS_FORMAT + 1, scope: SCOPE, marks: [mark] }),
    );
    expect(await createNoticeFiles().readMarks(SCOPE)).toBeNull();
  });

  it("keep the last whole file when a write stops part way", async () => {
    const files = createNoticeFiles();
    await files.writeMarks(SCOPE, [mark]);
    const release = hold();
    void files.writeMarks(SCOPE, [mark, { ...mark, mark: "restore", atMs: 6 }]);
    // The app closes here: the next launch reads the file as it was.
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([mark]);
    release();
  });

  it("land nothing a write that began before a clear would have saved", async () => {
    const files = createNoticeFiles();
    const release = hold();
    const writing = files.writeMarks(SCOPE, [mark]);
    files.writeList(SCOPE, () => [{ noticeId: "a" }]);
    const cleared = files.clear();
    release();
    await writing;
    await cleared;
    await files.flush();
    expect([...disk.files.keys()]).toEqual([]);
    expect(await files.readMarks(SCOPE)).toBeNull();
  });
});
