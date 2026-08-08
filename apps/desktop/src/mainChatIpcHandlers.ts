// Small production seam around Electron IPC registration. main.ts supplies
// the real parsers, workspace lookup, policy checks, and operations; tests can
// register and invoke these same callbacks without booting Electron's entire
// app lifecycle.
import {
  ChatChannelShareGrantRow,
  ChatChannelShareReceivedRow,
  MAX_CHAT_CHANNEL_SHARE_ROWS,
} from "./ipc/bridgeContract";

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

export async function awaitCredentialGeneration<Result>(input: {
  capturedGeneration: number;
  currentGeneration: () => number;
  run: () => Promise<Result>;
}): Promise<Result> {
  const result = await input.run();
  if (input.currentGeneration() !== input.capturedGeneration) {
    throw new Error("Your dohc Cloud session changed. Try again.");
  }
  return result;
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

// A relay-share call that failed because its session was invalid. Whether
// that says anything about the CURRENT session depends on whose token the
// relay rejected: a rejection of the credentials still in use is an
// authoritative sign-out, while a rejection of a token the session already
// rotated away from says nothing — callers must not clear account-scoped
// caches over it.
export class RelaySessionError extends Error {
  readonly sessionWasCurrent: boolean;
  constructor(message: string, options?: { sessionWasCurrent?: boolean }) {
    super(message);
    this.sessionWasCurrent = options?.sessionWasCurrent ?? true;
  }
}

// The relay side of a chat share listing. The joined rows are local and always
// answer; the granted/received lanes exist only on the relay. A transport
// failure is "unreachable", never an empty listing — an outage must not read
// as "there are no shares", or it clobbers whatever rows the renderer has
// cached. A session failure is "signed-out": the caller has no account-scoped
// rows, and cached ones must clear.
export type RelayChatShareLanes =
  | {
      state: "answered";
      granted: ChatChannelShareGrantRow[];
      received: ChatChannelShareReceivedRow[];
    }
  | { state: "unreachable" }
  // The relay answered, and the answer is one dohc cannot list. Separate from
  // "unreachable" because the two owe the user different things: an outage
  // owes a retry, and this owes the count, the limit, and the fact that
  // retrying will not change it.
  | {
      state: "over-limit";
      lanes: Array<{ lane: "granted" | "received"; rows: number }>;
      limit: number;
    }
  | { state: "signed-out" };

export async function readRelayChatShareLanes(input: {
  fetchListing: () => Promise<{
    granted?: Array<Record<string, unknown>>;
    received?: Array<Record<string, unknown>>;
  }>;
  remoteWorkspaceId: string | null;
  // Received shares that belong to ANOTHER local workspace: already joined
  // there, or pinned there by the DM home map. A received grant is
  // account-wide, so without this the lane is the same in every workspace —
  // one account-wide problem with it blanks a workspace that has shares of its
  // own, and an invitation already accepted in Work keeps offering Join in
  // Personal (#618).
  shareIdsClaimedElsewhere: ReadonlySet<string>;
}): Promise<RelayChatShareLanes> {
  let listing: Awaited<ReturnType<typeof input.fetchListing>>;
  try {
    listing = await input.fetchListing();
  } catch (error) {
    // Signed-out is authoritative only when the relay rejected the CURRENT
    // credentials. A stale token's rejection — a listing still in flight
    // across a same-account rotation — says nothing about the current
    // session, and clearing cached rows over it is the clobber this
    // contract exists to prevent.
    if (error instanceof RelaySessionError && error.sessionWasCurrent) {
      return { state: "signed-out" };
    }
    return { state: "unreachable" };
  }
  // A 200 whose body is not the listing shape is NOT an authoritative
  // answer. Mapping, row-level validation AND the size cap run inside this
  // guard: a malformed body, an invalid entry field, or an over-cap lane
  // escaping to the contract parse would reject the whole IPC call, which the
  // renderer reads as an unknown listing and clears.
  try {
    const mapped = mapRelayShareListing(
      listing,
      input.remoteWorkspaceId,
      input.shareIdsClaimedElsewhere,
    );
    // Size is validated HERE, not by the contract schema. Every row can be
    // valid and the lane still be one dohc cannot list, and the schema sits
    // outside this guard: an over-cap lane reaching it throws, the IPC call
    // rejects, and the renderer clears every cached row -- the clobber this
    // contract exists to prevent, through the one door row validation does
    // not cover (#608).
    //
    // Before the per-row parse, not after: the filter has already run, so the
    // lengths are final, and a relay-controlled body should not be fully
    // zod-parsed on the main thread only to be thrown away.
    //
    // Over-cap does not truncate. "answered" claims authority: a truncated
    // lane would tell the user that the shares dohc cut do not exist, and a
    // missing grant reads as a revoked one.
    //
    // Nor does it report an outage. This answer arrived, and it will arrive
    // again identically — calling it unreachable gives the surface a Try
    // again that can never work and no way to say what is wrong. It resolves
    // OVER-LIMIT, carrying what it observed and the configured limit, and it
    // is non-authoritative for exactly the same reason unreachable is, so
    // cached rows still stand.
    const overCap = ([
      ["granted", mapped.granted.length],
      ["received", mapped.received.length],
    ] as const).filter(([, rows]) => rows > MAX_CHAT_CHANNEL_SHARE_ROWS);
    if (overCap.length > 0) {
      // Every over-cap lane, not the first: naming one of two sends the reader
      // to fix half the problem.
      const lanes = overCap
        .map(([lane, rows]) => `"${lane}" holds ${rows} rows`)
        .join(", ");
      console.warn(
        `[desktop] relay share listing ${lanes}; the cap is ${MAX_CHAT_CHANNEL_SHARE_ROWS} rows per lane. Reporting the listing over-limit, so cached rows survive and the surface can name the constraint.`,
      );
      return {
        state: "over-limit",
        lanes: overCap.map(([lane, rows]) => ({ lane, rows })),
        limit: MAX_CHAT_CHANNEL_SHARE_ROWS,
      };
    }
    return {
      state: "answered",
      granted: mapped.granted.map((row) => ChatChannelShareGrantRow.parse(row)),
      received: mapped.received.map((row) =>
        ChatChannelShareReceivedRow.parse(row),
      ),
    };
  } catch {
    return { state: "unreachable" };
  }
}

function mapRelayShareListing(
  listing: {
    granted?: Array<Record<string, unknown>>;
    received?: Array<Record<string, unknown>>;
  },
  remoteWorkspaceId: string | null,
  shareIdsClaimedElsewhere: ReadonlySet<string>,
): {
  granted: Array<Record<string, unknown>>;
  received: Array<Record<string, unknown>>;
} {
  const chatSelector = (row: Record<string, unknown>) => {
    const selector = row.selector as
      | { kind?: unknown; channelWireId?: unknown; access?: unknown }
      | undefined;
    return selector?.kind === "chat-channel" &&
      typeof selector.channelWireId === "string"
      ? {
          channelWireId: selector.channelWireId,
          access: selector.access === "read-only" ? "read-only" : "read-write",
        }
      : null;
  };
  const grantedRows = listing.granted ?? [];
  const receivedRows = listing.received ?? [];
  // Only real arrays may map. An ITERABLE non-array lane — a string — would
  // iterate per character, filter every one, and manufacture an
  // authoritative EMPTY answer out of garbage.
  if (!Array.isArray(grantedRows) || !Array.isArray(receivedRows)) {
    throw new Error("relay share listing lanes must be arrays");
  }
  const granted: Array<Record<string, unknown>> = [];
  const received: Array<Record<string, unknown>> = [];
  for (const row of grantedRows) {
    const selector = chatSelector(row);
    // Grants are scoped to THIS workspace's remote identity: a channel shared
    // from another workspace is managed there.
    if (!selector || remoteWorkspaceId === null) continue;
    if (row.workspaceId !== remoteWorkspaceId) continue;
    // REVOKED grants are the granted lane's tombstones, and they are dropped
    // rather than listed. The relay keeps returning them to the granter, so
    // counting them made the cap measure an account's LIFETIME grants: past
    // 4096 the listing stayed over-limit with every grant revoked, new grants
    // were blocked, and revoking more could not reduce the count — a permanent
    // lockout with no user action that helps.
    //
    // The rule is that a cap may only count what the user can actually
    // reduce. Nothing displays these either — grantedByWire
    // skips them — so dropping them shrinks the payload the cap exists to
    // bound instead of merely uncounting it.
    if (row.revokedAtMs !== null && row.revokedAtMs !== undefined) continue;
    granted.push({
      shareId: row.shareId,
      ...selector,
      recipientEmail: row.recipientEmail ?? null,
      revokedAtMs: null,
    });
  }
  for (const row of receivedRows) {
    const selector = chatSelector(row);
    if (!selector) continue;
    // Scoped to THIS workspace: a share another local workspace already
    // claimed is managed there, and listing it here would offer a Join that
    // contradicts the claim.
    if (typeof row.shareId === "string" && shareIdsClaimedElsewhere.has(row.shareId)) {
      continue;
    }
    received.push({
      shareId: row.shareId,
      ...selector,
      granterEmail: row.granterEmail ?? null,
    });
  }
  return { granted, received };
}

// A relay 401 acts if and only if it belongs to the CURRENT credentials, and
// then it acts COMPLETELY — memory, broadcast, persistent store — and
// immediately, never behind cleanup. A stale request still in flight from a
// previous session must not wipe the session the user just adopted; a
// current-session 401 must not leave the saved token behind to report a false
// connected state after a restart.
interface RelaySessionIdentity {
  serverUrl: string;
  userId: string;
  token: string;
}

function sameRelaySession(
  left: RelaySessionIdentity,
  right: RelaySessionIdentity | null,
): boolean {
  return (
    right !== null &&
    right.token === left.token &&
    right.serverUrl === left.serverUrl &&
    right.userId === left.userId
  );
}

// Returns whether the 401 belonged to the current session and was acted on —
// the caller threads that into RelaySessionError, because only a rejection of
// the CURRENT credentials is an authoritative sign-out.
export async function handleRelayUnauthorized(input: {
  requestCredentials: RelaySessionIdentity;
  currentCredentials: RelaySessionIdentity | null;
  clearCachedCredentials: () => void;
  // The transitional broadcast, fired at the clear; the final broadcast
  // fires only once the store settled (notifyCloudSessionChanged).
  notifySessionChanging: () => void;
  notifyCloudSessionChanged: () => void;
  // ONE serialized store mutation: the saved record can be NEWER than the
  // cache (a completed login poll saves the next session before main adopts
  // it), so the store compares and clears inside its own mutation queue — a
  // login save can never land between the check and the clear.
  invalidatePersistedSessionIf: (
    expected: RelaySessionIdentity,
  ) => Promise<void>;
}): Promise<boolean> {
  if (!sameRelaySession(input.requestCredentials, input.currentCredentials)) {
    return false;
  }
  input.clearCachedCredentials();
  input.notifySessionChanging();
  try {
    await input.invalidatePersistedSessionIf(input.requestCredentials);
  } catch {
    // The in-memory session is already cleared and broadcast; a store
    // failure must not turn the session error into something else.
  }
  // Broadcast the FINAL state after the store settled: a status read raced
  // by the first broadcast can have seen the expired on-disk session and
  // reported connected — no later event would correct it.
  input.notifyCloudSessionChanged();
  return true;
}

// The session a share listing's relay lanes are scoped to: server URL, relay
// URL, and the stable Better Auth user id. The relay URL is part of the
// scope — the same account reconnected to a different relay has different
// rows, so its cache must not carry over. Never the token: it rotates within
// one session, and a rotated token must still preserve that session's cache.
export function chatShareSessionKey(
  credentials: { serverUrl: string; relayUrl?: string; userId: string } | null,
): string | null {
  if (!credentials) return null;
  const normalize = (url: string) => url.replace(/\/+$/u, "");
  return [
    normalize(credentials.serverUrl),
    credentials.relayUrl ? normalize(credentials.relayUrl) : "",
    credentials.userId,
  ].join("#");
}
