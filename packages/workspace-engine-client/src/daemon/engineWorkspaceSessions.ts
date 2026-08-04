import {
  DaemonRefusalError,
  isDaemonReconnectError,
  WorkspaceDaemonRequester,
} from "../live/daemonLiveAdapter";
import type { AgentAuthor } from "../versioned/versionedWireContract";
import {
  WORKSPACE_METHOD,
  decodeWorkspaceResult,
} from "../workspace/workspaceWireContract";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";
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
  /**
   * Stop retrying transport errors once this many milliseconds have passed
   * since the run started (#564). The deadline gates RETRIES only: a healthy
   * first attempt is never rejected, and an attempt already in flight always
   * finishes. Expiry throws EngineWorkspaceRetryDeadlineError with the last
   * transport error as its cause. Callers that hold a shared resource while
   * they wait — the capture chain's document open — pass this so one open
   * cannot spend the full six-attempt ladder holding everyone else off.
   */
  retryDeadlineMs?: number;
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
// Exported so a caller deriving a retryDeadlineMs can budget whole recovery
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

// A retry limit was reached: the run stopped STARTING retries. The last
// failure rides as the cause.
//
// `constraint` is the name of the option the CALLER actually set, because two
// different limits reach here and an agent has to be able to find the one that
// fired. Naming `retryDeadlineMs` for a region budget pointed readers at an
// option with no production caller (#564, codex).
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
  readonly attempts: number;

  constructor(
    workspaceId: string,
    constraint: string,
    limitMs: number,
    // What the limit is timed from, in words: the reader has to know which
    // interval the number above is, or the two durations look contradictory.
    measuredFrom: string,
    measuredMs: number,
    totalWaitedMs: number,
    attempts: number,
    cause: unknown,
  ) {
    super(
      `Rust engine stopped retrying for workspace ${workspaceId}. ` +
        `The ${constraint} limit of ${limitMs}ms was reached: ` +
        `${measuredMs}ms ${measuredFrom}. ` +
        `The caller waited ${totalWaitedMs}ms in total, across ${attempts} attempts. ` +
        `Retry the operation, or wait for the daemon to come back.`,
      { cause },
    );
    this.name = "EngineWorkspaceRetryDeadlineError";
    this.workspaceId = workspaceId;
    this.constraint = constraint;
    this.limitMs = limitMs;
    this.measuredMs = measuredMs;
    this.totalWaitedMs = totalWaitedMs;
    this.attempts = attempts;
  }
}

