// Notes as people type them, seeded into a relay as it stores them, for tests of activation over long histories (#3763).
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import type { NativeOwnerActivation } from "@dohc/workspace-engine-client/daemon";
import { openEmptyRelayTestDeployment } from "./emptyRelayDeployment.js";
import { openRelayDeployment } from "../relayDeployment.js";
import { selfHostLiveProfile } from "../selfHostLiveProfile.js";
import { markdownToYDoc } from "../../../../packages/ydoc-projection/src/import-export.js";
import { createLiveMarkdownRegistrationValidator } from "../../../../packages/ydoc-projection/src/liveDocumentValidation.js";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const WORDS = ["the", "note", "plan", "trip", "budget", "we", "should", "book", "early", "and", "keep", "a", "list", "of", "what", "each", "person", "brings"];
/** The self-hosted profile's activation settings: its entry, byte and capture budgets and its validation policy. */
export const ACTIVATION = selfHostLiveProfile().service.activation;

/**
 * A note as one person types it: a one-paragraph base, then one update per keystroke, as the editor sends them,
 * with a new paragraph about every 400 characters. Generated, never stored.
 */
export function typedNote(keystrokes: number) {
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
 * `cleanup` receives the work that closes and removes it.
 */
export async function typedRelayNote(keystrokes: number, cleanup: (close: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), "activation-typed-history-")), configPath = join(root, "deployment.json");
  let deployment = openEmptyRelayTestDeployment({configPath, relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity")});
  deployment.storage.provisionLiveHostControl({mode: "service", hostId: "service", updatedAtMs: 1, guard() {}});
  const raw = new DatabaseSync(join(root, "relay", "relay.sqlite"));
  cleanup(async () => {raw.close(); deployment.storage.close(); await rm(root, {recursive: true, force: true});});
  /** Closes the relay database and opens the same files again, as a relay restart does. */
  const reopen = () => {deployment.storage.close(); deployment = openRelayDeployment(configPath);};

  const note = typedNote(keystrokes), path = "notes/typed.md", origin = "typist";
  const document = {workspaceId: "workspace", mainVersionId: "main" as const, objectId: "object", lineageClaimId: sha256(note.baseline)};
  const project = createLiveMarkdownRegistrationValidator(ACTIVATION.validation);
  const base = project({document, currentPath: path, checkpoint: note.baseline}), end = project({document, currentPath: path, checkpoint: note.fullState});
  if (base.kind !== "accepted" || end.kind !== "accepted") throw new Error("Invalid typed note fixture.");
  const log = raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace',?,?,?,?,?)");
  const blob = raw.prepare("INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)");
  let originSeq = 0;
  const insertUpdate = (bytes: Uint8Array, payload: Record<string, unknown>) => {
    const updateBlobSha256 = sha256(bytes);
    blob.run(updateBlobSha256, bytes.length, bytes);
    log.run(origin, originSeq, "ydoc.update", JSON.stringify({versionId: "main", objectId: document.objectId, path, contentKind: "richdoc",
      isBaseState: originSeq === 1, lineageClaimId: document.lineageClaimId, updateBlobSha256, ...payload}), originSeq);
    return originSeq++;
  };
  /** Appends one Y.Doc row as the typist's next, with `payload` changing what the relay recorded, and returns its relay position. */
  const appendUpdate = (bytes: Uint8Array, payload: Record<string, unknown> = {}) => relaySeq(insertUpdate(bytes, payload));
  /** Appends one of the typist's file moments for this note, and returns its relay position. */
  const appendMoment = (payload: Record<string, unknown>) => {
    log.run(origin, originSeq, "moment.append", JSON.stringify({versionId: "main", objectId: document.objectId, ...payload}), originSeq);
    return relaySeq(originSeq++);
  };
  type Text = {projectedMarkdownSha256: string; projectedMarkdownByteLength: number};
  /**
   * Appends a write of the note's file with `text`, with the fields the engine's own writes carry, and returns its relay
   * position. With `objectMoment` the relay also records it as the object's moment, as it does for an accepted write.
   */
  const appendWrite = (momentId: string, text: Text, objectMoment = false) => {
    const at = appendMoment({momentId, path, operation: "write", payloadAfterPath: path, payloadAfterContentKind: "text",
      payloadAfterBlobSha256: text.projectedMarkdownSha256, payloadAfterByteLength: text.projectedMarkdownByteLength,
      recordedAtMs: 0, metadata: {}, beforePresent: true});
    if (objectMoment) raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,
      byte_length,recorded_at_ms) VALUES ('workspace',?,?,?,'main',?,?,'text',?,0)`).run(document.objectId, at, momentId, path, text.projectedMarkdownSha256, text.projectedMarkdownByteLength);
    return at;
  };
  /** Appends a move of the note from `from` to `to` with its text unchanged, recorded as the object's moment at `to`, and returns its relay position. */
  const appendRename = (from: string, to: string, text: Text) => {
    const momentId = `move-${originSeq}`;
    const at = appendMoment({momentId, path: to, operation: "rename", payloadBeforePath: from, payloadAfterPath: to,
      payloadBeforeContentKind: "text", payloadAfterContentKind: "text", payloadBeforeBlobSha256: text.projectedMarkdownSha256,
      payloadAfterBlobSha256: text.projectedMarkdownSha256, payloadAfterByteLength: text.projectedMarkdownByteLength});
    raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,
      byte_length,recorded_at_ms) VALUES ('workspace',?,?,?,'main',?,?,'text',?,0)`).run(document.objectId, at, momentId, to, text.projectedMarkdownSha256, text.projectedMarkdownByteLength);
    return at;
  };
  const relaySeq = (seq: number) => Number(raw.prepare("SELECT relay_seq FROM sync_relay_log WHERE origin_id=? AND origin_seq=?").get(origin, seq)!.relay_seq);
  /** The engine's name for the moment of the typist's Y.Doc row `seq`. */
  const named = (seq: number) => `moment-ydoc-apply-${sha256(["workspace", "main", document.objectId, path, origin, String(seq)].join("\0"))}`;
  raw.exec("BEGIN");
  try {
    raw.exec("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES ('workspace','owner',0,'epoch','stream')");
    log.run(origin, originSeq++, "moment.append", JSON.stringify({versionId: "main", objectId: document.objectId, momentId: "created", path, operation: "write",
      payloadAfterPath: path, payloadAfterContentKind: "text", payloadAfterBlobSha256: base.evidence.projectedMarkdownSha256,
      payloadAfterByteLength: base.evidence.projectedMarkdownByteLength}), 0);
    for (const bytes of [note.baseline, ...note.updates]) insertUpdate(bytes, {});
    raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace',?,?,'created','main',?,?,'text',?,0)")
      .run(document.objectId, relaySeq(0), path, base.evidence.projectedMarkdownSha256, base.evidence.projectedMarkdownByteLength);
    raw.exec("COMMIT");
  } catch (error) {raw.exec("ROLLBACK"); throw error;}

  const last = keystrokes + 1;
  const capture: NativeOwnerActivation = {activationId: `ordinary-activation-${"a".repeat(64)}`, sessionId: "native-session",
    baselineBytes: Buffer.from(note.baseline), fullState: Buffer.from(note.fullState),
    source: {version: 1, relayDatabaseNamespace: deployment.history.namespace, ...document, currentPath: path, replicationEpoch: "epoch",
      streamIdentity: "stream", committedCursor: relaySeq(last), baseOriginId: origin, baseOriginSeq: 1, baseRelaySeq: relaySeq(1),
      sourceMomentId: named(last),
      sourceDigest: end.evidence.projectedMarkdownSha256, sourceByteLength: end.evidence.projectedMarkdownByteLength,
      nativeHeadSequence: last, fullStateDigest: sha256(note.fullState), fullStateByteLength: note.fullState.length}};
  const host = {mode: "service" as const, hostId: "service", hostEpoch: deployment.storage.getLiveHostControl()!.hostEpoch,
    instanceId: "instance", connectionId: "connection"};
  /** The owner's capture once rows were appended: `fullState`, named after the typist's last Y.Doc row, at the relay's cursor. */
  const captureAt = (fullState: Uint8Array): NativeOwnerActivation => {
    const projected = project({document, currentPath: path, checkpoint: fullState});
    if (projected.kind !== "accepted") throw new Error("Invalid typed note capture.");
    const head = Number(raw.prepare("SELECT max(origin_seq) AS seq FROM sync_relay_log WHERE origin_id=? AND op_kind='ydoc.update'").get(origin)!.seq);
    return {...capture, fullState: Buffer.from(fullState), source: {...capture.source,
      committedCursor: Number(raw.prepare("SELECT max(relay_seq) AS cursor FROM sync_relay_log").get()!.cursor), sourceMomentId: named(head),
      sourceDigest: projected.evidence.projectedMarkdownSha256, sourceByteLength: projected.evidence.projectedMarkdownByteLength,
      nativeHeadSequence: head, fullStateDigest: sha256(fullState), fullStateByteLength: fullState.length}};
  };
  return {get deployment() {return deployment;}, reopen, document, capture, captureAt, host, note, path, raw, appendUpdate, appendMoment, appendWrite, appendRename,
    end: end.evidence};
}
export type TypedRelayNote = Awaited<ReturnType<typeof typedRelayNote>>;
