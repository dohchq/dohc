import {
  type SqliteDb,
  type LiveHostControlResult,
  type LiveHostControlRefusalReason,
  type LiveHostConnectionCoordinate,
  type BeginLiveHostTransitionInput,
  type ActivateLiveHostTransitionInput,
} from "./types";
import {
  type HostControlSnapshot,
  parseHostTransitionGeneration,
  parseHostControlIdentifier,
  parseHostMode,
  parseHostEpoch,
  type HostMode,
  type HostTransitionGeneration,
  nextHostEpoch,
} from "@dohc/live-session-contract/host-control";
import { SESSION_HOST_CONTROL_TABLE } from "./schema";
import { type StorageContext } from "./context";

function parseHostControlTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function readLiveHostControl(db: SqliteDb): HostControlSnapshot | null {
  const row = db
    .prepare(`SELECT * FROM ${SESSION_HOST_CONTROL_TABLE} WHERE singleton_id = 1`)
    .get();
  if (row === undefined) return null;

  const transitionGeneration = Number(row.transition_generation);
  const phase = row.transition_phase;
  const transition =
    phase === null
      ? null
      : {
          phase: parseHostTransitionPhase(phase),
          transitionGeneration: parseHostTransitionGeneration(transitionGeneration),
          transitionId: parseHostControlIdentifier(row.transition_id, "transition ID"),
          fromMode: parseHostMode(row.transition_from_mode),
          fromHostId: parseHostControlIdentifier(
            row.transition_from_host_id,
            "transition source host ID",
          ),
          fromInstanceId: parseHostControlIdentifier(
            row.transition_from_instance_id,
            "transition source instance ID",
          ),
          fromConnectionId: parseHostControlIdentifier(
            row.transition_from_connection_id,
            "transition source connection ID",
          ),
          fromEpoch: parseHostEpoch(row.transition_from_epoch),
          toMode: parseHostMode(row.transition_to_mode),
          toHostId: parseHostControlIdentifier(
            row.transition_to_host_id,
            "transition target host ID",
          ),
          startedAtMs: parseHostControlTimestamp(
            row.transition_started_at_ms,
            "transition start time",
          ),
        } as const;

  return {
    configuredMode: parseHostMode(row.configured_mode),
    configuredHostId: parseHostControlIdentifier(row.configured_host_id, "configured host ID"),
    hostEpoch: parseHostEpoch(row.host_epoch),
    admissionState: parseHostAdmissionState(row.admission_state),
    registeredInstanceId:
      row.registered_instance_id === null
        ? null
        : parseHostControlIdentifier(row.registered_instance_id, "registered instance ID"),
    registeredConnectionId:
      row.registered_connection_id === null
        ? null
        : parseHostControlIdentifier(row.registered_connection_id, "registered connection ID"),
    updatedAtMs: parseHostControlTimestamp(row.updated_at_ms, "host control update time"),
    lastTransitionGeneration:
      transitionGeneration === 0
        ? null
        : parseHostTransitionGeneration(transitionGeneration),
    lastCompletedTransitionId:
      row.last_completed_transition_id === null
        ? null
        : parseHostControlIdentifier(
            row.last_completed_transition_id,
            "last completed transition ID",
          ),
    transition,
  };
}

function parseHostAdmissionState(value: unknown): HostControlSnapshot["admissionState"] {
  if (value === "closed" || value === "open" || value === "draining") return value;
  throw new Error("stored host admission state is invalid");
}

function parseHostTransitionPhase(
  value: unknown,
): NonNullable<HostControlSnapshot["transition"]>["phase"] {
  if (value === "draining" || value === "activating") return value;
  throw new Error("stored host transition phase is invalid");
}

function liveHostSuccess(snapshot: HostControlSnapshot): LiveHostControlResult {
  return { ok: true, snapshot };
}

function liveHostRefusal(reason: LiveHostControlRefusalReason): LiveHostControlResult {
  return { ok: false, reason };
}

function readRequiredLiveHostControl(db: SqliteDb): HostControlSnapshot {
  const snapshot = readLiveHostControl(db);
  if (snapshot === null) throw new Error("session host control row disappeared");
  return snapshot;
}

function parseLiveHostConnectionCoordinate(
  input: LiveHostConnectionCoordinate,
): LiveHostConnectionCoordinate {
  return {
    mode: parseHostMode(input.mode),
    hostId: parseHostControlIdentifier(input.hostId, "host ID"),
    hostEpoch: parseHostEpoch(input.hostEpoch),
    instanceId: parseHostControlIdentifier(input.instanceId, "host instance ID"),
    connectionId: parseHostControlIdentifier(input.connectionId, "live connection ID"),
  };
}

