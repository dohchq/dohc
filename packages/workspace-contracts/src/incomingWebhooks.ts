import { z } from "zod";
import {
  formatInboxRecordMarkdown,
  INBOX_COLLECTION_PATH,
  safeInboxSlug,
  sanitizeInboxSingleLine,
} from "./inbox";

export const MAX_INCOMING_WEBHOOKS_PER_WORKSPACE = 20;
export const MAX_INCOMING_WEBHOOK_BODY_BYTES = 256 * 1024;
export const MAX_INCOMING_WEBHOOK_PENDING_COUNT = 100;
export const MAX_INCOMING_WEBHOOK_PENDING_BYTES = 4 * 1024 * 1024;
export const INCOMING_WEBHOOK_DAILY_DELIVERY_CAP = 500;
export const INCOMING_WEBHOOK_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const INCOMING_WEBHOOK_READ_TIMEOUT_MS = 10_000;
export const INCOMING_WEBHOOK_BURST_CAPACITY = 30;
export const INCOMING_WEBHOOK_REFILL_PER_SECOND = 0.5;
export const INCOMING_WEBHOOK_MAX_CHAIN_DEPTH = 4;
export const MAX_INCOMING_WEBHOOK_NAME_CHARS = 120;
// A website form webhook: anyone who reads the page can post, so each sender
// gets a small share and only the listed fields are kept.
export const INCOMING_WEBHOOK_FORM_SENDER_BURST = 5;
export const INCOMING_WEBHOOK_FORM_SENDER_DAILY = 20;
export const MAX_INCOMING_WEBHOOK_FORM_BODY_BYTES = 8 * 1024;
export const MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT = 20;
const MAX_INCOMING_WEBHOOK_FORM_FIELDS = 10;
const MAX_INCOMING_WEBHOOK_FORM_VALUE_CHARS = 500;
const MAX_INCOMING_WEBHOOK_COLLECTION_PATH_CHARS = 1024;
const MAX_INCOMING_WEBHOOK_HEADER_VALUE_CHARS = 512;

const INCOMING_WEBHOOK_ALLOWED_CONTENT_TYPES = [
  "application/json",
  "text/plain",
  "application/x-www-form-urlencoded",
] as const;

export type IncomingWebhookAllowedContentType =
  (typeof INCOMING_WEBHOOK_ALLOWED_CONTENT_TYPES)[number];

const INCOMING_WEBHOOK_ALLOWED_HEADERS = [
  "content-type",
  "idempotency-key",
  "x-webhook-delivery",
  "x-event-type",
  "x-github-event",
  "user-agent",
] as const;

export const INCOMING_WEBHOOK_DELIVERY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/u;
export const INCOMING_WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const INCOMING_WEBHOOK_ID_PATTERN = /^whk_[a-z0-9]{16,48}$/u;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export const IncomingWebhookId = z
  .string()
  .regex(INCOMING_WEBHOOK_ID_PATTERN, "Invalid webhook ID.");

const IncomingWebhookName = z
  .string()
  .transform((value) => sanitizeInboxSingleLine(value, MAX_INCOMING_WEBHOOK_NAME_CHARS))
  .refine((value) => value.length >= 1, "Enter a webhook name.")
  .refine(
    (value) => value.length <= MAX_INCOMING_WEBHOOK_NAME_CHARS,
    `Webhook name exceeds ${MAX_INCOMING_WEBHOOK_NAME_CHARS} characters.`,
  );

const IncomingWebhookCollectionPath = z
  .string()
  .min(1, "Choose a Collection path.")
  .max(
    MAX_INCOMING_WEBHOOK_COLLECTION_PATH_CHARS,
    `Collection path exceeds ${MAX_INCOMING_WEBHOOK_COLLECTION_PATH_CHARS} characters.`,
  )
  .refine((value) => !CONTROL_CHARS.test(value), "Collection path contains control characters.");

export const IncomingWebhookForm = z
  .object({
    fields: z
      .array(
        z
          .string()
          .regex(
            /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u,
            "Field names are letters, digits, - and _, starting with a letter.",
          ),
      )
      .min(1, "List at least one field.")
      .max(
        MAX_INCOMING_WEBHOOK_FORM_FIELDS,
        `List at most ${MAX_INCOMING_WEBHOOK_FORM_FIELDS} fields.`,
      )
      .refine((fields) => new Set(fields).size === fields.length, "List each field once."),
  })
  .strict();
export type IncomingWebhookForm = z.infer<typeof IncomingWebhookForm>;

export const IncomingWebhookDeliveryState = z.enum([
  "pending",
  "accepted",
  "settled",
  "failed",
  "paused",
]);
export type IncomingWebhookDeliveryState = z.infer<typeof IncomingWebhookDeliveryState>;

