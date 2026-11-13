import type { NativeDurableFile } from "../../modules/durable-file";
import { RECORD_MAX_BYTES } from "./durableFiles";

// The durable-file folder in memory, for tests. Every launch made over one disk shares its files, as every run of the
// app shares the phone's disk, and each launch's calls run one at a time, as the native module's do. A write puts half
// its text in a temporary file first, then the rest, then renames it over the record. `crash` ends every launch made
// so far, as the app closing would: a write it held stays a partial temporary file, and nothing the ended launches
// started ever finishes. Like the native module, nothing here deletes a file unless a call asks it to.

const RECORD_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const TEMPORARY_NAME = /^[A-Za-z0-9_-]{1,100}\.[0-9a-f]{32}\.tmp$/;

/** Rejects as the native module does, with its error code. */
const nativeError = (code: string, message: string) => Object.assign(new Error(message), { code });
/** What an ended launch's calls return: they never settle. */
const never = <T>() => new Promise<T>(() => undefined);

interface DurableDisk {
  /** Every file in the folder, by file name. */
  readonly files: Map<string, string>;
  /** File names that fail to open, as a damaged file would. */
  readonly unreadable: Set<string>;
  /** Each native call, as `<call> <name>`. */
  readonly log: string[];
  /** Fails each write: at folder preparation, before any temporary file; before its rename, leaving the previous
   * record; or after it, at the folder sync. */
  failWrites: "prepare" | "write" | "sync-folder" | null;
  /** Fails each delete: at the unlink, keeping the file; or after it, at the folder sync. */
  failRemoves: "unlink" | "sync-folder" | null;
  /** An iOS phone not unlocked since it started: reads and recovery reject as locked, and writes fail. */
  locked: boolean;
  /** Holds every write after its first half lands, until the returned function runs or the app crashes. */
  holdWrites(): () => void;
  /** Ends every launch made so far. Their held writes stay partial temporary files, and none of their calls settle. */
  crash(): void;
  names(): string[];
  /** One run of the app's native module over this disk. */
  launch(): NativeDurableFile;
}

export function durableDisk(): DurableDisk {
  let held: { readonly promise: Promise<void>; readonly release: () => void } | null = null;
  let run = 0;
  const releaseHold = () => {
    held?.release();
    held = null;
  };
  const disk: DurableDisk = {
    files: new Map(),
    unreadable: new Set(),
    log: [],
    failWrites: null,
    failRemoves: null,
    locked: false,
    holdWrites() {
      let release!: () => void;
      const hold = { promise: new Promise<void>(done => { release = done; }), release: () => release() };
      held = hold;
      return () => { if (held === hold) releaseHold(); };
    },
    crash() {
      run += 1;
      // The ended launches' writers wake, see they ended, and stop for good. New launches aren't held.
      releaseHold();
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
  const checkUnlocked = () => {
    if (disk.locked) throw nativeError("ERR_DURABLE_LOCKED", "The phone hasn't been unlocked since it started.");
  };

  function launch(): NativeDurableFile {
    const mine = run;
    const ended = () => mine !== run;
    let queue: Promise<unknown> = Promise.resolve();
    function serial<T>(call: string, body: () => Promise<T> | T): Promise<T> {
      if (ended()) return never();
      disk.log.push(call);
      const result = queue.then(() => ended() ? never<T>() : body());
      queue = result.catch(() => undefined);
      return result;
    }
    const unlink = (fileName: string) => {
      if (disk.failRemoves === "unlink") throw nativeError("ERR_DURABLE_FAILED", "Couldn't delete the file.");
      disk.files.delete(fileName);
      if (disk.failRemoves === "sync-folder") throw nativeError("ERR_DURABLE_UNSYNCED", "Couldn't sync the folder.");
    };

    return {
      write: (name, text) => serial(`write ${name}`, async () => {
        checkName(name);
        if (new TextEncoder().encode(text).length > RECORD_MAX_BYTES) throw nativeError("ERR_DURABLE_TOO_LARGE", "The record is too large.");
        if (disk.failWrites === "prepare") throw nativeError("ERR_DURABLE_FAILED", "Couldn't sync the folder's parent.");
        if (disk.locked) throw nativeError("ERR_DURABLE_FAILED", "Couldn't create the temporary file: Operation not permitted.");
        temporaries += 1;
        const temp = `${name}.${temporaries.toString(16).padStart(32, "0")}.tmp`;
        disk.files.set(temp, text.slice(0, Math.floor(text.length / 2)));
        if (held) await held.promise;
        if (ended()) return never<void>();
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
        const text = disk.files.get(name);
        if (text === undefined) return null;
        checkUnlocked();
        if (unreadable(name)) throw nativeError("ERR_DURABLE_UNREADABLE", "Couldn't read the record.");
        return text;
      }),
      list: () => serial("list", () => disk.names().filter(name => RECORD_NAME.test(name))),
      remove: name => serial(`remove ${name}`, () => {
        checkName(name);
        unlink(name);
      }),
      recover: () => serial("recover", () => {
        const records = disk.names().filter(name => RECORD_NAME.test(name));
        if (records.length > 0) checkUnlocked();
        return {
          leftovers: disk.names().filter(name => !RECORD_NAME.test(name)),
          unreadable: records.filter(unreadable),
        };
      }),
      removeLeftover: fileName => serial(`removeLeftover ${fileName}`, () => {
        checkName(fileName, TEMPORARY_NAME);
        unlink(fileName);
      }),
    };
  }

  return disk;
}
