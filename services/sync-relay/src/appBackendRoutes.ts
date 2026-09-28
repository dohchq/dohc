export type AppBackendAction = "activate" | "invoke" | "upload" | "file" | "attempt" | "descriptor" | "summary" | "blob";
export interface AppBackendRoute {
  route: "app-backend";
  publicationId: string;
  workspaceId?: string;
  action: AppBackendAction;
  sha256?: string;
}
