import { createHash } from "node:crypto";
import { parseAppCollectionCapability, parseAppCollectionCreateRequest, parseAppPublicationCandidate,
  type AppCollectionCapability, type AppCollectionPage, type AppCollectionReceipt } from "@dohc/security-contract/app-publication";
import { APP_COLLECTION_MAX_RECORD_BYTES, APP_COLLECTION_MAX_SCHEMA_BYTES, isAppCollectionPageRequest, isAppCollectionRecordPath,
  pageAppCollectionRecords, projectAppCollectionRecord, validateAppCollectionCreateFields, validateAppCollectionSchema } from "@dohc/security-contract/app-collection-checks";
import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import type { JournalDb } from "@dohc/app-backend-runtime/journal";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { LocalAppUnavailableError, type LocalAppAction } from "./localAppLaunch";
import type { LocalAppPrepared, LocalAppRow, LocalAppStorage, LocalAppStore } from "./localAppStore";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";

export const MAX_LOCAL_COLLECTION_CREATES_PER_PUBLICATION = 1_000;
export const LOCAL_APP_WITHDRAW_TIMEOUT_MS = 5_000;

/** The engine definitively refused a write; sending it again cannot succeed. */
export class LocalCollectionRefusal extends Error {}
/** What a local Collection app reaches in the workspace engine. Main binds it to this attachment's capture. */
export interface LocalCollectionEngine {
  activeVersionId(): Promise<string>;
  /** Published files after `afterPath`, or from the folder's start, in UTF-8 byte order. */
  listFiles(input: { versionId: string; folder: string; afterPath?: string; limit: number }): Promise<{ files: Array<{ path: string; contentKind: string; byteLength: number | null }>; more: boolean }>;
  /** The file's published text, or null when the version has no text file there. */
  readText(input: { versionId: string; path: string }): Promise<string | null>;
  /** A create-only authored write. Throws LocalCollectionRefusal for a definitive refusal. */
  create(input: Envelope): Promise<{ objectId: string; momentId: string }>;
  /** The committed moment, or null when the engine confirms it does not exist. */
  moment(momentId: string): Promise<{ workspaceId: string; versionId: string; objectId: string; path: string; operation: string; text: string | null } | null>;
}

export type Envelope = { path: string; text: string; versionId: string; author: MomentWriteAuthor; requestId: string; momentId: string };
type Outcome = { kind: "accepted"; receipt: AppCollectionReceipt } | { kind: "notWritten"; reason: string };
type Create = { publication_id: string; idempotency_key: string; payload_sha256: string; created_at_ms: number; envelope: string | null; outcome: string | null; storage_bytes: number; submitted: number };

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const contained = (path: string) => isShareablePath(path) && !isSharedWithMePath(path);
const createBytes = (row: Pick<Create, "publication_id" | "idempotency_key" | "payload_sha256" | "envelope" | "outcome">) =>
  Buffer.byteLength(row.publication_id + row.idempotency_key + row.payload_sha256 + (row.envelope ?? "") + (row.outcome ?? "")) + 256;
const base32 = (bytes: Uint8Array) => [...bytes].map(byte => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("");
/** Stops waiting when the signal aborts. The work itself continues. */
function until<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener("abort", stop, { once: true }); });
  return Promise.race([pending, aborted]).finally(() => signal.removeEventListener("abort", stop));
}

export function localCollectionAppStorage(db: JournalDb): LocalAppStorage {
  return { kind: "collection", publicationTable: "local_collection_apps", artifactTable: "local_collection_app_artifacts", resourceColumn: "collection_path",
    ensureSchema() {
      db.exec(`CREATE TABLE IF NOT EXISTS local_collection_apps(
        publication_id TEXT PRIMARY KEY, app_root TEXT NOT NULL UNIQUE, collection_path TEXT NOT NULL,
        authority_revision INTEGER NOT NULL, candidate TEXT NOT NULL, storage_bytes INTEGER NOT NULL, active INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS local_collection_app_artifacts(
        publication_id TEXT NOT NULL REFERENCES local_collection_apps(publication_id) ON DELETE CASCADE,
        path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(publication_id,path)) STRICT;
        CREATE TABLE IF NOT EXISTS local_collection_creates(
        publication_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_sha256 TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        envelope TEXT, outcome TEXT, storage_bytes INTEGER NOT NULL, submitted INTEGER NOT NULL, PRIMARY KEY(publication_id,idempotency_key),
        CHECK((envelope IS NULL)<>(outcome IS NULL))) STRICT;`);
    },
    assertRetirable(publicationId) {
      if (db.prepare("SELECT 1 FROM local_collection_creates WHERE publication_id=? AND envelope IS NOT NULL LIMIT 1").get(publicationId))
        throw new LocalAppUnavailableError("dohc is still saving this app's responses. Try again.");
    },
  };
}

