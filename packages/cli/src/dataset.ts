import { z } from "zod";
import { parseAppBackendJson } from "@dohc/security-contract/app-backend";
import { parseDatasetDefinition, parseDatasetRevision, parseDatasetDescription } from "@dohc/security-contract/dataset";

const identity = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const workspace = { workspaceId: z.string().min(1).max(128) };
const selection = { ...workspace, datasetId: identity };
const json = z.unknown().transform((value, context) => {
  try { return parseAppBackendJson(value, 64 * 1024); }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection input." }); return z.NEVER; }
});
const definition = z.unknown().transform((value, context) => {
  try { return parseDatasetDefinition(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection definition." }); return z.NEVER; }
});
const revision = z.unknown().transform((value, context) => {
  try { return parseDatasetRevision(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection revision." }); return z.NEVER; }
});
export const DatasetRequest = z.discriminatedUnion("action", [
  z.object({ ...workspace, action: z.literal("list"), after: identity.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...selection, action: z.literal("describe") }).strict(),
  z.object({ ...workspace, action: z.literal("create"), definition }).strict(),
  z.object({ ...workspace, action: z.literal("prepare"), descriptorPath: z.string().min(1).max(1024) }).strict(),
  z.object({ ...workspace, action: z.literal("approve"), preparationId: identity, revisionSha256: sha256 }).strict(),
  z.object({ ...workspace, action: z.literal("discard"), preparationId: identity }).strict(),
  z.object({ ...selection, action: z.literal("invoke"), operationId: identity, revision: z.number().int().positive(), revisionSha256: sha256,
    input: json, idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict(),
]);
export type DatasetRequest = z.infer<typeof DatasetRequest>;
export const DatasetPreparation = z.object({ preparationId: identity, revision, sourceDigest: sha256 }).strict();
export type DatasetPreparation = z.infer<typeof DatasetPreparation>;
export const DatasetInvocationResult = z.object({
  result: z.unknown().transform((value, context) => {
    try { return parseAppBackendJson(value, 256 * 1024); }
    catch { context.addIssue({ code: "custom", message: "Invalid Collection result." }); return z.NEVER; }
  }), revision: z.number().int().nonnegative(), replayed: z.boolean(),
}).strict();
export type DatasetInvocationResult = z.infer<typeof DatasetInvocationResult>;
const description = z.unknown().transform((value, context) => {
  try { return parseDatasetDescription(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid Collection description." }); return z.NEVER; }
});
export const DatasetResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), datasets: z.array(description).max(100), nextCursor: identity.nullable() }).strict(),
  z.object({ kind: z.literal("description"), dataset: description }).strict(),
  DatasetPreparation.extend({ kind: z.literal("prepared") }).strict(),
  z.object({ kind: z.literal("approved"), revision }).strict(),
  DatasetInvocationResult.extend({ kind: z.literal("invoked") }).strict(),
  z.object({ kind: z.literal("discarded") }).strict(),
]);
export type DatasetResult = z.infer<typeof DatasetResult>;
