import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { workspaceName } from "../chats/workspaceName";
import type { SubmitOutcome } from "../conversation/conversationWrites";
import type { Decision, LocalMark } from "../conversation/types";
import type { LocalActions } from "../conversation/useOutbox";
import type { NoticeRecord } from "../server/notices";
import type { WorkspaceList } from "../server/workspaceList";
import type { NoticeAction } from "./noticeWrites";

// A row in the phone's Notices, and how a Notice from the server becomes one.

export type SenderKind = "person" | "agent" | "automation";

export interface PhoneNotice {
  /** Unique in the list. A Notice from the server has `relay:` and its ID; a failure held on this phone, its own. */
  readonly id: string;
  /** The server's ID of a Notice it sent: marks go to the server. Absent for a failure held on this phone. */
  readonly relayId?: string;
  /** Null for a failure held on this phone, which has no sender. */
  readonly senderKind: SenderKind | null;
  readonly senderLabel: string;
  readonly title: string;
  readonly body?: string;
  /** How long ago it arrived; the row shows "2m ago" and VoiceOver hears "2 minutes ago". */
  readonly minutesAgo: number;
  /** When it arrived, when known: its time then counts from here, not from `minutesAgo`. */
  readonly atMs?: number;
  readonly read: boolean;
  /** Another workspace's name, shown beside the time. */
  readonly folder?: string;
  /**
   * The row's worded action, other than Try again: Open, Open note, Reply to the message a mention names, or Answer the
   * agent's question an agent-run Notice names, in the row.
   */
  readonly open?: "open" | "openNote" | "reply" | "answer";
  /** Where Open or Reply goes, in a sample build: a chat, or a thread with a message chosen to reply to. */
  readonly openChat?: {
    readonly id: string;
    readonly name?: string;
    readonly thread?: "1";
    readonly reply?: string;
  };
  /** What Open or Reply does, for a Notice from the server whose target the phone shows. */
  readonly onOpen?: () => void;
  /** The read that would offer Reply failed: the row says so, and this is its Try again. */
  readonly retryTarget?: () => void;
  /** What it's about opens only on a computer. */
  readonly elsewhere?: boolean;
  readonly retry?: boolean;
  /** What Try again does, for a failure held on this phone. */
  readonly onRetry?: () => void;
  /** A wake from the server waits for a computer; dismissing it would cancel it. */
  readonly dismissible: boolean;
  readonly failed?: boolean;
  /** The agent's question the Notice names, and this phone's answers to it, in the row (NoticeAnswer.tsx). */
  readonly answer?: NoticeAnswerView;
}

/**
 * What a row shows of the question an agent-run Notice names. It shows while a read shows the question or this phone
 * keeps an answer to it, so an answer queued for a workspace that later hides stays in sight, with Discard.
 */
export interface NoticeAnswerView {
  /**
   * The question as a current read shows it, or as the open answer's visit verified it, through a failed read. Null
   * when neither does.
   */
  readonly question: {
    readonly id: string;
    readonly authorName: string;
    readonly body: string;
  } | null;
  readonly decision: Decision;
  /** This phone's answers that aren't saved, oldest first: Send on a withheld one, Copy, and Discard on each. */
  readonly marks: readonly LocalMark[];
  /** The open visit's number, which keys its field, or null while the row's answer isn't open. */
  readonly editing: number | null;
  /** A current read shows the question. Without one, the open answer keeps its text with Send off. */
  readonly current: boolean;
  /** Whether a new answer may go now: the latest list and read verify the question, open. */
  readonly answerable: boolean;
  /** Whether Send may go on a withheld answer: the latest list and read still show the question. */
  readonly sendable: boolean;
  /** Closes the row's answer. */
  cancel(): void;
  /** Opens the question's thread, as Open does, when the phone shows it. */
  open?(): void;
  /** Answers with `body`, or with a poll's `option`. */
  submit(body: string, option?: string): Promise<SubmitOutcome>;
  /** The open answer's text, kept above the recycled rows, for its field to show again when the row returns. */
  draft(): string;
  /** Keeps the open answer's text as its field reports it. */
  keepDraft(text: string): void;
  /** Send, Copy and Discard on this phone's answers. */
  readonly actions: LocalActions;
}

