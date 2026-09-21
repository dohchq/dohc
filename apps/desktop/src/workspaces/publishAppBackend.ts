import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { LocalAppBackendHost } from "./localAppBackend";
import { OwnerAppBackendRestore } from "@dohc/cli/app-backend";

/** Freeze local writes before restoring the exact snapshot to the new shared authority. */
export async function activatePublishedAppBackend(input: {
  publicationId: string; authorityRevision: number; candidate: Pick<AppPublicationCandidate, "appRoot" | "capabilities">; initialize: boolean;
}, local: Pick<LocalAppBackendHost, "findByDataPath" | "transfer" | "advanceSharedAuthority" | "recoveryIntegrity">,
request: (action: "activate" | "restore" | "describe", body: unknown) => Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const confirm = (value: unknown) => {
    const result = OwnerAppBackendRestore.parse(value);
    if (result.publicationId !== input.publicationId || result.authorityRevision !== input.authorityRevision) throw new Error("The app activation changed. Refresh its publications.");
  };
  const capability = input.candidate.capabilities.find(capability => capability.kind === "app-backend");
  if (!capability) throw new Error("This app has no backend capability.");
  const existing = local.findByDataPath(capability.dataPath);
  if (existing && (existing.appRoot !== input.candidate.appRoot || existing.capability.schemaSha256 !== capability.schemaSha256 ||
      (!existing.sharedPublicationId && existing.capability.backendSha256 !== capability.backendSha256))) {
    throw new Error("The shared app does not match its local data. Approve its current backend locally before transferring.");
  }
  let sharedInitialized: boolean | null = null;
  let expectedRecoverySha256: string | undefined;
  if (existing) {
    const raw = await request("describe", {});
    signal.throwIfAborted();
    const description = raw as { publicationId?: unknown; authorityRevision?: unknown; initialized?: unknown; restoredBundleSha256?: unknown } | null;
    if (!description || description.publicationId !== input.publicationId || description.authorityRevision !== input.authorityRevision || typeof description.initialized !== "boolean") {
      throw new Error("The app activation changed. Refresh its publications.");
    }
    sharedInitialized = description.initialized;
    if (sharedInitialized && existing.sharedPublicationId && !existing.sharedTransferConfirmed) {
      expectedRecoverySha256 = local.recoveryIntegrity(capability.dataPath);
      if (description.restoredBundleSha256 !== expectedRecoverySha256) throw new Error("The shared app contains different data from the pending local transfer. Export the local recovery data before continuing.");
    }
    if (sharedInitialized && !existing.sharedPublicationId && existing.active) {
      throw new Error("This app already has local data while the shared app is initialized. Export the local recovery data before continuing.");
    }
    if (!existing.sharedPublicationId && !existing.active) throw new Error("Initialize or restore this local app before publishing its data.");
    if (!sharedInitialized && existing.sharedTransferConfirmed) throw new Error("The shared app data is missing. Restore a current shared recovery export before continuing.");
  }
  if (!input.initialize) {
    if (existing?.active && !existing.sharedPublicationId) throw new Error("This app has local data. Publish it with initialization to transfer that data.");
    return;
  }
  if (existing && !sharedInitialized) {
    if (existing.capability.backendSha256 !== capability.backendSha256) throw new Error("The shared app does not match its local data. Restore the matching backend source before retrying the transfer.");
    const bundle = local.transfer(capability.dataPath, input.publicationId, existing.sharedPublicationId ?? undefined);
    signal.throwIfAborted();
    confirm(await request("restore", { authorityRevision: input.authorityRevision, bundle }));
    signal.throwIfAborted();
    local.advanceSharedAuthority(capability.dataPath, input.publicationId, input.publicationId);
  } else {
    confirm(await request("activate", { authorityRevision: input.authorityRevision,
      ...(existing ? { preserveData: true } : {}), ...(expectedRecoverySha256 ? { expectedRecoverySha256 } : {}) }));
    signal.throwIfAborted();
    if (existing?.sharedPublicationId) local.advanceSharedAuthority(capability.dataPath, existing.sharedPublicationId, input.publicationId);
  }
  signal.throwIfAborted();
}
