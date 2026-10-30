import {afterEach, expect, it, vi} from "vitest";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import * as Y from "yjs";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {accountDeletionIdentity} from "@dohc/workspace-auth/accountDeletion";
import {yDocToArtifactMarkdown} from "@dohc/ydoc-projection";
import {requireEngineBinaryOrSkip} from "../../../apps/desktop/src/testing/engineBinary";
import {closeTestStorages, inspectDatabase, tempRoot} from "./testing";
import {initializeRelayDeployment, openRelayDeployment} from "./relayDeployment";
import {startServiceLiveHost} from "./serviceLiveHost";
import {createNamedFrameChanges} from "./liveHostChanges";
import {ServiceHostedReplication} from "./serviceHostedReplication";
import {authorizeServiceHostReplication, deriveServiceHostBearer} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {parseServiceActivationConfig, type ServiceActivationConfig} from "./serviceActivationDriver";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {buildFirstOpenBase, type FirstOpenBaseInput} from "./firstOpenBase";
import {createFirstOpenPublisher, type FirstOpenCheckHost, type FirstOpenNativeCheck} from "./firstOpenPublication";
import type {FirstOpenOutcome} from "@dohc/workspace-contracts/first-open";
import {fenceAccount, initializeAccountDeletion} from "./storage/accountDeletion";
import {readFirstOpenHistoryFile} from "./storage/firstOpenHistory";
import {activationCaptureBytes, ordinaryActivationReadBytes} from "./storage/ordinaryActivationSource";
import type {StorageContext} from "./storage/context";

// The real route, the service host's facade, its queued client and the native engine binary.
const engine = requireEngineBinaryOrSkip();
const profile = selfHostLiveProfile().service;
const WS = "workspace-1", OBJECT = "object-1", PATH = "docs/a.md", OWNER = "owner-1";
const key = new Uint8Array(32).fill(31);
const MARKDOWN = "# Plan\n\nBring snacks.\n";
// The engine settles the first exactly and the autolink canonically (`candidate-verdicts.json`).
const AMP_FENCED = "Title\n=====\n\n```rust\nlet x = &mut y;\n```\n", AUTOLINK = "See <https://example.com/b>.\n";
const configured = (change: Record<string, unknown> = {}) => parseServiceActivationConfig({...profile.activation, targets: [], ...change})!;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
  await closeTestStorages();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A relay deployment whose enrolled document has only ordinary history, a
 * service host whose engine attaches the document's workspace, and the
 * first-open route. `hold` keeps the engine's answer from the publisher until
 * it returns, so a change lands after native checked and before the writer.
 */
