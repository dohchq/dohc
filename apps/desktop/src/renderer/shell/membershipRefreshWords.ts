import { joinedByAnother } from "../../ipc/joinedAccountWords";

/**
 * What a joined workspace says while an account other than the one that joined is signed in.
 * The copy stays open and readable; what fails is every read and write with the server.
 */
export function otherAccountWords(
  workspaceName: string,
  signedInEmail: string | null,
): { title: string; message: string } {
  return { title: `dohc could not sync ${workspaceName}`, message: joinedByAnother(signedInEmail) };
}

// How a joined workspace says its refresh failed, in workspace words. An
// account other than the one that joined gets the cause and Switch account.
export function membershipRefreshFailure(input: {
  workspaceName: string;
  signedInEmail: string | null;
  error: unknown;
}): { title: string; message: string; switchAccount: true } | { fallback: string } {
  const unauthorized =
    typeof input.error === "object" &&
    input.error !== null &&
    (input.error as { errorKind?: unknown }).errorKind === "unauthorized";
  if (!unauthorized) return { fallback: `dohc could not refresh ${input.workspaceName}.` };
  return { ...otherAccountWords(input.workspaceName, input.signedInEmail), switchAccount: true };
}
