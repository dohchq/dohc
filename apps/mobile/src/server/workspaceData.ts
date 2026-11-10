import type { ServerProblemKind } from "@dohc/interface-words/account";
import type { AccountState, SignIn } from "./account";
import { requestGenerations, ServerError, shownProblem, type ServerClient } from "./client";
import { sleep } from "./deviceFlow";
import {
  earlierCursor, FEED_HOLD_MS, laterCursor, readChanges, readChats, readFiles, readPage, readStream, readThread,
  type ChatGroup, type ChatThread, type FeedAnswer, type FeedChanges, type GroupStream, type MissingChat, type PageRead, type Read, type WorkspaceFile,
} from "./workspaceReads";

// What the phone shows of one workspace, read from the server and kept fresh by the workspace's change feed.
//
// Each screen opens a view: the files, the chats, one chat's stream, one thread, or one page. A view shows what was
// read last while it reads again, so a refresh never blanks the screen. Its reads replace each other, and only the
// latest may land. Everything one store started aborts when it stops: when the person switches workspace, signs out,
// or another sign-in starts. A store that has stopped, or whose sign-in has ended, sets nothing, so a slow answer for
// one workspace can never paint another.
//
// The feed starts from the oldest cursor among the reads the store shows, so it misses no change made after any of
// them. A read that answers an older cursor than the feed's moves the feed back to it, but no further than where the
// feed was when the read started: a change reported before then is in the read's answer. On a change, only the views it
// can touch read again; a view no screen has open is marked stale and reads when one opens it. `replace` drops every
// view no screen has open and reads the open ones again. The feed stops in the background, and backs off on errors up
// to FEED_RETRY_MAX_MS.

export type ReadProblem = ServerProblemKind | "restoring";

export interface ViewState<T> {
  readonly value: T | null;
  /** A read is on its way. The value it will replace stays shown. */
  readonly loading: boolean;
  /** Why the latest read failed, until one succeeds. */
  readonly problem: ReadProblem | null;
  /** How many reads have failed, so each failure is reported once. */
  readonly failures: number;
}

/** What the store last read of the workspace's listings, for telling which views a change can touch. */
export interface Known {
  readonly files: readonly WorkspaceFile[] | null;
  readonly chats: readonly ChatGroup[] | null;
}

export interface View<T> {
  readonly id: string;
  read(client: ServerClient, workspaceId: string, signal: AbortSignal): Promise<Read<T>>;
  /** Whether `changes` can touch what the view shows now, `value`. */
  affectedBy(changes: FeedChanges, known: Known, value: T | null): boolean;
}

export const views = {
  files: { id: "files", read: readFiles, affectedBy: changes => changes.files !== undefined } satisfies View<readonly WorkspaceFile[]>,
  chats: { id: "chats", read: readChats, affectedBy: changes => changes.chats !== undefined } satisfies View<readonly ChatGroup[]>,

  /** A chat's stream: a change to one of its threads, or to a thread the store can't place in a chat yet. */
  stream(groupId: string): View<GroupStream | MissingChat> {
    return {
      id: `stream:${groupId}`,
      read: (client, workspaceId, signal) => readStream(client, workspaceId, groupId, signal),
      affectedBy(changes, known, value) {
        if (changes.chats === undefined) return false;
        if (changes.chats.length === 0 || known.chats === null) return true;
        return changes.chats.some(threadId => (value?.kind === "stream" && value.items.some(item => item.message.threadId === threadId)) ||
          !known.chats?.some(group => group.id !== groupId && group.threadIds.includes(threadId)));
      },
    };
  },

  thread(threadId: string): View<ChatThread | MissingChat> {
    return {
      id: `thread:${threadId}`,
      read: (client, workspaceId, signal) => readThread(client, workspaceId, threadId, signal),
      affectedBy: changes => changes.chats !== undefined && (changes.chats.length === 0 || changes.chats.includes(threadId)),
    };
  },

  /** A page: a change to the object at its path, or to any file while the store doesn't know which object that is. */
  page(path: string): View<PageRead> {
    return {
      id: `page:${path}`,
      read: (client, workspaceId, signal) => readPage(client, workspaceId, path, signal),
      affectedBy(changes, known) {
        if (changes.pages === undefined && changes.files === undefined) return false;
        const objectId = known.files?.find(file => file.path === path)?.objectId;
        return objectId === undefined || [...changes.pages ?? [], ...changes.files ?? []].includes(objectId);
      },
    };
  },
};

