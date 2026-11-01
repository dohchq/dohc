// dohc refuses a workspace registry it could not read, so it never overwrites
// it. The registry error screen and the startup failure box share these words.
export const REGISTRY_READ_FAILURE_TITLE = "dohc couldn't read its workspace registry";
export const REGISTRY_READ_FAILURE_NEXT =
  "Your files are untouched. Fix or move the registry file named in the technical details, then relaunch dohc.";

// Carries the file dohc couldn't read, so the startup failure box can name it.
export class RegistryReadError extends Error {
  constructor(message: string, readonly registryFile: string) {
    super(message);
  }
}
