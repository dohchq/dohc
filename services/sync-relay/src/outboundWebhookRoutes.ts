import { createHash } from "node:crypto";
import {
  jsonResponse,
  parseSafeOutboundHttpsUrl,
  parseSafeOutboundJson,
  readBoundedJson,
  readSafeOutboundHttps,
  resolveSafeOutboundDestination,
  SafeOutboundError,
  sendSafeOutboundHttps,
  TokenBucketLimiter,
  type SafeOutboundDestination,
  type SafeOutboundRequest,
  type SafeOutboundResponse,
} from "@dohc/service-http";
import { AUTOMATION_LIMITS } from "@dohc/app-backend-runtime/automation";
import {
  AUTOMATION_HTTP_USER_AGENT,
  MAX_AUTOMATIONS_FILE_BYTES,
  MAX_HTTP_BODY_BYTES,
  MAX_HTTP_HEADERS,
  MAX_HTTP_HEADER_VALUE_BYTES,
  MAX_HTTP_RESPONSE_BYTES,
  MAX_HTTP_TOTAL_HEADER_BYTES,
  HTTP_HEADER_VALUE_PATTERN,
  httpStepTargetLabel,
  isForbiddenHttpHeader,
  parseAutomationsFile,
} from "@dohc/workspace-contracts/automations";
import {
  AUTOMATION_CHAIN_DEPTH_CAP,
  HttpStepApprovalWriteInput,
  OutboundWebhookDispatchRequest,
  computeHttpStepApprovalDigest,
  httpStepSecretNames,
  sanitizeHttpFailureReason,
  scrubSecretsFromJson,
  secretUrlScrubValues,
  type HttpJsonValue,
  workspaceSecretApprovalBinding,
  type OutboundWebhookDispatchResponse,
} from "@dohc/workspace-contracts/http-step-approvals";
import { isShareAccessValue } from "@dohc/security-contract";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import { isSharedWithMePath, stripWindowsAliasSuffix } from "@dohc/workspace-core";
import {
  codeFilesOf,
  definitionDigest,
  stepsInOrder,
} from "@dohc/automation-executor/automation-plan";
import { checkAutomationReach } from "@dohc/automation-executor/automation-reach";
import { listRosterGrants, ownerRoster } from "@dohc/automation-executor/roster-listing";
import { badRequest, notFound, relayError } from "./errors";
import {
  COLLECTION_SCHEMA_FILE,
  effectiveShareSelector,
  fileSideOf,
  MAIN_VERSION_ID,
  parseStoredAnyShareSelectorJson,
} from "./shareFilter";
import { accountIsFenced, workspaceIsDeleted } from "./storage/accountDeletion";
import { SyncRelayQuotaExceededError } from "./storage/errors";
import type { SyncRelayStorage } from "./storage";
import type { ActiveWorkspaceShareGrantRow } from "./storage/outboundWebhooks";
import { unsealWorkspaceSecret, type WorkspaceSecretKeyring } from "./workspaceSecretCrypto";

export const MAX_HTTP_APPROVAL_BODY_BYTES = 8 * 1024;
export const MAX_OUTBOUND_DISPATCH_BODY_BYTES = 448 * 1024;
const MAX_CODE_FILE_BYTES = 256 * 1024;
const MAX_CONCURRENT_OUTBOUND_PER_ACCOUNT = 2;
const OUTBOUND_TIMEOUT_MS = 10_000;
const OUTBOUND_MAX_HEADER_SIZE = 8_192;
const OUTBOUND_MAX_RESPONSE_BYTES = 64 * 1024;
const DATASET_DESCRIPTOR_FILENAME = "dataset.json";
const MAX_DATASET_DESCRIPTOR_BYTES = 64 * 1024;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function loosePathKey(path: string): string {
  return path
    .normalize("NFC")
    .split("/")
    .map((segment) =>
      stripWindowsAliasSuffix(segment).toLowerCase().toUpperCase().toLowerCase().normalize("NFC"),
    )
    .join("/");
}

function pathWithinFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function readCommittedCollectionId(
  storage: SyncRelayStorage,
  workspaceId: string,
  collectionPath: string,
): string | null {
  const schemaPath = `${collectionPath}/${COLLECTION_SCHEMA_FILE}`;
  const objectId = storage.currentFileObjectId({
    workspaceId,
    versionId: MAIN_VERSION_ID,
    path: schemaPath,
  });
  if (objectId !== undefined && objectId.length > 0) return objectId;
  const descriptorText = storage.readCommittedWorkspaceTextFile(
    workspaceId,
    MAIN_VERSION_ID,
    `${collectionPath}/${DATASET_DESCRIPTOR_FILENAME}`,
    MAX_DATASET_DESCRIPTOR_BYTES,
  );
  if (descriptorText === null) return null;
  try {
    const parsed = JSON.parse(descriptorText) as { datasetId?: unknown } | null;
    return typeof parsed?.datasetId === "string" && parsed.datasetId.length > 0
      ? parsed.datasetId
      : null;
  } catch {
    return null;
  }
}

