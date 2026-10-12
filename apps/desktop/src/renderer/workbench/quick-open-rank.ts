import { FILE_KIND_RECORDS, fileKindForPath, type FileKindRecord } from "@dohc/workspace-contracts/kinds";
import type { CollectionSummary } from "@dohc/workspace-contracts/collection";
import type { ChatChannelRecord, SitePackageInfo, WorkspaceFileEntry, WorkspaceVersionRecord } from "../../ipc/bridgeContract";
import { basenameOf } from "../path";
// Pure quick-open ranking (Phase E5.0 polish). Tier order is the plan's:
// prefix > word-boundary > substring > fuzzy subsequence; PINNED paths sort
// first overall, recent files are boosted within a tier (most recent wins),
// then shorter paths, then alphabetical. Case-insensitive throughout.

// Match-quality tiers, best first.
const TIER_BASENAME_PREFIX = 0;
const TIER_WORD_BOUNDARY = 1;
const TIER_SUBSTRING = 2;
const TIER_FUZZY = 3;

// Word boundaries: the string start and any position after a separator
// (slash, dash, underscore, dot, space).
function startsAtWordBoundary(haystack: string, needle: string): boolean {
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (at === 0 || "/-_. ".includes(haystack[at - 1])) return true;
  }
  return false;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

// The tier a lowercase path matches the lowercase query at, or null when it
// doesn't match.
function quickOpenMatchTierLowercase(
  query: string,
  path: string,
  basename: string,
): number | null {
  if (query.length === 0) return TIER_SUBSTRING;
  if (basename.startsWith(query)) return TIER_BASENAME_PREFIX;
  if (startsAtWordBoundary(path, query)) return TIER_WORD_BOUNDARY;
  if (path.includes(query)) return TIER_SUBSTRING;
  if (isSubsequence(query, path)) return TIER_FUZZY;
  return null;
}

export interface QuickOpenContext {
  // Most recent first (workbench recentFiles).
  recent: readonly string[];
  pinned: readonly string[];
}

interface PreparedQuickOpenPath {
  path: string;
  lowercasePath: string;
  lowercaseBasename: string;
  pinnedRank: number;
  recentRank: number;
  sourceIndex: number;
}

interface ScoredQuickOpenPath<T extends PreparedQuickOpenPath = PreparedQuickOpenPath> {
  prepared: T;
  tier: number;
  priority: number;
}

// Build this index only when the file list, pins, or recent files change.
// Queries can then reuse every path-derived value.
export function prepareQuickOpenPaths(
  paths: readonly string[],
  context: QuickOpenContext,
): PreparedQuickOpenPath[] {
  const pinned = new Set(context.pinned);
  const recentRank = new Map(context.recent.map((path, index) => [path, index]));
  return paths.map((path, sourceIndex) => {
    const lowercasePath = path.toLowerCase();
    return {
      path,
      lowercasePath,
      lowercaseBasename: basenameOf(lowercasePath),
      pinnedRank: pinned.has(path) ? 0 : 1,
      recentRank: recentRank.get(path) ?? Number.MAX_SAFE_INTEGER,
      sourceIndex,
    };
  });
}

function compareCandidate(
  path: PreparedQuickOpenPath,
  tier: number,
  scored: ScoredQuickOpenPath,
  priority = 0,
): number {
  const other = scored.prepared;
  return (
    priority - scored.priority ||
    path.pinnedRank - other.pinnedRank ||
    tier - scored.tier ||
    path.recentRank - other.recentRank ||
    path.path.length - other.path.length ||
    (path.path < other.path ? -1 : path.path > other.path ? 1 : 0) ||
    // The previous full sort was stable. Equal paths therefore kept their
    // input order, which sourceIndex makes explicit for bounded selection.
    path.sourceIndex - other.sourceIndex
  );
}

function insertBounded<T extends PreparedQuickOpenPath>(
  selected: ScoredQuickOpenPath<T>[],
  path: T,
  tier: number,
  limit: number,
  priority = 0,
): void {
  if (selected.length === limit && compareCandidate(path, tier, selected[limit - 1], priority) >= 0) return;
  let low = 0;
  let high = selected.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareCandidate(path, tier, selected[middle], priority) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= limit) return;
  selected.splice(low, 0, { prepared: path, tier, priority });
  if (selected.length > limit) selected.pop();
}

