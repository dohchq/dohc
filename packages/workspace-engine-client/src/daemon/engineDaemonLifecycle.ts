import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import type { CompletedDaemonBlob } from "../live/daemonLiveAdapter";
import type { Event } from "../ydoc/generated/Event";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";
import {
  createEngineClient,
  type EngineClientSpawnOptions,
} from "./engineClient";

const ENGINE_BINARY_RESOURCE_DIR = "workspace-engine";
const ENGINE_BINARY_BASENAME = "dohc-workspace-engine";
const ENGINE_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 2_000;
const DEFAULT_HEALTHY_RESET_MS = 30_000;
// Ten restarts inside ten minutes is a mean generation lifetime under 60s —
// twice DEFAULT_HEALTHY_RESET_MS, the point at which a generation is declared
// healthy. A daemon that keeps dying just past that threshold resets the
// attempt budget forever, so only this window can end it.
const DEFAULT_RESTART_WINDOW_MS = 600_000;
const DEFAULT_MAX_RESTARTS_PER_WINDOW = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
// Wedge detection. The restart path starts at process exit, so a daemon that
// is alive but not answering never reaches it. These probe for that silence.
//
// `engine.ping` takes no workspace, reads no store, and touches no disk, and a
// live daemon answers it even while saturated: the request supervisor resolves
// a queued request's own deadline BEFORE the request competes for an execution
// slot, and admission overflow refuses immediately. So only silence is
// evidence of a wedge — never a slow answer, and never a refusal.
const DEFAULT_PING_INTERVAL_MS = 30_000;
// A probe carries NO wire deadline, so the supervisor gives it the daemon's own
// `default_deadline` of 30s — the latest a live daemon can take to answer a
// probe it never gets an execution slot for. 45s is that bound plus 15s of
// egress headroom. The probe must not carry a deadline of its own: EngineClient
// arms a client-side timer for any request that has one, and that timer turns
// the very silence this looks for into a rejection, which reads as life.
//
// The 30s does NOT bound when the reply arrives, and no constant here could.
// A reply is queued on the daemon's single output channel, and `write_output`
// writes one whole item before it reads the next. The supervisor's deadline
// covers `run_job` only; the wait on that channel is untimed. The queue holds
// `OUTPUT_QUEUE_CAPACITY` = 64 ITEMS, counted without regard to size, and a
// control frame may reach `max_frame_bytes` = 8 MiB — so up to 512 MiB can sit
// ahead of a reply. `BlobEgressBudget` does not bound this: it reserves blob
// bytes only. Most responses are far smaller (`SINGLE_ROW_HARD_CAP_BYTES` is
// 700 KiB, page budgets 256 KiB), but `ydoc.open` and `ydoc.resync` carry a
// base64 state sized to fill a frame, so 64 of those reach the ceiling.
//
// That is why the expiry alone cannot be the test, and why raising it would
// not help: no timeout both survives 512 MiB of egress and still catches a
// wedge. The probe verdict reads inbound TRAFFIC instead. A probe stuck behind
// bulk output arrives with that output, and bytes for anybody prove the daemon
// is turning; a wedged daemon sends nothing to anyone. The expiry then measures
// what it can honestly measure — total silence.
//
// That traffic counts whenever it arrived SINCE THE LAST VERDICT, not only
// while a probe was racing. The next probe starts an interval after the
// previous one resolved, so probes do not tile the timeline: at production
// values a probe expires at 45s and its successor begins at 75s. A reply
// delivered at 50s — the likeliest late frame there is, being the expired
// probe's own — would fall in that gap and prove nothing.
//
// Scope: events count as traffic too. `event_forwarder` is a separate task
// pushing onto the same queue, so it can emit while no request is in flight.
// It is file-change driven, so an idle wedge still goes silent and is still
// caught; a workspace being edited only DEFERS the verdict, never loses it.
const DEFAULT_PING_EXPIRY_MS = 45_000;
// Three silent probes in a row. They are one interval apart and each waits out
// its own expiry, so a wedge verdict needs at least 2 intervals + 3 expiries —
// three and a half minutes of unbroken silence from a process that answers in
// milliseconds when it is well. One answer in that span clears the count.
const DEFAULT_MAX_PING_EXPIRIES = 3;
// A wedge cannot be counted like a crash, so it gets its own budget.
//
// The crash window asks for 10 exits inside 10 minutes. One wedge cycle is
// 3 intervals + 3 expiries = 225s by construction, so a 10-minute window can
// never hold more than 3 of them. Ten is unreachable, `healthyResetMs` (30s)
// is shorter than the cycle so the burst budget resets every generation too,
// and a daemon that wedges after every launch would restart forever — the
// exact failure this file exists to end.
//
// The deeper reason the shared contract does not fit: a crash is a SAMPLE and
// a wedge is already a VERDICT. Ten crashes are evidence because one crash
// might be a bad input. One wedge kill already cost three silent probes and
// about three and a half minutes of proven silence. When a FRESH process
// repeats that from a clean start, with no probe answered in between,
// restarting a third time is not a recovery plan — it is a loop. Two strikes
// is about 7.5 minutes of a workspace that has answered nothing.
//
// Any answered probe clears the streak, so a daemon that wedges once and then
// recovers is restarted, not condemned. The cap therefore bounds only an
// unbroken wedge streak: a daemon that wedges intermittently is restarted
// every time, by design. This file ends a daemon that stopped answering for
// good, not one that answers unreliably. A crash between two wedges does not
// clear the streak either — a process that exits answered nothing.
const DEFAULT_MAX_CONSECUTIVE_WEDGES = 2;

