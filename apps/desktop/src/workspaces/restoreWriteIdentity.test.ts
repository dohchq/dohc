import {expect, it} from "vitest";
import type {VersionedTextMoment} from "@dohc/workspace-contracts/engine";
import {findRestoreReceipt, restoreReceiptOf, restoreRequestId} from "./restoreWriteIdentity";

it("finds a deleted binary's keyed restore on its new object without matching another session", async () => {
  const original: VersionedTextMoment = {id: "deleted", workspaceId: "workspace", versionId: "main", objectId: "old-object",
    path: "image.png", recordedAtMs: 1, operation: "delete", metadata: {origin: "api"},
    payload: {before: {path: "image.png", text: "", contentKind: "binary"}, after: {path: "image.png", text: ""}}};
  const key = restoreRequestId("session", original.id);
  const saved = {...original, id: "restored", objectId: "new-object", operation: "write" as const,
    metadata: {origin: "restore" as const, correlationId: key}};
  const engine = {listMoments: async (input: {objectId?: string}) => ({moments: (input.objectId ? [original] : [saved, original]).map(moment => ({...moment, momentOrder: 1})), nextBeforeMomentOrder: null, latestMomentOrder: 1})};
  expect(await findRestoreReceipt(engine, original, key)).toMatchObject({restoredMomentId: "restored"});
  expect(restoreReceiptOf(saved, original, restoreRequestId("other-session", original.id))).toBeNull();
  expect(restoreReceiptOf({...saved, versionId: "other-version"}, original, key)).toBeNull();
  expect(restoreReceiptOf(saved, {...original, operation: "write"}, key)).toBeNull();
});
