import type { ServerProblemKind } from "@dohc/interface-words/account";
import type { AccountState, SignIn } from "./account";
import { accountWorkspace, each, selectOpenWorkspace, type WorkspaceRole } from "./api";
import type { CacheRows, SavedView } from "./cacheRows";
import { requestGenerations, ServerError, shownProblem, type ServerClient } from "./client";
import { sleep } from "./deviceFlow";
import { appOperations, type PhoneApp } from "./phoneApps";
import { collectionOperations, type PhoneCollection } from "./phoneCollections";
import {
  readDocumentCollections,
  type DocumentCollectionSummary,
} from "./phoneDocumentCollections";
import { readLane } from "./readLane";
import {
  earlierCursor,
  reachOf,
  FEED_HOLD_MS,
  isCursor,
  laterCursor,
  markThreadRead,
  readChanges,
  readChats,
  readFileChats,
  readFiles,
  readPage,
  readStream,
  readStreamLanes,
  readThread,
  type ChatGroup,
  type ChatMessage,
  type ChatThread,
  type FeedAnswer,
  type FeedChanges,
  type FileChatsRead,
  type GroupStream,
  type MissingChat,
  type PageRead,
  type Read,
  type StreamLanes,
  type WorkspaceFile,
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

export type ReadProblem = ServerProblemKind;

export interface ViewState<T> {
  readonly value: T | null;
  /** A read is on its way. The value it will replace stays shown. */
  readonly loading: boolean;
  /** Why the latest read failed, until one succeeds. */
  readonly problem: ReadProblem | null;
  /** How many reads have failed, so each failure is reported once. */
  readonly failures: number;
  readonly fromCache?: boolean;
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
  readonly ownerOnly?: true;
  read(
    client: ServerClient,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<Omit<Read<T>, "cursor"> & { readonly cursor: string | null }>;
  /** Whether `changes` can touch what the view shows now, `value`. */
  affectedBy(changes: FeedChanges, known: Known, value: T | null): boolean;
  /** What the view shows after a read, from what it showed before and what the read answered. */
  carry?(previous: T | null, next: T): T;
  shownAs?(value: T | null): string | null;
  /** The messages a value shows, so the outbox can tell which of its saved writes a read now shows. */
  messages?(value: T): readonly ChatMessage[];
}

export const views = {
  files: {
    id: "files",
    read: readFiles,
    affectedBy: (changes) => changes.files !== undefined,
  } satisfies View<readonly WorkspaceFile[]>,
  chats: {
    id: "chats",
    read: readChats,
    affectedBy: (changes) => changes.chats !== undefined,
  } satisfies View<readonly ChatGroup[]>,
  apps: {
    id: "apps",
    read: (client, workspaceId, signal) =>
      appOperations(client, workspaceId, signal)
        .list()
        .then((value) => ({ value, cursor: null })),
    affectedBy: () => false,
  } satisfies View<readonly PhoneApp[]>,
  collections: {
    id: "collections",
    read: (client, workspaceId, signal) =>
      collectionOperations(client, workspaceId, signal)
        .list()
        .then((value) => ({ value, cursor: null })),
    affectedBy: () => false,
  } satisfies View<readonly PhoneCollection[]>,
  documentCollections: {
    id: "documentCollections",
    ownerOnly: true,
    read: readDocumentCollections,
    affectedBy: (changes) => changes.files !== undefined,
  } satisfies View<readonly DocumentCollectionSummary[]>,

  /** A chat's stream: a change to one of its threads, or to a thread the store can't place in a chat yet. */
  stream(groupId: string): View<GroupStream | MissingChat> {
    return {
      id: `stream:${groupId}`,
      read: (client, workspaceId, signal) => readStream(client, workspaceId, groupId, signal),
      messages: (value) => (value.kind === "stream" ? value.items.map((item) => item.message) : []),
      affectedBy(changes, known, value) {
        if (changes.chats === undefined) return false;
        if (changes.chats.length === 0 || known.chats === null) return true;
        return changes.chats.some(
          (threadId) =>
            (value?.kind === "stream" &&
              value.items.some((item) => item.message.threadId === threadId)) ||
            !known.chats?.some(
              (group) => group.id !== groupId && group.threadIds.includes(threadId),
            ),
        );
      },
    };
  },

  /**
   * Which writes a chat's stream takes. Read only where writes are on. A change to one of its threads, or to a thread
   * the store can't place in a chat yet, reads it again, since that's where a chat's own changes show.
   */
  lanes(groupId: string): View<StreamLanes | MissingChat> {
    return {
      id: `lanes:${groupId}`,
      read: (client, workspaceId, signal) => readStreamLanes(client, workspaceId, groupId, signal),
      affectedBy(changes, known) {
        if (changes.chats === undefined) return false;
        const chats = known.chats;
        if (changes.chats.length === 0 || chats === null) return true;
        return changes.chats.some(
          (threadId) =>
            !chats.some((group) => group.id !== groupId && group.threadIds.includes(threadId)),
        );
      },
    };
  },

  thread(threadId: string): View<ChatThread | MissingChat> {
    return {
      id: `thread:${threadId}`,
      read: (client, workspaceId, signal) => readThread(client, workspaceId, threadId, signal),
      messages: (value) => (value.kind === "thread" ? value.messages : []),
      affectedBy: (changes) =>
        changes.chats !== undefined &&
        (changes.chats.length === 0 || changes.chats.includes(threadId)),
    };
  },

  fileChats(path: string): View<FileChatsRead> {
    return {
      id: `fileChats:${path}`,
      read: (client, workspaceId, signal) => readFileChats(client, workspaceId, path, signal),
      affectedBy: (changes) => changes.chats !== undefined || changes.files !== undefined,
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
        const last =
          previous?.kind === "page"
            ? previous.markdown
            : previous?.kind === "missing"
              ? previous.last
              : undefined;
        return last === undefined ? next : { kind: "missing", last };
      },
      shownAs(value) {
        if (value === null) return null;
        const text =
          value.kind === "page"
            ? value.markdown
            : value.kind === "missing"
              ? value.last
              : undefined;
        return text ?? `\u0000${value.kind}`;
      },
      // Any file change can put another object at the page's path: one deleted and another made there. The listing that
      // would say so may not be read yet, so any file change reads the page again. A live edit, which changes no file,
      // reads it again when it's to the object at its path, or to any page while the store doesn't know which that is.
      affectedBy(changes, known) {
        if (changes.files !== undefined) return true;
        if (changes.pages === undefined) return false;
        const objectId = known.files?.find((file) => file.path === path)?.objectId;
        return objectId === undefined || changes.pages.includes(objectId);
      },
    };
  },
};

/** The view a saved view's id names, or null for an id this build doesn't know. */
export function viewOf(id: string): View<unknown> | null {
  if (id === views.files.id) return views.files;
  if (id === views.chats.id) return views.chats;
  if (id === views.apps.id) return views.apps;
  if (id === views.collections.id) return views.collections;
  if (id === views.documentCollections.id) return views.documentCollections;
  const [kind, ...rest] = id.split(":");
  const key = rest.join(":");
  if (key === "") return null;
  if (kind === "stream") return views.stream(key);
  if (kind === "lanes") return views.lanes(key);
  if (kind === "thread") return views.thread(key);
  if (kind === "fileChats") return views.fileChats(key);
  if (kind === "page") return views.page(key);
  return null;
}

export interface Cached {
  readonly view: View<unknown>;
  readonly value: unknown;
  readonly cursor: string | null;
  /** A change the feed reported may have touched it since. */
  readonly stale: boolean;
  readonly prefetched?: boolean;
}

/**
 * Views read for each server, account and workspace, in memory and, given `files`, in cache.db (cacheRows.ts), with
 * each account's workspace list there too. It empties whenever the sign-in changes or ends, deleting cache.db. Each
 * change is saved soon after; dropping a scope deletes its row.
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
  preload(signIn: Pick<SignIn, "origin" | "userId">): void;
  /** The sign-in's saved workspace list, or null when the cache keeps nothing on disk. */
  savedList(signIn: Pick<SignIn, "origin" | "userId">): SavedList | null;
  /** Saves now what waits to be saved, as when the app goes to the background. */
  flush(): void;
  /**
   * Empties the cache each time the account's sign-in changes: sign-out, a 401, or a new sign-in. The saved sign-in
   * read at launch, or on Try again after it couldn't be read, keeps it, and a read that finds none empties it.
   */
  follow(account: {
    state(): AccountState;
    subscribe(listener: () => void): () => void;
  }): () => void;
}

