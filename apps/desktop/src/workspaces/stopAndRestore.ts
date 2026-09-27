import { posix } from "node:path";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { collectionAutomationId, definitionHash } from "@dohc/automation-executor/automation-plan";

// Stop and restore (ADR 0013): after the owner stops a person they shared
// with, put back each file that person wrote directly, from the relay's
// ledger of their direct writes. A file goes back to its version before the
// person's first direct write, through the same restore as History, so each
// keeps Undo. A file anyone else changed after that first write is listed
// for the owner to check, never overwritten, and the restore checks again,
// inside the engine's own queue, that the file is still as it was read. A
// Collection the person created goes, unless anyone else's files remain in
// it once the person's are gone.
// Runs of the automation definitions the person wrote are undone where this
// computer's run history holds them.

const SCHEMA_FILE = "collection.yaml";
const AUTOMATIONS_FILE = "automations.yaml";

/** One file a direct write changed, as the relay's ledger names it. */
export interface DirectWriteFile {
  path: string;
  objectId: string;
  momentId: string;
  created: boolean;
}

/** Why a file was left for the owner to check. */
export type ReviewFile =
  | { path: string; reason: "changed-since" }
  | { path: string; reason: "folder-in-use" }
  | { path: string; reason: "restore-refused"; detail: string };

export interface RestoreReceipt {
  path: string;
  restoredMomentId: string;
}

export interface StopAndRestoreDependencies {
  moment(momentId: string): Promise<VersionedTextMoment | null>;
  /** Throws when the window that asked has left the workspace. */
  assertCurrent(): void;
  /** The ids of a file's moments after `momentId`, newest first. */
  momentsAfter(objectId: string, momentId: string): Promise<string[]>;
  /**
   * History's restore to before `momentId`, only while the file's newest
   * moment is still `expectedHeadMomentId`, and, for `aloneInFolder`, only
   * while nothing else is in its folder. The engine's expected refusals are
   * answers; any other failure throws.
   */
  restore(momentId: string, expectedHeadMomentId: string, aloneInFolder: boolean): Promise<
    | { kind: "restored"; receipt: RestoreReceipt }
    | { kind: "changed" }
    | { kind: "folder-in-use" }
    | { kind: "refused"; detail: string }
  >;
  /** The names in a workspace folder, or none when it is gone. */
  folderEntries(path: string): Promise<string[]>;
  /** Removes a workspace folder only when it is empty. */
  removeEmptyFolder(path: string): Promise<void>;
  undoRuns(
    definitions: ReadonlyArray<{ automationId: string; definitionHash: string }>,
  ): Promise<{ undone: number; left: number }>;
}

export type StopAndRestoreOutcome =
  | { status: "waiting" }
  | {
      status: "restored";
      restored: RestoreReceipt[];
      review: ReviewFile[];
      runsUndone: number;
      runsLeft: number;
      /** What stopped the restore part way; everything above it happened. */
      errorMessage: string | null;
    };

interface Written {
  first: DirectWriteFile;
  last: DirectWriteFile;
  all: DirectWriteFile[];
  moments: Map<string, VersionedTextMoment>;
}

type Content = { sha256: string | undefined; text: string } | null;

function contentBefore(moment: VersionedTextMoment): Content {
  const before = moment.payload.before;
  return before ? { sha256: before.sha256, text: before.text } : null;
}

function contentNow(head: VersionedTextMoment | null): Content {
  if (head === null || head.operation === "delete") return null;
  return { sha256: head.payload.after.sha256, text: head.payload.after.text };
}

function sameContent(left: Content, right: Content): boolean {
  if (left === null || right === null) return left === right;
  if (left.sha256 !== undefined && right.sha256 !== undefined) return left.sha256 === right.sha256;
  return left.text === right.text;
}

/** The valid automations in an automations.yaml text, as "<engine id> <definition hash>". */
function definitionsIn(collectionPath: string, text: string | null): Set<string> {
  const parsed = text === null ? null : parseAutomationsFile(text);
  if (parsed?.status !== "read") return new Set();
  return new Set(parsed.entries.flatMap((entry) => entry.status === "valid"
    ? [`${collectionAutomationId(collectionPath, entry.automation.id)} ${definitionHash(entry.automation)}`]
    : []));
}

// Automations first, so none of the person's runs again, and a schema last.
function restoreOrder(entry: { first: DirectWriteFile }): number {
  const name = posix.basename(entry.first.path);
  return name === AUTOMATIONS_FILE ? 0 : name === SCHEMA_FILE ? 2 : 1;
}

function isCreatedSchema(entry: Written): boolean {
  return entry.first.created && posix.basename(entry.first.path) === SCHEMA_FILE;
}

