import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { ChatThreadLane, LinkedChatStore } from "@dohc/workspace-contracts/engine";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { RegistryEntry } from "./registryStore";
import { assertJoinedChannelWritable, joinedSharedChannelForWireId } from "./sharedChannels";
import { shareViewIsPresent } from "./shareViewMarker";
import {
  assertSharedChannelMessageIdentity,
  chatRelayAuthorId,
  type ChatRelayIdentityStore,
  type ChatRelayIdentityTarget,
} from "./chatRelayIdentity";

// The one main-process path for chat writes, whoever makes them. The renderer
// always writes as the local person. The CLI, and MCP through it, names its
// actor, and its messages carry origin "cli" so no device dispatches an agent
// on them. Identity is never the caller's: it comes from the registry and the
// signed-in session.
export type ChatWriter =
  | { via: "renderer" }
  | { via: "cli"; actor: "human" | "agent" };

export type ChatWriteStore = ChatRelayIdentityStore & Pick<LinkedChatStore,
  "createThread" | "sendMessage" | "startChannelThread" | "resolveChatDecision" |
  "listReactions" | "setReaction">;

export interface ChatWritePlace {
  workspaceId: string;
  store: ChatWriteStore;
}

type ChatWorkspace = Pick<RegistryEntry, "remote" | "shareView" | "sharedChannels">;

type ChatAttachments = NonNullable<Parameters<LinkedChatStore["sendMessage"]>[0]["attachments"]>;

interface ChatMessageInput {
  writer: ChatWriter;
  body: string;
  needsDecision?: boolean;
  options?: string[];
  // Runs between admission and the final check, so a slow file lookup cannot
  // carry a stale grant or session into the write.
  resolveAttachments(): Promise<ChatAttachments>;
}

