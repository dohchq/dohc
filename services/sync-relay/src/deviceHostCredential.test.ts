import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { createDeviceHostCredential, parseDeviceHostCredential } from "./deviceHostCredential.js";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const roots: string[] = [], stores: SyncRelayStorage[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dohc-device-credential-")); roots.push(root);
  const path = join(root, "relay.sqlite"), storage = openSyncRelayStorage(path); stores.push(storage);
  const credential = createDeviceHostCredential("device-host", parseHostEpoch(1));
  return { root, path, storage, credential };
}
function close(storage: SyncRelayStorage) { stores.splice(stores.indexOf(storage), 1); storage.close(); }

it("stores only a scoped verifier, persists the same instance, and fences replaced connections", async () => {
  const f = await fixture();
  expect(f.storage.getLiveHostControl()).toBeNull();
  expect(f.storage.registerDeviceHost({ credential: f.credential, connectionId: "one", updatedAtMs: 1 })).toMatchObject({ ok: false });
  expect(f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 2 })).toMatchObject({ ok: true, snapshot: { admissionState: "closed" } });
  expect(f.storage.registerDeviceHost({ credential: f.credential, connectionId: "one", updatedAtMs: 3 })).toMatchObject({ ok: true });
  const raw = new DatabaseSync(f.path);
  const stored = raw.prepare("SELECT * FROM sync_relay_device_host_credential").get(); raw.close();
  expect(JSON.stringify(stored)).not.toContain(f.credential.secret);
  expect(stored?.verifier).toMatch(/^[a-f0-9]{64}$/);
  close(f.storage);
  const reopened = openSyncRelayStorage(f.path); stores.push(reopened);
  expect(reopened.registerDeviceHost({ credential: f.credential, connectionId: "two", updatedAtMs: 4 })).toMatchObject({ ok: true });
  expect(reopened.disconnectDeviceHost({ credential: f.credential, connectionId: "one", updatedAtMs: 5 })).toEqual({ ok: false, reason: "wrong-connection" });
  expect(reopened.getLiveHostControl()).toMatchObject({ registeredInstanceId: f.credential.instanceId, registeredConnectionId: "two", hostEpoch: 1 });
  expect(reopened.disconnectDeviceHost({ credential: f.credential, connectionId: "two", updatedAtMs: 6 })).toMatchObject({ ok: true });
  expect(reopened.registerDeviceHost({ credential: f.credential, connectionId: "three", updatedAtMs: 7 })).toMatchObject({ ok: true });
});

it("rejects account tokens, malformed secrets, wrong scopes, and credentials from another deployment", async () => {
  const f = await fixture();
  expect(f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 1 }).ok).toBe(true);
  const before = f.storage.getLiveHostControl();
  const alternate = createDeviceHostCredential(f.credential.hostId, f.credential.hostEpoch);
  for (const credential of [
    { ...f.credential, secret: "account-session-token" },
    { ...f.credential, secret: alternate.secret },
    { ...f.credential, hostId: "other" },
    { ...f.credential, instanceId: "other" },
    { ...f.credential, hostEpoch: parseHostEpoch(2) },
    { ...f.credential, secret: f.credential.secret + "\n" },
  ]) {
    expect(f.storage.registerDeviceHost({ credential, connectionId: "forged", updatedAtMs: 2 }).ok).toBe(false);
    expect(f.storage.getLiveHostControl()).toEqual(before);
  }
  const other = await fixture();
  expect(other.storage.provisionDeviceHostCredential({ credential: other.credential, updatedAtMs: 1 }).ok).toBe(true);
  expect(other.storage.registerDeviceHost({ credential: f.credential, connectionId: "foreign", updatedAtMs: 2 }).ok).toBe(false);
  expect(() => parseDeviceHostCredential({ ...f.credential, extra: f.credential.secret })).toThrow("Device host credential refused.");
});

it("keeps provision replay idempotent and refuses new instances before and after disconnect or revocation", async () => {
  const f = await fixture(), replacement = createDeviceHostCredential(f.credential.hostId, f.credential.hostEpoch);
  expect(f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 1 }).ok).toBe(true);
  expect(f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 2 }).ok).toBe(true);
  for (const phase of ["initial", "connected", "disconnected", "revoked"] as const) {
    if (phase === "connected") expect(f.storage.registerDeviceHost({ credential: f.credential, connectionId: "one", updatedAtMs: 3 }).ok).toBe(true);
    if (phase === "disconnected") expect(f.storage.disconnectDeviceHost({ credential: f.credential, connectionId: "one", updatedAtMs: 4 }).ok).toBe(true);
    if (phase === "revoked") expect(f.storage.revokeDeviceHostCredential({ ...f.credential, updatedAtMs: 5 }).ok).toBe(true);
    const before = f.storage.getLiveHostControl();
    expect(f.storage.provisionDeviceHostCredential({ credential: replacement, updatedAtMs: 6 }).ok).toBe(false);
    expect(f.storage.registerDeviceHost({ credential: replacement, connectionId: "replacement", updatedAtMs: 6 }).ok).toBe(false);
    expect(f.storage.getLiveHostControl()).toEqual(before);
  }
  expect(f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 7 })).toEqual({ ok: false, reason: "credential-refused" });
  close(f.storage);
  const reopened = openSyncRelayStorage(f.path); stores.push(reopened);
  expect(reopened.registerDeviceHost({ credential: f.credential, connectionId: "restart", updatedAtMs: 8 }).ok).toBe(false);
});

