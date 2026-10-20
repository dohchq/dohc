import {afterEach, expect, it, vi} from "vitest";
import {cpus, platform, release} from "node:os";
import {monitorEventLoopDelay} from "node:perf_hooks";
import {DatabaseSync} from "node:sqlite";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {closeTestStorages, inspectDatabase, storagePath, testStorage} from "../testing";
import {createLiveValidationExecutor} from "../liveValidation";
import type {StorageContext} from "./context";
import {readFirstOpenHistory, type FirstOpenEligibility, type FirstOpenHistoryReader, type FirstOpenSource} from "./firstOpenHistory";
import type {FirstOpenProof} from "./firstOpenEligibility";

// Run: DOHC_FIRST_OPEN_MEASURE=1 pnpm --filter @dohc/sync-relay exec vitest run src/storage/firstOpenEligibility.perf.test.ts --silent=false --reporter=verbose
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await closeTestStorages();
});

const ROWS = 100_000, BATCH = 5_000, FRESH = 10, WARM = 100, WRITES = 100, CATCH_UPS = 100, CATCH_UP_ROWS = 100, OBJECTS = 2_000, NAMESPACES = 8;
const TEXT = new TextEncoder().encode("ordinary text"), SHA = sha256Hex(TEXT);
const hex = (seed: string) => seed.padEnd(64, "0").slice(0, 64);
// The shape and size of a native write moment, which names its own object as its before state.
const momentPayload = (objectId: string, seq: number, beforeObjectId = objectId, blob?: string) => ({
  authors: [{humanId: "owner-1", humanName: "Owner", kind: "human"}], beforeBlobSha256: blob ?? hex(`b${seq}`), beforeByteLength: 43,
  beforeContentKind: "text", beforeLatestMomentId: `moment-${hex(`p${seq}`)}`, beforeMetadata: {correlationId: null, origin: "local-file", summary: null},
  beforeObjectId, beforePath: `docs/${objectId}.md`, beforePresent: "present", beforeUpdatedAtMs: seq, beforeVersionId: "main",
  metadata: {correlationId: null, origin: "local-file", summary: null}, momentId: `moment-${hex(`m${seq}`)}`, objectCreatedAtMs: 1, objectId,
  operation: "write", path: `docs/${objectId}.md`, payloadAfterBlobSha256: blob ?? hex(`a${seq}`), payloadAfterByteLength: 78, payloadAfterContentKind: "text",
  payloadAfterPath: `docs/${objectId}.md`, payloadBeforeBlobSha256: blob ?? hex(`b${seq}`), payloadBeforeByteLength: 43, payloadBeforeContentKind: "text",
  payloadBeforePath: `docs/${objectId}.md`, recordedAtMs: seq, versionId: "main"});
const moment = (objectId: string, seq: number, beforeObjectId = objectId) => JSON.stringify(momentPayload(objectId, seq, beforeObjectId));

/** Three workspaces in one relay database, as the shared writer sees them. */
const scenarios: Array<{workspaceId: string; expected: FirstOpenEligibility; row: (seq: number) => string}> = [
  {workspaceId: "long-history", expected: "eligible", row: seq => moment("target", seq)},
  {workspaceId: "small-target", expected: "eligible", row: seq => moment(seq < 2 ? "target" : `object-${seq % 10_000}`, seq)},
  {workspaceId: "late-replacement", expected: "deletion", row: seq => seq === ROWS - 1 ? moment("successor", seq, "target")
    : moment(seq < 2 ? "target" : `object-${seq % 10_000}`, seq)},
];

function stats(samples: number[]) {
  if (!samples.length) return {n: 0};
  const sorted = [...samples].sort((a, b) => a - b), at = (q: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(3));
  return {n: samples.length, minMs: at(0), p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1)};
}
const timed = async <T>(run: () => T | Promise<T>): Promise<[number, T]> => { const start = performance.now(); const value = await run(); return [performance.now() - start, value]; };

