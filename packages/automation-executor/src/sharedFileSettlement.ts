import type { SharedFileUpdate } from "@dohc/workspace-contracts/shared-file-settlement";

export function sharedFileUpdateKey(draft: SharedFileUpdate): string {
  return JSON.stringify([draft.outboxId, draft.binding.mainVersionId, draft.binding.objectId,
    draft.binding.lineageClaimId, draft.binding.restoreFenceGeneration, draft.nativeHeadSequence, draft.appendKey]);
}
