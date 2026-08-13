import { createHash } from "node:crypto";
import * as Y from "yjs";
import { EXCALIDRAW_SCENE_ROOTS } from "@dohc/workspace-contracts/live-documents";
import type { Event } from "./generated/Event";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { Request } from "./generated/Request";
import type { Response } from "./generated/Response";
import type { EngineTransport } from "./ydocLiveAdapter";
import {
  YDOC_EVENT,
  YDOC_METHOD,
  type JsonObject,
  type YdocContentKind,
} from "./ydocWireContract";

interface LoopbackFile {
  // Object ids are only unique WITHIN a scope, matching the daemon's
  // `DocKey` (workspace_id, version_id, object_id) — a fixture that reuses
  // an id across scopes must never let one scope's row cover another's.
  workspace: string;
  versionId: string;
  objectId: string;
  contentKind: YdocContentKind;
  content: string;
  // Whether this version has a file snapshot.
  head: "present" | "absent";
}

// Mirrors `dohc_engine_collab::durable::Regime`: LocalOnly is a prunable
// fast-resume cache (the artifact is durable canonical), Replicated is the
// durable canonical CRDT lineage itself, and its close NEVER prunes it.
type LineageRegime = "local-only" | "replicated";

interface Lineage {
  doc: Y.Doc;
  regime: LineageRegime;
  // The content kind the lineage was created under. `ydoc_open_state_on_store`
  // reads this off the persisted marker whenever durable state exists,
  // never off the reopen's request — a plaintext lineage resurrected under
  // a richdoc request would settle the EMPTY `body` fragment instead of the
  // `plainText` content it actually holds.
  contentKind: YdocContentKind;
  // The content sha the last settle over this lineage materialized, or
  // `null` if it was never settled — mirrors `ydoc_docs.last_settled_sha`,
  // the durable close guard's coverage check.
  lastSettledSha: string | null;
}

interface LoopbackSession {
  sessionId: string;
  workspace: string;
  versionId: string;
  objectId: string;
  path: string;
  contentKind: YdocContentKind;
  doc: Y.Doc;
  updateSeq: number;
  eventSeq: number;
  // Mirrors the daemon session's `lineage_absent` / `first_update_pending`
  // (crates/dohc-workspace-engine/src/lib.rs), which decide close()'s
  // implicit settle default: settle unless this session opened onto no
  // lineage and has recorded no update yet.
  lineageAbsentAtOpen: boolean;
  firstUpdatePending: boolean;
}

export interface EmitLoopbackRemoteUpdateOptions {
  seq?: number;
  sessionGeneration?: number;
}

export interface SeedLoopbackFileInput {
  workspace: string;
  versionId: string;
  path: string;
  content: string;
  contentKind?: YdocContentKind;
  objectId?: string;
  // The default models an ordinary captured file with a version snapshot.
  head?: "present" | "absent";
}

function fileKey(workspace: string, versionId: string, path: string): string {
  return `${workspace}\u0000${versionId}\u0000${path}`;
}

// The daemon's `ydoc_docs` row is keyed by (workspace, version, objectId) —
// object identity, not path (crates/dohc-engine-collab/src/durable.rs). A
// path-keyed lineage map would resurrect a rename's old text under a
// different object and let a reused path inherit a stranger's edits; this is
// the key `open()` resolves the path alias through.
// Both the daemon's absent-head open (`ydoc_open_state_on_store`,
// crates/dohc-engine-runtime/src/actor.rs) and its capture ingestion
// (crates/dohc-workspace-engine/src/store.rs) resolve an unrecorded path to
// the SAME `derive_capture_object_id`, so a path capture seeds later finds
// the id its own earlier open already derived. `seedFile`'s default reuses
// this instead of an unrelated counter — a mismatched default would make
// capture-seeding a path AFTER it was already opened land on a fresh object
// id, orphaning the lineage the open's derived id created.
function deriveObjectId(fileLookupKey: string): string {
  return `object-derived-${fileLookupKey}`;
}

function lineageKey(
  workspace: string,
  versionId: string,
  objectId: string,
): string {
  return `${workspace}\u0000${versionId}\u0000${objectId}`;
}

