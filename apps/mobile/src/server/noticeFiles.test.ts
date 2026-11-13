import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileName } from "./cacheFiles";
import {
  createNoticeFiles,
  NOTICE_LIST_FOLDER,
  NOTICE_LIST_FORMAT,
  NOTICE_MARKS_FOLDER,
  NOTICE_MARKS_FORMAT,
} from "./noticeFiles";

// A file system in memory, as expo-file-system 58 behaves: a write lands half its text first and can be held there,
// as a closed app would leave it, or fail there, as a full disk would. A move over a file deletes that file first, then
// can fail before it moves.
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  folders: new Set<string>(),
  heldWrites: null as Promise<void> | null,
  /** Called when a write stops at the hold. */
  onHeld: null as (() => void) | null,
  failMoveAfterDelete: false,
  /** Writes to files under this folder fail after their first half lands. */
  failWritesIn: null as string | null,
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
      if (disk.failWritesIn !== null && this.uri.startsWith(`${disk.failWritesIn}/`))
        throw new Error("No space left on device.");
      if (disk.heldWrites) {
        disk.onHeld?.();
        await disk.heldWrites;
      }
      disk.files.set(this.uri, text);
    }
    async move(to: File, options?: { overwrite?: boolean }) {
      const text = disk.files.get(this.uri);
      if (text === undefined) throw new Error("path does not exist");
      if (disk.files.has(to.uri)) {
        if (!options?.overwrite) throw new Error("already exists");
        disk.files.delete(to.uri);
      }
      if (disk.failMoveAfterDelete) throw new Error("The move failed.");
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
const MARKS = `document/${NOTICE_MARKS_FOLDER}`;
const slotPath = (slot: 0 | 1) => `${MARKS}/${fileName(SCOPE)}.${slot}.json`;
const listPath = `cache/${NOTICE_LIST_FOLDER}/${fileName(SCOPE)}.json`;
const slotText = (generation: number, marks: unknown[], scope = SCOPE) =>
  JSON.stringify({ format: NOTICE_MARKS_FORMAT, scope, generation, marks });
/** Holds the next writes part way. `reached` resolves once one stops there. */
const hold = () => {
  let release!: () => void;
  disk.heldWrites = new Promise<void>((done) => {
    release = done;
  });
  const reached = new Promise<void>((done) => {
    disk.onHeld = done;
  });
  return {
    reached,
    release() {
      disk.heldWrites = null;
      disk.onHeld = null;
      release();
    },
  };
};
const mark = (atMs: number) => ({ noticeId: "a", mark: "dismissed", atMs });

beforeEach(() => {
  disk.files.clear();
  disk.folders.clear();
  disk.heldWrites = null;
  disk.onHeld = null;
  disk.failMoveAfterDelete = false;
  disk.failWritesIn = null;
});

describe("the Notice files", () => {
  it("keep waiting marks in Documents, apart from the list in Caches, for the next launch", async () => {
    const first = createNoticeFiles();
    await first.writeMarks(SCOPE, [mark(1)]);
    first.writeList(SCOPE, () => [{ noticeId: "a" }]);
    await first.flush();
    expect([...disk.files.keys()].sort()).toEqual([listPath, slotPath(0)]);
    const next = createNoticeFiles();
    expect(await next.readMarks(SCOPE)).toEqual([mark(1)]);
    expect(await next.readList(SCOPE)).toEqual([{ noticeId: "a" }]);
  });

  it("alternate the two slots, and read the newest that parses and checks", async () => {
    const files = createNoticeFiles();
    await files.writeMarks(SCOPE, [mark(1)]);
    await files.writeMarks(SCOPE, [mark(2)]);
    await files.writeMarks(SCOPE, [mark(3)]);
    expect(disk.files.get(slotPath(0))).toBe(slotText(3, [mark(3)]));
    expect(disk.files.get(slotPath(1))).toBe(slotText(2, [mark(2)]));
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([mark(3)]);

    // A newer slot that doesn't parse, or is another account's or format's, doesn't count.
    disk.files.set(slotPath(1), slotText(4, [mark(4)]).slice(0, 20));
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([mark(3)]);
    disk.files.set(slotPath(1), slotText(4, [mark(4)], OTHER));
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([mark(3)]);
    disk.files.set(
      slotPath(1),
      JSON.stringify({ format: NOTICE_MARKS_FORMAT + 1, scope: SCOPE, generation: 4, marks: [] }),
    );
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([mark(3)]);
  });

  it("keep the last whole save when the app closes part way through a save", async () => {
    const files = createNoticeFiles();
    await files.writeMarks(SCOPE, [mark(1)]);
    await files.writeMarks(SCOPE, [mark(2)]);
    const held = hold();
    void files.writeMarks(SCOPE, [mark(3)]);
    await held.reached;
    // The app closes with half of the third save in the older slot.
    const third = slotText(3, [mark(3)]);
    expect(disk.files.get(slotPath(0))).toBe(third.slice(0, Math.floor(third.length / 2)));
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([mark(2)]);
    held.release();
  });

  it("say whether a marks save landed, and keep the last whole save when one fails", async () => {
    const files = createNoticeFiles();
    expect(await files.writeMarks(SCOPE, [mark(1)])).toBe(true);
    disk.failWritesIn = MARKS;
    expect(await files.writeMarks(SCOPE, [mark(2)])).toBe(false);
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([mark(1)]);
    disk.failWritesIn = null;
    expect(await files.writeMarks(SCOPE, [mark(3)])).toBe(true);
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([mark(3)]);
  });

  it("save the marks only once the list has landed, and keep the last marks when it doesn't", async () => {
    disk.folders.add(MARKS);
    disk.files.set(slotPath(0), slotText(1, [{ ...mark(1), taken: 1 }]));
    disk.folders.add(`cache/${NOTICE_LIST_FOLDER}`);
    disk.files.set(
      listPath,
      JSON.stringify({ format: NOTICE_LIST_FORMAT, scope: SCOPE, rows: [] }),
    );
    disk.failMoveAfterDelete = true;
    const files = createNoticeFiles();
    const marks = vi.fn(() => []);
    expect(await files.writeListThenMarks(SCOPE, [{ noticeId: "a" }], marks)).toBe("list-failed");
    expect(marks).not.toHaveBeenCalled();
    // The move deleted the old list, so a relaunch reads none and asks the server; the taken mark is still on disk.
    expect(await createNoticeFiles().readList(SCOPE)).toBeNull();
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([{ ...mark(1), taken: 1 }]);

    disk.failMoveAfterDelete = false;
    // The list lands, and the marks save after it fails: the taken mark is still on disk.
    disk.failWritesIn = MARKS;
    expect(await files.writeListThenMarks(SCOPE, [{ noticeId: "a" }], marks)).toBe("marks-failed");
    expect(marks).toHaveBeenCalledTimes(1);
    expect(await createNoticeFiles().readList(SCOPE)).toEqual([{ noticeId: "a" }]);
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([{ ...mark(1), taken: 1 }]);

    disk.failWritesIn = null;
    expect(await files.writeListThenMarks(SCOPE, [{ noticeId: "a" }], marks)).toBe("saved");
    expect(await createNoticeFiles().readList(SCOPE)).toEqual([{ noticeId: "a" }]);
    expect(await createNoticeFiles().readMarks(SCOPE)).toEqual([]);
  });

  it("land nothing a write that began before a clear would have saved", async () => {
    const files = createNoticeFiles();
    const held = hold();
    const writing = files.writeMarks(SCOPE, [mark(1)]);
    files.writeList(SCOPE, () => [{ noticeId: "a" }]);
    await held.reached;
    const cleared = files.clear();
    held.release();
    await writing;
    await cleared;
    await files.flush();
    expect([...disk.files.keys()]).toEqual([]);
    expect(await files.readMarks(SCOPE)).toBeNull();
  });
});
