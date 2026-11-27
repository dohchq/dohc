import { randomUUID } from "node:crypto";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-error";
import { JournalError } from "@dohc/app-backend-runtime/journal";
import {
  isDatasetReopenWaitError,
  isDatasetWorkerFailure,
} from "@dohc/app-backend-runtime/supervisor";
import {
  AppBackendLimitError,
  parseAppBackendJson,
  type AppBackendJson,
} from "@dohc/security-contract/app-backend";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { jsonResponse } from "@dohc/service-http";
import type { AccountSession } from "@dohc/workspace-auth/session";
import { hiddenFile } from "./accountFeed";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { PhoneMember } from "./phoneMember";
import type { RelayDatasetHost } from "./datasetHost";
import { badRequest, notFound, relayError, RELAY_ERROR_MESSAGES } from "./errors";
import type { SyncRelayStorage } from "./storage";
import { accountIsFenced } from "./storage/accountDeletion";
import { collectionFilePaths } from "./storage/collectionFilePresence";
import type { StorageContext } from "./storage/context";

// The phone reads its account's transactional Collections through each table's own read operation, changes one
// field of a record through the field's edit operation, and adds and deletes records through the table's create and
// delete operations, as the desktop does. The account route has checked the sign-in, its fence, the person's place in
// the workspace and their Show on phone. A Member or an Admin acts through their own grant, so the dataset host gives
// them their grants, the workspace's defaults and their folder ceiling, read-only below Edit. A Collection that is
// archived, still importing, or whose dataset.json is missing or under a hidden path answers as one that doesn't exist.

export const PHONE_COLLECTION_PAGE = 50;

const OPERATIONS = new Set([
  "collections",
  "collection",
  "collectionRecords",
  "collectionEdit",
  "collectionCreate",
  "collectionDelete",
]);

