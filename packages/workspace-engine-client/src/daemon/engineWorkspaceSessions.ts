import {
  DaemonRefusalError,
  isDaemonReconnectError,
  isEngineStoreBusyRefusal,
  isYdocOpenOperationCrashedRefusal,
  isYdocOpenStorageFailureRefusal,
  isYdocSessionBusyRefusal,
  isYdocArtifactAssetsPendingRefusal,
  isYdocArtifactAssetsInvalidRefusal,
  WorkspaceDaemonRequester,
} from "../live/daemonLiveAdapter";
import type { AgentAuthor } from "../versioned/versionedWireContract";
import {
  WORKSPACE_METHOD,
  decodeWorkspaceResult,
} from "../workspace/workspaceWireContract";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";
import { YdocOpenTimedOutError } from "../ydoc/ydocLiveAdapter";
import {
  DOHC_ENGINE_GUARD,
  DOHC_METADATA_GUARD,
  notARealFolderRefusal,
  outsideWorkspaceRefusal,
  type DohcPathGuard,
} from "@dohc/workspace-core";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  EngineDaemonUnavailableError,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";

export interface EngineWorkspace {
  workspaceId: string;
  rootPath: string;
  shareMount?: true;
  // One-shot maintenance/bootstrap opens can suppress capture, then close the
  // session before the ordinary desktop activity opens it with capture.
  captureMode?: "none";
}

export interface EngineWorkspaceBinding {
  client: EngineDaemonClient;
  workspace: WorkspaceHandle;
}

export interface EngineDaemonClientSource {
  currentClient(): EngineDaemonClient;
}

interface SessionEntry {
  binding: EngineWorkspaceBinding | null;
  opening: {
    client: EngineDaemonClient;
    promise: Promise<EngineWorkspaceBinding>;
  } | null;
  closing: Promise<void> | null;
  activeRuns: number;
  idleWaiters: Set<() => void>;
}

export interface EngineWorkspaceRunOptions {
  /**
   * Replays the operation after transport rebinding. Callers must enable this
   * only for idempotent operations or calls that verify a possibly committed
   * first attempt before applying another write.
   */
  retryTransportErrors?: boolean;
}

export interface EngineWorkspaceSessionsOptions {
  transportRebindAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
  // Test injection for the retry-deadline clock; production uses
  // performance.now, which is monotonic — a wall-clock jump (NTP, DST,
  // sleep/wake) must not spend or extend a retry budget.
  now?: () => number;
  /**
   * Deadline for a single daemon `workspace.open`. Defaults to
   * WORKSPACE_OPEN_DEADLINE_MS, which is the product guarantee about
   * workspace-open latency — production must not pass anything else. Test
   * harnesses that run many daemons at once can raise it, because there the
   * cause of a missed deadline is suite contention rather than the code under
   * test.
   */
  workspaceOpenDeadlineMs?: number;
}

// Node's setTimeout silently converts a delay above this to 1ms, so a caller
// asking for a 30-day deadline would get near-immediate transport timeouts —
// the exact opposite of widening it. EngineClient passes this value straight to
// setTimeout, so the ceiling has to be enforced here.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const TRANSPORT_REBIND_ATTEMPTS = 6;
const TRANSPORT_REBIND_INITIAL_BACKOFF_MS = 100;
// Exported so a caller deriving a retry budget can size whole recovery
// windows (open deadline + worst-case backoff) instead of restating numbers.
export const TRANSPORT_REBIND_MAX_BACKOFF_MS = 1_000;
const SHADOW_CLONE_TOKEN = /^[0-9a-f]{64}$/;
export const WORKSPACE_OPEN_DEADLINE_MS = 2_000;

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

export class EngineWorkspaceRebindError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string, cause: unknown) {
    super(`Rust engine could not re-open workspace ${workspaceId}.`, { cause });
    this.name = "EngineWorkspaceRebindError";
    this.workspaceId = workspaceId;
  }
}

export class EngineWorkspaceSessionsClosedError extends Error {
  constructor() {
    super("Rust engine workspace sessions are closed.");
    this.name = "EngineWorkspaceSessionsClosedError";
  }
}

export class EngineWorkspaceRebuildingError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(
      `Rust engine cannot open workspace ${workspaceId} while its data store is rebuilding. Try again shortly.`,
    );
    this.name = "EngineWorkspaceRebuildingError";
    this.workspaceId = workspaceId;
  }
}

// A retry limit was reached: the run stopped STARTING retries. The last
// failure rides as the cause.
//
// `constraint` names the option the CALLER actually set, so an agent reading
// the message can find the limit that fired instead of an option it never
// passed (#564, codex).
// TWO durations, because they are two different facts and one number cannot
// carry both (#564, codex). `measuredMs` is the interval the LIMIT is measured
// over — for a region budget that starts at the first failure, so a slow but
// healthy attempt is not charged against a retry allowance. `totalWaitedMs` is
// what the CALLER actually waited, first attempt included. They differ, and
// reporting the first as if it were the second sent an agent diagnosing a
// capture chain held for 8s looking for a 6s hold.
export class EngineWorkspaceRetryDeadlineError extends Error {
  readonly workspaceId: string;
  readonly constraint: string;
  readonly limitMs: number;
  readonly measuredMs: number;
  readonly totalWaitedMs: number;
  readonly failedAttempts: number;

