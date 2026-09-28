import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseAutomationsFile, type AutomationEntry } from "@dohc/workspace-contracts/automations";
import type { MomentAuthor, VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { NOTICE_TITLE_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import { cutText, NoticeNotSentError } from "@dohc/automation-executor/automation-chat";
import {
  automationFailedElsewhereBody,
  automationFailedNotice,
  automationFailedNoticeId,
  type FailureComputer,
} from "@dohc/automation-executor/automation-failed-notice";
import type {
  AutomationFailureReport,
  AutomationSwitchedOff,
  CollectionAutomationRetry,
} from "@dohc/automation-executor/collection-automations";
import type { NoticeRef, NoticeRow } from "../ipc/bridgeContract";
import type { NoticeStore } from "../notices/noticeStore";

// Notices about automations that go to the people involved. A failed run
// goes to this computer's person, who can try it again here, and to the
// workspace's owner, the person who changed the automation last, and the
// person whose Group message, button press or edit started it. Switching
// off an automation tells the person who changed it last, unless they
// switched it off themselves.

/**
 * Sends a failure's notice, then takes back the one it replaces, then
 * sends the copy for the other people involved. Rejects when a notice
 * could not be sent for now, as with no connection, so the failure is
 * reported again; a person who cannot get it is skipped.
 */
export async function sendFailureNotices(
  dependencies: {
    notices: Pick<NoticeStore, "postNotice" | "withdraw">;
    computer: FailureComputer;
    /** This computer reaches the workspace through a share, so the relay finds its owner. */
    throughShare: boolean;
    /** Who changed the automation last, as History names them, or null when this computer cannot tell. */
    lastChangedBy(automationId: string): Promise<string | null>;
    onError(context: string, error: unknown): void;
  },
  workspaceId: string,
  report: AutomationFailureReport,
): Promise<void> {
  const { notices, computer } = dependencies;
  const notice = automationFailedNotice({ workspaceId, computer, failure: report.failure, name: report.name, collectionPath: report.collectionPath });
  await notices.postNotice(notice);
  if (report.replaces !== null) {
    await notices.withdraw(automationFailedNoticeId({ workspaceId, installId: computer.installId, failure: report.replaces }));
  }
  const { automation, path } = notice.target;
  const body = automationFailedElsewhereBody(report.failure, report.name);
  const copy = { ...notice, body, target: { automation, ...(path === undefined ? {} : { path }) } };
  const lastChangedBy = await dependencies.lastChangedBy(automation);
  // Your own id among these posts nothing more: your notice has the same id.
  const people = new Set([report.startedBy, lastChangedBy].filter((person): person is string => person !== null));
  const recipients = [
    ...(dependencies.throughShare ? [{ toWorkspaceOwner: true as const }] : []),
    ...[...people].map((recipientUserId) => ({ recipientUserId })),
  ];
  for (const recipient of recipients) {
    try {
      await notices.postNotice({ ...copy, ...recipient });
    } catch (error) {
      if (!(error instanceof NoticeNotSentError)) throw error;
      // The person cannot read the Collection, or no server carries notices.
      dependencies.onError(`send "${notice.title}" to another person involved`, error);
    }
  }
}

export const RETRY_NO_RUN = "This notice has no run to try again.";
export const RETRY_ELSEWHERE = "Only the computer this run failed on can try it again. The notice names that computer.";

/**
 * Try again on a failed run's notice. Only the computer that ran it holds
 * its claim, so only a notice this person posted from this computer runs
 * anything; what a notice names grants nothing by itself. Once the run is
 * queued, its notice is dismissed on every computer.
 */
export async function retryFromFailureNotice(
  dependencies: {
    notices: Pick<NoticeStore, "list" | "mark">;
    retry(notice: NoticeRow, input: { automationId: string; claimId: string; startOver: boolean }): Promise<CollectionAutomationRetry>;
  },
  input: { notice: NoticeRef; account: string | null; startOver: boolean },
): Promise<CollectionAutomationRetry> {
  const listed = await dependencies.notices.list();
  const notice = listed.account === input.account
    ? listed.notices.find((row) => row.store === input.notice.store && row.noticeId === input.notice.noticeId)
    : undefined;
  const target = notice?.target;
  if (!notice || notice.kind !== "automation-failed" || !target?.automation || !target.run) {
    return { status: "refused", reason: RETRY_NO_RUN };
  }
  if (!notice.postedHere) return { status: "refused", reason: RETRY_ELSEWHERE };
  const result = await dependencies.retry(notice, {
    automationId: target.automation,
    claimId: target.run,
    startOver: input.startOver,
  });
  if (result.status === "queued") await dependencies.notices.mark([input.notice], "dismissed", input.account);
  return result;
}

/** Try again as the CLI and MCP answer it: a refusal for another computer's run carries the notice that names it. */
export type AutomationRunRetry =
  | Exclude<CollectionAutomationRetry, { status: "refused" }>
  | { status: "refused"; reason: string; notice?: { title: string; body: string } };

/**
 * Try again for a run named by its automation and claim, as the CLI and MCP
 * ask for it. A run this computer holds goes to its executor, as Try again
 * in the ⚡ panel does, and the executor takes its notice back once the run
 * is queued. For any other run, the notice's rule applies: when this person
 * sent themselves a failure notice about it from another computer, even one
 * they dismissed since, the retry is refused with that notice's text, which
 * names the computer.
 */
export async function retryAutomationRun(
  dependencies: {
    notices: Pick<NoticeStore, "sentFailure">;
    installId: string;
    /** Whether this computer's executor holds the run's claim. */
    holds(run: { automationId: string; claimId: string }): Promise<boolean>;
    retry(input: { automationId: string; claimId: string; startOver: boolean }): Promise<CollectionAutomationRetry>;
  },
  input: { workspaceId: string; automationId: string; claimId: string; startOver: boolean },
): Promise<AutomationRunRetry> {
  const { workspaceId, ...run } = input;
  if (!(await dependencies.holds(run))) {
    const sent = await dependencies.notices.sentFailure({ workspaceId, automationId: run.automationId, claimId: run.claimId });
    if (sent !== null && sent.originInstallId !== dependencies.installId) {
      return { status: "refused", reason: RETRY_ELSEWHERE, notice: { title: sent.title, body: sent.body } };
    }
  }
  return await dependencies.retry(run);
}

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
  readMoment(momentId: string): Promise<{ protected: false; moment: VersionedTextMoment } | { protected: true } | null>;
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
 * link's, whose holder is not a person dohc can notify, and a public link's
 * names nobody.
 */
type ChangeAuthor = { kind: "person"; userId: string } | { kind: "link" } | { kind: "dohc" } | { kind: "nobody" };
function authorOf(author: MomentAuthor | undefined, ownerUserId: string): ChangeAuthor {
  switch (author?.kind) {
    case undefined:
    case "agent":
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
      yield { before, after, author: authorOf(moment.author, input.ownerUserId), text };
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

export interface SwitchedOffNotice {
  workspaceId: string;
  noticeId: string;
  kind: "automation-switched-off";
  title: string;
  body: string;
  target: { automation: string; path: string };
  recipientUserId: string;
}

/**
 * The notice for the person who changed an automation last, when someone
 * else switched it off. The id comes from the file as it was switched off,
 * so each of the owner's computers that reads the change posts one notice.
 */
export function switchedOffNotice(input: {
  workspaceId: string;
  switched: AutomationSwitchedOff;
  path: string;
  switchedOffBy: SwitchedOffBy;
  lastChangedBy: string;
  contentHash: string;
  /** The name the notice shows for the person who switched it off. */
  switcherName: string;
}): SwitchedOffNotice | null {
  const { workspaceId, switched, switchedOffBy, lastChangedBy } = input;
  if (switchedOffBy.kind === "person" && switchedOffBy.userId === lastChangedBy) return null;
  const digest = createHash("sha256")
    .update(JSON.stringify([workspaceId, switched.automationId, input.contentHash]))
    .digest("hex");
  const who = cutText(input.switcherName.trim() || "Someone", 40);
  const suffix = `${who} switched off `;
  const name = `"${cutText(switched.name, NOTICE_TITLE_MAX_CHARS - [...suffix].length - 2)}"`;
  return {
    workspaceId,
    noticeId: `automation-switched-off:${digest.slice(0, 40)}`,
    kind: "automation-switched-off",
    title: `${suffix}${name}`,
    body: "You changed it last.",
    target: { automation: switched.automationId, path: input.path },
    recipientUserId: lastChangedBy,
  };
}

/**
 * The name a switch-off notice shows for who did it. The owner shows by
 * the name they chose. A person the work was shared with shows by email
 * only to the owner, who shared with that email; anyone else sees
 * "Someone". Someone holding an Edit link shows as that, to everyone.
 */
export function switcherNameFor(input: {
  switchedOffBy: SwitchedOffBy;
  recipient: string;
  ownerUserId: string;
  ownerName: string | null;
  emailOf(userId: string): string | null;
}): string {
  const by = input.switchedOffBy;
  if (by.kind === "link") return "Someone with an Edit link";
  if (by.userId === input.ownerUserId) return input.ownerName ?? "The workspace owner";
  if (input.recipient !== input.ownerUserId) return "Someone";
  return input.emailOf(by.userId) ?? "Someone you shared with";
}
