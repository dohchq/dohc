import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { closeTestStorages, inspectDatabase, storagePath, tempRoot, testStorage } from "./testing";
import { createReplicaReadPrincipal } from "./replicaReadPrincipal";
import { createReplicaSupervisor, type ReplicaChild } from "./replicaSupervisor";
import { createReplicaEngineStarter } from "./replicaEngine";

afterEach(async () => { vi.useRealTimers(); await closeTestStorages(); });

async function fixture(workspaceId = "w") {
  const storage = await testStorage();
  const seed = (id: string) => {
    storage.claimWorkspace({ workspaceId: id, ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: id, replicationEpoch: "epoch", streamIdentity: "stream" });
    storage.createShare({ share: { shareId: id, workspaceId: id, granterUserId: "owner", selectorJson: "{}", createdAtMs: 1 },
      grant: { grantId: id, shareId: id, principalKind: "user", principalUserId: "reader", principalEmail: null,
        access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null } });
  };
  seed(workspaceId);
  const db = inspectDatabase(storagePath(storage));
  const digest = () => createHash("sha256").update(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}"`).all()]))).digest("hex");
  return { storage, seed, digest };
}

it("binds read authority and reads every route without changing any table", async () => {
  const { storage, seed, digest } = await fixture(); seed("other");
  const bytes = Buffer.from("visible"), sha256 = createHash("sha256").update(bytes).digest("hex");
  storage.putBlob({ workspaceId: "w", sha256, content: bytes, createdAtMs: 1 });
  storage.putBlob({ workspaceId: "w", sha256: "f".repeat(64), content: bytes, createdAtMs: 1 });
  storage.appendLogBatch({ workspaceId: "w", originId: "o", ops: [{ originSeq: 0, opKind: "moment.append", payloadJson: JSON.stringify({ payloadAfterBlobSha256: sha256, description: "f".repeat(64) }), recordedAtMs: 1 }] });
  const principal = createReplicaReadPrincipal(storage);
  const lease = principal.issue("w", "incarnation");
  principal.issue("other", "other-incarnation");
  const read = (path: string, method = "GET", headers = {}) => principal.handle(new Request(`https://relay.test${path}`, { method,
    headers: { authorization: `Bearer ${lease.bearer}`, ...headers } }));
  const before = digest();
  for (const path of ["bootstrap", "log?replicationEpoch=epoch&streamIdentity=stream", "log/o/0?replicationEpoch=epoch&streamIdentity=stream", `blobs/${sha256}`]) {
    expect((await read(`/sync/w/${path}`)).status).toBe(200);
  }
  for (const [path, method] of [["/sync/w/log", "POST"], ["/sync/w/bootstrap", "POST"], ["/sync/w/epoch", "POST"],
    ["/sync/w/keys", "GET"], ["/sync/w/keys/device", "GET"], ["/sync/w/shares", "GET"], ["/sync/other/log", "GET"], ["/sync/w/log/extra", "GET"],
    [`/sync/w/blobs/${"f".repeat(64)}`, "GET"], [`/sync/w/blobs/${sha256}`, "PUT"]]) {
    expect((await read(path!, method)).status).toBe(404);
  }
  expect((await read("/sync/w/bootstrap", "GET", { cookie: "session=owner" })).status).toBe(404);
  expect(digest()).toBe(before);
  principal.issue("w", "replacement");
  expect((await read("/sync/w/bootstrap")).status).toBe(404);
  const current = principal.issue("w", "third");
  storage.rotateWorkspaceIdentity({ workspaceId: "w", ownerUserId: "owner", replicationEpoch: "new", streamIdentity: "new-stream", rotatedAtMs: 2 });
  expect((await principal.handle(new Request("https://relay.test/sync/w/bootstrap", { headers: { authorization: `Bearer ${current.bearer}` } }))).status).toBe(404);
  const last = principal.issue("w", "fourth");
  const epochRead = (path: string) => principal.handle(new Request(`https://relay.test/sync/w/${path}`, { headers: { authorization: `Bearer ${last.bearer}` } }));
  expect((await epochRead("log/o/0?replicationEpoch=new&streamIdentity=new-stream")).status).toBe(200);
  expect((await epochRead(`blobs/${sha256}`)).status).toBe(200);
  const removal = storage.removeShareAccess({ shareId: "w", grantId: "w", actorUserId: "owner", nowMs: 3 });
  expect((await principal.handle(new Request("https://relay.test/sync/w/bootstrap", { headers: { authorization: `Bearer ${last.bearer}` } }))).status).toBe(404);
  expect(() => principal.issue("w", "no-share")).toThrow();
  if (!removal.ok || !removal.undo) throw Error("Missing removal receipt.");
  storage.undoShareRemoval({ shareId: "w", actorUserId: "owner", undoId: removal.undo.undoId, nowMs: 4 });
  expect((await principal.handle(new Request("https://relay.test/sync/w/bootstrap", { headers: { authorization: `Bearer ${last.bearer}` } }))).status).toBe(404);
  const restored = principal.issue("w", "restored");
  const again = storage.removeShareAccess({ shareId: "w", grantId: "w", actorUserId: "owner", nowMs: 5 });
  if (!again.ok || !again.undo) throw Error("Missing second removal receipt.");
  storage.undoShareRemoval({ shareId: "w", actorUserId: "owner", undoId: again.undo.undoId, nowMs: 6 });
  expect((await principal.handle(new Request("https://relay.test/sync/w/bootstrap", { headers: { authorization: `Bearer ${restored.bearer}` } }))).status).toBe(404);
});

