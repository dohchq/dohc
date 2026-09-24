import { z } from "zod";
import {
  isShareablePath,
  isValidShareVersionId,
  MAX_SHARE_PATHS,
  SHARE_ACCESS_VALUES,
  type ShareAccess,
} from "@dohc/security-contract/share-selector";
import type { RegistryEntry } from "../workspaces/registryStore";
import {
  shareImpactOf,
  type ReachAutomation,
  type ReachRoster,
  type ReachShare,
  type StoppedStep,
} from "./automationReach";

// The share roster: the grants the owner gave on one workspace, as the relay
// last listed them. Grants live only on the relay, and the reach check
// (automationReach.ts) must answer without a network round trip, so the
// owner's computer keeps this copy in the workspace registry.

/** One grant on the roster. */
export interface RosterGrant {
  grantId: string;
  // A claimed grant names an account. A pending invite names only an email.
  recipientUserId: string | null;
  recipientEmail: string | null;
  // The files the grant covers. A path covers itself and everything beneath
  // it. No paths means the whole workspace at `versionId`. Null for a grant
  // on a chat alone.
  files: { paths: string[]; versionId: string | null; access: ShareAccess } | null;
  // The chat a Group or chat grant covers.
  channel: { wireId: string; canPost: boolean } | null;
}

export interface ShareRoster {
  // Rises each time the grants change.
  version: number;
  // Null when the relay listed an active grant on this workspace that dohc
  // cannot read. Its scope is unknown, so the reach check cannot use the rest.
  grants: RosterGrant[] | null;
}

export const SHARE_ROSTER_REFRESH_MS = 10 * 60_000;
// Before a run that reaches past its own Collection, a roster older than this
// is listed again if the relay answers.
export const SHARE_ROSTER_FRESH_MS = 60_000;
// 50 pages of 1,000 share links. Past this the listing is not one dohc can
// check, and the cached roster stays.
const MAX_LINK_PAGES = 50;

const ID = z.string().min(1).max(256);
const PATHS = z.array(z.string().refine(isShareablePath)).max(MAX_SHARE_PATHS);
const FILE_ACCESS = z.enum(SHARE_ACCESS_VALUES);
const CHAT_ACCESS = z.enum(["read-write", "read-only"]);
const RECIPIENT = {
  recipientUserId: ID.nullable(),
  recipientEmail: z.string().min(1).max(320).nullable(),
};

// A selector and a grant's access, read the way the relay wrote them
// (services/sync-relay/src/shareFilter.ts). A Group's read-write edits its
// folder and posts in its chat; read-only views both.
const Scope = z.union([
  z
    .object({
      selector: z.object({ kind: z.literal("group"), channelWireId: ID, paths: PATHS.min(1) }),
      access: CHAT_ACCESS,
    })
    .transform(({ selector, access }) => ({
      files: {
        paths: selector.paths,
        versionId: null,
        access: access === "read-write" ? ("edit" as const) : ("view" as const),
      },
      channel: { wireId: selector.channelWireId, canPost: access === "read-write" },
    })),
  z
    .object({
      selector: z.object({ kind: z.literal("chat-channel"), channelWireId: ID }),
      access: CHAT_ACCESS,
    })
    .transform(({ selector, access }) => ({
      files: null,
      channel: { wireId: selector.channelWireId, canPost: access === "read-write" },
    })),
  z
    .object({
      selector: z
        .object({
          kind: z.never().optional(),
          paths: PATHS,
          versionId: z.string().refine(isValidShareVersionId).nullable(),
        })
        .refine((selector) => selector.paths.length > 0 || selector.versionId !== null),
      access: FILE_ACCESS,
    })
    .transform(({ selector, access }) => ({
      files: { paths: selector.paths, versionId: selector.versionId, access },
      channel: null,
    })),
]);

// A row of GET /sync/shares, granted lane (shareSummaries.ts on the relay).
const GrantedRow = z.object({
  workspaceId: z.string(),
  grantId: ID,
  principalKind: z.enum(["user", "email", "link"]),
  revokedAtMs: z.number().nullable(),
  selector: z.unknown(),
  access: z.unknown(),
  ...RECIPIENT,
});

