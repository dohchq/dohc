import {afterEach, expect, it, vi} from "vitest";
import {cpus, platform, release} from "node:os";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {closeTestStorage, closeTestStorages, reopenTestStorage, storagePath, testStorage} from "../testing";
import type {SyncRelayStorage} from "../storage";
import type {StorageContext} from "./context";
import type {FirstOpenEligibility} from "./firstOpenEligibility";

// Run: DOHC_FIRST_OPEN_MEASURE=1 pnpm --filter @dohc/sync-relay exec vitest run src/storage/firstOpenEligibility.perf.test.ts
afterEach(closeTestStorages);

const ROWS = 100_000, BATCH = 5_000, WARM = 25, COLD = 3;
const hex = (seed: string) => seed.padEnd(64, "0").slice(0, 64);
// The shape and size of a native write moment, which names its own object as its before state.
const moment = (objectId: string, seq: number, beforeObjectId = objectId) => JSON.stringify({
  authors: [{humanId: "owner-1", humanName: "Owner", kind: "human"}], beforeBlobSha256: hex(`b${seq}`), beforeByteLength: 43,
  beforeContentKind: "text", beforeLatestMomentId: `moment-${hex(`p${seq}`)}`, beforeMetadata: {correlationId: null, origin: "local-file", summary: null},
  beforeObjectId, beforePath: `docs/${objectId}.md`, beforePresent: "present", beforeUpdatedAtMs: seq, beforeVersionId: "main",
  metadata: {correlationId: null, origin: "local-file", summary: null}, momentId: `moment-${hex(`m${seq}`)}`, objectCreatedAtMs: 1, objectId,
  operation: "write", path: `docs/${objectId}.md`, payloadAfterBlobSha256: hex(`a${seq}`), payloadAfterByteLength: 78, payloadAfterContentKind: "text",
  payloadAfterPath: `docs/${objectId}.md`, payloadBeforeBlobSha256: hex(`b${seq}`), payloadBeforeByteLength: 43, payloadBeforeContentKind: "text",
  payloadBeforePath: `docs/${objectId}.md`, recordedAtMs: seq, versionId: "main"});

/** Three workspaces in one relay database, as the shared writer sees them. */
const scenarios: Array<{workspaceId: string; expected: FirstOpenEligibility; row: (seq: number) => string}> = [
  {workspaceId: "long-history", expected: "eligible", row: seq => moment("target", seq)},
  {workspaceId: "small-target", expected: "eligible", row: seq => moment(seq < 2 ? "target" : `object-${seq % 10_000}`, seq)},
  {workspaceId: "late-replacement", expected: "deletion", row: seq => seq === ROWS - 1 ? moment("successor", seq, "target")
    : moment(seq < 2 ? "target" : `object-${seq % 10_000}`, seq)},
];

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b), at = (q: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(2));
  return {n: samples.length, minMs: at(0), p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1)};
}
const timed = (run: () => void) => { const start = performance.now(); run(); return performance.now() - start; };

it.skipIf(process.env.DOHC_FIRST_OPEN_MEASURE !== "1")("measures first-open eligibility on long histories, before and inside the relay writer", async () => {
  let storage: SyncRelayStorage = await testStorage();
  const path = storagePath(storage), db = () => (storage as StorageContext).db;
  for (const workspaceId of [...scenarios.map(s => s.workspaceId), "writer"]) {
    storage.claimWorkspace({workspaceId, ownerUserId: "owner-1", createdAtMs: 0});
    storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-1", streamIdentity: "stream-1"});
  }
  const insert = db().prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES (?,'owner-device',?,'moment.append',?,1)");
  const buildStart = performance.now();
  for (const scenario of scenarios) for (let start = 0; start < ROWS; start += BATCH) {
    db().exec("BEGIN");
    for (let seq = start; seq < start + BATCH; seq++) insert.run(scenario.workspaceId, seq, scenario.row(seq));
    db().exec("COMMIT");
  }
  const buildMs = performance.now() - buildStart;
  const size = db().prepare("SELECT page_count*page_size AS bytes, (SELECT avg(length(payload_json)) FROM sync_relay_log) AS payload FROM pragma_page_count(), pragma_page_size()").get()!;
  const prepare = vi.spyOn(db(), "prepare");
  storage.readFirstOpenEligibility({workspaceId: "writer", objectId: "target"});
  const query = String(prepare.mock.calls[0]![0]); prepare.mockRestore();
  const plan = db().prepare(`EXPLAIN QUERY PLAN ${query}`).all().map(row => String(row.detail));

  const results: Record<string, unknown> = {};
  let writerSeq = 0;
  const text = new TextEncoder().encode("writer"), sha256 = sha256Hex(text);
  storage.putBlob({workspaceId: "writer", sha256, content: text, createdAtMs: 0});
  // An ordinary write in another workspace, which needs the same relay writer.
  const append = (admit?: () => void) => {
    const seq = writerSeq++, path = `docs/writer-${seq}.md`;
    const payload = {momentId: `writer-${seq}`, objectId: `writer-${seq}`, versionId: "main", operation: "write", path, payloadAfterPath: path,
      payloadAfterBlobSha256: sha256, payloadAfterByteLength: text.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1};
    storage.appendLogBatch({workspaceId: "writer", originId: "owner-device",
      ops: [{originSeq: seq, opKind: "moment.append", payloadJson: JSON.stringify(payload), recordedAtMs: 1}], ...(admit ? {admit: () => admit()} : {})});
  };
  for (const {workspaceId, expected} of scenarios) {
    const read = () => expect(storage.readFirstOpenEligibility({workspaceId, objectId: "target"})).toBe(expected);
    // Cold: the first read on a fresh connection, whose page cache is empty. The OS file cache stays warm.
    const cold: number[] = [];
    for (let i = 0; i < COLD; i++) {
      closeTestStorage(storage);
      storage = reopenTestStorage(path);
      cold.push(timed(read));
    }
    for (let i = 0; i < 3; i++) read();
    const warm = Array.from({length: WARM}, () => timed(read));
    // Inside the writer: the whole append holds it, the read included.
    for (let i = 0; i < 3; i++) append(read);
    const inside: number[] = [], held: number[] = [], bare: number[] = [];
    for (let i = 0; i < WARM; i++) {
      bare.push(timed(() => append()));
      held.push(timed(() => append(() => inside.push(timed(read)))));
    }
    results[workspaceId] = {expected, preflightColdMs: stats(cold), preflightWarmMs: stats(warm), readInsideWriterMs: stats(inside),
      writerHeldWithReadMs: stats(held), writerHeldWithoutReadMs: stats(bare)};
  }
  const sqlite = db().prepare("SELECT sqlite_version() AS version").get()!;
  console.log(JSON.stringify({environment: {node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cpus: cpus().length,
    sqlite: sqlite.version, cacheSize: db().prepare("PRAGMA cache_size").get()!.cache_size, journalMode: db().prepare("PRAGMA journal_mode").get()!.journal_mode},
  fixture: {workspaces: scenarios.length, rowsPerWorkspace: ROWS, databaseBytes: size.bytes, meanPayloadBytes: Math.round(Number(size.payload)), buildMs: Math.round(buildMs)},
  plan, results}, null, 2));
}, 900_000);