/** Approved document Collection apps. Creates persist before dispatch and settle exactly once. */
export function createLocalCollectionApps(options: {
  db: JournalDb; store: LocalAppStore; workspaceId: string;
  assertCurrent(): void;
  /** Commits while the host closes, so admitted creates record their outcomes. Admission checks the session through the store. */
  transaction<T>(work: () => T): T;
  /** Charges the host byte budget's Collection ledger in the caller's transaction. */
  charge(bytes: number): void;
  /** This attachment's engine. Throws when it is unavailable. */
  engine(): LocalCollectionEngine;
  /** Who a create is made by: the person here, or the agent run active now. */
  author(): Promise<MomentWriteAuthor>;
  now?(): number;
}) {
  const { db } = options, now = options.now ?? Date.now;
  // Admitted requests per publication, and the one reconciliation per create key. Neither joins the Dataset host's unbounded close.
  const requests = new Map<string, Set<AbortController>>(), settling = new Map<string, Promise<void>>();
  let phase: "open" | "closing" | "closed" = "open";
  // Read through a call: the phase changes while a reconciliation awaits the engine.
  const closed = () => phase === "closed";

  function current(publicationId: string, expected?: number): { row: LocalAppRow; capability: AppCollectionCapability } {
    const row = options.store.row(publicationId, expected), capability = row.candidate.capabilities[0];
    if (row.kind !== "collection" || capability?.kind !== "collection-create") throw new Error("Invalid app approval.");
    return { row, capability };
  }
  /** Engine failures are unavailability, never a refusal, unless the engine refused definitively. */
  async function call<T>(signal: AbortSignal | undefined, reach: (engine: LocalCollectionEngine) => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => reach(options.engine()));
    try { return await (signal ? until(pending, signal) : pending); }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error instanceof LocalCollectionRefusal ? error : new LocalAppUnavailableError("The workspace engine did not answer. Try again.", { cause: error });
    }
  }
  async function schema(capability: AppCollectionCapability, versionId: string, signal?: AbortSignal) {
    if (!contained(capability.collectionPath)) throw new Error("Choose a Collection in your workspace.");
    const text = await call(signal, engine => engine.readText({ versionId, path: `${capability.collectionPath}/collection.yaml` }));
    if (text === null || Buffer.byteLength(text) > APP_COLLECTION_MAX_SCHEMA_BYTES || sha(text) !== capability.schemaSha256) throw new Error("The Collection schema changed. Prepare the app again.");
    const checked = validateAppCollectionSchema(text, capability, "dohc");
    if (!checked.ok) throw new Error(checked.message);
    return checked.value;
  }
  /** The capability a publication was approved with, whether or not it is still active. */
  function approvedCapability(publicationId: string): AppCollectionCapability {
    const value = db.prepare("SELECT candidate FROM local_collection_apps WHERE publication_id=?").get(publicationId) as { candidate: string } | undefined;
    const capability = value && parseAppPublicationCandidate(JSON.parse(value.candidate), APP_PUBLICATION_LIMITS).capabilities[0];
    if (capability?.kind !== "collection-create") throw new Error("This app approval no longer exists.");
    return capability;
  }
  const stored = (publicationId: string, key: string) =>
    db.prepare("SELECT * FROM local_collection_creates WHERE publication_id=? AND idempotency_key=?").get(publicationId, key) as Create | undefined;
  const pendingKeys = (publicationId?: string) => (publicationId === undefined
    ? db.prepare("SELECT publication_id,idempotency_key FROM local_collection_creates WHERE envelope IS NOT NULL").all()
    : db.prepare("SELECT publication_id,idempotency_key FROM local_collection_creates WHERE envelope IS NOT NULL AND publication_id=?").all(publicationId)) as Pick<Create, "publication_id" | "idempotency_key">[];

  function finish(publicationId: string, key: string, outcome: (row: Create) => Outcome) {
    // After close the reservation stays durable and settles when the store opens again.
    if (closed()) return;
    options.transaction(() => {
      const row = stored(publicationId, key);
      if (!row?.envelope) return;
      const next = { ...row, envelope: null, outcome: JSON.stringify(outcome(row)) }, bytes = createBytes(next);
      options.charge(bytes - row.storage_bytes);
      db.prepare("UPDATE local_collection_creates SET envelope=NULL,outcome=?,storage_bytes=? WHERE publication_id=? AND idempotency_key=?").run(next.outcome, bytes, publicationId, key);
    });
  }
  /** Until a create is submitted it rechecks the pinned approved schema; once submitted, it looks for its committed moment instead. */
  async function attempt(publicationId: string, key: string) {
    if (closed()) return;
    const row = stored(publicationId, key);
    if (!row?.envelope) return;
    const envelope = JSON.parse(row.envelope) as Envelope;
    const accepted = (objectId: string): Outcome => ({ kind: "accepted", receipt: { kind: "accepted", acceptanceId: envelope.path.slice(envelope.path.lastIndexOf("/") + 1, -3),
      objectId, path: envelope.path, momentId: envelope.momentId, acceptedAtMs: row.created_at_ms } });
    const committed = async () => {
      const moment = await call(undefined, engine => engine.moment(envelope.momentId));
      if (!moment) return null;
      return moment.workspaceId === options.workspaceId && moment.versionId === envelope.versionId && moment.path === envelope.path && moment.operation === "write" && moment.text === envelope.text
        ? accepted(moment.objectId) : { kind: "notWritten", reason: "Another change already used this response's identity." } satisfies Outcome;
    };
    if (row.submitted) {
      // A committed write completes the original receipt.
      const found = await committed();
      if (found) return finish(publicationId, key, () => found);
    } else {
      // The schema may change after admission. A later edit does not cancel submitted work.
      try { await schema(approvedCapability(publicationId), envelope.versionId); }
      catch (error) {
        if (error instanceof LocalAppUnavailableError) throw error;
        return finish(publicationId, key, () => ({ kind: "notWritten", reason: error instanceof Error ? error.message : "The Collection changed." }));
      }
    }
    // A closed store sends nothing new; the next open settles this reservation.
    if (closed()) return;
    if (!contained(envelope.path)) return finish(publicationId, key, () => ({ kind: "notWritten", reason: "This response is outside your workspace." }));
    if (!row.submitted) options.transaction(() => db.prepare("UPDATE local_collection_creates SET submitted=1 WHERE publication_id=? AND idempotency_key=?").run(publicationId, key));
    try {
      const written = await call(undefined, engine => engine.create(envelope));
      if (written.momentId !== envelope.momentId) throw new LocalAppUnavailableError("The workspace engine recorded another change.");
      finish(publicationId, key, () => accepted(written.objectId));
    } catch (error) {
      if (!(error instanceof LocalCollectionRefusal)) throw error;
      // Only confirmed absence makes the refusal final.
      const settled = await committed() ?? { kind: "notWritten", reason: error.message } satisfies Outcome;
      finish(publicationId, key, () => settled);
    }
  }
  /** One reconciliation per key at a time; later callers join it. */
  function settle(publicationId: string, key: string): Promise<void> {
    const id = JSON.stringify([publicationId, key]);
    let running = settling.get(id);
    if (!running) {
      running = attempt(publicationId, key).finally(() => settling.delete(id));
      settling.set(id, running);
    }
    return running;
  }
  /** Settles admitted creates within the deadline. Returns how many remain unconfirmed. */
  async function drain(publicationId?: string): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, LOCAL_APP_WITHDRAW_TIMEOUT_MS); });
    try { await Promise.race([Promise.allSettled(pendingKeys(publicationId).map(row => settle(row.publication_id, row.idempotency_key))), deadline]); }
    finally { clearTimeout(timer); }
    return pendingKeys(publicationId).length;
  }
  async function admitted<T>(publicationId: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(), set = requests.get(publicationId) ?? new Set();
    requests.set(publicationId, set.add(controller));
    try { return await run(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal); }
    finally { set.delete(controller); if (!set.size) requests.delete(publicationId); }
  }
  function result(row: Create, payload: string): AppCollectionReceipt {
    if (row.payload_sha256 !== payload) throw new Error("This response key was already used for another response.");
    if (row.envelope !== null) throw new LocalAppUnavailableError("dohc has not confirmed this response yet. Try again.");
    const outcome = JSON.parse(row.outcome!) as Outcome;
    if (outcome.kind === "notWritten") throw new Error(`dohc did not save this response. ${outcome.reason}`);
    return outcome.receipt;
  }
  async function create(publicationId: string, raw: unknown, signal: AbortSignal): Promise<AppCollectionReceipt> {
    const input = parseAppCollectionCreateRequest(raw), key = input.idempotencyKey;
    if (phase !== "open") throw new LocalAppUnavailableError("This workspace is closing.");
    const { capability } = current(publicationId, input.authorityRevision);
    const payload = sha(JSON.stringify(["dohc-local-collection-create-v1", publicationId, capability.collectionPath, capability.schemaSha256,
      Object.fromEntries(Object.entries(input.fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))]));
    const answer = async (row: Create) => {
      if (row.payload_sha256 === payload && row.envelope !== null) await until(settle(publicationId, key), signal).catch(() => {});
      // Only a request whose approval lasted until now receives the outcome.
      signal.throwIfAborted();
      current(publicationId, input.authorityRevision);
      return result(stored(publicationId, key)!, payload);
    };
    const prior = stored(publicationId, key);
    if (prior) return answer(prior);
    const versionId = await call(signal, engine => engine.activeVersionId());
    const fields = validateAppCollectionCreateFields(input.fields, capability, await schema(capability, versionId, signal));
    if (!fields.ok) throw new Error(fields.message);
    const derive = (label: string) => createHash("sha256").update(JSON.stringify(["dohc-local-collection-create-v1", label, options.workspaceId, publicationId, key])).digest();
    const acceptanceId = `accepted_${derive("acceptance").toString("hex").slice(0, 32)}`, createdAt = now();
    const text = `---\n${JSON.stringify({ ...fields.value, id: `rec_${base32(derive("record")).slice(0, 26)}`, created_at: createdAt, acceptance_id: acceptanceId })}\n---\n`;
    if (Buffer.byteLength(text) > APP_COLLECTION_MAX_RECORD_BYTES) throw new Error("Collection response is too large.");
    const envelope: Envelope = { path: `${capability.collectionPath}/${acceptanceId}.md`, text, versionId, author: structuredClone(await options.author()),
      requestId: `local-collection-${derive("request").toString("hex").slice(0, 48)}`, momentId: `local-collection-${derive("moment").toString("hex").slice(0, 48)}` };
    signal.throwIfAborted();
    const raced = options.transaction(() => {
      current(publicationId, input.authorityRevision);
      const again = stored(publicationId, key);
      if (again) return again;
      const count = Number(db.prepare("SELECT count(*) AS count FROM local_collection_creates WHERE publication_id=?").get(publicationId)!.count);
      if (count >= MAX_LOCAL_COLLECTION_CREATES_PER_PUBLICATION) throw new Error("This app reached its response limit on this device.");
      const row = { publication_id: publicationId, idempotency_key: key, payload_sha256: payload, created_at_ms: createdAt, envelope: JSON.stringify(envelope), outcome: null };
      const bytes = createBytes(row);
      options.charge(bytes);
      db.prepare("INSERT INTO local_collection_creates VALUES(?,?,?,?,?,NULL,?,0)").run(publicationId, key, payload, createdAt, row.envelope, bytes);
      return null;
    });
    return answer(raced ?? stored(publicationId, key)!);
  }
  async function list(publicationId: string, raw: { authorityRevision: number; limit: unknown; afterPath?: unknown }, signal: AbortSignal): Promise<AppCollectionPage> {
    if (!isAppCollectionPageRequest(raw.limit, raw.afterPath)) throw new Error("Invalid collection page.");
    const limit = raw.limit as number, afterPath = raw.afterPath as string | undefined;
    const { capability } = current(publicationId, raw.authorityRevision);
    if (!capability.readFields.length) throw new Error("This app cannot read its Collection.");
    if (afterPath !== undefined && !afterPath.startsWith(`${capability.collectionPath}/`)) throw new Error("Invalid collection page.");
    const versionId = await call(signal, engine => engine.activeVersionId());
    const approvedSchema = await schema(capability, versionId, signal);
    // Only direct-child Markdown files in the workspace can be records. No other file reaches the page, so no cursor names one.
    const prefix = `${capability.collectionPath}/`, rows: Array<{ path: string; record: AppCollectionPage["records"][number] | null }> = [];
    let cursor = afterPath, scanning = true, more = false;
    while (scanning) {
      const after = cursor;
      const listed = await call(signal, engine => engine.listFiles({ versionId, folder: capability.collectionPath, ...(after === undefined ? {} : { afterPath: after }), limit: 500 }));
      scanning = listed.more;
      for (const file of listed.files) {
        cursor = file.path;
        // Skip a nested folder in one step: `0` follows `/` in byte order.
        const nested = file.path.indexOf("/", prefix.length);
        if (nested >= 0) { cursor = `${file.path.slice(0, nested)}0`; scanning = true; break; }
        if (!isAppCollectionRecordPath(capability.collectionPath, file.path) || !contained(file.path)) continue;
        if (rows.length === limit) { more = true; scanning = false; break; }
        const text = file.contentKind !== "text" || file.byteLength === null || file.byteLength > APP_COLLECTION_MAX_RECORD_BYTES ? null
          : await call(signal, engine => engine.readText({ versionId, path: file.path }));
        rows.push({ path: file.path, record: text === null ? null : projectAppCollectionRecord(file.path, new TextEncoder().encode(text), capability, approvedSchema) });
      }
    }
    const page = pageAppCollectionRecords(rows, more);
    current(publicationId, raw.authorityRevision);
    return page;
  }
  const pendingCount = (publicationId: string) => pendingKeys(publicationId).length;
  return {
    current,
    async checkBrowserPublication(publicationId: string, authorityRevision: number, signal: AbortSignal) {
      const { capability } = current(publicationId, authorityRevision);
      await schema(capability, await call(signal, engine => engine.activeVersionId()), signal);
      current(publicationId, authorityRevision);
    },
    async activate(prepared: LocalAppPrepared, signal: AbortSignal, agent: ApprovalAgent | null | undefined, displace: (displaced: LocalAppRow | undefined, commit: () => void) => void) {
      options.assertCurrent(); signal.throwIfAborted();
      const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS), declared = candidate.capabilities[0];
      if (declared?.kind !== "collection-create") throw new Error("Choose an app connected to a Collection.");
      const capability = parseAppCollectionCapability(declared);
      // Local response files have no share-grant disclosure, so write-only fields need no read approval.
      await schema(capability, await call(signal, engine => engine.activeVersionId()), signal);
      const publicationId = sha(JSON.stringify(["dohc-local-collection-app-v1", options.workspaceId, candidate]));
      return options.store.activate({ kind: "collection", resourceId: capability.collectionPath, publicationId, prepared, agent }, signal, (_previous, displaced, commit) => displace(displaced, commit));
    },
    describe(value: LocalAppRow) {
      const capability = value.candidate.capabilities[0];
      if (capability?.kind !== "collection-create") throw new Error("Invalid app approval.");
      const approved = options.store.held(value);
      return { publicationId: value.publicationId, authorityRevision: value.authorityRevision, appRoot: value.appRoot, sourceRevision: value.candidate.sourceRevision,
        collectionCapability: capability, approved, active: approved, pendingCreates: pendingCount(value.publicationId) };
    },
    request(publicationId: string, action: LocalAppAction, raw: unknown, signal?: AbortSignal): Promise<unknown> {
      if (action !== "list" && action !== "create") throw new Error("This app is not approved for these Collection actions.");
      return admitted<unknown>(publicationId, signal, active => action === "list" ? list(publicationId, raw as Parameters<typeof list>[1], active) : create(publicationId, raw, active));
    },
    /** After authority ends: stops waiting requests, then settles admitted creates within the deadline. */
    confirm(publicationId: string) {
      for (const controller of requests.get(publicationId) ?? []) controller.abort();
      return drain(publicationId);
    },
    /** Settles a replaced publication's admitted creates before its replacement commits. */
    async settleRoot(appRoot: string) {
      for (const value of options.store.list(appRoot)) if (value.kind === "collection" && pendingCount(value.publicationId)) await drain(value.publicationId);
    },
    /** On attachment and engine reconnection. Admits nothing new. */
    reconcile() {
      for (const row of pendingKeys()) void settle(row.publication_id, row.idempotency_key).catch(() => {});
    },
    /** Rejects new creates, settles admitted ones within the deadline, then stops writing. */
    async close() {
      if (phase !== "open") return;
      phase = "closing";
      for (const set of requests.values()) for (const controller of set) controller.abort();
      await drain().catch(() => 0);
      phase = "closed";
    },
  };
}