function compareConfiguredCoordinate(
  snapshot: HostControlSnapshot,
  coordinate: Pick<LiveHostConnectionCoordinate, "mode" | "hostId" | "hostEpoch">,
): LiveHostControlRefusalReason | null {
  if (snapshot.configuredMode !== coordinate.mode) return "wrong-mode";
  if (snapshot.configuredHostId !== coordinate.hostId) return "wrong-host";
  if (snapshot.hostEpoch !== coordinate.hostEpoch) return "stale-epoch";
  return null;
}

export function getLiveHostControl(storage: StorageContext): HostControlSnapshot | null {
    return readLiveHostControl(storage.db);
  }

export function provisionLiveHostControl(storage: StorageContext, input: {
    mode: HostMode;
    hostId: string;
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult {
    const mode = parseHostMode(input.mode);
    const hostId = parseHostControlIdentifier(input.hostId, "configured host ID");
    const updatedAtMs = parseHostControlTimestamp(input.updatedAtMs, "host control update time");
    return storage.tx(() => {
      const existing = readLiveHostControl(storage.db);
      if (existing !== null) {
        if (existing.configuredMode !== mode || existing.configuredHostId !== hostId) {
          return liveHostRefusal("conflicting-provision");
        }
        input.guard();
        return liveHostSuccess(existing);
      }
      input.guard();
      storage.db
        .prepare(
          `INSERT INTO ${SESSION_HOST_CONTROL_TABLE} (
             singleton_id, configured_mode, configured_host_id, host_epoch,
             transition_generation, admission_state, updated_at_ms
           ) VALUES (1, ?, ?, 1, 0, 'closed', ?)`,
        )
        .run(mode, hostId, updatedAtMs);
      return liveHostSuccess(readRequiredLiveHostControl(storage.db));
    });
  }

export function registerLiveHost(storage: StorageContext, input: LiveHostConnectionCoordinate & {
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult {
    const coordinate = parseLiveHostConnectionCoordinate(input);
    const updatedAtMs = parseHostControlTimestamp(input.updatedAtMs, "host registration time");
    return storage.tx(() => {
      const snapshot = readLiveHostControl(storage.db);
      if (snapshot === null) return liveHostRefusal("not-provisioned");
      const mismatch = compareConfiguredCoordinate(snapshot, coordinate);
      if (mismatch !== null) return liveHostRefusal(mismatch);
      if (snapshot.transition !== null) {
        return liveHostRefusal(
          snapshot.transition.phase === "draining" ? "draining" : "busy-transition",
        );
      }
      if (
        snapshot.registeredInstanceId !== null &&
        snapshot.registeredInstanceId !== coordinate.instanceId
      ) {
        return liveHostRefusal("wrong-instance");
      }
      if (
        snapshot.admissionState === "open" &&
        snapshot.registeredConnectionId === coordinate.connectionId
      ) {
        input.guard();
        return liveHostSuccess(snapshot);
      }
      input.guard();
      storage.db
        .prepare(
          `UPDATE ${SESSION_HOST_CONTROL_TABLE}
           SET registered_instance_id = ?, registered_connection_id = ?,
               admission_state = 'open', last_completed_transition_id = NULL,
               updated_at_ms = ?
           WHERE singleton_id = 1`,
        )
        .run(coordinate.instanceId, coordinate.connectionId, updatedAtMs);
      return liveHostSuccess(readRequiredLiveHostControl(storage.db));
    });
  }

export function disconnectLiveHost(storage: StorageContext, input: LiveHostConnectionCoordinate & {
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult {
    const coordinate = parseLiveHostConnectionCoordinate(input);
    const updatedAtMs = parseHostControlTimestamp(input.updatedAtMs, "host disconnect time");
    return storage.tx(() => {
      const snapshot = readLiveHostControl(storage.db);
      if (snapshot === null) return liveHostRefusal("not-provisioned");
      const mismatch = compareConfiguredCoordinate(snapshot, coordinate);
      if (mismatch !== null) return liveHostRefusal(mismatch);
      if (snapshot.registeredInstanceId !== coordinate.instanceId) {
        return liveHostRefusal("wrong-instance");
      }
      if (snapshot.registeredConnectionId !== coordinate.connectionId) {
        return liveHostRefusal("wrong-connection");
      }
      if (snapshot.transition !== null) {
        return liveHostRefusal(
          snapshot.transition.phase === "draining" ? "draining" : "busy-transition",
        );
      }
      if (snapshot.admissionState !== "open") return liveHostRefusal("closed");
      input.guard();
      storage.db
        .prepare(
          `UPDATE ${SESSION_HOST_CONTROL_TABLE}
           SET admission_state = 'closed', registered_connection_id = NULL,
               last_completed_transition_id = NULL, updated_at_ms = ?
           WHERE singleton_id = 1`,
        )
        .run(updatedAtMs);
      return liveHostSuccess(readRequiredLiveHostControl(storage.db));
    });
  }

export function beginLiveHostTransition(storage: StorageContext, input: BeginLiveHostTransitionInput): LiveHostControlResult {
    const from = parseLiveHostConnectionCoordinate(input.from);
    const toMode = parseHostMode(input.toMode);
    const toHostId = parseHostControlIdentifier(input.toHostId, "target host ID");
    const transitionId = parseHostControlIdentifier(input.transitionId, "transition ID");
    const startedAtMs = parseHostControlTimestamp(input.startedAtMs, "transition start time");
    return storage.tx(() => {
      const snapshot = readLiveHostControl(storage.db);
      if (snapshot === null) return liveHostRefusal("not-provisioned");
      const mismatch = compareConfiguredCoordinate(snapshot, from);
      if (mismatch !== null) return liveHostRefusal(mismatch);
      if (snapshot.registeredInstanceId !== from.instanceId) {
        return liveHostRefusal("wrong-instance");
      }
      if (snapshot.registeredConnectionId !== from.connectionId) {
        return liveHostRefusal("wrong-connection");
      }
      if (snapshot.transition !== null) return liveHostRefusal("busy-transition");
      if (snapshot.admissionState !== "open") return liveHostRefusal("closed");
      if (toMode === snapshot.configuredMode) return liveHostRefusal("same-mode");
      if (snapshot.hostEpoch === Number.MAX_SAFE_INTEGER) {
        return liveHostRefusal("exhausted-epoch");
      }
      if (snapshot.lastCompletedTransitionId === transitionId) {
        return liveHostRefusal("completed-transition-id");
      }
      const storedGeneration = snapshot.lastTransitionGeneration ?? 0;
      if (storedGeneration === Number.MAX_SAFE_INTEGER) {
        return liveHostRefusal("exhausted-transition-generation");
      }
      const nextGeneration = parseHostTransitionGeneration(storedGeneration + 1);
      input.guard();
      storage.db
        .prepare(
          `UPDATE ${SESSION_HOST_CONTROL_TABLE}
           SET transition_generation = ?, admission_state = 'draining',
               transition_phase = 'draining', transition_id = ?,
               transition_from_mode = ?, transition_from_host_id = ?,
               transition_from_instance_id = ?, transition_from_connection_id = ?,
               transition_from_epoch = ?, transition_to_mode = ?,
               transition_to_host_id = ?, transition_started_at_ms = ?,
               last_completed_transition_id = NULL, updated_at_ms = ?
           WHERE singleton_id = 1`,
        )
        .run(
          nextGeneration,
          transitionId,
          from.mode,
          from.hostId,
          from.instanceId,
          from.connectionId,
          from.hostEpoch,
          toMode,
          toHostId,
          startedAtMs,
          startedAtMs,
        );
      return liveHostSuccess(readRequiredLiveHostControl(storage.db));
    });
  }

export function abortLiveHostTransition(storage: StorageContext, input: {
    transitionId: string;
    transitionGeneration: HostTransitionGeneration;
    updatedAtMs: number;
  }): LiveHostControlResult {
    const transitionId = parseHostControlIdentifier(input.transitionId, "transition ID");
    const transitionGeneration = parseHostTransitionGeneration(input.transitionGeneration);
    const updatedAtMs = parseHostControlTimestamp(input.updatedAtMs, "transition abort time");
    return storage.tx(() => {
      const snapshot = readLiveHostControl(storage.db);
      if (snapshot === null) return liveHostRefusal("not-provisioned");
      if (
        snapshot.transition?.phase !== "draining" ||
        snapshot.transition.transitionId !== transitionId ||
        snapshot.transition.transitionGeneration !== transitionGeneration
      ) {
        return liveHostRefusal("stale-transition");
      }
      storage.db
        .prepare(
          `UPDATE ${SESSION_HOST_CONTROL_TABLE}
           SET admission_state = 'closed', registered_connection_id = NULL,
               transition_phase = NULL, transition_id = NULL,
               transition_from_mode = NULL, transition_from_host_id = NULL,
               transition_from_instance_id = NULL,
               transition_from_connection_id = NULL, transition_from_epoch = NULL,
               transition_to_mode = NULL, transition_to_host_id = NULL,
               transition_started_at_ms = NULL, last_completed_transition_id = NULL,
               updated_at_ms = ?
           WHERE singleton_id = 1`,
        )
        .run(updatedAtMs);
      return liveHostSuccess(readRequiredLiveHostControl(storage.db));
    });
  }

export function commitLiveHostTransitionEpoch(storage: StorageContext, input: {
    transitionId: string;
    transitionGeneration: HostTransitionGeneration;
    updatedAtMs: number;
  }): LiveHostControlResult {
    const transitionId = parseHostControlIdentifier(input.transitionId, "transition ID");
    const transitionGeneration = parseHostTransitionGeneration(input.transitionGeneration);
    const updatedAtMs = parseHostControlTimestamp(input.updatedAtMs, "transition commit time");
    return storage.tx(() => {
      const snapshot = readLiveHostControl(storage.db);
      if (snapshot === null) return liveHostRefusal("not-provisioned");
      if (
        snapshot.transition?.phase !== "draining" ||
        snapshot.transition.transitionId !== transitionId ||
        snapshot.transition.transitionGeneration !== transitionGeneration
      ) {
        return liveHostRefusal("stale-transition");
      }
      if (snapshot.hostEpoch === Number.MAX_SAFE_INTEGER) {
        return liveHostRefusal("exhausted-epoch");
      }
      const nextEpoch = nextHostEpoch(snapshot.hostEpoch);
      storage.db
        .prepare(
          `UPDATE ${SESSION_HOST_CONTROL_TABLE}
           SET configured_mode = transition_to_mode,
               configured_host_id = transition_to_host_id, host_epoch = ?,
               admission_state = 'closed', registered_instance_id = NULL,
               registered_connection_id = NULL, transition_phase = 'activating',
               updated_at_ms = ?
           WHERE singleton_id = 1`,
        )
        .run(nextEpoch, updatedAtMs);
      return liveHostSuccess(readRequiredLiveHostControl(storage.db));
    });
  }

export function activateLiveHostTransition(storage: StorageContext, input: ActivateLiveHostTransitionInput): LiveHostControlResult {
    const transitionGeneration = parseHostTransitionGeneration(input.transitionGeneration);
    const transitionId = parseHostControlIdentifier(input.transitionId, "transition ID");
    const transitionFromEpoch = parseHostEpoch(input.transitionFromEpoch);
    const coordinate = parseLiveHostConnectionCoordinate(input);
    const updatedAtMs = parseHostControlTimestamp(input.updatedAtMs, "host activation time");
    return storage.tx(() => {
      const snapshot = readLiveHostControl(storage.db);
      if (snapshot === null) return liveHostRefusal("not-provisioned");
      if (
        snapshot.transition === null &&
        snapshot.admissionState === "open" &&
        snapshot.lastCompletedTransitionId === transitionId &&
        snapshot.lastTransitionGeneration === transitionGeneration &&
        snapshot.configuredMode === coordinate.mode &&
        snapshot.configuredHostId === coordinate.hostId &&
        snapshot.hostEpoch === coordinate.hostEpoch &&
        snapshot.hostEpoch === transitionFromEpoch + 1 &&
        snapshot.registeredInstanceId === coordinate.instanceId &&
        snapshot.registeredConnectionId === coordinate.connectionId
      ) {
        input.guard();
        return liveHostSuccess(snapshot);
      }
      if (snapshot.transition?.phase !== "activating") {
        return liveHostRefusal(
          snapshot.transition === null ? "stale-transition" : "busy-transition",
        );
      }
      const transition = snapshot.transition;
      if (
        transition.transitionGeneration !== transitionGeneration ||
        transition.transitionId !== transitionId ||
        transition.fromEpoch !== transitionFromEpoch
      ) {
        return liveHostRefusal("stale-transition");
      }
      const mismatch = compareConfiguredCoordinate(snapshot, coordinate);
      if (mismatch !== null) return liveHostRefusal(mismatch);
      input.guard();
      storage.db
        .prepare(
          `UPDATE ${SESSION_HOST_CONTROL_TABLE}
           SET admission_state = 'open', registered_instance_id = ?,
               registered_connection_id = ?, transition_phase = NULL,
               last_completed_transition_id = transition_id, transition_id = NULL,
               transition_from_mode = NULL, transition_from_host_id = NULL,
               transition_from_instance_id = NULL,
               transition_from_connection_id = NULL, transition_from_epoch = NULL,
               transition_to_mode = NULL, transition_to_host_id = NULL,
               transition_started_at_ms = NULL, updated_at_ms = ?
           WHERE singleton_id = 1`,
        )
        .run(coordinate.instanceId, coordinate.connectionId, updatedAtMs);
      return liveHostSuccess(readRequiredLiveHostControl(storage.db));
    });
  }
