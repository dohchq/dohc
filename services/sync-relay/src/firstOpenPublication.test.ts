import {afterEach, expect, it, vi} from "vitest";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import * as Y from "yjs";
import {LIVE_MARKDOWN_MAX_BYTES} from "@dohc/live-session-contract/limits";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {accountDeletionIdentity} from "@dohc/workspace-auth/accountDeletion";
import {yDocToArtifactMarkdown} from "@dohc/ydoc-projection";
import * as richdocSeed from "@dohc/ydoc-projection/richdoc-seed";
import {closeTestStorage, closeTestStorages, inspectDatabase, storagePath, tempRoot, testStorage} from "./testing";
import {guardRelayResponses} from "./relayResponseStanding";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostFeedRoute, serviceHostReplicationRoute} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {parseServiceActivationConfig, type ServiceActivationConfig} from "./serviceActivationDriver";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {firstOpenCandidateBinding, type FirstOpenCandidateInput} from "@dohc/workspace-engine-client/daemon";
import {firstOpenRecovery, type FirstOpenCandidateRefusal, type FirstOpenOutcome} from "@dohc/workspace-contracts/first-open";
import {FirstOpenAnswers} from "./firstOpenAnswers";
import {buildFirstOpenBase, MAX_YDOC_UPDATE_BYTES} from "./firstOpenBase";
import {createFirstOpenPublisher, FIRST_OPEN_DEADLINE_WAIT_MS, FIRST_OPEN_WRITER_ATTEMPTS, type FirstOpenBuild, type FirstOpenCheckHost, type FirstOpenNativeCheck} from "./firstOpenPublication";
import {createLiveValidationExecutor} from "./liveValidation";
import {FIRST_OPEN_ORIGIN_PREFIX} from "./relayLogInputs";
import {readFirstOpenHistoryFile, type FirstOpenHistoryReader} from "./storage/firstOpenHistory";
import {firstOpenOrigin} from "./storage/firstOpenEligibility";
import {fenceAccount, initializeAccountDeletion} from "./storage/accountDeletion";
import {activationCaptureBytes, ordinaryActivationReadBytes} from "./storage/ordinaryActivationSource";
import type {StorageContext} from "./storage/context";
import {DEFAULT_WORKSPACE_QUOTA_BYTES} from "./storage";

const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await closeTestStorages();
});

const WS = "workspace-1", OTHER_WS = "workspace-2", OBJECT = "object-1", PATH = "docs/a.md", OWNER = "owner-1";
const key = new Uint8Array(32).fill(23), namespace = "first-open-test";
const MARKDOWN = "# Plan\n\nBring snacks.\n";
const configured = (change: Record<string, unknown> = {}) => parseServiceActivationConfig({...selfHostLiveProfile().service.activation, targets: [], ...change})!;
const inThread: FirstOpenBuild = async (policy, input) => buildFirstOpenBase(policy, input);

type Native = (input: FirstOpenCandidateInput, signal: AbortSignal) => Promise<FirstOpenNativeCheck>;
/** How much longer than the candidate the stand-in says native's full state is, so sizing can't pass on the candidate's length. */
const GROWTH = 7;
/**
 * The engine's verdict, standing in for the native binary that
 * firstOpenPublication.native.test.ts drives: checked within the cap, with a
 * full state a little longer than the candidate.
 */
const accepting: Native = async input => {
  const binding = firstOpenCandidateBinding(input), fullStateByteLength = input.candidate.byteLength + GROWTH;
  return {kind: "answered", current: () => true, check: fullStateByteLength > input.maxFullStateBytes
    ? {status: "too-large", contractVersion: 1, binding, bound: "full-state-encoding", limit: input.maxFullStateBytes}
    : {status: "checked", contractVersion: 1, binding, settledSourceSha256: input.sourceSha256, settledSourceByteLength: input.source.byteLength,
      fullStateSha256: "f".repeat(64), fullStateByteLength}};
};
const refusing = (cause: FirstOpenCandidateRefusal): Native => async input =>
  ({kind: "answered", current: () => true, check: {status: "refused", contractVersion: 1, binding: firstOpenCandidateBinding(input), cause}});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A workspace whose enrolled document has only ordinary text history, and a second
 * workspace. `onRead` runs before each history read, after the route's own standing
 * checks, so what it commits lands between those checks and the writer. `afterRead`
 * runs once a read has its snapshot, so what it commits moves the log past the cutoff.
 */
async function fixture(options: {markdown?: string | Uint8Array; maxDeadlineWaits?: number; admissionIntervalMs?: number} = {}) {
  let reads = 0, onRead: ((read: number) => void) | undefined, afterRead: ((read: number) => void) | undefined, clock = 0;
  let reader: FirstOpenHistoryReader = async read => readFirstOpenHistoryFile(read);
  const storage = await testStorage({firstOpenHistory: async (read, signal) => {
    reads++;
    onRead?.(reads);
    const history = await reader(read, signal);
    afterRead?.(reads);
    return history;
  }});
  const raw = inspectDatabase(storagePath(storage));
  raw.exec("PRAGMA foreign_keys=OFF");
  const seqs = new Map<string, number>();
  const append = (opKind: string, payload: object, {workspaceId = WS, originId = "owner-device"}: {workspaceId?: string; originId?: string} = {}) => {
    const key = `${workspaceId}/${originId}`, originSeq = seqs.get(key) ?? 0;
    seqs.set(key, originSeq + 1);
    storage.appendLogBatch({workspaceId, originId, ops: [{originSeq, opKind, payloadJson: JSON.stringify(payload), recordedAtMs: 1}]});
  };
  let moments = 0;
  /** An ordinary write of the text, as an agent's `versionedText.write` lands on the relay. */
  const writeText = (content: string | Uint8Array, {objectId = OBJECT, path = PATH, workspaceId = WS}: {objectId?: string; path?: string; workspaceId?: string} = {}) => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content, sha256 = sha256Hex(bytes);
    storage.putBlob({workspaceId, sha256, content: bytes, createdAtMs: 1});
    const sourceMomentId = `moment-${++moments}`;
    append("moment.append", {momentId: sourceMomentId, objectId, versionId: "main", operation: "write", path, payloadAfterPath: path,
      payloadAfterBlobSha256: sha256, payloadAfterByteLength: bytes.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1_000 + moments}, {workspaceId});
    return {sourceMomentId, sourceDigest: sha256};
  };
  const share = (shareId: string, access: string, workspaceId = WS) => {
    raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,?,?,0)")
      .run(shareId, workspaceId, OWNER, JSON.stringify({paths: ["docs"], versionId: null}));
    raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','reader-2',NULL,?,1,'active',0,NULL,NULL)`).run(`grant-${shareId}`, shareId, access);
  };
  for (const workspaceId of [WS, OTHER_WS]) {
    expect(storage.claimWorkspace({workspaceId, ownerUserId: OWNER, createdAtMs: 0})).toBe("created");
    storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  }
  // What synthetic Y.Doc rows name.
  storage.putBlob({workspaceId: WS, sha256: "a".repeat(64), content: new Uint8Array([0, 0]), createdAtMs: 1});
  share("share-1", "edit");
  share("share-2", "edit", OTHER_WS);
  let source = writeText(options.markdown ?? MARKDOWN);
  writeText(MARKDOWN, {workspaceId: OTHER_WS});
  const enrollment = storage.enrollServiceHostDocument({workspaceId: WS, ownerUserId: OWNER, shareId: "share-1", path: PATH, nowMs: 10, guard() {}});
  const otherEnrollment = storage.enrollServiceHostDocument({workspaceId: OTHER_WS, ownerUserId: OWNER, shareId: "share-2", path: PATH, nowMs: 10, guard() {}});
  const bearer = deriveServiceHostBearer(enrollment, {key, namespace}), otherBearer = deriveServiceHostBearer(otherEnrollment, {key, namespace});
  let activation: ServiceActivationConfig | undefined = configured(), build = inThread, native = accepting;
  const builds = vi.fn<FirstOpenBuild>((policy, input, signal) => build(policy, input, signal));
  const checks = vi.fn<Native>((input, signal) => native(input, signal));
  let host: FirstOpenCheckHost | undefined = {checkFirstOpenCandidate: (workspaceId, input, signal) => {
    expect(workspaceId).toBe(WS);
    return checks(input, signal);
  }};
  const publisher = createFirstOpenPublisher({storage, namespace, activation: () => activation, host: () => host, build: builds,
    nowMs: () => clock, maxDeadlineWaits: options.maxDeadlineWaits, admissionIntervalMs: options.admissionIntervalMs ?? 0});
  const writes = vi.spyOn(storage, "writeFirstOpen");
  const handle = createServiceHostReplication({storage, prefix: "dohc-service-v1.", hostedFeed: true, firstOpen: publisher,
    authorize: input => authorizeServiceHostReplication(storage, {key, namespace, ...input})});
  const post = (body: Record<string, unknown> = {}, init: {bearer?: string; workspaceId?: string; signal?: AbortSignal; handler?: typeof handle} = {}) =>
    (init.handler ?? handle)(new Request(`https://relay.test/sync/${init.workspaceId ?? WS}/hosted/first-open`, {method: "POST", signal: init.signal,
      headers: {authorization: `Bearer ${init.bearer ?? bearer}`, "content-type": "application/json"},
      body: JSON.stringify({objectId: OBJECT, path: PATH, ...source, replicationEpoch: "epoch", streamIdentity: "stream", ...body})}));
  const open = async (body?: Record<string, unknown>, init?: Parameters<typeof post>[1]) => {
    const response = await post(body, init);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return (JSON.parse(text) as {outcome: FirstOpenOutcome}).outcome;
  };
  const bases = () => raw.prepare("SELECT * FROM sync_relay_log WHERE origin_id LIKE 'service-host:first-open:%' ORDER BY relay_seq").all();
  const head = () => raw.prepare("SELECT max(relay_seq) AS head FROM sync_relay_log WHERE workspace_id=?").get(WS)!.head;
  return {storage, raw, append, writeText, share, enrollment, bearer, otherBearer, handle, post, open, bases, head, builds, writes, checks,
    get source() { return source; }, set source(value) { source = value; },
    readWith(next: FirstOpenHistoryReader) { reader = next; }, onRead(next?: (read: number) => void) { onRead = next; },
    afterRead(next?: (read: number) => void) { afterRead = next; },
    setActivation(next: ServiceActivationConfig | undefined) { activation = next; }, buildWith(next: FirstOpenBuild) { build = next; },
    checkWith(next: Native) { native = next; }, setHost(next: FirstOpenCheckHost | undefined) { host = next; },
    advance(ms: number) { clock += ms; }, get reads() { return reads; }};
}