it("revokes and closes admission atomically, preserving revocation across replay and reopen", async () => {
  const f = await fixture();
  f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 1 });
  f.storage.registerDeviceHost({ credential: f.credential, connectionId: "one", updatedAtMs: 2 });
  const raw = new DatabaseSync(f.path);
  raw.exec(`CREATE TRIGGER reject_close BEFORE UPDATE OF admission_state ON sync_relay_session_host_control
    WHEN NEW.admission_state = 'closed' BEGIN SELECT RAISE(ABORT, 'injected close failure'); END;`);
  expect(() => f.storage.revokeDeviceHostCredential({ ...f.credential, updatedAtMs: 3 })).toThrow("injected close failure");
  expect(raw.prepare("SELECT revoked_at_ms FROM sync_relay_device_host_credential").get()?.revoked_at_ms).toBeNull();
  expect(f.storage.getLiveHostControl()?.admissionState).toBe("open");
  raw.exec("DROP TRIGGER reject_close");
  expect(f.storage.revokeDeviceHostCredential({ ...f.credential, updatedAtMs: 4 }).ok).toBe(true);
  const before = f.storage.getLiveHostControl();
  expect(before).toMatchObject({ admissionState: "closed", registeredConnectionId: null, registeredInstanceId: f.credential.instanceId, hostEpoch: 1 });
  expect(f.storage.revokeDeviceHostCredential({ ...f.credential, updatedAtMs: 5 }).ok).toBe(true);
  expect(f.storage.getLiveHostControl()).toEqual(before);
  expect(raw.prepare("SELECT revoked_at_ms FROM sync_relay_device_host_credential").get()?.revoked_at_ms).toBe(4);
  raw.close(); close(f.storage);
  const reopened = openSyncRelayStorage(f.path); stores.push(reopened);
  expect(reopened.getLiveHostControl()).toEqual(before);
  expect(reopened.registerDeviceHost({ credential: f.credential, connectionId: "two", updatedAtMs: 6 }).ok).toBe(false);
});

it("holds the SQLite write lock while checking the credential, then refuses registration after revocation commits", async () => {
  const f = await fixture(); f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 1 });
  const competitor = new DatabaseSync(f.path); competitor.exec("PRAGMA busy_timeout = 0");
  const original = DatabaseSync.prototype.prepare;
  let checked = false;
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    if (this !== competitor && sql.startsWith("SELECT * FROM sync_relay_device_host_credential")) {
      checked = true;
      expect(() => competitor.exec("UPDATE sync_relay_device_host_credential SET revoked_at_ms = 2")).toThrow(/locked|busy/);
    }
    return original.call(this, sql);
  });
  try { expect(f.storage.registerDeviceHost({ credential: f.credential, connectionId: "one", updatedAtMs: 3 }).ok).toBe(true); }
  finally { spy.mockRestore(); competitor.close(); }
  expect(checked).toBe(true);
  const second = openSyncRelayStorage(f.path); stores.push(second);
  expect(second.revokeDeviceHostCredential({ ...f.credential, updatedAtMs: 4 }).ok).toBe(true);
  expect(f.storage.registerDeviceHost({ credential: f.credential, connectionId: "two", updatedAtMs: 5 }).ok).toBe(false);
  expect(f.storage.getLiveHostControl()?.admissionState).toBe("closed");
});

