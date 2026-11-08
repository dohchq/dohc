import { CreationPartialError, type CreationPartial, type CreationStage } from "@dohc/cli/creation";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import { validateUserMaterializePath } from "@dohc/workspace-core";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { ChangeAttributionWire, SharedFileUpdate, SharedFileUpdateState } from "@dohc/workspace-engine-client";
import { isEngineStoreBusyRefusal, isIdempotencyKeyReuseRefusal, YdocOwnerDraftPendingError } from "@dohc/workspace-engine-client";
import {
  RECORD_ID_FRONTMATTER_KEY,
  isRecordId,
  parseCollectionRecordFields,
  type CollectionGetRecordParams,
  type CollectionGetRecordResult,
} from "@dohc/workspace-contracts";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import * as Y from "yjs";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import {
  FRONTMATTER_EDIT_REFUSED_MESSAGE,
  frontmatterEditsRefused,
} from "@dohc/ydoc-projection/frontmatter";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { isLossyDocument, isLossyMarkdownCached, lossyNoteRefusal, unreadNoteRefusal } from "@dohc/ydoc-projection/lossy-markdown";
import type { CollectionRecordWrites } from "./collectionAutomationRun";
import { recordIdFromBytes } from "./recordIds";

// The one collection write seam. Every agent surface (MCP/CLI) and Collection
// automations, on the desktop and on a server, set record fields and create
// records through these two functions, so attribution, session ownership, and
// settle behavior cannot drift between surfaces or hosts. The record's
// live-document frontmatter map is the storage path, the same one the desktop
// PropertiesPanel and collection views write through. Each host supplies a
// CollectionRecordEditContext over its own engine.
//
// Both writes are safe to run again. A field that already holds the
// requested value is not written, so a re-run journals only what still
// differs. Each changed field journals as its own update, so a caller that
// names its writes gives every field its own idempotency key. A create given
// a record id returns that record when it already exists.

// The live document field the desktop writes; one name for one thing
// (CollectionPage.tsx uses the same constant).
const FRONTMATTER_FIELD = "frontmatter";

// The engine's answer when no record has the id (collections.getRecord).
const RECORD_NOT_FOUND = "collection-record-not-found";

// The longest a create waits for the engine to adopt its file, when the
// caller's own signal allows longer. A healthy engine adopts within one
// Collection reconcile.
const ADOPTION_DEADLINE_MS = 15_000;

export class AutomationCreationSkipped extends Error {
  constructor() { super("The record was already created, then moved or deleted."); }
}

/** The request committed; its file may still need Collection adoption. */
export class AutomationCreationCommitted extends Error {}

/** The engine adapter subset the seam reads through. VersionedLiveAdapter satisfies it. */
export interface CollectionRecordEditAdapter {
  sharedFileUpdateStates(writes: readonly SharedFileUpdate[]): Promise<SharedFileUpdateState[]>;
  getCollectionRecord(
    params: CollectionGetRecordParams,
  ): Promise<CollectionGetRecordResult>;
}

/** How one update is recorded: its author, its declared provenance, and its idempotency key. */
export interface RecordUpdateOptions {
  actorOriginId?: string;
  attribution?: ChangeAttributionWire;
  idempotencyKey?: string;
}

/** A record's live document session, as a write uses it. */
export interface RecordEditSession {
  /**
   * Journals one update, decided on the session's chain against its
   * canonical doc as it stands then; null journals nothing. Resolves whether
   * an update was journaled. A keyed update rejects when the engine did not
   * record it, saying whether it may have been recorded.
   */
  applyDecidedLocalUpdate(
    decide: (doc: Y.Doc) => Uint8Array | null,
    onArmed: () => void,
    options: RecordUpdateOptions,
  ): Promise<boolean>;
  /** Writes journaled updates to the settled file. Owner drafts can remain pending. */
  settleNow(options: { summary: string }): Promise<unknown>;
  close(options?: { settle?: boolean }): Promise<void>;
}

