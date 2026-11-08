import { posix } from "node:path";
import { durableBatch, DURABLE_BATCH_ITEMS } from "@dohc/automation-executor/durable-batch";
import { restoreReceiptOf } from "./restoreWriteIdentity";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import type { WorkspacePolicyPath } from "@dohc/security-contract/effective-policy";
import type { KeptAutomationField } from "@dohc/automation-executor/collection-automations";
import type { SharedReversalsSchema } from "@dohc/workspace-contracts/shared-file-settlement";
import type { z } from "zod";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { sendsMessages } from "@dohc/automation-executor/collection-automation-run";

// Stop and restore (ADR 0013): after the owner stops a person they shared
// with, or ends an Edit share link, put back each file it wrote directly,
// from the relay's ledger of its direct writes. A file goes back to its version before the
// person's first direct write, through the same restore as History, so each
// keeps Undo. A file anyone else changed after that first write is listed
// for the owner to check, never overwritten, and the restore checks again,
// inside the engine's own queue, that the file is still as it was read. A
// Collection the person created goes, unless anyone else's files remain in
// it once the person's are gone.
// Runs of the automation definitions the person wrote are undone where this
// computer's run history holds them, and on the owner's self-hosted server.
// What cannot be undone is said, never
// hidden: messages those automations sent, changes Undo leaves, and runs
// another computer's history holds.

const SCHEMA_FILE = "collection.yaml";
const AUTOMATIONS_FILE = "automations.yaml";

/** One file a direct write changed, as the relay's ledger names it. */
export interface DirectWriteFile {
  path: string;
  objectId: string;
  momentId: string;
  created: boolean;
  /** The relay's public identity for this direct write's link participant. */
  publicPrincipalId?: string;
}

/** Why a file was left for the owner to check. */
export type ReviewFile =
  | { path: string; reason: "changed-since"; changedBy?: string }
  | { path: string; reason: "folder-in-use" }
  | { path: string; reason: "restore-refused"; detail: string; refusal?: "synced-deletion" }
  | { path: string; reason: "rules-unreadable"; unreadable: WorkspacePolicyPath[] };

export interface RestoreReceipt {
  path: string;
  restoredMomentId: string;
  removed?: boolean;
}

export interface StopAndRestoreDependencies {
  recordDefinitions?(definitions: ReadonlyArray<{collectionPath: string; id: string; definitionHash: string}>): Promise<void>;
  recordRestoreIntents?(momentIds: readonly string[]): Promise<void>;
  recordRestores?(receipts: readonly RestoreReceipt[], originalMomentIds: readonly string[]): Promise<void>;
  recordedRestores?: readonly RestoreReceipt[];
  findRestoreReceipt?(momentId: string, requestId: string): Promise<RestoreReceipt | null>;
  /** Whether the keyed restore that recorded `restoredMomentId` reached disk. */
  publicationApplied?(restoredMomentId: string, requestId: string): Promise<boolean>;
  /** The saved session's stable request key, when retrying unjournaled writes. */
  replayRequestId?(momentId: string): string;
  /** A moment, `protected` when its contents are protected here, or null while it has not arrived. */
  moment(momentId: string): Promise<VersionedTextMoment | "protected" | null>;
  /** Throws when the window that asked has left the workspace. */
  assertCurrent(): void;
  reviewPath?(path: string): string | null;
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
    | { kind: "refused"; detail: string; refusal?: "synced-deletion" }
    // History's rules could not be read; `unreadable` names what to fix.
    | { kind: "rules-unreadable"; unreadable: WorkspacePolicyPath[] }
  >;
  /** The names in a workspace folder, or none when it is gone. */
  folderEntries(path: string): Promise<string[]>;
  /** Removes a workspace folder only when it is empty. */
  removeEmptyFolder(path: string): Promise<void>;
  /** Runs undone and left, and fields kept at a later value or on records that left their Collection. */
  undoRuns(
    definitions: ReadonlyArray<{ collectionPath: string; id: string; definitionHash: string }>,
  ): Promise<UndoneRuns>;
}

export interface UndoneRuns {
  sharedReversals?: z.infer<typeof SharedReversalsSchema>;
  undone: number;
  left: number;
  keptFields: KeptAutomationField[];
  missing: number;
  otherKept: number;
  errorMessage: string | null;
}

