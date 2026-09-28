import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import { randomBytes } from "node:crypto";
import { recordIdFromBytes } from "@dohc/automation-executor/record-ids";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { errorMessage } from "./workspaceError";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { ChangeAttributionWire } from "@dohc/workspace-engine-client";
import type { CollectionRecordWrites } from "@dohc/automation-executor/collection-automation-run";
import {
  RECORD_ID_FRONTMATTER_KEY,
  isRecordId,
  parseCollectionRecordFields,
  type CollectionGetRecordParams,
  type CollectionGetRecordResult,
} from "@dohc/workspace-contracts";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import * as Y from "yjs";
import {
  frontmatterEditsRefused,
  patchFrontmatter,
} from "@dohc/ydoc-projection/frontmatter";
import { FRONTMATTER_EDIT_REFUSED_MESSAGE } from "../renderer/markdown/frontmatter";

import {
  readWorkspaceText,
  withStaleSensitiveWorkspaceOperation,
} from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createFile } from "./workspaceFiles";

// The one main-side collection write seam. Every agent surface (MCP/CLI) and
// Collection automations set record fields and create records through these
// two functions, so attribution, session ownership, and settle behavior cannot
// drift between surfaces. The record's live-document frontmatter map is the
// storage path — the same one the desktop PropertiesPanel and collection
// views write through.
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
// capture pass.
const ADOPTION_DEADLINE_MS = 15_000;

/** The engine adapter subset the seam reads through. VersionedLiveAdapter satisfies it. */
export interface CollectionRecordEditAdapter {
  getCollectionRecord(
    params: CollectionGetRecordParams,
  ): Promise<CollectionGetRecordResult>;
}

/** Workspace-scoped authority the caller (main) supplies. The CLI/MCP caller never sees it. */
export interface CollectionRecordEditContext {
  capture: Pick<WorkspaceEngineCapture, "openYDocSession" | "writeAuthoredTextFile">;
  workspaceRoot: string;
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withAdapter<T>(
    work: (adapter: CollectionRecordEditAdapter) => Promise<T>,
  ): Promise<T | null>;
  /**
   * Subscribes to the engine's announcement of each settled capture pass in
   * this workspace: the paths the pass captured or reconciled, or null when
   * the announcement did not list them all. Returns the unsubscribe.
   */
  onCaptureSettled(listener: (paths: readonly string[] | null) => void): () => void;
  /**
   * The caller's lifetime and deadline. A create stops waiting for the
   * engine to adopt its file when this aborts, and no write starts after it.
   */
  signal: AbortSignal;
}

