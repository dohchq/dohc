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
  // Test injection for the retryDeadlineMs clock; production uses Date.now.
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

// The retryDeadlineMs limit was reached: the run stopped STARTING transport
// retries. The last transport error rides as the cause.
export class EngineWorkspaceRetryDeadlineError extends Error {
  readonly workspaceId: string;

  constructor(
    workspaceId: string,
    retryDeadlineMs: number,
    waitedMs: number,
    attempts: number,
    cause: unknown,
  ) {
    super(
      `Rust engine stopped retrying the open for workspace ${workspaceId}: ` +
        `the retryDeadlineMs limit of ${retryDeadlineMs}ms was reached ` +
        `(waited ${waitedMs}ms across ${attempts} attempts). ` +
        `Retry the operation, or wait for the daemon to come back.`,
      { cause },
    );
    this.name = "EngineWorkspaceRetryDeadlineError";
    this.workspaceId = workspaceId;
  }
}

export function isEngineWorkspaceRetryDeadlineError(
  error: unknown,
): error is EngineWorkspaceRetryDeadlineError {
  return error instanceof EngineWorkspaceRetryDeadlineError;
}

function requiresReconnect(error: unknown): boolean {
  return (
    error instanceof DaemonRefusalError &&
    error.disposition === "afterReconnect"
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
    isTransportError(error) || error instanceof EngineDaemonUnavailableError
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

  constructor(
    private readonly source: EngineDaemonClientSource,
    options: EngineWorkspaceSessionsOptions = {},
  ) {
    this.transportRebindAttempts =
      options.transportRebindAttempts ?? TRANSPORT_REBIND_ATTEMPTS;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
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
          if (
            (!retryAfterReconnect && !retryAfterTransport) ||
            attempt >= maxAttempts
          ) {
            throw error;
          }
          rebindStarted = true;
          lastError = error;
          if (retryAfterTransport) {
            // Both gates bound WAITING, never a healthy first attempt: at
            // quit the failure is final, and past the caller's deadline the
            // run stops starting new backoff/attempt rounds (#564).
            if (this.shuttingDown) throw error;
            const waitedMs = this.now() - startedAtMs;
            if (retryDeadlineMs !== undefined && waitedMs >= retryDeadlineMs) {
              throw new EngineWorkspaceRetryDeadlineError(
                workspace.workspaceId,
                retryDeadlineMs,
                waitedMs,
                attempt,
                error,
              );
            }
            await this.interruptibleSleep(transportBackoffMs(attempt));
            if (this.shuttingDown) throw error;
          }
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
        return await this.open(workspace, entry);
      } catch (error) {
        if (error instanceof EngineWorkspaceRebindError) throw error;
        lastError = error;
        if (attempt >= maxAttempts) break;
        if (daemonMayBeRelaunching(error)) {
          // The same waiting gates as run()'s operation retries (#564): a
          // daemon-down open is the other place a caller can spend the whole
          // backoff ladder, and it holds the same resources.
          if (this.shuttingDown) break;
          const waitedMs = this.now() - startedAtMs;
          if (
            options.retryDeadlineMs !== undefined &&
            waitedMs >= options.retryDeadlineMs
          ) {
            throw new EngineWorkspaceRetryDeadlineError(
              workspace.workspaceId,
              options.retryDeadlineMs,
              waitedMs,
              attempt,
              error,
            );
          }
          await this.interruptibleSleep(transportBackoffMs(attempt));
          if (this.shuttingDown) break;
        }
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
        if (attempt >= this.transportRebindAttempts) {
          throw new EngineWorkspaceRebindError(
            workspace.workspaceId,
            new Error("Rust engine client changed on every open attempt."),
          );
        }
        await this.interruptibleSleep(transportBackoffMs(attempt));
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
