import { normalizeShareDiscussionDisplayName } from "@dohc/security-contract/share-discussion";

export const ACCOUNT_NAME_LOOKUP_DEADLINE_MS = 1_000;

export type LookupUserDisplayName = (
  userId: string,
) => Promise<string | null> | string | null;

// The account's display name, or null when it has none or the lookup fails
// or runs past its deadline.
export async function accountDisplayName(
  lookupUserDisplayName:
    | LookupUserDisplayName
    | undefined,
  userId: string,
): Promise<string | null> {
  if (!lookupUserDisplayName) return null;

  let lookup: Promise<string | null>;
  try {
    lookup = Promise.resolve(lookupUserDisplayName(userId));
  } catch {
    return null;
  }

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadlineResult = new Promise<null>((resolve) => {
      deadline = setTimeout(
        () => resolve(null),
        ACCOUNT_NAME_LOOKUP_DEADLINE_MS,
      );
      deadline.unref();
    });
    const normalized = normalizeShareDiscussionDisplayName(await Promise.race([lookup, deadlineResult]));
    return normalized.ok ? normalized.value : null;
  } catch {
    return null;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