/** Undoing runs stopped part way: what it undid before it stopped. */
export class UndoRunsStopped extends Error {
  constructor(message: string, readonly runs: UndoneRuns) {
    super(message);
  }
}

export type StopAndRestoreOutcome =
  | { status: "waiting" }
  | {
      status: "restored";
      restored: RestoreReceipt[];
      review: ReviewFile[];
      runsUndone: number;
      runsLeft: number;
      sharedReversals?: z.infer<typeof SharedReversalsSchema>;
      /** Changes the undone runs made that stay as they are. */
      runChangesKept: number;
      /** They wrote automations; this computer undoes only the runs it holds. */
      wroteAutomations: boolean;
      /** An automation they wrote posts, messages, notifies, or wakes an agent, which no Undo takes back. */
      sendsMessages: boolean;
      /** Fields the runs wrote that kept a later value. */
      keptFields: KeptAutomationField[];
      /** Fields the runs wrote on records no longer in their Collection. */
      fieldsMissing: number;
      /**
       * The step a failure stopped, with why; everything above it happened.
       * At `files`, this try undid no run.
       */
      unfinished: { step: "files" | "runs"; message: string } | null;
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

/**
 * The valid automations in an automations.yaml text, by "<definition hash>
 * <automation id>", each with whether it sends messages.
 */
function definitionsIn(text: string | null): Map<string, boolean> {
  const parsed = text === null ? null : parseAutomationsFile(text);
  if (parsed?.status !== "read") return new Map();
  return new Map(parsed.entries.flatMap((entry) => entry.status === "valid"
    ? [[`${definitionHash(entry.automation)} ${entry.automation.id}`, sendsMessages(entry.automation)] as const]
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

  // Everything must be here before anything changes. A file whose contents
  // are protected here cannot be restored here, so it goes to review.
  const review = new Map<string, ReviewFile>();
  type Receipt = {receipt: RestoreReceipt; originalMomentId: string; folder?: string};
  const recovered: Receipt[] = [];
  const known = new Set(dependencies.recordedRestores?.map(receipt => receipt.restoredMomentId));
  const recoveredFolders = new Set<string>();
  // A protected automations.yaml hides which automations they changed, so
  // their runs are neither found nor undone; the file's review says so.
  let protectedAutomations = false;
  // `theirs`: their own changes are protected, not only a later one.
  const refuseProtected = (path: string, theirs: boolean) => {
    const automations = theirs && posix.basename(path) === AUTOMATIONS_FILE;
    protectedAutomations ||= automations;
    review.set(path, {
      path, reason: "restore-refused",
      detail: automations
        ? "Its contents are protected here, so dohc could not read its automations or undo their runs. Restore it from its History, and undo their runs from its Collection's run history."
        : "Its contents are protected. Restore it from its History.",
    });
  };
  const written: Written[] = [];
  for (const entry of objects.values()) {
    const retained = dependencies.reviewPath?.(entry.last.path);
    if (retained) {
      review.set(entry.last.path, {path: entry.last.path, reason: "restore-refused", detail: posix.basename(entry.last.path) === AUTOMATIONS_FILE ? `${retained.replace(/\.$/, "")}. Runs from this file's automations were kept.` : retained});
      protectedAutomations ||= posix.basename(entry.last.path) === AUTOMATIONS_FILE;
      continue;
    }
    let readable = true;
    for (const file of entry.all) {
      const moment = await dependencies.moment(file.momentId);
      if (moment === null) return { status: "waiting" };
      if (moment === "protected") readable = false;
      else entry.moments.set(file.momentId, moment);
    }
    if (readable) written.push(entry);
    else refuseProtected(entry.last.path, true);
  }

  // A file goes back only when every moment after the person's first one is
  // theirs. One already as it was before them, such as after an earlier
  // try, is passed over; any other goes to review.
  const restorable: Array<{ entry: Written; head: string }> = [];
  for (const entry of written) {
    const theirs = new Set(entry.all.map((file) => file.momentId));
    const after = await dependencies.momentsAfter(entry.first.objectId, entry.first.momentId);
    const laterMoments = new Map<string, VersionedTextMoment | "protected">();
    const readLater = async (id: string) => {
      const kept = laterMoments.get(id);
      if (kept !== undefined) return kept;
      const later = await dependencies.moment(id);
      if (later !== null) laterMoments.set(id, later);
      return later;
    };
    const requestId = dependencies.replayRequestId?.(entry.first.momentId);
    if (requestId) {
      let receipt: RestoreReceipt | null = null;
      for (const id of after) {
        const later = await readLater(id);
        if (later === null) return {status: "waiting"};
        if (later !== "protected") receipt = restoreReceiptOf(later, entry.moments.get(entry.first.momentId)!, requestId);
        if (receipt) break;
      }
      // History shows the restore committed; only a confirmed publication completes it.
      if (receipt && !await dependencies.publicationApplied?.(receipt.restoredMomentId, requestId)) receipt = null;
      else if (!receipt && entry.moments.get(entry.first.momentId)!.payload.before?.contentKind === "binary") {
        receipt = await dependencies.findRestoreReceipt?.(entry.first.momentId, requestId) ?? null;
      }
      if (receipt) {
        const folder = isCreatedSchema(entry) ? posix.dirname(entry.first.path) : undefined;
        if (known.has(receipt.restoredMomentId)) {if (folder) recoveredFolders.add(folder);}
        else recovered.push({receipt: {...receipt, ...(entry.first.created ? {removed: true} : {})}, originalMomentId: entry.first.momentId, folder});
        continue;
      }
    }
    let snapshotHead = entry.first.momentId;
    for (const id of after) {
      const later = await readLater(id);
      if (later === null) return { status: "waiting" };
      if (later === "protected" || !later.syncRecordOnly) {
        snapshotHead = id;
        break;
      }
    }
    const creator = entry.moments.get(entry.first.momentId)!.authors;
    const sameRecipient = (moment: VersionedTextMoment) => {
      if (creator?.length !== 1 || !moment.authors?.length
        || moment.authors.some(author => author.kind === "unattributed")) return false;
      const original = creator[0]!;
      // Settlement exports keep their native IDs but encode "ydoc" as "local-file".
      const liveSettlement = moment.metadata.origin === "ydoc" || (moment.metadata.origin === "local-file"
        && /^moment-ydoc-(?:apply-)?[a-fA-F0-9]{64}$/u.test(moment.id));
      return moment.authors.every(author => original.kind === "named"
        ? (author.kind === "named" && author.userId === original.userId) || (liveSettlement && author.kind === "human" && author.relayConfirmed === true && author.humanId === original.userId)
        : original.kind === "link" && "principalId" in original && author.kind === "link" && (
          "publicPrincipalId" in author
            ? entry.first.publicPrincipalId !== undefined && author.publicPrincipalId === entry.first.publicPrincipalId
            : author.grantId === original.grantId && author.principalId === original.principalId));
    };
    let changedBy: string | undefined;
    let allTheirs = true;
    for (const id of after) {
      if (theirs.has(id)) continue;
      const later = await readLater(id);
      if (later === null) return { status: "waiting" };
      if (later !== "protected" && later.syncRecordOnly
        && !later.authors?.some(author => author.kind === "unattributed")) {
        const head = entry.moments.get(snapshotHead) ?? await readLater(snapshotHead);
        if (!later.authors?.length || head !== null && head !== "protected"
          && later.payload.after.path === head.payload.after.path
          && sameContent(contentNow(later), contentNow(head))) continue;
      }
      // Opening a live document can settle its unchanged seed without an author.
      if (later !== "protected" && later.operation === "write" && !later.authors?.length
        && later.payload.before?.path === later.payload.after.path
        && sameContent(contentBefore(later), contentNow(later))) continue;
      if (later !== "protected" && sameRecipient(later)) continue;
      allTheirs = false;
      const author = later !== "protected" && later.authors?.length === 1 ? later.authors[0] : undefined;
      changedBy = later !== "protected" && later.authors?.some(author => author.kind === "unattributed")
        ? "An unrecorded author"
        : author?.kind === "automation" ? "An automation" : author?.kind === "human" ? `Person ${author.humanId}`
        : author?.kind === "named" ? `Person ${author.userId}` : author?.kind === "agent" ? `Agent ${author.agentId}`
        : author?.kind === "link" ? "Another share link participant" : "Another author";
      break;
    }
    if (allTheirs) {
      restorable.push({ entry, head: after[0] ?? entry.first.momentId });
      continue;
    }
    const head = entry.moments.get(snapshotHead) ?? await readLater(snapshotHead);
    if (head === "protected") {
      refuseProtected(entry.last.path, false);
      continue;
    }
    if (sameContent(contentBefore(entry.moments.get(entry.first.momentId)!), contentNow(head))) continue;
    const path = head !== null && head.operation !== "delete" ? head.path : entry.last.path;
    review.set(path, { path, reason: "changed-since", changedBy });
  }

  // The automations the person wrote: in each of their writes, each
  // definition the file held after it and not before it.
  const definitions: Array<{ collectionPath: string; id: string; definitionHash: string }> = [];
  const seen = new Set<string>();
  let messages = false;
  for (const entry of written) {
    if (posix.basename(entry.first.path) !== AUTOMATIONS_FILE) continue;
    for (const file of entry.all) {
      const moment = entry.moments.get(file.momentId)!;
      const folder = posix.dirname(file.path);
      const before = definitionsIn(moment.payload.before?.text ?? null);
      for (const [key, sends] of definitionsIn(moment.payload.after.text)) {
        if (before.has(key) || seen.has(`${folder}/${key}`)) continue;
        seen.add(`${folder}/${key}`);
        messages ||= sends;
        // The hash has no spaces; an automation id may.
        const split = key.indexOf(" ");
        definitions.push({ collectionPath: folder, id: key.slice(split + 1), definitionHash: key.slice(0, split) });
      }
    }
  }

  restorable.sort((left, right) => restoreOrder(left.entry) - restoreOrder(right.entry));
  const restored: RestoreReceipt[] = [];
  const receipts = durableBatch<Receipt>(async batch => {
    await dependencies.recordRestores?.(batch.map(item => item.receipt), batch.map(item => item.originalMomentId));
    restored.push(...batch.map(item => item.receipt));
    for (const item of batch) if (item.folder) await dependencies.removeEmptyFolder(item.folder);
  });
  const removeRecoveredFolders = async () => {
    for (const folder of recoveredFolders) await dependencies.removeEmptyFolder(folder);
    recoveredFolders.clear();
  };
  const outcome = () => ({ status: "restored" as const, restored, review: [...review.values()].sort((left, right) => left.path.localeCompare(right.path)) });
  let runs: Omit<UndoneRuns, "errorMessage"> = { undone: 0, left: 0, keptFields: [], missing: 0, otherKept: 0 };
  let step: "files" | "runs" = "files";
  const done = (message: string | null) => ({
    ...outcome(), runsUndone: runs.undone, runsLeft: runs.left, runChangesKept: runs.keptFields.length + runs.missing + runs.otherKept,
    keptFields: runs.keptFields, fieldsMissing: runs.missing,
    ...(runs.sharedReversals?.length ? { sharedReversals: runs.sharedReversals } : {}),
    wroteAutomations: definitions.length > 0 || protectedAutomations, sendsMessages: messages,
    unfinished: message === null ? null : { step, message },
  });
  try {
    await dependencies.recordDefinitions?.(definitions);
    for (const receipt of recovered) await receipts.add(receipt);
    await receipts.flush();
    for (let start = 0; start < restorable.length; start += DURABLE_BATCH_ITEMS) {
      const batch = restorable.slice(start, start + DURABLE_BATCH_ITEMS);
      await dependencies.recordRestoreIntents?.(batch.map(({entry}) => entry.first.momentId));
      for (const { entry, head } of batch) {
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
          review.set(entry.last.path, { path: entry.last.path, reason: "restore-refused", detail: result.detail.slice(0, 500), refusal: result.refusal });
          continue;
        }
        if (result.kind === "rules-unreadable") {
          review.set(entry.last.path, { path: entry.last.path, reason: "rules-unreadable", unreadable: result.unreadable });
          continue;
        }
        const receipt = { ...result.receipt, ...(entry.first.created ? { removed: true } : {}) };
        await receipts.add({receipt, originalMomentId: entry.first.momentId, ...(isCreatedSchema(entry) ? {folder} : {})});
      }
      await receipts.flush();
    }
    await receipts.flush();
    await removeRecoveredFolders();
    if (definitions.length > 0) {
      step = "runs";
      const undone = await dependencies.undoRuns(definitions);
      runs = undone;
      if (undone.errorMessage !== null) return done(undone.errorMessage);
    }
  } catch (error) {
    try { await receipts.flush(); await removeRecoveredFolders(); }
    catch (flushError) { error = flushError; }
    if (error instanceof UndoRunsStopped) runs = error.runs;
    return done(error instanceof Error ? error.message : String(error));
  }
  return done(null);
}
