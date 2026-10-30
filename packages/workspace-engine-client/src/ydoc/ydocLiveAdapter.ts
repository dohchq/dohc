import { createHash } from "node:crypto";
import * as Y from "yjs";
import { YDOC_PENDING_MAX_BYTES, YDOC_PENDING_MAX_RECORDS } from "./ydocPendingLimits";
import { ydocUpdateDependsOn } from "./ydocUpdateDependencies";
import { EXCALIDRAW_SCENE_ROOTS } from "@dohc/workspace-contracts/live-documents";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import {
  EngineRequestDeadlineError,
  EngineRequestError,
} from "../daemon/engineClient";
import {
  DaemonRefusalError,
  isDaemonReconnectError,
  isYdocUpdateAdmissionRefusal,
  isTransientEngineRefusal,
  isYdocRemoteUpdatesPendingRefusal,
  isMarkdownWriteHeldRefusal,
  isYdocSessionNotFoundRefusal,
  WorkspaceDaemonRequester,
  type DaemonRequesterClient,
} from "../live/daemonLiveAdapter";
import type { Event, Request, Response, WorkspaceHandle } from "../protocol";
import {
  VERSIONED_METHOD,
  decodeVersionedResult,
} from "../versioned/versionedWireContract";
import {
  YDOC_EVENT,
  YDOC_METHOD,
  decodeYdocRemoteUpdatePayload,
  decodeYdocResult,
  type ChangeAttributionWire,
  type YdocCloseParams,
  type YdocContentKind,
  type ArtifactAssetDescriptor,
  type YdocEvictParams,
  type YdocOpenParams,
  type YdocRecordUpdateParams,
  type YdocRecordUpdateResult,
  type YdocSettleParams,
  type YdocSettleResult,
  type YdocOwnerDraft,
} from "./ydocWireContract";

const LOCAL_EDITOR_ORIGIN: unique symbol = Symbol(
  "dohc.workspaceEngineClient.localEditorOrigin",
);
const ORIGINAL_REPLAY_ORIGIN = Symbol("dohc.workspaceEngineClient.originalReplayOrigin");

export const ENGINE_DELIVERED_ORIGIN: unique symbol = Symbol(
  "dohc.workspaceEngineClient.engineDeliveredOrigin",
);


export interface EngineTransport extends DaemonRequesterClient {
  onEvent(handler: (event: Event) => void): () => void;
}

export type YdocAdapterErrorCode =
  | "acknowledged-state-missing"
  | "invalid-update"
  | "lineage-changed"
  | "missing-response-blob"
  | "response-mismatch"
  | "resync-needed"
  | "seed-not-permitted"
  | "session-closed"
  | "session-quarantined";

export class YdocAdapterError extends Error {
  readonly code: YdocAdapterErrorCode;

  constructor(code: YdocAdapterErrorCode, message: string) {
    super(message);
    this.name = "YdocAdapterError";
    this.code = code;
  }
}

export class YdocOwnerDraftPendingError extends Error {
  constructor(readonly draft: YdocOwnerDraft) {
    super("Saved locally. The shared file update is pending.");
    this.name = "YdocOwnerDraftPendingError";
  }
}

// How long one in-flight `ydoc.open` may go unanswered. Its sibling
// `workspace.open` has carried a 2 s bound since it was written; this request
// carried none, so a daemon that accepted an open and then said nothing held
// the capture chain for as long as the silence lasted — the wedge watchdog's
// ~225 s at best, and longer behind other traffic.
//
// Measured, because the only work this limit can reject is a healthy open
// (AGENTS.md, "measure limits that reject work"). Every case below is the real
// daemon — dohc-workspace-engine, debug build of de3fb9d5 — driven through this
// adapter and the real transport on a Ryzen 9 7950X / Windows 11 / 64 GB. The
// number is the `ydoc.open` request alone: response minus send.
//
//   cold store, small document                                     0.9 ms
//   cold store, 47 KiB document (the largest a seeded open can carry:
//     the daemon refuses a seed past INBAND_CONTENT_CAP_BYTES)      2.3 ms
//   warm store, same document                                      2.1 ms
//   open while the daemon captures 40 x 32 KiB files               0.9 ms
//   reopen after 7,500 settled appends (42 KiB of typed text) 2.0 ms
//   resurrect a lineage nothing settled, 500 real appends          13.7 ms
//   resurrect a lineage nothing settled, 3,000 real appends        67.4 ms
//   resurrect a lineage nothing settled, 10,000 real appends      120.9 ms
//
// What the shape of that says: a settled document reopens flat, because its
// close compacted the lineage. The cost is in a lineage nothing settled — a
// draft a dead daemon left behind — where the open replays every journalled
// update, and it grows with how many there are. 10,000 of them is already past
// ordinary: the settle debounce is 800 ms, so a lineage that deep means the
// daemon never settled once across 10,000 keystrokes.
//
// ydocOpenMeasurement.e2e.test.ts runs these cases again on whatever machine it
// is on, and fails when the bound stops clearing them.
//
// 5,000 ms is 41x the widest of those, past the headroom this repo usually
// gives a measured limit, and deliberately so. The table is one fast machine's
// debug build and the population is every machine dohc runs on. The costs are
// not symmetric either: too tight rejects a healthy open and the user gets a
// read-only document, while too loose holds the capture chain a few seconds
// longer on a daemon that has already stopped answering. If a healthy open ever
// does reach this limit, measure again rather than widening it here.
//
// One number for both sides: the daemon's supervisor adopts a request's own
// `deadline_ms` as its deadline (dohc-engine-protocol/src/supervisor.rs, capped
// at `max_deadline`), so it cancels the handler at the same instant this client
// stops waiting, instead of the 30 s default it applies to a request that names
// none.
export const YDOC_OPEN_DEADLINE_MS = 5_000;

/**
 * `ydoc.open` did not land inside YDOC_OPEN_DEADLINE_MS.
 *
 * TERMINAL for the caller's open, and deliberately not a transport error: the
 * daemon accepted the request, so re-issuing it costs another full deadline
 * against a daemon that is already not answering. The surface answers the same
 * read-only "the engine may still hold this document" state it answers for a
 * spent retry budget, with the user's own retry.
 *
 * The open may have completed daemon-side, with only its reply queued behind
 * other output — so this refusal can discard the only copy of a live session
 * id. Nothing here can release that session: `ydoc.close` needs the id, and no
 * RPC addresses a session by path. What keeps that safe is the daemon's own
 * refusal, `ydoc-session-busy`, which every later open of the path answers and
 * which is read-only too (isEngineWorkspaceOpenRefusedError). The session
 * itself goes when the workspace closes.
 */
export class YdocOpenTimedOutError extends Error {
  readonly path: string;
  // The limit is the constant, never an argument: one number reaches the wire,
  // the daemon and this message, and a caller cannot report a bound it did not
  // send.
  readonly limitMs = YDOC_OPEN_DEADLINE_MS;
  readonly waitedMs: number;

  constructor(path: string, waitedMs: number, cause: unknown) {
    super(
      `Rust engine did not answer ydoc.open for ${path}. ` +
        `The ydoc.open deadlineMs limit of ${YDOC_OPEN_DEADLINE_MS}ms was reached: ` +
        `the caller waited ${waitedMs}ms. ` +
        `The daemon may still hold this document; open it again.`,
      { cause },
    );
    this.name = "YdocOpenTimedOutError";
    this.path = path;
    this.waitedMs = waitedMs;
  }
}

// The bound has two clocks, because both sides honour the same number: this
// client's timer, and the daemon's supervisor answering DEADLINE_EXCEEDED for
// the deadline the request carried. Whichever reports first, the open did not
// land inside the bound and the document is in the same state — so the caller
// gets one refusal rather than two, only one of which the surface knows how to
// answer.
function isYdocOpenDeadlineFailure(error: unknown): boolean {
  return (
    error instanceof EngineRequestDeadlineError ||
    (error instanceof EngineRequestError &&
      error.wireError?.code === "DEADLINE_EXCEEDED") ||
    (error instanceof DaemonRefusalError &&
      error.wireCode === "DEADLINE_EXCEEDED")
  );
}

export class IllFormedUtf16EditError extends YdocAdapterError {
  constructor() {
    super(
      "invalid-update",
      "The local Y.Doc edit contains ill-formed UTF-16 text or crosses a surrogate-pair boundary.",
    );
    this.name = "IllFormedUtf16EditError";
  }
}

export class YdocSessionQuarantinedError extends YdocAdapterError {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "session-quarantined",
      "The Y.Doc session is quarantined after a local update could not be safely journaled.",
    );
    this.name = "YdocSessionQuarantinedError";
    this.cause = cause;
  }
}

export type YdocResyncReason =
  | "event-decode-failed"
  | "event-sequence-gap"
  | "session-generation-changed"
  | "native-state-changed";

