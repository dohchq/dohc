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
const SNIPPET_MAX_CHARS = 260;
const REDACT_READ_MAX_BYTES = 256 * 1024;
const MD_LINK_RE = /!?\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^)\s\r\n]+))(?:\s+[^)\r\n]*)?\)/gu;
const WIKI_LINK_RE = /!?\[\[([^\]\r\n]+)\]\]/gu;
const CLIPPED_TRAILING_RE =
  /(?:@\[[^\]\r\n]*|!?\[[^\]]*\]\(\s*<?(?![a-zA-Z][a-zA-Z0-9+.-]*:)[^)\r\n]*|!?\[\[[^\]\r\n]*)$/gu;
const CLIPPED_LEADING_MD_RE = /^(?:…|\.\.\.)[^(\r\n]*\)/u;
const CLIPPED_LEADING_WIKI_RE = /^(?:…|\.\.\.)[^[\r\n]*\]\]/u;
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
  readTextFile?(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    maxBytes?: number;
  }): Promise<{ contentKind: string; text: string | null } | null>;
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
  return posix
    .basename(path)
    .toLowerCase()
    .replace(/\.(md|markdown)$/iu, "");
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
    if (visibleStems.has(key) && !hiddenStems.has(key)) return true;
    candidates.push(posix.normalize(target));
  }
  const allowedPath = (p: string) => {
    if (!p || p === "." || p.startsWith("..") || !pathShown(member, p)) return false;
    if (member.selector.reach.folderLevel(p) === null) return false;
    return p.includes(".") || pathShown(member, `${p}.md`);
  };
  return candidates.every(allowedPath);
}

