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
import { badRequest, notFound, RelayError, relayError, RELAY_ERROR_MESSAGES } from "./errors";
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
const RELATION_LABEL_LIMIT = 100;
const RELATION_KEY_FALLBACK_MAX = 25;

const OPERATIONS = new Set([
  "collections",
  "collection",
  "collectionRecords",
  "collectionEdit",
  "collectionCreate",
  "collectionDelete",
  "collectionRelationOptions",
]);

/** They reach the relay's dataset host, so they need no server copy. */
export function isPhoneCollectionOperation(name: string): boolean {
  return OPERATIONS.has(name);
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
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
type DescribedRelation = NonNullable<Extract<DescribedField, { relation?: unknown }>["relation"]>;
type RelationTarget = {
  datasetId: string;
  revision: number;
  revisionSha256: string;
  fieldId: string;
  readOperationId: string;
  labelFieldId: string | null;
};

const initialValue = (field: DescribedField): AppBackendJson =>
  field.type === "button"
    ? null
    : (field.default ??
      (field.type === "checkbox"
        ? false
        : field.type === "multi-select" || field.relation?.many
          ? []
          : null));

function readRows(result: AppBackendJson, max: number) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Array.isArray(result.rows) ||
    result.rows.length > max ||
    !Object.hasOwn(result, "nextCursor")
  )
    throw relayError("conflict", "This Collection's read gave an answer dohc can't show.");
  return { rows: result.rows, nextCursor: result.nextCursor };
}

function relationOption(row: unknown, fieldId: string, labelFieldId: string | null) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const values = (row as Record<string, unknown>).values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const key = (values as Record<string, unknown>)[fieldId];
  if (!isRecordId(key)) return null;
  const raw = labelFieldId ? (values as Record<string, unknown>)[labelFieldId] : undefined;
  return { value: key, label: typeof raw === "string" && raw.trim() ? raw : String(key) };
}

