import {afterEach, expect, it, vi} from "vitest";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {firstOpenCandidateBinding} from "@dohc/workspace-engine-client/daemon";
import type {FirstOpenOutcome} from "@dohc/workspace-contracts/first-open";
import {closeTestStorages, inspectDatabase, storagePath, testStorage} from "../testing";
import {buildFirstOpenBase} from "../firstOpenBase";
import {createFirstOpenPublisher, type FirstOpenBuild, type FirstOpenCheckHost} from "../firstOpenPublication";
import {parseServiceActivationConfig} from "../serviceActivationDriver";
import {selfHostLiveProfile} from "../selfHostLiveProfile";
import type {StorageContext} from "./context";
import {readFirstOpenHistoryFile, type FirstOpenHistoryReader} from "./firstOpenHistory";
import {openServiceActivationRetirement, serviceActivationRetirementOpen} from "./serviceActivationRetirement";
import {retireUncoveredServiceActivations} from "./serviceHostEnrollment";

// Every case ends with no second root: the document already has, or gains, another
// live start, and first-open leaves neither a row nor a blob behind.

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestStorages();
});

const WS = "workspace-1", OBJECT = "object-1", PATH = "docs/a.md", OWNER = "owner-1", namespace = "first-open-races";
const LINEAGE = "a".repeat(64), MARKDOWN = "# Plan\n\nBring snacks.\n";
const IDENTITY = {replicationEpoch: "epoch", streamIdentity: "stream"};
const policy = parseServiceActivationConfig({...selfHostLiveProfile().service.activation, targets: []})!;

/** The engine's verdict: checked, with a full state a little longer than the candidate. */
const host: FirstOpenCheckHost = {checkFirstOpenCandidate: async (_, input) => ({kind: "answered", current: () => true, check: {status: "checked",
  contractVersion: 1, binding: firstOpenCandidateBinding(input), settledSourceSha256: input.sourceSha256, settledSourceByteLength: input.source.byteLength,
  fullStateSha256: "f".repeat(64), fullStateByteLength: input.candidate.byteLength + 7}})};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One enrolled document with only ordinary text history, shared for Edit, and the real publisher over it. */