const published = (outcome: FirstOpenOutcome) => {
  if (outcome.kind !== "published" && outcome.kind !== "replayed") throw new Error(`Expected a receipt, got ${JSON.stringify(outcome)}.`);
  return outcome.receipt;
};
const nothingAppended = (f: Fixture) => expect(f.bases()).toEqual([]);

it("gives an ordinary document its first live base: one unauthored row and its blob, at the reserved coordinate", async () => {
  const f = await fixture(), before = f.head(), outcome = await f.open();
  expect(outcome).toMatchObject({kind: "published", recovery: "pull",
    source: {workspaceId: WS, objectId: OBJECT, path: PATH, ...f.source}});
  const receipt = published(outcome), rows = f.bases();
  expect(rows).toHaveLength(1);
  const [row] = rows, payload = JSON.parse(String(row!.payload_json));
  expect(row).toMatchObject({workspace_id: WS, origin_id: receipt.originId, origin_seq: 0, relay_seq: receipt.relaySeq, op_kind: "ydoc.update",
    recorded_at_ms: 1_001, admitted_author_snapshot_json: null, settlement_admission_json: null, relay_admission: null});
  expect(Number(row!.relay_seq)).toBeGreaterThan(Number(before));
  expect(payload).toEqual({versionId: "main", objectId: OBJECT, path: PATH, contentKind: "richdoc", isBaseState: true,
    updateBlobSha256: payload.updateBlobSha256, lineageClaimId: payload.updateBlobSha256});
  expect(receipt.originId).toBe(firstOpenOrigin(namespace, {workspaceId: WS, objectId: OBJECT, path: PATH, ...f.source, sourceByteLength: 0},
    {replicationEpoch: "epoch", streamIdentity: "stream"}));
  // The base is the desktop's seed for the file, and settles to it.
  const base = f.storage.getBlob(WS, payload.updateBlobSha256)!, doc = new Y.Doc();
  try { Y.applyUpdate(doc, base); expect(yDocToArtifactMarkdown(doc)).toBe(MARKDOWN); } finally { doc.destroy(); }
  // No human edit, replacement moment or journal event; the ordinary write keeps its own record.
  expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=?").get(WS, OBJECT)!.n).toBe(1);
  expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_live_update_journal").get()!.n).toBe(0);
  expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_live_documents").get()!.n).toBe(0);
});

it("builds on the first-open worker unless a test injects another builder", async () => {
  const f = await fixture(), pool = createLiveValidationExecutor();
  pools.push(pool);
  f.buildWith((policy, input, signal) => pool.buildFirstOpenBase(policy, input, signal));
  expect((await f.open()).kind).toBe("published");
  expect(f.builds.mock.calls[0]![0]).toEqual(selfHostLiveProfile().service.activation.validation);
});

it("replays a lost reply after a newer head, another converter, reduced bounds and with no engine, without building or checking again", async () => {
  const f = await fixture(), first = published(await f.open()), asked = f.source;
  expect(await f.open()).toMatchObject({kind: "replayed", receipt: first, recovery: "pull"});
  f.source = f.writeText("# Plan\n\nBring snacks and drinks.\n");
  f.buildWith(async () => { throw new Error("the converter changed"); });
  f.setActivation(configured({maxCaptureBytes: 1, maxBytesPerDrain: 1}));
  f.setHost(undefined);
  expect(await f.open(asked)).toMatchObject({kind: "replayed", receipt: first});
  f.setHost({checkFirstOpenCandidate: async () => ({kind: "unavailable", reason: "host-unreachable"})});
  expect(await f.open(asked)).toMatchObject({kind: "replayed", receipt: first});
  expect(f.builds).toHaveBeenCalledTimes(1);
  expect(f.checks).toHaveBeenCalledTimes(1);
  expect(f.bases()).toHaveLength(1);
  // The newer head has history now: it gets no base of its own.
  f.setActivation(configured());
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority", recovery: "pull"});
});

it("converges concurrent requests to one receipt", async () => {
  const f = await fixture();
  const outcomes = await Promise.all(Array.from({length: 6}, () => f.open()));
  expect(f.bases()).toHaveLength(1);
  const receipt = {originId: f.bases()[0]!.origin_id, originSeq: 0, relaySeq: f.bases()[0]!.relay_seq};
  expect(outcomes.filter(outcome => outcome.kind === "published")).toHaveLength(1);
  for (const outcome of outcomes) expect(outcome).toMatchObject({kind: expect.stringMatching(/^(published|replayed)$/), receipt});
});

it("replays a receipt another request committed after this one's first look", async () => {
  const f = await fixture();
  let other: FirstOpenOutcome | undefined, first = true;
  // The other request runs whole after this one's replay probe, before this one's history read.
  f.readWith(async read => {
    if (first) { first = false; other = await f.open(); }
    return readFirstOpenHistoryFile(read);
  });
  const outcome = await f.open();
  expect(other).toMatchObject({kind: "published"});
  expect(outcome).toMatchObject({kind: "replayed", receipt: published(other!)});
  expect(f.bases()).toHaveLength(1);
});

it("replays a receipt another request committed before an ordinary write made this one's source stale", async () => {
  const f = await fixture();
  let other: FirstOpenOutcome | undefined;
  // While this request builds, the other publishes this source's base, then the file changes.
  f.buildWith(async (policy, input) => {
    f.buildWith(inThread);
    other = await f.open();
    f.writeText("# Plan\n\nBring drinks.\n");
    return buildFirstOpenBase(policy, input);
  });
  const outcome = await f.open();
  expect(other).toMatchObject({kind: "published"});
  expect(outcome).toMatchObject({kind: "replayed", receipt: published(other!)});
  expect(f.bases()).toHaveLength(1);
});

it("replays a receipt another request committed during this one's last catch-up", async () => {
  const f = await fixture();
  let other: FirstOpenOutcome | undefined, own = 0;
  // This request's first two reads see the workspace move; its third takes its snapshot, then the other publishes.
  f.readWith(async read => {
    const history = readFirstOpenHistoryFile(read);
    own++;
    if (own < FIRST_OPEN_WRITER_ATTEMPTS) f.writeText(`chat ${own}`, {objectId: `object-chat-${own}`, path: `chat/${own}.md`});
    else if (own === FIRST_OPEN_WRITER_ATTEMPTS) other = await f.open();
    return history;
  });
  const outcome = await f.open();
  expect(other).toMatchObject({kind: "published"});
  expect(outcome).toMatchObject({kind: "replayed", receipt: published(other!)});
  expect(f.writes).toHaveBeenCalledTimes(FIRST_OPEN_WRITER_ATTEMPTS + 1);
  expect(f.bases()).toHaveLength(1);
});

