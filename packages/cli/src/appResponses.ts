import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const selection = {
  workspaceId: id, grantId: id, publicPrincipalId: id.optional(),
  afterAcceptanceId: id.optional(), limit: z.number().int().min(1).max(100).default(100),
};
export const OwnerAppResponsesRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), ...selection }).strict(),
  z.object({ action: z.literal("undo"), ...selection, operationId: id }).strict(),
]);
export type OwnerAppResponsesRequest = z.infer<typeof OwnerAppResponsesRequest>;

const historyId = z.string().min(1).max(512);
export const OwnerAppResponsePage = z.object({
  acceptances: z.array(z.object({
    kind: z.literal("accepted"), acceptanceId: id, objectId: historyId, momentId: historyId,
    publicPrincipalId: id, versionId: historyId,
    collectionPath: z.string().min(1).max(4096), path: z.string().min(1).max(4096),
    acceptedAtMs: z.number().int().nonnegative(),
  }).strict()).max(100),
  nextAcceptanceId: id.nullable(),
}).strict();
export const OwnerAppResponsesResult = z.discriminatedUnion("action", [
  OwnerAppResponsePage.extend({ action: z.literal("list") }),
  z.object({
    action: z.literal("undo"),
    items: z.array(z.object({
      acceptanceId: id, status: z.enum(["deleted", "already-absent", "conflict", "failed"]),
      momentId: historyId.optional(),
    }).strict()).max(100), nextCursor: id.nullable(),
  }).strict(),
]);
export type OwnerAppResponsesResult = z.infer<typeof OwnerAppResponsesResult>;
