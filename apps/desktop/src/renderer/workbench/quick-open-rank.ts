import { prepareVisibilityPolicy, sameVisibilityPolicy, type VisibilityPolicyRule } from "@dohc/security-contract/visibility-policy";
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
  // Main parses the rules. Search and Go to share the same rule evaluator.
  visibility: {
    status: "ready" | "degraded" | "unavailable";
    rules: readonly VisibilityPolicyRule[];
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
  characterMask: number;
  characterMaskHigh: number;
  boundaryMask: number;
  boundaryMaskHigh: number;
  // Preparation bookkeeping may change; queries read ranking metadata instead.
  includedRevision: number;
  listingGeneration: number;
}

function goToRowKey(row: PreparedGoToRow): string {
  return row.target.kind === "version" || row.target.kind === "group" ? row.target.id : row.path;
}
function sameGoToRecord(kind: GoToKind, previous: PreparedGoToRow["record"], next: PreparedGoToRow["record"]): boolean {
  if (previous === next) return true;
  switch (kind) {
    case "file": { const a = previous as GoToFile, b = next as GoToFile; return a.path === b.path && a.kind === b.kind && a.icon === b.icon; }
    case "folder": return previous === next;
    case "collection": { const a = previous as GoToCollection, b = next as GoToCollection; return a.path === b.path && a.objectId === b.objectId; }
    case "app": { const a = previous as GoToApp, b = next as GoToApp; return a.root === b.root && a.title === b.title; }
    case "version": { const a = previous as GoToVersion, b = next as GoToVersion; return a.id === b.id && a.name === b.name; }
    case "group": { const a = previous as GoToGroup, b = next as GoToGroup; return a.id === b.id && a.name === b.name && a.kind === b.kind; }
  }
}
function withGoToRanks(row: PreparedGoToRow, pinned: ReadonlySet<string>, recent: ReadonlyMap<string, number>): PreparedGoToRow {
  const pinnedRank = pinned.has(row.path) ? 0 : 1, recentRank = recent.get(row.path) ?? Number.MAX_SAFE_INTEGER;
  return row.pinnedRank === pinnedRank && row.recentRank === recentRank ? row : { ...row, pinnedRank, recentRank, includedRevision: -1 };
}

function* applyGoToPathState(row: PreparedGoToRow, listing: GoToListing, work: { operations: number }, visibilityForPath: ReturnType<typeof prepareVisibilityPolicy>): Generator<void, PreparedGoToRow> {
  let share: GoToListing["receivedRoots"][number] | undefined;
  for (const root of listing.receivedRoots) {
    if (root.path === "" || row.path === root.path || row.path.startsWith(root.path + "/")) { share = root; break; }
    if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
  }
  const ended = share?.ended ?? false;
  // Keep the published host verdict while a listing is degraded or unavailable.
  // The admission pass withholds host rows until a ready policy arrives.
  const visible = share ? !share.damaged : listing.visibility.status === "ready"
    ? visibilityForPath(row.path).visibility !== "hidden"
    : row.visible;
  return row.ended === ended && row.visible === visible ? row : { ...row, ended, visible, includedRevision: -1 };
}

function samePathVerdicts(a: GoToListing | undefined, b: GoToListing | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.visibility.status !== b.visibility.status) return false;
  if (!sameVisibilityPolicy(a.visibility.rules, b.visibility.rules)) return false;
  return sameEntries(a.receivedRoots, b.receivedRoots, (x, y) => x.path === y.path && x.ended === y.ended && x.damaged === y.damaged);
}
function sameVisibilityVerdicts(a: GoToListing | undefined, b: GoToListing | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || !sameVisibilityPolicy(a.visibility.rules, b.visibility.rules)) return false;
  return sameEntries(a.receivedRoots, b.receivedRoots, (x, y) => x.path === y.path && x.ended === y.ended && x.damaged === y.damaged);
}
function sameEntries<T>(a: readonly T[] | undefined, b: readonly T[] | undefined, equal: (a: T, b: T) => boolean): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !equal(a[i], b[i])) return false;
  return true;
}
const samePaths = (a: readonly string[] | undefined, b: readonly string[] | undefined) => sameEntries(a, b, (x, y) => x === y);
function sameSources(a: GoToSources, b: GoToSources): boolean {
  return samePathVerdicts(a.listing, b.listing) &&
    sameEntries(a.listing?.files, b.listing?.files, (x, y) => x.path === y.path && x.kind === y.kind && x.icon === y.icon) &&
    samePaths(a.listing?.folders, b.listing?.folders) &&
    sameEntries(a.collections, b.collections, (x, y) => x.path === y.path && x.objectId === y.objectId) &&
    sameEntries(a.apps, b.apps, (x, y) => x.root === y.root && x.title === y.title) &&
    sameEntries(a.versions, b.versions, (x, y) => x.id === y.id && x.name === y.name) &&
    sameEntries(a.groups, b.groups, (x, y) => x.id === y.id && x.name === y.name && x.kind === y.kind);
}

