import type {
  PluginHostRecordToken,
  PluginHostStartEvidence,
} from "./PluginHost";
import { COMMAND_CLAIMS_DRAIN_DEADLINE_MS } from "./pluginShared";

export interface OwnedPluginHost {
  currentRecord(pluginId: string): PluginHostRecordToken | undefined;
  stop(pluginId: string): Promise<void>;
  stopRecord(pluginId: string, record: PluginHostRecordToken): Promise<void>;
  bumpGeneration(): void;
  stopAll(): Promise<void>;
}

export interface PluginHostOwnershipOptions {
  drainTimeoutMs?: number;
  onCleanupError?: (pluginId: string, error: unknown) => void;
}

export type PluginHostAdmissionRefusal = {
  kind: "refused";
  reason: "change-in-progress" | "closed";
};

export interface PluginHostStartResult<T> {
  value: T;
  evidence?: PluginHostStartEvidence;
}

export type PluginHostStartOutcome<T> =
  | { kind: "admitted"; value: T }
  | PluginHostAdmissionRefusal;

export type PluginHostCommandRunOutcome<T> =
  | { kind: "completed"; value: T }
  | PluginHostAdmissionRefusal;

export type PluginHostChangeStopOutcome =
  | { kind: "stopped"; drained: boolean; stopError?: unknown }
  | { kind: "refused"; reason: "self-drain" }
  | { kind: "superseded"; drained: boolean };

const commandAuthorityBrand: unique symbol = Symbol(
  "PluginHostCommandAuthority",
);
const surfaceLeaseBrand: unique symbol = Symbol("PluginHostSurfaceLease");
const surfaceStartAuthorityBrand: unique symbol = Symbol(
  "PluginHostSurfaceStartAuthority",
);
const changeReservationBrand: unique symbol = Symbol(
  "PluginHostChangeReservation",
);
const changeAuthorityBrand: unique symbol = Symbol(
  "PluginHostChangeAuthority",
);
const changeCompletionBrand: unique symbol = Symbol(
  "PluginHostChangeCompletion",
);

export interface PluginHostCommandAuthority {
  readonly [commandAuthorityBrand]: true;

  start<T>(
    enqueue: () => Promise<PluginHostStartResult<T>>,
  ): Promise<PluginHostStartOutcome<T>>;

  runChange<T>(
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T>;
}

export interface PluginHostSurfaceLease {
  readonly [surfaceLeaseBrand]: true;

  start<T>(
    enqueue: (
      authority: PluginHostSurfaceStartAuthority,
    ) => Promise<PluginHostStartResult<T>>,
  ): Promise<PluginHostStartOutcome<T>>;

  release(): Promise<void>;
}

export interface PluginHostSurfaceStartAuthority {
  readonly [surfaceStartAuthorityBrand]: true;

  runChange<T>(
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T>;
}

export interface PluginHostChangeReservation {
  readonly [changeReservationBrand]: true;

  run<T>(
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T>;
  cancel(): Promise<void>;
}

export interface PluginHostChangeAuthority {
  readonly [changeAuthorityBrand]: true;

