import { z } from "zod";

const id = z.string().min(1).max(200);
export const OwnerAppPublicationRequest = z.object({ workspaceId: id, appRoot: z.string().min(1).max(1024), shareId: id, grantId: id }).strict();
export type OwnerAppPublicationRequest = z.infer<typeof OwnerAppPublicationRequest>;
export const OwnerAppPublicationResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("published"), publicationId: z.string().regex(/^[a-f0-9]{64}$/), authorityRevision: z.number().int().positive() }).strict(),
]);
export type OwnerAppPublicationResult = z.infer<typeof OwnerAppPublicationResult>;