/** They reach the relay's dataset host, so they need no server copy. */
export function isPhoneCollectionOperation(name: string): boolean {
  return OPERATIONS.has(name);
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Not a relation or an attachment, which need a picker the phone doesn't have. */
const EDITABLE = new Set(["text", "number", "checkbox", "date", "select", "multi-select", "url"]);
/** What the host says when a request names rules it has replaced: nothing ran, and the same request never can. */
const RULES_REPLACED = "The Collection's rules changed. Its owner must approve this access again.";
const KEY_USED = "This retry key was already used for different values. Start a new response.";
const RULES_DISALLOW =
  "The Collection's rules no longer allow this change, so dohc did not save it.";

const isRecordId = (value: unknown): value is string | number =>
  (typeof value === "string" && value.length > 0 && value.length <= 1024) ||
  (typeof value === "number" && Number.isSafeInteger(value));
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

type DescribedField = DatasetDescription["tables"][number]["fields"][number];

const initialValue = (field: DescribedField): AppBackendJson =>
  field.type === "button"
    ? null
    : (field.default ??
      (field.type === "checkbox"
        ? false
        : field.type === "multi-select" || field.relation?.many
          ? []
          : null));

function args(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw badRequest("Invalid Collection arguments.");
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw badRequest("Invalid Collection arguments.");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw notFound();
  return value;
}
/** A read's cursor, as the read gave it: the last record's ID and its sort value. The read checks the value. */
function cursor(value: unknown): { id: string | number; value: AppBackendJson } | undefined {
  if (value === undefined || value === null) return undefined;
  const { id: key, value: sorted } = args(value, ["id", "value"]);
  if (
    !(typeof key === "string" && key.length > 0 && key.length <= 1024) &&
    !(typeof key === "number" && Number.isSafeInteger(key))
  )
    throw badRequest("Invalid Collection cursor.");
  try {
    return { id: key, value: parseAppBackendJson(sorted, 4096) };
  } catch {
    throw badRequest("Invalid Collection cursor.");
  }
}

export function createPhoneCollections(options: {
  storage: SyncRelayStorage;
  /** Absent while this server keeps no Collections. */
  host: Pick<RelayDatasetHost, "list" | "describe" | "invoke"> | undefined;
}) {
  const storage = options.storage as StorageContext;

  // The fence, the person's place in the workspace and their Show on phone. Plain reads, so the dataset host runs this
  // inside the read too.
  function holds(userId: string, workspaceId: string): void {
    if (accountIsFenced(storage, userId) || storage.phoneRole(userId, workspaceId) === null)
      throw notFound();
  }
  // Its dataset.json is on main, and neither where it was approved nor where it is now is hidden.
  function visible(workspaceId: string, datasetId: string): boolean {
    const paths = collectionFilePaths(storage, workspaceId, datasetId);
    return (
      paths !== null &&
      paths.current !== null &&
      !hiddenFile(paths.approved) &&
      !hiddenFile(paths.current)
    );
  }
  function describe(
    host: NonNullable<typeof options.host>,
    auth: AppBackendAuth,
    workspaceId: string,
    datasetId: string,
  ): DatasetDescription {
    if (!visible(workspaceId, datasetId)) throw notFound();
    // The owner's authority describes an archived one, which answers as missing rather than refused. A Member's
    // authority is refused one as archived, which answers the same.
    if (auth.kind === "named" && auth.grantId !== undefined) {
      try {
        return host.describe(auth, { workspaceId, datasetId });
      } catch (error) {
        if (error instanceof DatasetHostError && error.code === "conflict") throw notFound();
        throw error;
      }
    }
    const description = host.describe(auth, { workspaceId, datasetId, includeArchived: true });
    if (description.archived) throw notFound();
    return description;
  }
  // The desktop's choice: the table's first operation that only reads.
  const readOperation = (description: DatasetDescription, tableId: string) =>
    description.operations.find(
      (operation) =>
        operation.tableId === tableId && operation.kind === "read" && operation.readOnly,
    );
  // The desktop's choice: the first edit that changes the field. Only a field the phone edits and the read shows.
  const editOperation = (description: DatasetDescription, tableId: string, field: DescribedField) =>
    EDITABLE.has(field.type) &&
    !("generated" in field && field.generated) &&
    readOperation(description, tableId)?.fieldIds.includes(field.fieldId)
      ? description.operations.find(
          (operation) =>
            operation.tableId === tableId &&
            operation.kind === "edit" &&
            !operation.readOnly &&
            operation.fieldIds.includes(field.fieldId),
        )
      : undefined;
  const writeOperation = (
    description: DatasetDescription,
    tableId: string,
    kind: "create" | "delete",
  ) =>
    readOperation(description, tableId)
      ? description.operations.find(
          (operation) =>
            operation.tableId === tableId && operation.kind === kind && !operation.readOnly,
        )
      : undefined;
  // A new record's values, as the desktop sends them, or undefined when a required field would be empty: the desktop
  // asks for that field first, and the phone has nowhere to ask. The phone then reads the record by its key.
  function createValues(description: DatasetDescription, tableId: string) {
    const create = writeOperation(description, tableId, "create");
    const table = description.tables.find((table) => table.tableId === tableId);
    const key = table?.primaryKeyFieldId;
    if (!create || !table || !key || !readOperation(description, tableId)?.fieldIds.includes(key))
      return undefined;
    const values: Record<string, AppBackendJson> = {};
    for (const fieldId of create.fieldIds) {
      const field = table.fields.find((field) => field.fieldId === fieldId);
      if (!field) return undefined;
      const value = initialValue(field);
      if ("required" in field && field.required && (value === null || value === ""))
        return undefined;
      values[fieldId] = value;
    }
    return { create, values };
  }
  // A file still waiting to attach has no name.
  function fileNames(workspaceId: string, datasetId: string, fileIds: ReadonlySet<string>) {
    const names: Record<string, string> = {};
    const read = storage.db.prepare(
      "SELECT metadata FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=? AND attached_revision IS NOT NULL",
    );
    for (const fileId of fileIds) {
      const row = read.get(workspaceId, datasetId, fileId);
      const name: unknown = row && JSON.parse(String(row.metadata)).name;
      if (typeof name === "string") names[fileId] = name;
    }
    return names;
  }

  async function run(input: {
    caller: AccountSession;
    /** A Member's or an Admin's reach, or null for the owner. */
    member: Pick<PhoneMember, "grantId"> | null;
    /** What still lets the caller in. The phone's sign-in fence, place in the workspace and Show on phone by default. */
    holds?(): void;
    workspaceId: string;
    operation: string;
    args: unknown;
    authorize(): Promise<void>;
    signal: AbortSignal;
  }): Promise<unknown> {
    const { caller, workspaceId, operation, authorize } = input;
    const userId = caller.userId;
    const host = options.host;
    const stillHolds = input.holds ?? (() => holds(userId, workspaceId));
    // The host checks the guard at admission and again inside the read or the commit.
    const guarded = (check: () => void): AppBackendAuth => ({
      kind: "named",
      workspaceId,
      userId,
      ...(input.member ? { grantId: input.member.grantId } : {}),
      launch: { authorizeOperation: check, recheck: authorize },
    });
    const auth = guarded(stillHolds);
    if (operation === "collections") {
      const { cursor: after } = args(input.args, [], ["cursor"]);
      if (after !== undefined) id(after);
      if (!host) return { collections: [], nextCursor: null };
      const page = host.list(auth, {
        workspaceId,
        limit: PHONE_COLLECTION_PAGE,
        ...(after === undefined ? {} : { after: after as string }),
      });
      return {
        collections: page.datasets
          .filter((dataset) => !dataset.archived && visible(workspaceId, dataset.datasetId))
          .map(({ datasetId, name }) => ({ datasetId, name })),
        nextCursor: page.nextCursor,
      };
    }
    if (!host) throw notFound();
    if (operation === "collection") {
      const datasetId = id(args(input.args, ["datasetId"]).datasetId);
      const description = describe(host, auth, workspaceId, datasetId);
      return {
        datasetId,
        name: description.name,
        // The rules this description is of, which a change names. Never the operations or their source.
        revision: description.revision,
        revisionSha256: description.revisionSha256,
        tables: description.tables.map((table) => {
          // Only what the read gives, so a field it leaves out never shows as empty or unchecked.
          const read = readOperation(description, table.tableId);
          const fields = table.fields.flatMap((field) => {
            if (
              field.type === "button" ||
              field.generated ||
              !read?.fieldIds.includes(field.fieldId)
            )
              return [];
            const edit = editOperation(description, table.tableId, field);
            return [
              {
                fieldId: field.fieldId,
                name: field.name,
                type: field.type,
                ...(field.options ? { options: field.options } : {}),
                editable: edit !== undefined,
                reversible: edit?.reversible === true,
              },
            ];
          });
          return {
            tableId: table.tableId,
            name: table.name,
            primaryFieldId: fields.some((field) => field.fieldId === table.primaryKeyFieldId)
              ? table.primaryKeyFieldId!
              : null,
            fields,
            canCreate: createValues(description, table.tableId) !== undefined,
            canDelete: writeOperation(description, table.tableId, "delete") !== undefined,
          };
        }),
      };
    }
    // Nothing awaits between these checks and the answer.
    const answers = async (datasetId: string) => {
      await authorize();
      stillHolds();
      describe(host, auth, workspaceId, datasetId);
    };
    // A write's key and rules stamp. The key is the phone's own, kept for a retry; the owner's keys are shared with the
    // desktop's, so only a random one.
    const stamped = (body: Record<string, unknown>) => {
      const { revision, revisionSha256, idempotencyKey } = body;
      if (
        typeof idempotencyKey !== "string" ||
        !ID.test(idempotencyKey) ||
        !isCount(revision) ||
        typeof revisionSha256 !== "string" ||
        !SHA256.test(revisionSha256)
      )
        throw badRequest("Invalid Collection arguments.");
      return { revision, revisionSha256, idempotencyKey };
    };
    const refusedHere = { refused: { code: "forbidden", message: RULES_DISALLOW } };
    const commit = async (
      datasetId: string,
      stamp: ReturnType<typeof stamped>,
      operationId: string,
      operationInput: AppBackendJson,
    ): Promise<{ receipt: Record<string, AppBackendJson> | null } | { answer: object }> => {
      let result: AppBackendJson;
      try {
        // The phone's stamp, not the description's: a retry sends what its first try sent. The operation checks the
        // values, which the route read as JSON.
        ({ result } = await host.invoke(
          guarded(() => {
            stillHolds();
            if (!visible(workspaceId, datasetId)) throw notFound();
          }),
          {
            workspaceId,
            datasetId,
            ...stamp,
            operationId,
            input: operationInput,
            signal: input.signal,
          },
        ));
      } catch (error) {
        if (isAppBackendRuntimeError(error)) {
          await answers(datasetId);
          return {
            answer: { refused: { code: error.refusal.code, message: error.refusal.message } },
          };
        }
        if (
          error instanceof AppBackendLimitError ||
          (error instanceof Error && error.name === "AppBackendLimitError")
        ) {
          await answers(datasetId);
          return {
            answer: { refused: { code: "resource_limit", message: error.message } },
          };
        }
        // A key used before for another payload: the phone resends a write unchanged, so its operation or rules
        // changed between tries, and the first try may have saved.
        if (
          (error instanceof DatasetHostError &&
            error.code === "conflict" &&
            error.message === RULES_REPLACED) ||
          (error instanceof JournalError && error.code === "conflict" && error.message === KEY_USED)
        ) {
          await answers(datasetId);
          return { answer: { rulesChanged: true } };
        }
        throw error;
      }
      await answers(datasetId);
      return {
        receipt: result && typeof result === "object" && !Array.isArray(result) ? result : null,
      };
    };
    if (operation === "collectionCreate") {
      const body = args(input.args, [
        "datasetId",
        "tableId",
        "revision",
        "revisionSha256",
        "idempotencyKey",
      ]);
      const datasetId = id(body.datasetId),
        tableId = id(body.tableId),
        stamp = stamped(body);
      const description = describe(host, auth, workspaceId, datasetId);
      if (!description.tables.some((table) => table.tableId === tableId)) throw notFound();
      const create = createValues(description, tableId);
      if (!create) return refusedHere;
      const done = await commit(datasetId, stamp, create.create.operationId, {
        values: create.values,
      });
      if ("answer" in done) return done.answer;
      const { receipt } = done;
      if (!receipt || !isRecordId(receipt.id) || !isCount(receipt.version))
        throw relayError("conflict", "This Collection's create gave an answer dohc can't show.");
      return { saved: { id: receipt.id, version: receipt.version } };
    }
    if (operation === "collectionDelete") {
      const body = args(input.args, [
        "datasetId",
        "tableId",
        "recordId",
        "expectedVersion",
        "revision",
        "revisionSha256",
        "idempotencyKey",
      ]);
      const datasetId = id(body.datasetId),
        tableId = id(body.tableId),
        stamp = stamped(body);
      const { recordId, expectedVersion } = body;
      if (!isRecordId(recordId) || !isCount(expectedVersion))
        throw badRequest("Invalid Collection arguments.");
      const description = describe(host, auth, workspaceId, datasetId);
      if (!description.tables.some((table) => table.tableId === tableId)) throw notFound();
      const remove = writeOperation(description, tableId, "delete");
      if (!remove) return refusedHere;
      const done = await commit(datasetId, stamp, remove.operationId, {
        id: recordId,
        expectedVersion,
      });
      return "answer" in done ? done.answer : { saved: {} };
    }
    if (operation === "collectionEdit") {
      const body = args(input.args, [
        "datasetId",
        "tableId",
        "recordId",
        "fieldId",
        "value",
        "expectedVersion",
        "revision",
        "revisionSha256",
        "idempotencyKey",
      ]);
      const datasetId = id(body.datasetId),
        tableId = id(body.tableId),
        fieldId = id(body.fieldId),
        stamp = stamped(body);
      const { recordId, value, expectedVersion } = body;
      if (!isRecordId(recordId) || !isCount(expectedVersion))
        throw badRequest("Invalid Collection arguments.");
      const description = describe(host, auth, workspaceId, datasetId);
      const field = description.tables
        .find((table) => table.tableId === tableId)
        ?.fields.find((field) => field.fieldId === fieldId);
      if (!field) throw notFound();
      const edit = editOperation(description, tableId, field);
      if (!edit) return refusedHere;
      const done = await commit(datasetId, stamp, edit.operationId, {
        id: recordId,
        expectedVersion,
        values: { [fieldId]: value as AppBackendJson },
      });
      if ("answer" in done) return done.answer;
      const { receipt } = done;
      const prior = receipt?.priorValues;
      if (
        !receipt ||
        !isCount(receipt.version) ||
        (prior !== undefined &&
          (!prior || typeof prior !== "object" || Array.isArray(prior) || !(fieldId in prior)))
      )
        throw relayError("conflict", "This Collection's edit gave an answer dohc can't show.");
      return {
        saved: {
          version: receipt.version,
          ...(prior === undefined ? {} : { priorValue: prior[fieldId] ?? null }),
        },
      };
    }
    const body = args(input.args, ["datasetId", "tableId"], ["after", "recordId"]);
    const datasetId = id(body.datasetId),
      tableId = id(body.tableId),
      after = cursor(body.after),
      recordId = body.recordId;
    if (recordId !== undefined && (!isRecordId(recordId) || after))
      throw badRequest("Invalid Collection arguments.");
    const description = describe(host, auth, workspaceId, datasetId);
    const table = description.tables.find((table) => table.tableId === tableId);
    if (!table) throw notFound();
    const read = readOperation(description, tableId);
    if (!read) return { status: "refused", reason: "no-read" };
    // One record, by its key, as the desktop reads a record again.
    const key = table.primaryKeyFieldId;
    if (recordId !== undefined && (!key || !read.fieldIds.includes(key))) throw notFound();
    const { result } = await host.invoke(auth, {
      workspaceId,
      datasetId,
      revision: description.revision,
      revisionSha256: description.revisionSha256,
      operationId: read.operationId,
      input:
        recordId !== undefined
          ? { limit: 1, filters: [{ fieldId: key!, value: recordId }] }
          : { limit: PHONE_COLLECTION_PAGE, ...(after ? { after } : {}) },
      idempotencyKey: randomUUID(),
      signal: input.signal,
    });
    await answers(datasetId);
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !Array.isArray(result.rows) ||
      result.rows.length > PHONE_COLLECTION_PAGE ||
      !Object.hasOwn(result, "nextCursor")
    )
      throw relayError("conflict", "This Collection's read gave an answer dohc can't show.");
    const attachments = table.fields.filter((field) => field.type === "attachment");
    const fileIds = new Set<string>();
    for (const row of result.rows)
      if (row && typeof row === "object" && !Array.isArray(row)) {
        const values = row.values;
        if (values && typeof values === "object" && !Array.isArray(values))
          for (const field of attachments) {
            const value = values[field.fieldId];
            if (typeof value === "string" && FILE_ID.test(value)) fileIds.add(value);
          }
      }
    return {
      status: "ready",
      rows: result.rows,
      nextCursor: result.nextCursor,
      files: fileNames(workspaceId, datasetId, fileIds),
    };
  }

  return {
    /** One Collection operation, answered as the dataset routes answer the host's refusals. */
    async respond(input: Parameters<typeof run>[0]): Promise<Response> {
      try {
        return jsonResponse({ ok: true, result: await run(input) });
      } catch (error) {
        if (isDatasetReopenWaitError(error) || isDatasetWorkerFailure(error))
          return jsonResponse(
            { ok: false, error: RELAY_ERROR_MESSAGES.server_busy, code: "server_busy" },
            503,
            error.retryAfterMs
              ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) }
              : {},
          );
        if (
          error instanceof AppBackendLimitError ||
          (error instanceof Error && error.name === "AppBackendLimitError")
        )
          throw relayError("payload_too_large", error.message);
        if (isAppBackendRuntimeError(error)) throw relayError("conflict");
        if (error instanceof JournalError)
          throw relayError(error.code === "invalid" ? "bad_request" : "conflict");
        if (error instanceof DatasetHostError)
          throw relayError(
            error.code === "not_authorized"
              ? "not_found"
              : error.code === "invalid"
                ? "bad_request"
                : "conflict",
          );
        throw error;
      }
    },
  };
}

export type PhoneCollections = ReturnType<typeof createPhoneCollections>;
