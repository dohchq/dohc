// Small production seam around Electron IPC registration. main.ts supplies
// the real parsers, workspace lookup, policy checks, and operations; tests can
// register and invoke these same callbacks without booting Electron's entire
// app lifecycle.

interface WorkspacePayload {
  workspaceId: string;
}

interface WorkspaceContext {
  workspace: { workspaceId: string };
}

export type MainChatIpcHandler<Event, Result> = (
  event: Event,
  payload: unknown,
) => Promise<Result>;

export function createWritableChatIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  assertWritableWorkspace: (workspace: Context["workspace"]) => void;
  run: (context: Context, payload: Payload) => Promise<Result>;
  afterWrite?: Array<(context: Context, payload: Payload, result: Result) => void>;
}): MainChatIpcHandler<Event, Result> {
  return async (event, rawPayload) => {
    input.assertTrustedSender(event);
    const payload = input.parsePayload(rawPayload);
    const context = await input.requireContext(payload.workspaceId);
    input.assertWritableWorkspace(context.workspace);
    const result = await input.run(context, payload);
    for (const effect of input.afterWrite ?? []) effect(context, payload, result);
    return result;
  };
}

export function createReadAwareChatIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  isReadOnly: (workspace: Context["workspace"]) => boolean;
  run: (context: Context, payload: Payload, readOnly: boolean) => Promise<Result>;
}): MainChatIpcHandler<Event, Result> {
  return async (event, rawPayload) => {
    input.assertTrustedSender(event);
    const payload = input.parsePayload(rawPayload);
    const context = await input.requireContext(payload.workspaceId);
    return input.run(context, payload, input.isReadOnly(context.workspace));
  };
}

export function createChatChannelIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  assertWritableWorkspace: (workspace: Context["workspace"]) => void;
  run: (context: Context, payload: Payload) => Promise<Result>;
  queueCloudSync: (workspaceId: string) => void;
}): MainChatIpcHandler<Event, Result> {
  return createWritableChatIpcHandler({
    ...input,
    afterWrite: [({ workspace }) => input.queueCloudSync(workspace.workspaceId)],
  });
}

export function createSharedChannelWritableChatIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  assertWritableWorkspace: (workspace: Context["workspace"]) => void;
  assertSharedChannelWritable: (
    context: Context,
    payload: Payload,
  ) => Promise<void>;
  run: (context: Context, payload: Payload) => Promise<Result>;
}): MainChatIpcHandler<Event, Result> {
  return createWritableChatIpcHandler({
    ...input,
    run: async (context, payload) => {
      await input.assertSharedChannelWritable(context, payload);
      return input.run(context, payload);
    },
  });
}

export function createSetChatReactionIpcHandler<
  Event,
  Payload extends WorkspacePayload,
  Context extends WorkspaceContext,
  Result,
>(input: {
  assertTrustedSender: (event: Event) => void;
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  assertWritableWorkspace: (workspace: Context["workspace"]) => void;
  run: (context: Context, payload: Payload) => Promise<Result>;
  syncJoinedChannels: (workspaceId: string) => void;
  queueCloudSync: (workspaceId: string) => void;
}): MainChatIpcHandler<Event, Result> {
  return createWritableChatIpcHandler({
    ...input,
    afterWrite: [
      ({ workspace }) => input.syncJoinedChannels(workspace.workspaceId),
      ({ workspace }) => input.queueCloudSync(workspace.workspaceId),
    ],
  });
}

