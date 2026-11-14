import type { AgentThreadTool } from "./forwarding";
import {
  T3CodeError,
  listT3CodeProjects,
  listT3CodeThreads,
  openT3CodeSession,
  readT3CodeAddress,
  readT3CodeThread,
  sendToT3CodeThread,
  signInToT3Code,
  t3CodeThreadLink,
  type T3CodeProject,
  type T3CodeSession,
  type T3CodeThread,
  type T3CodeThreadState,
} from "./t3Code";
import { T3CodeSignInNotKept, type T3CodeSignInStore } from "./t3CodeSignInStore";

// dohc's one connection to T3 Code on this computer: the kept sign-in, and a
// session opened with it when a call needs one. A session ends on T3 Code's
// side when T3 Code restarts or the person revokes dohc there, so a call that
// fails drops the session and the next call opens another.

export interface T3CodeConnection extends AgentThreadTool {
  /** False when this computer cannot encrypt the sign-in, so dohc does not connect. */
  canKeep(): boolean;
  /** When dohc's sign-in runs out, or null when dohc has none. */
  signedInUntil(): Promise<number | null>;
  /**
   * Shows the person T3 Code's own page with `open`, and keeps the sign-in
   * they allow. Rejects when they decline, cancel, or do not answer in time,
   * and when this computer cannot encrypt the sign-in.
   */
  signIn(input: { open(url: string): void | Promise<void>; signal?: AbortSignal }): Promise<void>;
  projects(): Promise<T3CodeProject[]>;
  threads(input: {
    projectId: string;
    titleContains?: string;
    cursor?: number;
  }): Promise<{ threads: T3CodeThread[]; nextCursor: number | null }>;
  thread(threadId: string): Promise<T3CodeThreadState>;
  /** The link that opens a thread in T3 Code's own window. It needs no sign-in. */
  threadLink(threadId: string): Promise<string>;
  /**
   * Drops dohc's sign-in. T3 Code gives a client no way to revoke its own
   * entry, so that entry stays until the person revokes it in T3 Code.
   */
  forget(): Promise<void>;
}

export function createT3CodeConnection(dependencies: {
  /** T3 Code's own folder, `.t3` in the person's home, where it keeps the file that names its server. */
  home: string;
  store: T3CodeSignInStore;
  fetch?: typeof fetch;
}): T3CodeConnection {
  const { store } = dependencies;
  let opening: Promise<T3CodeSession> | null = null;
  // Each change to the kept sign-in: a new one saved, or the kept one dropped.
  // The count moves when a change starts, so a call made before it cannot
  // drop what it keeps. A session opens only after the changes before it end.
  let changes = 0;
  let changing: Promise<unknown> = Promise.resolve();

  const address = async () => {
    const found = await readT3CodeAddress(dependencies.home);
    if (found === null)
      throw new T3CodeError("not-running", "T3 Code is not running on this computer.");
    return found;
  };

  const drop = () => {
    const ended = opening;
    opening = null;
    void ended?.then(
      (session) => session.close(),
      () => undefined,
    );
  };

  const change = <T>(work: () => Promise<T>): Promise<T> => {
    changes += 1;
    drop();
    const done = changing.then(work, work);
    changing = done.catch(() => undefined);
    return done;
  };

  const open = async (): Promise<T3CodeSession> => {
    await changing;
    const signIn = await store.load();
    if (signIn === null) throw new T3CodeError("not-allowed", "dohc is not allowed in T3 Code.");
    const { origin } = await address();
    return openT3CodeSession({ origin, signIn, fetch: dependencies.fetch });
  };

  async function use<T>(call: (session: T3CodeSession) => Promise<T>): Promise<T> {
    const made = changes;
    const current = (opening ??= open());
    try {
      return await call(await current);
    } catch (error) {
      if (opening === current) drop();
      // T3 Code no longer takes this sign-in, so dohc keeps it no longer.
      if (error instanceof T3CodeError && error.problem === "not-allowed" && made === changes)
        await change(() => store.clear());
      throw error;
    }
  }

  return {
    forward: (input) => use((session) => sendToT3CodeThread(session, input)),
    canKeep: () => store.canKeep(),
    signedInUntil: async () => (await store.load())?.expiresAtMs ?? null,
    async signIn(input) {
      // Asked before the person is sent to T3 Code, not after they allow dohc.
      if (!store.canKeep()) throw new T3CodeSignInNotKept();
      const { origin } = await address();
      const signIn = await signInToT3Code({
        origin,
        open: input.open,
        signal: input.signal,
        fetch: dependencies.fetch,
      });
      await change(() => store.save(signIn));
    },
    projects: () => use(listT3CodeProjects),
    threads: (input) => use((session) => listT3CodeThreads(session, input)),
    thread: (threadId) => use((session) => readT3CodeThread(session, threadId)),
    threadLink: async (threadId) =>
      t3CodeThreadLink({ origin: (await address()).origin, threadId, fetch: dependencies.fetch }),
    forget: () => change(() => store.clear()),
  };
}
