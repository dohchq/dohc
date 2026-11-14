import type { NativeDurableFile } from "../../modules/durable-file";

// The outbox's records on disk, through the native `durable-file` module (`modules/durable-file`). Unlike the read
// cache, a record here is someone's unsent work: a write resolves only once the record would survive the app closing,
// the system ending it, a restart and sudden power loss, and nothing here ever deletes a record the caller didn't ask
// to delete. The folder is outside Caches and is never backed up.
//
// A record has a name of letters, digits, "-" and "_", and at most RECORD_MAX_BYTES of UTF-8 text. Both this binding
// and the native module check both, so a bad call fails before it reaches the disk. The native module runs calls one
// at a time, in the order they're made, so a delete made after a write lands after it.

/** The largest record, in UTF-8 bytes: twice the route's 256 KiB request limit
 * (`services/sync-relay/src/accountOperationRoutes.ts:17`). A record holds a whole request's arguments plus its own
 * fields, the origin, account, IDs, sequence, stage and result, and any of that text the record keeps as a JSON string
 * is escaped again. The native modules use the same number. */
export const RECORD_MAX_BYTES = 512 * 1024;

const RECORD_NAME = /^[A-Za-z0-9_-]{1,100}$/;
/** A temporary file the native module writes beside a record, then renames over it. */
const TEMPORARY_NAME = /^[A-Za-z0-9_-]{1,100}\.[0-9a-f]{32}\.tmp$/;

/** What `recover` found. */
export interface Recovery {
  /** Files in the folder that aren't records: temporary files from writes that never finished, and anything else. */
  readonly leftovers: readonly string[];
  /** Records that can't be read: not valid UTF-8, larger than the bound, or failing to open. */
  readonly unreadable: readonly string[];
}

export interface DurableFiles {
  /** Replaces the record `name` with `text`, and resolves once it's durable. A rejection of kind `unsynced` means the
   * new record may be in place but isn't known to survive power loss; any other rejection leaves the previous record. */
  write(name: string, text: string): Promise<void>;
  /** The record's text, or null when there's none. Rejects as `unreadable` when the record can't be read. */
  read(name: string): Promise<string | null>;
  /** Every record's name, sorted. Unreadable records are listed too. */
  list(): Promise<readonly string[]>;
  /** Deletes the record, if there is one, and resolves once the delete is durable. */
  remove(name: string): Promise<void>;
  /** Reports leftovers and unreadable records. It deletes nothing. */
  recover(): Promise<Recovery>;
  /** Deletes a temporary file `recover` reported. Any other leftover stays. */
  removeLeftover(fileName: string): Promise<void>;
}

/** `locked`: an iOS phone that hasn't been unlocked since it started keeps the records closed. Try again after. */
export class DurableFileError extends Error {
  constructor(
    readonly kind: "invalid" | "too-large" | "unreadable" | "locked" | "unsynced" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "DurableFileError";
  }
}

const KINDS: Readonly<Record<string, DurableFileError["kind"]>> = {
  ERR_DURABLE_INVALID: "invalid",
  ERR_DURABLE_TOO_LARGE: "too-large",
  ERR_DURABLE_UNREADABLE: "unreadable",
  ERR_DURABLE_LOCKED: "locked",
  ERR_DURABLE_UNSYNCED: "unsynced",
};

export function createDurableFiles(native: NativeDurableFile): DurableFiles {
  async function call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new DurableFileError((typeof code === "string" && KINDS[code]) || "failed", message);
    }
  }

  return {
    async write(name, text) {
      checkName(name);
      checkText(text);
      return call(() => native.write(name, text));
    },
    async read(name) {
      checkName(name);
      return call(() => native.read(name));
    },
    list: () => call(() => native.list()),
    async remove(name) {
      checkName(name);
      return call(() => native.remove(name));
    },
    recover: () => call(() => native.recover()),
    async removeLeftover(fileName) {
      if (!TEMPORARY_NAME.test(fileName))
        throw new DurableFileError(
          "invalid",
          "Only a leftover temporary file can be removed this way.",
        );
      return call(() => native.removeLeftover(fileName));
    },
  };
}

function checkName(name: string) {
  if (!RECORD_NAME.test(name))
    throw new DurableFileError("invalid", "The record name isn't valid.");
}

/** Refuses text over the bound in UTF-8, and text with a lone surrogate, which UTF-8 can't hold. */
function checkText(text: string) {
  const tooLarge = () =>
    new DurableFileError("too-large", `The record is larger than ${RECORD_MAX_BYTES} bytes.`);
  // Each UTF-16 unit takes at least one byte.
  if (text.length > RECORD_MAX_BYTES) throw tooLarge();
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0xd800 || code > 0xdfff) bytes += 3;
    else {
      const next = text.charCodeAt(i + 1);
      if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff))
        throw new DurableFileError("invalid", "The record's text isn't valid Unicode.");
      bytes += 4;
      i += 1;
    }
  }
  if (bytes > RECORD_MAX_BYTES) throw tooLarge();
}
