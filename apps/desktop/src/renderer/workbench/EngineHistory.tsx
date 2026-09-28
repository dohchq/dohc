import { formatChatTime } from "../time";
import { basenameOf } from "../path";
import { ChevronDown, ChevronRight, FileArchive, FileText, Lock, RotateCcw, Search, X, Zap } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { LegendList } from "@legendapp/list/react";
import type { EngineMomentRecord } from "../../ipc/bridgeContract";
import { chatAuthorLabel } from "./LinkedChats";

// Engine history timeline. Renders engine moments with their summaries
// ("Saved latest edits", "Merged version X into Main", "Reconciled offline
// edits", ...) and groups a multi-file pass (reconcile, switch, merge,
// restore) into one expandable item via its correlationId. Product
// vocabulary only, no git terms.

interface EngineHistoryGroup {
  key: string;
  summary: string;
  recordedAtMs: number;
  correlationId?: string;
  moments: EngineMomentRecord[];
}

// The list label for one moment: its real engine summary when it has one,
// else calm product copy derived from the operation.
export function engineMomentSummary(
  moment: Pick<EngineMomentRecord, "summary" | "operation" | "path" | "contentKind" | "byteLength">,
): string {
  if (moment.summary) return moment.summary;
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
    default:
      return "Unknown source";
  }
}

// A moment authored by a dohc-tracked agent run displays as
// "the agent name" (the same formatting rule the chat rail uses via
// chatAuthorLabel), and one a Collection automation authored as the
// automation's name and its Collection. An Edit link's direct file write
// names the link and a short form of the browser session that used it, so
// it never reads like an app submission from a link holder. Everything else
// keeps its actor-neutral origin label.
export function engineMomentSourceLabel(
  moment: Pick<EngineMomentRecord, "origin" | "agentAuthorName" | "publicAuthor" | "linkAuthor" | "automationAuthor" | "namedAuthor">,
): string {
  if (moment.publicAuthor) return `Link holder ${moment.publicAuthor.principalId}`;
  if (moment.linkAuthor) return `Edit link · holder ${moment.linkAuthor.principalId.slice(0, 8)}`;
  if (moment.automationAuthor) return `${moment.automationAuthor.name} in ${moment.automationAuthor.collection}`;
  if (moment.namedAuthor) return moment.namedAuthor.label;
  return moment.agentAuthorName !== undefined
    ? chatAuthorLabel({ authorKind: "agent", authorDisplayName: moment.agentAuthorName })
    : engineOriginLabel(moment.origin);
}

