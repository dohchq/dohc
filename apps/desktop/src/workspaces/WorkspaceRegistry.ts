import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { createRegistryStore, type RegistryEntry } from "./registryStore";

// Electron wiring over the pure registry store. The registry lives in
// userData; in test mode it lives under DOHC_TEST_HOME so E2E runs are
// hermetic (gated on test env AND unpackaged build).

function testHome(): string | null {
  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
    ? (process.env.DOHC_TEST_HOME ?? null)
    : null;
}

export function effectiveHome(): string {
  return testHome() ?? homedir();
}

// Where desktop-level state files live (registry, cloud credentials):
// userData in production, the hermetic test home under E2E.
export function stateDir(): string {
  return testHome() ?? app.getPath("userData");
}

let cachedStore: ReturnType<typeof createRegistryStore> | null = null;

function store() {
  if (!cachedStore) {
    const base = testHome() ?? app.getPath("userData");
    cachedStore = createRegistryStore(join(base, "dohc-workspaces.json"));
  }
  return cachedStore;
}

export function listWorkspaces(): RegistryEntry[] {
  return store().list();
}

export function registerWorkspace(workspace: CreatedWorkspace): void {
  store().register(workspace);
}

export function findWorkspace(workspaceId: string): RegistryEntry | null {
  return store().find(workspaceId);
}

export function setWorkspaceRemote(
  workspaceId: string,
  remote: { serverUrl: string; remoteWorkspaceId: string },
): void {
  store().setRemote(workspaceId, remote);
}
