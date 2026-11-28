import { collectionWords } from "@dohc/interface-words/collections";
import type { CollectionFieldType, FieldDefinition } from "@dohc/workspace-contracts/collection";
import { validateFieldValue } from "@dohc/workspace-contracts/collection-values";
import { workspaceNameError } from "@dohc/workspace-contracts/workspace-paths";
import { valueOf, type Draft } from "../collections/collectionFields";
import { each, isFields, okAnswer, segment, text } from "./api";
import type { ServerClient } from "./client";
import { FILE_WRITE_TIMEOUT_MS } from "./fileWrites";
import type { RecordValue } from "./phoneCollections";
import { earlierCursor, isCursor, type Read } from "./workspaceReads";

const MAX_COLLECTION_PAGES = 20;

export interface DocumentCollectionSummary {
  readonly path: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: "valid" | "degraded";
  readonly fields: readonly FieldDefinition[];
}

export interface DocumentCollectionRecord {
  readonly path: string;
  readonly objectId: string;
  readonly recordId: string | null;
  readonly title: string;
  readonly values: Readonly<Record<string, RecordValue>>;
}

export type DocumentCollectionRecordsPage =
  | {
      readonly kind: "ready";
      readonly collection: DocumentCollectionSummary;
      readonly records: readonly DocumentCollectionRecord[];
      readonly relationLabels: Readonly<Record<string, string>>;
      readonly nextPath: string | null;
    }
  | { readonly kind: "missing" };

export type DocumentCollectionWriteRefusal =
  | "folder-occupied"
  | "path-exists"
  | "not-found"
  | "stale-object"
  | "live-active"
  | "edit-refused";

export type DocumentCollectionWriteResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly objectId: string;
      readonly recordId?: string;
    }
  | {
      readonly ok: false;
      readonly refusal: DocumentCollectionWriteRefusal;
      readonly reason: string;
    };

const FIELD_TYPES = new Set([
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi-select",
  "person",
  "relation",
  "url",
  "button",
]);
const REFUSALS = new Set([
  "folder-occupied",
  "path-exists",
  "not-found",
  "stale-object",
  "live-active",
  "edit-refused",
]);

function readFieldDef(item: unknown): FieldDefinition | null {
  if (
    !isFields(item) ||
    !text(item.name, 65_536) ||
    typeof item.type !== "string" ||
    !FIELD_TYPES.has(item.type)
  )
    return null;
  const type = item.type as CollectionFieldType;
  if (type === "select" || type === "multi-select") {
    const options = each(item.options, (opt) => (text(opt, 65_536) ? opt : null));
    return options ? { name: item.name, type, options } : null;
  }
  if (type === "relation")
    return text(item.collection, 65_536) && typeof item.many === "boolean"
      ? { name: item.name, type, collection: item.collection, many: item.many }
      : null;
  return { name: item.name, type };
}

function readSummary(item: unknown): DocumentCollectionSummary | null {
  if (
    !isFields(item) ||
    !text(item.path, 512) ||
    !text(item.name, 512) ||
    (item.description !== null && typeof item.description !== "string") ||
    (item.status !== "valid" && item.status !== "degraded")
  )
    return null;
  const fields = each(item.fields, readFieldDef);
  return fields
    ? {
        path: item.path,
        name: item.name,
        description: item.description,
        status: item.status,
        fields,
      }
    : null;
}

function readRecord(item: unknown): DocumentCollectionRecord | null {
  if (
    !isFields(item) ||
    !text(item.path, 1024) ||
    !text(item.objectId, 256) ||
    (item.recordId !== null && !text(item.recordId, 64)) ||
    !text(item.title, 1024) ||
    !isFields(item.values)
  )
    return null;
  return {
    path: item.path,
    objectId: item.objectId,
    recordId: item.recordId,
    title: item.title,
    values: item.values as Readonly<Record<string, RecordValue>>,
  };
}

const opRead = <T>(
  client: ServerClient,
  workspaceId: string,
  operation: string,
  args: object,
  parse: (result: unknown) => T | null,
  signal: AbortSignal,
): Promise<Read<T>> =>
  client.send(
    "POST",
    `/sync/${segment(workspaceId)}/ops/${operation}`,
    (body) => {
      const answer = okAnswer(body);
      if (!answer || !isCursor(answer.cursor)) return null;
      const value = parse(answer.result);
      return value === null ? null : { value, cursor: answer.cursor };
    },
    args,
    { signal },
  );

export async function readDocumentCollections(
  client: ServerClient,
  workspaceId: string,
  signal: AbortSignal,
): Promise<Read<readonly DocumentCollectionSummary[]>> {
  const all: DocumentCollectionSummary[] = [];
  const seen = new Set<string>();
  let cursor = "";
  let afterPath: string | undefined;
  for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
    const next = await opRead(
      client,
      workspaceId,
      "documentCollections",
      afterPath ? { afterPath } : {},
      (result) => {
        const answer = okAnswer(result);
        const collections = each(answer?.collections, readSummary);
        if (!answer || !collections) return null;
        if (
          answer.nextPath !== undefined &&
          answer.nextPath !== null &&
          !text(answer.nextPath, 1024)
        )
          return null;
        return { collections, nextPath: answer.nextPath ?? null };
      },
      signal,
    );
    cursor = cursor ? earlierCursor(cursor, next.cursor) : next.cursor;
    for (const item of next.value.collections) {
      if (!seen.has(item.path)) {
        seen.add(item.path);
        all.push(item);
      }
    }
    if (!next.value.nextPath || next.value.nextPath === afterPath) break;
    afterPath = next.value.nextPath;
  }
  return { value: all, cursor };
}