function unsettledCloseRefusal(): Error {
  return Object.assign(new Error("ydoc-unsettled-close"), {
    wireError: {
      code: "INVALID_PARAMS",
      message: "ydoc-unsettled-close",
      retry: "no",
    },
  });
}

// The literal from crates/dohc-workspace-engine/src/lib.rs's
// `CollabError::ObjectAliasCollision` mapping.
function objectAliasCollisionRefusal(): Error {
  return Object.assign(new Error("ydoc-object-alias-collision"), {
    wireError: {
      code: "INVALID_PARAMS",
      message: "ydoc-object-alias-collision",
      retry: "no",
    },
  });
}

// `CollabError::NoMarker` has no specific message mapping in
// crates/dohc-workspace-engine/src/lib.rs — it falls through to the
// generic InvalidParams tail, so this is the literal the wire actually
// carries.
function noMarkerRefusal(): Error {
  return Object.assign(new Error("workspace operation failed"), {
    wireError: {
      code: "INVALID_PARAMS",
      message: "workspace operation failed",
      retry: "no",
    },
  });
}

function asObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requiredString(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} is invalid.`);
  return value;
}

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} is invalid.`);
  return value;
}

function optionalBoolean(object: JsonObject, key: string): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} is invalid.`);
  return value;
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function declaredDoc(contentKind?: YdocContentKind): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("frontmatter");
  doc.getMap("meta");
  doc.getXmlFragment("body");
  doc.getText("plainText");
  if (contentKind === "scene") {
    doc.getMap(EXCALIDRAW_SCENE_ROOTS.revisions);
    doc.getMap(EXCALIDRAW_SCENE_ROOTS.appState);
    doc.getMap(EXCALIDRAW_SCENE_ROOTS.assets);
  }
  return doc;
}

/// The lineage brought back as a fresh session's doc, exactly as the daemon's
/// reopen replays its durable rows.
function resurrectedDoc(lineage: Y.Doc, contentKind: YdocContentKind): Y.Doc {
  const doc = declaredDoc(contentKind);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(lineage));
  return doc;
}

function project(session: LoopbackSession): string {
  if (session.contentKind === "plaintext") {
    return session.doc.getText("plainText").toString();
  }
  if (session.contentKind === "scene") {
    throw new Error(
      "The Y.Doc loopback cannot project scene documents. Use the workspace engine to settle scenes.",
    );
  }
  return session.doc
    .getXmlFragment("body")
    .toArray()
    .map((node) => {
      if (node instanceof Y.XmlText) return node.toString();
      if (node instanceof Y.XmlElement) {
        return node
          .toArray()
          .map((child) => child.toString())
          .join("");
      }
      return node.toString();
    })
    .join("\n\n");
}

export interface YdocLoopbackEngineOptions {
  // The daemon writes the projected content to the workspace file as part of
  // settle, which is what its `materialized: true` reports. A loopback with no
  // materializer reports that same flag while nothing reaches disk — a caller
  // that reads the file back then sees content only because something else
  // wrote it. Tests that read the file pass this in.
  //
  // It writes on every supported text settle, including one the daemon answers
  // from the lineage without touching a drifted file. That is more than the
  // daemon does, so no test may use this hook to prove what happens to a file
  // the daemon leaves alone. Those cases belong to a real-daemon test. Scene
  // settles refuse because the loopback has no store-backed asset projector.
  materialize?: (input: { path: string; content: string }) => void;
}

export class YdocLoopbackEngine implements EngineTransport {
  readonly requests: Request[] = [];
  readonly responses: Response[] = [];
  readonly events: Event[] = [];
  readonly recordedUpdates: Uint8Array[] = [];

  private readonly files = new Map<string, LoopbackFile>();
  private readonly sessions = new Map<string, LoopbackSession>();
  // The durable CRDT rows, which do NOT belong to a session. The daemon keeps
  // them across an eviction and resurrects them on the next open, and a
  // local-only close is the one thing that prunes them
  // (crates/dohc-engine-collab/src/durable.rs). A loopback that stored the
  // lineage in the session map instead would report an evicted document as
  // gone — modelling less than the daemon, so every test driving it would
  // certify a convergence that does not happen (#665). Keyed by
  // (workspace, version, objectId) — see `lineageKey` — not by path.
  private readonly lineages = new Map<string, Lineage>();
  private readonly eventHandlers = new Set<(event: Event) => void>();
  private nextSessionId = 1;
  private nextMomentId = 1;
  private nextRecaptureOrder = 2;

  constructor(private readonly options: YdocLoopbackEngineOptions = {}) {}

  seedFile(input: SeedLoopbackFileInput): void {
    const key = fileKey(input.workspace, input.versionId, input.path);
    // Mirrors `resolve_capture_object`'s FIRST step, `alias_object_id`: a
    // path that already has a known alias reuses it, before derivation or
    // disambiguation ever run. An ordinary re-capture of the same path
    // (content changed, no rename) must keep the object identity its
    // current row already holds — including an explicit or previously
    // disambiguated id — or the evicted lineage behind it becomes
    // unreachable.
    const objectId =
      input.objectId ??
      this.files.get(key)?.objectId ??
      this.resolveDefaultObjectId(input.workspace, key);
    // The daemon keeps ONE snapshot row per object: a capture that lands
    // the SAME object at a new path replaces its row rather than adding a
    // second one, or a scan over `files` (capturedFileFor) would find the
    // stale row first and never reach the current one.
    for (const [otherKey, file] of this.files) {
      if (
        otherKey !== key &&
        file.workspace === input.workspace &&
        file.versionId === input.versionId &&
        file.objectId === objectId
      ) {
        this.files.delete(otherKey);
      }
    }
    this.files.set(key, {
      workspace: input.workspace,
      versionId: input.versionId,
      objectId,
      contentKind: input.contentKind ?? "richdoc",
      content: input.content,
      head: input.head ?? "present",
    });
  }

  // Mirrors `resolve_capture_object`'s disambiguation branch
  // (crates/dohc-engine-domain/src/store.rs): a path's default id must not
  // collide with an object that renamed away and is still live elsewhere.
  private resolveDefaultObjectId(workspace: string, key: string): string {
    const derived = deriveObjectId(key);
    return this.objectHasLiveAliasElsewhere(workspace, key, derived)
      ? `${derived}#recaptured-${this.nextRecaptureOrder++}`
      : derived;
  }

  // Mirrors `object_has_live_alias` (crates/dohc-engine-domain/src/store.rs):
  // true when some path OTHER than `excludingKey`, WITHIN `workspace`,
  // currently holds this exact object id — the sign an object renamed
  // away and is still referenced elsewhere. Scoped to the workspace like
  // the daemon's query (`WHERE workspace_id = ?1 AND object_id = ?2`):
  // object ids are unique only within a workspace, so a fixture in a
  // DIFFERENT workspace reusing this exact string must never collide.
  // Shared by capture's id resolution (above) and open's collision
  // refusal (`open()`, actor.rs ydoc_open_state_on_store) — the SAME
  // rule, at the two sites that mint an id from a bare path.
  private objectHasLiveAliasElsewhere(
    workspace: string,
    excludingKey: string,
    objectId: string,
  ): boolean {
    for (const [otherKey, file] of this.files) {
      if (
        file.workspace === workspace &&
        otherKey !== excludingKey &&
        file.objectId === objectId
      ) {
        return true;
      }
    }
    return false;
  }

  // Test-only seam for the sync-promotion the daemon does inside
  // `claim_base_in_tx` when a peer's base lands: it promotes the marker's
  // regime from local-only to replicated. Sync is not built (#356, #378), so
  // there is no wire method to reach this from a test; a replicated
  // lineage's close compacts and KEEPS the CRDT rows regardless of settle
  // state, which is what this exists to exercise.
  //
  // Requires an existing lineage entry: a replicated doc has durable state
  // by definition (`claim_base_in_tx` promotes a MARKER that already
  // exists), and every server-side content source — a captured seed, a
  // resurrection, a local edit, a remote update — journals a lineage
  // before a session's doc can hold anything this seam would need to
  // preserve. A session with no lineage entry is un-modelable here, not a
  // case to paper over with a fabricated fallback doc.
  markSessionReplicated(sessionId: string): void {
    const session = this.requireSession(sessionId);
    const key = this.lineageKeyFor(session);
    const entry = this.lineages.get(key);
    if (!entry) {
      throw new Error(
        "markSessionReplicated requires a journaled lineage; record an update first.",
      );
    }
    entry.regime = "replicated";
    this.lineages.set(key, entry);
  }

  onEvent(handler: (event: Event) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    const result = this.handleRequest(request);
    const response: Response = { id: request.id, result };
    this.responses.push(response);
    return response;
  }

  activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  sessionText(sessionId: string): string {
    return project(this.requireSession(sessionId));
  }

  sessionStateUpdate(sessionId: string): Uint8Array {
    return Y.encodeStateAsUpdate(this.requireSession(sessionId).doc);
  }

  applyRemoteUpdate(
    sessionId: string,
    update: Uint8Array,
    options?: EmitLoopbackRemoteUpdateOptions,
  ): void {
    const session = this.requireSession(sessionId);
    Y.applyUpdate(session.doc, update);
    this.journalSessionState(session);
    this.emitRemoteUpdate(sessionId, update, options);
  }

  emitRemoteUpdate(
    sessionId: string,
    update: Uint8Array,
    options?: EmitLoopbackRemoteUpdateOptions,
  ): void {
    const session = this.requireSession(sessionId);
    const seq = options?.seq ?? session.eventSeq + 1;
    session.eventSeq = seq;
    const event: Event = {
      seq,
      sessionGeneration: options?.sessionGeneration ?? 1,
      name: YDOC_EVENT.remoteUpdate,
      payload: {
        sessionId,
        updateBase64: encodeBase64(update),
      },
    };
    this.emitEvent(event);
  }

  emitEvent(event: Event): void {
    this.events.push(event);
    for (const handler of this.eventHandlers) handler(event);
  }

  private handleRequest(request: Request): JsonValue {
    switch (request.method) {
      case YDOC_METHOD.open:
        return this.open(request);
      case YDOC_METHOD.recordUpdate:
        return this.recordUpdate(request);
      case YDOC_METHOD.settle:
        return this.settle(request.params);
      case YDOC_METHOD.applyExternalMarkdownEdit:
        return this.applyExternalMarkdownEdit(request.params);
      case YDOC_METHOD.close:
        return this.close(request.params);
      case YDOC_METHOD.evict:
        return this.evict(request.params);
      case YDOC_METHOD.resync:
        return this.resync(request.params);
      default:
        throw new Error(`Unsupported loopback method: ${request.method}`);
    }
  }

  private open(request: Request): JsonValue {
    if (typeof request.workspace !== "string") {
      throw new Error("ydoc.open requires a workspace handle.");
    }
    const params = asObject(request.params, "ydoc.open params");
    const versionId = requiredString(params, "versionId", "ydoc.open params");
    const path = requiredString(params, "path", "ydoc.open params");
    const requestedKind = optionalString(params, "contentKind");
    if (
      requestedKind !== undefined &&
      requestedKind !== "richdoc" &&
      requestedKind !== "plaintext" &&
      requestedKind !== "scene"
    ) {
      throw new Error("ydoc.open params.contentKind is invalid.");
    }
    const fileLookupKey = fileKey(request.workspace, versionId, path);
    const file = this.files.get(fileLookupKey);
    let objectId: string;
    if (file) {
      objectId = file.objectId;
    } else {
      const derived = deriveObjectId(fileLookupKey);
      // A derived id still LIVE at another alias means this path's former
      // file was renamed away: only capture's locked resolution may mint a
      // disambiguated id for that (resolve_capture_object); an open cannot
      // reserve one pre-commit, so it refuses instead of grafting onto the
      // renamed file's lineage (actor.rs ydoc_open_state_on_store).
      if (this.objectHasLiveAliasElsewhere(request.workspace, fileLookupKey, derived)) {
        throw objectAliasCollisionRefusal();
      }
      objectId = derived;
    }
    const sessionId = `session-${this.nextSessionId++}`;
    // A surviving lineage RESURRECTS: it is the document's own state, and it
    // outranks the file exactly as the daemon's does. Keyed by OBJECT
    // IDENTITY (workspace, version, objectId) — see `lineageKey` — so a
    // rename resurrects the same lineage and a path a different object now
    // occupies does not inherit its predecessor's edits.
    const lineageMapKey = lineageKey(request.workspace, versionId, objectId);
    const lineage = this.lineages.get(lineageMapKey);
    // NO HEAD in this version. The daemon does NOT refuse here — it derives an
    // object id and binds an EMPTY doc, which is how a just-created file
    // becomes editable before capture ingests it (actor.rs
    // ydoc_open_state_on_store, head == None). A loopback that threw instead
    // modelled less than the daemon and hid every consumer bug on that branch.
    //
    // A RESURRECTION uses the lineage's OWN stored kind, never the reopen's
    // request: ydoc_open_state_on_store reads the persisted marker's
    // content_kind whenever durable state exists. Binding a plaintext
    // lineage as richdoc would settle the empty `body` fragment instead of
    // the `plainText` content it actually holds.
    const contentKind = lineage
      ? lineage.contentKind
      : (requestedKind ?? file?.contentKind ?? "richdoc");
    const doc = lineage
      ? resurrectedDoc(lineage.doc, contentKind)
      : declaredDoc(contentKind);
    const lineageAbsentAtOpen = lineage === undefined;
    // A captured file with no durable lineage yet ships its content as
    // `seedContent`, not embedded in `initialUpdateBase64` — the CLIENT
    // applies it as a real local update and records it through
    // `ydoc.recordUpdate` (`YdocLiveAdapter.openSession`), exactly as
    // `ydoc_open_state_on_store` does (actor.rs): `initial_update` stays
    // the EMPTY doc's state, and `seed_content` carries the head's text
    // separately, `(!lineage_existing).then(|| head...).flatten()`. That
    // recordUpdate is what clears `firstUpdatePending` — embedding the
    // seed directly into the initial doc here (as an earlier version of
    // this loopback did) leaves an ordinary settle over a freshly-opened
    // captured file looking untouched forever, and the NoMarker guard
    // refuses it.
    const seedContent =
      !lineage && file?.head === "present" ? file.content : undefined;
    this.sessions.set(sessionId, {
      sessionId,
      workspace: request.workspace,
      versionId,
      objectId,
      path,
      contentKind,
      doc,
      updateSeq: 0,
      eventSeq: 0,
      lineageAbsentAtOpen,
      firstUpdatePending: lineageAbsentAtOpen,
    });
    return {
      sessionId,
      objectId,
      path,
      contentKind,
      initialUpdateBase64: encodeBase64(Y.encodeStateAsUpdate(doc)),
      lineage: lineage ? "existing" : "absent",
      lineageClaimId: null,
      head: file ? file.head : "absent",
      ...(seedContent !== undefined ? { seedContent } : {}),
    };
  }

  private recordUpdate(request: Request): JsonValue {
    if (
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.length === 0
    ) {
      throw new Error("ydoc.recordUpdate requires an idempotency key.");
    }
    const params = asObject(request.params, "ydoc.recordUpdate params");
    const session = this.requireSession(
      requiredString(params, "sessionId", "ydoc.recordUpdate params"),
    );
    const update = decodeBase64(
      requiredString(params, "updateBase64", "ydoc.recordUpdate params"),
    );
    optionalString(params, "actorOriginId");
    const validationDoc = declaredDoc(session.contentKind);
    Y.applyUpdate(validationDoc, Y.encodeStateAsUpdate(session.doc));
    Y.applyUpdate(validationDoc, update);
    Y.applyUpdate(session.doc, update);
    this.journalSessionState(session);
    this.recordedUpdates.push(update);
    session.updateSeq += 1;
    return { seq: session.updateSeq, lineageClaimId: null };
  }

  private settleSession(session: LoopbackSession): {
    content: string;
    sha256: string;
  } {
    // `ydoc_settle_on_store`'s `load_persisted` finds no marker row at all
    // for a session that has never recorded a durable update — a marker is
    // created lazily, by the first recordUpdate, not by open. Mirrors that
    // with NoMarker's wire shape rather than letting an untouched session's
    // structurally-empty projection materialize and clobber whatever the
    // artifact already holds. `close()`'s implicit default already avoids
    // this; this guards the EXPLICIT settle:true override, and the direct
    // `ydoc.settle` RPC, which share this same path.
    if (session.lineageAbsentAtOpen && session.firstUpdatePending) {
      throw noMarkerRefusal();
    }
    const content = project(session);
    const digest = sha256(content);
    this.options.materialize?.({ path: session.path, content });
    const entry = this.lineages.get(this.lineageKeyFor(session));
    if (entry) entry.lastSettledSha = digest;
    return { content, sha256: digest };
  }

  private settle(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.settle params");
    const session = this.requireSession(
      requiredString(params, "sessionId", "ydoc.settle params"),
    );
    optionalString(params, "summary");
    const { content, sha256: digest } = this.settleSession(session);
    return {
      momentId: `moment-${this.nextMomentId++}`,
      path: session.path,
      content,
      sha256: digest,
      // The loopback always "materializes": it has no containment to block.
      materialized: true,
      projection: {
        contentKind: session.contentKind,
        sourceStateVectorSha256: sha256(Y.encodeStateVector(session.doc)),
        destructive: false,
      },
    };
  }

  private applyExternalMarkdownEdit(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.applyExternalMarkdownEdit params");
    const session = this.requireSession(
      requiredString(
        params,
        "sessionId",
        "ydoc.applyExternalMarkdownEdit params",
      ),
    );
    const markdown = requiredString(
      params,
      "markdown",
      "ydoc.applyExternalMarkdownEdit params",
    );
    const before = Y.encodeStateVector(session.doc);
    session.doc.transact(() => {
      if (session.contentKind === "plaintext") {
        const text = session.doc.getText("plainText");
        text.delete(0, text.length);
        text.insert(0, markdown);
      } else {
        const body = session.doc.getXmlFragment("body");
        body.delete(0, body.length);
        if (markdown.length > 0) {
          const paragraph = new Y.XmlElement("paragraph");
          paragraph.insert(0, [new Y.XmlText(markdown)]);
          body.insert(0, [paragraph]);
        }
      }
    });
    this.journalSessionState(session);
    this.emitRemoteUpdate(
      session.sessionId,
      Y.encodeStateAsUpdate(session.doc, before),
    );
    return { kind: "merged", markdown };
  }

  private close(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.close params");
    const sessionId = requiredString(params, "sessionId", "ydoc.close params");
    const settleFlag = optionalBoolean(params, "settle");
    optionalString(params, "summary");
    const session = this.requireSession(sessionId);
    const key = this.lineageKeyFor(session);

    // The loopback cannot settle scenes because it has no store-backed asset
    // projector. A direct settle still refuses, but close must finish the
    // teardown so the adapter does not retain a session it can never release.
    if (session.contentKind === "scene") {
      if (settleFlag === true) project(session);
      if (this.lineages.get(key)?.regime === "local-only") {
        this.lineages.delete(key);
      }
      this.sessions.delete(sessionId);
      return { closed: true };
    }

    // Missing `settle` means SETTLE unless this session opened onto no
    // lineage and has recorded no update yet — mirrors
    // `!(session.lineage_absent && session.first_update_pending)`
    // (crates/dohc-workspace-engine/src/lib.rs).
    const shouldSettle =
      settleFlag ?? !(session.lineageAbsentAtOpen && session.firstUpdatePending);
    // Threaded through instead of recomputed below: when this settled, its
    // digest IS what `settleSession` just wrote to `lastSettledSha`, so the
    // coverage check a settling close can never refuse is stated here, not
    // left to fall out of two separate `sha256(project(session))` calls
    // agreeing.
    const settled = shouldSettle ? this.settleSession(session) : null;

    const entry = this.lineages.get(key);
    if (entry && entry.regime === "local-only") {
      // Local-only prune would DISCARD the CRDT rows — the daemon refuses
      // unless the artifact already holds the head's bytes
      // (durable.rs close_session): the projected content must match either
      // the last settle this lineage recorded, OR a CAPTURED head — the
      // `files` row IS this loopback's disk read, so a present head whose
      // content already matches the projection is the same proof
      // `captured_head_sha` reads there (durable.rs:1278-1310). That query
      // is scoped by (workspace, version, object_id) with NO path
      // restriction — a rename does not mint a new object — so the lookup
      // here resolves by object identity too, never by this session's own
      // path: a renamed object captured at its NEW path still covers the
      // OLD session's close, and a path rebound to a DIFFERENT object with
      // coincidentally identical content never covers this one. Absent
      // head covers nothing either, same as the daemon's read. A
      // REPLICATED lineage never takes this branch — its close compacts
      // and keeps the rows regardless of settle state (see
      // `markSessionReplicated`).
      const currentSha = settled?.sha256 ?? sha256(project(session));
      const capturedFile = this.capturedFileFor(
        session.workspace,
        session.versionId,
        session.objectId,
      );
      const coveredByCapture =
        capturedFile !== undefined &&
        capturedFile.head === "present" &&
        sha256(capturedFile.content) === currentSha;
      if (entry.lastSettledSha !== currentSha && !coveredByCapture) {
        throw unsettledCloseRefusal();
      }
      this.lineages.delete(key);
    }

    this.sessions.delete(sessionId);
    return { closed: true };
  }

  // The daemon drops the session and its lease and leaves the durable lineage
  // exactly as it stands. So the session map loses its entry and `lineages`
  // keeps its row — which is what makes the next open resurrect the document
  // instead of finding it gone.
  private evict(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.evict params");
    const sessionId = requiredString(params, "sessionId", "ydoc.evict params");
    this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    return { evicted: true };
  }

  private journalSessionState(session: LoopbackSession): void {
    // Journal the session's whole state because each delta depends on the
    // state that seeded its session.
    const key = this.lineageKeyFor(session);
    const entry = this.lineages.get(key) ?? {
      doc: declaredDoc(session.contentKind),
      regime: "local-only" as LineageRegime,
      contentKind: session.contentKind,
      lastSettledSha: null,
    };
    Y.applyUpdate(entry.doc, Y.encodeStateAsUpdate(session.doc));
    this.lineages.set(key, entry);
    session.firstUpdatePending = false;
  }

  private resync(value: JsonValue): JsonValue {
    const params = asObject(value, "ydoc.resync params");
    const session = this.requireSession(
      requiredString(params, "sessionId", "ydoc.resync params"),
    );
    // The live adapter preserves its event position across a resync, so the
    // loopback sequence stays MONOTONIC — resetting it would make the next
    // remote update emit seq 1 and re-mark the freshly-resynced session
    // stale.
    return {
      initialUpdateBase64: encodeBase64(Y.encodeStateAsUpdate(session.doc)),
      lineageClaimId: null,
      recoveredPaths: [],
    };
  }

  private lineageKeyFor(session: LoopbackSession): string {
    return lineageKey(session.workspace, session.versionId, session.objectId);
  }

  // The daemon's `captured_head_sha` query is scoped by
  // (workspace, version, object_id), not by path (durable.rs) — the
  // loopback's disk read must resolve the same way, so a renamed object's
  // capture at its NEW path is still found for an OLD session still bound
  // to it, and a fixture reusing an object id in a DIFFERENT scope never
  // covers this one.
  private capturedFileFor(
    workspace: string,
    versionId: string,
    objectId: string,
  ): LoopbackFile | undefined {
    for (const file of this.files.values()) {
      if (
        file.workspace === workspace &&
        file.versionId === versionId &&
        file.objectId === objectId
      ) {
        return file;
      }
    }
    return undefined;
  }

  private requireSession(sessionId: string): LoopbackSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown loopback session: ${sessionId}`);
    return session;
  }
}
