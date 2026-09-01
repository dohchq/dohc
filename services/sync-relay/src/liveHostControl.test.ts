import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHostEpoch,
  type HostControlSnapshot,
} from "@dohc/live-session-contract/host-control";
import { afterEach, expect, it, vi } from "vitest";
import {
  createLiveHostControl,
  type LiveHostAuthorizationPorts,
  type ReportedHostConnection,
} from "./liveHostControl.js";
import {
  openSyncRelayStorage,
  type LiveHostConnectionCoordinate,
  type SyncRelayStorage,
} from "./storage.js";

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
  const root = await mkdtemp(join(tmpdir(), "dohc-live-host-control-"));
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

function permissiveAuthorization(): LiveHostAuthorizationPorts {
  return {
    authorizeDeploymentMaintenance: vi.fn(),
    authorizeHostConnection: vi.fn(),
    authorizeHostRegistration: vi.fn(),
  };
}

function changingReport(
  first: ReportedHostConnection,
  later: ReportedHostConnection,
): ReportedHostConnection {
  const seen = new Set<keyof ReportedHostConnection>();
  const read = <Key extends keyof ReportedHostConnection>(
    key: Key,
  ): ReportedHostConnection[Key] => {
    if (seen.has(key)) return later[key];
    seen.add(key);
    return first[key];
  };
  return {
    get connectionId() {
      return read("connectionId");
    },
    get hostEpoch() {
      return read("hostEpoch");
    },
    get hostId() {
      return read("hostId");
    },
    get instanceId() {
      return read("instanceId");
    },
    get mode() {
      return read("mode");
    },
  };
}

const DEVICE = {
  connectionId: "device-connection-1",
  hostEpoch: 1,
  hostId: "device-host-1",
  instanceId: "device-instance-1",
  mode: "device" as const,
};

const SERVICE = {
  connectionId: "service-connection-1",
  hostEpoch: 2,
  hostId: "service-host-1",
  instanceId: "service-instance-1",
  mode: "service" as const,
};

function storageCoordinate(
  input: typeof DEVICE | typeof SERVICE | (Omit<typeof DEVICE, "hostEpoch"> & { hostEpoch: number }),
): LiveHostConnectionCoordinate {
  return { ...input, hostEpoch: parseHostEpoch(input.hostEpoch) };
}

function provisionAndRegister(storage: SyncRelayStorage): HostControlSnapshot {
  const provisioned = storage.provisionLiveHostControl({
    guard: () => undefined,
    hostId: DEVICE.hostId,
    mode: DEVICE.mode,
    updatedAtMs: 10,
  });
  expect(provisioned.ok).toBe(true);
  const registered = storage.registerLiveHost({
    ...storageCoordinate(DEVICE),
    guard: () => undefined,
    updatedAtMs: 11,
  });
  if (!registered.ok) throw new Error(`registration refused: ${registered.reason}`);
  return registered.snapshot;
}

function beginDeviceToService(
  storage: SyncRelayStorage,
  transitionId = "device-to-service-1",
  startedAtMs = 20,
) {
  return storage.beginLiveHostTransition({
    from: storageCoordinate(DEVICE),
    guard: () => undefined,
    startedAtMs,
    toHostId: SERVICE.hostId,
    toMode: SERVICE.mode,
    transitionId,
  });
}

function rawDatabase(dbPath: string): RawDatabase {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

it("refuses a device-to-service transition when the device host cannot drain", async () => {
  const { dbPath, storage } = await newStorage();
  const authorization = permissiveAuthorization();
  const flush = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({
    connectionId: "service-connection-1",
    hostEpoch: 2,
    hostId: "service-host-1",
    instanceId: "service-instance-1",
    mode: "service" as const,
  }));
  const coordinator = createLiveHostControl({
    authorization,
    now: () => 1_000,
    runtime: {
      drainAcceptedWork: vi.fn(async () => {
        expect(storage.getLiveHostControl()).toMatchObject({
          admissionState: "draining",
          configuredHostId: "device-host-1",
          configuredMode: "device",
          hostEpoch: 1,
        });
        throw new Error("controlled drain refusal");
      }),
      start,
      stop,
    },
    settlement: { flush },
    storage,
  });

  expect(
    coordinator.provision({ hostId: "device-host-1", mode: "device" }),
  ).toMatchObject({ ok: true, snapshot: { hostEpoch: 1 } });
  expect(
    coordinator.register({
      connectionId: "device-connection-1",
      hostEpoch: 1,
      hostId: "device-host-1",
      instanceId: "device-instance-1",
      mode: "device",
    }),
  ).toMatchObject({
    ok: true,
    snapshot: { admissionState: "open" },
  });

  await expect(
    coordinator.transition({
      from: {
        connectionId: "device-connection-1",
        hostEpoch: 1,
        hostId: "device-host-1",
        instanceId: "device-instance-1",
        mode: "device",
      },
      to: { hostId: "service-host-1", mode: "service" },
      transitionId: "device-to-service-1",
    }),
  ).resolves.toMatchObject({ ok: false, reason: "drain-refused" });

  expect(flush).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();

  closeStorage(storage);
  const reopened = openSyncRelayStorage(dbPath);
  storages.push(reopened);
  expect(reopened.getLiveHostControl()).toEqual({
    admissionState: "closed",
    configuredHostId: "device-host-1",
    configuredMode: "device",
    hostEpoch: 1,
    lastCompletedTransitionId: null,
    lastTransitionGeneration: 1,
    registeredConnectionId: null,
    registeredInstanceId: "device-instance-1",
    transition: null,
    updatedAtMs: 1_000,
  });

  const reopenedCoordinator = createLiveHostControl({
    authorization: permissiveAuthorization(),
    now: () => 2_000,
    runtime: {
      drainAcceptedWork: vi.fn(async () => undefined),
      start,
      stop,
    },
    settlement: { flush },
    storage: reopened,
  });
  expect(
    reopenedCoordinator.register({
      connectionId: "service-connection-1",
      hostEpoch: 1,
      hostId: "service-host-1",
      instanceId: "service-instance-1",
      mode: "service",
    }),
  ).toEqual({ ok: false, reason: "wrong-mode" });
  expect(reopened.getLiveHostControl()).toMatchObject({
    admissionState: "closed",
    configuredHostId: "device-host-1",
    configuredMode: "device",
    hostEpoch: 1,
  });
});

