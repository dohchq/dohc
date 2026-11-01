// dohc refuses a workspace registry it could not read, so it never overwrites
// it. The registry error screen and the startup failure box share these words.
export const REGISTRY_READ_FAILURE_TITLE = "dohc couldn't read its workspace registry";
export const REGISTRY_READ_FAILURE_NEXT =
  "Your files are untouched. Fix or move the registry file named in the technical details, then relaunch dohc.";
// A registry from a newer dohc isn't broken, so it gets no "fix or move".
export const REGISTRY_NEWER_NEXT =
  "Your files are untouched. A newer version of dohc wrote this registry. Update dohc to open it.";

// The code a registry from a newer dohc carries. Main's IPC boundary keeps it.
export const REGISTRY_NEWER = "registry-newer";

// Carries the file dohc couldn't read, so the startup failure box can name it.
export class RegistryReadError extends Error {
  readonly code: typeof REGISTRY_NEWER | undefined;

  constructor(message: string, readonly registryFile: string, newer = false) {
    super(message);
    this.code = newer ? REGISTRY_NEWER : undefined;
  }
}

/** What to do next, for a registry refusal's code. */
export function registryReadFailureNext(code: string | undefined): string {
  return code === REGISTRY_NEWER ? REGISTRY_NEWER_NEXT : REGISTRY_READ_FAILURE_NEXT;
}
