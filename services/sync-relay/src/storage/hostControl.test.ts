import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHostEpoch,
  parseHostTransitionGeneration,
  type HostControlSnapshot,
} from "@dohc/live-session-contract/host-control";
import { afterEach, expect, it} from "vitest";
import {
  openSyncRelayStorage,
  type LiveHostConnectionCoordinate,
  type SyncRelayStorage,
} from "../storage";

interface RawStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface RawDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => RawDatabase;
};

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function newStorage(): Promise<{
  dbPath: string;
  storage: SyncRelayStorage;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-host-control-"));
  roots.push(root);
  const dbPath = join(root, "relay.sqlite");
  const storage = openSyncRelayStorage(dbPath);
  storages.push(storage);
  return { dbPath, storage };
}

function closeStorage(storage: SyncRelayStorage): void {
  const index = storages.indexOf(storage);
  expect(index).toBeGreaterThanOrEqual(0);
  storages.splice(index, 1);
  storage.close();
}

function reopen(storage: SyncRelayStorage, dbPath: string): SyncRelayStorage {
  closeStorage(storage);
  const reopened = openSyncRelayStorage(dbPath);
  storages.push(reopened);
  return reopened;
}

const allow = (): void => undefined;
const STALE = { ok: false, reason: "stale-transition" } as const;

const DEVICE: LiveHostConnectionCoordinate = {
  connectionId: "device-connection-1",
  hostEpoch: parseHostEpoch(1),
  hostId: "device-host-1",
  instanceId: "device-instance-1",
  mode: "device",
};

const SERVICE: LiveHostConnectionCoordinate = {
  connectionId: "service-connection-1",
  hostEpoch: parseHostEpoch(2),
  hostId: "service-host-1",
  instanceId: "service-instance-1",
  mode: "service",
};

function register(
  storage: SyncRelayStorage,
  coordinate: LiveHostConnectionCoordinate,
  updatedAtMs: number,
) {
  return storage.registerLiveHost({ ...coordinate, guard: allow, updatedAtMs });
}

function disconnect(
  storage: SyncRelayStorage,
  coordinate: LiveHostConnectionCoordinate,
  updatedAtMs: number,
) {
  return storage.disconnectLiveHost({ ...coordinate, guard: allow, updatedAtMs });
}

function provisionAndRegister(storage: SyncRelayStorage): HostControlSnapshot {
  const provisioned = storage.provisionLiveHostControl({
    guard: allow,
    hostId: DEVICE.hostId,
    mode: DEVICE.mode,
    updatedAtMs: 10,
  });
  expect(provisioned.ok).toBe(true);
  const registered = register(storage, DEVICE, 11);
  if (!registered.ok) throw new Error(`registration refused: ${registered.reason}`);
  return registered.snapshot;
}

function beginDeviceToService(
  storage: SyncRelayStorage,
  transitionId = "device-to-service-1",
  startedAtMs = 20,
) {
  return storage.beginLiveHostTransition({
    from: DEVICE,
    guard: allow,
    startedAtMs,
    toHostId: SERVICE.hostId,
    toMode: SERVICE.mode,
    transitionId,
  });
}

function completeTransition(
  storage: SyncRelayStorage,
  from: LiveHostConnectionCoordinate,
  to: LiveHostConnectionCoordinate,
  transitionId: string,
): HostControlSnapshot {
  const begun = storage.beginLiveHostTransition({
    from,
    guard: allow,
    startedAtMs: 20,
    toHostId: to.hostId,
    toMode: to.mode,
    transitionId,
  });
  if (!begun.ok || begun.snapshot.transition === null) throw new Error("transition did not begin");
  const { transitionGeneration } = begun.snapshot.transition;
  const committed = storage.commitLiveHostTransitionEpoch({
    transitionGeneration,
    transitionId,
    updatedAtMs: 21,
  });
  if (!committed.ok) throw new Error(`commit refused: ${committed.reason}`);
  const activated = storage.activateLiveHostTransition({
    ...to,
    guard: allow,
    transitionFromEpoch: from.hostEpoch,
    transitionGeneration,
    transitionId,
    updatedAtMs: 22,
  });
  if (!activated.ok) throw new Error(`activation refused: ${activated.reason}`);
  return activated.snapshot;
}