it("orders drain, maintenance flush, epoch commit, stop, start, and activation", async () => {
  const { dbPath, storage } = await newStorage();
  const events: string[] = [];
  const flush = vi.fn(async (reason: string) => {
    events.push(`flush:${reason}`);
  });
  const coordinator = createLiveHostControl({
    authorization: permissiveAuthorization(),
    now: (() => {
      let time = 100;
      return () => time++;
    })(),
    runtime: {
      async drainAcceptedWork() {
        events.push("drain");
        expect(storage.getLiveHostControl()).toMatchObject({
          admissionState: "draining",
          configuredMode: "device",
          hostEpoch: 1,
        });
      },
      async stop() {
        events.push("epoch-commit");
        expect(storage.getLiveHostControl()).toMatchObject({
          admissionState: "closed",
          configuredMode: "service",
          hostEpoch: 2,
          transition: { phase: "activating" },
        });
        events.push("stop");
      },
      async start() {
        events.push("start");
        return SERVICE;
      },
    },
    settlement: { flush },
    storage,
  });
  expect(coordinator.provision({ hostId: DEVICE.hostId, mode: DEVICE.mode }).ok).toBe(true);
  expect(coordinator.register(DEVICE).ok).toBe(true);

  const result = await coordinator.transition({
    from: DEVICE,
    to: { hostId: SERVICE.hostId, mode: SERVICE.mode },
    transitionId: "ordered-transition",
  });
  expect(result).toMatchObject({
    ok: true,
    snapshot: {
      admissionState: "open",
      configuredMode: "service",
      hostEpoch: 2,
      lastCompletedTransitionId: "ordered-transition",
      lastTransitionGeneration: 1,
      registeredInstanceId: SERVICE.instanceId,
      transition: null,
    },
  });
  events.push("activation");
  expect(events).toEqual([
    "drain",
    "flush:maintenance-drain",
    "epoch-commit",
    "stop",
    "start",
    "activation",
  ]);
  expect(flush).toHaveBeenCalledWith("maintenance-drain");

  closeStorage(storage);
  const reopened = openSyncRelayStorage(dbPath);
  storages.push(reopened);
  expect(reopened.getLiveHostControl()).toMatchObject({
    admissionState: "open",
    configuredMode: "service",
    hostEpoch: 2,
    lastCompletedTransitionId: "ordered-transition",
  });
});

it("aborts a flush refusal without stopping or starting a host", async () => {
  const { storage } = await newStorage();
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async () => SERVICE);
  const coordinator = createLiveHostControl({
    authorization: permissiveAuthorization(),
    now: () => 200,
    runtime: {
      drainAcceptedWork: vi.fn(async () => undefined),
      start,
      stop,
    },
    settlement: {
      flush: vi.fn(async () => {
        throw new Error("controlled flush refusal");
      }),
    },
    storage,
  });
  coordinator.provision({ hostId: DEVICE.hostId, mode: DEVICE.mode });
  coordinator.register(DEVICE);
  await expect(
    coordinator.transition({
      from: DEVICE,
      to: { hostId: SERVICE.hostId, mode: SERVICE.mode },
      transitionId: "flush-refusal",
    }),
  ).resolves.toEqual({ ok: false, reason: "flush-refused" });
  expect(stop).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(storage.getLiveHostControl()).toMatchObject({
    admissionState: "closed",
    configuredMode: "device",
    hostEpoch: 1,
    registeredConnectionId: null,
    registeredInstanceId: DEVICE.instanceId,
    transition: null,
  });
  expect(
    coordinator.register({ ...DEVICE, connectionId: "device-connection-2" }),
  ).toMatchObject({ ok: true, snapshot: { admissionState: "open" } });
});