/** Reads saved under one role never show under another: a joined workspace's scope names the role. */
export const cacheScope = (
  signIn: Pick<SignIn, "origin" | "userId">,
  workspaceId: string,
  role: WorkspaceRole = "owner",
) =>
  JSON.stringify(
    role === "owner"
      ? [signIn.origin, signIn.userId, workspaceId]
      : [signIn.origin, signIn.userId, workspaceId, role],
  );

const listScope = (signIn: Pick<SignIn, "origin" | "userId">) =>
  JSON.stringify([signIn.origin, signIn.userId]);

const choiceScope = (signIn: Pick<SignIn, "origin" | "userId">) =>
  JSON.stringify([signIn.origin, signIn.userId, "chosen"]);

export function createReadCache(files?: CacheRows): ReadCache {
  const scopes = new Map<string, Map<string, Cached>>();
  // A drop moves its scope's generation on, and a clear every scope's, so a restore that a delete overtakes adds nothing.
  let epoch = 0;
  const drops = new Map<string, number>();
  const generation = (scope: string) => `${epoch}.${drops.get(scope) ?? 0}`;
  // One restore per scope at a time: a second store for the scope waits on the first, so the scope stays tracked until
  // the only read of its file settles, and a list that drops it meanwhile moves its generation on.
  const restoring = new Map<string, Promise<void>>();
  const preloads = new Map<string, { readonly epoch: number; readonly read: Promise<unknown> }>();
  function forget(scope: string) {
    drops.set(scope, (drops.get(scope) ?? 0) + 1);
    scopes.delete(scope);
  }

  // Listings first, so a scope over its cap keeps Home and Chats, then the views set most recently.
  const saved = (scope: string): readonly SavedView[] =>
    [...(scopes.get(scope)?.values() ?? [])]
      .reverse()
      .sort((a, b) => Number(isListing(b.view)) - Number(isListing(a.view)))
      .map((cached) => ({
        id: cached.view.id,
        value: cached.value,
        cursor: cached.cursor,
        stale: cached.stale,
        prefetched: cached.prefetched,
      }));
  const cache: ReadCache = {
    entries: (scope) => [...(scopes.get(scope)?.values() ?? [])],
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
      preloads.clear();
      void files?.removeAll();
    },
    restore(scope) {
      if (!files || scopes.has(scope)) return null;
      const pending = restoring.get(scope);
      if (pending) return pending;
      const expected = generation(scope);
      const done = files
        .read(scope)
        .catch(() => [])
        .then((found) => {
          restoring.delete(scope);
          // A delete since the read began wins, and views read into memory meanwhile are newer.
          if (generation(scope) !== expected || scopes.has(scope)) return;
          const views = new Map<string, Cached>();
          for (const item of found) {
            const view = viewOf(item.id);
            if (view && (item.cursor === null || isCursor(item.cursor)))
              views.set(view.id, {
                view,
                value: item.value,
                cursor: item.cursor,
                stale: item.stale,
                prefetched: item.prefetched,
              });
          }
          if (views.size > 0) scopes.set(scope, views);
        });
      restoring.set(scope, done);
      return done;
    },
    preload(signIn) {
      if (!files) return;
      const expected = epoch;
      const listKey = listScope(signIn);
      const choiceKey = choiceScope(signIn);
      const listRead = files.readList(listKey);
      const choiceRead = files.readList(choiceKey);
      preloads.set(listKey, { epoch: expected, read: listRead });
      preloads.set(choiceKey, { epoch: expected, read: choiceRead });
      void Promise.all([listRead, choiceRead])
        .then(([foundList, foundChoice]) => {
          if (epoch !== expected) return;
          const workspaces = each(foundList, accountWorkspace);
          if (!workspaces) return;
          const chosen = typeof foundChoice === "string" ? foundChoice : null;
          const selected = selectOpenWorkspace(workspaces, chosen);
          if (selected) void cache.restore(cacheScope(signIn, selected.workspaceId, selected.role));
        })
        .catch(() => undefined);
    },
    savedList(signIn) {
      if (!files) return null;
      const scope = listScope(signIn);
      const readList = (key: string) => {
        const early = preloads.get(key);
        preloads.delete(key);
        return early?.epoch === epoch ? early.read : files.readList(key);
      };
      return {
        load() {
          const expected = epoch;
          return readList(scope).then((found) =>
            epoch === expected ? each(found, accountWorkspace) : null,
          );
        },
        // The list from the server, or one this phone changed, decides which workspaces the cache keeps: only those the
        // phone can open.
        listed(workspaces) {
          void files.writeList(scope, workspaces);
          const kept = new Set(
            workspaces
              .filter((entry) => entry.showOnPhone && entry.canOpen)
              .map((entry) => cacheScope(signIn, entry.workspaceId, entry.role)),
          );
          for (const known of new Set([...scopes.keys(), ...restoring.keys()]))
            if (!kept.has(known)) forget(known);
          void files.keep([...kept]);
        },
        loadChosen() {
          const expected = epoch;
          return readList(choiceScope(signIn)).then((found) =>
            epoch === expected && typeof found === "string" ? found : null,
          );
        },
        chose: (workspaceId) => void files.writeList(choiceScope(signIn), workspaceId),
      };
    },
    flush: () => void files?.flush(),
    follow(account) {
      const signInOf = (state: AccountState) =>
        state.status === "signed-in" ? state.signIn : null;
      let serving = account.state();
      return account.subscribe(() => {
        const last = serving;
        const next = account.state();
        serving = next;
        if (last.status === "loading" || last.status === "unreadable") {
          if (next.status === "signed-out") cache.clear();
          return;
        }
        if (signInOf(next) !== signInOf(last)) cache.clear();
      });
    },
  };
  return cache;
}