function rawDatabase(dbPath: string): RawDatabase {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

it("aborts a draining transition to closed admission that survives reopen", async () => {
  const { dbPath, storage } = await newStorage();
  provisionAndRegister(storage);
  const begun = beginDeviceToService(storage, "aborted-transition");
  expect(begun).toMatchObject({
    ok: true,
    snapshot: { admissionState: "draining", configuredMode: "device", hostEpoch: 1 },
  });
  if (!begun.ok || begun.snapshot.transition === null) throw new Error("transition did not begin");
  expect(
    storage.abortLiveHostTransition({
      transitionGeneration: begun.snapshot.transition.transitionGeneration,
      transitionId: "aborted-transition",
      updatedAtMs: 1_000,
    }).ok,
  ).toBe(true);

  const reopened = reopen(storage, dbPath);
  expect(reopened.getLiveHostControl()).toEqual({
    admissionState: "closed",
    configuredHostId: DEVICE.hostId,
    configuredMode: "device",
    hostEpoch: 1,
    lastCompletedTransitionId: null,
    lastTransitionGeneration: 1,
    registeredConnectionId: null,
    registeredInstanceId: DEVICE.instanceId,
    transition: null,
    updatedAtMs: 1_000,
  });
  expect(register(reopened, { ...SERVICE, hostEpoch: DEVICE.hostEpoch }, 1_001)).toEqual({
    ok: false,
    reason: "wrong-mode",
  });
  expect(register(reopened, { ...DEVICE, connectionId: "device-connection-2" }, 1_002)).toMatchObject({
    ok: true,
    snapshot: { admissionState: "open", hostEpoch: 1, registeredConnectionId: "device-connection-2" },
  });
});

it("keeps crash-shaped draining and activating states closed until an explicit command", async () => {
  const { dbPath, storage } = await newStorage();
  provisionAndRegister(storage);
  const begun = beginDeviceToService(storage, "restart-transition");
  if (!begun.ok || begun.snapshot.transition === null) throw new Error("transition did not begin");
  const generation = begun.snapshot.transition.transitionGeneration;

  let reopened = reopen(storage, dbPath);
  expect(reopened.getLiveHostControl()).toMatchObject({
    admissionState: "draining",
    configuredMode: "device",
    hostEpoch: 1,
    transition: { phase: "draining" },
  });
  expect(
    register(reopened, { ...DEVICE, connectionId: "device-connection-after-crash" }, 30),
  ).toEqual({ ok: false, reason: "draining" });
  const committed = reopened.commitLiveHostTransitionEpoch({
    transitionGeneration: generation,
    transitionId: "restart-transition",
    updatedAtMs: 31,
  });
  expect(committed).toMatchObject({
    ok: true,
    snapshot: {
      admissionState: "closed",
      configuredMode: "service",
      hostEpoch: 2,
      transition: { phase: "activating" },
    },
  });

  reopened = reopen(reopened, dbPath);
  expect(reopened.getLiveHostControl()).toMatchObject({
    admissionState: "closed",
    configuredMode: "service",
    hostEpoch: 2,
    registeredConnectionId: null,
    transition: { phase: "activating" },
  });
  expect(register(reopened, DEVICE, 32)).toEqual({ ok: false, reason: "wrong-mode" });
  expect(register(reopened, SERVICE, 33)).toEqual({ ok: false, reason: "busy-transition" });
});

it("fences disconnected, replaced, and stale host connections", async () => {
  const { storage } = await newStorage();
  provisionAndRegister(storage);

  expect(disconnect(storage, DEVICE, 50).ok).toBe(true);
  expect(
    register(storage, { ...DEVICE, instanceId: "different-device-instance" }, 51),
  ).toEqual({ ok: false, reason: "wrong-instance" });
  const currentDevice = { ...DEVICE, connectionId: "device-connection-2" };
  expect(register(storage, currentDevice, 52).ok).toBe(true);
  expect(disconnect(storage, DEVICE, 53)).toEqual({ ok: false, reason: "wrong-connection" });
  expect(storage.getLiveHostControl()).toMatchObject({
    admissionState: "open",
    registeredConnectionId: "device-connection-2",
  });

  completeTransition(storage, currentDevice, SERVICE, "disconnect-fence");
  expect(disconnect(storage, currentDevice, 54)).toEqual({ ok: false, reason: "wrong-mode" });
  expect(storage.getLiveHostControl()).toMatchObject({
    admissionState: "open",
    configuredMode: "service",
    hostEpoch: 2,
  });
  expect(disconnect(storage, SERVICE, 55).ok).toBe(true);
  expect(register(storage, DEVICE, 56)).toEqual({ ok: false, reason: "wrong-mode" });
});

it("fences a stale epoch even when every other connection coordinate is reused", async () => {
  const { storage } = await newStorage();
  provisionAndRegister(storage);
  completeTransition(storage, DEVICE, SERVICE, "to-service");
  expect(
    completeTransition(storage, SERVICE, { ...DEVICE, hostEpoch: parseHostEpoch(3) }, "back-to-device"),
  ).toMatchObject({ hostEpoch: 3 });
  expect(disconnect(storage, DEVICE, 60)).toEqual({ ok: false, reason: "stale-epoch" });
  expect(storage.getLiveHostControl()).toMatchObject({
    admissionState: "open",
    configuredMode: "device",
    hostEpoch: 3,
    registeredConnectionId: DEVICE.connectionId,
  });
});

it("replays only the unchanged completed activation coordinate", async () => {
  const { storage } = await newStorage();
  provisionAndRegister(storage);
  const completed = completeTransition(storage, DEVICE, SERVICE, "lost-activation-response");
  const generation = completed.lastTransitionGeneration!;
  expect(
    storage.beginLiveHostTransition({
      from: SERVICE,
      guard: allow,
      startedAtMs: 399,
      toHostId: DEVICE.hostId,
      toMode: DEVICE.mode,
      transitionId: "lost-activation-response",
    }),
  ).toEqual({ ok: false, reason: "completed-transition-id" });
  const replay = {
    ...SERVICE,
    guard: allow,
    transitionFromEpoch: DEVICE.hostEpoch,
    transitionGeneration: generation,
    transitionId: "lost-activation-response",
    updatedAtMs: 400,
  };
  expect(storage.activateLiveHostTransition(replay)).toEqual({ ok: true, snapshot: completed });
  expect(
    storage.activateLiveHostTransition({
      ...replay,
      transitionGeneration: parseHostTransitionGeneration(generation + 1),
    }),
  ).toEqual(STALE);
  expect(
    storage.activateLiveHostTransition({ ...replay, transitionId: "another-transition" }),
  ).toEqual(STALE);
  expect(
    storage.activateLiveHostTransition({ ...replay, connectionId: "service-connection-2" }),
  ).toEqual(STALE);

  expect(disconnect(storage, SERVICE, 401).ok).toBe(true);
  expect(storage.activateLiveHostTransition(replay)).toEqual(STALE);
});

it("fails closed for missing, unmarked, and damaged authority tables", async () => {
  const missingState = await newStorage();
  closeStorage(missingState.storage);
  let raw = rawDatabase(missingState.dbPath);
  raw.exec("DROP TABLE sync_relay_session_host_control");
  raw.close();
  expect(() => openSyncRelayStorage(missingState.dbPath)).toThrow(/marked.*missing/);
  raw = rawDatabase(missingState.dbPath);
  expect(
    raw
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'sync_relay_session_host_control'",
      )
      .get()?.count,
  ).toBe(0);
  raw.close();

  const unmarkedState = await newStorage();
  closeStorage(unmarkedState.storage);
  raw = rawDatabase(unmarkedState.dbPath);
  raw
    .prepare("DELETE FROM sync_relay_migrations WHERE migration_id = 'session-host-control-v1'")
    .run();
  raw.close();
  expect(() => openSyncRelayStorage(unmarkedState.dbPath)).toThrow(/unmarked/);
  raw = rawDatabase(unmarkedState.dbPath);
  expect(
    raw
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'sync_relay_session_host_control'",
      )
      .get()?.count,
  ).toBe(1);
  raw.close();

  const damagedState = await newStorage();
  closeStorage(damagedState.storage);
  raw = rawDatabase(damagedState.dbPath);
  raw.exec(`
    DROP TABLE sync_relay_session_host_control;
    CREATE TABLE sync_relay_session_host_control (
      singleton_id INTEGER PRIMARY KEY,
      configured_mode TEXT
    );
  `);
  raw.close();
  expect(() => openSyncRelayStorage(damagedState.dbPath)).toThrow(/damaged/);
});