  constructor(
    workspaceId: string,
    constraint: string,
    limitMs: number,
    // What the limit is timed from, in words: the reader has to know which
    // interval the number above is, or the two durations look contradictory.
    measuredFrom: string,
    measuredMs: number,
    totalWaitedMs: number,
    failedAttempts: number,
    cause: unknown,
  ) {
    super(
      `Rust engine stopped retrying for workspace ${workspaceId}. ` +
        `The ${constraint} limit of ${limitMs}ms was reached: ` +
        `${measuredMs}ms ${measuredFrom}. ` +
        `The caller waited ${totalWaitedMs}ms in total, across ${failedAttempts} failed attempts. ` +
        `Retry the operation, or wait for the daemon to come back.`,
      { cause },
    );
    this.name = "EngineWorkspaceRetryDeadlineError";
    this.workspaceId = workspaceId;
    this.constraint = constraint;
    this.limitMs = limitMs;
    this.measuredMs = measuredMs;
    this.totalWaitedMs = totalWaitedMs;
    this.failedAttempts = failedAttempts;
  }
}

// A bounded region was asked to START after `beginShutdown`. It is refused
// before the first daemon call, because the app is quitting and the work is
// abandonable by construction (#564, codex).
export class EngineWorkspaceShuttingDownError extends Error {
  constructor() {
    super(
      "Rust engine refused a bounded retry region: the app is quitting. " +
        "Nothing new starts during teardown; retry after the next launch.",
    );
    this.name = "EngineWorkspaceShuttingDownError";
  }
}

// The refusals a document open must NOT answer with the writable plain editor.
// Each means the same thing to the surface — the engine did not open this
// document, and may still own it — so each keeps it read-only
// (#533/#564/#616).
//
// `ydoc-session-busy` is the daemon SAYING SO, and it is not scoped to the
// timeout that motivated it. Whenever a lease is held, the daemon's Y.Doc is
// the canonical copy and the file on disk is not, so a writable plain editor
// over that file is a second writer whatever produced the lease: this client's
// timed-out open, another window, or a session whose close failed. The cost of
// classifying it this way is that a document whose session id was lost stays
// read-only until the workspace closes. That is the honest state, and the
// notice carries a retry.
export function isEngineWorkspaceOpenRefusedError(error: unknown): boolean {
  return (
    error instanceof EngineWorkspaceRetryDeadlineError ||
    error instanceof EngineWorkspaceShuttingDownError ||
    error instanceof YdocOpenTimedOutError ||
    isYdocSessionBusyRefusal(error) ||
    isYdocArtifactAssetsPendingRefusal(error) ||
    isYdocArtifactAssetsInvalidRefusal(error) ||
    isYdocOpenStorageFailureRefusal(error) ||
    isYdocOpenOperationCrashedRefusal(error)
  );
}

function requiresReconnect(error: unknown): boolean {
  return (
    error instanceof DaemonRefusalError &&
    error.disposition === "afterReconnect"
  );
}

// The daemon's own "retry, but wait first". It raises this for
// DeadlineExceeded and Overloaded (dohc-engine-protocol error.rs
// Retryability::AfterBackoff) on ANY method, including the `workspace.open`
// this file deadlines at 2 s — so the open ladder meets it routinely, and
// must both wait and count it against the budget.
function requiresBackoff(error: unknown): boolean {
  return (
    error instanceof DaemonRefusalError && error.disposition === "afterBackoff"
  );
}

function isTransportError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "transport-error"
  );
}

export function isEngineSessionReconnectError(error: unknown): boolean {
  return isDaemonReconnectError(error);
}

function daemonMayBeRelaunching(error: unknown): boolean {
  return (
    isTransportError(error) ||
    error instanceof EngineDaemonUnavailableError ||
    // A `workspace.open` that refuses with the afterReconnect disposition is
    // the same "come back on a new session" answer as a dropped transport,
    // and the open ladder retries it either way — so it must reach the same
    // shutdown/deadline gate (#564). Without this the ladder ran six full
    // opens on a spent budget, and `beginShutdown` did not stop it.
    requiresReconnect(error)
  );
}

