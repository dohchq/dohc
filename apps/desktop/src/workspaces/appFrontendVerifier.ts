import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  AppBackendRuntimeError,
  evaluateAppOperation,
  initializeAppDatabase,
  isAppBackendRuntimeError,
  type AppBackendRuntimeOptions,
  type JsonValue,
} from "@dohc/app-backend-runtime";
import { missingUndo } from "@dohc/app-backend-runtime/dataset-host";
import { orderedRequestIds } from "@dohc/app-backend-runtime/supervisor";
import {
  OwnerAppPublicationRequest,
  OwnerAppPublicationResult,
  type AppFrontendDiagnostic,
} from "@dohc/cli/app-publication";
import { parseAppBackendInvokeRequest } from "@dohc/security-contract/app-backend";
import {
  APP_COLLECTION_MAX_SCHEMA_BYTES,
  compareAppCollectionPaths,
  isAppCollectionPageRequest,
  pageAppCollectionRecords,
  projectAppCollectionRecord,
  validateAppCollectionCreateFields,
  validateAppCollectionSchema,
} from "@dohc/security-contract/app-collection-checks";
import {
  parseAppCollectionCreateRequest,
  type AppCollectionReceipt,
  type AppDatasetCapability,
  type AppPublicationCandidate,
} from "@dohc/security-contract/app-publication";
import type { DatasetRevision } from "@dohc/security-contract/dataset";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type {
  BackendFailureHint,
  runAppFrontendBrowserVerification,
} from "../window/appFrontendVerifyBrowser";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";
import {
  createLocalAppLaunchHost,
  LocalAppUnavailableError,
  type LocalAppAction,
  type LocalAppLaunchBackend,
} from "./localAppLaunch";
import type { LocalAppKind } from "./localAppStore";
import { selectDatasetCapability } from "./localDatasetApps";
import { prepareLocalAppPublication } from "./ownerAppPublication";

type VerifyFrontendRequest = Extract<OwnerAppPublicationRequest, { action: "verifyFrontend" }>;
type VerifyFrontendResult = Extract<OwnerAppPublicationResult, { kind: "frontendVerified" }>;