export interface EngineDaemonClient {
  sendRequest(request: Request): Promise<Response>;
  cancelRequest?(requestId: number): Promise<void>;
  onBlob?(handler: (blob: CompletedDaemonBlob) => void): () => void;
  onEvent?(handler: (event: Event) => void): () => void;
  close(): void;
  // Kill a daemon that stopped answering. `close` reports a deliberate
  // shutdown, which retry-enabled callers must NOT retry through; a wedge kill
  // is a replacement, which they must. A client that cannot tell the two apart
  // falls back to `close`.
  closeUnresponsive?(): void;
  // Frames received from the daemon, counting up. The wedge detector reads it
  // to tell a queued probe from a silent daemon.
  inboundActivity?(): number;
  waitForExit?(): Promise<void>;
}

export interface EngineDaemonLifecycleOptions {
  command: string;
  launch?: (options: EngineClientSpawnOptions) => Promise<EngineDaemonClient>;
  fileExists?: (path: string) => boolean;
  tokenFactory?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  maxRestarts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  healthyResetMs?: number;
  restartWindowMs?: number;
  maxRestartsPerWindow?: number;
  monotonicNowMs?: () => number;
  wallNowMs?: () => number;
  requestTimeoutMs?: number;
  pingIntervalMs?: number;
  pingExpiryMs?: number;
  maxPingExpiries?: number;
  maxConsecutiveWedges?: number;
  onFailure?: (error: Error, terminal: boolean) => void;
  // Fires once per launched-and-healthy daemon generation (the first launch
  // AND every restart). A capture event committed by a previous generation
  // can die with its transport before delivery, and the replacement's
  // baseline finds disk and manifest already agreeing — so no retry event is
  // ever generated. Consumers use this to invalidate state that daemon
  // events would otherwise keep fresh (e.g. the history timeline).
  onLaunch?: () => void;
}

export interface EngineBinaryPathOptions {
  isPackaged: boolean;
  appPath: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
}

interface InFlightLaunch {
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
}

export class EngineDaemonUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineDaemonUnavailableError";
  }
}

function engineBinaryName(platform: NodeJS.Platform): string {
  return `${ENGINE_BINARY_BASENAME}${platform === "win32" ? ".exe" : ""}`;
}

