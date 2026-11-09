import {afterEach, expect, it} from "vitest";
import {randomBytes} from "node:crypto";
import {cpus, loadavg, platform, release} from "node:os";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {closeTestStorages, inspectDatabase, storagePath, testStorage} from "./testing";
import {authorizeServiceHostReplication, deriveServiceHostBearer} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {parseServiceActivationConfig} from "./serviceActivationDriver";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {firstOpenCandidateBinding} from "@dohc/workspace-engine-client/daemon";
import {createFirstOpenPublisher, FIRST_OPEN_WRITER_ATTEMPTS, type FirstOpenCheckHost} from "./firstOpenPublication";
import type {FirstOpenOutcome} from "@dohc/workspace-contracts/first-open";
import {createLiveValidationExecutor} from "./liveValidation";
import {refuseOp} from "./storage/relayAdmission";
import type {SyncRelayLogInput} from "./storage";
import type {StorageContext} from "./storage/context";
import {putBlobInTransaction} from "./storage/blobs";
import {appendLogBatchInTransaction} from "./storage/log";

// Run: DOHC_FIRST_OPEN_LOOP_MEASURE=1 pnpm --filter @dohc/sync-relay exec vitest run src/firstOpenPublication.perf.test.ts --silent=false --reporter=verbose
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await closeTestStorages();
});

const WS = "workspace-1", OTHER_WS = "workspace-2", OBJECT = "object-1", PATH = "docs/a.md", OWNER = "owner-1";
const HISTORY_ROWS = 20_000, SAMPLES = 100, WARM = 5;
// Appends per second into the document's workspace: none, a quiet chat, an active one, agents writing, and a burst.
const RATES = [0, 1, 5, 20, 50];
const key = new Uint8Array(32).fill(29), namespace = "first-open-loop";

function stats(samples: number[]) {
  if (!samples.length) return {n: 0};
  const sorted = [...samples].sort((a, b) => a - b), at = (q: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(3));
  return {n: samples.length, minMs: at(0), p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1)};
}

