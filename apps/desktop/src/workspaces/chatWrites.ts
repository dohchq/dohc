import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { ChatThreadLane, LinkedChatStore } from "@dohc/workspace-contracts/engine";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { RegistryEntry } from "./registryStore";
import { assertJoinedChannelWritable, joinedSharedChannelForWireId } from "./sharedChannels";
import { shareViewIsPresent } from "./shareViewMarker";
import { AutomationChatSessionWait } from "../automations/automationChat";
import {
  assertSharedChannelMessageIdentity,
  chatRelayAuthorId,
  type ChatRelayIdentityStore,
  type ChatRelayIdentityTarget,
} from "./chatRelayIdentity";

// The one main-process path for chat writes, whoever makes them. The renderer
// always writes as the local person. The CLI, and MCP through it, names its
// actor, and its messages carry origin "cli" so no device dispatches an agent
// on them. The automation executor writes as an automation that ran for the
// local person, naming the automation and its chain depth. Identity is never
// the caller's: it comes from the registry and the signed-in session.
// `agentName` is the name an agent gave for itself, such as an MCP client's
// handshake name. It is provenance, like a document edit's author; without
// it the message carries the agent name from the person's settings.
export type ChatWriter =
  | { via: "renderer" }
  | { via: "cli"; actor: "human" | "agent"; agentName?: string }
  // `local` marks a message that stays on this computer, such as a wake in
  // "My agent", so it never waits for a session.
  | { via: "automation"; automationId: string; name: string; depth: number; local?: true };
// A person or their agent: only they react.
export type PersonWriter = Exclude<ChatWriter, { via: "automation" }>;

export type ChatWriteStore = ChatRelayIdentityStore & Pick<LinkedChatStore,
  "createThread" | "sendMessage" | "startChannelThread" | "resolveChatDecision" |
  "listReactions" | "setReaction">;

export interface ChatWritePlace {
  workspaceId: string;
  store: ChatWriteStore;
}

type ChatWorkspace = Pick<RegistryEntry, "remote" | "shareView" | "sharedChannels">;

// The target and session a write was admitted under. channelWireId is
// undefined until a joined channel makes the lookup necessary.
interface Admission {
  target: ChatRelayIdentityTarget;
  channelWireId: string | null | undefined;
  generation: number;
  authorUserId: string | undefined;
}

const SESSION_CHANGED = "Your server session changed. Try again.";

type ChatAttachments = NonNullable<Parameters<LinkedChatStore["sendMessage"]>[0]["attachments"]>;

interface ChatMessageInput {
  writer: ChatWriter;
  body: string;
  needsDecision?: boolean;
  options?: string[];
  // Runs between admission and the final check, so a slow file lookup cannot
  // carry a stale grant or session into the write.
  resolveAttachments(): Promise<ChatAttachments>;
  // The automation executor names its message and the key a retry replays.
  messageId?: string;
  idempotencyKey?: string;
  // Ends the write before its row when a run stops, pauses, or times out.
  signal?: AbortSignal;
}

