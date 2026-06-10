import { z } from "zod";

// Typed contract for everything the preload bridge exposes. Main-process
// handlers validate results against these before returning them. Payload
// validation starts with the first payload-accepting channel (Phase 4).
// The renderer never sees raw Electron APIs.

export const VersionResult = z.string().min(1);
export type VersionResult = z.infer<typeof VersionResult>;

export const PickWorkspaceRootResult = z.string().min(1).nullable();
export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;

export const WorkspaceSummary = z.object({
  workspaceId: z.string().min(1),
  rootPath: z.string().min(1),
  kind: z.enum(["personal", "shared", "cloud-only"]),
  mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceRegistryResult = z.object({
  workspaces: z.array(WorkspaceSummary),
});
export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;

export const DefaultWorkspaceRootResult = z.string().min(1);

export const CreateLocalWorkspacePayload = z.object({
  rootPath: z.string().min(1),
  kind: z.enum(["personal", "shared"]),
});
export type CreateLocalWorkspacePayload = z.infer<
  typeof CreateLocalWorkspacePayload
>;

export const ListWorkspaceFilesPayload = z.object({
  workspaceId: z.string().min(1),
});

export const WorkspaceFileEntry = z.object({
  path: z.string().min(1),
  kind: z.enum(["file", "database", "app-source"]),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;

export const ListWorkspaceFilesResult = z.object({
  files: z.array(WorkspaceFileEntry),
});
export type ListWorkspaceFilesResult = z.infer<typeof ListWorkspaceFilesResult>;

export const CreateWorkspaceFilePayload = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1),
});

export const CreateWorkspaceFileResult = z.object({
  path: z.string().min(1),
});

export const ImportWorkspaceFilesPayload = z.object({
  workspaceId: z.string().min(1),
});

export const ImportWorkspaceFilesResult = z.object({
  imported: z.array(z.string().min(1)),
});

export const LaunchMarksResult = z.object({
  appReadyMs: z.number().positive(),
  firstWindowMs: z.number().positive(),
  firstPaintMs: z.number().positive(),
});
export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;

export interface DohcDesktopBridge {
  getVersion(): Promise<VersionResult>;
  pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
  getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
  getDefaultWorkspaceRoot(): Promise<string>;
  createLocalWorkspace(
    payload: CreateLocalWorkspacePayload,
  ): Promise<WorkspaceSummary>;
  listWorkspaceFiles(payload: {
    workspaceId: string;
  }): Promise<ListWorkspaceFilesResult>;
  createWorkspaceFile(payload: {
    workspaceId: string;
    relativePath: string;
  }): Promise<{ path: string }>;
  importWorkspaceFiles(payload: {
    workspaceId: string;
  }): Promise<{ imported: string[] }>;
}