// A collision can admit extra work, but cannot reject a subsequence match.
function characterMasks(text: string): [number, number] {
  let low = 0, high = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let bit: number;
    if (code >= 97 && code <= 122) bit = code - 97;
    else if (code >= 48 && code <= 57) bit = code - 48 + 26;
    else {
      const separator = "/-_. ".indexOf(text[i]);
      bit = separator >= 0 ? 36 + separator : 41 + code % 23;
    }
    if (bit < 32) low |= 1 << bit;
    else high |= 1 << (bit - 32);
  }
  return [low, high];
}
function boundaryCharacters(text: string): string {
  let characters = text[0] ?? "";
  for (let i = 1; i < text.length; i++) {
    if ("/-_. ".includes(text[i - 1]) && !characters.includes(text[i])) characters += text[i];
  }
  return characters;
}
function preparedGoToTier(query: string, row: PreparedGoToRow, canPrefix: boolean, canBoundary: boolean, slash: boolean, fastSubsequence: boolean): number | null {
  if (!query) return TIER_SUBSTRING;
  if (canPrefix && row.lowercaseBasename.startsWith(query)) return TIER_BASENAME_PREFIX;
  const path = row.lowercasePath;
  if (canBoundary && startsAtWordBoundary(path, query)) return TIER_WORD_BOUNDARY;
  if ((!slash && row.lowercaseBasename.endsWith(query)) || path.includes(query)) return TIER_SUBSTRING;
  if (query.length > 1) {
    if (!fastSubsequence) return isSubsequence(query, path) ? TIER_FUZZY : null;
    let position = -1;
    for (let i = 0; i < query.length; i++) {
      position = path.indexOf(query[i], position + 1);
      if (position === -1) return null;
    }
    return TIER_FUZZY;
  }
  return null;
}

function compareGoToOrder(a: PreparedGoToRow, b: PreparedGoToRow): number {
  return a.path.length - b.path.length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.sourceIndex - b.sourceIndex;
}

const KNOWN_EXTENSIONS = new Set<string>(Object.values(FILE_KIND_RECORDS).flatMap(record => [...record.extensions]));
export function isGoToPathQuery(query: string): boolean {
  return query.includes("/") || KNOWN_EXTENSIONS.has(query.slice(query.lastIndexOf(".") + 1).toLowerCase()) && query.includes(".");
}

const EMPTY_CONTEXT: QuickOpenContext = { pinned: [], recent: [] };

// One instance belongs to one mounted shell. It consumes committed snapshots;
// source owners keep their own newest-answer-wins guards and refresh triggers.
// No I/O, identity resolution, relay sync, or source preparation happens in query.
export const GO_TO_SLICE_BUDGET_MS = 4;
const GO_TO_CHUNK_SIZE = 128;
export interface GoToPreparation {
  // Returns true when this run is complete or has been superseded.
  step(now?: () => number): boolean;
  cancel(): void;
}