export class YdocResyncNeededError extends YdocAdapterError {
  readonly reason: YdocResyncReason;
  readonly event: Event;
  override readonly cause: unknown;

  constructor(input: {
    reason: YdocResyncReason;
    event: Event;
    cause?: unknown;
  }) {
    super(
      "resync-needed",
      `The Y.Doc session is stale (${input.reason}); engine resynchronization is required.`,
    );
    this.name = "YdocResyncNeededError";
    this.reason = input.reason;
    this.event = input.event;
    this.cause = input.cause;
  }
}

export class RemoteYdocApplyError extends YdocAdapterError {
  readonly attemptedUpdate: Uint8Array;
  readonly postAttemptStateUpdate: Uint8Array;
  override readonly cause: unknown;

  constructor(input: {
    attemptedUpdate: Uint8Array;
    postAttemptStateUpdate: Uint8Array;
    cause: unknown;
  }) {
    super(
      "invalid-update",
      "An engine-delivered Y.Doc update failed during local application.",
    );
    this.name = "RemoteYdocApplyError";
    this.attemptedUpdate = input.attemptedUpdate;
    this.postAttemptStateUpdate = input.postAttemptStateUpdate;
    this.cause = input.cause;
  }
}

export interface OpenYdocAdapterSessionInput {
  allowLossySourceSha256?: string;
  workspace: WorkspaceHandle;
  versionId: string;
  path: string;
  expectedObjectId?: string;
  contentKind?: YdocContentKind;
  // An object with no durable CRDT lineage is normally seeded from its
  // artifact content. Set false when the caller already holds the canonical
  // state and will replay it: a seed carries a fresh client id, so merging it
  // into a populated doc appends a second copy of the file instead of
  // resuming it. Callers that pass false own re-establishing the content.
  seedAbsentLineage?: boolean;
  // A seed past the engine's in-band cap arrives as a blob, read in this
  // workspace, when it is at most `maxBytes`. Without it, such a seed refuses
  // the open.
  largeSeed?: LargeSeedReading;
}

export interface LargeSeedReading {
  workspaceId: string;
  maxBytes: number;
}

export interface ApplyLocalUpdateOptions {
  actorOriginId?: string;
  /** Declared write provenance the engine records beside the actor origin. */
  attribution?: ChangeAttributionWire;
  /** Server delivery retains this declaration for canonical automation admission. */
  trustedAutomationDraft?: boolean;
  /**
   * The wire idempotency key for this update's recordUpdate request, in
   * place of the session-generated one. An automation run's write carries
   * its claim id here, so a re-run handler's identical write dedupes
   * engine-side instead of journaling twice.
   */
  idempotencyKey?: string;
}

export interface YdocLocalTextEdit {
  root: "plainText";
  index: number;
  insert?: string;
  deleteLength?: number;
}

const ILL_FORMED_UTF16_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isWellFormedUtf16(value: string): boolean {
  return typeof value.isWellFormed === "function"
    ? value.isWellFormed()
    : !ILL_FORMED_UTF16_PATTERN.test(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function base64ToBytes(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new YdocAdapterError("invalid-update", "Invalid base64 Y.Doc update.");
  }
  return Buffer.from(value, "base64");
}

function declareDohcRootSchema(
  doc: Y.Doc,
  contentKind?: YdocContentKind,
): void {
  doc.getMap("frontmatter");
  doc.getMap("meta");
  doc.getXmlFragment("body");
  doc.getText("plainText");
  if (contentKind === "scene") {
    doc.getMap(EXCALIDRAW_SCENE_ROOTS.revisions);
    doc.getMap(EXCALIDRAW_SCENE_ROOTS.appState);
    doc.getMap(EXCALIDRAW_SCENE_ROOTS.assets);
  }
}

function createPlaintextSeedDoc(content: string, clientID: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  declareDohcRootSchema(doc);
  if (content.length > 0) doc.getText("plainText").insert(0, content);
  return doc;
}

function visitJsonStrings(
  value: unknown,
  visitor: (value: string) => void,
): void {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitJsonStrings(item, visitor);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visitor(key);
      visitJsonStrings(item, visitor);
    }
  }
}

function visitDeltaStrings(
  text: Y.Text | Y.XmlText,
  visitor: (value: string) => void,
): void {
  for (const operation of text.toDelta()) {
    if (typeof operation.insert === "string") {
      visitor(operation.insert);
    } else {
      visitJsonStrings(operation.insert, visitor);
    }
    for (const [key, value] of Object.entries(operation.attributes ?? {})) {
      visitor(key);
      visitJsonStrings(value, visitor);
    }
  }
}

function visitSharedValueStrings(
  value: unknown,
  visitor: (value: string) => void,
): void {
  if (value instanceof Y.XmlText || value instanceof Y.Text) {
    visitDeltaStrings(value, visitor);
    return;
  }
  if (value instanceof Y.XmlElement) {
    for (const [key, attribute] of Object.entries(value.getAttributes())) {
      visitor(key);
      if (attribute !== undefined) visitor(attribute);
    }
    for (const child of value.toArray()) {
      visitSharedValueStrings(child, visitor);
    }
    return;
  }
  if (value instanceof Y.XmlFragment) {
    for (const child of value.toArray()) {
      visitSharedValueStrings(child, visitor);
    }
    return;
  }
  if (value instanceof Y.Map) {
    visitJsonStrings(value.toJSON(), visitor);
    return;
  }
  if (value instanceof Y.Array) {
    for (const item of value.toArray()) {
      visitSharedValueStrings(item, visitor);
    }
    return;
  }
  visitJsonStrings(value, visitor);
}

function countReplacementChars(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0xfffd) count += 1;
  }
  return count;
}

interface RootUtf16Snapshot {
  readonly strings: readonly string[];
  readonly replacementCount: number;
}

type DocUtf16Snapshot = ReadonlyMap<string, RootUtf16Snapshot>;

function hasReplacementChars(snapshot: DocUtf16Snapshot): boolean {
  for (const root of snapshot.values()) if (root.replacementCount > 0) return true;
  return false;
}

function snapshotDocUtf16(doc: Y.Doc): DocUtf16Snapshot {
  const snapshot = new Map<string, RootUtf16Snapshot>();
  for (const [root, value] of doc.share) {
    const strings: string[] = [root];
    visitSharedValueStrings(value, (item) => strings.push(item));
    snapshot.set(root, {
      strings,
      replacementCount: strings.reduce(
        (count, item) => count + countReplacementChars(item),
        0,
      ),
    });
  }
  return snapshot;
}

// Minimal view of Yjs' internal item list, used only to count U+FFFD that this
// transaction DELETED. Yjs sanitizes a split surrogate pair to U+FFFD in every
// public read (toString/toDelta) and even in item storage, so a masked split
// (delete N pre-existing U+FFFD while a mid-pair split adds N) nets to zero in
// aggregate counts. Counting the deleted U+FFFD separately closes that bypass.
interface YjsInternalItem {
  readonly deleted: boolean;
  readonly right: YjsInternalItem | null;
  readonly content: { readonly str?: string; readonly type?: YjsInternalType };
}
interface YjsInternalType {
  readonly _start: YjsInternalItem | null;
}

function countDeletedTextReplacementChars(type: YjsInternalType): number {
  let total = 0;
  const walk = (start: YjsInternalItem | null, ancestorDeleted: boolean): void => {
    let item = start;
    while (item) {
      const deleted = ancestorDeleted || item.deleted;
      const content = item.content;
      if (typeof content.str === "string") {
        if (deleted) total += countReplacementChars(content.str);
      } else if (content.type) {
        walk(content.type._start, deleted);
      }
      item = item.right;
    }
  };
  walk(type._start, false);
  return total;
}

// Per-root count of U+FFFD contained in text the transaction `delta` DELETED,
// reconstructed by replaying `beforeState` + `delta` into a gc:false clone
// (which retains deleted content as tombstones) and walking the deleted items.
function deletedReplacementCounts(
  beforeState: Uint8Array,
  delta: Uint8Array,
): ReadonlyMap<string, number> {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, beforeState);
  Y.applyUpdate(clone, delta);
  const counts = new Map<string, number>();
  for (const [root, value] of clone.share) {
    counts.set(
      root,
      countDeletedTextReplacementChars(value as unknown as YjsInternalType),
    );
  }
  return counts;
}

