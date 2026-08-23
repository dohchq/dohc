import { COMMAND_CLAIMS_DRAIN_DEADLINE_MS } from "./pluginShared";

export interface OwnedPluginHost {
  isRunning(pluginId: string): boolean;
  stop(pluginId: string): Promise<void>;
  bumpGeneration(): void;
  stopAll(): Promise<void>;
}

export interface PluginHostOwnershipOptions {
  drainTimeoutMs?: number;
}

export type PluginHostCommandRefusal = {
  kind: "refused";
  reason: "change-in-progress" | "closed";
};

export type PluginHostCommandStart<T> =
  | { kind: "admitted"; value: T }
  | PluginHostCommandRefusal;

export interface PluginHostCommandStartResult<T> {
  value: T;
  startedHost: boolean;
}

const commandLeaseBrand: unique symbol = Symbol("PluginHostCommandLease");
const changeLeaseBrand: unique symbol = Symbol("PluginHostChangeLease");
const stopOpportunityBrand: unique symbol = Symbol(
  "PluginHostStopOpportunity",
);

export interface PluginHostCommandLease {
  readonly [commandLeaseBrand]: true;

  start<T>(
    enqueue: () => Promise<PluginHostCommandStartResult<T>>,
  ): Promise<PluginHostCommandStart<T>>;

  release(): PluginHostStopOpportunity | null;
}

export type PluginHostChangeStopOutcome =
  | {
      kind: "stopped";
      drained: boolean;
      stopError?: unknown;
    }
  | {
      kind: "refused";
      reason: "self-drain";
    }
  | {
      kind: "superseded";
      drained: boolean;
    };

export interface PluginHostChangeLease {
  readonly [changeLeaseBrand]: true;

  stop(): Promise<PluginHostChangeStopOutcome>;
  adopt(): void;
  release(): PluginHostStopOpportunity | null;
}

export interface PluginHostStopOpportunity {
  readonly [stopOpportunityBrand]: true;
  readonly pluginId: string;
}

export type PluginHostStopUnclaimedOutcome =
  | { kind: "stopped"; stopError?: unknown }
  | { kind: "superseded" }
  | { kind: "failed"; error: unknown };

interface PluginOwnershipState {
  readonly pluginId: string;
  epoch: number;
  readonly commands: Set<CommandLease>;
  readonly changes: Set<ChangeLease>;
  onDemandEpoch: number | null;
  adoptedEpoch: number | null;
  stopInFlight: Promise<HostStopAttempt> | null;
}

type HostStopAttempt =
  | { kind: "stopped"; stopError?: unknown }
  | { kind: "failed"; error: unknown };

let nextEpoch = 1;

function newEpoch(): number {
  const epoch = nextEpoch;
  nextEpoch += 1;
  return epoch;
}

function releaseSignal(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshotDrained(
  releases: ReadonlyArray<Promise<void>>,
  timeoutMs: number,
): Promise<boolean> {
  if (releases.length === 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(drained);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    void Promise.all(releases).then(() => finish(true));
  });
}

function isAdmissionOpen(state: PluginOwnershipState): boolean {
  if (state.changes.size > 0) return false;
  for (const command of state.commands) {
    if (command.overranDrain) return false;
  }
  return true;
}

function isIdle(state: PluginOwnershipState): boolean {
  return (
    state.commands.size === 0 &&
    state.changes.size === 0 &&
    state.stopInFlight === null
  );
}

const startCommand = Symbol("startCommand");
const releaseCommand = Symbol("releaseCommand");
const stopChange = Symbol("stopChange");
const adoptChange = Symbol("adoptChange");
const releaseChange = Symbol("releaseChange");

class CommandLease implements PluginHostCommandLease {
  readonly [commandLeaseBrand] = true;
  readonly released = releaseSignal();
  active = true;
  epoch: number;
  overranDrain = false;

  constructor(
    readonly owner: PluginHostOwnership,
    readonly state: PluginOwnershipState,
  ) {
    this.epoch = state.epoch;
  }

  start<T>(
    enqueue: () => Promise<PluginHostCommandStartResult<T>>,
  ): Promise<PluginHostCommandStart<T>> {
    return this.owner[startCommand](this, enqueue);
  }

  release(): PluginHostStopOpportunity | null {
    return this.owner[releaseCommand](this);
  }

  invalidate(): void {
    if (!this.active) return;
    this.active = false;
    this.released.resolve();
  }
}

class ChangeLease implements PluginHostChangeLease {
  readonly [changeLeaseBrand] = true;
  readonly released = releaseSignal();
  active = true;
  stopPromise: Promise<PluginHostChangeStopOutcome> | null = null;

  constructor(
    readonly owner: PluginHostOwnership,
    readonly state: PluginOwnershipState,
    readonly epoch: number,
    readonly origin: CommandLease | undefined,
  ) {}

  stop(): Promise<PluginHostChangeStopOutcome> {
    this.stopPromise ??= this.owner[stopChange](this);
    return this.stopPromise;
  }

