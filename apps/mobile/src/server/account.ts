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
// Writes to the token store run one at a time, in order, so a sign-out's delete always lands after a save it raced.

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
  /** `ended` when the server ended the session; `origin` is the last server, to sign in to again. */
  | { readonly status: "signed-out"; readonly origin: string | null; readonly ended: boolean }
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
  /** Ends this phone's session on the server, then deletes the token. The token goes even when the server can't be reached. */
  signOut(): Promise<void>;
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

  function setState(next: AccountState) {
    state = next;
    for (const listener of listeners) listener();
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

  /** Deletes the stored token, unless a newer sign-in has replaced it. */
  async function forget(token: string): Promise<void> {
    const stored = await store.load().catch(() => null);
    if (stored === null || stored.token === token) await store.clear();
  }

  /**
   * Revokes this token's own session through the sessions route. Failing is fine: the caller deletes it anyway. Each
   * request waits at most REVOKE_TIMEOUT_MS, since the token stays on the phone until this ends.
   */
  async function revoke(origin: string, token: string): Promise<void> {
    const client = createServerClient({ origin, token, fetch, signal: new AbortController().signal, timeoutMs: REVOKE_TIMEOUT_MS });
    const mine = (await listSessions(client)).find(session => session.current);
    if (mine) await endSession(client, mine.sessionId);
  }

  function endToken(origin: string, token: string): Promise<void> {
    return write(async () => {
      await revoke(origin, token).catch(() => undefined);
      await forget(token);
    });
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
          setState({ status: "signed-out", origin: stored.origin, ended: true });
          void write(() => forget(stored.token)).catch(() => undefined);
        },
      }),
    };
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async restore() {
      const current = { id: generation, signal: controller.signal };
      const stored = await write(() => store.load()).catch(() => null);
      if (current.id !== generation) return;
      setState(stored ? { status: "signed-in", signIn: signedIn(stored, current) } : { status: "signed-out", origin: null, ended: false });
    },

    async signIn(origin, onCode) {
      const ended = signOut();
      const attempt = advance();
      const isCurrent = () => attempt.id === generation;
      await ended;
      let token: string | null = null;
      try {
        const start = await startDeviceSignIn(origin, { fetch, signal: attempt.signal, now });
        if (!isCurrent()) return "cancelled";
        onCode({ userCode: start.userCode, approvalUrl: start.approvalUrl });
        const outcome = await waitForDeviceToken(origin, start, { fetch, signal: attempt.signal, now, sleep: options.sleep ?? sleep });
        if (!isCurrent()) return "cancelled";
        if (outcome.kind !== "token") return outcome.kind;
        token = outcome.token;
        const account = await readAccount(createServerClient({ origin, token, fetch, signal: attempt.signal }));
        const stored: StoredSignIn = { origin, token, userId: account.userId, email: account.email };
        await write(async () => {
          if (isCurrent()) await store.save(stored);
        });
        if (!isCurrent()) throw new ServerError("cancelled");
        setState({ status: "signed-in", signIn: signedIn(stored, attempt) });
        return "signed-in";
      } catch (error) {
        // A session the server made for a superseded sign-in, or one whose account the phone couldn't read, ends here.
        if (token !== null) void endToken(origin, token).catch(() => undefined);
        if (!isCurrent() || (error instanceof ServerError && error.problem === "cancelled")) return "cancelled";
        throw error;
      }
    },

    cancelSignIn() {
      if (state.status === "signed-out") advance();
    },

    signOut,
  };

  function signOut(): Promise<void> {
    const ending = saved;
    if (state.status !== "signed-in" || ending === null) return Promise.resolve();
    advance();
    saved = null;
    setState({ status: "signed-out", origin: ending.origin, ended: false });
    return endToken(ending.origin, ending.token);
  }
}
