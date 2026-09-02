import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { ChangeAttributionWire } from "@dohc/workspace-engine-client";
import type {
  CollectionQueryParams,
  CollectionQueryResult,
} from "@dohc/workspace-contracts";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import * as Y from "yjs";

import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createFile } from "./workspaceFiles";
import { workspaceRelativePathsEqual } from "./workspaceRelativePathIdentity";

// The ONE main-side collection write seam. Every agent surface (plugin SDK,
// MCP/CLI) sets record fields and creates records through these two
// functions, so attribution, session ownership, and settle behavior cannot
// drift between surfaces. The record's live-document frontmatter map is the
// storage path — the same one the desktop PropertiesPanel and collection
// views write through.

// The live document field the desktop writes; one name for one thing
// (CollectionPage.tsx uses the same constant).
const FRONTMATTER_FIELD = "frontmatter";

// Adoption runs on the capture/engine side after the created file settles;
// this caller can only observe the minted id through the index. The deadline
// bounds a workspace whose engine never adopts (engine wedged, collection
// removed mid-create).
const ADOPTION_DEADLINE_MS = 15_000;
const ADOPTION_POLL_INTERVAL_MS = 200;
const ADOPTION_QUERY_PAGE_LIMIT = 500;

/** The engine adapter subset the seam reads through. VersionedLiveAdapter satisfies it. */
export interface CollectionRecordEditAdapter {
  queryCollectionRecords(
    params: CollectionQueryParams,
  ): Promise<CollectionQueryResult>;
}

/** Workspace-scoped authority the caller (main) supplies. The SDK/MCP caller never sees it. */
export interface CollectionRecordEditContext {
  capture: Pick<WorkspaceEngineCapture, "openYDocSession">;
  workspaceRoot: string;
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withAdapter<T>(
    work: (adapter: CollectionRecordEditAdapter) => Promise<T>,
  ): Promise<T | null>;
  signal?: AbortSignal;
}

export interface SetCollectionRecordFieldsInput {
  recordPath: string;
  fields: Record<string, unknown>;
  author: ChangeAuthor;
}

export interface CreateCollectionRecordInput {
  collectionPath: string;
  /** Record file name without ".md". */
  name: string;
  fields?: Record<string, unknown>;
  author: ChangeAuthor;
}

/**
 * The actor origin a Y.Doc update is recorded under. Mirrors the engine's
 * capture rule (capture_agent_origin_id in dohc-engine-runtime): an agent
 * author is recorded as its agentId; every other author stays device-
 * attributed, exactly like a human edit from this desktop. One attribution
 * path, no second authority.
 */
export function actorOriginIdFor(author: ChangeAuthor): string | undefined {
  return author.kind === "agent" ? author.agentId : undefined;
}

/**
 * The declared attribution recorded beside the actor origin. An agent author
 * writes as an agent for its `onBehalfOf` principal at chain depth 0 (the
 * executor raises the depth for automation chains, lane 3); every other
 * author through this seam is a person.
 */
export function attributionFor(author: ChangeAuthor): ChangeAttributionWire {
  return author.kind === "agent"
    ? { actorKind: "agent", onBehalfOf: author.onBehalfOf, depth: 0 }
    : { actorKind: "human" };
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
 * Sets frontmatter fields on one record through the record's live engine
 * Y.Doc session: open, transact every field in ONE transaction with the
 * author-derived actorOriginId, settle so the write is durable and the .md
 * is on disk, release. Throws on refusal (invalid path, engine off, the
 * record's doc session held live elsewhere).
 *
 * `recordPath` must already be validated and normalized by the caller
 * (sdkWorkspacePath or an equivalent write-path validator).
 */
export async function setCollectionRecordFields(
  context: CollectionRecordEditContext,
  input: SetCollectionRecordFieldsInput,
): Promise<{ path: string }> {
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
    // so transacting on the session's own doc would change state WITHOUT
    // journaling, and re-applying the same update afterwards would journal
    // nothing (Yjs re-apply is a no-op).
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, session.initialUpdate);
      let update: Uint8Array | null = null;
      const captureUpdate = (encoded: Uint8Array): void => {
        update = encoded;
      };
      scratch.on("update", captureUpdate);
      try {
        scratch.transact(() => {
          const frontmatter = scratch.getMap(FRONTMATTER_FIELD);
          for (const [field, value] of entries) frontmatter.set(field, value);
        });
      } finally {
        scratch.off("update", captureUpdate);
      }
      if (update === null) {
        // Nothing changed; nothing to journal or settle.
        return { path: input.recordPath };
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
      return { path: input.recordPath };
    } finally {
      scratch.destroy();
    }
  } finally {
    await session.close();
  }
}

/**
 * Creates one record: writes `${collectionPath}/${name}.md` as an empty file
 * through the same createFile path the desktop's createWorkspaceFile IPC
 * uses, waits for engine adoption to mint the record id, seeds `fields`
 * (when given) through setCollectionRecordFields so initial values land as
 * attributed field history, and returns the minted id.
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
  const entries = writableFieldEntries(input.fields ?? {});
  throwIfAborted(context.signal);
  const requestedPath = `${input.collectionPath}/${name}.md`;
  const path = await withStaleSensitiveWorkspaceOperation(
    context.workspaceRoot,
    async () => await createFile(context.workspaceRoot, requestedPath, ""),
  );
  const recordId = await waitForAdoptedRecordId(context, input.collectionPath, path);
  if (entries.length > 0) {
    try {
      await setCollectionRecordFields(context, {
        recordPath: path,
        fields: Object.fromEntries(entries),
        author: input.author,
      });
    } catch (error) {
      // The record exists by now: name it, so the caller reconciles instead
      // of creating a second one.
      const detail = error instanceof Error ? error.message : String(error);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("The surface that owns this collection edit is no longer active.");
  }
}

async function findAdoptedRecordId(
  context: CollectionRecordEditContext,
  collectionPath: string,
  recordPath: string,
): Promise<string | null> {
  return await context.withAdapter(async (adapter) => {
    let cursor: CollectionQueryParams["cursor"];
    for (;;) {
      throwIfAborted(context.signal);
      const page: CollectionQueryResult = await adapter.queryCollectionRecords({
        collectionPath,
        limit: ADOPTION_QUERY_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      const record = page.records.find((candidate) =>
        workspaceRelativePathsEqual(candidate.path, recordPath),
      );
      if (record) return record.id;
      if (page.nextCursor === null) return null;
      cursor = page.nextCursor;
    }
  });
}

async function waitForAdoptedRecordId(
  context: CollectionRecordEditContext,
  collectionPath: string,
  recordPath: string,
): Promise<string> {
  const deadline = Date.now() + ADOPTION_DEADLINE_MS;
  let lastError: unknown;
  for (;;) {
    throwIfAborted(context.signal);
    let found: string | null = null;
    try {
      found = await findAdoptedRecordId(context, collectionPath, recordPath);
    } catch (error) {
      // The engine can refuse mid-adoption (collection reloading); the next
      // poll answers. A workspace whose engine stays broken hits the deadline
      // with the last refusal as the cause.
      lastError = error;
    }
    if (found !== null) return found;
    if (Date.now() >= deadline) {
      throw new Error(
        `The record file was created at ${recordPath}, but the engine did not adopt it as a collection record in time.`,
        lastError === undefined ? undefined : { cause: lastError },
      );
    }
    await abortableDelay(ADOPTION_POLL_INTERVAL_MS, context.signal);
  }
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new Error("The surface that owns this collection edit is no longer active."),
      );
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