  adopt(): void {
    this.owner[adoptChange](this);
  }

  release(): PluginHostStopOpportunity | null {
    return this.owner[releaseChange](this);
  }

  invalidate(): void {
    if (!this.active) return;
    this.active = false;
    this.released.resolve();
  }
}

class StopOpportunity implements PluginHostStopOpportunity {
  readonly [stopOpportunityBrand] = true;

  constructor(
    readonly owner: PluginHostOwnership,
    readonly pluginId: string,
    readonly epoch: number,
  ) {}
}

export class PluginHostOwnership {
  readonly #host: OwnedPluginHost;
  readonly #drainTimeoutMs: number;
  readonly #states = new Map<string, PluginOwnershipState>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    host: OwnedPluginHost,
    options: PluginHostOwnershipOptions = {},
  ) {
    this.#host = host;
    this.#drainTimeoutMs =
      options.drainTimeoutMs ?? COMMAND_CLAIMS_DRAIN_DEADLINE_MS;
    if (
      !Number.isFinite(this.#drainTimeoutMs) ||
      this.#drainTimeoutMs < 0
    ) {
      throw new RangeError("drainTimeoutMs must be a non-negative number");
    }
  }

  claimCommand(
    pluginId: string,
  ): PluginHostCommandLease | PluginHostCommandRefusal {
    if (this.#closed) return { kind: "refused", reason: "closed" };
    const state = this.#state(pluginId);
    if (!isAdmissionOpen(state)) {
      return { kind: "refused", reason: "change-in-progress" };
    }

    const lease = new CommandLease(this, state);
    state.commands.add(lease);
    return lease;
  }

  beginChange(
    pluginId: string,
    origin?: PluginHostCommandLease,
  ): PluginHostChangeLease {
    if (this.#closed) {
      throw new Error("Plugin host ownership is closed");
    }

    let commandOrigin: CommandLease | undefined;
    if (origin !== undefined) {
      if (!(origin instanceof CommandLease) || origin.owner !== this) {
        throw new Error("Change origin belongs to another ownership scope");
      }
      if (origin.state.pluginId !== pluginId) {
        throw new Error("Change origin belongs to another plugin");
      }
      commandOrigin = origin;
    }

    const state = this.#state(pluginId);
    const lease = new ChangeLease(
      this,
      state,
      state.epoch,
      commandOrigin,
    );
    state.changes.add(lease);
    return lease;
  }

  async stopUnclaimed(
    opportunity: PluginHostStopOpportunity,
  ): Promise<PluginHostStopUnclaimedOutcome> {
    if (
      this.#closed ||
      !(opportunity instanceof StopOpportunity) ||
      opportunity.owner !== this
    ) {
      return { kind: "superseded" };
    }

    const state = this.#states.get(opportunity.pluginId);
    if (
      !state ||
      state.epoch !== opportunity.epoch ||
      state.onDemandEpoch !== opportunity.epoch ||
      !isIdle(state)
    ) {
      return { kind: "superseded" };
    }

    const attempt = await this.#runHostStop(state, opportunity.epoch);
    if (attempt.kind === "failed") return attempt;
    return attempt.stopError === undefined
      ? { kind: "stopped" }
      : { kind: "stopped", stopError: attempt.stopError };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;

    const releases: Promise<void>[] = [];
    for (const state of this.#states.values()) {
      for (const command of state.commands) {
        if (!command.overranDrain) releases.push(command.released.promise);
      }
      for (const change of state.changes) {
        releases.push(change.released.promise);
      }
      if (state.stopInFlight) releases.push(state.stopInFlight.then(() => {}));
    }

    this.#closePromise = this.#finishClose(releases);
    return this.#closePromise;
  }

  async [startCommand]<T>(
    lease: CommandLease,
    enqueue: () => Promise<PluginHostCommandStartResult<T>>,
  ): Promise<PluginHostCommandStart<T>> {
    const stopping = lease.state.stopInFlight;
    if (stopping) await stopping;

    if (!lease.active || this.#closed) {
      return { kind: "refused", reason: "closed" };
    }
    if (!isAdmissionOpen(lease.state)) {
      return { kind: "refused", reason: "change-in-progress" };
    }

    lease.epoch = lease.state.epoch;
    const result = await enqueue();
    if (
      result.startedHost &&
      lease.active &&
      !this.#closed &&
      lease.state.epoch === lease.epoch &&
      lease.state.adoptedEpoch !== lease.epoch
    ) {
      lease.state.onDemandEpoch = lease.epoch;
    }
    return { kind: "admitted", value: result.value };
  }

  [releaseCommand](lease: CommandLease): PluginHostStopOpportunity | null {
    if (!lease.active) return null;
    lease.active = false;
    lease.state.commands.delete(lease);
    lease.released.resolve();
    return this.#stopOpportunity(lease.state);
  }

  async [stopChange](
    lease: ChangeLease,
  ): Promise<PluginHostChangeStopOutcome> {
    if (!lease.active || this.#closed) {
      return { kind: "superseded", drained: true };
    }
    if (lease.origin?.active) {
      return { kind: "refused", reason: "self-drain" };
    }

    const snapshot = [...lease.state.commands].filter(
      (command) => !command.overranDrain,
    );
    const drained = await snapshotDrained(
      snapshot.map((command) => command.released.promise),
      this.#drainTimeoutMs,
    );
    if (!drained) {
      for (const command of snapshot) {
        if (command.active) command.overranDrain = true;
      }
    }

    if (
      !lease.active ||
      this.#closed ||
      lease.state.epoch !== lease.epoch
    ) {
      return { kind: "superseded", drained };
    }

    const stopping = lease.state.stopInFlight;
    if (stopping) {
      await stopping;
      if (
        !lease.active ||
        this.#closed ||
        lease.state.epoch !== lease.epoch
      ) {
        return { kind: "superseded", drained };
      }
    }

    const attempt = await this.#runHostStop(lease.state, lease.epoch);
    if (attempt.kind === "failed") throw attempt.error;
    return attempt.stopError === undefined
      ? { kind: "stopped", drained }
      : { kind: "stopped", drained, stopError: attempt.stopError };
  }

  [adoptChange](lease: ChangeLease): void {
    if (
      !lease.active ||
      this.#closed ||
      lease.state.epoch !== lease.epoch
    ) {
      return;
    }
    if (lease.state.onDemandEpoch === lease.epoch) {
      lease.state.onDemandEpoch = null;
    }
    lease.state.adoptedEpoch = lease.epoch;
  }

  [releaseChange](lease: ChangeLease): PluginHostStopOpportunity | null {
    if (!lease.active) return null;
    lease.active = false;
    lease.state.changes.delete(lease);
    lease.released.resolve();
    return this.#stopOpportunity(lease.state);
  }

  #state(pluginId: string): PluginOwnershipState {
    const existing = this.#states.get(pluginId);
    if (existing) return existing;
    const state: PluginOwnershipState = {
      pluginId,
      epoch: newEpoch(),
      commands: new Set(),
      changes: new Set(),
      onDemandEpoch: null,
      adoptedEpoch: null,
      stopInFlight: null,
    };
    this.#states.set(pluginId, state);
    return state;
  }

  #stopOpportunity(
    state: PluginOwnershipState,
  ): PluginHostStopOpportunity | null {
    if (
      this.#closed ||
      !isIdle(state) ||
      state.onDemandEpoch !== state.epoch
    ) {
      return null;
    }
    return new StopOpportunity(this, state.pluginId, state.epoch);
  }

  #runHostStop(
    state: PluginOwnershipState,
    epoch: number,
  ): Promise<HostStopAttempt> {
    if (state.stopInFlight) {
      return Promise.resolve({
        kind: "failed",
        error: new Error(`Plugin "${state.pluginId}" is already stopping`),
      });
    }

    let resolveAttempt!: (attempt: HostStopAttempt) => void;
    const attempt = new Promise<HostStopAttempt>((resolve) => {
      resolveAttempt = resolve;
    });
    state.stopInFlight = attempt;
    void this.#performHostStop(state, epoch).then(
      (result) => {
        if (state.stopInFlight === attempt) state.stopInFlight = null;
        resolveAttempt(result);
      },
      (error: unknown) => {
        if (state.stopInFlight === attempt) state.stopInFlight = null;
        resolveAttempt({ kind: "failed", error });
      },
    );
    return attempt;
  }

  async #performHostStop(
    state: PluginOwnershipState,
    epoch: number,
  ): Promise<HostStopAttempt> {
    if (state.epoch !== epoch) {
      return { kind: "failed", error: new Error("Stop epoch was superseded") };
    }

    let stopError: unknown;
    try {
      await this.#host.stop(state.pluginId);
    } catch (error) {
      stopError = error;
    }

    if (this.#host.isRunning(state.pluginId)) {
      return {
        kind: "failed",
        error:
          stopError ??
          new Error(
            `Plugin "${state.pluginId}" remained live after its host stop resolved`,
          ),
      };
    }

    state.epoch = newEpoch();
    state.onDemandEpoch = null;
    state.adoptedEpoch = null;
    return stopError === undefined
      ? { kind: "stopped" }
      : { kind: "stopped", stopError };
  }

  async #finishClose(releases: ReadonlyArray<Promise<void>>): Promise<void> {
    try {
      await snapshotDrained(releases, this.#drainTimeoutMs);
      this.#host.bumpGeneration();
      await this.#host.stopAll();
    } finally {
      this.#reset();
    }
  }

  #reset(): void {
    for (const state of this.#states.values()) {
      for (const command of state.commands) command.invalidate();
      for (const change of state.changes) change.invalidate();
      state.commands.clear();
      state.changes.clear();
      state.onDemandEpoch = null;
      state.adoptedEpoch = null;
      state.epoch = newEpoch();
      state.stopInFlight = null;
    }
    this.#states.clear();
  }
}
