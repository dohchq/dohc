import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DIRECT_ACTIVITY_MAX_WAIT_MS,
  DIRECT_ROUTES,
  parseDirectConversationList,
  parseDirectMessage,
  parseDirectMessagePage,
  parseDirectResolution,
  parseDirectSendResult,
  type DirectConversation,
  type DirectMemberPick,
  type DirectMessage,
  type DirectResolution,
  type DirectSendResult,
} from "@dohc/security-contract/direct-messages";
import { atomicWriteFile } from "../atomicReplaceFile";

// Direct messages for the signed-in account. The relay holds each
// conversation; this computer keeps a copy of what it has read under
// <stateDir>/direct-messages/<account>/, so a person can read and export
// their conversations while their server is unreachable.
//
// One loop follows the account's direct activity while anyone listens, and
// tells listeners when it moves. Everything is keyed by account: signing in
// as someone else starts a fresh loop and reads a different folder.

export interface DirectAccount {
  relayUrl?: string;
  userId: string;
}

export type DirectFailure = "signed-out" | "unreachable" | "refused";

export class DirectMessageError extends Error {
  constructor(readonly failure: DirectFailure, message: string, readonly status: number | null = null, readonly code: string | null = null) {
    super(message);
    this.name = "DirectMessageError";
  }
}

export interface DirectList {
  conversations: DirectConversation[];
  /** True when the server could not be reached and this is the copy on this computer. */
  saved: boolean;
}

export interface DirectHistory {
  messages: DirectMessage[];
  more: boolean;
  saved: boolean;
}

interface Dependencies<Credentials extends DirectAccount> {
  /** The signed-in account, or null. */
  credentials(): Promise<Credentials | null>;
  /** One relay request with the account's bearer. Rejects when the server is unreachable. */
  relayResponse(credentials: Credentials, path: string, init: RequestInit): Promise<Response>;
  stateDir(): string;
  /** The account's direct conversations changed on the server. */
  changed(): void;
  /** How long to wait after a failed follow, or after the server answered early with nothing new, in ms. */
  retryMs?: number;
}

const UNREACHABLE = "dohc could not reach your server. Check your connection, then try again.";
const SIGNED_OUT = "Sign in to your server to send direct messages.";

const accountKey = (account: DirectAccount) => createHash("sha256").update(`${account.relayUrl}\n${account.userId}`).digest("hex").slice(0, 32);
const conversationFile = (conversationId: string) => `${conversationId}.json`;

function refusal(status: number, code: string | null, message: string | null): DirectMessageError {
  if (code === "direct_blocked") return new DirectMessageError("refused", "You can't message this person.", status, code);
  if (code === "direct_alone") return new DirectMessageError("refused", "Nobody else is in this conversation any more.", status, code);
  if (code === "direct_limit_reached") return new DirectMessageError("refused", "Your account has stored as many direct messages as your server keeps. Ask whoever runs it for more room.", status, code);
  if (status === 404) return new DirectMessageError("refused", "dohc could not find this conversation or person. They may have left the workspace.", status, code);
  if (status === 429) return new DirectMessageError("refused", "You have sent a lot of messages. Wait a minute, then try again.", status, code);
  return new DirectMessageError("refused", message ?? `Your server refused the request (${status}). Try again.`, status, code);
}

