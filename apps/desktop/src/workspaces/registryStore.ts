import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type { ShareViewSelector } from "./shareViewInfo";

// Pure registry persistence: a JSON file of known local workspaces. The
// electron wiring (userData path, test-home seam) lives in
// WorkspaceRegistry.ts; this module is unit-testable with a temp file.

export interface RemoteIdentity {
  serverUrl: string;
  remoteWorkspaceId: string;
  ownerUserId: string;
}

// Ops a share pull SKIPPED, kept with the share record because the skip is
// DURABLE: the pull commits its cursor past a refused op, so that content
// never arrives again unless the granter writes the same path a second time.
// A transient count would clear on the next quiet refresh and on restart,
// while the content stays missing.
export interface ShareSkippedOp {
  originId: string;
  originSeq: number;
  opKind: string;
  // The engine's stable code and its message. The message names the
  // constraint the op broke, and for a version refusal its limit, unit and
  // observed usage.
  code: string;
  detail: string;
  atMs: number;
}

// The relay chooses how many ops it serves; this registry is a local file the
// app rewrites whenever a workspace changes. So the list is retained up to
// MAX_RETAINED_SKIPPED_OPS and the rest are counted, not stored.
export interface ShareSkippedOps {
  ops: ShareSkippedOp[];
  more: number;
  // The coordinates this record has counted, retained ones included. The
  // retained list alone cannot answer "have I counted this?" once an op
  // overflows its cap and is dropped, so a refetched page would count it
  // again on every retry.
  counted?: string[];
  // Bumped on every write that adds a skipped op.
  generation: number;
  // The generation the user has seen. Dismissing RAISES this; it never
  // deletes an op. The cursor has already committed past those ops, so the
  // record is the only remaining evidence of what is missing — destroying it
  // would be an irreversible change behind a one-click control. Hiding is
  // reversible, keeps the coordinates for diagnosis, and makes a later
  // refusal (a higher generation) speak up again on its own.
  acknowledgedGeneration?: number;
  // Whether ops were skipped BEYOND the counted total. Set the first time an
  // op arrives that this record cannot prove it has already counted and
  // cannot remember — past MAX_TRACKED_SKIP_COORDINATES there is nowhere to
  // put it, so it is not counted at all rather than counted again on the next
  // retry. The total stays a number the record can stand behind, and the copy
  // reads "more than N".
  inexact?: boolean;
  // The last batch of unrememberable refusals, as the coordinates themselves.
  // In the inexact regime the record cannot tell a new op from a repeat, so
  // it cannot answer "is this news?" per op — but it can answer "is this the
  // same batch I just saw?", which is what keeps a refetched page from
  // re-raising a warning the user dismissed. A batch it has not just seen
  // moves the generation: more content was skipped and its cursor committed,
  // and staying silent would leave that hidden behind the acknowledgement.
  //
  // The coordinates, not a hash of them. A 32-bit digest is forgeable — two
  // one-op batches collide with a little searching, and the second would then
  // commit silently behind an acknowledgement of the first. The identity here
  // IS the data, so there is nothing to forge. A batch too large to keep
  // (`MAX_TRACKED_BATCH_COORDINATES`) records no identity at all, and the
  // next batch is treated as news — visible rather than silent.
  lastUncountedBatch?: string[];
}

// The largest batch of unrememberable refusals this record keeps the identity
// of. A page carries at most `MAX_PULL_OPS` ops; keeping every coordinate of
// every such page would put the relay in charge of this file's size. Past
// this, the record keeps no identity and the next batch reads as news.
export const MAX_TRACKED_BATCH_COORDINATES = 64;

function sameBatch(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((key, index) => key === right[index]);
}

export const MAX_RETAINED_SKIPPED_OPS = 20;

// Coordinates one share's skip record remembers having counted. Far above the
// retained-op cap on purpose: a coordinate is a short string, and remembering
// it is the whole reason a refetched page does not count the same op twice.
//
// A per-origin high-water mark was the cheaper shape and it was wrong: it can
// only stand for "everything below this is counted" while ops arrive in
// sequence order, and nothing checks that — `validate_share_page` checks the
// page cursor, not the order within an origin. A relay serving seq 100 then
// seq 99 would have had 99 read as a retry of something never counted. A set
// makes no ordering assumption at all.
export const MAX_TRACKED_SKIP_COORDINATES = 512;