async function fixture(options: {markdown?: string; service?: Record<string, unknown>} = {}) {
  const root = await tempRoot("first-open-native"), relayPath = join(root, "relay", "relay.sqlite");
  initializeRelayDeployment({configPath: join(root, "deployment.json"), relayPath, continuityDirectory: join(root, "continuity")});
  // History reads stay in this thread: a cancelled worker read keeps its slot until it exits, which is not the engine's to answer for.
  const {storage, history} = openRelayDeployment(join(root, "deployment.json"), {firstOpenHistory: async read => readFirstOpenHistoryFile(read)});
  let open = true;
  const closeStorage = () => { if (open) { open = false; storage.close(); } };
  cleanup.push(closeStorage);
  storage.provisionLiveHostControl({mode: "service", hostId: "service", updatedAtMs: 1, guard() {}});
  const raw = inspectDatabase(relayPath);
  raw.exec("PRAGMA foreign_keys=OFF");
  let seq = 0, moments = 0;
  const writeText = (content: string, {objectId = OBJECT, path = PATH}: {objectId?: string; path?: string} = {}) => {
    const bytes = new TextEncoder().encode(content), sha256 = sha256Hex(bytes);
    storage.putBlob({workspaceId: WS, sha256, content: bytes, createdAtMs: 1});
    const sourceMomentId = `moment-${++moments}`;
    storage.appendLogBatch({workspaceId: WS, originId: "owner-device", ops: [{originSeq: seq++, opKind: "moment.append", recordedAtMs: 1,
      payloadJson: JSON.stringify({momentId: sourceMomentId, objectId, versionId: "main", operation: "write", path, payloadAfterPath: path,
        payloadAfterBlobSha256: sha256, payloadAfterByteLength: bytes.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1_000 + moments})}]});
    return {sourceMomentId, sourceDigest: sha256};
  };
  expect(storage.claimWorkspace({workspaceId: WS, ownerUserId: OWNER, createdAtMs: 0})).toBe("created");
  storage.claimWorkspaceIdentity({workspaceId: WS, replicationEpoch: "epoch", streamIdentity: "stream"});
  raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share-1',?,?,?,0)")
    .run(WS, OWNER, JSON.stringify({paths: ["docs"], versionId: null}));
  raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('grant-1','share-1','user','reader-2',NULL,'edit',1,'active',0,NULL,NULL)`).run();
  const enroll = (path: string) => deriveServiceHostBearer(storage.enrollServiceHostDocument({workspaceId: WS, ownerUserId: OWNER, shareId: "share-1",
    path, nowMs: 10, guard() {}}), {key, namespace: history.namespace});
  let source = writeText(options.markdown ?? MARKDOWN);
  const bearer = enroll(PATH);

  const workspaceRoot = join(root, "workspace"), servicePath = join(root, "service.json");
  await mkdir(workspaceRoot);
  await writeFile(servicePath, JSON.stringify({version: 1, engineExecutable: engine.require(), hostId: "service", instanceId: "instance",
    workspaces: [{root: workspaceRoot, workspaceId: WS, maxRegistrations: 8, hostedReplication: {relay: {baseUrl: "https://relay.example.test",
      bearerToken: "owner-credential"}, identity: {replicationEpoch: "epoch", streamIdentity: "stream"}, maxPagesPerPull: 1}}],
    ingress: profile.ingress, client: profile.client, ...options.service}));
  const start = () => startServiceLiveHost({trustedAccount: accountId => ({accountId, name: "Owner"}), configPath: servicePath, storage, history,
    frameChanges: createNamedFrameChanges(16)});
  let host: Awaited<ReturnType<typeof start>> | undefined = await start();
  cleanup.push(() => host?.close());

  let activation: ServiceActivationConfig | undefined = configured(), seen: FirstOpenBaseInput | undefined;
  let hold: ((answer: FirstOpenNativeCheck) => Promise<void> | void) | undefined, sent: (() => void) | undefined;
  const answers: FirstOpenNativeCheck[] = [], asked: {maxFullStateBytes: number; candidate: Uint8Array}[] = [];
  const checking: FirstOpenCheckHost = {async checkFirstOpenCandidate(workspaceId, input, signal) {
    asked.push(input);
    const pending = host!.checkFirstOpenCandidate(workspaceId, input, signal);
    sent?.();
    const answer = await pending;
    answers.push(answer);
    await hold?.(answer);
    return answer;
  }};
  const publisher = createFirstOpenPublisher({admissionIntervalMs: 0, storage, namespace: history.namespace, activation: () => activation, host: () => host && checking,
    build: async (policy, input) => { seen = input; return buildFirstOpenBase(policy, input); }});
  const handle = createServiceHostReplication({storage, prefix: "dohc-service-v1.", hostedFeed: true, firstOpen: publisher,
    authorize: input => authorizeServiceHostReplication(storage, {key, namespace: history.namespace, ...input})});
  const post = (body: Record<string, unknown> = {}, init: {signal?: AbortSignal; bearer?: string} = {}) =>
    handle(new Request(`https://relay.test/sync/${WS}/hosted/first-open`, {method: "POST", signal: init.signal,
      headers: {authorization: `Bearer ${init.bearer ?? bearer}`, "content-type": "application/json"},
      body: JSON.stringify({objectId: OBJECT, path: PATH, ...source, replicationEpoch: "epoch", streamIdentity: "stream", ...body})}));
  const openDocument = async (body?: Record<string, unknown>, init?: Parameters<typeof post>[1]) => {
    const response = await post(body, init), text = await response.text();
    expect(response.status, text).toBe(200);
    return (JSON.parse(text) as {outcome: FirstOpenOutcome}).outcome;
  };
  const bases = () => raw.prepare("SELECT * FROM sync_relay_log WHERE origin_id LIKE 'service-host:first-open:%' ORDER BY relay_seq").all();
  return {storage, raw, writeText, enroll, post, open: openDocument, bases, answers, asked, closeStorage,
    get host() { return host; }, async restart() { await host?.close(); host = await start(); },
    async retire() { await host?.close(); host = undefined; },
    get seen() { return seen!; }, get source() { return source; }, set source(value) { source = value; },
    setActivation(next: ServiceActivationConfig | undefined) { activation = next; },
    holdWith(next?: (answer: FirstOpenNativeCheck) => Promise<void> | void) { hold = next; },
    /** Runs once the engine has the check, before its answer. */
    onSent(next?: () => void) { sent = next; }};
}

