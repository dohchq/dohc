import { formatChatTime } from "../time";
import { basenameOf } from "../path";
import { ChevronDown, ChevronRight, Database, FileArchive, FileText, History, Info, Layers, Lock, RotateCcw, Search, TriangleAlert, X, Zap } from "lucide-react";
import { EmptyState } from "../ui/controls";
import { Ref } from "../ui/Ref";
import { useCallback, useId, useMemo, useState } from "react";
import { LegendList } from "@legendapp/list/react";
import { HISTORY_MAX_SOURCES, type EngineMomentRecord, type TimelineEntry } from "../../ipc/bridgeContract";
import { chatAuthorLabel } from "./chatMessages";

// The History timeline: file moments, version markers and Collection
// changes, newest first, in the order main merged them. File moments keep
// their summaries ("Saved latest edits", "Merged version X into Main",
// "Reconciled offline edits", ...) and a multi-file pass (reconcile, switch,
// merge, restore) groups into one expandable item via its correlationId.
// Product vocabulary only, no git terms.

interface EngineHistoryGroup {
  key: string;
  summary: string;
  recordedAtMs: number;
  correlationId?: string;
  moments: EngineMomentRecord[];
}

type VersionEntry = Extract<TimelineEntry, { kind: "version" }>;
type CollectionEntry = Extract<TimelineEntry, { kind: "collection" }>;

export type TimelineItem =
  | { kind: "files"; key: string; group: EngineHistoryGroup }
  | { kind: "version"; key: string; version: VersionEntry["version"] }
  | { kind: "collection"; key: string; entry: CollectionEntry };

// The Collections a timeline can name and open on their History, with each
// operation's label by its name. A Collection this computer cannot open has
// no `openHistory`.
export type HistoryCollections = ReadonlyMap<string, {
  name: string;
  operationLabels?: ReadonlyMap<string, string>;
  openHistory?: () => void;
}>;

// The list label for one moment: its real engine summary when it has one,
// else calm product copy derived from the operation.
export function engineMomentSummary(
  moment: Pick<EngineMomentRecord, "summary" | "operation" | "path" | "contentKind" | "byteLength">,
): string {
  if (moment.summary) return moment.summary;
  if (moment.operation === "rename") return `Renamed to ${basenameOf(moment.path)}`;
  if (moment.operation === "delete") return `Deleted ${basenameOf(moment.path)}`;
  if (moment.contentKind === "binary") {
    return `Updated ${basenameOf(moment.path)} (${moment.byteLength ?? 0} bytes)`;
  }
  return `Edited ${basenameOf(moment.path)}`;
}

function engineOperationLabel(moment: EngineMomentRecord): string {
  if (moment.operation === "delete") return "Deleted";
  if (moment.operation === "rename") return "Renamed";
  return "Changed";
}

// One human label for where a moment came from. Engine moments are
// actor-neutral by default (origin, not author).
export function engineOriginLabel(origin: EngineMomentRecord["origin"]): string {
  switch (origin) {
    case "local-file":
      return "Local file edit";
    case "restore":
      return "Restore";
    case "sync":
      return "Sync";
    case "api":
      return "dohc";
    case "ydoc":
      return "Live edit";
    // Typing capture kept when its file changed outside dohc, in the words
    // of its notice. Dismissing or restoring it leaves the same change.
    case "capture-recovery":
    case "capture-recovery-cleared":
      return "Typing kept";
    default:
      return "Unknown source";
  }
}