it("wakes on append, caps children, evicts idle stores, and deletes after revocation", async () => {
  const { storage, seed } = await fixture(); seed("second");
  const starts: Array<{ storeDir: string; child: ReplicaChild }> = [];
  const pull = vi.fn(async () => {}), close = vi.fn(async () => {});
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("replicas"), maxRunning: 1, idleMs: 60_000,
    startChild: async input => { const child = { pull, close }; starts.push({ storeDir: input.storeDir, child }); return child; } });
  try {
    await supervisor.activate("w");
    expect(pull).toHaveBeenCalledTimes(1);
    await expect(supervisor.activate("second")).rejects.toThrow("capacity");
    storage.appendLogBatch({ workspaceId: "w", originId: "o", ops: [{ originSeq: 0, opKind: "moment.append", payloadJson: "{}", recordedAtMs: 1 }] });
    await expect.poll(() => pull.mock.calls.length).toBe(2);
    await supervisor.settled("w");
    expect(existsSync(starts[0]!.storeDir)).toBe(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await supervisor.activate("w");
    await vi.advanceTimersByTimeAsync(60_000); vi.useRealTimers();
    await expect.poll(() => existsSync(starts[0]!.storeDir)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    await supervisor.activate("second");
    storage.revokeShareGrant({ shareId: "second", grantId: "second", revokedAtMs: 2 });
    await expect.poll(() => existsSync(starts[1]!.storeDir)).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
  } finally { await supervisor.close(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("coalesces an append during pull and never starts two children for one workspace", async () => {
  const { storage } = await fixture();
  const entered = deferred(), release = deferred();
  const pull = vi.fn(async () => { if (pull.mock.calls.length === 1) { entered.resolve(); await release.promise; } });
  const startChild = vi.fn(async () => ({ pull, close: async () => {} }));
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("coalesce"), startChild });
  try {
    const activation = supervisor.activate("w"); await entered.promise;
    storage.appendLogBatch({ workspaceId: "w", originId: "o", ops: [{ originSeq: 0, opKind: "moment.append", payloadJson: "{}", recordedAtMs: 1 }] });
    const second = supervisor.activate("w");
    release.resolve(); await Promise.all([activation, second]); await supervisor.settled("w");
    expect(startChild).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(2);
  } finally { release.resolve(); await supervisor.close(); }
});

it("revokes a starting child, waits for it, and deletes its private directory", async () => {
  const { storage } = await fixture();
  const entered = deferred(), release = deferred();
  let storeDir = "", bearer = "";
  const pull = vi.fn(async () => {}), close = vi.fn(async () => {});
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("startup"), startChild: async input => {
    storeDir = input.storeDir; bearer = input.lease.bearer; entered.resolve(); await release.promise; return { pull, close };
  } });
  const activation = supervisor.activate("w");
  const rejected = expect(activation).rejects.toThrow("standing ended");
  await entered.promise;
  storage.revokeShareGrant({ shareId: "w", grantId: "w", revokedAtMs: 2 });
  expect((await supervisor.handle(new Request("https://relay.test/sync/w/bootstrap", { headers: { authorization: `Bearer ${bearer}` } }))).status).toBe(404);
  const shutdown = supervisor.close();
  expect(existsSync(storeDir)).toBe(true);
  release.resolve(); await rejected; await shutdown;
  expect(pull).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1); expect(existsSync(storeDir)).toBe(false);
});

it("cleans failed starts and permits a later activation without leaking capacity", async () => {
  const { storage } = await fixture();
  const errors: unknown[] = [];
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("failure"), maxRunning: 1,
    onError: (_, error) => errors.push(error), startChild: vi.fn().mockRejectedValueOnce(new Error("start failed"))
      .mockResolvedValue({ pull: async () => {}, close: async () => {} }) });
  try {
    await expect(supervisor.activate("w")).rejects.toThrow("start failed");
    await supervisor.settled("w");
    await supervisor.activate("w");
    expect(errors).toHaveLength(1);
  } finally { await supervisor.close(); }
});

it("settles a pending append notification when shutdown cancels its drain", async () => {
  const { storage } = await fixture();
  const pull = vi.fn(async () => {}), close = vi.fn(async () => {});
  let storeDir = "";
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("drain-close"), startChild: async input => {
    storeDir = input.storeDir; return { pull, close };
  } });
  await supervisor.activate("w");
  storage.appendLogBatch({ workspaceId: "w", originId: "o", ops: [{ originSeq: 0, opKind: "moment.append", payloadJson: "{}", recordedAtMs: 1 }] });
  await new Promise<void>(queueMicrotask);
  const pending = supervisor.settled("w");
  await supervisor.close(); await pending;
  expect(pull).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  expect(existsSync(storeDir)).toBe(false);
});

it("refuses unsupported production hosts and invalid limits before starting anything", async () => {
  const { storage } = await fixture();
  expect(() => createReplicaSupervisor({ storage, storeRoot: "relative", startChild: async () => { throw Error(); } })).toThrow("absolute");
  expect(() => createReplicaSupervisor({ storage, storeRoot: "C:/private", maxRunning: 0, startChild: async () => { throw Error(); } })).toThrow("budget");
  if (process.platform !== "linux") expect(() => createReplicaEngineStarter({ engineExecutable: "C:/daemon.exe", baseUrl: "https://relay.test" })).toThrow("Linux");
});