export function createChatWrites(dependencies: {
  findWorkspace(workspaceId: string): ChatWorkspace | null;
  warmCredentials(): Promise<unknown>;
  currentCredentials(): CloudCredentials | null;
  // Changes whenever the credential cache sets, clears, or reloads a session.
  currentCredentialGeneration(): number;
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
  // Tells open windows the workspace's chats changed, for writes they did not make.
  notifyRenderer(workspaceId: string): void;
}) {
  const {
    findWorkspace, warmCredentials, currentCredentials, currentCredentialGeneration,
    localUserDisplayName, agentDisplayName, localReactorFallbackId, projectChatBookmarks,
    queueCloudSync, syncSharedChannelsForChatTarget, scanChatDispatch, notifyRenderer,
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

  function hasJoinedChannels(workspaceId: string): boolean {
    return (findWorkspace(workspaceId)?.sharedChannels?.length ?? 0) > 0;
  }

  // The target's channel wire id. It never changes for a thread or channel,
  // so one lookup serves every check of a write.
  async function lookUpWireId(place: ChatWritePlace, target: ChatRelayIdentityTarget) {
    const channelId = "channelId" in target
      ? target.channelId
      : await place.store.findThreadChannelId({ workspaceId: place.workspaceId, threadId: target.threadId });
    return channelId
      ? await place.store.getChannelWireId({ workspaceId: place.workspaceId, channelId })
      : null;
  }

  // Synchronous: it reads the registry and the session as they are now, and
  // returns the author the session resolves to. channelWireId undefined means
  // the workspace has no joined channels, which the caller decided in this
  // same synchronous block. The renderer disabling its composer is honesty,
  // not authorization.
  function check(
    place: ChatWritePlace,
    channelWireId: string | null | undefined,
    generation: number,
  ): string | undefined {
    const workspace = ownedWorkspace(place.workspaceId);
    const joinedChannel = channelWireId === undefined
      ? null
      : joinedSharedChannelForWireId(workspace.sharedChannels, channelWireId);
    assertJoinedChannelWritable(joinedChannel);
    const credentials = currentCredentials();
    const authorUserId = chatRelayAuthorId(workspace, joinedChannel, credentials);
    // A joined shared channel requires the account that joined it. Elsewhere
    // a signed-out write stays local and omits the relay author.
    assertSharedChannelMessageIdentity({
      joinedChannel, credentials, authorUserId, resolvedAuthorUserId: authorUserId,
    });
    if (currentCredentialGeneration() !== generation) throw new Error(SESSION_CHANGED);
    return authorUserId;
  }

  // Refuses a received share before any await, then fixes the session the
  // write runs under. A session replaced while the target resolves refuses.
  async function admit(place: ChatWritePlace, target: ChatRelayIdentityTarget): Promise<Admission> {
    ownedWorkspace(place.workspaceId);
    await warmCredentials();
    const generation = currentCredentialGeneration();
    const channelWireId = hasJoinedChannels(place.workspaceId)
      ? await lookUpWireId(place, target)
      : undefined;
    return { target, channelWireId, generation, authorUserId: check(place, channelWireId, generation) };
  }

  // The final check and the store call run in one synchronous block, so no
  // other continuation can change the grant or the session between them.
  // `write` must call the store before it awaits anything. A channel joined
  // since admission needs the lookup admission skipped, so that runs first.
  // `expected` holds the author the session must still resolve to: the
  // admitted one unless the caller names another.
  async function commit<Result>(
    place: ChatWritePlace,
    admission: Admission,
    write: () => Promise<Result>,
    expected: { authorUserId?: string } = admission,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (admission.channelWireId === undefined && hasJoinedChannels(place.workspaceId)) {
      admission.channelWireId = await lookUpWireId(place, admission.target);
    }
    if (check(place, admission.channelWireId, admission.generation) !== expected.authorUserId) {
      throw new Error(SESSION_CHANGED);
    }
    signal?.throwIfAborted();
    return write();
  }

  async function actorFor(writer: ChatWriter) {
    if (writer.via === "automation") {
      return {
        author: { kind: "automation" as const, displayName: writer.name },
        authorOwnerDisplayName: localUserDisplayName(),
        automation: { automationId: writer.automationId, chainDepth: writer.depth },
      };
    }
    return await personActorFor(writer);
  }

  // People and agents; only they react.
  async function personActorFor(writer: PersonWriter) {
    return writer.via === "cli" && writer.actor === "agent"
      ? {
          author: { kind: "agent" as const, displayName: writer.agentName ?? await agentDisplayName() },
          authorOwnerDisplayName: localUserDisplayName(),
        }
      : { author: { kind: "human" as const, displayName: localUserDisplayName() } };
  }

  // Admits the message and does its async work. The caller commits the row.
  async function prepareMessage(place: ChatWritePlace, target: ChatRelayIdentityTarget, input: ChatMessageInput) {
    // Before admission, whose identity checks refuse a signed-out write to
    // a joined Group: an automation waits for a session there instead.
    if (input.writer.via === "automation" && !input.writer.local) {
      await warmCredentials();
      const workspace = findWorkspace(place.workspaceId);
      const synced = workspace?.remote !== undefined || (workspace?.sharedChannels?.length ?? 0) > 0;
      if (synced && currentCredentials() === null) throw new AutomationChatSessionWait();
    }
    const admission = await admit(place, target);
    const { authorUserId } = admission;
    // A synced workspace's automation waits for a session: without one its
    // message would stay on this computer and reach nobody.
    if (input.writer.via === "automation" && !input.writer.local && authorUserId === undefined &&
      findWorkspace(place.workspaceId)?.remote !== undefined) {
      throw new AutomationChatSessionWait();
    }
    const actor = await actorFor(input.writer);
    const attachments = await input.resolveAttachments();
    return { admission, fields: {
      ...actor,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(authorUserId ? { authorUserId } : {}),
      ...(input.writer.via === "cli" ? { origin: "cli" as const } : {}),
      body: input.body,
      ...(input.needsDecision ? { needsDecision: true } : {}),
      ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    } };
  }

  function afterWrite(workspaceId: string, target: ChatRelayIdentityTarget, message: boolean, writer?: ChatWriter) {
    // Nothing on screen asked for an automation's message, so the windows hear of it.
    if (writer?.via === "automation") notifyRenderer(workspaceId);
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
    // The recheck and the store call share one synchronous block.
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
    const { admission, fields } = await prepareMessage(place, target, input);
    const message = await commit(place, admission, () => place.store.sendMessage({
      workspaceId: place.workspaceId,
      threadId: input.threadId,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      ...fields,
    }), admission, input.signal);
    afterWrite(place.workspaceId, target, true, input.writer);
    return message;
  }

  async function startThread(place: ChatWritePlace, input: ChatMessageInput & {
    channelId: string;
    lane?: ChatThreadLane;
    title?: string;
    // The thread a new post starts; a Group's chat lane keeps its running one.
    threadId?: string;
  }) {
    const target = { channelId: input.channelId };
    const { admission, fields } = await prepareMessage(place, target, input);
    const started = await commit(place, admission, () => place.store.startChannelThread({
      workspaceId: place.workspaceId,
      channelId: input.channelId,
      ...(input.lane ? { lane: input.lane } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...fields,
    }), admission, input.signal);
    afterWrite(place.workspaceId, target, true, input.writer);
    return started;
  }

  // "toggle" removes the writer's reaction when one exists and adds it
  // otherwise. A reaction made signed out lives under the local id; once
  // signed in, removing it removes that alias too.
  async function setReaction(place: ChatWritePlace, input: {
    writer: PersonWriter;
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
    const admission = await admit(place, target);
    const { authorUserId } = admission;
    const { author } = await personActorFor(input.writer);
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
    // Each row commits on its own, including the second row of an alias
    // removal.
    const write = (authorId: string, replicationAuthorId?: string) =>
      commit(place, admission, () => store.setReaction({
        workspaceId,
        threadId: input.threadId,
        messageId: input.messageId,
        emoji: input.emoji,
        author: { authorId, ...author },
        ...(replicationAuthorId ? { replicationAuthorId } : {}),
        state,
      }));
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
    const admission = await admit(place, target);
    const decision = await commit(place, admission, () => place.store.resolveChatDecision({
      workspaceId: place.workspaceId,
      threadId: input.threadId,
      messageId: input.messageId,
      resolvedByMessageId: input.resolvedByMessageId,
      ...(input.chosenOption !== undefined ? { chosenOption: input.chosenOption } : {}),
    }), input.reply ?? admission);
    afterWrite(place.workspaceId, target, false);
    return decision;
  }

  return { createFileThread, sendMessage, startThread, setReaction, resolveDecision };
}

export type ChatWrites = ReturnType<typeof createChatWrites>;
