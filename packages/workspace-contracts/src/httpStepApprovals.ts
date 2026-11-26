import { createHash } from "node:crypto";
import { z } from "zod";
import {
  HTTP_HEADER_NAME_PATTERN,
  HTTP_HEADER_VALUE_PATTERN,
  MAX_AUTOMATION_ID_LENGTH,
  MAX_HTTP_BODY_BYTES,
  MAX_HTTP_HEADERS,
  MAX_HTTP_HEADER_VALUE_BYTES,
  isForbiddenHttpHeader,
  type AutomationHttpStep,
} from "./automations";
import type { WorkspaceSecretSummary } from "./workspaceSecrets";

export const AUTOMATION_CHAIN_DEPTH_CAP = 4;
export const MAX_WORKSPACE_HTTP_APPROVALS = 500;

export const HttpStepApprovalDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Approval digest must be a 64-character lowercase SHA-256 hex string.");

export const HttpStepApprovalWriteInput = z
  .object({
    approvalDigest: HttpStepApprovalDigest,
    collectionId: z.string().min(1).max(256),
    collectionPath: z.string().min(1).max(1_024),
    automationId: z.string().min(1).max(MAX_AUTOMATION_ID_LENGTH),
    stepOrdinal: z.number().int().min(0).max(24),
  })
  .strict();
export type HttpStepApprovalWriteInput = z.output<typeof HttpStepApprovalWriteInput>;

const EvaluatedHttpHeaderSchema = z
  .object({
    name: z
      .string()
      .regex(HTTP_HEADER_NAME_PATTERN)
      .refine((name) => !isForbiddenHttpHeader(name), "Header name is forbidden."),
    value: z
      .string()
      .refine(
        (value) =>
          HTTP_HEADER_VALUE_PATTERN.test(value) &&
          Buffer.byteLength(value, "utf8") <= MAX_HTTP_HEADER_VALUE_BYTES,
        "Header value is invalid.",
      ),
  })
  .strict();

export const OutboundWebhookDispatchRequest = z
  .object({
    collectionId: z.string().min(1).max(256),
    collectionPath: z.string().min(1).max(1_024),
    automationId: z.string().min(1).max(MAX_AUTOMATION_ID_LENGTH),
    stepOrdinal: z.number().int().min(0).max(24),
    approvalDigest: HttpStepApprovalDigest,
    deliveryId: z.string().regex(/^[0-9a-f]{64}$/u),
    chainDepth: z.number().int().min(0).max(AUTOMATION_CHAIN_DEPTH_CAP),
    evaluatedSafeHeaders: z.array(EvaluatedHttpHeaderSchema).max(MAX_HTTP_HEADERS),
    evaluatedBody: z
      .string()
      .refine(
        (body) => Buffer.byteLength(body, "utf8") <= MAX_HTTP_BODY_BYTES,
        "Request body exceeds limit.",
      )
      .nullable(),
    defaultContentType: z
      .enum(["application/json", "text/plain; charset=utf-8"])
      .nullable()
      .optional(),
  })
  .strict();
export type OutboundWebhookDispatchRequest = z.output<typeof OutboundWebhookDispatchRequest>;

export const OutboundWebhookDispatchResponse = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      status: z.number().int().min(200).max(299),
      deduplicated: z.boolean().optional(),
      response: z.json().optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1).max(128),
      status: z.number().int().min(100).max(599).optional(),
      reason: z.string().min(1).max(500),
      deduplicated: z.boolean().optional(),
      beforeSend: z.boolean().optional(),
    })
    .strict(),
]);
export type OutboundWebhookDispatchResponse = z.output<typeof OutboundWebhookDispatchResponse>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function httpStepSecretNames(
  step: Pick<AutomationHttpStep, "url" | "secretHeaders">,
): string[] {
  const names = new Set(step.secretHeaders.map((header) => header.secret));
  if (step.url.kind === "secret") names.add(step.url.secret);
  return [...names].sort(compareCodeUnits);
}

/**
 * What an approval remembers about a secret: a header secret's websites and
 * when it was first added, so rotating its value keeps the approval; a link
 * secret's exact version, so any new link needs a new approval.
 */
export function workspaceSecretApprovalBinding(secret: {
  readonly usage: "http-header" | "http-url";
  readonly allowedHosts: readonly string[];
  readonly createdAtMs: number;
  readonly generation: number;
}): string {
  return JSON.stringify(
    secret.usage === "http-header"
      ? [secret.usage, [...secret.allowedHosts].sort(compareCodeUnits), secret.createdAtMs]
      : [secret.usage, secret.createdAtMs, secret.generation],
  );
}

