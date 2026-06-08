export type WorkspaceErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "locked"
  | "review_required"
  | "invalid_path"
  | "invalid_manifest"
  | "unsupported_media_type";

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
