import {z} from "zod";
const id=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const OwnerAppResponsesRequest=z.object({workspaceId:id,grantId:id,publicPrincipalId:id.optional(),operationId:id,afterAcceptanceId:id.optional(),limit:z.number().int().min(1).max(100).default(100)}).strict();
export type OwnerAppResponsesRequest=z.infer<typeof OwnerAppResponsesRequest>;
export const OwnerAppResponsesResult=z.object({items:z.array(z.object({acceptanceId:id,status:z.enum(["deleted","already-absent","conflict","failed"]),momentId:z.string().min(1).max(512).optional()}).strict()).max(100),nextCursor:id.nullable()}).strict();
export type OwnerAppResponsesResult=z.infer<typeof OwnerAppResponsesResult>;
