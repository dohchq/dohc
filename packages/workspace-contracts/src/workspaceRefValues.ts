import { z } from "zod";
import { FILE_KIND_RECORDS, type FileDisplayKind } from "./kinds";
import type { WorkspaceFileRef } from "./workspaceRef";

export const WorkspaceFileRefSchema = z.object({
  workspaceId: z.string().min(1),
  target: z.object({ kind: z.literal("file"), objectId: z.string().min(1) }),
  labels: z.object({
    path: z.string().optional(), name: z.string(),
    displayKind: z.enum(Object.keys(FILE_KIND_RECORDS) as [FileDisplayKind, ...FileDisplayKind[]]),
  }),
}) satisfies z.ZodType<WorkspaceFileRef>;