const checked = (answer: FirstOpenNativeCheck | undefined) => {
  if (answer?.kind !== "answered" || answer.check.status !== "checked") throw new Error(`Expected a checked candidate, got ${JSON.stringify(answer)}.`);
  return answer.check;
};
const nothingAppended = (f: Fixture) => expect(f.bases()).toEqual([]);

it.skipIf(engine.missing)("publishes a candidate the engine checked, once, with the checked bytes as its base", async () => {
  const f = await fixture();
  const outcomes = await Promise.all(Array.from({length: 4}, () => f.open()));
  expect(outcomes.filter(outcome => outcome.kind === "published")).toHaveLength(1);
  expect(f.bases()).toHaveLength(1);
  const payload = JSON.parse(String(f.bases()[0]!.payload_json)), base = f.storage.getBlob(WS, payload.updateBlobSha256)!;
  // Whichever requests reached the engine, each checked the bytes the relay committed. The host takes one check at a time; the rest found it busy.
  for (const [index, answer] of f.answers.entries()) {
    if (answer.kind === "unavailable" && answer.reason === "busy") continue;
    const check = checked(answer);
    expect(check.binding.candidateSha256).toBe(payload.updateBlobSha256);
    expect(Buffer.from(f.asked[index]!.candidate).equals(Buffer.from(base))).toBe(true);
    expect(check.settledSourceSha256).toBe(f.source.sourceDigest);
  }
  expect(await f.open()).toMatchObject({kind: "replayed"});
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, base); expect(yDocToArtifactMarkdown(doc)).toBe(MARKDOWN); } finally { doc.destroy(); }
}, 120_000);

it.skipIf(engine.missing)("refuses what the engine refuses with its cause, appends nothing, and keeps the file", async () => {
  for (const markdown of [AUTOLINK, "Title\n=====\n\nUse `a && b` here.\n"]) {
    const f = await fixture({markdown});
    expect(await f.open()).toMatchObject({kind: "refused", reason: "unsupported-source", cause: "settlement-mismatch", recovery: "none"});
    expect(new TextDecoder().decode(f.storage.getBlob(WS, f.source.sourceDigest)!)).toBe(markdown);
    nothingAppended(f);
  }
}, 120_000);

it.skipIf(engine.missing)("publishes `&`, `<` and `]:` the blanket guard refused when the engine settles them exactly", async () => {
  for (const markdown of [AMP_FENCED, "Title\n=====\n\n```rust\nlet v: Vec<u8> = a < b;\n```\n", "Title\n=====\n\n```\n[docs]: https://example.com\n```\n",
    "Title\n=====\n\nFish & chips\n", "Title\n=====\n\n1 < 2 and 3 <= 4\n", "Title\n=====\n\nWrite `[docs]: url` once.\n"]) {
    const f = await fixture({markdown});
    expect(await f.open(), markdown).toMatchObject({kind: "published"});
    expect(checked(f.answers[0]).settledSourceByteLength).toBe(Buffer.byteLength(markdown));
  }
}, 120_000);