  stop(): Promise<PluginHostChangeStopOutcome>;
  adopt<T>(value: T): PluginHostChangeCompletion<T>;
  preserve<T>(value: T): PluginHostChangeCompletion<T>;
}

export interface PluginHostChangeCompletion<T> {
  readonly [changeCompletionBrand]: true;
  readonly value: T;
}

interface PluginOwnershipState {
  readonly pluginId: string;
  epoch: number;
  readonly commands: Set<CommandAuthority>;
  readonly surfaces: Set<SurfaceLease>;
  readonly pendingChanges: Set<ChangeReservation>;
  readonly changes: Set<ChangeAuthority>;
  onDemand: {
    readonly epoch: number;
    readonly record: PluginHostRecordToken;
  } | null;
  adoptedRecord: PluginHostRecordToken | null;
  stopInFlight: Promise<HostStopAttempt> | null;
}

type HostStopAttempt =
  | { kind: "stopped"; stopError?: unknown }
  | { kind: "failed"; error: unknown };

interface DrainMember {
  readonly released: Promise<void>;
  readonly active: () => boolean;
  readonly markOverran: () => void;
}

interface StopOpportunity {
  readonly state: PluginOwnershipState;
  readonly epoch: number;
  readonly record: PluginHostRecordToken;
}

let nextEpoch = 1;

function newEpoch(): number {
  const epoch = nextEpoch;
  nextEpoch += 1;
  return epoch;
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshotDrained(
  members: ReadonlyArray<DrainMember>,
  timeoutMs: number,
): Promise<boolean> {
  if (members.length === 0) return Promise.resolve(true);
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
    void Promise.all(members.map((member) => member.released)).then(() =>
      finish(true),
    );
  });
}

function admissionOpen(state: PluginOwnershipState): boolean {
  if (state.pendingChanges.size > 0 || state.changes.size > 0) return false;
  for (const command of state.commands) {
    if (command.overranDrain) return false;
  }
  for (const surface of state.surfaces) {
    if (surface.overranStart) return false;
  }
  return true;
}

function idle(state: PluginOwnershipState): boolean {
  return (
    state.commands.size === 0 &&
    state.surfaces.size === 0 &&
    state.pendingChanges.size === 0 &&
    state.changes.size === 0 &&
    state.stopInFlight === null
  );
}

const startCommand = Symbol("startCommand");
const runCommandChange = Symbol("runCommandChange");
const startSurface = Symbol("startSurface");
const runSurfaceChange = Symbol("runSurfaceChange");
const releaseSurface = Symbol("releaseSurface");
const runReservedChange = Symbol("runReservedChange");
const cancelReservedChange = Symbol("cancelReservedChange");
const stopChange = Symbol("stopChange");
const completeChange = Symbol("completeChange");

class CommandAuthority implements PluginHostCommandAuthority {
  readonly [commandAuthorityBrand] = true;
  readonly released = signal();
  active = true;
  epoch: number;
  overranDrain = false;
  startUsed = false;
  startPromise: Promise<PluginHostStartOutcome<unknown>> | null = null;
  readonly changePromises: Promise<unknown>[] = [];

  constructor(
    readonly owner: PluginHostOwnership,
    readonly state: PluginOwnershipState,
  ) {
    this.epoch = state.epoch;
  }

  start<T>(
    enqueue: () => Promise<PluginHostStartResult<T>>,
  ): Promise<PluginHostStartOutcome<T>> {
    if (this.startUsed) {
      return Promise.reject(new Error("Command start has already been used."));
    }
    this.startUsed = true;
    const started = this.owner[startCommand](this, enqueue);
    this.startPromise = started;
    return started;
  }

  runChange<T>(
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    if (!this.active) {
      return Promise.reject(new Error("Command authority is no longer active."));
    }
    const changed = this.owner[runCommandChange](this, operation);
    this.changePromises.push(changed);
    return changed;
  }

  invalidate(): void {
    if (!this.active) return;
    this.active = false;
    this.released.resolve();
  }
}

class SurfaceStartAuthority implements PluginHostSurfaceStartAuthority {
  readonly [surfaceStartAuthorityBrand] = true;
  active = true;
  readonly changePromises: Promise<unknown>[] = [];

  constructor(
    readonly owner: PluginHostOwnership,
    readonly lease: SurfaceLease,
  ) {}

  runChange<T>(
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    if (!this.active) {
      return Promise.reject(
        new Error("Surface start authority is no longer active."),
      );
    }
    const changed = this.owner[runSurfaceChange](this, operation);
    this.changePromises.push(changed);
    return changed;
  }

  invalidate(): void {
    this.active = false;
  }
}

class ChangeReservation implements PluginHostChangeReservation {
  readonly [changeReservationBrand] = true;
  readonly released = signal();
  active = true;
  runUsed = false;
  cancelPromise: Promise<void> | null = null;

  constructor(
    readonly owner: PluginHostOwnership,
    readonly state: PluginOwnershipState,
  ) {}

  run<T>(
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    if (!this.active) {
      return Promise.reject(
        new Error("Change reservation is no longer active."),
      );
    }
    if (this.runUsed) {
      return Promise.reject(new Error("Change reservation has already run."));
    }
    this.runUsed = true;
    return this.owner[runReservedChange](this, operation);
  }

