// What the join page and share-web's join routes say to each other.

export const JOIN_API = {preview: "/api/members/join-preview", join: "/api/members/join"} as const;

/** Why a join did not go through, in the words the page picks from. */
export type JoinRefusal = "signed_out" | "link_off" | "removed" | "full" | "unavailable";
export const JOIN_REFUSAL_STATUS: Record<JoinRefusal, number> = {
  signed_out: 401, link_off: 404, removed: 403, full: 409, unavailable: 503,
};

/** An invite-link token: the base64url secret after `/join#`. */
export function isJoinToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,512}$/.test(value);
}