export function isEngineWorkspaceRetryDeadlineError(
  error: unknown,
): error is EngineWorkspaceRetryDeadlineError {
  return error instanceof EngineWorkspaceRetryDeadlineError;
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
// Both mean the same thing to the surface — the engine did not open this
// document, and may still own it — so both keep it read-only (#533/#564).
export function isEngineWorkspaceOpenRefusedError(error: unknown): boolean {
  return (
    error instanceof EngineWorkspaceRetryDeadlineError ||
    error instanceof EngineWorkspaceShuttingDownError
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
  // (`withRetryBudget`). A per-run `retryDeadlineMs` bounds one run; this
  // bounds every run the region makes, together — which is what a caller
  // holding a shared resource across several daemon calls actually needs.
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
    // Failed attempts across every run the region made, because the region
    // is what the budget spans: a per-run counter resets on each `run` and
    // would report "across 1 attempts" for a wait that covered six.
    attempts: number;
  }>();

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
    // Same discipline as workspaceOpenDeadlineMs above: reject an invalid
    // value rather than quietly voiding the bound it exists to preserve.
    const retryDeadlineMs = options.retryDeadlineMs;
    if (
      retryDeadlineMs !== undefined &&
      (!Number.isInteger(retryDeadlineMs) ||
        retryDeadlineMs <= 0 ||
        retryDeadlineMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new TypeError(
        `retryDeadlineMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}, received ${String(retryDeadlineMs)}.`,
      );
    }
    const startedAtMs = this.now();
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
          startedAtMs,
        );
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
          const retryable = retryAfterReconnect || retryAfterTransport;
          this.noteBudgetAttempt();
          // A failure this ladder will not retry never reaches the gates: a
          // permission refusal is not a timeout however long we waited.
          if (!retryable) throw error;
          rebindStarted = true;
          lastError = error;
          const next = await this.settleAttempt({
            workspaceId: workspace.workspaceId,
            retryDeadlineMs,
            startedAtMs,
            attempt,
            lastAttempt: attempt >= maxAttempts,
            backoff: retryAfterTransport,
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
    // workspace call, and proceed into a `ydoc.open` that carries no deadline
    // — holding the chain through the 3 s forced-exit timer (#564, codex).
    // Nothing user-visible is lost: a bounded region is the abandonable kind
    // by construction, and an opening document is read-only (#533).
    if (this.shuttingDown) throw new EngineWorkspaceShuttingDownError();
    return await this.retryBudgets.run(
      { budgetMs, failedAtMs: null, startedAtMs: this.now(), attempts: 0 },
      task,
    );
  }

  // One failed daemon attempt, counted on the ambient budget so the refusal
  // can report what the WAIT actually cost rather than one ladder's share.
  // The first failure also starts the budget's clock: see `failedAtMs`.
  private noteBudgetAttempt(): void {
    const budget = this.retryBudgets.getStore();
    if (budget === undefined) return;
    budget.attempts += 1;
    budget.failedAtMs ??= this.now();
  }

  // The one deadline gate every retry ladder consults, on both sides of its
  // backoff: once a deadline is spent, no new attempt starts — in any
  // ladder, on any path. Two can apply: the ambient region budget, and this
  // run's own. Whichever is spent first stops the ladder.
  private throwPastRetryDeadline(
    workspaceId: string,
    retryDeadlineMs: number | undefined,
    startedAtMs: number,
    attempt: number,
    cause: unknown,
  ): void {
    const now = this.now();
    const budget = this.retryBudgets.getStore();
    if (budget !== undefined && budget.failedAtMs !== null) {
      const spentMs = now - budget.failedAtMs;
      if (spentMs >= budget.budgetMs) {
        throw new EngineWorkspaceRetryDeadlineError(
          workspaceId,
          // The option the caller actually set, not the per-run one it did
          // not pass.
          "withRetryBudget budgetMs",
          budget.budgetMs,
          "since the first failure",
          spentMs,
          // The whole hold, first attempt included. `spentMs` deliberately
          // excludes it — that is what stops a slow healthy open being
          // charged — so it cannot also answer "how long was the chain held".
          now - budget.startedAtMs,
          // The REGION's count, not this ladder's: the budget spans several
          // runs, each of which restarts `attempt` at 1.
          budget.attempts,
          cause,
        );
      }
    }
    if (retryDeadlineMs === undefined) return;
    const waitedMs = now - startedAtMs;
    if (waitedMs < retryDeadlineMs) return;
    throw new EngineWorkspaceRetryDeadlineError(
      workspaceId,
      "retryDeadlineMs",
      retryDeadlineMs,
      // This limit IS timed from the start of the run, so the two durations
      // are the same interval here. Both are still reported, so the message
      // has one shape and a reader never has to guess which one is missing.
      "since the run started",
      waitedMs,
      waitedMs,
      attempt,
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
    retryDeadlineMs: number | undefined;
    startedAtMs: number;
    attempt: number;
    lastAttempt: boolean;
    // Transport retries wait; an `afterReconnect` retry takes no backoff at
    // all, and used to skip these gates entirely because of it.
    backoff: boolean;
    cause: unknown;
  }): Promise<"retry" | "stop"> {
    const checkDeadline = (): void => {
      this.throwPastRetryDeadline(
        gate.workspaceId,
        gate.retryDeadlineMs,
        gate.startedAtMs,
        gate.attempt,
        gate.cause,
      );
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
    // Cancelling the armed sleep stays global on purpose: outside a region it
    // makes the retry happen SOONER, which is what a caller racing the quit
    // timer needs.
    if (this.shuttingDown && this.retryBudgets.getStore() !== undefined) {
      return "stop";
    }
    checkDeadline();
    if (!gate.backoff) return "retry";
    // Reaching here at quit means this run is OUTSIDE a bounded region — the
    // branch above already stopped the regions. It is racing the quit timer to
    // finish a write that was already accepted, so it retries at once: a
    // backoff would spend the window it needs, and `beginShutdown` only ever
    // cancels the ONE armed sleep, so waiting again here could outlast the
    // quit entirely.
    if (this.shuttingDown) return "retry";
    // Checked on BOTH sides of the wait: an attempt that ends just inside the
    // deadline must not ride the backoff over the line and then start a fresh
    // open on a spent budget.
    await this.interruptibleSleep(transportBackoffMs(gate.attempt));
    // Same scope as before the wait: quit ends a bounded region's retries, and
    // only a bounded region's.
    if (this.shuttingDown && this.retryBudgets.getStore() !== undefined) {
      return "stop";
    }
    checkDeadline();
    return "retry";
  }

  private async interruptibleSleep(delayMs: number): Promise<void> {
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
    startedAtMs: number,
  ): Promise<EngineWorkspaceBinding> {
    const maxAttempts = options.retryTransportErrors
      ? this.transportRebindAttempts
      : 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.open(workspace, entry, options, startedAtMs);
      } catch (error) {
        if (error instanceof EngineWorkspaceRebindError) throw error;
        if (error instanceof EngineWorkspaceRetryDeadlineError) throw error;
        lastError = error;
        this.noteBudgetAttempt();
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
          retryDeadlineMs: options.retryDeadlineMs,
          startedAtMs,
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
    startedAtMs: number,
  ): Promise<EngineWorkspaceBinding> {
    for (let attempt = 1; ; attempt += 1) {
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
        await this.closeBinding(binding).catch(() => undefined);
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
          retryDeadlineMs: options.retryDeadlineMs,
          startedAtMs,
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
