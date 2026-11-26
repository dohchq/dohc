export const MIN_SECRET_PASSPHRASE_LENGTH = 12;

export const NO_PASSPHRASE_YET =
  "No passphrase protects these files yet. On the computer that made them, open Settings › Sync and choose Protect with a passphrase.";
export const OTHER_KEY_PROTECTS =
  "Another computer protected this workspace's files with a different key, so this passphrase can't replace it. Unlock protected files with that computer's passphrase.";

export function validateSecretPassphrase(passphrase: string): string | null {
  if (!passphrase) return "Passphrase required to protect synced secrets.";
  if (passphrase.length < MIN_SECRET_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_SECRET_PASSPHRASE_LENGTH} characters.`;
  }
  return null;
}
