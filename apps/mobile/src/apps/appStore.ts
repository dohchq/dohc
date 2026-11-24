import type { Account, SignIn } from "../server/account";
import { requestGenerations, shownProblem, type Fetch } from "../server/client";
import {
  appOperations,
  type AppLaunch,
  type AppOperations,
  type PhoneApp,
} from "../server/phoneApps";
import type { ReadProblem } from "../server/workspaceData";

// The app running on the phone, and the open workspace's published apps.
//
// The runner holds at most one app, in memory only. Ending it drops the app, so its WebView unmounts on the next
// render, and drops a launch still on its way, so that launch never shows. The account ends it first at sign-out, a
// sign-in change, a workspace change and Show on phone off (appTeardown). The workspace's store ends it on Revoke,
// before it sends, and when a complete catalog read no longer lists it approved: a revoke on another phone or a
// withdrawn publication shows here at the next read, every 15 s while it runs. The server has already cut its access.

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
}

export interface AppRunner {
  state(): RunningApp | null;
  subscribe(listener: () => void): () => void;
  /** Ends the running app, and any launch on its way, that `match` names, or every one. */
  end(match?: (scope: AppScope) => boolean): void;
  /** Starts a launch for `scope`, ending the last. Resolves whether it showed. */
  start(scope: AppScope & { readonly name: string }, launch: Promise<AppLaunch>): Promise<boolean>;
  /** Ends the running app because its web process died. Its review says so until the next launch, or until `end` names it. */
  stop(): void;
  /** The app `stop` ended, or null. */
  stopped(): AppScope | null;
}

export function createAppRunner(): AppRunner {
  const listeners = new Set<() => void>();
  let running: RunningApp | null = null;
  let pending: { readonly key: number; readonly scope: AppScope } | null = null;
  let launches = 0;
  let stopped: AppScope | null = null;
  const set = (next: RunningApp | null) => {
    running = next;
    for (const listener of listeners) listener();
  };
  const end: AppRunner["end"] = (match = () => true) => {
    if (pending && match(pending.scope)) pending = null;
    const forget = stopped !== null && match(stopped);
    if (forget) stopped = null;
    if (running && match(running)) set(null);
    else if (forget) set(running);
  };
  return {
    state: () => running,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    end,
    async start(scope, launch) {
      stopped = null;
      end();
      const key = ++launches;
      pending = { key, scope };
      let answer: AppLaunch;
      try {
        answer = await launch;
      } catch (error) {
        if (pending?.key !== key) return false;
        pending = null;
        throw error;
      }
      if (pending?.key !== key) return false;
      pending = null;
      set({ ...scope, ...answer, key });
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
    /** Show on phone off. */
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
  /** Whether answers for this store still count: its sign-in is current and it hasn't stopped. */
  isLive(): boolean;
  approve(app: Pick<PhoneApp, "publicationId" | "authorityRevision">): Promise<void>;
  revoke(publicationId: string): Promise<void>;
  /**
   * Opens the app in the runner, unless this build can't run apps. Resolves whether it showed. Once `leaving` aborts,
   * the launch ends and never shows.
   */
  open(app: PhoneApp & { readonly name: string }, leaving: AbortSignal): Promise<boolean>;
  stop(): void;
}

export function createWorkspaceApps(options: {
  readonly signIn: Pick<SignIn, "client" | "isCurrent">;
  readonly workspaceId: string;
  readonly runner: AppRunner;
  readonly fetch: Fetch;
  /** This build may run apps (src/apps/canOpenApps.ts). */
  readonly canOpen: boolean;
}): WorkspaceApps {
  const { signIn, workspaceId, runner } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const operations = appOperations(signIn.client, workspaceId, signal);
  const reads = requestGenerations();
  const listeners = new Set<() => void>();
  let state: AppsState = { apps: null, problem: null, failures: 0 };
  const isLive = () => !signal.aborted && signIn.isCurrent();
  const mine = (publicationId?: string) => (scope: AppScope) =>
    scope.signIn === signIn &&
    scope.workspaceId === workspaceId &&
    (publicationId === undefined || scope.publicationId === publicationId);
  const set = (next: AppsState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  let reading: Promise<void> | null = null;
  // A failed or incomplete read rejects, so only a complete catalog can end the running app.
  const refresh = () => {
    const request = reads.next();
    const lands = () => isLive() && reads.isLatest(request);
    const read = operations.list().then(
      (apps) => {
        if (!lands()) return;
        runner.end(
          (scope) =>
            mine()(scope) &&
            !apps.some((app) => app.publicationId === scope.publicationId && app.approved),
        );
        set({ apps, problem: null, failures: state.failures });
      },
      (error: unknown) => {
        const problem = shownProblem(error);
        if (lands() && problem !== null) set({ ...state, problem, failures: state.failures + 1 });
      },
    );
    reading = read.finally(() => {
      if (reads.isLatest(request)) reading = null;
    });
    return read;
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
    check: () => reading ?? refresh(),
    isLive,
    async approve(app) {
      await operations.approve(app);
      if (isLive()) await refresh();
    },
    async revoke(publicationId) {
      runner.end(mine(publicationId));
      await operations.revoke(publicationId);
      if (isLive()) await refresh();
    },
    async open(app, leaving) {
      if (!options.canOpen) return false;
      const both = new AbortController();
      const abort = () => both.abort();
      for (const source of [signal, leaving]) {
        if (source.aborted) abort();
        source.addEventListener("abort", abort);
      }
      const scope = { signIn, workspaceId, publicationId: app.publicationId, name: app.name };
      try {
        const shown = await runner.start(scope, operations.launch(options.fetch, app, both.signal));
        if (shown && leaving.aborted) runner.end(mine(app.publicationId));
        return shown && !leaving.aborted;
      } finally {
        signal.removeEventListener("abort", abort);
        leaving.removeEventListener("abort", abort);
      }
    },
    stop() {
      runner.end(mine());
      controller.abort();
    },
  };
}
