import { asRecord } from "@dohc/workspace-core";
import type { WorkspaceSearchResult } from "@dohc/workspace-contracts/retrieval";
import { DaemonRefusalError, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import { currentAccountFeedCursor } from "./accountFeed";
import { badRequest } from "./errors";
import { untilAborted } from "./namedLiveFrameHost";
import { pathCollisionKey } from "./pathCollisionKey";
import { pathShown, type PhoneMember } from "./phoneMember";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import { withheldLinkText } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import { workspaceFileReach } from "./workspaceReach";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PREFIXES = 32;

export interface PhoneSearchHit {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly objectId?: string;
}

export interface PhoneSearchResult {
  readonly ok: true;
  readonly results: readonly PhoneSearchHit[];
  readonly indexBuilding: boolean;
  readonly truncated: boolean;
  readonly complete: boolean;
}

export interface PhoneSearchFiles {
  getActiveVersion(input: { workspaceId: string }): Promise<{ id: string } | null>;
  listTextFileMetadata(input: {
    workspaceId: string;
    versionId: string;
  }): Promise<readonly { path: string }[]>;
  retrieveWorkspace(input: {
    query: string;
    surfaces: ["page"];
    pathPrefix?: string;
    includeNeighbors: false;
    limit: number;
  }): Promise<WorkspaceSearchResult>;
}

const isInvalidQuery = (e: unknown) =>
  (e instanceof DaemonRefusalError && e.wireCode === "INVALID_PARAMS") ||
  (e instanceof EngineRequestError && e.wireError?.code === "INVALID_PARAMS");

const hasFolderRules = (m: PhoneMember) =>
  m.selector.reach.folderLevel("") === null || m.selector.reach.evaluated.rules.length > 0;

function visiblePrefixes(paths: readonly string[], member: PhoneMember, query: string): string[] {
  const ruled = member.selector.reach.evaluated.rules
    .map(([f]) => pathCollisionKey(f))
    .filter(Boolean);
  const folders = new Set<string>();
  const files = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    let clean: string | null = null;
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      const folded = pathCollisionKey(dir);
      if (
        member.selector.reach.folderLevel(dir) !== null &&
        !ruled.some((r) => r.startsWith(`${folded}/`))
      ) {
        clean = dir;
        break;
      }
    }
    if (clean !== null) folders.add(clean);
    else files.add(path);
  }
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const rank = (p: string) => (tokens.some((t) => p.toLowerCase().includes(t)) ? 0 : 1);
  return [
    ...[...folders].sort(),
    ...[...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
  ];
}

export function parsePhoneSearchArgs(args: unknown): { query: string; limit: number } {
  const record = asRecord(args);
  if (!record || Object.keys(record).some((k) => k !== "query" && k !== "limit"))
    throw badRequest("the arguments do not fit searchWorkspace");
  const query = typeof record.query === "string" ? record.query.trim() : "";
  const limit = record.limit === undefined ? DEFAULT_LIMIT : record.limit;
  if (
    !query ||
    query.length > 512 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  )
    throw badRequest("the arguments do not fit searchWorkspace");
  return { query, limit };
}

