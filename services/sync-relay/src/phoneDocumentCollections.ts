import { posix } from "node:path";
import * as Y from "yjs";
import {
  prepareCollectionRecord,
  setCollectionRecordFields,
} from "@dohc/automation-executor/collection-record-edits";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { LIVE_MARKDOWN_MAX_BYTES } from "@dohc/live-session-contract/limits";
import { isFolderMarkerPath } from "@dohc/security-contract/access-rules";
import {
  APP_COLLECTION_MAX_RECORD_BYTES,
  APP_COLLECTION_MAX_SCHEMA_BYTES,
} from "@dohc/security-contract/app-collection-checks";
import {
  COLLECTION_SCHEMA_FILENAME,
  RECORD_ID_FRONTMATTER_KEY,
  type CollectionSchema,
  type FieldDefinition,
} from "@dohc/workspace-contracts/collection";
import {
  isNormalizedRelativePath,
  isRecordId,
  parseCollectionSchema,
  serializeCollectionSchema,
  validateFieldValue,
} from "@dohc/workspace-contracts/collection-values";
import {
  defaultInboxCaptureTitle,
  formatInboxRecordMarkdown,
  INBOX_COLLECTION_PATH,
  INBOX_COLLECTION_YAML,
  INBOX_SCHEMA_PATH,
  MAX_INBOX_BODY_BYTES,
  MAX_INBOX_TITLE_CHARS,
  safeInboxSlug,
  sanitizeInboxSingleLine,
  validateInboxUrl,
} from "@dohc/workspace-contracts/inbox";
import {
  workspaceDestinationError,
  workspaceNameError,
} from "@dohc/workspace-contracts/workspace-paths";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  DaemonRefusalError,
  VersionedLiveAdapter,
  type WriteAuthor,
} from "@dohc/workspace-engine-client";
import {
  FRONTMATTER_EDIT_REFUSED_MESSAGE,
  loadMarkdownFrontmatter,
} from "@dohc/ydoc-projection/frontmatter";
import { frontmatterMapValues } from "@dohc/ydoc-projection/frontmatter-map";
import { lossyNoteRefusal } from "@dohc/ydoc-projection/lossy-markdown";
import {
  assertOutsideCollection,
  parseFields,
  parseObjectId,
  parseRequestId,
  seedRichDocLineage,
  validateAllowedFileWritePath,
} from "./accountFileWrites";
import { currentAccountFeedCursor, hiddenFile } from "./accountFeed";
import type { AutomationReplica } from "./automationReplicas";
import { replicaRecordEditContext, replicaRecordEngine } from "./automationRecordEdits";
import { badRequest, RelayError } from "./errors";
import { liveEditors } from "./liveEditors";
import { untilAborted } from "./namedLiveFrameHost";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import {
  readBoundedRelayBlob,
  scanCollectionMarkdownFiles,
  type ScannedCollectionMarkdownFile,
} from "./storage/appCollections";
import type { StorageContext } from "./storage/context";

export type PhoneDocumentCollectionReadOperation =
  | "documentCollections"
  | "documentCollectionRecords";
export type PhoneDocumentCollectionWriteOperation =
  | "createDocumentCollection"
  | "createDocumentRecord"
  | "editDocumentRecordFields"
  | "captureInboxItem";
export const isPhoneDocumentCollectionReadOperation = (
  name: string,
): name is PhoneDocumentCollectionReadOperation =>
  name === "documentCollections" || name === "documentCollectionRecords";
export const isPhoneDocumentCollectionWriteOperation = (
  name: string,
): name is PhoneDocumentCollectionWriteOperation =>
  name === "createDocumentCollection" ||
  name === "createDocumentRecord" ||
  name === "editDocumentRecordFields" ||
  name === "captureInboxItem";