it("requires maintenance authority again for resume and explicit abort", async () => {
  const { storage } = await newStorage();
  provisionAndRegister(storage);
  const begun = beginDeviceToService(storage, "protected-transition");
  if (!begun.ok || begun.snapshot.transition === null) throw new Error("transition did not begin");
  const before = begun.snapshot;
  const runtime = {
    drainAcceptedWork: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    start: vi.fn(async () => SERVICE),
  };
  const authorization = permissiveAuthorization();
  vi.mocked(authorization.authorizeDeploymentMaintenance).mockImplementation(({ action }) => {
    if (action === "resume" || action === "abort") throw new Error("not authorized");
  });
  const coordinator = createLiveHostControl({
    authorization,
    runtime,
    settlement: { flush: vi.fn(async () => undefined) },
    storage,
  });
  await expect(
    coordinator.resume({
      transitionGeneration: before.lastTransitionGeneration!,
      transitionId: "protected-transition",
    }),
  ).rejects.toThrow("not authorized");
  expect(() =>
    coordinator.abort({
      transitionGeneration: before.lastTransitionGeneration!,
      transitionId: "protected-transition",
    }),
  ).toThrow("not authorized");
  expect(runtime.drainAcceptedWork).not.toHaveBeenCalled();
  expect(runtime.stop).not.toHaveBeenCalled();
  expect(runtime.start).not.toHaveBeenCalled();
  expect(storage.getLiveHostControl()).toEqual(before);
});

it("authorizes the exact normalized coordinate used by storage", async () => {
  const { storage } = await newStorage();
  const registrationAuthorizations: ReportedHostConnection[] = [];
  const connectionAuthorizations: ReportedHostConnection[] = [];
  const authorization: LiveHostAuthorizationPorts = {
    authorizeDeploymentMaintenance: vi.fn(),
    authorizeHostConnection: (input) => connectionAuthorizations.push({ ...input }),
    authorizeHostRegistration: (input) => registrationAuthorizations.push({ ...input }),
  };
  const coordinator = createLiveHostControl({
    authorization,
    runtime: {
      drainAcceptedWork: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => changingReport(SERVICE, DEVICE)),
    },
    settlement: { flush: vi.fn(async () => undefined) },
    storage,
  });
  expect(coordinator.provision({ hostId: DEVICE.hostId, mode: DEVICE.mode }).ok).toBe(true);

  expect(coordinator.register(changingReport(DEVICE, SERVICE)).ok).toBe(true);
  const deviceRegistrationAuthorization = registrationAuthorizations[0];

  expect(coordinator.disconnect(changingReport(DEVICE, SERVICE)).ok).toBe(true);
  const deviceConnectionAuthorization = connectionAuthorizations[0];

  expect(coordinator.register(DEVICE).ok).toBe(true);
  registrationAuthorizations.length = 0;
  await expect(
    coordinator.transition({
      from: DEVICE,
      to: { hostId: SERVICE.hostId, mode: SERVICE.mode },
      transitionId: "single-read-authorization",
    }),
  ).resolves.toMatchObject({ ok: true });
  expect({
    activation: registrationAuthorizations[0],
    disconnect: deviceConnectionAuthorization,
    registration: deviceRegistrationAuthorization,
  }).toEqual({
    activation: SERVICE,
    disconnect: DEVICE,
    registration: DEVICE,
  });
});

it("keeps crash-shaped draining and activating states closed until an explicit command", async () => {
  const { dbPath, storage } = await newStorage();
  provisionAndRegister(storage);
  const begun = beginDeviceToService(storage, "restart-transition");
  if (!begun.ok || begun.snapshot.transition === null) throw new Error("transition did not begin");
  const generation = begun.snapshot.transition.transitionGeneration;
  closeStorage(storage);

  let reopened = openSyncRelayStorage(dbPath);
  storages.push(reopened);
  expect(reopened.getLiveHostControl()).toMatchObject({
    admissionState: "draining",
    configuredMode: "device",
    hostEpoch: 1,
    transition: { phase: "draining" },
  });
  expect(
    reopened.registerLiveHost({
      ...storageCoordinate(DEVICE),
      connectionId: "device-connection-after-crash",
      guard: () => undefined,
      updatedAtMs: 30,
    }),
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
  closeStorage(reopened);

  reopened = openSyncRelayStorage(dbPath);
  storages.push(reopened);
  expect(reopened.getLiveHostControl()).toMatchObject({
    admissionState: "closed",
    configuredMode: "service",
    hostEpoch: 2,
    registeredConnectionId: null,
    transition: { phase: "activating" },
  });
  expect(
    reopened.registerLiveHost({
      ...storageCoordinate(DEVICE),
      guard: () => undefined,
      updatedAtMs: 32,
    }),
  ).toEqual({ ok: false, reason: "wrong-mode" });
});

it("fences disconnected, replaced, and stale host connections", async () => {
  const { storage } = await newStorage();
  provisionAndRegister(storage);
  const coordinator = createLiveHostControl({
    authorization: permissiveAuthorization(),
    now: (() => {
      let time = 50;
      return () => time++;
    })(),
    runtime: {
      drainAcceptedWork: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => SERVICE),
    },
    settlement: { flush: vi.fn(async () => undefined) },
    storage,
  });

  expect(coordinator.disconnect(DEVICE).ok).toBe(true);
  expect(
    coordinator.register({ ...DEVICE, instanceId: "different-device-instance" }),
  ).toEqual({ ok: false, reason: "wrong-instance" });
  expect(coordinator.register({ ...DEVICE, connectionId: "device-connection-2" }).ok).toBe(
    true,
  );
  expect(coordinator.disconnect(DEVICE)).toEqual({ ok: false, reason: "wrong-connection" });
  expect(storage.getLiveHostControl()).toMatchObject({
    admissionState: "open",
    registeredConnectionId: "device-connection-2",
  });

  const currentDevice = { ...DEVICE, connectionId: "device-connection-2" };
  expect(
    await coordinator.transition({
      from: currentDevice,
      to: { hostId: SERVICE.hostId, mode: SERVICE.mode },
      transitionId: "disconnect-fence",
    }),
  ).toMatchObject({ ok: true });
  expect(coordinator.disconnect(currentDevice)).toEqual({
    ok: false,
    reason: "wrong-mode",
  });
  expect(storage.getLiveHostControl()).toMatchObject({
    admissionState: "open",
    configuredMode: "service",
    hostEpoch: 2,
  });
  expect(coordinator.disconnect(SERVICE).ok).toBe(true);
  expect(coordinator.register(DEVICE)).toEqual({ ok: false, reason: "wrong-mode" });
});

