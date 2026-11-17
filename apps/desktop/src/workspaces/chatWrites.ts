import { signalChatWrite } from "./chatWriteSignals";
import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type {
  ChatMessage,
  ChatReportedAgent,
  ChatThreadLane,
  LinkedChatStore,
} from "@dohc/workspace-contracts/engine";
import type { ChatWorkReport } from "@dohc/workspace-contracts/chat-work";
import {
  createActorIssuer,
  deriveLocalActor,
  serializeActorKey,
} from "@dohc/workspace-contracts/actor-identity";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { RegistryEntry } from "./registryStore";
import { normalizeChatMessageBody } from "@dohc/workspace-contracts/chat-message-body";
import {
  agentIdForChannelWireId,
  GENERAL_CHANNEL_WIRE_ID,
} from "@dohc/security-contract/chat-wire-ids";
import { assertJoinedChannelWritable, joinedSharedChannelForWireId } from "./sharedChannels";
import { shareViewIsPresent } from "./shareViewMarker";
import { logUnlessClosedCopy } from "./shareViewRebuild";
import { recordedShareSelector } from "./shareViewRecords";
import {
  joinedByAccount,
  shareViewTakesPosts,
  shareViewWriteLevel,
  shareViewWriteScopeOf,
  type ShareViewWritePlace,
} from "./shareWriteGate";
import { JOINED_BY_ANOTHER_ACCOUNT } from "../ipc/joinedAccountWords";
import { AutomationChatSessionWait } from "@dohc/automation-executor/automation-chat";
import { chatFileLinkScope, hasChatFileLink, refuseChatFileLinks } from "./chatFileLinkScope";
import type {
  AnswerOutcome,
  AnswerStages,
  Answered,
  AnswerWithStages,
  ChatMessageContent,
  ChatMessageIds,
  ChatWriteHost,
  TargetCheck,
} from "@dohc/workspace-operations/chat-writes";
import {
  assertSharedChannelMessageIdentity,
  chatRelayAuthorId,
  type ChatRelayIdentityStore,
  type ChatRelayIdentityTarget,
} from "./chatRelayIdentity";

// Admits renderer, CLI, and automation chat writes; DM setup derives its key
// the same way, from its captured session. The renderer always writes as the
// local person. The CLI, and MCP through it, names its
// actor, and its messages carry origin "cli" so no device dispatches an agent
// on them. The automation executor writes as an automation that ran for the
// local person, naming the automation and its chain depth. Identity is never
// the caller's: it comes from the registry and the signed-in session.
// `agentName` is the name an agent gave for itself, such as an MCP client's
// handshake name. The message shows it; without it the message is from
// "Agent". It is only a claim, so the message's key is the unnamed agent's.
// `agentId` names an agent you run, or the agent of a run dohc dispatched.
// Main knows both; the message carries that agent's id and settings name.
// `reported` is what the agent said about itself: its MCP client's product
// and version, and the model it stated. It sits beside the author's name and
// never replaces it.
// A person's own message in the app wakes its DM's agent, each of their
// agents it names, except the agents they run, and the agent dohc starts that
// it answers.
export type ChatWriter =
  | { via: "renderer" }
  | {
      via: "cli";
      actor: "human" | "agent";
      agentName?: string;
      agentId?: string;
      reported?: ChatReportedAgent;
    }
  // `local` marks a message that stays on this computer, such as a wake in
  // an agent's chat, so it never waits for a session.
  | { via: "automation"; automationId: string; name: string; depth: number; local?: true };
// A person or their agent: only they react.
export type PersonWriter = Exclude<ChatWriter, { via: "automation" }>;

export type ChatWriteStore = ChatRelayIdentityStore &
  Pick<
    LinkedChatStore,
    | "createThread"
    | "sendMessage"
    | "startChannelThread"
    | "resolveChatDecision"
    | "listReactions"
    | "setReaction"
    | "getMessage"
    | "listChannelThreads"
    | "getThread"
    | "listMessagesPage"
    | "listThreadDecisions"
    | "listChannels"
  >;

export interface ChatWritePlace {
  workspaceId: string;
  store: ChatWriteStore;
}

type ChatWorkspace = Pick<
  RegistryEntry,
  "remote" | "pausedRemote" | "shareView" | "sharedChannels" | "shareRoster"
>;

