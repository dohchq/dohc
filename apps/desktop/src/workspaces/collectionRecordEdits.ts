import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { errorMessage } from "./workspaceError";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { ChangeAttributionWire } from "@dohc/workspace-engine-client";
import {
  RECORD_ID_FRONTMATTER_KEY,
  isRecordId,
  type CollectionGetRecordParams,
  type CollectionGetRecordResult,
} from "@dohc/workspace-contracts";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import * as Y from "yjs";

import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createFile } from "./workspaceFiles";

// The one main-side collection write seam. Every agent surface (plugin SDK,
// MCP/CLI) sets record fields and creates records through these two
// functions, so attribution, session ownership, and settle behavior cannot
// drift between surfaces. The record's live-document frontmatter map is the
// storage path — the same one the desktop PropertiesPanel and collection
// views write through.
//
// Both writes are safe to run again. A field that already holds the
// requested value is not written, so a re-run journals only what still
// differs, under the new attempt's idempotency key. A create given a record
// id returns that record when it already exists.

// The live document field the desktop writes; one name for one thing
// (CollectionPage.tsx uses the same constant).
const FRONTMATTER_FIELD = "frontmatter";

// The engine's answer when no record has the id (collections.getRecord).
const RECORD_NOT_FOUND = "collection-record-not-found";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** The engine adapter subset the seam reads through. VersionedLiveAdapter satisfies it. */
export interface CollectionRecordEditAdapter {
  getCollectionRecord(
    params: CollectionGetRecordParams,
  ): Promise<CollectionGetRecordResult>;
}

/** Workspace-scoped authority the caller (main) supplies. The SDK/MCP caller never sees it. */
export interface CollectionRecordEditContext {
  capture: Pick<WorkspaceEngineCapture, "openYDocSession">;
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
   * The caller's lifetime and deadline. A create waits for the engine to
   * adopt the new record file until this aborts.
   */
  signal: AbortSignal;
}

export interface SetCollectionRecordFieldsInput {
  recordPath: string;
  fields: Record<string, unknown>;
  author: ChangeAuthor;
  /**
   * The wire idempotency key for this write's one journaled update. An
   * automation run passes its claim id, its attempt, and its write ordinal:
   * a retried request of one attempt cannot journal the write twice, and a
   * new attempt never reuses an earlier attempt's key. Omitted, the session
   * generates a per-update key as every other edit does.
   */
  idempotencyKey?: string;
}

export interface SetCollectionRecordFieldsResult {
  path: string;
  /**
   * The value each written field held before this write, keyed by field.
   * A field the record did not have reads as null, as record history
   * shows it. Fields that already held the requested value are absent.
   */
  replaced: Record<string, unknown>;
}