// --- the cache ----------------------------------------------------------------------------------------------------

export interface Cached {
  readonly view: View<unknown>;
  readonly value: unknown;
  readonly cursor: string;
  /** A change the feed reported may have touched it since. */
  readonly stale: boolean;
}

/** Views read for each server, account and workspace, in memory. It empties whenever the sign-in changes or ends. */
export interface ReadCache {
  entries(scope: string): readonly Cached[];
  get(scope: string, viewId: string): Cached | undefined;
  set(scope: string, cached: Cached): void;
  drop(scope: string): void;
  clear(): void;
  /** Empties the cache each time the account's sign-in changes: sign-out, a 401, or a new sign-in. */
  follow(account: { state(): AccountState; subscribe(listener: () => void): () => void }): () => void;
}

export const cacheScope = (signIn: Pick<SignIn, "origin" | "userId">, workspaceId: string) =>
  JSON.stringify([signIn.origin, signIn.userId, workspaceId]);

export function createReadCache(): ReadCache {
  const scopes = new Map<string, Map<string, Cached>>();
  const cache: ReadCache = {
    entries: scope => [...scopes.get(scope)?.values() ?? []],
    get: (scope, viewId) => scopes.get(scope)?.get(viewId),
    set(scope, cached) {
      const views = scopes.get(scope) ?? new Map<string, Cached>();
      scopes.set(scope, views);
      views.set(cached.view.id, cached);
    },
    drop: scope => void scopes.delete(scope),
    clear: () => scopes.clear(),
    follow(account) {
      const signInOf = (state: AccountState) => state.status === "signed-in" ? state.signIn : null;
      let serving = signInOf(account.state());
      return account.subscribe(() => {
        const next = signInOf(account.state());
        if (next === serving) return;
        serving = next;
        cache.clear();
      });
    },
  };
  return cache;
}

// --- one workspace ------------------------------------------------------------------------------------------------

export interface WorkspaceData {
  readonly workspaceId: string;
  state<T>(view: View<T>): ViewState<T>;
  /** Opens the view while any listener stays: it reads unless it already shows a fresh value. */
  subscribe(view: View<unknown>, listener: () => void): () => void;
  retry(view: View<unknown>): void;
  /** Starts the feed, or starts it again after `pause`. */
  resume(): void;
  /** Stops the feed until `resume`, as when the app goes to the background. */
  pause(): void;
  /** Ends everything this store started. */
  stop(): void;
}

export const FEED_RETRY_MS = 1000;
export const FEED_RETRY_MAX_MS = 30_000;

interface Entry {
  readonly view: View<unknown>;
  state: ViewState<unknown>;
  readonly listeners: Set<() => void>;
  stale: boolean;
  readonly reads: ReturnType<typeof requestGenerations>;
}

function readProblem(error: unknown): ReadProblem | null {
  return error instanceof ServerError && error.code === "restore-in-progress" ? "restoring" : shownProblem(error);
}

