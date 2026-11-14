/** Only emit these after verifying both the credential and the requested scope. */
export const LINK_REFUSALS = {
  link_view_access: {
    status: 403,
    error: "This link gives View access. Ask the owner for a link with the access you need.",
  },
  link_comment_access: {
    status: 403,
    error: "This link gives Comment access. Ask the owner for an Edit link.",
  },
  link_full: {
    status: 403,
    error: "This link cannot take more people. Ask the owner for a new link.",
  },
  link_live_unavailable: { status: 503, error: "Live editing is unavailable. Try again later." },
  // A 503, so a share server or page from before this code treats it as `link_live_unavailable`.
  link_live_stopped: {
    status: 503,
    error: "Live editing of this file stopped on the server. Only its owner can start it again.",
  },
  link_unavailable: {
    status: 503,
    error: "This link can't be reached right now. Try again in a moment.",
  },
  link_read_rate_limited: {
    status: 429,
    error: "This link has reached its request limit. Try again later.",
  },
  app_collection_missing: {
    status: 410,
    error: "This app can't find its data. Ask the person who shared it with you.",
  },
} as const;

export type LinkRefusalCode = keyof typeof LINK_REFUSALS;

export function linkRefusalBody(code: LinkRefusalCode) {
  return { ok: false as const, error: LINK_REFUSALS[code].error, code };
}

export function parseLinkRefusal(value: unknown, status: number): LinkRefusalCode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join() !== "code,error,ok" ||
    record.ok !== false ||
    typeof record.code !== "string" ||
    !Object.hasOwn(LINK_REFUSALS, record.code)
  )
    return null;
  const code = record.code as LinkRefusalCode;
  return LINK_REFUSALS[code].status === status && record.error === LINK_REFUSALS[code].error
    ? code
    : null;
}