export class GoToIndex {
  readonly workspaceId: string;
  revision = 0;
  preparing = false;
  private withholding = false;
  lastPreparationCount = 0;
  lastVisibilityCheckCount = 0;
  lastScanCount = 0;
  private completeRows: readonly PreparedGoToRow[] = [];
  private orderedRows: readonly PreparedGoToRow[] = [];
  private queryMetadata = new Int32Array(0);
  private filteredRows: { revision: number; removed: ReadonlySet<string>; rows: readonly PreparedGoToRow[] } | undefined;
  lastReorderedCount = 0;
  private removed = new Set<string>();
  get rows(): readonly PreparedGoToRow[] { return this.rowsWithout(this.removed); }
  rowsWithout(removed: ReadonlySet<string>): readonly PreparedGoToRow[] {
    if (this.withholding) return [];
    if (!removed.size) return this.completeRows;
    if (this.filteredRows?.revision !== this.revision || this.filteredRows.removed !== removed) {
      this.filteredRows = { revision: this.revision, removed, rows: this.completeRows.filter(row => !removed.has(row.id)) };
    }
    return this.filteredRows.rows;
  }
  private files: PreparedGoToRow[] = [];
  private listingGeneration = 0;
  private readonly subsets = new Map<GoToKind, Map<string, PreparedGoToRow>>();
  private sources: GoToSources = {};
  private requestedSources: GoToSources = {};
  private context: QuickOpenContext = EMPTY_CONTEXT;
  private requestedContext: QuickOpenContext = EMPTY_CONTEXT;
  private visibilityForPath = prepareVisibilityPolicy([]);
  private verdictListing: GoToListing | undefined;
  private active: GoToPreparation | null = null;
  private interrupted = false;
  private matches: { query: string; revision: number; indices: Int32Array; count: number } | null = null;

  constructor(workspaceId: string) { this.workspaceId = workspaceId; }

  // Equal content starts no run. Only background tasks prepare rows.
  update(sources: GoToSources, context: QuickOpenContext = this.requestedContext): GoToPreparation | null {
    const nextSources: GoToSources = {
      listing: sources.listing ?? this.requestedSources.listing,
      collections: sources.collections ?? this.requestedSources.collections,
      apps: sources.apps ?? this.requestedSources.apps,
      versions: sources.versions ?? this.requestedSources.versions,
      groups: sources.groups ?? this.requestedSources.groups,
    };
    if (!this.interrupted && sameSources(nextSources, this.requestedSources) &&
      samePaths(context.pinned, this.requestedContext.pinned) && samePaths(context.recent, this.requestedContext.recent)) {
      this.lastPreparationCount = 0;
      this.lastVisibilityCheckCount = 0;
      return this.active;
    }
    this.active?.cancel();
    this.requestedSources = nextSources;
    this.requestedContext = context;
    this.withholding ||= !samePathVerdicts(nextSources.listing, this.sources.listing);
    this.removed = this.removedKeys(nextSources);
    this.preparing = true;
    const counter = { operations: 0 };
    const work = this.prepare(this.requestedSources, context, counter);
    const run: GoToPreparation = {
      step: (now = () => performance.now()) => {
        if (this.active !== run) return true;
        // Check once per 128 operations, with headroom below the 4 ms target.
        const deadline = now() + GO_TO_SLICE_BUDGET_MS - 3;
        do {
          if (work.next().done) {
            this.active = null;
            this.preparing = false;
            this.withholding = false;
            this.filteredRows = undefined;
            return true;
          }
        } while (now() < deadline);
        return false;
      },
      cancel: () => {
        if (this.active !== run) return;
        work.return(undefined);
        this.active = null;
        this.interrupted = true;
        // Published rows remain usable after a safe cancellation.
      },
    };
    this.active = run;
    return run;
  }

  canQuery(listing?: GoToListing): boolean {
    return !this.withholding && samePathVerdicts(listing ?? this.sources.listing, this.sources.listing);
  }

  removedKeys(sources: GoToSources): Set<string> {
    const removed = new Set<string>();
    const compare = <T>(kind: GoToKind, next: readonly T[] | undefined, previous: readonly T[] | undefined, key: (entry: T) => string) => {
      if (!next || next === previous || !previous) return;
      const keys = new Set(next.map(key));
      for (const entry of previous) if (!keys.has(key(entry))) removed.add(kind + ":" + key(entry));
    };
    compare("collection", sources.collections ?? this.requestedSources.collections, this.sources.collections, entry => entry.path);
    compare("app", sources.apps ?? this.requestedSources.apps, this.sources.apps, entry => entry.root);
    compare("version", sources.versions ?? this.requestedSources.versions, this.sources.versions, entry => entry.id);
    const groups = sources.groups ?? this.requestedSources.groups;
    if (groups !== this.sources.groups) compare("group", groups?.filter(entry => entry.kind === "channel"), this.sources.groups?.filter(entry => entry.kind === "channel"), entry => entry.id);
    return removed;
  }

  cancel(): void { this.active?.cancel(); }