it.skipIf(process.env.DOHC_FIRST_OPEN_LOOP_MEASURE !== "1")("measures the first-open caller loop against same-workspace appends", async () => {
  const pool = createLiveValidationExecutor();
  pools.push(pool);
  const storage = await testStorage({firstOpenHistory: (read, signal) => pool.readFirstOpenHistory(read, signal)});
  const markdown = new TextEncoder().encode("# Plan\n\nBring snacks.\n"), digest = sha256Hex(markdown);
  for (const workspaceId of [WS, OTHER_WS]) {
    storage.claimWorkspace({workspaceId, ownerUserId: OWNER, createdAtMs: 0});
    storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
    storage.putBlob({workspaceId, sha256: digest, content: markdown, createdAtMs: 0});
  }
  const raw = inspectDatabase(storagePath(storage));
  // Other objects' history, so each read covers a workspace of realistic length.
  const insert = raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES (?,'history-device',?,'moment.append',?,1)");
  raw.exec("BEGIN");
  for (const workspaceId of [WS, OTHER_WS]) for (let seq = 0; seq < HISTORY_ROWS; seq++) {
    insert.run(workspaceId, seq, JSON.stringify({momentId: `history-${seq}`, objectId: `object-${seq % 500}`, versionId: "main", operation: "write",
      path: `notes/${seq % 500}.md`, payloadAfterPath: `notes/${seq % 500}.md`, payloadAfterBlobSha256: digest, payloadAfterByteLength: markdown.byteLength,
      payloadAfterContentKind: "text", recordedAtMs: seq}));
  }
  raw.exec("COMMIT");
  const seqs = new Map<string, number>();
  const append = (workspaceId: string, opKind: string, payload: object, refused = false) => {
    const originKey = `${workspaceId}/${opKind}`, originSeq = seqs.get(originKey) ?? 0;
    seqs.set(originKey, originSeq + 1);
    const op: SyncRelayLogInput = {originSeq, opKind, payloadJson: JSON.stringify(payload), recordedAtMs: 2};
    storage.appendLogBatch({workspaceId, originId: `device-${opKind}`, ops: [op],
      ...(refused ? {admit: (ops: SyncRelayLogInput[]) => ops.forEach(row => refuseOp(row, {opKind, payloadSha256: sha256Hex(row.payloadJson), reason: "outside-hosted-documents"}))} : {})});
  };
  const write = (workspaceId: string, objectId: string, path: string, momentId: string) => append(workspaceId, "moment.append", {momentId, objectId, versionId: "main",
    operation: "write", path, payloadAfterPath: path, payloadAfterBlobSha256: digest, payloadAfterByteLength: markdown.byteLength, payloadAfterContentKind: "text", recordedAtMs: 3});
  for (const workspaceId of [WS, OTHER_WS]) {
    raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,?,?,0)")
      .run(`share-${workspaceId}`, workspaceId, OWNER, JSON.stringify({paths: ["docs"], versionId: null}));
    raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','reader-2',NULL,'edit',1,'active',0,NULL,NULL)`).run(`grant-${workspaceId}`, `share-${workspaceId}`);
  }
  write(WS, OBJECT, PATH, "source-moment");
  const enrollment = storage.enrollServiceHostDocument({workspaceId: WS, ownerUserId: OWNER, shareId: `share-${WS}`, path: PATH, nowMs: 10, guard() {}});
  const activation = parseServiceActivationConfig({...selfHostLiveProfile().service.activation, targets: []})!;
  // This measures the writer loop, not the engine: every candidate checks, with a full state as long as the candidate.
  const host: FirstOpenCheckHost = {checkFirstOpenCandidate: async (_workspaceId, input) => ({kind: "answered", current: () => true,
    check: {status: "checked", contractVersion: 1, binding: firstOpenCandidateBinding(input), settledSourceSha256: input.sourceSha256,
      settledSourceByteLength: input.source.byteLength, fullStateSha256: input.candidateSha256, fullStateByteLength: input.candidate.byteLength}})};
  const publisher = createFirstOpenPublisher({admissionIntervalMs: 0, storage, namespace, activation: () => activation, host: () => host,
    build: (policy, input, signal) => pool.buildFirstOpenBase(policy, input, signal)});
  const handle = createServiceHostReplication({storage, prefix: "dohc-service-v1.", hostedFeed: true, firstOpen: publisher,
    authorize: input => authorizeServiceHostReplication(storage, {key, namespace, ...input})});
  const bearer = deriveServiceHostBearer(enrollment, {key, namespace});
  // Writer attempts and how long each held the writer: the calls are synchronous, so their wall time is the hold.
  let attempts = 0;
  const holds: Array<{ms: number; kind: string}> = [];
  const writeFirstOpen = storage.writeFirstOpen.bind(storage);
  storage.writeFirstOpen = (proof, base, guard) => {
    attempts++;
    const start = performance.now();
    let kind = "threw";
    try { const written = writeFirstOpen(proof, base, guard); kind = written.kind; return written; }
    finally { holds.push({ms: performance.now() - start, kind}); }
  };
  const request = async () => {
    const response = await handle(new Request(`https://relay.test/sync/${WS}/hosted/first-open`, {method: "POST",
      headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"},
      body: JSON.stringify({objectId: OBJECT, path: PATH, sourceMomentId: "source-moment", sourceDigest: digest, replicationEpoch: "epoch", streamIdentity: "stream"})}));
    expect(response.status).toBe(200);
    return (await response.json() as {outcome: FirstOpenOutcome}).outcome;
  };
  // Each publication is removed after it is measured, so the document stays without live history for the next sample.
  let baseBytes = 0;
  const forget = (outcome: FirstOpenOutcome) => {
    if (outcome.kind !== "published") return;
    const row = raw.prepare("SELECT json_extract(payload_json,'$.updateBlobSha256') AS sha FROM sync_relay_log WHERE relay_seq=?").get(outcome.receipt.relaySeq)!;
    baseBytes = storage.getBlob(WS, String(row.sha))!.byteLength;
    raw.prepare("DELETE FROM sync_relay_log WHERE relay_seq=?").run(outcome.receipt.relaySeq);
  };
  // The same commit without first-open: a new blob of the base's size and one Y.Doc row, for another document.
  const context = storage as StorageContext, plainHolds: number[] = [];
  let plainSeq = 0;
  const plain = () => {
    const content = randomBytes(baseBytes), sha256 = sha256Hex(content), start = performance.now();
    context.tx(() => {
      putBlobInTransaction(context, {workspaceId: WS, sha256, content, createdAtMs: 4});
      appendLogBatchInTransaction(context, {workspaceId: WS, originId: "plain-device", ops: [{originSeq: plainSeq++, opKind: "ydoc.update", recordedAtMs: 4,
        payloadJson: JSON.stringify({versionId: "main", objectId: "object-plain", path: "docs/plain.md", contentKind: "richdoc", updateBlobSha256: sha256,
          lineageClaimId: sha256, isBaseState: false})}]});
    });
    plainHolds.push(performance.now() - start);
  };
  // Chat, ordinary writes to other files, and the relay's refusals, in turn.
  const appender = (workspaceId: string, rate: number) => {
    let appended = 0, turn = 0;
    const timer = rate > 0 ? setInterval(() => {
      const kind = turn++ % 3;
      if (kind === 0) append(workspaceId, "chat.message.append", {messageId: `message-${turn}`, threadId: "thread-1", body: "on my way", authorUserId: OWNER, authorKind: "human"});
      else if (kind === 1) write(workspaceId, `object-live-${turn % 50}`, `docs/live-${turn % 50}.md`, `live-${workspaceId}-${turn}`);
      else append(workspaceId, "ydoc.update", {versionId: "main", objectId: "object-elsewhere", path: "docs/elsewhere.md", contentKind: "richdoc"}, true);
      appended++;
    }, 1_000 / rate) : undefined;
    const started = performance.now();
    return {stop() { clearInterval(timer); return {appended, seconds: (performance.now() - started) / 1_000}; }};
  };

  const run = async (label: string, workspaceId: string, rate: number) => {
    for (let i = 0; i < WARM; i++) forget(await request());
    attempts = 0; holds.length = 0; plainHolds.length = 0;
    const load = appender(workspaceId, rate), distribution: Record<number, number> = {}, outcomes: Record<string, number> = {}, latency: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const before = attempts, start = performance.now(), outcome = await request();
      latency.push(performance.now() - start);
      distribution[attempts - before] = (distribution[attempts - before] ?? 0) + 1;
      const name = outcome.kind === "unavailable" ? outcome.reason : outcome.kind;
      outcomes[name] = (outcomes[name] ?? 0) + 1;
      expect(["published", "contention"]).toContain(name);
      forget(outcome);
      plain();
    }
    const appended = load.stop();
    return {label, workspace: workspaceId === WS ? "same" : "unrelated", targetAppendsPerSecond: rate,
      appendsPerSecond: Number((appended.appended / appended.seconds).toFixed(2)), appended: appended.appended,
      attemptDistribution: distribution, outcomes, requestMs: stats(latency), writerHoldMs: stats(holds.map(hold => hold.ms)),
      // A publication commits a blob and a row; a retry only rechecks.
      publishingHoldMs: stats(holds.filter(hold => hold.kind === "published").map(hold => hold.ms)),
      retryHoldMs: stats(holds.filter(hold => hold.kind === "retry").map(hold => hold.ms)), plainAppendHoldMs: stats(plainHolds)};
  };
  const results = [];
  for (const rate of RATES) results.push(await run(`same-${rate}`, WS, rate));
  const unrelated = await run("unrelated-50", OTHER_WS, 50);
  results.push(unrelated);
  // Another workspace's appends never move this document's proof.
  expect(unrelated.attemptDistribution).toEqual({1: SAMPLES});
  console.log(JSON.stringify({environment: {node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cpus: cpus().length, loadavg: loadavg()},
    fixture: {historyRowsPerWorkspace: HISTORY_ROWS, samples: SAMPLES, warm: WARM, writerAttempts: FIRST_OPEN_WRITER_ATTEMPTS}, results}, null, 2));
}, 3_600_000);
