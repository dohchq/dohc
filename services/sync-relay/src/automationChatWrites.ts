import {
  NoticeNotSentError,
  readChatDirectory,
} from "@dohc/automation-executor/automation-chat";
import type {AutomationChatDependencies} from "@dohc/automation-executor/collection-automation-run";
import type {LinkedChatStore} from "@dohc/workspace-contracts/engine";
import {isNoticeTarget, type PostNoticeRequest} from "@dohc/workspace-contracts/relay";
import {ChatsLiveAdapter} from "@dohc/workspace-engine-client";
import type {TokenBucketLimiter} from "@dohc/service-http";
import type {AutomationReplica} from "./automationReplicas";
import {RelayError} from "./errors";
import {parsePostNotice} from "./noticeRoutes";
import type {SyncRelayStorage} from "./storage";

/** The chat calls an automation's messages make in this server's replica. */
export type ReplicaChatStore = Pick<LinkedChatStore, "listChannels" | "getChannelWireId" | "listChannelThreads"> &
  Pick<ChatsLiveAdapter, "startChannelThread" | "sendMessage" | "getMessage" | "findThreadChannelId">;

/** The chat store of one open replica, with channels named as the chat contract names them. */
export function replicaChatStore(replica: Pick<AutomationReplica, "client" | "workspace" | "workspaceId">): ReplicaChatStore {
  const adapter = new ChatsLiveAdapter(replica.client, replica.workspace, {workspaceId: replica.workspaceId});
  return {
    listChannels: async (input) => (await adapter.listChannels(input)).map(({channelId, ...channel}) => ({...channel, id: channelId})),
    getChannelWireId: (input) => adapter.getChannelWireId(input),
    listChannelThreads: (input) => adapter.listChannelThreads(input),
    startChannelThread: (input) => adapter.startChannelThread(input),
    sendMessage: (input) => adapter.sendMessage(input),
    getMessage: (input) => adapter.getMessage(input),
    findThreadChannelId: (input) => adapter.findThreadChannelId(input),
  };
}

// A wake needs the person's own computer: their agent and its "My agent"
// thread live there, and this server has neither.
export const WAKE_ON_SERVER =
  "This server cannot wake your agent. Choose one of your computers under Schedules run on in Settings.";

/**
 * Where an automation on this server posts, and how it writes, in its
 * replica of the workspace. It reaches only what the replica holds: the
 * workspace's own Groups and the direct messages its owner started, never a
 * Group the owner joined in someone else's workspace. Each message names the
 * automation as its author, the owner as the person it ran for, and the
 * run's chain depth, and is recorded under its effect id, so a retry replays
 * it. The owner comes from the relay's records, never from a caller.
 *
 * The engine refuses a replay whose author names changed, as when the owner
 * renamed themselves. The effect's message id is the effect's alone, so a
 * write that fails while that message is already in the replica, from this
 * automation and where the effect put it, landed before and counts as sent.
 */
export function replicaAutomationChat(input: {
  replica: Pick<AutomationReplica, "workspaceId" | "ownerUserId" | "signal">;
  store: ReplicaChatStore;
  /** The owner's name, shown beside the automation's messages. */
  ownerName(): Promise<string>;
}): AutomationChatDependencies {
  const {replica, store} = input;
  const {workspaceId} = replica;
  return {
    directory: async (roster, needs) =>
      replica.signal.aborted ? null : await readChatDirectory(store, workspaceId, roster, needs),
    async write(signal, message) {
      if (message.target.kind === "agent") throw new Error(WAKE_ON_SERVER);
      const run = AbortSignal.any([signal, replica.signal]);
      run.throwIfAborted();
      const authorOwnerDisplayName = await input.ownerName();
      run.throwIfAborted();
      const fields = {
        workspaceId,
        messageId: message.messageId,
        idempotencyKey: message.effectId,
        author: {kind: "automation" as const, displayName: message.automation.name},
        authorOwnerDisplayName,
        authorUserId: replica.ownerUserId,
        automation: {automationId: message.automation.automationId, chainDepth: message.automation.depth},
        body: message.body,
      };
      try {
        return message.target.kind === "group"
          ? await store.startChannelThread({...fields, channelId: message.target.channelId, lane: message.target.lane, threadId: message.threadId})
          : await store.sendMessage({...fields, threadId: message.target.threadId});
      } catch (error) {
        const sent = await store.getMessage({workspaceId, messageId: message.messageId}).catch(() => null);
        if (sent === null || sent.author.kind !== "automation" || sent.automation?.automationId !== message.automation.automationId) throw error;
        const where = message.target.kind === "group"
          ? await store.findThreadChannelId({workspaceId, threadId: sent.threadId}).catch(() => null) === message.target.channelId
          : sent.threadId === message.target.threadId;
        if (!where) throw error;
        return sent;
      }
    },
  };
}

/** A notice this server sends for a workspace's automations. */
export type ServerNotice = Pick<PostNoticeRequest, "noticeId" | "kind" | "title" | "body" | "target"> & { recipientUserId: string };

/**
 * Sends an automation's notice from this server, in process, as the relay's
 * notice route would for the workspace owner: the owner is the sender, and
 * the relay checks that the person can read what the notice points to. A
 * notice to someone else counts against the owner's limit on the route.
 */
export function replicaNoticePoster(input: {
  replica: Pick<AutomationReplica, "workspaceId" | "ownerUserId" | "signal">;
  storage: Pick<SyncRelayStorage, "postNotice">;
  /** The notice route's limiter, so the server and the owner's computers share one limit. */
  noticeLimiter: TokenBucketLimiter;
  ownerName(): Promise<string>;
  nowMs(): number;
}): (notice: ServerNotice, signal: AbortSignal) => Promise<void> {
  const {replica, storage} = input;
  return async (notice, signal) => {
    const run = AbortSignal.any([signal, replica.signal]);
    run.throwIfAborted();
    const senderLabel = await input.ownerName();
    run.throwIfAborted();
    const nowMs = input.nowMs();
    if (notice.recipientUserId !== replica.ownerUserId && !input.noticeLimiter.allow(replica.ownerUserId, nowMs)) {
      throw new NoticeNotSentError("Too many notices went to other people. Wait a minute, then try again.");
    }
    try {
      // The route's own checks, so the list never holds a notice the route would refuse.
      const posted = parsePostNotice({
        noticeId: notice.noticeId,
        recipientUserId: notice.recipientUserId,
        workspaceId: replica.workspaceId,
        kind: notice.kind,
        title: notice.title,
        body: notice.body,
        target: notice.target,
        originInstallId: "server",
      });
      storage.postNotice({...posted, recipientUserId: notice.recipientUserId, senderUserId: replica.ownerUserId, senderLabel, nowMs});
    } catch (error) {
      if (error instanceof RelayError && error.code === "bad_request") {
        // The executor cuts the title and body to fit, so what a person can
        // cause here is a path a notice cannot hold.
        const { path } = notice.target;
        throw new NoticeNotSentError(isNoticeTarget(notice.target)
          ? "This server refused the notice."
          : path !== undefined && path !== path.trim()
            ? "This notice points to a path that starts or ends with whitespace."
            : "This notice points to a path too long to send.");
      }
      if (error instanceof RelayError && error.code === "notice_refused") {
        throw new NoticeNotSentError("This person can't open what the notice points to.");
      }
      if (error instanceof RelayError && error.code === "notice_list_full") {
        throw new NoticeNotSentError("This person has too many unread notices to get this one.");
      }
      throw error;
    }
  };
}
