import { z } from "zod";

export const MAX_PREFERRED_NAME_LENGTH = 80;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

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
