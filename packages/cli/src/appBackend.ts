import { z } from "zod";
import { parseAppBackendCapability, parseAppBackendJson, APP_BACKEND_INPUT_BYTES } from "@dohc/security-contract/app-backend";

const selection = { workspaceId: z.string().min(1).max(200), publicationId: z.string().regex(/^[a-f0-9]{64}$/) };
const json = (maxBytes?: number) => z.unknown().transform((value, context) => {
  try { return parseAppBackendJson(value, maxBytes); }
  catch { context.addIssue({ code: "custom", message: "Invalid app backend JSON." }); return z.NEVER; }
});
export const OwnerAppBackendCapability = z.unknown().transform((value, context) => {
  try { return parseAppBackendCapability(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid app backend capability." }); return z.NEVER; }
});
export const OwnerAppBackendRequest = z.discriminatedUnion("action", [
  z.object({ ...selection, action: z.literal("describe") }).strict(),
  z.object({ ...selection, action: z.literal("invoke"), operation: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), input: json(APP_BACKEND_INPUT_BYTES) }).strict(),
  z.object({ ...selection, action: z.literal("export"), savePath: z.string().min(1).max(4096).optional(), overwrite: z.boolean().optional() }).strict(),
  z.object({ ...selection, action: z.literal("restore"), sourcePath: z.string().min(1).max(4096) }).strict(),
  z.object({ ...selection, action: z.literal("helper"), grantId: z.string().min(1).max(200), enabled: z.boolean() }).strict(),
]);
export type OwnerAppBackendRequest = z.infer<typeof OwnerAppBackendRequest>;
export const OwnerAppBackendDescribe = z.object({ capability: OwnerAppBackendCapability, revision: z.number().int().nonnegative(), online: z.boolean() }).strict();
export const OwnerAppBackendInvoke = z.object({ result: json(), revision: z.number().int().nonnegative(), replayed: z.boolean() }).strict();
export const OwnerAppBackendExport = z.object({ savedPath: z.string().min(1).max(4096) }).strict();
export const OwnerAppBackendHelper = z.object({ grantId: z.string().min(1).max(200), enabled: z.boolean() }).strict();
export const OwnerAppBackendRestore = z.object({ publicationId: selection.publicationId, authorityRevision: z.number().int().positive(), revision: z.number().int().nonnegative() }).strict();
export const OwnerAppBackendResult = z.union([OwnerAppBackendDescribe, OwnerAppBackendInvoke, OwnerAppBackendExport, OwnerAppBackendHelper, OwnerAppBackendRestore]);
export type OwnerAppBackendResult = z.infer<typeof OwnerAppBackendResult>;
