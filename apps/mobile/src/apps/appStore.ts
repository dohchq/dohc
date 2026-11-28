import type { WorkspaceRole } from "../server/api";
import type { ScopedEnds } from "../pages/pageLive";
import type { Account, SignIn } from "../server/account";
import { requestGenerations, ServerError, shownProblem, type Fetch } from "../server/client";
import {
  appOperations,
  type AppLaunch,
  type AppOperations,
  type AppReview,
  type PhoneApp,
} from "../server/phoneApps";
import { cachedList, views, type ReadCache, type ReadProblem } from "../server/workspaceData";

// The app running on the phone, and the open workspace's published apps.
//
// The runner holds at most one app, in memory only. Ending it drops the app, so its WebView unmounts on the next
// render, and drops a launch still on its way, so that launch never shows. The account ends it first at sign-out, a
// sign-in change, a workspace change and Show on phone off (appTeardown). The workspace's store ends it on Revoke,
// before it sends, and when a complete catalog read no longer lists it approved: a revoke on another phone or a
// withdrawn publication shows here at the next read, every 15 s while it runs. The server has already cut its access.
// An owner's app that a catalog lists another version of in its place keeps running until it closes, for at most
// REPLACED_KEPT_MS from its launch, so a revoke from another phone still closes it.

/** Whose a launch is: the sign-in and workspace it was made for, and its app. */
export interface AppScope {
  readonly signIn: object;
  readonly workspaceId: string;
  readonly publicationId: string;
}

export interface RunningApp extends AppScope, AppLaunch {
  /** New for each launch, so each gets a new WebView. */
  readonly key: number;
  readonly name: string;
  readonly appRoot: string | null;
  readonly startedAtMs: number;
}

export const REPLACED_KEPT_MS = 10 * 60_000;

export interface AppRunner {
  state(): RunningApp | null;
  launching(): LaunchScope | null;
  subscribe(listener: () => void): () => void;
  /** Ends the running app, and any launch on its way, that `match` names, or every one. */
  end(match?: (scope: AppScope) => boolean): void;
  /** Starts a launch for `scope`, ending the last. Its signal aborts when the launch ends. Resolves whether it showed. */
  start(scope: LaunchScope, launch: (ended: AbortSignal) => Promise<AppLaunch>): Promise<boolean>;
  /** Ends the running app because its web process died. Its review says so until the next launch, or until `end` names it. */
  stop(): void;
  /** The app `stop` ended, or null. */
  stopped(): AppScope | null;
}

type LaunchScope = AppScope & { readonly name: string; readonly appRoot: string | null };

export function createAppRunner(): AppRunner {
  const listeners = new Set<() => void>();
  let running: RunningApp | null = null;
  let pending: {
    readonly key: number;
    readonly scope: LaunchScope;
    readonly ended: AbortController;
  } | null = null;
  let launches = 0;
  let stopped: AppScope | null = null;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const set = (next: RunningApp | null) => {
    running = next;
    notify();
  };
  const end: AppRunner["end"] = (match = () => true) => {
    const launch = pending !== null && match(pending.scope);
    if (launch) {
      pending?.ended.abort();
      pending = null;
    }
    const forget = stopped !== null && match(stopped);
    if (forget) stopped = null;
    if (running && match(running)) set(null);
    else if (forget || launch) notify();
  };
  return {
    state: () => running,
    launching: () => pending?.scope ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    end,
    async start(scope, launch) {
      stopped = null;
      end();
      const key = ++launches;
      const ended = new AbortController();
      pending = { key, scope, ended };
      notify();
      let answer: AppLaunch;
      try {
        answer = await launch(ended.signal);
      } catch (error) {
        if (pending?.key !== key) return false;
        pending = null;
        notify();
        throw error;
      }
      if (pending?.key !== key) return false;
      pending = null;
      set({ ...scope, ...answer, key, startedAtMs: Date.now() });
      return true;
    },
    stop() {
      stopped = running;
      set(null);
    },
    stopped: () => stopped,
  };
}

/** What runs for one sign-in and workspace and ends with them: the running app, and pages edited live. */
interface Ends {
  end(match?: (scope: Pick<AppScope, "signIn" | "workspaceId">) => boolean): void;
}

/**
 * How the account ends a running app and the pages edited live, each before the work it precedes, as AccountProvider
 * wires it. Ending a live page closes its socket, and its web view goes on the next render.
 */