/** Workspace-scoped authority the host supplies. The CLI/MCP caller never sees it. */
export interface CollectionRecordEditContext {
  /** Opens the live document session of a record in the workspace's active version. */
  openRecord(path: string): Promise<RecordEditSession>;
  /**
   * Creates a file that does not exist yet, as `author`, and answers the
   * workspace path it created, as the host spells it. A taken path throws
   * VersionedTextStoreError "target-path-exists", or an error with code
   * EEXIST. An automation's file must name the automation as the author of
   * the moment that created it (see createRecordFile).
   */
  createFile(path: string, text: string, author: ChangeAuthor): Promise<string>;
  /** A file's text in the active version. Throws when there is none. */
  readText(path: string): Promise<{ text: string; truncated: boolean }>;
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withAdapter<T>(
    work: (adapter: CollectionRecordEditAdapter) => Promise<T>,
  ): Promise<T | null>;
  /**
   * Subscribes to the engine's news that it may have adopted records: the
   * paths it reconciled, or null when the news did not list them all.
   * Returns the unsubscribe. A host whose engine adopts a record before its
   * create returns never needs to call the listener.
   */
  onRecordsChanged(listener: (paths: readonly string[] | null) => void): () => void;
  /**
   * The caller's lifetime and deadline. A create stops waiting for the
   * engine to adopt its file when this aborts, and no write starts after it.
   */
  signal: AbortSignal;
}

export interface SetCollectionRecordFieldsInput {
  /** Automation effects finish once the owner draft journals them locally. */
  allowPendingSharedSettlement?: boolean;
  /** A creation key already recorded by the engine must not seed the field again. */
  preserveCompletedSeeds?: boolean;
  /** Undo treats an existing field key as a completed reversal, even after a later edit. */
  preserveCompletedFields?: boolean;
  /** Creation reports the stage that could not finish. */
  onStage?(stage: CreationStage): void;
  /** Finish a prior journaled update even when its values already match. */
  settleUnchanged?: boolean;
  recordPath: string;
  fields: Record<string, unknown>;
  author: ChangeAuthor;
  /**
   * Names this write for the engine's idempotency check. Each changed field
   * journals under "<prefix>/<field>", so a repeated request cannot journal
   * a field twice. Omitted, the session generates a key per update as every
   * other edit does.
   */
  idempotencyKeyPrefix?: string;
  /**
   * The value each named field should hold before this write. A field whose
   * current value is neither this nor the requested value changed since the
   * caller read it: the write leaves it as it is and reports it in `kept`.
   * An automation resuming a step that may already have landed passes the
   * values it planned from.
   */
  expectedBefore?: Record<string, unknown>;
}

export interface SetCollectionRecordFieldsResult {
  /** The owner draft is durable locally; its shared file has not settled. */
  sharedFileUpdates?: Record<string, SharedFileUpdate>;
  path: string;
  /**
   * The value each written field held before this write, keyed by field.
   * A field the record did not have reads as null, as record history
   * shows it. Fields that already held the requested value are absent.
   */
  replaced: Record<string, unknown>;
  /** The current value of each field `expectedBefore` left as it is. */
  kept: Record<string, unknown>;
}

export interface CreateCollectionRecordInput {
  collectionPath: string;
  /** Record file name without ".md". */
  name: string;
  fields?: Record<string, unknown>;
  author: ChangeAuthor;
  /** See SetCollectionRecordFieldsInput (applies to the field seed). */
  idempotencyKeyPrefix?: string;
  /** See SetCollectionRecordFieldsInput (applies to the field seed). */
  expectedBefore?: Record<string, unknown>;
  /**
   * The id of the record to create, from derivedRecordId, for a caller with
   * a stable step identity. When a record with this id is already in the
   * Collection, the create returns it (and seeds unchanged fields) instead of
   * adding another. Omitted, the record gets a new random id.
   */
  recordId?: string;
}

