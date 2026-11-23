import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  evaluateAppOperation,
  initializeAppDatabase,
  isAppBackendRuntimeError,
  type AppBackendRuntimeOptions,
  type JsonValue,
} from "@dohc/app-backend-runtime";
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
      .replace(/(?:shareToken|token|handoff|x-dohc-app-proof)[=:]\s*\S+/gi, "<redacted>");
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
  let resolvedDataset:
    | Awaited<ReturnType<VerifyLocalAppFrontendDeps["approvedArtifacts"]>>
    | undefined;
  let collectionSchemaText: string | undefined;

  if (input.publicationId !== undefined) {
    const pub = await deps.verificationPublication(input.publicationId);
    current();
    ({ publicationId, authorityRevision, candidate, files } = pub);
    target = { kind: "publication", publicationId, appRoot: pub.appRoot, authorityRevision };
    const cap = candidate.capabilities[0];
    if (cap?.kind === "dataset") {
      resolvedDataset = await deps.approvedArtifacts(cap.datasetId);
      current();
      if (!resolvedDataset.active)
        throw new Error("This Collection is unavailable on this device.");
    } else if (cap?.kind === "collection-create") {
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
              resolvedDataset = approved;
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

  const capability = candidate.capabilities[0];
  let compiledDatasetSource = "";
  let currentDb: Uint8Array | undefined;
  let dbRevision = 0;
  let opSeq = 0;
  let datasetChain: Promise<void> = Promise.resolve();
  const datasetReceipts = new Map<
    string,
    { payloadSha256: string; response: { result: JsonValue; revision: number; replayed: boolean } }
  >();

  if (capability?.kind === "dataset") {
    if (!resolvedDataset) throw new Error("This Collection is unavailable on this device.");
    compiledDatasetSource = await deps.compileDataset(
      resolvedDataset.operationSource,
      resolvedDataset.revision.definition.operationsPath,
      deps.signal,
    );
    current();
    currentDb = await initializeAppDatabase(
      {
        schemaSql: resolvedDataset.schemaSql,
        tables: resolvedDataset.revision.definition.tables.map((table) => table.sqlName),
        signal: deps.signal,
      },
      deps.datasetRuntime,
    );
    current();
  }

  const checkedCollection =
    capability?.kind === "collection-create"
      ? (() => {
          if (!collectionSchemaText)
            throw new Error("The Collection schema is unavailable. Prepare the app again.");
          const res = validateAppCollectionSchema(collectionSchemaText, capability, "dohc");
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
      if (!capability) {
        failBackend(
          op,
          rawOpName,
          "unconnected",
          `Unconnected app attempted ${op}.`,
          "Declare a dataset or collection binding in app.publish.json, or remove workspace data calls.",
          "This app is not approved for workspace data.",
        );
      }
      if (capability.kind === "dataset") {
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
        if (action !== "invoke") {
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
        const operation = capability.operations.find((item) => item.name === parsed.operation);
        if (!operation) {
          failBackend(
            "backend.invoke",
            parsed.operation,
            "operation_not_approved",
            `Operation "${parsed.operation}" is not in app.publish.json dataset.operationIds.`,
            "Add the operation's operationId to dataset.operationIds in app.publish.json, or remove the call.",
            "This action is not approved for the app.",
          );
        }
        const runSerialized = datasetChain
          .catch(() => {})
          .then(async () => {
            const receiptKey = parsed.idempotencyKey;
            const payloadHash = sha256(JSON.stringify([operation.operationId, parsed.input]));
            const existing = !operation.readOnly ? datasetReceipts.get(receiptKey) : undefined;
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
                  source: compiledDatasetSource,
                  operation: operation.name,
                  caller: { kind: "owner", userId: "verify-owner" },
                  input: parsed.input,
                  nowMs: Date.now(),
                  requestId: `verify-${++opSeq}`,
                  database: currentDb!,
                  tables: resolvedDataset!.revision.definition.tables.map((table) => table.sqlName),
                  readOnly: operation.readOnly,
                  files: [],
                  signal,
                },
                deps.datasetRuntime,
              );
              if (!operation.readOnly && evaluated.changed) {
                currentDb = evaluated.database;
                dbRevision++;
              }
              const response = { result: evaluated.result, revision: dbRevision, replayed: false };
              if (!operation.readOnly && datasetReceipts.size < 256)
                datasetReceipts.set(receiptKey, { payloadSha256: payloadHash, response });
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
        datasetChain = runSerialized.then(
          () => {},
          () => {},
        );
        return runSerialized;
      }

      if (action === "list") {
        const listReq = raw as { limit?: unknown; afterPath?: unknown };
        if (!capability.readFields.length) {
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
              capability,
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
          capability,
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
        const path = `${capability.collectionPath}/${acceptanceId}.md`;
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
    return OwnerAppPublicationResult.parse({
      kind: "frontendVerified",
      target,
      ...report,
    }) as VerifyFrontendResult;
  } finally {
    deps.signal.removeEventListener("abort", abortLifetime);
    if (!lifetime.signal.aborted) lifetime.abort();
    await host.close().catch(() => {});
  }
}
