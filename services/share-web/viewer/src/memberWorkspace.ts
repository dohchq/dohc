import { normalizeShareLabel } from "@dohc/security-contract/share-labels";
import { ended, type ChatChannelClient, type Ended } from "./ChatChannel";
import {
  CHAT_FOLLOW_HOLD_MS,
  CHAT_PAGE_LIMIT,
  chatBodyTooLong,
  chatMessage,
  chatRequest,
  deletedMessage,
  deleteNamedChatMessage,
  followNamedChat,
  NamedChatError,
  normalizeChatBody,
  postNamedChatMessage,
  readNamedChatHistory,
  type DeletedChatMessage,
  type NamedChatChannel,
  type NamedChatComments,
  type NamedChatMessage,
  type NamedChatPlace,
} from "./namedChat";
import { RETRY_INITIAL_MS, RETRY_MAX_MS } from "./retry";

// A workspace member's browser reads the workspace through its grant. The account
// cookie names the person; the page names only the grant.

/** The view routes' session for a member: the grant, which the account cookie must hold. */
export const memberSession = (grantId: string) => `member.${grantId}`;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new NamedChatError(0);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

export interface MemberGroups {
  shareId: string;
  userId: string;
  maxPostBytes: number;
  maxBodyBytes: number;
  /** The owner or an admin, who can delete anyone's message. */
  moderates: boolean;
  groups: NamedChatChannel[];
}

/** Every Group the member reaches, in the workspace's order. */
export async function openMemberGroups(
  grantId: string,
  signal: AbortSignal,
): Promise<MemberGroups> {
  const value = await chatRequest(
    `/api/named-chat/channels?${new URLSearchParams({ grantId })}`,
    signal,
  );
  if (
    typeof value.shareId !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.moderates !== "boolean" ||
    !positive(value.maxPostBytes) ||
    !positive(value.maxBodyBytes) ||
    !Array.isArray(value.channels)
  )
    throw invalid();
  const { shareId, userId } = value,
    maxPostBytes = Number(value.maxPostBytes),
    maxBodyBytes = Number(value.maxBodyBytes);
  const groups = value.channels.map((channel: unknown): NamedChatChannel => {
    if (
      !record(channel) ||
      typeof channel.channelWireId !== "string" ||
      (channel.access !== "read-only" && channel.access !== "read-write") ||
      (channel.type !== "posts" && channel.type !== "chat" && channel.type !== "both")
    )
      throw invalid();
    return {
      shareId,
      userId,
      channelWireId: channel.channelWireId,
      name: normalizeShareLabel(channel.name),
      access: channel.access,
      type: channel.type,
      maxPostBytes,
      maxBodyBytes,
    };
  });
  return { shareId, userId, maxPostBytes, maxBodyBytes, moderates: value.moderates, groups };
}

/** A member deletes their own messages; the owner or an admin deletes any. The relay decides. */
function memberRemove(
  place: NamedChatPlace,
  moderates: boolean,
): NonNullable<ChatChannelClient["remove"]> {
  const own = (message: NamedChatMessage) =>
    message.authorKind === "human" && message.authorUserId === place.userId;
  return {
    can: (message) => message.deletedAtMs === undefined && (moderates || own(message)),
    own,
    run: (message, signal) => deleteNamedChatMessage(place, message, signal),
  };
}

/** A current file's Comments: read, followed and posted by the file's path. */
export function commentsClient(comments: NamedChatComments, moderates: boolean): ChatChannelClient {
  return {
    access: comments.access,
    remove: memberRemove(comments, moderates),
    readHistory: (before, signal) => readNamedChatHistory(comments, before, signal),
    follow: (since, holdMs, signal) => followNamedChat(comments, since, holdMs, signal),
    post: (post, signal) => postNamedChatMessage(comments, post, signal),
    normalize: (text) => normalizeChatBody(text, comments),
    tooLong: (text) => chatBodyTooLong(text, comments),
  };
}

export interface GroupPage {
  messages: { channelWireId: string; message: NamedChatMessage }[];
  deleted: DeletedChatMessage[];
  nextCursor: number;
  hasMore: boolean;
}

