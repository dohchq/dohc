/** Version check for workspace files people and agents edit. */
export function fileVersionError(version: unknown, file: string): string | null {
  const reason = fileVersionReason(version);
  if (reason === null) return null;
  if (reason === "unsupported-version") {
    return `${file} uses a newer version. Update dohc to read this file.`;
  }
  return `${file} has an invalid version. Set version to 1.`;
}

export function fileVersionReason(version: unknown): "unsupported-version" | "invalid-version" | null {
  if (version === undefined || version === 1) return null;
  if (typeof version === "number" && Number.isSafeInteger(version) && version > 1) {
    return "unsupported-version";
  }
  return "invalid-version";
}
