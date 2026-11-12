import type {
  ChannelThreadSummary,
  ChatAgentReader,
  ChatChannel,
  ChatChannelSummary,
  ChatMessage,
  ChatReaction,
  ChatStreamItem,
  ChatThread,
} from "@dohc/workspace-contracts/engine";
import type { ChatReadStore, ChatsHost, DispatchFacts, ErrorDetail, ProvisionedChannel } from "../chats";
import type { AnswerStages, ChatWriteHost, ChatWriteReadStore } from "../chatWrites";

type Decision = Awaited<ReturnType<ChatReadStore["listThreadDecisions"]>>[number];
type ProjectionInput = Parameters<ChatReadStore["getThreadProjection"]>[0];
type StreamInput = Parameters<ChatReadStore["listGroupStream"]>[0];
type StreamPosition = ChatStreamItem["position"];
type StoreMethod = keyof ChatReadStore | "getMessage";

export const WORKSPACE_ID = "workspace-1";

// One workspace's chats in memory, read through the same methods as the
// linked chat store. `log` records each call, and the host's own effects, in
// the order they ran; `failing` makes a method reject.
export class MemoryChatStore implements ChatReadStore, ChatWriteReadStore {
  readonly log: string[] = [];
  readonly failing = new Map<StoreMethod, unknown>();
  readonly channels: ChatChannelSummary[] = [];
  readonly threads: ChatThread[] = [];
  readonly messages = new Map<string, ChatMessage[]>();
  readonly decisions = new Map<string, Decision[]>();
  readonly readSequence = new Map<string, number>();
  readonly wireIds = new Map<string, string>();
  readonly agentUnread = new Set<string>();
  readonly agentReaders: ChatAgentReader[] = [];
  readonly projections: ProjectionInput[] = [];
  private clock = 1_000;

  private enter(method: StoreMethod, workspaceId: string): void {
    this.log.push(method);
    if (workspaceId !== WORKSPACE_ID) throw new Error("Chat workspace mismatch.");
    if (this.failing.has(method)) throw this.failing.get(method);
  }

  now(): number {
    this.clock += 1;
    return this.clock;
  }

  addChannel(input: Partial<ChatChannel> & Pick<ChatChannel, "id" | "name">): ChatChannelSummary {
    const at = this.now();
    const channel: ChatChannelSummary = {
      workspaceId: WORKSPACE_ID,
      slug: input.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
      kind: "channel",
      type: "both",
      purpose: "",
      createdAtMs: at,
      updatedAtMs: at,
      threadCount: 0,
      unreadCount: 0,
      ...input,
    };
    this.channels.push(channel);
    return channel;
  }

  addThread(input: Partial<ChatThread> & Pick<ChatThread, "id">): ChatThread {
    const at = this.now();
    const thread: ChatThread = { workspaceId: WORKSPACE_ID, title: input.id, createdAtMs: at, updatedAtMs: at, ...input };
    this.threads.push(thread);
    this.messages.set(thread.id, []);
    return thread;
  }

  addMessage(input: Partial<ChatMessage> & Pick<ChatMessage, "id" | "threadId">): ChatMessage {
    const message: ChatMessage = {
      workspaceId: WORKSPACE_ID,
      author: { kind: "human", displayName: "Sam" },
      body: input.id,
      createdAtMs: this.now(),
      attachments: [],
      ...input,
    };
    const list = this.messages.get(message.threadId);
    if (!list) throw new Error(`no thread ${message.threadId}`);
    list.push(message);
    return message;
  }

  addDecision(threadId: string, decision: Omit<Decision, "workspaceId" | "threadId" | "atMs">): void {
    const list = this.decisions.get(threadId) ?? [];
    list.push({ workspaceId: WORKSPACE_ID, threadId, atMs: this.now(), ...decision });
    this.decisions.set(threadId, list);
  }

  async ensureGeneralChannel(input: { workspaceId: string }): Promise<ChatChannel> {
    this.enter("ensureGeneralChannel", input.workspaceId);
    return this.channels.find((channel) => channel.slug === "general") ??
      this.addChannel({ id: "channel-general", name: "General", slug: "general" });
  }

  async listChannels(input: { workspaceId: string }): Promise<ChatChannelSummary[]> {
    this.enter("listChannels", input.workspaceId);
    return this.channels.map((channel) => ({ ...channel }));
  }

  async getChannelWireId(input: { workspaceId: string; channelId: string }): Promise<string | null> {
    this.enter("getChannelWireId", input.workspaceId);
    return this.wireIds.get(input.channelId) ?? null;
  }