const isListing = (view: View<unknown>) =>
  [views.files, views.chats, views.apps, views.collections, views.documentCollections].some(
    (each) => each.id === view.id,
  );

export function cachedList<T>(
  cache: ReadCache,
  signIn: Pick<SignIn, "origin" | "userId">,
  workspaceId: string,
  view: View<T>,
  role: WorkspaceRole = "owner",
) {
  const scope = cacheScope(signIn, workspaceId, role);
  return {
    value: () => (cache.get(scope, view.id)?.value as T | undefined) ?? null,
    restored: cache.restore(scope) ?? Promise.resolve(),
    save: (value: T) => cache.set(scope, { view, value, cursor: null, stale: false }),
  };
}

export interface WorkspaceData {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  /** False once the store has stopped, as when the workspace opens afresh: answers for it no longer count. */
  isOpen(): boolean;
  /** The account joined this workspace rather than owns it, so the phone only reads it: it marks nothing read. */
  readonly joined: boolean;
  /** This store's number, different for each one made, so a screen can start afresh with a new store. */
  readonly instance: number;
  state<T>(view: View<T>): ViewState<T>;
  /** Opens the view while any listener stays: it reads unless it already shows a fresh value. */
  subscribe(view: View<unknown>, listener: () => void): () => void;
  /** Reads the view now, as a screen about to open it would, unless it shows a fresh value or a read is on its way. */
  prefetch(view: View<unknown>): void;
  /** Reads views in the background on the sign-in's polite read-ahead lane, yielding to any tap. */
  prefetchAhead(views: readonly View<unknown>[]): void;
  prefetchPages(paths: readonly string[], bucket?: string): void;
  retry(view: View<unknown>): void;
  /**
   * Reads the view now, in place of any read on its way, as a pull to refresh asks. Settles once this read answers,
   * whatever a later read does.
   */
  refresh(view: View<unknown>): Promise<void>;
  /** Marks a view stale (or drops it) and reads it again if a screen is subscribed. */
  invalidate(view: View<unknown>, drop?: boolean): void;
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
  /**
   * Marks the account's place in a thread at a message a screen shows. A mark the server took, or one on its way, is
   * not sent again; one that failed, including the server's "Couldn't send", says nothing, and the next showing sends
   * it again. A 404 that still counts means the workspace may be gone, as for a read. Resolves once the mark settles,
   * at once for one it doesn't send; it never rejects.
   */
  markRead(threadId: string, messageId: string): Promise<void>;
}

