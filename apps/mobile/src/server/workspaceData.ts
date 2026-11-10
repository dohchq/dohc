import type { ServerProblemKind } from "@dohc/interface-words/account";
import type { AccountState, SignIn } from "./account";
import { accountWorkspace, each } from "./api";
import type { CacheFiles, SavedView } from "./cacheFiles";
import { requestGenerations, ServerError, shownProblem, type ServerClient } from "./client";
import { sleep } from "./deviceFlow";
import {
  earlierCursor, FEED_HOLD_MS, isCursor, laterCursor, readChanges, readChats, readFiles, readPage, readStream, readThread,
  type ChatGroup, type ChatThread, type FeedAnswer, type FeedChanges, type GroupStream, type MissingChat, type PageRead, type Read, type WorkspaceFile,
} from "./workspaceReads";
import type { SavedList } from "./workspaceList";

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
// to FEED_RETRY_MAX_MS. After FEED_FAILURES_SHOWN failures in a row, or once its wait reaches that cap, the store shows
// the feed's failure, so what's on screen never goes stale without a sign. A feed answer takes it back. Try again, and
// a return from the background, start the feed again at once, counting failures from none.
//
// A 404 from the feed, or from a read whose answer still counts, means the workspace may be gone from this phone:
// hidden from it on another device, no longer the account's, or no longer readable on the server. The store then drops
// its cache, stops, and shows every view as a failed read, and says so through `onGone`, so the account reads its
// workspace list again to decide. Try again on a store that has gone asks, through `reopen`, for a new one. A 503 is
// not this: it's a failed read or feed failure like any other.

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

/** Whether the feed is failing: why, and how many times the store has shown that it is, so each is reported once. */
export interface FeedState {
  readonly problem: ReadProblem | null;
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
  /** What the view shows after a read, from what it showed before and what the read answered. */
  carry?(previous: T | null, next: T): T;
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

  /**
   * A page: a change to the object at its path, or to any file while the store doesn't know which object that is. A
   * page that goes keeps the last text this store read of it.
   */
  page(path: string): View<PageRead> {
    return {
      id: `page:${path}`,
      read: (client, workspaceId, signal) => readPage(client, workspaceId, path, signal),
      carry(previous, next) {
        if (next.kind !== "missing") return next;
        const last = previous?.kind === "page" ? previous.markdown : previous?.kind === "missing" ? previous.last : undefined;
        return last === undefined ? next : { kind: "missing", last };
      },
      // Any file change can put another object at the page's path: one deleted and another made there. The listing that
      // would say so may not be read yet, so any file change reads the page again. A live edit, which changes no file,
      // reads it again when it's to the object at its path, or to any page while the store doesn't know which that is.
      affectedBy(changes, known) {
        if (changes.files !== undefined) return true;
        if (changes.pages === undefined) return false;
        const objectId = known.files?.find(file => file.path === path)?.objectId;
        return objectId === undefined || changes.pages.includes(objectId);
      },
    };
  },
};

/** The view a saved view's id names, or null for an id this build doesn't know. */
export function viewOf(id: string): View<unknown> | null {
  if (id === views.files.id) return views.files;
  if (id === views.chats.id) return views.chats;
  const [kind, ...rest] = id.split(":");
  const key = rest.join(":");
  if (key === "") return null;
  if (kind === "stream") return views.stream(key);
  if (kind === "thread") return views.thread(key);
  if (kind === "page") return views.page(key);
  return null;
}

// --- the cache ----------------------------------------------------------------------------------------------------

export interface Cached {
  readonly view: View<unknown>;
  readonly value: unknown;
  readonly cursor: string;
  /** A change the feed reported may have touched it since. */
  readonly stale: boolean;
}

/**
 * Views read for each server, account and workspace, in memory and, given `files`, on disk (cacheFiles.ts), with each
 * account's workspace list on disk. It empties whenever the sign-in changes or ends, on disk too. Each change is saved
 * soon after; dropping a scope deletes its file.
 */