  async listChannelThreads(input: { workspaceId: string; channelId: string; lane?: "posts" | "chat" }): Promise<ChannelThreadSummary[]> {
    this.enter("listChannelThreads", input.workspaceId);
    const lane = input.lane ?? "posts";
    return this.threads
      .filter((thread) => thread.channelId === input.channelId && (thread.lane ?? "posts") === lane)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .map((thread) => {
        const messageCount = this.messages.get(thread.id)?.length ?? 0;
        const lastReadSequence = Math.min(messageCount, this.readSequence.get(thread.id) ?? 0);
        return {
          thread,
          messageCount,
          lastReadSequence,
          unreadCount: messageCount - lastReadSequence,
          openDecisionCount: (this.decisions.get(thread.id) ?? []).filter((decision) => decision.state === "open").length,
        };
      });
  }

  async listThreadsForFile(input: { workspaceId: string; objectId: string }): Promise<ChatThread[]> {
    this.enter("listThreadsForFile", input.workspaceId);
    return this.threads.filter((thread) => thread.linkedFile?.objectId === input.objectId);
  }

  async listThreads(input: { workspaceId: string }): Promise<ChatThread[]> {
    this.enter("listThreads", input.workspaceId);
    return [...this.threads];
  }

  async listMessages(input: { workspaceId: string; threadId: string }): Promise<ChatMessage[]> {
    this.enter("listMessages", input.workspaceId);
    const messages = this.messages.get(input.threadId);
    if (!messages) throw new Error("thread-not-found");
    return [...messages];
  }

  async getMessage(input: { workspaceId: string; messageId: string }): Promise<ChatMessage> {
    this.enter("getMessage", input.workspaceId);
    const message = [...this.messages.values()].flat().find((candidate) => candidate.id === input.messageId);
    if (!message) throw new Error("message-not-found");
    return message;
  }

  async listThreadDecisions(workspaceId: string, threadId: string): Promise<Decision[]> {
    this.enter("listThreadDecisions", workspaceId);
    return [...(this.decisions.get(threadId) ?? [])];
  }

  async getThreadProjection(input: ProjectionInput) {
    this.enter("getThreadProjection", input.workspaceId);
    this.projections.push(input);
    const access = input.linkedFileAccess;
    return {
      path: access?.kind === "allowed" ? access.path : `${input.threadId}.md`,
      readOnly: true as const,
      threadId: input.threadId,
      text: `The text of ${input.threadId}`,
    };
  }

  // Posts and conversation messages in one order: time, then a post before a
  // message, then id. Pages come from the newest end.
  async listGroupStream(input: StreamInput) {
    this.enter("listGroupStream", input.workspaceId);
    const items: ChatStreamItem[] = [];
    for (const thread of this.threads.filter((candidate) => candidate.channelId === input.channelId)) {
      const messages = this.messages.get(thread.id) ?? [];
      const decisionFor = (message: ChatMessage) => {
        const decision = this.decisions.get(thread.id)?.find((candidate) => candidate.messageId === message.id);
        if (!decision) return {};
        const { workspaceId: _workspaceId, ...rest } = decision;
        return { decision: rest };
      };
      if ((thread.lane ?? "posts") === "posts") {
        const [first, ...replies] = messages;
        if (!first) continue;
        items.push({
          position: { createdAtMs: first.createdAtMs, lane: "posts", id: thread.id },
          message: first,
          ...decisionFor(first),
          reactions: [],
          post: {
            replyCount: replies.length,
            repliers: replies.slice(-1).map((reply) => ({ author: reply.author, lastReplyAtMs: reply.createdAtMs })),
            ...(replies.length ? { lastReplyAtMs: replies.at(-1)!.createdAtMs } : {}),
            openDecisionCount: 0,
          },
        });
      } else {
        for (const message of messages.filter((candidate) => !candidate.parentMessageId)) {
          items.push({ position: { createdAtMs: message.createdAtMs, lane: "chat", id: message.id }, message, ...decisionFor(message), reactions: [] });
        }
      }
    }
    const order = (left: StreamPosition, right: StreamPosition) =>
      left.createdAtMs - right.createdAtMs ||
      (left.lane === right.lane ? 0 : left.lane === "posts" ? -1 : 1) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    items.sort((left, right) => order(left.position, right.position));
    const before = input.before;
    const older = before ? items.filter((item) => order(item.position, before) < 0) : items;
    const limit = Math.min(100, input.limit ?? 50);
    const page = older.slice(Math.max(0, older.length - limit));
    return {
      items: page,
      nextBefore: page.length < older.length ? page[0]!.position : null,
      readPosition: null,
    };
  }

