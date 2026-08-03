import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createRegistryStore,
  type JoinedSharedChannel,
  type RegistryEntry,
  type RemoteIdentity,
  type ShareMountRecord,
  type ShareViewIdentity,
} from "./registryStore";

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

export function registerWorkspace(workspace: RegistryEntry): void {
  store().register(workspace);
}

export function findWorkspace(workspaceId: string): RegistryEntry | null {
  return store().find(workspaceId);
}

// Failed-join rollback (0P-C gate fix): unregister a workspace this process
// just created. No-op for unknown ids.
export function removeWorkspace(workspaceId: string): void {
  store().remove(workspaceId);
}

export function setWorkspaceRemote(
  workspaceId: string,
  remote: RemoteIdentity,
): void {
  store().setRemote(workspaceId, remote);
}

export function completeWorkspaceJoinBootstrap(workspaceId: string): void {
  store().completeJoinBootstrap(workspaceId);
}

// The user has seen a share's skipped ops: hide the warning, keep the
// evidence. See registryStore.acknowledgeShareSkips.
export function acknowledgeWorkspaceShareSkips(
  workspaceId: string,
  shareId: string | undefined,
  generation: number,
): void {
  store().acknowledgeShareSkips(workspaceId, shareId, generation);
}

export function setWorkspaceShareView(
  workspaceId: string,
  shareView: ShareViewIdentity,
): void {
  store().setShareView(workspaceId, shareView);
}

// A shared view ended: merged into the record as it stands, never written
// back from a caller's pre-pull snapshot. See registryStore.markShareViewEnded.
export function endWorkspaceShareView(workspaceId: string): void {
  store().markShareViewEnded(workspaceId);
}

// MU-C4: the workspace's joined shared channels (replace-the-set write).
export function setWorkspaceSharedChannels(
  workspaceId: string,
  sharedChannels: JoinedSharedChannel[],
): void {
  store().setSharedChannels(workspaceId, sharedChannels);
}

// Share mounts: the workspace's mounted shares (replace-the-set write).
export function setWorkspaceShareMounts(
  workspaceId: string,
  shareMounts: ShareMountRecord[],
): void {
  store().setShareMounts(workspaceId, shareMounts);
}