it("fences a stale epoch even when every other connection coordinate is reused", async () => {
  const { storage } = await newStorage();
  const coordinator = createLiveHostControl({
    authorization: permissiveAuthorization(),
    runtime: {
      drainAcceptedWork: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async (input) =>
        input.mode === "service"
          ? SERVICE
          : { ...DEVICE, hostEpoch: 3 },
      ),
    },
    settlement: { flush: vi.fn(async () => undefined) },
    storage,
  });
  coordinator.provision({ hostId: DEVICE.hostId, mode: DEVICE.mode });
  coordinator.register(DEVICE);
  expect(
    await coordinator.transition({
      from: DEVICE,
      to: { hostId: SERVICE.hostId, mode: SERVICE.mode },
      transitionId: "to-service",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await coordinator.transition({
      from: SERVICE,
      to: { hostId: DEVICE.hostId, mode: DEVICE.mode },
      transitionId: "back-to-device",
    }),
  ).toMatchObject({ ok: true, snapshot: { hostEpoch: 3 } });
  expect(coordinator.disconnect(DEVICE)).toEqual({
    ok: false,
    reason: "stale-epoch",
  });
  expect(storage.getLiveHostControl()).toMatchObject({
    admissionState: "open",
    configuredMode: "device",
    hostEpoch: 3,
    registeredConnectionId: DEVICE.connectionId,
  });
});

it("does not let reports provision, replace, or conflict with durable authority", async () => {
  const { storage } = await newStorage();
  const coordinator = createLiveHostControl({
    authorization: permissiveAuthorization(),
    runtime: {
      drainAcceptedWork: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => SERVICE),
    },
    settlement: { flush: vi.fn(async () => undefined) },
    storage,
  });
  expect(coordinator.register(DEVICE)).toEqual({ ok: false, reason: "not-provisioned" });
  expect(storage.getLiveHostControl()).toBeNull();
  expect(coordinator.provision({ hostId: DEVICE.hostId, mode: DEVICE.mode }).ok).toBe(true);
  expect(coordinator.provision({ hostId: SERVICE.hostId, mode: SERVICE.mode })).toEqual({
    ok: false,
    reason: "conflicting-provision",
  });
  expect(storage.getLiveHostControl()).toMatchObject({
    configuredHostId: DEVICE.hostId,
    configuredMode: DEVICE.mode,
    hostEpoch: 1,
  });
});

it("serializes transition begin against another handle and registration", async () => {
  const { dbPath, storage } = await newStorage();
  provisionAndRegister(storage);
  const other = openSyncRelayStorage(dbPath);
  storages.push(other);
  const first = beginDeviceToService(storage, "race-transition");
  expect(first).toMatchObject({ ok: true, snapshot: { admissionState: "draining" } });
  expect(beginDeviceToService(other, "competing-transition")).toEqual({
    ok: false,
    reason: "busy-transition",
  });
  expect(
    other.registerLiveHost({
      ...storageCoordinate(DEVICE),
      connectionId: "racing-connection",
      guard: () => undefined,
      updatedAtMs: 21,
    }),
  ).toEqual({ ok: false, reason: "draining" });
  expect(other.getLiveHostControl()).toMatchObject({
    admissionState: "draining",
    registeredConnectionId: DEVICE.connectionId,
    transition: { transitionId: "race-transition" },
  });
});