it.skipIf(process.env.DOHC_FIRST_OPEN_MEASURE !== "1")("measures first-open preparation off the writer and its recheck inside it", async () => {
  const pool = createLiveValidationExecutor();
  pools.push(pool);
  const worker: FirstOpenHistoryReader = (request, signal) => pool.readFirstOpenHistory(request, signal);
  let reader = worker;
  const storage = await testStorage({firstOpenHistory: (request, signal) => reader(request, signal)}), context = storage as StorageContext, db = context.db;
  const workspaces = [...scenarios.map(s => s.workspaceId), "writer", "unrelated"];
  for (const workspaceId of workspaces) {
    storage.claimWorkspace({workspaceId, ownerUserId: "owner-1", createdAtMs: 0});
    storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-1", streamIdentity: "stream-1"});
    storage.putBlob({workspaceId, sha256: SHA, content: TEXT, createdAtMs: 0});
  }
  const insert = db.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES (?,'owner-device',?,'moment.append',?,1)");
  const buildStart = performance.now();
  for (const scenario of scenarios) for (let start = 0; start < ROWS; start += BATCH) {
    db.exec("BEGIN");
    for (let seq = start; seq < start + BATCH; seq++) insert.run(scenario.workspaceId, seq, scenario.row(seq));
    db.exec("COMMIT");
  }
  // Other objects' authority rows, the Stop/restore operations spread over several namespaces.
  const raw = inspectDatabase(storagePath(storage));
  raw.exec("PRAGMA foreign_keys=OFF");
  raw.exec("BEGIN");
  for (const {workspaceId} of scenarios) for (let index = 0; index < OBJECTS; index++) {
    const objectId = `object-${index}`, lineage = sha256Hex(new TextEncoder().encode(objectId));
    raw.prepare("INSERT INTO sync_relay_live_documents VALUES (?,'main',?,?,NULL,?,1,?,1,?,?,'retired','closed',0,0,5)")
      .run(workspaceId, objectId, lineage, `docs/${objectId}.md`, "b".repeat(64), lineage, new Uint8Array([0, 0]));
    raw.prepare("INSERT INTO sync_relay_live_document_ordinary_bases VALUES (?,'main',?,?,1,'owner-device',0,'old-epoch','old-stream',?,?,0,1)")
      .run(workspaceId, objectId, lineage, `docs/${objectId}.md`, "b".repeat(64));
    raw.prepare("INSERT INTO sync_relay_service_activations VALUES ('namespace',?,?,'main',?,?,'{}','{}',?,?,'owner-1','share-1',NULL,1)")
      .run(`activation-${workspaceId}-${objectId}`, workspaceId, objectId, lineage, "d".repeat(64), new Uint8Array([0, 0]));
    raw.prepare(`INSERT INTO sync_relay_live_restore_operations(operation_id,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,
      intent_json,basis_json,terminal_json,applied_json,native_receipt_json,phase,old_fence,new_fence,cutover_cursor,revoked_generation,invalidated_at_ms,fenced_at_ms,accounted_bytes)
      VALUES (?,?,?,'main',?,?,'{}','{}','{}','{}','{}','resumed',1,2,0,2,0,0,1)`).run(`restore-${workspaceId}-${objectId}`, `namespace-${index % NAMESPACES}`, workspaceId, objectId, lineage);
  }
  raw.exec("COMMIT");
  raw.close();
  // Each target's current source, appended normally so the relay projects it.
  const originSeqs = new Map<string, number>(scenarios.map(s => [s.workspaceId, ROWS]));
  const append = (workspaceId: string, objectIds: string[]) => {
    const first = originSeqs.get(workspaceId) ?? 0;
    originSeqs.set(workspaceId, first + objectIds.length);
    return {workspaceId, originId: "owner-device", ops: objectIds.map((objectId, index) => ({originSeq: first + index, opKind: "moment.append",
      payloadJson: JSON.stringify(momentPayload(objectId, ROWS + first + index, objectId, SHA)), recordedAtMs: 1}))};
  };
  const sources = new Map<string, FirstOpenSource>();
  for (const {workspaceId} of scenarios.slice(0, 2)) {
    const batch = append(workspaceId, ["target"]);
    storage.appendLogBatch(batch);
    const payload = JSON.parse(batch.ops[0]!.payloadJson) as {momentId: string; path: string; payloadAfterByteLength: number};
    sources.set(workspaceId, {workspaceId, objectId: "target", path: payload.path, sourceMomentId: payload.momentId, sourceDigest: SHA,
      sourceByteLength: payload.payloadAfterByteLength});
  }
  const buildMs = performance.now() - buildStart;
  const size = db.prepare("SELECT page_count*page_size AS bytes, (SELECT avg(length(payload_json)) FROM sync_relay_log) AS payload FROM pragma_page_count(), pragma_page_size()").get()!;

  // When the writer holds its transaction: from BEGIN IMMEDIATE returning until COMMIT or ROLLBACK returns.
  const exec = db.exec.bind(db);
  let began = 0, ending = 0, ended = 0;
  vi.spyOn(db, "exec").mockImplementation(sql => {
    if (sql === "COMMIT" || sql === "ROLLBACK") ending = performance.now();
    exec(sql);
    if (sql === "BEGIN IMMEDIATE") began = performance.now();
    if (sql === "COMMIT" || sql === "ROLLBACK") ended = performance.now();
  });
  const plain = async () => {
    const [whole] = await timed(() => storage.appendLogBatch(append("writer", ["plain"])));
    return {whole, hold: ended - began};
  };
  // A real publication: the base's blob and row in the target's workspace. Each is removed after it is timed, so the target stays eligible.
  const cleanup = inspectDatabase(storagePath(storage));
  const guarded = async (proof: FirstOpenProof, workspaceId: string) => {
    let publishing = 0;
    const base = {namespace: "namespace", bytes: TEXT, recordedAtMs: storage.readFirstOpenMoment(workspaceId, "target")!.recordedAtMs};
    const [whole, written] = await timed(() => storage.writeFirstOpen(proof, base, () => { publishing = performance.now(); }));
    if (written.kind === "published") cleanup.prepare("DELETE FROM sync_relay_log WHERE relay_seq=?").run(written.receipt.relaySeq);
    return {whole, hold: ended - began, eligibility: (written.kind === "published" ? publishing : ending) - began, kind: written.kind};
  };

  const plans: Record<string, string[]> = {};
  {
    const source = sources.get("long-history")!, queries: string[] = [];
    reader = async request => {
      const connection = new DatabaseSync(request.database, {readOnly: true});
      try { return readFirstOpenHistory({prepare: sql => { queries.push(sql); return connection.prepare(sql); }}, request); } finally { connection.close(); }
    };
    const prepared = await storage.prepareFirstOpen(source);
    reader = worker;
    if (prepared.kind !== "prepared") throw new Error(`Expected a preparation, got ${JSON.stringify(prepared)}.`);
    const spy = vi.spyOn(db, "prepare");
    // Refused after the recheck, before it publishes: nothing to remove.
    expect(() => storage.writeFirstOpen(prepared.proof, {namespace: "namespace", bytes: TEXT, recordedAtMs: -1}, () => undefined)).toThrow("timestamp");
    const guard = spy.mock.calls.map(([sql]) => sql).find(sql => sql.startsWith("WITH RECURSIVE"))!;
    spy.mockRestore();
    const plan = (query: string) => db.prepare(`EXPLAIN QUERY PLAN ${query}`).all().map(row => String(row.detail));
    plans.history = plan(queries[0]!);
    plans.writer = plan(guard);
  }

  const results: Record<string, unknown> = {}, acceptance: Record<string, {pass: boolean; [measure: string]: number | boolean | undefined}> = {};
  for (const {workspaceId, expected} of scenarios) {
    const source = sources.get(workspaceId) ?? {workspaceId, objectId: "target", path: "docs/target.md", sourceMomentId: "moment-target", sourceDigest: SHA, sourceByteLength: 78};
    const result: Record<string, unknown> = {expected};
    results[workspaceId] = result;
    // A fresh read-only connection on the first-open worker for every preparation.
    const fresh: number[] = [];
    let eligible = false;
    for (let i = 0; i < FRESH + 1; i++) {
      const [ms, prepared] = await timed(() => storage.prepareFirstOpen(source));
      expect(prepared.kind === "prepared" ? "eligible" : prepared.kind === "refused" ? prepared.reason : prepared.kind).toBe(expected);
      eligible = prepared.kind === "prepared";
      if (i > 0) fresh.push(ms);
    }
    result.freshWorkerPreparationMs = stats(fresh);
    // The same statement repeated on one warm connection, in this thread.
    const reader = new DatabaseSync(storagePath(storage), {readOnly: true});
    const warm: number[] = [];
    for (let i = 0; i < WARM + 3; i++) {
      const [ms] = await timed(() => readFirstOpenHistory(reader, {...source, afterRelaySeq: 0}));
      if (i >= 3) warm.push(ms);
    }
    reader.close();
    result.warmQueryMs = stats(warm);
    if (!eligible) continue;
    const prepare = async () => {
      const prepared = await storage.prepareFirstOpen(source);
      if (prepared.kind !== "prepared") throw new Error(`Expected a preparation, got ${JSON.stringify(prepared)}.`);
      return prepared.proof;
    };

    // The writer: a plain append and the same append behind the first-open recheck, interleaved.
    // Each publication uses up its proof, so each guarded append gets a new one, prepared before either append.
    const plainWhole: number[] = [], plainHold: number[] = [], guardedWhole: number[] = [], guardedHold: number[] = [], eligibility: number[] = [];
    for (let i = 0; i < 3; i++) { await plain(); await guarded(await prepare(), workspaceId); }
    for (let i = 0; i < WRITES; i++) {
      const proof = await prepare();
      // Alternate which append goes first, so neither always follows the other.
      const first = i % 2 === 0 ? await plain() : undefined;
      const checked = await guarded(proof, workspaceId);
      const bare = first ?? await plain();
      expect(checked.kind).toBe("published");
      plainWhole.push(bare.whole); plainHold.push(bare.hold);
      guardedWhole.push(checked.whole); guardedHold.push(checked.hold); eligibility.push(checked.eligibility);
    }
    Object.assign(result, {plainAppendMs: stats(plainWhole), plainHoldMs: stats(plainHold), guardedAppendMs: stats(guardedWhole),
      guardedHoldMs: stats(guardedHold), eligibilityInWriterMs: stats(eligibility)});

    // The event loop while the worker prepares, alone and with unrelated workspace writes in the main thread.
    const idle = monitorEventLoopDelay({resolution: 1});
    idle.enable();
    for (let i = 0; i < FRESH; i++) expect((await storage.prepareFirstOpen(source)).kind).toBe("prepared");
    idle.disable();
    result.preparationAloneEventLoopDelayMs = {p50: idle.percentile(50) / 1e6, p99: idle.percentile(99) / 1e6, max: idle.max / 1e6};
    const overlapped: number[] = [], loop = monitorEventLoopDelay({resolution: 1});
    let windows = 0;
    loop.enable();
    for (let i = 0; i < FRESH; i++) {
      let done = false;
      const preparing = storage.prepareFirstOpen(source).finally(() => { done = true; });
      while (!done) {
        const [ms] = await timed(() => storage.appendLogBatch(append("unrelated", ["unrelated"])));
        overlapped.push(ms);
        await new Promise(resolve => setImmediate(resolve));
      }
      expect((await preparing).kind).toBe("prepared");
      windows++;
    }
    loop.disable();
    result.overlap = {preparations: windows, unrelatedAppendMs: stats(overlapped),
      eventLoopDelayMs: {p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6}};

    // Catch-up: rows land in the target's workspace after preparation; the writer retries and the worker reads only the suffix.
    let retries = 0, proof = await prepare();
    const retryHold: number[] = [], retryEligibility: number[] = [], catchUp: number[] = [];
    for (let i = 0; i < CATCH_UPS; i++) {
      storage.appendLogBatch(append(workspaceId, Array.from({length: CATCH_UP_ROWS}, (_, index) => `object-${index}`)));
      const checked = await guarded(proof, workspaceId);
      expect(checked.kind).toBe("retry");
      retries++;
      retryHold.push(checked.hold); retryEligibility.push(checked.eligibility);
      const [ms, caught] = await timed(() => storage.catchUpFirstOpen(proof));
      if (caught.kind !== "prepared") throw new Error(`Expected a preparation, got ${JSON.stringify(caught)}.`);
      catchUp.push(ms);
      proof = caught.proof;
    }
    expect((await guarded(proof, workspaceId)).kind).toBe("published");
    result.catchUp = {rowsPerRound: CATCH_UP_ROWS, retries, freshWorkerCatchUpMs: stats(catchUp), retryHoldMs: stats(retryHold), retryEligibilityInWriterMs: stats(retryEligibility)};

    // A stale proof: the source changed, so the writer refuses without publishing.
    proof = await prepare();
    storage.appendLogBatch(append(workspaceId, ["target"]));
    const staleHold: number[] = [], staleEligibility: number[] = [];
    for (let i = 0; i < WRITES; i++) {
      const checked = await guarded(proof, workspaceId);
      expect(checked.kind).toBe("refused");
      staleHold.push(checked.hold); staleEligibility.push(checked.eligibility);
    }
    result.staleProof = {holdMs: stats(staleHold), eligibilityInWriterMs: stats(staleEligibility)};

    // Judged per scenario: eligibility work over every writer outcome, and hold against this scenario's plain appends.
    const work = stats([...eligibility, ...retryEligibility, ...staleEligibility]), plainP95 = stats(plainHold).p95Ms!, guardedP95 = stats(guardedHold).p95Ms!;
    acceptance[workspaceId] = {eligibilityP95Ms: work.p95Ms, eligibilityMaxMs: work.maxMs, plainHoldP95Ms: plainP95, guardedHoldP95Ms: guardedP95,
      holdP95DifferenceMs: Number((guardedP95 - plainP95).toFixed(3)), plainAppendP95Ms: stats(plainWhole).p95Ms, guardedAppendP95Ms: stats(guardedWhole).p95Ms,
      pass: work.p95Ms! <= 5 && work.maxMs! <= 20 && guardedP95 - plainP95 <= 10};
  }
  vi.restoreAllMocks();

  const sqlite = db.prepare("SELECT sqlite_version() AS version").get()!;
  console.log(JSON.stringify({environment: {node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cpus: cpus().length,
    sqlite: sqlite.version, cacheSize: db.prepare("PRAGMA cache_size").get()!.cache_size, journalMode: db.prepare("PRAGMA journal_mode").get()!.journal_mode},
  fixture: {workspaces: scenarios.length, rowsPerWorkspace: ROWS, authorityRowsPerTablePerWorkspace: OBJECTS, restoreNamespaces: NAMESPACES,
    databaseBytes: size.bytes, meanPayloadBytes: Math.round(Number(size.payload)), buildMs: Math.round(buildMs)},
  samples: {fresh: FRESH, warm: WARM, writes: WRITES, catchUps: CATCH_UPS}, plans, results,
  acceptance: {pass: Object.values(acceptance).every(scenario => scenario.pass), byScenario: acceptance}}, null, 2));
}, 3_600_000);
