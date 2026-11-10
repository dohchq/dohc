import { endSession, listSessions, readAccount } from "./api";
import { createServerClient, ServerError, type Fetch, type ServerClient } from "./client";
import { sleep, startDeviceSignIn, waitForDeviceToken } from "./deviceFlow";

// The phone's sign-in to one server, as the desktop's cloud login keeps its (apps/desktop/src/workspaces/cloudLogin.ts).
//
// A sign-in generation changes, synchronously, when the person signs out, when the server ends the session (a 401),
// and when a sign-in starts, which supersedes any earlier one. Changing the account or the server goes through
// sign-out, so it changes the generation too. A change aborts every request of the generation before it. Anything
// that would update state, the screen, the token store or a cache, checks its generation first, and gives up once it
// has moved on.
//
// Ending a token deletes it from the store first, then revokes its session with the copy held in memory, so a phone
// closed mid-way never keeps a token it signed out of. Writes to the store run one at a time, in order, so a delete
// always lands after a save it raced.

/** What the token store keeps for this phone: the server, the session token, and whose it is. */
export interface StoredSignIn {
  readonly origin: string;
  readonly token: string;
  readonly userId: string;
  readonly email: string;
}

export interface SignInStore {
  load(): Promise<StoredSignIn | null>;
  save(signIn: StoredSignIn): Promise<void>;
  clear(): Promise<void>;
}

export interface SignIn {
  readonly origin: string;
  readonly userId: string;
  readonly email: string;
  readonly client: ServerClient;
  /** False once this sign-in has ended. Check it before applying anything one of its requests answered. */
  isCurrent(): boolean;
}

export type AccountState =
  | { readonly status: "loading" }
  /**
   * `origin` is the last server, to sign in to again; `ended` when the server ended the session. `forgetFailed` while
   * a token this phone signed out of is still in the store, because deleting it failed.
   */
  | { readonly status: "signed-out"; readonly origin: string | null; readonly ended: boolean; readonly forgetFailed: boolean }
  | { readonly status: "signed-in"; readonly signIn: SignIn };

export type SignInOutcome = "signed-in" | "denied" | "expired" | "cancelled";

export interface Account {
  state(): AccountState;
  subscribe(listener: () => void): () => void;
  /** Reads the saved sign-in, once, at launch. */
  restore(): Promise<void>;
  /**
   * Signs in to `origin` through the device flow, superseding any sign-in in progress. `onCode` gets the code and the
   * approval page while the sign-in is still current. Rejects with a ServerError when the server can't be used.
   * A signed-in phone signs out first.
   */
  signIn(origin: string, onCode: (code: { readonly userCode: string; readonly approvalUrl: string }) => void): Promise<SignInOutcome>;
  /** Ends a sign-in in progress. A completed sign-in stays. */
  cancelSignIn(): void;
  /**
   * Signs the phone out at once, ending everything the sign-in started. Then it deletes the token, and revokes its
   * session on the server, which may fail. It never rejects: a failed delete shows as `forgetFailed`.
   */
  signOut(): Promise<void>;
  /** Tries again to delete the tokens whose delete failed. */
  retryForget(): Promise<void>;
}

const REVOKE_TIMEOUT_MS = 5000;

