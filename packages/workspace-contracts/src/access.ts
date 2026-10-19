import { z } from "zod";

const Id = z.string().min(1).max(256);
const Path = z.string().min(1).max(1024);
const Version = Id.nullable();
const Label = z.string().max(320).nullable();
const Timestamp = z.number().int().nonnegative().nullable();
export const AccessObjectRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: Path, versionId: Version.default(null) }).strict(),
  z.object({ kind: z.literal("file"), objectId: Id }).strict(),
  z.object({ kind: z.literal("chat"), channelWireId: Id }).strict(),
  z.object({ kind: z.literal("collection"), datasetId: z.string().uuid() }).strict(),
]);
export type AccessObjectRef = z.infer<typeof AccessObjectRef>;
const Selector = z.union([
  z.object({ kind: z.never().optional(), paths: z.array(Path).max(100), versionId: Version }),
  z.object({ kind: z.literal("group"), channelWireId: Id, paths: z.array(Path).max(100), versionId: z.null() }),
  z.object({ kind: z.literal("chat"), channelWireId: Id }),
]);
export const AccessShareRow = z.object({
  kind: z.literal("share"), shareId: Id, grantId: Id,
  via: z.enum(["named", "link", "dependent", "received"]),
  granterUserId: Id.nullable(), granterEmail: Label,
  recipientUserId: Id.nullable(), recipientEmail: Label,
  subjectName: Label, sharerName: Label,
  selector: Selector.nullable(), access: z.enum(["view", "comment", "edit", "read-only", "read-write"]).nullable(),
  status: z.enum(["active", "revoked", "removed", "damaged"]), generation: z.number().int().positive().nullable(),
  fileScope: z.enum(["served", "not-served"]).optional(),
  removalMessage: z.string().min(1).max(500).optional(),
});
export type AccessShareRow = z.infer<typeof AccessShareRow>;
export const AccessCollectionRow = z.object({
  kind: z.literal("collection"), datasetId: z.string().uuid(), principal: Id, appId: Id.nullable(),
  operationIds: z.array(Id).max(128), revision: z.number().int().nonnegative(),
  revisionSha256: z.string().regex(/^[a-f0-9]{64}$/), compatible: z.boolean(),
});
export type AccessCollectionRow = z.infer<typeof AccessCollectionRow>;
export const AccessAnswer = z.object({
  ref: AccessObjectRef.nullable(), rows: z.array(z.union([AccessShareRow, AccessCollectionRow])).max(100),
  visibility: z.enum(["visible", "missing", "hidden", "unknown"]),
  coverage: z.object({ kind: z.enum(["granted", "received-own-grant", "received-account", "collection", "unavailable"]),
    complete: z.boolean(), observation: z.literal("interval") }),
  unknownReason: z.enum(["signed-out", "not-synced", "other-account", "other-server", "not-listed-yet", "changed", "unreadable"]).nullable(),
  checkedAtMs: Timestamp, freshness: z.enum(["fresh", "stale", "unknown"]), nextCursor: z.string().max(2048).nullable(),
}).refine(answer => (answer.coverage.kind === "unavailable" && answer.visibility !== "hidden" && answer.visibility !== "missing") === (answer.unknownReason !== null),
  { path: ["unknownReason"], message: "A reason is required for unavailable Access unless visibility is hidden or missing." });
export type AccessAnswer = z.infer<typeof AccessAnswer>;
const AccessPageInput = z.object({ cursor: z.string().min(1).max(2048).optional() });
export const ObjectAccessInput = AccessPageInput.extend({ ref: AccessObjectRef });
export const SharingAccessInput = AccessPageInput.extend({ lane: z.enum(["granted", "received"]) });
export const AccessRefreshResult = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["requested", "joined", "paced"]) }),
  z.object({ status: z.literal("unavailable"), reason: z.enum(["signed-out", "unreadable"]) }),
]);
export type AccessRefreshResult = z.infer<typeof AccessRefreshResult>;
export const AccessRefreshInput = z.object({ reason: z.enum(["sharing-open", "access-expand"]) });