it("allows registration to land before begin but never during drain", async () => {
  const { storage } = await newStorage();
  provisionAndRegister(storage);
  const replacement = { ...DEVICE, connectionId: "replacement-before-begin" };
  expect(
    storage.registerLiveHost({
      ...storageCoordinate(replacement),
      guard: () => undefined,
      updatedAtMs: 19,
    }),
  ).toMatchObject({ ok: true, snapshot: { admissionState: "open" } });
  expect(
    storage.beginLiveHostTransition({
      from: storageCoordinate(replacement),
      guard: () => undefined,
      startedAtMs: 20,
      toHostId: SERVICE.hostId,
      toMode: SERVICE.mode,
      transitionId: "after-registration",
    }),
  ).toMatchObject({ ok: true, snapshot: { admissionState: "draining" } });
  expect(
    storage.registerLiveHost({
      ...storageCoordinate({ ...replacement, connectionId: "too-late" }),
      guard: () => undefined,
      updatedAtMs: 21,
    }),
  ).toEqual({ ok: false, reason: "draining" });
});

it("refuses same-mode transitions and both exhaustion boundaries before begin", async () => {
  const { dbPath, storage } = await newStorage();
  provisionAndRegister(storage);
  expect(
    storage.beginLiveHostTransition({
      from: storageCoordinate(DEVICE),
      guard: () => undefined,
      startedAtMs: 20,
      toHostId: "another-device",
      toMode: "device",
      transitionId: "hidden-replacement",
    }),
  ).toEqual({ ok: false, reason: "same-mode" });

  const raw = rawDatabase(dbPath);
  raw
    .prepare(
      "UPDATE sync_relay_session_host_control SET host_epoch = ? WHERE singleton_id = 1",
    )
    .run(Number.MAX_SAFE_INTEGER);
  raw.close();
  const exhaustedEpoch = {
    ...DEVICE,
    hostEpoch: Number.MAX_SAFE_INTEGER,
  };
  const beforeEpoch = storage.getLiveHostControl();
  expect(
    storage.beginLiveHostTransition({
      from: storageCoordinate(exhaustedEpoch),
      guard: () => undefined,
      startedAtMs: 21,
      toHostId: SERVICE.hostId,
      toMode: SERVICE.mode,
      transitionId: "epoch-exhausted",
    }),
  ).toEqual({ ok: false, reason: "exhausted-epoch" });
  expect(storage.getLiveHostControl()).toEqual(beforeEpoch);

  const reset = rawDatabase(dbPath);
  reset
    .prepare(
      `UPDATE sync_relay_session_host_control
       SET host_epoch = 1, transition_generation = ?
       WHERE singleton_id = 1`,
    )
    .run(Number.MAX_SAFE_INTEGER);
  reset.close();
  const beforeGeneration = storage.getLiveHostControl();
  expect(beginDeviceToService(storage, "generation-exhausted", 22)).toEqual({
    ok: false,
    reason: "exhausted-transition-generation",
  });
  expect(storage.getLiveHostControl()).toEqual(beforeGeneration);
});

it("allocates fresh generations and runtime keys for T1, T2, then T1", async () => {
  const { storage } = await newStorage();
  const observed: Array<{
    transitionGeneration: number;
    transitionId: string;
    transitionFromEpoch: number;
  }> = [];
  const coordinator = createLiveHostControl({
    authorization: permissiveAuthorization(),
    now: (() => {
      let time = 100;
      return () => time++;
    })(),
    runtime: {
      async drainAcceptedWork(input) {
        observed.push(input);
        throw new Error("controlled refusal");
      },
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => SERVICE),
    },
    settlement: { flush: vi.fn(async () => undefined) },
    storage,
  });
  coordinator.provision({ hostId: DEVICE.hostId, mode: DEVICE.mode });
  let connection = DEVICE;
  coordinator.register(connection);
  for (const [index, transitionId] of ["T1", "T2", "T1"].entries()) {
    await expect(
      coordinator.transition({
        from: connection,
        to: { hostId: SERVICE.hostId, mode: SERVICE.mode },
        transitionId,
      }),
    ).resolves.toEqual({ ok: false, reason: "drain-refused" });
    if (index < 2) {
      connection = { ...DEVICE, connectionId: `device-reconnect-${index + 1}` };
      expect(coordinator.register(connection).ok).toBe(true);
    }
  }
  expect(
    observed.map(({ transitionGeneration, transitionFromEpoch, transitionId }) => ({
      transitionGeneration,
      transitionFromEpoch,
      transitionId,
    })),
  ).toEqual([
    { transitionGeneration: 1, transitionFromEpoch: 1, transitionId: "T1" },
    { transitionGeneration: 2, transitionFromEpoch: 1, transitionId: "T2" },
    { transitionGeneration: 3, transitionFromEpoch: 1, transitionId: "T1" },
  ]);
  expect(new Set(observed.map((input) => `${input.transitionGeneration}:${input.transitionId}:${input.transitionFromEpoch}`)).size).toBe(3);
});

