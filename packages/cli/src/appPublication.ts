import { z } from "zod";
import { parseAppCollectionCapability } from "@dohc/security-contract/app-publication";
import { parseAppDatasetCapability } from "@dohc/security-contract/dataset";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PublicationAgent = z.object({ kind: z.literal("agent"), label: z.string().min(1).max(160).nullable(), labelSource: z.literal("agent-declared") }).strict();
const selector = z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(100), versionId: z.null() }).strict();
const access = z.enum(["view", "comment", "edit"]);
const linkFacts = { shareId: id, grantId: id, selector, access, bearerWarning: z.string().min(1).max(512) };
const OwnerAppCollectionCapability = z.unknown().transform((value, context) => {
  try { return parseAppCollectionCapability(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid collection capability." }); return z.NEVER; }
});
const OwnerAppCapability = z.unknown().transform((value, context) => {
  try {
    if (value && typeof value === "object" && "kind" in value && value.kind === "dataset") return parseAppDatasetCapability(value);
    return parseAppCollectionCapability(value);
  } catch { context.addIssue({ code: "custom", message: "Invalid app capability." }); return z.NEVER; }
});
const OwnerAppDatasetCapability = z.unknown().transform((value, context) => {
  try { return parseAppDatasetCapability(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid dataset capability." }); return z.NEVER; }
});
// approved: this device's authority still names the app. active: it can run now. pendingCreates: responses not yet confirmed saved or refused.
const localPublication = { publicationId: hash, authorityRevision: z.number().int().positive(), appRoot: z.string().min(1).max(1024), sourceRevision: hash, approved: z.boolean(), active: z.boolean() };
const LocalPublication = z.union([
  z.object({ ...localPublication, datasetCapability: OwnerAppDatasetCapability }).strict(),
  z.object({ ...localPublication, collectionCapability: OwnerAppCollectionCapability, pendingCreates: z.number().int().nonnegative().max(1000) }).strict(),
]);
const publication = { operatorTakedown: z.object({ actor: z.literal("operator"), disabledAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), reason: z.string().min(1).max(1024) }).strict().optional(), approvalProvenance: z.object({ agent: PublicationAgent.nullable(), selector: z.unknown(), access, committedCandidateDigest: hash, sourceRevision: hash, capabilities: z.array(OwnerAppCapability).max(1) }).strict().optional(), publicationId: hash, authorityRevision: z.number().int().positive(), shareId: id, grantId: id, active: z.boolean(), linkCurrent: z.boolean(), collectionCapability: z.union([OwnerAppCollectionCapability, z.literal("unavailable")]).nullable(), datasetCapability: z.union([OwnerAppDatasetCapability, z.literal("unavailable")]).nullable() };
const OwnerAppPublicationListRow = z.discriminatedUnion("manifestUnavailable", [
  z.object({ ...publication, manifestUnavailable: z.literal(false), appRoot: z.string().min(1).max(1024), sourceRevision: hash }).strict(),
  z.object({ ...publication, manifestUnavailable: z.literal(true) }).strict(),
]);
export const OwnerAppPublicationRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("createLink"), workspaceId: id, appRoot: z.string().min(1).max(1024), paths: selector.shape.paths.optional(), access: access.default("view"), operationId: z.string().uuid(), agentLabel: z.string().min(1).max(160).optional() }).strict(),
  z.object({ action: z.literal("listLocal"), workspaceId: id, appRoot: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal("checkLocal"), workspaceId: id, appRoot: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal("prepareLocal"), workspaceId: id, appRoot: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal("launchLocal"), workspaceId: id, publicationId: hash }).strict(),
  z.object({ action: z.literal("list"), workspaceId: id, appRoot: z.string().min(1).max(1024), cursor: hash.optional() }).strict(),
  z.object({ action: z.literal("prepare"), workspaceId: id, appRoot: z.string().min(1).max(1024), shareId: id, grantId: id }).strict(),
  z.object({ action: z.literal("approve"), workspaceId: id, approvalId: z.string().uuid(), candidateDigest: hash, agentLabel: z.string().min(1).max(160).optional(), linkReads: z.array(z.object({ operationId: z.string().uuid(), fieldIds: z.array(z.string().uuid()).max(128) }).strict()).max(128).optional() }).strict(),
  z.object({ action: z.literal("cancel"), workspaceId: id, approvalId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("withdraw"), workspaceId: id, publicationId: hash, expectedAuthorityRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("revokeCollection"), workspaceId: id, publicationId: hash, expectedAuthorityRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("reviewReactivation"), workspaceId: id, publicationId: hash }).strict(),
]);
export type OwnerAppPublicationRequest = z.infer<typeof OwnerAppPublicationRequest>;
export const OwnerAppPublicationResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linkCreated"), ...linkFacts, url: z.string().url().max(4096) }).strict(),
  z.object({ kind: z.literal("urlUnavailable"), ...linkFacts }).strict(),
  z.object({ kind: z.literal("localLaunched"), publicationId: hash, url: z.string().url().max(4096) }).strict(),
  z.object({ kind: z.literal("localListed"), publications: z.array(LocalPublication).max(64) }).strict(),
  // The source revision prepareLocal would capture now. It differs from an approval's sourceRevision once the app's source changed.
  // declaresCollection is false for an app that reaches no Collection. prepareLocal refuses such an app, so it has nothing to approve here.
  z.object({ kind: z.literal("localChecked"), appRoot: z.string().min(1).max(1024), sourceRevision: hash, sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(512), declaresCollection: z.boolean() }).strict(),
  z.object({ kind: z.literal("listed"), publications: z.array(OwnerAppPublicationListRow).max(25), nextCursor: hash.nullable() }).strict(),
  // The relay answered not found: it does not publish apps for this workspace and account.
  z.object({ kind: z.literal("listUnavailable") }).strict(),
  z.object({ kind: z.literal("prepared"), approvalId: z.string().uuid(), candidateDigest: hash,
    appRoot: z.string().min(1).max(1024), versionId: id, sourceRevision: hash,
    audience: z.object({shareId:id,grantId:id,selector:z.object({paths:z.array(z.string()),versionId:id.nullable()}).strict(),access}).strict().optional(),
    sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(512), capabilities: z.array(OwnerAppCapability).max(1), externalNetwork: z.literal(true), local: z.literal(true).optional(),
  }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("published"), publicationId: z.string().regex(/^[a-f0-9]{64}$/), authorityRevision: z.number().int().positive(), local: z.literal(true).optional(), appQuery: z.string().max(256).optional(), access: access.optional(), bearerWarning: z.string().max(512).optional() }).strict(),
  z.object({ kind: z.literal("withdrawn"), publicationId: hash, authorityRevision: z.number().int().positive() }).strict(),
  // Authority ended, but responses admitted earlier may still be saved. Withdraw again at this revision to confirm.
  z.object({ kind: z.literal("withdrawalUnconfirmed"), publicationId: hash, authorityRevision: z.number().int().positive(), unresolvedCreates: z.number().int().positive().max(1000) }).strict(),
  z.object({ kind: z.literal("collectionRevoked"), publicationId: hash, authorityRevision: z.number().int().positive() }).strict(),
]);
export type OwnerAppPublicationResult = z.infer<typeof OwnerAppPublicationResult>;
