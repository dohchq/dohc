import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Pure registry persistence: a JSON file of known local workspaces. The
// electron wiring (userData path, test-home seam) lives in
// WorkspaceRegistry.ts; this module is unit-testable with a temp file.

export interface RemoteIdentity {
  serverUrl: string;
  remoteWorkspaceId: string;
  ownerUserId: string;
}

// A shared VIEW received through a relay share grant (PR 18): read-only,
// refreshed from the share, never pushed. `ended` marks a revoked share —
// the local copy stays readable but stops refreshing.
export interface ShareViewIdentity {
  shareId: string;
  granterEmail: string | null;
  // The selector the relay stated for this share, pinned here when the record
  // is created so every later pull enforces it locally instead of trusting
  // the relay to send only what it granted. Empty `paths` with a `versionId`
  // is a whole-workspace version share; `versionId` null follows main.
  //
  // REQUIRED. Both accept paths resolve a selector before the record exists,
  // so a record without one is damaged, never merely old. Its refresh refuses
  // rather than asking the relay for a replacement — that ask is the one a
  // relay able to damage a record would answer with a wider scope.
  grantedSelector: { paths: string[]; versionId: string | null };
  ended?: boolean;
  // The relay this share was opened from. A refresh only ever runs against
  // this origin relay; signed into a different relay, the refresh is skipped
  // rather than misreading a 404 as "the share ended" (PR 18 gate fix).
  // Optional for views registered before this field existed.
  relayUrl?: string;
}

// A shared CHANNEL this workspace joined through a chat-channel grant
// (MU-C4): bidirectional — pulled into the local chat store and (when
// read-write) pushed back through the member append route. `ended` marks a
// revoked grant: the locally replayed copy stays readable but stops syncing.
export interface JoinedSharedChannel {
  shareId: string;
  channelWireId: string;
  access: "read-write" | "read-only";
  granterEmail: string | null;
  // Same origin-relay pin as ShareViewIdentity.relayUrl: refreshes only ever
  // run against the relay the share was joined from.
  relayUrl: string;
  recipientUserId: string;
  ended?: boolean;
}

// A share MOUNTED into a host workspace: the received share materializes
// under shared-with-me/<label>/ inside the host root — ordinary read-only
// files the user's agent can read with normal tools — refreshed from the
// share's filtered op log, never pushed. `ended` marks a revoked share:
// the mounted copy stays readable but stops refreshing.
export interface ShareMountRecord {
  shareId: string;
  // Folder name under shared-with-me/ (a single path segment; re-validated
  // on every refresh — the registry file is data, not a write path).
  label: string;
  granterEmail: string | null;
  // Same origin-relay pin as ShareViewIdentity.relayUrl: refreshes only ever
  // run against the relay the share was mounted from.
  relayUrl: string;
  // Account pin: shares are addressed to an account, and recipient routes
  // 404 identically for "not yours" and "revoked". Signed into a DIFFERENT
  // account, a refresh must SKIP (not flip the mount to ended). Null on
  // records from before this field existed — those refresh as before.
  recipientEmail?: string | null;
  // Same REQUIRED pinned selector as ShareViewIdentity.grantedSelector, for
  // the same reason: the mount's pulls enforce it against the relay's
  // selection, and a record without one is damaged.
  grantedSelector: { paths: string[]; versionId: string | null };
  ended?: boolean;
}

export interface RegistryEntry extends CreatedWorkspace {
  // Present only after the user explicitly enables cloud sync (Phase 9).
  remote?: RemoteIdentity;
  // Durable join gate: true from registration until the first pull has
  // materialized and committed. Boot-time local writers must skip the entry.
  joinBootstrapPending?: true;
  shareView?: ShareViewIdentity;
  // MU-C4: shared channels joined INTO this workspace's chat store.
  sharedChannels?: JoinedSharedChannel[];
  // Share mounts materialized into this workspace's shared-with-me/.
  shareMounts?: ShareMountRecord[];
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

    completeJoinBootstrap(workspaceId: string): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      if (entry.joinBootstrapPending !== true) return;
      // Copy-on-write: the durable join gate may only clear in the cache when
      // the same change reached disk — a failed write() must not leave this
      // process believing bootstrap completed while the file still gates it.
      const updated = { ...entry };
      delete updated.joinBootstrapPending;
      write({
        ...registry,
        workspaces: registry.workspaces.map((w) => (w === entry ? updated : w)),
      });
    },

    setShareView(workspaceId: string, shareView: ShareViewIdentity): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      entry.shareView = shareView;
      write(registry);
    },

    // MU-C4: replace the workspace's joined shared-channel set. Upserts and
    // removals both go through this one write (callers compute the next set),
    // keeping the file format append-simple.
    setSharedChannels(workspaceId: string, sharedChannels: JoinedSharedChannel[]): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      if (sharedChannels.length === 0) delete entry.sharedChannels;
      else entry.sharedChannels = sharedChannels;
      write(registry);
    },

    // Share mounts: replace the workspace's mount set (same replace-the-set
    // write shape as setSharedChannels — callers compute the next set).
    setShareMounts(workspaceId: string, shareMounts: ShareMountRecord[]): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      if (shareMounts.length === 0) delete entry.shareMounts;
      else entry.shareMounts = shareMounts;
      write(registry);
    },

    // Failed-join rollback (0P-C gate fix): removes a registration this
    // process just created. Unknown ids are a no-op — the rollback path must
    // never throw over state that is already gone.
    remove(workspaceId: string): void {
      const registry = read();
      const remaining = registry.workspaces.filter((w) => w.workspaceId !== workspaceId);
      if (remaining.length === registry.workspaces.length) return;
      write({ ...registry, workspaces: remaining });
    },
  };
}