it("replays only the unchanged completed activation coordinate", async () => {
  const { storage } = await newStorage();
  const authorization = permissiveAuthorization();
  const coordinator = createLiveHostControl({
    authorization,
    now: (() => {
      let time = 300;
      return () => time++;
    })(),
    runtime: {
      drainAcceptedWork: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => SERVICE),
    },
    settlement: { flush: vi.fn(async () => undefined) },
    storage,
  });
  coordinator.provision({ hostId: DEVICE.hostId, mode: DEVICE.mode });
  coordinator.register(DEVICE);
  const completed = await coordinator.transition({
    from: DEVICE,
    to: { hostId: SERVICE.hostId, mode: SERVICE.mode },
    transitionId: "lost-activation-response",
  });
  if (!completed.ok) throw new Error(`transition refused: ${completed.reason}`);
  const generation = completed.snapshot.lastTransitionGeneration!;
  expect(
    storage.beginLiveHostTransition({
      from: storageCoordinate(SERVICE),
      guard: () => undefined,
      startedAtMs: 399,
      toHostId: DEVICE.hostId,
      toMode: DEVICE.mode,
      transitionId: "lost-activation-response",
    }),
  ).toEqual({ ok: false, reason: "completed-transition-id" });
  expect(
    storage.activateLiveHostTransition({
      ...storageCoordinate(SERVICE),
      guard: () => authorization.authorizeHostRegistration(SERVICE),
      transitionFromEpoch: parseHostEpoch(1),
      transitionGeneration: generation,
      transitionId: "lost-activation-response",
      updatedAtMs: 400,
    }),
  ).toEqual(completed);
  await expect(
    coordinator.resume({
      transitionGeneration: generation,
      transitionId: "lost-activation-response",
    }),
  ).resolves.toEqual(completed);
  await expect(
    coordinator.resume({
      transitionGeneration: Number(generation) + 1,
      transitionId: "lost-activation-response",
    }),
  ).resolves.toEqual({ ok: false, reason: "stale-transition" });
  await expect(
    coordinator.resume({
      transitionGeneration: generation,
      transitionId: "another-transition",
    }),
  ).resolves.toEqual({ ok: false, reason: "stale-transition" });

  expect(coordinator.disconnect(SERVICE).ok).toBe(true);
  await expect(
    coordinator.resume({
      transitionGeneration: generation,
      transitionId: "lost-activation-response",
    }),
  ).resolves.toEqual({ ok: false, reason: "stale-transition" });
});

it("clears a completed receipt on state-changing reconnect and later transition", async () => {
  const { storage } = await newStorage();
  const coordinator = createLiveHostControl({
    authorization: permissiveAuthorization(),
    runtime: {
      drainAcceptedWork: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => SERVICE),
    },
    settlement: { flush: vi.fn(async () => undefined) },
    storage,
  });
  coordinator.provision({ hostId: DEVICE.hostId, mode: DEVICE.mode });
  coordinator.register(DEVICE);
  const completed = await coordinator.transition({
    from: DEVICE,
    to: { hostId: SERVICE.hostId, mode: SERVICE.mode },
    transitionId: "receipt-to-clear",
  });
  if (!completed.ok) throw new Error(`transition refused: ${completed.reason}`);
  const generation = completed.snapshot.lastTransitionGeneration!;
  const reconnected = { ...SERVICE, connectionId: "service-connection-2" };
  expect(coordinator.register(reconnected).ok).toBe(true);
  expect(storage.getLiveHostControl()?.lastCompletedTransitionId).toBeNull();
  await expect(
    coordinator.resume({ transitionGeneration: generation, transitionId: "receipt-to-clear" }),
  ).resolves.toEqual({ ok: false, reason: "stale-transition" });

  const later = storage.beginLiveHostTransition({
    from: storageCoordinate(reconnected),
    guard: () => undefined,
    startedAtMs: 500,
    toHostId: DEVICE.hostId,
    toMode: DEVICE.mode,
    transitionId: "later-transition",
  });
  expect(later).toMatchObject({ ok: true, snapshot: { lastCompletedTransitionId: null } });
  if (!later.ok || later.snapshot.transition === null) throw new Error("later transition absent");
  expect(
    storage.abortLiveHostTransition({
      transitionGeneration: later.snapshot.transition.transitionGeneration,
      transitionId: "later-transition",
      updatedAtMs: 501,
    }),
  ).toMatchObject({
    ok: true,
    snapshot: { admissionState: "closed", lastCompletedTransitionId: null },
  });
});

