import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../ydoc/generated/Event";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { EngineClientSpawnOptions } from "./engineClient";
import {
  createRustEngineDaemon,
  defaultEngineBinaryPath,
  EngineDaemonLifecycle,
  runEngineDaemonStartupSmoke,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";

// Every cross-machine wait in this file carries this bound (#568). Each
// relaunch runs the startup smoke against a real temporary directory, so a
// wait's duration is honest fs work plus whatever else the machine is doing.
// Measured 2026-08-03 on a 24-process load (4 copies of this suite plus 4
// each of five desktop suites, 3 waves, 12 runs): every wait whose subject
// arrived completed within 2.5s; 15s is 6x that, and the 20s test deadline
// still fails a genuine hang as itself. The rolling-window failures that
// same load produced (6/12 and 3/12 runs) were NOT slow waits — the crash
// landed while the replacement's startup smoke was still in flight, so it
// was spent on the burst budget and the window signal never existed to wait
// for. Those tests now await the real became-healthy signal below.
const WAIT = { timeout: 15_000 } as const;
vi.setConfig({ testTimeout: 20_000 });

// The healthy window the restart-budget test configures; its wait is derived
// from this so the two can never drift apart.
const HEALTHY_RESET_MS = 20;

// Burst headroom for the rolling-window tests. `restartAttempts` counts every
// attempt, including the successful ones, and only the healthy-reset timer
// clears it — so a low maxRestarts makes those tests depend on a real timer
// firing between crashes, and a loaded run that delays it ends them on the
// BURST terminal instead of the window terminal under test. None of them needs
// more than 6 attempts, so a budget this high can never fire and the window
// stays the only way they can reach terminal. The burst budget has its own
// tests above.
const WINDOW_TEST_MAX_RESTARTS = 10;

class FakeClient implements EngineDaemonClient {
  readonly requests: Request[] = [];
  readonly cancelledRequestIds: number[] = [];
  closed = false;
  // WHICH kill path ran. The real EngineClient rejects everything in flight
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

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    return await this.respond(request);
  }

  async cancelRequest(requestId: number): Promise<void> {
    this.cancelledRequestIds.push(requestId);
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
    // A REAL child's "exit" is an event-loop delivery: node cannot dispatch it
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
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

// The first launch's startup smoke runs BEHIND start() now, so a test that
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

  it("fans daemon events out to lifecycle handlers across restarts", async () => {
    // MUTATION: dropping the client.onEvent re-subscription in launchOnce (or
    // the handler fan-out) leaves `seen` empty and this test fails — in daemon
    // mode capture events are the ONLY history-refresh signal.
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const emitters: ((event: Event) => void)[] = [];
    class EventfulClient extends FakeClient {
      onEvent(handler: (event: Event) => void): () => void {
        emitters.push(handler);
        return () => {};
      }
    }
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 1,
      initialBackoffMs: 0,
      launch: async (options) => {
        exits.push(options.onExit);
        return new EventfulClient();
      },
    });
    const seen: number[] = [];
    lifecycle.onEvent((event) => {
      if (event.name === "capture.momentRecorded") seen.push(event.sessionGeneration);
    });

    try {
      await lifecycle.start();
      expect(emitters).toHaveLength(1);
      emitters[0]?.({
        seq: 1,
        sessionGeneration: 1,
        name: "capture.momentRecorded",
        payload: null,
      });
      expect(seen).toEqual([1]);

      // The daemon restarts: the SAME lifecycle handler keeps receiving from
      // the replacement client without re-registering.
      exits[0]?.(1, null);
      await vi.waitFor(() => expect(emitters.length).toBeGreaterThan(1), WAIT);
      emitters[1]?.({
        seq: 1,
        sessionGeneration: 2,
        name: "capture.momentRecorded",
        payload: null,
      });
      expect(seen).toEqual([1, 2]);
    } finally {
      await lifecycle.stop();
    }
  });

  it("fires onLaunch for the first launch and again after a restart", async () => {
    // MUTATION: dropping the onLaunch call in launchOnce leaves `launches`
    // at 0 — a capture event that died with a previous daemon's transport
    // would then never be compensated by a relaunch repaint.
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    let launches = 0;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 1,
      initialBackoffMs: 0,
      launch: async (options) => {
        exits.push(options.onExit);
        return new FakeClient();
      },
      onLaunch: () => {
        launches += 1;
      },
    });

    try {
      await lifecycle.start();
      expect(launches).toBe(1);
      exits[0]?.(1, null);
      await vi.waitFor(() => expect(launches).toBe(2), WAIT);
    } finally {
      await lifecycle.stop();
    }
  });

  it("fails loudly before launch when the configured binary is missing", async () => {
    const launch = vi.fn(async () => new FakeClient());
    const lifecycle = new EngineDaemonLifecycle({
      command: join(tmpdir(), "definitely-missing-dohc-engine"),
      fileExists: () => false,
      launch,
    });

    await expect(lifecycle.start()).rejects.toThrow(
      /Rust engine binary not found/,
    );
    expect(launch).not.toHaveBeenCalled();
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

  it("carries the restart budget across handshaking daemon generations", async () => {
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const terminalFailures: Error[] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 3,
      initialBackoffMs: 0,
      launch: async (options) => {
        exits.push(options.onExit);
        return new FakeClient();
      },
      onFailure: (error, terminal) => {
        if (terminal) terminalFailures.push(error);
      },
    });

    try {
      await lifecycle.start();
      for (let generation = 0; generation < 4; generation += 1) {
        exits[generation]?.(1, null);
        if (generation < 3) {
          await vi.waitFor(
            () => expect(exits).toHaveLength(generation + 2),
            WAIT,
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      await vi.waitFor(
        () => {
          expect(terminalFailures).toHaveLength(1);
        }, WAIT);
      expect(exits).toHaveLength(4);
      expect(terminalFailures[0]?.message).toMatch(
        /restart limit exceeded after 3 attempts/,
      );
    } finally {
      await lifecycle.stop();
    }
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
      // A crash exercises the budget it is aimed at only if it lands on a
      // HEALTHY generation: one that dies during its own startup smoke is a
      // failed launch attempt instead, and the rolling window and reset
      // timer never see it. The smoke runs against a real temporary
      // directory, so under load it outlasts any fixed sleep — exactly how
      // this family failed on a busy box (#568). onLaunch fires after
      // running=true: the real became-healthy signal.
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

  it("ends terminal when restarts keep recurring across healthy generations", async () => {
    // The crash-every-31s daemon: every generation outlives healthyResetMs, so
    // the attempt budget never ends the run and only the rolling window can
    // reach terminal — the one signal the desktop turns into a dialog.
    // MUTATION: drop the window check in restartAfterExit and this test times
    // out waiting for a terminal failure that never arrives.
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const terminalFailures: Error[] = [];
    let live = 0;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      restartWindowMs: 120_000,
      maxRestartsPerWindow: 3,
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
        // Only a HEALTHY generation's crash spends a window slot — see the
        // restart-budget test above for why a sleep cannot stand in for
        // this signal. Then outlive the healthy window: these are the
        // healthy gaps the issue describes, the ones a budget reset by
        // health cannot see past.
        await vi.waitFor(() => expect(live).toBe(generation + 1), WAIT);
        await new Promise((resolve) => setTimeout(resolve, HEALTHY_RESET_MS * 10));
        exits[generation]?.(1, null);
      }
      await vi.waitFor(() => expect(live).toBe(4), WAIT);
      exits[3]?.(1, null);

      await vi.waitFor(() => expect(terminalFailures).toHaveLength(1), WAIT);
      expect(terminalFailures[0]?.message).toBe(
        "The Rust engine crashed again after 3 restarts in the last 2 minutes. " +
          "The limit is 3 restarts per 2 minutes. dohc stopped restarting it.",
      );
      expect(terminalFailures[0]?.cause).toMatchObject({
        message: "Rust engine daemon exited unexpectedly with code 1.",
      });
      expect(exits).toHaveLength(4);
    } finally {
      await lifecycle.stop();
    }
  });

  it("forgets restarts older than the rolling window", async () => {
    // MUTATION: drop the timestamp pruning in restartAfterExit and restarts
    // spaced four windows apart accumulate, so the third crash ends terminal
    // and both assertions below fail.
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
        // Crash only a healthy generation, spaced four windows apart.
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
    // MUTATION: move the recordCrash call inside the attempt loop and the
    // flaky first attempt of every crash burns a second slot — terminal
    // arrives at crash 2 with only 2 generations launched, so both counts
    // below fail. A run that spends one attempt per crash cannot tell the two
    // accountings apart; this needs a crash that costs more than one attempt.
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

  it("expires window entries on the wall clock when the host suspends", async () => {
    // performance.now() does not advance while a Linux host sleeps, so a
    // laptop that wakes after the window would find its old crashes still
    // "recent" and terminate on the next one.
    // MUTATION: drop the wall-clock half of the filter and the retained
    // entries end this run terminal at the third crash.
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const terminalFailures: Error[] = [];
    let live = 0;
    const restartWindowMs = 120_000;
    let wallNow = 0;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      restartWindowMs,
      maxRestartsPerWindow: 2,
      // The suspended host: its monotonic clock stands still while the wall
      // clock crosses the window several times over.
      monotonicNowMs: () => 0,
      wallNowMs: () => wallNow,
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
        // Crash only a healthy generation — see the restart-budget test.
        await vi.waitFor(() => expect(live).toBe(generation + 1), WAIT);
        await new Promise((resolve) => setTimeout(resolve, HEALTHY_RESET_MS * 10));
        wallNow += restartWindowMs * 4;
        exits[generation]?.(1, null);
      }

      await vi.waitFor(() => expect(live).toBe(4), WAIT);
      expect(exits).toHaveLength(4);
      expect(terminalFailures).toHaveLength(0);
    } finally {
      await lifecycle.stop();
    }
  });

  it("expires window entries on the monotonic clock when the wall clock steps back", async () => {
    // The inverse host fault: an NTP or VM correction moves the wall clock
    // backwards, stranding entries in the future where no wall comparison
    // ever expires them.
    // MUTATION: drop the monotonic half of the filter and the stranded
    // entries end this run terminal at the third crash.
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const terminalFailures: Error[] = [];
    let live = 0;
    const restartWindowMs = HEALTHY_RESET_MS * 2;
    let wallNow = 10 * 60_000;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      restartWindowMs,
      maxRestartsPerWindow: 2,
      wallNowMs: () => wallNow,
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
        // Crash only a healthy generation — see the restart-budget test.
        await vi.waitFor(() => expect(live).toBe(generation + 1), WAIT);
        // Real elapsed time, which the untouched monotonic clock measures,
        // crosses the window between crashes.
        await new Promise((resolve) => setTimeout(resolve, restartWindowMs * 4));
        // Each crash sees a wall clock a further ten minutes in the past.
        wallNow -= 10 * 60_000;
        exits[generation]?.(1, null);
      }

      await vi.waitFor(() => expect(live).toBe(4), WAIT);
      expect(exits).toHaveLength(4);
      expect(terminalFailures).toHaveLength(0);
    } finally {
      await lifecycle.stop();
    }
  });

  it("restarts a daemon that is alive but stopped answering engine.ping", async () => {
    // The wedge from the issue: the process never exits, so the restart path —
    // which starts at process exit — is never reached on its own.
    // MUTATION: remove the wedge detector (or its reportWedge kill) and no
    // failure is ever reported, no client is closed, and no relaunch happens.
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
      // The probe must carry no wire deadline. EngineClient arms its OWN timer
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
    // THE RATIO, not the numbers. Every other wedge test compresses the probe
    // cadence, and compression changes the one relationship that was broken:
    // a wedge cycle is 3 intervals + 3 expiries = 225s, so the shared crash
    // window (10 exits per 600s) can never hold more than 3 of them, and
    // healthyResetMs (30s) is shorter than the cycle so the burst budget
    // resets every generation too. A daemon that wedged after every launch
    // therefore restarted forever — #412's own complaint, for wedges.
    //
    // So this test changes NO production constant. It drives a clock instead.
    // MUTATION: delete the consecutive-wedge budget and leave wedge exits to
    // the shared 10-in-600s crash contract -> no terminal failure ever
    // arrives and this fails on an empty list.
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers();
    let now = 0;
    const clients: SelfExitingClient[] = [];
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
        clients.push(client);
        return client;
      },
      onFailure: (error, terminal) => {
        if (terminal) terminalFailures.push(error);
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
        elapsed += step
      ) {
        now += step;
        await vi.advanceTimersByTimeAsync(step);
        // Each launch runs the smoke against a real temporary directory. A
        // driven clock does not move real I/O, so give the event loop a real
        // turn between steps or the relaunch never completes.
        await new Promise((resolve) => realSetTimeout(resolve, 0));
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
      // message, minutes later. It must NOT be an elapsed-driven-time
      // ceiling: the driven clock advances one step per real event-loop
      // turn, and the relaunch smoke's real I/O consumes turns, so driven
      // milliseconds measure machine load — honest runs measured 650s to
      // 965s of driven time under a 24-process load, overlapping any bound
      // a tripled interval (830s measured) could fail (#568/#580). Probe
      // ARRIVAL SPACING inside one wedged generation is load-invariant:
      // it is pure fake-timer arithmetic, one expiry plus one interval
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
    // A daemon that wedges, is restarted, ANSWERS, then wedges again is being
    // recovered — not looping. Only consecutive wedges with nothing answered
    // in between are evidence, so this daemon must keep getting restarted.
    // MUTATION: drop the consecutiveWedges reset in probeOnce and the second
    // wedge condemns a daemon that demonstrably answered between the two.
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

  it("kills a wedged daemon as a transport failure, not a deliberate close", async () => {
    // A wedge kill is a REPLACEMENT. EngineWorkspaceSessions retries only
    // `transport-error`, so a plain close tells an editor session the daemon
    // went away on purpose and it stays failed across the restart already
    // under way — AUDIT-KILLREC, reached the second way.
    // MUTATION: call client.close() in reportWedge instead and the recorded
    // cause is "closed", which no retry path rebinds through.
    const clients: SelfExitingClient[] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      pingIntervalMs: 5,
      pingExpiryMs: 10,
      maxPingExpiries: 1,
      launch: async (options) => {
        const client = new SelfExitingClient(silentPing);
        client.exit = options.onExit;
        clients.push(client);
        return client;
      },
    });

    try {
      await lifecycle.start();
      await vi.waitFor(() => expect(clients.length).toBeGreaterThanOrEqual(2), WAIT);
      expect(clients[0]?.closed).toBe(true);
      expect(clients[0]?.closeCause).toBe("transport-error");
    } finally {
      await lifecycle.stop();
    }
  });

  it("kills the wedged daemon before the terminal report can block", async () => {
    // The desktop answers a terminal verdict with dialog.showErrorBox, which
    // does not return until the user dismisses the modal. Reporting first
    // would leave the wedged child alive behind that dialog for as long as it
    // stands, while this lifecycle already called the engine gone.
    // MUTATION: move the kill below reportFailure and the wedged client is
    // still open when the consumer regains control -> [false].
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
    // MUTATION: drop the inboundActivity check in sendPing and this daemon —
    // which never answers a probe but never stops sending — is killed as
    // wedged, restarting a daemon that is draining real work.
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

    // Output keeps arriving for OTHER callers throughout, exactly as it would
    // while the daemon writes down a queued backlog. No probe is ever answered.
    const traffic = setInterval(() => {
      for (const client of clients) client.inbound += 1;
    }, 2);
    try {
      await lifecycle.start();
      // Long enough for several expiries to pass and condemn it, if silence
      // were still being measured by the probe's own reply.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(failures).toEqual([]);
      expect(clients).toHaveLength(1);
      expect(clients[0]?.closed).toBe(false);
    } finally {
      clearInterval(traffic);
      await lifecycle.stop();
    }
  });

  it("counts a reply that lands between probe windows", async () => {
    // Probes do not tile the timeline: the next one starts an interval after
    // the previous RESOLVED, so with a 20ms expiry and a 30ms interval the
    // windows are [0,20], [50,70], [100,120] — and the gaps belong to nobody.
    // A reply delivered at 30ms, just after its own probe expired, is the
    // likeliest late frame there is. It still proves the daemon is turning.
    // MUTATION: baseline the activity count inside sendPing per window instead
    // of carrying it across verdicts, and every one of these replies lands in
    // a gap, is discarded, and this healthy daemon is killed as wedged.
    const clients: SelfExitingClient[] = [];
    const failures: Error[] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      pingIntervalMs: 30,
      pingExpiryMs: 20,
      maxPingExpiries: 3,
      launch: async (options) => {
        const client: SelfExitingClient = new SelfExitingClient((request) => {
          if (request.method !== "engine.ping") return healthyPing(request);
          // Answers, but too late for its own race — exactly the queued reply
          // that arrives once the daemon works through its output backlog.
          setTimeout(() => {
            client.inbound += 1;
          }, 30);
          return new Promise<Response>(() => {});
        });
        client.exit = options.onExit;
        clients.push(client);
        return client;
      },
      onFailure: (error) => failures.push(error),
    });

    try {
      await lifecycle.start();
      // Room for several expiries to accumulate a wedge verdict, if the gaps
      // were still being thrown away.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(failures).toEqual([]);
      expect(clients).toHaveLength(1);
      expect(clients[0]?.closed).toBe(false);
    } finally {
      await lifecycle.stop();
    }
  });

  it("never kills a daemon that answers engine.ping slowly or refuses it", async () => {
    // A saturated daemon answers: the request supervisor resolves a queued
    // request's own deadline before it competes for an execution slot, so the
    // probe comes back as a refusal rather than as silence.
    // MUTATION: count a rejected probe as an expiry, or drop the expiry bound
    // below the answer latency, and this kills a healthy daemon.
    const clients: FakeClient[] = [];
    const failures: Error[] = [];
    let probes = 0;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 1,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      pingIntervalMs: 2,
      pingExpiryMs: 40,
      maxPingExpiries: 1,
      launch: async () => {
        const client = new FakeClient(async (request) => {
          if (request.method !== "engine.ping") return healthyPing(request);
          probes += 1;
          const saturated = probes % 2 === 1;
          // Well inside the 40ms expiry bound, well past the 20ms deadline.
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (saturated) throw new Error("request deadline elapsed while queued");
          return { id: request.id, result: { ok: true } };
        });
        clients.push(client);
        return client;
      },
      onFailure: (error) => failures.push(error),
    });

    try {
      await lifecycle.start();
      await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(4), WAIT);
      expect(failures).toEqual([]);
      expect(clients).toHaveLength(1);
      expect(clients[0]?.closed).toBe(false);
    } finally {
      await lifecycle.stop();
    }
  });

  it("does not call a restarting daemon wedged", async () => {
    // A probe can still be in flight when its generation dies. The replacement
    // must not inherit that silence.
    // MUTATION: drop the liveness re-check after the probe settles and the
    // stale probe reports a wedge against a daemon that is already gone.
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const failures: Error[] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
      pingIntervalMs: 5,
      // 100ms of expiry bound: long enough that the first generation's probe is
      // still pending when the crash lands.
      pingExpiryMs: 100,
      maxPingExpiries: 1,
      launch: async (options) => {
        exits.push(options.onExit);
        return new FakeClient(
          exits.length === 1 ? silentPing : healthyPing,
        );
      },
      onFailure: (error) => failures.push(error),
    });

    try {
      await lifecycle.start();
      // Let the first probe get in flight, then crash under it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      exits[0]?.(1, null);
      await vi.waitFor(() => expect(exits).toHaveLength(2), WAIT);
      // Outlive the stale probe's expiry bound by a wide margin.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(failures.map((error) => error.message)).toEqual([
        "Rust engine daemon exited unexpectedly with code 1.",
      ]);
    } finally {
      await lifecycle.stop();
    }
  });

  it("counts a replacement that handshakes then hangs as a failed restart", async () => {
    let initialExit: EngineClientSpawnOptions["onExit"];
    let launchCount = 0;
    const failures: Array<{ error: Error; terminal: boolean }> = [];
    const healthyClient = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "health-handle" } };
      }
      return { id: request.id, result: null };
    });
    const hungClient = new FakeClient(
      () =>
        new Promise<Response>(() => {
          // The replacement completed helloAck but cannot serve requests.
        }),
    );
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 1,
      initialBackoffMs: 0,
      healthyResetMs: 20,
      requestTimeoutMs: 10,
      launch: async (options) => {
        launchCount += 1;
        if (launchCount === 1) {
          initialExit = options.onExit;
          return healthyClient;
        }
        return hungClient;
      },
      onFailure: (error, terminal) => {
        failures.push({ error, terminal });
      },
    });

    try {
      await lifecycle.start();
      initialExit?.(1, null);
      await vi.waitFor(() => expect(launchCount).toBe(2), WAIT);
      await vi.waitFor(
        () => {
          expect(
            failures.some(
              ({ error, terminal }) =>
                !terminal &&
                /workspace\.open timed out after 10ms/.test(error.message),
            ),
          ).toBe(true);
          expect(failures.some(({ terminal }) => terminal)).toBe(true);
        }, WAIT);
    } finally {
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

  it("opens a workspace and completes a versions.active smoke round-trip", async () => {
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "opaque-handle" } };
      }
      if (request.method === "versions.active") {
        return { id: request.id, result: { id: "main", kind: "main" } };
      }
      return { id: request.id, result: {} };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();
    await startupSmokeDone(client);
    client.requests.length = 0;

    await expect(
      lifecycle.smokeWorkspace("C:\\shadow-workspace", "smoke-workspace"),
    ).resolves.toEqual({ id: "main", kind: "main" });
    expect(client.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "versions.active",
      "workspace.close",
    ]);
    expect(client.requests[1]?.workspace).toBe("opaque-handle");
    await lifecycle.stop();
  });

  it("opens, binds, and closes a workspace around an injected CLI read", async () => {
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "cli-handle" } };
      }
      if (request.method === "search.queryChatMessagesGranular") {
        return {
          id: request.id,
          result: {
            results: [{
              threadId: "thread",
              messageId: null,
              text: "needle",
            }],
            saturated: false,
          },
        };
      }
      return { id: request.id, result: {} };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();
    await startupSmokeDone(client);
    client.requests.length = 0;

    await expect(
      lifecycle.requestWorkspace(
        "C:\\workspace",
        "workspace",
        "search.queryChatMessagesGranular",
        { query: "needle", limit: 50_000 },
      ),
    ).resolves.toEqual({
      results: [{
        threadId: "thread",
        messageId: null,
        text: "needle",
      }],
      saturated: false,
    });
    expect(client.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "search.queryChatMessagesGranular",
      "workspace.close",
    ]);
    expect(client.requests[0]?.params).toEqual({
      rootDir: "C:\\workspace",
      workspaceId: "workspace",
      recoverRunningDispatches: false,
      skipStartupMaintenance: true,
    });
    expect(client.requests[1]?.workspace).toBe("cli-handle");
    await lifecycle.stop();
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
    client.requests.length = 0;

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

  it("serializes concurrent CLI reads that share a workspace handle", async () => {
    let releaseFirst!: (response: Response) => void;
    let readCount = 0;
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "shared-handle" } };
      }
      if (request.method === "search.queryChatMessagesGranular") {
        readCount += 1;
        if (readCount === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { id: request.id, result: { results: [], saturated: false } };
      }
      return { id: request.id, result: {} };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();
    await startupSmokeDone(client);
    client.requests.length = 0;

    const first = lifecycle.requestWorkspace(
      "C:\\workspace",
      "workspace",
      "search.queryChatMessagesGranular",
      { query: "first", limit: 50_000 },
    );
    await vi.waitFor(() => expect(client.requests).toHaveLength(2), WAIT);
    const second = lifecycle.requestWorkspace(
      "C:\\workspace",
      "workspace",
      "search.queryChatMessagesGranular",
      { query: "second", limit: 50_000 },
    );
    await Promise.resolve();
    expect(client.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "search.queryChatMessagesGranular",
    ]);

    const firstRequest = client.requests[1];
    if (!firstRequest) throw new Error("First read was not sent");
    releaseFirst({
      id: firstRequest.id,
      result: { results: [], saturated: false },
    });
    await Promise.all([first, second]);
    expect(client.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "search.queryChatMessagesGranular",
      "workspace.close",
      "workspace.open",
      "search.queryChatMessagesGranular",
      "workspace.close",
    ]);
    await lifecycle.stop();
  });

  it("resolves start() on the handshake, before the startup smoke completes", async () => {
    // The hello/helloAck handshake already proves the daemon is alive and
    // speaking the protocol; the desktop blocks window creation on start(),
    // so the disk-heavy workspace smoke must not gate it.
    // MUTATION: await the smoke inside the first launch again and start()
    // cannot resolve while the smoke's workspace.open is still unanswered —
    // this test times out inside lifecycle.start().
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
      // The smoke still runs to completion in the background.
      await vi.waitFor(() => expect(openRequest).toBeDefined(), WAIT);
      if (!openRequest) throw new Error("smoke open was not sent");
      releaseOpen({
        id: openRequest.id,
        result: { workspace: "health-handle" },
      });
      await vi.waitFor(
        () =>
          expect(client.requests.map((request) => request.method)).toEqual([
            "workspace.open",
            "versions.active",
            "workspace.close",
          ]),
        WAIT,
      );
    } finally {
      await lifecycle.stop();
    }
  });

  it("routes a background smoke failure through onFailure and the restart path", async () => {
    // The smoke's own rejection reaches onFailure unwrapped and non-terminal
    // — the same error the blocking smoke used to throw out of start(). The
    // kill is a replacement (transport-error, like a wedge kill), and its
    // exit carries the failure into the ordinary restart machinery, whose
    // relaunch runs the BLOCKING smoke and takes over.
    // MUTATION: swallow the deferred smoke's rejection, or drop its kill,
    // and no failure is ever reported and no replacement is launched.
    const clients: SelfExitingClient[] = [];
    const failures: Array<{ error: Error; terminal: boolean }> = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: WINDOW_TEST_MAX_RESTARTS,
      initialBackoffMs: 0,
      healthyResetMs: HEALTHY_RESET_MS,
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
      expect(clients[0]?.closed).toBe(true);
      expect(clients[0]?.closeCause).toBe("transport-error");
      expect(
        failures.map(({ error, terminal }) => [error.message, terminal]),
      ).toEqual([
        ["smoke integrity check failed", false],
        ["Rust engine daemon exited unexpectedly with signal SIGTERM.", false],
      ]);
    } finally {
      await lifecycle.stop();
    }
  });

  it("reports a hung startup smoke within the request bound after start() resolves", async () => {
    const client = new FakeClient(
      () =>
        new Promise<Response>(() => {
          // Deliberately never settles: the daemon completed helloAck but
          // stopped processing requests.
        }),
    );
    const failures: Array<{ error: Error; terminal: boolean }> = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      requestTimeoutMs: 20,
      launch: async () => client,
      onFailure: (error, terminal) => {
        failures.push({ error, terminal });
      },
    });

    const startedAt = Date.now();
    await lifecycle.start();
    await vi.waitFor(() => expect(failures).toHaveLength(1), WAIT);
    expect(failures[0]?.error.message).toMatch(
      /workspace\.open timed out after 20ms/,
    );
    expect(failures[0]?.terminal).toBe(false);
    // Proves the 20ms request timer drove the failure rather than a hang
    // or a mis-armed slower timer. This bound stays at its original 500ms:
    // this exact path never failed under load in 12 measured runs (#568),
    // and evidence borrowed from another path cannot widen a discrimination
    // bound this one never broke — widening it would let a regression that
    // delays the startup timeout to just under the ceiling pass unseen.
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(client.closed).toBe(true);
    await lifecycle.stop();
  });

  it("times out workspace opens with an engine deadline and cancellation", async () => {
    let hangOpen = false;
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open" && hangOpen) {
        return new Promise<Response>(() => {
          // The daemon never acknowledges this real-workspace open.
        });
      }
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "health-handle" } };
      }
      return { id: request.id, result: null };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      requestTimeoutMs: 20,
      launch: async () => client,
    });

    await lifecycle.start();
    await startupSmokeDone(client);
    client.requests.length = 0;
    client.cancelledRequestIds.length = 0;
    hangOpen = true;
    await expect(
      lifecycle.requestWorkspace(
        "C:\\workspace",
        "workspace",
        "search.queryChatMessagesGranular",
        { query: "needle", limit: 50_000 },
      ),
    ).rejects.toThrow(
      /workspace\.open timed out after 20ms/,
    );
    expect(client.requests[0]?.deadlineMs).toBe(20);
    expect(client.cancelledRequestIds).toEqual([client.requests[0]?.id]);
    expect(client.closed).toBe(true);
    await lifecycle.stop();
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

  it.runIf(process.env.DOHC_TEST_REAL_RUST_ENGINE === "1")(
    "completes the startup smoke against the real Rust daemon",
    async () => {
      const lifecycle = createRustEngineDaemon({
        command: defaultEngineBinaryPath({
          isPackaged: false,
          appPath: process.cwd(),
        }),
      });
      try {
        await lifecycle.start();
        // A fresh shadow database currently has no active version. The null
        // result is still a successful, decoded versions.active round-trip.
        await expect(runEngineDaemonStartupSmoke(lifecycle)).resolves.toBeNull();
      } finally {
        await lifecycle.stop();
      }
    },
  );
});
