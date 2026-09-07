import { asRecord } from "@dohc/workspace-core";
import { SHA256_HEX_PATTERN } from "@dohc/security-contract/wire-patterns";
import { MAX_LOG_PAGE_SIZE, MAX_SHARE_ID_CHARS } from "./wireLimits";
import { badRequest } from "./errors";

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

// C0 controls (including NUL) and DEL. Rejected in every parsed string field:
// the presence scope key joins workspaceId/topic with NUL separators, so an
// embedded NUL in one component could collide with a different workspace's
// scope (workspace "a" + topic "b\0c" vs workspace "a\0b" + topic "c") and
// leak presence across tenants. Refusing control characters at the parse
// boundary makes the composite keys unambiguous.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function parseString(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw badRequest(`${name} must be a non-empty trimmed string`);
  }
  if (value.length > maxChars) throw badRequest(`${name} is too long`);
  if (CONTROL_CHARS.test(value)) {
    throw badRequest(`${name} must not contain control characters`);
  }
  return value;
}

export function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) throw badRequest("since must be a non-negative integer");
  return cursor;
}

const CURSOR_MAX_CHARS = 1_024;
const MAX_WORKSPACE_ID_CHARS = 256;

type CursorField = "id" | "messageId" | "ms";

// An opaque page cursor: base64url JSON with a version and the named fields,
// nothing more. Ids are share-id shaped, message ids are bounded text, and
// times are non-negative safe integers.
export function cursorCodec<Cursor extends object>(
  fields: { [Key in keyof Cursor]: CursorField },
  label: string,
): {
  encode: (cursor: Cursor) => string;
  decode: (value: string | null) => Cursor | undefined;
} {
  const names = Object.keys(fields).sort();
  const expectedKeys = [...names, "version"].sort().join("\0");
  return {
    encode: (cursor) =>
      Buffer.from(JSON.stringify({ version: 1, ...cursor }), "utf8").toString("base64url"),
    decode: (value) => {
      if (value === null) return undefined;
      const invalid = () => badRequest(`${label} is invalid`);
      if (value.length === 0 || value.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw invalid();
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      } catch {
        throw invalid();
      }
      const row = asRecord(decoded);
      if (!row || Object.keys(row).sort().join("\0") !== expectedKeys || row.version !== 1) {
        throw invalid();
      }
      const cursor: Record<string, string | number> = {};
      for (const name of names) {
        const field = row[name];
        const kind = fields[name as keyof Cursor];
        if (kind === "ms") {
          if (!Number.isSafeInteger(field) || Number(field) < 0) throw invalid();
          cursor[name] = Number(field);
        } else if (kind === "messageId") {
          if (typeof field !== "string" || field.length === 0 || field.length > 512) {
            throw invalid();
          }
          cursor[name] = field;
        } else {
          if (
            typeof field !== "string" ||
            field.length === 0 ||
            field.length > MAX_SHARE_ID_CHARS ||
            !/^[a-z0-9][a-z0-9-]*$/u.test(field)
          ) {
            throw invalid();
          }
          cursor[name] = field;
        }
      }
      return cursor as unknown as Cursor;
    },
  };
}

export function parseWorkspaceId(value: unknown): string {
  const workspaceId = parseString(value, "workspaceId", MAX_WORKSPACE_ID_CHARS);
  // Reserved: "/sync/shares/..." is the share-route namespace. A
  // workspace with this id could never be addressed, so refuse the claim
  // rather than strand it.
  if (workspaceId === "shares") throw badRequest("workspaceId is reserved");
  return workspaceId;
}

const DEFAULT_LOG_PAGE_SIZE = 100;

export function parseLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_LOG_PAGE_SIZE;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive integer");
  return Math.min(limit, MAX_LOG_PAGE_SIZE);
}

export function assertSha256(value: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) throw badRequest("sha256 must be 64 lowercase hex characters");
}