export interface VerifyLocalAppFrontendDeps {
  workspaceId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  assertCurrent(): void;
  flushCapture(): Promise<{ deferredWrites: readonly string[] }>;
  withAdapter<T>(work: (adapter: VersionedLiveAdapter) => Promise<T>): Promise<T | null>;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  compileDataset(source: string, path: string, signal: AbortSignal): Promise<string>;
  datasetRuntime: AppBackendRuntimeOptions;
  approvedArtifacts(datasetId: string): Promise<{
    revision: DatasetRevision;
    schemaSql: string;
    operationSource: string;
    active: boolean;
  }>;
  verificationPublication(publicationId: string): Promise<{
    publicationId: string;
    authorityRevision: number;
    appRoot: string;
    kind: LocalAppKind;
    resourceId: string;
    candidate: AppPublicationCandidate;
    files: ClosedAppBuild["files"];
  }>;
  runBrowser: typeof runAppFrontendBrowserVerification;
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const base32 = (bytes: Uint8Array) =>
  [...bytes].map((byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("");
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const actionToBrokerOp = (action: LocalAppAction | "file") =>
  action === "list"
    ? "collection.list"
    : action === "create"
      ? "collection.create"
      : action === "query"
        ? "backend.invoke"
        : `backend.${action}`;

export function createDiagnosticScrubber(workspaceRoot: string, origin?: string) {
  const roots = [workspaceRoot, homedir()].filter(Boolean).flatMap((root) => {
    const replacement = root === workspaceRoot ? "<workspace>" : "<home>";
    return [
      root.replace(/\\/g, "/").replace(/\/+$/, ""),
      root.replace(/\//g, "\\").replace(/\\+$/, ""),
    ].map((variant) => ({ re: new RegExp(escapeRegex(variant), "gi"), replacement }));
  });
  const originRe = origin ? new RegExp(escapeRegex(origin), "gi") : null;
  return (raw: string): string => {
    let text = raw
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/https?:\/\/127\.0\.0\.1:\d+[^\s"'<>]*/gi, "<local-app>")
      .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
      .replace(
        /["']?(?:shareToken|token|handoff|x-dohc-app-proof)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
        "<redacted>",
      );
    if (originRe) text = text.replace(originRe, "<local-app>");
    for (const { re, replacement } of roots) text = text.replace(re, replacement);
    text = text
      .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "<path>")
      .replace(/(^|[\s(])\/(?:Users|home|var|tmp|private|etc|opt|mnt)\/[^\s"'<>]+/g, "$1<path>")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  };
}

function classifyCompileDiagnostic(
  error: unknown,
  appRoot: string,
  scrub: (value: string) => string,
): AppFrontendDiagnostic {
  const raw = error instanceof Error ? error.message : String(error);
  const loc =
    /(?:^|\n)([^:\s][^:\n]*):(\d+):(\d+):\s*ERROR:/.exec(raw) ??
    /^([^:\s][^:]*):(\d+):\s*(.+)$/.exec(raw);
  const locFields: Partial<AppFrontendDiagnostic> = {};
  if (loc && !loc[1]!.includes("\\") && isShareablePath(loc[1]!) && !isSharedWithMePath(loc[1]!)) {
    locFields.path = loc[1]!;
    if (Number.isSafeInteger(Number(loc[2])) && Number(loc[2]) > 0) locFields.line = Number(loc[2]);
    if (Number.isSafeInteger(Number(loc[3])) && Number(loc[3]) > 0)
      locFields.column = Number(loc[3]);
  }
  const detail = scrub(raw);
  const detailField = detail ? { detail } : {};
  if (locFields.path && locFields.line) {
    return {
      code: "compile_error",
      severity: "error",
      ...locFields,
      ...detailField,
      remedy: "Fix the frontend syntax or bundle error reported above and verify again.",
    };
  }
  const manifestPath = `${appRoot}/app.publish.json`;
  const rules: Array<
    [RegExp, AppFrontendDiagnostic["code"], string, Partial<AppFrontendDiagnostic>]
  > = [
    [
      /does not exist|not among its inputs|cannot include live documents/i,
      "missing_input",
      "List every imported file relative to the app root in app.publish.json inputs.",
      locFields,
    ],
    [
      /app\.publish\.json/i,
      "manifest_error",
      "Fix app.publish.json (version, entryPath, inputs, packageMap, and binding fields).",
      isShareablePath(manifestPath) ? { path: manifestPath } : {},
    ],
    [
      /collection\.yaml|collection schema|Collection fields/i,
      "collection_schema_error",
      "Check the Collection schema and declared allowedFields/readFields in app.publish.json.",
      locFields,
    ],
    [
      /Collection|dataset|operationId/i,
      "dataset_binding_error",
      "Verify datasetPath, revision/revisionSha256, and operationIds match the approved Collection.",
      locFields,
    ],
  ];
  const matched = rules.find(([pattern]) => pattern.test(raw));
  return matched
    ? { code: matched[1], severity: "error", ...matched[3], ...detailField, remedy: matched[2] }
    : {
        code: "compile_error",
        severity: "error",
        ...locFields,
        ...detailField,
        remedy: "Fix the frontend syntax or bundle error reported above and verify again.",
      };
}

const MAX_DIAGNOSTICS = 64;

function outsideAppRootDiagnostics(candidate: AppPublicationCandidate): AppFrontendDiagnostic[] {
  const prefix = `${candidate.appRoot}/`;
  const outsidePaths = [
    ...new Set(
      [candidate.entryPath, ...candidate.inputs.map((file) => file.path)].filter(
        (path) => path !== candidate.appRoot && !path.startsWith(prefix),
      ),
    ),
  ];
  return outsidePaths.map((path) => ({
    code: "input_outside_app_root" as const,
    severity: "warning" as const,
    path,
    detail:
      "Path is outside the app folder; a default share link scoped to the app folder will refuse it.",
    remedy:
      "Move shared files inside the app folder, or create a share link whose paths include every referenced folder.",
  }));
}

export async function verifyLocalAppFrontend(
  input: VerifyFrontendRequest,
  deps: VerifyLocalAppFrontendDeps,
): Promise<VerifyFrontendResult> {
  const current = () => {
    deps.signal.throwIfAborted();
    deps.assertCurrent();
  };
  current();

  let target: VerifyFrontendResult["target"];
  let candidate: AppPublicationCandidate;
  let files: ClosedAppBuild["files"];
  let publicationId: string;
  let authorityRevision: number;
  type ApprovedDatasetArtifacts = Awaited<
    ReturnType<VerifyLocalAppFrontendDeps["approvedArtifacts"]>
  >;
  const resolvedDatasets = new Map<string, ApprovedDatasetArtifacts>();
  let collectionSchemaText: string | undefined;

  if (input.publicationId !== undefined) {
    const pub = await deps.verificationPublication(input.publicationId);
    current();
    ({ publicationId, authorityRevision, candidate, files } = pub);
    target = { kind: "publication", publicationId, appRoot: pub.appRoot, authorityRevision };
    for (const cap of candidate.capabilities) {
      if (cap.kind === "dataset" && !resolvedDatasets.has(cap.datasetId)) {
        const approved = await deps.approvedArtifacts(cap.datasetId);
        current();
        if (!approved.active) throw new Error("This Collection is unavailable on this device.");
        resolvedDatasets.set(cap.datasetId, approved);
      } else if (cap.kind === "collection-create") {
        const schemaBytes = await deps.withAdapter(async (adapter) => {
          const meta = await adapter.captureSourceMetadata({
            workspaceId: deps.workspaceId,
            versionId: "main",
            paths: [`${cap.collectionPath}/collection.yaml`],
            bounds: { maxInputFiles: 1, maxInputBytes: APP_COLLECTION_MAX_SCHEMA_BYTES },
            signal: deps.signal,
          });
          return (await adapter.hydrateCapturedSources(meta, deps.signal))[0]?.bytes ?? null;
        });
        current();
        if (!schemaBytes || sha256(schemaBytes) !== cap.schemaSha256)
          throw new Error("The Collection schema changed. Prepare the app again.");
        collectionSchemaText = new TextDecoder("utf-8", { fatal: true }).decode(schemaBytes);
      }
    }
  } else {
    const appRoot = input.appRoot!;
    if (!isShareablePath(appRoot) || isSharedWithMePath(appRoot))
      throw new Error("Choose an app in your workspace.");
    const capture = await deps.flushCapture();
    current();
    let prepared: Awaited<ReturnType<typeof prepareLocalAppPublication>> | null;
    try {
      prepared = await deps.withAdapter((adapter) =>
        prepareLocalAppPublication(
          { workspaceId: deps.workspaceId, appRoot },
          {
            adapter,
            signal: deps.signal,
            assertCurrent: current,
            compile: deps.compile,
            deferredWrites: capture.deferredWrites,
            onCollectionSchema: (text) => {
              collectionSchemaText = text;
            },
            resolveDatasetRevision: async (binding) => {
              const approved = await deps.approvedArtifacts(binding.datasetId);
              current();
              if (!approved.active)
                throw new Error("This Collection is unavailable on this device.");
              resolvedDatasets.set(binding.datasetId, approved);
              return approved.revision;
            },
          },
        ),
      );
    } catch (error) {
      current();
      return OwnerAppPublicationResult.parse({
        kind: "frontendVerified",
        ok: false,
        stage: "compile",
        target: { kind: "candidate", appRoot },
        startupOk: false,
        stepsOk: false,
        handshake: { delivered: false, messageCount: 0 },
        brokerCalls: [],
        steps: [],
        diagnostics: [
          classifyCompileDiagnostic(error, appRoot, createDiagnosticScrubber(deps.workspaceRoot)),
        ],
        externalRequestsBlocked: 0,
      }) as VerifyFrontendResult;
    }
    current();
    if (!prepared) throw new Error("dohc could not capture this app. Restart dohc and try again.");
    ({ candidate, files } = prepared);
    publicationId = sha256(`dohc-verify:${candidate.buildDigest}`);
    authorityRevision = 1;
    target = {
      kind: "candidate",
      appRoot: candidate.appRoot,
      sourceRevision: candidate.sourceRevision,
    };
  }

  const hints = new Map<string, BackendFailureHint[]>();
  const recordHint = (op: string, operation: string | undefined, hint: BackendFailureHint) => {
    const key = `${op}:${operation ?? ""}`;
    hints.set(key, [...(hints.get(key) ?? []), hint]);
  };
  function failBackend(
    op: string,
    operation: string | undefined,
    reasonCode:
      | "unconnected"
      | "unsupported_in_dry_run"
      | "operation_not_approved"
      | "runtime_error",
    detail: string,
    remedy: string,
    message: string,
  ): never {
    recordHint(op, operation, {
      reasonCode,
      diagnosticCode: `broker_${reasonCode}`,
      detail,
      remedy,
    });
    throw new Error(message);
  }
  const consumeBackendHint = (op: string, operation?: string): BackendFailureHint | undefined => {
    const key = `${op}:${operation ?? ""}`;
    const list = hints.get(key);
    const first = list?.shift();
    if (list?.length === 0) hints.delete(key);
    return first;
  };

  const datasetCapabilities = candidate.capabilities.filter(
    (cap): cap is AppDatasetCapability => cap.kind === "dataset",
  );
  const collectionCapability = candidate.capabilities.find(
    (cap) => cap.kind === "collection-create",
  );
  type DryDatasetState = {
    resolved: ApprovedDatasetArtifacts;
    compiledSource: string;
    currentDb: Uint8Array;
    dbRevision: number;
    chain: Promise<void>;
    receipts: Map<
      string,
      {
        payloadSha256: string;
        response: { result: JsonValue; revision: number; replayed: boolean };
      }
    >;
  };
  const dryDatasets = new Map<string, DryDatasetState>();
  const nextRequestId = orderedRequestIds();
  const scrub = createDiagnosticScrubber(deps.workspaceRoot);

  for (const cap of datasetCapabilities) {
    if (dryDatasets.has(cap.datasetId)) continue;
    const resolved = resolvedDatasets.get(cap.datasetId);
    if (!resolved) throw new Error("This Collection is unavailable on this device.");
    let compiledSource: string;
    try {
      compiledSource = await deps.compileDataset(
        resolved.operationSource,
        resolved.revision.definition.operationsPath,
        deps.signal,
      );
      current();
    } catch (error) {
      current();
      const detail = scrub(error instanceof Error ? error.message : String(error));
      return OwnerAppPublicationResult.parse({
        kind: "frontendVerified",
        ok: false,
        stage: "compile",
        target,
        startupOk: false,
        stepsOk: false,
        handshake: { delivered: false, messageCount: 0 },
        brokerCalls: [],
        steps: [],
        diagnostics: [
          {
            code: "dataset_binding_error",
            severity: "error",
            ...(detail ? { detail } : {}),
            remedy: "Fix the Collection operations source or approval before verifying this app.",
          },
        ],
        externalRequestsBlocked: 0,
      }) as VerifyFrontendResult;
    }
    const currentDb = await initializeAppDatabase(
      {
        schemaSql: resolved.schemaSql,
        tables: resolved.revision.definition.tables.map((table) => table.sqlName),
        signal: deps.signal,
      },
      deps.datasetRuntime,
    );
    current();
    dryDatasets.set(cap.datasetId, {
      resolved,
      compiledSource,
      currentDb,
      dbRevision: 0,
      chain: Promise.resolve(),
      receipts: new Map(),
    });
  }

  const checkedCollection = collectionCapability
    ? (() => {
        if (!collectionSchemaText)
          throw new Error("The Collection schema is unavailable. Prepare the app again.");
        const res = validateAppCollectionSchema(collectionSchemaText, collectionCapability, "dohc");
        if (!res.ok) throw new Error(res.message);
        return res.value;
      })()
    : undefined;
  const dryRecords: Array<{ path: string; bytes: Uint8Array }> = [];
  const dryCollectionReceipts = new Map<
    string,
    { payloadSha256: string; receipt: AppCollectionReceipt }
  >();

  const dryBackend: LocalAppLaunchBackend = {
    browserPublication(id) {
      if (id !== publicationId) throw new Error("Unknown verification publication.");
      return { authorityRevision, files };
    },
    assertBrowserPublication(id, rev) {
      if (id !== publicationId || rev !== authorityRevision)
        throw new Error("Verification session ended.");
    },
    async readBrowserFile(_id, raw) {
      failBackend(
        "backend.file",
        raw.operation,
        "unsupported_in_dry_run",
        "backend.file is unavailable in empty dry-run verification.",
        "Verify uploaded file reads in a live Collection or guard empty dry-run file reads.",
        "Unsupported in dry-run verification.",
      );
    },
    async request(id, action, raw, signal) {
      if (id !== publicationId) throw new Error("Unknown verification publication.");
      const op = actionToBrokerOp(action);
      const rawOpName =
        raw && typeof raw === "object" && "operation" in raw && typeof raw.operation === "string"
          ? raw.operation
          : undefined;
      if (datasetCapabilities.length === 0 && !collectionCapability) {
        failBackend(
          op,
          rawOpName,
          "unconnected",
          `Unconnected app attempted ${op}.`,
          "Declare a dataset or collection binding in app.publish.json, or remove workspace data calls.",
          "This app is not approved for workspace data.",
        );
      }
      if (datasetCapabilities.length > 0) {
        if (action === "upload" || action === "attempt") {
          failBackend(
            op,
            rawOpName,
            "unsupported_in_dry_run",
            `${op} is unavailable in dry-run verification.`,
            "Avoid invoking file uploads or pending attempts during dry-run verification.",
            "Unsupported in dry-run verification.",
          );
        }
        if (action !== "invoke" && action !== "query") {
          failBackend(
            op,
            rawOpName,
            "operation_not_approved",
            `Dataset app attempted ${op}.`,
            "Use backend.invoke for Dataset-backed apps.",
            "This app is not approved for document Collection access.",
          );
        }
        const parsed = parseAppBackendInvokeRequest(raw);
        let selectedCapability: AppDatasetCapability;
        try {
          selectedCapability = selectDatasetCapability(datasetCapabilities, parsed.dataset);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "This Collection is not approved for the app.";
          failBackend(
            "backend.invoke",
            parsed.operation,
            "operation_not_approved",
            parsed.dataset
              ? `Collection alias "${parsed.dataset}" is not approved in app.publish.json.`
              : "Multi-Collection apps must pass a declared dataset alias on backend.invoke.",
            "Pass a declared dataset alias in backend.invoke or check datasets in app.publish.json.",
            message,
          );
        }
        const datasetState = dryDatasets.get(selectedCapability.datasetId)!;
        const operation = selectedCapability.operations.find(
          (item) => item.name === parsed.operation,
        );
        if (!operation || (action === "query" && !operation.readOnly)) {
          failBackend(
            "backend.invoke",
            parsed.operation,
            "operation_not_approved",
            operation
              ? `Read-only query attempted write operation "${parsed.operation}".`
              : `Operation "${parsed.operation}" is not in app.publish.json dataset.operationIds.`,
            operation
              ? "Call write operations through useDatasetMutation or client.invoke instead of useDatasetQuery."
              : "Add the operation's operationId to dataset.operationIds in app.publish.json, or remove the call.",
            "This action is not approved for the app.",
          );
        }
        const restricted = selectedCapability.createFields?.find(
          (entry) => entry.operationId === operation.operationId,
        );
        if (restricted) {
          const reqInput = parsed.input;
          if (
            !reqInput ||
            typeof reqInput !== "object" ||
            Array.isArray(reqInput) ||
            Object.keys(reqInput).length !== 1 ||
            !Object.hasOwn(reqInput, "values") ||
            !reqInput.values ||
            typeof reqInput.values !== "object" ||
            Array.isArray(reqInput.values) ||
            Object.keys(reqInput.values).some((fieldId) => !restricted.fieldIds.includes(fieldId))
          ) {
            failBackend(
              "backend.invoke",
              parsed.operation,
              "operation_not_approved",
              `Operation "${parsed.operation}" submitted fields outside app.publish.json dataset.createFields.`,
              "Submit only the approved fieldIds under input.values, or update dataset.createFields in app.publish.json.",
              "This form cannot submit those fields.",
            );
          }
        }
        const runSerialized = datasetState.chain
          .catch(() => {})
          .then(async () => {
            const receiptKey = parsed.idempotencyKey;
            const payloadHash = sha256(JSON.stringify([operation.operationId, parsed.input]));
            const existing = !operation.readOnly
              ? datasetState.receipts.get(receiptKey)
              : undefined;
            if (existing) {
              if (existing.payloadSha256 !== payloadHash) {
                failBackend(
                  "backend.invoke",
                  parsed.operation,
                  "runtime_error",
                  `Reused idempotencyKey with a different payload for "${parsed.operation}".`,
                  "Use a fresh idempotencyKey for each distinct request payload.",
                  "Idempotency key reused with different payload.",
                );
              }
              return { ...existing.response, replayed: true };
            }
            try {
              const evaluated = await evaluateAppOperation(
                {
                  source: datasetState.compiledSource,
                  operation: operation.name,
                  caller: { kind: "owner", userId: "verify-owner" },
                  input: parsed.input,
                  nowMs: Date.now(),
                  requestId: nextRequestId(),
                  database: datasetState.currentDb,
                  tables: datasetState.resolved.revision.definition.tables.map(
                    (table) => table.sqlName,
                  ),
                  readOnly: operation.readOnly,
                  files: [],
                  signal,
                },
                deps.datasetRuntime,
              );
              const definedOperation = datasetState.resolved.revision.definition.operations.find(
                (item) => item.operationId === operation.operationId,
              );
              const undoRefusal =
                definedOperation?.reversedBy !== undefined
                  ? missingUndo(definedOperation, evaluated.result)
                  : null;
              if (undoRefusal) throw new AppBackendRuntimeError(undoRefusal);
              if (!operation.readOnly && evaluated.changed) {
                datasetState.currentDb = evaluated.database;
                datasetState.dbRevision++;
              }
              const response = {
                result: evaluated.result,
                revision: datasetState.dbRevision,
                replayed: false,
              };
              if (!operation.readOnly && datasetState.receipts.size < 256)
                datasetState.receipts.set(receiptKey, { payloadSha256: payloadHash, response });
              return response;
            } catch (error) {
              if (isAppBackendRuntimeError(error)) throw error;
              recordHint("backend.invoke", parsed.operation, {
                reasonCode: "runtime_error",
                diagnosticCode: "broker_runtime_error",
                detail: error instanceof Error ? error.message : "Dry-run operation failed.",
                remedy: "Fix the Collection operation error or input validation before retrying.",
              });
              throw new LocalAppUnavailableError("Dry-run backend operation failed.");
            }
          });
        datasetState.chain = runSerialized.then(
          () => {},
          () => {},
        );
        return runSerialized;
      }

      if (action === "list") {
        const listReq = raw as { limit?: unknown; afterPath?: unknown };
        if (!collectionCapability!.readFields.length) {
          failBackend(
            "collection.list",
            undefined,
            "operation_not_approved",
            "This app has no readFields declared in app.publish.json.",
            "Declare collection.readFields in app.publish.json or remove collection.list calls.",
            "This app cannot read its Collection.",
          );
        }
        if (!isAppCollectionPageRequest(listReq.limit, listReq.afterPath))
          throw new Error("Invalid collection page.");
        const limit = listReq.limit as number;
        const afterPath = listReq.afterPath as string | undefined;
        const ordered = [...dryRecords]
          .sort((a, b) => compareAppCollectionPaths(a.path, b.path))
          .filter(
            (item) =>
              afterPath === undefined || compareAppCollectionPaths(item.path, afterPath) > 0,
          );
        return pageAppCollectionRecords(
          ordered.slice(0, limit).map((item) => ({
            path: item.path,
            record: projectAppCollectionRecord(
              item.path,
              item.bytes,
              collectionCapability!,
              checkedCollection!,
            ),
          })),
          ordered.length > limit,
        );
      }
      if (action === "create") {
        const parsed = parseAppCollectionCreateRequest(raw);
        const payloadHash = sha256(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(parsed.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
          ),
        );
        const existing = dryCollectionReceipts.get(parsed.idempotencyKey);
        if (existing) {
          if (existing.payloadSha256 !== payloadHash)
            throw new Error("This response key was already used for another response.");
          return existing.receipt;
        }
        const checked = validateAppCollectionCreateFields(
          parsed.fields,
          collectionCapability!,
          checkedCollection!,
        );
        if (!checked.ok) {
          failBackend(
            "collection.create",
            undefined,
            "runtime_error",
            checked.message,
            "Ensure submitted fields match collection.yaml and allowedFields/requiredFields.",
            checked.message,
          );
        }
        const derive = (label: string) =>
          createHash("sha256")
            .update(JSON.stringify(["dohc-verify-collection-v1", label, parsed.idempotencyKey]))
            .digest();
        const acceptanceId = `accepted_${derive("acceptance").toString("hex").slice(0, 32)}`;
        const createdAt = Date.now();
        const path = `${collectionCapability!.collectionPath}/${acceptanceId}.md`;
        dryRecords.push({
          path,
          bytes: new TextEncoder().encode(
            `---\n${JSON.stringify({ ...checked.value, id: `rec_${base32(derive("record")).slice(0, 26)}`, created_at: createdAt, acceptance_id: acceptanceId })}\n---\n`,
          ),
        });
        const receipt: AppCollectionReceipt = {
          kind: "accepted",
          acceptanceId,
          objectId: `dry_${derive("object").toString("hex").slice(0, 24)}`,
          path,
          momentId: `dry_${derive("moment").toString("hex").slice(0, 24)}`,
          acceptedAtMs: createdAt,
        };
        if (dryCollectionReceipts.size < 256)
          dryCollectionReceipts.set(parsed.idempotencyKey, { payloadSha256: payloadHash, receipt });
        return receipt;
      }
      failBackend(
        op,
        rawOpName,
        "operation_not_approved",
        `Document Collection app attempted ${op}.`,
        "Use collection.list and collection.create for document Collection apps.",
        "This app is not approved for Dataset access.",
      );
    },
  };

  const lifetime = new AbortController();
  const abortLifetime = () => lifetime.abort(deps.signal.reason);
  deps.signal.addEventListener("abort", abortLifetime, { once: true });
  const host = await createLocalAppLaunchHost({ backend: dryBackend, lifetime: lifetime.signal });
  try {
    const report = await deps.runBrowser({
      startSession: () => host.launchSession(publicationId, deps.signal, { observeBroker: true }),
      expectStartupBackend: input.expectStartupBackend,
      steps: input.steps,
      timeoutMs: input.timeoutMs ?? 10_000,
      signal: deps.signal,
      consumeBackendHint,
      scrub: createDiagnosticScrubber(deps.workspaceRoot),
    });
    current();
    const outsideWarnings = outsideAppRootDiagnostics(candidate);
    const diagnostics = [...report.diagnostics, ...outsideWarnings].slice(0, MAX_DIAGNOSTICS);
    return OwnerAppPublicationResult.parse({
      kind: "frontendVerified",
      target,
      ...report,
      diagnostics,
    }) as VerifyFrontendResult;
  } finally {
    deps.signal.removeEventListener("abort", abortLifetime);
    if (!lifetime.signal.aborted) lifetime.abort();
    await host.close().catch(() => {});
  }
}
