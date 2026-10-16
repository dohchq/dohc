import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasRelayWriteObservers, notifyRelayWrite } from "./relayWriteChanges";
import { closeTestStorages, inspectDatabase, storagePath, tempRoot, testStorage } from "./testing";
import { createReplicaReadPrincipal } from "./replicaReadPrincipal";
import { createReplicaSupervisor, type ReplicaChild, type ReplicaChildInput } from "./replicaSupervisor";
import { createReplicaEngineStarter } from "./replicaEngine";
import {ReplicaCurrentViewRefused} from "./storage/replicaCurrentViews";
import {registered, cleanupLiveDeliveryFixtures} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";

const fsFailure = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rm: (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === fsFailure.path) return Promise.reject(new Error("EPERM private store"));
    return fs.rm(...args);
  } };
});
afterEach(async () => { fsFailure.path = ""; vi.restoreAllMocks(); vi.useRealTimers(); await closeTestStorages(); });

const emptyCurrentView=(input: ReplicaChildInput)=>async()=>({workspaceId:input.lease.workspaceId,revision:0,logCursor:0,journalCursor:0,files:[],texts:[],moved:false,nextCursor:null,refusedFiles:[]});

it("collects after each full drain even when a later owner write is queued",async()=>{
  const {storage}=await fixture(),events:string[]=[];let pulls=0;
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  const supervisor=createReplicaSupervisor({storage,storeRoot:await tempRoot("view-during-writes"),startChild:async input=>({
    close:async()=>{},currentView:async()=>{events.push("view");return emptyCurrentView(input)();},
    pull:async()=>{events.push("pull");if(++pulls===2){storage.appendLogBatch({workspaceId:"w",originId:"o",ops:[{originSeq:0,opKind:"moment.append",payloadJson:"{}",recordedAtMs:1}]});await vi.advanceTimersByTimeAsync(20);}}
  })});
  try{await supervisor.activate("w");events.length=0;await supervisor.activate("w");expect(events).toEqual(["pull","view","pull","view"]);}
  finally{await supervisor.close();}
});

it("drains queued writes after a view loses a restore race",async()=>{
  const {storage}=await fixture();let pulls=0;const events:string[]=[];
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  const supervisor=createReplicaSupervisor({storage,maxViewTextBytes:1,storeRoot:await tempRoot("view-restore-race"),startChild:async input=>({
    close:async()=>{},currentView:async()=>{events.push("view");const text=String(pulls).repeat(2);return {...await emptyCurrentView(input)(),files:[{versionId:"main",objectId:"a",path:"a.txt",contentKind:"text" as const,sha256:sha(text),byteLength:2,lineageClaimId:null,restoreGeneration:null}],texts:[{sha256:sha(text),text}]};},
    pull:async()=>{events.push("pull");if(++pulls===2){storage.appendLogBatch({workspaceId:"w",originId:"o",ops:[{originSeq:0,opKind:"moment.append",payloadJson:"{}",recordedAtMs:1}]});await vi.advanceTimersByTimeAsync(20);}}
  })});
  try{await supervisor.activate("w");events.length=0;vi.spyOn(storage,"stageReplicaCurrentView").mockImplementationOnce(()=>{throw new ReplicaCurrentViewRefused();});await supervisor.activate("w");expect(events).toEqual(["pull","view","pull","view"]);}
  finally{await supervisor.close();}
});

async function fixture(workspaceId = "w") {
  const storage = await testStorage();
  const seed = (id: string) => {
    storage.claimWorkspace({ workspaceId: id, ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: id, replicationEpoch: "epoch", streamIdentity: "stream" });
    storage.createShare({ share: { shareId: id, workspaceId: id, granterUserId: "owner", selectorJson: '{"paths":[],"versionId":"main"}', createdAtMs: 1 },
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
    startChild: async input => { const child = { currentView: emptyCurrentView(input), pull, close }; starts.push({ storeDir: input.storeDir, child }); return child; } });
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
    await supervisor.settled("w");
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

it("wakes for a journal commit without an ordinary log write", async () => {
  const f = registered({deployment: true});
  f.storage.claimWorkspaceIdentity({workspaceId: "workspace", replicationEpoch: "epoch", streamIdentity: "stream"});
  const pull = vi.fn(async () => {});
  const supervisor = createReplicaSupervisor({storage: f.storage, storeRoot: await tempRoot("journal-wake"),
    startChild: async input => ({currentView: emptyCurrentView(input), pull, close: async () => {}})});
  try {
    await supervisor.activate("workspace");
    expect(pull).toHaveBeenCalledTimes(1);
    expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(), "journal-only")).result.kind).toBe("accepted");
    expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_log").get()!.n).toBe(0);
    await expect.poll(() => pull.mock.calls.length).toBe(2);
    await supervisor.settled("workspace");
  } finally {await supervisor.close(); f.close(); cleanupLiveDeliveryFixtures();}
});