export interface ReadCache {
  entries(scope: string): readonly Cached[];
  get(scope: string, viewId: string): Cached | undefined;
  set(scope: string, cached: Cached): void;
  drop(scope: string): void;
  clear(): void;
  /**
   * Reads the scope's saved views into memory, unless a drop or clear overtakes the read. Null when there is nothing
   * to read: the scope already has views in memory, which are newer, or the cache keeps nothing on disk.
   */
  restore(scope: string): Promise<void> | null;
  /** The sign-in's saved workspace list, or null when the cache keeps nothing on disk. */
  savedList(signIn: Pick<SignIn, "origin" | "userId">): SavedList | null;
  /** Saves now what waits to be saved, as when the app goes to the background. */
  flush(): void;
  /**
   * Empties the cache each time the account's sign-in changes: sign-out, a 401, or a new sign-in. The saved sign-in
   * read at launch keeps it, and a launch with none empties it.
   */
  follow(account: { state(): AccountState; subscribe(listener: () => void): () => void }): () => void;
}

export const cacheScope = (signIn: Pick<SignIn, "origin" | "userId">, workspaceId: string) =>
  JSON.stringify([signIn.origin, signIn.userId, workspaceId]);

/** The scope of an account's workspace list. */
const listScope = (signIn: Pick<SignIn, "origin" | "userId">) => JSON.stringify([signIn.origin, signIn.userId]);

export function createReadCache(files?: CacheFiles): ReadCache {
  const scopes = new Map<string, Map<string, Cached>>();
  // A drop moves its scope's generation on, and a clear every scope's, so a restore that a delete overtakes adds nothing.
  let epoch = 0;
  const drops = new Map<string, number>();
  const generation = (scope: string) => `${epoch}.${drops.get(scope) ?? 0}`;
  const restoring = new Set<string>();
  function forget(scope: string) {
    drops.set(scope, (drops.get(scope) ?? 0) + 1);
    scopes.delete(scope);
  }

  // Listings first, so a scope over its cap keeps Home and Chats, then the views set most recently.
  const saved = (scope: string): readonly SavedView[] => [...scopes.get(scope)?.values() ?? []]
    .reverse()
    .sort((a, b) => Number(isListing(b.view)) - Number(isListing(a.view)))
    .map(cached => ({ id: cached.view.id, value: cached.value, cursor: cached.cursor, stale: cached.stale }));
  const cache: ReadCache = {
    entries: scope => [...scopes.get(scope)?.values() ?? []],
    get: (scope, viewId) => scopes.get(scope)?.get(viewId),
    set(scope, cached) {
      const views = scopes.get(scope) ?? new Map<string, Cached>();
      scopes.set(scope, views);
      views.delete(cached.view.id);
      views.set(cached.view.id, cached);
      files?.write(scope, () => saved(scope));
    },
    drop(scope) {
      forget(scope);
      void files?.remove(scope);
    },
    clear() {
      epoch += 1;
      scopes.clear();
      void files?.removeAll();
    },
    restore(scope) {
      if (!files || scopes.has(scope)) return null;
      const expected = generation(scope);
      restoring.add(scope);
      return files.read(scope).catch(() => []).then(found => {
        restoring.delete(scope);
        // A delete since the read began wins, and views read into memory meanwhile are newer.
        if (generation(scope) !== expected || scopes.has(scope)) return;
        const views = new Map<string, Cached>();
        for (const item of found) {
          const view = viewOf(item.id);
          if (view && isCursor(item.cursor)) views.set(view.id, { view, value: item.value, cursor: item.cursor, stale: item.stale });
        }
        if (views.size > 0) scopes.set(scope, views);
      });
    },
    savedList(signIn) {
      if (!files) return null;
      const scope = listScope(signIn);
      return {
        load() {
          const expected = epoch;
          return files.readList(scope).then(found => epoch === expected ? each(found, accountWorkspace) : null);
        },
        // The list from the server, or one this phone changed, decides which workspaces the cache keeps: only those the
        // phone can open.
        listed(workspaces) {
          void files.writeList(scope, workspaces);
          const kept = new Set(workspaces.filter(entry => entry.showOnPhone && entry.canOpen).map(entry => cacheScope(signIn, entry.workspaceId)));
          for (const known of new Set([...scopes.keys(), ...restoring])) if (!kept.has(known)) forget(known);
          void files.keep([...kept]);
        },
      };
    },
    flush: () => void files?.flush(),
    follow(account) {
      const signInOf = (state: AccountState) => state.status === "signed-in" ? state.signIn : null;
      let serving = account.state();
      return account.subscribe(() => {
        const last = serving;
        const next = account.state();
        serving = next;
        if (last.status === "loading") {
          if (next.status === "signed-out") cache.clear();
          return;
        }
        if (signInOf(next) !== signInOf(last)) cache.clear();
      });
    },
  };
  return cache;
}