async function fixture() {
  const reads = vi.fn<FirstOpenHistoryReader>(async read => readFirstOpenHistoryFile(read));
  const storage = await testStorage({firstOpenHistory: (read, signal) => reads(read, signal)});
  const context = storage as StorageContext;
  const raw = inspectDatabase(storagePath(storage));
  raw.exec("PRAGMA foreign_keys=OFF");
  let originSeq = 0;
  const append = (opKind: string, payload: object) =>
    storage.appendLogBatch({workspaceId: WS, originId: "owner-laptop", ops: [{originSeq: originSeq++, opKind, payloadJson: JSON.stringify(payload), recordedAtMs: 1}]});
  const share = (shareId: string) => {
    raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,?,?,0)")
      .run(shareId, WS, OWNER, JSON.stringify({paths: ["docs"], versionId: null}));
    raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','reader-2',NULL,'edit',1,'active',0,NULL,NULL)`).run(`grant-${shareId}`, shareId);
  };

  expect(storage.claimWorkspace({workspaceId: WS, ownerUserId: OWNER, createdAtMs: 0})).toBe("created");
  storage.claimWorkspaceIdentity({workspaceId: WS, ...IDENTITY});
  // What the synthetic Y.Doc rows below name.
  storage.putBlob({workspaceId: WS, sha256: LINEAGE, content: new Uint8Array([0, 0]), createdAtMs: 1});
  const text = new TextEncoder().encode(MARKDOWN), sourceDigest = sha256Hex(text);
  storage.putBlob({workspaceId: WS, sha256: sourceDigest, content: text, createdAtMs: 1});
  append("moment.append", {momentId: "write-1", objectId: OBJECT, versionId: "main", operation: "write", path: PATH, payloadAfterPath: PATH,
    payloadAfterBlobSha256: sourceDigest, payloadAfterByteLength: text.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1_001});
  share("share-1");
  const enrollment = storage.enrollServiceHostDocument({workspaceId: WS, ownerUserId: OWNER, shareId: "share-1", path: PATH, nowMs: 10, guard() {}});
  const source = {workspaceId: WS, objectId: OBJECT, path: PATH, sourceMomentId: "write-1", sourceDigest, sourceByteLength: text.byteLength};

  // The digests of every base the publisher built, so a test can look for their blobs.
  const built: string[] = [];
  let build: FirstOpenBuild = async (config, input) => buildFirstOpenBase(config, input);
  const publish = createFirstOpenPublisher({storage, namespace, activation: () => policy, host: () => host, admissionIntervalMs: 0,
    build: async (config, input, signal) => {
      const result = await build(config, input, signal);
      if (result.kind === "built") built.push(result.lineageClaimId);
      return result;
    }});
  const open = (): Promise<FirstOpenOutcome> => publish({workspaceId: WS, ownerUserId: OWNER, guard() {}, signal: new AbortController().signal,
    request: {objectId: OBJECT, path: PATH, sourceMomentId: source.sourceMomentId, sourceDigest, identity: IDENTITY}});

  /** Runs `change` once, after every check on the request path and immediately before the writer's transaction. */
  const beforeWriter = (change: () => void) => {
    const write = storage.writeFirstOpen.bind(storage);
    return vi.spyOn(storage, "writeFirstOpen").mockImplementationOnce((proof, base, guard) => { change(); return write(proof, base, guard); });
  };
  /** Holds the build, which runs after the history read, until the test releases it. */
  const holdBuild = () => {
    const started = deferred(), release = deferred(), inner = build;
    build = async (config, input, signal) => { started.resolve(); await release.promise; return inner(config, input, signal); };
    return {started: started.promise, release: release.resolve};
  };

  const standing = () => storage.readFirstOpenStanding({workspaceId: WS, ownerUserId: OWNER, path: PATH});
  const eligibility = () => readFirstOpenHistoryFile({...source, database: storagePath(storage), afterRelaySeq: 0}).eligibility;
  const bases = () => Number(raw.prepare("SELECT count(*) AS n FROM sync_relay_log WHERE origin_id LIKE 'service-host:first-open:%'").get()!.n);
  const baseBlobs = () => built.filter(digest => raw.prepare("SELECT 1 FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?").get(WS, digest)).length;
  return {storage, context, raw, append, share, enrollment, source, built, reads, open, beforeWriter, holdBuild, standing, eligibility, bases, baseBlobs};
}

/** Nothing of first-open's is left: no base row, and no blob of any base it built. */
const nothingLeft = (f: Fixture) => {
  expect(f.bases()).toBe(0);
  expect(f.baseBlobs()).toBe(0);
};
const notFound = {code: "not_found"};

// Another live start, written straight into the tables that hold it.
const liveDocument = (f: Fixture) => f.raw.prepare(`INSERT INTO sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id,
  replaces_lineage_claim_id,current_path,baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes,
  lineage_state,admission_state,restore_fence_generation,registered_at_ms,retired_at_ms) VALUES (?,'main',?,?,NULL,?,1,?,1,?,?,'current','open',0,0,NULL)`)
  .run(WS, OBJECT, LINEAGE, PATH, "b".repeat(64), LINEAGE, new Uint8Array([0, 0]));