type Change = [string, (f: Fixture) => unknown];
const FENCE_KEY = "first-open-native-fence";
const lostStanding: Change[] = [
  ["View-only access", f => f.raw.prepare("UPDATE sync_relay_share_grants SET access='view' WHERE share_id='share-1'").run()],
  ["the last Edit grant revoked", f => f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id='share-1'").run()],
  ["the owner's Pause", f => f.storage.setServiceHostEnrollmentEnabled({workspaceId: WS, path: PATH, ownerUserId: OWNER, enabled: false, nowMs: 20, guard() {}})],
  ["the owner's Stop", f => f.storage.setServiceHostEnrollmentEnabled({workspaceId: WS, path: PATH, ownerUserId: OWNER, enabled: false, retire: true, nowMs: 20, guard() {}})],
  ["the document moved", f => f.writeText(MARKDOWN, {path: "docs/b.md"})],
  ["the owner's account fenced", f => {
    initializeAccountDeletion(f.storage as StorageContext, FENCE_KEY);
    expect(fenceAccount(f.storage as StorageContext, FENCE_KEY, OWNER, `${OWNER}@dohc.test`).phase).toBe("fenced");
  }],
  ["the workspace tombstoned", f => {
    initializeAccountDeletion(f.storage as StorageContext, FENCE_KEY);
    f.raw.prepare("INSERT INTO sync_relay_deleted_workspaces VALUES (?)").run(accountDeletionIdentity(FENCE_KEY, `workspace:${WS}`));
  }],
];
it.skipIf(engine.missing).each(lostStanding)("appends nothing when %s lands after the engine checked", async (_, change) => {
  const f = await fixture();
  f.holdWith(() => { change(f); });
  expect((await f.post()).status).toBe(404);
  checked(f.answers[0]);
  nothingAppended(f);
}, 120_000);

it.skipIf(engine.missing)("appends nothing for a deletion, a changed file, a retired host or reduced bounds after the engine checked", async () => {
  // A replacement at the document's path deletes it for good.
  const deleted = await fixture();
  deleted.holdWith(() => {
    deleted.storage.appendLogBatch({workspaceId: WS, originId: "other-device", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1,
      payloadJson: JSON.stringify({momentId: "replace-1", objectId: "object-3", versionId: "main", operation: "write", path: "docs/z.md",
        payloadAfterPath: "docs/z.md", payloadAfterBlobSha256: deleted.source.sourceDigest, payloadAfterByteLength: 1, payloadAfterContentKind: "text",
        recordedAtMs: 1_100, beforePresent: "present", beforeObjectId: OBJECT, beforeVersionId: "main", beforePath: "docs/z.md"})}]});
  });
  expect(await deleted.open()).toMatchObject({kind: "refused", reason: "deletion"});
  const changed = await fixture();
  changed.holdWith(() => { changed.writeText("# Plan\n\nNewer.\n"); });
  expect(await changed.open()).toMatchObject({kind: "refused", reason: "stale-source", recovery: "pull-current-source"});
  const retired = await fixture();
  retired.holdWith(() => retired.restart());
  expect(await retired.open()).toMatchObject({kind: "unavailable", reason: "host-absent", recovery: "retry-later"});
  const reduced = await fixture();
  reduced.holdWith(answer => {
    const {fullStateByteLength} = checked(answer), B = reduced.asked[0]!.candidate.byteLength;
    reduced.setActivation(configured({maxCaptureBytes: activationCaptureBytes(B, fullStateByteLength, reduced.seen.bounds.descriptorBytes) - 1}));
  });
  expect(await reduced.open()).toMatchObject({kind: "refused", reason: "too-large", code: "capture-budget"});
  for (const f of [deleted, changed, retired, reduced]) { checked(f.answers[0]); nothingAppended(f); }
  // The host that replaced the retired one checks again and publishes.
  retired.holdWith();
  expect(await retired.open()).toMatchObject({kind: "published"});
}, 180_000);

