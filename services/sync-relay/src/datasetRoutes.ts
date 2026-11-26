import { parseApprovalAgent } from "@dohc/security-contract/approval-provenance";
import { readBoundedBytes } from "@dohc/service-http";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { createAppExternalCalls } from "./appExternalCalls";
import { JournalError, type DatasetCursor } from "@dohc/app-backend-runtime/journal";
import {
  DatasetHostError,
  DatasetBindingPendingAttemptError,
  DatasetNotArchivedError,
} from "@dohc/app-backend-runtime/dataset-error";
import {
  isDatasetReopenWaitError,
  isDatasetWorkerFailure,
} from "@dohc/app-backend-runtime/supervisor";
import { APP_PUBLICATION_MAX_METADATA_BYTES } from "@dohc/security-contract/app-publication";
import { APP_DATASET_MAX_BINDINGS, parseDatasetRevision } from "@dohc/security-contract/dataset";
import { parseDatasetAttemptRequest } from "@dohc/security-contract/dataset-attempts";
import {
  APP_BACKEND_BULK_LIMITS,
  APP_BACKEND_PROFILE_HEADER,
  APP_BACKEND_REQUEST_BYTES,
  AppBackendLimitError,
  APP_BACKEND_CATCH_UP_BYTES,
  APP_BACKEND_CATCH_UP_HEADER,
  APP_BACKEND_UPLOAD_REQUEST_BYTES,
  parseAppBackendJson,
  parseAppBackendInvokeRequest,
  parseAppBackendUploadRequest,
} from "@dohc/security-contract/app-backend";
import { DATASET_AUTOMATION_CHAIN_DEPTH } from "@dohc/app-backend-runtime/dataset-automation-claims";
import { CHAIN_STOPPED_PRESS } from "@dohc/automation-executor/automation-failed-notice";
import type { DatasetServerPress } from "./datasetAutomations";
import type { CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import type { RelayDatasetHost } from "./datasetHost";
import { MemberAppRefusal } from "./storage/memberApps";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { AppBackendRoute } from "./appBackendRoutes";
import { createAppBackendAdmission, type AppBackendAdmissionLimits } from "./appBackendAdmission";
import { badRequest, notFound, relayError } from "./errors";
import type { AppEventWaits } from "./appEventWaits";
import { parseLinkLogHold } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";

/** The largest JSON body a dataset action reads. */
export function datasetRequestBytes(action: DatasetRoute["action"], owner = false): number {
  if (action === "invoke" && owner) return APP_BACKEND_BULK_LIMITS.requestBytes;
  return action === "upload"
    ? APP_BACKEND_UPLOAD_REQUEST_BYTES
    : action === "activate" || action === "prepare-migration"
      ? 1024 * 1024
      : // An app candidate up to its bound, inside the `localApp` wrapper.
        action === "binding" || action === "local-app"
        ? APP_PUBLICATION_MAX_METADATA_BYTES + 1024
        : APP_BACKEND_REQUEST_BYTES;
}

/**
 * The journal from `after` to the head, with each change's bytes, or null when
 * it holds a checkpoint, more than one page, or more than the response carries.
 * The kept copy then catches up through its own routes.
 */
function journalAfter(
  host: RelayDatasetHost,
  auth: Extract<AppBackendAuth, { kind: "named" }>,
  scope: { workspaceId: string; datasetId: string },
  after: DatasetCursor,
) {
  try {
    const { head } = host.replicaCapture(auth, scope);
    if (head.revision < after.revision) return null;
    const page =
      head.revision === after.revision
        ? { records: [] }
        : host.replicaPage(auth, { ...scope, through: head, after, limit: 32 });
    if (page.records.length !== head.revision - after.revision) return null;
    let bytes = 0;
    const changesets: string[] = [];
    for (const record of page.records) {
      if (record.kind !== "event") return null;
      bytes += record.byteLength;
      if (bytes > APP_BACKEND_CATCH_UP_BYTES / 2) return null;
      const changeset = host.replicaBlob(auth, {
        ...scope,
        record,
        offset: 0,
        length: record.byteLength,
      });
      changesets.push(Buffer.from(changeset).toString("base64"));
    }
    const catchUp = { head, records: page.records, changesets };
    return Buffer.byteLength(JSON.stringify(catchUp)) > APP_BACKEND_CATCH_UP_BYTES ? null : catchUp;
  } catch {
    // The change is committed either way; the copy's own catch-up reports any problem.
    return null;
  }
}

export interface DatasetRoute {
  route: "dataset";
  workspaceId: string;
  datasetId?: string;
  transferId?: string;
  named?: boolean;
  action:
    | "press"
    | "list"
    | "activate"
    | "describe"
    | "artifacts"
    | "approval"
    | "confirm-approval"
    | "invoke"
    | "prepare-migration"
    | "approve-migration"
    | "discard-migration"
    | "migration-preview-page"
    | "permissions"
    | "grant"
    | "binding"
    | "local-app"
    | "upload"
    | "file"
    | "history"
    | "history-revision"
    | "import"
    | "export"
    | "lifecycle"
    | "archive"
    | "restore"
    | "pending-attempts"
    | "reconcile-attempt"
    | "cancel-attempt"
    | "delete-preview"
    | "delete"
    | "deletion-status";
}
const headers = {
  "cache-control": "private, no-store",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function datasetId(value: string | undefined): string {
  if (!value || !uuid.test(value)) throw notFound();
  return value;
}
function record(
  raw: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    required.some((key) => !Object.hasOwn(raw, key)) ||
    Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw badRequest("Invalid dataset request.");
  return raw as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.includes("\0") ||
    Buffer.byteLength(value) > max
  )
    throw badRequest("Invalid dataset value.");
  return value;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw badRequest("Invalid dataset revision.");
  return Number(value);
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw badRequest("Invalid dataset digest.");
  return value;
}
function cursor(value: unknown, scope: { workspaceId: string; datasetId: string }): DatasetCursor {
  const row = record(value, [
    "workspaceId",
    "datasetId",
    "hostEpoch",
    "approvedRevisionHash",
    "revision",
    "digest",
  ]);
  if (
    row.workspaceId !== scope.workspaceId ||
    row.datasetId !== scope.datasetId ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0
  )
    throw badRequest("Invalid dataset cursor.");
  return {
    ...scope,
    hostEpoch: text(row.hostEpoch),
    approvedRevisionHash: digest(row.approvedRevisionHash),
    revision: Number(row.revision),
    digest: digest(row.digest),
  };
}
function input(value: unknown) {
  try {
    return parseAppBackendJson(value, 64 * 1024);
  } catch {
    throw badRequest("Invalid operation input.");
  }
}
async function json(
  request: Request,
  signal: AbortSignal,
  maximum: number,
): Promise<{ raw: unknown; requestBytes: number }> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw badRequest("Dataset requests require JSON.");
  try {
    const bytes = await readBoundedBytes(request, maximum, signal);
    return {
      raw: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      requestBytes: bytes.byteLength,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RangeError) throw relayError("payload_too_large", error.message);
    throw badRequest("Invalid dataset JSON.");
  }
}
export async function response(run: () => unknown): Promise<Response> {
  try {
    const value = await run();
    return value instanceof Response ? value : Response.json(value, { headers });
  } catch (error) {
    if (
      error instanceof AppBackendLimitError ||
      (error instanceof Error && error.name === "AppBackendLimitError")
    )
      throw relayError("payload_too_large", error.message);
    if (isAppBackendRuntimeError(error))
      return Response.json(
        { code: error.refusal.code, message: error.refusal.message },
        { status: 409, headers },
      );
    if (isDatasetReopenWaitError(error) || isDatasetWorkerFailure(error))
      return Response.json(
        { code: error.code, message: error.message },
        {
          status: 503,
          headers: {
            ...headers,
            ...(error.retryAfterMs
              ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) }
              : {}),
          },
        },
      );
    if (error instanceof JournalError)
      throw relayError(error.code === "invalid" ? "bad_request" : "conflict");
    if (
      error instanceof DatasetBindingPendingAttemptError ||
      error instanceof DatasetNotArchivedError
    )
      throw relayError("conflict", error.message);
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
}

