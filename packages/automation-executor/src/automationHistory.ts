import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseAutomationsFile, type AutomationEntry } from "@dohc/workspace-contracts/automations";
import type { MomentAuthor, VersionedTextMoment } from "@dohc/workspace-contracts/engine";

export type AutomationHistoryMoment = Pick<VersionedTextMoment, "operation" | "authors"> & {
  payload: { before?: { text?: string } | null; after: { text: string } };
};
/** One file's History, as the owner's computer reads it. */
export interface AutomationsFileHistory {
  /** Waits until every change the engine has seen is in History. */
  flush(): Promise<void>;
  fileObjectIdForPath(path: string): Promise<string | null>;
  /** One page of the file's moments, newest first, and where the next page starts. */
  listMoments(input: { objectId: string; limit: number; beforeMomentOrder?: number }): Promise<{
    moments: ReadonlyArray<{ id: string; protected: boolean }>;
    nextBeforeMomentOrder: number | null;
  }>;
  readMoment(momentId: string): Promise<{ protected: false; moment: AutomationHistoryMoment } | { protected: true } | null>;
}

// How far back History is read for a change to one automation.
const HISTORY_PAGE = 50;
const HISTORY_MOMENTS = 1_000;

/** The automation's entry in one side of a moment, or null when that side does not have it. */
function entryIn(text: string | undefined, id: string): AutomationEntry | null {
  const parsed = text === undefined ? null : parseAutomationsFile(text);
  if (parsed?.status !== "read") return null;
  return parsed.entries.find((entry) => (entry.status === "valid" ? entry.automation.id : entry.id) === id) ?? null;
}

const isOn = (entry: AutomationEntry | null): boolean | null =>
  entry?.status === "valid" ? entry.automation.enabled : null;

/**
 * Who made a change, as History names them. A person the work was shared
 * with is their relay user id. The owner's own edits and their agents'
 * carry no person, so they are the owner, made on one of the owner's
 * computers. An automation's change is dohc's. An Edit link's change is the
 * link's, whose holder is not a person dohc can notify. A public link names
 * nobody. A moment names one author only when all its authors agree.
 */
type ChangeAuthor = { kind: "person"; userId: string } | { kind: "link" } | { kind: "dohc" } | { kind: "nobody" };
function authorOf(authors: MomentAuthor[] | undefined, ownerUserId: string): ChangeAuthor {
  const each = (authors ?? []).map((author) => entryAuthorOf(author, ownerUserId));
  const [first = entryAuthorOf(undefined, ownerUserId)] = each;
  return each.every((author) => isDeepStrictEqual(author, first)) ? first : { kind: "nobody" };
}
function entryAuthorOf(author: MomentAuthor | undefined, ownerUserId: string): ChangeAuthor {
  switch (author?.kind) {
    case undefined:
    case "agent":
    case "human":
      return { kind: "person", userId: ownerUserId };
    case "named":
      return { kind: "person", userId: author.userId };
    case "automation":
      return { kind: "dohc" };
    case "link":
      return { kind: "link" };
    case "public":
      return { kind: "nobody" };
  }
}

interface EntryChange {
  before: AutomationEntry | null;
  after: AutomationEntry | null;
  author: ChangeAuthor;
  /** The file's text after the change. */
  text: string;
}

/** Each change History shows to one automation's entry, newest first. */
async function* entryChanges(
  history: AutomationsFileHistory,
  input: { path: string; id: string; ownerUserId: string },
): AsyncGenerator<EntryChange> {
  await history.flush();
  const objectId = await history.fileObjectIdForPath(input.path);
  if (objectId === null) return;
  let beforeMomentOrder: number | undefined;
  for (let read = 0; read < HISTORY_MOMENTS;) {
    const page = await history.listMoments({
      objectId, limit: HISTORY_PAGE, ...(beforeMomentOrder === undefined ? {} : { beforeMomentOrder }),
    });
    for (const summary of page.moments) {
      read += 1;
      if (summary.protected) continue;
      const detail = await history.readMoment(summary.id);
      if (detail === null || detail.protected) continue;
      const { moment } = detail;
      const text = moment.operation === "delete" ? "" : moment.payload.after.text;
      const before = entryIn(moment.payload.before?.text, input.id);
      const after = moment.operation === "delete" ? null : entryIn(text, input.id);
      if (isDeepStrictEqual(before, after)) continue;
      yield { before, after, author: authorOf(moment.authors, input.ownerUserId), text };
    }
    if (page.nextBeforeMomentOrder === null) return;
    beforeMomentOrder = page.nextBeforeMomentOrder;
  }
}

/** The person whose change to the automation History shows last, past dohc's own. */
async function lastPersonIn(changes: AsyncGenerator<EntryChange>): Promise<string | null> {
  for await (const { author } of changes) {
    if (author.kind === "dohc") continue;
    return author.kind === "person" ? author.userId : null;
  }
  return null;
}

/** Who changed an automation last, as History names them, or null when it does not say. */
export async function whoChangedLast(
  history: AutomationsFileHistory,
  input: { path: string; id: string; ownerUserId: string },
): Promise<string | null> {
  return await lastPersonIn(entryChanges(history, input));
}

/**
 * The newest change in History that switched the automation off, who made
 * it, and who changed the automation last before that. Null when History
 * does not show both, or when dohc switched it off itself.
 */
export async function whoSwitchedOff(
  history: AutomationsFileHistory,
  input: { path: string; id: string; ownerUserId: string },
): Promise<{ switchedOffBy: SwitchedOffBy; lastChangedBy: string; contentHash: string } | null> {
  const changes = entryChanges(history, input);
  for await (const { before, after, author, text } of changes) {
    if (isOn(before) !== true || isOn(after) !== false) continue;
    if (author.kind !== "person" && author.kind !== "link") return null;
    const lastChangedBy = await lastPersonIn(changes);
    return lastChangedBy === null ? null : {
      switchedOffBy: author.kind === "person" ? { kind: "person", userId: author.userId } : { kind: "link" },
      lastChangedBy,
      contentHash: createHash("sha256").update(text).digest("hex"),
    };
  }
  return null;
}

/** Who switched an automation off: a person, or someone holding an Edit link. */
export type SwitchedOffBy = { kind: "person"; userId: string } | { kind: "link" };