function memberMayEdit(
  storage: SyncRelayStorage,
  workspaceId: string,
  grant: ActiveWorkspaceShareGrantRow,
  sourcePaths: readonly string[],
): boolean {
  const userId = grant.principalKind === "user" ? grant.principalUserId : null;
  if (userId === null || !isShareAccessValue(grant.access)) return true;
  if (storage.workspaceRoleOf(workspaceId, userId)?.role !== "member") return true;
  const reach = storage.memberReach(workspaceId, userId, "member", grant.access);
  return sourcePaths.some((path) => reach.levelAt(path) === "edit");
}

function hasActiveNonOwnerEditGrantForPaths(
  storage: SyncRelayStorage,
  workspaceId: string,
  ownerUserId: string,
  sourcePaths: readonly string[],
): boolean {
  const looseSources = sourcePaths.map(loosePathKey);
  for (const grant of storage.listActiveWorkspaceShareGrants(workspaceId)) {
    if (grant.principalKind === "user" && grant.principalUserId === ownerUserId) continue;
    const storedSelector = parseStoredAnyShareSelectorJson(grant.selectorJson);
    if (storedSelector === null) return true;
    if ("kind" in storedSelector && storedSelector.kind === "workspace") {
      if (memberMayEdit(storage, workspaceId, grant, sourcePaths)) return true;
      continue;
    }
    const effective = effectiveShareSelector(storedSelector, grant.access);
    if (effective === null) return true;
    const fileSide = fileSideOf(effective);
    if (fileSide === null) continue;
    if (!("access" in fileSide)) return true;
    if (fileSide.access !== "edit") continue;
    for (const granted of fileSide.paths) {
      const looseGranted = loosePathKey(granted);
      if (looseSources.some((source) => pathWithinFolder(source, looseGranted))) {
        return true;
      }
    }
  }
  return false;
}

export interface OutboundWebhookLimiters {
  readonly approval: TokenBucketLimiter;
  readonly account: TokenBucketLimiter;
  readonly workspace: TokenBucketLimiter;
}

export function createOutboundWebhookLimiters(): OutboundWebhookLimiters {
  return {
    approval: new TokenBucketLimiter(30, 0.5, 4_096),
    account: new TokenBucketLimiter(20, 1 / 3, 4_096),
    workspace: new TokenBucketLimiter(10, 1 / 6, 8_192),
  };
}

export type OutboundWebhookRoute =
  | { route: "workspace-http-approvals"; workspaceId: string }
  | { route: "workspace-outbound-dispatch"; workspaceId: string };

export interface OutboundWebhookExecutionDependencies {
  readonly storage: SyncRelayStorage;
  readonly keyring: WorkspaceSecretKeyring | null;
  readonly readOwnerShares: (
    ownerUserId: string,
    path: string,
  ) => Promise<{ status: number; body: unknown }>;
  readonly approvalRateLimiter: TokenBucketLimiter;
  readonly accountRateLimiter: TokenBucketLimiter;
  readonly workspaceRateLimiter: TokenBucketLimiter;
  readonly accountInFlight: Map<string, number>;
  readonly nowMs: () => number;
  readonly resolveDestination?: (rawUrl: string) => Promise<SafeOutboundDestination>;
  readonly sendRequest?: (request: SafeOutboundRequest, signal?: AbortSignal) => Promise<number>;
  readonly readRequest?: (
    request: SafeOutboundRequest,
    signal?: AbortSignal,
  ) => Promise<SafeOutboundResponse>;
}

function fixedSafeOutboundReason(
  error: unknown,
  secrets: readonly string[],
  maxResponseBytes: number,
): {
  code: string;
  reason: string;
} {
  if (error instanceof SafeOutboundError) {
    switch (error.code) {
      case "unsafe_url":
        return {
          code: "unsafe_url",
          reason: sanitizeHttpFailureReason("Webhook destination URL is not allowed.", secrets),
        };
      case "unsafe_address":
        return {
          code: "unsafe_address",
          reason: "Webhook destination resolved to a blocked or non-public network address.",
        };
      case "dns_failed":
        return {
          code: "dns_failed",
          reason: "Webhook destination hostname could not be resolved.",
        };
      case "redirect_refused":
        return {
          code: "redirect_refused",
          reason: "Webhook destination returned a redirect, which is not allowed.",
        };
      case "response_too_large":
        return {
          code: "response_too_large",
          reason: `Webhook destination response exceeded the ${maxResponseBytes / 1024} KiB limit.`,
        };
      case "response_interrupted":
        return {
          code: "response_interrupted",
          reason: "Webhook connection closed before a complete response arrived.",
        };
      case "unsupported_response":
        return {
          code: "unsupported_response",
          reason: "Webhook destination did not answer with uncompressed UTF-8 JSON.",
        };
      case "invalid_json":
        return {
          code: "invalid_json",
          reason: `Webhook destination answered with JSON that is invalid or nested more than ${AUTOMATION_LIMITS.resultDepth} levels deep.`,
        };
      default:
        return {
          code: "transport_failed",
          reason: "Webhook request failed or timed out.",
        };
    }
  }
  return {
    code: "transport_failed",
    reason: "Webhook request failed or timed out.",
  };
}

