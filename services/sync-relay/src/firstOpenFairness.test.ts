import {afterEach, expect, it} from "vitest";
import {cpus, loadavg, platform, release} from "node:os";
import {setTimeout as pace} from "node:timers/promises";
import * as Y from "yjs";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {markdownToYDoc} from "@dohc/ydoc-projection";
import {firstOpenCandidateBinding} from "@dohc/workspace-engine-client/daemon";
import type {FirstOpenOutcome, FirstOpenSourceIdentity} from "@dohc/workspace-contracts/first-open";
import {closeTestStorages, inspectDatabase, storagePath, testStorage} from "./testing";
import {authorizeServiceHostReplication, deriveServiceHostBearer} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {parseServiceActivationConfig} from "./serviceActivationDriver";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {createFirstOpenPublisher, type FirstOpenCheckHost} from "./firstOpenPublication";
import {createFirstOpenClient} from "./firstOpenClient";
import {FirstOpenRetry} from "./firstOpenRetry";
import {createLiveValidationExecutor} from "./liveValidation";
import {LiveRestoreBusy} from "./liveRestoreValidation";

// A writer replaces a shared note with content first open builds in full and
// the engine then refuses, about once a minute, so the relay keeps building
// and refusing it. This measures what that costs the work beside it on the
// same relay: live edits of another note, a sibling note's activation, and a
// restore. All of them and first open share one validation executor, as
// main.ts wires them, and activation, restore and first open share its one
// auxiliary slot. The same work runs first without the writer, in the same
// process, as the baseline.
//
// Time: the relay's publisher and the host's retries read one injected clock.
// It runs in real time while work runs and jumps over idle waits, so each
// one-minute cycle keeps its real build and costs only that build's real time.
//
// The engine's own check is answered as the engine answers this content
// (`settlement-mismatch`, as firstOpenPublication.native.test.ts shows for
// `a && b` in code), so this measures the relay's side only.

const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await closeTestStorages();
});

const WS = "workspace-1", OWNER = "owner-1", PATH = "docs/log.md", OBJECT = "object-log", namespace = "first-open-fairness";
const key = new Uint8Array(32).fill(41);
const profile = selfHostLiveProfile().service;
const policy = profile.activation.validation;
/** The service host's pass interval: an activation the executor answers `retry` captures again on the next pass. */
const PASS_MS = profile.activation.pollIntervalMs;
/** The writer's cycle, and how many it runs. */
const CYCLE_MS = 60_000, CYCLES = 8;
/** The pathological note's size: a megabyte of paragraphs, under every bound, so each build runs to the end. */
const PATHOLOGICAL_BYTES = 1024 * 1024;
/** How often a live edit of another note validates. */
const EDIT_EVERY_MS = 50;

// Budgets, fixed before the first run. Each measured against the baseline in the same process:
// - a sibling activation and a restore each finish within the baseline's slowest, plus one validation
//   child's cold start (measured here), plus one service-host pass, plus 100 ms;
// - live edit validation keeps its p95 within 100 ms of the baseline's.
const BUDGET_SLACK_MS = 100, EDIT_P95_SLACK_MS = 100;

/** Deterministic jitter. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function stats(samples: number[]) {
  if (!samples.length) return {n: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0};
  const sorted = [...samples].sort((a, b) => a - b), at = (q: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1));
  return {n: samples.length, minMs: at(0), p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1)};
}

const checkpointOf = (markdown: string) => {
  const doc = markdownToYDoc(markdown);
  try {return Y.encodeStateAsUpdate(doc);} finally {doc.destroy();}
};
/** A note of everyday length: 200 paragraphs. */
const everyday = (label: string) => Array.from({length: 200}, (_, i) => `${label} ${i}: **bold**, *italic*, \`code\` and [a link](https://example.com/${i}).`).join("\n\n");
/** Builds in full, and the engine settles `a && b` in code to other bytes. Each cycle numbers it anew, so each is a new source. */
const pathological = (cycle: number) => {
  let text = `Log ${cycle}\n=====\n\n`;
  for (let i = 0; Buffer.byteLength(text) < PATHOLOGICAL_BYTES - 64; i++) text += `Use \`a && b\` here, entry ${cycle}-${i}.\n\n`;
  return text;
};