const isListing = (view: View<unknown>) => view.id === views.files.id || view.id === views.chats.id;

// --- one workspace ------------------------------------------------------------------------------------------------

export interface WorkspaceData {
  readonly workspaceId: string;
  /** This store's number, different for each one made, so a screen can start afresh with a new store. */
  readonly instance: number;
  state<T>(view: View<T>): ViewState<T>;
  /** Opens the view while any listener stays: it reads unless it already shows a fresh value. */
  subscribe(view: View<unknown>, listener: () => void): () => void;
  retry(view: View<unknown>): void;
  feed(): FeedState;
  subscribeFeed(listener: () => void): () => void;
  /** Starts the feed again at once, with its backoff from the start. */
  retryFeed(): void;
  /** Starts the feed, or starts it again after `pause`. */
  resume(): void;
  /** Stops the feed until `resume`, as when the app goes to the background. */
  pause(): void;
  /** Ends everything this store started. */
  stop(): void;
}

export const FEED_RETRY_MS = 1000;
export const FEED_RETRY_MAX_MS = 30_000;
export const FEED_FAILURES_SHOWN = 3;

let instances = 0;

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
  /** The server answered 404 for the workspace: the store has stopped and cleared. */
  readonly onGone?: () => void;
  /** Try again on a store that has gone: the account opens the workspace in a new store. */
  readonly reopen?: () => void;
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
  let feedState: FeedState = { problem: null, failures: 0 };
  const feedListeners = new Set<() => void>();
  function setFeed(next: FeedState) {
    feedState = next;
    for (const listener of feedListeners) listener();
  }
  function seed(found: readonly Cached[]) {
    for (const cached of found) {
      const target = entries.get(cached.view.id);
      if (target) {
        target.state = { ...target.state, value: cached.value };
        target.stale = cached.stale;
      } else {
        entries.set(cached.view.id, {
          view: cached.view, state: { value: cached.value, loading: false, problem: null, failures: 0 },
          listeners: new Set(), stale: cached.stale, reads: requestGenerations(),
        });
      }
      cursor = cursor === null ? cached.cursor : earlierCursor(cursor, cached.cursor);
    }
  }
  seed(cache.entries(scope));

  // A scope with nothing in memory, as at launch, reads its file first. Until it has, every view shows as loading and
  // nothing reads from the server; then each open view without a fresh value reads, and the feed starts from the
  // cursors of what the file held.
  let restoring = false;
  const restored = cache.restore(scope);
  if (restored) {
    restoring = true;
    void restored.then(() => {
      restoring = false;
      if (stopped) return;
      // What the cache holds now, so a drop or clear since the file was read wins here too.
      seed(cache.entries(scope));
      for (const target of entries.values()) {
        if (target.listeners.size > 0 && live() && (target.state.value === null || target.stale)) read(target);
        else if (target.state.loading) set(target, { ...target.state, loading: false });
      }
      startFeed();
    });
  }

  const live = () => !stopped && signIn.isCurrent();
  const isGone = (error: unknown) => error instanceof ServerError && error.problem === "not-found";
  let hasGone = false;

  /**
   * The workspace may no longer reach this phone: nothing of it stays, in the cache or on screen, and each view shows
   * a failed read. Its caller has checked that the answer still counts.
   */
  function gone() {
    hasGone = true;
    cache.drop(scope);
    store.stop();
    for (const target of entries.values()) set(target, { value: null, loading: false, problem: "refused", failures: target.state.failures + 1 });
    options.onGone?.();
  }

  function entry(view: View<unknown>): Entry {
    let found = entries.get(view.id);
    if (!found) {
      // A view first opened after the workspace has gone can't read, so it shows the same failed read and Try again.
      const state: ViewState<unknown> = hasGone
        ? { value: null, loading: false, problem: "refused", failures: 1 }
        : { value: null, loading: restoring, problem: null, failures: 0 };
      found = { view, state, listeners: new Set(), stale: false, reads: requestGenerations() };
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
        const value = target.view.carry ? target.view.carry(target.state.value, answer.value) : answer.value;
        cache.set(scope, { view: target.view, value, cursor: answer.cursor, stale: false });
        set(target, { value, loading: false, problem: null, failures: target.state.failures });
        follow(from === null ? answer.cursor : laterCursor(answer.cursor, from));
      },
      (error: unknown) => {
        // An answer that no longer counts says nothing, not even that the workspace has gone.
        if (!live() || !target.reads.isLatest(request)) return;
        if (isGone(error)) return gone();
        const problem = readProblem(error);
        if (problem === null) return;
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

  // Each run of the feed counts its own failures, so one started again begins from none.
  async function listen(signal: AbortSignal) {
    let failures = 0;
    let shown = false;
    while (!signal.aborted && live() && cursor !== null) {
      let answer: FeedAnswer;
      try {
        answer = await readChanges(signIn.client, workspaceId, cursor, { holdMs, signal });
      } catch (error) {
        // A request of a feed that has stopped, or been started again, says nothing, not even that the workspace has
        // gone. A 401 has ended the sign-in.
        if (signal.aborted || !live() || (error instanceof ServerError && (error.problem === "signed-out" || error.problem === "cancelled"))) return;
        if (isGone(error)) return gone();
        failures += 1;
        const delay = Math.min(FEED_RETRY_MS * 2 ** (failures - 1), FEED_RETRY_MAX_MS);
        const problem = readProblem(error);
        if (problem !== null && !shown && (failures >= FEED_FAILURES_SHOWN || delay >= FEED_RETRY_MAX_MS)) {
          shown = true;
          setFeed({ problem, failures: feedState.failures + 1 });
        }
        try {
          await wait(delay, signal);
        } catch {
          return;
        }
        continue;
      }
      failures = 0;
      shown = false;
      if (signal.aborted || !live()) return;
      if (feedState.problem !== null) setFeed({ ...feedState, problem: null });
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

  const store: WorkspaceData = {
    workspaceId,
    instance: ++instances,
    state: <T>(view: View<T>) => entry(view).state as ViewState<T>,
    subscribe(view, listener) {
      const target = entry(view);
      target.listeners.add(listener);
      if (target.listeners.size === 1 && live() && !target.state.loading && (target.state.value === null || target.stale)) read(target);
      return () => void target.listeners.delete(listener);
    },
    retry(view) {
      if (hasGone) return options.reopen?.();
      const target = entry(view);
      if (live() && !target.state.loading) read(target);
    },
    feed: () => feedState,
    subscribeFeed(listener) {
      feedListeners.add(listener);
      return () => void feedListeners.delete(listener);
    },
    retryFeed() {
      if (hasGone) return options.reopen?.();
      stopFeed();
      startFeed();
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
  return store;
}
