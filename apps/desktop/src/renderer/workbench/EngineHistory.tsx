import { ChevronDown, ChevronRight, FileArchive, FileText, Lock, RotateCcw, Search, X } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { EngineMomentRecord } from "../../ipc/bridgeContract";
import { chatAuthorLabel } from "./LinkedChats";

// Engine history timeline (PR 0M-5, workspace-engine alpha). Flagged
// workspaces read ENGINE moments instead of legacy change sets; this renders
// them with their real summaries ("Saved latest edits", "Merged version X
// into Main", "Reconciled offline edits", ...) and groups a multi-file pass
// (reconcile, switch, merge, restore) into one expandable item via its
// correlationId. Product vocabulary only — no git terms.

export interface EngineHistoryGroup {
  key: string;
  summary: string;
  recordedAtMs: number;
  correlationId?: string;
  moments: EngineMomentRecord[];
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

// The list label for one moment: its real engine summary when it has one,
// else calm product copy derived from the operation.
export function engineMomentSummary(
  moment: Pick<EngineMomentRecord, "summary" | "operation" | "path" | "contentKind" | "byteLength">,
): string {
  if (moment.summary) return moment.summary;
  if (moment.operation === "delete") return `Deleted ${basename(moment.path)}`;
  if (moment.contentKind === "binary") {
    return `Updated ${basename(moment.path)} (${moment.byteLength ?? 0} bytes)`;
  }
  return `Edited ${basename(moment.path)}`;
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

// PR 0N-1: a moment authored by a dohc-tracked agent run displays as
// "<User Name>'s agent" (the SAME formatting rule the chat rail uses via
// chatAuthorLabel); everything else keeps its actor-neutral origin label.
export function engineMomentSourceLabel(
  moment: Pick<EngineMomentRecord, "origin" | "agentAuthorName">,
): string {
  return moment.agentAuthorName !== undefined
    ? chatAuthorLabel({ authorKind: "agent", authorDisplayName: moment.agentAuthorName })
    : engineOriginLabel(moment.origin);
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

// Groups CONSECUTIVE moments that share a correlationId (the list is newest
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

function formatRecordedAt(recordedAtMs: number): { label: string; iso: string } {
  const recordedAt = new Date(recordedAtMs);
  return {
    label: recordedAt.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    iso: recordedAt.toISOString(),
  };
}

function dayKey(recordedAtMs: number): string {
  const recordedAt = new Date(recordedAtMs);
  const month = String(recordedAt.getMonth() + 1).padStart(2, "0");
  const day = String(recordedAt.getDate()).padStart(2, "0");
  return `${recordedAt.getFullYear()}-${month}-${day}`;
}

function formatDay(recordedAtMs: number): { label: string; dateTime: string } {
  const recordedAt = new Date(recordedAtMs);
  return {
    label: recordedAt.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    dateTime: dayKey(recordedAtMs),
  };
}

function MomentRow(props: {
  moment: EngineMomentRecord;
  nested?: boolean;
  onOpenMoment: (momentId: string) => void;
}) {
  const { moment } = props;
  const recordedAt = formatRecordedAt(moment.recordedAtMs);
  // Agent-authored moments speak in the olive attribution voice; everything
  // else is a neutral origin in ink.
  const isAgent = moment.agentAuthorName !== undefined;
  return (
    <button
      type="button"
      data-testid="engine-moment-open"
      data-moment-id={moment.id}
      data-moment-path={moment.path}
      title={`Open diff for ${moment.path}`}
      aria-label={`Open diff for ${moment.path}`}
      onClick={() => props.onOpenMoment(moment.id)}
      className={`block w-full px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
        props.nested ? "pl-8" : ""
      }`}
    >
      <span className="flex min-w-0 items-start gap-2">
        {moment.protected ? (
          // Secret-backed file moment (PR 08): the lock is the affordance —
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
                <span
                  data-testid="engine-moment-source"
                  className={isAgent ? "text-agent" : "text-muted"}
                >
                  {engineMomentSourceLabel(moment)}
                </span>
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
  onOpenMoment: (momentId: string) => void;
}) {
  const { group } = props;
  const [expanded, setExpanded] = useState(false);
  const recordedAt = formatRecordedAt(group.recordedAtMs);
  // Uniform agent authorship surfaces on the group row itself; mixed or
  // neutral groups show no author (never a guess).
  const agentAuthorName = groupAgentAuthorName(group.moments);
  return (
    <div data-testid="engine-moment-group">
      <button
        type="button"
        data-testid="engine-moment-group-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="block w-full px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
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

// The timeline body for flagged workspaces (side panel History view, history
// tab render this over the same root-owned page state).
export function EngineHistoryView(props: {
  moments: EngineMomentRecord[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenMoment: (momentId: string) => void;
}) {
  const [query, setQuery] = useState("");
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
              className="grid size-5 shrink-0 place-items-center rounded-md text-subtle hover:bg-line/50 hover:text-ink"
            >
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </label>
      </div>
      <ul
        data-testid="engine-history-list"
        className="m-0 min-h-0 flex-1 list-none overflow-y-auto overflow-x-hidden p-0"
      >
        {filteredGroups.map((group, index) => {
          const day = formatDay(group.recordedAtMs);
          const previousDayKey =
            index > 0 ? dayKey(filteredGroups[index - 1].recordedAtMs) : null;
          const showDayHeading = previousDayKey !== day.dateTime;
          return (
            <Fragment key={group.key}>
              {showDayHeading ? (
                <li className="sticky top-0 z-[1] border-b border-line bg-panel-2 px-3 py-1">
                  <time
                    data-testid="engine-history-day-heading"
                    dateTime={day.dateTime}
                    className="text-[10px] font-semibold uppercase tracking-wide text-subtle"
                  >
                    {day.label}
                  </time>
                </li>
              ) : null}
              <li data-testid="engine-moment" className="border-b border-line">
                {group.moments.length > 1 ? (
                  <GroupRow group={group} onOpenMoment={props.onOpenMoment} />
                ) : (
                  <MomentRow moment={group.moments[0]} onOpenMoment={props.onOpenMoment} />
                )}
              </li>
            </Fragment>
          );
        })}
        {props.hasMore ? (
          <li className="border-b border-line">
            <button
              type="button"
              data-testid="engine-history-load-more"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
              className="block w-full cursor-pointer px-3 py-2 text-center text-[11px] text-muted hover:bg-line/25 hover:text-ink disabled:cursor-wait disabled:opacity-60"
            >
              {props.loadingMore ? "Loading…" : "Show earlier changes"}
            </button>
          </li>
        ) : null}
      </ul>
    </>
  );
}