// Rank a prepared index and retain at most `limit` paths. Non-matching paths
// are excluded. Sort key, in order: pinned first → match tier → recency rank
// (more recent first; the "recent files boosted" rule) → shorter path →
// alphabetical. A finite limit uses bounded insertion, so a query never sorts
// the complete match set.
export function rankPreparedQuickOpenPaths(
  query: string,
  paths: readonly PreparedQuickOpenPath[],
  limit: number,
): string[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  const lowercaseQuery = query.toLowerCase();
  const selected: ScoredQuickOpenPath[] = [];
  for (const path of paths) {
    const tier = quickOpenMatchTierLowercase(
      lowercaseQuery,
      path.lowercasePath,
      path.lowercaseBasename,
    );
    if (tier === null) continue;
    insertBounded(selected, path, tier, boundedLimit);
  }
  return selected.map((path) => path.prepared.path);
}

export type GoToKind = "file" | "folder" | "collection" | "app" | "version" | "group";
type GoToFile = Pick<WorkspaceFileEntry, "path" | "kind" | "icon">;
type GoToCollection = Pick<CollectionSummary, "path" | "objectId">;
type GoToApp = Pick<SitePackageInfo, "root" | "title">;
type GoToVersion = Pick<WorkspaceVersionRecord, "id" | "name">;
type GoToGroup = Pick<ChatChannelRecord, "id" | "name" | "kind">;

export interface GoToListing {
  files: readonly GoToFile[];
  folders: readonly string[];
  // Verdicts come from the visibility-rule loop, never the engine path floor.
  // Until the listing producer supplies them, all host path rows stay withheld.
  visibility: {
    status: "ready" | "degraded" | "unavailable";
    // Exact paths: the producer must cover folders, Collections, and apps too.
    hiddenHostPaths: ReadonlySet<string>;
  };
  // The listing has already applied each share's selector and canonical overlay.
  receivedRoots: readonly { path: string; ended: boolean; damaged: boolean }[];
}

export interface GoToSources {
  listing?: GoToListing;
  collections?: readonly GoToCollection[];
  apps?: readonly GoToApp[];
  versions?: readonly GoToVersion[];
  // Only committed, admitted Group rows. DM and agent channels are excluded.
  groups?: readonly GoToGroup[];
}

export type GoToTarget =
  | { workspaceId: string; kind: "file" | "folder" | "collection" | "app"; path: string }
  | { workspaceId: string; kind: "version" | "group"; id: string };

export interface PreparedGoToRow extends PreparedQuickOpenPath {
  id: string;
  kind: GoToKind;
  label: string;
  glyphId: FileKindRecord["glyphId"] | "folder" | "table" | "box" | "layers" | "messages-square";
  target: GoToTarget;
  record: GoToFile | string | GoToCollection | GoToApp | GoToVersion | GoToGroup;
  ended: boolean;
  visible: boolean;
  listingGeneration: number;
}

function applyGoToPathState(row: PreparedGoToRow, listing: GoToListing): void {
  const share = listing.receivedRoots.find(root => root.path === "" || row.path === root.path || row.path.startsWith(root.path + "/"));
  row.ended = share?.ended ?? false;
  row.visible = share ? !share.damaged : listing.visibility.status === "ready" &&
    !listing.visibility.hiddenHostPaths.has(row.path);
}

function samePathVerdicts(a: GoToListing, b: GoToListing | undefined): boolean {
  if (!b || a.visibility.status !== b.visibility.status) return false;
  const hidden = a.visibility.hiddenHostPaths, previousHidden = b.visibility.hiddenHostPaths;
  if (hidden !== previousHidden) {
    if (hidden.size !== previousHidden.size) return false;
    for (const path of hidden) if (!previousHidden.has(path)) return false;
  }
  return a.receivedRoots === b.receivedRoots || a.receivedRoots.length === b.receivedRoots.length &&
    a.receivedRoots.every((root, i) => {
      const previous = b.receivedRoots[i];
      return root.path === previous.path && root.ended === previous.ended && root.damaged === previous.damaged;
    });
}

const KNOWN_EXTENSIONS = new Set<string>(Object.values(FILE_KIND_RECORDS).flatMap(record => [...record.extensions]));
export function isGoToPathQuery(query: string): boolean {
  return query.includes("/") || KNOWN_EXTENSIONS.has(query.slice(query.lastIndexOf(".") + 1).toLowerCase()) && query.includes(".");
}