it("resumes each crash boundary with one persisted key and one target instance", async () => {
  for (const boundary of ["drain", "flush", "epoch-commit", "old-stop", "target-start"] as const) {
    const { storage } = await newStorage();
    provisionAndRegister(storage);
    const begun = beginDeviceToService(storage, `crash-${boundary}`);
    if (!begun.ok || begun.snapshot.transition === null) throw new Error("transition did not begin");
    const transition = begun.snapshot.transition;
    const key = `${transition.transitionGeneration}:${transition.transitionId}:${transition.fromEpoch}`;
    const drainedKeys = new Set<string>();
    const stoppedKeys = new Set<string>();
    const started = new Map<string, typeof SERVICE>();
    let drainEffects = 0;
    let flushEffects = 0;
    let stopEffects = 0;
    let startEffects = 0;
    let flushed = false;

    const drain = async (input: { transitionGeneration: number; transitionId: string; transitionFromEpoch: number }) => {
      const runtimeKey = `${input.transitionGeneration}:${input.transitionId}:${input.transitionFromEpoch}`;
      if (!drainedKeys.has(runtimeKey)) {
        drainedKeys.add(runtimeKey);
        drainEffects += 1;
      }
    };
    const stop = async (input: { transitionGeneration: number; transitionId: string; transitionFromEpoch: number }) => {
      const runtimeKey = `${input.transitionGeneration}:${input.transitionId}:${input.transitionFromEpoch}`;
      if (!stoppedKeys.has(runtimeKey)) {
        stoppedKeys.add(runtimeKey);
        stopEffects += 1;
      }
    };
    const start = async (input: { transitionGeneration: number; transitionId: string; transitionFromEpoch: number }) => {
      const runtimeKey = `${input.transitionGeneration}:${input.transitionId}:${input.transitionFromEpoch}`;
      const existing = started.get(runtimeKey);
      if (existing !== undefined) return existing;
      startEffects += 1;
      started.set(runtimeKey, SERVICE);
      return SERVICE;
    };
    const flush = async () => {
      if (!flushed) {
        flushed = true;
        flushEffects += 1;
      }
    };

    await drain({
      transitionGeneration: transition.transitionGeneration,
      transitionId: transition.transitionId,
      transitionFromEpoch: transition.fromEpoch,
    });
    if (boundary !== "drain") await flush();
    if (boundary === "epoch-commit" || boundary === "old-stop" || boundary === "target-start") {
      expect(
        storage.commitLiveHostTransitionEpoch({
          transitionGeneration: transition.transitionGeneration,
          transitionId: transition.transitionId,
          updatedAtMs: 30,
        }).ok,
      ).toBe(true);
    }
    if (boundary === "old-stop" || boundary === "target-start") {
      await stop({
        transitionGeneration: transition.transitionGeneration,
        transitionId: transition.transitionId,
        transitionFromEpoch: transition.fromEpoch,
      });
    }
    if (boundary === "target-start") {
      await start({
        transitionGeneration: transition.transitionGeneration,
        transitionId: transition.transitionId,
        transitionFromEpoch: transition.fromEpoch,
      });
    }

    const coordinator = createLiveHostControl({
      authorization: permissiveAuthorization(),
      runtime: {
        drainAcceptedWork: drain,
        start,
        stop,
      },
      settlement: { flush },
      storage,
    });
    const result = await coordinator.resume({
      transitionGeneration: transition.transitionGeneration,
      transitionId: transition.transitionId,
    });
    expect(result, boundary).toMatchObject({
      ok: true,
      snapshot: {
        admissionState: "open",
        configuredMode: "service",
        hostEpoch: 2,
        registeredInstanceId: SERVICE.instanceId,
      },
    });
    expect(drainedKeys, boundary).toEqual(new Set([key]));
    expect(stoppedKeys, boundary).toEqual(new Set([key]));
    expect(started, boundary).toEqual(new Map([[key, SERVICE]]));
    expect(drainEffects, boundary).toBe(1);
    expect(flushEffects, boundary).toBe(1);
    expect(stopEffects, boundary).toBe(1);
    expect(startEffects, boundary).toBe(1);
  }
});

