import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Regex,
  SearchX,
  SlidersHorizontal,
  WholeWord,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { SearchResultsEventEntry } from "../../ipc/channels";
import { rendererMarks } from "../../performance/rendererMarks";
import {
  GROUP_WINDOW_STEP,
  groupVisibleEntries,
  moveSearchSelection,
  visibleFlatEntries,
  windowPreviewForRow,
  type SearchGroup,
} from "./search-model";
import type { SearchRunOptions, WorkspaceSearchApi } from "./useWorkspaceSearch";

// Phase E5.0 content-search panel (Cmd/Ctrl+Shift+F surface): debounced
// search-as-you-type over the streamed ripgrep IPC, grouped-by-file results
// with offset-based highlighting (the pattern NEVER re-executes here),
// keyboard navigation in flat result order, and the 2000-match cap notice.

const DEBOUNCE_MS = 150;
// Mirrors SEARCH_MAX_TOTAL_MATCHES (workspaceSearch.ts) for the cap notice
// copy; the authoritative cap lives in the main-process engine.
const RESULT_CAP = 2000;

function isBlankSearchQuery(value: string): boolean {
  return value.trim().length === 0;
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

// Offset-based match highlighting: slice the preview at matchStart/matchEnd.
// The row END-truncates, so deep-column matches are lead-trimmed first
// (windowPreviewForRow) — the match must always be visible in its own row.
// The mark is the OPAQUE --dohc-match blue (3:1+ vs panel AND the selected
// row in both themes; one hue means "your match" here and in the editor).
function HighlightedPreview({ entry }: { entry: SearchResultsEventEntry }) {
  const windowed = windowPreviewForRow(entry);
  return (
    <span className="block truncate font-mono text-[12px] leading-5 text-muted">
      {windowed.leadTrimmed ? <span aria-hidden>…</span> : null}
      {windowed.text.slice(0, windowed.matchStart)}
      <mark className="rounded-[2px] bg-match px-px font-semibold text-ink">
        {windowed.text.slice(windowed.matchStart, windowed.matchEnd)}
      </mark>
      {windowed.text.slice(windowed.matchEnd)}
    </span>
  );
}

// One file's result group. Memoized against the streaming re-renders: the
// model clones ONLY touched groups per batch, so untouched groups keep their
// references and skip re-rendering as later batches arrive.
const FileGroup = memo(function FileGroup(props: {
  group: SearchGroup;
  collapsed: boolean;
  // Whether the group renders ALL its entries (vs the bounded preview window
  // — committing hundreds of rows at once is a keystroke-budget long task).
  showAll: boolean;
  // Index of the keyboard-selected entry WITHIN this group, or -1.
  selectedEntryIndex: number;
  onToggle: (path: string) => void;
  onShowAll: (path: string) => void;
  onOpen: (path: string, line: number, column: number, entry: SearchResultsEventEntry) => void;
}) {
  const { group } = props;
  const visible = groupVisibleEntries(group, props.showAll);
  const hidden = group.entries.length - visible.length;
  const chatEntry = group.entries.find((entry) => entry.surface === "chat");
  const groupTitle = chatEntry?.title ?? basenameOf(group.path);
  return (
    <li data-testid="search-result-group" data-path={group.path}>
      <button
        type="button"
        data-testid="search-group-toggle"
        aria-expanded={!props.collapsed}
        onClick={() => props.onToggle(group.path)}
        // h-7 at 13px: the workbench list rhythm (Explorer rows, palette
        // rows) — Search must not read denser than the tree one click away.
        className="flex h-7 w-full items-center gap-1 rounded px-1.5 text-left text-[13px] text-ink hover:bg-line/50"
      >
        {props.collapsed ? (
          <ChevronRight size={12} aria-hidden className="shrink-0 text-subtle" />
        ) : (
          <ChevronDown size={12} aria-hidden className="shrink-0 text-subtle" />
        )}
        {chatEntry ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-line px-1.5 text-[10px] font-semibold uppercase leading-4 text-muted">
            <MessageSquare size={10} aria-hidden />
            Chat
          </span>
        ) : null}
        <span className="truncate font-medium">{groupTitle}</span>
        {!chatEntry && dirnameOf(group.path) ? (
          <span className="truncate text-[11px] text-subtle">{dirnameOf(group.path)}</span>
        ) : null}
        <span
          data-testid="search-group-count"
          className="ml-auto rounded-full bg-line px-1.5 text-[10px] font-semibold leading-4 text-muted"
        >
          {group.entries.length}
        </span>
      </button>
      {props.collapsed ? null : (
        <ul className="m-0 list-none p-0">
          {visible.map((entry, index) => (
            <li key={`${entry.line}:${entry.column}:${index}`}>
              <button
                type="button"
                data-testid="search-result-row"
                data-path={group.path}
                data-line={entry.line}
                data-selected={index === props.selectedEntryIndex || undefined}
                onClick={() => props.onOpen(group.path, entry.line, entry.column, entry)}
                // py-[4px] around the leading-5 preview = a 28px line box,
                // matching the h-7 workbench row pitch.
                className={`block w-full rounded py-[4px] pl-6 pr-2 text-left ${
                  index === props.selectedEntryIndex
                    ? "bg-line"
                    : "hover:bg-panel-2"
                }`}
              >
                <HighlightedPreview entry={entry} />
              </button>
            </li>
          ))}
          {hidden > 0 ? (
            <li>
              <button
                type="button"
                data-testid="search-show-more"
                onClick={() => props.onShowAll(group.path)}
                className="flex h-7 w-full items-center rounded pl-6 pr-2 text-left text-[11px] text-subtle hover:bg-panel-2 hover:text-ink"
              >
                Show {hidden} more match{hidden === 1 ? "" : "es"}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </li>
  );
});

function ToggleButton(props: {
  testId: string;
  label: string;
  pressed: boolean;
  onToggle: () => void;
  Icon: typeof CaseSensitive;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      onClick={props.onToggle}
      // Pressed must survive a glance, not read as a momentary hover: a
      // match-blue tinted fill + 1px match border (VS Code's
      // inputOption.activeBackground/activeBorder idiom) — a toggled-on
      // filter silently changes every search, so its on-state has to pop.
      className={`grid size-5.5 shrink-0 place-items-center rounded ${
        props.pressed
          ? "border border-match bg-match/15 text-ink"
          : "text-subtle hover:bg-line/50 hover:text-ink"
      }`}
    >
      <props.Icon size={13} aria-hidden />
    </button>
  );
}

export function SearchView(props: {
  search: WorkspaceSearchApi;
  onOpenResult: (
    path: string,
    line: number,
    column: number,
    entry?: SearchResultsEventEntry,
  ) => void;
}) {
  const { model } = props.search;
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showAllGroups, setShowAllGroups] = useState<ReadonlySet<string>>(new Set());
  const [groupWindow, setGroupWindow] = useState(GROUP_WINDOW_STEP);
  const [selected, setSelected] = useState(-1);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // Clear any armed debounce on unmount (never fire a search into a gone view).
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // THE one search-issuing seam: explicit values (state set in the same tick
  // hasn't committed yet), debounce cancelled, selection/collapse reset.
  const { run, clear } = props.search;
  function issueNow(options: SearchRunOptions): void {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    setCollapsed(new Set());
    setShowAllGroups(new Set());
    setGroupWindow(GROUP_WINDOW_STEP);
    setSelected(-1);
    if (isBlankSearchQuery(options.query)) {
      clear();
      return;
    }
    run({
      ...options,
      includeGlob: options.includeGlob?.trim() || undefined,
      excludeGlob: options.excludeGlob?.trim() || undefined,
    });
  }

  function currentOptions(overrides?: Partial<SearchRunOptions>): SearchRunOptions {
    return {
      query,
      caseSensitive,
      wholeWord,
      regex,
      includeGlob,
      excludeGlob,
      ...overrides,
    };
  }

  // Debounced search-as-you-type (Enter searches immediately, below).
  function onQueryChange(value: string): void {
    setQuery(value);
    if (isBlankSearchQuery(value)) {
      issueNow(currentOptions({ query: value }));
      return;
    }
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      issueNow(currentOptions({ query: value }));
    }, DEBOUNCE_MS);
  }

  // A toggle/filter flip re-issues immediately (no debounce — it's a click).
  function flipToggle(apply: () => void, overrides: Partial<SearchRunOptions>): void {
    apply();
    if (query.length > 0) issueNow(currentOptions(overrides));
  }

  // Performance measures (post-commit, per search): first rendered batch and
  // completion, bracketing from content-search-start (set at issue time).
  // The marks are freshness epochs the perf spec polls (freshMeasure idiom).
  const firstRecordedFor = useRef<string | null>(null);
  useEffect(() => {
    if (
      model.searchId !== null &&
      model.totalMatches > 0 &&
      firstRecordedFor.current !== model.searchId
    ) {
      firstRecordedFor.current = model.searchId;
      rendererMarks.measureSince("content-search-first-result", "content-search-start");
      rendererMarks.mark("content-search-first-result-rendered");
    }
  }, [model.searchId, model.totalMatches]);
  const completeRecordedFor = useRef<string | null>(null);
  useEffect(() => {
    if (
      model.searchId !== null &&
      model.status === "complete" &&
      completeRecordedFor.current !== model.searchId
    ) {
      completeRecordedFor.current = model.searchId;
      rendererMarks.measureSince("content-search-complete", "content-search-start");
      rendererMarks.mark("content-search-completed");
    }
  }, [model.searchId, model.status]);

  // Only the windowed groups ever render (or join keyboard nav): once the
  // window is full, later streamed batches change nothing but the summary —
  // commits stay small no matter how many thousand files match.
  const windowedGroups = useMemo(
    () => (model.groups.length > groupWindow ? model.groups.slice(0, groupWindow) : model.groups),
    [model.groups, groupWindow],
  );
  const hiddenGroupCount = model.groups.length - windowedGroups.length;
  const flat = useMemo(
    () => visibleFlatEntries(windowedGroups, collapsed, showAllGroups),
    [windowedGroups, collapsed, showAllGroups],
  );
  // The list can shrink under the selection (narrowed search, collapse).
  const selectedIndex = Math.min(selected, flat.length - 1);
  const selectedFlat = selectedIndex >= 0 ? flat[selectedIndex] : null;

  // Keep the keyboard-selected row visible inside the scrolling list.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  function onInputKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(
        moveSearchSelection(selectedIndex, event.key === "ArrowDown" ? 1 : -1, flat.length),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedFlat) {
        props.onOpenResult(
          selectedFlat.path,
          selectedFlat.entry.line,
          selectedFlat.entry.column,
          selectedFlat.entry,
        );
      } else {
        issueNow(currentOptions());
      }
    } else if (event.key === "Escape") {
      setSelected(-1);
    }
  }

  const fileCount = model.groups.length;

  return (
    <div
      data-testid="search-view"
      data-state={model.status}
      data-search-id={model.searchId ?? ""}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex flex-col gap-1.5 border-b border-line px-2 py-2">
        <div className="flex items-center gap-1 rounded border border-line bg-bg px-1.5 py-1 focus-within:border-ink">
          <input
            ref={inputRef}
            type="text"
            data-testid="search-input"
            aria-label="Search workspace"
            placeholder="Search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onInputKeyDown}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
          />
          <ToggleButton
            testId="search-toggle-case"
            label="Match case"
            pressed={caseSensitive}
            onToggle={() =>
              flipToggle(() => setCaseSensitive(!caseSensitive), {
                caseSensitive: !caseSensitive,
              })
            }
            Icon={CaseSensitive}
          />
          <ToggleButton
            testId="search-toggle-word"
            label="Match whole word"
            pressed={wholeWord}
            onToggle={() =>
              flipToggle(() => setWholeWord(!wholeWord), { wholeWord: !wholeWord })
            }
            Icon={WholeWord}
          />
          <ToggleButton
            testId="search-toggle-regex"
            label="Use regular expression"
            pressed={regex}
            onToggle={() => flipToggle(() => setRegex(!regex), { regex: !regex })}
            Icon={Regex}
          />
          <ToggleButton
            testId="search-filter-toggle"
            label="Toggle include/exclude filters"
            pressed={filtersOpen}
            onToggle={() => setFiltersOpen((open) => !open)}
            Icon={SlidersHorizontal}
          />
        </div>
        {filtersOpen ? (
          // Persistent labels (Explorer section-header style): two filled
          // glob boxes are otherwise anonymous — placeholder text vanishes
          // on input, and only row order would say which glob narrows and
          // which excludes. The nested <label> carries the accessible name.
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-0.5">
              <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-subtle">
                Files to include
              </span>
              <input
                type="text"
                data-testid="search-include"
                placeholder="e.g. *.md"
                value={includeGlob}
                onChange={(event) => {
                  const value = event.target.value;
                  setIncludeGlob(value);
                  if (query.length > 0) issueNow(currentOptions({ includeGlob: value }));
                }}
                spellCheck={false}
                className="rounded border border-line bg-bg px-1.5 py-1 text-[12px] text-ink outline-none placeholder:text-subtle focus:border-ink"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-subtle">
                Files to exclude
              </span>
              <input
                type="text"
                data-testid="search-exclude"
                placeholder="e.g. drafts/**"
                value={excludeGlob}
                onChange={(event) => {
                  const value = event.target.value;
                  setExcludeGlob(value);
                  if (query.length > 0) issueNow(currentOptions({ excludeGlob: value }));
                }}
                spellCheck={false}
                className="rounded border border-line bg-bg px-1.5 py-1 text-[12px] text-ink outline-none placeholder:text-subtle focus:border-ink"
              />
            </label>
          </div>
        ) : null}
        {model.status !== "idle" ? (
          <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-subtle">
            {model.status === "searching" ? (
              <span data-testid="search-spinner" className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 animate-pulse rounded-full bg-accent"
                />
                Searching…
              </span>
            ) : (
              <span data-testid="search-summary">
                {model.totalMatches === 0
                  ? "No results"
                  : `${model.totalMatches} result${model.totalMatches === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`}
              </span>
            )}
          </div>
        ) : null}
      </div>

      {model.limitHit ? (
        <div
          data-testid="search-cap-notice"
          className="border-b border-line bg-panel-2 px-3 py-1.5 text-[11px] text-warning"
        >
          Showing the first {RESULT_CAP} matches — narrow your search to see
          everything.
        </div>
      ) : null}

      {model.status === "idle" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <span className="text-xs text-muted">Search this workspace</span>
          <span className="text-[11px] text-subtle">
            Full-text results stream in as you type. Toggle case, whole word,
            regex, and file filters above.
          </span>
        </div>
      ) : model.status === "complete" && model.totalMatches === 0 ? (
        <div
          data-testid="search-empty-state"
          className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center"
        >
          <SearchX size={18} aria-hidden className="text-subtle" />
          <span className="text-xs text-muted">No results found</span>
          <span className="text-[11px] text-subtle">
            Check the spelling, loosen a filter, or try a regex.
          </span>
        </div>
      ) : (
        <ul
          ref={listRef}
          data-testid="search-results"
          className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1"
        >
          {windowedGroups.map((group, groupIndex) => (
            <FileGroup
              key={group.path}
              group={group}
              collapsed={collapsed.has(group.path)}
              showAll={showAllGroups.has(group.path)}
              selectedEntryIndex={
                selectedFlat?.groupIndex === groupIndex ? selectedFlat.entryIndex : -1
              }
              onToggle={(path) =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
              onShowAll={(path) =>
                setShowAllGroups((current) => new Set(current).add(path))
              }
              onOpen={props.onOpenResult}
            />
          ))}
          {hiddenGroupCount > 0 ? (
            <li>
              <button
                type="button"
                data-testid="search-show-more-files"
                onClick={() => setGroupWindow((current) => current + GROUP_WINDOW_STEP)}
                className="flex h-7 w-full items-center rounded px-1.5 text-left text-[11px] text-subtle hover:bg-panel-2 hover:text-ink"
              >
                Show {hiddenGroupCount} more file{hiddenGroupCount === 1 ? "" : "s"}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