/** Where a Notice's Open goes on the phone. */
export type PhoneTarget =
  | {
      readonly kind: "thread";
      readonly workspaceId: string;
      readonly threadId: string;
      readonly messageId: string | null;
    }
  | { readonly kind: "page"; readonly workspaceId: string; readonly path: string }
  | { readonly kind: "agents" };

/**
 * Where the phone can open a Notice's target, or null when only a computer can. A thread or page opens only in a
 * workspace the account's list, as the server last confirmed it, shows on this phone and can open. The Notice's
 * placement alone proves nothing.
 */
export function phoneTarget(record: NoticeRecord, list: WorkspaceList): PhoneTarget | null {
  const target = record.target;
  if (!target) return null;
  if (target.settings === "agents") return { kind: "agents" };
  const workspaceId = record.workspaceId;
  if (workspaceId === null || list.status !== "ready" || list.pending.has(workspaceId)) return null;
  const entry = list.workspaces.find((item) => item.workspaceId === workspaceId);
  if (!entry?.showOnPhone || !entry.canOpen) return null;
  if (target.thread !== undefined)
    return {
      kind: "thread",
      workspaceId,
      threadId: target.thread,
      messageId: target.message ?? null,
    };
  if (target.path !== undefined && fileKindForPath(target.path).displayKind === "markdown")
    return { kind: "page", workspaceId, path: target.path };
  return null;
}

const openWord = (target: PhoneTarget): NonNullable<PhoneNotice["open"]> =>
  target.kind === "page" ? "openNote" : "open";

/** The row's first action from its target alone: Open where the phone shows it, else only a computer opens it. */
const openAction = (record: NoticeRecord, list: WorkspaceList): NoticeAction => {
  const target = phoneTarget(record, list);
  return target ? { kind: "open", target, readFailed: false } : { kind: "elsewhere" };
};

/**
 * The row for a Notice from the server. It shows the title and body the phone's scope sent, as plain text, and
 * nothing else of the Notice's words. `action` is its first action (`noticeAction`); without one, it opens its target.
 */
export function presentNotice(
  record: NoticeRecord,
  context: {
    readonly list: WorkspaceList;
    readonly currentWorkspaceId: string | null;
    readonly action?: NoticeAction;
    open(record: NoticeRecord, target: PhoneTarget): void;
    /** Reply on a mention whose message a read showed. The handler checks again before it goes. */
    reply?(record: NoticeRecord): void;
    /** Answer on an agent's question a read verified, which opens the row's answer. It checks again too. */
    answer?(record: NoticeRecord): void;
    /** Try again on the read that would offer Reply or Answer. */
    retryTarget?(record: NoticeRecord): void;
  },
): PhoneNotice {
  const { reply, answer, retryTarget } = context;
  const given = context.action ?? openAction(record, context.list);
  const action =
    (given.kind === "reply" && !reply) || (given.kind === "answer" && !answer)
      ? openAction(record, context.list)
      : given;
  const workspace =
    context.list.status === "ready" && record.workspaceId !== context.currentWorkspaceId
      ? context.list.workspaces.find((item) => item.workspaceId === record.workspaceId)
      : undefined;
  return {
    id: `relay:${record.noticeId}`,
    relayId: record.noticeId,
    senderKind: record.senderKind,
    senderLabel: record.senderLabel,
    title: record.title,
    ...(record.body === "" ? {} : { body: record.body }),
    minutesAgo: 0,
    atMs: record.createdAtMs,
    read: record.readAtMs !== null,
    ...(workspace ? { folder: workspaceName(workspace) } : {}),
    ...(action.kind === "reply" && reply
      ? { open: "reply" as const, onOpen: () => reply(record) }
      : action.kind === "answer" && answer
        ? { open: "answer" as const, onOpen: () => answer(record) }
        : action.kind === "open"
          ? {
              open: openWord(action.target),
              onOpen: () => context.open(record, action.target),
              ...(action.readFailed && retryTarget
                ? { retryTarget: () => retryTarget(record) }
                : {}),
            }
          : { elsewhere: true }),
    // A wake waits for a computer: the phone offers it no swipe and no Done, though its scope leaves wakes out.
    dismissible: record.kind !== "automation-wake",
    ...(record.kind === "automation-failed" ? { failed: true } : {}),
  };
}