it("rejects malformed host-control rows through SQLite constraints", async () => {
  const { dbPath, storage } = await newStorage();
  provisionAndRegister(storage);
  const raw = rawDatabase(dbPath);
  const update = (sql: string): void => {
    expect(() => raw.exec(`SAVEPOINT malformed; ${sql}; RELEASE malformed`)).toThrow();
    try {
      raw.exec("ROLLBACK TO malformed; RELEASE malformed");
    } catch {}
  };

  update(
    `UPDATE sync_relay_session_host_control
     SET registered_instance_id = NULL
     WHERE singleton_id = 1`,
  );
  update(
    `UPDATE sync_relay_session_host_control
     SET admission_state = 'closed'
     WHERE singleton_id = 1`,
  );
  raw.close();

  const begun = beginDeviceToService(storage, "malformed-active");
  if (!begun.ok || begun.snapshot.transition === null) throw new Error("transition did not begin");
  let mutator = rawDatabase(dbPath);
  expect(() =>
    mutator
      .prepare(
        "UPDATE sync_relay_session_host_control SET transition_generation = 0 WHERE singleton_id = 1",
      )
      .run(),
  ).toThrow();
  expect(() =>
    mutator
      .prepare(
        "UPDATE sync_relay_session_host_control SET last_completed_transition_id = 'bad' WHERE singleton_id = 1",
      )
      .run(),
  ).toThrow();
  mutator.close();

  const generation = begun.snapshot.transition.transitionGeneration;
  expect(
    storage.commitLiveHostTransitionEpoch({
      transitionGeneration: generation,
      transitionId: "malformed-active",
      updatedAtMs: 40,
    }).ok,
  ).toBe(true);
  expect(
    storage.activateLiveHostTransition({
      ...storageCoordinate(SERVICE),
      guard: () => undefined,
      transitionFromEpoch: parseHostEpoch(1),
      transitionGeneration: generation,
      transitionId: "malformed-active",
      updatedAtMs: 41,
    }).ok,
  ).toBe(true);

  mutator = rawDatabase(dbPath);
  expect(() =>
    mutator
      .prepare(
        "UPDATE sync_relay_session_host_control SET transition_generation = 0 WHERE singleton_id = 1",
      )
      .run(),
  ).toThrow();
  expect(() =>
    mutator
      .prepare(
        `UPDATE sync_relay_session_host_control
         SET admission_state = 'closed', registered_connection_id = NULL
         WHERE singleton_id = 1`,
      )
      .run(),
  ).toThrow();
  mutator.close();
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

it("persists the exact migration marker and table shape across reopen", async () => {
  const { dbPath, storage } = await newStorage();
  closeStorage(storage);
  let reopened = openSyncRelayStorage(dbPath);
  storages.push(reopened);
  closeStorage(reopened);
  const raw = rawDatabase(dbPath);
  const columns = raw
    .prepare("PRAGMA table_info(sync_relay_session_host_control)")
    .all()
    .map((row) => String(row.name));
  expect(columns).toEqual([
    "singleton_id",
    "configured_mode",
    "configured_host_id",
    "host_epoch",
    "transition_generation",
    "admission_state",
    "registered_instance_id",
    "registered_connection_id",
    "transition_phase",
    "transition_id",
    "transition_from_mode",
    "transition_from_host_id",
    "transition_from_instance_id",
    "transition_from_connection_id",
    "transition_from_epoch",
    "transition_to_mode",
    "transition_to_host_id",
    "transition_started_at_ms",
    "last_completed_transition_id",
    "updated_at_ms",
  ]);
  expect(
    raw
      .prepare(
        "SELECT COUNT(*) AS count FROM sync_relay_migrations WHERE migration_id = 'session-host-control-v1'",
      )
      .get()?.count,
  ).toBe(1);
  const sql = String(
    raw
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'sync_relay_session_host_control'",
      )
      .get()?.sql,
  );
  expect(sql).toContain("transition_generation BETWEEN 0 AND 9007199254740991");
  expect(sql).toContain("last_completed_transition_id IS NULL OR transition_generation >= 1");
  expect(sql).toContain("admission_state <> 'closed' OR registered_connection_id IS NULL");
  raw.close();
  reopened = openSyncRelayStorage(dbPath);
  storages.push(reopened);
  expect(reopened.getLiveHostControl()).toBeNull();
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
    guard: () => undefined,
    hostId: DEVICE.hostId,
    mode: DEVICE.mode,
    updatedAtMs: 2,
  });
  let before = storage.getLiveHostControl();
  expect(() =>
    storage.registerLiveHost({
      ...storageCoordinate(DEVICE),
      guard: refused,
      updatedAtMs: 3,
    }),
  ).toThrow("guard refused");
  expect(storage.getLiveHostControl()).toEqual(before);
  storage.registerLiveHost({
    ...storageCoordinate(DEVICE),
    guard: () => undefined,
    updatedAtMs: 4,
  });
  before = storage.getLiveHostControl();
  expect(() =>
    storage.disconnectLiveHost({
      ...storageCoordinate(DEVICE),
      guard: refused,
      updatedAtMs: 5,
    }),
  ).toThrow("guard refused");
  expect(storage.getLiveHostControl()).toEqual(before);
  expect(() =>
    storage.beginLiveHostTransition({
      from: storageCoordinate(DEVICE),
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
      ...storageCoordinate(SERVICE),
      guard: refused,
      transitionFromEpoch: parseHostEpoch(1),
      transitionGeneration: begun.snapshot.transition!.transitionGeneration,
      transitionId: "guarded-activation",
      updatedAtMs: 8,
    }),
  ).toThrow("guard refused");
  expect(storage.getLiveHostControl()).toEqual(before);
});

it("runs the provisioning guard under BEGIN IMMEDIATE", async () => {
  const { dbPath, storage } = await newStorage();
  const raw = rawDatabase(dbPath);
  raw.exec("PRAGMA busy_timeout = 0");
  let busy: unknown;
  const result = storage.provisionLiveHostControl({
    guard: () => {
      try {
        raw
          .prepare(
            `INSERT INTO sync_relay_session_host_control (
               singleton_id, configured_mode, configured_host_id, host_epoch,
               transition_generation, admission_state, updated_at_ms
             ) VALUES (1, 'service', 'competing-service', 1, 0, 'closed', 1)`,
          )
          .run();
      } catch (error) {
        busy = error;
      }
    },
    hostId: DEVICE.hostId,
    mode: DEVICE.mode,
    updatedAtMs: 1,
  });
  raw.close();
  expect(String(busy)).toMatch(/busy|locked/i);
  expect(result).toMatchObject({
    ok: true,
    snapshot: { configuredHostId: DEVICE.hostId, configuredMode: "device" },
  });
});