  cancel(): Promise<void> {
    this.cancelPromise ??= this.owner[cancelReservedChange](this);
    return this.cancelPromise;
  }

  invalidate(): void {
    if (!this.active) return;
    this.active = false;
    this.released.resolve();
  }
}

class SurfaceLease implements PluginHostSurfaceLease {
  readonly [surfaceLeaseBrand] = true;
  readonly startSettled = signal();
  readonly invalidated = signal();
  readonly releaseRequestedSignal = signal();
  active = true;
  epoch: number;
  startUsed = false;
  startEnqueued = false;
  overranStart = false;
  releaseRequested = false;
  startPromise: Promise<PluginHostStartOutcome<unknown>> | null = null;
  releasePromise: Promise<void> | null = null;

  constructor(
    readonly owner: PluginHostOwnership,
    readonly state: PluginOwnershipState,
  ) {
    this.epoch = state.epoch;
  }

  start<T>(
    enqueue: (
      authority: PluginHostSurfaceStartAuthority,
    ) => Promise<PluginHostStartResult<T>>,
  ): Promise<PluginHostStartOutcome<T>> {
    if (this.startUsed) {
      return Promise.reject(new Error("Surface start has already been used."));
    }
    this.startUsed = true;
    const started = this.owner[startSurface](this, enqueue);
    this.startPromise = started;
    void started.then(
      () => {
        this.startEnqueued = false;
        this.overranStart = false;
        this.startSettled.resolve();
      },
      () => {
        this.startEnqueued = false;
        this.overranStart = false;
        this.startSettled.resolve();
      },
    );
    return started;
  }

  release(): Promise<void> {
    this.releaseRequested = true;
    this.releaseRequestedSignal.resolve();
    this.releasePromise ??= this.owner[releaseSurface](this);
    return this.releasePromise;
  }

  invalidate(): void {
    if (!this.active) return;
    this.active = false;
    this.invalidated.resolve();
  }
}

class ChangeCompletion<T> implements PluginHostChangeCompletion<T> {
  readonly [changeCompletionBrand] = true;

  constructor(
    readonly change: ChangeAuthority,
    readonly disposition: "adopt" | "preserve",
    readonly value: T,
  ) {}
}

class ChangeAuthority implements PluginHostChangeAuthority {
  readonly [changeAuthorityBrand] = true;
  readonly released = signal();
  active = true;
  stopPromise: Promise<PluginHostChangeStopOutcome> | null = null;

  constructor(
    readonly owner: PluginHostOwnership,
    readonly state: PluginOwnershipState,
    readonly epoch: number,
    readonly origin: CommandAuthority | SurfaceStartAuthority | undefined,
    readonly preserveOnDemand: boolean,
  ) {}

  stop(): Promise<PluginHostChangeStopOutcome> {
    this.stopPromise ??= this.owner[stopChange](this);
    return this.stopPromise;
  }

  adopt<T>(value: T): PluginHostChangeCompletion<T> {
    return this.owner[completeChange](this, "adopt", value);
  }

  preserve<T>(value: T): PluginHostChangeCompletion<T> {
    return this.owner[completeChange](this, "preserve", value);
  }