it.skipIf(engine.missing)("answers a host that retires, or is gone, during the engine's work as unavailable, and replays without it", async () => {
  const f = await fixture();
  // Retire as soon as the check is on its way.
  f.onSent(() => { f.onSent(); void f.host!.close(); });
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "host-absent", recovery: "retry-later"});
  nothingAppended(f);
  await f.retire();
  expect(await f.open()).toMatchObject({kind: "unavailable", reason: "host-absent"});
  await f.restart();
  const receipt = await f.open();
  expect(receipt.kind).toBe("published");
  // A lost reply replays with no host and with a newer head.
  await f.retire();
  const asked = f.source;
  f.source = f.writeText("# Plan\n\nNewer.\n");
  expect(await f.open(asked)).toMatchObject({kind: "replayed"});
}, 180_000);

it.skipIf(engine.missing)("checks outside the writer and is not held by an activation pass that waits on it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let pass: Promise<FirstOpenOutcome> | undefined, armed = false;
  const writes: boolean[] = [];
  // Every activation pass checks the replica's origin first. This one asks for a first open from inside the pass, in its turn.
  vi.spyOn(ServiceHostedReplication.prototype, "create").mockImplementation(async () => {
    if (armed && !pass) { pass = f.open(); await pass; }
    throw new Error("This test has no relay to create a replica on.");
  });
  const f = await fixture({service: {settlement: profile.settlement, adoption: profile.adoption, sync: profile.sync,
    activation: {...profile.activation, pollIntervalMs: 10, targets: []}}});
  f.holdWith(() => {
    writes.push((f.storage as StorageContext).db.isTransaction);
    // The relay keeps writing while the engine's answer waits.
    f.writeText("elsewhere", {objectId: "object-elsewhere", path: "notes/elsewhere.md"});
  });
  armed = true;
  await vi.waitFor(() => expect(pass).toBeDefined(), {timeout: 30_000});
  expect(await pass).toMatchObject({kind: "published"});
  expect(writes).toEqual([false]);
}, 120_000);

it.skipIf(engine.missing)("lets the engine encode exactly the measured full state at each bound, and stops it one byte short", async () => {
  // float32 integers grow when native writes them, so a cap of the candidate's own length would refuse.
  const fixtures = JSON.parse(readFileSync(new URL("../../../crates/dohc-engine-collab/tests/first-open-base/ts-bases.json", import.meta.url), "utf8")) as
    {name: string; markdown?: string}[];
  const markdown = fixtures.find(row => row.name === "float32-integers")!.markdown!;
  const probe = await fixture({markdown});
  expect((await probe.open()).kind).toBe("published");
  const B = probe.asked[0]!.candidate.byteLength, F = checked(probe.answers[0]).fullStateByteLength, {descriptorBytes, logEntryBytes} = probe.seen.bounds;
  expect(F - B).toBeGreaterThan(1_024);
  const capture = activationCaptureBytes(B, F, descriptorBytes);
  const reads = ordinaryActivationReadBytes({baselineBytes: B, entryBytes: [logEntryBytes], updateBytes: [B], fullStateBytes: F});
  for (const [name, at, bound] of [["maxCaptureBytes", capture, "capture-budget"], ["maxBytesPerDrain", reads, "read-budget"]] as const) {
    const fits = await fixture({markdown});
    fits.setActivation(configured({[name]: at}));
    expect(await fits.open()).toMatchObject({kind: "published"});
    expect(fits.asked[0]!.maxFullStateBytes).toBe(F);
    expect(checked(fits.answers[0]).fullStateByteLength).toBe(F);
    const short = await fixture({markdown});
    short.setActivation(configured({[name]: at - 1}));
    expect(await short.open()).toMatchObject({kind: "refused", reason: "too-large", code: bound, recovery: "none"});
    expect(short.answers[0]).toMatchObject({kind: "answered", check: {status: "too-large", bound: "full-state-encoding", limit: F - 1}});
    nothingAppended(short);
  }
}, 240_000);

it.skipIf(engine.missing)("refuses a check the host's configuration can never admit as too large for it, and keeps the host", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture({service: {ingress: {...profile.ingress, maxUploads: 1}}});
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await f.open()).toMatchObject({kind: "refused", reason: "too-large", code: "host-capacity", recovery: "none"});
  }
  expect(f.host!.invalidated.aborted).toBe(false);
  nothingAppended(f);
}, 120_000);