export function createDirectMessages<Credentials extends DirectAccount>(dependencies: Dependencies<Credentials>) {
  let following: { key: string; stop: AbortController } | null = null;
  let listeners = 0;
  // The account whose copy may stay on this computer: undefined until main knows, null once signed out.
  let keeping: string | null | undefined;

  const account = async (): Promise<Credentials> => {
    const credentials = await dependencies.credentials();
    if (!credentials?.relayUrl) throw new DirectMessageError("signed-out", SIGNED_OUT);
    return credentials;
  };
  const folder = (credentials: DirectAccount) => join(dependencies.stateDir(), "direct-messages", accountKey(credentials));

  async function call(credentials: Credentials, path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await dependencies.relayResponse(credentials, path, init);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") throw error;
      throw new DirectMessageError("unreachable", UNREACHABLE);
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw refusal(response.status, typeof body?.code === "string" ? body.code : null, typeof body?.error === "string" ? body.error : null);
    return body;
  }

  const post = (credentials: Credentials, path: string, body: unknown) =>
    call(credentials, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function readSaved<T>(credentials: DirectAccount, file: string, parse: (value: unknown) => T | null): Promise<T | null> {
    try {
      return parse(JSON.parse(await readFile(join(folder(credentials), file), "utf8")));
    } catch {
      return null;
    }
  }

  async function save(credentials: DirectAccount, file: string, value: unknown): Promise<void> {
    if (keeping !== undefined && keeping !== accountKey(credentials)) return;
    try {
      await mkdir(folder(credentials), { recursive: true });
      await atomicWriteFile(join(folder(credentials), file), JSON.stringify(value));
    } catch {
      // The copy is for reading offline. A failed save leaves the last one.
    }
  }

  const parseSavedMessages = (value: unknown): DirectMessage[] | null => {
    if (!Array.isArray(value)) return null;
    const messages = value.map(parseDirectMessage);
    return messages.every((message): message is DirectMessage => message !== null) ? messages : null;
  };

  /** Adds a page to the saved copy, by seq, and answers the whole copy. */
  async function keep(credentials: DirectAccount, conversationId: string, page: readonly DirectMessage[]): Promise<DirectMessage[]> {
    const saved = await readSaved(credentials, conversationFile(conversationId), parseSavedMessages) ?? [];
    const bySeq = new Map(saved.map((message) => [message.seq, message]));
    for (const message of page) bySeq.set(message.seq, message);
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    await save(credentials, conversationFile(conversationId), merged);
    return merged;
  }

  const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });

  async function follow(key: string, stop: AbortSignal): Promise<void> {
    let since = -1;
    while (!stop.aborted) {
      // Each request reads the session again, so a new token for the same account is used at once.
      const credentials = await dependencies.credentials().catch(() => null);
      if (stop.aborted) return;
      if (!credentials?.relayUrl || accountKey(credentials) !== key) {
        void ensureFollowing();
        return;
      }
      try {
        const answer = await call(credentials, `${DIRECT_ROUTES.activity}?since=${Math.max(since, 0)}&waitMs=${since < 0 ? 0 : DIRECT_ACTIVITY_MAX_WAIT_MS}`, { signal: stop });
        const revision = (answer as { revision?: unknown } | null)?.revision;
        if (!Number.isSafeInteger(revision)) throw new DirectMessageError("refused", "unreadable activity");
        const unchanged = since >= 0 && revision === since;
        // The first answer counts as a change: a window may be showing the copy saved while the server was away.
        if (!unchanged) dependencies.changed();
        since = revision as number;
        // A server that answers before its wait with nothing new would otherwise make this loop spin.
        if (unchanged) await pause(dependencies.retryMs ?? 1_000);
      } catch {
        if (stop.aborted) return;
        await pause(dependencies.retryMs ?? 15_000);
      }
    }
  }

  async function ensureFollowing(): Promise<void> {
    if (listeners === 0) return;
    const credentials = await dependencies.credentials().catch(() => null);
    const key = credentials?.relayUrl ? accountKey(credentials) : null;
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
    /**
     * Keeps only this account's saved copy, or none when signed out. Call it
     * once the account is known, not on a credential load's temporary null.
     */
    async credentialsChanged(credentials: DirectAccount | null): Promise<void> {
      const keep = credentials?.relayUrl ? accountKey(credentials) : null;
      keeping = keep;
      const root = join(dependencies.stateDir(), "direct-messages");
      const folders = await readdir(root).catch(() => [] as string[]);
      await Promise.all(folders.filter((name) => name !== keep).map((name) => rm(join(root, name), { recursive: true, force: true })));
    },

    async list(): Promise<DirectList> {
      const credentials = await account();
      void ensureFollowing();
      try {
        const listed = parseDirectConversationList(await call(credentials, DIRECT_ROUTES.conversations));
        if (!listed) throw new DirectMessageError("refused", "Your server sent conversations dohc could not read. Try again.");
        await save(credentials, "conversations.json", listed);
        return { conversations: listed.conversations, saved: false };
      } catch (error) {
        if (!(error instanceof DirectMessageError) || error.failure !== "unreachable") throw error;
        const saved = await readSaved(credentials, "conversations.json", parseDirectConversationList);
        if (!saved) throw error;
        return { conversations: saved.conversations, saved: true };
      }
    },

    /** The newest page, or the page before `before`. Falls back to the saved copy when the server is unreachable. */
    async history(conversationId: string, before?: number): Promise<DirectHistory> {
      const credentials = await account();
      const query = before === undefined ? "" : `?before=${before}`;
      try {
        const page = parseDirectMessagePage(await call(credentials, `${DIRECT_ROUTES.messages.replace(":conversationId", encodeURIComponent(conversationId))}${query}`));
        if (!page || page.conversationId !== conversationId) throw new DirectMessageError("refused", "Your server sent messages dohc could not read. Try again.");
        await keep(credentials, conversationId, page.messages);
        return { messages: page.messages, more: page.more, saved: false };
      } catch (error) {
        if (!(error instanceof DirectMessageError) || error.failure !== "unreachable") throw error;
        const saved = await readSaved(credentials, conversationFile(conversationId), parseSavedMessages);
        if (!saved) throw error;
        const shown = before === undefined ? saved : saved.filter((message) => message.seq < before);
        return { messages: shown, more: false, saved: true };
      }
    },

    async resolve(people: DirectMemberPick[]): Promise<DirectResolution> {
      const resolved = parseDirectResolution(await post(await account(), DIRECT_ROUTES.resolve, { people }));
      if (!resolved) throw new DirectMessageError("refused", "Your server sent a person dohc could not read. Try again.");
      return resolved;
    },

    /** Sends one message. The caller keeps `messageId` for Try again, so a retry never sends twice. */
    async send(input: { messageId: string; body: string } & ({ conversationId: string } | { people: DirectMemberPick[] })): Promise<DirectSendResult> {
      const result = parseDirectSendResult(await post(await account(), DIRECT_ROUTES.send, input));
      if (!result) throw new DirectMessageError("refused", "Your server answered in a way dohc could not read. Check the conversation before sending again.");
      return result;
    },

    async read(conversationId: string, seq: number): Promise<void> {
      await post(await account(), DIRECT_ROUTES.read.replace(":conversationId", encodeURIComponent(conversationId)), { seq });
    },

    async block(conversationId: string, personId: string, blocked: boolean): Promise<void> {
      await post(await account(), DIRECT_ROUTES.block.replace(":conversationId", encodeURIComponent(conversationId)), { personId, blocked });
    },
  };
}

export type DirectMessages = ReturnType<typeof createDirectMessages>;
