import { endSession, listSessions, readAccount } from "./api";
import {
  createServerClient,
  ServerError,
  type Fetch,
  type ServerClient,
  type ServerProblem,
} from "./client";
import { sleep, startDeviceSignIn, waitForDeviceToken } from "./deviceFlow";
import { StoreError } from "./keptStore";
import type { PendingSignOuts } from "./pushRegistration";

// The phone's sign-in to one server, as the desktop's cloud login keeps its (apps/desktop/src/workspaces/cloudLogin.ts).
//
// A sign-in generation changes, synchronously, when the person signs out, when the server ends the session (a 401),
// and when a sign-in starts, which supersedes any earlier one. Changing the account or the server goes through
// sign-out, so it changes the generation too. A change aborts every request of the generation before it. Anything
// that would update state, the screen, the token store or a cache, checks its generation first, and gives up once it
// has moved on.

/** What the token store keeps for this phone: the server, the session token, and whose it is. */
export interface StoredSignIn {
  readonly origin: string;
  readonly token: string;
  readonly userId: string;
  readonly email: string;
  /** The account's name, which the server gives the phone's chat writes. */
  readonly name: string;
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
  readonly name: string;
  readonly client: ServerClient;
  /** False once this sign-in has ended. Check it before applying anything one of its requests answered. */
  isCurrent(): boolean;
}

export type AccountState =
  | { readonly status: "loading" }
  | { readonly status: "unreadable" }
  /**
   * `origin` is the last server, to sign in to again; `ended` when the server ended the session. `forgetFailed` while
   * a token this phone signed out of is still in the store, because deleting it failed. `pendingSignOut` while a
   * Sign out waits for the server to end the session, and `failed` once that has failed.
   */
  | {
      readonly status: "signed-out";
      readonly origin: string | null;
      readonly ended: boolean;
      readonly forgetFailed: boolean;
      readonly pendingSignOut: "running" | "failed" | null;
    }
  | { readonly status: "signed-in"; readonly signIn: SignIn };

export type SignInOutcome = "signed-in" | "denied" | "expired" | "cancelled";

export interface Account {
  state(): AccountState;
  subscribe(listener: () => void): () => void;
  /** Reads the saved sign-in at launch, and again after `unreadable`. */
  restore(): Promise<void>;
  /**
   * Signs in to `origin` through the device flow, superseding any sign-in in progress. `onCode` gets the code and the
   * approval page while the sign-in is still current. Rejects with a ServerError when the server can't be used, and
   * at once on a signed-in phone, which signs out first through Settings, where Sign out says what it deletes.
   */
  signIn(
    origin: string,
    onCode: (code: { readonly userCode: string; readonly approvalUrl: string }) => void,
  ): Promise<SignInOutcome>;
  /** Ends a sign-in in progress. A completed sign-in stays. */
  cancelSignIn(): void;
  /**
   * Signs the phone out, ending everything the sign-in started, also after the server ended the session. With
   * `onSignOut`, the sign-in ends when the hook calls `leave`; without it, at once. Then the server ends the session,
   * and only then is the token deleted: a failed delete shows as `forgetFailed`. It rejects when the hook rejects
   * before `leave`, and the phone stays signed in with its token; and when the server didn't end the session, and the
   * Sign out stays pending until this is called again.
   */
  signOut(): Promise<void>;
  retryForget(): Promise<void>;
}

const REVOKE_TIMEOUT_MS = 5000;

const isProblem = (error: unknown, ...problems: readonly ServerProblem[]) =>
  error instanceof ServerError && problems.includes(error.problem);

