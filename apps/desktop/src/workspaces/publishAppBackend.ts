import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { LocalAppBackendHost } from "./localAppBackend";
import { OwnerAppBackendRestore } from "@dohc/cli/app-backend";

/** Freeze local writes before restoring the exact snapshot to the new shared authority. */
export async function activatePublishedAppBackend(input: {
  publicationId: string; authorityRevision: number; candidate: Pick<AppPublicationCandidate, "appRoot" | "capabilities">; initialize: boolean;
}, local: Pick<LocalAppBackendHost, "findByDataPath" | "transfer" | "advanceSharedAuthority">,
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
  if (!input.initialize) {
    if (existing?.active && !existing.sharedPublicationId) throw new Error("This app has local data. Publish it with initialization to transfer that data.");
    return;
  }
  if (existing && (!existing.sharedPublicationId || existing.sharedPublicationId === input.publicationId)) {
    const bundle = local.transfer(capability.dataPath, input.publicationId);
    signal.throwIfAborted();
    confirm(await request("restore", { authorityRevision: input.authorityRevision, bundle }));
  } else {
    confirm(await request("activate", { authorityRevision: input.authorityRevision }));
    signal.throwIfAborted();
    if (existing?.sharedPublicationId) local.advanceSharedAuthority(capability.dataPath, existing.sharedPublicationId, input.publicationId);
  }
  signal.throwIfAborted();
}