function invocationResponse({
  profile,
  ...result
}: Awaited<ReturnType<RelayDatasetHost["invoke"]>> & {
  catchUp?: ReturnType<typeof journalAfter>;
}): Response {
  return Response.json(result, {
    headers: profile === "bulk" ? { ...headers, [APP_BACKEND_PROFILE_HEADER]: profile } : headers,
  });
}

export function createDatasetRoutes(
  host: RelayDatasetHost,
  storage: SyncRelayStorage,
  options: {
    limits?: Partial<AppBackendAdmissionLimits>;
    nowMs: () => number;
    pressDataset?: (
      auth: Extract<AppBackendAuth, { kind: "named" }>,
      input: DatasetServerPress,
      signal: AbortSignal,
    ) => ReturnType<CollectionAutomations["pressDataset"]>;
  },
) {
  const admit = createAppBackendAdmission(options.limits);
  return async (
    request: Request,
    route: DatasetRoute,
    auth: Extract<AppBackendAuth, { kind: "named" }>,
    fromDesktop: () => Promise<boolean> = async () => false,
  ): Promise<Response> => {
    const localApp = async (raw: object) => {
      const candidate = record(raw, ["localApp"]).localApp;
      if (Object.hasOwn(Object(candidate), "external") && !(await fromDesktop()))
        throw relayError(
          "conflict",
          "Approve an app that calls outside services from the dohc desktop app.",
        );
      return candidate;
    };
    if (route.action === "import") {
      if (!route.transferId || !["GET", "POST"].includes(request.method))
        throw relayError("method_not_allowed");
      if (!storage.workspaceIsOwnedBy(route.workspaceId, auth.userId)) throw notFound();
      if (new URL(request.url).search) throw badRequest("Dataset imports do not accept a query.");
      const scope = {
        workspaceId: route.workspaceId,
        datasetId: route.datasetId!,
        transferId: route.transferId,
      };
      if (request.method === "GET") return response(() => host.recoveryImportStatus(auth, scope));
      if (request.headers.get("content-type") !== "application/octet-stream" || !request.body)
        throw badRequest("Dataset import requires a recovery stream.");
      const rawCursor = request.headers.get("x-dohc-dataset-source-cursor");
      if (!rawCursor || Buffer.byteLength(rawCursor) > 1024)
        throw badRequest("Invalid recovery source cursor.");
      let value;
      try {
        value = JSON.parse(rawCursor);
      } catch {
        throw badRequest("Invalid recovery source cursor.");
      }
      const cursor = record(value, [
        "workspaceId",
        "datasetId",
        "hostEpoch",
        "approvedRevisionHash",
        "revision",
        "digest",
      ]);
      if (
        cursor.workspaceId !== scope.workspaceId ||
        cursor.datasetId !== scope.datasetId ||
        !Number.isSafeInteger(cursor.revision) ||
        Number(cursor.revision) < 0
      )
        throw badRequest("Invalid recovery source cursor.");
      const sourceCursor = {
        workspaceId: scope.workspaceId,
        datasetId: scope.datasetId,
        hostEpoch: text(cursor.hostEpoch),
        approvedRevisionHash: digest(cursor.approvedRevisionHash),
        revision: Number(cursor.revision),
        digest: digest(cursor.digest),
      };
      const manifestSha256 = digest(request.headers.get("x-dohc-dataset-manifest-sha256"));
      const release = admit(
        {
          dataset: JSON.stringify([scope.workspaceId, scope.datasetId]),
          participant: auth.userId,
          organizer: true,
        },
        "restore",
        options.nowMs(),
      );
      const deadline = new AbortController();
      const signal = AbortSignal.any([request.signal, storage.unavailable, deadline.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const renewDeadline = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => deadline.abort(new DOMException("Recovery import timed out", "TimeoutError")),
          120_000,
        );
        timer.unref();
      };
      renewDeadline();
      try {
        const body = request.body;
        async function* stream() {
          const reader = body.getReader();
          const aborted = () => {
            void reader.cancel().catch(() => {});
          };
          signal.addEventListener("abort", aborted, { once: true });
          try {
            for (;;) {
              signal.throwIfAborted();
              if (!storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId)) throw notFound();
              const item = await reader.read();
              signal.throwIfAborted();
              // Bound idle receipt, then give installation its own deadline.
              if (item.done) {
                renewDeadline();
                break;
              }
              if (item.value.byteLength) renewDeadline();
              for (let offset = 0; offset < item.value.byteLength; offset += 1024 * 1024)
                yield item.value.subarray(offset, offset + 1024 * 1024);
            }
          } finally {
            signal.removeEventListener("abort", aborted);
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        return await response(() =>
          host.importRecovery(auth, {
            ...scope,
            manifestSha256,
            sourceCursor,
            stream: stream(),
            activate: true,
            signal,
          }),
        );
      } finally {
        clearTimeout(timer);
        release();
      }
    }
    const read = [
      "list",
      "describe",
      "artifacts",
      "approval",
      "permissions",
      "history",
      "history-revision",
      "lifecycle",
      "pending-attempts",
      "delete-preview",
      "deletion-status",
    ].includes(route.action);
    if (request.method !== (read ? "GET" : "POST")) throw relayError("method_not_allowed");
    const query = new URL(request.url).searchParams;
    const allowedQuery =
      route.action === "history"
        ? ["beforeRevision", "limit", "metadataOnly"]
        : route.action === "history-revision"
          ? ["revisionSha256"]
          : route.action === "list"
            ? ["after", "limit", "includeArchived"]
            : route.action === "describe"
              ? ["includeArchived"]
              : route.action === "permissions" ||
                  route.action === "lifecycle" ||
                  route.action === "pending-attempts" ||
                  route.action === "delete-preview"
                ? ["after", "limit"]
                : [];
    if (
      [...query.keys()].some((key) => !allowedQuery.includes(key)) ||
      allowedQuery.some((key) => query.getAll(key).length > 1) ||
      (query.has("metadataOnly") && !["true", "false"].includes(query.get("metadataOnly")!)) ||
      (query.has("includeArchived") && !["true", "false"].includes(query.get("includeArchived")!))
    )
      throw badRequest("Invalid dataset query.");
    const signal = AbortSignal.any([
      request.signal,
      storage.unavailable,
      AbortSignal.timeout(30_000),
    ]);
    const scope = { workspaceId: route.workspaceId, datasetId: route.datasetId! };
    // Read before admission, so a slow sender holds no slot.
    const owner = !auth.grantId && storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId);
    const { raw, requestBytes } = read
      ? { raw: undefined, requestBytes: undefined }
      : await json(request, signal, datasetRequestBytes(route.action, owner));
    const release = admit(
      {
        dataset: JSON.stringify([route.workspaceId, route.datasetId ?? "catalog"]),
        participant: auth.userId,
        organizer:
          storage.workspaceIsOwnedBy(route.workspaceId, auth.userId) ||
          storage.workspaceRoleOf(route.workspaceId, auth.userId)?.role === "admin",
      },
      route.action,
      options.nowMs(),
    );
    try {
      return await response(async () => {
        signal.throwIfAborted();
        const page = {
          after: query.has("after") ? text(query.get("after")) : undefined,
          limit: query.has("limit") ? positive(Number(query.get("limit"))) : undefined,
        };
        if (route.action === "pending-attempts") {
          if (
            page.after !== undefined &&
            (!/^(0|[1-9][0-9]*)$/.test(page.after) || !Number.isSafeInteger(Number(page.after)))
          )
            throw badRequest("Invalid pending attempt cursor.");
          if (page.limit !== undefined && page.limit > 100)
            throw badRequest("Invalid pending attempt page size.");
          return host.pendingAttempts(auth, {
            ...scope,
            after: page.after === undefined ? undefined : Number(page.after),
            limit: page.limit,
          });
        }
        const includeArchived = query.get("includeArchived") === "true";
        if (route.action === "list")
          return host.list(auth, { workspaceId: route.workspaceId, ...page, includeArchived });
        if (route.action === "describe") return host.describe(auth, { ...scope, includeArchived });
        if (route.action === "deletion-status") {
          if (!storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId)) throw notFound();
          return host.deletionStatus(auth, scope);
        }
        if (route.action === "delete-preview") {
          if (!storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId)) throw notFound();
          if (page.limit !== undefined && page.limit > 100)
            throw badRequest("Invalid deletion preview page size.");
          return host.deletePreview(auth, { ...scope, ...page });
        }
        if (route.action === "lifecycle") return host.lifecycle(auth, { ...scope, ...page });
        if (route.action === "artifacts") return host.approvedArtifacts(auth, scope);
        if (route.action === "approval") return host.approval(auth, scope);
        if (route.action === "confirm-approval") {
          const body = record(raw, ["revisionSha256"]);
          return host.confirmApproval(auth, {
            ...scope,
            revisionSha256: digest(body.revisionSha256),
          });
        }
        if (route.action === "permissions") return host.permissions(auth, { ...scope, ...page });
        if (route.action === "history-revision")
          return host.historyRevision(auth, {
            ...scope,
            revisionSha256: digest(query.get("revisionSha256")),
          });
        if (route.action === "history")
          return host.history(auth, {
            ...scope,
            metadataOnly: query.get("metadataOnly") === "true",
            limit: page.limit,
            beforeRevision: query.has("beforeRevision")
              ? positive(Number(query.get("beforeRevision")))
              : undefined,
          });
        if (
          route.action === "approve-migration" ||
          route.action === "discard-migration" ||
          route.action === "migration-preview-page"
        ) {
          const body = record(
            raw,
            ["candidateId", ...(route.action === "approve-migration" ? ["checkpointSha256"] : [])],
            route.action === "migration-preview-page"
              ? ["after", "limit"]
              : route.action === "approve-migration"
                ? ["approvalAgent", "changeSha256"]
                : [],
          );
          const candidate = { ...scope, candidateId: datasetId(text(body.candidateId)), signal };
          if (route.action === "approve-migration")
            return host.approveMigration(auth, {
              ...candidate,
              checkpointSha256: digest(body.checkpointSha256),
              ...(body.changeSha256 === undefined
                ? {}
                : { changeSha256: digest(body.changeSha256) }),
              ...(body.approvalAgent === undefined
                ? {}
                : { approvalAgent: approvalAgent(body.approvalAgent) }),
            });
          if (route.action === "discard-migration") {
            await host.discardMigration(auth, candidate);
            return { discarded: true };
          }
          return host.migrationPreviewPage(auth, {
            ...candidate,
            after: body.after === undefined ? undefined : text(body.after, 1024),
            limit: body.limit === undefined ? undefined : positive(body.limit),
          });
        }
        if (route.action === "reconcile-attempt" || route.action === "cancel-attempt") {
          const body = record(raw, ["reference", "acknowledge"]);
          if (body.acknowledge !== true)
            throw badRequest("Attempt reconciliation requires acknowledgment.");
          const input = { ...scope, reference: digest(body.reference), acknowledge: true as const };
          return route.action === "cancel-attempt"
            ? host.cancelAttempt(auth, input)
            : host.reconcileAttempt(auth, input);
        }
        if (route.action === "delete") {
          if (!storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId)) throw notFound();
          const body = record(raw, ["expected", "reviewToken", "acknowledge"]);
          if (body.acknowledge !== true)
            throw badRequest("Permanent deletion requires acknowledgment.");
          const expected = record(body.expected, [
            "workspaceId",
            "datasetId",
            "hostEpoch",
            "approvedRevisionHash",
            "revision",
            "digest",
          ]);
          if (
            expected.workspaceId !== scope.workspaceId ||
            expected.datasetId !== scope.datasetId ||
            !Number.isSafeInteger(expected.revision) ||
            Number(expected.revision) < 0
          )
            throw badRequest("Invalid dataset cursor.");
          return host.deleteDataset(auth, {
            ...scope,
            acknowledge: true,
            reviewToken: digest(body.reviewToken),
            expected: {
              ...scope,
              hostEpoch: text(expected.hostEpoch),
              approvedRevisionHash: digest(expected.approvedRevisionHash),
              revision: Number(expected.revision),
              digest: digest(expected.digest),
            },
          });
        }
        if (route.action === "archive" || route.action === "restore") {
          record(raw, []);
          return route.action === "archive"
            ? host.archiveDataset(auth, scope)
            : host.restoreDataset(auth, scope);
        }
        if (route.action === "upload") {
          const body = record(raw, [
            "revision",
            "revisionSha256",
            "idempotencyKey",
            "name",
            "contentType",
            "bytesBase64",
            ...(route.named ? ["fieldId"] : []),
          ]);
          let parsed;
          try {
            parsed = parseAppBackendUploadRequest({
              authorityRevision: positive(body.revision),
              idempotencyKey: body.idempotencyKey,
              name: body.name,
              contentType: body.contentType,
              bytesBase64: body.bytesBase64,
            });
          } catch {
            throw badRequest("Invalid dataset upload.");
          }
          const { authorityRevision: revision, ...file } = parsed;
          return route.named
            ? host.dataUpload(
                auth,
                {
                  ...scope,
                  ...file,
                  revision,
                  revisionSha256: digest(body.revisionSha256),
                  fieldId: datasetId(text(body.fieldId)),
                },
                signal,
              )
            : host.ownerUpload(
                auth,
                { ...scope, ...file, revision, revisionSha256: digest(body.revisionSha256) },
                signal,
              );
        }
        if (route.action === "file") {
          const body = record(raw, [
            "revision",
            "revisionSha256",
            "fileId",
            ...(route.named ? ["read"] : []),
          ]);
          if (route.named) {
            const read = record(body.read, ["operationId", "fieldId", "input"]);
            return host.dataReadFile(
              auth,
              {
                ...scope,
                revision: positive(body.revision),
                revisionSha256: digest(body.revisionSha256),
                fileId: text(body.fileId, 128),
                operationId: datasetId(text(read.operationId)),
                fieldId: datasetId(text(read.fieldId)),
                input: input(read.input),
              },
              signal,
            );
          }
          return host.ownerReadFile(
            auth,
            {
              ...scope,
              revision: positive(body.revision),
              revisionSha256: digest(body.revisionSha256),
              fileId: text(body.fileId, 128),
            },
            signal,
          );
        }
        if (route.action === "activate" || route.action === "prepare-migration") {
          const body = record(
            raw,
            [
              "revision",
              "schemaSql",
              "operationSource",
              ...(route.action === "prepare-migration" ? ["expected", "migrationSql"] : []),
            ],
            ["capacityBytes", ...(route.action === "activate" ? ["approvalAgent"] : [])],
          );
          let revision;
          try {
            revision = parseDatasetRevision(body.revision);
          } catch {
            throw badRequest("Invalid dataset revision.");
          }
          if (revision.datasetId !== scope.datasetId)
            throw badRequest("Dataset identity does not match this route.");
          const input = {
            ...scope,
            revision,
            schemaSql: text(body.schemaSql, 256 * 1024),
            operationSource: text(body.operationSource, 256 * 1024),
            signal,
          };
          if (route.action === "activate")
            return host.activate(auth, {
              ...input,
              ...(body.approvalAgent === undefined
                ? {}
                : { approvalAgent: approvalAgent(body.approvalAgent) }),
              ...(body.capacityBytes === undefined
                ? {}
                : { capacityBytes: positive(body.capacityBytes) }),
            });
          if (body.capacityBytes !== undefined)
            throw badRequest("Dataset migrations cannot change capacity through this route.");
          const expected = record(body.expected, [
            "workspaceId",
            "datasetId",
            "hostEpoch",
            "approvedRevisionHash",
            "revision",
            "digest",
          ]);
          if (
            expected.workspaceId !== scope.workspaceId ||
            expected.datasetId !== scope.datasetId ||
            !Number.isSafeInteger(expected.revision) ||
            Number(expected.revision) < 0
          )
            throw badRequest("Invalid dataset cursor.");
          return host.prepareMigration(auth, {
            ...input,
            migrationSql: text(body.migrationSql, 256 * 1024),
            expected: {
              ...scope,
              hostEpoch: text(expected.hostEpoch),
              approvedRevisionHash: digest(expected.approvedRevisionHash),
              revision: Number(expected.revision),
              digest: digest(expected.digest),
            },
          });
        }
        if (route.action === "press") {
          if (!options.pressDataset) throw notFound();
          const body = record(
            raw,
            ["table", "field", "recordId", "pressId", "confirmed"],
            ["agent"],
          );
          if (!Array.isArray(body.confirmed) || body.confirmed.length > 128)
            throw badRequest("Invalid dataset request.");
          return options.pressDataset(
            auth,
            {
              datasetId: scope.datasetId,
              table: text(body.table),
              field: text(body.field),
              recordId: text(body.recordId, 1024),
              pressId: text(body.pressId, 256),
              by: pressingActor(body.agent),
              confirmed: body.confirmed.map((value) => text(value)),
            },
            signal,
          );
        }
        if (route.action === "invoke") {
          const body = record(
            raw,
            ["revision", "revisionSha256", "operationId", "input", "idempotencyKey"],
            ["agent"],
          );
          const agent = owningAgent(body.agent);
          if (
            agent &&
            (auth.grantId || !storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId))
          )
            throw notFound();
          const named = request.headers.get(APP_BACKEND_CATCH_UP_HEADER);
          let after: DatasetCursor | undefined;
          if (named !== null) {
            if (Buffer.byteLength(named) > 1024) throw badRequest("Invalid dataset cursor.");
            let value: unknown;
            try {
              value = JSON.parse(named);
            } catch {
              throw badRequest("Invalid dataset cursor.");
            }
            after = cursor(value, scope);
          }
          const result = await host.invoke(agent ? { ...auth, agent } : auth, {
            ...scope,
            revision: positive(body.revision),
            revisionSha256: digest(body.revisionSha256),
            operationId: datasetId(text(body.operationId)),
            input: body.input,
            requestBytes,
            idempotencyKey: text(body.idempotencyKey, 128),
            signal,
          });
          // The owner's kept copy names where it is, and gets the journal after it, so it
          // needs no other request. Only the owner reads the journal, as on the copy's routes.
          if (
            after === undefined ||
            !storage.workspaceIsOwnedBy(scope.workspaceId, auth.userId) ||
            auth.grantId
          )
            return invocationResponse(result);
          const catchUp = journalAfter(host, auth, scope, after);
          return invocationResponse(catchUp ? { ...result, catchUp } : result);
        }
        if (route.action === "local-app") {
          if (auth.grantId) throw notFound();
          if (raw && typeof raw === "object" && Object.hasOwn(raw, "localApp")) {
            return host.approveLocalAppWorkspace(auth, {
              workspaceId: route.workspaceId,
              candidate: await localApp(raw),
            });
          }
          const body = record(raw, ["publicationId", "enabled"]);
          if (body.enabled !== false) throw badRequest("Invalid app binding.");
          host.withdrawLocalAppWorkspace(auth, {
            workspaceId: route.workspaceId,
            publicationId: digest(body.publicationId),
          });
          return { ok: true };
        }
        if (route.action === "binding") {
          // An app the owner approved on their own computer, which runs here as itself.
          if (raw && typeof raw === "object" && Object.hasOwn(raw, "localApp"))
            return host.approveLocalApp(auth, {
              ...scope,
              candidate: await localApp(raw),
            });
          const body = record(raw, ["publicationId", "enabled"]);
          if (typeof body.enabled !== "boolean") throw badRequest("Invalid app binding.");
          const input = { ...scope, publicationId: digest(body.publicationId) };
          if (body.enabled) host.bindPublication(auth, input);
          else host.unbindPublication(auth, input);
          return { ok: true };
        }
        if (raw && typeof raw === "object" && Object.hasOwn(raw, "defaults")) {
          const value = record(record(raw, ["defaults"]).defaults, [
            "view",
            "comment",
            "edit",
            "revision",
            "revisionSha256",
          ]);
          const operations = (list: unknown) => {
            if (!Array.isArray(list) || list.length > 128)
              throw badRequest("Invalid Collection defaults.");
            return [...new Set(list.map((value) => datasetId(text(value))))];
          };
          return host.setWorkspaceDefaults(auth, {
            ...scope,
            defaults: {
              view: operations(value.view),
              comment: operations(value.comment),
              edit: operations(value.edit),
              revision: positive(value.revision),
              revisionSha256: digest(value.revisionSha256),
            },
          });
        }
        const body = record(raw, ["grant"], ["grantId", "principalKey"]);
        if (Object.hasOwn(body, "principalKey")) {
          if (body.grant !== null || Object.hasOwn(body, "grantId"))
            throw badRequest("Invalid dataset grant removal.");
          host.removeDataGrant(auth, { ...scope, principalKey: text(body.principalKey) });
          return { ok: true };
        }
        let grant = null;
        if (body.grant !== null) {
          const value = record(body.grant, [
            "operationIds",
            "discover",
            "revision",
            "revisionSha256",
          ]);
          if (
            !Array.isArray(value.operationIds) ||
            value.operationIds.length > 128 ||
            typeof value.discover !== "boolean"
          )
            throw badRequest("Invalid dataset grant.");
          grant = {
            operationIds: value.operationIds.map((value) => datasetId(text(value))),
            discover: value.discover,
            revision: positive(value.revision),
            revisionSha256: digest(value.revisionSha256),
          };
        }
        host.setDataGrant(auth, { ...scope, grantId: text(body.grantId), grant });
        return { ok: true };
      });
    } finally {
      release();
    }
  };
}