export function appTeardown(...runners: readonly Ends[]) {
  const end = (match?: (scope: Pick<AppScope, "signIn" | "workspaceId">) => boolean) => {
    for (const runner of runners) runner.end(match);
  };
  return {
    /** Sign out's hook, after ending them: before the outbox deletes anything. */
    signOut:
      <A extends unknown[], T>(hook: (...args: A) => Promise<T>) =>
      (...args: A) => {
        end();
        return hook(...args);
      },
    /** A 401 or another sign-in ends every one but the current sign-in's. Returns the unsubscribe. */
    follow: (account: Pick<Account, "subscribe" | "state">) =>
      account.subscribe(() => {
        const now = account.state();
        end((scope) => now.status !== "signed-in" || scope.signIn !== now.signIn);
      }),
    /** The open workspace is now `workspaceId`, by a choice here or a change elsewhere. */
    open: (workspaceId: string | null) => end((scope) => scope.workspaceId !== workspaceId),
    /** Show on phone off, or a 404 for the workspace. */
    hide: (workspaceId: string) => end((scope) => scope.workspaceId === workspaceId),
  };
}

export interface AppsState {
  readonly apps: readonly PhoneApp[] | null;
  readonly problem: ReadProblem | null;
  readonly failures: number;
}

export interface WorkspaceApps {
  readonly workspaceId: string;
  /** Reads for this store's sign-in and workspace. They end when it stops. */
  readonly operations: AppOperations;
  state(): AppsState;
  subscribe(listener: () => void): () => void;
  /** Reads the catalog again. Only the latest read lands. Resolves once it has landed or been dropped. */
  refresh(): Promise<void>;
  /** A periodic check: joins a read still running instead of replacing it, so a slow read can finish. */
  check(): Promise<void>;
  /** Reads the catalog quietly in the background when empty, without reporting failures unless `check` joins it. */
  warm(): Promise<void>;
  /** The last review read for `publicationId` in this store, or null. */
  cachedReview(publicationId: string): AppReview | null;
  /** Reads `publicationId`'s review, joining an in-flight read of the same generation. */
  readReview(publicationId: string): Promise<AppReview>;
  /** Starts reading `publicationId`'s review before the screen opens. */
  prefetchReview(publicationId: string): void;
  /** Whether answers for this store still count: its sign-in is current and it hasn't stopped. */
  isLive(): boolean;
  approve(
    app: Pick<PhoneApp, "publicationId" | "authorityRevision"> & {
      readonly scopeDigest?: string | null;
    },
  ): Promise<void>;
  revoke(publicationId: string): Promise<void>;
  /**
   * Opens the app in the runner, unless this build can't run apps. Resolves whether it showed. Once `leaving` aborts,
   * the launch ends and never shows.
   */
  open(app: PhoneApp & { readonly name: string }, leaving: AbortSignal): Promise<boolean>;
  stop(): void;
}