export interface CreateCollectionRecordInput {
  collectionPath: string;
  /** Record file name without ".md". */
  name: string;
  fields?: Record<string, unknown>;
  author: ChangeAuthor;
  /** See SetCollectionRecordFieldsInput.idempotencyKey (applies to the field seed). */
  idempotencyKey?: string;
  /**
   * The id of the record to create, from derivedRecordId. When a record
   * with this id is already in the Collection, the create returns it (and
   * sets its fields) instead of adding another. Omitted, the record gets a
   * new random id.
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
 * writes as an agent for its `onBehalfOf` principal at chain depth 0; an
 * automation writes at the depth its author carries (one greater than its
 * trigger's); every other author through this seam is a person.
 */
export function attributionFor(author: ChangeAuthor): ChangeAttributionWire {
  switch (author.kind) {
    case "agent":
      return { actorKind: "agent", onBehalfOf: author.onBehalfOf, depth: 0 };
    case "automation":
      return {
        actorKind: "automation",
        onBehalfOf: author.onBehalfOf,
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
 * A record id derived from `seed`, in the engine's record id shape: "rec_"
 * plus the first 16 bytes of the seed's SHA-256 in unpadded lowercase
 * base32. The same seed always names the same record, so an automation step
 * that seeds it with its claim id and step position finds the record an
 * earlier attempt created.
 */
export function derivedRecordId(seed: string): string {
  return recordIdFromBytes(
    createHash("sha256").update(seed).digest().subarray(0, 16),
  );
}

/**
 * Sets frontmatter fields on one record through the record's live engine
 * Y.Doc session: open, skip every field that already holds the requested
 * value, transact the rest in one transaction with the author-derived
 * actorOriginId, settle so the write is durable and the .md is on disk,
 * release. When no field changes, nothing is journaled or settled. Throws on
 * refusal (invalid path, engine off, the record's doc session held live
 * elsewhere).
 *
 * `recordPath` must already be validated and normalized by the caller
 * (sdkWorkspacePath or an equivalent write-path validator).
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
    // The update is computed on a scratch replica, exactly like the renderer
    // editor: the session journals a local edit from its doc's update event,
    // so transacting on the session's own doc would change state without
    // journaling, and re-applying the same update afterwards would journal
    // nothing (Yjs re-apply is a no-op).
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, session.initialUpdate);
      const frontmatter = scratch.getMap(FRONTMATTER_FIELD);
      const replaced: Record<string, unknown> = {};
      const changed = entries.filter(([field, value]) => {
        const current = frontmatter.get(field);
        const currentValue =
          current instanceof Y.AbstractType ? current.toJSON() : current;
        if (isDeepStrictEqual(currentValue, value)) return false;
        replaced[field] = currentValue ?? null;
        return true;
      });
      if (changed.length === 0) {
        // Every field already holds its value; nothing to journal or settle.
        return { path: input.recordPath, replaced };
      }
      let update: Uint8Array | null = null;
      const captureUpdate = (encoded: Uint8Array): void => {
        update = encoded;
      };
      scratch.on("update", captureUpdate);
      try {
        scratch.transact(() => {
          for (const [field, value] of changed) frontmatter.set(field, value);
        });
      } finally {
        scratch.off("update", captureUpdate);
      }
      if (update === null) {
        throw new Error(
          `The field change for ${input.recordPath} produced no document update.`,
        );
      }
      let armed = false;
      const actorOriginId = actorOriginIdFor(input.author);
      session.applyLocalUpdate(
        update,
        () => {
          armed = true;
        },
        {
          ...(actorOriginId === undefined ? {} : { actorOriginId }),
          attribution: attributionFor(input.author),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        },
      );
      // settleNow queues on the same session chain as the update above, so it
      // observes the journaled edit; it throws when the settle cannot commit.
      await session.settleNow({
        summary: `Updated ${recordBasename(input.recordPath)}`,
      });
      if (!armed) {
        throw new Error(
          `The engine session did not accept the field change for ${input.recordPath}.`,
        );
      }
      return { path: input.recordPath, replaced };
    } finally {
      scratch.destroy();
    }
  } finally {
    await session.close();
  }
}

/**
 * Creates one record: writes `${collectionPath}/${name}.md` with only its
 * record id in the frontmatter, through the same createFile path the
 * desktop's createWorkspaceFile IPC uses, waits for the engine to adopt the
 * file as that record, seeds `fields` (when given) through
 * setCollectionRecordFields so initial values land as attributed field
 * history, and returns the record's path and id.
 *
 * A name that is already taken refuses; the other file is never written.
 * With `recordId`, a record that already has the id is the one returned,
 * wherever it lives now, and its fields are set to `fields`.
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
  const recordId = input.recordId ?? recordIdFromBytes(randomBytes(16));
  let path =
    input.recordId === undefined
      ? null
      : await recordPathFor(context, input.collectionPath, recordId);
  if (path === null) {
    const created = await createRecordFile(
      context,
      `${input.collectionPath}/${name}.md`,
      recordId,
    );
    path = await waitForRecord(context, input.collectionPath, recordId, created);
  }
  if (entries.length > 0) {
    try {
      await setCollectionRecordFields(context, {
        recordPath: path,
        fields: Object.fromEntries(entries),
        author: input.author,
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
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

function recordBasename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("The surface that owns this collection edit is no longer active.");
  }
}

// The engine's record id shape (mint_record_id in dohc-engine-domain): "rec_"
// plus 16 bytes in unpadded lowercase base32, most significant bit first.
function recordIdFromBytes(bytes: Uint8Array): string {
  let id = "rec_";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) id += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return id;
}

/**
 * Writes the record file with only its id in the frontmatter. The engine
 * adopts a file under its own valid id, so the record's id is known before
 * adoption. Refuses a taken name instead of writing into the other
 * file.
 */
async function createRecordFile(
  context: CollectionRecordEditContext,
  requestedPath: string,
  recordId: string,
): Promise<string> {
  return await withStaleSensitiveWorkspaceOperation(
    context.workspaceRoot,
    async () => {
      try {
        return await createFile(
          context.workspaceRoot,
          requestedPath,
          `---\n${RECORD_ID_FRONTMATTER_KEY}: ${recordId}\n---\n`,
          { exclusive: true },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error(
          `${requestedPath} already exists. Choose another record name.`,
          { cause: error },
        );
      }
    },
  );
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
 * Resolves with the record's path once the engine has adopted the file at
 * `path` as the record `recordId`. The engine announces each capture pass
 * after it reconciles the Collections it touched, so this checks once now
 * and once for each announcement that names the path, never on a timer.
 * The caller's signal is the deadline.
 */
function waitForRecord(
  context: CollectionRecordEditContext,
  collectionPath: string,
  recordId: string,
  path: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let checkAgain = false;
    let lastError: unknown;
    const finish = (outcome: { path: string } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      context.signal.removeEventListener("abort", onAbort);
      if ("path" in outcome) resolve(outcome.path);
      else reject(outcome.error);
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
          const found = await recordPathFor(context, collectionPath, recordId);
          if (found !== null) finish({ path: found });
        } catch (error) {
          // The engine can refuse mid-reconcile (a Collection reloading);
          // its next announcement answers. One that stays broken reaches
          // the deadline with this refusal as the cause.
          lastError = error;
        }
      } while (checkAgain && !settled);
      checking = false;
    };
    const onAbort = (): void => {
      finish({
        error: new Error(
          `The record file was created at ${path}, but the engine did not adopt it as a collection record before this request ended. Look for it in the Collection before you create it again.`,
          lastError === undefined ? undefined : { cause: lastError },
        ),
      });
    };
    const unsubscribe = context.onCaptureSettled((paths) => {
      if (paths === null || paths.includes(path)) void check();
    });
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    else void check();
  });
}
