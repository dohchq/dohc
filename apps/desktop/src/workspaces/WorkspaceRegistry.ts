import { app } from "electron";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RelayAutomationHost } from "@dohc/workspace-contracts/relay";
import type { RosterListing } from "../automations/shareRoster";
import {
  createRegistryStore,
  type JoinedSharedChannel,
  type RegistryEntry,
  type RemoteIdentity,
  type ShareMountRecord,
  type ShareViewIdentity,
} from "./registryStore";
import { recordSynced } from "./syncHistory";

// Electron wiring over the pure registry store. The registry lives in
// userData; in test mode it lives under DOHC_TEST_HOME so E2E runs are
// hermetic (gated on test env and unpackaged build).

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
  const canonicalRoot = realpathSync.native(workspace.rootPath);
  for (const existing of store().list()) {
    let existingCanonicalRoot: string;
    try {
      existingCanonicalRoot = realpathSync.native(existing.rootPath);
    } catch {
      continue;
    }
    if (existingCanonicalRoot === canonicalRoot) {
      throw new Error(`Folder is already attached: ${existing.rootPath}`);
    }
  }
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
  // The folder keeps the fact too, so a forgotten and reattached copy still
  // knows it synced. See syncHistory.ts.
  const workspace = findWorkspace(workspaceId);
  if (workspace && !workspace.remote) recordSynced(workspace.rootPath);
  store().setRemote(workspaceId, remote);
}

export function markWorkspaceOpened(workspaceId: string, atMs = Date.now()): void {
  store().markOpened(workspaceId, atMs);
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

// The user has seen an automation's failures up to `generation`: hide the
// notice, keep the engine's failed claim rows. See
// registryStore.acknowledgeAutomationFailure.
export function acknowledgeWorkspaceAutomationFailure(
  workspaceId: string,
  automationId: string,
  generation: number,
): void {
  store().acknowledgeAutomationFailure(workspaceId, automationId, generation);
}

// The relay's latest answer for which computer runs the workspace's
// schedules. See registryStore.setAutomationHost.
export function setWorkspaceAutomationHost(workspaceId: string, host: RelayAutomationHost | null): void {
  store().setAutomationHost(workspaceId, host);
}

// A new listing of the workspace's grants. See registryStore.setShareRoster.
export function setWorkspaceShareRoster(
  workspaceId: string,
  listing: RosterListing,
  pulledAfter: boolean,
): void {
  store().setShareRoster(workspaceId, listing, pulledAfter);
}

// A pull from the relay started after the stored listing. See
// registryStore.markShareRosterPulled.
export function markWorkspaceShareRosterPulled(workspaceId: string): void {
  store().markShareRosterPulled(workspaceId);
}

export function setWorkspaceShareView(
  workspaceId: string,
  shareView: ShareViewIdentity,
): void {
  const workspace = findWorkspace(workspaceId);
  if (workspace && !workspace.shareView) recordSynced(workspace.rootPath);
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
