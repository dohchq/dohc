import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RelayAutomationHost } from "@dohc/workspace-contracts/relay";
import type { RosterListing } from "@dohc/automation-executor/roster-listing";
import {
  createRegistryStore,
  type JoinedSharedChannel,
  type RegistryEntry,
  type RemoteIdentity,
  type ShareMountRecord,
  type ShareViewIdentity,
} from "./registryStore";
import { canonicalWorkspaceRoot, FOLDER_CHANGED } from "./createWorkspaceFolder";
import { storedShareMounts } from "./shareViewFilesTarget";
import { recordReceivedShare, recordSynced } from "./syncHistory";

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

// Saves only a root that is its folder's real path, the one every workspace
// operation receives. A root that no longer resolves to itself changed after
// createWorkspaceFolder checked it, so nothing is saved.
export function registerWorkspace(workspace: RegistryEntry): void {
  if (canonicalWorkspaceRoot(workspace.rootPath) !== workspace.rootPath) {
    throw new Error(FOLDER_CHANGED);
  }
  for (const existing of store().list()) {
    let existingRoot: string;
    try {
      existingRoot = canonicalWorkspaceRoot(existing.rootPath);
    } catch {
      continue;
    }
    if (existingRoot === workspace.rootPath) {
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

export async function setWorkspaceRemote(
  workspaceId: string,
  remote: RemoteIdentity,
): Promise<void> {
  // The folder keeps the fact too, so a forgotten and reattached copy still
  // knows it synced. See syncHistory.ts.
  const workspace = findWorkspace(workspaceId);
  if (workspace && !workspace.remote) await recordSynced(workspace.rootPath);
  store().setRemote(workspaceId, remote);
}

export function pauseWorkspaceRemote(workspaceId: string, syncPause?: import("@dohc/workspace-contracts/workspace-sync").WorkspaceSyncPause): void {
  store().pauseRemote(workspaceId, syncPause);
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
  listedAtMs: number,
): void {
  store().setShareRoster(workspaceId, listing, pulledAfter, listedAtMs);
}

// A pull from the relay started after the stored listing. See
// registryStore.markShareRosterPulled.
export function markWorkspaceShareRosterPulled(workspaceId: string): void {
  store().markShareRosterPulled(workspaceId);
}

export async function setWorkspaceShareView(
  workspaceId: string,
  shareView: ShareViewIdentity,
): Promise<void> {
  const workspace = findWorkspace(workspaceId);
  if (workspace && !workspace.shareView) await recordSynced(workspace.rootPath);
  store().setShareView(workspaceId, shareView);
}

// A shared view ended: merged into the record as it stands, never written
// back from a caller's pre-pull snapshot. See registryStore.markShareViewEnded.
export function endWorkspaceShareView(workspaceId: string): void {
  store().markShareViewEnded(workspaceId);
}

// Apply received-share changes against the current cached registry entry.
export function reconcileWorkspaceRecipientShares(
  workspaceId: string,
  reconcile: (entry: Readonly<RegistryEntry>) => RegistryEntry | null,
): boolean {
  return store().reconcileRecipientShares(workspaceId, reconcile);
}

// MU-C4: change the workspace's joined shared channels. See updateReceived.
export function updateWorkspaceSharedChannels(
  workspaceId: string,
  update: (current: readonly JoinedSharedChannel[]) => readonly JoinedSharedChannel[],
): Promise<void> {
  return updateReceived(workspaceId, entry => entry.sharedChannels ?? [], update,
    next => store().setSharedChannels(workspaceId, next));
}

// Share mounts: change the workspace's mounted shares. See updateReceived.
export function updateWorkspaceShareMounts(
  workspaceId: string,
  update: (current: readonly ShareMountRecord[]) => readonly ShareMountRecord[],
): Promise<void> {
  return updateReceived(workspaceId, storedShareMounts, update,
    next => store().setShareMounts(workspaceId, next));
}

// The folder keeps that a share came in before the registry does, so leaving
// or removing it later cannot make the workspace look never shared. See
// syncHistory.ts. `update` runs on the set as it stands after that wait and
// is stored in the same step, so a change made meanwhile is kept; it may run
// twice and throws to change nothing. Returning `current` stores nothing.
async function updateReceived<Row>(
  workspaceId: string,
  stored: (entry: RegistryEntry) => readonly Row[],
  update: (current: readonly Row[]) => readonly Row[],
  commit: (next: Row[]) => void,
): Promise<void> {
  for (let recorded = false; ; recorded = true) {
    const workspace = findWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const current = stored(workspace);
    const next = update(current);
    if (next === current) return;
    if (recorded || next.length === 0) return commit([...next]);
    await recordReceivedShare(workspace.rootPath);
  }
}