const EMPTY_CONTEXT: QuickOpenContext = { pinned: [], recent: [] };
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// One instance belongs to one mounted shell. It consumes committed snapshots;
// source owners keep their own newest-answer-wins guards and refresh triggers.
// No I/O, identity resolution, relay sync, or source preparation happens in query.
export class GoToIndex {
  readonly workspaceId: string;
  revision = 0;
  lastPreparationCount = 0;
  lastScanCount = 0;
  rows: readonly PreparedGoToRow[] = [];
  private files: PreparedGoToRow[] = [];
  private listingGeneration = 0;
  private readonly subsets = new Map<GoToKind, Map<string, PreparedGoToRow>>();
  private sources: GoToSources = {};
  private context: QuickOpenContext = EMPTY_CONTEXT;
  private matches: { query: string; revision: number; indices: Int32Array; count: number } | null = null;

  constructor(workspaceId: string) { this.workspaceId = workspaceId; }

  update(sources: GoToSources, context: QuickOpenContext = this.context): void {
    this.lastPreparationCount = 0;
    let changed = false;
    const replace = (kind: GoToKind, entries: Iterable<{
      key: string; label: string; path: string; record: PreparedGoToRow["record"];
      glyphId: PreparedGoToRow["glyphId"]; ended?: boolean; visible?: boolean;
    }>) => {
      const previous = this.subsets.get(kind);
      const next = new Map<string, PreparedGoToRow>();
      for (const entry of entries) {
        let row = previous?.get(entry.key);
        if (!row || row.path !== entry.path || row.label !== entry.label) {
          const lowercasePath = entry.path.toLowerCase();
          row = {
            id: kind + ":" + entry.key, kind, label: entry.label,
            path: entry.path, lowercasePath, lowercaseBasename: entry.label.toLowerCase(),
            glyphId: entry.glyphId, record: entry.record, ended: entry.ended ?? false,
            visible: entry.visible ?? true, pinnedRank: context.pinned.includes(entry.path) ? 0 : 1,
            recentRank: context.recent.lastIndexOf(entry.path) === -1 ? Number.MAX_SAFE_INTEGER : context.recent.lastIndexOf(entry.path),
            sourceIndex: 0, listingGeneration: 0,
            target: kind === "version" || kind === "group"
              ? { workspaceId: this.workspaceId, kind, id: entry.key }
              : { workspaceId: this.workspaceId, kind, path: entry.path },
          };
          this.lastPreparationCount += 1;
        } else {
          // IPC can replace every record after one rename. Preserve matching fields.
          row.record = entry.record;
          row.glyphId = entry.glyphId;
          row.ended = entry.ended ?? false;
          row.visible = entry.visible ?? true;
        }
        next.set(entry.key, row);
      }
      this.subsets.set(kind, next);
      changed = true;
    };
    if (sources.listing && sources.listing !== this.sources.listing) {
      const snapshot = sources.listing;
      const next = this.subsets.get("file") ?? new Map<string, PreparedGoToRow>();
      const generation = ++this.listingGeneration;
      const verdictsChanged = !samePathVerdicts(snapshot, this.sources.listing);
      const removedCandidates: PreparedGoToRow[] = [];
      let fileIndex = 0;
      for (const file of snapshot.files) {
        const previousAtIndex = this.files[fileIndex];
        let row = previousAtIndex?.path === file.path ? previousAtIndex : next.get(file.path);
        if (previousAtIndex && previousAtIndex !== row) removedCandidates.push(previousAtIndex);
        const isNew = !row;
        if (!row) {
          row = {
            id: "file:" + file.path, kind: "file", label: basenameOf(file.path),
            path: file.path, lowercasePath: file.path.toLowerCase(), lowercaseBasename: basenameOf(file.path).toLowerCase(),
            glyphId: file.kind === "database" ? FILE_KIND_RECORDS.database.glyphId : fileKindForPath(file.path).glyphId,
            record: file, ended: false, visible: true,
            pinnedRank: context.pinned.includes(file.path) ? 0 : 1,
            recentRank: context.recent.lastIndexOf(file.path) === -1 ? Number.MAX_SAFE_INTEGER : context.recent.lastIndexOf(file.path),
            sourceIndex: fileIndex, listingGeneration: 0, target: { workspaceId: this.workspaceId, kind: "file", path: file.path },
          };
          this.lastPreparationCount += 1;
          next.set(file.path, row);
        } else {
          if ((row.record as GoToFile).kind !== file.kind) {
            row.glyphId = file.kind === "database" ? FILE_KIND_RECORDS.database.glyphId : fileKindForPath(file.path).glyphId;
          }
          row.record = file;
        }
        if (isNew || verdictsChanged) {
          applyGoToPathState(row, snapshot);
        }
        if (row.listingGeneration !== generation) this.files[fileIndex++] = row;
        row.listingGeneration = generation;
      }
      for (let i = fileIndex; i < this.files.length; i++) removedCandidates.push(this.files[i]);
      this.files.length = fileIndex;
      for (const row of removedCandidates) if (row.listingGeneration !== generation) next.delete(row.path);
      this.subsets.set("file", next);
      changed = true;
      replace("folder", snapshot.folders.map(path => ({
        key: path, path, label: basenameOf(path), record: path, glyphId: "folder",
      })));
      this.sources.listing = snapshot;
    }
    if (sources.collections && sources.collections !== this.sources.collections) {
      replace("collection", sources.collections.map(record => ({
        key: record.path, path: record.path, label: basenameOf(record.path), record, glyphId: "table",
      })));
      this.sources.collections = sources.collections;
    }
    if (sources.apps && sources.apps !== this.sources.apps) {
      replace("app", sources.apps.map(record => ({
        key: record.root, path: record.root, label: record.title, record, glyphId: "box",
      })));
      this.sources.apps = sources.apps;
    }
    if (sources.versions && sources.versions !== this.sources.versions) {
      replace("version", sources.versions.map(record => ({
        key: record.id, path: record.name, label: record.name, record, glyphId: "layers",
      })));
      this.sources.versions = sources.versions;
    }
    if (sources.groups && sources.groups !== this.sources.groups) {
      replace("group", sources.groups.filter(record => record.kind === "channel").map(record => ({
        key: record.id, path: record.name, label: record.name, record, glyphId: "messages-square",
      })));
      this.sources.groups = sources.groups;
    }
    const contextChanged = !sameStrings(context.pinned, this.context.pinned) || !sameStrings(context.recent, this.context.recent);
    if (!changed && !contextChanged) return;
    this.context = context;
    const pinned = contextChanged ? new Set(context.pinned) : null;
    const recent = contextChanged ? new Map(context.recent.map((path, i) => [path, i])) : null;
    const rows: PreparedGoToRow[] = [];
    for (const [kind, subset] of this.subsets) for (const row of kind === "file" ? this.files : subset.values()) {
      if (pinned && recent) {
        row.pinnedRank = pinned.has(row.path) ? 0 : 1;
        row.recentRank = recent.get(row.path) ?? Number.MAX_SAFE_INTEGER;
      }
      if (kind === "folder" || kind === "collection" || kind === "app") {
        if (this.sources.listing) applyGoToPathState(row, this.sources.listing);
        else row.visible = false;
      }
      // A Collection replaces its ordinary folder row.
      if (row.visible && !(kind === "folder" && this.subsets.get("collection")?.has(row.path))) rows.push(row);
    }
    this.files.forEach((row, i) => { row.sourceIndex = i; });
    rows.forEach((row, i) => { row.sourceIndex = i; });
    this.rows = rows;
    this.revision += 1;
    this.matches = null;
  }