export function createAccount(options: {
  readonly store: SignInStore;
  readonly fetch: Fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Sign out's own cleanup of `ending`, the account it signs out, or null after a 401. It calls `leave`, which ends the
   * sign-in and deletes the token, once its cleanup can't be lost. Only Sign out runs it: a 401 never does.
   */
  readonly onSignOut?: (
    leave: () => Promise<void>,
    ending: Pick<SignIn, "origin" | "userId"> | null,
  ) => Promise<void>;
  readonly pendingSignOuts?: PendingSignOuts;
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
  let unrevoked: StoredSignIn | null = null;
  let revokeFailed = false;

  function setState(next: AccountState) {
    state = next;
    for (const listener of listeners) listener();
  }

  function signedOut(
    origin: string | null,
    ended: boolean,
  ): Extract<AccountState, { status: "signed-out" }> {
    return {
      status: "signed-out",
      origin,
      ended,
      forgetFailed: unforgotten.size > 0,
      pendingSignOut: unrevoked === null ? null : revokeFailed ? "failed" : "running",
    };
  }

  function showSignedOut() {
    const shown = state;
    if (shown.status !== "signed-out") return;
    const next = signedOut(shown.origin, shown.ended);
    if (next.forgetFailed !== shown.forgetFailed || next.pendingSignOut !== shown.pendingSignOut)
      setState(next);
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
    showSignedOut();
  }

  async function revoke(origin: string, token: string): Promise<void> {
    const client = createServerClient({
      origin,
      token,
      fetch,
      signal: new AbortController().signal,
      timeoutMs: REVOKE_TIMEOUT_MS,
    });
    const sessions = await listSessions(client).catch((error: unknown) => {
      if (isProblem(error, "signed-out")) return null;
      throw error;
    });
    if (sessions === null) return;
    const mine = sessions.find((session) => session.current);
    if (!mine) throw new ServerError("invalid");
    await endSession(client, mine.sessionId).catch((error: unknown) => {
      if (!isProblem(error, "signed-out", "not-found")) throw error;
    });
  }

  /** Deletes the token, then ends its session on the server. Never rejects. */
  async function endToken(origin: string, token: string): Promise<void> {
    await forget(origin, token);
    await revoke(origin, token).catch(() => undefined);
  }

  function signedIn(
    stored: StoredSignIn,
    current: { readonly id: number; readonly signal: AbortSignal },
  ): SignIn {
    saved = stored;
    return {
      origin: stored.origin,
      userId: stored.userId,
      email: stored.email,
      name: stored.name,
      isCurrent: () => current.id === generation,
      client: createServerClient({
        origin: stored.origin,
        token: stored.token,
        fetch,
        signal: current.signal,
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

  // A sign-out in progress, shared only by calls that end the same sign-in. A call after a newer sign-in starts its
  // own, so a slow revoke for an old session never stands in for ending the new one.
  let signingOut: { readonly ending: StoredSignIn | null; readonly done: Promise<void> } | null =
    null;
  function signOut(): Promise<void> {
    const ending = saved ?? unrevoked;
    if (signingOut !== null && signingOut.ending === ending) return signingOut.done;
    const done: Promise<void> = endSignIn().finally(() => {
      if (signingOut?.done === done) signingOut = null;
    });
    signingOut = { ending, done };
    return done;
  }

  async function endSignIn(): Promise<void> {
    const ending = saved ?? unrevoked;
    const at = generation;
    const origin = ending?.origin ?? (state.status === "signed-out" ? state.origin : null);
    const marked = ending !== null && ending === saved;
    // A damaged kept.db takes no mark until the hook has deleted it, as the Sign out sheet warned.
    let unmarked = false;
    if (marked && options.pendingSignOuts)
      await options.pendingSignOuts.begin(ending).catch((error: unknown) => {
        if (!options.onSignOut || !(error instanceof StoreError && error.kind === "damaged"))
          throw error;
        unmarked = true;
      });
    let leaving: Promise<void> | null = null;
    const leaveOnce = async () => {
      // A 401 moved the generation while the hook ran: the server has ended the session, and what it holds now stays.
      if (generation !== at) {
        if (ending) await forget(ending.origin, ending.token);
        return;
      }
      if (unmarked && ending) await options.pendingSignOuts?.begin(ending);
      advance();
      saved = null;
      unrevoked = ending;
      revokeFailed = false;
      setState(signedOut(origin, false));
      if (!ending) return;
      try {
        await revoke(ending.origin, ending.token);
      } catch (error) {
        revokeFailed = true;
        showSignedOut();
        throw error;
      }
      unrevoked = null;
      showSignedOut();
      await forget(ending.origin, ending.token);
      if (!unforgotten.has(ending.token))
        await options.pendingSignOuts?.end(ending).catch(() => undefined);
    };
    const leave = () => (leaving ??= leaveOnce());
    const cleaning = options.onSignOut?.(leave, ending);
    if (cleaning) {
      try {
        await cleaning;
      } catch (error) {
        if (!leaving) {
          if (marked && saved === ending)
            await options.pendingSignOuts?.cancel(ending).catch(() => undefined);
          throw error;
        }
      }
    }
    await leave();
  }

  let restoring: Promise<void> | null = null;
  async function readSaved(): Promise<void> {
    const current = { id: generation, signal: controller.signal };
    const loaded = await write(() => store.load()).catch(() => null);
    // A token this phone already signed out of is never signed in with again.
    const stored = loaded && !unforgotten.has(loaded.token) ? loaded : null;
    const pending =
      stored && options.pendingSignOuts
        ? await options.pendingSignOuts.isPending(stored).catch(() => null)
        : false;
    if (current.id !== generation) {
      // Signed out while the store was read: the token it held goes too.
      if (stored) void endToken(stored.origin, stored.token);
      return;
    }
    if (pending === null) return setState({ status: "unreadable" });
    if (pending && stored) {
      unrevoked = stored;
      setState(signedOut(stored.origin, false));
      void signOut().catch(() => undefined);
      return;
    }
    setState(
      stored ? { status: "signed-in", signIn: signedIn(stored, current) } : signedOut(null, false),
    );
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    restore() {
      restoring ??= readSaved().finally(() => (restoring = null));
      return restoring;
    },

    async signIn(origin, onCode) {
      if (state.status === "signed-in") throw new Error("This phone is already signed in.");
      if (unrevoked) throw new Error("This phone is still signing out.");
      const attempt = advance();
      const isCurrent = () => attempt.id === generation;
      let token: string | null = null;
      try {
        const start = await startDeviceSignIn(origin, { fetch, signal: attempt.signal, now });
        if (!isCurrent()) throw new ServerError("cancelled");
        onCode({ userCode: start.userCode, approvalUrl: start.approvalUrl });
        const outcome = await waitForDeviceToken(origin, start, {
          fetch,
          signal: attempt.signal,
          now,
          sleep: options.sleep ?? sleep,
        });
        // Held before the check, so a token that arrived for a superseded sign-in still has its session ended.
        if (outcome.kind === "token") token = outcome.token;
        if (!isCurrent()) throw new ServerError("cancelled");
        if (outcome.kind !== "token") return outcome.kind;
        const account = await readAccount(
          createServerClient({ origin, token: outcome.token, fetch, signal: attempt.signal }),
        );
        const stored: StoredSignIn = {
          origin,
          token: outcome.token,
          userId: account.userId,
          email: account.email,
          name: account.name,
        };
        await options.pendingSignOuts?.end(stored).catch(() => undefined);
        await write(async () => {
          if (isCurrent()) await store.save(stored);
        });
        if (!isCurrent()) throw new ServerError("cancelled");
        setState({ status: "signed-in", signIn: signedIn(stored, attempt) });
        return "signed-in";
      } catch (error) {
        // A session the server made for a superseded sign-in, or one whose account the phone couldn't read, ends here.
        if (token !== null) void endToken(origin, token);
        if (!isCurrent() || (error instanceof ServerError && error.problem === "cancelled"))
          return "cancelled";
        throw error;
      }
    },

    cancelSignIn() {
      if (state.status === "signed-out" && !unrevoked) advance();
    },

    signOut,

    async retryForget() {
      await Promise.all([...unforgotten].map(([token, origin]) => forget(origin, token)));
    },
  };
}