it.skipIf(process.env.DOHC_REPLICA_MEASURE!=="1")("measures the owner's journal commit path with an active replica observer", async () => {
  const samples:number[]=[];
  for(let sample=0;sample<21;sample++) {
    const f=registered({deployment:true});
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"epoch",streamIdentity:"stream"});
    const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("journal-push-measure"),
      startChild:async input=>({currentView: emptyCurrentView(input), pull:async()=>{},close:async()=>{}})});
    try {
      await supervisor.activate("workspace");let elapsed=0;
      for(let i=0;i<100;i++) {
        const input=f.capture(f.update("counter",String(i)),`measure-${i}`), start=performance.now();
        expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe("accepted");elapsed+=performance.now()-start;
      }
      samples.push(elapsed/100);
    }finally{await supervisor.close();f.close();cleanupLiveDeliveryFixtures();}
  }
  samples.sort((a,b)=>a-b);
  const result={median:samples[10],p95:samples[19],samples,rows:100};
  if(process.env.DOHC_REPLICA_MEASURE_OUT)writeFileSync(process.env.DOHC_REPLICA_MEASURE_OUT,JSON.stringify(result));
  console.log(`OWNER_COMMIT_MS_PER_ROW median=${result.median} p95=${result.p95} samples=21 rows=100`);
},120_000);

it("coalesces an append during pull and never starts two children for one workspace", async () => {
  const { storage } = await fixture();
  const entered = deferred(), release = deferred();
  const pull = vi.fn(async () => { if (pull.mock.calls.length === 1) { entered.resolve(); await release.promise; } });
  const startChild = vi.fn(async (input: ReplicaChildInput) => ({ currentView: emptyCurrentView(input), pull, close: async () => {} }));
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
    storeDir = input.storeDir; bearer = input.lease.bearer; entered.resolve(); await release.promise; return { currentView: emptyCurrentView(input), pull, close };
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

it("rebuilds a failed fresh store once before completing activation", async () => {
  const { storage } = await fixture();
  const errors: unknown[] = [];
  const paths: string[] = [], bearers: string[] = [];
  const startChild = vi.fn(async (input: ReplicaChildInput) => {
    paths.push(input.storeDir); bearers.push(input.lease.bearer);
    if (paths.length === 1) { writeFileSync(`${input.storeDir}/broken`, "owner-role store"); throw new Error("start failed"); }
    expect(existsSync(`${input.storeDir}/broken`)).toBe(false);
    return { currentView: emptyCurrentView(input), pull: async () => {}, close: async () => {} };
  });
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("failure"), maxRunning: 1,
    onError: (_, error) => errors.push(error), startChild });
  try {
    await supervisor.activate("w");
    expect(startChild).toHaveBeenCalledTimes(2);
    expect(new Set(paths).size).toBe(1);
    expect(new Set(bearers).size).toBe(2);
    expect(errors).toHaveLength(0);
  } finally { await supervisor.close(); }
});

it("reports failure after two fresh attempts and stops background retrying without holding capacity", async () => {
  const { storage, seed } = await fixture(); seed("second");
  const errors: unknown[] = [], paths: string[] = [];
  const startChild = vi.fn(async (input: ReplicaChildInput) => {
    if (input.lease.workspaceId === "w") { paths.push(input.storeDir); throw new Error("unrecoverable"); }
    return { currentView: emptyCurrentView(input), pull: async () => {}, close: async () => {} };
  });
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("failed"), maxRunning: 1,
    onError: (_, error) => errors.push(error), startChild });
  try {
    await expect(supervisor.activate("w")).rejects.toThrow("unrecoverable");
    await supervisor.settled("w");
    expect(paths).toHaveLength(2);
    expect(paths.every(path => !existsSync(path))).toBe(true);
    storage.appendLogBatch({ workspaceId: "w", originId: "o", ops: [{ originSeq: 0, opKind: "moment.append", payloadJson: "{}", recordedAtMs: 1 }] });
    await supervisor.settled("w");
    expect(paths).toHaveLength(2);
    expect(errors).toHaveLength(1);
    await supervisor.activate("second");
    await supervisor.evict("second");
    startChild.mockImplementationOnce(async input => ({ currentView: emptyCurrentView(input), pull: async () => {}, close: async () => {} }));
    await supervisor.activate("w");
    expect(errors).toHaveLength(1);
  } finally { await supervisor.close(); }
});

