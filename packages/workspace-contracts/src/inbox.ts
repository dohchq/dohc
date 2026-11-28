import { dump } from "js-yaml";
import { z } from "zod";
import { HistoryOperationId } from "./historyOperation";

export const INBOX_COLLECTION_PATH = "Inbox";
export const INBOX_SCHEMA_PATH = `${INBOX_COLLECTION_PATH}/collection.yaml`;
export const INBOX_FILES_DIR = `${INBOX_COLLECTION_PATH}/files`;

export const INBOX_STATUSES = ["New", "Filed", "Archived"] as const;
export const INBOX_SOURCES = ["drop", "capture", "webhook", "cli", "agent"] as const;
export const INBOX_KINDS = ["note", "file", "image", "link", "webhook"] as const;

export const MAX_INBOX_TITLE_CHARS = 240;
const MAX_INBOX_URL_CHARS = 2048;
export const MAX_INBOX_BODY_BYTES = 256 * 1024;
export const MAX_INBOX_PATH_CHARS = 4096;
export const MAX_INBOX_MOVE_ATTACHMENTS = 5000;
export const MAX_INBOX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INBOX_PASTED_IMAGES = 10;
export const MAX_INBOX_LIST_LIMIT = 100;
export const DEFAULT_INBOX_LIST_LIMIT = 50;

export const INBOX_PASTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type InboxStatus = (typeof INBOX_STATUSES)[number];
export type InboxSource = (typeof INBOX_SOURCES)[number];
export type InboxKind = (typeof INBOX_KINDS)[number];
export type InboxPastedImageMimeType = (typeof INBOX_PASTED_IMAGE_MIME_TYPES)[number];

export const INBOX_COLLECTION_YAML = `version: 1
name: Inbox
description: Captured notes, links, files, and webhooks waiting to be filed.
fields:
  Title:
    type: text
  Status:
    type: select
    options:
      - New
      - Filed
      - Archived
    colors:
      New: blue
      Filed: teal
      Archived: gray
  Source:
    type: select
    options:
      - drop
      - capture
      - webhook
      - cli
      - agent
  Kind:
    type: select
    options:
      - note
      - file
      - image
      - link
      - webhook
  Received:
    type: date
  URL:
    type: url
  Attachment:
    type: text
  Filed to:
    type: text
views:
  - name: Table
    kind: table
    sort:
      - field: Received
        direction: desc
  - name: By status
    kind: board
    groupBy: Status
    sort:
      - field: Received
        direction: desc
`;

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;

export function sanitizeInboxSingleLine(value: string, maxChars = MAX_INBOX_TITLE_CHARS): string {
  const cleaned = value.replace(CONTROL_CHARS, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trimEnd();
}

export function validateInboxUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter a link starting with http:// or https://.");
  if (trimmed.length > MAX_INBOX_URL_CHARS) {
    throw new Error(`Link exceeds ${MAX_INBOX_URL_CHARS} characters. Use a shorter URL.`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new Error("Link contains control characters. Remove them and try again.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Link is not a valid URL. Use an http:// or https:// address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// links can be saved in Inbox.");
  }
  if (parsed.href.length > MAX_INBOX_URL_CHARS) {
    throw new Error(`Link exceeds ${MAX_INBOX_URL_CHARS} characters. Use a shorter URL.`);
  }
  return parsed.href;
}

export function defaultInboxCaptureTitle(input: {
  title?: string;
  url?: string;
  body?: string;
  fallback?: string;
}): string {
  const explicit = input.title ? sanitizeInboxSingleLine(input.title) : "";
  if (explicit) return explicit;
  if (input.url) {
    try {
      const parsed = new URL(input.url);
      const pathPart = parsed.pathname.replace(/\/+$/u, "");
      return sanitizeInboxSingleLine(`${parsed.hostname}${pathPart}`) || parsed.hostname;
    } catch {
      // Validated separately.
    }
  }
  const firstLine = (input.body ?? "")
    .split(/\r?\n/u)
    .map((line) => sanitizeInboxSingleLine(line, 80))
    .find((line) => line.length > 0);
  return firstLine || input.fallback || "Captured item";
}

export function safeInboxSlug(seed: string, fallback = "item", maxChars = 60): string {
  const ascii = seed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  let slug = (ascii || fallback).slice(0, maxChars).replace(/^-+|-+$/gu, "");
  if (!slug) slug = fallback;
  if (WINDOWS_RESERVED_NAME.test(slug)) slug = `item-${slug}`;
  return slug;
}

export function safeCodeFence(
  content: string,
  info = "",
  options?: { readonly preserveVerbatim?: boolean },
): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/gu)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  const safeInfo = info.replace(/[^a-zA-Z0-9_+-]/gu, "");
  const body = options?.preserveVerbatim
    ? content
    : content.replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n");
  return `${fence}${safeInfo}\n${body}${body.endsWith("\n") ? "" : "\n"}${fence}`;
}

