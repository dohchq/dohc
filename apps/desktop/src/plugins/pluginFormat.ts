/**
 * The plugin surfaces' shared wording helpers. No Node imports: the uninstall
 * preflight builds its warning prose in main, and the details rail shows the
 * same measurements in the renderer, so one body has to reach both. A second
 * copy in the renderer would let the dialog and the rail disagree about the
 * size of the same directory.
 */

export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
}

const BYTES_PER_KB = 1_024;
const BYTES_PER_MB = 1_048_576;

/** The size in the unit that states it truly: 40 bytes reads as "40 bytes",
 * never as a rounded-up "0.1 MB" the user cannot check. */
export function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} ${plural(bytes, "byte")}`;
  if (bytes < BYTES_PER_MB) return `${Math.floor(bytes / BYTES_PER_KB)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}