it("rebuilds after an unrecoverable first pull and waits for the old child to close", async () => {
  const { storage } = await fixture();
  const closed = vi.fn(async () => {});
  const startChild = vi.fn(async (input: ReplicaChildInput) => ({ currentView: emptyCurrentView(input), close: closed,
    pull: async () => { if (startChild.mock.calls.length === 1) throw new Error("first pull failed"); expect(closed).toHaveBeenCalledTimes(1); } }));
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("first-pull"), startChild });
  try { await supervisor.activate("w"); expect(startChild).toHaveBeenCalledTimes(2); }
  finally { await supervisor.close(); }
});

it("settles a pending append notification when shutdown cancels its drain", async () => {
  const { storage } = await fixture();
  const pull = vi.fn(async () => {}), close = vi.fn(async () => {});
  let storeDir = "";
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("drain-close"), startChild: async input => {
    storeDir = input.storeDir; return { currentView: emptyCurrentView(input), pull, close };
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
  expect(() => createReplicaSupervisor({ storage, storeRoot: "relative", startChild: async input => { throw Error(); } })).toThrow("absolute");
  expect(() => createReplicaSupervisor({ storage, storeRoot: "C:/private", maxRunning: 0, startChild: async input => { throw Error(); } })).toThrow("budget");
  if (process.platform !== "linux") expect(() => createReplicaEngineStarter({ engineExecutable: "C:/daemon.exe", baseUrl: "https://relay.test" })).toThrow("Linux");
});

it("sweeps stores from a prior process before admitting a child", async () => {
  const { storage } = await fixture(), root = await tempRoot("sweep");
  const stale = join(root, "replica-crashed"); mkdirSync(stale);
  writeFileSync(join(stale, "deleted-text-and-ciphertext"), "private bytes");
  const unrelated = join(root, "relay-data"); mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep"), "not a replica");
  const supervisor = createReplicaSupervisor({ storage, storeRoot: root, startChild: async input => {
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(unrelated, "keep"))).toBe(true);
    return { currentView: emptyCurrentView(input), pull: async () => {}, close: async () => {} };
  } });
  try { await supervisor.activate("w"); }
  finally { await supervisor.close().catch(() => {}); }
});

it.each(["close", "remove"])("releases capacity and reports a %s error during retirement", async stage => {
  const { storage, seed } = await fixture(); seed("second");
  let path = ""; const errors: unknown[] = [];
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("retire-failure"), maxRunning: 1,
    onError: (_, error) => errors.push(error), startChild: async input => {
      path = input.storeDir;
      return { currentView: emptyCurrentView(input), pull: async () => {}, close: async () => { if (stage === "close") throw Error("close failed"); } };
    } });
  try {
    await supervisor.activate("w");
    if (stage === "remove") fsFailure.path = path;
    await supervisor.evict("w");
    expect(errors.map(String)).toContain(stage === "close" ? "Error: close failed" : "Error: EPERM private store");
    expect(hasRelayWriteObservers(storage)).toBe(false);
    fsFailure.path = "";
    await supervisor.activate("second");
    await supervisor.evict("second");
    await supervisor.activate("w");
  } finally { fsFailure.path = ""; await supervisor.close().catch(() => {}); }
});

it("retires an idle dead child immediately and permits a new activation", async () => {
  const { storage } = await fixture(); const exited = deferred(); let path = "";
  const startChild = vi.fn(async (input: ReplicaChildInput) => {
    path = input.storeDir; return { currentView: emptyCurrentView(input), exited: exited.promise, pull: async () => {}, close: async () => {} };
  });
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("dead"), startChild });
  try {
    await supervisor.activate("w"); const first = path; exited.resolve();
    await expect.poll(() => existsSync(first)).toBe(false);
    await supervisor.settled("w");
    startChild.mockImplementation(async input => { path = input.storeDir; return { currentView: emptyCurrentView(input), exited: new Promise<void>(() => {}), pull: async () => {}, close: async () => {} }; });
    await supervisor.activate("w"); expect(startChild).toHaveBeenCalledTimes(2);
  } finally { await supervisor.close(); }
});

