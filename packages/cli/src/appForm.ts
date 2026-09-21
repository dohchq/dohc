import { z } from "zod";

const path = z.string().min(1).max(1024);
export const OwnerAppFormRequest = z.object({
  workspaceId: z.string().min(1).max(200),
  collectionPath: z.string().min(1).max(980),
  appRoot: path,
  publicFields: z.array(z.string().min(1).max(256)).min(1).max(100)
    .refine(fields => new Set(fields).size === fields.length, "Choose each field once."),
}).strict();
export type OwnerAppFormRequest = z.infer<typeof OwnerAppFormRequest>;

export const OwnerAppFormResult = z.object({
  appRoot: path,
  schemaSource: path,
  files: z.array(path).min(1).max(64),
  recordsCopied: z.literal(0),
}).strict();
export type OwnerAppFormResult = z.infer<typeof OwnerAppFormResult>;