export function defaultEngineBinaryPath(
  options: EngineBinaryPathOptions,
): string {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  if (options.isPackaged) {
    if (!options.resourcesPath) {
      throw new EngineDaemonUnavailableError(
        "Electron resources path is unavailable for the packaged Rust engine.",
      );
    }
    return path.join(
      options.resourcesPath,
      ENGINE_BINARY_RESOURCE_DIR,
      engineBinaryName(platform),
    );
  }
  return path.resolve(
    options.appPath,
    "../..",
    "target",
    "debug",
    engineBinaryName(platform),
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// The restart window reaches the user through a dialog, so it is spoken in
// minutes there. Test-scale windows stay in milliseconds; no honest wording
// rounds 40ms to a minute.
function describeWindow(windowMs: number): string {
  const minutes = windowMs / 60_000;
  if (!Number.isInteger(minutes) || minutes < 1) return `${windowMs}ms`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function resultObject(
  response: Response,
  method: string,
): Record<string, JsonValue | undefined> {
  const result = response.result;
  if (result === null || Array.isArray(result) || typeof result !== "object") {
    throw new EngineDaemonUnavailableError(
      `Rust engine ${method} returned an invalid result.`,
    );
  }
  return result;
}

export class EngineDaemonLifecycle {
  private readonly options: EngineDaemonLifecycleOptions;
  private readonly launch: (
    options: EngineClientSpawnOptions,
  ) => Promise<EngineDaemonClient>;
  private readonly fileExists: (path: string) => boolean;
  private readonly tokenFactory: () => string;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly monotonicNowMs: () => number;
  private readonly wallNowMs: () => number;
  private client: EngineDaemonClient | null = null;
  private restartPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private launchGeneration = 0;
  private activeGeneration = 0;
  private nextRequestId = 1;
  private restartAttempts = 0;
  private restartTimestamps: { mono: number; wall: number }[] = [];
  private running = false;
  private stopping = false;
  private healthyResetTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pingExpiries = 0;
  // Inbound frames counted at the last probe verdict. It spans the gaps between
  // probes on purpose: the next probe does not start until `pingIntervalMs`
  // AFTER the previous one resolved, so a per-window baseline would discard
  // every frame that arrived in between — including a probe's own reply
  // delivered just after its expiry, which is the likeliest late frame there is.
  private activityBaseline: number | undefined;
  // Wedge kills with no probe answered since, across generations.
  private consecutiveWedges = 0;
  // A terminal verdict was reported. The kill it ordered still has an exit
  // coming, and that exit must not start another generation.
  private terminal = false;
  private readonly exitedGenerations = new Set<number>();
  private readonly inFlightLaunches = new Set<InFlightLaunch>();
  private readonly launchingClients = new Set<EngineDaemonClient>();
  private readonly workspaceRequestTails = new Map<string, Promise<void>>();
  private readonly eventHandlers = new Set<(event: Event) => void>();

  constructor(options: EngineDaemonLifecycleOptions) {
    this.options = options;
    this.launch = options.launch ?? createEngineClient;
    this.fileExists = options.fileExists ?? isFile;
    // The token is deliberately process-local and regenerated for every
    // launch. On Linux, another process owned by the same uid can inspect
    // /proc/<pid>/environ; the boundary here is other OS accounts. If the
    // threat model expands, replace this with an inherited fd or a 0600
    // create-exclusive file rather than persisting this token normally.
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("hex"));
    this.sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref();
        }));
    this.monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
    this.wallNowMs = options.wallNowMs ?? (() => Date.now());
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.stopping) {
      throw new EngineDaemonUnavailableError(
        "Rust engine lifecycle is already stopping.",
      );
    }
    await this.launchTracked();
  }

  async smokeWorkspace(
    rootDir: string,
    workspaceId: string,
  ): Promise<JsonValue> {
    const client = this.requireClient();
    return await this.smokeWorkspaceWithClient(client, rootDir, workspaceId);
  }

  async requestWorkspace(
    rootDir: string,
    workspaceId: string,
    method: string,
    params: Request["params"],
  ): Promise<JsonValue> {
    const previous = this.workspaceRequestTails.get(rootDir) ?? Promise.resolve();
    const request = previous
      .catch(() => undefined)
      .then(
        async () =>
          await this.requestWorkspaceOnce(
            rootDir,
            workspaceId,
            method,
            params,
          ),
      );
    const tail = request.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceRequestTails.set(rootDir, tail);
    try {
      return await request;
    } finally {
      if (this.workspaceRequestTails.get(rootDir) === tail) {
        this.workspaceRequestTails.delete(rootDir);
      }
    }
  }

  private async requestWorkspaceOnce(
    rootDir: string,
    workspaceId: string,
    method: string,
    params: Request["params"],
  ): Promise<JsonValue> {
    const client = this.requireClient();
    const opened = resultObject(
      await this.sendSmokeRequest(
        client,
        {
          id: this.requestId(),
          method: "workspace.open",
          params: {
            rootDir,
            workspaceId,
            recoverRunningDispatches: false,
            skipStartupMaintenance: true,
          },
        },
        "workspace.open",
      ),
      "workspace.open",
    );
    if (typeof opened.workspace !== "string" || opened.workspace.length === 0) {
      throw new EngineDaemonUnavailableError(
        "Rust engine workspace.open returned no workspace handle.",
      );
    }
    const workspace = opened.workspace as WorkspaceHandle;
    try {
      return (
        await this.sendSmokeRequest(
          client,
          {
            id: this.requestId(),
            method,
            workspace,
            params,
          },
          method,
        )
      ).result;
    } finally {
      // Best-effort release: the desktop closing the owner concurrently drops
      // this attachment daemon-side, and a close error thrown from a finally
      // would replace an already-obtained read result. The daemon reaps
      // attachments with their owner, so a missed close cannot leak.
      try {
        await this.sendSmokeRequest(
          client,
          {
            id: this.requestId(),
            method: "workspace.close",
            workspace,
            params: {},
          },
          "workspace.close",
        );
      } catch (error) {
        console.debug(
          `[engine-daemon] read-attach close failed (owner likely closed concurrently): ${String(error)}`,
        );
      }
    }
  }

  currentClient(): EngineDaemonClient {
    return this.requireClient();
  }

  // Daemon-initiated events, surviving restarts: handlers registered here are
  // fanned out from every client this lifecycle launches, so a consumer never
  // has to know the daemon was replaced.
  onEvent(handler: (event: Event) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopOnce();
    await this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.clearHealthyResetTimer();
    this.clearPingTimer();
    for (const launch of this.inFlightLaunches) {
      launch.abortController.abort();
    }
    const clients = new Set(this.launchingClients);
    if (this.client) clients.add(this.client);
    this.client = null;
    for (const client of clients) client.close();
    await Promise.allSettled(
      [...clients].map(async (client) => await client.waitForExit?.()),
    );
    await Promise.allSettled(
      [...this.inFlightLaunches].map(async ({ promise }) => await promise),
    );
    await this.restartPromise?.catch(() => undefined);
  }

  private async smokeWorkspaceWithClient(
    client: EngineDaemonClient,
    rootDir: string,
    workspaceId: string,
  ): Promise<JsonValue> {
    const opened = resultObject(
      await this.sendSmokeRequest(
        client,
        {
          id: this.requestId(),
          method: "workspace.open",
          params: { rootDir, workspaceId },
        },
        "workspace.open",
      ),
      "workspace.open",
    );
    if (typeof opened.workspace !== "string" || opened.workspace.length === 0) {
      throw new EngineDaemonUnavailableError(
        "Rust engine workspace.open returned no workspace handle.",
      );
    }
    const workspace = opened.workspace as WorkspaceHandle;
    try {
      const active = await this.sendSmokeRequest(
        client,
        {
          id: this.requestId(),
          method: "versions.active",
          workspace,
          params: {},
        },
        "versions.active",
      );
      return active.result;
    } finally {
      await this.sendSmokeRequest(
        client,
        {
          id: this.requestId(),
          method: "workspace.close",
          workspace,
          params: {},
        },
        "workspace.close",
      );
    }
  }

  private requestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }

  private requireClient(): EngineDaemonClient {
    if (!this.running || !this.client) {
      throw new EngineDaemonUnavailableError(
        "Rust engine daemon is not available.",
      );
    }
    return this.client;
  }

  private async sendSmokeRequest(
    client: EngineDaemonClient,
    request: Request,
    method: string,
  ): Promise<Response> {
    const timeoutMs =
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const boundedRequest = {
      ...request,
      deadlineMs: request.deadlineMs ?? timeoutMs,
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        void client.cancelRequest?.(request.id).catch(() => undefined);
        if (method === "workspace.open") client.close();
        reject(
          new EngineDaemonUnavailableError(
            `Rust engine ${method} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      timeout.unref();
    });
    try {
      return await Promise.race([client.sendRequest(boundedRequest), deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private assertBinaryPresent(): void {
    if (!this.fileExists(this.options.command)) {
      throw new EngineDaemonUnavailableError(
        `Rust engine binary not found: ${this.options.command}`,
      );
    }
  }

  private launchTracked(): Promise<void> {
    const abortController = new AbortController();
    const promise = this.launchOnce(abortController.signal);
    const launch: InFlightLaunch = { abortController, promise };
    this.inFlightLaunches.add(launch);
    void promise.then(
      () => this.inFlightLaunches.delete(launch),
      () => this.inFlightLaunches.delete(launch),
    );
    return promise;
  }

  private async launchOnce(signal: AbortSignal): Promise<void> {
    this.assertBinaryPresent();
    if (this.stopping) return;
    const generation = ++this.launchGeneration;
    this.activeGeneration = generation;
    const authToken = this.tokenFactory();
    let client: EngineDaemonClient;
    try {
      client = await this.launch({
        command: this.options.command,
        cwd: dirname(this.options.command),
        authToken,
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        capabilities: ["blobs"],
        signal,
        onExit: (code, signal) => {
          this.handleUnexpectedExit(generation, code, signal);
        },
      });
    } catch (error) {
      if (this.stopping) return;
      throw new EngineDaemonUnavailableError(
        "Rust engine failed its startup handshake.",
        { cause: error },
      );
    }
    this.launchingClients.add(client);
    // Attach the fan-out BEFORE the smoke: a capture event from a workspace
    // reopened early in the daemon's life must not be lost to subscription
    // ordering. The subscription dies with the client if this launch fails.
    client.onEvent?.((event) => {
      for (const handler of this.eventHandlers) handler(event);
    });
    try {
      if (this.stopping || this.exitedGenerations.has(generation)) {
        await this.closeClient(client);
        if (this.stopping) return;
        throw new EngineDaemonUnavailableError(
          "Rust engine exited during its startup handshake.",
        );
      }
      await runEngineDaemonSmoke(async (rootDir, workspaceId) =>
        await this.smokeWorkspaceWithClient(client, rootDir, workspaceId),
      );
      if (this.stopping || this.exitedGenerations.has(generation)) {
        await this.closeClient(client);
        if (this.stopping) return;
        throw new EngineDaemonUnavailableError(
          "Rust engine exited during its startup health check.",
        );
      }
      this.client = client;
      this.running = true;
      this.scheduleHealthyReset(generation);
      this.startWedgeWatch(generation, client);
      try {
        this.options.onLaunch?.();
      } catch {
        // A launch observer must never fail the launch itself.
      }
    } catch (error) {
      await this.closeClient(client);
      if (this.stopping) return;
      throw error;
    } finally {
      this.launchingClients.delete(client);
    }
  }

  private async closeClient(client: EngineDaemonClient): Promise<void> {
    client.close();
    await client.waitForExit?.();
  }

  private handleUnexpectedExit(
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.exitedGenerations.add(generation);
    if (
      this.stopping ||
      !this.running ||
      generation !== this.activeGeneration
    ) {
      return;
    }
    this.clearHealthyResetTimer();
    this.clearPingTimer();
    this.running = false;
    this.client = null;
    // A terminal wedge already reported its verdict and then ordered this kill.
    // Tear the generation down, but do not relaunch what was just condemned.
    if (this.terminal) return;
    const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    const exitError = new EngineDaemonUnavailableError(
      `Rust engine daemon exited unexpectedly with ${detail}.`,
    );
    this.reportFailure(exitError, false);
    if (!this.restartPromise) {
      this.restartPromise = this.restartAfterExit(exitError).finally(() => {
        this.restartPromise = null;
      });
      void this.restartPromise.catch(() => undefined);
    }
  }

  private async restartAfterExit(exitError: Error): Promise<void> {
    const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    // One entry per crash, not per launch attempt: the attempts inside a
    // single crash are what `maxRestarts` already bounds, and counting them
    // here would spend the window on one crash the daemon recovered from.
    this.recordCrash(exitError);
    let lastError: Error = exitError;
    while (this.restartAttempts < maxRestarts) {
      const attempt = ++this.restartAttempts;
      const delay = Math.min(
        (this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS) *
          2 ** (attempt - 1),
        this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      );
      if (delay > 0) await this.sleep(delay);
      if (this.stopping) return;
      try {
        await this.launchTracked();
        return;
      } catch (error) {
        if (this.stopping) return;
        lastError = asError(error);
        this.reportFailure(lastError, false);
      }
    }
    const terminal = new EngineDaemonUnavailableError(
      `Rust engine restart limit exceeded after ${maxRestarts} attempts.`,
      { cause: lastError },
    );
    this.reportFailure(terminal, true);
    throw terminal;
  }

  // Throws the terminal failure when this crash is one too many for the
  // window. `restartAttempts` bounds a burst and a healthy generation resets
  // it, so only this window can end a daemon that dies just past
  // healthyResetMs over and over.
  private recordCrash(exitError: Error): void {
    const windowMs = this.options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    const maxPerWindow =
      this.options.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS_PER_WINDOW;
    // Neither clock survives both failure modes alone, so an entry expires
    // when EITHER says it is older than the window. A backwards wall step
    // (NTP, VM adjust) under-ages entries the monotonic side still expires; a
    // host suspend stops the monotonic clock, and the wall side expires the
    // entries that slept through the window.
    const mono = this.monotonicNowMs();
    const wall = this.wallNowMs();
    this.restartTimestamps = this.restartTimestamps.filter(
      (at) => at.mono > mono - windowMs && at.wall > wall - windowMs,
    );
    if (this.restartTimestamps.length >= maxPerWindow) {
      const window = describeWindow(windowMs);
      const terminal = new EngineDaemonUnavailableError(
        `The Rust engine crashed again after ${this.restartTimestamps.length} restarts in the last ${window}. The limit is ${maxPerWindow} restarts per ${window}. dohc stopped restarting it.`,
        { cause: exitError },
      );
      this.reportFailure(terminal, true);
      throw terminal;
    }
    this.restartTimestamps.push({ mono, wall });
  }

  private scheduleHealthyReset(generation: number): void {
    this.clearHealthyResetTimer();
    const healthyResetMs =
      this.options.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS;
    this.healthyResetTimer = setTimeout(() => {
      this.healthyResetTimer = null;
      if (
        this.running &&
        !this.stopping &&
        generation === this.activeGeneration
      ) {
        this.restartAttempts = 0;
      }
    }, healthyResetMs);
    this.healthyResetTimer.unref();
  }

  private clearHealthyResetTimer(): void {
    if (!this.healthyResetTimer) return;
    clearTimeout(this.healthyResetTimer);
    this.healthyResetTimer = null;
  }

  // Watch one live generation for a wedge: a process that is still running but
  // has stopped answering. Every generation starts its own watch with a fresh
  // count, so silence from a daemon that was already replaced cannot carry over.
  private startWedgeWatch(
    generation: number,
    client: EngineDaemonClient,
  ): void {
    this.pingExpiries = 0;
    this.activityBaseline = client.inboundActivity?.();
    this.schedulePing(generation, client);
  }

  private schedulePing(generation: number, client: EngineDaemonClient): void {
    this.clearPingTimer();
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      void this.probeOnce(generation, client);
    }, this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private clearPingTimer(): void {
    if (!this.pingTimer) return;
    clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  // A probe counts only against the generation that is CURRENT, running, and
  // still owns the client it was scheduled for. While a restart is in flight
  // `running` is false, so a daemon that is merely being replaced is never
  // probed and can never be called wedged.
  private probedGenerationIsLive(
    generation: number,
    client: EngineDaemonClient,
  ): boolean {
    return (
      this.running &&
      !this.stopping &&
      this.client === client &&
      generation === this.activeGeneration &&
      !this.exitedGenerations.has(generation)
    );
  }

  private async probeOnce(
    generation: number,
    client: EngineDaemonClient,
  ): Promise<void> {
    if (!this.probedGenerationIsLive(generation, client)) return;
    const answered = await this.sendPing(client);
    // Re-check: the daemon can exit, or be replaced, while a probe is pending.
    if (!this.probedGenerationIsLive(generation, client)) return;
    // Traffic is life. The daemon serializes ONE output queue, so a probe waits
    // behind whatever is already queued and cannot overtake it — its own reply
    // is a measure of queue depth, not of health. Frames for ANYBODY prove the
    // daemon is turning, and they count whenever they arrived since the last
    // verdict, not only while a probe happened to be racing. A reply delivered
    // just after its own probe expired is still proof the daemon is alive.
    const activity = client.inboundActivity?.();
    const sawTraffic =
      activity !== undefined &&
      this.activityBaseline !== undefined &&
      activity > this.activityBaseline;
    if (activity !== undefined) this.activityBaseline = activity;
    if (answered || sawTraffic) {
      this.pingExpiries = 0;
      // One answer ends a wedge streak, whichever generation it came from. A
      // daemon that wedged once and now replies is being recovered, not looped.
      this.consecutiveWedges = 0;
      this.schedulePing(generation, client);
      return;
    }
    this.pingExpiries += 1;
    const maxExpiries = this.options.maxPingExpiries ?? DEFAULT_MAX_PING_EXPIRIES;
    if (this.pingExpiries < maxExpiries) {
      this.schedulePing(generation, client);
      return;
    }
    this.reportWedge(client, maxExpiries);
  }

  // True when the daemon answered AT ALL: a pong, a deadline refusal for a
  // probe that queued behind real work, an overload refusal, or a transport
  // error. Each of those proves something in the daemon is still turning, and
  // a broken transport is already on its way to a kill. Only silence — nothing
  // back within the expiry bound — resolves false.
  //
  // The request carries no deadline ON PURPOSE. EngineClient arms its own timer
  // for any request that names one and rejects when it fires, so a wire
  // deadline would convert a wedged daemon's silence into a rejection this
  // reads as life, and the detector would never fire against the real client.
  private async sendPing(client: EngineDaemonClient): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // This resolves false for "no reply in time", which is not yet a verdict.
    // `probeOnce` decides, because liveness is judged on traffic seen since the
    // last verdict rather than inside this one window.
    const silence = new Promise<boolean>((resolve) => {
      timeout = setTimeout(
        () => resolve(false),
        this.options.pingExpiryMs ?? DEFAULT_PING_EXPIRY_MS,
      );
      timeout.unref();
    });
    const answer = client
      .sendRequest({
        id: this.requestId(),
        method: "engine.ping",
        params: {},
      })
      .then(
        () => true,
        () => true,
      );
    try {
      return await Promise.race([answer, silence]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private reportWedge(client: EngineDaemonClient, maxExpiries: number): void {
    this.clearPingTimer();
    this.pingExpiries = 0;
    this.consecutiveWedges += 1;
    const maxWedges =
      this.options.maxConsecutiveWedges ?? DEFAULT_MAX_CONSECUTIVE_WEDGES;
    const expiryMs = this.options.pingExpiryMs ?? DEFAULT_PING_EXPIRY_MS;
    const silence = `${maxExpiries} probes in a row expired after ${expiryMs}ms each with no frame of any kind from the engine`;
    // The crash window cannot end a wedge loop: one wedge cycle is longer than
    // a tenth of that window, so its count is unreachable by construction. A
    // wedge streak carries its own budget.
    const terminal = this.consecutiveWedges >= maxWedges;
    // Condemn, then kill, then report. Each step depends on the one before it.
    //
    // Condemn first because the kill becomes a process exit, and
    // `handleUnexpectedExit` reads `terminal` to decide whether to relaunch.
    // Setting it here does not depend on when that exit is delivered.
    if (terminal) this.terminal = true;
    // Kill before reporting because `reportFailure` runs consumer code: on a
    // terminal verdict the desktop app answers it with `dialog.showErrorBox`,
    // a modal that does not return until the user dismisses it. Killing after
    // that call would leave the wedged child alive for as long as the dialog
    // stands, while this lifecycle already called the engine gone.
    //
    // `closeUnresponsive` rejects everything in flight as a transport failure.
    // A plain `close` reports a deliberate shutdown, and retry-enabled callers
    // do not retry through one — they would stay failed across the very
    // restart this kill is starting.
    if (client.closeUnresponsive) client.closeUnresponsive();
    else client.close();
    this.reportFailure(
      new EngineDaemonUnavailableError(
        terminal
          ? `The Rust engine went silent on ${this.consecutiveWedges} launches: ${silence}. The limit is ${maxWedges} wedges with no traffic in between. dohc stopped restarting it.`
          : `The Rust engine is running but sent nothing: ${silence}. The limit is ${maxExpiries} probes with no traffic. dohc is restarting it.`,
      ),
      terminal,
    );
  }

  private reportFailure(error: Error, terminal: boolean): void {
    if (terminal) this.terminal = true;
    try {
      this.options.onFailure?.(error, terminal);
    } catch {
      // Failure reporting must never restart or crash the supervisor itself.
    }
  }
}

async function runEngineDaemonSmoke(
  smokeWorkspace: (rootDir: string, workspaceId: string) => Promise<JsonValue>,
): Promise<JsonValue> {
  const rootDir = await mkdtemp(join(tmpdir(), "dohc-rust-engine-smoke-"));
  try {
    const markerDirectory = join(rootDir, ".dohc", "engine");
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(
      join(markerDirectory, "SHADOW_CLONE"),
      randomBytes(32).toString("hex"),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return await smokeWorkspace(
      rootDir,
      `desktop-startup-smoke-${process.pid}`,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

export async function runEngineDaemonStartupSmoke(
  lifecycle: EngineDaemonLifecycle,
): Promise<JsonValue> {
  return await runEngineDaemonSmoke(async (rootDir, workspaceId) =>
    await lifecycle.smokeWorkspace(rootDir, workspaceId),
  );
}

export function createRustEngineDaemon(
  options: EngineDaemonLifecycleOptions,
): EngineDaemonLifecycle {
  return new EngineDaemonLifecycle(options);
}
