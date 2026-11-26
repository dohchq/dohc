export type AppBackendAction =
  | "activate"
  | "invoke"
  | "upload"
  | "file"
  | "attempt"
  /** A link app waits here for its Collection to change. */
  | "events"
  | "descriptor"
  | "summary"
  /** A person allows the Member app they reviewed. */
  | "consent"
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
