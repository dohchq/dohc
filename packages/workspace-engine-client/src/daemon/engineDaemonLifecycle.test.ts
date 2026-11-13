import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "../protocol";
import { type EngineClientSpawnOptions } from "./engineClient";
import {
  defaultEngineBinaryPath,
  EngineDaemonLifecycle,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";

const WAIT = { timeout: 15_000 } as const;

function probesSent(client: FakeClient | undefined): number {
  return client?.requests.filter((request) => request.method === "engine.ping").length ?? 0;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// The healthy window the restart-budget test configures; its wait is derived
// from this so the two can never drift apart.
const HEALTHY_RESET_MS = 20;

// Burst headroom for the rolling-window tests. `restartAttempts` counts every
// attempt, including the successful ones, and only the healthy-reset timer
// clears it — so a low maxRestarts makes those tests depend on a real timer
// firing between crashes, and a loaded run that delays it ends them on the
// burst terminal instead of the window terminal under test. None of them needs
// more than 6 attempts, so a budget this high can never fire and the window
// stays the only way they can reach terminal. The burst budget has its own
// tests above.
const WINDOW_TEST_MAX_RESTARTS = 10;

class FakeClient implements EngineDaemonClient {
  readonly requests: Request[] = [];
  readonly cancelledRequestIds: number[] = [];
  closed = false;
  // Which kill path ran. The real EngineClient rejects everything in flight
  // with this code, and a caller that retries through a relaunch reads it to
  // tell a replacement from a deliberate shutdown. A fake that only recorded
  // `closed = true` could not tell the two apart at all.
  closeCause: "closed" | "transport-error" | null = null;
  // Frames arriving from the daemon for ANYONE. Bulk egress advances this
  // while a probe waits behind it in the daemon's single output queue.
  inbound = 0;
  waitForExit?: () => Promise<void>;

  inboundActivity(): number {
    return this.inbound;
  }

  constructor(
    private readonly respond: (
      request: Request,
    ) => Response | Promise<Response> = (request) =>
      request.method === "workspace.open"
        ? { id: request.id, result: { workspace: "health-handle" } }
        : { id: request.id, result: null },
  ) {}

  private readonly outstanding = new Set<Request>();

  outstandingRequests(match: (request: Request) => boolean): number {
    return [...this.outstanding].filter(match).length;
  }

  async sendRequest(request: Request, _signal?: AbortSignal, _progress?: () => void, cancelSignal?: AbortSignal): Promise<Response> {
    const cancel = () => this.cancelledRequestIds.push(request.id);
    cancelSignal?.addEventListener("abort", cancel, {once: true});
    this.requests.push(request);
    this.outstanding.add(request);
    try {
      return await this.respond(request);
    } finally {
      cancelSignal?.removeEventListener("abort", cancel);
      this.outstanding.delete(request);
    }
  }

  close(): void {
    this.finishClose("closed");
  }

  closeUnresponsive(): void {
    this.finishClose("transport-error");
  }

  protected finishClose(cause: "closed" | "transport-error"): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCause = cause;
  }
}

function healthyPing(request: Request): Response {
  if (request.method === "workspace.open") {
    return { id: request.id, result: { workspace: "health-handle" } };
  }
  if (request.method === "engine.ping") {
    return { id: request.id, result: { ok: true } };
  }
  return { id: request.id, result: null };
}

// Alive, handshaked, serving the launch smoke — and silent on engine.ping.
// This is the wedge: nothing exits, so nothing in the restart path can see it.
function silentPing(request: Request): Response | Promise<Response> {
  if (request.method === "engine.ping") return new Promise<Response>(() => {});
  return healthyPing(request);
}

// A real client.close() ends the child's stdin and kills a child that ignores
// it; the resulting process exit is what reaches the lifecycle. This fake makes
// that same handoff, so a test can prove the wedge kill lands in the ordinary
// restart machinery.
class SelfExitingClient extends FakeClient {
  exit: EngineClientSpawnOptions["onExit"];

  protected override finishClose(
    cause: "closed" | "transport-error",
  ): void {
    if (this.closed) return;
    super.finishClose(cause);
    // A real child's "exit" is an event-loop delivery: node cannot dispatch it
    // inside the close() call that killed the process. Delivering it
    // synchronously here would let a fake reorder failure reports in a way the
    // real transport never can. A microtask keeps that ordering honest without
    // depending on fake timers.
    queueMicrotask(() => this.exit?.(null, "SIGTERM"));
  }
}

const scratchPaths: string[] = [];

function fakeBinary(): string {
  const directory = mkdtempSync(join(tmpdir(), "dohc-engine-lifecycle-test-"));
  scratchPaths.push(directory);
  const path = join(directory, "dohc-workspace-engine");
  writeFileSync(path, "test");
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

// The first launch's startup smoke runs behind start() now, so a test that
// resets `client.requests` after start() must let the smoke finish first or
// its tail requests bleed into the assertion window. workspace.close is the
// smoke's last request, and this fake answers synchronously on push — once
// the close is recorded, its response (and any fake state it mutates) has
// already settled.
async function startupSmokeDone(client: FakeClient): Promise<void> {
  await vi.waitFor(
    () =>
      expect(
        client.requests.some(
          (request) => request.method === "workspace.close",
        ),
      ).toBe(true),
    WAIT,
  );
}

describe("Rust engine daemon lifecycle", () => {
  it("generates a distinct auth token for every launch", async () => {
    const tokens: string[] = [];
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      initialBackoffMs: 0,
      launch: async (options) => {
        tokens.push(options.authToken);
        exits.push(options.onExit);
        return new FakeClient();
      },
    });

    await lifecycle.start();
    exits[0]?.(9, null);
    await vi.waitFor(() => expect(tokens).toHaveLength(2), WAIT);

    expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[1]).not.toBe(tokens[0]);
    await lifecycle.stop();
  });

  it("keeps the replacement client unavailable until previous hosts have stopped", async () => {
    const retiring = deferred();
    const retired = deferred();
    const published = deferred();
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const clients: FakeClient[] = [];
    let publications = 0;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      sleep: async () => undefined,
      launch: async (options) => {
        exits.push(options.onExit);
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
      beforePublish: async () => {
        if (clients.length === 1) return;
        retiring.resolve();
        await retired.promise;
      },
      onLaunch: () => {
        if (++publications === 2) published.resolve();
      },
    });
    try {
      await lifecycle.start();
      exits[0]?.(1, null);
      await retiring.promise;
      expect(() => lifecycle.currentClient()).toThrow("not available");
      expect(publications).toBe(1);
      retired.resolve();
      await published.promise;
      expect(lifecycle.currentClient()).toBe(clients[1]);
    } finally {
      retired.resolve();
      await lifecycle.stop();
    }
  });

  it("fails publication when retiring the previous hosts fails", async () => {
    const failure = new Error("host teardown failed");
    const client = new FakeClient();
    const onLaunch = vi.fn();
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
      beforePublish: async () => { throw failure; },
      onLaunch,
    });
    try {
      await expect(lifecycle.start()).rejects.toBe(failure);
      expect(client.closed).toBe(true);
      expect(onLaunch).not.toHaveBeenCalled();
      expect(() => lifecycle.currentClient()).toThrow("not available");
    } finally {
      await lifecycle.stop();
    }
  });

  it("bounds restart attempts when every replacement fails", async () => {
    let exit: EngineClientSpawnOptions["onExit"];
    let launchCount = 0;
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 3,
      initialBackoffMs: 0,
      launch: async (options) => {
        launchCount += 1;
        if (launchCount === 1) {
          exit = options.onExit;
          return new FakeClient();
        }
        throw new Error("replacement handshake failed");
      },
      onFailure: (_error, isTerminal) => {
        if (isTerminal) resolveTerminal();
      },
    });

    await lifecycle.start();
    exit?.(1, null);
    await terminal;
    expect(launchCount).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(launchCount).toBe(4);
    await lifecycle.stop();
  });


  it("resets the restart budget after a sustained healthy generation", async () => {
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    let live = 0;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 1,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      launch: async (options) => {
        exits.push(options.onExit);
        return new FakeClient();
      },
      onLaunch: () => {
        live += 1;
      },
    });

    try {
      await lifecycle.start();
      exits[0]?.(1, null);
      await vi.waitFor(() => expect(live).toBe(2), WAIT);
      // The budget-reset timer is armed just before onLaunch, so after the
      // wait above a wide multiple of the window lets it fire.
      await new Promise((resolve) => setTimeout(resolve, HEALTHY_RESET_MS * 10));
      exits[1]?.(1, null);
      await vi.waitFor(() => expect(exits).toHaveLength(3), WAIT);
    } finally {
      await lifecycle.stop();
    }
  });


  it("forgets restarts older than the rolling window", async () => {
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const terminalFailures: Error[] = [];
    let live = 0;
    const restartWindowMs = HEALTHY_RESET_MS * 2;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      restartWindowMs,
      maxRestartsPerWindow: 2,
      launch: async (options) => {
        exits.push(options.onExit);
        return new FakeClient();
      },
      onLaunch: () => {
        live += 1;
      },
      onFailure: (error, terminal) => {
        if (terminal) terminalFailures.push(error);
      },
    });

    try {
      await lifecycle.start();
      for (let generation = 0; generation < 3; generation += 1) {
        await vi.waitFor(() => expect(live).toBe(generation + 1), WAIT);
        await new Promise((resolve) => setTimeout(resolve, restartWindowMs * 4));
        exits[generation]?.(1, null);
      }

      await vi.waitFor(() => expect(live).toBe(4), WAIT);
      expect(exits).toHaveLength(4);
      expect(terminalFailures).toHaveLength(0);
    } finally {
      await lifecycle.stop();
    }
  });

  it("spends one window slot per crash, not per launch attempt", async () => {
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const terminalFailures: Error[] = [];
    let launchCount = 0;
    let live = 0;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      // 6 attempts here, the most of any window test — see the constant.
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      restartWindowMs: 120_000,
      maxRestartsPerWindow: 3,
      launch: async (options) => {
        launchCount += 1;
        // Every crash costs two attempts: the first replacement fails its
        // handshake, the second one takes.
        if (launchCount > 1 && launchCount % 2 === 0) {
          throw new Error("replacement handshake failed");
        }
        exits.push(options.onExit);
        return new FakeClient();
      },
      onLaunch: () => {
        live += 1;
      },
      onFailure: (error, terminal) => {
        if (terminal) terminalFailures.push(error);
      },
    });

    try {
      await lifecycle.start();
      for (let generation = 0; generation < 3; generation += 1) {
        // Crash only a healthy generation — see the restart-budget test.
        await vi.waitFor(() => expect(live).toBe(generation + 1), WAIT);
        await new Promise((resolve) => setTimeout(resolve, HEALTHY_RESET_MS * 10));
        exits[generation]?.(1, null);
      }
      await vi.waitFor(() => expect(live).toBe(4), WAIT);
      expect(terminalFailures).toHaveLength(0);
      exits[3]?.(1, null);

      await vi.waitFor(() => expect(terminalFailures).toHaveLength(1), WAIT);
      expect(terminalFailures[0]?.message).toMatch(/after 3 restarts/);
      // 4 generations from 7 launch calls: 3 crashes recovered, each after one
      // failed attempt. Counting attempts would have stopped at 2 generations.
      expect(exits).toHaveLength(4);
      expect(launchCount).toBe(7);
    } finally {
      await lifecycle.stop();
    }
  });

  it("restarts a daemon that is alive but stopped answering engine.ping", async () => {
    // The wedge from the issue: the process never exits, so the restart path —
    // which starts at process exit — is never reached on its own.
    const clients: SelfExitingClient[] = [];
    const failures: Array<{ error: Error; terminal: boolean }> = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      pingIntervalMs: 5,
      pingExpiryMs: 10,
      maxPingExpiries: 2,
      launch: async (options) => {
        // Only the first generation wedges; its replacement answers.
        const client = new SelfExitingClient(
          clients.length === 0 ? silentPing : healthyPing,
        );
        client.exit = options.onExit;
        clients.push(client);
        return client;
      },
      onFailure: (error, terminal) => {
        failures.push({ error, terminal });
      },
    });

    try {
      await lifecycle.start();
      await vi.waitFor(() => expect(clients).toHaveLength(2), WAIT);
      expect(clients[0]?.closed).toBe(true);
      expect(
        failures.map(({ error, terminal }) => [error.message, terminal]),
      ).toEqual([
        [
          "The Rust engine is running but sent nothing: " +
            "2 probes in a row expired after 10ms each with no frame of any " +
            "kind from the engine. " +
            "The limit is 2 probes with no traffic. dohc is restarting it.",
          false,
        ],
        // The kill becomes an exit, and the exit is what carries the wedge
        // into the same restart machinery a crash uses — including the rolling
        // window's crash accounting.
        ["Rust engine daemon exited unexpectedly with signal SIGTERM.", false],
      ]);
      // The probe must carry no wire deadline. EngineClient arms its own timer
      // for any request that names one and rejects when it fires, so a deadline
      // here would turn a wedged daemon's silence into a rejection the detector
      // reads as life — and none of the above would ever happen against the
      // real client. This fake cannot model that timer, so assert the input.
      const probes = clients[0]?.requests.filter(
        (request) => request.method === "engine.ping",
      );
      expect(probes?.length).toBeGreaterThanOrEqual(2);
      for (const probe of probes ?? []) {
        expect(probe.deadlineMs ?? null).toBeNull();
      }
    } finally {
      await lifecycle.stop();
    }
  });

  it("ends a wedge loop at PRODUCTION cadence, on a driven clock", async () => {
    // The ratio, not the numbers. Every other wedge test compresses the probe
    // cadence, and compression changes the one relationship that was broken:
    // a wedge cycle is 3 intervals + 3 expiries = 225s, so the shared crash
    // window (10 exits per 600s) can never hold more than 3 of them, and
    // healthyResetMs (30s) is shorter than the cycle so the burst budget
    // resets every generation too. A daemon that wedged after every launch
    // therefore restarted forever — the own complaint, for wedges.
    //
    // So this test changes NO production constant. It drives a clock instead.
    const realSetTimeout = globalThis.setTimeout;
    const realTurn = () => new Promise((resolve) => realSetTimeout(resolve, 0));
    vi.useFakeTimers();
    let now = 0;
    const clients: SelfExitingClient[] = [];
    let published = 0;
    const terminalFailures: Error[] = [];
    // Driven arrival time of every probe, per generation, for the cadence
    // assertion below.
    const probeArrivals: number[][] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      initialBackoffMs: 0,
      // Ping cadence, expiry, wedge budget, healthy reset, and the rolling
      // window are all left at their production defaults ON PURPOSE.
      monotonicNowMs: () => now,
      wallNowMs: () => now,
      launch: async (options) => {
        const arrivals: number[] = [];
        probeArrivals.push(arrivals);
        const client = new SelfExitingClient((request) => {
          if (request.method === "engine.ping") arrivals.push(now);
          return silentPing(request);
        });
        client.exit = options.onExit;
        // Recorded at the call, so a launch the terminal verdict should have
        // prevented counts even while it is still starting.
        clients.push(client);
        // A loaded machine: each relaunch takes several real event-loop turns,
        // as its smoke's real file work does under load.
        if (clients.length > 1) for (let turn = 0; turn < 3; turn += 1) await realTurn();
        return client;
      },
      onFailure: (error, terminal) => {
        if (terminal) terminalFailures.push(error);
      },
      onLaunch: () => {
        published += 1;
      },
    });

    try {
      await lifecycle.start();
      // Twenty minutes of driven time: twice the crash window, and room for
      // five 225s wedge cycles.
      const step = 5_000;
      for (
        let elapsed = 0;
        elapsed < 20 * 60_000 && terminalFailures.length === 0;
      ) {
        // A relaunch runs its smoke against a real temporary directory, which
        // a driven clock does not move. Hold the clock from the kill until the
        // next generation is published or the restart is refused, so driven
        // time is fake-timer arithmetic however loaded the machine is.
        const relaunching = clients.length > published || clients.at(-1)?.closed === true;
        if (!relaunching) {
          now += step;
          elapsed += step;
        }
        await vi.advanceTimersByTimeAsync(relaunching ? 0 : step);
        await realTurn();
      }

      expect(terminalFailures.map((error) => error.message)).toEqual([
        "The Rust engine went silent on 2 launches: " +
          "3 probes in a row expired after 45000ms each with no frame of any " +
          "kind from the engine. " +
          "The limit is 2 wedges with no traffic in between. " +
          "dohc stopped restarting it.",
      ]);
      // Two generations, both wedged, both killed. A third would mean the
      // terminal verdict failed to stop the restart it ordered.
      expect(clients).toHaveLength(2);
      expect(clients.every((client) => client.closed)).toBe(true);
      // The cadence check pins the wedge budget's SPEED, which the terminal
      // message alone cannot: a slower probe cadence would produce the same
      // message, minutes later. Probe ARRIVAL SPACING inside one wedged
      // generation pins it directly: it is pure fake-timer arithmetic, one
      // expiry plus one interval
      // after the previous probe, 45s + 30s = 75s at the production
      // constants (the expiry half is already pinned by the message
      // above). A tripled interval spaces probes 135s apart and fails
      // here on any box; the tolerance covers only the driven loop's 5s
      // step quantization.
      const spacings: number[] = [];
      for (const arrivals of probeArrivals) {
        for (let i = 1; i < arrivals.length; i += 1) {
          spacings.push((arrivals[i] ?? 0) - (arrivals[i - 1] ?? 0));
        }
      }
      // Two generations, three probes each: at least four spacings.
      expect(spacings.length).toBeGreaterThanOrEqual(4);
      for (const spacing of spacings) {
        expect(spacing).toBeGreaterThanOrEqual(75_000);
        expect(spacing).toBeLessThanOrEqual(80_000);
      }
    } finally {
      vi.useRealTimers();
      await lifecycle.stop();
    }
  }, 30_000);

  it("clears the wedge streak when a generation answers a probe", async () => {
    // A daemon that wedges, is restarted, answers, then wedges again is being
    // recovered — not looping. Only consecutive wedges with nothing answered
    // in between are evidence, so this daemon must keep getting restarted.
    const clients: SelfExitingClient[] = [];
    const failures: Array<{ error: Error; terminal: boolean }> = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      pingIntervalMs: 5,
      pingExpiryMs: 10,
      maxPingExpiries: 1,
      maxConsecutiveWedges: 2,
      launch: async (options) => {
        // Every generation after the first answers two probes before going
        // silent, so no streak ever reaches two.
        let answers = clients.length === 0 ? 0 : 2;
        const client = new SelfExitingClient((request) => {
          if (request.method !== "engine.ping") return healthyPing(request);
          if (answers > 0) {
            answers -= 1;
            return healthyPing(request);
          }
          return new Promise<Response>(() => {});
        });
        client.exit = options.onExit;
        clients.push(client);
        return client;
      },
      onFailure: (error, terminal) => {
        failures.push({ error, terminal });
      },
    });

    try {
      await lifecycle.start();
      // Four generations means three wedge kills survived without terminating.
      await vi.waitFor(() => expect(clients.length).toBeGreaterThanOrEqual(4), WAIT);
      expect(failures.filter(({ terminal }) => terminal)).toEqual([]);
    } finally {
      await lifecycle.stop();
    }
  });


  it("kills the wedged daemon before the terminal report can block", async () => {
    const clients: SelfExitingClient[] = [];
    const closedWhenReported: boolean[] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      pingIntervalMs: 5,
      pingExpiryMs: 10,
      maxPingExpiries: 1,
      maxConsecutiveWedges: 2,
      launch: async (options) => {
        const client = new SelfExitingClient(silentPing);
        client.exit = options.onExit;
        clients.push(client);
        return client;
      },
      onFailure: (_error, terminal) => {
        // Stands in for the modal: read the wedged client at the exact moment
        // the consumer takes control, which is where a dialog would park.
        if (terminal) closedWhenReported.push(clients.at(-1)?.closed ?? false);
      },
    });

    try {
      await lifecycle.start();
      await vi.waitFor(() => expect(closedWhenReported).toHaveLength(1), WAIT);
      expect(closedWhenReported).toEqual([true]);
    } finally {
      await lifecycle.stop();
    }
  });

  it("never kills a daemon whose output is still arriving", async () => {
    // A probe cannot overtake the daemon's output queue. That queue holds 64
    // ITEMS counted without regard to size, a control frame may reach 8 MiB,
    // and BlobEgressBudget reserves blob bytes only — so a reply can sit
    // behind hundreds of megabytes, and the wait on that channel is untimed.
    // No expiry can both survive that and still catch a wedge, so silence is
    // measured as NO TRAFFIC AT ALL rather than as no reply.
    const clients: SelfExitingClient[] = [];
    const failures: Error[] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      pingIntervalMs: 2,
      pingExpiryMs: 20,
      maxPingExpiries: 1,
      launch: async (options) => {
        const client = new SelfExitingClient(silentPing);
        client.exit = options.onExit;
        clients.push(client);
        return client;
      },
      onFailure: (error) => failures.push(error),
    });

    // Output keeps arriving for other callers throughout, exactly as it would
    // while the daemon writes down a queued backlog. No probe is ever answered.
    const traffic = setInterval(() => {
      for (const client of clients) client.inbound += 1;
    }, 2);
    try {
      await lifecycle.start();
      // Several probes expire unanswered; had silence still been measured by
      // the probe's own reply, the first expiry would have condemned it.
      await vi.waitFor(
        () => expect(probesSent(clients[0])).toBeGreaterThanOrEqual(4),
        WAIT,
      );
      expect(failures).toEqual([]);
      expect(clients).toHaveLength(1);
      expect(clients[0]?.closed).toBe(false);
    } finally {
      clearInterval(traffic);
      await lifecycle.stop();
    }
  });

  it("waits for the daemon to exit during clean shutdown", async () => {
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const client = new FakeClient();
    client.waitForExit = () => exited;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();

    let stopped = false;
    const stop = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(client.closed).toBe(true);
    expect(stopped).toBe(false);
    resolveExit();
    await stop;
    expect(stopped).toBe(true);
  });

  it("waits for an in-flight launch and leaves no daemon starting on shutdown", async () => {
    let resolveLaunch!: (client: EngineDaemonClient) => void;
    let resolveExit!: () => void;
    const launched = new Promise<EngineDaemonClient>((resolve) => {
      resolveLaunch = resolve;
    });
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    let launchSignal: AbortSignal | undefined;
    const client = new FakeClient();
    client.waitForExit = () => exited;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async (options) => {
        launchSignal = options.signal;
        return await launched;
      },
    });

    const start = lifecycle.start();
    await Promise.resolve();
    let stopped = false;
    const stop = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(launchSignal?.aborted).toBe(true);

    resolveLaunch(client);
    await vi.waitFor(() => expect(client.closed).toBe(true), WAIT);
    expect(stopped).toBe(false);

    resolveExit();
    await Promise.all([start, stop]);
    expect(stopped).toBe(true);
  });

  it("reads through an attachment while a full relay session stays live", async () => {
    let ownerHandle: string | null = null;
    const attachments = new Set<string>();
    let nextAttachment = 0;
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        const openParams = request.params as Record<string, unknown>;
        const readIntent =
          openParams.skipStartupMaintenance === true;
        if (readIntent && ownerHandle) {
          nextAttachment += 1;
          const handle = `cli-attachment-${nextAttachment}`;
          attachments.add(handle);
          return { id: request.id, result: { workspace: handle } };
        }
        ownerHandle = "desktop-owner";
        return { id: request.id, result: { workspace: ownerHandle } };
      }
      if (request.method === "search.queryChatMessagesGranular") {
        if (
          typeof request.workspace !== "string" ||
          !attachments.has(request.workspace)
        ) {
          throw new Error("read did not use an attachment");
        }
        return {
          id: request.id,
          result: {
            results: [{ threadId: "thread", messageId: null, text: "needle" }],
            saturated: false,
          },
        };
      }
      if (request.method === "versions.active") {
        if (request.workspace !== ownerHandle) {
          throw new Error("desktop owner was torn down");
        }
        return { id: request.id, result: { id: "main", kind: "main" } };
      }
      if (request.method === "workspace.close") {
        if (
          typeof request.workspace === "string" &&
          attachments.delete(request.workspace)
        ) {
          return {
            id: request.id,
            result: { closed: false, attachmentClosed: true },
          };
        }
        if (request.workspace === ownerHandle) ownerHandle = null;
        return { id: request.id, result: { closed: true } };
      }
      return { id: request.id, result: {} };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();
    await startupSmokeDone(client);

    const desktopOpen = await client.sendRequest({
      id: 10_000,
      method: "workspace.open",
      params: {
        rootDir: "C:\\workspace",
        workspaceId: "workspace",
        relay: {
          baseUrl: "https://relay.example.test",
          bearerToken: "desktop-token",
        },
      },
    });
    const desktopHandle = (
      desktopOpen.result as { workspace: string }
    ).workspace;

    await expect(
      lifecycle.requestWorkspace(
        "C:\\workspace",
        "workspace",
        "search.queryChatMessagesGranular",
        { query: "needle", limit: 50_000 },
      ),
    ).resolves.toEqual({
      results: [{ threadId: "thread", messageId: null, text: "needle" }],
      saturated: false,
    });
    expect(attachments.size).toBe(0);
    await expect(
      client.sendRequest({
        id: 10_001,
        method: "versions.active",
        workspace: desktopHandle,
        params: {},
      }),
    ).resolves.toMatchObject({ result: { id: "main", kind: "main" } });

    await client.sendRequest({
      id: 10_002,
      method: "workspace.close",
      workspace: desktopHandle,
      params: {},
    });
    await lifecycle.stop();
  });

  it("resolves start() on the handshake, before the startup smoke completes", async () => {
    // The hello/helloAck handshake already proves the daemon is alive and
    // speaking the protocol; the desktop blocks window creation on start(),
    // so the disk-heavy workspace smoke must not gate it.
    let openRequest: Request | undefined;
    let releaseOpen!: (response: Response) => void;
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        openRequest = request;
        return new Promise<Response>((resolve) => {
          releaseOpen = resolve;
        });
      }
      return healthyPing(request);
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });

    try {
      await lifecycle.start();
      // The smoke has not completed — its workspace.open is unsent or held —
      // yet the lifecycle is already running and serving its client.
      expect(
        client.requests.filter((request) => request.method === "workspace.close"),
      ).toEqual([]);
      expect(lifecycle.currentClient()).toBe(client);
      await vi.waitFor(() => expect(openRequest).toBeDefined(), WAIT);
      if (!openRequest) throw new Error("smoke open was not sent");
      // stop() joins the held smoke: shutdown must wait out its
      // temp-directory work rather than pulling the directory from under it.
      let stopped = false;
      const stop = lifecycle.stop().then(() => {
        stopped = true;
      });
      await vi.waitFor(() => expect(client.closed).toBe(true), WAIT);
      expect(stopped).toBe(false);
      // A late reply from the retired request cannot continue the smoke.
      releaseOpen({
        id: openRequest.id,
        result: { workspace: "health-handle" },
      });
      await stop;
      expect(client.requests.map((request) => request.method)).toEqual([
        "workspace.open",
      ]);
    } finally {
      await lifecycle.stop();
    }
  });

  it("routes a background smoke failure through onFailure and the restart path", async () => {
    // The smoke's own rejection reaches onFailure unwrapped and non-terminal
    // — the same error the blocking smoke used to throw out of start(). The
    // kill is a replacement (transport-error, like a wedge kill), and its
    // exit carries the failure into the ordinary restart machinery, whose
    // relaunch runs the blocking smoke and takes over.
    const clients: SelfExitingClient[] = [];
    const failures: Array<{ error: Error; terminal: boolean }> = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      initialBackoffMs: 0,
      launch: async (options) => {
        // Only the first generation fails its smoke; the replacement passes.
        const failing = clients.length === 0;
        const client = new SelfExitingClient((request) => {
          if (failing && request.method === "versions.active") {
            throw new Error("smoke integrity check failed");
          }
          return healthyPing(request);
        });
        client.exit = options.onExit;
        clients.push(client);
        return client;
      },
      onFailure: (error, terminal) => {
        failures.push({ error, terminal });
      },
    });

    try {
      // Resolves despite the doomed smoke: the handshake is the gate.
      await lifecycle.start();
      await vi.waitFor(() => expect(clients).toHaveLength(2), WAIT);
      expect(clients[0]?.closeCause).toBe("transport-error");
      expect(
        failures.map(({ error, terminal }) => [error.message, terminal]),
      ).toEqual([
        ["smoke integrity check failed", false],
        ["Rust engine daemon exited unexpectedly with signal SIGTERM.", false],
      ]);
      // Each generation's smoke opened its own workspace id: a background
      // smoke and a restart's blocking smoke can overlap in one process, and
      // two live opens must never share one.
      const smokeOpenId = (client: FakeClient | undefined) =>
        (
          client?.requests.find(
            (request) => request.method === "workspace.open",
          )?.params as Record<string, unknown> | undefined
        )?.workspaceId;
      await vi.waitFor(
        () => expect(smokeOpenId(clients[1])).toBeDefined(),
        WAIT,
      );
      expect(smokeOpenId(clients[0])).toMatch(/^desktop-startup-smoke-/);
      expect(smokeOpenId(clients[1])).toMatch(/^desktop-startup-smoke-/);
      expect(smokeOpenId(clients[1])).not.toBe(smokeOpenId(clients[0]));
    } finally {
      await lifecycle.stop();
    }
  });

  it("probes again when a probe expiry fires late, instead of condemning", async () => {
    const failures: Error[] = [];
    let now = 0;
    let pings = 0;
    let finishOpen!: () => void;
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return new Promise<Response>((resolve) => {
          finishOpen = () => resolve(healthyPing(request));
        });
      }
      if (request.method === "engine.ping") {
        pings += 1;
        // The first probe expires while the host is suspended for a minute.
        if (pings === 1) {
          now += 60_000;
          return new Promise<Response>(() => {});
        }
        setImmediate(() => finishOpen());
      }
      return healthyPing(request);
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      requestProbeDelayMs: 10,
      pingExpiryMs: 40,
      monotonicNowMs: () => now,
      launch: async () => client,
      onFailure: (error) => failures.push(error),
    });
    try {
      await lifecycle.start();
      await startupSmokeDone(client);
      expect(pings).toBe(2);
      expect(failures).toEqual([]);
      expect(client.closed).toBe(false);
    } finally {
      await lifecycle.stop();
    }
  });

  it("ends a slow read at the caller's budget without condemning the engine", async () => {
    let hangRead = false;
    const failures: Error[] = [];
    const client = new FakeClient((request) => {
      if (request.method === "search.queryChatMessagesGranular" && hangRead) {
        return new Promise<Response>(() => {
          // The attach opened; the read itself is slow.
        });
      }
      return healthyPing(request);
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      workspaceReadTimeoutMs: 100,
      requestProbeDelayMs: 10,
      pingExpiryMs: 40,
      launch: async () => client,
      onFailure: (error) => failures.push(error),
    });

    await lifecycle.start();
    await startupSmokeDone(client);
    client.requests.length = 0;
    hangRead = true;
    await expect(
      lifecycle.requestWorkspace(
        "C:\\workspace",
        "workspace",
        "search.queryChatMessagesGranular",
        { query: "needle", limit: 50_000 },
      ),
    ).rejects.toThrow(/^Rust engine search\.queryChatMessagesGranular timed out after \d+ms\.$/);
    const read = client.requests.find(({ method }) => method === "search.queryChatMessagesGranular");
    expect(read?.deadlineMs).toBeLessThanOrEqual(100);
    expect(client.cancelledRequestIds).toEqual([read?.id]);
    // The attachment is still released, and the engine stays.
    expect(client.requests.some(({ method }) => method === "workspace.close")).toBe(true);
    expect(client.closed).toBe(false);
    expect(failures).toEqual([]);

    hangRead = false;
    await expect(
      lifecycle.requestWorkspace(
        "C:\\workspace",
        "workspace",
        "search.queryChatMessagesGranular",
        { query: "needle", limit: 1 },
      ),
    ).resolves.toBeNull();
    await lifecycle.stop();
  });

  it("keeps a read that expired in the queue ordering the next one behind the read ahead", async () => {
    let holdClose = false;
    let releaseClose: (() => void) | undefined;
    const client = new FakeClient((request) => {
      if (request.method === "workspace.close" && holdClose && !releaseClose) {
        return new Promise<Response>((resolve) => {
          releaseClose = () => resolve(healthyPing(request));
        });
      }
      return healthyPing(request);
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      workspaceReadTimeoutMs: 50,
      launch: async () => client,
    });
    try {
      await lifecycle.start();
      await startupSmokeDone(client);
      client.requests.length = 0;
      holdClose = true;
      const read = (query: string) =>
        lifecycle.requestWorkspace("C:\\workspace", "workspace", "search.queryChatMessagesGranular", { query, limit: 1 });
      const first = read("first");
      await vi.waitFor(() => expect(releaseClose).toBeDefined(), WAIT);
      await expect(read("second")).rejects.toThrow("did not start within its 50ms budget");
      const third = read("third");
      await expect(third).rejects.toThrow("did not start within its 50ms budget");
      // Neither later read reached the engine while the first still held the root.
      expect(client.requests.filter(({ method }) => method === "workspace.open")).toHaveLength(1);
      releaseClose!();
      await expect(first).resolves.toBeNull();
    } finally {
      await lifecycle.stop();
    }
  });

  it("resolves the dev and packaged binary layouts", () => {
    expect(
      defaultEngineBinaryPath({
        isPackaged: false,
        appPath: "/repo/apps/desktop",
        platform: "linux",
      }),
    ).toBe(posix.join("/repo", "target/debug/dohc-workspace-engine"));
    expect(
      defaultEngineBinaryPath({
        isPackaged: true,
        appPath: "C:\\ignored",
        resourcesPath: "C:\\Program Files\\dohc\\resources",
        platform: "win32",
      }),
    ).toBe(
      win32.join(
        "C:\\Program Files\\dohc\\resources",
        "workspace-engine",
        "dohc-workspace-engine.exe",
      ),
    );
  });

});