it("permits reactivation after a transient pull failure in a converged replica", async () => {
  const { storage } = await fixture(); let pulls = 0;
  const startChild = vi.fn(async (input: ReplicaChildInput) => ({ currentView: emptyCurrentView(input), close: async () => {}, pull: async () => { if (++pulls === 2) throw Error("deadline exceeded"); } }));
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("transient"), startChild });
  try {
    await supervisor.activate("w");
    storage.appendLogBatch({ workspaceId: "w", originId: "o", ops: [{ originSeq: 0, opKind: "moment.append", payloadJson: "{}", recordedAtMs: 1 }] });
    await supervisor.settled("w").catch(() => {});
    await supervisor.activate("w"); expect(startChild).toHaveBeenCalledTimes(2);
  } finally { await supervisor.close(); }
});

it("observes owner writes only while an entry is running", async () => {
  const { storage } = await fixture();
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("subscribe"), startChild: async input => ({ currentView: emptyCurrentView(input), pull: async () => {}, close: async () => {} }) });
  try {
    expect(hasRelayWriteObservers(storage)).toBe(false);
    await supervisor.activate("w"); expect(hasRelayWriteObservers(storage)).toBe(true);
    await supervisor.evict("w"); expect(hasRelayWriteObservers(storage)).toBe(false);
    await supervisor.activate("w"); expect(hasRelayWriteObservers(storage)).toBe(true);
  } finally { await supervisor.close(); }
});

it("reads standing once per idle entry in an owner-write batch", async () => {
  const { storage } = await fixture();
  const supervisor = createReplicaSupervisor({ storage, storeRoot: await tempRoot("standing"), startChild: async input => ({ currentView: emptyCurrentView(input), pull: async () => {}, close: async () => {} }) });
  try {
    await supervisor.activate("w");
    const read = vi.spyOn(storage, "readReplicaStanding");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    notifyRelayWrite(storage); await new Promise<void>(queueMicrotask); await vi.advanceTimersByTimeAsync(20);
    expect(read).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); await supervisor.close(); }
});

async function blobFixture() {
  const { storage } = await fixture();
  const shas = ["served", "not-served"].map(text => {
    const bytes = Buffer.from(text), sha256 = createHash("sha256").update(bytes).digest("hex");
    storage.putBlob({ workspaceId: "w", sha256, content: bytes, createdAtMs: 1 }); return sha256;
  });
  storage.appendLogBatch({ workspaceId: "w", originId: "o", ops: shas.map((sha, originSeq) => ({ originSeq,
    opKind: "moment.append", payloadJson: JSON.stringify({ payloadAfterBlobSha256: sha }), recordedAtMs: 1 })) });
  const principal = createReplicaReadPrincipal(storage), lease = principal.issue("w", "first");
  const read = (path: string, bearer = lease.bearer) => principal.handle(new Request(`https://relay.test/sync/w/${path}`, { headers: { authorization: `Bearer ${bearer}` } }));
  return { principal, lease, shas, read };
}

it("authorizes only blobs referenced by log rows served to this lease", async () => {
  const { shas, read } = await blobFixture();
  expect((await read(`blobs/${shas[0]}`)).status).toBe(404);
  expect((await read("log?replicationEpoch=epoch&streamIdentity=stream&limit=1")).status).toBe(200);
  expect((await read(`blobs/${shas[0]}`)).status).toBe(200);
  expect((await read(`blobs/${shas[1]}`)).status).toBe(404);
  expect((await read("log/o/1?replicationEpoch=epoch&streamIdentity=stream")).status).toBe(200);
  expect((await read(`blobs/${shas[1]}`)).status).toBe(200);
});

it("checks a served blob by set membership once per request", async () => {
  const { shas, read } = await blobFixture();
  await read("log?replicationEpoch=epoch&streamIdentity=stream");
  const has = vi.spyOn(Set.prototype, "has");
  expect((await read(`blobs/${shas[0]}`)).status).toBe(200);
  expect(has.mock.calls.filter(([value]) => value === shas[0])).toHaveLength(1);
});

it("does not transfer served blob authority to a replacement incarnation", async () => {
  const { principal, shas, read } = await blobFixture();
  await read("log?replicationEpoch=epoch&streamIdentity=stream");
  const replacement = principal.issue("w", "replacement");
  expect((await read(`blobs/${shas[0]}`, replacement.bearer)).status).toBe(404);
});
