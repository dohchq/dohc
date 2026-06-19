import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  // The process exclusively owns this file (single-instance lock), so the
  // parsed registry is cached after first read and refreshed on write.
  let cache: RegistryFile | null = null;

  function read(): RegistryFile {
    if (cache) return cache;
    let text: string;
    try {
      text = readFileSync(registryFile, "utf8");
    } catch (error) {
      // Only a genuinely absent file is a fresh empty registry. A permission
      // or I/O error must NOT be treated as "no workspaces" — that would let
      // the next write() clobber a registry we simply failed to read.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Cannot read workspace registry (${registryFile}); refusing to overwrite it.`,
        );
      }
      cache = { version: 1, workspaces: [] };
      return cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A present-but-corrupt file is NOT "no workspaces" — refuse rather
      // than let the next write() collapse real data to empty.
      throw new Error(
        `Workspace registry is corrupt (${registryFile}); refusing to overwrite it.`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Workspace registry has an unexpected shape (${registryFile}).`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== 1) {
      // A future-version registry must be preserved, never silently wiped.
      throw new Error(
        `Workspace registry version ${String(obj.version)} is newer than supported; refusing to overwrite it.`,
      );
    }
    if (!Array.isArray(obj.workspaces)) {
      throw new Error(`Workspace registry "workspaces" is not an array (${registryFile}).`);
    }
    cache = { version: 1, workspaces: obj.workspaces as RegistryEntry[] };
    return cache;
  }

  function write(registry: RegistryFile): void {
    mkdirSync(dirname(registryFile), { recursive: true });
    // Atomic: write a temp file then rename over the target so a crash or
    // concurrent reader never sees a half-written registry.
    const tmp = `${registryFile}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
    renameSync(tmp, registryFile);
    cache = registry;
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