export function readDocumentCollectionRecords(
  client: ServerClient,
  workspaceId: string,
  input: {
    readonly collectionPath: string;
    readonly afterPath?: string;
    readonly limit?: number;
    readonly search?: string;
  },
  signal: AbortSignal,
): Promise<Read<DocumentCollectionRecordsPage>> {
  const args: Record<string, unknown> = { collectionPath: input.collectionPath };
  if (input.afterPath !== undefined) args.afterPath = input.afterPath;
  if (input.limit !== undefined) args.limit = input.limit;
  if (input.search) args.search = input.search;
  return opRead(
    client,
    workspaceId,
    "documentCollectionRecords",
    args,
    (result) => {
      if (!isFields(result)) return null;
      if (result.ok === false && result.refusal === "not-found") return { kind: "missing" };
      if (result.ok !== true) return null;
      const collection = readSummary(result.collection);
      const records = each(result.records, readRecord);
      if (
        !collection ||
        !records ||
        !isFields(result.relationLabels) ||
        (result.nextPath !== null && !text(result.nextPath, 1024))
      )
        return null;
      const relationLabels = Object.fromEntries(
        Object.entries(result.relationLabels).filter((entry): entry is [string, string] =>
          text(entry[1], 1024),
        ),
      );
      return { kind: "ready", collection, records, relationLabels, nextPath: result.nextPath };
    },
    signal,
  );
}

function readWriteResult(body: unknown): DocumentCollectionWriteResult | null {
  const answer = okAnswer(body);
  const result = answer && isFields(answer.result) ? answer.result : null;
  if (!result || typeof result.ok !== "boolean") return null;
  if (result.ok) {
    if (
      !text(result.path, 1024) ||
      !text(result.objectId, 256) ||
      (result.recordId !== undefined && !text(result.recordId, 64))
    )
      return null;
    return {
      ok: true,
      path: result.path,
      objectId: result.objectId,
      ...(result.recordId !== undefined ? { recordId: result.recordId } : {}),
    };
  }
  return typeof result.refusal === "string" &&
    REFUSALS.has(result.refusal) &&
    text(result.reason, 512)
    ? {
        ok: false,
        refusal: result.refusal as DocumentCollectionWriteRefusal,
        reason: result.reason,
      }
    : null;
}

export function documentCollectionWrites(client: ServerClient, workspaceId: string) {
  const run = (operation: string, args: object, signal?: AbortSignal) =>
    client.send("POST", `/sync/${segment(workspaceId)}/ops/${operation}`, readWriteResult, args, {
      signal,
      timeoutMs: FILE_WRITE_TIMEOUT_MS,
    });
  return {
    createCollection: (
      input: { readonly folder: string; readonly name?: string; readonly requestId: string },
      signal?: AbortSignal,
    ) => run("createDocumentCollection", input, signal),
    createRecord: (
      input: { readonly collectionPath: string; readonly name: string; readonly requestId: string },
      signal?: AbortSignal,
    ) => run("createDocumentRecord", input, signal),
    editRecordFields: (
      input: {
        readonly path: string;
        readonly expectedObjectId: string;
        readonly fields: Readonly<Record<string, RecordValue>>;
        readonly requestId: string;
      },
      signal?: AbortSignal,
    ) => run("editDocumentRecordFields", input, signal),
  };
}

export function validateCollectionFolderName(
  entered: string,
): { readonly ok: true; readonly folder: string } | { readonly ok: false; readonly error: string } {
  const folder = entered.trim();
  if (!folder) return { ok: false, error: collectionWords.collectionNameRequired };
  if (
    folder.includes("/") ||
    folder.includes("\\") ||
    folder.startsWith(".") ||
    workspaceNameError(folder, "win32") !== null
  )
    return { ok: false, error: collectionWords.invalidCollectionName };
  return { ok: true, folder };
}

export function coerceDocumentFieldValue(
  field: FieldDefinition,
  draft: Draft,
):
  | { readonly ok: true; readonly value: RecordValue }
  | { readonly ok: false; readonly error: string } {
  if (field.type === "button") return { ok: false, error: collectionWords.propertyRefused };
  const parsed = valueOf(
    {
      type: field.type === "person" ? "text" : field.type,
      options: field.type === "select" || field.type === "multi-select" ? field.options : [],
      ...(field.type === "relation" ? { relation: { many: field.many } } : {}),
    },
    draft,
  );
  if (!parsed) return { ok: false, error: collectionWords.enterNumber };
  const value =
    field.type === "person" && typeof parsed.value === "string"
      ? parsed.value.trim() || null
      : parsed.value;
  const checked = validateFieldValue(field, value);
  if (checked.status === "flagged") {
    if (checked.reason.code === "invalid-url")
      return { ok: false, error: collectionWords.enterUrl };
    if (checked.reason.code === "expected-number" || checked.reason.code === "number-not-finite")
      return { ok: false, error: collectionWords.enterNumber };
    return { ok: false, error: collectionWords.propertyRefused };
  }
  return { ok: true, value };
}
