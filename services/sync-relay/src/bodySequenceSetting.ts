export const BODY_SEQUENCE_SETTING = "DOHC_RELAY_BODY_SEQUENCE_NOTES";

/**
 * Whether this relay admits notes whose body is one sequence. Off unless the setting is `1`. The
 * relay and each validation worker it starts read the same setting.
 */
export function bodySequenceNotesAdmitted(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env[BODY_SEQUENCE_SETTING];
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new TypeError(`${BODY_SEQUENCE_SETTING} must be 0 or 1.`);
}