function searchTerm(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 200)
    throw badRequest("Invalid Collection arguments.");
  return value.length > 0 ? value : undefined;
}

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
  function relationTarget(
    host: NonNullable<typeof options.host>,
    auth: AppBackendAuth,
    workspaceId: string,
    source: DatasetDescription,
    relation: DescribedRelation,
  ): RelationTarget | null {
    if (!visible(workspaceId, relation.datasetId)) return null;
    let target: DatasetDescription;
    if (relation.datasetId === source.datasetId) target = source;
    else {
      try {
        target = describe(host, auth, workspaceId, relation.datasetId);
      } catch (error) {
        if (
          (error instanceof RelayError && error.code === "not_found") ||
          (error instanceof DatasetHostError &&
            (error.code === "not_authorized" || error.code === "conflict"))
        )
          return null;
        throw error;
      }
    }
    const table = target.tables.find((t) => t.tableId === relation.tableId);
    const read = target.operations.find(
      (op) =>
        op.tableId === relation.tableId &&
        op.kind === "read" &&
        op.readOnly &&
        op.fieldIds.includes(relation.fieldId),
    );
    const keyField = table?.fields.find((f) => f.fieldId === relation.fieldId);
    if (!table || !read || !keyField || keyField.type === "button") return null;
    const label = table.fields.find(
      (f) =>
        f.type === "text" &&
        !("generated" in f && f.generated) &&
        f.fieldId !== relation.fieldId &&
        read.fieldIds.includes(f.fieldId),
    );
    return {
      datasetId: target.datasetId,
      revision: target.revision,
      revisionSha256: target.revisionSha256,
      fieldId: relation.fieldId,
      readOperationId: read.operationId,
      labelFieldId: label?.fieldId ?? null,
    };
  }
  const canInput = (
    host: NonNullable<typeof options.host>,
    auth: AppBackendAuth,
    workspaceId: string,
    description: DatasetDescription,
    field: DescribedField,
  ) =>
    field.type !== "button" &&
    !field.generated &&
    (EDITABLE.has(field.type) ||
      (field.type === "relation" &&
        field.relation !== undefined &&
        relationTarget(host, auth, workspaceId, description, field.relation) !== null));
  const editOperation = (
    host: NonNullable<typeof options.host>,
    auth: AppBackendAuth,
    workspaceId: string,
    description: DatasetDescription,
    tableId: string,
    field: DescribedField,
  ) =>
    canInput(host, auth, workspaceId, description, field) &&
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
  function createSpec(
    host: NonNullable<typeof options.host>,
    auth: AppBackendAuth,
    workspaceId: string,
    description: DatasetDescription,
    tableId: string,
  ) {
    const create = writeOperation(description, tableId, "create");
    const table = description.tables.find((table) => table.tableId === tableId);
    const key = table?.primaryKeyFieldId;
    if (!create || !table || !key || !readOperation(description, tableId)?.fieldIds.includes(key))
      return undefined;
    if (
      create.fieldIds.some((fid) => {
        const f = table.fields.find((item) => item.fieldId === fid);
        return !f || f.type === "button" || f.generated;
      })
    )
      return undefined;
    const fields: Array<Record<string, unknown>> = [];
    const allowedFieldIds = new Set<string>();
    for (const field of table.fields) {
      if (!create.fieldIds.includes(field.fieldId) || field.type === "button" || field.generated)
        continue;
      if (!canInput(host, auth, workspaceId, description, field)) {
        const init = initialValue(field);
        if (
          field.required &&
          (init === null || init === "" || (Array.isArray(init) && !init.length))
        )
          return undefined;
        continue;
      }
      allowedFieldIds.add(field.fieldId);
      fields.push({
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        required: field.required,
        ...(Object.hasOwn(field, "default") ? { default: field.default } : {}),
        ...(field.options ? { options: field.options } : {}),
        ...(field.type === "relation" && field.relation
          ? { relation: { many: field.relation.many } }
          : {}),
      });
    }
    return { create, fields, allowedFieldIds };
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
            const target =
              field.type === "relation" && field.relation
                ? relationTarget(host, auth, workspaceId, description, field.relation)
                : null;
            const edit = editOperation(host, auth, workspaceId, description, table.tableId, field);
            return [
              {
                fieldId: field.fieldId,
                name: field.name,
                type: field.type,
                ...(field.options ? { options: field.options } : {}),
                ...(target && field.relation ? { relation: { many: field.relation.many } } : {}),
                editable: edit !== undefined,
                reversible: edit?.reversible === true,
              },
            ];
          });
          const creation = createSpec(host, auth, workspaceId, description, table.tableId);
          return {
            tableId: table.tableId,
            name: table.name,
            primaryFieldId: fields.some((field) => field.fieldId === table.primaryKeyFieldId)
              ? table.primaryKeyFieldId!
              : null,
            fields,
            createFields: creation?.fields ?? [],
            canCreate: creation !== undefined,
            canDelete: writeOperation(description, table.tableId, "delete") !== undefined,
          };
        }),
      };
    }
    // Nothing awaits between these checks and the answer.
    const answers = async (datasetId: string): Promise<DatasetDescription> => {
      await authorize();
      stillHolds();
      return describe(host, auth, workspaceId, datasetId);
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
      const body = args(
        input.args,
        ["datasetId", "tableId", "revision", "revisionSha256", "idempotencyKey"],
        ["values"],
      );
      const datasetId = id(body.datasetId),
        tableId = id(body.tableId),
        stamp = stamped(body);
      let supplied: Record<string, AppBackendJson> | undefined;
      if (body.values !== undefined) {
        if (!body.values || typeof body.values !== "object" || Array.isArray(body.values))
          throw badRequest("Invalid Collection arguments.");
        try {
          supplied = parseAppBackendJson(body.values) as Record<string, AppBackendJson>;
        } catch {
          throw badRequest("Invalid Collection arguments.");
        }
        if (Object.keys(supplied).some((key) => !ID.test(key)))
          throw badRequest("Invalid Collection arguments.");
      }
      const description = describe(host, auth, workspaceId, datasetId);
      const table = description.tables.find((table) => table.tableId === tableId);
      if (!table) throw notFound();
      const creation = createSpec(host, auth, workspaceId, description, tableId);
      if (
        !creation ||
        (supplied && Object.keys(supplied).some((k) => !creation.allowedFieldIds.has(k)))
      )
        return refusedHere;
      const values: Record<string, AppBackendJson> = {};
      for (const fieldId of creation.create.fieldIds) {
        const field = table.fields.find((item) => item.fieldId === fieldId)!;
        values[fieldId] =
          supplied && Object.hasOwn(supplied, fieldId) ? supplied[fieldId]! : initialValue(field);
      }
      const done = await commit(datasetId, stamp, creation.create.operationId, { values });
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
      const edit = editOperation(host, auth, workspaceId, description, tableId, field);
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
    const invokeTarget = (datasetId: string, target: RelationTarget, opInput: AppBackendJson) =>
      host.invoke(
        guarded(() => {
          stillHolds();
          if (!visible(workspaceId, datasetId) || !visible(workspaceId, target.datasetId))
            throw notFound();
        }),
        {
          workspaceId,
          datasetId: target.datasetId,
          revision: target.revision,
          revisionSha256: target.revisionSha256,
          operationId: target.readOperationId,
          input: opInput,
          idempotencyKey: randomUUID(),
          signal: input.signal,
        },
      );
    if (operation === "collectionRelationOptions") {
      const body = args(input.args, ["datasetId", "tableId", "fieldId"], ["search", "after"]);
      const datasetId = id(body.datasetId),
        tableId = id(body.tableId),
        fieldId = id(body.fieldId),
        after = cursor(body.after),
        search = searchTerm(body.search);
      const description = describe(host, auth, workspaceId, datasetId);
      const pickTarget = (desc: DatasetDescription) => {
        const field = desc.tables
          .find((t) => t.tableId === tableId)
          ?.fields.find((f) => f.fieldId === fieldId);
        if (field?.type !== "relation" || !field.relation) return null;
        if (
          editOperation(host, auth, workspaceId, desc, tableId, field) === undefined &&
          !createSpec(host, auth, workspaceId, desc, tableId)?.allowedFieldIds.has(fieldId)
        )
          return null;
        return relationTarget(host, auth, workspaceId, desc, field.relation);
      };
      const target = pickTarget(description);
      if (!target) throw notFound();
      const verify = async () => {
        const fresh = pickTarget(await answers(datasetId));
        if (
          !fresh ||
          fresh.datasetId !== target.datasetId ||
          fresh.fieldId !== target.fieldId ||
          fresh.readOperationId !== target.readOperationId
        )
          throw notFound();
      };
      let raw: AppBackendJson;
      try {
        ({ result: raw } = await invokeTarget(datasetId, target, {
          limit: PHONE_COLLECTION_PAGE,
          ...(after ? { after } : {}),
          ...(search ? { search } : {}),
        }));
      } catch (error) {
        if (search && isAppBackendRuntimeError(error) && error.refusal.code === "invalid_input") {
          await verify();
          return { options: [], nextCursor: null, searchUnsupported: true };
        }
        throw error;
      }
      await verify();
      const page = readRows(raw, PHONE_COLLECTION_PAGE);
      const seen = new Set<string>();
      const options: Array<{ value: string | number; label: string }> = [];
      for (const row of page.rows) {
        const opt = relationOption(row, target.fieldId, target.labelFieldId);
        if (!opt) continue;
        const encoded = JSON.stringify(opt.value);
        if (!seen.has(encoded)) {
          seen.add(encoded);
          options.push(opt);
        }
      }
      return { options, nextCursor: page.nextCursor };
    }
    const body = args(
      input.args,
      ["datasetId", "tableId"],
      ["after", "recordId", "search", "sort"],
    );
    const datasetId = id(body.datasetId),
      tableId = id(body.tableId),
      after = cursor(body.after),
      recordId = body.recordId,
      search = searchTerm(body.search);
    let sort: { fieldId: string; direction: "asc" | "desc" } | undefined;
    if (body.sort !== undefined) {
      const raw = args(body.sort, ["fieldId", "direction"]);
      if (
        typeof raw.fieldId !== "string" ||
        !ID.test(raw.fieldId) ||
        (raw.direction !== "asc" && raw.direction !== "desc")
      )
        throw badRequest("Invalid Collection arguments.");
      sort = { fieldId: raw.fieldId, direction: raw.direction };
    }
    if (
      recordId !== undefined &&
      (!isRecordId(recordId) || after || search !== undefined || sort !== undefined)
    )
      throw badRequest("Invalid Collection arguments.");
    const description = describe(host, auth, workspaceId, datasetId);
    const table = description.tables.find((table) => table.tableId === tableId);
    if (!table) throw notFound();
    const read = readOperation(description, tableId);
    if (!read) return { status: "refused", reason: "no-read" };
    if (sort) {
      const sortField = table.fields.find((f) => f.fieldId === sort.fieldId);
      if (
        !sortField ||
        !read.fieldIds.includes(sort.fieldId) ||
        sortField.type === "button" ||
        sortField.type === "attachment" ||
        sortField.type === "multi-select" ||
        (sortField.type === "relation" &&
          (sortField.relation?.many !== false ||
            relationTarget(host, auth, workspaceId, description, sortField.relation) === null))
      )
        throw badRequest("Invalid Collection arguments.");
    }
    const key = table.primaryKeyFieldId;
    if (recordId !== undefined && (!key || !read.fieldIds.includes(key))) throw notFound();
    let result: AppBackendJson;
    try {
      ({ result } = await host.invoke(auth, {
        workspaceId,
        datasetId,
        revision: description.revision,
        revisionSha256: description.revisionSha256,
        operationId: read.operationId,
        input:
          recordId !== undefined
            ? { limit: 1, filters: [{ fieldId: key!, value: recordId }] }
            : {
                limit: PHONE_COLLECTION_PAGE,
                ...(after ? { after } : {}),
                ...(search ? { search } : {}),
                ...(sort ? { sort } : {}),
              },
        idempotencyKey: randomUUID(),
        signal: input.signal,
      }));
    } catch (error) {
      if (
        (search !== undefined || sort !== undefined) &&
        isAppBackendRuntimeError(error) &&
        error.refusal.code === "invalid_input"
      ) {
        await answers(datasetId);
        return { status: "refused", reason: "unsupported-query" };
      }
      throw error;
    }
    const page = readRows(result, PHONE_COLLECTION_PAGE);
    const attachments = table.fields.filter((field) => field.type === "attachment");
    const relFields = table.fields.filter(
      (f): f is Exclude<DescribedField, { type: "button" }> & { relation: DescribedRelation } =>
        f.type === "relation" && f.relation !== undefined && read.fieldIds.includes(f.fieldId),
    );
    const fileIds = new Set<string>();
    const relGroups = new Map<
      string,
      { relation: DescribedRelation; fieldIds: string[]; wanted: Map<string, string | number> }
    >();
    for (const row of page.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const values = row.values;
      if (!values || typeof values !== "object" || Array.isArray(values)) continue;
      for (const field of attachments) {
        const value = values[field.fieldId];
        if (typeof value === "string" && FILE_ID.test(value)) fileIds.add(value);
      }
      for (const field of relFields) {
        const raw = values[field.fieldId];
        const keys = field.relation.many
          ? Array.isArray(raw)
            ? raw.filter(isRecordId)
            : []
          : isRecordId(raw)
            ? [raw]
            : [];
        if (!keys.length) continue;
        const gk = `${field.relation.datasetId}\0${field.relation.tableId}\0${field.relation.fieldId}`;
        const group = relGroups.get(gk) ?? {
          relation: field.relation,
          fieldIds: [] as string[],
          wanted: new Map<string, string | number>(),
        };
        relGroups.set(gk, group);
        if (!group.fieldIds.includes(field.fieldId)) group.fieldIds.push(field.fieldId);
        for (const item of keys) group.wanted.set(JSON.stringify(item), item);
      }
    }
    const resolved: Array<{
      relation: DescribedRelation;
      fieldIds: string[];
      labels: Record<string, string>;
    }> = [];
    for (const group of relGroups.values()) {
      const target = relationTarget(host, auth, workspaceId, description, group.relation);
      if (!target) continue;
      const labels: Record<string, string> = {};
      const collect = (raw: AppBackendJson) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.rows))
          return false;
        for (const row of raw.rows) {
          const opt = relationOption(row, target.fieldId, target.labelFieldId);
          if (opt && group.wanted.has(JSON.stringify(opt.value)))
            labels[JSON.stringify(opt.value)] = opt.label;
        }
        return raw.nextCursor !== null;
      };
      const tryTarget = async (opInput: AppBackendJson) => {
        try {
          return {
            ok: true as const,
            result: (await invokeTarget(datasetId, target, opInput)).result,
          };
        } catch (error) {
          if (input.signal.aborted) throw error;
          if (error instanceof RelayError && error.code === "not_found")
            return { ok: false as const, code: "not_found" };
          if (isAppBackendRuntimeError(error))
            return { ok: false as const, code: error.refusal.code };
          if (error instanceof DatasetHostError) return { ok: false as const, code: error.code };
          throw error;
        }
      };
      let first = await tryTarget({ limit: RELATION_LABEL_LIMIT });
      if (!first.ok && first.code === "invalid_input")
        first = await tryTarget({ limit: PHONE_COLLECTION_PAGE });
      if (first.ok && collect(first.result)) {
        let count = 0;
        for (const [encoded, item] of group.wanted) {
          if (Object.hasOwn(labels, encoded) || count++ >= RELATION_KEY_FALLBACK_MAX) continue;
          const single = await tryTarget({
            limit: 1,
            filters: [{ fieldId: target.fieldId, value: item }],
          });
          if (!single.ok) break;
          collect(single.result);
        }
      }
      if (Object.keys(labels).length > 0)
        resolved.push({ relation: group.relation, fieldIds: group.fieldIds, labels });
    }
    const fresh = await answers(datasetId);
    const freshTable = fresh.tables.find((t) => t.tableId === tableId);
    const freshRead = readOperation(fresh, tableId);
    const relations: Record<string, Record<string, string>> = {};
    for (const group of resolved) {
      if (!relationTarget(host, auth, workspaceId, fresh, group.relation)) continue;
      for (const fieldId of group.fieldIds) {
        if (!freshRead?.fieldIds.includes(fieldId)) continue;
        const f = freshTable?.fields.find((item) => item.fieldId === fieldId);
        if (
          f?.type === "relation" &&
          f.relation &&
          f.relation.datasetId === group.relation.datasetId &&
          f.relation.tableId === group.relation.tableId &&
          f.relation.fieldId === group.relation.fieldId
        )
          relations[fieldId] = group.labels;
      }
    }
    return {
      status: "ready",
      rows: page.rows,
      nextCursor: page.nextCursor,
      files: fileNames(workspaceId, datasetId, fileIds),
      relations,
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