function assertDocUtf16IsSafe(
  doc: Y.Doc,
  before: DocUtf16Snapshot,
  computeDeleted: () => ReadonlyMap<string, number>,
  seedUpdate: boolean,
): void {
  const after = snapshotDocUtf16(doc);
  let hasReplacement = false;
  for (const [, current] of after) {
    for (const value of current.strings) {
      // A lone surrogate survives directly in non-text values (map/attribute
      // strings are not sanitized) — reject it unconditionally.
      if (!isWellFormedUtf16(value)) throw new IllFormedUtf16EditError();
    }
    if (current.replacementCount > 0) hasReplacement = true;
  }
  // Fast path: no U+FFFD anywhere post-edit ⇒ no split (masked or otherwise)
  // could have occurred, so skip the clone entirely (the common case).
  if (!hasReplacement) return;
  if (seedUpdate) return;

  // A split surfaces as a NET-NEW U+FFFD once offsetting deletions are counted:
  // newFFFD = after − before + deleted. Reject any root with newFFFD > 0. This
  // catches the masked split (cross_engine.rs:264) without over-rejecting a
  // clean delete of pre-existing U+FFFD (a net decrease → newFFFD ≤ 0).
  // The general opaque split that no live TypeScript scan can reconstruct is
  // caught engine-side by the replay-parity gate
  // (crates/dohc-engine-collab/src/replay_parity.rs).
  const deleted = computeDeleted();
  for (const [root, current] of after) {
    const newReplacement =
      current.replacementCount -
      (before.get(root)?.replacementCount ?? 0) +
      (deleted.get(root) ?? 0);
    if (newReplacement > 0) throw new IllFormedUtf16EditError();
  }
}

