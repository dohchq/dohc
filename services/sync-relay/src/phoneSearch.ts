import { posix } from "node:path";
import { CHAT_FILE_LINK_WITHHELD } from "@dohc/workspace-contracts/chat-mentions";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import type { WorkspaceSearchResult } from "@dohc/workspace-contracts/retrieval";
import { asRecord } from "@dohc/workspace-core";
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
const MAX_PREFIXES = 512;
const PREFIX_BUDGET_MS = 8_000;
const MD_LINK_RE = /!?\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^)\s\r\n]+))(?:\s+[^)\r\n]*)?\)/gu;
const WIKI_LINK_RE = /!?\[\[([^\]\r\n]+)\]\]/gu;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;

export interface PhoneSearchHit {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
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

const isMarkdownPage = (path: string) => liveDocumentKindForPath(path) === "richdoc";
const pageShown = (member: PhoneMember | null, path: string) =>
  isMarkdownPage(path) && pathShown(member, path);

function stemOf(path: string): string {
  const base = posix.basename(path).toLowerCase();
  return base.replace(/\.(md|markdown)$/iu, "");
}

function normalizeLinkTarget(raw: string): string {
  const clean = raw.split(/[?#]/u, 1)[0]?.trim() ?? "";
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

function linkAllowed(
  member: PhoneMember,
  fromPath: string,
  rawTarget: string,
  wiki: boolean,
  hiddenStems: ReadonlySet<string>,
  visibleStems: ReadonlySet<string>,
): boolean {
  const target = normalizeLinkTarget(rawTarget);
  if (!target || URL_SCHEME_RE.test(target)) return true;
  const dir = posix.dirname(fromPath);
  const candidates: string[] = [];
  if (target.startsWith("/")) {
    candidates.push(posix.normalize(target.replace(/^\/+/u, "")));
  } else if (!wiki || target.startsWith(".")) {
    candidates.push(posix.normalize(dir === "." ? target : posix.join(dir, target)));
  } else if (target.includes("/")) {
    candidates.push(posix.normalize(target));
    if (dir !== ".") candidates.push(posix.normalize(posix.join(dir, target)));
  } else {
    const key = stemOf(target);
    if (hiddenStems.has(key) && !visibleStems.has(key)) return false;
    candidates.push(posix.normalize(target));
  }
  const allowedPath = (p: string) => {
    if (!p || p === "." || p.startsWith("..") || !pathShown(member, p)) return false;
    if (member.selector.reach.folderLevel(p) === null) return false;
    return p.includes(".") || pathShown(member, `${p}.md`);
  };
  return candidates.every(allowedPath);
}

function visiblePrefixes(
  allPaths: readonly string[],
  visiblePages: readonly string[],
  member: PhoneMember | null,
  query: string,
): string[] {
  const ruled = member
    ? member.selector.reach.evaluated.rules.map(([f]) => pathCollisionKey(f)).filter(Boolean)
    : [];
  const nonMdDirs = allPaths.filter((p) => !isMarkdownPage(p)).map((p) => pathCollisionKey(p));
  const folders = new Set<string>();
  const files = new Set<string>();
  for (const path of visiblePages) {
    const parts = path.split("/");
    let clean: string | null = null;
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      const folded = pathCollisionKey(dir);
      const prefix = `${folded}/`;
      if (
        (member === null || member.selector.reach.folderLevel(dir) !== null) &&
        !ruled.some((r) => r.startsWith(prefix)) &&
        !nonMdDirs.some((p) => p.startsWith(prefix))
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
    nowMs?: () => number;
  },
): Promise<PhoneSearchResult> {
  const { workspaceId, query, limit, member, signal } = input;
  const nowMs = input.nowMs ?? Date.now;
  const startedMs = nowMs();
  const reach = member ? workspaceFileReach(member.selector) : null;
  const queryTokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  let hiddenStems = new Set<string>();
  let visibleStems = new Set<string>();
  const redact = (text: string, fromPath: string) => {
    if (!member || !reach) return text;
    let out = withheldLinkText(text, reach);
    out = out.replace(MD_LINK_RE, (full, angled?: string, bare?: string) =>
      linkAllowed(member, fromPath, angled ?? bare ?? "", false, hiddenStems, visibleStems)
        ? full
        : CHAT_FILE_LINK_WITHHELD,
    );
    out = out.replace(WIKI_LINK_RE, (full, inner: string) => {
      const target = inner.split("|", 1)[0] ?? "";
      return linkAllowed(member, fromPath, target, true, hiddenStems, visibleStems)
        ? full
        : CHAT_FILE_LINK_WITHHELD;
    });
    return out;
  };
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
    dropped = false,
    droppedNonMd = false;
  const collect = (raw: WorkspaceSearchResult | null) => {
    if (!raw) return;
    indexBuilding ||= raw.indexBuilding;
    anyTruncated ||= raw.truncated;
    allComplete &&= raw.complete;
    for (const [rank, hit] of raw.results.entries()) {
      if (hit.kind !== "page" || typeof hit.path !== "string" || hit.path === "") {
        dropped = true;
        continue;
      }
      if (!isMarkdownPage(hit.path)) {
        dropped = true;
        droppedNonMd = true;
        continue;
      }
      if (!pathShown(member, hit.path)) {
        dropped = true;
        continue;
      }
      const title = redact(hit.title, hit.path);
      const snippet = redact(hit.snippet, hit.path);
      if (
        member !== null &&
        (title !== hit.title || snippet !== hit.snippet) &&
        queryTokens.length > 0
      ) {
        const visibleText = `${hit.path}\n${title}\n${snippet}`
          .replaceAll(CHAT_FILE_LINK_WITHHELD, " ")
          .toLowerCase();
        if (!queryTokens.some((token) => visibleText.includes(token))) {
          dropped = true;
          continue;
        }
      }
      const next = {
        hit: { path: hit.path, title, snippet },
        terms: hit.matchedTerms.length,
        rank,
      };
      const prev = byPath.get(hit.path);
      if (!prev || next.terms > prev.terms || (next.terms === prev.terms && next.rank < prev.rank))
        byPath.set(hit.path, next);
    }
  };
  const runScoped = async (allPaths: readonly string[], visible: readonly string[]) => {
    const prefixes = visiblePrefixes(allPaths, visible, member, query);
    let ran = 0;
    for (const prefix of prefixes) {
      if (ran >= MAX_PREFIXES || nowMs() - startedMs >= PREFIX_BUDGET_MS) {
        prefixCapped = true;
        break;
      }
      collect(await run(prefix));
      ran += 1;
    }
  };
  const restricted = member !== null && hasFolderRules(member);
  let scoped = restricted;
  if (restricted) {
    const version = await files.getActiveVersion({ workspaceId });
    const allPaths = version
      ? (await files.listTextFileMetadata({ workspaceId, versionId: version.id })).map(
          (f) => f.path,
        )
      : [];
    const visible = allPaths.filter((p) => pageShown(member, p));
    hiddenStems = new Set(allPaths.filter((p) => !pathShown(member, p)).map(stemOf));
    visibleStems = new Set(visible.map(stemOf));
    if (visible.length === 0)
      return { ok: true, results: [], indexBuilding: false, truncated: false, complete: true };
    await runScoped(allPaths, visible);
  } else {
    const raw = await run();
    collect(raw);
    if (raw?.truncated && droppedNonMd && byPath.size < limit) {
      const version = await files.getActiveVersion({ workspaceId });
      const allPaths = version
        ? (await files.listTextFileMetadata({ workspaceId, versionId: version.id })).map(
            (f) => f.path,
          )
        : [];
      const visible = allPaths.filter((p) => pageShown(member, p));
      if (visible.length > 0) {
        scoped = true;
        anyTruncated = false;
        allComplete = true;
        await runScoped(allPaths, visible);
      }
    }
  }
  const ordered = scoped
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
