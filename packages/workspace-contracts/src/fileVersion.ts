/** Version check for workspace files people and agents edit. */
export function fileVersionError(version: unknown, file: string): string | null {
  if (version === undefined || version === 1) return null;
  if (typeof version === "number" && Number.isSafeInteger(version) && version > 1) {
    return `${file} uses a newer version. Update dohc to read this file.`;
  }
  return `${file} has an invalid version. Set version to 1.`;
}