it("persists revocation after a backward clock step and keeps its first timestamp across retries", async () => {
  const f = await fixture();
  expect(f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 100 }).ok).toBe(true);
  expect(f.storage.registerDeviceHost({ credential: f.credential, connectionId: "before-clock-step", updatedAtMs: 110 }).ok).toBe(true);
  expect(f.storage.revokeDeviceHostCredential({ ...f.credential, updatedAtMs: 10 }).ok).toBe(true);
  const before = f.storage.getLiveHostControl();
  expect(before).toMatchObject({ admissionState: "closed", registeredConnectionId: null, registeredInstanceId: f.credential.instanceId });
  close(f.storage);
  const reopened = openSyncRelayStorage(f.path); stores.push(reopened);
  for (const updatedAtMs of [0, 200]) {
    expect(reopened.revokeDeviceHostCredential({ ...f.credential, updatedAtMs }).ok).toBe(true);
    expect(reopened.getLiveHostControl()).toEqual(before);
    expect(reopened.registerDeviceHost({ credential: f.credential, connectionId: "after-clock-step", updatedAtMs }).ok).toBe(false);
    expect(reopened.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs }).ok).toBe(false);
  }
  const raw = new DatabaseSync(f.path);
  try {
    expect(raw.prepare("SELECT created_at_ms, revoked_at_ms FROM sync_relay_device_host_credential").get())
      .toMatchObject({ created_at_ms: 100, revoked_at_ms: 100 });
  } finally { raw.close(); }
});

it("provisions the initial credential on an existing matching device configuration", async () => {
  const f = await fixture();
  expect(f.storage.provisionLiveHostControl({ mode: "device", hostId: f.credential.hostId, updatedAtMs: 1, guard: () => {} }).ok).toBe(true);
  const before = f.storage.getLiveHostControl();
  expect(f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 2 })).toMatchObject({ ok: true, snapshot: before });
  expect(f.storage.getLiveHostControl()).toEqual(before);
  close(f.storage);
  const reopened = openSyncRelayStorage(f.path); stores.push(reopened);
  expect(reopened.registerDeviceHost({ credential: f.credential, connectionId: "adopted", updatedAtMs: 3 })).toMatchObject({
    ok: true, snapshot: { registeredInstanceId: f.credential.instanceId, registeredConnectionId: "adopted", hostEpoch: 1 },
  });
});

it("revokes during maintenance without rewriting the transition or restoring credential authority", async () => {
  const f = await fixture();
  f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 1 });
  f.storage.registerDeviceHost({ credential: f.credential, connectionId: "draining-device", updatedAtMs: 2 });
  const begun = f.storage.beginLiveHostTransition({
    from: { mode: "device", hostId: f.credential.hostId, hostEpoch: f.credential.hostEpoch,
      instanceId: f.credential.instanceId, connectionId: "draining-device" },
    toMode: "service", toHostId: "service-host", transitionId: "maintenance", startedAtMs: 3, guard: () => {},
  });
  expect(begun).toMatchObject({ ok: true, snapshot: { admissionState: "draining" } });
  const before = f.storage.getLiveHostControl();
  expect(f.storage.revokeDeviceHostCredential({ ...f.credential, updatedAtMs: 4 })).toMatchObject({ ok: true, snapshot: before });
  close(f.storage);
  const reopened = openSyncRelayStorage(f.path); stores.push(reopened);
  expect(reopened.revokeDeviceHostCredential({ ...f.credential, updatedAtMs: 5 })).toMatchObject({ ok: true, snapshot: before });
  expect(reopened.registerDeviceHost({ credential: f.credential, connectionId: "new", updatedAtMs: 6 }).ok).toBe(false);
  expect(reopened.disconnectDeviceHost({ credential: f.credential, connectionId: "draining-device", updatedAtMs: 6 }).ok).toBe(false);
  expect(reopened.getLiveHostControl()).toEqual(before);
  const raw = new DatabaseSync(f.path);
  try { expect(raw.prepare("SELECT revoked_at_ms FROM sync_relay_device_host_credential").get()?.revoked_at_ms).toBe(4); }
  finally { raw.close(); }
});

it("does not overwrite an existing deployment mode or damaged credential schema", async () => {
  const f = await fixture();
  f.storage.provisionLiveHostControl({ mode: "service", hostId: "service-host", updatedAtMs: 1, guard: () => {} });
  const before = f.storage.getLiveHostControl();
  expect(f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 2 })).toEqual({ ok: false, reason: "conflicting-provision" });
  expect(f.storage.getLiveHostControl()).toEqual(before);
  close(f.storage);
  const raw = new DatabaseSync(f.path); raw.exec("DROP TABLE sync_relay_device_host_credential"); raw.close();
  expect(() => openSyncRelayStorage(f.path)).toThrow("Device host credential schema is missing or damaged.");
});

it("rolls back the verifier if initial host provisioning fails", async () => {
  const f = await fixture(), raw = new DatabaseSync(f.path);
  raw.exec(`CREATE TRIGGER reject_initial_host BEFORE INSERT ON sync_relay_session_host_control
    BEGIN SELECT RAISE(ABORT, 'injected provision failure'); END;`);
  expect(() => f.storage.provisionDeviceHostCredential({ credential: f.credential, updatedAtMs: 1 })).toThrow("injected provision failure");
  expect(f.storage.getLiveHostControl()).toBeNull();
  expect(raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_device_host_credential").get()?.count).toBe(0);
  raw.close();
});