export const FEED_RETRY_MS = 1000;
export const FEED_RETRY_MAX_MS = 30_000;
export const FEED_FAILURES_SHOWN = 3;
export const PREFETCH_MAX = 10;

let instances = 0;

interface Entry {
  readonly view: View<unknown>;
  state: ViewState<unknown>;
  readonly listeners: Set<() => void>;
  stale: boolean;
  prefetched?: boolean;
  ahead?: { promote(): boolean } | null;
  readonly reads: ReturnType<typeof requestGenerations>;
}

export function createWorkspaceData(options: {
  readonly signIn: Pick<SignIn, "client" | "isCurrent" | "origin" | "userId">;
  readonly workspaceId: string;
  readonly role?: WorkspaceRole;
  readonly cache: ReadCache;
  readonly holdMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The server answered 404 for the workspace: the store has stopped and cleared. */
  readonly onGone?: () => void;
  /**
   * Try again on a store that has gone, and the feed's `replace` in a workspace the account joined: the account opens
   * the workspace in a new store.
   */
  readonly reopen?: () => void;
  /** A read from the server that still counts showed these messages. */
  readonly onMessages?: (messages: readonly ChatMessage[]) => void;
}): WorkspaceData {
  const { signIn, workspaceId, cache } = options;
  const holdMs = options.holdMs ?? FEED_HOLD_MS;
  const wait = options.sleep ?? sleep;
  const role = options.role ?? "owner";
  const scope = cacheScope(signIn, workspaceId, role);
  const lane = readLane(signIn);
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
    const reaches = new Set(
      found.flatMap((cached) => (cached.cursor ? [reachOf(cached.cursor)] : [])),
    );
    if (reaches.size > 1) {
      cache.drop(scope);
      return;
    }
    for (const cached of found) {
      if (cached.stale && cached.prefetched) continue;
      const target = entries.get(cached.view.id);
      if (target) {
        target.state = { ...target.state, value: cached.value, fromCache: true };
        target.stale = cached.stale;
        target.prefetched = cached.prefetched;
        shown(target);
      } else {
        entries.set(cached.view.id, {
          view: cached.view,
          state: {
            value: cached.value,
            loading: false,
            problem: null,
            failures: 0,
            fromCache: true,
          },
          listeners: new Set(),
          stale: cached.stale,
          prefetched: cached.prefetched,
          reads: requestGenerations(),
        });
      }
      if (cached.cursor !== null)
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
        if (
          target.listeners.size > 0 &&
          live() &&
          !(target.view.ownerOnly && role !== "owner") &&
          (target.state.value === null || target.stale)
        )
          void read(target);
        else if (target.state.loading) set(target, { ...target.state, loading: false });
      }
      startFeed();
      drain();
    });
  }

  const live = () => !stopped && signIn.isCurrent();
  // The message each thread's mark is on its way at, and the one the server last took.
  const sending = new Map<string, string>();
  const marked = new Map<string, string>();
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
    for (const target of entries.values())
      set(target, {
        value: null,
        loading: false,
        problem: "refused",
        failures: target.state.failures + 1,
      });
    options.onGone?.();
  }

  function entry(view: View<unknown>): Entry {
    let found = entries.get(view.id);
    if (!found) {
      const state: ViewState<unknown> = hasGone
        ? { value: null, loading: false, problem: "refused", failures: 1 }
        : { value: null, loading: restoring, problem: null, failures: 0 };
      found = { view, state, listeners: new Set(), stale: false, reads: requestGenerations() };
      entries.set(view.id, found);
    }
    return found;
  }

  const due = (target: Entry) =>
    live() &&
    !(target.view.ownerOnly && role !== "owner") &&
    !target.state.loading &&
    (target.state.value === null || target.stale);

  function set(target: Entry, state: ViewState<unknown>) {
    target.state = state;
    for (const listener of target.listeners) listener();
  }

  function shown(target: Entry) {
    if (!target.prefetched || target.listeners.size === 0 || target.state.value === null) return;
    target.prefetched = false;
    const cached = cache.get(scope, target.view.id);
    if (cached) cache.set(scope, { ...cached, prefetched: undefined });
  }

  function read(
    target: Entry,
    by:
      | "person"
      | "feed"
      | { readonly signal: AbortSignal; readonly promote: () => boolean } = "person",
  ): Promise<unknown> {
    if (target.view.ownerOnly && role !== "owner") return Promise.resolve();
    target.ahead = null;
    const request = target.reads.next();
    const from = cursor;
    const unseen = target.prefetched || target.state.value === null;
    const ahead = typeof by === "string" ? null : by;
    let isAhead = ahead !== null;
    if (!isAhead) set(target, { ...target.state, loading: true });
    const reading = ahead
      ? target.view.read(signIn.client, workspaceId, ahead.signal)
      : lane.screen(
          () => target.view.read(signIn.client, workspaceId, everything.signal),
          by === "person",
        );
    if (ahead) {
      target.ahead = {
        promote() {
          if (!isAhead || !target.reads.isLatest(request) || !ahead.promote()) return false;
          isAhead = false;
          target.ahead = null;
          set(target, { ...target.state, loading: true });
          return true;
        },
      };
    }
    return reading.then(
      (answer) => {
        if (target.reads.isLatest(request)) target.ahead = null;
        if (!live() || !target.reads.isLatest(request)) return;
        target.stale = false;
        const previous = unseen ? null : target.state.value;
        const value = target.view.carry ? target.view.carry(previous, answer.value) : answer.value;
        const shownAs = target.view.shownAs;
        target.prefetched =
          target.listeners.size === 0 &&
          shownAs !== undefined &&
          (unseen || shownAs(value) !== shownAs(previous));
        const saved = { view: target.view, value, cursor: answer.cursor, stale: false };
        cache.set(scope, { ...saved, prefetched: target.prefetched || undefined });
        set(target, { value, loading: false, problem: null, failures: target.state.failures });
        if (target.view.messages) options.onMessages?.(target.view.messages(value));
        if (answer.cursor !== null)
          follow(from === null ? answer.cursor : laterCursor(answer.cursor, from));
        return value;
      },
      (error: unknown) => {
        if (target.reads.isLatest(request)) target.ahead = null;
        // An answer that no longer counts says nothing, not even that the workspace has gone.
        if (!live() || !target.reads.isLatest(request)) return;
        if (isGone(error)) return gone();
        const problem = shownProblem(error);
        if (problem === null || isAhead) return;
        set(target, {
          ...target.state,
          loading: false,
          problem,
          failures: target.state.failures + 1,
        });
      },
    );
  }

  type QueuedAhead =
    | { readonly kind: "page"; readonly path: string; readonly bucket: string }
    | { readonly kind: "view"; readonly view: View<unknown> };
  let queued: QueuedAhead[] = [];
  const tried = new Set<string>();
  const buckets = new Map<string, { kept: number; reading: number }>();
  function drain() {
    let next = 0;
    while (next < queued.length && running && live() && !restoring && lane.free()) {
      const item = queued[next]!;
      if (item.kind === "view") {
        queued.splice(next, 1);
        const found = entries.get(item.view.id);
        if (
          found &&
          (found.listeners.size > 0 ||
            found.state.loading ||
            found.ahead ||
            (found.state.value !== null && !found.stale))
        )
          continue;
        const target = found ?? entry(item.view);
        void lane.ahead(everything.signal, async (signal, promote) => {
          await read(target, { signal, promote });
          if (
            signal.aborted &&
            !stopped &&
            live() &&
            target.listeners.size === 0 &&
            !target.state.loading &&
            (target.state.value === null || target.stale) &&
            !queued.some(
              (queuedItem) => queuedItem.kind === "view" && queuedItem.view.id === item.view.id,
            )
          )
            queued.push(item);
        });
        continue;
      }
      const { path, bucket } = item;
      const allowance = buckets.get(bucket) ?? { kept: 0, reading: 0 };
      buckets.set(bucket, allowance);
      if (allowance.kept < PREFETCH_MAX && allowance.kept + allowance.reading >= PREFETCH_MAX) {
        next += 1;
        continue;
      }
      queued.splice(next, 1);
      if (allowance.kept >= PREFETCH_MAX) continue;
      const view = views.page(path);
      const found = entries.get(view.id);
      if (
        found &&
        (found.listeners.size > 0 ||
          found.state.value !== null ||
          found.state.loading ||
          found.ahead)
      )
        continue;
      tried.add(path);
      allowance.reading += 1;
      const target = found ?? entry(view);
      void lane.ahead(everything.signal, async (signal, promote) => {
        let promoted = false;
        const value = await read(target, {
          signal,
          promote: () => {
            promoted = promote();
            return promoted;
          },
        });
        allowance.reading -= 1;
        if (!promoted && (value as PageRead | undefined)?.kind === "page") allowance.kept += 1;
        else if (signal.aborted) {
          tried.delete(path);
          queued.push(item);
        }
      });
    }
  }
  const leaveLane = lane.onFree(drain);

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
        if (
          signal.aborted ||
          !live() ||
          (error instanceof ServerError &&
            (error.problem === "signed-out" || error.problem === "cancelled"))
        )
          return;
        if (isGone(error)) return gone();
        failures += 1;
        const delay = Math.min(FEED_RETRY_MS * 2 ** (failures - 1), FEED_RETRY_MAX_MS);
        const problem = shownProblem(error);
        if (
          problem !== null &&
          !shown &&
          (failures >= FEED_FAILURES_SHOWN || delay >= FEED_RETRY_MAX_MS)
        ) {
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
    target.ahead = null;
    target.reads.next();
    if (target.state.loading) set(target, { ...target.state, loading: false });
  }

  function apply(answer: FeedAnswer) {
    if (answer.replace) {
      cache.drop(scope);
      for (const [id, target] of entries) {
        if (target.listeners.size > 0) {
          target.stale = false;
          set(target, {
            value: null,
            loading: true,
            problem: null,
            failures: target.state.failures,
          });
          void read(target, "feed");
          continue;
        }
        forget(target);
        entries.delete(id);
      }
      if (role !== "owner") options.reopen?.();
      return;
    }
    const known: Known = {
      files: (entries.get(views.files.id)?.state.value as readonly WorkspaceFile[] | null) ?? null,
      chats: (entries.get(views.chats.id)?.state.value as readonly ChatGroup[] | null) ?? null,
    };
    for (const target of entries.values()) {
      if (!target.view.affectedBy(answer.changed, known, target.state.value)) continue;
      if (target.listeners.size > 0) {
        void read(target, "feed");
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
    role,
    joined: role !== "owner",
    isOpen: () => !stopped,
    instance: ++instances,
    state: <T>(view: View<T>) => entry(view).state as ViewState<T>,
    subscribe(view, listener) {
      const target = entry(view);
      target.listeners.add(listener);
      if (target.listeners.size === 1 && !target.ahead?.promote() && due(target)) void read(target);
      shown(target);
      return () => void target.listeners.delete(listener);
    },
    prefetch(view) {
      const target = entry(view);
      if (!target.ahead?.promote() && due(target)) void read(target);
    },
    prefetchAhead(list) {
      const seen = new Set(queued.map((item) => (item.kind === "view" ? item.view.id : null)));
      for (const view of list) {
        if (seen.has(view.id)) continue;
        seen.add(view.id);
        queued.push({ kind: "view", view });
      }
      drain();
    },
    prefetchPages(paths, bucket) {
      const fresh = new Map(
        paths
          .filter((path) => !tried.has(path))
          .map((path) => [
            path,
            {
              kind: "page" as const,
              path,
              bucket: bucket ?? path.slice(0, path.lastIndexOf("/") + 1),
            },
          ]),
      );
      queued = [
        ...fresh.values(),
        ...queued.filter((next) => next.kind !== "page" || !fresh.has(next.path)),
      ];
      drain();
    },
    retry(view) {
      if (hasGone) return options.reopen?.();
      const target = entry(view);
      if (live() && !target.state.loading) void read(target);
    },
    refresh(view) {
      if (hasGone) {
        options.reopen?.();
        return Promise.resolve();
      }
      const target = entry(view);
      const start = async () => {
        if (live()) await read(target);
      };
      return restoring && restored ? restored.then(start) : start();
    },
    invalidate(view, drop = false) {
      if (view.id.startsWith("page:")) tried.delete(view.id.slice("page:".length));
      const target = entries.get(view.id);
      const cached = cache.get(scope, view.id);
      if (cached) cache.set(scope, { ...cached, stale: true });
      if (!target) return;
      if (target.listeners.size > 0) {
        if (drop) forget(target);
        target.stale = true;
        if (live()) void read(target);
        return;
      }
      forget(target);
      if (drop) {
        entries.delete(view.id);
        return;
      }
      target.stale = true;
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
      drain();
    },
    pause() {
      running = false;
      stopFeed();
    },
    stop() {
      stopped = true;
      running = false;
      leaveLane();
      stopFeed();
      everything.abort();
    },
    markRead(threadId, messageId) {
      if (
        store.joined ||
        !live() ||
        sending.get(threadId) === messageId ||
        marked.get(threadId) === messageId
      )
        return Promise.resolve();
      sending.set(threadId, messageId);
      return markThreadRead(signIn.client, workspaceId, threadId, messageId, everything.signal)
        .then(
          () => {
            marked.set(threadId, messageId);
          },
          (error: unknown) => {
            // As a read's 404 does, one that still counts says the workspace may be gone from this phone.
            if (live() && isGone(error)) gone();
          },
        )
        .finally(() => {
          if (sending.get(threadId) === messageId) sending.delete(threadId);
        });
    },
  };
  return store;
}
