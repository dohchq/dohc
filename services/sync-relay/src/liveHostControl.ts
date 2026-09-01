import {
  parseHostControlIdentifier,
  parseHostEpoch,
  parseHostMode,
  parseHostTransitionGeneration,
  type HostControlSnapshot,
  type HostEpoch,
  type HostMode,
  type HostTransitionGeneration,
  type SettlementSchedulerHandle,
} from "@dohc/live-session-contract";
import type {
  LiveHostConnectionCoordinate,
  LiveHostControlRefusalReason,
  LiveHostControlResult,
  SyncRelayStorage,
} from "./storage.js";

export interface ReportedHostConnection {
  readonly mode: HostMode;
  readonly hostId: string;
  readonly hostEpoch: number;
  readonly instanceId: string;
  readonly connectionId: string;
}

export type HostRegistrationAttempt = ReportedHostConnection;

export interface OldHostCoordinate {
  readonly transitionGeneration: HostTransitionGeneration;
  readonly transitionId: string;
  readonly transitionFromEpoch: HostEpoch;
  readonly mode: HostMode;
  readonly hostId: string;
  readonly instanceId: string;
  readonly connectionId: string;
}

export interface NewHostCoordinate {
  readonly transitionGeneration: HostTransitionGeneration;
  readonly transitionId: string;
  readonly transitionFromEpoch: HostEpoch;
  readonly mode: HostMode;
  readonly hostId: string;
  readonly hostEpoch: HostEpoch;
}

export interface LiveHostRuntime {
  drainAcceptedWork(input: OldHostCoordinate): Promise<void>;
  stop(input: OldHostCoordinate): Promise<void>;
  start(input: NewHostCoordinate): Promise<HostRegistrationAttempt>;
}

export type DeploymentMaintenanceAction =
  | "provision"
  | "transition"
  | "resume"
  | "abort";

export interface LiveHostAuthorizationPorts {
  authorizeDeploymentMaintenance(input: {
    readonly action: DeploymentMaintenanceAction;
    readonly transitionGeneration?: HostTransitionGeneration;
    readonly transitionId?: string;
  }): void;
  authorizeHostRegistration(input: ReportedHostConnection): void;
  authorizeHostConnection(input: ReportedHostConnection): void;
}

export type LiveHostTransitionResult =
  | LiveHostControlResult
  | {
      readonly ok: false;
      readonly reason: "drain-refused" | "flush-refused" | "runtime-refused";
    };

export interface LiveHostControlCoordinator {
  provision(input: { readonly mode: HostMode; readonly hostId: string }): LiveHostControlResult;
  register(input: ReportedHostConnection): LiveHostControlResult;
  disconnect(input: ReportedHostConnection): LiveHostControlResult;
  transition(input: {
    readonly from: ReportedHostConnection;
    readonly to: { readonly mode: HostMode; readonly hostId: string };
    readonly transitionId: string;
  }): Promise<LiveHostTransitionResult>;
  resume(input: {
    readonly transitionId: string;
    readonly transitionGeneration: number;
  }): Promise<LiveHostTransitionResult>;
  abort(input: {
    readonly transitionId: string;
    readonly transitionGeneration: number;
  }): LiveHostControlResult;
}

export interface CreateLiveHostControlOptions {
  readonly authorization: LiveHostAuthorizationPorts;
  readonly runtime: LiveHostRuntime;
  readonly settlement: Pick<SettlementSchedulerHandle, "flush">;
  readonly storage: SyncRelayStorage;
  readonly now?: () => number;
}

