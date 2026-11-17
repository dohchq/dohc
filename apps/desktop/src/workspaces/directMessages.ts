import {
  DIRECT_ACTIVITY_MAX_WAIT_MS,
  DIRECT_ROUTES,
  parseDirectConversationList,
  parseDirectMessagePage,
  parseDirectResolution,
  parseDirectSendResult,
  type DirectConversation,
  type DirectMemberPick,
  type DirectMessagePage,
  type DirectResolution,
  type DirectSendResult,
} from "@dohc/security-contract/direct-messages";
import { extractChatFileReferences } from "@dohc/workspace-contracts/chat-mentions";
import { DIRECT_FINAL, DIRECT_RETRY, DIRECT_SIGNED_OUT } from "../ipc/errorWords";

// Direct messages for the signed-in account. The relay holds each
// conversation; this computer keeps nothing on disk, so while the server is
// away the windows show their failed state with Try again.
//
// One loop follows the account's direct activity while anyone listens. Each
// move reads the list once, which the windows and the account's Notices share.

export interface DirectAccount {
  relayUrl?: string;
  userId: string;
}

export type DirectFailure = "signed-out" | "unreachable" | "refused";

/** A member picked in a workspace, and the account main checked that workspace against. */
export interface DirectPick {
  person: DirectMemberPick;
  admitted: DirectAccount;
}

export class DirectMessageError extends Error {
  /** Whether trying again can help. It crosses IPC as the error's code, so a notice offers Try again only then. */
  readonly wireCode: typeof DIRECT_FINAL | typeof DIRECT_RETRY | typeof DIRECT_SIGNED_OUT;
  constructor(
    readonly failure: DirectFailure,
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
    retry = failure === "unreachable",
  ) {
    super(message);
    this.name = "DirectMessageError";
    this.wireCode =
      failure === "signed-out" ? DIRECT_SIGNED_OUT : retry ? DIRECT_RETRY : DIRECT_FINAL;
  }
}

/** The list as the server last gave it, for one account. */
export interface DirectListed {
  viewerId: string;
  conversations: DirectConversation[];
}

interface Dependencies<Credentials extends DirectAccount> {
  /** The signed-in account, or null. */
  credentials(): Promise<Credentials | null>;
  /** One relay request with the account's bearer. Rejects when the server is unreachable. */
  relayResponse(credentials: Credentials, path: string, init: RequestInit): Promise<Response>;
  /** The account's direct conversations changed on the server, or the server stopped answering. */
  changed(): void;
  /** The list the Notices come from changed. */
  listedChanged(): void;
  /** How long to wait after a failed follow, or after the server answered early with nothing new, in ms. */
  retryMs?: number;
}

const UNREACHABLE = "dohc could not reach your server. Check your connection.";
const SIGNED_OUT = "Sign in to your server to send direct messages.";
// A window read the account, then the account changed before its call arrived.
const OTHER_ACCOUNT =
  "You signed in as someone else. Open Chats again to see their direct messages.";

const accountKey = (account: DirectAccount) => `${account.relayUrl}\n${account.userId}`;
const conversationPath = (route: string, conversationId: string) =>
  route.replace(":conversationId", encodeURIComponent(conversationId));

function refusal(status: number, code: string | null, message: string | null): DirectMessageError {
  if (code === "direct_blocked")
    return new DirectMessageError("refused", "You can't message this person.", status, code);
  if (code === "direct_limit_reached")
    return new DirectMessageError(
      "refused",
      "Your account has stored as many direct messages as your server keeps. Ask whoever runs it for more room.",
      status,
      code,
    );
  if (status === 404)
    return new DirectMessageError(
      "refused",
      "dohc could not find this conversation or person. They may have left the workspace.",
      status,
      code,
    );
  if (status === 429)
    return new DirectMessageError(
      "refused",
      "You have sent a lot of messages. Wait a minute, then try again.",
      status,
      code,
      true,
    );
  return new DirectMessageError(
    "refused",
    message ?? `Your server refused the request (${status}).`,
    status,
    code,
    true,
  );
}

