import { z } from "zod";

export const WORKSPACE_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const MAX_WORKSPACE_SECRETS = 50;
export const MAX_HTTP_HEADER_SECRET_BYTES = 4096;
export const MAX_HTTP_URL_SECRET_BYTES = 2048;
export const MAX_SECRET_ALLOWED_HOSTS = 10;

const HEADER_VALUE_PATTERN = /^[\x20-\x7e]+$/u;
const RESERVED_LOCAL_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa"] as const;
const IPV4_LITERAL_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const NUMERIC_LABEL_PATTERN = /^(?:0x[0-9a-f]+|\d+)$/iu;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

function isIpLiteralHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/gu, "");
  if (bare.includes(":")) return true;
  if (IPV4_LITERAL_PATTERN.test(bare)) return true;
  const labels = bare.split(".");
  if (labels.length > 0 && labels.every((label) => NUMERIC_LABEL_PATTERN.test(label))) return true;
  return false;
}

function isAllowedPublicHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower.length === 0 ||
    lower.length > 253 ||
    lower.startsWith(".") ||
    lower.endsWith(".") ||
    lower.includes("..") ||
    !lower.includes(".")
  ) {
    return false;
  }
  if (lower.split(".").some((label) => label.length === 0 || label.length > 63)) return false;
  if (isIpLiteralHostname(lower)) return false;
  if (lower === "home.arpa" || RESERVED_LOCAL_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return false;
  }
  return true;
}

export function normalizeSecretAllowedHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 253 ||
    /[\s/:?#\\@*[\]\r\n\0]/u.test(trimmed) ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".")
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(`https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.port !== "") {
    return null;
  }
  const canonical = url.hostname.toLowerCase();
  return isAllowedPublicHost(canonical) ? canonical : null;
}

export function validateSecretHttpUrl(raw: string): URL | null {
  if (
    raw.length === 0 ||
    utf8ByteLength(raw) > MAX_HTTP_URL_SECRET_BYTES ||
    raw.includes("#") ||
    /[\t\r\n\0]/u.test(raw) ||
    raw.trim() !== raw
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const canonicalHost = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !isAllowedPublicHost(canonicalHost)
  ) {
    return null;
  }
  return url;
}

export function validateSecretHeaderValue(raw: string): boolean {
  return (
    raw.length > 0 &&
    utf8ByteLength(raw) <= MAX_HTTP_HEADER_SECRET_BYTES &&
    HEADER_VALUE_PATTERN.test(raw)
  );
}

export const WorkspaceSecretName = z
  .string()
  .regex(
    WORKSPACE_SECRET_NAME_PATTERN,
    "Secret names must start with A-Z and use only A-Z, 0-9, and _ (up to 64 characters).",
  );

export const WorkspaceSecretUsage = z.enum(["http-header", "http-url"]);
export type WorkspaceSecretUsage = z.output<typeof WorkspaceSecretUsage>;

const WorkspaceSecretAllowedHosts = z
  .array(z.string())
  .min(1, "Add at least one allowed host.")
  .max(MAX_SECRET_ALLOWED_HOSTS, `At most ${MAX_SECRET_ALLOWED_HOSTS} allowed hosts are allowed.`)
  .transform((hosts, ctx) => {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const raw of hosts) {
      const normalized = normalizeSecretAllowedHost(raw);
      if (normalized === null) {
        ctx.addIssue({
          code: "custom",
          message: `"${raw}" is not a valid public hostname.`,
        });
        return z.NEVER;
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(normalized);
      }
    }
    return unique.sort();
  });

export const WorkspaceSecretSummary = z
  .object({
    name: WorkspaceSecretName,
    usage: WorkspaceSecretUsage,
    allowedHosts: z.array(z.string()),
    generation: z.number().int().min(1),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
  })
  .strict();
export type WorkspaceSecretSummary = z.output<typeof WorkspaceSecretSummary>;

const WorkspaceSecretWriteMode = z.enum(["create", "replace"]);
export type WorkspaceSecretWriteMode = z.output<typeof WorkspaceSecretWriteMode>;

export const WorkspaceSecretWriteInput = z.discriminatedUnion("usage", [
  z
    .object({
      name: WorkspaceSecretName,
      mode: WorkspaceSecretWriteMode,
      usage: z.literal("http-header"),
      value: z
        .string()
        .refine(
          validateSecretHeaderValue,
          `Header secret must be printable ASCII up to ${MAX_HTTP_HEADER_SECRET_BYTES} bytes with no line breaks or tabs.`,
        ),
      allowedHosts: WorkspaceSecretAllowedHosts,
    })
    .strict(),
  z
    .object({
      name: WorkspaceSecretName,
      mode: WorkspaceSecretWriteMode,
      usage: z.literal("http-url"),
      value: z
        .string()
        .refine(
          (value) => validateSecretHttpUrl(value) !== null,
          `Webhook URL secret must be a public HTTPS URL (port 443, no IP or local host, up to ${MAX_HTTP_URL_SECRET_BYTES} bytes).`,
        ),
    })
    .strict(),
]);
export type WorkspaceSecretWriteInput = z.output<typeof WorkspaceSecretWriteInput>;

const WorkspaceSecretsStorageKind = z.enum(["local", "server"]);

export const WorkspaceSecretsState = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      storage: WorkspaceSecretsStorageKind,
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      storage: WorkspaceSecretsStorageKind,
      secrets: z.array(WorkspaceSecretSummary),
      limit: z.number().int().min(1),
    })
    .strict(),
]);
export type WorkspaceSecretsState = z.output<typeof WorkspaceSecretsState>;