/**
 * The actor origin a Y.Doc update is recorded under. Mirrors the engine's
 * capture rule (capture_agent_origin_id in dohc-engine-runtime): an agent
 * author is recorded as its agentId, an automation as its automationId —
 * exactly the id its engine subscription is registered under, or the
 * engine's self-skip guard never binds; every other author stays device-
 * attributed, exactly like a human edit from this desktop. One attribution
 * path, no second authority.
 */
export function actorOriginIdFor(author: ChangeAuthor): string | undefined {
  switch (author.kind) {
    case "agent":
      return author.agentId;
    case "automation":
      return author.automationId;
    default:
      return undefined;
  }
}

/**
 * The declared attribution recorded beside the actor origin. An agent author
 * writes as an agent for its `onBehalfOf` person at its run's chain depth;
 * an automation writes for its run's person, when it has one, at the depth
 * its author carries (one greater than its trigger's), naming the run it
 * wrote from; every other author through this seam is a person.
 */
export function attributionFor(author: ChangeAuthor): ChangeAttributionWire {
  switch (author.kind) {
    case "agent":
      return { actorKind: "agent", onBehalfOf: author.onBehalfOf, depth: author.depth };
    case "automation":
      return {
        actorKind: "automation",
        ...(author.onBehalfOf !== undefined ? { onBehalfOf: author.onBehalfOf } : {}),
        depth: author.depth,
        run: { claimId: author.run.claimId, automationName: author.run.automationName },
      };
    default:
      return { actorKind: "human" };
  }
}

function assertWritableFieldValue(field: string, value: unknown): void {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      throw new Error(`Field "${field}" must be a finite number.`);
    case "object": {
      if (Array.isArray(value)) {
        for (const entry of value) assertWritableFieldValue(field, entry);
        return;
      }
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        assertWritableFieldValue(`${field}.${key}`, entry);
      }
      return;
    }
    default:
      throw new Error(
        `Field "${field}" must be a JSON value (null, boolean, number, string, array, or object).`,
      );
  }
}

function writableFieldEntries(
  fields: Record<string, unknown>,
): Array<[string, unknown]> {
  const entries = Object.entries(fields);
  for (const [field, value] of entries) {
    if (field === "id") {
      throw new Error(
        'The "id" field is engine-owned record identity and cannot be set.',
      );
    }
    assertWritableFieldValue(field, value);
  }
  return entries;
}

/**
 * The update that sets one frontmatter field over `doc`'s state. It is
 * computed on a scratch replica, exactly like the renderer editor: the
 * session journals a local edit from its doc's update event, so transacting
 * on the session's own doc would change state without journaling.
 */
function frontmatterUpdate(doc: Y.Doc, field: string, value: unknown): Uint8Array {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    const captured: { update?: Uint8Array } = {};
    scratch.on("update", (encoded: Uint8Array) => {
      captured.update = encoded;
    });
    // Setting a map key always emits an update.
    patchFrontmatter(scratch, new Map([[field, value]]));
    if (captured.update === undefined) throw new Error(`Setting "${field}" produced no update.`);
    return captured.update;
  } finally {
    scratch.destroy();
  }
}

/**
 * Sets frontmatter fields on one record through the record's live engine
 * Y.Doc session: open, then for each field at its turn on the session's
 * chain, skip it when it already holds the requested value (or, with
 * `expectedBefore`, anything but the expected one), else journal it as one
 * update with the author-derived actorOriginId; settle so the writes are
 * durable and the .md is on disk, release. When no field changes, nothing
 * is journaled or settled. Throws on
 * refusal (invalid path, engine off, a lossy note or one it could not read to check, the record's doc session held live
 * elsewhere).
 *
 * `recordPath` must already be validated and normalized by the caller
 * (a write-path validator).
 */
