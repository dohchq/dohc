export type AppBackendAction = "activate" | "invoke" | "upload" | "file" | "attempt" | "descriptor" | "blob";
export interface AppBackendRoute {
  route: "app-backend";
  publicationId: string;
  workspaceId?: string;
  action: AppBackendAction;
  sha256?: string;
}