function coordinate(op: { originId: string; originSeq: number }): string {
  return `${op.originId}\u0000${op.originSeq}`;
}

/**
 * Merge newly refused ops into a share's durable record.
 *
 * Idempotent by origin coordinate: a page can be re-fetched (a crash before
 * the cursor commit, a retry after a later page failed), and the same op must
 * not stack up. Ops beyond the retention cap raise `more` instead.
 */
export function mergeShareSkippedOps(
  existing: ShareSkippedOps | undefined,
  incoming: readonly ShareSkippedOp[],
): ShareSkippedOps {
  const ops = [...(existing?.ops ?? [])];
  // Every coordinate this record has counted: the retained ops, plus the ones
  // it counted and could not keep. Membership is the ONLY duplicate test —
  // there is no ordering assumption to break.
  const counted = new Set([
    ...ops.map(coordinate),
    ...(existing?.counted ?? []),
  ]);
  let added = false;
  let inexact = existing?.inexact ?? false;
  const uncounted: string[] = [];
  for (const op of incoming) {
    const key = coordinate(op);
    if (counted.has(key)) continue;
    if (counted.size >= MAX_TRACKED_SKIP_COORDINATES) {
      // Nowhere left to remember it, so a refetched page could not tell this
      // op from a new one. Counting it would let the total drift upward, so
      // the count stops and the record says it is incomplete instead.
      //
      // Visibility is a separate question from exactness. `inexact` flips
      // once, but every LATER batch of ops the record cannot place is more
      // content skipped past a committed cursor — leaving those silent would
      // hide them behind an acknowledgement forever. They are counted as news
      // per BATCH below, which is the identity this record still has.
      inexact = true;
      uncounted.push(key);
      continue;
    }
    counted.add(key);
    added = true;
    if (ops.length < MAX_RETAINED_SKIPPED_OPS) ops.push(op);
  }
  // A batch of ops the record could not place is news UNLESS it is the batch
  // it just saw — that is the retry, and a retry must not resurrect an
  // acknowledged warning.
  const batch =
    uncounted.length > 0 && uncounted.length <= MAX_TRACKED_BATCH_COORDINATES
      ? [...uncounted].sort()
      : undefined;
  const lastUncountedBatch =
    uncounted.length > 0 ? batch : existing?.lastUncountedBatch;
  if (uncounted.length > 0 && !sameBatch(batch, existing?.lastUncountedBatch)) {
    added = true;
  }
  // Only a write that recorded something moves the generation: a refetched
  // page that changes nothing must not resurrect an acknowledged warning.
  const generation = (existing?.generation ?? 0) + (added ? 1 : 0);
  return {
    ops,
    // Derived, never accumulated: one counter cannot drift from the set it
    // counts.
    more: counted.size - ops.length,
    counted: [...counted],
    generation,
    ...(existing?.acknowledgedGeneration !== undefined
      ? { acknowledgedGeneration: existing.acknowledgedGeneration }
      : {}),
    ...(inexact ? { inexact: true } : {}),
    ...(lastUncountedBatch !== undefined ? { lastUncountedBatch } : {}),
  };
}

/**
 * Record that the user has seen everything up to `generation`.
 *
 * Nothing is deleted. A refusal recorded between the render and the click has
 * a higher generation, so it stays unacknowledged and the warning comes back
 * on its own — the race a destructive clear had to guard against does not
 * exist here. An acknowledgement never moves backwards, so a stale click
 * cannot un-see a newer one.
 */
