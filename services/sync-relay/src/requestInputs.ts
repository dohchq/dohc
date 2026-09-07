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