function isInsideSurrogatePair(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return false;
  const previous = value.charCodeAt(index - 1);
  const current = value.charCodeAt(index);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function assertTextEditIsValid(text: string, edit: YdocLocalTextEdit): void {
  const deleteLength = edit.deleteLength ?? 0;
  if (
    !Number.isSafeInteger(edit.index) ||
    edit.index < 0 ||
    !Number.isSafeInteger(deleteLength) ||
    deleteLength < 0 ||
    edit.index + deleteLength > text.length
  ) {
    throw new YdocAdapterError(
      "invalid-update",
      "The local Y.Text edit range is outside the current UTF-16 content.",
    );
  }
  if (edit.insert !== undefined && !isWellFormedUtf16(edit.insert)) {
    throw new IllFormedUtf16EditError();
  }
  if (
    isInsideSurrogatePair(text, edit.index) ||
    isInsideSurrogatePair(text, edit.index + deleteLength)
  ) {
    throw new IllFormedUtf16EditError();
  }
}

interface LocalRecordCapture {
  readonly options: ApplyLocalUpdateOptions | undefined;
  readonly before: DocUtf16Snapshot;
  // Only text that existed before the edit can be deleted by it, so with no
  // U+FFFD before there is none to count and the state is not encoded.
  readonly beforeState: Uint8Array | null;
  readonly seedUpdate: boolean;
  readonly originalUpdate?: Uint8Array;
  operation?: Promise<YdocRecordUpdateResult | undefined>;
  rejection?: Error;
}

// The document a run of local records was made on, within one lineage claim.
// Once the lineage changes, the generation is refused and none of its records
// reach the engine again. A lineage replacement starts the next generation.
interface DocumentGeneration {
  refusal?: YdocAdapterError;
}

interface LocalUpdateRecord {
  readonly updateBase64: string;
  readonly idempotencyKey: string;
  readonly actorOriginId?: string;
  readonly attribution?: ChangeAttributionWire;
  readonly trustedAutomationDraft?: boolean;
  readonly seed: boolean;
  readonly generation: DocumentGeneration;
  refusal?: unknown;
}

const LINEAGE_CHANGED_WHILE_RECORDING =
  "The document lineage changed while the edit was being recorded. The edit remains in this editor and was not applied to the winning lineage.";

export function isLineageChange(error: unknown): boolean {
  return error instanceof YdocAdapterError && error.code === "lineage-changed";
}

export class YdocAdapterSession {
  private activeDoc: Y.Doc;
  get doc(): Y.Doc {
    return this.activeDoc;
  }
  initialUpdate: Uint8Array;
  readonly objectId: string;
  readonly path: string;
  readonly contentKind: YdocContentKind;
  private activeArtifactAssets: readonly ArtifactAssetDescriptor[];
  get artifactAssets(): readonly ArtifactAssetDescriptor[] {
    return this.activeArtifactAssets;
  }
  readonly workspace: WorkspaceHandle;
  readonly sessionId: string;
  // Whether the ENTERED VERSION has a committed snapshot for this path.
  // Set by openSession; read by the open consumer, which owns the
  // create-or-refuse decision.
  head: "present" | "absent" = "present";
  headSha256: string | null = null;
  // Whether the daemon resumed durable CRDT state for this object. Read with
  // `head`, never instead of it: a crash-orphaned draft the daemon resurrects
  // is lineage-existing and head-absent, and its CRDT rows are the only copy
  // of those edits — refusing it would strand them and wedge the lease on an
  // unsettled close.
  lineage: "existing" | "absent" = "existing";
  // Whether that resumed state holds updates the workspace file may not: a
  // crash between an edit and its settle, or a remote update drained at open.
  unsettled = false;
  lineageClaimId: string | null;
  // Whether this device claimed the lineage from its own unclaimed history,
  // as of the last open or resync.
  lineageOriginatedHere: boolean;

  private readonly adapter: YdocLiveAdapter;
  private closed = false;
  private seedReserved = false;
  private lastSettledSha: string | null = null;
  private recordChain: Promise<void> = Promise.resolve();
  private activeLocalRecordCapture: LocalRecordCapture | null = null;
  // Contract: an observer-detected local hazard is reject-and-quarantine.
  // Structured text edits reject before a transaction and do not quarantine.
  // Whether a transient refusal left the engine behind this document. Owned
  // by the session because the session is what the engine refused, and read
  // by close() to decide whether releasing would discard the only copy.
  private quarantinedError: YdocSessionQuarantinedError | null = null;
  private staleError: YdocAdapterError | null = null;
  private resyncPending: Promise<Uint8Array> | null = null;
  private droppedWhileStale = false;
  private generation: DocumentGeneration = {};
  private nextLocalUpdateSeq = 1;
  private readonly pendingRecords = new Set<LocalUpdateRecord>();
  private acknowledgedDoc = new Y.Doc();
  private pendingRecordBytes = 0;
  ownerDraft: YdocOwnerDraft | undefined;
  private readonly remoteUpdateListeners = new Set<(update: Uint8Array) => void>();
  private readonly headChangedListeners = new Set<(headSha256: string | null) => void>();
  private readonly durableLocalChangeListeners = new Set<() => void>();
  private readonly settlementWantedListeners = new Set<() => void>();
  private readonly localUpdateAcknowledgedListeners = new Set<(id: string, lane: "journal" | "owner-outbox") => void>();
  private readonly localUpdateRefusedListeners = new Set<(id: string, error: unknown) => void>();
  private readonly ownerDraftChangedListeners = new Set<() => void>();
  private readonly remoteApplyErrorListeners = new Set<
    (error: RemoteYdocApplyError) => void
  >();
  private readonly resyncNeededListeners = new Set<
    (error: YdocResyncNeededError) => void
  >();
  private readonly sessionErrorListeners = new Set<(error: unknown) => void>();
  private readonly lineageReplacementListeners = new Set<
    (doc: Y.Doc, recoveredPaths: string[]) => void
  >();
  private readonly retiredDocs = new Set<Y.Doc>();

  constructor(
    adapter: YdocLiveAdapter,
    workspace: WorkspaceHandle,
    sessionId: string,
    input: {
      objectId: string;
      path: string;
      contentKind: YdocContentKind;
      initialUpdate: Uint8Array;
      artifactAssets?: readonly ArtifactAssetDescriptor[];
      lineageClaimId: string | null;
      lineageOriginatedHere: boolean;
      ownerDraft?: YdocOwnerDraft;
    },
  ) {
    this.adapter = adapter;
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.objectId = input.objectId;
    this.path = input.path;
    this.contentKind = input.contentKind;
    this.activeArtifactAssets = input.artifactAssets ?? [];
    this.initialUpdate = input.initialUpdate;
    this.lineageClaimId = input.lineageClaimId;
    this.lineageOriginatedHere = input.lineageOriginatedHere;
    this.ownerDraft = input.ownerDraft;
    this.activeDoc = new Y.Doc();
    declareDohcRootSchema(this.activeDoc, this.contentKind);
    Y.applyUpdate(this.activeDoc, this.initialUpdate, ENGINE_DELIVERED_ORIGIN);
    declareDohcRootSchema(this.acknowledgedDoc, this.contentKind);
    Y.applyUpdate(this.acknowledgedDoc, this.initialUpdate);
    this.activeDoc.on("update", this.handleDocUpdate);
  }

  canonicalSource(): "ydoc" {
    return "ydoc";
  }

  applyLocalUpdate(
    update: Uint8Array,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    const original = new Uint8Array(update);
    return this.runLocalMutation(
      () => Y.applyUpdate(this.doc, original, LOCAL_EDITOR_ORIGIN),
      options,
      false,
      original,
    );
  }

  // Only the owner may replay originals already validated in its prior session.
  replayLocalUpdate(
    update: Uint8Array,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    this.assertRecordable();
    Y.applyUpdate(this.doc, update, ORIGINAL_REPLAY_ORIGIN);
    return this.enqueueRecordUpdate(update, options);
  }

  async reestablishAcknowledgedState(update: Uint8Array): Promise<void> {
    this.assertRecordable();
    const vector = Y.decodeStateVector(Y.encodeStateVector(this.acknowledgedDoc));
    const required = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update));
    if ([...required].every(([client, clock]) => (vector.get(client) ?? 0) >= clock)) return;
    await this.requestRecoveryBase(update);
    Y.applyUpdate(this.doc, update, ORIGINAL_REPLAY_ORIGIN);
  }

  private async requestRecoveryBase(update: Uint8Array): Promise<void> {
    if (this.lineage !== "absent") {
      throw new YdocAdapterError("acknowledged-state-missing",
        "The engine is missing acknowledged document state. Recovery cannot replace an existing lineage.");
    }
    try {
      await this.requestRecordUpdate({
        updateBase64: bytesToBase64(update),
        idempotencyKey: `${this.sessionId}:recovery-base:${this.nextLocalUpdateSeq++}`,
        seed: true,
        generation: this.generation,
      });
    } catch (error) {
      if (!isYdocUpdateAdmissionRefusal(error)) throw error;
      throw new YdocAdapterError("acknowledged-state-missing",
        "The engine refused to restore acknowledged document state. Reopen the file to recover your edits.");
    }
  }

  applySeedUpdate(update: Uint8Array): Promise<YdocRecordUpdateResult | undefined> {
    if (this.lineage !== "absent" || this.seedReserved) {
      throw new YdocAdapterError(
        "seed-not-permitted",
        "The session already has existing lineage.",
      );
    }
    this.seedReserved = true;
    try {
      return this.runLocalMutation(
        () => Y.applyUpdate(this.doc, update, LOCAL_EDITOR_ORIGIN),
        undefined,
        true,
      ).catch((error: unknown) => {
        this.seedReserved = false;
        throw error;
      });
    } catch (error) {
      this.seedReserved = false;
      throw error;
    }
  }

  applyLocalEdit(
    mutator: (doc: Y.Doc) => void,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    return this.runLocalMutation(
      () => {
        this.doc.transact(() => mutator(this.doc), LOCAL_EDITOR_ORIGIN);
      },
      options,
    );
  }

  applyLocalTextEdit(
    edit: YdocLocalTextEdit,
    options?: ApplyLocalUpdateOptions,
  ): Promise<YdocRecordUpdateResult | undefined> {
    this.assertRecordable();
    const text = this.doc.getText(edit.root);
    const current = text.toString();
    assertTextEditIsValid(current, edit);
    return this.runLocalMutation(
      () => {
        this.doc.transact(() => {
          const deleteLength = edit.deleteLength ?? 0;
          if (deleteLength > 0) text.delete(edit.index, deleteLength);
          if (edit.insert !== undefined && edit.insert.length > 0) {
            text.insert(edit.index, edit.insert);
          }
        }, LOCAL_EDITOR_ORIGIN);
      },
      options,
    );
  }

  private enqueueRecordUpdate(
    update: Uint8Array,
    options?: ApplyLocalUpdateOptions,
    seedUpdate = false,
  ): Promise<YdocRecordUpdateResult | undefined> {
    // An edit on a document whose lineage changed waits for no engine answer:
    // it cannot enter the winning lineage.
    if (this.generation.refusal) throw this.generation.refusal;
    const record: LocalUpdateRecord = {
      updateBase64: bytesToBase64(update),
      idempotencyKey: options?.idempotencyKey ?? `${this.sessionId}:${this.nextLocalUpdateSeq++}`,
      ...(options?.actorOriginId ? { actorOriginId: options.actorOriginId } : {}),
      ...(options?.attribution ? { attribution: structuredClone(options.attribution) } : {}),
      ...(options?.trustedAutomationDraft ? {trustedAutomationDraft: true} : {}),
      seed: seedUpdate,
      generation: this.generation,
    };
    const retainedBytes = record.updateBase64.length * 2 +
      (record.actorOriginId?.length ?? 0) * 2 +
      (record.attribution ? JSON.stringify(record.attribution).length * 2 : 0);
    if (this.pendingRecords.size >= YDOC_PENDING_MAX_RECORDS ||
      retainedBytes > YDOC_PENDING_MAX_BYTES - this.pendingRecordBytes) {
      const error = new DaemonRefusalError({ code: "LIMIT_EXCEEDED", retry: "no",
        message: "pending-edits-limit" }, undefined);
      for (const listener of this.localUpdateRefusedListeners) {
        try { listener(record.idempotencyKey, error); }
        catch (cause) { this.surfaceSessionError(cause); }
      }
      this.restoreAcknowledgedDocument();
      throw error;
    }
    this.pendingRecords.add(record);
    this.pendingRecordBytes += retainedBytes;
    const operation = this.recordChain.then(async () => {
      this.assertRecordable();
      if (record.refusal !== undefined) throw record.refusal;
      try {
        return await this.requestRecordUpdate(record);
      } catch (refusal) {
        // Recovery cannot repair a definite refusal of this original input,
        // nor return it to a lineage that has already changed.
        if (isYdocUpdateAdmissionRefusal(refusal) || isLineageChange(refusal)) throw refusal;
        try {
          return await this.recoverCanonicalState(record);
        } catch (recoveryFailure) {
          // Recovery resent under the caller's key and the engine found the
          // key already used. That answer outranks whatever sent us here.
          if (isYdocUpdateAdmissionRefusal(recoveryFailure)) {
            throw recoveryFailure;
          }
          if (
            recoveryFailure instanceof YdocAdapterError &&
            (recoveryFailure.code === "lineage-changed" ||
              recoveryFailure.code === "acknowledged-state-missing")
          ) {
            throw recoveryFailure;
          }
          // The desktop rebind boundary classifies the thrown value itself.
          // Do not hide a daemon restart inside the diagnostic cause wrapper:
          // either reconnect-class failure is sufficient to require a fresh
          // workspace/session binding.
          if (isDaemonReconnectError(recoveryFailure)) throw recoveryFailure;
          if (isDaemonReconnectError(refusal)) throw refusal;
          // Same reason as the reconnect passthrough above, for the other
          // class a caller must be able to recognize: the classifier reads
          // the thrown value, and a transient refusal buried in a diagnostic
          // wrapper reads as terminal. Recovery met the same busy engine the
          // write did; report that, not a story about recovery.
          if (isTransientEngineRefusal(recoveryFailure)) throw recoveryFailure;
          if (isTransientEngineRefusal(refusal)) throw refusal;
          const refusalMessage =
            refusal instanceof Error ? refusal.message : String(refusal);
          const recoveryMessage =
            recoveryFailure instanceof Error
              ? recoveryFailure.message
              : String(recoveryFailure);
          throw new Error(
            `Y.Doc update recovery failed: ${recoveryMessage}. Original record refusal: ${refusalMessage}.`,
            { cause: refusal },
          );
        }
      }
    });
    return this.trackRecordOperation(operation);
  }

  /**
   * The policy every operation queued on the record chain answers to: what a
   * failure means for the SESSION, and how the chain survives it.
   *
   * Quarantine is for a session whose canonical state is no longer knowable —
   * a partially applied update, a response that went missing. A busy engine
   * refused the write cleanly and changed nothing, and recovery has already
   * pulled this doc back to durable state, so the session is exactly as good
   * as it was. Killing it for a condition that clears in milliseconds would
   * turn a pause into a dead document.
   *
   * A lineage change is not uncertainty either: the engine holds the winning
   * lineage, and this document's edits cannot enter it. The session hands
   * over to the winner instead.
   *
   * The chain is then neutralized either way, so one refusal cannot reject
   * every operation queued behind it, and the rejection is claimed once here
   * so a caller that ignores it does not trip an unhandled rejection.
   */
  private trackRecordOperation<T>(
    operation: Promise<T>,
  ): Promise<T> {
    const guarded = operation.then(
      (value) => {
        if (!this.closed && this.staleError === null && this.quarantinedError === null) {
          this.notifyListeners(this.durableLocalChangeListeners, undefined);
        }
        return value;
      },
      (error: unknown) => {
        // Transient refusals leave the originals queued for another attempt.
        if (!isTransientEngineRefusal(error) && !isYdocUpdateAdmissionRefusal(error) &&
          !isLineageChange(error)) this.quarantine(error);
        this.surfaceSessionError(error);
        throw error;
      },
    );
    this.recordChain = guarded.then(
      () => undefined,
      () => undefined,
    );
    void guarded.catch((error: unknown) => {
      // The handover resync waits for the record chain, so it starts only
      // once this operation has settled, never from inside it.
      if (isLineageChange(error) && this.generation.refusal !== undefined && !this.closed) {
        void this.resync().catch((cause: unknown) => this.surfaceSessionError(cause));
      }
    });
    return guarded;
  }

  // Unacknowledged records have the same lifetime as the in-memory content.
  get missingLocalState(): boolean {
    return this.pendingRecords.size > 0;
  }

  resendMissingState(): Promise<void> {
    if (!this.missingLocalState) return Promise.resolve();
    const originals = [...this.pendingRecords];
    const operation = this.recordChain.then(async () => {
      this.assertRecordable();
      const records = originals.filter(record => this.pendingRecords.has(record));
      if (records.length === 0) return;
      await this.mergeRecoveryState(this.generation);
      for (const record of records) {
        await this.requestRecordUpdate(record);
      }
    });
    return this.trackRecordOperation(operation);
  }

  private async requestRecordUpdate(
    record: LocalUpdateRecord,
  ): Promise<YdocRecordUpdateResult> {
    const generation = record.generation;
    if (generation.refusal) throw generation.refusal;
    const params: YdocRecordUpdateParams = {
      sessionId: this.sessionId,
      updateBase64: record.updateBase64,
      expectedLineageClaimId: this.lineageClaimId,
      ...(record.actorOriginId ? { actorOriginId: record.actorOriginId } : {}),
      ...(record.attribution ? { attribution: structuredClone(record.attribution) } : {}),
      ...(record.trustedAutomationDraft ? {trustedAutomationDraft: true} : {}),
      ...(record.seed ? { seed: true } : {}),
    };
    let result: YdocRecordUpdateResult;
    try {
      result = decodeYdocResult(YDOC_METHOD.recordUpdate, await this.adapter.request(
        this.workspace,
        YDOC_METHOD.recordUpdate,
        params,
        { idempotencyKey: record.idempotencyKey },
      ));
    } catch (error) {
      if (isYdocUpdateAdmissionRefusal(error) && this.pendingRecords.has(record)) {
        // Retire causal dependents before replacement so observers can retain
        // a recovery copy. Independent clients keep their queued writes.
        const refusedUpdates = [base64ToBytes(record.updateBase64)];
        let tail = false;
        for (const pending of this.pendingRecords) {
          if (pending === record) tail = true;
          if (!tail) continue;
          const update = base64ToBytes(pending.updateBase64);
          if (pending !== record && !refusedUpdates.some(refused => ydocUpdateDependsOn(update, refused))) continue;
          if (pending !== record) refusedUpdates.push(update);
          pending.refusal = error;
          this.removePendingRecord(pending);
          for (const listener of this.localUpdateRefusedListeners) {
            try { listener(pending.idempotencyKey, error); }
            catch (cause) { this.surfaceSessionError(cause); }
          }
        }
        this.restoreAcknowledgedDocument();
      }
      throw error;
    }
    // Only an answer within this document's lineage acknowledges the edit.
    if (generation.refusal) throw generation.refusal;
    if (!this.continuesLineage(result)) throw this.refuseGeneration(generation, LINEAGE_CHANGED_WHILE_RECORDING);
    Y.applyUpdate(this.acknowledgedDoc, base64ToBytes(record.updateBase64));
    this.removePendingRecord(record);
    if (!record.seed) {
      const lane = "ownerDraft" in result ? "owner-outbox" : "journal";
      for (const listener of this.localUpdateAcknowledgedListeners) {
        try { listener(record.idempotencyKey, lane); }
        catch (error) { this.surfaceSessionError(error); }
      }
    }
    if ("ownerDraft" in result && this.ownerDraft) {
      this.ownerDraft = { ...this.ownerDraft, outboxId: result.ownerDraft.outboxId,
        pendingBytes: result.ownerDraft.pendingBytes, state: result.ownerDraft.state };
    }
    return result;
  }

  private removePendingRecord(record: LocalUpdateRecord): void {
    if (!this.pendingRecords.delete(record)) return;
    this.pendingRecordBytes -= record.updateBase64.length * 2 +
      (record.actorOriginId?.length ?? 0) * 2 +
      (record.attribution ? JSON.stringify(record.attribution).length * 2 : 0);
  }

  private restoreAcknowledgedDocument(): void {
    const replacement = new Y.Doc();
    declareDohcRootSchema(replacement, this.contentKind);
    Y.applyUpdate(replacement, Y.encodeStateAsUpdate(this.acknowledgedDoc));
    for (const record of this.pendingRecords) Y.applyUpdate(replacement, base64ToBytes(record.updateBase64));
    const refusedDoc = this.activeDoc;
    refusedDoc.off("update", this.handleDocUpdate);
    this.activeDoc = replacement;
    replacement.on("update", this.handleDocUpdate);
    this.initialUpdate = Y.encodeStateAsUpdate(replacement);
    for (const listener of this.lineageReplacementListeners) {
      try { listener(replacement, []); }
      catch (error) { this.surfaceSessionError(error); }
    }
    refusedDoc.destroy();
  }

  private async mergeRecoveryState(generation: DocumentGeneration): Promise<void> {
    if (generation.refusal) throw generation.refusal;
    const durableState = await this.requestResyncState();
    if (generation.refusal) throw generation.refusal;
    if (!this.continuesLineage(durableState)) {
      throw this.refuseGeneration(generation, LINEAGE_CHANGED_WHILE_RECORDING);
    }
    const durableVector = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(durableState.update));
    const acknowledgedVector = Y.decodeStateVector(Y.encodeStateVector(this.acknowledgedDoc));
    if ([...acknowledgedVector].some(([client, clock]) => (durableVector.get(client) ?? 0) < clock)) {
      await this.requestRecoveryBase(Y.encodeStateAsUpdate(this.acknowledgedDoc));
    }
    Y.applyUpdate(this.acknowledgedDoc, durableState.update);
    Y.applyUpdate(this.doc, durableState.update, ENGINE_DELIVERED_ORIGIN);
  }

  private async recoverCanonicalState(
    record: LocalUpdateRecord,
  ): Promise<YdocRecordUpdateResult> {
    await this.mergeRecoveryState(record.generation);
    return this.requestRecordUpdate(record);
  }

  /**
   * Refuse every record of a document whose lineage changed, before any of
   * them reaches the engine, and hold the session stale until the resync
   * hands it to the winning lineage.
   */
  private refuseGeneration(generation: DocumentGeneration, message: string): YdocAdapterError {
    generation.refusal ??= new YdocAdapterError("lineage-changed", message);
    if (generation === this.generation) this.staleError ??= generation.refusal;
    return generation.refusal;
  }

  async adoptCollectionRecord(): Promise<"settled" | "ownerPending" | "declined"> {
    this.assertRecordable();
    await this.recordChain;
    await this.resyncIfNeeded();
    const raw = await this.adapter.request(this.workspace, YDOC_METHOD.adoptCollectionRecord, { sessionId: this.sessionId });
    const result = decodeYdocResult(YDOC_METHOD.adoptCollectionRecord, raw);
    // Engine maintenance arrives through the same remote-state route as peer edits.
    await this.resync();
    return result.status;
  }

  async settle(options?: { summary?: string; allowLossySourceSha256?: string }): Promise<YdocSettleResult> {
    this.assertRecordable();
    await this.recordChain;
    // A resync request that landed while the journal drained is waited out,
    // not reported as a failed save: the settle must not write text this
    // editor has not shown yet, and the resync shows it.
    await this.resyncIfNeeded();
    this.assertOpen();
    if (this.ownerDraft) {
      await this.resendMissingState();
      throw new YdocOwnerDraftPendingError(this.ownerDraft);
    }
    const params: YdocSettleParams = {
      sessionId: this.sessionId,
      ...(options?.summary ? { summary: options.summary } : {}),
      ...(options?.allowLossySourceSha256 ? { allowLossySourceSha256: options.allowLossySourceSha256 } : {}),
    };
    let raw: Response["result"];
    try {
      raw = await this.adapter.request(this.workspace, YDOC_METHOD.settle, params);
    } catch (error) {
      // Remote edits were drained under this session's lease: this doc is
      // behind the durable lineage. Resync (which returns the full drained
      // state) and settle exactly once more — the daemon refuses rather
      // than materializing content this editor never saw.
      //
      // One retry, never a loop: a second refusal means peers are still
      // outrunning this session, and that wants a backoff rather than a tight
      // retry. It reaches the caller unchanged, and the caller's ladder owns
      // it — as TRANSIENT, which only the typed discriminator says, because
      // the wire code alone reads terminal.
      if (isYdocRemoteUpdatesPendingRefusal(error)) {
        await this.resync();
        try {
          raw = await this.adapter.request(this.workspace, YDOC_METHOD.settle, params);
        } catch (retryError) {
          if (options?.allowLossySourceSha256 && isMarkdownWriteHeldRefusal(retryError)) this.requestSettlement();
          throw retryError;
        }
      } else {
        if (options?.allowLossySourceSha256 && isMarkdownWriteHeldRefusal(error)) this.requestSettlement();
        throw error;
      }
    }
    const result = decodeYdocResult(YDOC_METHOD.settle, raw);
    this.lastSettledSha = result.sha256;
    this.headSha256 = result.sha256;
    this.notifyListeners(this.headChangedListeners, this.headSha256);
    return result;
  }

  isSelfMaterializedSha(sha256: string): boolean {
    return this.lastSettledSha === sha256;
  }

  onRemoteUpdate(handler: (update: Uint8Array) => void): () => void {
    this.remoteUpdateListeners.add(handler);
    return () => this.remoteUpdateListeners.delete(handler);
  }

  onHeadChanged(handler: (headSha256: string | null) => void): () => void {
    this.headChangedListeners.add(handler);
    return () => this.headChangedListeners.delete(handler);
  }

  onDurableLocalChange(handler: () => void): () => void {
    this.durableLocalChangeListeners.add(handler);
    return () => this.durableLocalChangeListeners.delete(handler);
  }

  onSettlementWanted(handler: () => void): () => void {
    this.settlementWantedListeners.add(handler);
    return () => this.settlementWantedListeners.delete(handler);
  }

  requestSettlement(): void {
    if (!this.closed) this.notifyListeners(this.settlementWantedListeners, undefined);
  }

  onLocalUpdateAcknowledged(handler: (id: string, lane: "journal" | "owner-outbox") => void): () => void {
    this.localUpdateAcknowledgedListeners.add(handler);
    return () => this.localUpdateAcknowledgedListeners.delete(handler);
  }

  onLocalUpdateRefused(handler: (id: string, error: unknown) => void): () => void {
    this.localUpdateRefusedListeners.add(handler);
    return () => this.localUpdateRefusedListeners.delete(handler);
  }

  onOwnerDraftChanged(handler: () => void): () => void {
    this.ownerDraftChangedListeners.add(handler);
    return () => this.ownerDraftChangedListeners.delete(handler);
  }

  onRemoteApplyError(handler: (error: RemoteYdocApplyError) => void): () => void {
    this.remoteApplyErrorListeners.add(handler);
    return () => this.remoteApplyErrorListeners.delete(handler);
  }

  onResyncNeeded(handler: (error: YdocResyncNeededError) => void): () => void {
    this.resyncNeededListeners.add(handler);
    return () => this.resyncNeededListeners.delete(handler);
  }

  onLineageReplaced(
    handler: (doc: Y.Doc, recoveredPaths: string[]) => void,
  ): () => void {
    this.lineageReplacementListeners.add(handler);
    return () => this.lineageReplacementListeners.delete(handler);
  }

  onSessionError(handler: (error: unknown) => void): () => void {
    this.sessionErrorListeners.add(handler);
    return () => this.sessionErrorListeners.delete(handler);
  }

  currentStateUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  receiveRemoteUpdate(update: Uint8Array): void {
    if (this.closed) return;
    if (this.staleError !== null) {
      // The engine emitted an update we cannot order against the in-flight
      // resync state. Dropping it silently would leave the doc permanently
      // behind (the reset baseline hides the gap) — remember it happened so
      // the current resync pass runs once more when it lands.
      this.droppedWhileStale = true;
      return;
    }
    try {
      Y.applyUpdate(this.doc, update, ENGINE_DELIVERED_ORIGIN);
      Y.applyUpdate(this.acknowledgedDoc, update);
    } catch (cause) {
      const error = new RemoteYdocApplyError({
        attemptedUpdate: update,
        postAttemptStateUpdate: Y.encodeStateAsUpdate(this.doc),
        cause,
      });
      this.notifyListeners(this.remoteApplyErrorListeners, error);
    }
  }

  markStale(error: YdocResyncNeededError): void {
    if (this.closed) return;
    if (this.staleError !== null) {
      // A gap/generation event observed while already stale is still an
      // event whose update this doc missed — the in-flight resync must run
      // one more pass rather than resetting the baseline past it. With no
      // resync in flight, the last one failed, and this request retries it.
      if (this.resyncPending === null) {
        void this.resync().catch((cause: unknown) => this.surfaceSessionError(cause));
      } else {
        this.droppedWhileStale = true;
      }
      return;
    }
    this.staleError = error;
    this.notifyListeners(this.resyncNeededListeners, error);
    void this.resync().catch((cause: unknown) => this.surfaceSessionError(cause));
  }

  async resyncIfNeeded(): Promise<void> {
    if (this.staleError !== null) await this.resync();
  }

  resync(): Promise<Uint8Array> {
    if (this.resyncPending) return this.resyncPending;
    this.resyncPending = this.readResyncState();
    return this.resyncPending;
  }

  private async readResyncState(): Promise<Uint8Array> {
    try {
      while (true) {
        await this.recordChain.catch(() => undefined);
        if (this.closed) {
          throw new YdocAdapterError(
            "session-closed",
            "The Y.Doc adapter session is closed.",
          );
        }
        const result = await this.requestResyncState();
        if (this.closed) throw new YdocAdapterError("session-closed", "The Y.Doc adapter session is closed.");
        const update = result.update;
        // A refused generation is replaced even if this read shows its claim:
        // its records never reach the engine again.
        if (this.generation.refusal !== undefined || !this.continuesLineage(result)) {
          const refusal = this.refuseGeneration(this.generation,
            "The document lineage changed. The earlier edits cannot enter this lineage.");
          this.generation = {};
          for (const record of this.pendingRecords) {
            record.refusal = refusal;
            this.removePendingRecord(record);
          }
          // The new lineage replaces the acknowledged baseline as well.
          this.acknowledgedDoc.destroy();
          this.acknowledgedDoc = new Y.Doc();
          declareDohcRootSchema(this.acknowledgedDoc, this.contentKind);
          Y.applyUpdate(this.acknowledgedDoc, update);
          const replacement = new Y.Doc();
          declareDohcRootSchema(replacement, this.contentKind);
          Y.applyUpdate(replacement, update, ENGINE_DELIVERED_ORIGIN);
          replacement.on("update", this.handleDocUpdate);
          this.activeDoc.off("update", this.handleDocUpdate);
          this.retiredDocs.add(this.activeDoc);
          this.activeDoc = replacement;
          this.lineageClaimId = result.lineageClaimId;
          this.lineageOriginatedHere = result.lineageOriginatedHere;
          this.initialUpdate = update;
          this.activeArtifactAssets = result.artifactAssets;
          for (const listener of this.lineageReplacementListeners) {
            listener(replacement, result.recoveredPaths);
          }
        } else {
          Y.applyUpdate(this.acknowledgedDoc, update);
          Y.applyUpdate(this.doc, update, ENGINE_DELIVERED_ORIGIN);
        }
        // The event baseline is preserved across resync: transport event seqs
        // stay monotone within a session generation, and clearing the position
        // would let the first post-resync gap pass undetected (the next event
        // would be accepted as a fresh baseline). Positions recorded during the
        // stale window keep the continuity; a genuine gap after this resync
        // marks stale again and converges through one more pass.
        if (this.droppedWhileStale) {
          // An update arrived after the engine produced this resync state but
          // before it was applied here; its content is durable engine-side, so
          // one more pass folds it in. The stale guard stays SET across the
          // next pass: clearing it first would open an await-window where
          // local edits journal against a baseline the second pass immediately
          // advances past.
          this.droppedWhileStale = false;
          continue;
        }
        this.staleError = null;
        this.notifyListeners(this.headChangedListeners, this.headSha256);
        if (this.ownerDraft) this.notifyListeners(this.ownerDraftChangedListeners, undefined);
        return update;
      }
    } finally {
      // Release the coalesced read before observers' queued invalidations run.
      this.resyncPending = null;
    }
  }

  /**
   * Whether durable state read back from the engine continues this session's
   * lineage. The engine claims an unclaimed lineage in the transaction of a
   * record, so a record whose response was lost leaves this session unclaimed
   * while the engine holds the claim it made from this very history. The
   * session takes that claim and keeps its document. Any other change of
   * claim is a different lineage.
   */
  private continuesLineage(durable: {
    lineageClaimId: string | null;
    lineageOriginatedHere: boolean;
  }): boolean {
    if (durable.lineageClaimId === this.lineageClaimId) return true;
    if (
      this.lineageClaimId !== null ||
      durable.lineageClaimId === null ||
      !durable.lineageOriginatedHere
    ) {
      return false;
    }
    this.lineageClaimId = durable.lineageClaimId;
    this.lineageOriginatedHere = true;
    return true;
  }

  private async requestResyncState(): Promise<{
    update: Uint8Array;
    lineageClaimId: string | null;
    lineageOriginatedHere: boolean;
    recoveredPaths: string[];
    artifactAssets: readonly ArtifactAssetDescriptor[];
  }> {
    const delivery = await this.adapter.requestWithBlob(
      this.workspace,
      YDOC_METHOD.resync,
      { sessionId: this.sessionId },
    );
    const result = decodeYdocResult(YDOC_METHOD.resync, delivery.result);
    if (this.closed) throw new YdocAdapterError("session-closed", "The Y.Doc adapter session is closed.");
    this.ownerDraft = result.ownerDraft;
    this.headSha256 = result.headSha256;
    return {
      update: delivery.bytes,
      lineageClaimId: result.lineageClaimId,
      lineageOriginatedHere: result.lineageOriginatedHere,
      recoveredPaths: result.recoveredPaths,
      artifactAssets: result.artifactAssets,
    };
  }

  async close(options?: { settle?: boolean; summary?: string }): Promise<void> {
    if (this.closed) return;
    await this.recordChain.catch(() => undefined);
    const params: YdocCloseParams = {
      sessionId: this.sessionId,
      ...(options?.settle !== undefined ? { settle: options.settle } : {}),
      ...(options?.summary ? { summary: options.summary } : {}),
    };
    try {
      decodeYdocResult(
        YDOC_METHOD.close,
        await this.adapter.request(this.workspace, YDOC_METHOD.close, params),
      );
    } catch (error) {
      if (!isYdocSessionNotFoundRefusal(error)) throw error;
    }
    this.closed = true;
    this.durableLocalChangeListeners.clear();
    this.settlementWantedListeners.clear();
    this.localUpdateAcknowledgedListeners.clear();
    this.localUpdateRefusedListeners.clear();
    this.acknowledgedDoc.destroy();
    this.ownerDraftChangedListeners.clear();
    this.doc.off("update", this.handleDocUpdate);
    for (const retired of this.retiredDocs) retired.destroy();
    this.retiredDocs.clear();
    this.adapter.releaseSession(this.sessionId);
  }

  // End the session without settling and without pruning. The daemon drops
  // the session and its lease; the durable lineage keeps every update this
  // document journaled, so the next open resurrects them.
  async evict(): Promise<void> {
    if (this.closed) return;
    await this.recordChain.catch(() => undefined);
    const params: YdocEvictParams = { sessionId: this.sessionId };
    try {
      decodeYdocResult(
        YDOC_METHOD.evict,
        await this.adapter.request(this.workspace, YDOC_METHOD.evict, params),
      );
    } catch (error) {
      if (!isYdocSessionNotFoundRefusal(error)) throw error;
    }
    this.closed = true;
    this.durableLocalChangeListeners.clear();
    this.settlementWantedListeners.clear();
    this.localUpdateAcknowledgedListeners.clear();
    this.localUpdateRefusedListeners.clear();
    this.acknowledgedDoc.destroy();
    this.ownerDraftChangedListeners.clear();
    this.doc.off("update", this.handleDocUpdate);
    for (const retired of this.retiredDocs) retired.destroy();
    this.retiredDocs.clear();
    this.adapter.releaseSession(this.sessionId);
  }

  private readonly handleDocUpdate = (
    update: Uint8Array,
    origin: unknown,
  ): void => {
    try {
      if (this.closed) return;
      if (origin === ENGINE_DELIVERED_ORIGIN) {
        this.notifyListeners(this.remoteUpdateListeners, update);
        return;
      }
      if (origin !== LOCAL_EDITOR_ORIGIN) return;

      const capture = this.activeLocalRecordCapture;
      assertDocUtf16IsSafe(
        this.doc,
        capture?.before ?? snapshotDocUtf16(this.doc),
        () =>
          capture?.beforeState
            ? deletedReplacementCounts(capture.beforeState, update)
            : new Map<string, number>(),
        capture?.seedUpdate ?? false,
      );
      if (capture?.originalUpdate !== undefined) return;
      const operation = this.enqueueRecordUpdate(
        update,
        capture?.options,
        capture?.seedUpdate ?? false,
      );
      if (capture !== null) capture.operation = operation;
    } catch (error) {
      if (origin === LOCAL_EDITOR_ORIGIN) {
        const rejection =
          error instanceof Error ? error : new Error("Unknown local Y.Doc observer failure.");
        if (this.activeLocalRecordCapture !== null) {
          this.activeLocalRecordCapture.rejection = rejection;
        }
        if (!isYdocUpdateAdmissionRefusal(rejection) && !isLineageChange(rejection)) this.quarantine(rejection);
        this.surfaceSessionError(rejection);
      } else {
        this.surfaceSessionError(error);
      }
    }
  };

  private runLocalMutation(
    mutation: () => void,
    options?: ApplyLocalUpdateOptions,
    seedUpdate = false,
    originalUpdate?: Uint8Array,
  ): Promise<YdocRecordUpdateResult | undefined> {
    this.assertRecordable();
    const before = snapshotDocUtf16(this.doc);
    const capture: LocalRecordCapture = {
      options: options === undefined ? undefined : structuredClone(options),
      originalUpdate,
      before,
      beforeState: hasReplacementChars(before) ? Y.encodeStateAsUpdate(this.doc) : null,
      seedUpdate,
    };
    this.activeLocalRecordCapture = capture;
    try {
      mutation();
    } finally {
      this.activeLocalRecordCapture = null;
    }
    if (capture.rejection !== undefined) throw capture.rejection;
    return originalUpdate === undefined
      ? capture.operation ?? Promise.resolve(undefined)
      : this.enqueueRecordUpdate(originalUpdate, capture.options, seedUpdate);
  }

  private quarantine(cause: unknown): void {
    this.quarantinedError ??= new YdocSessionQuarantinedError(cause);
  }

  private notifyListeners<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        this.surfaceSessionError(error);
      }
    }
  }

  private surfaceSessionError(error: unknown): void {
    for (const listener of this.sessionErrorListeners) {
      try {
        listener(error);
      } catch {
        // Error channels are terminal observer boundaries; listener failures
        // must never escape into Yjs transaction cleanup.
      }
    }
  }

  private assertOpen(): void {
    this.assertRecordable();
    if (this.staleError !== null) throw this.staleError;
  }

  // A pending resync does not stop an ordinary session from journaling. The
  // engine appends a local update only to the lineage its expected claim
  // names, so the resync merges both sides. A keystroke refused here would instead tear
  // the session down and rebuild it. An owner draft still waits, because its
  // append names the draft revision the resync renews.
  private assertRecordable(): void {
    if (this.closed) {
      throw new YdocAdapterError(
        "session-closed",
        "The Y.Doc adapter session is closed.",
      );
    }
    if (this.quarantinedError !== null) throw this.quarantinedError;
    if (this.ownerDraft !== undefined && this.staleError !== null) throw this.staleError;
  }
}

