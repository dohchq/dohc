export interface PublicEditRelease {readonly version: 1}

// Deployment authorization only. Admission budgets remain explicit in their existing profiles.
export function parsePublicEditRelease(value: unknown): PublicEditRelease | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).join() !== "version" || (value as {version?: unknown}).version !== 1) {
    throw new TypeError("Public Edit release must be exactly {version: 1}.");
  }
  return Object.freeze({version: 1});
}