it("replays a base published over a moment ID the log holds twice, at the time of the row it was published over", async () => {
  const f = await fixture(), bytes = new TextEncoder().encode(MARKDOWN).byteLength;
  f.append("moment.append", {momentId: f.source.sourceMomentId, objectId: OBJECT, versionId: "main", operation: "write", path: PATH, payloadAfterPath: PATH,
    payloadAfterBlobSha256: f.source.sourceDigest, payloadAfterByteLength: bytes, payloadAfterContentKind: "text", recordedAtMs: 5_000});
  const receipt = published(await f.open());
  expect(f.bases()[0]).toMatchObject({recorded_at_ms: 5_000});
  expect(await f.open()).toMatchObject({kind: "replayed", receipt});
  // The same moment again after the base does not change which row the base was published over.
  f.append("moment.append", {momentId: f.source.sourceMomentId, objectId: OBJECT, versionId: "main", operation: "write", path: PATH, payloadAfterPath: PATH,
    payloadAfterBlobSha256: f.source.sourceDigest, payloadAfterByteLength: bytes, payloadAfterContentKind: "text", recordedAtMs: 9_000});
  expect(await f.open()).toMatchObject({kind: "replayed", receipt});
});

it("refuses squatting on the reserved coordinate, then publishes there", async () => {
  const f = await fixture();
  const originId = firstOpenOrigin(namespace, {workspaceId: WS, objectId: OBJECT, path: PATH, ...f.source, sourceByteLength: 0},
    {replicationEpoch: "epoch", streamIdentity: "stream"});
  const squat = await f.handle(new Request(`https://relay.test/sync/${WS}/hosted/log`, {method: "POST",
    headers: {authorization: `Bearer ${f.bearer}`, "content-type": "application/json"}, body: JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream",
      originId, ops: [{originSeq: 0, opKind: "ydoc.update", recordedAtMs: 1_001, payload: {versionId: "main", objectId: OBJECT, path: PATH,
        contentKind: "richdoc", updateBlobSha256: f.source.sourceDigest, lineageClaimId: f.source.sourceDigest, isBaseState: false}}]})}));
  expect(squat.status).toBe(400);
  expect(await squat.text()).toContain("reserved for relay first-open bases");
  expect(f.storage.maxOriginSeq(WS, originId)).toBe(-1);
  expect(published(await f.open()).originId).toBe(originId);
});

it("reports unexpected contents at the reserved coordinate and never writes over them", async () => {
  const f = await fixture(), receipt = published(await f.open());
  f.raw.prepare("UPDATE sync_relay_log SET recorded_at_ms=7 WHERE relay_seq=?").run(receipt.relaySeq);
  expect(await f.open()).toMatchObject({kind: "integrity", reason: "reserved-receipt", recovery: "report"});
  f.raw.prepare("DELETE FROM sync_relay_log WHERE relay_seq=?").run(receipt.relaySeq);
  f.raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_admission)
    VALUES (?,?,0,'relay.refused','{}',1,'refused')`).run(WS, receipt.originId);
  expect(await f.open()).toMatchObject({kind: "integrity", reason: "reserved-receipt"});
  expect(f.raw.prepare("SELECT op_kind FROM sync_relay_log WHERE origin_id=?").all(receipt.originId)).toEqual([{op_kind: "relay.refused"}]);
});

it("answers only the service host's credential, under the hosted feed", async () => {
  const f = await fixture();
  const route = (method: string, pathname: string) => ({workspaceId: WS, method, pathname});
  expect(serviceHostFeedRoute(route("POST", `/sync/${WS}/hosted/first-open`))).toBe(true);
  for (const [method, pathname] of [["GET", `/sync/${WS}/hosted/first-open`], ["POST", `/sync/${WS}/hosted/first-open/x`], ["POST", `/sync/other/hosted/first-open`]]) {
    expect(serviceHostFeedRoute(route(method!, pathname!))).toBe(false);
  }
  // The shapes automation and replica credentials share never include it.
  for (const pathname of [`/sync/${WS}/first-open`, `/sync/${WS}/hosted/first-open`]) expect(serviceHostReplicationRoute(route("POST", pathname))).toBe(false);
  const automation = createServiceHostReplication({storage: f.storage, prefix: "dohc-automation-v1.", authorize: () => OWNER});
  expect((await f.post({}, {handler: automation, bearer: "dohc-automation-v1.token"})).status).toBe(404);
  const principal = createReplicaReadPrincipal(f.storage), replica = principal.issue(WS, "first-open");
  expect((await f.post({}, {handler: principal.handle, bearer: replica.bearer})).status).toBe(404);
  // A hosted feed configured without publication has no such route.
  const plain = createServiceHostReplication({storage: f.storage, prefix: "dohc-service-v1.", hostedFeed: true,
    authorize: input => authorizeServiceHostReplication(f.storage, {key, namespace, ...input})});
  expect((await f.post({}, {handler: plain})).status).toBe(404);
  // Another workspace's credential, and an unknown one.
  expect((await f.post({}, {bearer: f.otherBearer})).status).toBe(404);
  expect((await f.post({}, {bearer: `dohc-service-v1.${"A".repeat(43)}`})).status).toBe(404);
  expect(f.reads).toBe(0);
  nothingAppended(f);
});

it("takes only the source and the replication identity from the caller", async () => {
  const f = await fixture();
  for (const extra of [{bytes: "AAAA"}, {lineageClaimId: "a".repeat(64)}, {originId: `${FIRST_OPEN_ORIGIN_PREFIX}x`}, {recordedAtMs: 1},
    {authorContext: {kind: "account", accountId: OWNER}}, {maxCaptureBytes: 1}, {reader: "x"}, {afterRelaySeq: 0}]) {
    expect((await f.post(extra)).status, Object.keys(extra)[0]).toBe(400);
  }
  for (const wrong of [{path: "docs/a.txt"}, {path: "../a.md"}, {sourceDigest: "A".repeat(64)}, {objectId: ""}, {replicationEpoch: "epoch", streamIdentity: undefined}]) {
    expect((await f.post(wrong)).status, JSON.stringify(wrong)).toBe(400);
  }
  expect(f.reads).toBe(0);
  nothingAppended(f);
});

it("takes the document from its enrollment: another object, path or identity is refused before any read", async () => {
  const f = await fixture();
  f.writeText("other", {objectId: "object-2", path: "docs/b.md"});
  for (const body of [{objectId: "object-2"}, {objectId: "object-2", path: "docs/b.md"}, {path: "docs/c.md"}]) {
    expect((await f.post(body)).status, JSON.stringify(body)).toBe(404);
  }
  expect((await f.post({replicationEpoch: "epoch-0"})).status).toBe(409);
  expect((await f.post({streamIdentity: "stream-0"})).status).toBe(409);
  expect(f.reads).toBe(0);
  expect(f.builds).not.toHaveBeenCalled();
  nothingAppended(f);
});

type Change = [string, (f: Fixture) => void];
const FENCE_KEY = "first-open-route-fence";
const lostStanding: Change[] = [
  ["View-only access", f => f.raw.prepare("UPDATE sync_relay_share_grants SET access='view' WHERE share_id='share-1'").run()],
  ["the last Edit grant revoked", f => f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id='share-1'").run()],
  ["the owner's Pause", f => f.storage.setServiceHostEnrollmentEnabled({workspaceId: WS, path: PATH, ownerUserId: OWNER, enabled: false, nowMs: 20, guard() {}})],
  ["the owner's Stop", f => f.storage.setServiceHostEnrollmentEnabled({workspaceId: WS, path: PATH, ownerUserId: OWNER, enabled: false, retire: true, nowMs: 20, guard() {}})],
  ["the document moved", f => { f.writeText(MARKDOWN, {path: "docs/b.md"}); }],
  ["the document replaced at its path", f => { f.writeText(MARKDOWN, {objectId: "object-2"}); }],
  ["its owner's account fenced", f => {
    initializeAccountDeletion(f.storage as StorageContext, FENCE_KEY);
    expect(fenceAccount(f.storage as StorageContext, FENCE_KEY, OWNER, `${OWNER}@dohc.test`).phase).toBe("fenced");
  }],
  ["the workspace tombstoned", f => {
    initializeAccountDeletion(f.storage as StorageContext, FENCE_KEY);
    f.raw.prepare("INSERT INTO sync_relay_deleted_workspaces VALUES (?)").run(accountDeletionIdentity(FENCE_KEY, `workspace:${WS}`));
  }],
];
it.each(lostStanding)("refuses before reading anything after %s", async (_, change) => {
  const f = await fixture();
  change(f);
  expect((await f.post()).status).toBe(404);
  expect(f.reads).toBe(0);
  nothingAppended(f);
});
it.each(lostStanding)("appends nothing when %s lands between the route's checks and the writer", async (_, change) => {
  const f = await fixture();
  f.onRead(() => { change(f); f.onRead(); });
  expect((await f.post()).status).toBe(404);
  expect(f.reads).toBe(1);
  nothingAppended(f);
});
// The writer's own checks alone: the change lands after the base is built.
it.each(lostStanding)("appends nothing when %s lands after the base is built", async (_, change) => {
  const f = await fixture();
  f.buildWith(async (policy, input) => { const built = buildFirstOpenBase(policy, input); change(f); return built; });
  expect((await f.post()).status).toBe(404);
  nothingAppended(f);
});
it.each(lostStanding)("appends nothing when %s lands after the engine checked", async (_, change) => {
  const f = await fixture();
  f.checkWith(async (input, signal) => { const answer = await accepting(input, signal); change(f); return answer; });
  expect((await f.post()).status).toBe(404);
  expect(f.checks).toHaveBeenCalledTimes(1);
  nothingAppended(f);
});

it("refuses a stale source and a source changed before the writer, and discards the preparation", async () => {
  const f = await fixture(), asked = f.source;
  f.source = f.writeText("# Plan\n\nNew text.\n");
  expect(await f.open(asked)).toMatchObject({kind: "refused", reason: "stale-source", recovery: "pull-current-source"});
  expect(f.builds).not.toHaveBeenCalled();
  // Changed after the base was built.
  f.buildWith(async (policy, input) => { const built = buildFirstOpenBase(policy, input); f.writeText("# Plan\n\nNewer.\n"); return built; });
  expect(await f.open()).toMatchObject({kind: "refused", reason: "stale-source"});
  nothingAppended(f);
});

it("refuses a deleted and restored document for good", async () => {
  const f = await fixture();
  f.append("moment.append", {momentId: "delete-1", objectId: OBJECT, versionId: "main", operation: "delete", path: PATH, beforePath: PATH,
    payloadBeforePath: PATH, payloadBeforeBlobSha256: f.source.sourceDigest, payloadAfterPath: null, payloadAfterBlobSha256: null, recordedAtMs: 1_100});
  f.source = f.writeText(MARKDOWN);
  expect(await f.open()).toMatchObject({kind: "refused", reason: "deletion", recovery: "none"});
  nothingAppended(f);
});

// Proves: a host that restarted holds no answers, so it asks once, and the
// relay's history alone answers deletion again. That exclusion then holds for
// a later edit, which the host never asks about.
it("rebuilds a deletion's exclusion from relay history after its host restarts", async () => {
  const f = await fixture(), context = {policy: "policy", bounds: "bounds"};
  f.append("moment.append", {momentId: "delete-1", objectId: OBJECT, versionId: "main", operation: "delete", path: PATH, beforePath: PATH,
    payloadBeforePath: PATH, payloadBeforeBlobSha256: f.source.sourceDigest, payloadAfterPath: null, payloadAfterBlobSha256: null, recordedAtMs: 1_100});
  f.source = f.writeText(MARKDOWN);
  const source = () => ({workspaceId: WS, objectId: OBJECT, path: PATH, ...f.source});
  new FirstOpenAnswers().record(await f.open(), context);
  const restarted = new FirstOpenAnswers(), reads = f.reads;
  expect(restarted.standing(source(), context)).toBeUndefined();
  restarted.record(await f.open(), context);
  expect(f.reads).toBe(reads + 1);
  f.source = f.writeText("# Plan\n\nRestored, then edited.\n");
  expect(restarted.standing(source(), context)).toMatchObject({kind: "refused", reason: "deletion"});
  expect(restarted.refusal(source(), context)).toMatchObject({reason: "deletion", recovery: "none"});
  nothingAppended(f);
});

it("refuses a deletion committed while the base was being built", async () => {
  const f = await fixture();
  f.buildWith(async (policy, input) => {
    const built = buildFirstOpenBase(policy, input);
    // Displaced, then back at its path as the current source.
    f.append("moment.append", {momentId: "replace-1", objectId: "object-3", versionId: "main", operation: "write", path: "docs/z.md", payloadAfterPath: "docs/z.md",
      payloadAfterBlobSha256: f.source.sourceDigest, payloadAfterByteLength: 1, payloadAfterContentKind: "text", recordedAtMs: 1_100,
      beforePresent: "present", beforeObjectId: OBJECT, beforeVersionId: "main", beforePath: "docs/z.md"});
    return built;
  });
  expect(await f.open()).toMatchObject({kind: "refused", reason: "deletion"});
  nothingAppended(f);
});

const ydoc = (change: {isBaseState: boolean}) => ({versionId: "main", objectId: OBJECT, path: PATH, contentKind: "richdoc",
  updateBlobSha256: "a".repeat(64), lineageClaimId: "a".repeat(64), ...change});
const priorAuthority: Change[] = [
  ["an owner base", f => f.append("ydoc.update", ydoc({isBaseState: true}))],
  ["an accepted explicit-false delta without a base", f => f.append("ydoc.update", ydoc({isBaseState: false}))],
  ["an audit row alone", f => f.raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
    VALUES (?,'service-host:stored',0,'live.audit.application',?,1)`).run(WS, JSON.stringify({objectId: OBJECT, mainVersionId: "main", updateBlobSha256: "a".repeat(64)}))],
  ["a retired baseline registration", f => f.raw.prepare(`INSERT INTO sync_relay_live_documents VALUES (?,'main',?,?,NULL,'docs/old.md',1,?,1,?,?,'retired','closed',0,0,5)`)
    .run(WS, OBJECT, "a".repeat(64), "b".repeat(64), "a".repeat(64), new Uint8Array([0, 0]))],
  ["an ordinary activation basis", f => f.raw.prepare(`INSERT INTO sync_relay_live_document_ordinary_bases VALUES (?,'main',?,?,1,'owner-device',0,'old','old','docs/old.md',?,0,1)`)
    .run(WS, OBJECT, "a".repeat(64), "b".repeat(64))],
  ["a retained service activation", f => f.raw.prepare(`INSERT INTO sync_relay_service_activations VALUES ('namespace','activation-1',?,'main',?,?,'{}','{}',?,?,?,'share-1',NULL,1)`)
    .run(WS, OBJECT, "a".repeat(64), "d".repeat(64), new Uint8Array([0, 0]), OWNER)],
  ["a Stop/restore operation", f => f.raw.prepare(`INSERT INTO sync_relay_live_restore_operations(operation_id,relay_database_namespace,workspace_id,main_version_id,object_id,
    lineage_claim_id,intent_json,basis_json,terminal_json,applied_json,native_receipt_json,phase,old_fence,new_fence,cutover_cursor,revoked_generation,invalidated_at_ms,fenced_at_ms,accounted_bytes)
    VALUES ('restore-1','namespace-2',?,'main',?,?,'{}','{}','{}','{}','{}','resumed',1,2,0,2,0,0,1)`).run(WS, OBJECT, "a".repeat(64))],
];
it.each(priorAuthority)("answers existing history, appending nothing, after %s", async (_, add) => {
  const f = await fixture();
  add(f);
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority", recovery: "pull"});
  nothingAppended(f);
});
it.each(priorAuthority)("appends nothing when %s commits while the base is built", async (_, add) => {
  const f = await fixture();
  f.buildWith(async (policy, input) => { const built = buildFirstOpenBase(policy, input); add(f); return built; });
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  nothingAppended(f);
});

