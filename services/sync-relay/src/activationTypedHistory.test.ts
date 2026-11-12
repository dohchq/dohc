// #3763: typing any amount must never stop a note from going live, and activation must cost what the note's size costs,
// not what its edit count costs. These tests drive the activation itself (`prepare`) with production settings and
// assert its outcome: accepted, how long it took, and that it never held the event loop long enough to stall typing.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import type { NativeOwnerActivation } from "@dohc/workspace-engine-client/daemon";
import { openEmptyRelayTestDeployment } from "./testing/emptyRelayDeployment.js";
import { selfHostLiveProfile } from "./selfHostLiveProfile.js";
import { validateOrdinaryActivation } from "./storage/ordinaryActivationValidation.js";
import { markdownToYDoc } from "../../../packages/ydoc-projection/src/import-export.js";
import { createLiveMarkdownRegistrationValidator } from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const WORDS = ["the", "note", "plan", "trip", "budget", "we", "should", "book", "early", "and", "keep", "a", "list", "of", "what", "each", "person", "brings"];
// The bars from the agreed #3763 plan.
const ACTIVATION_MS = 1_000, EVENT_LOOP_STALL_MS = 100;
// The self-hosted profile's activation settings: its entry, byte and capture budgets and its validation policy.
const ACTIVATION = selfHostLiveProfile().service.activation;

/**
 * A note as one person types it: a one-paragraph base, then one update per keystroke, as the editor sends them,
 * with a new paragraph about every 400 characters. Generated, never stored.
 */
function typedNote(keystrokes: number) {
  const base = markdownToYDoc("Notes\n", {clientID: 1}), baseline = Y.encodeStateAsUpdate(base);
  base.destroy();
  const doc = new Y.Doc(); doc.clientID = 2; Y.applyUpdate(doc, baseline);
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => {updates.push(update);});
  const body = doc.getXmlFragment("body");
  let text = (body.get(0) as Y.XmlElement).get(0) as Y.XmlText, word = 0, letter = 0, typed = 0;
  while (updates.length < keystrokes) {
    if (typed >= 400) {
      const paragraph = new Y.XmlElement("paragraph"), next = new Y.XmlText();
      paragraph.insert(0, [next]); body.insert(body.length, [paragraph]); text = next; typed = 0;
    } else {
      const current = `${WORDS[word % WORDS.length]} `;
      text.insert(text.length, current[letter]!); typed++;
      if (++letter === current.length) {letter = 0; word++;}
    }
  }
  const fullState = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return {baseline, updates, fullState};
}

/**
 * A relay holding a note that was created, given its base, and then typed `keystrokes` times, and the owner's
 * capture of it, as the engine names it after the last row it applied. Rows are seeded as the relay stores them.
 */