export async function executeRelayOutboundWebhook(
  deps: OutboundWebhookExecutionDependencies,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly request: OutboundWebhookDispatchRequest;
    readonly signal?: AbortSignal;
    readonly recheckSession?: () => Promise<void>;
  },
): Promise<{ httpStatus: number; body: OutboundWebhookDispatchResponse }> {
  const { storage, nowMs } = deps;
  const { workspaceId, ownerUserId, request, signal, recheckSession } = input;
  const beforeSendFailure = (
    httpStatus: number,
    error: string,
    reason: string,
    secrets: readonly string[] = [],
  ) => ({
    httpStatus,
    body: {
      ok: false as const,
      error,
      reason: sanitizeHttpFailureReason(reason, secrets),
      beforeSend: true,
    },
  });

  if (
    accountIsFenced(storage, ownerUserId) ||
    workspaceIsDeleted(storage, workspaceId) ||
    !storage.workspaceIsOwnedBy(workspaceId, ownerUserId)
  ) {
    throw notFound();
  }
  if (request.chainDepth >= AUTOMATION_CHAIN_DEPTH_CAP) {
    return beforeSendFailure(
      422,
      "chain_depth_exceeded",
      `Automation chain reached the maximum depth of ${AUTOMATION_CHAIN_DEPTH_CAP}.`,
    );
  }
  if (
    !isNormalizedRelativePath(request.collectionPath) ||
    isSharedWithMePath(request.collectionPath)
  ) {
    return beforeSendFailure(
      400,
      "invalid_collection",
      "Collection path is not a valid owned Collection.",
    );
  }

  const verifyCommittedStep = (secrets: readonly string[] = []) => {
    const committedCollectionId = readCommittedCollectionId(
      storage,
      workspaceId,
      request.collectionPath,
    );
    if (committedCollectionId === null || committedCollectionId !== request.collectionId) {
      return {
        ok: false as const,
        failure: beforeSendFailure(
          409,
          "definition_not_synced",
          "Sync this workspace first so your server has the latest Collection and automation.",
          secrets,
        ),
      };
    }

    const automationsText = storage.readCommittedWorkspaceTextFile(
      workspaceId,
      MAIN_VERSION_ID,
      `${request.collectionPath}/automations.yaml`,
      MAX_AUTOMATIONS_FILE_BYTES,
    );
    if (automationsText === null) {
      return {
        ok: false as const,
        failure: beforeSendFailure(
          409,
          "definition_not_synced",
          "Sync this workspace first so your server has the latest automations.yaml.",
          secrets,
        ),
      };
    }
    const parsed = parseAutomationsFile(automationsText);
    if (parsed.status !== "read") {
      return {
        ok: false as const,
        failure: beforeSendFailure(
          409,
          "definition_unreadable",
          "The synced automations.yaml could not be read.",
          secrets,
        ),
      };
    }
    const matchedEntry = parsed.entries.find(
      (entry) => entry.status === "valid" && entry.automation.id === request.automationId,
    );
    if (!matchedEntry || matchedEntry.status !== "valid" || !matchedEntry.automation.enabled) {
      return {
        ok: false as const,
        failure: beforeSendFailure(
          409,
          "definition_not_synced",
          "This automation is not enabled in the latest synced copy of automations.yaml.",
          secrets,
        ),
      };
    }
    const { automation } = matchedEntry;
    const orderedStep = stepsInOrder(automation).find(
      ({ ordinal }) => ordinal === request.stepOrdinal,
    );
    if (!orderedStep || orderedStep.step.kind !== "http") {
      return {
        ok: false as const,
        failure: beforeSendFailure(
          409,
          "definition_not_synced",
          "The synced automation does not have a matching webhook step at that position.",
          secrets,
        ),
      };
    }
    const httpStep = orderedStep.step;

    const uniqueCodeFiles = [
      ...new Set(
        stepsInOrder(automation).flatMap(({ step }) =>
          step.kind === "run-file" ? [step.file] : [],
        ),
      ),
    ].sort(compareCodeUnits);
    const codeFileHashes: Array<{ file: string; sha256: string }> = [];
    for (const file of uniqueCodeFiles) {
      const codeText = storage.readCommittedWorkspaceTextFile(
        workspaceId,
        MAIN_VERSION_ID,
        `${request.collectionPath}/${file}`,
        MAX_CODE_FILE_BYTES,
      );
      if (codeText === null) {
        return {
          ok: false as const,
          failure: beforeSendFailure(
            409,
            "definition_not_synced",
            `Sync this workspace first so your server has "${file}".`,
            secrets,
          ),
        };
      }
      codeFileHashes.push({
        file,
        sha256: createHash("sha256").update(codeText).digest("hex"),
      });
    }

    const secretNames = httpStepSecretNames(httpStep);
    const secretBindings = new Map<string, string>();
    for (const name of secretNames) {
      const stored = storage.readWorkspaceSecretForExecution(workspaceId, name);
      if (stored) secretBindings.set(name, workspaceSecretApprovalBinding(stored.summary));
    }
    const approvalDigest = computeHttpStepApprovalDigest({
      collectionId: committedCollectionId,
      collectionPath: request.collectionPath,
      automationId: automation.id,
      stepOrdinal: request.stepOrdinal,
      step: httpStep,
      definitionDigest: definitionDigest(automation),
      codeFileHashes,
      secretBindings,
    });
    if (approvalDigest === null || approvalDigest !== request.approvalDigest) {
      return {
        ok: false as const,
        failure: beforeSendFailure(
          409,
          "definition_not_synced",
          secretNames.length > 0
            ? "A secret this step uses changed, or your server doesn't have the current automation yet. Sync this workspace, then allow the step again if dohc asks."
            : "Sync this workspace first so your server has the current automation definition and scripts.",
          secrets,
        ),
      };
    }
    const sourcePaths = [
      `${request.collectionPath}/automations.yaml`,
      ...codeFilesOf(automation, request.collectionPath),
    ];
    return { ok: true as const, automation, httpStep, approvalDigest, sourcePaths };
  };

  const initialStep = verifyCommittedStep();
  if (!initialStep.ok) return initialStep.failure;
  const { automation, httpStep, approvalDigest, sourcePaths } = initialStep;
  const readResponse = httpStep.as !== null;
  const maxResponseBytes = readResponse ? MAX_HTTP_RESPONSE_BYTES : OUTBOUND_MAX_RESPONSE_BYTES;
  if (!storage.hasWorkspaceHttpStepApproval(workspaceId, approvalDigest)) {
    return beforeSendFailure(
      403,
      "approval_required",
      "This webhook step needs owner confirmation in dohc Desktop before sending.",
    );
  }
  if (hasActiveNonOwnerEditGrantForPaths(storage, workspaceId, ownerUserId, sourcePaths)) {
    return beforeSendFailure(403, "reach_stopped", "This Collection is not private.");
  }

  const collectionName = request.collectionPath.split("/").at(-1) ?? request.collectionPath;
  const checkSoloReach = async () => {
    const rosterAnswer = await listRosterGrants(workspaceId, (path) =>
      deps.readOwnerShares(ownerUserId, path),
    );
    const roster =
      rosterAnswer.kind === "answered"
        ? ownerRoster(ownerUserId, rosterAnswer.listing, "")
        : ownerRoster(ownerUserId, undefined, rosterAnswer.next);
    const [reach] = checkAutomationReach(roster, {
      id: automation.id,
      collection: { path: request.collectionPath, name: collectionName },
      codeFiles: codeFilesOf(automation, request.collectionPath),
      steps: [
        {
          kind: "http",
          target: httpStepTargetLabel(httpStep),
          stepOrdinal: request.stepOrdinal,
        },
      ],
    });
    return reach;
  };
  const initialReach = await checkSoloReach();
  if (!initialReach || !initialReach.allowed) {
    return beforeSendFailure(
      403,
      "reach_stopped",
      initialReach && !initialReach.allowed
        ? initialReach.reason
        : "This Collection is not private.",
    );
  }

  const declaredSafeHeaders = new Map(
    httpStep.headers.map((header) => [header.name.toLowerCase(), header] as const),
  );
  const declaredSecretHeaders = new Set(
    httpStep.secretHeaders.map((header) => header.name.toLowerCase()),
  );
  const seenSupplied = new Set<string>();
  const safeHeadersByLower = new Map<string, { name: string; value: string }>();
  for (const header of request.evaluatedSafeHeaders) {
    const lower = header.name.toLowerCase();
    if (
      seenSupplied.has(lower) ||
      isForbiddenHttpHeader(header.name) ||
      declaredSecretHeaders.has(lower) ||
      !declaredSafeHeaders.has(lower)
    ) {
      return beforeSendFailure(
        400,
        "invalid_headers",
        "Request headers do not match the approved automation step.",
      );
    }
    seenSupplied.add(lower);
    const declared = declaredSafeHeaders.get(lower)!;
    const value =
      declared.value.kind === "literal" && !Array.isArray(declared.value.value)
        ? String(declared.value.value)
        : header.value;
    if (
      !HTTP_HEADER_VALUE_PATTERN.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_HTTP_HEADER_VALUE_BYTES
    ) {
      return beforeSendFailure(400, "invalid_headers", "Request header value is invalid.");
    }
    safeHeadersByLower.set(lower, { name: declared.name, value });
  }
  for (const [lower, declared] of declaredSafeHeaders) {
    if (
      !safeHeadersByLower.has(lower) &&
      declared.value.kind === "literal" &&
      !Array.isArray(declared.value.value)
    ) {
      safeHeadersByLower.set(lower, { name: declared.name, value: String(declared.value.value) });
    }
  }
  if (safeHeadersByLower.size + httpStep.secretHeaders.length > MAX_HTTP_HEADERS) {
    return beforeSendFailure(
      400,
      "invalid_headers",
      `Webhook requests allow at most ${MAX_HTTP_HEADERS} headers.`,
    );
  }
  if (httpStep.body === null && request.evaluatedBody !== null) {
    return beforeSendFailure(
      400,
      "invalid_body",
      "This webhook step does not declare a request body.",
    );
  }
  if (
    request.evaluatedBody !== null &&
    Buffer.byteLength(request.evaluatedBody, "utf8") > MAX_HTTP_BODY_BYTES
  ) {
    return beforeSendFailure(
      413,
      "payload_too_large",
      `Webhook body exceeds the ${MAX_HTTP_BODY_BYTES}-byte limit.`,
    );
  }

  const now = nowMs();
  if (!deps.accountRateLimiter.allow(ownerUserId, now)) {
    return beforeSendFailure(
      429,
      "rate_limited",
      "Account webhook rate limit reached. Try again shortly.",
    );
  }
  if (!deps.workspaceRateLimiter.allow(workspaceId, now)) {
    return beforeSendFailure(
      429,
      "rate_limited",
      "Workspace webhook rate limit reached. Try again shortly.",
    );
  }

  const currentInFlight = deps.accountInFlight.get(ownerUserId) ?? 0;
  if (currentInFlight >= MAX_CONCURRENT_OUTBOUND_PER_ACCOUNT) {
    return beforeSendFailure(
      429,
      "concurrency_limit",
      `At most ${MAX_CONCURRENT_OUTBOUND_PER_ACCOUNT} webhooks can run at once for this account.`,
    );
  }

  deps.accountInFlight.set(ownerUserId, currentInFlight + 1);
  const secretsToScrub: string[] = [];
  const loadedSecrets: Array<{ name: string; generation: number; createdAtMs: number }> = [];
  const finalizeFailure = (errorCode: string, reason: string, httpStatus?: number) => {
    const safeReason = sanitizeHttpFailureReason(reason, secretsToScrub);
    storage.finalizeWorkspaceHttpDispatch({
      workspaceId,
      deliveryId: request.deliveryId,
      status: "failed",
      httpStatus: httpStatus ?? null,
      errorReason: safeReason,
      nowMs: nowMs(),
    });
    return {
      httpStatus: 200,
      body: {
        ok: false as const,
        error: errorCode,
        ...(httpStatus !== undefined ? { status: httpStatus } : {}),
        reason: safeReason,
      },
    };
  };

  try {
    let rawUrl: string;
    if (httpStep.url.kind === "literal") {
      rawUrl = httpStep.url.url;
    } else {
      if (!deps.keyring) {
        return beforeSendFailure(
          200,
          "secrets_unavailable",
          "Workspace secrets are unavailable on this server.",
          secretsToScrub,
        );
      }
      const storedUrlSecret = storage.readWorkspaceSecretForExecution(
        workspaceId,
        httpStep.url.secret,
      );
      if (!storedUrlSecret) {
        return beforeSendFailure(
          200,
          "secret_missing",
          `Secret "${httpStep.url.secret}" was not found in Workspace Settings.`,
          secretsToScrub,
        );
      }
      if (storedUrlSecret.summary.usage !== "http-url") {
        return beforeSendFailure(
          200,
          "secret_wrong_usage",
          `Secret "${httpStep.url.secret}" is not configured as a webhook URL secret.`,
          secretsToScrub,
        );
      }
      loadedSecrets.push(storedUrlSecret.summary);
      const unsealedUrl = unsealWorkspaceSecret({
        keyring: deps.keyring,
        workspaceId,
        ownerUserId,
        name: storedUrlSecret.summary.name,
        usage: storedUrlSecret.summary.usage,
        allowedHosts: storedUrlSecret.summary.allowedHosts,
        generation: storedUrlSecret.summary.generation,
        keyId: storedUrlSecret.keyId,
        sealed: storedUrlSecret.sealedValue,
      });
      if (unsealedUrl === null) {
        return beforeSendFailure(
          200,
          "secret_unseal_failed",
          `Secret "${httpStep.url.secret}" could not be unsealed. Replace it in Settings.`,
          secretsToScrub,
        );
      }
      rawUrl = unsealedUrl;
      secretsToScrub.push(...secretUrlScrubValues(rawUrl));
    }

    let destination: SafeOutboundDestination;
    try {
      const parsedUrl = parseSafeOutboundHttpsUrl(rawUrl);
      if (parsedUrl === null) {
        throw new SafeOutboundError("unsafe_url", "Outbound destination URL is not allowed.");
      }
      destination = await (deps.resolveDestination ?? resolveSafeOutboundDestination)(
        parsedUrl.href,
      );
    } catch (error) {
      const mapped = fixedSafeOutboundReason(error, secretsToScrub, maxResponseBytes);
      return beforeSendFailure(200, mapped.code, mapped.reason, secretsToScrub);
    }
    if (httpStep.url.kind === "secret") {
      secretsToScrub.push(destination.canonicalHost);
    }

    const outboundHeaders = Object.create(null) as Record<string, string>;
    let totalHeaderBytes = 0;
    let hasContentType = false;
    for (const { name, value } of safeHeadersByLower.values()) {
      outboundHeaders[name] = value;
      totalHeaderBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
      if (name.toLowerCase() === "content-type") hasContentType = true;
    }
    if (totalHeaderBytes > MAX_HTTP_TOTAL_HEADER_BYTES) {
      return beforeSendFailure(
        200,
        "invalid_headers",
        `Webhook headers exceed the ${MAX_HTTP_TOTAL_HEADER_BYTES}-byte limit.`,
        secretsToScrub,
      );
    }

    for (const secretHeader of httpStep.secretHeaders) {
      if (!deps.keyring) {
        return beforeSendFailure(
          200,
          "secrets_unavailable",
          "Workspace secrets are unavailable on this server.",
          secretsToScrub,
        );
      }
      const storedSecret = storage.readWorkspaceSecretForExecution(
        workspaceId,
        secretHeader.secret,
      );
      if (!storedSecret) {
        return beforeSendFailure(
          200,
          "secret_missing",
          `Secret "${secretHeader.secret}" was not found in Workspace Settings.`,
          secretsToScrub,
        );
      }
      if (storedSecret.summary.usage !== "http-header") {
        return beforeSendFailure(
          200,
          "secret_wrong_usage",
          `Secret "${secretHeader.secret}" is not configured as a header secret.`,
          secretsToScrub,
        );
      }
      if (!storedSecret.summary.allowedHosts.includes(destination.canonicalHost)) {
        return beforeSendFailure(
          200,
          "secret_host_denied",
          httpStep.url.kind === "secret"
            ? `Secret "${secretHeader.secret}" is not allowed for the webhook destination host.`
            : `Secret "${secretHeader.secret}" is not allowed for host "${destination.canonicalHost}".`,
          secretsToScrub,
        );
      }
      loadedSecrets.push(storedSecret.summary);
      const unsealed = unsealWorkspaceSecret({
        keyring: deps.keyring,
        workspaceId,
        ownerUserId,
        name: storedSecret.summary.name,
        usage: storedSecret.summary.usage,
        allowedHosts: storedSecret.summary.allowedHosts,
        generation: storedSecret.summary.generation,
        keyId: storedSecret.keyId,
        sealed: storedSecret.sealedValue,
      });
      if (unsealed === null) {
        return beforeSendFailure(
          200,
          "secret_unseal_failed",
          `Secret "${secretHeader.secret}" could not be unsealed. Replace it in Settings.`,
          secretsToScrub,
        );
      }
      secretsToScrub.push(unsealed);
      const combinedValue = `${secretHeader.prefix ?? ""}${unsealed}`;
      if (!HTTP_HEADER_VALUE_PATTERN.test(combinedValue)) {
        return beforeSendFailure(
          200,
          "invalid_headers",
          `Secret header "${secretHeader.name}" contains disallowed characters.`,
          secretsToScrub,
        );
      }
      totalHeaderBytes +=
        Buffer.byteLength(secretHeader.name, "utf8") + Buffer.byteLength(combinedValue, "utf8");
      if (totalHeaderBytes > MAX_HTTP_TOTAL_HEADER_BYTES) {
        return beforeSendFailure(
          200,
          "invalid_headers",
          `Webhook headers exceed the ${MAX_HTTP_TOTAL_HEADER_BYTES}-byte limit.`,
          secretsToScrub,
        );
      }
      outboundHeaders[secretHeader.name] = combinedValue;
      if (secretHeader.name.toLowerCase() === "content-type") hasContentType = true;
    }

    if (request.evaluatedBody !== null && !hasContentType) {
      const fallbackContentType =
        request.defaultContentType ??
        (httpStep.body?.kind === "text" ? "text/plain; charset=utf-8" : "application/json");
      outboundHeaders["Content-Type"] = fallbackContentType;
    }
    outboundHeaders["User-Agent"] = AUTOMATION_HTTP_USER_AGENT;
    outboundHeaders["X-Dohc-Delivery-Id"] = request.deliveryId;
    outboundHeaders["X-Dohc-Chain-Depth"] = String(request.chainDepth + 1);

    // Recheck session, ownership, account fence, committed definition, approval,
    // and authoritative solo reach after awaiting DNS, with the final checks
    // running synchronously inside the SQLite reservation transaction.
    if (recheckSession) {
      await recheckSession();
    }
    const postDnsReach = await checkSoloReach();
    if (!postDnsReach || !postDnsReach.allowed) {
      return beforeSendFailure(
        403,
        "reach_stopped",
        postDnsReach && !postDnsReach.allowed
          ? postDnsReach.reason
          : "This Collection is not private.",
        secretsToScrub,
      );
    }

    const finalChecks = () => {
      for (const loaded of loadedSecrets) {
        const current = storage.readWorkspaceSecretForExecution(workspaceId, loaded.name);
        if (
          current === null ||
          current.summary.generation !== loaded.generation ||
          current.summary.createdAtMs !== loaded.createdAtMs
        ) {
          return beforeSendFailure(
            409,
            "secret_changed",
            `Secret "${loaded.name}" changed while dohc was sending. Try again.`,
            secretsToScrub,
          );
        }
      }
      const verified = verifyCommittedStep(secretsToScrub);
      if (!verified.ok) return verified.failure;
      if (!storage.hasWorkspaceHttpStepApproval(workspaceId, verified.approvalDigest)) {
        return beforeSendFailure(
          403,
          "approval_required",
          "This webhook step needs owner confirmation in dohc Desktop before sending.",
          secretsToScrub,
        );
      }
      if (
        hasActiveNonOwnerEditGrantForPaths(storage, workspaceId, ownerUserId, verified.sourcePaths)
      ) {
        return beforeSendFailure(
          403,
          "reach_stopped",
          "This Collection is not private.",
          secretsToScrub,
        );
      }
      return null;
    };
    const outboundRequest: SafeOutboundRequest = {
      destination,
      method: httpStep.method,
      headers: outboundHeaders,
      body: request.evaluatedBody !== null ? Buffer.from(request.evaluatedBody, "utf8") : undefined,
      timeoutMs: OUTBOUND_TIMEOUT_MS,
      maxHeaderSize: OUTBOUND_MAX_HEADER_SIZE,
      maxResponseBytes,
      rejectRedirects: true,
    };
    const readJson = async (): Promise<
      { status: number; response?: HttpJsonValue } | { code: string; reason: string }
    > => {
      try {
        if (!readResponse) {
          return {
            status: await (deps.sendRequest ?? sendSafeOutboundHttps)(outboundRequest, signal),
          };
        }
        const read = await (deps.readRequest ?? readSafeOutboundHttps)(outboundRequest, signal);
        if (read.status < 200 || read.status >= 300) return { status: read.status };
        const parsed = parseSafeOutboundJson(read, AUTOMATION_LIMITS.resultDepth) as HttpJsonValue;
        const scrubbed = scrubSecretsFromJson(parsed, secretsToScrub);
        if (!scrubbed.ok) return { code: "unsupported_response", reason: scrubbed.reason };
        return { status: read.status, response: scrubbed.value };
      } catch (error) {
        return fixedSafeOutboundReason(error, secretsToScrub, maxResponseBytes);
      }
    };

    if (httpStep.method === "GET") {
      if (
        accountIsFenced(storage, ownerUserId) ||
        workspaceIsDeleted(storage, workspaceId) ||
        !storage.workspaceIsOwnedBy(workspaceId, ownerUserId)
      ) {
        throw notFound();
      }
      const refusal = finalChecks();
      if (refusal !== null) return refusal;
      const fetched = await readJson();
      if ("code" in fetched) {
        return {
          httpStatus: 200,
          body: { ok: false, error: fetched.code, reason: fetched.reason },
        };
      }
      if (fetched.status >= 200 && fetched.status < 300) {
        return { httpStatus: 200, body: { ok: true, ...fetched } };
      }
      return {
        httpStatus: 200,
        body: {
          ok: false,
          error: "http_status_error",
          status: fetched.status,
          reason: `Webhook destination returned HTTP ${fetched.status}.`,
        },
      };
    }

    let reservation;
    try {
      reservation = storage.reserveWorkspaceHttpDispatch({
        workspaceId,
        ownerUserId,
        deliveryId: request.deliveryId,
        nowMs: nowMs(),
        beforeReserve: finalChecks,
      });
    } catch (error) {
      if (error instanceof SyncRelayQuotaExceededError) {
        return beforeSendFailure(507, "quota_exceeded", error.message, secretsToScrub);
      }
      throw error;
    }
    if (!reservation.ok) {
      if (reservation.reason === "refused") return reservation.refusal;
      throw notFound();
    }
    if (!reservation.reserved) {
      const { existing } = reservation;
      if (existing.status === "pending") {
        return {
          httpStatus: 409,
          body: {
            ok: false,
            error: "delivery_in_flight",
            reason: "This webhook delivery is already in progress.",
            deduplicated: true,
          },
        };
      }
      if (existing.status === "sent") {
        return {
          httpStatus: 200,
          body: {
            ok: true,
            status: existing.httpStatus ?? 200,
            deduplicated: true,
          },
        };
      }
      return {
        httpStatus: 200,
        body: {
          ok: false,
          error: "delivery_failed",
          ...(existing.httpStatus !== null ? { status: existing.httpStatus } : {}),
          reason: existing.errorReason ?? "The webhook request failed.",
          deduplicated: true,
        },
      };
    }

    const sent = await readJson();
    if ("code" in sent) return finalizeFailure(sent.code, sent.reason);
    const { status } = sent;
    if (status >= 200 && status < 300) {
      storage.finalizeWorkspaceHttpDispatch({
        workspaceId,
        deliveryId: request.deliveryId,
        status: "sent",
        httpStatus: status,
        errorReason: null,
        nowMs: nowMs(),
      });
      return {
        httpStatus: 200,
        body: { ok: true, ...sent },
      };
    }
    return finalizeFailure(
      "http_status_error",
      `Webhook destination returned HTTP ${status}.`,
      status,
    );
  } finally {
    const active = deps.accountInFlight.get(ownerUserId) ?? 1;
    if (active <= 1) deps.accountInFlight.delete(ownerUserId);
    else deps.accountInFlight.set(ownerUserId, active - 1);
  }
}