/** The host's activation of that start, captured under the workspace's current identity. */
const activation = (f: Fixture, retirement: {requestedAtMs: number} | null = null) => f.raw.prepare(`INSERT INTO sync_relay_service_activations(
  relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,source_json,binding_json,state_digest,state_bytes,
  owner_user_id,share_id,completion_json,accounted_bytes,retire_requested_at_ms,retire_restore_generation,retire_accepted_cursor)
  VALUES (?,'activation-1',?,'main',?,?,?,?,?,?,?,'share-1',NULL,1,?,?,?)`).run(namespace, WS, OBJECT, LINEAGE, JSON.stringify(IDENTITY),
  JSON.stringify({currentPath: PATH}), "d".repeat(64), new Uint8Array([0, 0]), OWNER,
  retirement?.requestedAtMs ?? null, retirement ? 0 : null, retirement ? 0 : null);
const completeRetirement = (f: Fixture) => f.raw.prepare(`UPDATE sync_relay_service_activations SET retired_at_ms=50,retired_boundary_json='{}',state_bytes=NULL
  WHERE activation_id='activation-1'`).run();
const pause = (f: Fixture) => f.storage.setServiceHostEnrollmentEnabled({workspaceId: WS, path: PATH, ownerUserId: OWNER, enabled: false, nowMs: 20, guard() {}});
const resume = (f: Fixture) => f.storage.setServiceHostEnrollmentEnabled({workspaceId: WS, path: PATH, ownerUserId: OWNER, enabled: true, nowMs: 30, guard() {}});
const stop = (f: Fixture) => f.storage.setServiceHostEnrollmentEnabled({workspaceId: WS, path: PATH, ownerUserId: OWNER, enabled: false, retire: true, nowMs: 20, guard() {}});
/** The Stop/restore operation of that start, in `phase`. */
const restore = (f: Fixture, phase: "authority-invalidated" | "fenced" | "declined") => {
  const fenced = phase === "fenced";
  f.raw.prepare(`INSERT INTO sync_relay_live_restore_operations(operation_id,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,
    intent_json,basis_json,terminal_json,phase,old_fence,new_fence,cutover_cursor,revoked_generation,invalidated_at_ms,fenced_at_ms,declined_at_ms,accounted_bytes)
    VALUES ('restore-1',?,?,'main',?,?,'{}','{}',?,?,1,?,?,2,0,?,?,1)`).run(namespace, WS, OBJECT, LINEAGE, fenced ? "{}" : null, phase,
    fenced ? 2 : null, fenced ? 0 : null, fenced ? 0 : null, phase === "declined" ? 0 : null);
};
const ydoc = (isBaseState: boolean) => ({versionId: "main", objectId: OBJECT, path: PATH, contentKind: "richdoc", updateBlobSha256: LINEAGE,
  lineageClaimId: LINEAGE, isBaseState});

it("publishes one base and its blob when nothing races it, so the checks below can see what a race leaves", async () => {
  const f = await fixture();
  expect(await f.open()).toMatchObject({kind: "published"});
  expect(f.bases()).toBe(1);
  expect(f.baseBlobs()).toBe(1);
});

// 1. A queued retirement is a pending Pause or Stop; an open one is the activation's obligation.
it.each([["a pending Pause", pause], ["a Stop", stop]] as const)("refuses before reading anything while %s is queued", async (_, queue) => {
  const f = await fixture();
  queue(f);
  expect(f.standing()).toBeNull();
  await expect(f.open()).rejects.toMatchObject(notFound);
  expect(f.reads).not.toHaveBeenCalled();
  nothingLeft(f);
});

it("refuses while a Pause has an open retirement, through standing and through history", async () => {
  const f = await fixture();
  liveDocument(f);
  activation(f);
  pause(f);
  expect(serviceActivationRetirementOpen(f.context, {workspaceId: WS, objectId: OBJECT})).toBe(true);
  expect(f.standing()).toBeNull();
  expect(f.eligibility()).toBe("prior-authority");
  await expect(f.open()).rejects.toMatchObject(notFound);
  nothingLeft(f);
});

