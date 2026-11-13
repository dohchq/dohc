import { Directory, File, Paths } from "expo-file-system";
import { isFields } from "./api";
import { fileName } from "./cacheFiles";

// The account's Notices on disk, per account.
//
// - The list, in Caches. It's a copy of what the server sent, so a relaunch shows it before the server answers. The
//   system may delete it, and a file this build can't read is deleted and read again from the server. A new copy is
//   written beside it and moved into its place. expo-file-system's move deletes the old file first, so an app closed
//   between the two can leave no list, never half of one; the relaunch then reads the list from the server.
// - The marks this phone made that the server hasn't taken yet, in Documents, which the system never clears. They
//   alternate between two slot files, each with a generation number. A save writes the whole queue to the slot that
//   doesn't hold the newest generation, and a read takes the newest slot that parses and checks. An app closed at any
//   point leaves at least the last whole save. Nothing asks the disk to flush, so a power loss can still lose the last
//   save.
//
// Everything runs in order on one queue. Both kinds carry their account's scope and format, and go when the account's
// sign-in changes or ends. A clear moves every scope's generation on, so a read or write that began before it lands
// nothing.

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
  /**
   * Saves the list now, after every change before it, in place of a save that waits. Only once that has landed does it
   * save the marks `marks` answers then. Resolves whether the list landed; it never rejects.
   */
  writeListThenMarks(
    scope: string,
    rows: readonly unknown[],
    marks: () => readonly unknown[],
  ): Promise<boolean>;
  /** Saves now a list that waits to be saved. */
  flush(): Promise<void>;
  /** Deletes every scope's files, and drops every write that hasn't landed. */
  clear(): Promise<void>;
}

interface Slot {
  readonly slot: 0 | 1;
  readonly generation: number;
}

export function createNoticeFiles(
  options: { readonly list?: Directory; readonly marks?: Directory } = {},
): NoticeFiles {
  const lists = options.list ?? new Directory(Paths.cache, NOTICE_LIST_FOLDER);
  const marks = options.marks ?? new Directory(Paths.document, NOTICE_MARKS_FOLDER);
  let epoch = 0;
  const waiting = new Map<string, () => readonly unknown[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Each scope's slot holding its newest marks, once read or written this run. */
  const newest = new Map<string, Slot | null>();

  // Every read, write and delete runs in order, so a read after a clear never finds a file the clear deletes.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T> | T, fallback: T): Promise<T> {
    const next = queue.then(run).catch(() => fallback);
    queue = next;
    return next;
  }

  /** The file's fields when it parses and is of this format and for `scope`, or null. */
  async function parsed(file: File, scope: string, format: number) {
    if (!file.exists) return null;
    try {
      const data: unknown = JSON.parse(await file.text());
      return isFields(data) && data.format === format && data.scope === scope ? data : null;
    } catch {
      return null;
    }
  }

  async function readListFile(scope: string) {
    const expected = epoch;
    const file = new File(lists, `${fileName(scope)}.json`);
    const data = await parsed(file, scope, NOTICE_LIST_FORMAT);
    if (epoch !== expected) return null;
    if (data === null || data.rows === undefined) {
      if (file.exists) file.delete();
      return null;
    }
    return data.rows;
  }

  async function replaceList(scope: string, text: string, expected: number): Promise<boolean> {
    const name = fileName(scope);
    const temp = new File(lists, `${name}.json.tmp`);
    try {
      if (!lists.exists) lists.create({ intermediates: true });
      await temp.write(text);
      if (epoch !== expected) {
        temp.delete();
        return false;
      }
      await temp.move(new File(lists, `${name}.json`), { overwrite: true });
      return true;
    } catch {
      if (temp.exists) temp.delete();
      return false;
    }
  }

  const slotFile = (scope: string, slot: 0 | 1) =>
    new File(marks, `${fileName(scope)}.${slot}.json`);

  /** The newest slot that parses and checks, with its marks, or null. */
  async function readSlots(scope: string) {
    let found: (Slot & { readonly marks: unknown }) | null = null;
    for (const slot of [0, 1] as const) {
      const data = await parsed(slotFile(scope, slot), scope, NOTICE_MARKS_FORMAT);
      const generation = data?.generation;
      if (
        !data ||
        !Array.isArray(data.marks) ||
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        (found !== null && found.generation >= generation)
      )
        continue;
      found = { slot, generation, marks: data.marks };
    }
    return found;
  }

  async function readMarksFile(scope: string) {
    const expected = epoch;
    const found = await readSlots(scope);
    if (epoch !== expected) return null;
    newest.set(scope, found && { slot: found.slot, generation: found.generation });
    return found?.marks ?? null;
  }

  /** Writes the marks to the slot that doesn't hold the newest, unless a clear came first. */
  async function writeSlot(scope: string, list: readonly unknown[], expected: number) {
    if (epoch !== expected) return;
    const known = newest.has(scope) ? (newest.get(scope) ?? null) : await readSlots(scope);
    if (epoch !== expected) return;
    const next: Slot = {
      slot: known === null || known.slot === 1 ? 0 : 1,
      generation: (known?.generation ?? 0) + 1,
    };
    const text = JSON.stringify({
      format: NOTICE_MARKS_FORMAT,
      scope,
      generation: next.generation,
      marks: list,
    });
    try {
      if (!marks.exists) marks.create({ intermediates: true });
      await slotFile(scope, next.slot).write(text);
      if (epoch === expected) newest.set(scope, next);
    } catch {
      // That slot may hold part of this save; the other still holds the last whole one, and the next save goes here.
      newest.set(scope, known && { slot: known.slot, generation: known.generation });
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
        const text = JSON.stringify({ format: NOTICE_LIST_FORMAT, scope, rows: rows() });
        await replaceList(scope, text, expected);
      }
    }, undefined);
  }

  return {
    readList: (scope) => serial(() => readListFile(scope), null),
    writeList(scope, rows) {
      waiting.set(scope, rows);
      if (timer === null) timer = setTimeout(() => void saveLists(), NOTICE_WRITE_DELAY_MS);
    },
    readMarks: (scope) => serial(() => readMarksFile(scope), null),
    writeMarks(scope, list) {
      const expected = epoch;
      return serial(() => writeSlot(scope, list, expected), undefined);
    },
    writeListThenMarks(scope, rows, list) {
      const expected = epoch;
      waiting.delete(scope);
      const text = JSON.stringify({ format: NOTICE_LIST_FORMAT, scope, rows });
      return serial(async () => {
        if (epoch !== expected || !(await replaceList(scope, text, expected))) return false;
        await writeSlot(scope, list(), expected);
        return true;
      }, false);
    },
    flush: () => saveLists(),
    clear() {
      epoch += 1;
      waiting.clear();
      newest.clear();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return serial(() => {
        if (lists.exists) lists.delete();
        if (marks.exists) marks.delete();
      }, undefined);
    },
  };
}