it.each([
  "malformed-candidate", "incomplete-candidate", "invalid-public-baseline", "projection-failed", "settlement-mismatch",
] as const)("refuses a source the engine refuses with %s, names that cause and keeps its exact bytes", async cause => {
  const markdown = "See <https://example.com/b>.\n", f = await fixture({markdown});
  f.checkWith(refusing(cause));
  expect(await f.open()).toMatchObject({kind: "refused", reason: "unsupported-source", cause, recovery: "none"});
  expect(new TextDecoder().decode(f.storage.getBlob(WS, f.source.sourceDigest)!)).toBe(markdown);
  expect(f.writes).not.toHaveBeenCalled();
  nothingAppended(f);
});

it("refuses a source that is not UTF-8, or that the relay's validator reads differently, before asking the engine", async () => {
  const f = await fixture({markdown: new Uint8Array([0x23, 0x20, 0xff, 0x0a])});
  expect(await f.open()).toMatchObject({kind: "refused", reason: "unsupported-source", cause: "not-utf8", recovery: "none"});
  // A projection regression looks the same, so it is logged.
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const g = await fixture();
  g.buildWith(async () => ({kind: "refused", reason: "unsupported-source"}));
  expect(await g.open()).toMatchObject({kind: "refused", reason: "unsupported-source", cause: "relay-projection"});
  expect(logged).toHaveBeenLastCalledWith("[sync-relay] first-open candidate invalid", "unsupported-source", g.source.sourceDigest);
  for (const fixture of [f, g]) { expect(fixture.checks).not.toHaveBeenCalled(); nothingAppended(fixture); }
});

it.each([
  ["empty Markdown", ""],
  ["Unicode", "# Café 🎉\n\nnaïve 中文 — ok\n"],
  ["frontmatter", "---\ntitle: Plan\nnested:\n  count: 3\n---\n\nBody\n"],
  ["a source witness", "* one\n* two\n"],
  ["`&` in fenced code, which the blanket guard refused", "Title\n=====\n\n```rust\nlet x = &mut y;\n```\n"],
])("publishes %s once the engine checks it", async (_, markdown) => {
  const f = await fixture({markdown});
  const receipt = published(await f.open()), payload = JSON.parse(String(f.bases()[0]!.payload_json));
  // The checked candidate is the committed base, byte for byte.
  const [checked] = f.checks.mock.calls[0]!;
  const base = f.storage.getBlob(WS, payload.updateBlobSha256)!;
  expect(Buffer.from(base).equals(Buffer.from(checked.candidate))).toBe(true);
  expect(payload.updateBlobSha256).toBe(checked.candidateSha256);
  expect(Buffer.from(checked.source).toString()).toBe(markdown);
  expect(receipt.originSeq).toBe(0);
});