export function createOutboundWebhookRoutes(deps: OutboundWebhookExecutionDependencies) {
  return async function respondToOutboundWebhooks(
    request: Request,
    route: OutboundWebhookRoute,
    ownerUserId: string,
    recheckSession: () => Promise<void>,
  ): Promise<Response> {
    if (route.route === "workspace-http-approvals") {
      if (!deps.approvalRateLimiter.allow(ownerUserId, deps.nowMs())) {
        return jsonResponse(
          {
            ok: false,
            error: "rate_limited",
            message: "Too many webhook approval requests. Try again shortly.",
          },
          429,
        );
      }
      if (request.method === "GET") {
        if (
          accountIsFenced(deps.storage, ownerUserId) ||
          workspaceIsDeleted(deps.storage, route.workspaceId) ||
          !deps.storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)
        ) {
          throw notFound();
        }
        return jsonResponse(
          {
            ok: true,
            approvals: deps.storage.listWorkspaceHttpStepApprovals(route.workspaceId),
            secrets: deps.storage.listWorkspaceSecrets(route.workspaceId),
          },
          200,
        );
      }
      if (request.method !== "POST") {
        throw relayError("method_not_allowed");
      }
      let rawBody: unknown;
      try {
        rawBody = await readBoundedJson(request, MAX_HTTP_APPROVAL_BODY_BYTES, request.signal);
      } catch (error) {
        if (error instanceof RangeError) throw relayError("payload_too_large");
        throw badRequest("request body must be valid JSON");
      }
      await recheckSession();
      const parsed = HttpStepApprovalWriteInput.safeParse(rawBody);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? "invalid approval payload");
      }
      if (
        !isNormalizedRelativePath(parsed.data.collectionPath) ||
        isSharedWithMePath(parsed.data.collectionPath)
      ) {
        throw badRequest("collectionPath must be a normalized owned Collection path");
      }
      let result;
      try {
        result = deps.storage.approveWorkspaceHttpStep({
          workspaceId: route.workspaceId,
          ownerUserId,
          approvalDigest: parsed.data.approvalDigest,
          collectionPath: parsed.data.collectionPath,
          automationId: parsed.data.automationId,
          stepOrdinal: parsed.data.stepOrdinal,
          nowMs: deps.nowMs(),
        });
      } catch (error) {
        if (error instanceof SyncRelayQuotaExceededError) {
          throw relayError("quota_exceeded", error.message);
        }
        throw error;
      }
      if (!result.ok) {
        if (result.reason === "unauthorized") throw notFound();
        return jsonResponse(
          {
            ok: false,
            error: "http_approval_limit_reached",
            message: `At most ${result.limit} webhook approvals are allowed per workspace (${result.count} used).`,
          },
          400,
        );
      }
      return jsonResponse({ ok: true, approvalDigest: result.approvalDigest }, 200);
    }

    if (request.method !== "POST") {
      throw relayError("method_not_allowed");
    }
    let rawBody: unknown;
    try {
      rawBody = await readBoundedJson(request, MAX_OUTBOUND_DISPATCH_BODY_BYTES, request.signal);
    } catch (error) {
      if (error instanceof RangeError) throw relayError("payload_too_large");
      throw badRequest("request body must be valid JSON");
    }
    await recheckSession();
    const parsed = OutboundWebhookDispatchRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? "invalid webhook dispatch request");
    }
    const dispatched = await executeRelayOutboundWebhook(deps, {
      workspaceId: route.workspaceId,
      ownerUserId,
      request: parsed.data,
      signal: request.signal,
      recheckSession,
    });
    return jsonResponse(dispatched.body, dispatched.httpStatus);
  };
}