// The target and session a write was admitted under. channelWireId is
// undefined until a joined channel makes the lookup necessary.
interface Admission {
  target: ChatRelayIdentityTarget;
  channelWireId: string | null | undefined;
  // In a joined workspace, whether the target is in a Group or on a file. A
  // thread's place, a channel's kind and its wire id never change, so
  // admission decides it once. Its level can change, so commit reads it again.
  inReach: boolean;
  place: TargetPlace;
  generation: number;
  authorUserId: string | undefined;
  actorCredentials: Pick<CloudCredentials, "serverUrl" | "userId"> | null;
  installationId: string;
}

const SESSION_CHANGED = "Your server session changed. Try again.";

// Where a member writes in a joined workspace: a Group, or a file's thread,
// which takes the level at the path the file sits at when it is written.
type TargetPlace = "group" | { objectId: string } | null;

type ChatAttachments = NonNullable<Parameters<LinkedChatStore["sendMessage"]>[0]["attachments"]>;

interface ChatMessageInput {
  writer: ChatWriter;
  body: string;
  needsDecision?: boolean;
  options?: string[];
  // What an agent reports about its work. The engine refuses one from a person.
  work?: ChatWorkReport;
  // Runs between admission and the final check, so a slow file lookup cannot
  // carry a stale grant or session into the write.
  resolveAttachments(): Promise<ChatAttachments>;
  // The automation executor names its message and the key a retry replays.
  messageId?: string;
  idempotencyKey?: string;
  // Ends the write before its row when a run stops, pauses, or times out.
  signal?: AbortSignal;
  // Hears of the message once the store holds it, before the work that
  // follows the write, so a caller whose later step fails knows it saved.
  // An answer's `failure` says why its question stays open.
  onSaved?(saved: { message: ChatMessage; failure?: unknown }): void;
  // An answer's read of its question, run once the write is admitted.
  checkTargets?: TargetCheck;
}

// What a person's write through the shared commands is bound to. The
// commands name none of it.
export interface ChatHostBinding {
  writer: PersonWriter;
  work?: ChatWorkReport;
  resolveAttachments?(): Promise<ChatAttachments>;
  onSaved?(saved: { message: ChatMessage; failure?: unknown }): void;
}