export async function setCollectionRecordFields(
  context: CollectionRecordEditContext,
  input: SetCollectionRecordFieldsInput,
): Promise<SetCollectionRecordFieldsResult> {
  const entries = writableFieldEntries(input.fields);
  if (entries.length === 0) {
    throw new Error("Set at least one field.");
  }
  if (liveDocumentKindForPath(input.recordPath) === null) {
    throw new Error(
      `Not a collection record path (records are Markdown files): ${input.recordPath}`,
    );
  }
  throwIfAborted(context.signal);
  // A lossy note's next write would rewrite the parts dohc can't show, so no
  // session opens for it. A read that fails or comes back partial refuses too:
  // only a checked note may change. A missing file has no bytes to check; the
  // session's own document is checked before any change.
  let current: Awaited<ReturnType<CollectionRecordEditContext["readText"]>> | null = null;
  try {
    current = await context.readText(input.recordPath);
  } catch (error) {
    if (!isFileNotFound(error)) throw new Error(unreadNoteRefusal(input.recordPath), { cause: error });
  }
  if (current?.truncated) throw new Error(unreadNoteRefusal(input.recordPath));
  if (current && isLossyMarkdownCached(createHash("sha256").update(current.text).digest("hex"), current.text)) {
    throw new Error(lossyNoteRefusal(input.recordPath));
  }
  input.onStage?.("bind");
  const session = await context.openRecord(input.recordPath);
  let failed = false;
  let sharedSettlementPending = false;
  // The session's own document, judged at the first turn that would change
  // it: the file can change between the read above and this open.
  let sessionLossy: boolean | undefined;
  const headSha256 = current ? createHash("sha256").update(current.text).digest("hex") : null;
  let sharedFileUpdates: Record<string, SharedFileUpdate> | undefined;
  const appendPrefix = input.idempotencyKeyPrefix ?? (input.allowPendingSharedSettlement ? `collection-fields/${randomUUID()}` : undefined);
  try {
    // The caller can end while the session opens (an automation run's
    // deadline); a write must not land after that.
    throwIfAborted(context.signal);
    // Field names are the caller's, so "__proto__" must stay a plain key.
    const replaced: Record<string, unknown> = Object.create(null);
    const kept: Record<string, unknown> = Object.create(null);
    const expected = input.expectedBefore;
    const actorOriginId = actorOriginIdFor(input.author);
    const decidedFields = new Set<string>();
    let armed = 0;
    // Each field is compared and written at its own turn on the session's
    // chain, against the canonical doc as it stands then, so a change that
    // arrived after the session opened is compared, not overwritten.
    input.onStage?.("fields");
    const journaled = await Promise.all(entries.map(([field, value]) => {
      const idempotencyKey = appendPrefix === undefined ? undefined : `${appendPrefix}/${field}`;
      let fieldArmed = false;
      let fieldDecided = false;
      return session.applyDecidedLocalUpdate(
        (doc) => {
          const current = doc.getMap(FRONTMATTER_FIELD).get(field);
          const currentValue =
            (current instanceof Y.AbstractType ? current.toJSON() : current) ??
            null;
          if (isDeepStrictEqual(currentValue, value)) return null;
          if (
            expected !== undefined &&
            Object.hasOwn(expected, field) &&
            !isDeepStrictEqual(currentValue, expected[field] ?? null)
          ) {
            kept[field] = currentValue;
            return null;
          }
          sessionLossy ??= isLossyDocument(doc, headSha256);
          if (sessionLossy) throw new Error(lossyNoteRefusal(input.recordPath));
          if (frontmatterEditsRefused(doc)) throw new Error(FRONTMATTER_EDIT_REFUSED_MESSAGE);
          replaced[field] = currentValue;
          fieldDecided = true;
          decidedFields.add(field);
          return frontmatterUpdate(doc, field, value);
        },
        () => {
          armed += 1;
          fieldArmed = true;
        },
        {
          ...(actorOriginId === undefined ? {} : { actorOriginId }),
          attribution: attributionFor(input.author),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        },
      ).then(written => {
        if (fieldDecided && !written) {
          throw new Error(`The engine session did not accept the field change for ${input.recordPath}.`);
        }
        return written;
      }).catch(async error => {
        if ((!input.preserveCompletedSeeds && !input.preserveCompletedFields) || idempotencyKey === undefined || !isIdempotencyKeyReuseRefusal(error)) throw error;
        // This typed refusal proves the chosen key already landed. The session
        // restores canonical state before rejecting; no new write was recorded.
        if (fieldArmed) armed -= 1;
        delete replaced[field];
        decidedFields.delete(field);
        if (input.preserveCompletedFields) return false;
        return session.applyDecidedLocalUpdate(doc => {
          const current = doc.getMap(FRONTMATTER_FIELD).get(field);
          kept[field] = (current instanceof Y.AbstractType ? current.toJSON() : current) ?? null;
          return null;
        }, () => {}, {
          ...(actorOriginId === undefined ? {} : { actorOriginId }),
          attribution: attributionFor(input.author),
        });
      });
    }));
    const updates = journaled.filter(Boolean).length;
    // Every field already held its value, or someone else's: nothing to settle.
    if (updates === 0 && !input.settleUnchanged) return { path: input.recordPath, replaced, kept };
    // settleNow queues on the same session chain as the updates above, so
    // it observes the journaled edits; it throws when the settle cannot
    // commit.
    input.onStage?.("settle");
    try {
      await session.settleNow({
        summary: `Updated ${recordBasename(input.recordPath)}`,
      });
    } catch (error) {
      if (!input.allowPendingSharedSettlement || !(error instanceof YdocOwnerDraftPendingError) || appendPrefix === undefined) throw error;
      sharedSettlementPending = true;
      const candidates = entries.filter(([field]) => !Object.hasOwn(kept, field)).map(([field]) => [field, {
        outboxId: error.draft.outboxId, binding: error.draft.binding,
        nativeHeadSequence: error.draft.nativeHeadSequence, appendKey: `${appendPrefix}/${field}`,
      }] as const);
      const unchanged = candidates.filter(([field]) => !decidedFields.has(field));
      // Undo cannot finish while a prior reversal's receipt is unknown.
      const states = unchanged.length === 0 ? [] : await context.withAdapter(adapter =>
        adapter.sharedFileUpdateStates(unchanged.map(([, draft]) => draft))).catch(error => {
          if (input.preserveCompletedFields) throw new Error("dohc could not check this run's shared reversals.", {cause: error});
          return [];
        });
      if (input.preserveCompletedFields && unchanged.some((_, index) => states?.[index] === undefined)) {
        throw new Error("dohc could not check this run's shared reversals.");
      }
      const existing = new Set(unchanged.filter((_, index) => states?.[index] !== undefined && states[index] !== "absent")
        .map(([field]) => field));
      sharedFileUpdates = Object.fromEntries(candidates.filter(([field]) => decidedFields.has(field) || existing.has(field)));
    }
    if (armed !== updates) {
      throw new Error(
        `The engine session did not accept the field change for ${input.recordPath}.`,
      );
    }
    input.onStage?.("close");
    return { path: input.recordPath, replaced, kept, ...(sharedFileUpdates ? { sharedFileUpdates } : {}) };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await session.close(sharedSettlementPending || sessionLossy ? { settle: false } : undefined); }
    catch (error) {
      if (!failed) { input.onStage?.("close"); throw error; }
    }
  }
}