it("checks every new candidate, and publishes nothing the engine did not check", async () => {
  const f = await fixture();
  f.checkWith(async () => { throw new Error("the engine is not asked"); });
  await expect(f.post().then(response => response.json())).resolves.toMatchObject({ok: false, code: "internal_error"});
  // An answer about another candidate or source is no check of this one.
  f.checkWith(async input => accepting({...input, candidateSha256: "b".repeat(64)}, new AbortController().signal));
  expect(await f.open()).toMatchObject({kind: "integrity", reason: "check-evidence", recovery: "report"});
  f.checkWith(async input => accepting({...input, sourceMomentId: "other"}, new AbortController().signal));
  expect(await f.open()).toMatchObject({kind: "integrity", reason: "check-evidence"});
  f.checkWith(async () => ({kind: "integrity"}));
  expect(await f.open()).toMatchObject({kind: "integrity", reason: "check-evidence"});
  expect(f.writes).not.toHaveBeenCalled();
  nothingAppended(f);
});

it("writes only the bytes the engine checked", async () => {
  const f = await fixture();
  f.checkWith(async (input, signal) => {
    const answer = await accepting(input, signal);
    input.candidate[input.candidate.length - 1] ^= 1;
    return answer;
  });
  expect(await f.open()).toMatchObject({kind: "integrity", reason: "check-evidence"});
  expect(f.writes).toHaveBeenCalledTimes(1);
  nothingAppended(f);
});

it("tells the engine's absence, failures and limits apart, appends nothing for any, and asks again only for those that can pass", async () => {
  const f = await fixture();
  f.setHost(undefined);
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "host-absent", recovery: "retry-later"});
  f.setHost({checkFirstOpenCandidate: (_workspaceId, input, signal) => f.checks(input, signal)});
  for (const reason of ["host-absent", "host-unreachable", "check-failed", "check-deadline", "busy"] as const) {
    f.checkWith(async () => ({kind: "unavailable", reason}));
    expect(await f.open(), reason).toMatchObject({kind: "unavailable", reason, recovery: "retry-later"});
  }
  // A check the host's configuration can never admit refuses this file until its operator raises it.
  f.checkWith(async () => ({kind: "host-capacity"}));
  expect(await f.open()).toMatchObject({kind: "refused", reason: "too-large", code: "host-capacity", recovery: "none"});
  // The host that checked retired or detached the workspace before the writer.
  f.checkWith(async (input, signal) => ({...await accepting(input, signal), current: () => false}));
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "host-absent", recovery: "retry-later"});
  expect(f.writes).toHaveBeenCalledTimes(1);
  nothingAppended(f);
  // A cancelled check stays cancelled.
  const abort = new AbortController();
  f.checkWith(async (_input, signal) => { abort.abort(new Error("cancelled")); signal.throwIfAborted(); throw new Error("not cancelled"); });
  const response = await f.post({}, {signal: abort.signal});
  expect(response.status).not.toBe(200);
  expect(await response.json()).not.toHaveProperty("outcome");
  nothingAppended(f);
});

it("checks outside the writer, while the relay keeps writing", async () => {
  const f = await fixture();
  f.checkWith(async (input, signal) => {
    expect((f.storage as StorageContext).db.isTransaction).toBe(false);
    // Another workspace's write commits while the check runs.
    f.writeText("elsewhere", {workspaceId: OTHER_WS, objectId: "object-elsewhere", path: "docs/elsewhere.md"});
    return accepting(input, signal);
  });
  expect((await f.open()).kind).toBe("published");
  expect(f.checks).toHaveBeenCalledTimes(1);
});

it("reuses the check when only the workspace moves, and checks again for a changed source", async () => {
  const f = await fixture();
  f.afterRead(read => { if (read < FIRST_OPEN_WRITER_ATTEMPTS) f.writeText(`chat ${read}`, {objectId: `object-chat-${read}`, path: `chat/${read}.md`}); });
  expect((await f.open()).kind).toBe("published");
  expect(f.writes).toHaveBeenCalledTimes(FIRST_OPEN_WRITER_ATTEMPTS);
  expect(f.checks).toHaveBeenCalledTimes(1);
  // The file changes while the engine checks: the check answers for the old bytes only.
  const g = await fixture();
  g.checkWith(async (input, signal) => { g.writeText("# Plan\n\nNewer.\n"); return accepting(input, signal); });
  expect(await g.open()).toMatchObject({kind: "refused", reason: "stale-source", recovery: "pull-current-source"});
  nothingAppended(g);
});

it("asks the engine for no more than the least remaining update, capture or read allowance, and refuses past it", async () => {
  // The bounds the route builds against, what it asked, and native's measured full state.
  const probe = await fixture();
  let seen: Parameters<FirstOpenBuild>[1] | undefined;
  probe.buildWith(async (policy, input) => { seen = input; return buildFirstOpenBase(policy, input); });
  expect((await probe.open()).kind).toBe("published");
  const {candidate} = probe.checks.mock.calls[0]![0];
  const B = candidate.byteLength, F = B + GROWTH, {descriptorBytes, logEntryBytes} = seen!.bounds;
  const capture = activationCaptureBytes(B, F, descriptorBytes);
  const reads = ordinaryActivationReadBytes({baselineBytes: B, entryBytes: [logEntryBytes], updateBytes: [B], fullStateBytes: F});
  expect(reads).toBe(3 * B + logEntryBytes + F + 2);
  const at = async (change: Record<string, unknown>) => {
    const f = await fixture();
    f.setActivation(configured(change));
    const outcome = await f.open();
    return {outcome, cap: f.checks.mock.calls[0]?.[0].maxFullStateBytes, f};
  };
  // At each bound the engine may encode exactly F; one byte less and it stops short.
  for (const [change, bound] of [[{maxCaptureBytes: capture}, "capture-budget"], [{maxBytesPerDrain: reads}, "read-budget"]] as const) {
    const fits = await at(change);
    expect(fits.cap).toBe(F);
    expect(fits.outcome.kind).toBe("published");
    const short = await at(Object.fromEntries(Object.entries(change).map(([name, value]) => [name, value - 1])));
    expect(short.cap).toBe(F - 1);
    expect(short.outcome).toMatchObject({kind: "refused", reason: "too-large", code: bound, recovery: "none"});
    nothingAppended(short.f);
  }
  // Generous bounds leave the engine's own update limit.
  expect((await at({maxCaptureBytes: 2 * MAX_YDOC_UPDATE_BYTES, maxBytesPerDrain: 4 * MAX_YDOC_UPDATE_BYTES})).cap).toBe(MAX_YDOC_UPDATE_BYTES);
  // A base that leaves no room is refused before the engine is asked.
  const none = await at({maxCaptureBytes: B + descriptorBytes + 1});
  expect(none.outcome).toMatchObject({kind: "refused", reason: "too-large", code: "capture-budget"});
  expect(none.f.checks).not.toHaveBeenCalled();
  const oversized = await fixture();
  vi.spyOn(richdocSeed, "encodeRichdocSeed").mockReturnValueOnce(new Uint8Array(MAX_YDOC_UPDATE_BYTES + 1).fill(0xff));
  expect(await oversized.open()).toMatchObject({kind: "refused", reason: "too-large", code: "update-limit"});
  // Bounds reduced after the engine measured still apply in the writer, against its measurement.
  const reduced = await fixture();
  reduced.checkWith(async (input, signal) => { const answer = await accepting(input, signal); reduced.setActivation(configured({maxCaptureBytes: capture - 1})); return answer; });
  expect(await reduced.open()).toMatchObject({kind: "refused", reason: "too-large", code: "capture-budget"});
  for (const f of [oversized, reduced]) nothingAppended(f);
});

