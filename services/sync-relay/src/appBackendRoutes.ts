export type AppBackendAction =
  | "activate"
  | "invoke"
  | "upload"
  | "file"
  | "attempt"
  | "descriptor"
  | "summary"
  | "blob"
  /** Share-web redeems a phone's launch grant. */
  | "redeem";
export interface AppBackendRoute {
  route: "app-backend";
  publicationId: string;
  workspaceId?: string;
  action: AppBackendAction;
  sha256?: string;
}
