import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { ChatThreadLane, LinkedChatStore } from "@dohc/workspace-contracts/engine";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { RegistryEntry } from "./registryStore";
import { assertSharedChannelWritable } from "./sharedChannels";
import { shareViewIsPresent } from "./shareViewMarker";
import {
  assertSharedChannelMessageIdentity,
  type ChatRelayIdentityStore,
  type ChatRelayIdentityTarget,
  type ResolvedChatRelayIdentity,
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

type ChatAttachments = NonNullable<Parameters<LinkedChatStore["sendMessage"]>[0]["attachments"]>;

interface ChatMessageInput {
  writer: ChatWriter;
  body: string;
  needsDecision?: boolean;
  options?: string[];
  // Runs after identity resolves and before the final check, so a slow file
  // lookup cannot carry a stale grant or session into the write.
  resolveAttachments(): Promise<ChatAttachments>;
}

export function createChatWrites(dependencies: {
  findWorkspace(workspaceId: string): Pick<RegistryEntry, "shareView" | "sharedChannels"> | null;
  // Warms the credential cache and refuses an identity resolved across a
  // session change.
  chatRelayIdentityFor(
    workspaceId: string, target: ChatRelayIdentityTarget, store: ChatRelayIdentityStore,
  ): Promise<ResolvedChatRelayIdentity>;
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
    findWorkspace, chatRelayIdentityFor, currentCredentials, localUserDisplayName,
    agentDisplayName, localReactorFallbackId, projectChatBookmarks, queueCloudSync,
    syncSharedChannelsForChatTarget, scanChatDispatch,
  } = dependencies;

  // Every received file share is read-only for chat, whatever its cached relay
  // capability: there is no durable per-row relay receipt yet.
  function assertOwnedWorkspace(workspaceId: string) {
    const workspace = findWorkspace(workspaceId);
    if (shareViewIsPresent(workspace?.shareView)) {
      throw new SharedFileReadOnlyError("Chats are read-only in this shared view.");
    }
    return workspace;
  }

  // Runs before identity, attachments, or any durable row. The renderer
  // disabling its composer is honesty, not authorization.
  async function assertWritable(place: ChatWritePlace, target: ChatRelayIdentityTarget) {
    const workspace = assertOwnedWorkspace(place.workspaceId);
    await assertSharedChannelWritable({
      workspaceId: place.workspaceId,
      sharedChannels: workspace?.sharedChannels,
      store: place.store,
      target,
    });
  }

  // A joined shared channel requires the account that joined it. Elsewhere a
  // signed-out write stays local and omits the relay author.
  async function verifiedAuthorUserId(place: ChatWritePlace, target: ChatRelayIdentityTarget) {
    const identity = await chatRelayIdentityFor(place.workspaceId, target, place.store);
    assertSharedChannelMessageIdentity({
      joinedChannel: identity.joinedChannel,
      credentials: currentCredentials(),
      authorUserId: identity.authorUserId,
      resolvedAuthorUserId: identity.authorUserId,
    });
    return identity.authorUserId;
  }

  async function revalidate(
    place: ChatWritePlace, target: ChatRelayIdentityTarget, authorUserId: string | undefined,
  ) {
    await assertWritable(place, target);
    if ((await verifiedAuthorUserId(place, target)) !== authorUserId) {
      throw new Error("Your server session changed. Try again.");
    }
  }

  // Check access, then resolve one identity. A write that awaits more work
  // after that checks both again, so its row lands under the grant and session
  // it started with.
  async function admit<Prepared>(
    place: ChatWritePlace,
    target: ChatRelayIdentityTarget,
    prepare: (authorUserId: string | undefined) => Promise<Prepared>,
  ) {
    await assertWritable(place, target);
    const authorUserId = await verifiedAuthorUserId(place, target);
    const prepared = await prepare(authorUserId);
    await revalidate(place, target, authorUserId);
    return { authorUserId, prepared };
  }

  async function actorFor(writer: ChatWriter) {
    return writer.via === "cli" && writer.actor === "agent"
      ? {
          author: { kind: "agent" as const, displayName: await agentDisplayName() },
          authorOwnerDisplayName: localUserDisplayName(),
        }
      : { author: { kind: "human" as const, displayName: localUserDisplayName() } };
  }

  async function prepareMessage(input: ChatMessageInput) {
    return { actor: await actorFor(input.writer), attachments: await input.resolveAttachments() };
  }

  function messageFields(
    input: ChatMessageInput,
    authorUserId: string | undefined,
    { actor, attachments }: Awaited<ReturnType<typeof prepareMessage>>,
  ) {
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
    assertOwnedWorkspace(place.workspaceId);
    const thread = await place.store.createThread({
      workspaceId: place.workspaceId,
      title: input.title,
      linkedFile: await input.linkedFile(),
    });
    afterWrite(place.workspaceId, { threadId: thread.id }, false);
    return thread;
  }

  async function sendMessage(place: ChatWritePlace, input: ChatMessageInput & {
    threadId: string;
    parentMessageId?: string;
  }) {
    const target = { threadId: input.threadId };
    const { authorUserId, prepared } = await admit(place, target, () => prepareMessage(input));
    const message = await place.store.sendMessage({
      workspaceId: place.workspaceId,
      threadId: input.threadId,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      ...messageFields(input, authorUserId, prepared),
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
    const { authorUserId, prepared } = await admit(place, target, () => prepareMessage(input));
    const started = await place.store.startChannelThread({
      workspaceId: place.workspaceId,
      channelId: input.channelId,
      ...(input.lane ? { lane: input.lane } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...messageFields(input, authorUserId, prepared),
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
    const { authorUserId, prepared } = await admit(place, target, async (authorUserId) => ({
      author: (await actorFor(input.writer)).author,
      existing: input.state === "toggle" || (input.state === "removed" && aliased(authorUserId))
        ? await store.listReactions({ workspaceId, threadId: input.threadId })
        : [],
    }));
    const reacted = (authorId: string | undefined) => prepared.existing.some((reaction) =>
      reaction.messageId === input.messageId && reaction.emoji === input.emoji &&
      reaction.author.authorId === authorId);
    const hasLocalAlias = reacted(localAuthorId);
    const hasCurrent = authorUserId !== undefined && reacted(authorUserId);
    const state = input.state !== "toggle"
      ? input.state
      : hasLocalAlias || hasCurrent ? "removed" : "added";
    const write = (authorId: string, replicationAuthorId?: string) => store.setReaction({
      workspaceId,
      threadId: input.threadId,
      messageId: input.messageId,
      emoji: input.emoji,
      author: { authorId, ...prepared.author },
      ...(replicationAuthorId ? { replicationAuthorId } : {}),
      state,
    });
    let reaction: Awaited<ReturnType<typeof write>>;
    if (state === "removed" && aliased(authorUserId) && hasLocalAlias) {
      reaction = await write(localAuthorId);
      if (hasCurrent) {
        await revalidate(place, target, authorUserId);
        reaction = await write(authorUserId, authorUserId);
      }
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
    if (input.reply) {
      await revalidate(place, target, input.reply.authorUserId);
    } else {
      await assertWritable(place, target);
      await verifiedAuthorUserId(place, target);
    }
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
