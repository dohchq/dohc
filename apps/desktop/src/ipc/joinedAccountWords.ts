// dohc keeps the joined account's id, not its email, so it can name only the
// account signed in now.
export function joinedByAnother(email: string | null | undefined): string {
  return email
    ? `This computer is signed in as ${email}, not the account the owner invited.`
    : "This computer is signed in to a different account than the one the owner invited.";
}

/** Why main refuses a joined workspace's write or read under another account. */
export const JOINED_BY_ANOTHER_ACCOUNT = joinedByAnother(null);

/** Whether a failure is main's refusal of an account other than the one that joined. */
export function isJoinedByAnotherAccount(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text.includes(JOINED_BY_ANOTHER_ACCOUNT);
}
