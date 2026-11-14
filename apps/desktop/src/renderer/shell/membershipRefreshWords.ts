import { joinedByAnother } from "../settings/MembersSettings";

// How a joined workspace says its refresh failed, in workspace words. An
// account other than the one that joined gets the cause and Switch account.
// dohc keeps the joined account's id, not its email, so it names only the
// account signed in now.
export function membershipRefreshFailure(input: { workspaceName: string; signedInEmail: string | null; error: unknown }):
  { title: string; message: string; switchAccount: true } | { fallback: string } {
  const unauthorized = typeof input.error === "object" && input.error !== null &&
    (input.error as { errorKind?: unknown }).errorKind === "unauthorized";
  if (!unauthorized) return { fallback: `dohc could not refresh ${input.workspaceName}.` };
  return {
    title: `dohc could not refresh ${input.workspaceName}`,
    message: `${joinedByAnother(input.signedInEmail)} dohc does not record that account's email.`,
    switchAccount: true,
  };
}