async function typedRelayNote(keystrokes: number) {
  const root = await mkdtemp(join(tmpdir(), "activation-typed-history-"));
  const deployment = openEmptyRelayTestDeployment({configPath: join(root, "deployment.json"), relayPath: join(root, "relay", "relay.sqlite"),
    continuityDirectory: join(root, "continuity")});
  deployment.storage.provisionLiveHostControl({mode: "service", hostId: "service", updatedAtMs: 1, guard() {}});
  const raw = new DatabaseSync(join(root, "relay", "relay.sqlite"));
  cleanup.push(async () => {raw.close(); deployment.storage.close(); await rm(root, {recursive: true, force: true});});

  const note = typedNote(keystrokes), path = "notes/typed.md", origin = "typist";
  const document = {workspaceId: "workspace", mainVersionId: "main" as const, objectId: "object", lineageClaimId: sha256(note.baseline)};
  const project = createLiveMarkdownRegistrationValidator(ACTIVATION.validation);
  const base = project({document, currentPath: path, checkpoint: note.baseline}), end = project({document, currentPath: path, checkpoint: note.fullState});
  if (base.kind !== "accepted" || end.kind !== "accepted") throw new Error("Invalid typed note fixture.");
  raw.exec("BEGIN");
  try {
    raw.exec("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES ('workspace','owner',0,'epoch','stream')");
    const log = raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace',?,?,?,?,?)");
    const blob = raw.prepare("INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)");
    log.run(origin, 0, "moment.append", JSON.stringify({versionId: "main", objectId: document.objectId, momentId: "created", path, operation: "write",
      payloadAfterPath: path, payloadAfterContentKind: "text", payloadAfterBlobSha256: base.evidence.projectedMarkdownSha256,
      payloadAfterByteLength: base.evidence.projectedMarkdownByteLength}), 0);
    [note.baseline, ...note.updates].forEach((bytes, index) => {
      const updateBlobSha256 = sha256(bytes);
      blob.run(updateBlobSha256, bytes.length, bytes);
      log.run(origin, index + 1, "ydoc.update", JSON.stringify({versionId: "main", objectId: document.objectId, path, contentKind: "richdoc",
        isBaseState: index === 0, lineageClaimId: document.lineageClaimId, updateBlobSha256}), index + 1);
    });
    raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace',?,(SELECT relay_seq FROM sync_relay_log WHERE origin_id=? AND origin_seq=0),'created','main',?,?,'text',?,0)")
      .run(document.objectId, origin, path, base.evidence.projectedMarkdownSha256, base.evidence.projectedMarkdownByteLength);
    raw.exec("COMMIT");
  } catch (error) {raw.exec("ROLLBACK"); throw error;}

  const relaySeq = (originSeq: number) => Number(raw.prepare("SELECT relay_seq FROM sync_relay_log WHERE origin_id=? AND origin_seq=?").get(origin, originSeq)!.relay_seq);
  const last = keystrokes + 1;
  const capture: NativeOwnerActivation = {activationId: `ordinary-activation-${"a".repeat(64)}`, sessionId: "native-session",
    baselineBytes: Buffer.from(note.baseline), fullState: Buffer.from(note.fullState),
    source: {version: 1, relayDatabaseNamespace: deployment.history.namespace, ...document, currentPath: path, replicationEpoch: "epoch",
      streamIdentity: "stream", committedCursor: relaySeq(last), baseOriginId: origin, baseOriginSeq: 1, baseRelaySeq: relaySeq(1),
      sourceMomentId: `moment-ydoc-apply-${sha256(["workspace", "main", document.objectId, path, origin, String(last)].join("\0"))}`,
      sourceDigest: end.evidence.projectedMarkdownSha256, sourceByteLength: end.evidence.projectedMarkdownByteLength,
      nativeHeadSequence: last, fullStateDigest: sha256(note.fullState), fullStateByteLength: note.fullState.length}};
  const host = {mode: "service" as const, hostId: "service", hostEpoch: deployment.storage.getLiveHostControl()!.hostEpoch,
    instanceId: "instance", connectionId: "connection"};
  return {deployment, document, capture, host};
}

/** The relay's work for this note that runs off the request path, before anyone shares it. Main has none. */
async function foldAhead(_note: Awaited<ReturnType<typeof typedRelayNote>>) {}

/** One activation with the self-hosted profile's settings, timed, with the event loop watched. */
async function activate(note: Awaited<ReturnType<typeof typedRelayNote>>) {
  const store = note.deployment.storage.createServiceActivationStore(note.deployment.history);
  const stalls = monitorEventLoopDelay({resolution: 10}); stalls.enable();
  const start = performance.now();
  try {
    const outcome = await store.prepare({capture: note.capture, host: note.host, registeredAtMs: 3, guard() {},
      validate: async work => validateOrdinaryActivation(work, ACTIVATION.validation),
      bounds: {maxCaptureBytes: ACTIVATION.maxCaptureBytes, maxEntriesPerDrain: ACTIVATION.maxEntriesPerDrain,
        maxBytesPerDrain: ACTIVATION.maxBytesPerDrain}}).then(value => value, (error: unknown) => error);
    return {outcome, elapsedMs: performance.now() - start, stallMs: stalls.max / 1e6};
  } finally {stalls.disable();}
}

it("a note typed within today's entry limit activates", async () => {
  const note = await typedRelayNote(100);
  expect((await activate(note)).outcome).toEqual({document: note.document, replayed: false, completed: false});
});

// Fails on main: 200 keystrokes after the base is more history than the activation reads, and it refuses the note.
it("a note typed past today's entry limit activates", async () => {
  const note = await typedRelayNote(200);
  expect((await activate(note)).outcome).toEqual({document: note.document, replayed: false, completed: false});
});

it("a long typed note activates in under a second without stalling the relay, however many keystrokes it took", {timeout: 600_000}, async () => {
  for (const keystrokes of [10_000, 100_000]) {
    const note = await typedRelayNote(keystrokes);
    await foldAhead(note);
    const {outcome, elapsedMs, stallMs} = await activate(note);
    expect(outcome, `${keystrokes} keystrokes`).toEqual({document: note.document, replayed: false, completed: false});
    expect(elapsedMs, `${keystrokes} keystrokes: activation time`).toBeLessThan(ACTIVATION_MS);
    expect(stallMs, `${keystrokes} keystrokes: longest event-loop stall`).toBeLessThanOrEqual(EVENT_LOOP_STALL_MS);
  }
});