/**
 * Restores what a person wrote directly. `files` are every file of their
 * direct writes, oldest first. Answers `waiting`, restoring nothing, while
 * this computer has not received all of them. A failure part way answers
 * what was already restored, with the failure.
 */
export async function restoreDirectWrites(
  dependencies: StopAndRestoreDependencies,
  files: readonly DirectWriteFile[],
): Promise<StopAndRestoreOutcome> {
  const objects = new Map<string, Written>();
  for (const file of files) {
    const seen = objects.get(file.objectId);
    if (seen) {
      seen.last = file;
      seen.all.push(file);
    } else {
      objects.set(file.objectId, { first: file, last: file, all: [file], moments: new Map() });
    }
  }

  // Everything must be here before anything changes.
  for (const entry of objects.values()) {
    for (const file of entry.all) {
      const moment = await dependencies.moment(file.momentId);
      if (moment === null) return { status: "waiting" };
      entry.moments.set(file.momentId, moment);
    }
  }
  const written = [...objects.values()];

  // A file goes back only when every moment after the person's first one is
  // theirs. One already as it was before them, such as after an earlier
  // try, is passed over; any other goes to review.
  const restorable: Array<{ entry: Written; head: string }> = [];
  const review = new Map<string, ReviewFile>();
  for (const entry of written) {
    const theirs = new Set(entry.all.map((file) => file.momentId));
    const after = await dependencies.momentsAfter(entry.first.objectId, entry.first.momentId);
    if (after.every((id) => theirs.has(id))) {
      restorable.push({ entry, head: after[0] ?? entry.first.momentId });
      continue;
    }
    const head = await dependencies.moment(after[0]!);
    if (sameContent(contentBefore(entry.moments.get(entry.first.momentId)!), contentNow(head))) continue;
    const path = head !== null && head.operation !== "delete" ? head.path : entry.last.path;
    review.set(path, { path, reason: "changed-since" });
  }

  // The automations the person wrote: in each of their writes, each
  // definition the file held after it and not before it.
  const definitions: Array<{ automationId: string; definitionHash: string }> = [];
  const seen = new Set<string>();
  for (const entry of written) {
    if (posix.basename(entry.first.path) !== AUTOMATIONS_FILE) continue;
    for (const file of entry.all) {
      const moment = entry.moments.get(file.momentId)!;
      const folder = posix.dirname(file.path);
      const before = definitionsIn(folder, moment.payload.before?.text ?? null);
      for (const key of definitionsIn(folder, moment.payload.after.text)) {
        if (before.has(key) || seen.has(key)) continue;
        seen.add(key);
        // The hash has no spaces; an automation id may.
        const split = key.lastIndexOf(" ");
        definitions.push({ automationId: key.slice(0, split), definitionHash: key.slice(split + 1) });
      }
    }
  }

  restorable.sort((left, right) => restoreOrder(left.entry) - restoreOrder(right.entry));
  const restored: RestoreReceipt[] = [];
  const outcome = () => ({ status: "restored" as const, restored, review: [...review.values()].sort((left, right) => left.path.localeCompare(right.path)) });
  let runs = { undone: 0, left: 0 };
  try {
    for (const { entry, head } of restorable) {
      const folder = posix.dirname(entry.first.path);
      if (isCreatedSchema(entry)) {
        // Only the schema may be left now. A record History would not
        // restore, or a file someone added since, keeps the Collection.
        const entries = await dependencies.folderEntries(folder);
        if (entries.some((name) => name !== SCHEMA_FILE) || [...review.keys()].some((path) => posix.dirname(path) === folder)) {
          review.set(entry.last.path, { path: entry.last.path, reason: "folder-in-use" });
          continue;
        }
      }
      dependencies.assertCurrent();
      // The engine checks the folder again in its own queue before it
      // removes the schema.
      const result = await dependencies.restore(entry.first.momentId, head, isCreatedSchema(entry));
      if (result.kind === "changed" || result.kind === "folder-in-use") {
        const reason = result.kind === "changed" ? "changed-since" : "folder-in-use";
        review.set(entry.last.path, { path: entry.last.path, reason });
        continue;
      }
      if (result.kind === "refused") {
        // History refuses some files, such as a shared live document.
        review.set(entry.last.path, { path: entry.last.path, reason: "restore-refused", detail: result.detail.slice(0, 500) });
        continue;
      }
      restored.push(result.receipt);
      if (isCreatedSchema(entry)) await dependencies.removeEmptyFolder(folder);
    }
    if (definitions.length > 0) runs = await dependencies.undoRuns(definitions);
  } catch (error) {
    return { ...outcome(), runsUndone: runs.undone, runsLeft: runs.left, errorMessage: error instanceof Error ? error.message : String(error) };
  }
  return { ...outcome(), runsUndone: runs.undone, runsLeft: runs.left, errorMessage: null };
}
