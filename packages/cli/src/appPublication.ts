import { z } from "zod";
import { parseAppCollectionCapability } from "@dohc/security-contract/app-publication";
import { parseAppBackendCapability } from "@dohc/security-contract/app-backend";
import { OwnerAppBackendCapability } from "./appBackend";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const OwnerAppCollectionCapability = z.unknown().transform((value, context) => {
  try { return parseAppCollectionCapability(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid collection capability." }); return z.NEVER; }
});
const OwnerAppCapability = z.unknown().transform((value, context) => {
  try {
    return value && typeof value === "object" && "kind" in value && value.kind === "app-backend"
      ? parseAppBackendCapability(value) : parseAppCollectionCapability(value);
  } catch { context.addIssue({ code: "custom", message: "Invalid app capability." }); return z.NEVER; }
});
const publication = { publicationId: hash, authorityRevision: z.number().int().positive(), shareId: id, grantId: id, active: z.boolean(), linkCurrent: z.boolean(), collectionCapability: z.union([OwnerAppCollectionCapability, z.literal("unavailable")]).nullable(), backendCapability: z.union([OwnerAppBackendCapability, z.literal("unavailable")]).nullable() };
const OwnerAppPublicationListRow = z.discriminatedUnion("manifestUnavailable", [
  z.object({ ...publication, manifestUnavailable: z.literal(false), appRoot: z.string().min(1).max(1024), sourceRevision: hash }).strict(),
  z.object({ ...publication, manifestUnavailable: z.literal(true) }).strict(),
]);
export const OwnerAppPublicationRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), workspaceId: id, appRoot: z.string().min(1).max(1024), cursor: hash.optional() }).strict(),
  z.object({ action: z.literal("prepare"), workspaceId: id, appRoot: z.string().min(1).max(1024), shareId: id, grantId: id }).strict(),
  z.object({ action: z.literal("approve"), workspaceId: id, approvalId: z.string().uuid(), candidateDigest: hash, initialize: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("cancel"), workspaceId: id, approvalId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("withdraw"), workspaceId: id, publicationId: hash, expectedAuthorityRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("revokeCollection"), workspaceId: id, publicationId: hash, expectedAuthorityRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("reviewReactivation"), workspaceId: id, publicationId: hash }).strict(),
]);
export type OwnerAppPublicationRequest = z.infer<typeof OwnerAppPublicationRequest>;
export const OwnerAppPublicationResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("listed"), publications: z.array(OwnerAppPublicationListRow).max(25), nextCursor: hash.nullable() }).strict(),
  z.object({ kind: z.literal("prepared"), approvalId: z.string().uuid(), candidateDigest: hash,
    appRoot: z.string().min(1).max(1024), versionId: id, sourceRevision: hash,
    sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(512), capabilities: z.array(OwnerAppCapability).max(1), externalNetwork: z.literal(true),
  }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("published"), publicationId: z.string().regex(/^[a-f0-9]{64}$/), authorityRevision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("withdrawn"), publicationId: hash, authorityRevision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("collectionRevoked"), publicationId: hash, authorityRevision: z.number().int().positive() }).strict(),
]);
export type OwnerAppPublicationResult = z.infer<typeof OwnerAppPublicationResult>;
