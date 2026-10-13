import {expect, it, vi} from "vitest";
import type {VersionedTextMoment} from "@dohc/workspace-contracts/engine";
import {findRestoreReceipt, restoreReceiptOf, restoreRequestId} from "./restoreWriteIdentity";

it("finds a deleted binary's keyed restore on its new object without matching another session", async () => {
  const original: VersionedTextMoment = {id: "deleted", workspaceId: "workspace", versionId: "main", objectId: "old-object",
    path: "image.png", recordedAtMs: 1, operation: "delete", metadata: {origin: "api"},
    payload: {before: {path: "image.png", text: "", contentKind: "binary"}, after: {path: "image.png", text: ""}}};
  const key = restoreRequestId("session", original.id);
  const saved = {...original, id: "restored", objectId: "new-object", operation: "write" as const,
    metadata: {origin: "restore" as const, correlationId: key}};
  const engine = {publicationApplied: async () => true, readTextFile: async () => ({objectId: saved.objectId,versionId: "main",path: "image.png",text: "",updatedAtMs: 1,latestMomentId: saved.id,metadata: saved.metadata}), listMoments: async (input: {objectId?: string}) => ({moments: (input.objectId === original.objectId ? [original] : [saved]).map(moment => ({...moment, momentOrder: 1})), nextBeforeMomentOrder: null, latestMomentOrder: 1})};
  expect(await findRestoreReceipt(engine, original, key)).toMatchObject({restoredMomentId: "restored"});
  expect(restoreReceiptOf(saved, original, restoreRequestId("other-session", original.id))).toBeNull();
  expect(restoreReceiptOf({...saved, versionId: "other-version"}, original, key)).toBeNull();
  expect(restoreReceiptOf(saved, {...original, operation: "write", payload: {...original.payload, before: {...original.payload.before!, contentKind: "text"}}}, key)).toBeNull();
});

it("recovers a binary written then deleted from the current object's history only", async () => {
  const original = {id: "written", workspaceId: "workspace", versionId: "main", objectId: "old", path: "image.png",
    recordedAtMs: 1, operation: "write" as const, metadata: {origin: "api" as const},
    payload: {before: {path: "image.png", text: "", contentKind: "binary" as const}, after: {path: "image.png", text: ""}}};
  const key = restoreRequestId("session", original.id);
  const saved = {...original, id: "restored", objectId: "new", metadata: {origin: "restore" as const, correlationId: key}};
  const listMoments = vi.fn(async (input: {objectId?: string}) => ({moments: (input.objectId === "new" ? [saved] : [original]).map(moment => ({...moment, momentOrder: 1})), nextBeforeMomentOrder: null, latestMomentOrder: 2}));
  const engine = {publicationApplied: async () => true, readTextFile: vi.fn(async () => ({objectId: "new",versionId: "main",path: "image.png",text: "",updatedAtMs: 1,latestMomentId: saved.id,metadata: saved.metadata})), listMoments};
  expect(restoreReceiptOf(saved, original, key)).toMatchObject({restoredMomentId: "restored"});
  expect(await findRestoreReceipt(engine, original, key)).toMatchObject({restoredMomentId: "restored"});
  expect(listMoments.mock.calls.every(([input]) => input.objectId === "old" || input.objectId === "new")).toBe(true);
});

it.each(["write", "delete"] as const)("adopts a keyed %s restore only once its publication is confirmed", async operation => {
  const original: VersionedTextMoment = {id: "edited", workspaceId: "workspace", versionId: "main", objectId: "object",
    path: "note.txt", recordedAtMs: 1, operation: "write", metadata: {origin: "api"},
    payload: {before: {path: "note.txt", text: "original"}, after: {path: "note.txt", text: "current"}}};
  const key = restoreRequestId("session", original.id);
  const saved = {...original, id: "restored", operation, metadata: {origin: "restore" as const, correlationId: key}};
  const publicationApplied = vi.fn(async () => false);
  const engine = {publicationApplied, readTextFile: async () => null, listMoments: async () => ({
    moments: [{...saved, momentOrder: 2}, {...original, momentOrder: 1}], nextBeforeMomentOrder: null, latestMomentOrder: 2})};
  expect(await findRestoreReceipt(engine, original, key)).toBeNull();
  expect(publicationApplied).toHaveBeenCalledWith({workspaceId: "workspace", requestId: key, momentId: "restored"});
  publicationApplied.mockResolvedValue(true);
  expect(await findRestoreReceipt(engine, original, key))
    .toEqual({path: "note.txt", restoredMomentId: "restored", restored: operation === "delete" ? "deleted" : "text"});
});

it("never scans unrelated version history on a fresh binary restore", async () => {
  const original = {id: "deleted", workspaceId: "workspace", versionId: "main", objectId: "old", path: "image.png",
    recordedAtMs: 1, operation: "delete" as const, metadata: {origin: "api" as const},
    payload: {before: {path: "image.png", text: "", contentKind: "binary" as const}, after: {path: "image.png", text: ""}}};
  const listMoments = vi.fn(async () => ({moments: [{...original, momentOrder: 1}], nextBeforeMomentOrder: null, latestMomentOrder: 1}));
  expect(await findRestoreReceipt({publicationApplied: async () => true, readTextFile: async () => null, listMoments}, original, "key")).toBeNull();
  expect(listMoments.mock.calls).toEqual([[{workspaceId: "workspace", versionId: "main", objectId: "old", limit: 100}]]);
});