// 2. Resume and a new Edit share leave an open retirement in place.
it("refuses after Resume while the retirement is still open", async () => {
  const f = await fixture();
  liveDocument(f);
  activation(f);
  pause(f);
  resume(f);
  expect(f.storage.readServiceHostEnrollment(WS, PATH)).toMatchObject({enabled: true, ownerStop: null, retired: false});
  expect(serviceActivationRetirementOpen(f.context, {workspaceId: WS, objectId: OBJECT})).toBe(true);
  expect(f.standing()).toBeNull();
  expect(f.eligibility()).toBe("prior-authority");
  await expect(f.open()).rejects.toMatchObject(notFound);
  expect(f.reads).not.toHaveBeenCalled();
  nothingLeft(f);
});

it("refuses after a reshare while the retirement the lost grant opened is still open", async () => {
  const f = await fixture();
  liveDocument(f);
  activation(f);
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id='share-1'").run();
  f.context.tx(() => retireUncoveredServiceActivations(f.context, [f.enrollment], 20));
  f.share("share-3");
  expect(serviceActivationRetirementOpen(f.context, {workspaceId: WS, objectId: OBJECT})).toBe(true);
  expect(f.standing()).toBeNull();
  expect(f.eligibility()).toBe("prior-authority");
  await expect(f.open()).rejects.toMatchObject(notFound);
  nothingLeft(f);
});

// Standing returns once the retirement completes; the start it retired still counts.
it("refuses for good once the retirement completes and the document resumes", async () => {
  const f = await fixture();
  liveDocument(f);
  activation(f);
  pause(f);
  completeRetirement(f);
  resume(f);
  expect(serviceActivationRetirementOpen(f.context, {workspaceId: WS, objectId: OBJECT})).toBe(false);
  expect(f.standing()).toBe(OBJECT);
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  nothingLeft(f);
});

// 3. Restore fences, whatever phase their operation reached.
const restores = ["authority-invalidated", "fenced", "declined"] as const;
it.each(restores)("refuses a document with a restore operation %s", async phase => {
  const f = await fixture();
  restore(f, phase);
  expect(f.standing()).toBe(OBJECT);
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  expect(f.built).toEqual([]);
  nothingLeft(f);
});

