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

/**
 * Deterministic SHA-256 digest binding an owner's Desktop UI approval of one
 * outbound HTTP step to its Collection id and path, automation definition, step
 * ordinal, destination, header declarations, and every referenced code file.
 */
export function computeHttpStepApprovalDigest(input: {
  readonly collectionId: string;
  readonly collectionPath: string;
  readonly automationId: string;
  readonly stepOrdinal: number;
  readonly step: Pick<AutomationHttpStep, "url" | "method" | "headers" | "secretHeaders">;
  readonly definitionDigest: string;
  readonly codeFileHashes: ReadonlyArray<{ readonly file: string; readonly sha256: string }>;
}): string {
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
  return createHash("sha256")
    .update(
      JSON.stringify([
        "dohc-http-step-approval-v1",
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
      ]),
    )
    .digest("hex");
}

/**
 * Defensively scrubs any unsealed secret value from a status/failure message
 * before persisting or returning it.
 */
export function sanitizeHttpFailureReason(reason: string, secrets: readonly string[]): string {
  let scrubbed = reason;
  for (const secret of secrets) {
    if (secret.length > 0 && scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join("[redacted]");
    }
  }
  return scrubbed.slice(0, 500);
}