it("rolls back every guarded host-control mutation", async () => {
  const { storage } = await newStorage();
  const refused = () => {
    throw new Error("guard refused");
  };
  expect(() =>
    storage.provisionLiveHostControl({
      guard: refused,
      hostId: DEVICE.hostId,
      mode: DEVICE.mode,
      updatedAtMs: 1,
    }),
  ).toThrow("guard refused");
  expect(storage.getLiveHostControl()).toBeNull();
  storage.provisionLiveHostControl({
    guard: allow,
    hostId: DEVICE.hostId,
    mode: DEVICE.mode,
    updatedAtMs: 2,
  });
  let before = storage.getLiveHostControl();
  expect(() =>
    storage.registerLiveHost({ ...DEVICE, guard: refused, updatedAtMs: 3 }),
  ).toThrow("guard refused");
  expect(storage.getLiveHostControl()).toEqual(before);
  register(storage, DEVICE, 4);
  before = storage.getLiveHostControl();
  expect(() =>
    storage.disconnectLiveHost({ ...DEVICE, guard: refused, updatedAtMs: 5 }),
  ).toThrow("guard refused");
  expect(storage.getLiveHostControl()).toEqual(before);
  expect(() =>
    storage.beginLiveHostTransition({
      from: DEVICE,
      guard: refused,
      startedAtMs: 6,
      toHostId: SERVICE.hostId,
      toMode: SERVICE.mode,
      transitionId: "guarded-transition",
    }),
  ).toThrow("guard refused");
  expect(storage.getLiveHostControl()).toEqual(before);
  const begun = beginDeviceToService(storage, "guarded-activation");
  if (!begun.ok || begun.snapshot.transition === null) throw new Error("transition did not begin");
  const committed = storage.commitLiveHostTransitionEpoch({
    transitionGeneration: begun.snapshot.transition.transitionGeneration,
    transitionId: "guarded-activation",
    updatedAtMs: 7,
  });
  if (!committed.ok) throw new Error(`commit refused: ${committed.reason}`);
  before = committed.snapshot;
  expect(() =>
    storage.activateLiveHostTransition({
      ...SERVICE,
      guard: refused,
      transitionFromEpoch: DEVICE.hostEpoch,
      transitionGeneration: begun.snapshot.transition!.transitionGeneration,
      transitionId: "guarded-activation",
      updatedAtMs: 8,
    }),
  ).toThrow("guard refused");
  expect(storage.getLiveHostControl()).toEqual(before);
});
