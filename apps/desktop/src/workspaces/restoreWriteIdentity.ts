import { createHash } from "node:crypto";
import type { VersionedTextMoment, VersionedTextStore } from "@dohc/workspace-contracts/engine";

export const restoreRequestId = (session: string, momentId: string) =>
  `restore/${createHash("sha256").update(JSON.stringify([session, momentId])).digest("hex")}`;

export function restoreReceiptOf(saved: Pick<VersionedTextMoment, "objectId" | "versionId" | "metadata" | "path" | "id">, original: VersionedTextMoment, requestId: string) {
  const binaryRecreation = original.operation === "delete" && original.payload.before?.contentKind === "binary";
  return (saved.objectId === original.objectId || binaryRecreation) && saved.versionId === original.versionId &&
    saved.metadata.origin === "restore" && saved.metadata.correlationId === requestId
    ? {path: saved.path, restoredMomentId: saved.id} : null;
}

/** Stable request metadata proves this restore committed, even after a later edit. */
export async function findRestoreReceipt(engine: Pick<VersionedTextStore, "listMoments">, original: VersionedTextMoment, requestId: string) {
  let beforeMomentOrder: number | undefined;
  for (;;) {
    const page = await engine.listMoments({workspaceId: original.workspaceId, versionId: original.versionId,
      ...(original.operation === "delete" && original.payload.before?.contentKind === "binary" ? {} : {objectId: original.objectId}),
      limit: 100, ...(beforeMomentOrder === undefined ? {} : {beforeMomentOrder})});
    for (const saved of page.moments) {
      if (saved.id === original.id) return null;
      const receipt = restoreReceiptOf(saved, original, requestId);
      if (receipt) return {...receipt, restored: saved.operation === "delete" ? "deleted" as const : "text" as const};
    }
    if (page.nextBeforeMomentOrder === null) return null;
    beforeMomentOrder = page.nextBeforeMomentOrder;
  }
}