export function createChatWrites(dependencies: {
  findWorkspace(workspaceId: string): ChatWorkspace | null;
  warmCredentials(): Promise<unknown>;
  currentCredentials(): CloudCredentials | null;
  localUserDisplayName(): string;
  agentDisplayName(): Promise<string>;
  // The stable per-install id a signed-out reaction is authored under.
  localReactorFallbackId(): string;
  projectChatBookmarks(workspaceId: string): void;
  queueCloudSync(workspaceId: string): void;
  syncSharedChannelsForChatTarget(
    workspaceId: string, target: ChatRelayIdentityTarget,
  ): Promise<unknown>;
  scanChatDispatch(workspaceId: string): Promise<unknown>;
}) {
  const {
    findWorkspace, warmCredentials, currentCredentials, localUserDisplayName,
    agentDisplayName, localReactorFallbackId, projectChatBookmarks, queueCloudSync,
    syncSharedChannelsForChatTarget, scanChatDispatch,
  } = dependencies;

  // Every received file share is read-only for chat, whatever its cached relay
  // capability: there is no durable per-row relay receipt yet.
  function ownedWorkspace(workspaceId: string): ChatWorkspace {
    const workspace = findWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (shareViewIsPresent(workspace.shareView)) {
      throw new SharedFileReadOnlyError("Chats are read-only in this shared view.");
    }
    return workspace;
  }

  // The only awaits a check depends on: the target's channel wire id, which
  // never changes for a thread or channel, and the credential cache. A
  // workspace with no joined channels needs no store read. undefined means
  // the wire id was not looked up.
  async function resolveTarget(place: ChatWritePlace, target: ChatRelayIdentityTarget) {
    const workspace = ownedWorkspace(place.workspaceId);
    let channelWireId: string | null | undefined;
    if ((workspace.sharedChannels?.length ?? 0) > 0) {
      const channelId = "channelId" in target
        ? target.channelId
        : await place.store.findThreadChannelId({ workspaceId: place.workspaceId, threadId: target.threadId });
      channelWireId = channelId
        ? await place.store.getChannelWireId({ workspaceId: place.workspaceId, channelId })
        : null;
    }
    await warmCredentials();
    return { channelWireId };
  }

  // Synchronous, so nothing can change between these checks and the write
  // that follows them. It reads the registry and the session as they are now.
  // `admitted` is the author an earlier check accepted; the session must still
  // resolve to it. The renderer disabling its composer is honesty, not
  // authorization.
  function check(
    place: ChatWritePlace,
    resolved: { channelWireId: string | null | undefined },
    admitted?: { authorUserId?: string },
  ): string | undefined {
    const workspace = ownedWorkspace(place.workspaceId);
    if (resolved.channelWireId === undefined && (workspace.sharedChannels?.length ?? 0) > 0) {
      throw new Error("This shared channel changed. Try again.");
    }
    const joinedChannel = resolved.channelWireId === undefined
      ? null
      : joinedSharedChannelForWireId(workspace.sharedChannels, resolved.channelWireId);
    assertJoinedChannelWritable(joinedChannel);
    const credentials = currentCredentials();
    const authorUserId = chatRelayAuthorId(workspace, joinedChannel, credentials);
    // A joined shared channel requires the account that joined it. Elsewhere
    // a signed-out write stays local and omits the relay author.
    assertSharedChannelMessageIdentity({
      joinedChannel, credentials, authorUserId, resolvedAuthorUserId: authorUserId,
    });
    if (admitted && authorUserId !== admitted.authorUserId) {
      throw new Error("Your server session changed. Try again.");
    }
    return authorUserId;
  }

  async function actorFor(writer: ChatWriter) {
    return writer.via === "cli" && writer.actor === "agent"
      ? {
          author: { kind: "agent" as const, displayName: await agentDisplayName() },
          authorOwnerDisplayName: localUserDisplayName(),
        }
      : { author: { kind: "human" as const, displayName: localUserDisplayName() } };
  }

  // Admit the write, do the caller's async work, then check again with no
  // await before the row, so it lands under the grant and session it started
  // with.
  async function prepareMessage(place: ChatWritePlace, target: ChatRelayIdentityTarget, input: ChatMessageInput) {
    const resolved = await resolveTarget(place, target);
    const authorUserId = check(place, resolved);
    const actor = await actorFor(input.writer);
    const attachments = await input.resolveAttachments();
    check(place, resolved, { authorUserId });
    return {
      ...actor,
      ...(authorUserId ? { authorUserId } : {}),
      ...(input.writer.via === "cli" ? { origin: "cli" as const } : {}),
      body: input.body,
      ...(input.needsDecision ? { needsDecision: true } : {}),
      ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  function afterWrite(workspaceId: string, target: ChatRelayIdentityTarget, message: boolean) {
    if (message) {
      // A message can mark a live bookmark projection pending, and a person's
      // message can call an agent.
      projectChatBookmarks(workspaceId);
      void scanChatDispatch(workspaceId).catch((error) => {
        console.error("[desktop] chat dispatch scan:", error);
      });
    }
    queueCloudSync(workspaceId);
    // Naming the target puts its joined channel in this pass instead of
    // leaving it to the rotation.
    void syncSharedChannelsForChatTarget(workspaceId, target).catch((error) => {
      console.error("[desktop] shared channel sync:", error);
    });
  }

  // A file chat has no author and belongs to no channel, so only the shared
  // view gate applies. It links the file's stable object id, never the path.
  async function createFileThread(place: ChatWritePlace, input: {
    title: string;
    linkedFile(): Promise<{ objectId: string; pathHint: string }>;
  }) {
    ownedWorkspace(place.workspaceId);
    const linkedFile = await input.linkedFile();
    ownedWorkspace(place.workspaceId);
    const thread = await place.store.createThread({
      workspaceId: place.workspaceId,
      title: input.title,
      linkedFile,
    });
    afterWrite(place.workspaceId, { threadId: thread.id }, false);
    return thread;
  }

  async function sendMessage(place: ChatWritePlace, input: ChatMessageInput & {
    threadId: string;
    parentMessageId?: string;
  }) {
    const target = { threadId: input.threadId };
    const fields = await prepareMessage(place, target, input);
    const message = await place.store.sendMessage({
      workspaceId: place.workspaceId,
      threadId: input.threadId,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      ...fields,
    });
    afterWrite(place.workspaceId, target, true);
    return message;
  }

  async function startThread(place: ChatWritePlace, input: ChatMessageInput & {
    channelId: string;
    lane?: ChatThreadLane;
    title?: string;
  }) {
    const target = { channelId: input.channelId };
    const fields = await prepareMessage(place, target, input);
    const started = await place.store.startChannelThread({
      workspaceId: place.workspaceId,
      channelId: input.channelId,
      ...(input.lane ? { lane: input.lane } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...fields,
    });
    afterWrite(place.workspaceId, target, true);
    return started;
  }

  // "toggle" removes the writer's reaction when one exists and adds it
  // otherwise. A reaction made signed out lives under the local id; once
  // signed in, removing it removes that alias too.
  async function setReaction(place: ChatWritePlace, input: {
    writer: ChatWriter;
    threadId: string;
    messageId: string;
    emoji: string;
    state: "added" | "removed" | "toggle";
  }) {
    const { workspaceId, store } = place;
    const target = { threadId: input.threadId };
    const localAuthorId = localReactorFallbackId();
    const aliased = (authorUserId: string | undefined): authorUserId is string =>
      authorUserId !== undefined && authorUserId !== localAuthorId;
    const resolved = await resolveTarget(place, target);
    const authorUserId = check(place, resolved);
    const { author } = await actorFor(input.writer);
    const existing = input.state === "toggle" || (input.state === "removed" && aliased(authorUserId))
      ? await store.listReactions({ workspaceId, threadId: input.threadId })
      : [];
    const reacted = (authorId: string | undefined) => existing.some((reaction) =>
      reaction.messageId === input.messageId && reaction.emoji === input.emoji &&
      reaction.author.authorId === authorId);
    const hasLocalAlias = reacted(localAuthorId);
    const hasCurrent = authorUserId !== undefined && reacted(authorUserId);
    const state = input.state !== "toggle"
      ? input.state
      : hasLocalAlias || hasCurrent ? "removed" : "added";
    // write() checks again right before each row, including the second row
    // of an alias removal.
    const write = (authorId: string, replicationAuthorId?: string) => {
      check(place, resolved, { authorUserId });
      return store.setReaction({
        workspaceId,
        threadId: input.threadId,
        messageId: input.messageId,
        emoji: input.emoji,
        author: { authorId, ...author },
        ...(replicationAuthorId ? { replicationAuthorId } : {}),
        state,
      });
    };
    let reaction: Awaited<ReturnType<typeof write>>;
    if (state === "removed" && aliased(authorUserId) && hasLocalAlias) {
      reaction = await write(localAuthorId);
      if (hasCurrent) reaction = await write(authorUserId, authorUserId);
    } else {
      reaction = await write(authorUserId ?? localAuthorId, authorUserId);
    }
    afterWrite(workspaceId, target, false);
    return reaction;
  }

  // A caller that just wrote the resolving reply passes it, so the decision
  // lands under the session the reply did.
  async function resolveDecision(place: ChatWritePlace, input: {
    threadId: string;
    messageId: string;
    resolvedByMessageId: string;
    chosenOption?: string;
    reply?: { authorUserId?: string };
  }) {
    const target = { threadId: input.threadId };
    check(place, await resolveTarget(place, target), input.reply);
    const decision = await place.store.resolveChatDecision({
      workspaceId: place.workspaceId,
      threadId: input.threadId,
      messageId: input.messageId,
      resolvedByMessageId: input.resolvedByMessageId,
      ...(input.chosenOption !== undefined ? { chosenOption: input.chosenOption } : {}),
    });
    afterWrite(place.workspaceId, target, false);
    return decision;
  }

  return { createFileThread, sendMessage, startThread, setReaction, resolveDecision };
}

export type ChatWrites = ReturnType<typeof createChatWrites>;
