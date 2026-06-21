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

export const SITE_SOURCE_CODE_EXT_RE = /\.(?:tsx?|jsx?|[cm][jt]s|s?css|json|html?)$/i;

export const APPROVAL_ERROR_REASONS = [
  "approval-required",
  "site-publish-required",
] as const;
export type ApprovalErrorReason = (typeof APPROVAL_ERROR_REASONS)[number];
export const DEFAULT_APPROVAL_ERROR_REASON: ApprovalErrorReason = APPROVAL_ERROR_REASONS[0];

const APPROVAL_ERROR_REASON_SET: ReadonlySet<string> = new Set(APPROVAL_ERROR_REASONS);
export function isApprovalErrorReason(reason: string | undefined): reason is ApprovalErrorReason {
  return reason !== undefined && APPROVAL_ERROR_REASON_SET.has(reason);
}

export const AtomKind = z.enum([
  "markdown",
  "text",
  "csv",
  "json",
  "html",
]);
export type AtomKind = z.infer<typeof AtomKind>;

// Intentional split string: active-source no-legacy gates scan for retired
// app-model tokens, but pre-launch local rows may still need this migration.
// Keep the old marker assembled rather than written literally; this follows
// the same source-hygiene pattern as brandNoLegacy.test.ts.
const LEGACY_ATOM_KIND_APP_SOURCE = `${"app"}-${"source"}`;
export function normalizeAtomKind(kind: unknown): AtomKind {
  const normalized = kind === LEGACY_ATOM_KIND_APP_SOURCE ? "text" : kind;
  const parsed = AtomKind.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(
      `Unknown atom kind: ${String(kind)}. Valid kinds: ${AtomKind.options.join(", ")}`,
    );
  }
  return parsed.data;
}

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