// A moment authored by a dohc-tracked agent run displays as
// "the agent name" (the same formatting rule the chat rail uses via
// chatAuthorLabel), and one a Collection automation authored as the
// automation's name and its Collection. An Edit link's direct file write
// names the link and a short id for its holder; an app submission names the
// holder with the same short id, so it never reads like an Edit link's write. A
// restore names this computer's person who made it; their other edits read as a local file
// edit or a live edit. A live edit the relay admitted from an account or link
// holder names them. Everything else keeps its actor-neutral origin label.
export function engineMomentSourceLabel(
  moment: Pick<EngineMomentRecord, "origin" | "agentAuthorName" | "personAuthorName" | "liveAuthorName" | "publicAuthor" | "linkAuthor" | "automationAuthor" | "namedAuthor" | "authorLabels">,
): string {
  if (moment.origin === "restore" && moment.personAuthorName !== undefined) return moment.personAuthorName;
  if (moment.authorLabels) {
    const [first, second, third, ...rest] = moment.authorLabels;
    const shown = [first, second, third].filter((label): label is string => label !== undefined).join(", ");
    return rest.length ? `${shown} and ${rest.length} more` : shown;
  }
  if (moment.liveAuthorName) return moment.liveAuthorName;
  if (moment.publicAuthor) return `Link holder ${moment.publicAuthor.principalId.replace(/^public_/, "").slice(0, 8)}`;
  if (moment.linkAuthor) return `Edit link · holder ${moment.linkAuthor.principalId.slice(0, 8)}`;
  if (moment.automationAuthor) {
    const { name, collection } = moment.automationAuthor;
    return collection === undefined ? name : `${name} in ${collection}`;
  }
  if (moment.namedAuthor) return moment.namedAuthor.label;
  return moment.agentAuthorName !== undefined
    ? chatAuthorLabel({ authorKind: "agent", authorDisplayName: moment.agentAuthorName })
    : engineOriginLabel(moment.origin);
}

// Where a moment came from, as one line of History. An automation's name
// and Collection follow the ⚡ mark, in words, so nothing waits behind hover.
export function EngineMomentSource(props: {
  moment: Pick<EngineMomentRecord, "origin" | "agentAuthorName" | "personAuthorName" | "liveAuthorName" | "publicAuthor" | "linkAuthor" | "automationAuthor" | "namedAuthor" | "authorLabels">;
  testId: string;
  id?: string;
}) {
  const { moment } = props;
  if (moment.automationAuthor) {
    return (
      <span id={props.id} data-testid={props.testId} className="inline-flex items-center gap-1 text-muted">
        <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
        <span className="sr-only">Automation </span>
        {engineMomentSourceLabel(moment)}
      </span>
    );
  }
  // Agent-authored moments speak in the olive attribution voice; everything
  // else is a neutral origin in ink.
  return (
    <span
      data-testid={props.testId}
      className={moment.agentAuthorName !== undefined ? "text-agent" : "text-muted"}
    >
      {engineMomentSourceLabel(moment)}
    </span>
  );
}

// The group-level author: the shared agent author name when every moment in
// the group carries the same one, else undefined (mixed or neutral groups
// stay unlabeled — never a guessed attribution).
export function groupAgentAuthorName(
  moments: readonly Pick<EngineMomentRecord, "agentAuthorName">[],
): string | undefined {
  const first = moments[0]?.agentAuthorName;
  if (first === undefined) return undefined;
  return moments.every((moment) => moment.agentAuthorName === first)
    ? first
    : undefined;
}

// Keeps the order main merged and groups consecutive file moments that share
// a correlationId (one pass records its per-file moments contiguously on the
// capture chain). A version or Collection row between them ends the group.
// Moments without a correlationId stay singletons.
export function groupTimeline(entries: readonly TimelineEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "version") {
      items.push({ kind: "version", key: `version:${entry.version.id}`, version: entry.version });
      continue;
    }
    if (entry.kind === "collection") {
      items.push({ kind: "collection", key: `collection:${entry.datasetId}:${entry.change.revision}`, entry });
      continue;
    }
    const { moment } = entry;
    const previous = items[items.length - 1];
    if (
      previous?.kind === "files" &&
      moment.correlationId !== undefined &&
      previous.group.correlationId === moment.correlationId
    ) {
      previous.group.moments.push(moment);
      continue;
    }
    items.push({
      kind: "files",
      key: moment.id,
      group: {
        key: moment.id,
        summary: engineMomentSummary(moment),
        recordedAtMs: moment.recordedAtMs,
        ...(moment.correlationId !== undefined
          ? { correlationId: moment.correlationId }
          : {}),
        moments: [moment],
      },
    });
  }
  return items;
}