// A link row of GET /sync/<workspace>/shares/links. The relay lists only the
// active dependents of active links.
const LinkRow = z.object({
  status: z.enum(["active", "revoked"]),
  selector: z.unknown(),
  dependents: z.array(z.object({ grantId: ID, access: FILE_ACCESS, ...RECIPIENT })),
});

const LinkPage = z.object({
  links: z.array(z.unknown()),
  nextCursor: z.string().min(1).max(1024).optional(),
});

const StoredGrant = z.object({
  grantId: ID,
  ...RECIPIENT,
  files: z
    .object({ paths: PATHS, versionId: z.string().refine(isValidShareVersionId).nullable(), access: FILE_ACCESS })
    .nullable(),
  channel: z.object({ wireId: ID, canPost: z.boolean() }).nullable(),
});

function rosterGrant(
  grantId: string,
  recipient: { recipientUserId: string | null; recipientEmail: string | null },
  selector: unknown,
  access: unknown,
): RosterGrant | null {
  if (recipient.recipientUserId === null && recipient.recipientEmail === null) return null;
  const scope = Scope.safeParse({ selector, access });
  if (!scope.success) return null;
  return {
    grantId,
    recipientUserId: recipient.recipientUserId,
    recipientEmail: recipient.recipientEmail,
    ...scope.data,
  };
}

/**
 * The roster for one workspace from the relay's listings: the owner's
 * granted rows, and the dependents of the owner's share links.
 *
 * Link holders are not on the roster: they cannot change files other than
 * live documents (ADR 0002). A dependent is different. It is a person who
 * opened a link in dohc, and the relay lets a dependent with Edit send change
 * proposals, so the roster lists dependents like named grants.
 *
 * Returns null when an active grant on this workspace cannot be read. Throws
 * when the share listing is not the shape the relay sends.
 */
export function rosterGrantsFrom(
  workspaceId: string,
  shares: unknown,
  links: readonly unknown[],
): RosterGrant[] | null {
  const granted = z.object({ granted: z.array(z.unknown()) }).parse(shares).granted;
  const grants: RosterGrant[] = [];
  for (const value of granted) {
    const row = GrantedRow.safeParse(value);
    if (!row.success) return null;
    if (row.data.workspaceId !== workspaceId) continue;
    if (row.data.revokedAtMs !== null || row.data.principalKind === "link") continue;
    const grant = rosterGrant(row.data.grantId, row.data, row.data.selector, row.data.access);
    if (!grant) return null;
    grants.push(grant);
  }
  for (const value of links) {
    const link = LinkRow.safeParse(value);
    if (!link.success) return null;
    if (link.data.status !== "active") continue;
    for (const dependent of link.data.dependents) {
      const grant = rosterGrant(dependent.grantId, dependent, link.data.selector, dependent.access);
      if (!grant) return null;
      grants.push(grant);
    }
  }
  return grants.sort((left, right) => (left.grantId < right.grantId ? -1 : left.grantId > right.grantId ? 1 : 0));
}

/** Lists the roster from the relay. `get` sends one GET with the owner's session. */
export async function listRosterGrants(
  workspaceId: string,
  get: (path: string) => Promise<unknown>,
): Promise<RosterGrant[] | null> {
  const shares = await get("/sync/shares");
  const links: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page === MAX_LINK_PAGES) throw new Error("The relay listed more share links than dohc can check.");
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const body = LinkPage.parse(await get(`/sync/${encodeURIComponent(workspaceId)}/shares/links${query}`));
    links.push(...body.links);
    cursor = body.nextCursor;
    if (cursor === undefined) break;
    if (cursors.has(cursor)) throw new Error("The relay repeated a share link page.");
    cursors.add(cursor);
  }
  return rosterGrantsFrom(workspaceId, shares, links);
}

/**
 * What the reach check knows on this computer. `localUserId` is the
 * signed-in account, which owns a workspace that does not sync.
 */
export function reachRosterFor(entry: RegistryEntry, localUserId: string | null): ReachRoster {
  if (entry.shareView) return { kind: "shared-view" };
  if (!entry.remote) return { kind: "owner", ownerUserId: localUserId, grants: [] };
  const stored = entry.shareRoster;
  if (!stored) return { kind: "unknown", cause: "not-listed" };
  // The registry is a file on disk. A roster it cannot read is unknown, not empty.
  const grants = z.array(StoredGrant).nullable().safeParse(stored.grants);
  if (!grants.success || grants.data === null) return { kind: "unknown", cause: "unreadable" };
  return { kind: "owner", ownerUserId: entry.remote.ownerUserId, grants: grants.data };
}