// Who pressed for the verified person: the person, or their agent at its
// run's chain depth. The agent is provenance only; access is the person's.
// A press at the chain's limit would start nothing, so it is refused here.
function pressingActor(value: unknown): DatasetServerPress["by"] {
  if (value === undefined) return { kind: "human" };
  const agent = record(value, ["originId", "depth"]);
  if (!Number.isSafeInteger(agent.depth) || Number(agent.depth) < 0)
    throw badRequest("Invalid dataset request.");
  if (Number(agent.depth) >= DATASET_AUTOMATION_CHAIN_DEPTH) throw badRequest(CHAIN_STOPPED_PRESS);
  return { kind: "agent", originId: text(agent.originId), depth: Number(agent.depth) };
}

// The owner's agent that makes a change through the owner's session, at its
// run's chain depth. Provenance only: access is the owner's.
function owningAgent(value: unknown): { depth: number; agentId?: string } | undefined {
  if (value === undefined) return undefined;
  const agent = record(value, ["depth"], ["agentId"]);
  if (!Number.isSafeInteger(agent.depth) || Number(agent.depth) < 0)
    throw badRequest("Invalid dataset request.");
  return agent.agentId === undefined
    ? { depth: Number(agent.depth) }
    : { depth: Number(agent.depth), agentId: text(agent.agentId) };
}