export const IncomingWebhookRecentDelivery = z
  .object({
    deliveryId: z.string().min(1).max(128),
    state: IncomingWebhookDeliveryState,
    contentType: z.string().min(1).max(128),
    receivedAtMs: z.number().int().nonnegative(),
    settledAtMs: z.number().int().nonnegative().nullable(),
    recordPath: z.string().min(1).max(4096).nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict();
export type IncomingWebhookRecentDelivery = z.infer<typeof IncomingWebhookRecentDelivery>;

export const IncomingWebhookSummary = z
  .object({
    webhookId: IncomingWebhookId,
    name: z.string().min(1).max(MAX_INCOMING_WEBHOOK_NAME_CHARS),
    collectionPath: IncomingWebhookCollectionPath,
    collectionId: z.string().min(1).max(256).nullable(),
    paused: z.boolean(),
    pauseReason: z.string().max(500).nullable(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    lastDeliveryAtMs: z.number().int().nonnegative().nullable(),
    form: IncomingWebhookForm.optional(),
    pendingCount: z.number().int().nonnegative(),
    recentDeliveries: z.array(IncomingWebhookRecentDelivery).max(20),
  })
  .strict();
export type IncomingWebhookSummary = z.infer<typeof IncomingWebhookSummary>;

export const IncomingWebhookCreateInput = z
  .object({
    name: IncomingWebhookName,
    collectionPath: IncomingWebhookCollectionPath.default(INBOX_COLLECTION_PATH),
    form: IncomingWebhookForm.optional(),
  })
  .strict();
export type IncomingWebhookCreateInput = z.infer<typeof IncomingWebhookCreateInput>;

export const IncomingWebhookUpdateInput = z
  .object({
    webhookId: IncomingWebhookId,
    name: IncomingWebhookName.optional(),
    paused: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.paused !== undefined,
    "Provide a new name or paused state.",
  );
export type IncomingWebhookUpdateInput = z.infer<typeof IncomingWebhookUpdateInput>;

export const IncomingWebhookCreatedResult = z
  .object({
    webhook: IncomingWebhookSummary,
    token: z.string().regex(INCOMING_WEBHOOK_TOKEN_PATTERN),
    endpointUrl: z.string().url(),
    webhooks: z.array(IncomingWebhookSummary),
    limit: z.number().int().positive(),
  })
  .strict();
export type IncomingWebhookCreatedResult = z.infer<typeof IncomingWebhookCreatedResult>;

export const AgentIncomingWebhookCreateInput = z
  .object({
    name: IncomingWebhookName,
    collection: IncomingWebhookCollectionPath.refine(
      (path) => /[^\s/\\]/u.test(path),
      "Choose a Collection folder, not the workspace root.",
    ),
    form: IncomingWebhookForm.optional(),
  })
  .strict();
export const AgentIncomingWebhookCreated = IncomingWebhookCreatedResult.pick({
  webhook: true,
  endpointUrl: true,
});

export const IncomingWebhooksState = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      serverOrigin: z.string().url(),
      webhooks: z.array(IncomingWebhookSummary),
      limit: z.number().int().positive(),
    })
    .strict(),
]);
export type IncomingWebhooksState = z.infer<typeof IncomingWebhooksState>;

export function parseIncomingWebhookContentType(
  rawHeader: string | null,
): IncomingWebhookAllowedContentType | null {
  if (!rawHeader) return null;
  const mediaType = rawHeader.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    mediaType === "application/json" ||
    mediaType === "text/plain" ||
    mediaType === "application/x-www-form-urlencoded"
  ) {
    return mediaType;
  }
  return null;
}

export function extractAllowedIncomingWebhookHeaders(
  headers: Pick<Headers, "get">,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of INCOMING_WEBHOOK_ALLOWED_HEADERS) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const cleaned = sanitizeInboxSingleLine(raw, MAX_INCOMING_WEBHOOK_HEADER_VALUE_CHARS);
    if (cleaned.length > 0) {
      result[name] = cleaned;
    }
  }
  return result;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Keeps only a form webhook's listed fields, so the record, its title, and
 * whatever reads them never see other text a sender added. Extra fields, such
 * as a named submit button, are dropped rather than refused.
 */