/** One page of every Group's new messages after `since`. */
export async function followMemberGroups(
  shareId: string,
  since: number,
  holdMs: number,
  signal: AbortSignal,
): Promise<GroupPage> {
  const query = new URLSearchParams({
    shareId,
    since: String(since),
    hold: String(holdMs),
    limit: String(CHAT_PAGE_LIMIT),
  });
  const value = await chatRequest(`/api/named-chat/messages?${query}`, signal);
  if (
    value.shareId !== shareId ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.deleted) ||
    typeof value.hasMore !== "boolean" ||
    !Number.isSafeInteger(value.nextCursor) ||
    Number(value.nextCursor) < 0
  )
    throw invalid();
  const messages = value.messages.map((item: unknown) => {
    if (!record(item) || typeof item.channelWireId !== "string") throw invalid();
    const { channelWireId, ...fields } = item;
    return { channelWireId, message: chatMessage(fields) };
  });
  return {
    messages,
    deleted: value.deleted.map(deletedMessage),
    nextCursor: Number(value.nextCursor),
    hasMore: value.hasMore,
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

// Enough for any Group a person reads at once. An older message is in the Group's history.
const BUFFERED_PER_GROUP = 500;
type FollowPage = {
  messages: NamedChatMessage[];
  deleted: DeletedChatMessage[];
  nextCursor: number;
  hasMore: boolean;
};
type Waiter = {
  wireId: string;
  since: number;
  resolve(page: FollowPage): void;
  reject(error: unknown): void;
};

/**
 * One follow per tab for every Group. The open Group's view follows through
 * `client`, served from the same request; `onMessages` hears how many messages
 * from other people each Group received, so the page can count them.
 */
export function createGroupFollow(options: {
  shareId: string;
  userId: string;
  follow?: typeof followMemberGroups;
  onMessages(counts: ReadonlyMap<string, number>): void;
  onEnded(reason: Ended): void;
}) {
  const follow = options.follow ?? followMemberGroups;
  // A delete names no Group, so every Group's view hears it; one it does not hold changes nothing.
  // Each is kept with the cursor of the page that brought it.
  let deletes: { at: number; deleted: DeletedChatMessage }[] = [];
  const buffers = new Map<string, NamedChatMessage[]>(),
    counted = new Map<string, number>(),
    waiters = new Set<Waiter>();
  let cursor: number | null = null,
    floor = 0,
    loop: AbortController | null = null,
    over = false;

  const ready = (wireId: string, since: number): FollowPage | null => {
    const messages = (buffers.get(wireId) ?? []).filter((item) => item.relaySeq > since);
    const deleted = deletes.filter((item) => item.at > since).map((item) => item.deleted);
    return messages.length || deleted.length || cursor! > since
      ? { messages, deleted, nextCursor: cursor!, hasMore: false }
      : null;
  };
  const settle = () => {
    for (const waiter of [...waiters]) {
      const page = ready(waiter.wireId, waiter.since);
      if (page) {
        waiters.delete(waiter);
        waiter.resolve(page);
      }
    }
  };
  const fail = (error: unknown) => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter.reject(error);
    }
  };
  const receive = (page: GroupPage) => {
    const counts = new Map<string, number>();
    for (const { channelWireId, message } of page.messages) {
      const buffer = buffers.get(channelWireId) ?? [];
      if (!buffer.some((item) => item.relaySeq === message.relaySeq)) {
        buffer.push(message);
        buffer.sort((left, right) => left.relaySeq - right.relaySeq);
        buffers.set(channelWireId, buffer.slice(-BUFFERED_PER_GROUP));
      }
      // A restarted follow can return a message again; it counts once.
      if (
        message.authorUserId !== options.userId &&
        message.relaySeq > (counted.get(channelWireId) ?? 0)
      ) {
        counted.set(channelWireId, message.relaySeq);
        counts.set(channelWireId, (counts.get(channelWireId) ?? 0) + 1);
      }
    }
    cursor = page.nextCursor;
    deletes = [
      ...deletes,
      ...page.deleted.map((deleted) => ({ at: page.nextCursor, deleted })),
    ].slice(-BUFFERED_PER_GROUP);
    if (counts.size) options.onMessages(counts);
    settle();
  };

  const run = () => {
    loop?.abort();
    if (over || cursor === null || document.visibilityState !== "visible") {
      loop = null;
      return;
    }
    const controller = new AbortController();
    loop = controller;
    const current = () => loop === controller && !controller.signal.aborted;
    void (async () => {
      let delay = RETRY_INITIAL_MS,
        hold = 0;
      while (current()) {
        try {
          const page = await follow(options.shareId, cursor!, hold, controller.signal);
          if (!current()) return;
          hold = page.hasMore ? 0 : CHAT_FOLLOW_HOLD_MS;
          delay = RETRY_INITIAL_MS;
          receive(page);
        } catch (error) {
          if (!current()) return;
          const reason = ended(error);
          fail(error);
          if (reason) {
            over = true;
            loop = null;
            options.onEnded(reason);
            return;
          }
          // A request the server cannot read waits for the Group's Try again.
          if (error instanceof NamedChatError && error.status === 400) {
            loop = null;
            return;
          }
          await pause(delay, controller.signal);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    })();
  };
  const visibility = () => {
    if (document.visibilityState === "visible") {
      if (!loop) run();
    } else {
      loop?.abort();
      loop = null;
    }
  };
  document.addEventListener("visibilitychange", visibility);

  const followGroup = (wireId: string, since: number, signal: AbortSignal) => {
    // The buffers hold every Group's messages after `floor`. A Group that read its history before that starts the follow again there.
    if (cursor === null || since < floor) {
      floor = since;
      cursor = since;
      run();
    } else if (!loop) run();
    const page = ready(wireId, since);
    if (page) return Promise.resolve(page);
    return new Promise<FollowPage>((resolve, reject) => {
      const waiter: Waiter = {
        wireId,
        since,
        resolve,
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      const abort = () => {
        waiters.delete(waiter);
        reject(signal.reason);
      };
      waiter.resolve = (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      signal.addEventListener("abort", abort, { once: true });
      waiters.add(waiter);
    });
  };
  return {
    client(group: NamedChatChannel, moderates: boolean): ChatChannelClient {
      return {
        access: group.access,
        remove: memberRemove(group, moderates),
        readHistory: (before, signal) => readNamedChatHistory(group, before, signal),
        follow: (since, _holdMs, signal) => followGroup(group.channelWireId, since, signal),
        post: (post, signal) => postNamedChatMessage(group, post, signal),
        normalize: (text) => normalizeChatBody(text, group),
        tooLong: (text) => chatBodyTooLong(text, group),
      };
    },
    close() {
      over = true;
      loop?.abort();
      loop = null;
      document.removeEventListener("visibilitychange", visibility);
      fail(new DOMException("Closed", "AbortError"));
    },
  };
}