  invalidate(): void {
    if (!this.active) return;
    this.active = false;
    this.released.resolve();
  }
}

export class PluginHostOwnership {
  readonly #host: OwnedPluginHost;
  readonly #drainTimeoutMs: number;
  readonly #onCleanupError: (pluginId: string, error: unknown) => void;
  readonly #states = new Map<string, PluginOwnershipState>();
  readonly #consumedStartEvidence = new WeakSet<object>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    host: OwnedPluginHost,
    options: PluginHostOwnershipOptions = {},
  ) {
    this.#host = host;
    this.#drainTimeoutMs =
      options.drainTimeoutMs ?? COMMAND_CLAIMS_DRAIN_DEADLINE_MS;
    this.#onCleanupError = options.onCleanupError ?? (() => undefined);
    if (
      !Number.isFinite(this.#drainTimeoutMs) ||
      this.#drainTimeoutMs < 0
    ) {
      throw new RangeError("drainTimeoutMs must be a non-negative number");
    }
  }

  runCommand<T>(
    pluginId: string,
    operation: (command: PluginHostCommandAuthority) => Promise<T>,
  ): Promise<PluginHostCommandRunOutcome<T>> {
    if (this.#closed) {
      return Promise.resolve({ kind: "refused", reason: "closed" });
    }
    const state = this.#state(pluginId);
    if (!admissionOpen(state)) {
      return Promise.resolve({
        kind: "refused",
        reason: "change-in-progress",
      });
    }

    const authority = new CommandAuthority(this, state);
    state.commands.add(authority);
    return this.#executeCommand(authority, operation);
  }

  acquireSurface(
    pluginId: string,
  ): PluginHostSurfaceLease | PluginHostAdmissionRefusal {
    if (this.#closed) return { kind: "refused", reason: "closed" };
    const state = this.#state(pluginId);
    const lease = new SurfaceLease(this, state);
    state.surfaces.add(lease);
    return lease;
  }

  runChange<T>(
    pluginId: string,
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    return this.reserveChange(pluginId).run(operation);
  }

  reserveChange(pluginId: string): PluginHostChangeReservation {
    if (this.#closed) throw new Error("Plugin host ownership is closed");
    const state = this.#state(pluginId);
    const reservation = new ChangeReservation(this, state);
    state.pendingChanges.add(reservation);
    return reservation;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const releases: Promise<void>[] = [];
    for (const state of this.#states.values()) {
      for (const reservation of state.pendingChanges) reservation.invalidate();
      state.pendingChanges.clear();
      for (const command of state.commands) {
        if (!command.overranDrain) releases.push(command.released.promise);
      }
      for (const change of state.changes) {
        releases.push(change.released.promise);
      }
      for (const surface of state.surfaces) {
        if (surface.startEnqueued && surface.startPromise) {
          releases.push(surface.startPromise.then(() => {}, () => {}));
        }
      }
      if (state.stopInFlight) releases.push(state.stopInFlight.then(() => {}));
    }
    this.#closePromise = this.#finishClose(releases);
    return this.#closePromise;
  }

  async [startCommand]<T>(
    authority: CommandAuthority,
    enqueue: () => Promise<PluginHostStartResult<T>>,
  ): Promise<PluginHostStartOutcome<T>> {
    const stopping = authority.state.stopInFlight;
    if (stopping) await stopping;
    if (!authority.active || this.#closed) {
      throw new Error("Command authority is no longer active.");
    }
    if (!admissionOpen(authority.state)) {
      return { kind: "refused", reason: "change-in-progress" };
    }

    authority.epoch = authority.state.epoch;
    const result = await enqueue();
    const refusal = await this.#acceptStartEvidence(
      authority.state,
      authority.epoch,
      result.evidence,
    );
    if (refusal) return refusal;
    return { kind: "admitted", value: result.value };
  }

  [runCommandChange]<T>(
    authority: CommandAuthority,
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    return this.#beginChange(authority.state, authority, operation);
  }

  [runSurfaceChange]<T>(
    authority: SurfaceStartAuthority,
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    return this.#beginChange(authority.lease.state, authority, operation);
  }

  async [startSurface]<T>(
    lease: SurfaceLease,
    enqueue: (
      authority: PluginHostSurfaceStartAuthority,
    ) => Promise<PluginHostStartResult<T>>,
  ): Promise<PluginHostStartOutcome<T>> {
    for (;;) {
      if (!lease.active || lease.releaseRequested || this.#closed) {
        return { kind: "refused", reason: "closed" };
      }
      const waits: Promise<unknown>[] = [];
      if (lease.state.stopInFlight) waits.push(lease.state.stopInFlight);
      for (const reservation of lease.state.pendingChanges) {
        waits.push(reservation.released.promise);
      }
      for (const change of lease.state.changes) {
        waits.push(change.released.promise);
      }
      if (waits.length === 0) break;
      await Promise.race([
        Promise.allSettled(waits),
        lease.releaseRequestedSignal.promise,
        lease.invalidated.promise,
      ]);
    }

    if (!lease.active || lease.releaseRequested || this.#closed) {
      return { kind: "refused", reason: "closed" };
    }
    lease.epoch = lease.state.epoch;
    lease.startEnqueued = true;
    const authority = new SurfaceStartAuthority(this, lease);
    let result!: PluginHostStartResult<T>;
    let operationError: unknown;
    let failed = false;
    try {
      result = await enqueue(authority);
    } catch (error) {
      failed = true;
      operationError = error;
    }
    await this.#settleChanges(authority.changePromises);
    authority.invalidate();
    if (failed) throw operationError;
    if (!lease.overranStart) lease.epoch = lease.state.epoch;
    const refusal = await this.#acceptStartEvidence(
      lease.state,
      lease.epoch,
      result.evidence,
    );
    if (refusal) return refusal;
    return { kind: "admitted", value: result.value };
  }

  [releaseSurface](lease: SurfaceLease): Promise<void> {
    return this.#finishSurfaceRelease(lease);
  }

  [runReservedChange]<T>(
    reservation: ChangeReservation,
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    if (!reservation.active || this.#closed) {
      return Promise.reject(
        new Error("Change reservation is no longer active."),
      );
    }
    reservation.invalidate();
    reservation.state.pendingChanges.delete(reservation);
    return this.#beginChange(reservation.state, undefined, operation);
  }

  [cancelReservedChange](reservation: ChangeReservation): Promise<void> {
    if (!reservation.active) return Promise.resolve();
    reservation.invalidate();
    reservation.state.pendingChanges.delete(reservation);
    return this.#cleanup(this.#stopOpportunity(reservation.state));
  }

  async [stopChange](
    change: ChangeAuthority,
  ): Promise<PluginHostChangeStopOutcome> {
    if (!change.active || this.#closed) {
      return { kind: "superseded", drained: true };
    }
    if (change.origin instanceof CommandAuthority && change.origin.active) {
      return { kind: "refused", reason: "self-drain" };
    }

    const excludedSurface =
      change.origin instanceof SurfaceStartAuthority && change.origin.active
        ? change.origin.lease
        : undefined;
    const members = this.#drainMembers(change.state, excludedSurface);
    const drained = await snapshotDrained(members, this.#drainTimeoutMs);
    if (!drained) {
      for (const member of members) {
        if (member.active()) member.markOverran();
      }
    }
    if (!change.active || this.#closed || change.state.epoch !== change.epoch) {
      return { kind: "superseded", drained };
    }

    const stopping = change.state.stopInFlight;
    if (stopping) {
      await stopping;
      if (
        !change.active ||
        this.#closed ||
        change.state.epoch !== change.epoch
      ) {
        return { kind: "superseded", drained };
      }
    }

    const attempt = await this.#runHostStop(change.state, change.epoch);
    if (attempt.kind === "failed") throw attempt.error;
    return attempt.stopError === undefined
      ? { kind: "stopped", drained }
      : { kind: "stopped", drained, stopError: attempt.stopError };
  }

  [completeChange]<T>(
    change: ChangeAuthority,
    disposition: "adopt" | "preserve",
    value: T,
  ): PluginHostChangeCompletion<T> {
    if (!change.active) throw new Error("Change authority is no longer active.");
    return new ChangeCompletion(change, disposition, value);
  }

  async #executeCommand<T>(
    authority: CommandAuthority,
    operation: (command: PluginHostCommandAuthority) => Promise<T>,
  ): Promise<PluginHostCommandRunOutcome<T>> {
    const stopping = authority.state.stopInFlight;
    if (stopping) await stopping;
    if (!authority.active || this.#closed) {
      authority.invalidate();
      authority.state.commands.delete(authority);
      return { kind: "refused", reason: "closed" };
    }

    let value!: T;
    let operationError: unknown;
    let failed = false;
    try {
      value = await operation(authority);
    } catch (error) {
      failed = true;
      operationError = error;
    }
    if (authority.startPromise) await authority.startPromise.catch(() => undefined);
    await this.#settleChanges(authority.changePromises);
    authority.invalidate();
    authority.state.commands.delete(authority);
    await this.#cleanup(this.#stopOpportunity(authority.state));
    if (failed) throw operationError;
    return { kind: "completed", value };
  }

  #beginChange<T>(
    state: PluginOwnershipState,
    origin: CommandAuthority | SurfaceStartAuthority | undefined,
    operation: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    const change = new ChangeAuthority(
      this,
      state,
      state.epoch,
      origin,
      state.onDemand !== null,
    );
    state.changes.add(change);
    return this.#executeChange(change, operation);
  }