export function acknowledgeShareSkips(
  skipped: ShareSkippedOps,
  generation: number,
): ShareSkippedOps {
  return {
    ...skipped,
    acknowledgedGeneration: Math.max(
      skipped.acknowledgedGeneration ?? 0,
      Math.min(generation, skipped.generation),
    ),
  };
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
  //
  // The `access` level rides with it (#646): the level is part of the grant,
  // pinned once and enforced on every pull, not re-asked per refresh.
  grantedSelector: ShareViewSelector;
  ended?: boolean;
  // Ops this share's pulls skipped, and why. Durable on purpose: the cursor
  // has moved past them, so the content stays missing until the granter
  // writes those paths again. Cleared only when the user dismisses it.
  skippedOps?: ShareSkippedOps;
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
  grantedSelector: ShareViewSelector;
  ended?: boolean;
  // Same durable skip record as ShareViewIdentity.skippedOps, for the same
  // reason: a mount's pulls commit past a refused op too.
  skippedOps?: ShareSkippedOps;
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

    /**
     * Mark a shared view ended, merging into whatever the record holds NOW.
     *
     * The caller learns a share ended from a pull, and that same pull may have
     * recorded skipped ops on its way. Writing back the pre-pull snapshot it
     * was holding would drop them, and the cursor has already committed past
     * those ops. So the read-and-merge lives here, where a caller cannot pass
     * a stale copy at all.
     */
    /**
     * Record that the user has seen a share's skipped ops. Hides the warning;
     * keeps the evidence. `shareId` names a mounted share, absent means the
     * workspace's own shared view.
     */
    acknowledgeShareSkips(
      workspaceId: string,
      shareId: string | undefined,
      generation: number,
    ): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      // Copy-on-write, like completeJoinBootstrap above: the cache may only
      // show the warning hidden once the same change reached disk. Mutating
      // first and writing after would hide it in this process while the file
      // still holds it — quiet now, back after a restart.
      let updated: RegistryEntry;
      if (shareId === undefined) {
        const shareView = entry.shareView;
        if (!shareView) throw new Error(`Unknown shared view: ${workspaceId}`);
        if (!shareView.skippedOps) return;
        updated = {
          ...entry,
          shareView: {
            ...shareView,
            skippedOps: acknowledgeShareSkips(shareView.skippedOps, generation),
          },
        };
      } else {
        const mounts = entry.shareMounts ?? [];
        const target = mounts.find((mount) => mount.shareId === shareId);
        if (!target) throw new Error(`Unknown share mount: ${shareId}`);
        const skippedOps = target.skippedOps;
        if (!skippedOps) return;
        updated = {
          ...entry,
          shareMounts: mounts.map((mount) =>
            mount.shareId === shareId
              ? {
                  ...mount,
                  skippedOps: acknowledgeShareSkips(skippedOps, generation),
                }
              : mount,
          ),
        };
      }
      write({
        ...registry,
        workspaces: registry.workspaces.map((w) => (w === entry ? updated : w)),
      });
    },

    markShareViewEnded(workspaceId: string): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry?.shareView) throw new Error(`Unknown shared view: ${workspaceId}`);
      // Copy-on-write for the same reason as the acknowledgement above.
      const updated: RegistryEntry = {
        ...entry,
        shareView: { ...entry.shareView, ended: true },
      };
      write({
        ...registry,
        workspaces: registry.workspaces.map((w) => (w === entry ? updated : w)),
      });
    },

    // MU-C4: replace the workspace's joined shared-channel set. Upserts and
    // removals both go through this one write (callers compute the next set),
    // keeping the file format append-simple.
    setSharedChannels(
      workspaceId: string,
      sharedChannels: JoinedSharedChannel[],
    ): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      // Keep the cached entry unchanged until the replacement reaches disk.
      // A failed write must not make a joined channel appear changed or gone
      // for the rest of this process.
      const updated: RegistryEntry = { ...entry };
      if (sharedChannels.length === 0) delete updated.sharedChannels;
      else updated.sharedChannels = sharedChannels;
      write({
        ...registry,
        workspaces: registry.workspaces.map((w) => (w === entry ? updated : w)),
      });
    },

    // Share mounts: replace the workspace's mount set (same replace-the-set
    // write shape as setSharedChannels — callers compute the next set).
    setShareMounts(workspaceId: string, shareMounts: ShareMountRecord[]): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      // Keep an empty set as a durable ownership tombstone. A last unmount
      // can leave its projection folder behind when safe removal is refused;
      // deleting the field would immediately promote those known share bytes
      // to ordinary local authority on the next read.
      const updated: RegistryEntry = { ...entry, shareMounts };
      write({
        ...registry,
        workspaces: registry.workspaces.map((w) => (w === entry ? updated : w)),
      });
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
