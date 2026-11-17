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
import { createHash } from "node:crypto";
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
  /** Throws once the window no longer shows that workspace. Checked again just before the request leaves. */
  assertCurrent(): void;
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

/**
 * Who a window's conversation call is for: the account its list named. `scope` stands for that account's server
 * and user, so main refuses the call once another account, or the same user on another server, signs in.
 */
export interface DirectViewer {
  viewerId: string;
  scope: string;
}

/** The list as the server last gave it, for one account. */
export interface DirectListed extends DirectViewer {
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
/** The scope a window passes back with each call for `account`. Opaque to the window. */
export const directScope = (account: DirectAccount) =>
  createHash("sha256").update(accountKey(account)).digest("hex");
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

  const toListed = ({ viewerId, scope, conversations }: DirectListed): DirectListed => ({
    viewerId,
    scope,
    conversations,
  });
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
   * The one door for a window's call: it acts only while the account it names is signed in on the same server.
   * A conversation call names the scope its list came with. A member pick names its workspace's member ids,
   * which mean someone else on another server, so it names the account main admitted the pick on.
   */
  const as = async (viewer: DirectViewer): Promise<Credentials> => {
    const credentials = await signedIn();
    if (credentials.userId !== viewer.viewerId || directScope(credentials) !== viewer.scope)
      throw new DirectMessageError("refused", OTHER_ACCOUNT);
    return credentials;
  };
  // The window may leave the pick's workspace while the account is read, so its check runs after that read.
  const asPicked = async (viewerId: string, pick: DirectPick): Promise<Credentials> => {
    const credentials = await as({ viewerId, scope: directScope(pick.admitted) });
    pick.assertCurrent();
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
      scope: directScope(credentials),
      conversations: answer.conversations,
      read,
      fresh,
    };
    // A read that lands after the account changed does not replace the new account's list.
    const current = await dependencies.credentials().catch(() => null);
    if (!current || accountKey(current) !== next.key) return toListed(next);
    // Reads overlap, so answers can arrive out of order. An older one would bring back a Notice already read.
    if (listed?.key === next.key && listed.read > next.read) return toListed(listed);
    setListed(next);
    return toListed(next);
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
        ? toListed(listed)
        : null;
    },

    /** The signed-in account's conversations, and who that account is. Windows learn `viewerId` here. */
    async list(): Promise<DirectListed> {
      const credentials = await signedIn();
      void ensureFollowing();
      if (listed?.fresh && listed.key === accountKey(credentials)) return toListed(listed);
      return readList(credentials, false);
    },

    /** The newest page, or the page before `before`. */
    async history(
      viewer: DirectViewer,
      conversationId: string,
      before?: number,
    ): Promise<DirectMessagePage> {
      const credentials = await as(viewer);
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
      const credentials = await asPicked(viewerId, pick);
      const resolved = parseDirectResolution(
        await post(credentials, DIRECT_ROUTES.resolve, { person: pick.person }),
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
      input: { messageId: string; body: string } & (
        | { viewer: DirectViewer; conversationId: string }
        | { viewerId: string; pick: DirectPick }
      ),
    ): Promise<DirectSendResult> {
      // A direct message belongs to no workspace, so it links no file.
      if (extractChatFileReferences(input.body).length > 0)
        throw new DirectMessageError("refused", "Files can't be linked in a direct message.");
      const { messageId, body } = input;
      const [credentials, to] =
        "pick" in input
          ? [await asPicked(input.viewerId, input.pick), { person: input.pick.person }]
          : [await as(input.viewer), { conversationId: input.conversationId }];
      const result = parseDirectSendResult(
        await post(credentials, DIRECT_ROUTES.send, { messageId, body, ...to }),
      );
      if (!result)
        throw new DirectMessageError(
          "refused",
          "Your server answered in a way dohc could not read. Check the conversation before sending again.",
        );
      return result;
    },

    async read(viewer: DirectViewer, conversationId: string, seq: number): Promise<void> {
      await post(await as(viewer), conversationPath(DIRECT_ROUTES.read, conversationId), { seq });
    },

    async block(viewer: DirectViewer, conversationId: string, blocked: boolean): Promise<void> {
      await post(await as(viewer), conversationPath(DIRECT_ROUTES.block, conversationId), {
        blocked,
      });
    },
  };
}

export type DirectMessages = ReturnType<typeof createDirectMessages>;
