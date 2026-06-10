import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Pure registry persistence: a JSON file of known local workspaces. The
// electron wiring (userData path, test-home seam) lives in
// WorkspaceRegistry.ts; this module is unit-testable with a temp file.

export interface RemoteIdentity {
  serverUrl: string;
  remoteWorkspaceId: string;
}

export interface RegistryEntry extends CreatedWorkspace {
  // Present only after the user explicitly enables cloud sync (Phase 9).
  remote?: RemoteIdentity;
}

interface RegistryFile {
  version: 1;
  workspaces: RegistryEntry[];
}

export function createRegistryStore(registryFile: string) {
  function read(): RegistryFile {
    try {
      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
      return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
    } catch {
      return { version: 1, workspaces: [] };
    }
  }

  function write(registry: RegistryFile): void {
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  }

  return {
    registryFile,

    list(): RegistryEntry[] {
      return read().workspaces;
    },

    find(workspaceId: string): RegistryEntry | null {
      return read().workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
    },

    register(workspace: RegistryEntry): void {
      const registry = read();
      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
        throw new Error(`Folder is already attached: ${workspace.rootPath}`);
      }
      // Two roots with one workspaceId would make file operations silently
      // target whichever registered first (e.g., attaching a copied folder).
      if (
        registry.workspaces.some(
          (w) => w.workspaceId === workspace.workspaceId,
        )
      ) {
        throw new Error(
          `This folder carries the identity of an already attached workspace (${workspace.workspaceId}). ` +
            `If this is a copy, remove its .dohc folder to attach it as a new workspace.`,
        );
      }
      registry.workspaces.push(workspace);
      write(registry);
    },

    setRemote(workspaceId: string, remote: RemoteIdentity): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      entry.remote = remote;
      write(registry);
    },
  };
}