export function createWorkspaceApps(options: {
  readonly signIn: Pick<SignIn, "client" | "isCurrent" | "origin" | "userId">;
  readonly workspaceId: string;
  readonly runner: AppRunner;
  readonly cache: ReadCache;
  readonly ends: Pick<ScopedEnds, "add">;
  readonly fetch: Fetch;
  /** This build may run apps (src/apps/canOpenApps.ts). */
  readonly canOpen: boolean;
  readonly role?: WorkspaceRole;
  /** Whether the workspace's store this one belongs to is still open. */
  readonly open?: () => boolean;
}): WorkspaceApps {
  const { signIn, workspaceId, runner } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const operations = appOperations(signIn.client, workspaceId, signal);
  const reads = requestGenerations();
  const listeners = new Set<() => void>();
  const saved = cachedList(options.cache, signIn, workspaceId, views.apps, options.role);
  let state: AppsState = { apps: saved.value(), problem: null, failures: 0 };
  const isLive = () => !signal.aborted && signIn.isCurrent() && (options.open?.() ?? true);
  const mine = (publicationId?: string) => (scope: AppScope) =>
    scope.signIn === signIn &&
    scope.workspaceId === workspaceId &&
    (publicationId === undefined || scope.publicationId === publicationId);
  const set = (next: AppsState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  void saved.restored.then(() => {
    const apps = saved.value();
    if (isLive() && state.apps === null && apps) set({ ...state, apps });
  });

  let reading: { promise: Promise<void>; report: boolean } | null = null;
  let warmed = false;
  let reviewEpoch = 0;
  const reviews = new Map<string, AppReview>();
  const reviewReads = new Map<
    string,
    { readonly epoch: number; readonly version: number; readonly promise: Promise<AppReview> }
  >();
  const reviewVersions = new Map<string, number>();
  const reviewVersion = (id: string) => reviewVersions.get(id) ?? 0;
  const dropReview = (id: string) => {
    reviewVersions.set(id, reviewVersion(id) + 1);
    reviews.delete(id);
    reviewReads.delete(id);
  };
  const clearReviews = () => {
    reviewEpoch += 1;
    reviews.clear();
    reviewReads.clear();
    reviewVersions.clear();
  };
  const remove = options.ends.add(
    { signIn, workspaceId },
    {
      end() {
        reads.next();
        reading = null;
        warmed = false;
        clearReviews();
        set({ apps: null, problem: null, failures: 0 });
      },
    },
  );
  // A failed or incomplete read rejects, so only a complete catalog can end the running app.
  const load = (report: boolean) => {
    const request = reads.next();
    const lands = () => isLive() && reads.isLatest(request);
    const active = { promise: Promise.resolve(), report };
    const read = Promise.all([operations.list(), saved.restored]).then(
      ([apps]) => {
        if (reads.isLatest(request)) reading = null;
        if (!lands()) return;
        saved.save(apps);
        const byId = new Map(apps.map((entry) => [entry.publicationId, entry]));
        const priorById = new Map(state.apps?.map((entry) => [entry.publicationId, entry]) ?? []);
        for (const id of new Set([...reviews.keys(), ...reviewReads.keys()])) {
          const entry = byId.get(id);
          const cached = reviews.get(id);
          const prior = priorById.get(id);
          const baseline = cached ?? prior;
          if (
            !entry ||
            !baseline ||
            entry.authorityRevision !== baseline.authorityRevision ||
            entry.approved !== baseline.approved ||
            entry.member?.consent !== baseline.member?.consent
          )
            dropReview(id);
        }
        const running = runner.state();
        const listed = apps.find((app) => app.publicationId === running?.publicationId);
        const replaced =
          running !== null &&
          Date.now() - running.startedAtMs < REPLACED_KEPT_MS &&
          apps.some((app) => app.owner && app.appRoot === running.appRoot);
        if (running && mine()(running) && (listed ? !listed.approved : !replaced))
          runner.end((scope) => scope === running);
        set({ apps, problem: null, failures: state.failures });
      },
      (error: unknown) => {
        if (reads.isLatest(request)) reading = null;
        const problem = shownProblem(error);
        if (lands() && active.report && problem !== null)
          set({ ...state, problem, failures: state.failures + 1 });
      },
    );
    active.promise = read;
    reading = active;
    return read;
  };
  const refresh = () => load(true);
  const readReview = (publicationId: string): Promise<AppReview> => {
    const epoch = reviewEpoch;
    const version = reviewVersion(publicationId);
    const inFlight = reviewReads.get(publicationId);
    if (inFlight && inFlight.epoch === epoch && inFlight.version === version)
      return inFlight.promise;
    const stillCurrent = () =>
      isLive() && reviewEpoch === epoch && reviewVersion(publicationId) === version;
    const promise: Promise<AppReview> = operations.review(publicationId).then(
      (review) => {
        if (reviewReads.get(publicationId) === tracked) reviewReads.delete(publicationId);
        if (stillCurrent()) {
          reviews.set(publicationId, review);
          return review;
        }
        if (isLive() && reviewEpoch === epoch) return readReview(publicationId);
        return review;
      },
      (error: unknown) => {
        if (reviewReads.get(publicationId) === tracked) reviewReads.delete(publicationId);
        if (
          stillCurrent() &&
          error instanceof ServerError &&
          (error.problem === "not-found" || error.problem === "refused")
        )
          reviews.delete(publicationId);
        throw error;
      },
    );
    const tracked = { epoch, version, promise };
    reviewReads.set(publicationId, tracked);
    return promise;
  };

  return {
    workspaceId,
    operations,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    check() {
      if (reading) {
        reading.report = true;
        return reading.promise;
      }
      return refresh();
    },
    warm() {
      if (warmed || !isLive() || state.apps !== null || reading !== null) return Promise.resolve();
      warmed = true;
      return load(false);
    },
    cachedReview: (publicationId) => (isLive() ? (reviews.get(publicationId) ?? null) : null),
    readReview,
    prefetchReview(publicationId) {
      if (!isLive() || reviewReads.has(publicationId)) return;
      void readReview(publicationId).catch(() => undefined);
    },
    isLive,
    async approve(app) {
      clearReviews();
      await operations.approve(app);
      clearReviews();
      if (isLive()) await refresh();
    },
    async revoke(publicationId) {
      clearReviews();
      runner.end(mine(publicationId));
      await operations.revoke(publicationId);
      clearReviews();
      if (isLive()) await refresh();
    },
    async open(app, leaving) {
      if (!options.canOpen || leaving.aborted || !isLive()) return false;
      const both = new AbortController();
      const abort = () => both.abort();
      const sources = [signal, leaving];
      const scope = {
        signIn,
        workspaceId,
        publicationId: app.publicationId,
        name: app.name,
        appRoot: app.owner ? app.appRoot : null,
      };
      try {
        const shown = await runner.start(scope, (ended) => {
          sources.push(ended);
          for (const source of sources) {
            if (source.aborted) abort();
            source.addEventListener("abort", abort);
          }
          return operations.launch(options.fetch, app, both.signal);
        });
        if (shown && leaving.aborted) runner.end(mine(app.publicationId));
        return shown && !leaving.aborted;
      } finally {
        for (const source of sources) source.removeEventListener("abort", abort);
      }
    },
    stop() {
      remove();
      clearReviews();
      runner.end(mine());
      controller.abort();
    },
  };
}