interface RosterState {
  timer: ReturnType<typeof setInterval> | null;
  listedAtMs: number | null;
  reachable: boolean;
  running: Promise<void> | null;
  again: boolean;
}

/**
 * Keeps each open workspace's roster current: at open, after this computer
 * changes a share, on relay reconnect, and every 10 minutes. The executor
 * asks `forRun` before a run.
 */
export function createShareRosters(dependencies: {
  findWorkspace(workspaceId: string): RegistryEntry | null;
  saveRoster(workspaceId: string, grants: RosterGrant[] | null): void;
  // Throws when the relay does not answer or the session cannot list shares.
  listGrants(workspace: RegistryEntry): Promise<RosterGrant[] | null>;
  localUserId(): string | null;
  logError(workspaceId: string, error: unknown): void;
  nowMs?: () => number;
}) {
  const nowMs = dependencies.nowMs ?? Date.now;
  const states = new Map<string, RosterState>();

  function stateFor(workspaceId: string): RosterState {
    let state = states.get(workspaceId);
    if (!state) {
      state = { timer: null, listedAtMs: null, reachable: true, running: null, again: false };
      states.set(workspaceId, state);
    }
    return state;
  }

  async function listOnce(workspaceId: string, state: RosterState): Promise<void> {
    const workspace = dependencies.findWorkspace(workspaceId);
    if (!workspace?.remote || workspace.shareView) return;
    try {
      const grants = await dependencies.listGrants(workspace);
      dependencies.saveRoster(workspaceId, grants);
      state.listedAtMs = nowMs();
      state.reachable = true;
    } catch (error) {
      state.reachable = false;
      dependencies.logError(workspaceId, error);
    }
  }

  // A request made while a listing runs gets one more listing after it, so a
  // share changed mid-listing is never missed.
  function refresh(workspaceId: string): Promise<void> {
    const state = stateFor(workspaceId);
    if (state.running) {
      state.again = true;
      return state.running;
    }
    const running = (async () => {
      do {
        state.again = false;
        await listOnce(workspaceId, state);
      } while (state.again);
    })().finally(() => {
      state.running = null;
    });
    state.running = running;
    return running;
  }

  function roster(workspaceId: string): ReachRoster {
    const workspace = dependencies.findWorkspace(workspaceId);
    return workspace
      ? reachRosterFor(workspace, dependencies.localUserId())
      : { kind: "unknown", cause: "not-listed" };
  }

  async function forRun(workspaceId: string): Promise<ReachRoster> {
    const state = stateFor(workspaceId);
    const fresh = state.listedAtMs !== null && nowMs() - state.listedAtMs < SHARE_ROSTER_FRESH_MS;
    if (state.running) await state.running;
    else if (!fresh && state.reachable) await refresh(workspaceId);
    return roster(workspaceId);
  }

  return {
    open(workspaceId: string): void {
      const state = stateFor(workspaceId);
      if (state.timer) return;
      state.timer = setInterval(() => void refresh(workspaceId), SHARE_ROSTER_REFRESH_MS);
      state.timer.unref?.();
      void refresh(workspaceId);
    },

    close(workspaceId: string): void {
      const state = states.get(workspaceId);
      if (!state?.timer) return;
      clearInterval(state.timer);
      state.timer = null;
    },

    /** This computer created, ended, or changed a share. Null names no workspace, so every open one refreshes. */
    sharesChanged(workspaceId: string | null): void {
      if (workspaceId !== null) {
        void refresh(workspaceId);
        return;
      }
      for (const [id, state] of states) if (state.timer) void refresh(id);
    },

    /** A relay sync pass succeeded, so the relay answers again. */
    pulled(workspaceId: string): void {
      const state = stateFor(workspaceId);
      if (state.reachable) return;
      state.reachable = true;
      void refresh(workspaceId);
    },

    forRun,

    /** Which automation steps would stop if this share were created. */
    async shareImpact(
      workspaceId: string,
      share: ReachShare,
      automations: readonly ReachAutomation[],
    ): Promise<StoppedStep[]> {
      return shareImpactOf(await forRun(workspaceId), share, automations);
    },
  };
}
