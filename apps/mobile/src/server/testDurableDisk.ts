import type { NativeDurableFile } from "../../modules/durable-file";
import { RECORD_MAX_BYTES } from "./durableFiles";

// The durable-file folder in memory, for tests. Every launch made over one disk shares its files, as every run of the
// app shares the phone's disk, and each launch's calls run one at a time, as the native module's do. A write puts half
// its text in a temporary file first, then the rest, then renames it over the record, so a write held and never
// released leaves a partial temporary file, as an app closed mid-write would. Like the native module, nothing here
// deletes a file unless a call asks it to.

const RECORD_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const TEMPORARY_NAME = /^[A-Za-z0-9_-]{1,100}\.[0-9a-f]{32}\.tmp$/;

/** Rejects as the native module does, with its error code. */
const nativeError = (code: string, message: string) => Object.assign(new Error(message), { code });

interface DurableDisk {
  /** Every file in the folder, by file name. */
  readonly files: Map<string, string>;
  /** File names that fail to open, as a damaged file would. */
  readonly unreadable: Set<string>;
  /** Each native call, as `<call> <name>`. */
  readonly log: string[];
  /** Fails each write before its rename, leaving the previous record, or after it, at the folder sync. */
  failWrites: "write" | "sync-folder" | null;
  /** An iOS phone not unlocked since it started: reads and recovery reject as locked, and writes fail. */
  locked: boolean;
  /** Holds every write after its first half lands, until the returned function runs. */
  holdWrites(): () => void;
  names(): string[];
  /** One run of the app's native module over this disk. */
  launch(): NativeDurableFile;
}

export function durableDisk(): DurableDisk {
  let held: Promise<void> | null = null;
  const disk: DurableDisk = {
    files: new Map(),
    unreadable: new Set(),
    log: [],
    failWrites: null,
    locked: false,
    holdWrites() {
      let release!: () => void;
      held = new Promise<void>(done => { release = done; });
      return () => { held = null; release(); };
    },
    names: () => [...disk.files.keys()].sort(),
    launch,
  };
  let temporaries = 0;

  const unreadable = (name: string) =>
    disk.unreadable.has(name) || new TextEncoder().encode(disk.files.get(name) ?? "").length > RECORD_MAX_BYTES;
  const checkName = (name: string, pattern = RECORD_NAME) => {
    if (!pattern.test(name)) throw nativeError("ERR_DURABLE_INVALID", "The record name isn't valid.");
  };

  function launch(): NativeDurableFile {
    let queue: Promise<unknown> = Promise.resolve();
    function serial<T>(call: string, run: () => Promise<T> | T): Promise<T> {
      disk.log.push(call);
      const result = queue.then(run);
      queue = result.catch(() => undefined);
      return result;
    }

    return {
      write: (name, text) => serial(`write ${name}`, async () => {
        checkName(name);
        if (new TextEncoder().encode(text).length > RECORD_MAX_BYTES) throw nativeError("ERR_DURABLE_TOO_LARGE", "The record is too large.");
        if (disk.locked) throw nativeError("ERR_DURABLE_FAILED", "Operation not permitted");
        temporaries += 1;
        const temp = `${name}.${temporaries.toString(16).padStart(32, "0")}.tmp`;
        disk.files.set(temp, text.slice(0, Math.floor(text.length / 2)));
        if (held) await held;
        if (disk.failWrites === "write") {
          disk.files.delete(temp);
          throw nativeError("ERR_DURABLE_FAILED", "No space left on device");
        }
        disk.files.delete(temp);
        disk.files.set(name, text);
        disk.unreadable.delete(name);
        if (disk.failWrites === "sync-folder") throw nativeError("ERR_DURABLE_UNSYNCED", "Couldn't sync the folder.");
      }),
      read: name => serial(`read ${name}`, () => {
        checkName(name);
        if (disk.locked) throw nativeError("ERR_DURABLE_LOCKED", "The phone hasn't been unlocked since it started.");
        const text = disk.files.get(name);
        if (text === undefined) return null;
        if (unreadable(name)) throw nativeError("ERR_DURABLE_UNREADABLE", "Couldn't read the record.");
        return text;
      }),
      list: () => serial("list", () => disk.names().filter(name => RECORD_NAME.test(name))),
      remove: name => serial(`remove ${name}`, () => {
        checkName(name);
        disk.files.delete(name);
      }),
      recover: () => serial("recover", () => {
        if (disk.locked) throw nativeError("ERR_DURABLE_LOCKED", "The phone hasn't been unlocked since it started.");
        return {
          leftovers: disk.names().filter(name => !RECORD_NAME.test(name)),
          unreadable: disk.names().filter(name => RECORD_NAME.test(name) && unreadable(name)),
        };
      }),
      removeLeftover: fileName => serial(`removeLeftover ${fileName}`, () => {
        checkName(fileName, TEMPORARY_NAME);
        disk.files.delete(fileName);
      }),
    };
  }

  return disk;
}