export function httpStepSecretProblem(
  step: Pick<AutomationHttpStep, "url" | "secretHeaders">,
  secrets: readonly WorkspaceSecretSummary[],
): string | null {
  const uses = [
    ...(step.url.kind === "secret" ? [{ name: step.url.secret, usage: "http-url" as const }] : []),
    ...step.secretHeaders.map((header) => ({ name: header.secret, usage: "http-header" as const })),
  ];
  for (const use of uses) {
    const secret = secrets.find((candidate) => candidate.name === use.name);
    if (!secret) return `Add the secret ${use.name} in Settings, then allow this step.`;
    if (secret.usage !== use.usage) {
      return `${use.name} is saved as ${secret.usage === "http-url" ? "a webhook link" : "an API key"}, but this step uses it as ${use.usage === "http-url" ? "a webhook link" : "an API key"}. Fix it in Settings, then allow this step.`;
    }
  }
  return null;
}

export function workspaceSecretApprovalBindings(
  secrets: readonly WorkspaceSecretSummary[] | null,
): Map<string, string> | null {
  return secrets === null
    ? null
    : new Map(secrets.map((secret) => [secret.name, workspaceSecretApprovalBinding(secret)]));
}

/**
 * Deterministic SHA-256 digest binding an owner's Desktop UI approval of one
 * outbound HTTP step to its Collection id and path, automation definition, step
 * ordinal, destination, header declarations, every referenced code file, and
 * each named secret's approval binding. Null when the step names a secret and
 * the secret bindings could not be read.
 */
export function computeHttpStepApprovalDigest(input: {
  readonly collectionId: string;
  readonly collectionPath: string;
  readonly automationId: string;
  readonly stepOrdinal: number;
  readonly step: Pick<AutomationHttpStep, "url" | "method" | "headers" | "secretHeaders">;
  readonly definitionDigest: string;
  readonly codeFileHashes: ReadonlyArray<{ readonly file: string; readonly sha256: string }>;
  readonly secretBindings: ReadonlyMap<string, string> | null;
}): string | null {
  const urlBinding =
    input.step.url.kind === "literal"
      ? ["literal", input.step.url.url]
      : ["secret", input.step.url.secret];
  const headerNames = input.step.headers
    .map((header) => header.name.toLowerCase())
    .sort(compareCodeUnits);
  const secretHeaderRefs = input.step.secretHeaders
    .map((header) => [header.name.toLowerCase(), header.secret, header.prefix ?? ""] as const)
    .sort((left, right) => compareCodeUnits(left[0], right[0]));
  const codeFiles = [...input.codeFileHashes]
    .map((entry) => [entry.file, entry.sha256] as const)
    .sort((left, right) => compareCodeUnits(left[0], right[0]));
  const fields = [
    input.collectionId,
    input.collectionPath,
    input.automationId,
    input.stepOrdinal,
    urlBinding,
    input.step.method,
    headerNames,
    secretHeaderRefs,
    input.definitionDigest,
    codeFiles,
  ];
  const secretNames = httpStepSecretNames(input.step);
  if (secretNames.length === 0) {
    return createHash("sha256")
      .update(JSON.stringify(["dohc-http-step-approval-v1", ...fields]))
      .digest("hex");
  }
  const bindings = input.secretBindings;
  if (bindings === null) return null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "dohc-http-step-approval-v2",
        ...fields,
        secretNames.map((name) => [name, bindings.get(name) ?? null]),
      ]),
    )
    .digest("hex");
}

/**
 * Defensively scrubs any unsealed secret value from a status/failure message
 * before persisting or returning it.
 */
export function sanitizeHttpFailureReason(reason: string, secrets: readonly string[]): string {
  return redactSecrets(reason, secrets).slice(0, 500);
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length > 0 && scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join("[redacted]");
    }
  }
  return scrubbed;
}

/** What to scrub for a secret destination URL: the URL, and its path parts and query values of 8 or more characters. */
export function secretUrlScrubValues(rawUrl: string): string[] {
  const url = URL.parse(rawUrl);
  const parts = url === null ? [] : [...url.pathname.split("/"), ...url.searchParams.values()];
  return [rawUrl, ...parts.filter((part) => part.length >= 8)];
}

export type HttpJsonValue =
  | string
  | number
  | boolean
  | null
  | HttpJsonValue[]
  | { [key: string]: HttpJsonValue };

/** Replaces every secret value found in a fetched JSON response. Keys stay as sent. */
export function scrubSecretsFromJson(
  value: HttpJsonValue,
  secrets: readonly string[],
): HttpJsonValue {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubSecretsFromJson(item, secrets));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubSecretsFromJson(item, secrets)]),
  );
}