export async function setChatReactionFromMain<Result>(input: {
  workspaceId: string;
  threadId: string;
  messageId: string;
  emoji: string;
  state: "added" | "removed";
  localFallbackAuthorId: string;
  localAuthorDisplayName: string;
  resolveReplicationAuthorId: () => Promise<string | undefined>;
  revalidateReplicationAuthorId: (
    replicationAuthorId: string | undefined,
  ) => Promise<void>;
  listReactions?: () => Promise<
    readonly {
      messageId: string;
      emoji: string;
      author: { authorId: string };
    }[]
  >;
  setReaction: (mutation: {
    workspaceId: string;
    threadId: string;
    messageId: string;
    emoji: string;
    author: {
      authorId: string;
      kind: "human";
      displayName: string;
    };
    replicationAuthorId?: string;
    state: "added" | "removed";
  }) => Promise<Result>;
}): Promise<Result> {
  const replicationAuthorId = await input.resolveReplicationAuthorId();
  await input.revalidateReplicationAuthorId(replicationAuthorId);
  if (
    input.state === "removed" &&
    replicationAuthorId &&
    replicationAuthorId !== input.localFallbackAuthorId &&
    input.listReactions
  ) {
    const reactions = await input.listReactions();
    await input.revalidateReplicationAuthorId(replicationAuthorId);
    const matchesCell = (reaction: (typeof reactions)[number]) =>
      reaction.messageId === input.messageId && reaction.emoji === input.emoji;
    const hasLocalAlias = reactions.some(
      (reaction) =>
        matchesCell(reaction) &&
        reaction.author.authorId === input.localFallbackAuthorId,
    );
    const hasCurrentIdentity = reactions.some(
      (reaction) =>
        matchesCell(reaction) && reaction.author.authorId === replicationAuthorId,
    );
    let localRemoval: { result: Result } | undefined;
    if (hasLocalAlias) {
      localRemoval = {
        result: await input.setReaction({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          messageId: input.messageId,
          emoji: input.emoji,
          author: {
            authorId: input.localFallbackAuthorId,
            kind: "human",
            displayName: input.localAuthorDisplayName,
          },
          state: "removed",
        }),
      };
      await input.revalidateReplicationAuthorId(replicationAuthorId);
    }
    if (localRemoval && !hasCurrentIdentity) return localRemoval.result;
  }
  const authorId = replicationAuthorId ?? input.localFallbackAuthorId;
  return input.setReaction({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    messageId: input.messageId,
    emoji: input.emoji,
    author: {
      authorId,
      kind: "human",
      displayName: input.localAuthorDisplayName,
    },
    ...(replicationAuthorId ? { replicationAuthorId } : {}),
    state: input.state,
  });
}

export async function chatViewerAuthorId(input: {
  localFallbackAuthorId: string;
  resolveReplicationAuthorId: () => Promise<string | undefined>;
}): Promise<string> {
  return (
    (await input.resolveReplicationAuthorId()) ?? input.localFallbackAuthorId
  );
}

export function reactionsForViewer<
  Reaction extends {
    reactionId: string;
    threadId: string;
    messageId: string;
    emoji: string;
    authorId: string;
  },
>(
  reactions: readonly Reaction[],
  input: { viewerAuthorId: string; localFallbackAuthorId: string },
): Reaction[] {
  if (input.viewerAuthorId === input.localFallbackAuthorId) return [...reactions];

  const byCell = new Map<string, { reaction: Reaction; isCurrentIdentity: boolean }>();
  for (const reaction of reactions) {
    const isCurrentIdentity = reaction.authorId === input.viewerAuthorId;
    const mapped =
      reaction.authorId === input.localFallbackAuthorId
        ? { ...reaction, authorId: input.viewerAuthorId }
        : reaction;
    const key = [
      mapped.threadId,
      mapped.messageId,
      mapped.emoji,
      mapped.authorId,
    ].join("\u0000");
    const current = byCell.get(key);
    if (!current || (isCurrentIdentity && !current.isCurrentIdentity)) {
      byCell.set(key, { reaction: mapped, isCurrentIdentity });
    }
  }
  return [...byCell.values()].map(({ reaction }) => reaction);
}

export async function writeChatMessageFromMain<Attachment, Result>(input: {
  resolveAuthorUserId: () => Promise<string | undefined>;
  resolveAttachments: () => Promise<Attachment[]>;
  revalidateAuthorUserId: (authorUserId: string | undefined) => Promise<void>;
  write: (resolved: {
    authorUserId?: string;
    attachments: Attachment[];
  }) => Promise<Result>;
}): Promise<Result> {
  const authorUserId = await input.resolveAuthorUserId();
  const attachments = await input.resolveAttachments();
  await input.revalidateAuthorUserId(authorUserId);
  return input.write({
    ...(authorUserId ? { authorUserId } : {}),
    attachments,
  });
}