export async function searchWorkspacePages(
  files: PhoneSearchFiles,
  input: {
    workspaceId: string;
    query: string;
    limit: number;
    member: PhoneMember | null;
    signal: AbortSignal;
  },
): Promise<PhoneSearchResult> {
  const { workspaceId, query, limit, member, signal } = input;
  const reach = member ? workspaceFileReach(member.selector) : null;
  const redact = (text: string) => (reach ? withheldLinkText(text, reach) : text);
  const run = async (pathPrefix?: string): Promise<WorkspaceSearchResult | null> => {
    signal.throwIfAborted();
    try {
      return await files.retrieveWorkspace({
        query,
        surfaces: ["page"],
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
        includeNeighbors: false,
        limit: MAX_LIMIT,
      });
    } catch (error) {
      if (isInvalidQuery(error)) return null;
      throw error;
    }
  };
  const byPath = new Map<string, { hit: PhoneSearchHit; terms: number; rank: number }>();
  let indexBuilding = false,
    anyTruncated = false,
    allComplete = true,
    prefixCapped = false,
    dropped = false;
  const collect = (raw: WorkspaceSearchResult | null) => {
    if (!raw) return;
    indexBuilding ||= raw.indexBuilding;
    anyTruncated ||= raw.truncated;
    allComplete &&= raw.complete;
    for (const [rank, hit] of raw.results.entries()) {
      if (
        hit.kind !== "page" ||
        typeof hit.path !== "string" ||
        hit.path === "" ||
        !pathShown(member, hit.path)
      ) {
        dropped = true;
        continue;
      }
      const next = {
        hit: {
          path: hit.path,
          title: redact(hit.title),
          snippet: redact(hit.snippet),
          ...(typeof hit.objectId === "string" && hit.objectId ? { objectId: hit.objectId } : {}),
        },
        terms: hit.matchedTerms.length,
        rank,
      };
      const prev = byPath.get(hit.path);
      if (!prev || next.terms > prev.terms || (next.terms === prev.terms && next.rank < prev.rank))
        byPath.set(hit.path, next);
    }
  };
  const restricted = member !== null && hasFolderRules(member);
  if (restricted) {
    const version = await files.getActiveVersion({ workspaceId });
    const visible = version
      ? (await files.listTextFileMetadata({ workspaceId, versionId: version.id }))
          .map((f) => f.path)
          .filter((p) => pathShown(member, p))
      : [];
    if (visible.length === 0)
      return { ok: true, results: [], indexBuilding: false, truncated: false, complete: true };
    const prefixes = visiblePrefixes(visible, member, query);
    prefixCapped = prefixes.length > MAX_PREFIXES;
    for (const prefix of prefixes.slice(0, MAX_PREFIXES)) collect(await run(prefix));
  } else {
    collect(await run());
  }
  const ordered = restricted
    ? [...byPath.values()].sort(
        (a, b) => b.terms - a.terms || a.rank - b.rank || a.hit.path.localeCompare(b.hit.path),
      )
    : [...byPath.values()];
  const isolated = member !== null && dropped;
  const truncated = ordered.length > limit || prefixCapped || (!isolated && anyTruncated);
  return {
    ok: true,
    results: ordered.slice(0, limit).map((e) => e.hit),
    indexBuilding,
    truncated,
    complete: !indexBuilding && !truncated && (isolated || allComplete),
  };
}

export async function runPhoneSearch(
  server: { storage: SyncRelayStorage; copies: ServerCopies },
  input: {
    owner: string;
    member: PhoneMember | null;
    workspaceId: string;
    args: unknown;
    visitor: Extract<CopyVisitor, { reason: "account" }>;
    authorize(): Promise<void>;
  },
): Promise<{ result: PhoneSearchResult; cursor: string }> {
  const { query, limit } = parsePhoneSearchArgs(input.args);
  const { signal } = input.visitor;
  const authorize = () => untilAborted(input.authorize(), signal);
  return await server.copies.withServerCopy(
    input.owner,
    input.workspaceId,
    input.visitor,
    async (replica) => {
      await authorize();
      const cursor = currentAccountFeedCursor(server.storage, input.workspaceId, input.member);
      await replica.sync(signal);
      await authorize();
      const files = new VersionedLiveAdapter(replica.client, replica.workspace, {
        workspaceId: input.workspaceId,
      });
      const result = await untilAborted(
        searchWorkspacePages(files, {
          workspaceId: input.workspaceId,
          query,
          limit,
          member: input.member,
          signal,
        }),
        signal,
      );
      await authorize();
      server.copies.hold(input.visitor.userId, input.workspaceId);
      return { result, cursor };
    },
  );
}