function parseEventsSince(value: string | null): Map<string, number> | null {
  if (value === null) return null;
  const since = new Map<string, number>();
  const pairs = value === "" ? [] : value.split(",");
  if (pairs.length > APP_DATASET_MAX_BINDINGS) return null;
  for (const pair of pairs) {
    const match = /^((?:[a-z][a-z0-9_-]{0,63})?):(0|[1-9][0-9]{0,15})$/.exec(pair);
    const revision = Number(match?.[2]);
    if (!match || since.has(match[1]!) || !Number.isSafeInteger(revision)) return null;
    since.set(match[1]!, revision);
  }
  return since;
}

function approvalAgent(value: unknown) {
  try {
    return parseApprovalAgent(value);
  } catch {
    throw badRequest("Invalid approval agent.");
  }
}

export function createDatasetAppRoutes(
  host: RelayDatasetHost,
  storage: SyncRelayStorage,
  options: {
    limits?: Partial<AppBackendAdmissionLimits>;
    nowMs: () => number;
    shareSenderLabel?: (userId: string) => Promise<string>;
    /** Without app publishing, only an app the owner approved on their own computer runs here. */
    publications: boolean;
    events?: AppEventWaits;
    external?: ReturnType<typeof createAppExternalCalls>;
  },
) {
  const admit = createAppBackendAdmission(options.limits);
  const serve = async (
    request: Request,
    route: AppBackendRoute,
    auth: AppBackendAuth,
    /** A phone launch: only a publication runs, never an app approved on a computer. */
    publishedOnly = false,
    /** Checks the caller's sign-in again. Throws once it has ended. */
    signedIn?: () => Promise<void>,
  ): Promise<Response> => {
    if (route.action === "events") {
      if (!options.events || !options.publications) throw notFound();
      if (request.method !== "GET") throw relayError("method_not_allowed");
      const query = new URL(request.url).searchParams;
      const authorityRevision = Number(query.get("authorityRevision"));
      const since = parseEventsSince(query.get("since"));
      const hold = parseLinkLogHold(query.get("hold"));
      if (query.size !== 3 || !Number.isSafeInteger(authorityRevision) || !since) throw notFound();
      const signal = AbortSignal.any([request.signal, storage.unavailable]);
      const deadlineAtMs = Date.now() + hold;
      for (;;) {
        if (auth.kind === "named") await (auth.launch ? auth.launch.recheck() : signedIn?.());
        const current = host.appEventRevisions(auth, route.publicationId, authorityRevision);
        const changed = current.collections
          .filter(({ dataset, revision }) => revision !== (since.get(dataset) ?? 0))
          .map(({ dataset, revision }) => ({ dataset, revision }));
        const holdMs = deadlineAtMs - Date.now();
        if (changed.length || holdMs <= 0 || signal.aborted)
          return Response.json({ changed }, { headers });
        await options.events.wait({
          workspaceId: current.workspaceId,
          actor: current.actor,
          since: current.collections,
          holdMs,
          signal,
        });
      }
    }
    if (route.action === "external") {
      if (!options.external) throw notFound();
      if (request.method !== "POST") throw relayError("method_not_allowed");
      if (new URL(request.url).search) throw badRequest("App operations do not accept a query.");
      const served = {
        publicationId: route.publicationId,
        ...host.externalPublication(auth, route.publicationId),
      };
      if (!options.publications && !served.local) throw notFound();
      const signal = AbortSignal.any([
        request.signal,
        storage.unavailable,
        AbortSignal.timeout(30_000),
      ]);
      const { raw } = await json(request, signal, APP_BACKEND_REQUEST_BYTES);
      const stillServed = async () => {
        if (auth.kind === "named") await auth.launch?.recheck();
        if (
          host.externalPublication(auth, route.publicationId).authorityRevision !==
          served.authorityRevision
        )
          throw notFound();
      };
      await stillServed();
      const call = options.external;
      return response(() => call(served, raw, stillServed, signal));
    }
    const reviewing =
      route.action === "summary" || route.action === "consent" || route.action === "blob";
    const published = host.servedPublication(auth, route.publicationId, reviewing);
    const get =
      route.action === "descriptor" || route.action === "summary" || route.action === "blob";
    if (
      !published ||
      (!options.publications && !published.local) ||
      (publishedOnly && published.local) ||
      // An app with no dataset serves only its files.
      (!published.capabilities.length && !get && route.action !== "consent")
    )
      throw notFound();
    const { authority, workspaceId, authorityRevision, capabilities } = published;
    const owner = authority.caller.kind === "owner";
    const signal = AbortSignal.any([
      request.signal,
      storage.unavailable,
      AbortSignal.timeout(30_000),
    ]);
    // Read before admission, so a slow sender holds no slot.
    const { raw, requestBytes } =
      get || request.method !== "POST"
        ? { raw: undefined, requestBytes: undefined }
        : await json(
            request,
            signal,
            route.action === "upload"
              ? APP_BACKEND_UPLOAD_REQUEST_BYTES
              : route.action === "invoke" && owner
                ? APP_BACKEND_BULK_LIMITS.requestBytes
                : APP_BACKEND_REQUEST_BYTES,
          );
    // A phone launch's reach may have ended while its body arrived.
    if (raw !== undefined && auth.kind === "named") await auth.launch?.recheck();
    let targetCapability = published.capability;
    let targetDatasetAlias: string | undefined;
    if (
      !get &&
      route.action !== "activate" &&
      route.action !== "consent" &&
      capabilities.length > 0
    ) {
      if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "dataset")) {
        const value = (raw as Record<string, unknown>).dataset;
        if (
          typeof value !== "string" ||
          !/^[a-z][a-z0-9_-]{0,63}$/.test(value) ||
          value === "prototype" ||
          value === "constructor"
        ) {
          throw auth.kind === "link" ? notFound() : badRequest("Invalid app dataset alias.");
        }
        targetDatasetAlias = value;
      }
      if (capabilities.length === 1) {
        const only = capabilities[0]!;
        if (targetDatasetAlias !== undefined && only.alias !== targetDatasetAlias) throw notFound();
        targetCapability = only;
      } else {
        if (targetDatasetAlias === undefined) {
          throw badRequest("Choose which Collection this app action targets.");
        }
        const matched = capabilities.find((cap) => cap.alias === targetDatasetAlias);
        if (!matched) throw notFound();
        targetCapability = matched;
      }
    }
    const admissionDatasetId = targetCapability?.datasetId ?? published.datasetId;
    let release: () => void;
    try {
      release = admit(
        {
          dataset: JSON.stringify(
            admissionDatasetId === null
              ? [workspaceId, null, route.publicationId]
              : [workspaceId, admissionDatasetId],
          ),
          participant: authority.principalKey,
          ...(authority.caller.kind === "link"
            ? { link: JSON.stringify([workspaceId, authority.caller.grantId]) }
            : {}),
          organizer: authority.caller.kind === "owner",
        },
        route.action === "file" ? "app-file" : route.action,
        options.nowMs(),
      );
    } catch (error) {
      // The publication is known here, but its requested operation or file is not yet authorized.
      if (auth.kind === "link") throw notFound();
      throw error;
    }
    try {
      if (request.method !== (get ? "GET" : "POST")) throw relayError("method_not_allowed");
      const query = new URL(request.url).searchParams;
      if (route.action === "blob") {
        if (
          auth.kind !== "named" ||
          query.size !== 1 ||
          query.get("authorityRevision") !== String(authorityRevision)
        )
          throw notFound();
        const { member } = published;
        const file =
          (!member || member.consent === "current"
            ? published.candidate.files.find((file) => file.sha256 === route.sha256)
            : undefined) ??
          (member
            ? published.candidate.inputs
                .map((input) => ({ ...input, contentType: "application/octet-stream" }))
                .find((input) => input.sha256 === route.sha256)
            : undefined);
        if (!file) throw notFound();
        const bytes = storage.getBlob(workspaceId, file.sha256);
        if (!bytes || bytes.byteLength !== file.byteLength) throw notFound();
        signal.throwIfAborted();
        return new Response(Uint8Array.from(bytes), {
          headers: { ...headers, "content-type": file.contentType },
        });
      }
      if (query.size) throw badRequest("App operations do not accept a query.");
      return await response(async () => {
        signal.throwIfAborted();
        if (route.action === "summary" && published.member) {
          const authorName =
            (await options
              .shareSenderLabel?.(published.member.publisherUserId)
              .catch(() => null)) ?? null;
          signal.throwIfAborted();
          const member = host.servedPublication(auth, route.publicationId, true)?.member;
          if (!member) throw notFound();
          return {
            subjectName: member.slug,
            sharerName: authorName,
            access: "member",
            review: {
              authorityRevision,
              consent: member.consent,
              scopeDigest: member.digest,
              collections: member.scope.map(({ datasetId, operationIds, access }) => {
                const declared = capabilities.find((value) => value.datasetId === datasetId)!;
                return {
                  name: declared.name,
                  access,
                  operations: declared.operations
                    .filter((operation) => operationIds.includes(operation.operationId))
                    .map(({ name, readOnly }) => ({ name, readOnly })),
                };
              }),
              source: published.candidate.inputs,
            },
          };
        }
        if (route.action === "consent") {
          if (!published.member || auth.kind !== "named") throw notFound();
          if (!auth.person) throw new MemberAppRefusal("browser");
          const body = record(raw, ["scopeDigest"]);
          if (typeof body.scopeDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.scopeDigest))
            throw badRequest("Invalid Member app review.");
          return host.consentMemberApp(auth, route.publicationId, body.scopeDigest);
        }
        if (route.action === "summary") {
          if (auth.kind !== "named") throw notFound();
          if (authority.caller.kind === "owner")
            return { subjectName: published.candidate.appRoot, sharerName: null, access: "owner" };
          if (authority.caller.kind !== "named") throw notFound();
          const grant = storage.getShareGrant(authority.caller.grantId);
          if (!grant) throw notFound();
          const share = storage.getShare(grant.shareId);
          if (!share) throw notFound();
          const sharerName =
            (await options.shareSenderLabel?.(share.granterUserId).catch(() => null)) ?? null;
          signal.throwIfAborted();
          const current = host.servedPublication(auth, route.publicationId);
          if (!current || current.authority.caller.kind !== "named") throw notFound();
          return {
            ...storage.getShareLabels(grant.shareId, "member"),
            sharerName,
            access: current.authority.caller.access,
          };
        }
        if (route.action === "descriptor") {
          if (auth.kind !== "named") throw notFound();
          return {
            publicationId: route.publicationId,
            authorityRevision,
            files: published.candidate.files,
          };
        }
        if (route.action === "activate") {
          if (published.local || published.member) throw notFound();
          const body = record(raw, ["authorityRevision"]);
          if (body.authorityRevision !== authorityRevision) throw notFound();
          const datasetIds = host.bindPublication(auth, {
            workspaceId,
            publicationId: route.publicationId,
          });
          return { publicationId: route.publicationId, authorityRevision, datasetIds };
        }
        if (!targetCapability) throw notFound();
        const targetDatasetId = targetCapability.datasetId;
        if (route.action === "attempt") {
          const body = record(
            raw,
            ["authorityRevision", "operation", "action"],
            ["idempotencyKey", "input", "token", "dataset"],
          );
          const { authorityRevision: expected, operation, dataset: _dataset, ...attempt } = body;
          let parsed;
          try {
            parsed = parseDatasetAttemptRequest(attempt);
          } catch {
            throw badRequest("Invalid pending submission request.");
          }
          return host.attempt(
            auth,
            route.publicationId,
            {
              authorityRevision: positive(expected),
              operation: text(operation),
              ...(targetDatasetAlias === undefined ? {} : { dataset: targetDatasetAlias }),
              request: parsed,
            },
            signal,
          );
        }
        if (route.action === "upload") {
          let body;
          try {
            body = parseAppBackendUploadRequest(raw);
          } catch {
            throw badRequest("Invalid app upload.");
          }
          return host.upload(auth, route.publicationId, body, signal);
        }
        if (route.action === "file") {
          const body = record(
            raw,
            ["authorityRevision", "fileId", "operation", "input"],
            ["dataset"],
          );
          return host.readFile(
            auth,
            route.publicationId,
            {
              authorityRevision: positive(body.authorityRevision),
              fileId: text(body.fileId, 128),
              operation: text(body.operation),
              input: input(body.input),
              ...(targetDatasetAlias === undefined ? {} : { dataset: targetDatasetAlias }),
            },
            signal,
          );
        }
        if (route.action !== "invoke") throw notFound();
        // The owner's computer names the agent that drives an app the owner approved there.
        let agent: ReturnType<typeof owningAgent>,
          readOnly = false,
          request: unknown = raw;
        if (published.local && raw && typeof raw === "object" && Object.hasOwn(raw, "agent")) {
          const { agent: named, ...rest } = raw as Record<string, unknown>;
          agent = owningAgent(named);
          request = rest;
        }
        if (request && typeof request === "object" && Object.hasOwn(request, "readOnly")) {
          const { readOnly: flag, ...rest } = request as Record<string, unknown>;
          if (flag !== true) throw badRequest("Invalid app operation.");
          readOnly = true;
          request = rest;
        }
        let body;
        try {
          body = parseAppBackendInvokeRequest(request, owner ? "bulk" : undefined);
        } catch (error) {
          if (error instanceof AppBackendLimitError && auth.kind !== "link") throw error;
          throw badRequest("Invalid app operation.");
        }
        if (body.authorityRevision !== authorityRevision) throw notFound();
        const operation = targetCapability.operations.find(
          (operation) => operation.name === body.operation && (!readOnly || operation.readOnly),
        );
        if (!operation) throw notFound();
        return invocationResponse(
          await host.invoke(agent && auth.kind === "named" ? { ...auth, agent } : auth, {
            workspaceId,
            datasetId: targetDatasetId,
            revision: targetCapability.revision,
            revisionSha256: targetCapability.revisionSha256,
            operationId: operation.operationId,
            input: body.input,
            requestBytes,
            idempotencyKey: body.idempotencyKey,
            access: { kind: "app", appId: route.publicationId },
            signal,
          }),
        );
      });
    } finally {
      release();
    }
  };
  return async (...args: Parameters<typeof serve>) => {
    try {
      return await serve(...args);
    } catch (error) {
      if (!(error instanceof MemberAppRefusal)) throw error;
      return Response.json(
        { code: error.code, message: error.message },
        { status: error.status, headers },
      );
    }
  };
}
