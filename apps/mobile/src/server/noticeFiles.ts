import { Directory, File, Paths } from "expo-file-system";
import { isFields } from "./api";
import { fileName } from "./cacheFiles";

// The account's Notices on disk, in two files per account.
//
// - The list, in Caches. It's a copy of what the server sent, so a relaunch shows it before the server answers. The
//   system may delete it, and a file this build can't read is deleted and read again from the server.
// - The marks this phone made that the server hasn't taken yet, in Documents, which the system never clears. Each
//   change replaces the whole file: the new text goes to a file beside it, which then moves into its place. A closed
//   app leaves the old file or the new one, never half of one. Nothing asks the disk to flush, so a power loss can
//   still lose the last change.
//
// Both files carry their account's scope and format, and go when the account's sign-in changes or ends. A clear moves
// every scope's generation on, so a read or write that began before it lands nothing.

export const NOTICE_LIST_FORMAT = 1;
export const NOTICE_MARKS_FORMAT = 1;
export const NOTICE_LIST_FOLDER = "dohc-notices";
export const NOTICE_MARKS_FOLDER = "dohc-notice-marks";
export const NOTICE_WRITE_DELAY_MS = 1000;

export interface NoticeFiles {
  /** The scope's saved list, unchecked, or null. It never rejects. */
  readList(scope: string): Promise<unknown>;
  /** Saves the list soon, as `rows` answers then. */
  writeList(scope: string, rows: () => readonly unknown[]): void;
  /** The scope's waiting marks, unchecked, or null. It never rejects. */
  readMarks(scope: string): Promise<unknown>;
  /** Saves the waiting marks now, after every change before it. It never rejects. */
  writeMarks(scope: string, marks: readonly unknown[]): Promise<void>;
  /** Saves now a list that waits to be saved. */
  flush(): Promise<void>;
  /** Deletes both files of every scope, and drops every write that hasn't landed. */
  clear(): Promise<void>;
}

export function createNoticeFiles(
  options: { readonly list?: Directory; readonly marks?: Directory } = {},
): NoticeFiles {
  const lists = options.list ?? new Directory(Paths.cache, NOTICE_LIST_FOLDER);
  const marks = options.marks ?? new Directory(Paths.document, NOTICE_MARKS_FOLDER);
  let epoch = 0;
  const waiting = new Map<string, () => readonly unknown[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Every read, write and delete runs in order, so a read after a clear never finds a file the clear deletes.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T> | T, fallback: T): Promise<T> {
    const next = queue.then(run).catch(() => fallback);
    queue = next;
    return next;
  }

  async function read(folder: Directory, scope: string, format: number, field: string) {
    const expected = epoch;
    const file = new File(folder, `${fileName(scope)}.json`);
    if (!file.exists) return null;
    let data: unknown = null;
    try {
      data = JSON.parse(await file.text());
    } catch {
      data = null;
    }
    if (epoch !== expected) return null;
    const found =
      isFields(data) && data.format === format && data.scope === scope ? data[field] : null;
    if (found === null || found === undefined) {
      if (file.exists) file.delete();
      return null;
    }
    return found;
  }

  async function replace(folder: Directory, scope: string, text: string, expected: number) {
    const name = fileName(scope);
    const temp = new File(folder, `${name}.json.tmp`);
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      await temp.write(text);
      const file = new File(folder, `${name}.json`);
      if (epoch === expected) await temp.move(file, { overwrite: true });
      else temp.delete();
    } catch {
      if (temp.exists) temp.delete();
    }
  }

  function saveLists(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const batch = [...waiting];
    waiting.clear();
    const expected = epoch;
    return serial(async () => {
      for (const [scope, rows] of batch) {
        if (epoch !== expected) return;
        await replace(
          lists,
          scope,
          JSON.stringify({ format: NOTICE_LIST_FORMAT, scope, rows: rows() }),
          expected,
        );
      }
    }, undefined);
  }

  return {
    readList: (scope) => serial(() => read(lists, scope, NOTICE_LIST_FORMAT, "rows"), null),
    writeList(scope, rows) {
      waiting.set(scope, rows);
      if (timer === null) timer = setTimeout(() => void saveLists(), NOTICE_WRITE_DELAY_MS);
    },
    readMarks: (scope) => serial(() => read(marks, scope, NOTICE_MARKS_FORMAT, "marks"), null),
    writeMarks(scope, list) {
      const expected = epoch;
      const text = JSON.stringify({ format: NOTICE_MARKS_FORMAT, scope, marks: list });
      return serial(async () => {
        if (epoch === expected) await replace(marks, scope, text, expected);
      }, undefined);
    },
    flush: () => saveLists(),
    clear() {
      epoch += 1;
      waiting.clear();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return serial(() => {
        if (lists.exists) lists.delete();
        if (marks.exists) marks.delete();
      }, undefined);
    },
  };
}
