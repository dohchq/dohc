import { z } from "zod";

export const WorkspaceId = z.string().min(1);
export const UserId = z.string().min(1);
export const AtomId = z.string().min(1);
export const FolderId = z.string().min(1);
export const AssetId = z.string().min(1);
export const DatabaseId = z.string().min(1);

export const WorkspacePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/"), "workspace paths are relative")
  .refine(
    (path) => !path.split("/").includes(".."),
    "workspace paths cannot contain ..",
  );

export const SITE_SOURCE_CODE_EXT_RE = /\.(?:tsx?|jsx?|css|json|html?)$/i;

export const AtomKind = z.enum([
  "markdown",
  "text",
  "csv",
  "json",
  "html",
]);
export type AtomKind = z.infer<typeof AtomKind>;

export const AssetKind = z.enum([
  "image",
  "audio",
  "video",
  "pdf",
  "csv",
  "json",
  "sqlite",
  "file",
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const WorkspaceFile = z.object({
  id: z.string(),
  workspaceId: WorkspaceId,
  path: WorkspacePath,
  kind: z.enum(["atom", "asset", "database"]),
  contentType: z.string(),
  revision: z.string(),
  updatedAt: z.number(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;