export function createAccount(options: {
  readonly store: SignInStore;
  readonly fetch: Fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Account {
  const { store, fetch } = options;
  const now = options.now ?? Date.now;
  let generation = 0;
  let controller = new AbortController();
  let state: AccountState = { status: "loading" };
  let saved: StoredSignIn | null = null;
  const listeners = new Set<() => void>();
  let writes: Promise<unknown> = Promise.resolve();
  /** Tokens this phone ended whose delete failed, with their servers. */
  const unforgotten = new Map<string, string>();

  function setState(next: AccountState) {
    state = next;
    for (const listener of listeners) listener();
  }

  function signedOut(origin: string | null, ended: boolean): AccountState {
    return { status: "signed-out", origin, ended, forgetFailed: unforgotten.size > 0 };
  }

  /** Shows a delete that failed, or one that has now worked, on a signed-out phone. */
  function showForgetState() {
    if (state.status === "signed-out" && state.forgetFailed !== unforgotten.size > 0) setState(signedOut(state.origin, state.ended));
  }

  /** The next generation. The one before it ends, and its requests abort. */
  function advance(): { readonly id: number; readonly signal: AbortSignal } {
    controller.abort();
    controller = new AbortController();
    generation += 1;
    return { id: generation, signal: controller.signal };
  }

  function write<T>(run: () => Promise<T>): Promise<T> {
    const next = writes.then(run, run);
    writes = next.catch(() => undefined);
    return next;
  }

  /** Deletes the stored token, unless a newer sign-in has replaced it. Records a failed delete. */
  async function forget(origin: string, token: string): Promise<void> {
    try {
      await write(async () => {
        const stored = await store.load().catch(() => null);
        if (stored === null || stored.token === token) await store.clear();
      });
      unforgotten.delete(token);
    } catch {
      unforgotten.set(token, origin);
    }
    showForgetState();
  }

  /** Revokes this token's own session through the sessions route. Each request waits at most REVOKE_TIMEOUT_MS. */
  async function revoke(origin: string, token: string): Promise<void> {
    const client = createServerClient({ origin, token, fetch, signal: new AbortController().signal, timeoutMs: REVOKE_TIMEOUT_MS });
    const mine = (await listSessions(client)).find(session => session.current);
    if (mine) await endSession(client, mine.sessionId);
  }

  /** Deletes the token, then ends its session on the server. Never rejects. */
  async function endToken(origin: string, token: string): Promise<void> {
    await forget(origin, token);
    await revoke(origin, token).catch(() => undefined);
  }

  function signedIn(stored: StoredSignIn, current: { readonly id: number; readonly signal: AbortSignal }): SignIn {
    saved = stored;
    return {
      origin: stored.origin, userId: stored.userId, email: stored.email,
      isCurrent: () => current.id === generation,
      client: createServerClient({
        origin: stored.origin, token: stored.token, fetch, signal: current.signal,
        // The server ended the session, so there is nothing to revoke.
        onSignedOut: () => {
          if (current.id !== generation) return;
          advance();
          saved = null;
          setState(signedOut(stored.origin, true));
          void forget(stored.origin, stored.token);
        },
      }),
    };
  }

  function signOut(): Promise<void> {
    const ending = saved;
    const origin = ending?.origin ?? (state.status === "signed-out" ? state.origin : null);
    advance();
    saved = null;
    setState(signedOut(origin, false));
    return ending ? endToken(ending.origin, ending.token) : Promise.resolve();
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async restore() {
      const current = { id: generation, signal: controller.signal };
      const loaded = await write(() => store.load()).catch(() => null);
      // A token this phone already signed out of is never signed in with again.
      const stored = loaded && !unforgotten.has(loaded.token) ? loaded : null;
      if (current.id !== generation) {
        // Signed out while the store was read: the token it held goes too.
        if (stored) void endToken(stored.origin, stored.token);
        return;
      }
      setState(stored ? { status: "signed-in", signIn: signedIn(stored, current) } : signedOut(null, false));
    },

    async signIn(origin, onCode) {
      if (state.status === "signed-in") void signOut();
      const attempt = advance();
      const isCurrent = () => attempt.id === generation;
      let token: string | null = null;
      try {
        const start = await startDeviceSignIn(origin, { fetch, signal: attempt.signal, now });
        if (!isCurrent()) throw new ServerError("cancelled");
        onCode({ userCode: start.userCode, approvalUrl: start.approvalUrl });
        const outcome = await waitForDeviceToken(origin, start, { fetch, signal: attempt.signal, now, sleep: options.sleep ?? sleep });
        // Held before the check, so a token that arrived for a superseded sign-in still has its session ended.
        if (outcome.kind === "token") token = outcome.token;
        if (!isCurrent()) throw new ServerError("cancelled");
        if (outcome.kind !== "token") return outcome.kind;
        const account = await readAccount(createServerClient({ origin, token: outcome.token, fetch, signal: attempt.signal }));
        const stored: StoredSignIn = { origin, token: outcome.token, userId: account.userId, email: account.email };
        await write(async () => {
          if (isCurrent()) await store.save(stored);
        });
        if (!isCurrent()) throw new ServerError("cancelled");
        setState({ status: "signed-in", signIn: signedIn(stored, attempt) });
        return "signed-in";
      } catch (error) {
        // A session the server made for a superseded sign-in, or one whose account the phone couldn't read, ends here.
        if (token !== null) void endToken(origin, token);
        if (!isCurrent() || (error instanceof ServerError && error.problem === "cancelled")) return "cancelled";
        throw error;
      }
    },

    cancelSignIn() {
      if (state.status === "signed-out") advance();
    },

    signOut,

    async retryForget() {
      await Promise.all([...unforgotten].map(([token, origin]) => forget(origin, token)));
    },
  };
}