// Where a moment came from, as one line of History. An automation's name
// and Collection follow the ⚡ mark, in words, so nothing waits behind hover.
export function EngineMomentSource(props: {
  moment: Pick<EngineMomentRecord, "origin" | "agentAuthorName" | "publicAuthor" | "linkAuthor" | "automationAuthor" | "namedAuthor">;
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

// Groups consecutive moments that share a correlationId (the list is newest
// first, and one pass records its per-file moments contiguously on the
// capture chain). Moments without a correlationId stay singletons.
export function groupEngineMoments(
  moments: readonly EngineMomentRecord[],
): EngineHistoryGroup[] {
  const groups: EngineHistoryGroup[] = [];
  for (const moment of moments) {
    const previous = groups[groups.length - 1];
    if (
      previous &&
      moment.correlationId !== undefined &&
      previous.correlationId === moment.correlationId
    ) {
      previous.moments.push(moment);
      continue;
    }
    groups.push({
      key: moment.id,
      summary: engineMomentSummary(moment),
      recordedAtMs: moment.recordedAtMs,
      ...(moment.correlationId !== undefined
        ? { correlationId: moment.correlationId }
        : {}),
      moments: [moment],
    });
  }
  return groups;
}

function engineHistorySearchText(group: EngineHistoryGroup): string {
  return [
    group.summary,
    ...group.moments.flatMap((moment) => [
      moment.path,
      engineMomentSummary(moment),
      engineMomentSourceLabel(moment),
    ]),
  ]
    .join("\n")
    .toLowerCase();
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

function formatDay(recordedAtMs: number): { label: string; dateTime: string } {
  const recordedAt = new Date(recordedAtMs);
  return {
    label: dayFormat.format(recordedAt),
    dateTime: dayKey(recordedAtMs),
  };
}

function MomentRow(props: {
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
            className="mt-0.5 shrink-0 text-subtle"
          />
        ) : moment.contentKind === "binary" ? (
          <FileArchive
            size={12}
            aria-hidden
            data-testid="engine-moment-binary"
            className="mt-0.5 shrink-0 text-subtle"
          />
        ) : moment.origin === "restore" ? (
          <RotateCcw size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
        ) : (
          <FileText size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] text-ink ${
              props.nested ? "font-mono" : "font-medium"
            }`}
          >
            {props.nested ? moment.path : engineMomentSummary(moment)}
          </span>
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

// The timeline body (side panel History view and the history tab render
// this over the same root-owned page state).
export function EngineHistoryView(props: {
  moments: EngineMomentRecord[];
  hasMore: boolean;
  loadingMore: boolean;
  protectedTruncated: boolean;
  onLoadMore: () => void;
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(() => groupEngineMoments(props.moments), [props.moments]);
  const filteredGroups = useMemo(
    () =>
      normalizedQuery
        ? groups.filter((group) =>
            engineHistorySearchText(group).includes(normalizedQuery),
          )
        : groups,
    [groups, normalizedQuery],
  );
  const rows = useMemo(() => {
    const result: Array<
      | { key: string; day: ReturnType<typeof formatDay>; group?: never }
      | { key: string; group: EngineHistoryGroup; day?: never }
    > = [];
    let previousDay: string | null = null;
    for (const group of filteredGroups) {
      const day = formatDay(group.recordedAtMs);
      if (previousDay !== day.dateTime) result.push({ key: `day:${group.key}`, day });
      result.push({ key: group.key, group });
      previousDay = day.dateTime;
    }
    return result;
  }, [filteredGroups]);
  const stickyHeaderIndices = useMemo(
    () => rows.flatMap((row, index) => (row.day ? [index] : [])),
    [rows],
  );
  const focusedIndex = rows.findIndex((row) => row.key === focusedKey);
  // Retain the adjacent groups too, so Tab can leave a row after it scrolls away.
  const retainedKeys = focusedIndex < 0
    ? []
    : rows.slice(Math.max(0, focusedIndex - 2), focusedIndex + 3).map((row) => row.key);
  const headerItemCount = props.protectedTruncated ? 1 : 0;
  const listItemCount = headerItemCount + rows.length + (props.hasMore ? 1 : 0);
  const rowPresentation = useMemo(
    () => ({ expandedGroups, headerItemCount, listItemCount, onOpenMoment: props.onOpenMoment }),
    [expandedGroups, headerItemCount, listItemCount, props.onOpenMoment],
  );

  // A known page with no moments. The caller renders this view only when it
  // has a page: "No changes yet" states something about the workspace,
  // and a read still in flight or a read that failed may not state it.
  if (props.moments.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <span className="text-sm text-muted">No changes yet</span>
        <span className="max-w-xs text-[11px] leading-5 text-subtle">
          Edits — yours or your agent's — show up here as a timeline you can
          review.
        </span>
      </div>
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
      <LegendList
        role="list"
        data-testid="engine-history-list"
        className="m-0 min-h-0 flex-1 list-none p-0"
        data={rows}
        keyExtractor={(row) => row.key}
        estimatedItemSize={56}
        getItemType={(row) => (row.day ? "day" : "moment")}
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
        ListHeaderComponent={props.protectedTruncated ? (
          <li
            role="listitem"
            aria-posinset={1}
            aria-setsize={listItemCount}
            className="border-b border-line px-3 py-2 text-[11px] text-muted"
          >
            Some protected activity in this range is not shown.
          </li>
        ) : null}
        renderItem={({ item, index }) => item.day ? (
          <li
            role="listitem"
            aria-posinset={headerItemCount + index + 1}
            aria-setsize={listItemCount}
            className="border-b border-line bg-panel-2 px-3 py-1"
          >
            <time
              data-testid="engine-history-day-heading"
              dateTime={item.day.dateTime}
              className="dohc-section-label"
            >
              {item.day.label}
            </time>
          </li>
        ) : (
          <li
            role="listitem"
            aria-posinset={headerItemCount + index + 1}
            aria-setsize={listItemCount}
            data-testid="engine-moment"
            data-history-key={item.key}
            className="border-b border-line"
          >
            {item.group.moments.length > 1 ? (
              <GroupRow
                group={item.group}
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
              <MomentRow moment={item.group.moments[0]} onOpenMoment={props.onOpenMoment} />
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
