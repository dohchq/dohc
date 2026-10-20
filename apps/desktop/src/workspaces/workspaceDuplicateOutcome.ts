import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";

// A worker can disappear or fail after committing. Other wire refusals reject the request.
const UNCERTAIN_REFUSALS = new Set(["INTERNAL", "WORKSPACE_UNAVAILABLE"]);

export async function duplicateWithRecovery<T>(path: string, commit: () => Promise<T>): Promise<T> {
  try {
    return await commit();
  } catch (cause) {
    const refusal = cause instanceof VersionedTextStoreError ? cause.cause : cause;
    if (refusal instanceof DaemonRefusalError && !UNCERTAIN_REFUSALS.has(refusal.wireCode)) throw cause;
    throw new Error(
      "dohc could not confirm Duplicate for " + path + ". Open the workspace again, then try Duplicate again. dohc will check the saved operation before making another copy.",
      {cause},
    );
  }
}