/**
 * Creates one record: writes `${collectionPath}/${name}.md` with only its
 * record id in the frontmatter, through the host's createFile, waits for
 * the engine to adopt the file, seeds `fields` (when given) through
 * setCollectionRecordFields so
 * initial values land as attributed field history, and returns the record's
 * path and id. The engine keeps the file's id unless another record, now or
 * in its history, holds it; then it adopts the file under a new id, and that
 * id is the one returned.
 *
 * A name that is already taken refuses, and the other file is never written,
 * unless that file carries this create's record id: then it is an earlier
 * attempt's file, and the create continues with it. With `recordId`, a
 * record in this Collection that already has the id is the one returned,
 * even under another name. Seeding preserves fields changed since creation.
 */
export async function createCollectionRecord(
  context: CollectionRecordEditContext,
  input: CreateCollectionRecordInput,
): Promise<{ path: string; recordId: string; kept?: Record<string, unknown> } | CreationPartial> {
  return createRecord(context, input);
}

async function createRecord(
  context: CollectionRecordEditContext,
  input: CreateCollectionRecordInput,
  onFailure?: (error: unknown) => void,
): ReturnType<typeof createCollectionRecord> {
  const prepared = prepareCollectionRecord(input);
  const entries = writableFieldEntries(input.fields ?? {});
  throwIfAborted(context.signal);
  const requestedId = prepared.recordId;
  let path = prepared.path;
  let recordId = requestedId;
  let durable = false;
  let checkingExistingFile = false;
  let failedStage: CreationStage = "index";
  try {
    const existingPath = input.recordId === undefined
      ? null : await recordPathFor(context, input.collectionPath, requestedId);
    if (existingPath !== null) {
      if (input.author.kind === "automation") {
        checkingExistingFile = true;
        const existingId = await fileRecordId(context, existingPath).catch((error: unknown) => {
          if (isFileNotFound(error)) throw new AutomationCreationSkipped();
          throw error;
        });
        if (existingId !== requestedId) throw new AutomationCreationSkipped();
        checkingExistingFile = false;
      }
      if (input.author.kind !== "automation" && existingPath !== prepared.path) {
        throw new Error("This record ID belongs to another path. Open that record to edit its fields.");
      }
      path = existingPath;
      durable = true;
    } else {
      failedStage = "write";
      path = await createRecordFile(context, path, requestedId, input.author);
      durable = true;
      failedStage = "index";
      ({ path, recordId } = await waitForRecord(context, input.collectionPath, path, stage => { failedStage = stage; }));
    }
    let kept: Record<string, unknown> = {};
    if (entries.length > 0) {
      ({ kept } = await setCollectionRecordFields(context, {
        recordPath: path,
        fields: Object.fromEntries(entries),
        author: input.author,
        // Creation keys stay completed even after someone clears a seeded field.
        preserveCompletedSeeds: true,
        idempotencyKeyPrefix: input.idempotencyKeyPrefix ?? `create-record/${recordId}`,
        expectedBefore: Object.fromEntries(entries.map(([field]) => [field,
          input.expectedBefore && Object.hasOwn(input.expectedBefore, field) ? input.expectedBefore[field] : null,
        ])),
        settleUnchanged: true,
        onStage: stage => { failedStage = stage; },
      }));
    }
    return { path, recordId, ...(Object.keys(kept).length > 0 ? { kept } : {}) };
  } catch (error) {
    // A transport or lease can fail after the write landed.
    if (error instanceof AutomationCreationSkipped || checkingExistingFile) throw error;
    onFailure?.(error instanceof Error && isEngineStoreBusyRefusal(error.cause) ? error.cause : error);

    const diskId = await fileRecordId(context, path).catch(() => null);
    if (!durable && diskId !== requestedId) throw error;
    if (diskId !== null && ["write", "capture", "index"].includes(failedStage)) recordId = diskId;
    return {
      kind: "partial", created: [path], failedStage, reason: (error instanceof Error ? error.message : String(error)),
      retry: {
        mode: "resume", recordId,
        instruction: "Try again with the same record ID and fields to finish this record without creating another.",
      },
    };
  }
}

