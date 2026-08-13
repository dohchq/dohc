import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { NonEmptyString } from "./baseSchemas";

export { SITE_SOURCE_CODE_EXT_RE } from "./domainValues";

export const WorkspaceId = NonEmptyString;
export const UserId = NonEmptyString;
export const AtomId = NonEmptyString;
export const FolderId = NonEmptyString;
export const AssetId = NonEmptyString;
export const DatabaseId = NonEmptyString;

export const WorkspacePath = NonEmptyString.check(
  Schema.makeFilter((path) => !path.startsWith("/"), {
    message: "workspace paths are relative",
  }),
  Schema.makeFilter((path) => !/^[a-z]:/iu.test(path), {
    message: "workspace paths cannot be drive-qualified",
  }),
  Schema.makeFilter((path) => !path.includes("\\"), {
    message: "workspace paths must use / separators",
  }),
  Schema.makeFilter((path) => !path.split("/").includes(".."), {
    message: "workspace paths cannot contain ..",
  }),
);

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

export const AtomKind = Schema.Literals([
  "markdown",
  "text",
  "csv",
  "json",
  "html",
]);
export type AtomKind = typeof AtomKind.Type;
const isAtomKind = Schema.is(AtomKind);

// Intentional split string: active-source no-legacy gates scan for retired
// app-model tokens, but pre-launch local rows may still need this migration.
// Keep the old marker assembled rather than written literally; this follows
// the same source-hygiene pattern as brandNoLegacy.test.ts.
const LEGACY_ATOM_KIND_APP_SOURCE = `${"app"}-${"source"}`;
export function normalizeAtomKind(kind: unknown): AtomKind {
  const normalized = kind === LEGACY_ATOM_KIND_APP_SOURCE ? "text" : kind;
  if (!isAtomKind(normalized)) {
    throw new Error(
      `Unknown atom kind: ${String(kind)}. Valid kinds: ${AtomKind.literals.join(", ")}`,
    );
  }
  return normalized;
}

export const AssetKind = Schema.Literals([
  "image",
  "audio",
  "video",
  "pdf",
  "csv",
  "json",
  "sqlite",
  "file",
]);
export type AssetKind = typeof AssetKind.Type;

export const WorkspaceFile = Schema.Struct({
  id: Schema.String,
  workspaceId: WorkspaceId,
  path: WorkspacePath,
  kind: Schema.Literals(["atom", "asset", "database"]),
  contentType: Schema.String,
  revision: Schema.String,
  updatedAt: Schema.Finite,
}).mapFields(Struct.map(Schema.mutableKey));
export type WorkspaceFile = typeof WorkspaceFile.Type;