class ProgressClient extends SelfExitingClient {
  readonly progressCallbacks = new Map<number, () => void>();
  readonly requestSignals = new Map<number, AbortSignal>();
  reportsProgress(): boolean { return true; }
  override async sendRequest(request: Request, signal?: AbortSignal, onProgress?: () => void, cancelSignal?: AbortSignal): Promise<Response> {
    if (onProgress) this.progressCallbacks.set(request.id, onProgress);
    if (signal) this.requestSignals.set(request.id, signal);
    return await super.sendRequest(request, signal, onProgress, cancelSignal);
  }
}

async function progressFixture(options: { silent?: boolean; capMs?: number } = {}) {
  let hold = false;
  const opens = new Map<number, () => void>();
  let nextOpened: ReturnType<typeof deferred>;
  const client = new ProgressClient(request => {
    if (hold && request.method === "workspace.open") {
      return new Promise<Response>(resolve => {
        opens.set(request.id, () => resolve(healthyPing(request)));
        nextOpened.resolve();
      });
    }
    if (hold && options.silent && request.method === "engine.ping") return new Promise<Response>(() => {});
    return healthyPing(request);
  });
  const failures: Error[] = [];
  const lifecycle = new EngineDaemonLifecycle({
    command: fakeBinary(), launch: async () => client,
    workspaceReadTimeoutMs: options.capMs ?? 200, requestProbeDelayMs: 20, pingExpiryMs: 40,
    monotonicNowMs: () => Date.now(),
    onFailure: error => failures.push(error),
  });
  await lifecycle.start();
  await startupSmokeDone(client);
  vi.useFakeTimers();
  hold = true;
  const open = async () => {
    nextOpened = deferred();
    const result = lifecycle.requestWorkspace("C:/progress-test", "progress-test", "versions.active", {});
    const outcome = result.then(value => ({ value }), error => ({ error: error as Error }));
    await nextOpened.promise;
    const id = client.requests.at(-1)!.id;
    expect(opens.has(id)).toBe(true);
    return { id, outcome };
  };
  return { client, lifecycle, failures, opens, open };
}

