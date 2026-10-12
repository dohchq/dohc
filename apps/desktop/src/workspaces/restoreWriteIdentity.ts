import { createHash } from "node:crypto";
import type { VersionedTextMoment, VersionedTextStore } from "@dohc/workspace-contracts/engine";

export const restoreRequestId = (session: string, momentId: string) =>
  `restore/${createHash("sha256").update(JSON.stringify([session, momentId])).digest("hex")}`;

export function restoreReceiptOf(saved: Pick<VersionedTextMoment, "objectId" | "versionId" | "metadata" | "path" | "id">, original: VersionedTextMoment, requestId: string) {
  const binaryRecreation = original.payload.before?.contentKind === "binary";
  return (saved.objectId === original.objectId || binaryRecreation) && saved.versionId === original.versionId &&
    saved.metadata.origin === "restore" && saved.metadata.correlationId === requestId
    ? {path: saved.path, restoredMomentId: saved.id} : null;
}

/** A keyed restore counts once the engine confirms it reached disk, even after a later edit. */
export async function findRestoreReceipt(engine: Pick<VersionedTextStore, "listMoments" | "readTextFile" | "publicationApplied">, original: VersionedTextMoment, requestId: string) {
  const objects = new Set([original.objectId]);
  if (original.payload.before?.contentKind === "binary") {
    const current = await engine.readTextFile({workspaceId: original.workspaceId, versionId: original.versionId, path: original.path});
    if (current) objects.add(current.objectId);
  }
  for (const objectId of objects) {
    let beforeMomentOrder: number | undefined;
    for (;;) {
      const page = await engine.listMoments({workspaceId: original.workspaceId, versionId: original.versionId,
        objectId,
        limit: 100, ...(beforeMomentOrder === undefined ? {} : {beforeMomentOrder})});
      for (const saved of page.moments) {
        if (saved.id === original.id) break;
        const receipt = restoreReceiptOf(saved, original, requestId);
        // One request records one moment, so an unconfirmed match is no receipt.
        if (receipt) return await engine.publicationApplied({workspaceId: original.workspaceId, requestId, momentId: saved.id})
          ? {...receipt, restored: saved.operation === "delete" ? "deleted" as const : "text" as const} : null;
      }
      if (page.nextBeforeMomentOrder === null || page.moments.some(saved => saved.id === original.id)) break;
      beforeMomentOrder = page.nextBeforeMomentOrder;
    }
  }
  return null;
}