  private *prepare(sources: GoToSources, context: QuickOpenContext, work: { operations: number }): Generator<void> {
    this.lastPreparationCount = 0;
    this.lastVisibilityCheckCount = 0;
    this.lastReorderedCount = 0;
    const force = this.interrupted;
    const forceVerdicts = force && this.withholding;
    if (force && !forceVerdicts) {
      // Repair positions and admission markers without sorting the completed order.
      for (let i = 0; i < this.completeRows.length; i++) {
        const row = this.completeRows[i];
        row.sourceIndex = i;
        row.includedRevision = this.revision;
        if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
      }
    }
    let changed = false;
    const priorVerdictListing = this.verdictListing;
    const verdictListing = sources.listing?.visibility.status === "unavailable" && priorVerdictListing
      ? { ...sources.listing, visibility: priorVerdictListing.visibility }
      : sources.listing;
    const visibilityForPath = verdictListing && !sameVisibilityPolicy(verdictListing.visibility.rules, priorVerdictListing?.visibility.rules ?? [])
      ? prepareVisibilityPolicy(verdictListing.visibility.rules) : this.visibilityForPath;
    const pinned = new Set<string>();
    const recent = new Map<string, number>();
    for (const path of context.pinned) { pinned.add(path); if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield; }
    for (let i = 0; i < context.recent.length; i++) { recent.set(context.recent[i], i); if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield; }
    const contextChanged = force || !samePaths(context.pinned, this.context.pinned) || !samePaths(context.recent, this.context.recent);
    // Context updates keep the path order and copy only query ranking metadata.
    if (!force && sameSources(sources, this.sources)) {
      const metadata = this.queryMetadata.slice();
      const ordered = this.orderedRows.slice(), complete = this.completeRows.slice();
      for (const [kind, subset] of this.subsets) {
        let fileIndex = 0;
        for (const previous of kind === "file" ? this.files : subset.values()) {
          const row = withGoToRanks(previous, pinned, recent);
          if (row !== previous) subset.set(goToRowKey(row), row);
          if (kind === "file") this.files[fileIndex++] = row;
          if (complete[previous.sourceIndex] === previous) complete[previous.sourceIndex] = row;
          if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
        }
      }
      for (let i = 0; i < this.orderedRows.length; i++) {
        const row = complete[this.orderedRows[i].sourceIndex];
        row.includedRevision = this.revision + 1;
        metadata[i * 8 + 5] = row.pinnedRank;
        metadata[i * 8 + 7] = recent.get(row.path) ?? -1;
        ordered[i] = row;
        if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
      }
      this.queryMetadata = metadata;
      this.orderedRows = ordered;
      this.completeRows = complete;
      this.context = context;
      this.sources = sources;
      this.revision += 1;
      this.matches = null;
      return;
    }
    const index = this;
    function* replace(kind: GoToKind, entries: Iterable<{
      key: string; label: string; path: string; record: PreparedGoToRow["record"];
      glyphId: PreparedGoToRow["glyphId"]; previous?: PreparedGoToRow;
    } | null>, verdictsChanged = true): Generator<void> {
      const previous = index.subsets.get(kind);
      const next = kind === "file" ? previous ?? new Map<string, PreparedGoToRow>() : new Map<string, PreparedGoToRow>();
      const generation = kind === "file" ? ++index.listingGeneration : 0;
      const files: PreparedGoToRow[] = [];
      const removed: PreparedGoToRow[] = [];
      if (kind === "file") index.subsets.set(kind, next);
      for (const entry of entries) {
        if (!entry) { if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield; continue; }
        let row = kind === "file" ? entry.previous : previous?.get(entry.key);
        const existing = row;
        if (kind === "file" && row?.listingGeneration === generation) { if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield; continue; }
        const isNew = !row || row.path !== entry.path || row.label !== entry.label;
        if (!row || row.path !== entry.path || row.label !== entry.label) {
          const lowercasePath = entry.path.toLowerCase();
          const lowercaseBasename = entry.label.toLowerCase();
          const masks = characterMasks(lowercasePath + (kind === "app" ? lowercaseBasename : ""));
          const boundaries = boundaryCharacters(lowercasePath);
          const boundaryMasks = characterMasks(boundaries);
          row = {
            id: kind + ":" + entry.key, kind, label: entry.label, path: entry.path, lowercasePath, lowercaseBasename,
            characterMask: masks[0], characterMaskHigh: masks[1],
            boundaryMask: boundaryMasks[0], boundaryMaskHigh: boundaryMasks[1],
            glyphId: entry.glyphId, record: entry.record, ended: false, visible: true,
            pinnedRank: pinned.has(entry.path) ? 0 : 1, recentRank: recent.get(entry.path) ?? Number.MAX_SAFE_INTEGER,
            sourceIndex: 0, includedRevision: -1, listingGeneration: 0,
            target: kind === "version" || kind === "group"
              ? { workspaceId: index.workspaceId, kind, id: entry.key }
              : { workspaceId: index.workspaceId, kind, path: entry.path },
          };
          index.lastPreparationCount += 1;
        }
        if (row.glyphId !== entry.glyphId || !sameGoToRecord(kind, row.record, entry.record)) {
          row = { ...row, record: entry.record, glyphId: entry.glyphId, includedRevision: -1 };
        }
        if (kind === "file" || kind === "folder" || kind === "collection" || kind === "app") {
          if (isNew || verdictsChanged) {
            if (sources.listing) {
              index.lastVisibilityCheckCount += 1;
              row = yield* applyGoToPathState(row, verdictListing!, work, visibilityForPath);
            }
            else if (row.visible) row = { ...row, visible: false, includedRevision: -1 };
          }
        }
        if (row !== existing || kind !== "file") next.set(entry.key, row);
        if (kind === "file") {
          const old = index.files[files.length];
          if (old && old.path !== row.path) removed.push(old);
          row.listingGeneration = generation; files.push(row);
        }
        if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
      }
      if (kind === "file") {
        for (let i = files.length; i < index.files.length; i++) { removed.push(index.files[i]); if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield; }
        // Interrupted passes can add entries before publishing their file array.
        for (const entry of force ? next.keys() : removed) {
          if (typeof entry === "string") {
            if (next.get(entry)?.listingGeneration !== generation) next.delete(entry);
          } else if (entry.listingGeneration !== generation && next.get(entry.path)?.listingGeneration !== generation) next.delete(entry.path);
          if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
        }
        index.files = files;
      }
      index.subsets.set(kind, next);
      changed = true;
    }
    const visibilityVerdictsChanged = forceVerdicts || !sameVisibilityVerdicts(verdictListing, priorVerdictListing);
    if (sources.listing && (force || sources.listing !== this.sources.listing)) {
      const snapshot = sources.listing;
      if (force || snapshot.files !== this.sources.listing?.files || visibilityVerdictsChanged) yield* replace("file", (function* () {
        const previous = index.subsets.get("file");
        let entry: { key: string; path: string; label: string; record: GoToFile; glyphId: PreparedGoToRow["glyphId"]; previous?: PreparedGoToRow } | undefined;
        for (const file of snapshot.files) {
          const row = previous?.get(file.path);
          const glyphId = row && (row.record as GoToFile).kind === file.kind ? row.glyphId :
            file.kind === "database" ? FILE_KIND_RECORDS.database.glyphId : fileKindForPath(file.path).glyphId;
          if (!entry) entry = { key: file.path, path: file.path, label: row?.label ?? basenameOf(file.path), record: file, glyphId, previous: row };
          else {
            entry.key = file.path; entry.path = file.path; entry.label = row?.label ?? basenameOf(file.path);
            entry.record = file; entry.glyphId = glyphId; entry.previous = row;
          }
          yield entry;
        }
      })(), visibilityVerdictsChanged);
      if (force || snapshot.folders !== this.sources.listing?.folders || visibilityVerdictsChanged) yield* replace("folder", (function* () {
        for (const path of snapshot.folders) yield { key: path, path, label: basenameOf(path), record: path, glyphId: "folder" as const };
      })(), visibilityVerdictsChanged);
      changed = true;
    }
    if (sources.collections && (force || sources.collections !== this.sources.collections)) {
      yield* replace("collection", (function* () {
        for (const record of sources.collections!) yield { key: record.path, path: record.path, label: basenameOf(record.path), record, glyphId: "table" as const };
      })(), visibilityVerdictsChanged);
    }
    if (sources.apps && (force || sources.apps !== this.sources.apps)) {
      yield* replace("app", (function* () {
        for (const record of sources.apps!) yield { key: record.root, path: record.root, label: record.title, record, glyphId: "box" as const };
      })(), visibilityVerdictsChanged);
    }
    if (sources.versions && (force || sources.versions !== this.sources.versions)) {
      yield* replace("version", (function* () {
        for (const record of sources.versions!) yield { key: record.id, path: record.name, label: record.name, record, glyphId: "layers" as const };
      })());
    }
    if (sources.groups && (force || sources.groups !== this.sources.groups)) {
      yield* replace("group", (function* () {
        // Yield even for excluded rows, so exclusions cannot create one long slice.
        for (const record of sources.groups!) {
          if (record.kind === "channel") yield { key: record.id, path: record.name, label: record.name, record, glyphId: "messages-square" as const };
          else yield null;
        }
      })());
    }
    if (!changed && !contextChanged) return;
    const rows: PreparedGoToRow[] = [];
    const addedRows: PreparedGoToRow[] = [];
    let previousKeptIndex = -1;
    for (const [kind, subset] of this.subsets) {
      let fileIndex = 0;
      for (const previous of kind === "file" ? this.files : subset.values()) {
        let row = previous;
        if (contextChanged) row = withGoToRanks(row, pinned, recent);
        if (visibilityVerdictsChanged && (kind === "folder" || kind === "collection" || kind === "app")) {
          if (sources.listing) {
            index.lastVisibilityCheckCount += 1;
            row = yield* applyGoToPathState(row, verdictListing!, work, visibilityForPath);
          }
          else if (row.visible) row = { ...row, visible: false, includedRevision: -1 };
        }
        if (row !== previous) subset.set(goToRowKey(row), row);
        if (kind === "file") this.files[fileIndex++] = row;
        const pathBacked = kind === "file" || kind === "folder" || kind === "collection" || kind === "app";
        const mounted = sources.listing?.visibility.status !== "ready" && sources.listing?.receivedRoots.some(root => root.path === "" || row.path === root.path || row.path.startsWith(root.path + "/"));
        const withheldHostPath = pathBacked && sources.listing?.visibility.status !== "ready" && !mounted;
        if (row.visible && !withheldHostPath && !(kind === "folder" && this.subsets.get("collection")?.has(row.path))) {
          if (forceVerdicts || row.includedRevision !== this.revision || row.sourceIndex < previousKeptIndex) {
            addedRows.push(row);
            row.includedRevision = -1;
          } else previousKeptIndex = row.sourceIndex;
          row.sourceIndex = rows.length;
          rows.push(row);
        }
        if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
      }
    }
    // Sort only newly admitted rows, then merge them into the previous order.
    // Bounded native sorts handle small runs; merge copies yield in chunks.
    this.lastReorderedCount = addedRows.length;
    let added = addedRows;
    let buffer = new Array<PreparedGoToRow>(addedRows.length);
    const sortRunSize = 32;
    for (let left = 0; left < added.length; left += sortRunSize) {
      const run = added.slice(left, left + sortRunSize).sort(compareGoToOrder);
      for (let i = 0; i < run.length; i++) added[left + i] = run[i];
      yield;
    }
    for (let width = sortRunSize; width < added.length; width *= 2) {
      for (let left = 0; left < added.length; left += width * 2) {
        const middle = Math.min(left + width, added.length);
        const right = Math.min(left + width * 2, added.length);
        let a = left, b = middle;
        for (let to = left; to < right; to++) {
          const first = added[a], second = added[b];
          if (a < middle && (b >= right || compareGoToOrder(first, second) <= 0)) buffer[to] = added[a++];
          else buffer[to] = added[b++];
          if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
        }
      }
      [added, buffer] = [buffer, added];
    }
    const ordered: PreparedGoToRow[] = [];
    let at = 0;
    for (const row of forceVerdicts ? [] : this.orderedRows) {
      if (rows[row.sourceIndex] === row && row.includedRevision === this.revision) {
        while (at < added.length && compareGoToOrder(added[at], row) <= 0) {
          ordered.push(added[at++]);
          if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
        }
        ordered.push(row);
      }
      if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
    }
    while (at < added.length) { ordered.push(added[at++]); if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield; }
    const metadata = new Int32Array(ordered.length * 8);
    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i];
      const offset = i * 8;
      metadata[offset] = row.characterMask;
      metadata[offset + 1] = row.characterMaskHigh;
      metadata[offset + 2] = row.boundaryMask;
      metadata[offset + 3] = row.boundaryMaskHigh;
      metadata[offset + 4] = row.lowercaseBasename.charCodeAt(0);
      metadata[offset + 5] = row.pinnedRank;
      metadata[offset + 6] = row.kind === "file" ? 0 : row.kind === "app" ? 3 : 1;
      metadata[offset + 7] = recent.get(row.path) ?? -1;
      row.includedRevision = this.revision + 1;
      if (++work.operations % GO_TO_CHUNK_SIZE === 0) yield;
    }
    this.orderedRows = ordered;
    this.queryMetadata = metadata;
    this.sources = sources;
    this.visibilityForPath = visibilityForPath;
    if (verdictListing) this.verdictListing = verdictListing;
    this.context = context;
    this.interrupted = false;
    this.completeRows = rows;
    this.revision += 1;
    this.matches = null;
  }

  query(query: string, limit = 50, removed: ReadonlySet<string> = this.removed): PreparedGoToRow[] {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0 || this.withholding) { this.lastScanCount = 0; return []; }
    const q = query.toLowerCase();
    const rows = this.orderedRows;
    const metadata = this.queryMetadata;
    const [mask, maskHigh] = characterMasks(q);
    const fastSubsequence = !/[\uD800-\uDFFF]/.test(q);
    const exactSingleCharacter = q.length === 1 && (/[a-z0-9]/.test(q) || "/-_. ".includes(q));
    const firstCharacter = q.charCodeAt(0);
    const [firstMask, firstMaskHigh] = characterMasks(q[0] ?? "");
    const slash = q.includes("/");
    const previous = this.matches;
    const narrow = previous && previous.revision === this.revision && q.startsWith(previous.query);
    const indices = narrow ? previous.indices : new Int32Array(rows.length);
    const scanCount = narrow ? previous.count : rows.length;
    let count = 0;
    const buckets: PreparedGoToRow[][] = Array.from({ length: 16 }, () => []);
    const recentBuckets: { row: PreparedGoToRow; rank: number }[][] = Array.from({ length: 16 }, () => []);
    const pathQuery = isGoToPathQuery(q);
    for (let at = 0; at < scanCount; at++) {
      const i = narrow ? indices[at] : at;
      const offset = i * 8;
      if ((metadata[offset] & mask) !== mask || (metadata[offset + 1] & maskHigh) !== maskHigh) continue;
      let tier: number | null;
      if (exactSingleCharacter) {
        tier = metadata[offset + 4] === firstCharacter ? TIER_BASENAME_PREFIX :
          (metadata[offset + 2] & mask) === mask && (metadata[offset + 3] & maskHigh) === maskHigh ? TIER_WORD_BOUNDARY : TIER_SUBSTRING;
      } else {
        const row = rows[i];
        tier = preparedGoToTier(q, row, metadata[offset + 4] === firstCharacter,
          (metadata[offset + 2] & firstMask) === firstMask && (metadata[offset + 3] & firstMaskHigh) === firstMaskHigh, slash, fastSubsequence);
      }
      const flags = metadata[offset + 6];
      if (flags & 2) {
        const row = rows[i];
        const nameTier = quickOpenMatchTierLowercase(q, row.lowercaseBasename, row.lowercaseBasename);
        if (nameTier !== null) tier = tier === null ? nameTier : Math.min(tier, nameTier);
      }
      if (tier === null) continue;
      indices[count++] = i;
      if (removed.size && removed.has(rows[i].id)) continue;
      const priority = pathQuery && (flags & 1) ? 1 : 0;
      const bucketIndex = (priority * 2 + metadata[offset + 5]) * 4 + tier;
      const rank = metadata[offset + 7];
      if (rank !== -1) recentBuckets[bucketIndex].push({ row: rows[i], rank });
      else if (buckets[bucketIndex].length < boundedLimit) buckets[bucketIndex].push(rows[i]);
    }
    this.lastScanCount = scanCount;
    // Compact one current match set in place. All unseen matches survive narrowing.
    this.matches = { query: q, revision: this.revision, indices, count };
    const result: PreparedGoToRow[] = [];
    for (let i = 0; i < buckets.length; i++) {
      // Stable path order breaks equal recency ties, including names of different kinds.
      recentBuckets[i].sort((a, b) => a.rank - b.rank);
      for (const candidate of recentBuckets[i]) {
        if (result.length === boundedLimit) return result;
        result.push(candidate.row);
      }
      for (const row of buckets[i]) {
        if (result.length === boundedLimit) return result;
        result.push(row);
      }
    }
    return result;
  }
}