  query(query: string, limit = 50): PreparedGoToRow[] {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) return [];
    const q = query.toLowerCase();
    const rows = this.rows;
    const previous = this.matches;
    const narrow = previous && previous.revision === this.revision && q.startsWith(previous.query);
    const indices = narrow ? previous.indices : new Int32Array(rows.length);
    const scanCount = narrow ? previous.count : rows.length;
    let count = 0;
    const selected: ScoredQuickOpenPath<PreparedGoToRow>[] = [];
    const pathQuery = isGoToPathQuery(q);
    for (let at = 0; at < scanCount; at++) {
      const i = narrow ? indices[at] : at;
      const row = rows[i];
      let tier = quickOpenMatchTierLowercase(q, row.lowercasePath, row.lowercaseBasename);
      if (row.kind === "app") {
        const nameTier = quickOpenMatchTierLowercase(q, row.lowercaseBasename, row.lowercaseBasename);
        if (nameTier !== null) tier = tier === null ? nameTier : Math.min(tier, nameTier);
      }
      if (tier === null) continue;
      indices[count++] = i;
      insertBounded(selected, row, tier, boundedLimit, pathQuery && row.kind !== "file" ? 1 : 0);
    }
    this.lastScanCount = scanCount;
    // Compact one current match set in place. All unseen matches survive narrowing.
    this.matches = { query: q, revision: this.revision, indices, count };
    return selected.map(candidate => candidate.prepared);
  }
}
