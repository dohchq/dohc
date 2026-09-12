import { z } from "zod";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const OwnerAppPublicationRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), workspaceId: id, appRoot: z.string().min(1).max(1024), cursor: hash.optional() }).strict(),
  z.object({ action: z.literal("prepare"), workspaceId: id, appRoot: z.string().min(1).max(1024), shareId: id, grantId: id }).strict(),
  z.object({ action: z.literal("approve"), workspaceId: id, approvalId: z.string().uuid(), candidateDigest: hash }).strict(),
  z.object({ action: z.literal("cancel"), workspaceId: id, approvalId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("withdraw"), workspaceId: id, publicationId: hash, expectedAuthorityRevision: z.number().int().positive() }).strict(),
]);
export type OwnerAppPublicationRequest = z.infer<typeof OwnerAppPublicationRequest>;
export const OwnerAppPublicationResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("listed"), publications: z.array(z.object({ publicationId: hash, authorityRevision: z.number().int().positive(),
    shareId: id, grantId: id, appRoot: z.string().min(1).max(1024), sourceRevision: hash, active: z.boolean() }).strict()).max(25), nextCursor: hash.nullable() }).strict(),
  z.object({ kind: z.literal("prepared"), approvalId: z.string().uuid(), candidateDigest: hash,
    appRoot: z.string().min(1).max(1024), versionId: id, sourceRevision: hash,
    sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(512), capabilities: z.tuple([]), externalNetwork: z.literal(true),
  }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("published"), publicationId: z.string().regex(/^[a-f0-9]{64}$/), authorityRevision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("withdrawn"), publicationId: hash, authorityRevision: z.number().int().positive() }).strict(),
]);
export type OwnerAppPublicationResult = z.infer<typeof OwnerAppPublicationResult>;