it("refuses a valid base the validation policy cannot afford as too large, a file the live schema cannot hold as unsupported, and an invalid base by its fault", async () => {
  const f = await fixture();
  f.setActivation(configured({validation: {...selfHostLiveProfile().service.activation.validation, maxStructVisits: 1}}));
  expect(await f.open()).toMatchObject({kind: "refused", reason: "too-large", code: "validation-budget", recovery: "none"});
  nothingAppended(f);
  // The same seed under the configured policy publishes.
  f.setActivation(configured());
  expect((await f.open()).kind).toBe("published");
  // A link around inline code, as eight real notes have, stays an ordinary file. It is logged, since a relay fault looks the same.
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const g = await fixture({markdown: "See [`lock()`](https://example.com/lock).\n"});
  expect(await g.open()).toMatchObject({kind: "refused", reason: "unsupported-source", cause: "relay-projection", recovery: "none"});
  expect(logged).toHaveBeenLastCalledWith("[sync-relay] first-open candidate invalid", "invalid-schema", g.source.sourceDigest);
  expect(g.checks).not.toHaveBeenCalled();
  nothingAppended(g);
  // A seed that is no valid update, or that the encoder failed to build, is the relay's own fault.
  for (const [fault, encode] of [["invalid-update", () => Uint8Array.of(0xff, 0xff, 0xff)], ["seed-encoder", () => { throw new Error("an encoder bug"); }]] as const) {
    const h = await fixture();
    vi.spyOn(richdocSeed, "encodeRichdocSeed").mockImplementationOnce(encode);
    expect(await h.open(), fault).toMatchObject({kind: "integrity", reason: "candidate", recovery: "report"});
    expect(logged).toHaveBeenLastCalledWith("[sync-relay] first-open candidate invalid", fault, h.source.sourceDigest);
    nothingAppended(h);
  }
});

// The note's own nesting decides the refusal, so it is no fault of the relay's
// and sets no wait: the same bytes answer the same way at once.
it.each([
  ["nested past the contract", `${">".repeat(121)} a\n`],
  ["past the lexing budget", `${">".repeat(120)} a\n===\n\n`.repeat(16)],
])("refuses a note %s as unsupported, publishing nothing and setting no wait", async (_name, markdown) => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture({markdown});
  for (const attempt of [1, 2]) {
    expect(await f.open()).toMatchObject({kind: "refused", reason: "unsupported-source", cause: "relay-projection", recovery: "none"});
    expect(f.builds).toHaveBeenCalledTimes(attempt);
  }
  expect(logged).toHaveBeenLastCalledWith("[sync-relay] first-open candidate invalid", "unsupported-source", f.source.sourceDigest);
  expect(f.checks).not.toHaveBeenCalled();
  nothingAppended(f);
});

// Yjs spreads a new element's children as call arguments, which overflowed a
// main thread's stack past about 124,000 of them (a worker's, past 498,000).
it("builds a seed for a paragraph with more hard breaks than Yjs can spread, and refuses it only by size", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture({markdown: `a${"\\\n".repeat(200_000)}a\n`});
  expect(await f.open()).toMatchObject({kind: "refused", reason: "too-large", code: "read-budget", recovery: "none"});
  expect(logged).not.toHaveBeenCalled();
  expect(f.checks).not.toHaveBeenCalled();
  nothingAppended(f);
});

it("refuses for good a note whose seed runs the first-open worker out of memory, and frees its slot first", async () => {
  const f = await fixture({markdown: `a${"\\\n".repeat(520_000)}a\n`}), pool = createLiveValidationExecutor();
  pools.push(pool);
  const validate = pool.validator(selfHostLiveProfile().service.activation.validation);
  const live = {document: {workspaceId: WS, mainVersionId: "main" as const, objectId: OBJECT, lineageClaimId: "lineage"}, currentPath: PATH,
    checkpoint: richdocSeed.encodeRichdocSeed(MARKDOWN, 1), suffix: [], candidate: Uint8Array.of(0, 0)};
  // Both slots take live validation at once, as soon as the build answers.
  let following: Promise<string[]> | undefined;
  f.buildWith(async (policy, input, signal) => {
    const built = await pool.buildFirstOpenBase(policy, input, signal);
    following = Promise.all([validate(live), validate(live)]).then(results => results.map(result => result.kind));
    return built;
  });
  expect(await f.open()).toMatchObject({kind: "refused", reason: "too-large", code: "seed-worker-capacity", recovery: "none"});
  expect(await following).toEqual(["accepted", "accepted"]);
  expect(f.checks).not.toHaveBeenCalled();
  nothingAppended(f);
  const g = await fixture();
  g.buildWith((policy, input, signal) => pool.buildFirstOpenBase(policy, input, signal));
  expect((await g.open()).kind).toBe("published");
}, 60_000);

// A slow host says nothing about whether the note fits, so a build that passes
// its deadline is asked again later, never refused.
it("answers a build that passes its deadline as transient, and frees its slot first", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  // A deadline of 0 passes long before a new worker can start and answer.
  const f = await fixture(), pool = createLiveValidationExecutor(undefined, undefined, {firstOpenBuildMs: 0});
  pools.push(pool);
  const validate = pool.validator(selfHostLiveProfile().service.activation.validation);
  const live = {document: {workspaceId: WS, mainVersionId: "main" as const, objectId: OBJECT, lineageClaimId: "lineage"}, currentPath: PATH,
    checkpoint: richdocSeed.encodeRichdocSeed(MARKDOWN, 1), suffix: [], candidate: Uint8Array.of(0, 0)};
  // Both slots take live validation at once, as soon as the build answers.
  let following: Promise<string[]> | undefined;
  f.buildWith(async (policy, input, signal) => {
    const built = await pool.buildFirstOpenBase(policy, input, signal);
    following = Promise.all([validate(live), validate(live)]).then(results => results.map(result => result.kind));
    return built;
  });
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS, recovery: "retry-later"});
  expect(logged).toHaveBeenCalledWith("[sync-relay] first-open build passed its deadline", WS, OBJECT, f.source.sourceDigest);
  expect(await following).toEqual(["accepted", "accepted"]);
  expect(f.checks).not.toHaveBeenCalled();
  nothingAppended(f);
  // The same source publishes once its wait has passed and a build finishes in time.
  f.buildWith(inThread);
  f.advance(FIRST_OPEN_DEADLINE_WAIT_MS);
  expect((await f.open()).kind).toBe("published");
});

// Each build that passes its deadline holds the one first-open slot that
// long, so the relay, not its clients, decides when the same source builds
// again.
it("answers a source whose build passed its deadline at once until its wait passes, doubling the wait up to an hour", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture(), deadline = async () => ({kind: "deadline"}) as const;
  f.buildWith(deadline);
  const waits = [];
  for (let repeat = 0; repeat < 9; repeat++) {
    const outcome = await f.open();
    expect(outcome).toMatchObject({kind: "unavailable", reason: "build-deadline", recovery: "retry-later"});
    const waitMs = outcome.kind === "unavailable" && outcome.reason === "build-deadline" ? outcome.retryAfterMs : 0;
    waits.push(waitMs / 60_000);
    // Inside the wait, the relay answers with what is left of it, and builds nothing.
    const builds = f.builds.mock.calls.length;
    f.advance(waitMs - 1);
    const inside = await f.open();
    expect(f.builds).toHaveBeenCalledTimes(builds);
    expect(inside).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: 1});
    f.advance(1);
  }
  expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  expect(f.builds).toHaveBeenCalledTimes(9);
  // An edit is a new source, which builds at once.
  f.source = f.writeText(`${MARKDOWN}\nEdited.`);
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS});
  expect(f.builds).toHaveBeenCalledTimes(10);
  // A build that finishes forgets the wait, so a later deadline waits a minute again.
  f.advance(FIRST_OPEN_DEADLINE_WAIT_MS);
  f.buildWith(async () => ({kind: "refused", reason: "update-limit"}));
  expect(await f.open()).toMatchObject({kind: "refused", reason: "too-large", code: "update-limit"});
  f.buildWith(deadline);
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS});
  nothingAppended(f);
});

// The wait stands in only for the build, so every answer that comes before it still holds.
it("answers a waiting source with the history it gained since, without building", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture();
  f.buildWith(async () => ({kind: "deadline"}));
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline"});
  priorAuthority[0]![1](f);
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority", recovery: "pull"});
  expect(f.builds).toHaveBeenCalledTimes(1);
});

// Its bytes passed every check before the build that set the wait.
it("reads a waiting source's history but not its bytes", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture(), blobs = vi.spyOn(f.storage, "getBlob");
  const sourceReads = () => blobs.mock.calls.filter(([, digest]) => digest === f.source.sourceDigest).length;
  f.buildWith(async () => ({kind: "deadline"}));
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline"});
  expect(sourceReads()).toBe(1);
  const histories = f.reads;
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS});
  expect(sourceReads()).toBe(1);
  expect(f.reads).toBe(histories + 1);
  // Once the wait passes, the source is read and built again.
  f.advance(FIRST_OPEN_DEADLINE_WAIT_MS);
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline"});
  expect(sourceReads()).toBe(2);
  expect(f.builds).toHaveBeenCalledTimes(2);
});

// The wait is measured when the history read returns, which can take part of it or outlast it.
it("answers what is left of a wait once its history read returns", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture();
  f.buildWith(async () => ({kind: "deadline"}));
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS});
  f.afterRead(() => f.advance(FIRST_OPEN_DEADLINE_WAIT_MS / 4));
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS * 3 / 4});
  expect(f.builds).toHaveBeenCalledTimes(1);
});