// 4. Accepted history on the log itself.
type Start = [string, (f: Fixture) => void];
const logged: Start[] = [
  ["an accepted base", f => f.append("ydoc.update", ydoc(true))],
  ["an accepted delta", f => f.append("ydoc.update", ydoc(false))],
  ["an audit row", f => f.raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
    VALUES (?,'service-host:stored',0,'live.audit.application',?,1)`).run(WS, JSON.stringify({objectId: OBJECT, mainVersionId: "main", updateBlobSha256: LINEAGE}))],
];
it.each(logged)("refuses a document with %s", async (_, add) => {
  const f = await fixture();
  add(f);
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  expect(f.built).toEqual([]);
  nothingLeft(f);
});

// 5–7. A change after the request's checks and before the writer commits.
// Log rows move the head, so the writer asks for a catch-up, whose read refuses.
it.each(logged)("refuses when %s lands after the history read, while the base is built", async (_, add) => {
  const f = await fixture(), held = f.holdBuild(), writes = vi.spyOn(f.storage, "writeFirstOpen");
  const opening = f.open();
  await held.started;
  expect(f.reads).toHaveBeenCalledTimes(1);
  add(f);
  held.release();
  expect(await opening).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  expect(writes.mock.results.map(result => result.value)).toEqual([{kind: "retry"}]);
  expect(f.reads).toHaveBeenCalledTimes(2);
  expect(f.built).toHaveLength(1);
  nothingLeft(f);
});
it.each(logged)("refuses when %s lands immediately before the writer", async (_, add) => {
  const f = await fixture(), writes = f.beforeWriter(() => add(f));
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  expect(writes.mock.results[0]).toEqual({type: "return", value: {kind: "retry"}});
  nothingLeft(f);
});

it("lets a device's own base win the race, and keeps refusing that source afterwards", async () => {
  const f = await fixture(), held = f.holdBuild();
  const opening = f.open();
  await held.started;
  f.append("ydoc.update", ydoc(true));
  held.release();
  expect(await opening).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  expect(await f.open()).toMatchObject({kind: "existing-history", reason: "prior-authority"});
  expect(f.built).toHaveLength(1);
  nothingLeft(f);
});

// Starts that move no log head: only the writer's own guard sees them. An open
// retirement also ends standing, so the request's last check answers 404 after the writer refuses.
const existingHistory = {kind: "existing-history", reason: "prior-authority"};
const unlogged: Array<[string, (f: Fixture) => void, object]> = [
  ["a device registers its live document", liveDocument, existingHistory],
  ["an activation with an open retirement appears", f => activation(f, {requestedAtMs: 20}), notFound],
  ["a retirement opens on a new activation", f => {
    liveDocument(f);
    activation(f);
    expect(f.context.tx(() => openServiceActivationRetirement(f.context, {workspaceId: WS, objectId: OBJECT}, 20))).not.toBeNull();
  }, notFound],
  ...restores.map((phase): [string, (f: Fixture) => void, object] => [`a restore operation ${phase} begins`, f => restore(f, phase), existingHistory]),
];
it.each(unlogged)("refuses in the writer itself when %s immediately before it", async (_, add, answer) => {
  const f = await fixture(), writes = f.beforeWriter(() => add(f));
  expect(await f.open().then(value => value, (error: unknown) => error)).toMatchObject(answer);
  expect(writes.mock.results).toEqual([{type: "return", value: {kind: "refused", reason: "prior-authority"}}]);
  expect(f.built).toHaveLength(1);
  nothingLeft(f);
});

it("refuses an open retirement in the writer whatever its caller's own guard allows", async () => {
  const f = await fixture(), prepared = await f.storage.prepareFirstOpen(f.source);
  if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
  activation(f, {requestedAtMs: 20});
  const bytes = new Uint8Array([1, 2, 3]), guard = vi.fn();
  expect(f.storage.writeFirstOpen(prepared.proof, {namespace, bytes, sha256: sha256Hex(bytes), recordedAtMs: 1_001}, guard))
    .toEqual({kind: "refused", reason: "prior-authority"});
  expect(guard).not.toHaveBeenCalled();
  expect(f.bases()).toBe(0);
  expect(f.raw.prepare("SELECT 1 FROM sync_relay_blobs WHERE sha256=?").get(sha256Hex(bytes))).toBeUndefined();
});

// The writer's append guard checks standing again: the blob it wrote in that transaction goes with the refusal.
const lostStanding: Start[] = [
  ["Edit is reduced to View", f => f.raw.prepare("UPDATE sync_relay_share_grants SET access='view' WHERE share_id='share-1'").run()],
  ["the last Edit grant is revoked", f => f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id='share-1'").run()],
  ["the note is unshared", f => {
    f.raw.prepare("DELETE FROM sync_relay_share_grants WHERE share_id='share-1'").run();
    f.raw.prepare("DELETE FROM sync_relay_shares WHERE share_id='share-1'").run();
  }],
  ["a Pause is queued", pause],
  ["a Stop is queued", stop],
];
it.each(lostStanding)("appends nothing when %s immediately before the writer", async (_, change) => {
  const f = await fixture(), writes = f.beforeWriter(() => change(f));
  await expect(f.open()).rejects.toMatchObject(notFound);
  expect(f.standing()).toBeNull();
  expect(writes.mock.results).toEqual([{type: "throw", value: expect.objectContaining(notFound)}]);
  expect(f.built).toHaveLength(1);
  nothingLeft(f);
});
it.each(lostStanding)("appends nothing when %s while the base is built", async (_, change) => {
  const f = await fixture(), held = f.holdBuild();
  const opening = f.open().then(value => value, (error: unknown) => error);
  await held.started;
  change(f);
  held.release();
  expect(await opening).toMatchObject(notFound);
  nothingLeft(f);
});