function transportBackoffMs(attempt: number): number {
  return Math.min(
    TRANSPORT_REBIND_INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
    TRANSPORT_REBIND_MAX_BACKOFF_MS,
  );
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

export class EngineWorkspaceSessions {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly captureAuthors = new Map<string, AgentAuthor | null>();
  private readonly shareMounts = new Set<string>();
  private readonly rebuildingWorkspaces = new Set<string>();
  private readonly transportRebindAttempts: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;
  private readonly workspaceOpenDeadlineMs: number;
  private acceptingRuns = true;
  // App quit (#564): retry waiting is over. Armed backoff sleeps resolve,
  // and a transport failure after this point is final. Operations themselves
  // still run — the quit teardown's closes go through run() too.
  private shuttingDown = false;
  private readonly sleepCancels = new Set<() => void>();
  // The ambient budget a caller put over a REGION of daemon work
  // (`withRetryBudget`). It bounds every run the region makes, together —
  // which is what a caller holding a shared resource across several daemon
  // calls actually needs, and it is the only retry limit this class has.
  private readonly retryBudgets = new AsyncLocalStorage<{
    budgetMs: number;
    // The clock starts at the FIRST FAILURE, not at region entry, because the
    // budget bounds RECOVERY and a healthy attempt is not recovery (#564,
    // codex P1). Anchored at entry, a legitimately slow open — a large
    // document's lineage resurrection, the slow case #514 fought — spent the
    // budget on work that was succeeding, and one transport blip after it was
    // then refused a retry that would have bound. That made this a limit
    // rejecting valid work, which AGENTS.md says must be measured first; the
    // measurement on record covers the JS chain path, not daemon restart or
    // lineage recovery. Anchoring at the first failure removes the case
    // instead: what remains bounded is the recovery window, and that IS
    // derived from the transport contract it is built from
    // (WORKSPACE_OPEN_DEADLINE_MS + TRANSPORT_REBIND_MAX_BACKOFF_MS).
    failedAtMs: number | null;
    // Region entry. REPORTING ONLY — it bounds nothing, and must not, or the
    // slow-healthy-attempt case comes straight back. It exists so the refusal
    // can state what the caller actually waited, which is the observed usage
    // AGENTS.md asks a rejection to name.
    startedAtMs: number;
    // FAILED attempts across every run the region made, because the region
    // is what the budget spans: a per-run counter resets on each `run` and
    // would report "1" for a wait that covered six. It counts failures, and
    // the message says so — a run that failed and then recovered late is one
    // failed attempt out of two, and reporting "2 attempts" for one recovery
    // window would be a different (also true) number the reader cannot use.
    failedAttempts: number;
    // What the region was recovering from. A run refused at its START has no
    // failure of its own to name, and a refusal that names none sends the
    // reader looking for the wrong thing.
    lastError: unknown;
    // THE REGION IS THE OPEN, AND NOTHING BEYOND IT.
    //
    // An async context is inherited by everything created inside it, and a
    // document open INSTALLS things that outlive it: the settle debounce
    // timer, the remote-update subscription, the save-state reporter, an
    // armed backoff. Node timers keep the context they were created in, so
    // those callbacks kept reading as work inside the abandonable open
    // region — for the whole life of the session. A settle for an edit the
    // engine had already ACCEPTED would then be refused by a budget spent
    // during the open, or stopped by quit, which is the one thing this class
    // must never do to an accepted write (#564, codex r22).
    //
    // The context cannot be un-inherited, so the REGION ends instead: every
    // reader asks `activeBudget()`, and that answers undefined once the task
    // has returned. One statement, and it covers every callback the open
    // installs rather than each one separately.
    ended: boolean;
  }>();

  // The ambient budget, but only while its region is still running. See
  // `ended` above: a context that outlived the open is not a region.
  private activeBudget() {
    const budget = this.retryBudgets.getStore();
    return budget === undefined || budget.ended ? undefined : budget;
  }

  constructor(
    private readonly source: EngineDaemonClientSource,
    options: EngineWorkspaceSessionsOptions = {},
  ) {
    this.transportRebindAttempts =
      options.transportRebindAttempts ?? TRANSPORT_REBIND_ATTEMPTS;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => performance.now());
    // `??` alone would accept 0, a negative, NaN or Infinity — an exported
    // option, so an invalid value would either fail every workspace.open or
    // quietly void the deadline guarantee this option exists to preserve.
    // Reject rather than clamp: silently substituting a value is how a caller
    // ends up believing it widened a deadline it did not.
    const deadline = options.workspaceOpenDeadlineMs;
    if (
      deadline !== undefined &&
      (!Number.isInteger(deadline) ||
        deadline <= 0 ||
        deadline > MAX_TIMER_DELAY_MS)
    ) {
      // Integer, not merely finite: the protocol declares deadlineMs as uint32
      // and the Rust wire field is a u32, so 12.5 would ship an invalid envelope
      // and can terminate the transport instead of widening anything.
      // Number.isInteger also rejects NaN and Infinity.
      throw new TypeError(
        `workspaceOpenDeadlineMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}, received ${String(deadline)}.`,
      );
    }
    this.workspaceOpenDeadlineMs = deadline ?? WORKSPACE_OPEN_DEADLINE_MS;
  }

  async run<T>(
    workspace: EngineWorkspace,
    operation: (binding: EngineWorkspaceBinding) => Promise<T>,
    options: EngineWorkspaceRunOptions = {},
  ): Promise<T> {
    const entry = await this.acquire(workspace.workspaceId);
    try {
      const maxAttempts = options.retryTransportErrors
        ? this.transportRebindAttempts
        : 2;
      let rebindStarted = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const binding = await this.openForRun(
          workspace,
          entry,
          options,
          rebindStarted,
        );
        // The second door: the operation is daemon work this class does not
        // issue itself, and the rebind above can take the whole window with it
        // (#564, codex r17).
        this.assertRegionLive(workspace.workspaceId);
        try {
          return await operation(binding);
        } catch (error) {
          const retryAfterReconnect = requiresReconnect(error);
          const retryAfterTransport =
            options.retryTransportErrors === true && isTransportError(error);
          if (
            (retryAfterReconnect || isTransportError(error)) &&
            entry.binding === binding
          ) {
            entry.binding = null;
          }
          // The busy store, collected for EVERY method rather than for
          // `workspace.open` alone. The engine answers it on any call, and a
          // contract only three surfaces collected on left the rest reporting
          // a kebab-case wire message to the user for a condition that clears
          // by itself (#658, and #595 round 14's rule about advertising
          // retries nobody performs).
          //
          // Safe for every method, including the non-idempotent ones, and
          // ONLY for this class: a busy store is raised by `BEGIN IMMEDIATE`
          // or by the commit, so the transaction did not commit and a second
          // attempt cannot apply anything twice.
          //
          // Deliberately NOT the whole `afterBackoff` disposition, which also
          // carries DEADLINE_EXCEEDED. A deadline interrupts BETWEEN durable
          // units and leaves work already committed durable
          // (`dohc-engine-runtime` actor), so replaying it is a second write —
          // exactly what the `retryTransportErrors` opt-in above exists to
          // keep callers in charge of. The protocol calls that disposition
          // retryable because retryable MUTATIONS carry idempotency keys, and
          // this wrapper cannot know whether the operation it was handed does.
          const retryAfterBackoff = isEngineStoreBusyRefusal(error);
          const retryable =
            retryAfterReconnect || retryAfterTransport || retryAfterBackoff;
          this.noteBudgetAttempt(error);
          // A failure this ladder will not retry never reaches the gates: a
          // permission refusal is not a timeout however long we waited.
          if (!retryable) throw error;
          rebindStarted = true;
          lastError = error;
          const next = await this.settleAttempt({
            workspaceId: workspace.workspaceId,
            attempt,
            lastAttempt: attempt >= maxAttempts,
            backoff: retryAfterTransport || retryAfterBackoff,
            cause: error,
          });
          if (next === "stop") throw error;
        }
      }
      throw new EngineWorkspaceRebindError(workspace.workspaceId, lastError);
    } finally {
      this.release(entry);
    }
  }

  /**
   * App quit: stop holding callers for daemon recovery. Armed backoff sleeps
   * resolve now, and further transport failures are final instead of
   * retried. Operations still run — the quit teardown's own closes come
   * through run() after this.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const cancel of [...this.sleepCancels]) cancel();
  }

  /**
   * Bound every retry ladder inside `task` by ONE budget, measured from
   * here (#564). A caller that holds a shared resource across several daemon
   * calls — the capture chain's document open, which reads the active
   * version before it opens the provider — cannot bound itself by giving
   * each call its own deadline: the calls add up. The budget is ambient so
   * it reaches runs this caller does not issue itself (a store method's
   * internal `run`), and per-async-context so two concurrent tasks never
   * share one.
   */
  async withRetryBudget<T>(budgetMs: number, task: () => Promise<T>): Promise<T> {
    if (
      !Number.isInteger(budgetMs) ||
      budgetMs <= 0 ||
      budgetMs > MAX_TIMER_DELAY_MS
    ) {
      throw new TypeError(
        `withRetryBudget budgetMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}, received ${String(budgetMs)}.`,
      );
    }
    // Checked where the work BEGINS, not only where it retries. `shuttingDown`
    // was consulted on the failure path alone, so a task that never failed
    // never saw it: a document open still queued on the capture chain when
    // `will-quit` fired would enter here afterwards, succeed at its first
    // workspace call, and proceed into a `ydoc.open` whose own bound (#616)
    // outlasts the 3 s forced-exit timer (#564, codex).
    // Nothing user-visible is lost: a bounded region is the abandonable kind
    // by construction, and an opening document is read-only (#533).
    if (this.shuttingDown) throw new EngineWorkspaceShuttingDownError();
    const budget = {
      budgetMs,
      failedAtMs: null as number | null,
      startedAtMs: this.now(),
      failedAttempts: 0,
      lastError: undefined as unknown,
      ended: false,
    };
    try {
      return await this.retryBudgets.run(budget, task);
    } finally {
      // The open has returned, so the region is over — whatever still holds
      // its context. Everything the session installed reads as ordinary work
      // from here, which is what it is.
      budget.ended = true;
    }
  }

  // One failed daemon attempt, counted on the ambient budget so the refusal
  // can report what the WAIT actually cost rather than one ladder's share.
  // The first failure also starts the budget's clock: see `failedAtMs`.
  private noteBudgetAttempt(cause?: unknown): void {
    const budget = this.activeBudget();
    if (budget === undefined) return;
    budget.failedAttempts += 1;
    budget.failedAtMs ??= this.now();
    // A churned open has no error of its own; it must not erase the one the
    // region is actually recovering from.
    if (cause !== undefined) budget.lastError = cause;
  }

  /**
   * THE INVARIANT: no daemon request starts after the region's budget or its
   * shutdown fired, and none blocks the region between the doors either —
   * whatever the caller awaited in between.
   *
   * Three review rounds found the same hole in three different awaits — the
   * gap between two runs (r15), the rebind ladder inside a run (r17), and the
   * wait for a closing entry (r18). One defect wearing three hats: a check
   * that answers for the instant it runs, placed where an await can follow it.
   * A fourth caller would have been the fourth hat, so the check moved to the
   * DOORS daemon work leaves through, and every path reaches one of them:
   *
   * - `open`, at the top of its loop. Every `workspace.open` this class issues
   *   goes through there, and re-asking each iteration covers the churned
   *   client, the armed backoff, and the queued `entry.opening` with one line.
   * - `operation(binding)`, which is the caller's own daemon work.
   *
   * TWO doors, not three. `run` used to ask a third time at its own entry
   * (r15's gate), and once the doors existed that call could be deleted with
   * every r15 test still red under its own mutation — the open door answers
   * first, whether the caller waited on a closing entry or nothing at all. A
   * check nothing can fail is not a gate.
   *
   * Outside a region this does nothing: work that is not abandonable keeps
   * retrying at quit on purpose, because an accepted write must not be
   * dropped.
   */
  private assertRegionLive(workspaceId: string): void {
    const budget = this.activeBudget();
    if (budget === undefined) return;
    if (this.shuttingDown) throw new EngineWorkspaceShuttingDownError();
    // A healthy attempt costs the budget nothing, however long it took, so a
    // region that has not failed yet is never refused for time alone.
    this.throwPastRetryDeadline(workspaceId, budget.lastError);
  }

  // The one deadline gate every retry ladder consults, on both sides of its
  // backoff: once the ambient budget is spent, no new attempt starts — in any
  // ladder, on any path. A run outside a region is not bounded here, and that
  // is deliberate: only work a caller marked abandonable may be abandoned.
  private throwPastRetryDeadline(workspaceId: string, cause: unknown): void {
    const budget = this.activeBudget();
    if (budget === undefined || budget.failedAtMs === null) return;
    const now = this.now();
    const spentMs = now - budget.failedAtMs;
    if (spentMs < budget.budgetMs) return;
    throw new EngineWorkspaceRetryDeadlineError(
      workspaceId,
      "withRetryBudget budgetMs",
      budget.budgetMs,
      "since the first failure",
      spentMs,
      // The whole hold, first attempt included. `spentMs` deliberately
      // excludes it — that is what stops a slow healthy open being charged —
      // so it cannot also answer "how long was the chain held".
      now - budget.startedAtMs,
      // The REGION's count, not one ladder's: the budget spans several runs,
      // each of which restarts `attempt` at 1.
      budget.failedAttempts,
      cause,
    );
  }

  /**
   * What happens after ONE failed attempt, for every ladder that has them:
   * the operation retries, the open ladder, and the client-churn loop.
   *
   * The gates used to be applied by each ladder remembering to apply them,
   * and the churn loop forgot one — its terminal throw ran ahead of the
   * deadline check, so a churn-exhausted open past its budget rejected with
   * `EngineWorkspaceRebindError`. Main maps only the deadline error to the
   * read-only retry surface, so that downgraded an engine-owned document to
   * the writable plain editor: the disk/Y.Doc race the budget exists to
   * prevent (#564, codex). One method owns the sequence now — a fourth ladder
   * either asks here or is visibly hand-rolling gates it should not.
   *
   * Throws `EngineWorkspaceRetryDeadlineError` when a deadline is spent,
   * including on the LAST allowed attempt, which can start inside the budget
   * and finish outside it. Returns "stop" when the ladder must give up with
   * its own terminal error, "retry" when it may start another attempt.
   *
   * The CALLER decides whether a failure is retryable at all: a permission
   * refusal is not a timeout however long the caller waited.
   */
  private async settleAttempt(gate: {
    workspaceId: string;
    attempt: number;
    lastAttempt: boolean;
    // Transport retries wait; an `afterReconnect` retry takes no backoff at
    // all, and used to skip these gates entirely because of it.
    backoff: boolean;
    cause: unknown;
  }): Promise<"retry" | "stop"> {
    const checkDeadline = (): void => {
      this.throwPastRetryDeadline(gate.workspaceId, gate.cause);
    };
    if (gate.lastAttempt) {
      checkDeadline();
      return "stop";
    }
    // At quit a BOUNDED region's failure is final: free the caller in one
    // attempt rather than spend the budget on a daemon that is not coming
    // back.
    //
    // Only a bounded region. `beginShutdown` is a global flag doing a scoped
    // job, and the scope is the document OPEN — the one thing #564 asked to
    // stop waiting on, and the one thing safe to abandon, because an opening
    // document is read-only (#533) and holds no edit. Work outside a region
    // is the opposite obligation: an already-open document retrying a journal
    // write holds the user's only copy in its canonical Y.Doc, and abandoning
    // that retry discards the edit while `closeAllEngineYDocSessions` swallows
    // the failure (#564, codex P1). An open that cannot finish is abandoned;
    // a write already accepted is not.
    //
    const abandonable = this.activeBudget() !== undefined;
    if (this.shuttingDown && abandonable) {
      return "stop";
    }
    checkDeadline();
    if (!gate.backoff) return "retry";
    // Reaching here at quit means this run is OUTSIDE a bounded region: a
    // write the engine already accepted, racing the forced exit. It KEEPS its
    // backoff. Retrying at once looked like the way to win that race and was
    // the opposite (#564, codex r17): the daemon it is racing is relaunching,
    // so a burst of immediate attempts all fail inside that window, the close
    // fails, `closeAllEngineYDocSessions` swallows it, and the edit goes with
    // the exit. Pacing is what lets the second attempt find a daemon.
    //
    // The cancel is registered for abandonable work ONLY, for the same
    // reason: `beginShutdown` resolving this sleep would put the burst back.
    // Checked on BOTH sides of the wait: an attempt that ends just inside the
    // deadline must not ride the backoff over the line and then start a fresh
    // open on a spent budget.
    await this.interruptibleSleep(
      transportBackoffMs(gate.attempt),
      abandonable,
    );
    // Same scope as before the wait: quit ends a bounded region's retries, and
    // only a bounded region's.
    if (this.shuttingDown && this.activeBudget() !== undefined) {
      return "stop";
    }
    checkDeadline();
    return "retry";
  }

  // `cancellable` marks a wait that quit may end: an abandonable region's.
  // A wait for work that must not be abandoned runs its full backoff, because
  // the daemon it is waiting for is the one that has to answer.
  private async interruptibleSleep(
    delayMs: number,
    cancellable: boolean,
  ): Promise<void> {
    if (!cancellable) {
      await this.sleep(delayMs);
      return;
    }
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolveCancel) => {
      cancel = resolveCancel;
    });
    this.sleepCancels.add(cancel);
    try {
      await Promise.race([this.sleep(delayMs), cancelled]);
    } finally {
      this.sleepCancels.delete(cancel);
    }
  }

  rememberCaptureAuthor(workspaceId: string, author: AgentAuthor | null): void {
    this.captureAuthors.set(workspaceId, author);
  }

  rememberShareMount(workspaceId: string): void {
    this.shareMounts.add(workspaceId);
  }

  beginRebuild(workspaceId: string): void {
    this.rebuildingWorkspaces.add(workspaceId);
  }

  endRebuild(workspaceId: string): void {
    this.rebuildingWorkspaces.delete(workspaceId);
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    this.captureAuthors.delete(workspaceId);
    this.shareMounts.delete(workspaceId);
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    if (entry.closing) {
      await entry.closing;
      return;
    }

    const closing = this.closeEntry(entry);
    entry.closing = closing;
    try {
      await closing;
    } finally {
      if (entry.closing === closing) entry.closing = null;
      if (this.entries.get(workspaceId) === entry) {
        this.entries.delete(workspaceId);
      }
    }
  }

  async closeAll(): Promise<void> {
    this.acceptingRuns = false;
    const workspaceIds = [...this.entries.keys()];
    await Promise.allSettled(
      workspaceIds.map(async (workspaceId) => {
        await this.closeWorkspace(workspaceId);
      }),
    );
  }

  private entry(workspaceId: string): SessionEntry {
    let entry = this.entries.get(workspaceId);
    if (!entry) {
      entry = {
        binding: null,
        opening: null,
        closing: null,
        activeRuns: 0,
        idleWaiters: new Set(),
      };
      this.entries.set(workspaceId, entry);
    }
    return entry;
  }

  private async acquire(workspaceId: string): Promise<SessionEntry> {
    for (;;) {
      if (!this.acceptingRuns) {
        throw new EngineWorkspaceSessionsClosedError();
      }
      if (this.rebuildingWorkspaces.has(workspaceId)) {
        throw new EngineWorkspaceRebuildingError(workspaceId);
      }
      const entry = this.entry(workspaceId);
      if (entry.closing) {
        await entry.closing;
        continue;
      }
      entry.activeRuns += 1;
      return entry;
    }
  }

  private release(entry: SessionEntry): void {
    entry.activeRuns -= 1;
    if (entry.activeRuns !== 0) return;
    const waiters = [...entry.idleWaiters];
    entry.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private async waitForIdle(entry: SessionEntry): Promise<void> {
    if (entry.activeRuns === 0) return;
    await new Promise<void>((resolveIdle) => {
      entry.idleWaiters.add(resolveIdle);
    });
  }

  private async closeEntry(entry: SessionEntry): Promise<void> {
    await this.waitForIdle(entry);
    let binding = entry.binding;
    if (!binding && entry.opening) {
      binding = await entry.opening.promise.catch(() => null);
    }
    entry.binding = null;
    entry.opening = null;
    if (binding) await this.closeBinding(binding);
  }

  private async openForRun(
    workspace: EngineWorkspace,
    entry: SessionEntry,
    options: EngineWorkspaceRunOptions,
    rebindStarted: boolean,
  ): Promise<EngineWorkspaceBinding> {
    const maxAttempts = options.retryTransportErrors
      ? this.transportRebindAttempts
      : 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.open(workspace, entry, options);
      } catch (error) {
        if (error instanceof EngineWorkspaceRebindError) throw error;
        // A region's terminal refusals are not ladder failures: counting one
        // would put a phantom attempt on the budget and could start its clock
        // on something that never touched the daemon. The door above raises
        // both, so both leave through here untouched. (Structural: with the
        // region gates in place, a quit refusal cannot reach the wrapping
        // branch below, so no test can tell the wrap from the rethrow.)
        if (isEngineWorkspaceOpenRefusedError(error)) throw error;
        lastError = error;
        this.noteBudgetAttempt(error);
        // EVERY retry decision this ladder makes settles here, including the
        // ones for errors it re-opens immediately. Gating only the
        // "daemon may be relaunching" errors left a bare `continue` behind it,
        // and that is the door an `afterBackoff` refusal walked through: six
        // immediate opens, no deadline, no shutdown, and no backoff against
        // an overload the daemon had just declared. A daemon-down open is
        // also where a caller can spend a whole ladder holding the capture
        // chain, which is what #564 is about.
        const next = await this.settleAttempt({
          workspaceId: workspace.workspaceId,
          attempt,
          lastAttempt: attempt >= maxAttempts,
          // Wait only when the error asks for it: the daemon may be
          // relaunching, or it requested backoff itself. Anything else
          // re-opens at once, as it always has.
          backoff: daemonMayBeRelaunching(error) || requiresBackoff(error),
          cause: error,
        });
        if (next === "stop") break;
      }
    }
    if (rebindStarted) {
      throw new EngineWorkspaceRebindError(workspace.workspaceId, lastError);
    }
    throw lastError;
  }

  private async open(
    workspace: EngineWorkspace,
    entry: SessionEntry,
    options: EngineWorkspaceRunOptions,
  ): Promise<EngineWorkspaceBinding> {
    for (let attempt = 1; ; attempt += 1) {
      // The door. Every workspace.open this class issues passes here, so this
      // is where the region's invariant is enforced rather than at each of the
      // awaits that can precede it.
      this.assertRegionLive(workspace.workspaceId);
      const client = this.source.currentClient();
      if (entry.binding?.client === client) return entry.binding;
      if (entry.binding?.client !== client) entry.binding = null;
      if (entry.opening?.client === client) return await entry.opening.promise;

      const promise = this.openWithClient(client, workspace);
      entry.opening = { client, promise };
      let binding: EngineWorkspaceBinding;
      try {
        binding = await promise;
      } finally {
        if (entry.opening?.promise === promise) entry.opening = null;
      }
      if (this.source.currentClient() !== client) {
        // NOT awaited, and that is the point. This is cleanup for a client
        // generation nobody will use again: no caller reads its result, and
        // the `.catch` already says failure is acceptable. Awaiting it put a
        // daemon request with no deadline BETWEEN two doors — a stale client
        // that is connected but unresponsive held the region here, past its
        // budget and past quit, with the gates one line away (#564, codex
        // r19). The doors bound what STARTS; nothing may block the region
        // between them either.
        void this.closeBinding(binding).catch(() => undefined);
        // A churned open is a failed daemon attempt the budget paid for. Left
        // uncounted, a wait this ladder caused reported "across 0 attempts".
        this.noteBudgetAttempt();
        const lastAttempt = attempt >= this.transportRebindAttempts;
        // The client-churn ladder settles like every other ladder (#564,
        // codex): without these gates, churning generations held a caller
        // through six full opens — past its deadline and past quit.
        const churn = new Error(
          "Rust engine client changed while opening the workspace.",
        );
        const next = await this.settleAttempt({
          workspaceId: workspace.workspaceId,
          attempt,
          lastAttempt,
          backoff: true,
          cause: churn,
        });
        if (next === "stop") {
          throw new EngineWorkspaceRebindError(
            workspace.workspaceId,
            lastAttempt
              ? new Error("Rust engine client changed on every open attempt.")
              : churn,
          );
        }
        continue;
      }
      entry.binding = binding;
      return binding;
    }
  }

  private async openWithClient(
    client: EngineDaemonClient,
    workspace: EngineWorkspace,
  ): Promise<EngineWorkspaceBinding> {
    await this.prepareWorkspace(workspace.rootPath);
    const requester = new WorkspaceDaemonRequester(client);
    const hasCaptureAuthor = this.captureAuthors.has(workspace.workspaceId);
    const shareMount =
      workspace.shareMount === true || this.shareMounts.has(workspace.workspaceId);
    const captureDisabled = shareMount || workspace.captureMode === "none";
    const raw = await requester.request(
      WORKSPACE_METHOD.open,
      {
        rootDir: workspace.rootPath,
        workspaceId: workspace.workspaceId,
        // The desktop recovery sweep owns user-visible crash reconciliation.
        // A daemon-side open must therefore preserve running claims on both a
        // fresh desktop boot and a sidecar-only rebind.
        recoverRunningDispatches: false,
        ...(captureDisabled ? { captureMode: "none" as const } : {}),
        ...(!captureDisabled && hasCaptureAuthor
          ? {
              captureAuthor:
                this.captureAuthors.get(workspace.workspaceId) ?? null,
            }
          : {}),
      },
      { deadlineMs: this.workspaceOpenDeadlineMs },
    );
    const opened = decodeWorkspaceResult(WORKSPACE_METHOD.open, raw);
    return { client, workspace: opened.workspace as WorkspaceHandle };
  }

  private async prepareWorkspace(rootPath: string): Promise<void> {
    let preparation = this.preparations.get(rootPath);
    if (!preparation) {
      preparation = (async () => {
        const workspaceRoot = resolve(rootPath);
        const rootInfo = await lstat(workspaceRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
          throw new Error(
            `Rust engine workspace root must be a real directory: ${rootPath}.`,
          );
        }
        const realRoot = await realpath(workspaceRoot);
        const dohcDirectory = join(workspaceRoot, ".dohc");
        const markerDirectory = join(dohcDirectory, "engine");
        const markerPath = join(markerDirectory, "SHADOW_CLONE");
        await this.ensureRealDirectory(dohcDirectory, realRoot, DOHC_METADATA_GUARD);
        await this.ensureRealDirectory(markerDirectory, realRoot, DOHC_ENGINE_GUARD);
        try {
          await writeFile(markerPath, randomBytes(32).toString("hex"), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          const markerInfo = await lstat(markerPath);
          if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
            throw new Error(
              `Rust engine shadow marker must be a real file: ${markerPath}.`,
            );
          }
          const token = await readFile(markerPath, "utf8");
          if (!SHADOW_CLONE_TOKEN.test(token)) {
            throw new Error(
              `Rust engine shadow marker is invalid for ${rootPath}.`,
            );
          }
        }
      })();
      this.preparations.set(rootPath, preparation);
      const release = () => {
        if (this.preparations.get(rootPath) === preparation) {
          this.preparations.delete(rootPath);
        }
      };
      void preparation.then(release, release);
    }
    await preparation;
  }

  // Refuses through the shared .dohc guard copy, so this surface says what
  // the desktop and the MCP server say (#612). It used to answer "must not be
  // a symlink" for a plain file, and print the absolute host path back at the
  // user.
  //
  // Presence-keyed, not errno-keyed: EEXIST is what a file squat raises, but a
  // DANGLING symlink squat raises ENOENT, which the old isAlreadyExists
  // allowlist rethrew as a bare errno. When something is at the path, the
  // checks below name it; when nothing is, the mkdir itself failed.
  private async ensureRealDirectory(
    directory: string,
    realRoot: string,
    guard: DohcPathGuard,
  ): Promise<void> {
    try {
      await mkdir(directory);
    } catch (error) {
      if (!(await lstat(directory).catch(() => null))) throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(notARealFolderRefusal(guard, info));
    }
    const resolvedDirectory = await realpath(directory);
    const escape = relative(realRoot, resolvedDirectory);
    if (
      escape === ".." ||
      escape.startsWith(`..${sep}`) ||
      isAbsolute(escape)
    ) {
      throw new Error(outsideWorkspaceRefusal(guard));
    }
  }

  private async closeBinding(binding: EngineWorkspaceBinding): Promise<void> {
    const requester = new WorkspaceDaemonRequester(binding.client);
    const raw = await requester.request(
      WORKSPACE_METHOD.close,
      {},
      { workspace: binding.workspace },
    );
    decodeWorkspaceResult(WORKSPACE_METHOD.close, raw);
  }
}