export const PHONE_DOC_COLLECTION_PAGE = 50;
export const PHONE_DOC_COLLECTION_MAX_SCAN = 200;
const MAX_COLLECTIONS = 200;
const MAX_FIELDS = 32;
const MAX_LIVE_OVERLAY_BYTES = 2 * 1024 * 1024;
const MAX_DISPLAY_TITLE = 256;
const MAX_DESCRIPTION = 1024;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const parentDir = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const clipText = (text: string, max: number) => {
  if (text.length <= max) return text;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

function validateCollectionFolder(value: unknown, checkDest = false): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > 512 ||
    CONTROL_CHARS.test(value) ||
    !isNormalizedRelativePath(value) ||
    value.split("/").some((s) => s.startsWith("."))
  )
    throw badRequest("Invalid Collection folder path.");
  const schemaPath = `${value}/${COLLECTION_SCHEMA_FILENAME}`;
  const checked = validateUserWritePath(schemaPath);
  if (
    hiddenFile(schemaPath) ||
    isFolderMarkerPath(schemaPath) ||
    !checked.ok ||
    checked.normalized !== schemaPath ||
    (checkDest && workspaceDestinationError(schemaPath, "win32") !== null)
  )
    throw badRequest("Invalid Collection folder path.");
  return value;
}

const isJsonSafe = (v: unknown, d = 0): boolean =>
  d <= 8 &&
  (v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (Array.isArray(v) && v.every((x) => isJsonSafe(x, d + 1))));

function validateRecordFields(
  raw: unknown,
  schema: CollectionSchema | null,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw badRequest("Fields must be an object.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_FIELDS) throw badRequest("Invalid field count.");
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of entries) {
    if (!key || key.length > 256 || key === RECORD_ID_FRONTMATTER_KEY || !isJsonSafe(value))
      throw badRequest(`Invalid value for field "${key}".`);
    const def = schema?.fields.find((f) => f.name === key);
    if (def && (def.type === "button" || validateFieldValue(def, value).status !== "valid"))
      throw badRequest(`Invalid value for field "${key}".`);
    out[key] = typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  return out;
}

const sanitizeJson = (v: unknown): unknown =>
  v === null || typeof v === "string" || typeof v === "boolean"
    ? v
    : typeof v === "number"
      ? Number.isFinite(v)
        ? v
        : null
      : typeof v === "bigint"
        ? v.toString()
        : Array.isArray(v)
          ? v.map(sanitizeJson)
          : null;

function readFrontmatter(
  ctx: StorageContext,
  workspaceId: string,
  row: ScannedCollectionMarkdownFile,
): Record<string, unknown> | null {
  if (
    row.contentKind !== "text" ||
    row.byteLength === null ||
    row.byteLength !== row.actualLength ||
    row.byteLength > LIVE_MARKDOWN_MAX_BYTES
  )
    return null;
  const full = row.byteLength <= APP_COLLECTION_MAX_RECORD_BYTES;
  const bytes = full
    ? readBoundedRelayBlob(ctx, workspaceId, row.blobSha256, APP_COLLECTION_MAX_RECORD_BYTES)
    : (ctx.db
        .prepare(
          "SELECT substr(content,1,?) AS c FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?",
        )
        .get(APP_COLLECTION_MAX_RECORD_BYTES, workspaceId, row.blobSha256)?.c as
        | Uint8Array
        | undefined);
  if (!(bytes instanceof Uint8Array)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: full }).decode(bytes);
  } catch {
    return null;
  }
  return loadMarkdownFrontmatter(text)?.meta ?? null;
}

