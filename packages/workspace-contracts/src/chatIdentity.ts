import { z } from "zod";

export const MAX_PREFERRED_NAME_LENGTH = 80;

// Control characters, Unicode formatting controls (including bidi overrides
// and isolates), and explicit line/paragraph separators can spoof or split a
// visible author label even though the underlying authorization id is safe.
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The human-readable owner name used by chat authorship surfaces. This value is
 * display-only: authorization continues to use opaque, verified user ids.
 */
export const PreferredName = z
  .string()
  .trim()
  .min(1, "Enter the name your agent should use.")
  .max(MAX_PREFERRED_NAME_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: "Names cannot contain control characters.",
  });

export type PreferredName = z.infer<typeof PreferredName>;

export function preferredNameFromInput(value: string): PreferredName | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : PreferredName.parse(trimmed);
}

/**
 * Agent rows store the owner's raw display name. Every presentation surface
 * calls this helper so old already-suffixed rows do not become "agent's agent".
 */
export function agentDisplayLabel(ownerDisplayName: string): string {
  const owner = ownerDisplayName.trim();
  if (/['’]s agent$/i.test(owner)) return owner;
  return `${owner}'s agent`;
}