function extractRedactedSnippet(text: string, tokens: readonly string[]): string {
  let bestLine = "";
  let bestScore = -1;
  let firstLine = "";
  for (const rawLine of text.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (!firstLine) firstLine = trimmed;
    const lowered = trimmed.toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (lowered.includes(token) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestLine = trimmed;
    }
  }
  const cleaned = (bestScore > 0 ? bestLine : firstLine).replace(/\s+/gu, " ").trim();
  if (cleaned.length <= SNIPPET_MAX_CHARS) return cleaned;
  const lowered = cleaned.toLowerCase();
  const matchAt = tokens.map((t) => lowered.indexOf(t)).find((i) => i >= 0) ?? 0;
  const start = Math.max(0, matchAt - Math.floor(SNIPPET_MAX_CHARS / 3));
  const end = Math.min(cleaned.length, start + SNIPPET_MAX_CHARS);
  let window = cleaned.slice(start, end).trim();
  if (start > 0) window = `…${window}`;
  if (end < cleaned.length) window = `${window}…`;
  return window.slice(0, SNIPPET_MAX_CHARS);
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
  const nonMdPaths = allPaths.filter((p) => !isMarkdownPage(p)).map((p) => pathCollisionKey(p));
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
        !nonMdPaths.some((p) => p.startsWith(prefix))
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
    .filter((t) => t.length >= 2 || /[^\x00-\x7f]/u.test(t));
  let hiddenStems = new Set<string>();
  let visibleStems = new Set<string>();
  let cachedVersion: { versionId: string | null; allPaths: readonly string[] } | null = null;
  const loadFiles = async () => {
    if (cachedVersion !== null) return cachedVersion;
    const version = await files.getActiveVersion({ workspaceId });
    const allPaths = version
      ? (await files.listTextFileMetadata({ workspaceId, versionId: version.id })).map(
          (f) => f.path,
        )
      : [];
    cachedVersion = { versionId: version?.id ?? null, allPaths };
    if (member !== null) {
      hiddenStems = new Set(allPaths.filter((p) => !pathShown(member, p)).map(stemOf));
      visibleStems = new Set(allPaths.filter((p) => pageShown(member, p)).map(stemOf));
    }
    return cachedVersion;
  };
  const redactText = (text: string, fromPath: string, clipped = false) => {
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
    if (clipped) {
      out = out.replace(CLIPPED_TRAILING_RE, CHAT_FILE_LINK_WITHHELD);
      out = out.replace(CLIPPED_LEADING_WIKI_RE, `…${CHAT_FILE_LINK_WITHHELD}`);
      out = out.replace(CLIPPED_LEADING_MD_RE, (full) =>
        URL_SCHEME_RE.test(full.replace(/^(?:…|\.\.\.)/u, ""))
          ? full
          : `…${CHAT_FILE_LINK_WITHHELD}`,
      );
    }
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
  const byPath = new Map<
    string,
    {
      hit: PhoneSearchHit;
      rawTitle: string;
      rawSnippet: string;
      matchedTerms: readonly string[];
      terms: number;
      rank: number;
    }
  >();
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
      const next = {
        hit: { path: hit.path, title: hit.title, snippet: hit.snippet },
        rawTitle: hit.title,
        rawSnippet: hit.snippet,
        matchedTerms: hit.matchedTerms,
        terms: hit.matchedTerms.length,
        rank,
      };
      const prev = byPath.get(hit.path);
      if (!prev || next.terms > prev.terms || (next.terms === prev.terms && next.rank < prev.rank))
        byPath.set(hit.path, next);
    }
  };
  const runScoped = async (allPaths: readonly string[], visible: readonly string[]) => {
    anyTruncated = false;
    allComplete = true;
    dropped = false;
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
    const { allPaths } = await loadFiles();
    const visible = allPaths.filter((p) => pageShown(member, p));
    if (visible.length === 0)
      return { ok: true, results: [], indexBuilding: false, truncated: false, complete: true };
    await runScoped(allPaths, visible);
  } else {
    const raw = await run();
    collect(raw);
    const crowded =
      raw !== null &&
      (raw.truncated || raw.results.length >= MAX_LIMIT) &&
      byPath.size < limit &&
      (droppedNonMd || (member !== null && dropped));
    if (crowded) {
      const { allPaths } = await loadFiles();
      const visible = allPaths.filter((p) => pageShown(member, p));
      if (visible.length > 0) {
        scoped = true;
        byPath.clear();
        await runScoped(allPaths, visible);
      }
    }
  }
  const ordered = scoped
    ? [...byPath.values()].sort(
        (a, b) => b.terms - a.terms || a.rank - b.rank || a.hit.path.localeCompare(b.hit.path),
      )
    : [...byPath.values()];
  const finalHits: PhoneSearchHit[] = [];
  const versionId = member !== null && files.readTextFile ? (await loadFiles()).versionId : null;
  for (const entry of ordered) {
    if (member === null) {
      finalHits.push(entry.hit);
      continue;
    }
    const title = redactText(entry.rawTitle, entry.hit.path, true);
    const matchTerms =
      entry.matchedTerms.length > 0
        ? entry.matchedTerms.map((t) => t.toLowerCase()).filter(Boolean)
        : queryTokens;
    let snippet: string;
    let changed = title !== entry.rawTitle;
    let haystackSource: string | null = null;
    if (files.readTextFile && versionId !== null) {
      signal.throwIfAborted();
      const loaded = await files.readTextFile({
        workspaceId,
        versionId,
        path: entry.hit.path,
        maxBytes: REDACT_READ_MAX_BYTES,
      });
      if (loaded?.contentKind === "text" && typeof loaded.text === "string") {
        const redactedBody = redactText(loaded.text, entry.hit.path, false);
        if (redactedBody !== loaded.text) {
          changed = true;
          haystackSource = redactedBody;
          snippet = extractRedactedSnippet(redactedBody, matchTerms);
        } else {
          snippet = redactText(entry.rawSnippet, entry.hit.path, true);
          if (snippet !== entry.rawSnippet) changed = true;
        }
      } else {
        snippet = redactText(entry.rawSnippet, entry.hit.path, true);
        if (snippet !== entry.rawSnippet) changed = true;
      }
    } else {
      snippet = redactText(entry.rawSnippet, entry.hit.path, true);
      if (snippet !== entry.rawSnippet) changed = true;
    }
    if (changed && matchTerms.length > 0) {
      const visibleText = `${entry.hit.path}\n${title}\n${haystackSource ?? snippet}`
        .replaceAll(CHAT_FILE_LINK_WITHHELD, " ")
        .toLowerCase();
      if (!matchTerms.some((token) => visibleText.includes(token))) continue;
    }
    finalHits.push({ path: entry.hit.path, title, snippet });
  }
  const truncated = finalHits.length > limit || prefixCapped || anyTruncated;
  return {
    ok: true,
    results: finalHits.slice(0, limit),
    indexBuilding,
    truncated,
    complete: !indexBuilding && !truncated && allComplete,
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