function overlayLiveFrontmatter(
  storage: SyncRelayStorage,
  workspaceId: string,
  path: string,
  objectId: string,
): Record<string, unknown> | null {
  const live = storage.readAcceptedLiveDocument(workspaceId, path);
  if (live.kind !== "cut" || live.cut.document.objectId !== objectId) return null;
  const bytes =
    live.cut.checkpoint.bytes.byteLength +
    live.cut.suffix.reduce((n, item) => n + item.bytes.byteLength, 0);
  if (bytes > MAX_LIVE_OVERLAY_BYTES) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(
      doc,
      Y.mergeUpdates([live.cut.checkpoint.bytes, ...live.cut.suffix.map((i) => i.bytes)]),
    );
    return frontmatterMapValues(doc.getMap("frontmatter"));
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

function hasDatasetAncestor(ctx: StorageContext, workspaceId: string, folder: string): boolean {
  const parts = folder.split("/");
  const stmt = ctx.db.prepare(
    "SELECT 1 FROM sync_relay_current_files WHERE workspace_id=? AND version_id='main' AND path=?",
  );
  return (
    parts.some(
      (_, i) =>
        stmt.get(workspaceId, [...parts.slice(0, i), "dataset.json"].join("/")) !== undefined,
    ) || stmt.get(workspaceId, `${folder}/dataset.json`) !== undefined
  );
}

function parseSchemaBlob(ctx: StorageContext, workspaceId: string, sha256: string) {
  const blob = readBoundedRelayBlob(ctx, workspaceId, sha256, APP_COLLECTION_MAX_SCHEMA_BYTES);
  if (!blob) return null;
  try {
    return parseCollectionSchema(new TextDecoder("utf-8", { fatal: true }).decode(blob));
  } catch {
    return null;
  }
}

const summaryOf = (folder: string, parsed: ReturnType<typeof parseCollectionSchema>) => ({
  path: folder,
  name: clipText(parsed.schema.name?.trim() || posix.basename(folder), MAX_DISPLAY_TITLE),
  description: parsed.schema.description
    ? clipText(parsed.schema.description, MAX_DESCRIPTION)
    : null,
  status: parsed.status,
  fields: parsed.schema.fields as FieldDefinition[],
});

export function runPhoneDocumentCollectionRead(
  storage: SyncRelayStorage,
  input: {
    readonly workspaceId: string;
    readonly operation: PhoneDocumentCollectionReadOperation;
    readonly args: unknown;
  },
): { readonly result: unknown; readonly cursor: string } {
  const ctx = storage as StorageContext;
  const { workspaceId, operation } = input;
  if (operation === "documentCollections") {
    const body = parseFields(input.args, ["afterPath"]);
    if (
      body.afterPath !== undefined &&
      (typeof body.afterPath !== "string" || Buffer.byteLength(body.afterPath, "utf8") > 1_024)
    )
      throw badRequest("Invalid Document Collection cursor.");
    const result = ctx.readTx(() => {
      const stmt = ctx.db.prepare(
        "SELECT path, blob_sha256 FROM sync_relay_current_files WHERE workspace_id=? AND version_id='main' AND content_kind='text' AND path GLOB '*/collection.yaml' AND path>? ORDER BY path LIMIT ?",
      );
      let cursorPath = typeof body.afterPath === "string" ? body.afterPath : "";
      let hasMore = false;
      let scanned = 0;
      const collections: Array<ReturnType<typeof summaryOf>> = [];
      while (collections.length < MAX_COLLECTIONS && scanned < MAX_COLLECTIONS * 4) {
        const batchSize = Math.min(
          MAX_COLLECTIONS - collections.length,
          MAX_COLLECTIONS * 4 - scanned,
        );
        const rows = stmt.all(workspaceId, cursorPath, batchSize + 1);
        hasMore = rows.length > batchSize;
        const slice = rows.slice(0, batchSize);
        if (!slice.length) break;
        for (const row of slice) {
          scanned += 1;
          const schemaPath = String(row.path);
          cursorPath = schemaPath;
          const folder = parentDir(schemaPath);
          if (
            !folder ||
            Buffer.byteLength(folder, "utf8") > 512 ||
            hiddenFile(schemaPath) ||
            folder.split("/").some((s) => s.startsWith(".")) ||
            hasDatasetAncestor(ctx, workspaceId, folder)
          )
            continue;
          const parsed = parseSchemaBlob(ctx, workspaceId, String(row.blob_sha256));
          if (parsed) collections.push(summaryOf(folder, parsed));
        }
        if (!hasMore) break;
      }
      return { ok: true, collections, nextPath: hasMore ? cursorPath : null };
    });
    return { result, cursor: currentAccountFeedCursor(storage, workspaceId, null) };
  }

  const body = parseFields(input.args, ["collectionPath", "afterPath", "limit", "search"]);
  const collectionPath = validateCollectionFolder(body.collectionPath);
  const limit = body.limit === undefined ? PHONE_DOC_COLLECTION_PAGE : body.limit;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PHONE_DOC_COLLECTION_PAGE ||
    (body.afterPath !== undefined &&
      (typeof body.afterPath !== "string" || Buffer.byteLength(body.afterPath, "utf8") > 1_024)) ||
    (body.search !== undefined && (typeof body.search !== "string" || body.search.length > 200))
  )
    throw badRequest("Invalid Document Collection query.");
  const search = typeof body.search === "string" ? body.search.trim().toLowerCase() : "";

  const found = ctx.readTx(() => {
    if (hasDatasetAncestor(ctx, workspaceId, collectionPath)) return null;
    const row = ctx.db
      .prepare(
        "SELECT blob_sha256, content_kind FROM sync_relay_current_files WHERE workspace_id=? AND version_id='main' AND path=?",
      )
      .get(workspaceId, `${collectionPath}/${COLLECTION_SCHEMA_FILENAME}`);
    const parsed =
      row?.content_kind === "text"
        ? parseSchemaBlob(ctx, workspaceId, String(row.blob_sha256))
        : null;
    if (!parsed) return null;
    const target = search ? PHONE_DOC_COLLECTION_MAX_SCAN : limit;
    const rows: Array<{
      path: string;
      objectId: string;
      frontmatter: Record<string, unknown> | null;
    }> = [];
    let cursorPath = search ? undefined : (body.afterPath as string | undefined);
    let scannedTotal = 0;
    let hasMore = false;
    while (rows.length < target && scannedTotal < PHONE_DOC_COLLECTION_MAX_SCAN) {
      const scanned = scanCollectionMarkdownFiles(ctx, {
        workspaceId,
        versionId: "main",
        collectionPath,
        afterPath: cursorPath,
        limit: Math.min(target - rows.length, PHONE_DOC_COLLECTION_MAX_SCAN - scannedTotal),
        maxPathBytes: 1_024,
      });
      for (const item of scanned.rows) {
        scannedTotal += 1;
        cursorPath = item.path;
        if (hiddenFile(item.path) || posix.basename(item.path).startsWith(".")) continue;
        const objectId = storage.currentFileObjectId({
          workspaceId,
          versionId: "main",
          path: item.path,
        });
        if (objectId)
          rows.push({
            path: item.path,
            objectId,
            frontmatter: readFrontmatter(ctx, workspaceId, item),
          });
      }
      hasMore = scanned.hasMore;
      if (!scanned.hasMore || !scanned.rows.length) break;
    }
    return { parsed, rows, hasMore, lastScanned: cursorPath ?? null };
  });

  const cursor = currentAccountFeedCursor(storage, workspaceId, null);
  if (!found)
    return {
      result: { ok: false, refusal: "not-found", reason: "This Collection is no longer here." },
      cursor,
    };

  const schemaFields = found.parsed.schema.fields.filter((f) => f.type !== "button");
  const relationIds = new Set<string>();
  let records = found.rows.map((entry) => {
    const raw =
      overlayLiveFrontmatter(storage, workspaceId, entry.path, entry.objectId) ??
      entry.frontmatter ??
      {};
    const rawId = raw[RECORD_ID_FRONTMATTER_KEY];
    const rawTitle =
      typeof raw.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : typeof raw.Title === "string" && raw.Title.trim()
          ? raw.Title.trim()
          : "";
    const title = clipText(
      rawTitle || posix.basename(entry.path).replace(/\.md$/i, ""),
      MAX_DISPLAY_TITLE,
    );
    const values: Record<string, unknown> = Object.create(null);
    for (const field of schemaFields) {
      if (!Object.hasOwn(raw, field.name)) continue;
      const val = sanitizeJson(raw[field.name]);
      values[field.name] = val;
      if (field.type === "relation")
        for (const item of Array.isArray(val) ? val : [val])
          if (typeof item === "string" && isRecordId(item)) relationIds.add(item);
    }
    return {
      path: entry.path,
      objectId: entry.objectId,
      recordId: typeof rawId === "string" && isRecordId(rawId) ? rawId : null,
      title,
      values,
    };
  });
  if (search)
    records = records.filter(
      (r) =>
        r.title.toLowerCase().includes(search) ||
        Object.values(r.values).some(
          (v) =>
            v != null &&
            (Array.isArray(v) ? v.join(" ") : String(v)).toLowerCase().includes(search),
        ),
    );
  const relationLabels: Record<string, string> = {};
  if (relationIds.size > 0) {
    const lookup = ctx.db.prepare(
      "SELECT path FROM sync_relay_current_record_ids WHERE workspace_id=? AND version_id='main' AND record_id=? LIMIT 1",
    );
    ctx.readTx(() => {
      for (const id of relationIds) {
        const hit = lookup.get(workspaceId, id);
        if (typeof hit?.path === "string" && !hiddenFile(hit.path))
          relationLabels[id] = clipText(
            posix.basename(hit.path).replace(/\.md$/i, ""),
            MAX_DISPLAY_TITLE,
          );
      }
    });
  }
  return {
    result: {
      ok: true,
      collection: summaryOf(collectionPath, found.parsed),
      records,
      relationLabels,
      nextPath: search ? null : found.hasMore ? found.lastScanned : null,
    },
    cursor,
  };
}