it("keeps live edits, a sibling activation and a restore within budget while a writer replaces a note first open refuses every minute", async () => {
  const startedAt = performance.now();
  const pool = createLiveValidationExecutor();
  pools.push(pool);
  // A cold validation child: what the first job on a new child pays to start it.
  const sibling = {document: {workspaceId: WS, mainVersionId: "main", objectId: "object-sibling", lineageClaimId: "sibling-lineage"},
    currentPath: "docs/sibling.md", baselineBytes: checkpointOf(everyday("Sibling"))};
  const cold = createLiveValidationExecutor();
  pools.push(cold);
  const coldStart = performance.now();
  expect(await cold.ordinaryActivation(policy)(sibling)).toMatchObject({kind: "accepted"});
  const coldStartMs = performance.now() - coldStart;
  await cold.close();

  const storage = await testStorage({firstOpenHistory: (read, signal) => pool.readFirstOpenHistory(read, signal)});
  storage.claimWorkspace({workspaceId: WS, ownerUserId: OWNER, createdAtMs: 0});
  storage.claimWorkspaceIdentity({workspaceId: WS, replicationEpoch: "epoch", streamIdentity: "stream"});
  const raw = inspectDatabase(storagePath(storage));
  raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share-1',?,?,?,0)")
    .run(WS, OWNER, JSON.stringify({paths: ["docs"], versionId: null}));
  raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('grant-1','share-1','user','reader-2',NULL,'edit',1,'active',0,NULL,NULL)`).run();
  let originSeq = 0;
  const write = (cycle: number): FirstOpenSourceIdentity => {
    const bytes = new TextEncoder().encode(pathological(cycle)), sourceDigest = sha256Hex(bytes), sourceMomentId = `log-${cycle}`;
    storage.putBlob({workspaceId: WS, sha256: sourceDigest, content: bytes, createdAtMs: 1});
    storage.appendLogBatch({workspaceId: WS, originId: "agent-device", ops: [{originSeq: originSeq++, opKind: "moment.append", recordedAtMs: 1,
      payloadJson: JSON.stringify({momentId: sourceMomentId, objectId: OBJECT, versionId: "main", operation: "write", path: PATH, payloadAfterPath: PATH,
        payloadAfterBlobSha256: sourceDigest, payloadAfterByteLength: bytes.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1_000 + cycle})}]});
    return {workspaceId: WS, objectId: OBJECT, path: PATH, sourceMomentId, sourceDigest};
  };
  let source = write(0);
  const enrollment = storage.enrollServiceHostDocument({workspaceId: WS, ownerUserId: OWNER, shareId: "share-1", path: PATH, nowMs: 10, guard() {}});

  // One clock for the relay and the host: real time while work runs, and a jump over each idle wait.
  let skipped = 0;
  const clock = () => performance.now() + skipped;
  const jumpTo = (at: number) => {if (at > clock()) skipped += at - clock();};
  const activation = parseServiceActivationConfig({...profile.activation, targets: []})!;
  const host: FirstOpenCheckHost = {checkFirstOpenCandidate: async (_workspaceId, input) => ({kind: "answered", current: () => true,
    check: {status: "refused", contractVersion: 1, binding: firstOpenCandidateBinding(input), cause: "settlement-mismatch"}})};
  const builds: {ms: number; kind: string}[] = [];
  let building: (() => void) | undefined;
  const publisher = createFirstOpenPublisher({storage, namespace, activation: () => activation, host: () => host, nowMs: clock,
    build: async (buildPolicy, input, signal) => {
      const start = performance.now(), pending = pool.buildFirstOpenBase(buildPolicy, input, signal);
      building?.();
      const built = await pending;
      builds.push({ms: performance.now() - start, kind: built.kind === "refused" ? `refused:${built.reason}` : built.kind});
      return built;
    }});
  const relay = createServiceHostReplication({storage, prefix: "dohc-service-v1.", hostedFeed: true, firstOpen: publisher,
    authorize: input => authorizeServiceHostReplication(storage, {key, namespace, ...input})});
  const client = createFirstOpenClient({relay: {baseUrl: "https://relay.test", bearerToken: deriveServiceHostBearer(enrollment, {key, namespace})},
    identity: {replicationEpoch: "epoch", streamIdentity: "stream"}, fetch: async (url, init) => relay(new Request(url, init))});
  const retry = new FirstOpenRetry({nowMs: clock, random: seeded(2069)});

  // Foreground work, as the service host and the relay run it.
  const activate = pool.ordinaryActivation(policy), restore = pool.restore(policy), validate = pool.validator(policy);
  const restored = {binding: {...sibling.document, currentPath: sibling.currentPath}, checkpoint: {bytes: sibling.baselineBytes}, events: [],
    point: {journalCursor: 0, receiptDigest: "a".repeat(64)}, artifact: () => undefined, assertCurrent() {}};
  const edited = {document: {...sibling.document, objectId: "object-edited"}, currentPath: "docs/edited.md",
    checkpoint: checkpointOf(everyday("Edited")), suffix: [], candidate: Uint8Array.of(0, 0)};
  /** A sibling's activation: a busy executor answers `retry`, and the next pass captures again. */
  const activateSibling = async () => {
    const start = performance.now();
    for (let tries = 1; ; tries++) {
      const answer = await activate(sibling);
      if (answer.kind !== "retry") {expect(answer.kind).toBe("accepted"); return {ms: performance.now() - start, tries};}
      await pace(PASS_MS);
    }
  };
  /** A restore: a busy executor refuses its preparation, and it asks again a pass later. */
  const restoreSibling = async () => {
    const start = performance.now();
    for (let tries = 1; ; tries++) {
      try {await restore.point(restored); return {ms: performance.now() - start, tries};}
      catch (error) {if (!(error instanceof LiveRestoreBusy)) throw error;}
      await pace(PASS_MS);
    }
  };

  const run = async (label: "baseline" | "pathological") => {
    const edits: number[] = [], activations: {ms: number; tries: number}[] = [], restores: {ms: number; tries: number}[] = [];
    const attempts: {cycle: number; atMs: number; outcome: string}[] = [];
    // Warm both children, as a running relay's are.
    await Promise.all([activateSibling(), validate(edited)]);
    let editing = true;
    const editor = (async () => {
      while (editing) {
        const start = performance.now();
        expect((await validate(edited)).kind).toBe("accepted");
        edits.push(performance.now() - start);
        await pace(EDIT_EVERY_MS);
      }
    })();
    const buildsBefore = builds.length, runStartedAt = performance.now();
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const cycleStart = clock();
      const probe = () => cycle % 2 ? activateSibling().then(row => {activations.push(row);}) : restoreSibling().then(row => {restores.push(row);});
      if (label === "baseline") {await probe(); jumpTo(cycleStart + CYCLE_MS); continue;}
      // The writer replaces the note; the host asks on its passes until the relay answers this source.
      source = write(cycle);
      let probing: Promise<void> | undefined;
      building = () => {building = undefined; probing = probe();};
      for (;;) {
        const outcome: FirstOpenOutcome | undefined = await retry.attempt(source, signal => client(source, signal));
        if (outcome) attempts.push({cycle, atMs: Math.round(clock()), outcome: outcome.kind === "unavailable" ? outcome.reason
          : outcome.kind === "refused" ? `refused:${outcome.reason}` : outcome.kind});
        const next = retry.state(source)?.retryAtMs ?? Infinity;
        if (next === Infinity || next >= cycleStart + CYCLE_MS) break;
        jumpTo(next);
      }
      building = undefined;
      // A cycle whose answer came without a build (an admission still quiet) probes anyway.
      await (probing ?? probe());
      jumpTo(cycleStart + CYCLE_MS);
    }
    editing = false;
    await editor;
    return {label, seconds: Number(((performance.now() - runStartedAt) / 1_000).toFixed(1)), builds: builds.slice(buildsBefore), attempts,
      liveEdit: stats(edits), activation: {...stats(activations.map(row => row.ms)), tries: activations.map(row => row.tries)},
      restore: {...stats(restores.map(row => row.ms)), tries: restores.map(row => row.tries)}};
  };

  const baseline = await run("baseline");
  const loaded = await run("pathological");
  const budgets = {
    activationMs: baseline.activation.maxMs + coldStartMs + PASS_MS + BUDGET_SLACK_MS,
    restoreMs: baseline.restore.maxMs + coldStartMs + PASS_MS + BUDGET_SLACK_MS,
    liveEditP95Ms: baseline.liveEdit.p95Ms + EDIT_P95_SLACK_MS,
  };
  console.log(JSON.stringify({environment: {node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cpus: cpus().length, loadavg: loadavg()},
    fixture: {cycles: CYCLES, cycleMs: CYCLE_MS, passMs: PASS_MS, pathologicalBytes: PATHOLOGICAL_BYTES, editEveryMs: EDIT_EVERY_MS},
    coldStartMs: Number(coldStartMs.toFixed(1)), budgets, baseline, pathological: loaded,
    wallSeconds: Number(((performance.now() - startedAt) / 1_000).toFixed(1))}, null, 2));
  // The writer did what it is here for: each cycle's note was built and refused, and nothing published.
  expect(loaded.builds.length).toBeGreaterThanOrEqual(CYCLES / 2);
  expect(raw.prepare("SELECT count(*) AS n FROM sync_relay_log WHERE origin_id LIKE 'service-host:first-open:%'").get()!.n).toBe(0);
  expect(loaded.activation.maxMs).toBeLessThanOrEqual(budgets.activationMs);
  expect(loaded.restore.maxMs).toBeLessThanOrEqual(budgets.restoreMs);
  expect(loaded.liveEdit.p95Ms).toBeLessThanOrEqual(budgets.liveEditP95Ms);
}, 600_000);