describe("lifecycle request progress", () => {
  it.each(["background"] as readonly ("background" | "blocking")[])("ends the restart budget when a hung lock holder reaches the %s smoke cap", async mode => {
    const capMs = 120_000, maxRestarts = 2;
    const clients: ProgressClient[] = [];
    const opened = Array.from({ length: maxRestarts + 1 }, () => deferred());
    const failures: Array<{ error: Error; terminal: boolean }> = [];
    const capFailures = () => failures.filter(({ error }) => error.message === `Rust engine workspace.open timed out after ${capMs}ms.`).length;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(), initialBackoffMs: 0, maxRestarts,
      requestTimeoutMs: capMs, monotonicNowMs: () => Date.now(),
      launch: async options => {
        const index = clients.length;
        const hung = mode === "background" || index > 0;
        const client = new ProgressClient(request => {
          if (hung && request.method === "workspace.open") {
            // Taking the real engine's open lock reports a step before it hangs.
            client.progressCallbacks.get(request.id)!();
            opened[index]!.resolve();
            return new Promise<Response>(() => {});
          }
          return healthyPing(request);
        });
        client.exit = options.onExit;
        clients.push(client);
        return client;
      },
      onFailure: (error, terminal) => failures.push({ error, terminal }),
    });
    try {
      if (mode === "background") vi.useFakeTimers();
      await lifecycle.start();
      if (mode === "blocking") {
        await startupSmokeDone(clients[0]!);
        vi.useFakeTimers();
        clients[0]!.exit?.(1, null);
      }
      const firstHung = mode === "background" ? 0 : 1;
      for (let index = firstHung; index <= maxRestarts; index++) {
        await opened[index]!.promise;
        const client = clients[index]!;
        expect(client.outstandingRequests(request => request.method === "workspace.open")).toBe(1);
        const open = client.requests.find(request => request.method === "workspace.open")!;
        const failuresBefore = capFailures();
        await vi.advanceTimersByTimeAsync(6_000);
        expect(client.cancelledRequestIds).not.toContain(open.id);
        expect(client.closed).toBe(false);
        expect(capFailures()).toBe(failuresBefore);
        await vi.advanceTimersByTimeAsync(capMs - 6_000 + 10);
        await vi.waitFor(() => expect(capFailures()).toBeGreaterThan(failuresBefore), WAIT);
        expect(capFailures()).toBe(failuresBefore + 1);
        expect(client.closed).toBe(true);
        expect(probesSent(client)).toBeGreaterThan(0);
        expect(open.deadlineMs).toBe(capMs);
        expect(client.cancelledRequestIds).toContain(open.id);
      }
      await vi.waitFor(() => expect(failures.some(({ terminal }) => terminal)).toBe(true), WAIT);
      expect(clients).toHaveLength(maxRestarts + 1);
      expect(capFailures()).toBe(mode === "background" ? maxRestarts + 1 : maxRestarts);
      expect(failures.at(-1)).toEqual({
        error: expect.objectContaining({ message: `Rust engine restart limit exceeded after ${maxRestarts} attempts.` }), terminal: true,
      });
      expect(() => lifecycle.currentClient()).toThrow("Rust engine daemon is not available.");
    } finally { await lifecycle.stop(); }
  });

  it("keeps a slow open while its own progress advances", async () => {
    const f = await progressFixture();
    try {
      const { id, outcome } = await f.open();
      const before = probesSent(f.client);
      for (let i = 0; i < 8; i++) { f.client.progressCallbacks.get(id)!(); await vi.advanceTimersByTimeAsync(10); }
      expect(probesSent(f.client)).toBe(before);
      expect(f.client.cancelledRequestIds).not.toContain(id);
      f.opens.get(id)!();
      expect(await outcome).toHaveProperty("value");
      expect(f.client.requestSignals.get(id)!.aborted).toBe(true);
      expect(f.client.closed).toBe(false);
    } finally { await f.lifecycle.stop(); }
  });

  it("cancels a stalled open despite unrelated frames and preserves the responding daemon", async () => {
    const f = await progressFixture({ silent: true });
    try {
      const { id, outcome } = await f.open();
      f.client.progressCallbacks.get(id)!();
      await vi.advanceTimersByTimeAsync(45);
      expect(probesSent(f.client)).toBeGreaterThan(0);
      f.client.inbound += 1;
      await vi.advanceTimersByTimeAsync(40);
      expect(await outcome).toHaveProperty("error.message", "Rust engine workspace.open made no progress while the daemon was responding.");
      expect(f.client.cancelledRequestIds).toContain(id);
      expect(f.client.closed).toBe(false);
      expect(f.lifecycle.currentClient()).toBe(f.client);
    } finally { await f.lifecycle.stop(); }
  });

  it("preserves the absolute cap while a responding open keeps progressing", async () => {
    const f = await progressFixture({ capMs: 100 });
    try {
      const { id, outcome } = await f.open();
      for (let i = 0; i < 10; i++) { f.client.progressCallbacks.get(id)!(); await vi.advanceTimersByTimeAsync(10); }
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toHaveProperty("error.message", "Rust engine workspace.open timed out after 100ms.");
      expect(f.client.cancelledRequestIds).toContain(id);
      expect(f.client.closed).toBe(false);
    } finally { await f.lifecycle.stop(); }
  });

  it("condemns true silence even after earlier request progress", async () => {
    const f = await progressFixture({ silent: true });
    try {
      const { id, outcome } = await f.open();
      f.client.progressCallbacks.get(id)!();
      await vi.advanceTimersByTimeAsync(90);
      expect(await outcome).toHaveProperty("error.message", "Rust engine workspace.open got no answer: a probe expired after 40ms with no frame of any kind from the engine.");
      expect(f.client.closeCause).toBe("transport-error");
    } finally { await f.lifecycle.stop(); }
  });

  it("retires old request progress when a replacement generation is published", async () => {
    const clients: ProgressClient[] = [];
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    let releaseOld!: () => void;
    const oldOpened = deferred(), replacementOpened = deferred();
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(), initialBackoffMs: 0, requestProbeDelayMs: 20, pingExpiryMs: 40,
      launch: async options => {
        exits.push(options.onExit);
        const client = new ProgressClient(request => {
          if (request.method === "workspace.open" && (request.params as Record<string, unknown>).workspaceId === "generation-test") {
            return new Promise<Response>(resolve => {
              if (client === clients[0]) {
                releaseOld = () => resolve(healthyPing(request));
                oldOpened.resolve();
              } else replacementOpened.resolve();
            });
          }
          return healthyPing(request);
        });
        clients.push(client);
        return client;
      },
    });
    try {
      await lifecycle.start();
      await startupSmokeDone(clients[0]!);
      const old = lifecycle.requestWorkspace("C:/generation-test", "generation-test", "versions.active", {}).catch(error => error as Error);
      await oldOpened.promise;
      const oldId = clients[0]!.requests.at(-1)!.id;
      const oldProgress = clients[0]!.progressCallbacks.get(oldId)!;
      exits[0]?.(1, null);
      expect(await old).toHaveProperty("message", "Rust engine request generation was retired.");
      await vi.waitFor(() => expect(lifecycle.currentClient()).toBe(clients[1]), WAIT);
      expect(clients[0]!.requestSignals.get(oldId)!.aborted).toBe(true);
      vi.useFakeTimers();
      const replacement = lifecycle.requestWorkspace("C:/generation-test", "generation-test", "versions.active", {}).catch(error => error as Error);
      await replacementOpened.promise;
      const newId = clients[1]!.requests.at(-1)!.id;
      clients[1]!.progressCallbacks.get(newId)!();
      oldProgress();
      releaseOld();
      await vi.advanceTimersByTimeAsync(45);
      expect(await replacement).toHaveProperty("message", "Rust engine workspace.open made no progress while the daemon was responding.");
      expect(clients[1]!.cancelledRequestIds).toEqual([newId]);
      expect(clients[1]!.closed).toBe(false);
      expect(lifecycle.currentClient()).toBe(clients[1]);
      expect(clients[0]!.requests.at(-1)!.id).toBe(oldId);
    } finally { await lifecycle.stop(); }
  });

  it("cleans request and probe observers when shutdown retires a pending request", async () => {
    const f = await progressFixture({ silent: true });
    const { id, outcome } = await f.open();
    await vi.advanceTimersByTimeAsync(25);
    const ping = f.client.requests.find(request => request.method === "engine.ping")!;
    await f.lifecycle.stop();
    expect(await outcome).toHaveProperty("error.message", "Rust engine request generation was retired.");
    expect(f.client.requestSignals.get(id)!.aborted).toBe(true);
    expect(f.client.requestSignals.get(ping.id)!.aborted).toBe(true);
    f.client.progressCallbacks.get(id)!();
    await vi.advanceTimersByTimeAsync(201);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.failures).toEqual([]);
  });
});