  async listAgentUnreadThreads(workspaceId: string, reader: ChatAgentReader) {
    this.enter("listAgentUnreadThreads", workspaceId);
    this.agentReaders.push(reader);
    return this.threads
      .filter((thread) => this.agentUnread.has(thread.id))
      .map((thread) => ({ ...thread, lastRead: { createdAtMs: 0, messageId: "" } }));
  }
}

export const IDLE_DISPATCH: DispatchFacts = { paused: null, lastRun: null };

// A host over the store. Files map path to object id and back; provisioning
// is logged beside the store's calls so their order can be checked.
export function memoryHost(
  store: MemoryChatStore,
  options: { writable?: boolean; files?: Record<string, string>; dispatch?: DispatchFacts; errorDetail?: ErrorDetail } = {},
): ChatsHost & { provisions: ProvisionedChannel[] } {
  const files = options.files ?? {};
  const provisions: ProvisionedChannel[] = [];
  return {
    workspaceId: WORKSPACE_ID,
    store,
    provisions,
    writable: options.writable ?? true,
    errorDetail: options.errorDetail ?? "full",
    fileObjectId: async (path) => files[path] ?? null,
    filePath: async (objectId) => Object.entries(files).find(([, id]) => id === objectId)?.[0] ?? null,
    dispatch: async () => options.dispatch ?? IDLE_DISPATCH,
    provisioned: (change) => {
      store.log.push("provisioned");
      provisions.push(change);
    },
  };
}

// A write host over the store that admits everyone. `log` records each stage
// beside the store's reads; `commands` keeps what each stage was handed. Like
// the engine, a chat lane start joins the channel's running conversation, and
// a resolve of an answered question returns it as it was. `findMessage` gives
// the host the hook a host with a filtered store provides.
export function memoryWriteHost(store: MemoryChatStore, options: { findMessage?: boolean } = {}) {
  const commands: unknown[] = [];
  let next = 0;
  const id = (prefix: string) => `${prefix}-${(next += 1)}`;
  const write = (input: { threadId: string; body: string; messageId?: string; parentMessageId?: string }) =>
    store.addMessage({
      id: input.messageId ?? id("message"), threadId: input.threadId, body: input.body,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    });
  const resolve: AnswerStages["resolve"] = async (command) => {
    store.log.push("resolve");
    commands.push({ resolve: command });
    const decision = store.decisions.get(command.threadId)?.find((candidate) => candidate.messageId === command.messageId);
    if (!decision) throw new Error("decision-not-found");
    if (decision.state === "open") {
      Object.assign(decision, { state: "resolved", resolvedByMessageId: command.resolvedByMessageId },
        command.chosenOption === undefined ? {} : { chosenOption: command.chosenOption });
    }
    return { ...decision };
  };
  const host: ChatWriteHost = {
    workspaceId: WORKSPACE_ID,
    store,
    ...(options.findMessage ? { findMessage: (messageId: string) => store.getMessage({ workspaceId: WORKSPACE_ID, messageId }) } : {}),
    async start(command) {
      store.log.push("admit", "start");
      commands.push({ start: command });
      const running = command.lane === "chat"
        ? store.threads.find((thread) => thread.channelId === command.channelId && thread.lane === "chat")
        : undefined;
      const thread = running ?? store.addThread({
        id: command.threadId ?? id("thread"), channelId: command.channelId, lane: command.lane, title: command.title ?? "",
      });
      return { thread, message: write({ ...command, threadId: thread.id }) };
    },
    async reply(command) {
      store.log.push("admit", "reply");
      commands.push({ reply: command });
      return write(command);
    },
    async answer(command, checkTargets, use) {
      store.log.push("admit");
      await checkTargets();
      return await use({
        reply: async () => {
          store.log.push("reply");
          commands.push({ reply: command });
          return write(command);
        },
        resolve,
      });
    },
    async answerWith(command, use) {
      store.log.push("admit");
      return await use({ reply: await store.getMessage({ workspaceId: WORKSPACE_ID, messageId: command.replyId }), resolve });
    },
    async react(command) {
      store.log.push("admit", "react");
      commands.push({ react: command });
      const reaction: ChatReaction = {
        reactionId: `${command.messageId}:${command.emoji}`, threadId: command.threadId, messageId: command.messageId,
        emoji: command.emoji, author: { authorId: "user-1", kind: "human", displayName: "Sam" }, state: command.state, atMs: store.now(),
      };
      return reaction;
    },
  };
  return { host, commands };
}