/** The same identity and validated path for local and received-share creation. */
export function prepareCollectionRecord(input: Pick<CreateCollectionRecordInput, "collectionPath" | "name" | "recordId">): {
  path: string; recordId: string; text: string;
} {
  const name = input.name;
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(
      "Record name must be a plain file name without path separators.",
    );
  }
  if (input.recordId !== undefined && !isRecordId(input.recordId)) {
    throw new Error(
      `Record id must be "rec_" followed by 26 lowercase base32 characters: ${input.recordId}`,
    );
  }
  const validated = validateUserMaterializePath(`${input.collectionPath}/${name}.md`, { platform: process.platform });
  if (!validated.ok) throw new Error(`Invalid record path: ${validated.reason}`);
  const recordId = input.recordId ?? recordIdFromBytes(randomBytes(16));
  return { path: validated.normalized, recordId, text: `---\n${RECORD_ID_FRONTMATTER_KEY}: ${recordId}\n---\n` };
}


/** Keep durable facts when the authority lease rejects after the work returns. */
export async function runCollectionRecordCreation(
  run: <T>(work: (context: CollectionRecordEditContext) => Promise<T>) => Promise<T>,
  input: CreateCollectionRecordInput,
): ReturnType<typeof createCollectionRecord> {
  let result: Awaited<ReturnType<typeof createCollectionRecord>> | undefined;
  try {
    return await run(async context => {
      result = await createCollectionRecord(context, input);
      return result;
    });
  } catch (error) {
    if (!result) throw error;
    if ("kind" in result) return result;
    return {
      kind: "partial", created: [result.path], failedStage: "scope", reason: (error instanceof Error ? error.message : String(error)),
      retry: { mode: "resume", recordId: result.recordId,
        instruction: "Reopen this workspace. Try again with the same record ID and fields to confirm the saved record." },
    };
  }
}