export class YdocLiveAdapter {
  private readonly sessions = new Map<string, YdocAdapterSession>();
  private readonly unsubscribeEvents: () => void;
  private readonly requester: WorkspaceDaemonRequester;
  private readonly eventPositions = new Map<
    string,
    { seq: number; sessionGeneration: number }
  >();

  constructor(transport: EngineTransport) {
    this.requester = new WorkspaceDaemonRequester(transport);
    this.unsubscribeEvents = transport.onEvent((event) => this.receiveEvent(event));
  }

  async openSession(
    input: OpenYdocAdapterSessionInput,
  ): Promise<YdocAdapterSession> {
    const params: YdocOpenParams = {
      ...(input.allowLossySourceSha256 ? { allowLossySourceSha256: input.allowLossySourceSha256 } : {}),
      versionId: input.versionId,
      path: input.path,
      ...(input.expectedObjectId
        ? { expectedObjectId: input.expectedObjectId }
        : {}),
      ...(input.contentKind ? { contentKind: input.contentKind } : {}),
      ...(input.contentKind === "scene"
        ? { seedFromArtifact: input.seedAbsentLineage !== false }
        : {}),
      ...(input.largeSeed ? { seedLimitBytes: input.largeSeed.maxBytes } : {}),
    };
    const startedAtMs = performance.now();
    let delivery: Awaited<ReturnType<YdocLiveAdapter["requestWithBlob"]>>;
    try {
      delivery = await this.requestWithBlob(
        input.workspace,
        YDOC_METHOD.open,
        params,
        { deadlineMs: YDOC_OPEN_DEADLINE_MS },
      );
    } catch (error) {
      if (!isYdocOpenDeadlineFailure(error)) throw error;
      throw new YdocOpenTimedOutError(
        input.path,
        Math.round(performance.now() - startedAtMs),
        error instanceof DaemonRefusalError ? error.cause : error,
      );
    }
    const result = decodeYdocResult(YDOC_METHOD.open, delivery.result);
    const session = new YdocAdapterSession(this, input.workspace, result.sessionId, {
      objectId: result.objectId,
      path: result.path,
      contentKind: result.contentKind,
      initialUpdate: delivery.bytes,
      ownerDraft: result.ownerDraft,
      artifactAssets: result.artifactAssets,
      lineageClaimId: result.lineageClaimId,
      lineageOriginatedHere: result.lineageOriginatedHere,
    });
    this.sessions.set(result.sessionId, session);
    session.head = result.head;
    session.headSha256 = result.headSha256;
    session.lineage = result.lineage;
    session.unsettled = result.unsettled;
    // `lineage` (durable CRDT state) is not `head` (a snapshot in this
    // version). An ordinary first open of a captured file is lineage-absent
    // and head-present, and that is exactly the seed case below.
    const lineageAbsent = result.lineage === "absent";
    if (
      lineageAbsent &&
      input.seedAbsentLineage !== false &&
      (typeof result.seedContent === "string" ||
        result.seedBlobSha256 !== undefined)
    ) {
      try {
        if (result.contentKind === "scene") {
          throw new YdocAdapterError(
            "response-mismatch",
            "The engine returned text seed content for a scene. The engine must seed scenes in the initial Y.Doc update.",
          );
        }
        const seedContent =
          result.seedContent ??
          (await this.readSeedBlob(input, result.seedBlobSha256 ?? ""));
        if (!isWellFormedUtf16(seedContent)) {
          throw new IllFormedUtf16EditError();
        }
        const clientID = result.seedClientId;
        if (
          clientID === undefined ||
          !Number.isInteger(clientID) ||
          clientID < 1 ||
          clientID > 0xffff_ffff
        ) {
          throw new YdocAdapterError(
            "response-mismatch",
            "The engine returned seed content without a valid seed client id.",
          );
        }
        const seedDoc =
          result.contentKind === "plaintext"
            ? createPlaintextSeedDoc(seedContent, clientID)
            : markdownToYDoc(seedContent, { clientID });
        try {
          if (result.contentKind === "richdoc") {
            let projection: string | undefined;
            try {
              projection = yDocToMarkdown(seedDoc);
            } catch {
              // The serializer rejects some accepted imports. They can still
              // open, but cannot carry an exact-source witness yet.
            }
            if (projection !== undefined && projection !== seedContent) {
              // The first replicated base must still match the captured file.
              // The engine validates this source against the projection witness.
              const meta = seedDoc.getMap("meta");
              meta.set("dohcMarkdownSource", seedContent);
              meta.set(
                "dohcMarkdownSourceSha256",
                createHash("sha256").update(seedContent).digest("hex"),
              );
              meta.set(
                "dohcMarkdownSourceProjectionSha256",
                createHash("sha256").update(projection).digest("hex"),
              );
            }
          }
          await session.applySeedUpdate(Y.encodeStateAsUpdate(seedDoc));
          // The exposed initial state must include the seed: consumers (the
          // desktop bridge) forward session.initialUpdate to the renderer,
          // and the pre-seed encoding would render an empty document and
          // baseline subsequent edits wrongly.
          session.initialUpdate = Y.encodeStateAsUpdate(session.doc);
        } finally {
          seedDoc.destroy();
        }
      } catch (error) {
        // A failed seed must not leak the registered session (and with it
        // the daemon lease). settle:false is refused precisely when the
        // seed committed before the failure surfaced (dirty lineage — e.g.
        // a request timeout on an applied update): fall back to a settling
        // close so the committed seed becomes the artifact and the daemon
        // entry actually releases instead of wedging until workspace close.
        this.releaseSession(result.sessionId);
        try {
          await this.request(input.workspace, YDOC_METHOD.close, {
            sessionId: result.sessionId,
            settle: false,
          });
        } catch {
          await this.request(input.workspace, YDOC_METHOD.close, {
            sessionId: result.sessionId,
            settle: true,
          }).catch(() => undefined);
        }
        throw error;
      }
    }
    return session;
  }