export function createLiveHostControl(
  options: CreateLiveHostControlOptions,
): LiveHostControlCoordinator {
  const now = options.now ?? Date.now;

  const executeActivating = async (
    snapshot: HostControlSnapshot,
  ): Promise<LiveHostTransitionResult> => {
    const transition = requireTransition(snapshot, "activating");
    const oldCoordinate = oldHostCoordinate(transition);
    const newCoordinate: NewHostCoordinate = {
      transitionGeneration: transition.transitionGeneration,
      transitionId: transition.transitionId,
      transitionFromEpoch: transition.fromEpoch,
      mode: transition.toMode,
      hostId: transition.toHostId,
      hostEpoch: snapshot.hostEpoch,
    };
    let registration: HostRegistrationAttempt;
    try {
      await options.runtime.stop(oldCoordinate);
      registration = await options.runtime.start(newCoordinate);
    } catch {
      return { ok: false, reason: "runtime-refused" };
    }
    const reported = parseReportedHostConnection(registration);
    return options.storage.activateLiveHostTransition({
      ...reported,
      transitionGeneration: transition.transitionGeneration,
      transitionId: transition.transitionId,
      transitionFromEpoch: transition.fromEpoch,
      updatedAtMs: now(),
      guard: () => options.authorization.authorizeHostRegistration(reported),
    });
  };

  const executeDraining = async (
    snapshot: HostControlSnapshot,
  ): Promise<LiveHostTransitionResult> => {
    const transition = requireTransition(snapshot, "draining");
    const oldCoordinate = oldHostCoordinate(transition);
    try {
      await options.runtime.drainAcceptedWork(oldCoordinate);
    } catch {
      abortFailedDrain(options.storage, transition, now());
      return { ok: false, reason: "drain-refused" };
    }
    try {
      await options.settlement.flush("maintenance-drain");
    } catch {
      abortFailedDrain(options.storage, transition, now());
      return { ok: false, reason: "flush-refused" };
    }
    const committed = options.storage.commitLiveHostTransitionEpoch({
      transitionGeneration: transition.transitionGeneration,
      transitionId: transition.transitionId,
      updatedAtMs: now(),
    });
    if (!committed.ok) return committed;
    return executeActivating(committed.snapshot);
  };

  return {
    provision(input) {
      return options.storage.provisionLiveHostControl({
        mode: parseHostMode(input.mode),
        hostId: parseHostControlIdentifier(input.hostId, "configured host ID"),
        updatedAtMs: now(),
        guard: () =>
          options.authorization.authorizeDeploymentMaintenance({ action: "provision" }),
      });
    },

    register(input) {
      const coordinate = parseReportedHostConnection(input);
      return options.storage.registerLiveHost({
        ...coordinate,
        updatedAtMs: now(),
        guard: () => options.authorization.authorizeHostRegistration(coordinate),
      });
    },

    disconnect(input) {
      const coordinate = parseReportedHostConnection(input);
      return options.storage.disconnectLiveHost({
        ...coordinate,
        updatedAtMs: now(),
        guard: () => options.authorization.authorizeHostConnection(coordinate),
      });
    },

    async transition(input) {
      const transitionId = parseHostControlIdentifier(input.transitionId, "transition ID");
      const begun = options.storage.beginLiveHostTransition({
        from: parseReportedHostConnection(input.from),
        toMode: parseHostMode(input.to.mode),
        toHostId: parseHostControlIdentifier(input.to.hostId, "target host ID"),
        transitionId,
        startedAtMs: now(),
        guard: () =>
          options.authorization.authorizeDeploymentMaintenance({
            action: "transition",
            transitionId,
          }),
      });
      if (!begun.ok) return begun;
      return executeDraining(begun.snapshot);
    },

    async resume(input) {
      const transitionId = parseHostControlIdentifier(input.transitionId, "transition ID");
      const transitionGeneration = parseHostTransitionGeneration(
        input.transitionGeneration,
      );
      options.authorization.authorizeDeploymentMaintenance({
        action: "resume",
        transitionGeneration,
        transitionId,
      });
      const snapshot = options.storage.getLiveHostControl();
      if (snapshot === null) return refusal("not-provisioned");
      if (snapshot.transition === null) {
        return snapshot.admissionState === "open" &&
          snapshot.lastCompletedTransitionId === transitionId &&
          snapshot.lastTransitionGeneration === transitionGeneration
          ? { ok: true, snapshot }
          : refusal("stale-transition");
      }
      if (
        snapshot.transition.transitionId !== transitionId ||
        snapshot.transition.transitionGeneration !== transitionGeneration
      ) {
        return refusal("stale-transition");
      }
      return snapshot.transition.phase === "draining"
        ? executeDraining(snapshot)
        : executeActivating(snapshot);
    },

    abort(input) {
      const transitionId = parseHostControlIdentifier(input.transitionId, "transition ID");
      const transitionGeneration = parseHostTransitionGeneration(
        input.transitionGeneration,
      );
      options.authorization.authorizeDeploymentMaintenance({
        action: "abort",
        transitionGeneration,
        transitionId,
      });
      return options.storage.abortLiveHostTransition({
        transitionGeneration,
        transitionId,
        updatedAtMs: now(),
      });
    },
  };
}

function parseReportedHostConnection(
  input: ReportedHostConnection,
): LiveHostConnectionCoordinate {
  return {
    mode: parseHostMode(input.mode),
    hostId: parseHostControlIdentifier(input.hostId, "host ID"),
    hostEpoch: parseHostEpoch(input.hostEpoch),
    instanceId: parseHostControlIdentifier(input.instanceId, "host instance ID"),
    connectionId: parseHostControlIdentifier(input.connectionId, "live connection ID"),
  };
}

function oldHostCoordinate(
  transition: NonNullable<HostControlSnapshot["transition"]>,
): OldHostCoordinate {
  return {
    transitionGeneration: transition.transitionGeneration,
    transitionId: transition.transitionId,
    transitionFromEpoch: transition.fromEpoch,
    mode: transition.fromMode,
    hostId: transition.fromHostId,
    instanceId: transition.fromInstanceId,
    connectionId: transition.fromConnectionId,
  };
}

function requireTransition(
  snapshot: HostControlSnapshot,
  phase: "draining" | "activating",
): NonNullable<HostControlSnapshot["transition"]> {
  if (snapshot.transition?.phase !== phase) {
    throw new Error(`host transition is not ${phase}`);
  }
  return snapshot.transition;
}

function abortFailedDrain(
  storage: SyncRelayStorage,
  transition: NonNullable<HostControlSnapshot["transition"]>,
  updatedAtMs: number,
): void {
  const aborted = storage.abortLiveHostTransition({
    transitionGeneration: transition.transitionGeneration,
    transitionId: transition.transitionId,
    updatedAtMs,
  });
  if (!aborted.ok) {
    throw new Error(`failed to persist host transition abort: ${aborted.reason}`);
  }
}

function refusal(reason: LiveHostControlRefusalReason): LiveHostControlResult {
  return { ok: false, reason };
}