export function createDirectMessages<Credentials extends DirectAccount>(
  dependencies: Dependencies<Credentials>,
) {
  let following: { key: string; stop: AbortController } | null = null;
  let listeners = 0;
  // The list for one account, from the read numbered `read`. `fresh` while nothing has changed it since the follow loop read it.
  let listed: (DirectListed & { key: string; read: number; fresh: boolean }) | null = null;
  // Numbers each list read as it starts. A server's revision can go backwards after a reset, so it can't order reads.
  let reads = 0;

  const setListed = (next: typeof listed) => {
    const before = listed;
    listed = next;
    if (before?.key !== next?.key || before?.conversations !== next?.conversations)
      dependencies.listedChanged();
  };

  const signedIn = async (): Promise<Credentials> => {
    const credentials = await dependencies.credentials();
    if (!credentials?.relayUrl) throw new DirectMessageError("signed-out", SIGNED_OUT);
    return credentials;
  };
  /**
   * The one door for a window's call: it names the account it read, and acts only while that account is signed in.
   * A member pick names its workspace's member ids, which mean someone else on another server, so it also needs the
   * server main admitted the pick on.
   */
  const as = async (viewerId: string, admitted?: DirectAccount): Promise<Credentials> => {
    const credentials = await signedIn();
    if (credentials.userId !== viewerId) throw new DirectMessageError("refused", OTHER_ACCOUNT);
    if (admitted && accountKey(admitted) !== accountKey(credentials))
      throw new DirectMessageError("refused", OTHER_ACCOUNT);
    return credentials;
  };

  async function call(
    credentials: Credentials,
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await dependencies.relayResponse(credentials, path, init);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") throw error;
      throw new DirectMessageError("unreachable", UNREACHABLE);
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok)
      throw refusal(
        response.status,
        typeof body?.code === "string" ? body.code : null,
        typeof body?.error === "string" ? body.error : null,
      );
    return body;
  }

  /** A write changes the list, so the next read goes to the server. */
  async function post(credentials: Credentials, path: string, body: unknown): Promise<unknown> {
    try {
      return await call(credentials, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      if (listed?.key === accountKey(credentials)) listed = { ...listed, fresh: false };
    }
  }

  async function readList(credentials: Credentials, fresh: boolean): Promise<DirectListed> {
    const read = ++reads;
    const answer = parseDirectConversationList(
      await call(credentials, DIRECT_ROUTES.conversations),
    );
    if (!answer)
      throw new DirectMessageError(
        "refused",
        "Your server sent conversations dohc could not read.",
        null,
        null,
        true,
      );
    const next = {
      key: accountKey(credentials),
      viewerId: credentials.userId,
      conversations: answer.conversations,
      read,
      fresh,
    };
    // A read that lands after the account changed does not replace the new account's list.
    const current = await dependencies.credentials().catch(() => null);
    if (!current || accountKey(current) !== next.key)
      return { viewerId: next.viewerId, conversations: next.conversations };
    // Reads overlap, so answers can arrive out of order. An older one would bring back a Notice already read.
    if (listed?.key === next.key && listed.read > next.read)
      return { viewerId: listed.viewerId, conversations: listed.conversations };
    setListed(next);
    return { viewerId: next.viewerId, conversations: next.conversations };
  }

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref?.();
    });

  async function follow(key: string, stop: AbortSignal): Promise<void> {
    let since = -1;
    while (!stop.aborted) {
      try {
        // Each request reads the session again, so a new token for the same account is used at once.
        // A read that fails is retried below like a failed request.
        const credentials = await dependencies.credentials();
        if (stop.aborted) return;
        if (!credentials?.relayUrl || accountKey(credentials) !== key) {
          // This loop ends. Its record goes first, or a follow for an account signed in again would think it still runs.
          if (following?.stop.signal === stop) following = null;
          void ensureFollowing();
          return;
        }
        const answer = await call(
          credentials,
          `${DIRECT_ROUTES.activity}?since=${Math.max(since, 0)}&waitMs=${since < 0 ? 0 : DIRECT_ACTIVITY_MAX_WAIT_MS}`,
          { signal: stop },
        );
        const revision = (answer as { revision?: unknown } | null)?.revision;
        if (!Number.isSafeInteger(revision))
          throw new DirectMessageError("refused", "unreadable activity", null, null, true);
        const unchanged = since >= 0 && revision === since;
        // The first answer counts as a change: a window may be showing a failed read from while the server was away.
        if (!unchanged) {
          await readList(credentials, true);
          if (stop.aborted) return;
          dependencies.changed();
        }
        since = revision as number;
        // A server that answers before its wait with nothing new would otherwise make this loop spin.
        if (unchanged) await pause(dependencies.retryMs ?? 1_000);
      } catch {
        if (stop.aborted) return;
        // The windows read the list again on this change; it must reach the server and fail, not repeat the last answer.
        if (listed?.key === key) listed = { ...listed, fresh: false };
        // Every failure is a change, so a window shows that the server is away instead of waiting to fail a send.
        // Not only the first: a server shutting down can fail this call and still answer the list read it starts.
        dependencies.changed();
        // The first retry comes soon, so that case settles in a second rather than a full wait.
        const first = since >= 0;
        since = -1;
        await pause(dependencies.retryMs ?? (first ? 1_000 : 15_000));
      }
    }
  }

  async function ensureFollowing(): Promise<void> {
    if (listeners === 0) return;
    const credentials = await dependencies.credentials().catch(() => null);
    // The last listener may have stopped while the account was read.
    if (listeners === 0) return;
    const key = credentials?.relayUrl ? accountKey(credentials) : null;
    if (listed && listed.key !== key) setListed(null);
    if (following?.key === key) return;
    following?.stop.abort();
    following = null;
    if (!credentials || key === null) return;
    const stop = new AbortController();
    following = { key, stop };
    void follow(key, stop.signal);
  }

  return {
    /** Starts following while anything listens. The returned function stops listening. */
    listen(): () => void {
      listeners += 1;
      void ensureFollowing();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        listeners -= 1;
        if (listeners === 0) {
          following?.stop.abort();
          following = null;
        }
      };
    },
    /** The account changed: follow the new one, if anything listens. */
    accountChanged(): void {
      void ensureFollowing();
    },
    /** The list the follow loop read last, for `userId` only. Nothing is read from the server. */
    listed(userId: string): DirectListed | null {
      return listed && listed.viewerId === userId && following?.key === listed.key
        ? { viewerId: listed.viewerId, conversations: listed.conversations }
        : null;
    },

    /** The signed-in account's conversations, and who that account is. Windows learn `viewerId` here. */
    async list(): Promise<DirectListed> {
      const credentials = await signedIn();
      void ensureFollowing();
      if (listed?.fresh && listed.key === accountKey(credentials))
        return { viewerId: listed.viewerId, conversations: listed.conversations };
      return readList(credentials, false);
    },

    /** The newest page, or the page before `before`. */
    async history(
      viewerId: string,
      conversationId: string,
      before?: number,
    ): Promise<DirectMessagePage> {
      const credentials = await as(viewerId);
      const query = before === undefined ? "" : `?before=${before}`;
      const page = parseDirectMessagePage(
        await call(
          credentials,
          `${conversationPath(DIRECT_ROUTES.messages, conversationId)}${query}`,
        ),
      );
      if (!page || page.conversationId !== conversationId)
        throw new DirectMessageError(
          "refused",
          "Your server sent messages dohc could not read.",
          null,
          null,
          true,
        );
      return page;
    },

    async resolve(viewerId: string, pick: DirectPick): Promise<DirectResolution> {
      const resolved = parseDirectResolution(
        await post(await as(viewerId, pick.admitted), DIRECT_ROUTES.resolve, {
          person: pick.person,
        }),
      );
      if (!resolved)
        throw new DirectMessageError(
          "refused",
          "Your server sent a person dohc could not read.",
          null,
          null,
          true,
        );
      return resolved;
    },

    /** Sends one message. The caller keeps `messageId` for Try again, so a retry never sends twice. */
    async send(
      viewerId: string,
      input: { messageId: string; body: string } & (
        | { conversationId: string }
        | { pick: DirectPick }
      ),
    ): Promise<DirectSendResult> {
      // A direct message belongs to no workspace, so it links no file.
      if (extractChatFileReferences(input.body).length > 0)
        throw new DirectMessageError("refused", "Files can't be linked in a direct message.");
      const { messageId, body } = input;
      const result = parseDirectSendResult(
        "pick" in input
          ? await post(await as(viewerId, input.pick.admitted), DIRECT_ROUTES.send, {
              messageId,
              body,
              person: input.pick.person,
            })
          : await post(await as(viewerId), DIRECT_ROUTES.send, {
              messageId,
              body,
              conversationId: input.conversationId,
            }),
      );
      if (!result)
        throw new DirectMessageError(
          "refused",
          "Your server answered in a way dohc could not read. Check the conversation before sending again.",
        );
      return result;
    },

    async read(viewerId: string, conversationId: string, seq: number): Promise<void> {
      await post(await as(viewerId), conversationPath(DIRECT_ROUTES.read, conversationId), { seq });
    },

    async block(viewerId: string, conversationId: string, blocked: boolean): Promise<void> {
      await post(await as(viewerId), conversationPath(DIRECT_ROUTES.block, conversationId), {
        blocked,
      });
    },
  };
}

export type DirectMessages = ReturnType<typeof createDirectMessages>;