  // A seed past the in-band cap, read by the digest the open named. The bytes
  // must hash to that digest, so the seed is exactly the head the engine
  // derived the seed client from.
  private async readSeedBlob(
    input: OpenYdocAdapterSessionInput,
    sha256: string,
  ): Promise<string> {
    if (input.largeSeed === undefined || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new YdocAdapterError(
        "response-mismatch",
        "The engine returned a seed blob this open did not ask for.",
      );
    }
    const delivery = await this.requester.requestWithBlob(
      VERSIONED_METHOD.textReadBlob,
      { workspaceId: input.largeSeed.workspaceId, sha256 },
      (raw) =>
        decodeVersionedResult(VERSIONED_METHOD.textReadBlob, raw)
          .bytesBase64 === null,
      // The open holds its lease while this read runs, so it gets the open's
      // own bound.
      { workspace: input.workspace, deadlineMs: YDOC_OPEN_DEADLINE_MS },
    );
    const read = decodeVersionedResult(
      VERSIONED_METHOD.textReadBlob,
      delivery.result,
    );
    const bytes =
      read.bytesBase64 !== null
        ? new Uint8Array(Buffer.from(read.bytesBase64, "base64"))
        : delivery.blob?.bytes;
    if (
      bytes === undefined ||
      bytes.byteLength > input.largeSeed.maxBytes ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    ) {
      throw new YdocAdapterError(
        "response-mismatch",
        "The seed blob does not match the digest the engine named.",
      );
    }
    // ignoreBOM keeps a leading U+FEFF, which the digest covers.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }

  async request(
    workspace: WorkspaceHandle,
    method: string,
    params: Request["params"],
    options?: { idempotencyKey?: string; deadlineMs?: number },
  ): Promise<Response["result"]> {
    return this.requester.request(method, params, {
      workspace,
      ...(options?.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      ...(options?.deadlineMs !== undefined
        ? { deadlineMs: options.deadlineMs }
        : {}),
    });
  }

  async requestWithBlob(
    workspace: WorkspaceHandle,
    method: typeof YDOC_METHOD.open | typeof YDOC_METHOD.resync,
    params: Request["params"],
    options?: { deadlineMs?: number },
  ): Promise<{ result: Response["result"]; bytes: Uint8Array }> {
    const delivery = await this.requester.requestWithBlob(
      method,
      params,
      () => true,
      {
        workspace,
        ...(options?.deadlineMs !== undefined
          ? { deadlineMs: options.deadlineMs }
          : {}),
      },
    );
    if (delivery.blob === null) {
      throw new YdocAdapterError(
        "missing-response-blob",
        `${method} completed without its mandatory raw state blob.`,
      );
    }
    return {
      result: delivery.result,
      bytes: delivery.blob.bytes,
    };
  }

  releaseSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.eventPositions.delete(sessionId);
  }

  dispose(): void {
    this.unsubscribeEvents();
  }

  private receiveEvent(event: Event): void {
    try {
      if (event.name !== YDOC_EVENT.remoteUpdate) return;
      const payload = decodeYdocRemoteUpdatePayload(event.payload);
      const session = this.sessions.get(payload.sessionId);
      if (session === undefined) return;
      if ("settlementWanted" in payload) {
        session.requestSettlement();
        return;
      }
      if ("resyncRequired" in payload) {
        session.markStale(new YdocResyncNeededError({reason: "native-state-changed", event}));
        return;
      }
      const previous = this.eventPositions.get(payload.sessionId);
      this.eventPositions.set(payload.sessionId, {
        seq: event.seq,
        sessionGeneration: event.sessionGeneration,
      });
      if (
        previous !== undefined &&
        event.sessionGeneration !== previous.sessionGeneration
      ) {
        session.markStale(
          new YdocResyncNeededError({
            reason: "session-generation-changed",
            event,
          }),
        );
        return;
      }
      if (previous !== undefined && event.seq !== previous.seq + 1) {
        session.markStale(
          new YdocResyncNeededError({
            reason: "event-sequence-gap",
            event,
          }),
        );
        return;
      }
      session.receiveRemoteUpdate(base64ToBytes(payload.updateBase64));
    } catch (cause) {
      this.markAllSessionsStale(
        new YdocResyncNeededError({
          reason: "event-decode-failed",
          event,
          cause,
        }),
      );
    }
  }

  private markAllSessionsStale(error: YdocResyncNeededError): void {
    for (const session of this.sessions.values()) session.markStale(error);
  }
}
