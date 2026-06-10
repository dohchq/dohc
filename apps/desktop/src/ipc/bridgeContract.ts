import { z } from "zod";

// Typed contract for everything the preload bridge exposes. Main-process
// handlers validate results against these before returning them. Payload
// validation starts with the first payload-accepting channel (Phase 4).
// The renderer never sees raw Electron APIs.

export const VersionResult = z.string().min(1);
export type VersionResult = z.infer<typeof VersionResult>;

export const PickWorkspaceRootResult = z.string().min(1).nullable();
export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;

// The real registry arrives in Phase 4; the contract starts narrow.
export const WorkspaceRegistryResult = z.object({
  workspaces: z.array(
    z.object({
      workspaceId: z.string().min(1),
      rootPath: z.string().min(1),
      kind: z.enum(["personal", "shared", "cloud-only"]),
      mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
    }),
  ),
});
export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;

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
}