export interface SetCollectionRecordFieldsInput {
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
   * Collection, the create returns it (and sets its fields) instead of
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
 * its author carries (one greater than its trigger's); every other author
 * through this seam is a person.
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
 * refusal (invalid path, engine off, the record's doc session held live
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
  const session = await context.capture.openYDocSession({
    path: input.recordPath,
    // A record file is a live Markdown document.
    contentKind: "richdoc",
    onRemoteUpdate: () => {
      // The capture already folds remote updates into the session's canonical
      // doc; this seam holds no second replica to notify.
    },
  });
  try {
    // The caller can end while the session opens (an automation run's
    // deadline); a write must not land after that.
    throwIfAborted(context.signal);
    // Field names are the caller's, so "__proto__" must stay a plain key.
    const replaced: Record<string, unknown> = Object.create(null);
    const kept: Record<string, unknown> = Object.create(null);
    const expected = input.expectedBefore;
    const actorOriginId = actorOriginIdFor(input.author);
    let armed = 0;
    // Each field is compared and written at its own turn on the session's
    // chain, against the canonical doc as it stands then, so a change that
    // arrived after the session opened is compared, not overwritten.
    const journaled = await Promise.all(entries.map(([field, value]) =>
      session.applyDecidedLocalUpdate(
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
          if (frontmatterEditsRefused(doc)) throw new Error(FRONTMATTER_EDIT_REFUSED_MESSAGE);
          replaced[field] = currentValue;
          return frontmatterUpdate(doc, field, value);
        },
        () => {
          armed += 1;
        },
        {
          ...(actorOriginId === undefined ? {} : { actorOriginId }),
          attribution: attributionFor(input.author),
          ...(input.idempotencyKeyPrefix === undefined
            ? {}
            : { idempotencyKey: `${input.idempotencyKeyPrefix}/${field}` }),
        },
      )));
    const updates = journaled.filter(Boolean).length;
    // Every field already held its value, or someone else's: nothing to settle.
    if (updates === 0) return { path: input.recordPath, replaced, kept };
    // settleNow queues on the same session chain as the updates above, so
    // it observes the journaled edits; it throws when the settle cannot
    // commit.
    await session.settleNow({
      summary: `Updated ${recordBasename(input.recordPath)}`,
    });
    if (armed !== updates) {
      throw new Error(
        `The engine session did not accept the field change for ${input.recordPath}.`,
      );
    }
    return { path: input.recordPath, replaced, kept };
  } finally {
    await session.close();
  }
}

/**
 * Creates one record: writes `${collectionPath}/${name}.md` with only its
 * record id in the frontmatter, through the same createFile path the
 * desktop's createWorkspaceFile IPC uses, waits for the engine to adopt the
 * file, seeds `fields` (when given) through setCollectionRecordFields so
 * initial values land as attributed field history, and returns the record's
 * path and id. The engine keeps the file's id unless another record, now or
 * in its history, holds it; then it adopts the file under a new id, and that
 * id is the one returned.
 *
 * A name that is already taken refuses, and the other file is never written,
 * unless that file carries this create's record id: then it is an earlier
 * attempt's file, and the create continues with it. With `recordId`, a
 * record in this Collection that already has the id is the one returned,
 * even under another name, and its fields are set to `fields`.
 */
export async function createCollectionRecord(
  context: CollectionRecordEditContext,
  input: CreateCollectionRecordInput,
): Promise<{ path: string; recordId: string }> {
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
  const entries = writableFieldEntries(input.fields ?? {});
  throwIfAborted(context.signal);
  const requestedId = input.recordId ?? recordIdFromBytes(randomBytes(16));
  const existingPath =
    input.recordId === undefined
      ? null
      : await recordPathFor(context, input.collectionPath, requestedId);
  const { path, recordId } =
    existingPath === null
      ? await waitForRecord(
          context,
          input.collectionPath,
          await createRecordFile(
            context,
            `${input.collectionPath}/${name}.md`,
            requestedId,
            input.author,
          ),
        )
      : { path: existingPath, recordId: requestedId };
  if (entries.length > 0) {
    try {
      await setCollectionRecordFields(context, {
        recordPath: path,
        fields: Object.fromEntries(entries),
        author: input.author,
        ...(input.idempotencyKeyPrefix === undefined
          ? {}
          : { idempotencyKeyPrefix: input.idempotencyKeyPrefix }),
        ...(input.expectedBefore === undefined
          ? {}
          : { expectedBefore: input.expectedBefore }),
      });
    } catch (error) {
      // The record exists by now: name it, so the caller reconciles instead
      // of creating a second one.
      const detail = errorMessage(error);
      throw new Error(
        `The record was created at ${path} (id ${recordId}), but its fields could not be set: ${detail}`,
        { cause: error },
      );
    }
  }
  return { path, recordId };
}

/** The record writes an automation run makes, in this edit context. */
export function collectionRecordWrites(context: CollectionRecordEditContext): CollectionRecordWrites {
  return {
    setFields: (input) => setCollectionRecordFields(context, input),
    create: (input) => createCollectionRecord(context, input),
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
    if (author.kind === "automation") {
      await context.capture.writeAuthoredTextFile(
        join(context.workspaceRoot, requestedPath),
        text,
        author,
        { createOnly: true, signal: context.signal },
      );
      return requestedPath;
    }
    return await withStaleSensitiveWorkspaceOperation(
      context.workspaceRoot,
      async () =>
        await createFile(context.workspaceRoot, requestedPath, text, {
          exclusive: true,
        }),
    );
  } catch (error) {
    const collision = error instanceof VersionedTextStoreError
      ? error.code === "target-path-exists"
      : (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
    if (!collision) throw error;
    const existing = await fileRecordId(context, requestedPath).catch(
      () => undefined,
    );
    // Nothing is there: the create itself failed.
    if (existing === undefined) throw error;
    if (existing === recordId) return requestedPath;
  }
  throw new Error(`${requestedPath} already exists. Choose another record name.`);
}

/** The valid record id in a file's frontmatter, or null. */
async function fileRecordId(
  context: CollectionRecordEditContext,
  path: string,
): Promise<string | null> {
  const read = await readWorkspaceText(context.workspaceRoot, path);
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
 * adopted it under. The engine announces each capture pass after it
 * reconciles the Collections it touched, and a new id it gives the file
 * lands in the file itself. So each check reads the file's id and looks
 * that id up, once now and once for each announcement that names the path.
 * The wait ends at the caller's signal or ADOPTION_DEADLINE_MS, whichever
 * comes first.
 */
function waitForRecord(
  context: CollectionRecordEditContext,
  collectionPath: string,
  path: string,
): Promise<{ path: string; recordId: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    let checkAgain = false;
    let lastError: unknown;
    const finish = (
      outcome: { path: string; recordId: string } | { error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      unsubscribe();
      context.signal.removeEventListener("abort", expire);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome);
    };
    const check = async (): Promise<void> => {
      if (checking) {
        checkAgain = true;
        return;
      }
      checking = true;
      do {
        checkAgain = false;
        try {
          const recordId = await fileRecordId(context, path);
          if (
            recordId !== null &&
            (await recordPathFor(context, collectionPath, recordId)) === path
          ) {
            finish({ path, recordId });
          }
        } catch (error) {
          // The engine can refuse mid-reconcile (a Collection reloading);
          // its next announcement answers. One that stays broken reaches
          // the deadline with this refusal as the cause.
          lastError = error;
        }
      } while (checkAgain && !settled);
      checking = false;
    };
    const expire = (): void => {
      finish({
        error: new Error(
          `The record file was created at ${path}, but the engine did not adopt it as a collection record in time. Look for it in the Collection before you create it again.`,
          lastError === undefined ? undefined : { cause: lastError },
        ),
      });
    };
    const deadline = setTimeout(expire, ADOPTION_DEADLINE_MS);
    const unsubscribe = context.onCaptureSettled((paths) => {
      if (paths === null || paths.includes(path)) void check();
    });
    context.signal.addEventListener("abort", expire, { once: true });
    if (context.signal.aborted) expire();
    else void check();
  });
}
