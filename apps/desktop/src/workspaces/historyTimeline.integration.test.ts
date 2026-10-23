import { readDatasetHistoryHeads } from "@dohc/app-backend-runtime/dataset-history";
import { createHash } from "node:crypto";
import { createWorkspaceAuthorityOwner, type WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import { createHistoryCollectionRemote, serverHistorySources } from "./historyCollectionRemote";
import { createRemoteDatasetData, type OwnerDatasetData } from "./remoteDataset";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
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
import { neutralHistoryPresentations } from "../testing/historyPageFixture";
import { HISTORY_MAX_SOURCES, HISTORY_CURSOR_BYTES, TimelineCursor, ListHistoryResult, type ListHistoryPayload, type TimelineEntry } from "../ipc/bridgeContract";
import { RELAY_FETCH_TIMEOUT_MS } from "./sharedChannels";
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
  const supervisor = await createDatasetSupervisor({ journal, directory: async () => root });
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
  const local: TimelineReads["local"] = (positions, limit) => {
    const pages = transaction(() => readDatasetHistoryHeads(db, { workspaceId: "workspace", positions, limit }));
    return { pages, sourceIds: pages.map(page => page.datasetId), transferred: [],
      sourceCount: Number(db.prepare("SELECT count(*) AS count FROM dohc_dataset_catalog WHERE workspace_id=?").get("workspace")?.count) };
  };
  const reads: TimelineReads = { scope: "test", signal: signal.signal, assertCurrent() {}, engine: sharedViewHistory(store, "workspace"), local,
    remote: async () => { throw new Error("unexpected remote"); }, names: { agent: () => undefined, person: () => undefined, automation: () => null, named: a => a.userId, presentations: neutralHistoryPresentations } };
  const list = createHistoryTimeline();
  const page = async (input: Partial<ListHistoryPayload> = {}) => {
    const result = ListHistoryResult.parse(await list({ workspaceId: "workspace", ...input }, reads));
    if (!("entries" in result)) throw new Error("Expected ready History");
    return result;
  };
  return { db, journal, host, heads, initialize, event, schema, reads, page, write, signal, transactions: () => transactions,
    headsPage: (input: Parameters<typeof readDatasetHistoryHeads>[1]) => transaction(() => readDatasetHistoryHeads(db, input)) };
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
  f.reads.local = (positions, limit) => ({ pages: f.headsPage({ workspaceId: "workspace", positions, limit }), transferred: [remote], sourceIds: [a, remote], sourceCount: 2 });
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

it("prefetches the final emitted position with real 51-entry remote pages", async () => {
  const f = await fixture(), remote = f.initialize(8);
  for (let t = 1; t <= 120; t++) f.event(remote, t);
  f.reads.local = () => ({ pages: [], transferred: [remote], sourceIds: [remote], sourceCount: 1 });
  f.reads.remote = vi.fn(async (_id, before) => f.host.history("owner", { workspaceId: "workspace", datasetId: remote, beforeRevision: before, limit: 51, metadataOnly: true }));
  const first = await f.page({ object: { kind: "dataset", datasetId: remote } });
  expect(first.entries).toHaveLength(50);
  expect(f.reads.remote).toHaveBeenNthCalledWith(2, remote, 71, expect.any(AbortSignal));
  const second = await f.page({ object: { kind: "dataset", datasetId: remote }, cursor: first.nextCursor! });
  expect(second.entries.map(label)).toEqual(Array.from({ length: 50 }, (_, n) => remote + ":" + (70 - n)));
  expect(f.reads.remote).toHaveBeenCalledTimes(3);
  expect(f.reads.remote).toHaveBeenNthCalledWith(3, remote, 21, expect.any(AbortSignal));
});

it("starts a prefetched source's deadline when a page waits, not during idle time", async () => {
  const f = await fixture(), remote = f.initialize(8), entered = deferred<void>();
  for (let t = 1; t <= 120; t++) f.event(remote, t);
  f.reads.local = () => ({ pages: [], transferred: [remote], sourceIds: [remote], sourceCount: 1 });
  const background = deferred<Awaited<ReturnType<TimelineReads["remote"]>>>();
  f.reads.remote = vi.fn(async (_id, before) => {
    if (before !== 71) return f.host.history("owner", { workspaceId: "workspace", datasetId: remote, beforeRevision: before, limit: 51, metadataOnly: true });
    entered.resolve(); return background.promise;
  });
  vi.useFakeTimers();
  const first = await f.page({ object: { kind: "dataset", datasetId: remote } }); await entered.promise;
  await vi.advanceTimersByTimeAsync(2 * HISTORY_REMOTE_DEADLINE_MS);
  let returned = false;
  const waiting = f.page({ object: { kind: "dataset", datasetId: remote }, cursor: first.nextCursor! }).then(page => { returned = true; return page; });
  await vi.advanceTimersByTimeAsync(HISTORY_REMOTE_DEADLINE_MS - 1); expect(returned).toBe(false);
  background.resolve(f.host.history("owner", { workspaceId: "workspace", datasetId: remote, beforeRevision: 71, limit: 51, metadataOnly: true }));
  const second = await waiting;
  expect(second.completeness).toBe("complete"); expect(second.entries).toHaveLength(50);
});

it("rejects a stale workspace reply after an asynchronous source returns", async () => {
  const f = await fixture(), entered = deferred<void>(), reply = deferred<Awaited<ReturnType<TimelineReads["remote"]>>>();
  f.reads.local = () => ({ pages: [], transferred: [uuid(8)], sourceIds: [uuid(8)], sourceCount: 1 });
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

it("keeps file rows before Collection rows at the same timestamp", async () => {
  const f = await fixture(), a = f.initialize(1); f.event(a, 500); await f.write("file", 500);
  expect((await f.page({ limit: 2 })).entries.map(label)).toEqual(["file", a + ":1"]);
});

it("prunes an older Collection before reading heads on later file pages", async () => {
  const f = await fixture(), a = f.initialize(1); f.event(a, 1);
  for (let n = 0; n < 100; n++) await f.write("file-" + n, 1000 + n);
  const local = vi.fn(f.reads.local); f.reads.local = local;
  let before = f.transactions();
  const first = await f.page();
  expect(first.entries.every(row => row.kind === "file")).toBe(true);
  expect(local).toHaveBeenCalledTimes(1); expect(f.transactions() - before).toBe(1);
  local.mockClear(); before = f.transactions();
  const second = await f.page({ cursor: first.nextCursor! });
  expect(second.entries.every(row => row.kind === "file")).toBe(true);
  expect(local).toHaveBeenCalledExactlyOnceWith([], 1, [a]); expect(f.transactions() - before).toBe(1);
});

it("discloses a local Collection transferred between pages instead of declaring it finished", async () => {
  const f = await fixture(), a = f.initialize(1), b = f.initialize(2);
  f.event(a, 600); f.event(a, 500); f.event(b, 400);
  const first = await f.page({ limit: 1 });
  f.reads.local = (positions, limit) => ({ transferred: [a], sourceIds: [a, b], sourceCount: 2, pages: f.headsPage({ workspaceId: "workspace", positions, limit, skip: [a] }) });
  const next = await f.page({ cursor: first.nextCursor! });
  expect(next).toMatchObject({ completeness: "partial", unavailableSources: [{ datasetId: a, reason: "unavailable" }] });
  expect(next.entries.map(label)).not.toContain(a + ":1");
});

it("removes finished sources and discloses the bounded source set", async () => {
  const f = await fixture();
  for (let n = 1; n <= HISTORY_MAX_SOURCES + 5; n++) { const id = f.initialize(n); f.event(id, n); }
  await f.write("file", 1000);
  const first = await f.page();
  expect(first).toMatchObject({ completeness: "partial", omittedSources: 5 });
  expect(first.entries[0]).toMatchObject({ kind: "file" });
  expect(first.nextCursor!.collections).toHaveLength(HISTORY_MAX_SOURCES - 49);
  expect(first.nextCursor!.collections.every(s => !s.done)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(first.nextCursor))).toBeLessThanOrEqual(HISTORY_CURSOR_BYTES);
  const next = await f.page({ cursor: first.nextCursor! }); expect(next.omittedSources).toBe(5);
});

it("rejects duplicate, oversized, malformed-lineage, and mixed-version cursors before remote reads", async () => {
  const f = await fixture(), a = f.initialize(1); f.event(a, 1); f.event(a, 2);
  const first = await f.page({ limit: 1 }), cursor = first.nextCursor!, source = cursor.collections[0]!;
  const remote = vi.fn(f.reads.remote); f.reads.remote = remote;
  const invalid = [
    { ...cursor, collections: [source, source] },
    { ...cursor, collections: Array.from({ length: HISTORY_MAX_SOURCES + 1 }, (_, n) => ({ ...source, datasetId: uuid(n + 1) })) },
    { ...cursor, collections: [{ ...source, lineage: "not-a-sha" }] },
    { ...cursor, engine: { ...cursor.engine!, engineUuid: "x".repeat(HISTORY_CURSOR_BYTES) } },
    { ...cursor, engine: { ...cursor.engine!, versionId: "branch" } },
    { ...cursor, versionId: "branch", engine: { ...cursor.engine!, versionId: "branch" } },
  ];
  for (const value of invalid) {
    expect(TimelineCursor.safeParse(value).success).toBe(false);
    await expect(f.page({ cursor: value })).rejects.toThrow();
  }
  expect(remote).not.toHaveBeenCalled();
});

it("caps remote concurrency and does not refetch a cached head outside the window", async () => {
  const f = await fixture(), ids = Array.from({ length: 6 }, (_, n) => uuid(n + 8)), reached = deferred<void>(), release = deferred<void>();
  f.reads.local = () => ({ pages: [], transferred: ids, sourceIds: ids, sourceCount: ids.length });
  let active = 0, maximum = 0, started = 0;
  f.reads.remote = vi.fn(async id => {
    active++; maximum = Math.max(maximum, active); if (++started === 4) reached.resolve();
    await release.promise; active--;
    return { datasetId: id, lineage: sha(id), headRevision: 1, entries: [{ revision: 1, recordedAtMs: 10, operation: "Add record", callerReference: null, approvedRevisionHash: sha("approved"), changesetBytes: 0, attachmentCount: 0 }], nextBeforeRevision: null };
  });
  const waiting = f.page(); await reached.promise; expect(started).toBe(4); release.resolve(); await waiting;
  expect(maximum).toBe(4); expect(started).toBe(6);

  const g = await fixture(), remote = g.initialize(8); g.event(remote, 1);
  for (let n = 0; n < 100; n++) await g.write("file-" + n, 1000 + n);
  g.reads.local = () => ({ pages: [], transferred: [remote], sourceIds: [remote], sourceCount: 1 });
  const read = vi.fn(async () => g.host.history("owner", { workspaceId: "workspace", datasetId: remote, limit: 51, metadataOnly: true })); g.reads.remote = read;
  const first = await g.page(); expect(read).toHaveBeenCalledOnce();
  const second = await g.page({ cursor: first.nextCursor! });
  expect(second.entries.every(row => row.kind === "file")).toBe(true); expect(read).toHaveBeenCalledOnce();
});

it("drops a confirmed deleted remote Collection without leaving pages partial", async () => {
  const f = await fixture(), remote = f.initialize(8); f.event(remote, 600); f.event(remote, 500);
  f.reads.local = () => ({ pages: [], transferred: [remote], sourceIds: [remote], sourceCount: 1 });
  const reply = deferred<Awaited<ReturnType<TimelineReads["remote"]>>>();
  f.reads.remote = async (_id, before) => before === undefined ? f.host.history("owner", { workspaceId: "workspace", datasetId: remote, limit: 51, metadataOnly: true }) : reply.promise;
  const first = await f.page({ object: { kind: "dataset", datasetId: remote }, limit: 1 });
  reply.resolve({ datasetId: remote, headRevision: 0, entries: [], nextBeforeRevision: null, deleted: true });
  const next = await f.page({ object: { kind: "dataset", datasetId: remote }, cursor: first.nextCursor! });
  expect(next).toMatchObject({ completeness: "complete", unavailableSources: [], entries: [], nextCursor: null });
});

it("returns updating when a refill engine read refuses", async () => {
  const f = await fixture(); await f.write("hidden", 100, "private/a.md");
  const base = await f.reads.engine.listMoments();
  const read = vi.fn<TimelineReads["engine"]["listMoments"]>();
  read.mockResolvedValueOnce({ ...base, versionMarkers: [], nextCursor: base.startCursor });
  read.mockRejectedValueOnce({ wireError: { code: "OVERLOADED", message: "History is still updating. Try again." } });
  f.reads.engine = { listMoments: read }; f.reads.admitted = () => false;
  expect(await createHistoryTimeline()({ workspaceId: "workspace" }, f.reads)).toEqual({ status: "updating" });
});

it("emits protected-only pages even when every file path is hidden", async () => {
  const f = await fixture(); await f.write("protected", 100, "private/a.md");
  const base = await f.reads.engine.listMoments();
  f.reads.engine = { listMoments: async () => ({ ...base, versionMarkers: [], moments: base.moments.map(m => ({ ...m, protected: true })), nextCursor: null }) };
  f.reads.admitted = () => false;
  const page = await f.page(); expect(page.entries).toHaveLength(1); expect(page.entries[0]).toMatchObject({ kind: "file", moment: { protected: true } });
});

it("stops after 40 engine pages of hidden rows and carries the exact continuation", async () => {
  const f = await fixture(); await f.write("hidden", 100, "private/a.md");
  const base = await f.reads.engine.listMoments();
  let count = 0;
  const read = vi.fn<TimelineReads["engine"]["listMoments"]>(async input => {
    count++;
    const next = { ...base.startCursor, text: { recordedAtMs: 100, momentOrder: count * 50 } };
    return { ...base, versionMarkers: [], startCursor: input?.cursor ?? base.startCursor,
      moments: Array.from({ length: 50 }, (_, n) => ({ ...base.moments[0]!, id: "hidden-" + count + "-" + n, momentOrder: (count - 1) * 50 + n + 1 })), nextCursor: next };
  });
  f.reads.engine = { listMoments: read }; f.reads.admitted = () => false;
  const page = await f.page(); expect(page.entries).toEqual([]); expect(read).toHaveBeenCalledTimes(40);
  expect(page.nextCursor!.engine!.text!.momentOrder).toBe(2000);
  f.reads.admitted = () => true; const next = await f.page({ cursor: page.nextCursor!, limit: 1 });
  expect(next.entries).toHaveLength(1); expect(read.mock.calls[40]![0]?.cursor).toEqual(page.nextCursor!.engine);
});

it("finishes a prefetched read under its own real authority lease after the page lease releases", async () => {
  const f = await fixture(), remote = f.initialize(8);
  for (let n = 1; n <= 120; n++) f.event(remote, n);
  f.reads.local = () => ({ pages: [], transferred: [remote], sourceIds: [remote], sourceCount: 1 });
  const workspace = { workspaceId: "workspace", rootPath: "root" }, state = {};
  const owner = createWorkspaceAuthorityOwner({ findWorkspace: () => workspace, canonicalizeRoot: path => path, createState: () => state });
  cleanups.push(() => owner.close());
  const entered = deferred<void>(), reply = deferred<void>();
  const history = vi.fn<OwnerDatasetData["history"]>(async input => {
    if (input.beforeRevision === 71) { entered.resolve(); await reply.promise; }
    return f.host.history("owner", { workspaceId: "workspace", ...input });
  });
  const describe = vi.fn();
  const data = { history, describe } as unknown as OwnerDatasetData;
  let released: WorkspaceAuthorityOperation<typeof workspace, object> | undefined;
  const list = createHistoryTimeline();
  const owned = (cursor?: import("../ipc/bridgeContract").TimelineCursor) => owner.withOperation("workspace", async operation => {
    released ??= operation;
    f.reads.remote = createHistoryCollectionRemote({ expected: operation, generation: 1, currentGeneration: () => 1,
      withOperation: work => owner.withOperation("workspace", work), dataFor: () => data });
    return list({ workspaceId: "workspace", object: { kind: "dataset", datasetId: remote }, cursor }, { ...f.reads, signal: operation.signal, assertCurrent: operation.assertCurrent });
  });
  const first = await owned(); await entered.promise;
  try {
    expect(() => released!.assertCurrent()).toThrow("This operation ended. Try again.");
  } finally {
    reply.resolve();
  }
  const second = await owned("nextCursor" in first ? first.nextCursor! : undefined);
  expect(second).toMatchObject({ status: "ready", completeness: "complete" });
  if (!("entries" in second)) throw Error("Expected ready");
  expect(second.entries).toHaveLength(50); expect(history).toHaveBeenCalledTimes(3); expect(describe).not.toHaveBeenCalled();
});

it("confirms deletion through the owner route and keeps other failures partial", async () => {
  const operation = { state: {}, workspace: { attachmentId: Symbol() }, signal: new AbortController().signal, assertCurrent() {} };
  const deleted = vi.fn(async () => ({ deleted: true }));
  const data = { history: async () => { throw Error("not available"); }, deletionStatus: deleted } as unknown as OwnerDatasetData;
  const read = createHistoryCollectionRemote({ expected: operation, generation: 1, currentGeneration: () => 1,
    withOperation: work => work(operation), dataFor: () => data });
  await expect(read(uuid(8), 2, operation.signal)).resolves.toMatchObject({ deleted: true });
  deleted.mockResolvedValue({ deleted: false });
  await expect(read(uuid(8), 2, operation.signal)).rejects.toThrow("not available");
});

it("discloses an empty single-Collection deadline result and requires refresh", async () => {
  const f = await fixture(), remote = uuid(8), entered = deferred<void>();
  f.reads.local = () => ({ pages: [], transferred: [remote], sourceIds: [remote], sourceCount: 1 });
  f.reads.remote = async (_id, _before, signal) => { entered.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
  vi.useFakeTimers(); const waiting = f.page({ object: { kind: "dataset", datasetId: remote } }); await entered.promise;
  await vi.advanceTimersByTimeAsync(HISTORY_REMOTE_DEADLINE_MS);
  expect(await waiting).toMatchObject({ entries: [], nextCursor: null, completeness: "partial", unavailableSources: [{ datasetId: remote, reason: "deadline" }] });
});

it("excludes a later prefetched source only after a page has waited 750 ms", async () => {
  const f = await fixture(), remote = f.initialize(8), entered = deferred<AbortSignal>();
  for (let n = 1; n <= 120; n++) f.event(remote, n);
  f.reads.local = () => ({ pages: [], transferred: [remote], sourceIds: [remote], sourceCount: 1 });
  f.reads.remote = async (_id, before, signal) => {
    if (before === undefined) return f.host.history("owner", { workspaceId: "workspace", datasetId: remote, metadataOnly: true, limit: 51 });
    entered.resolve(signal); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  vi.useFakeTimers();
  const first = await f.page({ object: { kind: "dataset", datasetId: remote } }), backgroundSignal = await entered.promise;
  await vi.advanceTimersByTimeAsync(HISTORY_REMOTE_DEADLINE_MS * 2); expect(backgroundSignal.aborted).toBe(false);
  const waiting = f.page({ object: { kind: "dataset", datasetId: remote }, cursor: first.nextCursor! });
  await vi.advanceTimersByTimeAsync(HISTORY_REMOTE_DEADLINE_MS);
  expect(await waiting).toMatchObject({ entries: [], nextCursor: null, completeness: "partial", unavailableSources: [{ datasetId: remote, reason: "deadline" }] });
  expect(backgroundSignal.aborted).toBe(true);
});

const remoteReply = (datasetId: string, revisions = [2, 1]) => ({
  datasetId, name: "Current name", lineage: sha(datasetId), headRevision: 2,
  entries: revisions.map(revision => ({ revision, recordedAtMs: revision === 2 ? 1000 : 1,
    operation: "Add record", callerReference: null, approvedRevisionHash: sha("approved"), changesetBytes: 0, attachmentCount: 0 })),
  nextBeforeRevision: null,
});

it("starts each foreground deadline after its slot, including later page-one sources", async () => {
  const f = await fixture(), ids = Array.from({ length: 12 }, (_, n) => uuid(n + 8)), entered = deferred<void>();
  f.reads.local = () => ({ pages: [], transferred: ids, sourceIds: ids, sourceCount: ids.length });
  let started = 0;
  f.reads.remote = async id => {
    if (++started === 4) entered.resolve();
    await new Promise(resolve => setTimeout(resolve, 400));
    return remoteReply(id, [1]);
  };
  vi.useFakeTimers();
  const waiting = f.page(); await entered.promise;
  await vi.advanceTimersByTimeAsync(1200);
  const page = await waiting;
  expect(started).toBe(12); expect(page.unavailableSources).toEqual([]);
  expect(page.entries.filter(row => row.kind === "collection")).toHaveLength(12);
});

it("bounds a dead relay page after its first deadline and discloses queued sources", async () => {
  const f = await fixture(), ids = Array.from({ length: 12 }, (_, n) => uuid(n + 8)), entered = deferred<void>();
  await f.write("file", 500);
  f.reads.local = () => ({ pages: [], transferred: ids, sourceIds: ids, sourceCount: ids.length });
  const signals: AbortSignal[] = [];
  f.reads.remote = vi.fn<TimelineReads["remote"]>(async (_id, _before, signal) => {
    signals.push(signal); if (signals.length === 4) entered.resolve();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  vi.useFakeTimers();
  const start = Date.now(); let returned = false;
  const waiting = f.page().then(page => { returned = true; return page; }); await entered.promise;
  await vi.advanceTimersByTimeAsync(HISTORY_REMOTE_DEADLINE_MS - 1); expect(returned).toBe(false);
  await vi.advanceTimersByTimeAsync(HISTORY_REMOTE_DEADLINE_MS + 1);
  expect(returned).toBe(true);
  const page = await waiting;
  expect(Date.now() - start).toBeLessThanOrEqual(2 * HISTORY_REMOTE_DEADLINE_MS);
  expect(signals.length).toBeLessThan(ids.length);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(page.entries.map(label)).toContain("file");
  expect(page.completeness).toBe("partial");
  expect(page.unavailableSources).toEqual(ids.map(datasetId => ({ datasetId, reason: "deadline" })));
  f.reads.remote = vi.fn(async id => remoteReply(id, [1]));
  expect((await f.page()).unavailableSources).toEqual([]);
  expect(f.reads.remote).toHaveBeenCalledTimes(ids.length);
});

it("promotes queued prefetches ahead of background work without excluding foreground sources", async () => {
  const f = await fixture(), ids = Array.from({ length: 8 }, (_, n) => uuid(n + 8)), entered = deferred<void>();
  f.reads.local = () => ({ pages: [], transferred: ids, sourceIds: ids, sourceCount: ids.length });
  let background = true;
  const starts: string[] = [];
  f.reads.remote = async (id, before) => {
    if (before === undefined) return remoteReply(id);
    starts.push(background ? "background" : "foreground");
    if (background) entered.resolve();
    await new Promise(resolve => setTimeout(resolve, background ? 500 : 400));
    return remoteReply(id, [1]);
  };
  vi.useFakeTimers();
  const first = await f.page({ limit: 8 }); await entered.promise;
  expect(starts).toEqual(["background"]);
  background = false;
  const waiting = f.page({ cursor: first.nextCursor! });
  await vi.advanceTimersByTimeAsync(1200);
  const page = await waiting;
  expect(starts).toEqual(["background", ...Array(7).fill("foreground")]);
  expect(page.unavailableSources).toEqual([]);
  expect(page.entries.filter(row => row.kind === "collection")).toHaveLength(8);
});

it("aborts a hung background read after the relay timeout and frees its slot", async () => {
  const f = await fixture(), ids = [uuid(8), uuid(9)], entered = deferred<AbortSignal>(), second = vi.fn();
  f.reads.local = () => ({ pages: [], transferred: ids, sourceIds: ids, sourceCount: ids.length });
  f.reads.remote = async (id, before, signal) => {
    if (before === undefined) return remoteReply(id);
    if (id === ids[0]) {
      entered.resolve(signal);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    second(); return remoteReply(id, [1]);
  };
  vi.useFakeTimers();
  await f.page({ limit: 2 }); const signal = await entered.promise;
  await vi.advanceTimersByTimeAsync(RELAY_FETCH_TIMEOUT_MS - 1);
  expect(signal.aborted).toBe(false); expect(second).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true); expect(second).toHaveBeenCalledOnce();
});

it("gives another workspace its own slots while four foreground reads wait", async () => {
  const f = await fixture(), ids = Array.from({ length: 4 }, (_, n) => uuid(n + 8)), entered = deferred<void>(), release = deferred<void>();
  const list = createHistoryTimeline();
  f.reads.local = () => ({ pages: [], transferred: ids, sourceIds: ids, sourceCount: ids.length });
  let started = 0;
  f.reads.remote = async id => { if (++started === 4) entered.resolve(); await release.promise; return remoteReply(id, [1]); };
  const waiting = list({ workspaceId: "workspace" }, f.reads); await entered.promise;
  const remote = vi.fn(async id => remoteReply(id, [1]));
  const other = await list({ workspaceId: "second-workspace", object: { kind: "dataset", datasetId: ids[0]! } },
    { ...f.reads, scope: "other-workspace-attachment", remote });
  expect(other).toMatchObject({ status: "ready", completeness: "complete" });
  expect(remote).toHaveBeenCalledOnce(); release.resolve(); await waiting;
});

it("retries a rejected idle prefetch once in the foreground and uses its current name", async () => {
  const f = await fixture(), remote = uuid(8), failed = deferred<void>();
  f.reads.local = () => ({ pages: [], transferred: [remote], sourceIds: [remote], sourceCount: 1 });
  let attempts = 0;
  f.reads.remote = vi.fn(async id => {
    if (++attempts === 1) return remoteReply(id);
    if (attempts === 2) { failed.resolve(); throw Error("temporary 503"); }
    return { ...remoteReply(id, [1]), name: "Renamed by owner" };
  });
  const first = await f.page({ object: { kind: "dataset", datasetId: remote }, limit: 1 }); await failed.promise;
  const next = await f.page({ object: { kind: "dataset", datasetId: remote }, cursor: first.nextCursor! });
  expect(next).toMatchObject({ completeness: "complete", unavailableSources: [], entries: [{ name: "Renamed by owner" }] });
  expect(attempts).toBe(3);
});

it("keeps the most recently active Collections when the source count exceeds the cap", async () => {
  const f = await fixture(), ids = Array.from({ length: HISTORY_MAX_SOURCES + 5 }, (_, n) => f.initialize(n + 1));
  for (const [n, id] of ids.entries()) f.event(id, n + 1);
  const page = await f.page({ limit: 1 });
  expect(page.entries[0]).toMatchObject({ datasetId: ids.at(-1), sortAtMs: ids.length });
  expect(page.nextCursor!.collections.map(s => s.datasetId)).not.toContain(ids[0]);
  expect(page).toMatchObject({ completeness: "partial", omittedSources: 5 });
});

it("reads the owner's renamed Collection name in the same history reply without describe", async () => {
  const f = await fixture(), remote = f.initialize(8); f.event(remote, 2); f.event(remote, 1);
  const operation = { state: {}, workspace: { attachmentId: Symbol() }, signal: f.signal.signal, assertCurrent() {} };
  const relay = vi.fn(async () => f.host.history("owner", { workspaceId: "workspace", datasetId: remote, metadataOnly: true }));
  const data = createRemoteDatasetData({ workspaceId: "workspace", credentials: { serverUrl: "https://account.example", relayUrl: "https://relay.example", userId: "owner", token: "test", email: "owner@example.test" },
    credentialGeneration: 1, signal: operation.signal, currentCredentialGeneration: () => 1, assertCurrent() {}, relayJson: relay });
  const remoteRead = createHistoryCollectionRemote({ expected: operation, generation: 1, currentGeneration: () => 1,
    withOperation: work => work(operation), dataFor: () => data });
  expect(await remoteRead(remote, undefined, operation.signal)).toMatchObject({ name: "Collection 8" });
  f.db.prepare("UPDATE dohc_dataset_catalog SET revision_json=json_set(revision_json,'$.definition.name',?) WHERE dataset_id=?").run("Owner renamed", remote);
  expect(await remoteRead(remote, undefined, operation.signal)).toMatchObject({ name: "Owner renamed" });
  expect(relay).toHaveBeenCalledTimes(2);
});

it("reads the Collections a server lists, on a computer that doesn't keep the workspace's own", async () => {
  const f = await fixture(), a = f.initialize(1), b = f.initialize(2);
  f.event(a, 400); f.event(b, 600); await f.write("file", 500);
  const described = (datasetId: string) => ({ datasetId }) as unknown as DatasetDescription;
  const list = vi.fn<OwnerDatasetData["list"]>(async ({ after }) => after === undefined
    ? { datasets: [described(a)], nextCursor: a } : { datasets: [described(b)], nextCursor: null });
  let current = true;
  f.reads.local = serverHistorySources({ list }, () => { if (!current) throw new Error("workspace changed"); });
  f.reads.remote = async (datasetId, before) => f.host.history("owner", { workspaceId: "workspace", datasetId, beforeRevision: before, limit: 51, metadataOnly: true });
  const first = await f.page({ limit: 2 });
  expect(first.entries.map(label)).toEqual([b + ":1", "file"]);
  expect(first).toMatchObject({ completeness: "complete", omittedSources: 0 });
  // A later page reads the sources its cursor names, without listing again.
  expect((await f.page({ cursor: first.nextCursor! })).entries.map(label)).toEqual([a + ":1", "main"]);
  expect(list).toHaveBeenCalledTimes(2);
  // A server that doesn't answer leaves the files.
  list.mockRejectedValue(new Error("offline"));
  const files = await f.page();
  expect(files.entries.map(label)).toEqual(["file", "main"]);
  expect(files).toMatchObject({ completeness: "complete", unavailableSources: [] });
  current = false;
  await expect(f.page()).rejects.toThrow("workspace changed");
});
