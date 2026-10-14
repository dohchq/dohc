import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { createDatasetJournal, type DatasetCursor } from "@dohc/app-backend-runtime/journal";
import { createDatasetHost } from "@dohc/app-backend-runtime/dataset-host";
import { createDatasetSupervisor } from "@dohc/app-backend-runtime/supervisor";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { sharedViewHistory } from "./sharedViewHistory";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";
import { ListHistoryResult, type ListHistoryPayload, type TimelineEntry } from "../ipc/bridgeContract";
import { createHistoryTimeline, HISTORY_REMOTE_DEADLINE_MS, type TimelineReads } from "./historyTimeline";

const uuid = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
const label = (row: TimelineEntry) => row.kind === "file" ? row.moment.id : row.kind === "version" ? row.version.id : row.datasetId + ":" + row.change.revision;
async function fixture() {
  const root = await createTestScratch("history-merge-");
  const db = new DatabaseSync(":memory:");
  let transactions = 0;
  const transaction = <T,>(work: () => T): T => { transactions++; db.exec("BEGIN"); try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const journal = createDatasetJournal({ db, transaction });
  const supervisor = await createDatasetSupervisor({ journal, directory: root });
  cleanups.push(async () => { await supervisor.close(); db.close(); });
  const host = createDatasetHost({ db, transaction, journal, supervisor,
    resolveAuthority(_caller: string, request) { if (request.workspaceId !== "workspace") throw Error("wrong workspace"); return { principalKey: "owner", caller: { kind: "owner" as const, userId: "owner" } }; } });
  const heads = new Map<string, DatasetCursor>();
  const initialize = (n: number) => {
    const datasetId = uuid(n), hash = sha(datasetId), scope = { workspaceId: "workspace", datasetId };
    const cursor = journal.initialize({ scope, hostEpoch: "epoch", approvedRevisionHash: hash, source: "source", schemaSql: "schema",
      definitionJson: "{}", checkpoint: new Uint8Array([1]), authorize() {} });
    db.prepare("INSERT INTO dohc_dataset_catalog VALUES(?,?,?,?)").run("workspace", datasetId, JSON.stringify({ definition: { name: "Collection " + n } }), "{}");
    heads.set(datasetId, cursor); return datasetId;
  };
  const event = (datasetId: string, recordedAtMs: number) => {
    const expected = heads.get(datasetId)!, changeset = new Uint8Array([1]);
    const result = journal.commitOperation({ expected, proposalId: "proposal-" + expected.revision, operation: "Add record", callerKey: sha("owner"), idempotencyKey: "request-" + expected.revision, payloadSha256: sha("payload"),
      resultJson: '{"private":"undo receipt"}', changeset, changesetSha256: sha(changeset), attachedFileIds: [], recordedAtMs, authorize() {} });
    if (result.kind !== "committed") throw new Error("Expected a new journal event");
    heads.set(datasetId, result.event.cursor);
  };
  const schema = (datasetId: string) => {
    const expected = heads.get(datasetId)!;
    const next = journal.transitionCheckpoint({ expected, hostEpoch: expected.hostEpoch, approvedRevisionHash: sha("schema-" + expected.revision),
      source: "source", schemaSql: "schema", definitionJson: "{}", checkpoint: new Uint8Array([1]), authorize() {} });
    heads.set(datasetId, next);
    db.prepare("DELETE FROM dohc_dataset_checkpoint_times WHERE workspace_id=? AND dataset_id=? AND revision=?").run("workspace", datasetId, next.revision);
  };
  let clock = 1;
  const sessions = mockLiveSessions(new VersionedLoopbackEngine(), undefined, undefined, request => {
    if (request.method === "versionedText.write") (request.params as Record<string, unknown>).nowMs = clock;
  });
  const store = createCaptureLiveStores({ workspaceId: "workspace", rootPath: root, attachmentId: Symbol() }, sessions).store;
  await store.ensureMainVersion({ workspaceId: "workspace" });
  const write = async (id: string, time: number, path = "notes.md") => { clock = time; return store.writeTextFile({ workspaceId: "workspace", versionId: "main", path, text: id, momentId: id, metadata: { origin: "api" } }); };
  const signal = new AbortController();
  const local: TimelineReads["local"] = (positions, limit) => ({ pages: host.historyHeads("owner", { workspaceId: "workspace", positions, limit }), transferred: [] });
  const reads: TimelineReads = { scope: "test", signal: signal.signal, assertCurrent() {}, engine: sharedViewHistory(store, "workspace"), local,
    remote: async () => { throw new Error("unexpected remote"); }, names: { agent: () => undefined, person: () => undefined, automation: () => null, named: a => a.userId } };
  const list = createHistoryTimeline();
  const page = async (input: Partial<ListHistoryPayload> = {}) => {
    const result = ListHistoryResult.parse(await list({ workspaceId: "workspace", ...input }, reads));
    if (!("entries" in result)) throw new Error("Expected ready History");
    return result;
  };
  return { db, journal, host, heads, initialize, event, schema, reads, page, write, signal, transactions: () => transactions };
}

it("merges file and Collection streams with deterministic equal-time order and one metadata transaction", async () => {
  const f = await fixture(), a = f.initialize(1), b = f.initialize(2);
  f.event(a, 400); f.event(a, 600); f.event(b, 600); await f.write("file", 500);
  const before = f.transactions(), prepare = vi.spyOn(f.db, "prepare");
  const first = await f.page({ limit: 4 });
  expect(first.entries.map(label)).toEqual([a + ":2", b + ":1", "file", a + ":1"]);
  expect(f.transactions() - before).toBe(2);
  expect(prepare.mock.calls.every(([sql]) => !String(sql).includes("e.result_json"))).toBe(true);
  expect(JSON.stringify(first)).not.toContain("undo receipt");
});

it("carries only emitted positions across pages and excludes concurrent old-dated arrivals", async () => {
  const f = await fixture(), a = f.initialize(1);
  for (const t of [100, 300, 500]) f.event(a, t);
  for (const [id, t] of [["file-high", 600], ["file-low", 200]] as const) await f.write(id, t);
  const first = await f.page({ limit: 2 });
  f.event(a, 50); await f.write("old-sync", 50);
  const all = [...first.entries]; let cursor = first.nextCursor;
  while (cursor) { const next = await f.page({ limit: 2, cursor }); all.push(...next.entries); cursor = next.nextCursor; }
  expect(all.filter(row => row.kind !== "version").map(label)).toEqual(["file-high", a + ":3", a + ":2", "file-low", a + ":1"]);
  expect(new Set(all.map(label)).size).toBe(all.length);
  const refresh = await f.page(); expect(refresh.entries.map(label)).toContain(a + ":4"); expect(refresh.entries.map(label)).toContain("old-sync");
});

it("places an undated schema beside its newer neighbour across a page boundary", async () => {
  const f = await fixture(), a = f.initialize(1);
  f.event(a, 300); f.schema(a); f.event(a, 500); await f.write("file", 450);
  const first = await f.page({ limit: 1 });
  expect(first.entries.map(label)).toEqual([a + ":3"]);
  const second = await f.page({ limit: 1, cursor: first.nextCursor! });
  expect(second.entries[0]).toMatchObject({ kind: "collection", sortAtMs: 500, change: { revision: 2, recordedAtMs: null } });
  f.schema(a);
  expect((await f.page({ limit: 1 })).entries[0]).toMatchObject({ sortAtMs: 500, change: { revision: 4, recordedAtMs: null } });
});

it("fixes the source set and drops a deleted Collection without shifting other positions", async () => {
  const f = await fixture(), a = f.initialize(1), b = f.initialize(2);
  f.event(a, 200); f.event(a, 600); f.event(b, 100); f.event(b, 500);
  const first = await f.page({ limit: 1 });
  const c = f.initialize(3); f.event(c, 700);
  f.db.prepare("DELETE FROM dohc_dataset_catalog WHERE dataset_id=?").run(a);
  const second = await f.page({ cursor: first.nextCursor! });
  expect(second.entries.filter(row => row.kind === "collection").map(label)).toEqual([b + ":2", b + ":1"]);
  expect((await f.page()).entries.map(label)).toContain(c + ":1");
});

it("excludes a deadline source for the rest of the chain and recovers only on refresh", async () => {
  const f = await fixture(), a = f.initialize(1), remote = uuid(8), started = deferred<void>();
  f.event(a, 100); f.event(a, 500);
  f.reads.local = (positions, limit) => ({ pages: f.host.historyHeads("owner", { workspaceId: "workspace", positions, limit }), transferred: [remote] });
  const remoteRead = vi.fn<TimelineReads["remote"]>(async (_id, _before, signal) => {
    started.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  f.reads.remote = remoteRead;
  vi.useFakeTimers();
  const pending = f.page({ limit: 1 }); await started.promise;
  await vi.advanceTimersByTimeAsync(HISTORY_REMOTE_DEADLINE_MS);
  const first = await pending;
  expect(first).toMatchObject({ completeness: "partial", unavailableSources: [{ datasetId: remote, reason: "deadline" }] });
  const next = await f.page({ cursor: first.nextCursor!, limit: 1 });
  expect(next.unavailableSources).toEqual(first.unavailableSources); expect(remoteRead).toHaveBeenCalledTimes(1);
  remoteRead.mockResolvedValue({ datasetId: remote, headRevision: 1, lineage: sha("remote"), olderRecordedAtMs: 700,
    entries: [{ revision: 1, operation: "Add record", recordedAtMs: 700, callerReference: null, approvedRevisionHash: sha("approved"), changesetBytes: 0, attachmentCount: 0 }], nextBeforeRevision: null });
  expect((await f.page({ limit: 1 })).entries.map(label)).toEqual([remote + ":1"]);
});

it("prefetches one remote page ahead and permanently excludes a later deadline", async () => {
  const f = await fixture(), remote = uuid(8), ahead = deferred<void>();
  f.reads.local = () => ({ pages: [], transferred: [remote] });
  f.reads.remote = vi.fn(async (_id, before, signal) => {
    if (before !== undefined) { ahead.resolve(); return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
    return { datasetId: remote, headRevision: 2, lineage: sha("remote"), olderRecordedAtMs: 600,
      entries: [{ revision: 2, operation: "Add record", recordedAtMs: 600, callerReference: null, approvedRevisionHash: sha("approved"), changesetBytes: 0, attachmentCount: 0 }], nextBeforeRevision: 2 };
  });
  vi.useFakeTimers(); const first = await f.page({ limit: 1 }); await ahead.promise;
  expect(f.reads.remote).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(HISTORY_REMOTE_DEADLINE_MS);
  const second = await f.page({ cursor: first.nextCursor! });
  expect(second).toMatchObject({ completeness: "partial", unavailableSources: [{ datasetId: remote, reason: "deadline" }] });
});

it("rejects a stale workspace reply after an asynchronous source returns", async () => {
  const f = await fixture(), entered = deferred<void>(), reply = deferred<Awaited<ReturnType<TimelineReads["remote"]>>>();
  f.reads.local = () => ({ pages: [], transferred: [uuid(8)] });
  f.reads.remote = async () => { entered.resolve(); return reply.promise; };
  let current = true; f.reads.assertCurrent = () => { if (!current) throw new Error("workspace changed"); };
  const pending = expect(f.page()).rejects.toThrow("workspace changed"); await entered.promise; current = false;
  reply.resolve({ datasetId: uuid(8), headRevision: 0, lineage: sha("remote"), entries: [], nextBeforeRevision: null }); await pending;
});

it("matches cursor scope and invalidates replacement lineage", async () => {
  const f = await fixture(), a = f.initialize(1); f.event(a, 100); f.event(a, 500);
  const first = await f.page({ limit: 1 });
  await expect(f.page({ versionId: "other", cursor: first.nextCursor! })).rejects.toThrow("scope changed");
  await expect(f.page({ object: { kind: "dataset", datasetId: a }, cursor: first.nextCursor! })).rejects.toThrow("scope changed");
  f.db.prepare("UPDATE dohc_dataset_journals SET checkpoint_digest=? WHERE dataset_id=? AND checkpoint_revision=0").run(sha("replaced"), a);
  await expect(f.page({ cursor: first.nextCursor! })).rejects.toThrow("lineage changed");
});

it("keeps version marker ties in the engine cursor's descending ID order", async () => {
  const f = await fixture();
  const base = await f.reads.engine.listMoments({ limit: 50 });
  const markers = ["a", "b"].map(id => ({ id, kind: "named" as const, name: id, workspaceId: "workspace", createdAtMs: 500 }));
  f.reads.engine = { listMoments: async input => {
    const available = markers.filter(marker => !input?.cursor?.marker || marker.id < input.cursor.marker.versionId);
    return { ...base, moments: [], versionMarkers: available, startCursor: input?.cursor ?? base.startCursor, nextCursor: null };
  } };
  const first = await f.page({ limit: 1 });
  expect(first.entries.map(label)).toEqual(["b"]);
  const second = await f.page({ limit: 1, cursor: first.nextCursor! });
  expect(second.entries.map(label)).toEqual(["a"]);
  expect(second.nextCursor).toBeNull();
});

it("makes progress through byte-cut pages without dropping unconsumed positions", async () => {
  const f = await fixture(), a = f.initialize(1);
  f.db.prepare("UPDATE dohc_dataset_catalog SET revision_json=? WHERE dataset_id=?").run(JSON.stringify({ definition: { name: "x".repeat(6000) } }), a);
  for (let n = 1; n <= 70; n++) f.event(a, n);
  const seen: number[] = [];
  let cursor: import("../ipc/bridgeContract").TimelineCursor | undefined;
  do {
    const result = await f.page({ object: { kind: "dataset", datasetId: a }, cursor });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256 * 1024);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.length).toBeLessThan(50);
    seen.push(...result.entries.flatMap(row => row.kind === "collection" ? [row.change.revision] : []));
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(Array.from({ length: 70 }, (_, n) => 70 - n));
});
