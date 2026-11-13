import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { workspaceName } from "../chats/workspaceName";
import type { NoticeRecord } from "../server/notices";
import type { WorkspaceList } from "../server/workspaceList";

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
  readonly open?: "open" | "openNote";
  /** Where Open goes, in a sample build: a chat. */
  readonly openChat?: { readonly id: string; readonly name: string };
  /** Where Open goes, for a Notice from the server whose target the phone shows. */
  readonly onOpen?: () => void;
  /** What it's about opens only on a computer. */
  readonly elsewhere?: boolean;
  readonly retry?: boolean;
  /** What Try again does, for a failure held on this phone. */
  readonly onRetry?: () => void;
  /** A wake from the server waits for a computer; dismissing it would cancel it. */
  readonly dismissible: boolean;
  readonly failed?: boolean;
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

/**
 * The row for a Notice from the server. It shows the title and body the phone's scope sent, as plain text, and
 * nothing else of the Notice's words.
 */
export function presentNotice(
  record: NoticeRecord,
  context: {
    readonly list: WorkspaceList;
    readonly currentWorkspaceId: string | null;
    open(record: NoticeRecord, target: PhoneTarget): void;
  },
): PhoneNotice {
  const target = phoneTarget(record, context.list);
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
    ...(target
      ? { open: openWord(target), onOpen: () => context.open(record, target) }
      : { elsewhere: true }),
    // A wake waits for a computer: no swipe or Dismiss touches it on the phone, though the relay leaves it out.
    dismissible: record.kind !== "automation-wake",
    ...(record.kind === "automation-failed" ? { failed: true } : {}),
  };
}