function automationName(automation: NonNullable<CollectionEntry["change"]["automation"]>): string {
  return automation.name ?? automation.automationId.slice(automation.automationId.lastIndexOf("#") + 1);
}

// Main is where the workspace starts, not a version someone created.
export function versionMarkerTitle(version: VersionEntry["version"]): string {
  return version.kind === "main" ? "Workspace created" : `Created version ${version.name}`;
}

// A Collection change in the person's words. A rules change says so; a
// record change takes its operation's label when the Collection's
// definition names it, else the Collection it changed.
export function collectionChangeTitle(entry: CollectionEntry, label: string | undefined): string {
  if (entry.change.schema) return "Changed fields and rules";
  return label ?? `Changed ${entry.name}`;
}

// The agent that approved a Collection's rules, if one did.
function approvalAgentName(change: CollectionEntry["change"]): string | undefined {
  const agent = change.approvalAgent;
  return agent ? chatAuthorLabel({ authorKind: "agent", authorDisplayName: agent.label ?? "Agent" }) : undefined;
}

function timelineSearchText(item: TimelineItem, labelOf: (entry: CollectionEntry) => string | undefined): string {
  if (item.kind === "version") return versionMarkerTitle(item.version).toLowerCase();
  if (item.kind === "collection") {
    const { name, change } = item.entry;
    return [collectionChangeTitle(item.entry, labelOf(item.entry)), name, change.operation,
      approvalAgentName(change) ?? "", change.automation ? automationName(change.automation) : ""].join("\n").toLowerCase();
  }
  return [
    item.group.summary,
    ...item.group.moments.flatMap((moment) => [
      moment.path,
      engineMomentSummary(moment),
      engineMomentSourceLabel(moment),
      ...(moment.authorLabels ?? []),
    ]),
  ]
    .join("\n")
    .toLowerCase();
}

// Which day heading an item sits under. A Collection change main could not
// date sits where main placed it, under its neighbours' day; its row says
// the date is unknown. Only an item with no placement time either gets the
// "Date unknown" heading.
function itemPlacement(item: TimelineItem): number | null {
  if (item.kind === "files") return item.group.recordedAtMs;
  if (item.kind === "version") return item.version.createdAtMs;
  return item.entry.sortAtMs;
}