  async #settleChanges(changes: ReadonlyArray<Promise<unknown>>): Promise<void> {
    let settled = 0;
    while (settled < changes.length) {
      const pending = changes.slice(settled);
      settled = changes.length;
      await Promise.allSettled(pending);
    }
  }

  async #executeChange<T>(
    change: ChangeAuthority,
    operation: (
      authority: PluginHostChangeAuthority,
    ) => Promise<PluginHostChangeCompletion<T>>,
  ): Promise<T> {
    let completion: PluginHostChangeCompletion<T> | undefined;
    let operationError: unknown;
    let failed = false;
    try {
      completion = await operation(change);
      if (!(completion instanceof ChangeCompletion) || completion.change !== change) {
        throw new Error("Change completed with another authority's decision.");
      }
      if (completion.disposition === "adopt" && change.active && !this.#closed) {
        change.state.adoptedRecord = this.#host.currentRecord(
          change.state.pluginId,
        ) ?? null;
        change.state.onDemand = null;
      } else if (
        completion.disposition === "preserve" &&
        change.preserveOnDemand &&
        change.active &&
        !this.#closed
      ) {
        const record = this.#host.currentRecord(change.state.pluginId);
        change.state.onDemand = record
          ? { epoch: change.state.epoch, record }
          : null;
        change.state.adoptedRecord = null;
      }
    } catch (error) {
      failed = true;
      operationError = error;
    }

    change.invalidate();
    change.state.changes.delete(change);
    await this.#cleanup(this.#stopOpportunity(change.state));
    if (failed) throw operationError;
    return completion!.value;
  }

  async #finishSurfaceRelease(lease: SurfaceLease): Promise<void> {
    if (!lease.active) return;
    if (lease.startUsed) {
      await Promise.race([
        lease.startSettled.promise,
        lease.invalidated.promise,
      ]);
    }
    if (!lease.active) return;
    lease.active = false;
    lease.state.surfaces.delete(lease);
    await this.#cleanup(this.#stopOpportunity(lease.state));
  }

  #drainMembers(
    state: PluginOwnershipState,
    excludedSurface?: SurfaceLease,
  ): DrainMember[] {
    const members: DrainMember[] = [];
    for (const command of state.commands) {
      if (command.overranDrain) continue;
      members.push({
        released: command.released.promise,
        active: () => command.active,
        markOverran: () => {
          command.overranDrain = true;
        },
      });
    }
    for (const surface of state.surfaces) {
      if (
        surface === excludedSurface ||
        !surface.startEnqueued ||
        surface.overranStart
      ) {
        continue;
      }
      members.push({
        released: surface.startSettled.promise,
        active: () => surface.active && surface.startEnqueued,
        markOverran: () => {
          surface.overranStart = true;
        },
      });
    }
    return members;
  }

  async #acceptStartEvidence(
    state: PluginOwnershipState,
    epoch: number,
    evidence: PluginHostStartEvidence | undefined,
  ): Promise<PluginHostAdmissionRefusal | undefined> {
    const refusal: PluginHostAdmissionRefusal | undefined = this.#closed
      ? { kind: "refused", reason: "closed" }
      : state.epoch !== epoch
        ? { kind: "refused", reason: "change-in-progress" }
        : undefined;
    if (!evidence || this.#consumedStartEvidence.has(evidence)) return refusal;
    this.#consumedStartEvidence.add(evidence);
    if (
      evidence.pluginId !== state.pluginId ||
      this.#host.currentRecord(state.pluginId) !== evidence.record ||
      state.adoptedRecord === evidence.record
    ) {
      return refusal;
    }
    if (refusal) {
      await this.#discardStartEvidence(state.pluginId, evidence.record);
      return refusal;
    }
    state.onDemand = { epoch, record: evidence.record };
    return undefined;
  }

  async #discardStartEvidence(
    pluginId: string,
    record: PluginHostRecordToken,
  ): Promise<void> {
    if (this.#host.currentRecord(pluginId) !== record) return;
    try {
      await this.#host.stopRecord(pluginId, record);
    } catch (error) {
      this.#onCleanupError(pluginId, error);
      return;
    }
    if (this.#host.currentRecord(pluginId) === record) {
      this.#onCleanupError(
        pluginId,
        new Error(
          `Plugin "${pluginId}" kept a late host record after stop resolved`,
        ),
      );
    }
  }

  #state(pluginId: string): PluginOwnershipState {
    const existing = this.#states.get(pluginId);
    if (existing) return existing;
    const state: PluginOwnershipState = {
      pluginId,
      epoch: newEpoch(),
      commands: new Set(),
      surfaces: new Set(),
      pendingChanges: new Set(),
      changes: new Set(),
      onDemand: null,
      adoptedRecord: null,
      stopInFlight: null,
    };
    this.#states.set(pluginId, state);
    return state;
  }

  #stopOpportunity(state: PluginOwnershipState): StopOpportunity | null {
    if (
      this.#closed ||
      !idle(state) ||
      state.onDemand?.epoch !== state.epoch
    ) {
      return null;
    }
    return {
      state,
      epoch: state.epoch,
      record: state.onDemand.record,
    };
  }

  async #cleanup(opportunity: StopOpportunity | null): Promise<void> {
    if (!opportunity || this.#closed) return;
    if (
      opportunity.state.epoch !== opportunity.epoch ||
      opportunity.state.onDemand?.epoch !== opportunity.epoch ||
      opportunity.state.onDemand.record !== opportunity.record ||
      !idle(opportunity.state)
    ) {
      return;
    }
    const currentRecord = this.#host.currentRecord(opportunity.state.pluginId);
    if (currentRecord !== opportunity.record) {
      opportunity.state.epoch = newEpoch();
      opportunity.state.onDemand = null;
      opportunity.state.adoptedRecord = null;
      return;
    }
    const attempt = await this.#runHostStop(
      opportunity.state,
      opportunity.epoch,
    );
    if (attempt.kind === "failed") {
      this.#onCleanupError(opportunity.state.pluginId, attempt.error);
    } else if (attempt.stopError !== undefined) {
      this.#onCleanupError(opportunity.state.pluginId, attempt.stopError);
    }
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
    if (this.#host.currentRecord(state.pluginId) !== undefined) {
      return {
        kind: "failed",
        error:
          stopError ??
          new Error(
            `Plugin "${state.pluginId}" kept a host record after stop resolved`,
          ),
      };
    }
    state.epoch = newEpoch();
    state.onDemand = null;
    state.adoptedRecord = null;
    return stopError === undefined
      ? { kind: "stopped" }
      : { kind: "stopped", stopError };
  }

  async #finishClose(releases: ReadonlyArray<Promise<void>>): Promise<void> {
    try {
      await snapshotDrained(
        releases.map((released) => ({
          released,
          active: () => true,
          markOverran: () => undefined,
        })),
        this.#drainTimeoutMs,
      );
      this.#host.bumpGeneration();
      await this.#host.stopAll();
    } finally {
      this.#reset();
    }
  }

  #reset(): void {
    for (const state of this.#states.values()) {
      for (const command of state.commands) command.invalidate();
      for (const surface of state.surfaces) surface.invalidate();
      for (const reservation of state.pendingChanges) reservation.invalidate();
      for (const change of state.changes) change.invalidate();
      state.commands.clear();
      state.surfaces.clear();
      state.pendingChanges.clear();
      state.changes.clear();
      state.onDemand = null;
      state.adoptedRecord = null;
      state.epoch = newEpoch();
      state.stopInFlight = null;
    }
    this.#states.clear();
  }
}