export function createChatWrites(dependencies: {
  findWorkspace(workspaceId: string): ChatWorkspace | null;
  warmCredentials(): Promise<unknown>;
  currentCredentials(): CloudCredentials | null;
  // Changes whenever the credential cache sets, clears, or reloads a session.
  currentCredentialGeneration(): number;
  localUserDisplayName(): string;
  agentDisplayName(agentId: string): Promise<string>;
  // The agents a person's message wakes, from its body, its DM's agent and
  // the agent it answers.
  agentIdsToWake(
    body: string,
    dmAgentId: string | null,
    answeredAgentId: string | null,
  ): Promise<string[]>;
  // The stable per-install id a signed-out reaction is authored under.
  localInstallationId(): string;
  projectChatBookmarks(workspaceId: string): void;
  queueCloudSync(workspaceId: string): void;
  syncSharedChannelsForChatTarget(
    workspaceId: string,
    target: ChatRelayIdentityTarget,
  ): Promise<unknown>;
  // Sends a joined workspace's own Group posts to the owner.
  pushShareViewChat(workspaceId: string): Promise<unknown>;
  scanChatDispatch(workspaceId: string): Promise<unknown>;
  // Runs a write of several rows where no dispatch scan of the workspace
  // reads it half done.
  betweenDispatchScans<Result>(workspaceId: string, write: () => Promise<Result>): Promise<Result>;
  // Tells open windows the workspace's chats changed, for writes they did not make.
  notifyRenderer(workspaceId: string): void;
  // Where a file sits now in a joined workspace's store, or null when it
  // sits nowhere. A file's thread takes the level at that path.
  currentPathOf(workspaceId: string, objectId: string): Promise<string | null>;
}) {
  const {
    findWorkspace,
    warmCredentials,
    currentCredentials,
    currentCredentialGeneration,
    localUserDisplayName,
    agentDisplayName,
    agentIdsToWake,
    localInstallationId,
    projectChatBookmarks,
    queueCloudSync,
    syncSharedChannelsForChatTarget,
    pushShareViewChat,
    scanChatDispatch,
    betweenDispatchScans,
    notifyRenderer,
    currentPathOf,
  } = dependencies;

  // A joined workspace at Comment or Edit in its Groups or on some file posts
  // in its Groups and comments on its files, which the relay's append lane
  // admits. Each target
  // then needs its own level (`takesPostsAt`). Every other received share is read-only for
  // chat, whatever its cached relay capability: there is no durable per-row
  // relay receipt yet.
  function joinedWorkspacePosts(workspace: ChatWorkspace): boolean {
    const view = workspace.shareView;
    const pin = recordedShareSelector(view?.grantedSelector);
    // The levels alone: `check` refuses another account in its own words.
    const scope = shareViewWriteScopeOf(view, null);
    return !!view && pin?.wholeWorkspace === true && scope !== null && shareViewTakesPosts(scope);
  }

  function chatWorkspace(workspaceId: string): ChatWorkspace {
    const workspace = findWorkspace(workspaceId);
    if (!workspace) throw new Error("This workspace is not open. Open it again.");
    if (shareViewIsPresent(workspace.shareView) && !joinedWorkspacePosts(workspace)) {
      const pin = recordedShareSelector(workspace.shareView?.grantedSelector);
      throw new SharedFileReadOnlyError(
        pin?.wholeWorkspace !== true
          ? "Chats are read-only in this shared view."
          : workspace.shareView?.ended
            ? "Your membership ended."
            : "Only people who can comment post here.",
      );
    }
    return workspace;
  }

  // The admitted workspace for one write. In a joined workspace only a Group
  // or a file's thread takes it.
  function writableWorkspace(workspaceId: string, inReach: boolean): ChatWorkspace {
    const workspace = chatWorkspace(workspaceId);
    if (shareViewIsPresent(workspace.shareView) && !inReach) {
      throw new SharedFileReadOnlyError(
        "In a joined workspace you can post in Groups and comment on files only.",
      );
    }
    return workspace;
  }

  // The place a target in a joined workspace is, if a member writes there: a
  // Group, which is an ordinary channel and never General, a direct message
  // or an agent's chat; or a file's thread.
  async function targetPlaceOf(
    place: ChatWritePlace,
    target: ChatRelayIdentityTarget,
    wire: string | null,
  ): Promise<TargetPlace> {
    if (wire === null) {
      if ("channelId" in target) return null;
      const { thread } = await place.store.getThread({
        workspaceId: place.workspaceId,
        threadId: target.threadId,
      });
      if (thread.linkedFile === undefined || thread.channelId !== undefined) return null;
      return { objectId: thread.linkedFile.objectId };
    }
    if (wire === GENERAL_CHANNEL_WIRE_ID || agentIdForChannelWireId(wire) !== null) return null;
    const channelId =
      "channelId" in target
        ? target.channelId
        : await place.store.findThreadChannelId({
            workspaceId: place.workspaceId,
            threadId: target.threadId,
          });
    if (!channelId) return null;
    const channels = await place.store.listChannels({ workspaceId: place.workspaceId });
    return channels.some((channel) => channel.id === channelId && channel.kind === "channel")
      ? "group"
      : null;
  }

  // Where a place's level is read: the Group, or the path its file sits at now.
  async function levelPlaceOf(
    workspaceId: string,
    target: TargetPlace,
  ): Promise<ShareViewWritePlace | null> {
    if (target === null || target === "group") return target;
    const path = await currentPathOf(workspaceId, target.objectId);
    return path === null ? null : { path };
  }

  // The level decides. A Group takes the member level until Group rules
  // exist. A file's thread takes the level at the file's current path, by
  // the rule every gate asks (`shareViewWriteLevel`). Synchronous, so a
  // caller reads it in the same block as its write.
  const takesPostsAt = (workspaceId: string, at: ShareViewWritePlace | null) =>
    at !== null && takesPosts(levelOf(workspaceId, at));

  const takesPosts = (level: string | null) => level === "comment" || level === "edit";
  const levelOf = (workspaceId: string, place: ShareViewWritePlace) => {
    const scope = shareViewWriteScopeOf(findWorkspace(workspaceId)?.shareView, null);
    return scope === null ? null : shareViewWriteLevel(scope, place);
  };

  function hasJoinedChannels(workspaceId: string): boolean {
    return (findWorkspace(workspaceId)?.sharedChannels?.length ?? 0) > 0;
  }

  // The target's channel wire id. It never changes for a thread or channel,
  // so one lookup serves every check of a write.
  async function lookUpWireId(place: ChatWritePlace, target: ChatRelayIdentityTarget) {
    const channelId =
      "channelId" in target
        ? target.channelId
        : await place.store.findThreadChannelId({
            workspaceId: place.workspaceId,
            threadId: target.threadId,
          });
    return channelId
      ? await place.store.getChannelWireId({ workspaceId: place.workspaceId, channelId })
      : null;
  }

  // The agent whose DM the target is in, or null. The write keeps the wire
  // id, so its final check needs no second lookup.
  async function dmAgentIdOf(place: ChatWritePlace, admission: Admission): Promise<string | null> {
    if (admission.channelWireId === undefined) {
      admission.channelWireId = await lookUpWireId(place, admission.target);
    }
    return admission.channelWireId === null
      ? null
      : agentIdForChannelWireId(admission.channelWireId);
  }

  // Refuses a file link the place's readers may not open. Only a write that
  // holds a link reads the channel.
  async function checkFileLinks(
    place: ChatWritePlace,
    admission: Admission,
    texts: readonly string[],
  ): Promise<void> {
    if (!hasChatFileLink(texts)) return;
    const { workspaceId, store } = place;
    const { target } = admission;
    const channelId =
      "channelId" in target
        ? target.channelId
        : await store.findThreadChannelId({ workspaceId, threadId: target.threadId });
    const channel = channelId
      ? ((await store.listChannels({ workspaceId })).find((entry) => entry.id === channelId) ??
        null)
      : null;
    const wireId =
      admission.channelWireId !== undefined
        ? admission.channelWireId
        : channel
          ? await store.getChannelWireId({ workspaceId, channelId: channel.id })
          : null;
    refuseChatFileLinks(chatFileLinkScope(chatWorkspace(workspaceId), channel, wireId), texts);
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
    inReach: boolean,
  ): string | undefined {
    const workspace = writableWorkspace(place.workspaceId, inReach);
    const joinedChannel =
      channelWireId === undefined
        ? null
        : joinedSharedChannelForWireId(workspace.sharedChannels, channelWireId);
    assertJoinedChannelWritable(joinedChannel);
    const credentials = currentCredentials();
    const authorUserId = chatRelayAuthorId(workspace, joinedChannel, credentials);
    // A joined shared channel requires the account that joined it. Elsewhere
    // a signed-out write stays local and omits the relay author.
    assertSharedChannelMessageIdentity({
      joinedChannel,
      credentials,
      authorUserId,
      resolvedAuthorUserId: authorUserId,
    });
    // A joined workspace's post reaches the owner only as the account that
    // joined. Without it the post would look sent and never leave.
    if (workspace.shareView && !joinedByAccount(workspace.shareView, credentials)) {
      throw new Error(JOINED_BY_ANOTHER_ACCOUNT);
    }
    if (currentCredentialGeneration() !== generation) throw new Error(SESSION_CHANGED);
    return authorUserId;
  }

  // Refuses a received share before any await, then fixes the session the
  // write runs under. A session replaced while the target resolves refuses.
  async function admit(place: ChatWritePlace, target: ChatRelayIdentityTarget): Promise<Admission> {
    const joinedWorkspace = shareViewIsPresent(chatWorkspace(place.workspaceId).shareView);
    await warmCredentials();
    const generation = currentCredentialGeneration();
    const channelWireId =
      joinedWorkspace || hasJoinedChannels(place.workspaceId)
        ? await lookUpWireId(place, target)
        : undefined;
    const targetPlace = joinedWorkspace
      ? await targetPlaceOf(place, target, channelWireId ?? null)
      : null;
    const at = await levelPlaceOf(place.workspaceId, targetPlace);
    const inReach = joinedWorkspace && takesPostsAt(place.workspaceId, at);
    const authorUserId = check(place, channelWireId, generation, inReach);
    const credentials = currentCredentials();
    const actorCredentials =
      credentials === null
        ? null
        : {
            serverUrl: credentials.serverUrl,
            userId: credentials.userId,
          };
    return {
      target,
      channelWireId,
      inReach,
      place: targetPlace,
      generation,
      authorUserId,
      actorCredentials,
      installationId: localInstallationId(),
    };
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
    // Where the file sits now. Its level is read below, with the check.
    const at = admission.inReach ? await levelPlaceOf(place.workspaceId, admission.place) : null;
    const inReach = admission.inReach && takesPostsAt(place.workspaceId, at);
    if (
      check(place, admission.channelWireId, admission.generation, inReach) !== expected.authorUserId
    ) {
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
          author: {
            kind: "agent" as const,
            displayName:
              writer.agentName ??
              (writer.agentId ? await agentDisplayName(writer.agentId) : "Agent"),
          },
          authorOwnerDisplayName: localUserDisplayName(),
          ...(writer.agentId ? { authorAgentId: writer.agentId } : {}),
          ...(writer.reported ? { authorReported: writer.reported } : {}),
        }
      : { author: { kind: "human" as const, displayName: localUserDisplayName() } };
  }

  // The agent a reply answers: the author of the message it replies under,
  // or the agent that started the post or file chat it is in. A Group's
  // running conversation has no starter, so there only a reply under an
  // agent's message answers one. An agent id is a settings id, so only a
  // message this device wrote, which alone keeps its actor key, names one of
  // this person's agents; another person's agent may share the id.
  async function answeredAgentIdOf(
    place: ChatWritePlace,
    threadId: string,
    parentMessageId: string | undefined,
  ): Promise<string | null> {
    const { workspaceId, store } = place;
    // A thread or parent this cannot read is the write's own refusal to make,
    // and a reply it cannot place wakes no one rather than the wrong agent.
    try {
      if (parentMessageId) {
        const parent = await store.getMessage({ workspaceId, messageId: parentMessageId });
        if (parent?.authorAgentId && parent.authorActorKey !== undefined)
          return parent.authorAgentId;
      }
      const { thread } = await store.getThread({ workspaceId, threadId });
      if (thread.lane === "chat") return null;
      const [opening] = (await store.listMessagesPage({ workspaceId, threadId, limit: 1 }))
        .messages;
      return opening?.authorAgentId && opening.authorActorKey !== undefined
        ? opening.authorAgentId
        : null;
    } catch {
      return null;
    }
  }

  // Admits the message and does its async work. The caller commits the row.
  async function prepareMessage(
    place: ChatWritePlace,
    target: ChatRelayIdentityTarget,
    input: ChatMessageInput & { parentMessageId?: string; title?: string },
  ) {
    const body = normalizeChatMessageBody(input.body);
    // Before admission, whose identity checks refuse a signed-out write to
    // a joined Group: an automation waits for a session there instead.
    if (input.writer.via === "automation" && !input.writer.local) {
      await warmCredentials();
      const workspace = findWorkspace(place.workspaceId);
      const synced =
        (workspace?.remote ?? workspace?.pausedRemote) !== undefined ||
        (workspace?.sharedChannels?.length ?? 0) > 0;
      if (synced && currentCredentials() === null) throw new AutomationChatSessionWait();
    }
    const admission = await admit(place, target);
    const { authorUserId } = admission;
    // A synced workspace's automation waits for a session: without one its
    // message would stay on this computer and reach nobody.
    if (
      input.writer.via === "automation" &&
      !input.writer.local &&
      authorUserId === undefined &&
      (findWorkspace(place.workspaceId)?.remote ??
        findWorkspace(place.workspaceId)?.pausedRemote) !== undefined
    ) {
      throw new AutomationChatSessionWait();
    }
    await checkFileLinks(place, admission, [
      body,
      ...(input.options ?? []),
      ...(input.title ? [input.title] : []),
    ]);
    await input.checkTargets?.();
    const actor = await actorFor(input.writer);
    const wakeAgentIds =
      input.writer.via === "renderer"
        ? await agentIdsToWake(
            body,
            await dmAgentIdOf(place, admission),
            "threadId" in target
              ? await answeredAgentIdOf(place, target.threadId, input.parentMessageId)
              : null,
          )
        : [];
    const attachments = await input.resolveAttachments();
    const authorActorKey = deriveChatActorKey({
      credentials: admission.actorCredentials,
      installationId: admission.installationId,
      workspaceId: place.workspaceId,
      writer: input.writer,
      displayName: actor.author.displayName,
    });
    return {
      admission,
      fields: {
        authorActorKey,
        ...actor,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(authorUserId ? { authorUserId } : {}),
        ...(input.writer.via === "cli" ? { origin: "cli" as const } : {}),
        ...(wakeAgentIds.length > 0 ? { wakeAgentIds } : {}),
        body,
        ...(input.needsDecision ? { needsDecision: true } : {}),
        ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
        ...(input.work ? { work: input.work } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    };
  }

  function afterWrite(
    workspaceId: string,
    target: ChatRelayIdentityTarget,
    message: boolean,
    writer?: ChatWriter,
  ) {
    // Nothing on screen asked for an automation's message, so the windows hear of it.
    if (writer?.via === "automation") notifyRenderer(workspaceId);
    if (message) {
      signalChatWrite(workspaceId);
      // A message can mark a live bookmark projection pending, and a person's
      // message can call an agent.
      projectChatBookmarks(workspaceId);
      void scanChatDispatch(workspaceId).catch(
        logUnlessClosedCopy("[desktop] chat dispatch scan:"),
      );
    }
    if (shareViewIsPresent(findWorkspace(workspaceId)?.shareView)) {
      // A failed send stays queued in the view's store, and the next pull of
      // the view sends it again.
      void pushShareViewChat(workspaceId).catch(
        logUnlessClosedCopy("[desktop] joined workspace chat push:"),
      );
      return;
    }
    queueCloudSync(workspaceId);
    // Naming the target puts its joined channel in this pass instead of
    // leaving it to the rotation.
    void syncSharedChannelsForChatTarget(workspaceId, target).catch(
      logUnlessClosedCopy("[desktop] shared channel sync:"),
    );
  }

  // A file chat has no author and belongs to no channel, so only the shared
  // view gate applies. It links the file's stable object id, never the path.
  // A joined workspace sends it to the owner, so it needs the account that
  // joined, as a post does.
  async function createFileThread(
    place: ChatWritePlace,
    input: {
      title: string;
      linkedFile(): Promise<{ objectId: string; pathHint: string }>;
    },
  ) {
    const joinedWorkspace = shareViewIsPresent(chatWorkspace(place.workspaceId).shareView);
    if (joinedWorkspace) await warmCredentials();
    const generation = currentCredentialGeneration();
    const admitted = () =>
      joinedWorkspace
        ? check(place, undefined, generation, true)
        : writableWorkspace(place.workspaceId, false);
    admitted();
    const linkedFile = await input.linkedFile();
    const at = joinedWorkspace
      ? await levelPlaceOf(place.workspaceId, { objectId: linkedFile.objectId })
      : null;
    // A joined workspace comments on a file where its path takes Comment or
    // Edit. That, the recheck and the store call share one synchronous block.
    if (joinedWorkspace && !takesPostsAt(place.workspaceId, at)) {
      throw new SharedFileReadOnlyError("Only people who can comment post here.");
    }
    admitted();
    const thread = await place.store.createThread({
      workspaceId: place.workspaceId,
      title: input.title,
      linkedFile,
    });
    afterWrite(place.workspaceId, { threadId: thread.id }, false);
    return thread;
  }

  async function replayedMessage(
    place: ChatWritePlace,
    input: ChatMessageInput,
    target: ChatRelayIdentityTarget,
  ) {
    chatWorkspace(place.workspaceId);
    if (input.writer.via !== "automation" || !input.messageId || !input.idempotencyKey) return null;
    const sent = await place.store
      .getMessage({ workspaceId: place.workspaceId, messageId: input.messageId })
      .catch(() => null);
    if (
      !sent ||
      sent.author.kind !== "automation" ||
      sent.automation?.automationId !== input.writer.automationId ||
      sent.body !== normalizeChatMessageBody(input.body)
    )
      return null;
    const where =
      "channelId" in target
        ? (await place.store
            .findThreadChannelId({ workspaceId: place.workspaceId, threadId: sent.threadId })
            .catch(() => null)) === target.channelId
        : sent.threadId === target.threadId;
    return where ? sent : null;
  }

  type ReplyInput = ChatMessageInput & { threadId: string; parentMessageId?: string };

  function commitReply(
    place: ChatWritePlace,
    { admission, fields }: Awaited<ReturnType<typeof prepareMessage>>,
    input: ReplyInput,
  ) {
    return commit(
      place,
      admission,
      () =>
        place.store.sendMessage({
          workspaceId: place.workspaceId,
          threadId: input.threadId,
          ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
          ...fields,
        }),
      admission,
      input.signal,
    );
  }

  async function sendMessage(place: ChatWritePlace, input: ReplyInput) {
    const target = { threadId: input.threadId };
    let message;
    try {
      message = await commitReply(place, await prepareMessage(place, target, input), input);
    } catch (error) {
      const sent = await replayedMessage(place, input, target);
      if (!sent) throw error;
      message = sent;
    }
    input.onSaved?.({ message });
    afterWrite(place.workspaceId, target, true, input.writer);
    return message;
  }

  async function startThread(
    place: ChatWritePlace,
    input: ChatMessageInput & {
      channelId: string;
      lane?: ChatThreadLane;
      title?: string;
      // The thread a new post starts; a Group's chat lane keeps its running one.
      threadId?: string;
      // Desktop's own thread in an agent DM; see LinkedChatStore.startChannelThread.
      ownThread?: true;
    },
  ) {
    const target = { channelId: input.channelId };
    let started;
    try {
      const { admission, fields } = await prepareMessage(place, target, input);
      started = await commit(
        place,
        admission,
        () =>
          place.store.startChannelThread({
            workspaceId: place.workspaceId,
            channelId: input.channelId,
            ...(input.lane ? { lane: input.lane } : {}),
            ...(input.title ? { title: input.title } : {}),
            ...(input.threadId ? { threadId: input.threadId } : {}),
            ...(input.ownThread ? { ownThread: true } : {}),
            ...fields,
          }),
        admission,
        input.signal,
      );
    } catch (error) {
      const sent = await replayedMessage(place, input, target);
      if (!sent) throw error;
      // The post saved, so the caller hears so before the lookup of its thread, which can fail.
      input.onSaved?.({ message: sent });
      const thread = (
        await place.store.listChannelThreads({
          workspaceId: place.workspaceId,
          channelId: input.channelId,
          ...(input.lane ? { lane: input.lane } : {}),
        })
      ).find((entry) => entry.thread.id === sent.threadId)?.thread;
      if (!thread) throw error;
      afterWrite(place.workspaceId, target, true, input.writer);
      return { thread, message: sent };
    }
    input.onSaved?.({ message: started.message });
    afterWrite(place.workspaceId, target, true, input.writer);
    return started;
  }

  // "toggle", the CLI's convenience, removes the writer's reaction when one
  // exists and adds it otherwise, under the same admission as the row. A
  // reaction made signed out lives under the local id; once signed in,
  // removing it removes that alias too.
  async function setReaction(
    place: ChatWritePlace,
    input: {
      writer: PersonWriter;
      threadId: string;
      messageId: string;
      emoji: string;
      state: "added" | "removed" | "toggle";
      idempotencyKey?: string;
    },
  ) {
    const { workspaceId, store } = place;
    const target = { threadId: input.threadId };
    const localAuthorId = localInstallationId();
    const aliased = (authorUserId: string | undefined): authorUserId is string =>
      authorUserId !== undefined && authorUserId !== localAuthorId;
    const admission = await admit(place, target);
    const { authorUserId } = admission;
    const { author } = await personActorFor(input.writer);
    const existing =
      input.state === "toggle" || (input.state === "removed" && aliased(authorUserId))
        ? await store.listReactions({ workspaceId, threadId: input.threadId })
        : [];
    const reacted = (authorId: string | undefined) =>
      existing.some(
        (reaction) =>
          reaction.messageId === input.messageId &&
          reaction.emoji === input.emoji &&
          reaction.author.authorId === authorId,
      );
    const hasLocalAlias = reacted(localAuthorId);
    const hasCurrent = authorUserId !== undefined && reacted(authorUserId);
    const state =
      input.state !== "toggle" ? input.state : hasLocalAlias || hasCurrent ? "removed" : "added";
    // Each row commits on its own, including the second row of an alias
    // removal, and each author's cell has its own key.
    const write = (authorId: string, replicationAuthorId?: string, idempotencyKey?: string) =>
      commit(place, admission, () =>
        store.setReaction({
          workspaceId,
          threadId: input.threadId,
          messageId: input.messageId,
          emoji: input.emoji,
          author: { authorId, ...author },
          ...(replicationAuthorId ? { replicationAuthorId } : {}),
          state,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      );
    let reaction: Awaited<ReturnType<typeof write>>;
    if (state === "removed" && aliased(authorUserId) && hasLocalAlias) {
      reaction = await write(
        localAuthorId,
        undefined,
        input.idempotencyKey && `${input.idempotencyKey}:local`,
      );
      if (hasCurrent) reaction = await write(authorUserId, authorUserId, input.idempotencyKey);
    } else {
      reaction = await write(authorUserId ?? localAuthorId, authorUserId, input.idempotencyKey);
    }
    afterWrite(workspaceId, target, false);
    return reaction;
  }

  // A reply that answers a question or poll, under one admission. The shared
  // command orders its stages and judges who won. The reply and the answer
  // land between dispatch scans, so no agent reads the reply while its
  // question still looks open.
  async function answer(
    place: ChatWritePlace,
    input: ReplyInput,
    use: (stages: AnswerStages) => Promise<AnswerOutcome>,
  ) {
    const target = { threadId: input.threadId };
    const prepared = await prepareMessage(place, target, input);
    const answered = await betweenDispatchScans(place.workspaceId, async () => {
      const outcome = await use({
        reply: () => commitReply(place, prepared, input),
        resolve: (command) =>
          commit(place, prepared.admission, () =>
            place.store.resolveChatDecision({
              workspaceId: place.workspaceId,
              ...command,
            }),
          ),
      });
      input.onSaved?.(
        outcome.state === "failed"
          ? { message: outcome.message, failure: outcome.failure }
          : { message: outcome.message },
      );
      return outcome;
    });
    afterWrite(place.workspaceId, target, true, input.writer);
    return answered;
  }

  // Answers a question with a reply that already saved, when the answer
  // failed after the reply landed. It posts nothing. The reply must be in the
  // question's thread, written from a window rather than the CLI, and carry
  // the key this session gives the writer, which only a reply this device
  // wrote for them keeps.
  async function answerWith(
    place: ChatWritePlace,
    input: {
      writer: PersonWriter;
      threadId: string;
      questionId: string;
      replyId: string;
    },
    use: (stages: AnswerWithStages) => Promise<Answered>,
  ) {
    const { workspaceId, store } = place;
    const target = { threadId: input.threadId };
    const admission = await admit(place, target);
    const reply = await store.getMessage({ workspaceId, messageId: input.replyId });
    const { author } = await personActorFor(input.writer);
    const authorActorKey = deriveChatActorKey({
      credentials: admission.actorCredentials,
      installationId: admission.installationId,
      workspaceId,
      writer: input.writer,
      displayName: author.displayName,
    });
    if (
      reply.threadId !== input.threadId ||
      reply.id === input.questionId ||
      reply.origin !== undefined ||
      authorActorKey === null ||
      reply.authorActorKey !== authorActorKey ||
      reply.authorUserId !== admission.authorUserId
    ) {
      throw new Error("Only your own reply in this thread can answer its question.");
    }
    const outcome = await use({
      reply,
      resolve: (command) =>
        commit(place, admission, () => store.resolveChatDecision({ workspaceId, ...command })),
    });
    // A question another reply answered changed nothing here.
    if (outcome.state === "resolved") {
      afterWrite(workspaceId, target, false);
      // No new message reaches the other views, so they hear of the answer here.
      notifyRenderer(workspaceId);
    }
    return outcome;
  }

  // The shared commands' host for one place and one person or their agent.
  // It gives no findMessage: the engine refuses a missing parent or message,
  // and this store hides none from the person.
  function host(place: ChatWritePlace, bound: ChatHostBinding): ChatWriteHost {
    const message = (
      command: ChatMessageContent & ChatMessageIds,
      checkTargets?: TargetCheck,
    ): ChatMessageInput => ({
      writer: bound.writer,
      body: command.body,
      needsDecision: command.needsDecision,
      options: command.options,
      work: bound.work,
      resolveAttachments: bound.resolveAttachments ?? (async () => []),
      messageId: command.messageId,
      idempotencyKey: command.idempotencyKey,
      onSaved: bound.onSaved,
      checkTargets,
    });
    return {
      workspaceId: place.workspaceId,
      store: place.store,
      start: (command) =>
        startThread(place, {
          ...message(command),
          channelId: command.channelId,
          lane: command.lane,
          title: command.title,
          threadId: command.threadId,
        }),
      reply: (command) =>
        sendMessage(place, {
          ...message(command),
          threadId: command.threadId,
          parentMessageId: command.parentMessageId,
        }),
      answer: (command, checkTargets, use) =>
        answer(
          place,
          {
            ...message(command, checkTargets),
            threadId: command.threadId,
            parentMessageId: command.parentMessageId,
          },
          use,
        ),
      answerWith: (command, use) => answerWith(place, { writer: bound.writer, ...command }, use),
      react: (command) => setReaction(place, { writer: bound.writer, ...command }),
    };
  }

  // Throws unless a message to this thread would be admitted now: the checks
  // a write makes, without writing.
  async function assertMayPost(place: ChatWritePlace, threadId: string): Promise<void> {
    await admit(place, { threadId });
  }

  return { createFileThread, sendMessage, startThread, setReaction, assertMayPost, host };
}

// Use captured admission credentials, including for a DM's opening message.
export function deriveChatActorKey(input: {
  credentials: Pick<CloudCredentials, "serverUrl" | "userId"> | null;
  installationId: string;
  workspaceId: string;
  writer: ChatWriter;
  displayName: string;
}): string | null {
  try {
    return serializeActorKey(
      deriveLocalActor({
        identity: {
          installationId: input.installationId,
          account:
            input.credentials === null
              ? null
              : {
                  issuer: createActorIssuer(input.credentials.serverUrl),
                  userId: input.credentials.userId,
                },
        },
        workspaceId: input.workspaceId,
        author:
          input.writer.via === "automation"
            ? { kind: "automation", automationId: input.writer.automationId }
            : input.writer.via === "cli" && input.writer.actor === "agent"
              ? // Only an agent you run and a run dohc dispatched name their agent.
                // Any other agent is the unnamed agent, whatever name it gives.
                { kind: "agent", claimedName: input.writer.agentId }
              : { kind: "human" },
        displayName: input.displayName,
        origin: input.writer.via,
      }).key,
    );
  } catch {
    // A damaged signed-in issuer supplies no installation evidence.
    return null;
  }
}

export type ChatWrites = ReturnType<typeof createChatWrites>;
