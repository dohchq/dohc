import {afterEach, expect, it, vi} from "vitest";
import * as Y from "yjs";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {accountDeletionIdentity} from "@dohc/workspace-auth/accountDeletion";
import {yDocToArtifactMarkdown} from "@dohc/ydoc-projection";
import * as richdocSeed from "@dohc/ydoc-projection/richdoc-seed";
import {closeTestStorages, inspectDatabase, storagePath, testStorage} from "./testing";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostFeedRoute, serviceHostReplicationRoute} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {parseServiceActivationConfig, type ServiceActivationConfig} from "./serviceActivationDriver";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {buildFirstOpenBase, MAX_YDOC_UPDATE_BYTES} from "./firstOpenBase";
import {createFirstOpenPublisher, FIRST_OPEN_WRITER_ATTEMPTS, type FirstOpenBuild} from "./firstOpenPublication";
import {firstOpenRecovery, type FirstOpenOutcome} from "./firstOpenOutcome";
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A workspace whose enrolled document has only ordinary text history, and a second
 * workspace. `onRead` runs before each history read, after the route's own standing
 * checks, so what it commits lands between those checks and the writer. `afterRead`
 * runs once a read has its snapshot, so what it commits moves the log past the cutoff.
 */
async function fixture(options: {markdown?: string | Uint8Array} = {}) {
  let reads = 0, onRead: ((read: number) => void) | undefined, afterRead: ((read: number) => void) | undefined;
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
  let activation: ServiceActivationConfig | undefined = configured(), build = inThread;
  const builds = vi.fn<FirstOpenBuild>((policy, input, signal) => build(policy, input, signal));
  const publisher = createFirstOpenPublisher({storage, namespace, activation: () => activation, build: builds});
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
  return {storage, raw, append, writeText, share, enrollment, bearer, otherBearer, handle, post, open, bases, head, builds, writes,
    get source() { return source; }, set source(value) { source = value; },
    readWith(next: FirstOpenHistoryReader) { reader = next; }, onRead(next?: (read: number) => void) { onRead = next; },
    afterRead(next?: (read: number) => void) { afterRead = next; },
    setActivation(next: ServiceActivationConfig | undefined) { activation = next; }, buildWith(next: FirstOpenBuild) { build = next; },
    get reads() { return reads; }};
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

it("replays a lost reply after a newer head, another converter and reduced bounds, without building again", async () => {
  const f = await fixture(), first = published(await f.open()), asked = f.source;
  expect(await f.open()).toMatchObject({kind: "replayed", receipt: first, recovery: "pull"});
  f.source = f.writeText("# Plan\n\nBring snacks and drinks.\n");
  f.buildWith(async () => { throw new Error("the converter changed"); });
  f.setActivation(configured({maxCaptureBytes: 1, maxBytesPerDrain: 1}));
  expect(await f.open(asked)).toMatchObject({kind: "replayed", receipt: first});
  expect(f.builds).toHaveBeenCalledTimes(1);
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

it("refuses an unsupported source and keeps its exact bytes", async () => {
  const markdown = "See <https://example.com/b>.\n", f = await fixture({markdown});
  expect(await f.open()).toMatchObject({kind: "refused", reason: "unsupported-source", recovery: "none"});
  expect(new TextDecoder().decode(f.storage.getBlob(WS, f.source.sourceDigest)!)).toBe(markdown);
  // Growth native could not bound.
  const g = await fixture(), doc = new Y.Doc();
  doc.getXmlFragment("prosemirror").insert(0, [new Y.XmlText()]);
  (doc.getXmlFragment("prosemirror").get(0) as Y.XmlText).insert(0, "x", {mark: {width: 0.5}});
  vi.spyOn(richdocSeed, "encodeRichdocSeed").mockReturnValueOnce(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  expect(await g.open()).toMatchObject({kind: "refused", reason: "unsupported-source"});
  // Not UTF-8.
  const h = await fixture({markdown: new Uint8Array([0x23, 0x20, 0xff, 0x0a])});
  expect(await h.open()).toMatchObject({kind: "refused", reason: "unsupported-source"});
  for (const fixture of [f, g, h]) nothingAppended(fixture);
});

it.each([
  ["empty Markdown", ""],
  ["Unicode", "# Café 🎉\n\nnaïve 中文 — ok\n"],
  ["frontmatter", "---\ntitle: Plan\nnested:\n  count: 3\n---\n\nBody\n"],
  ["a source witness", "* one\n* two\n"],
])("publishes %s", async (_, markdown) => {
  const f = await fixture({markdown});
  const receipt = published(await f.open()), payload = JSON.parse(String(f.bases()[0]!.payload_json));
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, f.storage.getBlob(WS, payload.updateBlobSha256)!); expect(yDocToArtifactMarkdown(doc)).toBe(markdown); } finally { doc.destroy(); }
  expect(receipt.originSeq).toBe(0);
});

it("refuses a base over each configured bound, at the boundary the real verifier uses", async () => {
  // The bounds the route builds against, and the sizes of what it built.
  const probe = await fixture();
  let seen: Parameters<FirstOpenBuild>[1] | undefined;
  probe.buildWith(async (policy, input) => { seen = input; return buildFirstOpenBase(policy, input); });
  probe.setActivation(configured());
  const outcome = await probe.open();
  expect(outcome.kind).toBe("published");
  const base = probe.storage.getBlob(WS, JSON.parse(String(probe.bases()[0]!.payload_json)).updateBlobSha256)!;
  const built = buildFirstOpenBase(selfHostLiveProfile().service.activation.validation, seen!);
  if (built.kind !== "built") throw new Error(JSON.stringify(built));
  expect(Buffer.from(built.base).equals(Buffer.from(base))).toBe(true);
  const {sizes} = built, larger = Math.max(sizes.baseBytes, sizes.stateUpdateBytes), full = larger + sizes.nativeGrowthBytes;
  const capture = activationCaptureBytes(larger, full, seen!.bounds.descriptorBytes);
  const reads = ordinaryActivationReadBytes({baselineBytes: sizes.baseBytes, entryBytes: [seen!.bounds.logEntryBytes], updateBytes: [sizes.baseBytes], fullStateBytes: full});
  const at = async (change: Record<string, unknown>) => { const f = await fixture(); f.setActivation(configured(change)); return f.open(); };
  expect((await at({maxCaptureBytes: capture, maxBytesPerDrain: reads})).kind).toBe("published");
  expect(await at({maxCaptureBytes: capture - 1})).toMatchObject({kind: "refused", reason: "too-large", code: "capture-budget", recovery: "none"});
  expect(await at({maxBytesPerDrain: reads - 1})).toMatchObject({kind: "refused", reason: "too-large", code: "read-budget"});
  const oversized = await fixture();
  vi.spyOn(richdocSeed, "encodeRichdocSeed").mockReturnValueOnce(new Uint8Array(MAX_YDOC_UPDATE_BYTES + 1).fill(0xff));
  expect(await oversized.open()).toMatchObject({kind: "refused", reason: "too-large", code: "update-limit"});
  // Bounds reduced after the base was built still apply in the writer.
  const reduced = await fixture();
  reduced.buildWith(async (policy, input) => { const result = buildFirstOpenBase(policy, input); reduced.setActivation(configured({maxCaptureBytes: capture - 1})); return result; });
  expect(await reduced.open()).toMatchObject({kind: "refused", reason: "too-large", code: "capture-budget"});
  for (const f of [oversized, reduced]) nothingAppended(f);
});

it("refuses a valid base the validation policy cannot afford as too large, and an invalid one as an integrity failure", async () => {
  const f = await fixture();
  f.setActivation(configured({validation: {...selfHostLiveProfile().service.activation.validation, maxStructVisits: 1}}));
  expect(await f.open()).toMatchObject({kind: "refused", reason: "too-large", code: "validation-budget", recovery: "none"});
  nothingAppended(f);
  // The same seed under the configured policy publishes.
  f.setActivation(configured());
  expect((await f.open()).kind).toBe("published");
  // A base the validator rejects is the relay's own fault.
  const g = await fixture(), doc = new Y.Doc();
  doc.getXmlFragment("prosemirror").insert(0, [new Y.XmlElement("not-a-node")]);
  vi.spyOn(richdocSeed, "encodeRichdocSeed").mockReturnValueOnce(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  expect(await g.open()).toMatchObject({kind: "integrity", reason: "candidate", recovery: "report"});
  nothingAppended(g);
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
    ["history-unavailable", () => f.readWith(async () => { throw new Error("no such table"); })],
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