/** The record writes an automation run makes, in this edit context. */
export function collectionRecordWrites(context: CollectionRecordEditContext): CollectionRecordWrites {
  return {
    setFields: (input) => setCollectionRecordFields(context, {
      ...input, allowPendingSharedSettlement: true,
      // A keyed effect can have landed before its run recorded the result.
      settleUnchanged: input.idempotencyKeyPrefix !== undefined,
    }),
    create: async (input) => {
      let failure: unknown;
      const result = await createRecord(context, input, error => { failure = error; });
      if ("kind" in result) {
        if (result.retry.mode === "resume" && result.retry.recordId) {
          await input.onPartial?.({ path: result.created[0]!, recordId: result.retry.recordId });
        }
        if (isEngineStoreBusyRefusal(failure)) throw failure;
        throw new CreationPartialError(result);
      }
      return result;
    },
  };
}

function recordBasename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("The surface that owns this collection edit is no longer active.");
  }
}

/**
 * Writes the record file with only its id in the frontmatter, so the
 * record's id is known before adoption. A taken name refuses, unless the
 * file there carries the same id.
 *
 * An added record's claim takes its author and chain depth from the moment
 * that created the file. So an automation's record is written through the
 * engine with the automation as the moment's author: without it, an
 * automation that adds a record to its own Collection would trigger itself
 * at depth 0 without end.
 */