it("answers a wait in whole milliseconds on a clock that reads fractions", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture();
  f.buildWith(async () => ({kind: "deadline"}));
  f.advance(0.4);
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS});
  for (const step of [0.3, FIRST_OPEN_DEADLINE_WAIT_MS - 1.5]) {
    f.advance(step);
    const outcome = await f.open();
    const retryAfterMs = outcome.kind === "unavailable" && outcome.reason === "build-deadline" ? outcome.retryAfterMs : 0;
    expect(Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0, String(retryAfterMs)).toBe(true);
  }
  expect(f.builds).toHaveBeenCalledTimes(1);
});

it("builds a waiting source whose history read outlasts the wait, with that read", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture();
  f.buildWith(async () => ({kind: "deadline"}));
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS});
  f.advance(FIRST_OPEN_DEADLINE_WAIT_MS - 1);
  f.afterRead(() => f.advance(1));
  f.buildWith(inThread);
  const reads = f.reads;
  expect((await f.open()).kind).toBe("published");
  expect(f.builds).toHaveBeenCalledTimes(2);
  expect(f.reads).toBe(reads + 1);
});

it("keeps at most its limit of waits, forgetting the one set longest ago", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture({maxDeadlineWaits: 2});
  // Writing a text again makes it the current source, with the same digest.
  const open = (text: string) => { f.source = f.writeText(text); return f.open(); };
  f.buildWith(async () => ({kind: "deadline"}));
  for (const text of ["One", "Two", "Three"]) await open(text);
  expect(f.builds).toHaveBeenCalledTimes(3);
  // The third wait pushed out the first: that source builds again at once, while the newest still waits.
  await open("One");
  expect(f.builds).toHaveBeenCalledTimes(4);
  const newest = await open("Three");
  expect(f.builds).toHaveBeenCalledTimes(4);
  expect(newest).toMatchObject({kind: "unavailable", reason: "build-deadline", retryAfterMs: FIRST_OPEN_DEADLINE_WAIT_MS});
});

it("publishes nothing when the validation policy changes while the engine checks, and builds under the new policy next time", async () => {
  const f = await fixture(), validation = selfHostLiveProfile().service.activation.validation;
  const changed = {...validation, maxStructVisits: validation.maxStructVisits + 1};
  // Only the policy changes: every bound stays as it was.
  f.checkWith(async (input, signal) => { const answer = await accepting(input, signal); f.setActivation(configured({validation: changed})); return answer; });
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "reconfigured", recovery: "retry-later"});
  expect(f.writes).toHaveBeenCalledTimes(1);
  nothingAppended(f);
  f.checkWith(accepting);
  expect((await f.open()).kind).toBe("published");
  expect(f.builds.mock.calls[1]![0]).toEqual(changed);
});

it("refuses a file longer than a live document before building or asking the engine", async () => {
  const over = await fixture({markdown: "a".repeat(LIVE_MARKDOWN_MAX_BYTES + 1)});
  expect(await over.open()).toMatchObject({kind: "refused", reason: "too-large", code: "source-limit", recovery: "none"});
  expect(over.builds).not.toHaveBeenCalled();
  expect(over.checks).not.toHaveBeenCalled();
  nothingAppended(over);
  // A file at the limit is built.
  const at = await fixture({markdown: "a".repeat(LIVE_MARKDOWN_MAX_BYTES)});
  at.buildWith(async () => ({kind: "busy"}));
  expect(await at.open()).toMatchObject({kind: "unavailable", reason: "busy"});
  expect(at.builds).toHaveBeenCalledTimes(1);
});

it("tells contention, capacity, cancellation and failure apart, and appends nothing for any", async () => {
  // Every read sees the workspace move once more, so each writer attempt finds a new head.
  const moving = await fixture();
  moving.afterRead(read => { if (read <= FIRST_OPEN_WRITER_ATTEMPTS) moving.writeText(`chat ${read}`, {objectId: `object-chat-${read}`, path: `chat/${read}.md`}); });
  expect(await moving.open()).toMatchObject({kind: "unavailable", reason: "contention", recovery: "retry-later"});
  expect(moving.writes).toHaveBeenCalledTimes(FIRST_OPEN_WRITER_ATTEMPTS);
  expect(moving.reads).toBe(FIRST_OPEN_WRITER_ATTEMPTS);
  nothingAppended(moving);
  // One move fewer and the last attempt publishes.
  const settling = await fixture();
  settling.afterRead(read => { if (read < FIRST_OPEN_WRITER_ATTEMPTS) settling.writeText(`chat ${read}`, {objectId: `object-chat-${read}`, path: `chat/${read}.md`}); });
  expect((await settling.open()).kind).toBe("published");
  expect(settling.writes).toHaveBeenCalledTimes(FIRST_OPEN_WRITER_ATTEMPTS);

  const busy = await fixture();
  busy.readWith(async () => ({kind: "busy"}));
  expect(await busy.open()).toMatchObject({kind: "unavailable", reason: "busy", recovery: "retry-later"});
  busy.readWith(async read => readFirstOpenHistoryFile(read));
  busy.buildWith(async () => ({kind: "busy"}));
  expect(await busy.open()).toMatchObject({kind: "unavailable", reason: "busy"});

  const cancelled = await fixture(), abort = new AbortController();
  cancelled.buildWith(async (policy, input) => { const built = buildFirstOpenBase(policy, input); abort.abort(new Error("cancelled")); return built; });
  await expect(cancelled.post({}, {signal: abort.signal}).then(response => response.status)).resolves.not.toBe(200);
  expect(cancelled.writes).not.toHaveBeenCalled();
  for (const f of [busy, cancelled]) nothingAppended(f);
});

it("answers a failed history read, worker or database as a typed transient outcome, and logs its cause", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const sqlite = () => Object.assign(new Error("disk I/O error"), {code: "ERR_SQLITE_ERROR", errcode: 10});
  const f = await fixture(), failures: Array<[string, () => void]> = [
    ["history-unavailable", () => f.readWith(async () => { throw new Error("the history reader exited"); })],
    ["worker-failed", () => f.buildWith(async () => { throw new Error("Live validation worker exited."); })],
    ["storage-failed", () => f.writes.mockImplementationOnce(() => { throw sqlite(); })],
  ];
  for (const [reason, fail] of failures) {
    f.readWith(async read => readFirstOpenHistoryFile(read));
    f.buildWith(inThread);
    fail();
    expect(await f.open(), reason).toMatchObject({kind: "unavailable", reason, recovery: "retry-later", source: {workspaceId: WS, objectId: OBJECT, ...f.source}});
    expect(logged).toHaveBeenLastCalledWith("[sync-relay] first-open unavailable", expect.anything());
  }
  // The workspace moves, and the catch-up read fails.
  f.readWith(async read => { if (read.afterRelaySeq > 0) throw new Error("worker exited"); return readFirstOpenHistoryFile(read); });
  f.afterRead(() => { f.afterRead(); f.writeText("chat", {objectId: "object-chat", path: "chat/a.md"}); });
  const writes = f.writes.mock.calls.length;
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "history-unavailable"});
  expect(f.writes.mock.calls.length).toBe(writes + 1);
  nothingAppended(f);
  // An unexpected fault is no outcome, and neither is a timeout nor a cancellation during a read.
  f.readWith(async read => readFirstOpenHistoryFile(read));
  f.writes.mockImplementationOnce(() => { throw new TypeError("a relay bug"); });
  expect(await f.post().then(response => response.json())).toMatchObject({ok: false, code: "internal_error"});
  for (const reason of [new DOMException("timed out", "TimeoutError"), new Error("cancelled")]) {
    const abort = new AbortController();
    f.readWith(async read => { abort.abort(reason); return readFirstOpenHistoryFile(read); });
    const response = await f.post({}, {signal: abort.signal});
    expect(response.status).not.toBe(200);
    expect(await response.json()).not.toHaveProperty("outcome");
  }
  nothingAppended(f);
});