export function createWorkspaceData(options: {
  readonly signIn: Pick<SignIn, "client" | "isCurrent" | "origin" | "userId">;
  readonly workspaceId: string;
  readonly cache: ReadCache;
  readonly holdMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): WorkspaceData {
  const { signIn, workspaceId, cache } = options;
  const holdMs = options.holdMs ?? FEED_HOLD_MS;
  const wait = options.sleep ?? sleep;
  const scope = cacheScope(signIn, workspaceId);
  const everything = new AbortController();
  const entries = new Map<string, Entry>();
  let stopped = false;
  let running = false;
  let feed: AbortController | null = null;
  // Where the feed reads from next: the oldest cursor among what the store shows.
  let cursor: string | null = null;
  for (const cached of cache.entries(scope)) {
    entries.set(cached.view.id, {
      view: cached.view, state: { value: cached.value, loading: false, problem: null, failures: 0 },
      listeners: new Set(), stale: cached.stale, reads: requestGenerations(),
    });
    cursor = cursor === null ? cached.cursor : earlierCursor(cursor, cached.cursor);
  }

  const live = () => !stopped && signIn.isCurrent();

  function entry(view: View<unknown>): Entry {
    let found = entries.get(view.id);
    if (!found) {
      found = { view, state: { value: null, loading: false, problem: null, failures: 0 }, listeners: new Set(), stale: false, reads: requestGenerations() };
      entries.set(view.id, found);
    }
    return found;
  }

  function set(target: Entry, state: ViewState<unknown>) {
    target.state = state;
    for (const listener of target.listeners) listener();
  }

  function read(target: Entry) {
    const request = target.reads.next();
    const from = cursor;
    set(target, { ...target.state, loading: true });
    target.view.read(signIn.client, workspaceId, everything.signal).then(
      answer => {
        if (!live() || !target.reads.isLatest(request)) return;
        target.stale = false;
        cache.set(scope, { view: target.view, value: answer.value, cursor: answer.cursor, stale: false });
        set(target, { value: answer.value, loading: false, problem: null, failures: target.state.failures });
        follow(from === null ? answer.cursor : laterCursor(answer.cursor, from));
      },
      (error: unknown) => {
        const problem = readProblem(error);
        if (!live() || !target.reads.isLatest(request) || problem === null) return;
        set(target, { ...target.state, loading: false, problem, failures: target.state.failures + 1 });
      },
    );
  }

  /** Starts the feed from a read's cursor, or moves it back to one older than its own. */
  function follow(readCursor: string) {
    if (cursor === null) {
      cursor = readCursor;
      startFeed();
      return;
    }
    const earlier = earlierCursor(cursor, readCursor);
    if (earlier === cursor) return;
    cursor = earlier;
    stopFeed();
    startFeed();
  }

  function startFeed() {
    if (!running || feed !== null || cursor === null || !live()) return;
    const own = new AbortController();
    feed = own;
    void listen(own.signal).finally(() => {
      if (feed === own) feed = null;
    });
  }

  function stopFeed() {
    feed?.abort();
    feed = null;
  }

  async function listen(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted && live() && cursor !== null) {
      let answer: FeedAnswer;
      try {
        answer = await readChanges(signIn.client, workspaceId, cursor, { holdMs, signal });
      } catch (error) {
        // A 401 has ended the sign-in, and a cancelled request belongs to a feed that has stopped.
        if (signal.aborted || !live() || (error instanceof ServerError && (error.problem === "signed-out" || error.problem === "cancelled"))) return;
        failures += 1;
        try {
          await wait(Math.min(FEED_RETRY_MS * 2 ** (failures - 1), FEED_RETRY_MAX_MS), signal);
        } catch {
          return;
        }
        continue;
      }
      failures = 0;
      if (signal.aborted || !live()) return;
      cursor = answer.cursor;
      apply(answer);
    }
  }

  /** Drops the answer of a read in flight for a view no screen has open: it may predate the change. */
  function forget(target: Entry) {
    target.reads.next();
    if (target.state.loading) set(target, { ...target.state, loading: false });
  }

  function apply(answer: FeedAnswer) {
    if (answer.replace) {
      cache.drop(scope);
      for (const [id, target] of entries) {
        if (target.listeners.size > 0) {
          read(target);
          continue;
        }
        forget(target);
        entries.delete(id);
      }
      return;
    }
    const known: Known = {
      files: entries.get(views.files.id)?.state.value as readonly WorkspaceFile[] | null ?? null,
      chats: entries.get(views.chats.id)?.state.value as readonly ChatGroup[] | null ?? null,
    };
    for (const target of entries.values()) {
      if (!target.view.affectedBy(answer.changed, known, target.state.value)) continue;
      if (target.listeners.size > 0) {
        read(target);
        continue;
      }
      forget(target);
      target.stale = true;
      const cached = cache.get(scope, target.view.id);
      if (cached) cache.set(scope, { ...cached, stale: true });
    }
  }

  return {
    workspaceId,
    state: <T>(view: View<T>) => entry(view).state as ViewState<T>,
    subscribe(view, listener) {
      const target = entry(view);
      target.listeners.add(listener);
      if (target.listeners.size === 1 && live() && !target.state.loading && (target.state.value === null || target.stale)) read(target);
      return () => void target.listeners.delete(listener);
    },
    retry(view) {
      const target = entry(view);
      if (live() && !target.state.loading) read(target);
    },
    resume() {
      running = true;
      startFeed();
    },
    pause() {
      running = false;
      stopFeed();
    },
    stop() {
      stopped = true;
      running = false;
      stopFeed();
      everything.abort();
    },
  };
}