export function keepIncomingWebhookFormFields(
  form: IncomingWebhookForm,
  bodyText: string,
): { readonly ok: true; readonly body: string } | { readonly ok: false; readonly error: string } {
  const sent = new URLSearchParams(bodyText);
  const kept = new URLSearchParams();
  for (const name of form.fields) {
    const values = sent.getAll(name);
    if (values.length > 1) return { ok: false, error: `field ${name} appears more than once` };
    const value = values[0]?.trim();
    if (!value) continue;
    if (value.length > MAX_INCOMING_WEBHOOK_FORM_VALUE_CHARS) {
      return {
        ok: false,
        error: `field ${name} exceeds ${MAX_INCOMING_WEBHOOK_FORM_VALUE_CHARS} characters`,
      };
    }
    if (name === "email" && !EMAIL_SHAPE.test(value)) {
      return { ok: false, error: "field email is not an email address" };
    }
    kept.append(name, value);
  }
  const body = kept.toString();
  if (body === "") {
    return { ok: false, error: `send at least one of these fields: ${form.fields.join(", ")}` };
  }
  return { ok: true, body };
}

const TITLE_KEYS = ["title", "subject", "summary", "event", "name", "email"];

function titleFromPayload(
  webhookName: string,
  contentType: IncomingWebhookAllowedContentType,
  headers: Readonly<Record<string, string>>,
  bodyText: string,
): string {
  const eventHeader = headers["x-github-event"] ?? headers["x-event-type"];
  if (contentType === "application/json") {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        for (const key of TITLE_KEYS) {
          if (typeof record[key] === "string" && record[key].trim().length > 0) {
            return sanitizeInboxSingleLine(`${webhookName}: ${record[key]}`);
          }
        }
      }
    } catch {
      // Unparseable JSON is still preserved verbatim inside the quarantined code block.
    }
  } else if (contentType === "application/x-www-form-urlencoded") {
    try {
      const params = new URLSearchParams(bodyText);
      for (const key of TITLE_KEYS) {
        const value = params.get(key);
        if (value && value.trim().length > 0) {
          return sanitizeInboxSingleLine(`${webhookName}: ${value}`);
        }
      }
    } catch {
      // Malformed form payload stays quarantined as text.
    }
  } else {
    const firstLine = bodyText
      .split(/\r?\n/u)
      .map((line) => sanitizeInboxSingleLine(line, 80))
      .find((line) => line.length > 0);
    if (firstLine) {
      return sanitizeInboxSingleLine(`${webhookName}: ${firstLine}`);
    }
  }
  if (eventHeader) {
    return sanitizeInboxSingleLine(`${webhookName}: ${eventHeader}`);
  }
  return sanitizeInboxSingleLine(webhookName) || "Webhook delivery";
}

function fenceInfoForContentType(contentType: IncomingWebhookAllowedContentType): string {
  if (contentType === "application/json") return "json";
  return "text";
}

function incomingWebhookRecordFilename(
  deliveryId: string,
  title: string,
  receivedAtMs: number,
): string {
  const datePrefix = new Date(receivedAtMs).toISOString().slice(0, 10);
  const slug = safeInboxSlug(title, "webhook", 44);
  const shortId = safeInboxSlug(deliveryId.replace(/^whd_/u, "").slice(0, 12), "delivery", 12);
  return `${datePrefix}-${slug}-${shortId}.md`;
}

export function formatIncomingWebhookRecord(input: {
  readonly recordId: string;
  readonly deliveryId: string;
  readonly webhookName: string;
  readonly contentType: IncomingWebhookAllowedContentType;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
  readonly receivedAtMs: number;
}): { readonly title: string; readonly filename: string; readonly markdown: string } {
  const receivedIso = new Date(input.receivedAtMs).toISOString();
  const title = titleFromPayload(
    input.webhookName,
    input.contentType,
    input.headers,
    input.bodyText,
  );
  const filename = incomingWebhookRecordFilename(input.deliveryId, title, input.receivedAtMs);

  const headerLines = Object.entries(input.headers)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, value]) =>
        `${key}: ${sanitizeInboxSingleLine(value, MAX_INCOMING_WEBHOOK_HEADER_VALUE_CHARS)}`,
    );

  const deliveryHeader =
    headerLines.length > 0
      ? `Delivery: ${sanitizeInboxSingleLine(input.deliveryId, 128)}\n${headerLines.join("\n")}`
      : `Delivery: ${sanitizeInboxSingleLine(input.deliveryId, 128)}`;

  const markdown = formatInboxRecordMarkdown({
    recordId: input.recordId,
    title,
    source: "webhook",
    kind: "webhook",
    receivedIso,
    status: "New",
    body: input.bodyText,
    quarantineBodyHeader: deliveryHeader,
    quarantineBodyAsCodeBlock: true,
    quarantineBodyInfo: fenceInfoForContentType(input.contentType),
    preserveVerbatimBody: true,
    // An accepted 256 KiB wire payload containing invalid UTF-8 octets can expand up to 3x as U+FFFD.
    maxBodyBytes: MAX_INCOMING_WEBHOOK_BODY_BYTES * 3,
  });
  return { title, filename, markdown };
}