export function isInboxRecordPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length === 2 &&
    parts[0] === INBOX_COLLECTION_PATH &&
    parts[1]!.length > 3 &&
    /\.md$/iu.test(parts[1]!)
  );
}

export function isInboxAttachmentPath(path: string): boolean {
  if (!path.startsWith(`${INBOX_FILES_DIR}/`)) return false;
  const rest = path.slice(INBOX_FILES_DIR.length + 1);
  return (
    rest.length > 0 &&
    !rest.split("/").some((segment) => !segment || segment === "." || segment === "..")
  );
}

function escapeMarkdownLabel(value: string): string {
  return sanitizeInboxSingleLine(value, 160).replace(/[\\[\]()`]/gu, "\\$&") || "attachment";
}

function encodeMarkdownTarget(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/\(/gu, "%28").replace(/\)/gu, "%29"))
    .join("/");
}

function escapeMarkdownUrlTarget(url: string): string {
  return url.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
}

export interface FormatInboxRecordInput {
  recordId: string;
  title: string;
  source: InboxSource;
  kind: InboxKind;
  receivedIso: string;
  status?: InboxStatus;
  url?: string;
  attachment?: string;
  attachments?: readonly { path: string; isImage: boolean; label?: string }[];
  filedTo?: string;
  body?: string;
  quarantineBodyAsCodeBlock?: boolean;
  quarantineBodyInfo?: string;
  quarantineBodyHeader?: string;
  preserveVerbatimBody?: boolean;
  maxBodyBytes?: number;
}

export function formatInboxRecordMarkdown(input: FormatInboxRecordInput): string {
  const title = sanitizeInboxSingleLine(input.title, MAX_INBOX_TITLE_CHARS) || "Captured item";
  const status: InboxStatus = input.status ?? "New";
  const receivedDate = /^\d{4}-\d{2}-\d{2}/u.test(input.receivedIso)
    ? input.receivedIso.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const frontmatter: Record<string, string> = {
    id: sanitizeInboxSingleLine(input.recordId, 128),
    Title: title,
    Status: status,
    Source: input.source,
    Kind: input.kind,
    Received: receivedDate,
  };
  if (input.url !== undefined && input.url.trim() !== "") {
    frontmatter.URL = validateInboxUrl(input.url);
  }
  const primaryAttachment = input.attachment ?? input.attachments?.[0]?.path;
  if (primaryAttachment !== undefined && primaryAttachment.trim() !== "") {
    if (!isInboxAttachmentPath(primaryAttachment)) {
      throw new Error("Inbox attachment path must stay inside Inbox/files/.");
    }
    frontmatter.Attachment = primaryAttachment;
  }
  if (input.filedTo !== undefined && input.filedTo.trim() !== "") {
    frontmatter["Filed to"] = sanitizeInboxSingleLine(input.filedTo, 512);
  }

  const yaml = dump(frontmatter, { lineWidth: -1, sortKeys: false, noRefs: true });
  const sections: string[] = [];

  if (frontmatter.URL) {
    sections.push(
      `[${escapeMarkdownLabel(frontmatter.URL)}](${escapeMarkdownUrlTarget(frontmatter.URL)})`,
    );
  }

  const attachmentEntries =
    input.attachments && input.attachments.length > 0
      ? input.attachments
      : primaryAttachment
        ? [
            {
              path: primaryAttachment,
              isImage: input.kind === "image",
              label: primaryAttachment.slice(INBOX_FILES_DIR.length + 1),
            },
          ]
        : [];

  for (const item of attachmentEntries) {
    if (!isInboxAttachmentPath(item.path)) {
      throw new Error("Inbox attachment path must stay inside Inbox/files/.");
    }
    const relFromInbox = item.path.slice(INBOX_COLLECTION_PATH.length + 1);
    const encoded = encodeMarkdownTarget(relFromInbox);
    const label = escapeMarkdownLabel(item.label ?? relFromInbox.split("/").at(-1) ?? "file");
    sections.push(item.isImage ? `![${label}](${encoded})` : `[${label}](${encoded})`);
  }

  const rawBody = input.body ?? "";
  const cleanedBody = input.preserveVerbatimBody
    ? rawBody
    : rawBody.replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n");
  const maxBodyBytes = input.maxBodyBytes ?? MAX_INBOX_BODY_BYTES;
  if (Buffer.byteLength(cleanedBody, "utf8") > maxBodyBytes) {
    throw new Error(`Inbox body exceeds ${maxBodyBytes} bytes. Shorten the text.`);
  }
  const cleanedHeader = (input.quarantineBodyHeader ?? "")
    .replace(/\u0000/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trimEnd();
  if (input.quarantineBodyAsCodeBlock && (cleanedHeader.length > 0 || cleanedBody.length > 0)) {
    const fencedContent =
      cleanedHeader.length > 0 && cleanedBody.length > 0
        ? `${cleanedHeader}\n\n${cleanedBody}`
        : cleanedHeader.length > 0
          ? cleanedHeader
          : cleanedBody;
    sections.push(
      safeCodeFence(fencedContent, input.quarantineBodyInfo ?? "text", {
        preserveVerbatim: input.preserveVerbatimBody === true,
      }),
    );
  } else if (cleanedBody.trim().length > 0) {
    sections.push(cleanedBody.trimEnd());
  }

  const bodyBlock = sections.length > 0 ? `\n${sections.join("\n\n")}\n` : "";
  return `---\n${yaml}---\n${bodyBlock}`;
}

export const InboxStatusSchema = z.enum(INBOX_STATUSES);
const InboxSourceSchema = z.enum(INBOX_SOURCES);
export const InboxKindSchema = z.enum(INBOX_KINDS);

export const InboxItemSummary = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    title: z.string(),
    status: InboxStatusSchema.nullable(),
    source: InboxSourceSchema.nullable(),
    kind: InboxKindSchema.nullable(),
    received: z.string().nullable(),
    url: z.string().nullable().optional(),
    attachment: z.string().nullable().optional(),
    filedTo: z.string().nullable().optional(),
  })
  .strict();
export type InboxItemSummary = z.infer<typeof InboxItemSummary>;

export const InboxListInput = z
  .object({
    status: InboxStatusSchema.optional(),
    limit: z.number().int().min(1).max(MAX_INBOX_LIST_LIMIT).optional(),
  })
  .strict();
export type InboxListInput = z.infer<typeof InboxListInput>;

export const InboxListResult = z
  .object({
    exists: z.boolean(),
    items: z.array(InboxItemSummary),
    hasMore: z.boolean(),
  })
  .strict();
export type InboxListResult = z.infer<typeof InboxListResult>;

export const InboxAddInput = z
  .object({
    title: z
      .string()
      .max(MAX_INBOX_TITLE_CHARS * 2)
      .optional(),
    body: z.string().max(MAX_INBOX_BODY_BYTES).optional(),
    url: z.string().max(MAX_INBOX_URL_CHARS).optional(),
    kind: InboxKindSchema.optional(),
  })
  .strict();
export type InboxAddInput = z.infer<typeof InboxAddInput>;

export const InboxAddResult = z
  .object({
    path: z.string().min(1),
    recordId: z.string().min(1),
    title: z.string().min(1),
    createdInbox: z.boolean(),
  })
  .strict();
export type InboxAddResult = z.infer<typeof InboxAddResult>;

export const InboxAddSocketResult = z.union([
  z
    .object({ ok: z.literal(true) })
    .merge(InboxAddResult)
    .strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
]);
export type InboxAddSocketResult = z.infer<typeof InboxAddSocketResult>;

export const InboxArchiveInput = z
  .object({
    item: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
  })
  .strict();
export type InboxArchiveInput = z.infer<typeof InboxArchiveInput>;

export const InboxArchiveResult = z
  .object({
    path: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    previousStatus: z.string().nullable(),
    changed: z.boolean(),
  })
  .strict();
export type InboxArchiveResult = z.infer<typeof InboxArchiveResult>;

export const InboxArchiveSocketResult = z.union([
  z
    .object({ ok: z.literal(true) })
    .merge(InboxArchiveResult)
    .strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
]);
export type InboxArchiveSocketResult = z.infer<typeof InboxArchiveSocketResult>;

export const InboxMoveInput = z
  .object({
    item: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    targetFolder: z.string().max(MAX_INBOX_PATH_CHARS),
  })
  .strict();
export type InboxMoveInput = z.infer<typeof InboxMoveInput>;

const InboxMovedAttachment = z
  .object({
    fromPath: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    toPath: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    operationId: HistoryOperationId.optional(),
  })
  .strict();

export const InboxMoveResult = z
  .object({
    fromPath: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    toPath: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    operationId: HistoryOperationId.optional(),
    attachments: z.array(InboxMovedAttachment).max(MAX_INBOX_MOVE_ATTACHMENTS),
  })
  .strict();
export type InboxMoveResult = z.infer<typeof InboxMoveResult>;

export const InboxMoveSocketResult = z.union([
  z
    .object({ ok: z.literal(true) })
    .merge(InboxMoveResult)
    .strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
]);
export type InboxMoveSocketResult = z.infer<typeof InboxMoveSocketResult>;

export const InboxPastedImage = z
  .object({
    name: z.string().min(1).max(200),
    mimeType: z.enum(INBOX_PASTED_IMAGE_MIME_TYPES),
    bytesBase64: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_INBOX_IMAGE_BYTES / 3) * 4 + 8),
  })
  .strict();
export type InboxPastedImage = z.infer<typeof InboxPastedImage>;

export const InboxSkippedFile = z
  .object({
    name: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type InboxSkippedFile = z.infer<typeof InboxSkippedFile>;

export const InboxCapturedItem = z
  .object({
    path: z.string().min(1),
    recordId: z.string().min(1),
    title: z.string().min(1),
    attachments: z.array(z.string().min(1)),
  })
  .strict();
export type InboxCapturedItem = z.infer<typeof InboxCapturedItem>;

export const InboxCaptureFilesInput = z
  .object({
    droppedPaths: z.array(z.string().min(1)).max(100).optional(),
    pick: z.boolean().optional(),
    pastedImages: z.array(InboxPastedImage).max(MAX_INBOX_PASTED_IMAGES).optional(),
    title: z
      .string()
      .max(MAX_INBOX_TITLE_CHARS * 2)
      .optional(),
    body: z.string().max(MAX_INBOX_BODY_BYTES).optional(),
    url: z.string().max(MAX_INBOX_URL_CHARS).optional(),
  })
  .strict();
export type InboxCaptureFilesInput = z.infer<typeof InboxCaptureFilesInput>;

export const InboxCaptureFilesResult = z
  .object({
    items: z.array(InboxCapturedItem),
    skipped: z.number().int().nonnegative(),
    skippedSources: z.array(InboxSkippedFile),
    createdInbox: z.boolean(),
  })
  .strict();
export type InboxCaptureFilesResult = z.infer<typeof InboxCaptureFilesResult>;

export const InboxUndoArchiveInput = z
  .object({
    item: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    previousStatus: z.string().max(120).nullable(),
  })
  .strict();
export type InboxUndoArchiveInput = z.infer<typeof InboxUndoArchiveInput>;

export const InboxUndoArchiveResult = z
  .object({
    path: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    restored: z.boolean(),
    currentStatus: z.string().nullable(),
  })
  .strict();
export type InboxUndoArchiveResult = z.infer<typeof InboxUndoArchiveResult>;

export const InboxUndoMoveInput = z
  .object({
    fromPath: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    toPath: z.string().min(1).max(MAX_INBOX_PATH_CHARS),
    operationId: HistoryOperationId.optional(),
    attachments: z.array(InboxMovedAttachment).max(MAX_INBOX_MOVE_ATTACHMENTS),
  })
  .strict();
export type InboxUndoMoveInput = z.infer<typeof InboxUndoMoveInput>;

export const InboxUndoMoveResult = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type InboxUndoMoveResult = z.infer<typeof InboxUndoMoveResult>;