async function createRecordFile(
  context: CollectionRecordEditContext,
  requestedPath: string,
  recordId: string,
  author: ChangeAuthor,
): Promise<string> {
  const text = `---\n${RECORD_ID_FRONTMATTER_KEY}: ${recordId}\n---\n`;
  try {
    return await context.createFile(requestedPath, text, author);
  } catch (error) {
    const committed = error instanceof AutomationCreationCommitted;
    const collision = error instanceof VersionedTextStoreError
      ? error.code === "target-path-exists"
      : (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
    if (!collision && !committed) throw error;
    const existing = await fileRecordId(context, requestedPath).catch((readError: unknown) => {
      if (!committed || isFileNotFound(readError)) return undefined;
      throw readError;
    });
    if (committed && existing !== recordId) throw new AutomationCreationSkipped();
    // Nothing is there: the create itself failed.
    if (existing === undefined) throw error;
    if (existing === recordId) return requestedPath;
  }
  throw new Error(`${requestedPath} already exists. Choose another record name.`);
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
    || (error instanceof VersionedTextStoreError && error.code === "file-not-found");
}

/** The valid record id in a file's frontmatter, or null. */
async function fileRecordId(
  context: CollectionRecordEditContext,
  path: string,
): Promise<string | null> {
  const read = await context.readText(path);
  const id = read.truncated
    ? undefined
    : parseCollectionRecordFields(read.text)?.[RECORD_ID_FRONTMATTER_KEY];
  return typeof id === "string" && isRecordId(id) ? id : null;
}

/** Where the record with `recordId` lives in the Collection, or null when no record has it. */
async function recordPathFor(
  context: CollectionRecordEditContext,
  collectionPath: string,
  recordId: string,
): Promise<string | null> {
  const found = await context.withAdapter(async (adapter) => {
    try {
      const { record } = await adapter.getCollectionRecord({
        collectionPath,
        recordId,
        historyLimit: 1,
      });
      return { path: record.path };
    } catch (error) {
      if (error instanceof Error && error.message === RECORD_NOT_FOUND) {
        return { path: null };
      }
      throw error;
    }
  });
  if (found === null) throw new Error("The workspace engine is not running.");
  return found.path;
}

/**
 * Resolves once the engine has adopted the file at `path`, with the id it
 * adopted it under. The engine says when it reconciled the Collections a
 * change touched, and a new id it gives the file lands in the file itself.
 * So each check reads the file's id and looks that id up, once now and once
 * for each announcement that names the path.
 * The wait ends at the caller's signal or ADOPTION_DEADLINE_MS, whichever
 * comes first.
 */
async function waitForRecord(
  context: CollectionRecordEditContext,
  collectionPath: string,
  path: string,
  onStage: (stage: CreationStage) => void,
): Promise<{ path: string; recordId: string }> {
  let lastError: unknown;
  const expired = (): Error => new Error(
    `dohc created ${path}, but the engine did not add it to the Collection in time.`,
    lastError === undefined ? undefined : { cause: lastError },
  );
  const wait = Effect.gen(function* () {
    const changes = yield* Queue.sliding<void>(1);
    onStage("capture");
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => context.onRecordsChanged((paths) => {
          if (paths === null || paths.includes(path)) Queue.offerUnsafe(changes, undefined);
        }),
        catch: error => error,
      }),
      unsubscribe => Effect.sync(unsubscribe),
    );
    onStage("index");
    if (context.signal.aborted) return yield* Effect.fail(expired());
    yield* Queue.offer(changes, undefined);
    while (true) {
      yield* Queue.take(changes);
      const adopted = yield* Effect.gen(function* () {
        const recordId = yield* Effect.tryPromise({
          try: () => fileRecordId(context, path),
          catch: error => error,
        });
        if (recordId === null) return null;
        const found = yield* Effect.tryPromise({
          try: () => recordPathFor(context, collectionPath, recordId),
          catch: error => error,
        });
        return found === path ? { path, recordId } : null;
      }).pipe(Effect.catch(error => {
        // A refusal during reconciliation can recover on the next announcement.
        lastError = error;
        if (isEngineStoreBusyRefusal(error)) {
          return Effect.sleep(100).pipe(Effect.andThen(Queue.offer(changes, undefined)), Effect.as(null));
        }
        return Effect.succeed(null);
      }));
      if (adopted !== null) return adopted;
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: ADOPTION_DEADLINE_MS,
      orElse: () => Effect.fail(expired()),
    }),
  );
  const exit = await Effect.runPromiseExit(wait, { signal: context.signal });
  if (exit._tag === "Success") return exit.value;
  throw Cause.hasInterruptsOnly(exit.cause) ? expired() : Cause.squash(exit.cause);
}
