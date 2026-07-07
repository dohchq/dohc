// Passphrase floor for the secret-key envelope enrollment (0P-D). The relay
// only ever sees the scrypt-wrapped envelope, so the passphrase is the sole
// factor protecting synced secrets — refuse a trivially weak one at the
// enrollment boundary (main process), which a renderer check cannot enforce.

export const MIN_SECRET_PASSPHRASE_LENGTH = 8;

/**
 * Returns a user-facing error message when the passphrase is unusable for
 * protecting synced secrets, or `null` when it is acceptable.
 */
export function validateSecretPassphrase(passphrase: string): string | null {
  if (!passphrase) return "Passphrase required to protect synced secrets.";
  if (passphrase.length < MIN_SECRET_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_SECRET_PASSPHRASE_LENGTH} characters.`;
  }
  return null;
}