function dayKey(recordedAtMs: number): string {
  const recordedAt = new Date(recordedAtMs);
  const month = String(recordedAt.getMonth() + 1).padStart(2, "0");
  const day = String(recordedAt.getDate()).padStart(2, "0");
  return `${recordedAt.getFullYear()}-${month}-${day}`;
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatDay(recordedAtMs: number | null): { label: string; dateTime: string | null } {
  if (recordedAtMs === null) return { label: "Date unknown", dateTime: null };
  const recordedAt = new Date(recordedAtMs);
  return {
    label: dayFormat.format(recordedAt),
    dateTime: dayKey(recordedAtMs),
  };
}

// "Budget", "Budget and Guests", "Budget, Guests, Tasks and 2 more", or
// "2 Collections" when this computer knows none of their names.
export function collectionListPhrase(names: readonly string[], total: number): string {
  const shown = names.slice(0, 3);
  const rest = total - shown.length;
  if (shown.length === 0) return `${total} Collection${total === 1 ? "" : "s"}`;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

// The sentences that say what a partial timeline is missing.
export function missingSourcesWords(
  unavailable: readonly { datasetId: string }[],
  omitted: number,
  nameOf: (datasetId: string) => string | undefined,
): { unavailable: string | null; omitted: string | null } {
  const names = unavailable.flatMap((source) => nameOf(source.datasetId) ?? []);
  return {
    unavailable: unavailable.length
      ? `dohc could not load changes from ${collectionListPhrase(names, unavailable.length)}.`
      : null,
    omitted: omitted > 0
      ? `History includes up to ${HISTORY_MAX_SOURCES} Collections. ${omitted} more ${omitted === 1 ? "is" : "are"} left out. To see a Collection's changes, open it and choose History.`
      : null,
  };
}

// One change in the timeline. The states page renders it too.
export function MomentRow(props: {
  moment: EngineMomentRecord;
  nested?: boolean;
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const { moment } = props;
  const recordedAt = formatChatTime(moment.recordedAtMs);
  // The row's name says what it opens, so an automation that wrote the
  // change is its description.
  const sourceId = useId();
  const describedBySource = moment.automationAuthor !== undefined && !props.nested;
  // A state mark sits on the first line's center: the 22px chip in a nested
  // row, the 13px summary otherwise.
  const mark = props.nested ? "mt-[5px]" : "mt-0.5";
  return (
    <button
      type="button"
      aria-describedby={describedBySource ? sourceId : undefined}
      data-testid="engine-moment-open"
      data-moment-id={moment.id}
      data-moment-path={moment.path}
      title={`Open diff for ${moment.path}`}
      aria-label={`Open diff for ${moment.path}`}
      onClick={() => props.onOpenMoment(moment.id, moment.path)}
      className={`block w-full px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
        props.nested ? "pl-8" : ""
      }`}
    >
      <span className="flex min-w-0 items-start gap-2">
        {moment.protected ? (
          // Secret-backed file moment: the lock is the affordance —
          // the row is metadata-only and its page shows no contents.
          <Lock
            size={12}
            aria-hidden
            data-testid="engine-moment-lock"
            className={`${mark} shrink-0 text-subtle`}
          />
        ) : moment.contentKind === "binary" ? (
          <FileArchive
            size={12}
            aria-hidden
            data-testid="engine-moment-binary"
            className={`${mark} shrink-0 text-subtle`}
          />
        ) : moment.origin === "restore" ? (
          <RotateCcw size={12} aria-hidden className={`${mark} shrink-0 text-subtle`} />
        ) : props.nested ? (
          // The file's own chip carries its kind.
          <span aria-hidden className="size-3 shrink-0" />
        ) : (
          <FileText size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
        )}
        <span className="min-w-0 flex-1">
          {props.nested ? (
            <span className="flex min-w-0">
              <Ref path={moment.path} folder />
            </span>
          ) : (
            <span className="block truncate text-[13px] font-medium text-ink">
              {engineMomentSummary(moment)}
            </span>
          )}
          <span className="mt-0.5 block truncate text-[11px] text-subtle">
            {props.nested ? (
              engineOperationLabel(moment)
            ) : (
              <>
                <EngineMomentSource moment={moment} testId="engine-moment-source" id={sourceId} />
                {" · "}
                <time
                  data-testid="engine-moment-recorded-at"
                  dateTime={recordedAt.iso}
                  title={recordedAt.iso}
                  className="font-mono"
                >
                  {recordedAt.label}
                </time>
                {" · "}
                <span className="font-mono">{moment.path}</span>
              </>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}

function GroupRow(props: {
  group: EngineHistoryGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const { group } = props;
  const { expanded } = props;
  const recordedAt = formatChatTime(group.recordedAtMs);
  // Uniform agent authorship surfaces on the group row itself; mixed or
  // neutral groups show no author (never a guess).
  const agentAuthorName = groupAgentAuthorName(group.moments);
  return (
    <div data-testid="engine-moment-group">
      <button
        type="button"
        data-testid="engine-moment-group-toggle"
        aria-expanded={expanded}
        onClick={props.onToggle}
        className="block w-full px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <span className="flex min-w-0 items-start gap-2">
          {expanded ? (
            <ChevronDown size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
          ) : (
            <ChevronRight size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink">
              {group.summary}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-subtle">
              {agentAuthorName !== undefined ? (
                <>
                  <span
                    data-testid="engine-moment-group-source"
                    className="text-agent"
                  >
                    {chatAuthorLabel({
                      authorKind: "agent",
                      authorDisplayName: agentAuthorName,
                    })}
                  </span>
                  {" · "}
                </>
              ) : null}
              <time
                dateTime={recordedAt.iso}
                title={recordedAt.iso}
                className="font-mono"
              >
                {recordedAt.label}
              </time>
              {" · "}
              <span className="font-mono">
                {group.moments.length} file{group.moments.length === 1 ? "" : "s"}
              </span>
            </span>
          </span>
        </span>
      </button>
      {expanded ? (
        <div data-testid="engine-moment-group-files">
          {group.moments.map((moment) => (
            <MomentRow
              key={moment.id}
              moment={moment}
              nested
              onOpenMoment={props.onOpenMoment}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// A version starting, as a marker between changes. It opens nothing, so it
// reads lighter than the changes around it.
function VersionMarkerRow(props: { version: VersionEntry["version"] }) {
  const createdAt = formatChatTime(props.version.createdAtMs);
  return (
    <div className="flex min-w-0 items-start gap-2 px-3 py-2">
      <Layers size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-muted">
          {versionMarkerTitle(props.version)}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-subtle">
          <time dateTime={createdAt.iso} title={createdAt.iso} className="font-mono">
            {createdAt.label}
          </time>
        </span>
      </span>
    </div>
  );
}

// One saved Collection change. Like a file's row opens its diff, it opens its
// Collection's History, where the change and its Undo are, when this
// computer can open that Collection.
function CollectionChangeRow(props: { entry: CollectionEntry; label?: string; openHistory?: () => void }) {
  const { name, change } = props.entry;
  const recordedAt = change.recordedAtMs === null ? null : formatChatTime(change.recordedAtMs);
  const agent = approvalAgentName(change);
  // Only a record change with no label names its Collection in its title,
  // and only it needs its operation's own name to say which change it was.
  const unlabelled = !change.schema && props.label === undefined;
  // The row's name says what it opens, so the change is its description.
  const metaId = useId();
  const body = (
    <span className="flex min-w-0 items-start gap-2">
      <Database size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">
          {collectionChangeTitle(props.entry, props.label)}
        </span>
        <span id={metaId} className="mt-0.5 block truncate text-[11px] text-subtle">
          {agent !== undefined ? (
            <>
              <span data-testid="history-collection-agent" className="text-agent">{agent}</span>
              {" · "}
            </>
          ) : null}
          {change.automation ? (
            <>
              <span className="inline-flex items-center gap-1 text-muted">
                <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
                <span className="sr-only">Automation </span>
                {automationName(change.automation)}
              </span>
              {" · "}
            </>
          ) : null}
          {recordedAt ? (
            <time dateTime={recordedAt.iso} title={recordedAt.iso} className="font-mono">
              {recordedAt.label}
            </time>
          ) : (
            <span data-testid="history-collection-date-unknown">Date unknown</span>
          )}
          {" · "}
          {unlabelled ? <span className="font-mono">{change.operation}</span> : <span>{name}</span>}
        </span>
      </span>
    </span>
  );
  return props.openHistory ? (
    <button
      type="button"
      data-testid="history-collection-open"
      aria-describedby={metaId}
      aria-label={`Open Collection history for ${name}`}
      title={`Open Collection history for ${name}`}
      onClick={props.openHistory}
      className="block w-full px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
    >
      {body}
    </button>
  ) : (
    <div className="px-3 py-2">{body}</div>
  );
}

// What a partial timeline is missing, above its rows. Try again starts a new
// source chain; a source left out by the limit stays out, so only the
// Collections that did not load offer it.
function HistorySourcesNotice(props: {
  words: { unavailable: string | null; omitted: string | null };
  onRetry: () => void;
}) {
  const { words } = props;
  return (
    <div
      data-testid="history-sources-notice"
      className="flex shrink-0 items-start gap-2 border-b border-line bg-panel px-3 py-2 text-[12px] text-muted"
    >
      {words.unavailable ? (
        <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-warning" />
      ) : (
        <Info size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {words.unavailable ? <span data-testid="history-sources-unavailable">{words.unavailable}</span> : null}
        {words.omitted ? <span data-testid="history-sources-omitted">{words.omitted}</span> : null}
      </span>
      {words.unavailable ? (
        <button
          type="button"
          data-testid="history-sources-retry"
          onClick={props.onRetry}
          className="h-6 shrink-0 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

// The timeline body (side panel History view and the history tab render
// this over the same root-owned page state).
export function EngineHistoryView(props: {
  entries: TimelineEntry[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenMoment: (momentId: string, filePath: string) => void;
  unavailableSources?: readonly { datasetId: string }[];
  omittedSources?: number;
  collections?: HistoryCollections;
  // Reads the newest page again, which starts a new source chain.
  onRetry?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const { collections, entries } = props;
  const items = useMemo(() => groupTimeline(props.entries), [props.entries]);
  const labelOf = useCallback(
    (entry: CollectionEntry) => collections?.get(entry.datasetId)?.operationLabels?.get(entry.change.operation),
    [collections],
  );
  const filteredItems = useMemo(
    () =>
      normalizedQuery
        ? items.filter((item) => timelineSearchText(item, labelOf).includes(normalizedQuery))
        : items,
    [items, normalizedQuery, labelOf],
  );
  const rows = useMemo(() => {
    const result: Array<
      | { key: string; day: ReturnType<typeof formatDay>; item?: never }
      | { key: string; item: TimelineItem; day?: never }
    > = [];
    let previousDay: string | null | undefined;
    for (const item of filteredItems) {
      const day = formatDay(itemPlacement(item));
      if (previousDay !== day.dateTime) result.push({ key: `day:${item.key}`, day });
      result.push({ key: item.key, item });
      previousDay = day.dateTime;
    }
    return result;
  }, [filteredItems]);
  const words = useMemo(
    () => missingSourcesWords(props.unavailableSources ?? [], props.omittedSources ?? 0, (datasetId) =>
      collections?.get(datasetId)?.name ??
        entries.find((entry): entry is CollectionEntry => entry.kind === "collection" && entry.datasetId === datasetId)?.name),
    [props.unavailableSources, props.omittedSources, collections, entries],
  );
  const retry = props.onRetry ?? (() => undefined);
  const stickyHeaderIndices = useMemo(
    () => rows.flatMap((row, index) => (row.day ? [index] : [])),
    [rows],
  );
  const focusedIndex = rows.findIndex((row) => row.key === focusedKey);
  // Retain the adjacent groups too, so Tab can leave a row after it scrolls away.
  const retainedKeys = focusedIndex < 0
    ? []
    : rows.slice(Math.max(0, focusedIndex - 2), focusedIndex + 3).map((row) => row.key);
  const headerItemCount = 0;
  const listItemCount = headerItemCount + rows.length + (props.hasMore ? 1 : 0);
  const rowPresentation = useMemo(
    () => ({ expandedGroups, headerItemCount, listItemCount, onOpenMoment: props.onOpenMoment, collections }),
    [expandedGroups, headerItemCount, listItemCount, props.onOpenMoment, collections],
  );
  const partial = words.unavailable !== null || words.omitted !== null;

  // A known page with no rows. The caller renders this view only when it
  // has a page: "No changes yet" states something about the workspace,
  // and a read still in flight or a read that failed may not state it.
  // Neither may a page that is missing Collections: their changes are
  // unknown, not absent.
  if (props.entries.length === 0 && !props.hasMore) {
    if (partial) {
      return (
        <div
          data-testid="history-collections-unavailable"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted"
        >
          {words.unavailable ? <span>{words.unavailable}</span> : null}
          {words.omitted ? <span>{words.omitted}</span> : null}
          {words.unavailable ? (
            <button
              type="button"
              data-testid="history-sources-retry"
              onClick={retry}
              className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink"
            >
              Try again
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <EmptyState
        icon={History}
        title="No changes yet"
        hint="Edits by you or your agent appear here as a timeline you can review."
      />
    );
  }

  return (
    <>
      <div className="shrink-0 border-b border-line bg-panel-2 px-2 py-2">
        <label className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-[11px] text-muted focus-within:border-ink">
          <Search size={12} aria-hidden className="shrink-0 text-subtle" />
          <input
            type="search"
            data-testid="engine-history-search"
            aria-label="Search history"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search history"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="Clear history search"
              title="Clear history search"
              onClick={() => setQuery("")}
              className="grid size-5 shrink-0 place-items-center rounded-md text-subtle hover:bg-hover hover:text-ink"
            >
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </label>
      </div>
      {partial ? <HistorySourcesNotice words={words} onRetry={retry} /> : null}
      <LegendList
        role="list"
        data-testid="engine-history-list"
        // `isolate` keeps the sticky day headings' z-index inside History,
        // under any overlay.
        className="isolate m-0 min-h-0 flex-1 list-none p-0"
        data={rows}
        keyExtractor={(row) => row.key}
        estimatedItemSize={56}
        getItemType={(row) => (row.day ? "day" : row.item.kind)}
        stickyHeaderIndices={stickyHeaderIndices}
        recycleItems={false}
        alwaysRender={{ keys: retainedKeys }}
        onFocusCapture={(event) =>
          setFocusedKey(
            (event.target as HTMLElement).closest<HTMLElement>("[data-history-key]")
              ?.dataset.historyKey ?? null,
          )
        }
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null);
        }}
        extraData={rowPresentation}
        renderItem={({ item, index }) => item.day ? (
          <li
            role="listitem"
            aria-posinset={headerItemCount + index + 1}
            aria-setsize={listItemCount}
            className="border-b border-line bg-panel-2 px-3 py-1"
          >
            {item.day.dateTime === null ? (
              <span data-testid="engine-history-day-heading" className="dohc-section-label">
                {item.day.label}
              </span>
            ) : (
              <time
                data-testid="engine-history-day-heading"
                dateTime={item.day.dateTime}
                className="dohc-section-label"
              >
                {item.day.label}
              </time>
            )}
          </li>
        ) : (
          <li
            role="listitem"
            aria-posinset={headerItemCount + index + 1}
            aria-setsize={listItemCount}
            data-testid={item.item.kind === "files" ? "engine-moment"
              : item.item.kind === "version" ? "history-version" : "history-collection-change"}
            data-history-key={item.key}
            className="border-b border-line"
          >
            {item.item.kind === "version" ? (
              <VersionMarkerRow version={item.item.version} />
            ) : item.item.kind === "collection" ? (
              <CollectionChangeRow
                entry={item.item.entry}
                label={labelOf(item.item.entry)}
                openHistory={collections?.get(item.item.entry.datasetId)?.openHistory}
              />
            ) : item.item.group.moments.length > 1 ? (
              <GroupRow
                group={item.item.group}
                expanded={expandedGroups.has(item.key)}
                onToggle={() => setExpandedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(item.key)) next.delete(item.key);
                  else next.add(item.key);
                  return next;
                })}
                onOpenMoment={props.onOpenMoment}
              />
            ) : (
              <MomentRow moment={item.item.group.moments[0]} onOpenMoment={props.onOpenMoment} />
            )}
          </li>
        )}
        ListFooterComponent={props.hasMore ? (
          <li
            role="listitem"
            aria-posinset={listItemCount}
            aria-setsize={listItemCount}
            className="border-b border-line"
          >
            <button
              type="button"
              data-testid="engine-history-load-more"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
              className="block w-full cursor-pointer px-3 py-2 text-center text-[11px] text-muted hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-60"
            >
              {props.loadingMore ? "Loading…" : "Show earlier changes"}
            </button>
          </li>
        ) : null}
      />
    </>
  );
}