it("answers only a SQLite failure that can pass as transient, in the writer and in a history read", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture(), history: FirstOpenHistoryReader = async read => readFirstOpenHistoryFile(read);
  const coded = (errcode: number) => Object.assign(new Error("private SQLite message"), {code: "ERR_SQLITE_ERROR", errcode});
  const raised = (sql: string) => {
    try { f.raw.exec(sql); } catch (error) { return error; }
    throw new Error(`${sql} raised nothing.`);
  };
  const fails = async (fault: unknown, where: "writer" | "history") => {
    if (where === "writer") f.writes.mockImplementationOnce(() => { throw fault; });
    else f.readWith(async () => { throw fault; });
    const response = await f.post();
    f.readWith(history);
    return response.json();
  };
  // BUSY, LOCKED, NOMEM, IOERR and an extended IOERR, FULL, CANTOPEN.
  for (const errcode of [5, 6, 7, 10, 266, 13, 14]) {
    expect(await fails(coded(errcode), "writer"), String(errcode)).toMatchObject({outcome: {kind: "unavailable", reason: "storage-failed", recovery: "retry-later"}});
    expect(await fails(coded(errcode), "history"), String(errcode)).toMatchObject({outcome: {kind: "unavailable", reason: "history-unavailable"}});
  }
  // A real constraint failure, missing table and invalid SQL, then CORRUPT, NOTADB and a plain constraint code.
  const deterministic = [raised("CREATE TEMP TABLE probe(x UNIQUE); INSERT INTO probe VALUES (1),(1)"), raised("SELECT * FROM missing_table"), raised("SELEC 1"),
    coded(11), coded(26), coded(19)];
  expect(deterministic.map(error => (error as {errcode: number}).errcode & 255)).toEqual([19, 1, 1, 11, 26, 19]);
  for (const fault of deterministic) {
    for (const where of ["writer", "history"] as const) {
      expect(await fails(fault, where), `${String(fault)} in the ${where}`).toEqual({ok: false, error: "internal error", code: "internal_error"});
    }
  }
  // PROTOCOL, READONLY_RECOVERY and READONLY_CANTINIT pass on the history reader's read-only connection only.
  for (const errcode of [15, 264, 1288]) {
    expect(await fails(coded(errcode), "history"), String(errcode)).toMatchObject({outcome: {kind: "unavailable", reason: "history-unavailable"}});
    expect(await fails(coded(errcode), "writer"), String(errcode)).toEqual({ok: false, error: "internal error", code: "internal_error"});
  }
  // READONLY itself and READONLY_CANTLOCK stay the relay's fault.
  for (const errcode of [8, 520]) expect(await fails(coded(errcode), "history"), String(errcode)).toEqual({ok: false, error: "internal error", code: "internal_error"});
  nothingAppended(f);
});

it("answers a real history reader that finds no history tables as the relay's own fault", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture(), pool = createLiveValidationExecutor(), empty = join(await tempRoot("no-history"), "empty.sqlite");
  pools.push(pool);
  new DatabaseSync(empty).close();
  f.readWith((read, signal) => pool.readFirstOpenHistory({...read, database: empty}, signal));
  expect(await f.post().then(response => response.json())).toEqual({ok: false, error: "internal error", code: "internal_error"});
  expect(f.checks).not.toHaveBeenCalled();
  nothingAppended(f);
});

it("answers storage that shuts down or fails before the last standing check as a request error, never as lost access", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const closing = (f: Fixture) => f.readWith(async (read, signal) => {
    closeTestStorage(f.storage);
    signal.throwIfAborted();
    return readFirstOpenHistoryFile(read);
  });
  const f = await fixture();
  closing(f);
  const response = await f.post();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ok: false, error: "internal error", code: "internal_error"});
  // The relay's own handler answers it as the shutdown it is.
  const g = await fixture();
  closing(g);
  const guarded = await g.post({}, {handler: guardRelayResponses(g.storage, g.handle)});
  expect(guarded.status).toBe(503);
  expect(await guarded.json()).not.toHaveProperty("outcome");
  // Storage that fails the standing read itself, in the writer and again in the last check.
  const h = await fixture();
  h.readWith(async read => {
    vi.spyOn(h.storage, "readFirstOpenStanding").mockImplementation(() => { throw Object.assign(new Error("disk I/O error"), {code: "ERR_SQLITE_ERROR", errcode: 10}); });
    return readFirstOpenHistoryFile(read);
  });
  const failing = await h.post();
  expect(failing.status).toBe(500);
  expect(await failing.json()).toEqual({ok: false, error: "internal error", code: "internal_error"});
  for (const fixture of [f, g, h]) nothingAppended(fixture);
});

it("answers a late replay or a storage failure as absent when access ends after the other request publishes", async () => {
  const revoke = (f: Fixture) => f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id='share-1'").run();
  // The other request publishes while this one builds, the file changes, and the grant goes.
  const stale = await fixture();
  stale.buildWith(async (policy, input) => {
    stale.buildWith(inThread);
    expect((await stale.open()).kind).toBe("published");
    stale.writeText("# Plan\n\nBring drinks.\n");
    revoke(stale);
    return buildFirstOpenBase(policy, input);
  });
  expect((await stale.post()).status).toBe(404);
  // The other request publishes during this one's last catch-up, then the grant goes.
  const contended = await fixture();
  let own = 0;
  contended.readWith(async read => {
    const history = readFirstOpenHistoryFile(read);
    own++;
    if (own < FIRST_OPEN_WRITER_ATTEMPTS) contended.writeText(`chat ${own}`, {objectId: `object-chat-${own}`, path: `chat/${own}.md`});
    else if (own === FIRST_OPEN_WRITER_ATTEMPTS) { expect((await contended.open()).kind).toBe("published"); revoke(contended); }
    return history;
  });
  expect((await contended.post()).status).toBe(404);
  expect(contended.writes).toHaveBeenCalledTimes(FIRST_OPEN_WRITER_ATTEMPTS + 1);
  // The other request publishes, the grant goes, and this one's writer fails as storage can.
  const failing = await fixture();
  failing.buildWith(async (policy, input) => {
    failing.buildWith(inThread);
    expect((await failing.open()).kind).toBe("published");
    revoke(failing);
    failing.writes.mockImplementationOnce(() => { throw Object.assign(new Error("disk I/O error"), {code: "ERR_SQLITE_ERROR", errcode: 10}); });
    return buildFirstOpenBase(policy, input);
  });
  expect((await failing.post()).status).toBe(404);
  for (const f of [stale, contended, failing]) expect(f.bases()).toHaveLength(1);
});

it("is not moved by another workspace's appends", async () => {
  const f = await fixture();
  f.afterRead(() => f.writeText("elsewhere", {workspaceId: OTHER_WS, objectId: "object-elsewhere", path: "docs/elsewhere.md"}));
  expect((await f.open()).kind).toBe("published");
  expect(f.writes).toHaveBeenCalledTimes(1);
  expect(f.reads).toBe(1);
});

it("rolls back the blob and the row together when the workspace is over quota", async () => {
  const f = await fixture(), blobs = () => f.raw.prepare("SELECT count(*) AS n FROM sync_relay_blobs WHERE workspace_id=?").get(WS)!.n;
  const before = blobs();
  f.raw.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id=?").run(DEFAULT_WORKSPACE_QUOTA_BYTES - 1, WS);
  expect((await f.post()).status).toBe(413);
  nothingAppended(f);
  expect(blobs()).toBe(before);
});

it("maps every answer to one recovery", () => {
  expect(firstOpenRecovery({kind: "published", receipt: {originId: "o", originSeq: 0, relaySeq: 1}})).toBe("pull");
  expect(firstOpenRecovery({kind: "refused", reason: "ordinary-activation-refused"})).toBe("report");
  expect(firstOpenRecovery({kind: "integrity", reason: "candidate"})).toBe("report");
});


it("admits once per object before reading blobs or building, despite edits, while another object stays eligible", async () => {
  const f = await fixture({admissionIntervalMs: 60_000});
  f.buildWith(async () => ({kind: "busy"}));
  const blobs = vi.spyOn(f.storage, "getBlob");
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "busy"});
  const readCount = blobs.mock.calls.length;
  f.source = f.writeText("Edited source.");
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "busy"});
  expect(blobs).toHaveBeenCalledTimes(readCount);
  expect(f.builds).toHaveBeenCalledTimes(1);
  const sibling = f.writeText("Sibling", {objectId: "sibling", path: "docs/sibling.md"});
  f.storage.enrollServiceHostDocument({workspaceId: WS, ownerUserId: OWNER, shareId: "share-1", path: "docs/sibling.md", nowMs: 10, guard() {}});
  expect(await f.open({objectId: "sibling", path: "docs/sibling.md", ...sibling})).toMatchObject({kind: "unavailable", reason: "busy"});
  expect(f.builds).toHaveBeenCalledTimes(2);
  f.advance(59_999);
  await f.open();
  expect(f.builds).toHaveBeenCalledTimes(2);
  f.advance(1);
  await f.open();
  expect(f.builds).toHaveBeenCalledTimes(3);
  nothingAppended(f);
});

it("keeps admission through a long build and leaves a quiet interval afterwards, including across edits", async () => {
  const f = await fixture({admissionIntervalMs: 60_000});
  let entered!: () => void, release!: () => void, calls = 0;
  const building = new Promise<void>(resolve => {entered = resolve;}), held = new Promise<void>(resolve => {release = resolve;});
  f.buildWith(async () => {
    if (++calls === 1) {entered(); await held;}
    return {kind: "busy"};
  });
  const pending = f.open();
  await building;
  try {
    f.advance(120_000);
    f.source = f.writeText("An edit while the build was held.");
    await f.open();
    expect(f.builds).toHaveBeenCalledTimes(1);
  } finally {release(); await pending;}
  f.advance(59_999);
  await f.open();
  expect(f.builds).toHaveBeenCalledTimes(1);
  f.advance(1);
  await f.open();
  expect(f.builds).toHaveBeenCalledTimes(2);
  nothingAppended(f);
});