it.skipIf(engine.missing)("frees the engine and keeps the host when the caller cancels at any point of the check", async () => {
  // The engine refuses this file, so every request reaches it. A held slot would wait out this deadline.
  const f = await fixture({markdown: AUTOLINK, service: {client: {...profile.client, requestDeadlineMs: 600_000}}});
  for (let turns = 0; turns < 24; turns++) {
    const abort = new AbortController();
    const response = f.post({}, {signal: abort.signal});
    for (let turn = 0; turn < turns; turn++) await new Promise(setImmediate);
    abort.abort(new Error("cancelled"));
    expect((await response).status).not.toBe(200);
    expect(f.host!.invalidated.aborted).toBe(false);
    expect(await f.open()).toMatchObject({kind: "refused", reason: "unsupported-source", cause: "settlement-mismatch"});
  }
  nothingAppended(f);
}, 120_000);

it.skipIf(engine.missing)("publishes nothing when the caller cancels while the engine's acceptance is on its way, and publishes on the next request", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), answered = new Promise<void>(resolve => { reached = resolve; });
  f.holdWith(() => { reached(); return held; });
  const response = f.post({}, {signal: abort.signal});
  await answered;
  checked(f.answers[0]);
  abort.abort(new Error("cancelled"));
  release();
  expect((await response).status).not.toBe(200);
  nothingAppended(f);
  expect(f.host!.invalidated.aborted).toBe(false);
  f.holdWith();
  expect(await f.open()).toMatchObject({kind: "published"});
  expect(f.bases()).toHaveLength(1);
}, 120_000);

// The notes whose candidates the relay's validator refuses before the engine: each has a link around inline code.
const RELAY_PROJECTION = [".agents/skills/dohc-writing/SKILL.md", "AGENTS.md", "README.md", "crates/yrs-interop/README.md",
  "docs/engineering/verify-agent-work.md", "docs/how-to/self-host-recovery.md", "docs/reference/cli-mcp-sdk.md", "vendor/file-guard-0.2.0/README.md"];
// Each tracked Markdown file of the parity inventory through the real route. Run with DOHC_FIRST_OPEN_INVENTORY=1.
it.runIf(!engine.missing && process.env.DOHC_FIRST_OPEN_INVENTORY === "1")("rechecks the real-note inventory through the route", async () => {
  const inventory = JSON.parse(execFileSync("git", ["show", "HEAD:crates/dohc-engine-collab/tests/first-open-base/inventory.json"], {encoding: "utf8"})) as
    {path: string; sha256: string; oldGuard: string; verdict: string; cause?: string}[];
  const f = await fixture(), verdicts: Record<string, unknown>[] = [];
  for (const [index, note] of inventory.entries()) {
    const markdown = execFileSync("git", ["show", `a572fc3f5:${note.path}`], {encoding: "utf8", maxBuffer: 1 << 26});
    expect(sha256Hex(new TextEncoder().encode(markdown))).toBe(note.sha256);
    const objectId = `note-${index}`, path = `docs/note-${index}.md`, written = f.writeText(markdown, {objectId, path});
    const outcome = await f.open({objectId, path, ...written}, {bearer: f.enroll(path)});
    verdicts.push({path: note.path, oldGuard: note.oldGuard, inventory: note.verdict, cause: note.cause, outcome: outcome.kind,
      ...("reason" in outcome ? {reason: outcome.reason} : {}), ...("cause" in outcome ? {route: outcome.cause} : {})});
    // A note the engine refuses reaches it, unless the relay's own validator refuses its candidate first; either way it stays an ordinary file.
    if (note.verdict === "checked") expect(outcome.kind, note.path).toBe("published");
    else expect(outcome, note.path).toMatchObject({kind: "refused", reason: "unsupported-source",
      cause: RELAY_PROJECTION.includes(note.path) ? "relay-projection" : note.cause, recovery: "none"});
  }
  console.log(JSON.stringify(verdicts, null, 1));
  expect(verdicts.filter(row => row.outcome === "published")).toHaveLength(15);
  expect(verdicts.filter(row => row.route === "relay-projection").map(row => row.path)).toEqual(RELAY_PROJECTION);
}, 600_000);