async function createIdempotentFile(
  files: VersionedLiveAdapter,
  input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly text: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly author: WriteAuthor;
  },
): Promise<{ readonly ok: true; readonly objectId: string } | { readonly ok: false }> {
  try {
    const written = await files.writeTextFile({
      workspaceId: input.workspaceId,
      versionId: "main",
      path: input.path,
      text: input.text,
      publish: true,
      createOnly: true,
      requestId: input.requestId,
      metadata: { origin: "api", correlationId: input.correlationId },
      author: input.author,
    });
    return { ok: true, objectId: written.object.id };
  } catch (error) {
    if (!(error instanceof DaemonRefusalError)) throw error;
    const existing = await files.readTextFile({
      workspaceId: input.workspaceId,
      versionId: "main",
      path: input.path,
    });
    if (existing)
      return existing.metadataCorrelationId === input.correlationId
        ? { ok: true, objectId: existing.objectId }
        : { ok: false };
    if (
      error.message === "target-path-exists" ||
      error.message === "invalid-input" ||
      (
        await files.listTextFileMetadata({
          workspaceId: input.workspaceId,
          versionId: "main",
          under: input.path,
        })
      ).length > 0
    )
      return { ok: false };
    throw error;
  }
}

export async function runPhoneDocumentCollectionWrite(
  deps: { readonly storage: SyncRelayStorage; readonly copies: ServerCopies },
  input: {
    readonly workspaceId: string;
    readonly owner: string;
    readonly operation: PhoneDocumentCollectionWriteOperation;
    readonly args: unknown;
    readonly visitor: Extract<CopyVisitor, { reason: "account" }>;
    authorize(): Promise<void>;
    nowMs?: () => number;
  },
): Promise<{ readonly result: unknown; readonly cursor: string }> {
  const { workspaceId, owner, operation, visitor } = input;
  const signal = visitor.signal;
  const authorize = () => untilAborted(input.authorize(), signal);
  const author: WriteAuthor = { kind: "human", humanId: owner };
  const objectAt = (path: string) =>
    deps.storage.objectIdAtPathInVersion({ workspaceId, versionId: "main", path });
  const unconfirmed = (what: string) =>
    new RelayError("server_busy", `Your server could not confirm ${what} yet. Try again.`, 503);
  const withCopy = <T>(
    work: (replica: AutomationReplica, files: VersionedLiveAdapter) => Promise<T>,
  ) =>
    deps.copies.withServerCopy(owner, workspaceId, visitor, (replica) =>
      replica.withRecordWork(async () => {
        await authorize();
        await replica.sync(signal);
        await authorize();
        const out = await work(
          replica,
          new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId }),
        );
        await authorize();
        deps.copies.hold(visitor.userId, workspaceId);
        return out;
      }),
    );

  if (operation === "createDocumentCollection") {
    const body = parseFields(input.args, ["folder", "name", "requestId"]);
    const folder = validateCollectionFolder(body.folder, true);
    const requestId = parseRequestId(body.requestId);
    const name =
      body.name === undefined
        ? posix.basename(folder)
        : typeof body.name === "string" && body.name.trim() && body.name.length <= 200
          ? body.name.trim()
          : (() => {
              throw badRequest("Invalid Collection name.");
            })();
    const schemaPath = `${folder}/${COLLECTION_SCHEMA_FILENAME}`;
    const correlationId = `phone-doc-collection-create:${requestId}`;
    const yamlText = serializeCollectionSchema({
      name,
      description: null,
      fields: [{ name: "Name", type: "text" }],
      views: [],
    });
    const occupied = {
      ok: false,
      refusal: "folder-occupied",
      reason: "A folder or file with that name already exists.",
    };
    const result = await withCopy(async (replica, files) => {
      await files.ensureMainVersion({ workspaceId });
      const existing = await files.readTextFile({
        workspaceId,
        versionId: "main",
        path: schemaPath,
      });
      if (existing) {
        if (existing.metadataCorrelationId !== correlationId) return occupied;
        await replica.sync(signal);
        if (objectAt(schemaPath) !== existing.objectId) throw unconfirmed("the new Collection");
        return { ok: true, path: folder, objectId: existing.objectId };
      }
      await assertOutsideCollection(files, workspaceId, schemaPath);
      const lower = folder.toLowerCase();
      if (
        (await files.listTextFileMetadata({ workspaceId, versionId: "main" })).some((f) => {
          const p = f.path.toLowerCase();
          return p === lower || p.startsWith(`${lower}/`);
        })
      )
        return occupied;
      const created = await createIdempotentFile(files, {
        workspaceId,
        path: schemaPath,
        text: yamlText,
        requestId,
        correlationId,
        author,
      });
      if (!created.ok) return occupied;
      await replica.sync(signal);
      if (objectAt(schemaPath) !== created.objectId) throw unconfirmed("the new Collection");
      return { ok: true, path: folder, objectId: created.objectId };
    });
    return { result, cursor: currentAccountFeedCursor(deps.storage, workspaceId, null) };
  }

  if (operation === "createDocumentRecord") {
    const body = parseFields(input.args, ["collectionPath", "name", "requestId"]);
    const collectionPath = validateCollectionFolder(body.collectionPath);
    const requestId = parseRequestId(body.requestId);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      name.startsWith(".") ||
      workspaceNameError(`${name}.md`, "win32") !== null
    )
      throw badRequest("Invalid record name.");
    const recordId = derivedRecordId(
      `phone-doc-record:${workspaceId}:${collectionPath}:${requestId}`,
    );
    let prepared: ReturnType<typeof prepareCollectionRecord>;
    try {
      prepared = prepareCollectionRecord({ collectionPath, name, recordId });
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Invalid record path.");
    }
    validateAllowedFileWritePath(prepared.path, { allowSketch: false, checkDestination: true });
    const correlationId = `phone-doc-record:${requestId}`;
    const result = await withCopy(async (replica, files) => {
      await files.ensureMainVersion({ workspaceId });
      await assertOutsideCollection(files, workspaceId, prepared.path, true);
      const schemaFile = await files.readTextFile({
        workspaceId,
        versionId: "main",
        path: `${collectionPath}/${COLLECTION_SCHEMA_FILENAME}`,
      });
      if (schemaFile?.contentKind !== "text" || typeof schemaFile.text !== "string")
        return { ok: false, refusal: "not-found", reason: "This Collection is no longer here." };
      const created = await createIdempotentFile(files, {
        workspaceId,
        path: prepared.path,
        text: prepared.text,
        requestId,
        correlationId,
        author,
      });
      if (!created.ok)
        return {
          ok: false,
          refusal: "path-exists",
          reason: "A record with this name already exists.",
        };
      await seedRichDocLineage(deps.storage, replica, {
        workspaceId,
        path: prepared.path,
        objectId: created.objectId,
      });
      await replica.sync(signal);
      if (
        objectAt(prepared.path) !== created.objectId ||
        !deps.storage.mainLiveLineageExists({ workspaceId, objectId: created.objectId })
      )
        throw unconfirmed("the new record");
      return {
        ok: true,
        path: prepared.path,
        objectId: created.objectId,
        recordId: prepared.recordId,
      };
    });
    return { result, cursor: currentAccountFeedCursor(deps.storage, workspaceId, null) };
  }

  if (operation === "captureInboxItem") {
    const body = parseFields(input.args, ["title", "body", "url", "kind", "requestId"]);
    const requestId = parseRequestId(body.requestId);
    if (
      (body.title !== undefined &&
        (typeof body.title !== "string" || body.title.length > MAX_INBOX_TITLE_CHARS * 2)) ||
      (body.body !== undefined &&
        (typeof body.body !== "string" ||
          Buffer.byteLength(body.body, "utf8") > MAX_INBOX_BODY_BYTES)) ||
      (body.url !== undefined && typeof body.url !== "string") ||
      (body.kind !== undefined && body.kind !== "note" && body.kind !== "link")
    )
      throw badRequest("Invalid Inbox item arguments.");
    const rawTitle = body.title ? sanitizeInboxSingleLine(body.title) : "";
    const noteBody = body.body ?? "";
    let url: string | undefined;
    if (body.url?.trim()) {
      try {
        url = validateInboxUrl(body.url);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Invalid Inbox link.");
      }
    }
    const kind = body.kind ?? (url ? "link" : "note");
    if (!rawTitle && !url && !noteBody.trim()) throw badRequest("Enter a title, note, or link.");
    const title = defaultInboxCaptureTitle({ title: rawTitle, url, body: noteBody });
    const recordId = derivedRecordId(`phone-inbox-capture:${workspaceId}:${requestId}`);
    const correlationId = `phone-inbox-capture:${requestId}`;
    const receivedIso = new Date(input.nowMs?.() ?? Date.now()).toISOString();
    let markdown: string;
    try {
      markdown = formatInboxRecordMarkdown({
        recordId,
        title,
        source: "capture",
        kind,
        receivedIso,
        url,
        body: noteBody,
      });
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Invalid Inbox item.");
    }
    const occupied = (reason: string) => ({ ok: false, refusal: "folder-occupied", reason });
    const result = await withCopy(async (replica, files) => {
      await files.ensureMainVersion({ workspaceId });
      await assertOutsideCollection(files, workspaceId, INBOX_SCHEMA_PATH, true);
      const confirmCapture = async (path: string, objectId: string) => {
        await seedRichDocLineage(deps.storage, replica, { workspaceId, path, objectId });
        await replica.sync(signal);
        if (
          objectAt(path) !== objectId ||
          !deps.storage.mainLiveLineageExists({ workspaceId, objectId })
        )
          throw unconfirmed("the captured note");
        return { ok: true, path, objectId, recordId };
      };
      const ctx = deps.storage as StorageContext;
      const prior = ctx.readTx(() => {
        const hit = ctx.db
          .prepare(
            `SELECT json_extract(payload_json, '$.path') AS path, json_extract(payload_json, '$.objectId') AS object_id
             FROM sync_relay_log
             WHERE workspace_id = ? AND op_kind = 'moment.append'
               AND json_extract(payload_json, '$.versionId') = 'main'
               AND json_extract(payload_json, '$.operation') = 'write'
               AND json_extract(payload_json, '$.metadata.correlationId') = ?
             ORDER BY relay_seq DESC LIMIT 1`,
          )
          .get(workspaceId, correlationId);
        return typeof hit?.path === "string" && typeof hit?.object_id === "string"
          ? { path: hit.path, objectId: hit.object_id }
          : null;
      });
      if (prior) {
        if (objectAt(prior.path) === prior.objectId)
          return await confirmCapture(prior.path, prior.objectId);
        return { ok: true, path: prior.path, objectId: prior.objectId, recordId };
      }
      const rootHit = (
        await files.resolveFiles({ workspaceId, targets: [{ path: INBOX_COLLECTION_PATH }] })
      ).results[0];
      if (rootHit?.status === "found") return occupied("A file named Inbox already exists.");
      const schemaFile = await files.readTextFile({
        workspaceId,
        versionId: "main",
        path: INBOX_SCHEMA_PATH,
      });
      if (schemaFile) {
        if (schemaFile.contentKind !== "text")
          return occupied("Inbox cannot be used as a Collection.");
      } else {
        if (
          (
            await files.listTextFileMetadata({
              workspaceId,
              versionId: "main",
              under: INBOX_SCHEMA_PATH,
            })
          ).length > 0
        )
          return occupied("Inbox cannot be used as a Collection.");
        const createdSchema = await createIdempotentFile(files, {
          workspaceId,
          path: INBOX_SCHEMA_PATH,
          text: INBOX_COLLECTION_YAML,
          requestId: `${requestId}:inbox`,
          correlationId: `phone-inbox-schema:${requestId}`,
          author,
        });
        if (
          !createdSchema.ok &&
          (await files.readTextFile({ workspaceId, versionId: "main", path: INBOX_SCHEMA_PATH }))
            ?.contentKind !== "text"
        )
          return occupied("Inbox cannot be used as a Collection.");
      }
      const suffix = recordId.slice(-6).toLowerCase();
      const base = `${INBOX_COLLECTION_PATH}/${receivedIso.slice(0, 10)}-${safeInboxSlug(title, kind, 52)}-${suffix}`;
      for (const candidate of [`${base}.md`, `${base}-2.md`]) {
        const created = await createIdempotentFile(files, {
          workspaceId,
          path: candidate,
          text: markdown,
          requestId,
          correlationId,
          author,
        });
        if (created.ok) return await confirmCapture(candidate, created.objectId);
      }
      throw unconfirmed("the captured note");
    });
    return { result, cursor: currentAccountFeedCursor(deps.storage, workspaceId, null) };
  }

  const body = parseFields(input.args, ["path", "expectedObjectId", "fields", "requestId"]);
  const { path } = validateAllowedFileWritePath(body.path, {
    allowSketch: false,
    checkDestination: false,
  });
  if (!/\.md$/i.test(path)) throw badRequest("Properties can only be edited on Markdown pages.");
  const expectedObjectId = parseObjectId(body.expectedObjectId);
  const requestId = parseRequestId(body.requestId);
  const rawFields = validateRecordFields(body.fields, null);
  const result = await withCopy(async (replica, files) => {
    await assertOutsideCollection(files, workspaceId, path, true);
    const found = (await files.resolveFiles({ workspaceId, targets: [{ path }] })).results[0];
    if (found?.status !== "found")
      return { ok: false, refusal: "not-found", reason: "This file is no longer here." };
    if (found.objectId !== expectedObjectId)
      return {
        ok: false,
        refusal: "stale-object",
        reason: "This file changed before your change finished. Try again.",
      };
    const folder = parentDir(path);
    if (folder) {
      const schemaFile = await files.readTextFile({
        workspaceId,
        versionId: "main",
        path: `${folder}/${COLLECTION_SCHEMA_FILENAME}`,
      });
      if (schemaFile?.contentKind === "text" && typeof schemaFile.text === "string")
        validateRecordFields(rawFields, parseCollectionSchema(schemaFile.text).schema);
    }
    if (
      liveEditors(deps.storage).connected({ workspaceId, objectId: found.objectId }) ||
      deps.storage.isHostedForLiveEditing(workspaceId, found.objectId)
    )
      return {
        ok: false,
        refusal: "live-active",
        reason: "Someone is editing this page right now. Close it everywhere, then try again.",
      };
    try {
      await setCollectionRecordFields(
        replicaRecordEditContext(replica, replicaRecordEngine(replica), signal, true),
        {
          recordPath: path,
          fields: rawFields,
          author: { kind: "user", userId: owner },
          idempotencyKeyPrefix: `phone-record-edit:${requestId}`,
          preserveCompletedFields: true,
          settleUnchanged: true,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === FRONTMATTER_EDIT_REFUSED_MESSAGE || message === lossyNoteRefusal(path))
        return { ok: false, refusal: "edit-refused", reason: message };
      throw error;
    }
    await replica.sync(signal);
    return { ok: true, path, objectId: found.objectId };
  });
  return { result, cursor: currentAccountFeedCursor(deps.storage, workspaceId, null) };
}
