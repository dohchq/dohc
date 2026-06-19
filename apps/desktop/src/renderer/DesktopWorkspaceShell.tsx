import {
  Bot,
  Cloud,
  ExternalLink,
  FileText,
  History,
  Maximize2,
  PanelRight,
  RefreshCw,
  Search,
  User,
  X,
} from "lucide-react";
import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ChangeSetDetailRecord,
  ChangeSetFileRecord,
  ChangeSetRecord,
  FileChangeSnapshot,
  SyncStatusResult,
  WorkbenchMenuCommand,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import { CommandPalette, type Command } from "./CommandPalette";
import {
  FileInspector,
  preloadMarkdownEditor,
  type ScrollTarget,
} from "./FileInspector";
import type { WikilinkFile } from "./editor/wikilinkPlugin";
import { NewFileDialog } from "./NewFileDialog";
import { Overlay } from "./Overlay";
import { DesktopSettings } from "./settings/DesktopSettings";
import { Titlebar, workspaceName } from "./Titlebar";
import { toggleTheme } from "./theme";
import { ActivityBar, activityViewLabel } from "./workbench/ActivityBar";
import { EditorTabs } from "./workbench/EditorTabs";
import { Explorer } from "./workbench/Explorer";
import { projectTreePath, type PendingTreeChange } from "./workbench/file-tree-optimistic";
import { rankQuickOpenPaths } from "./workbench/quick-open-rank";
import { SidePanel } from "./workbench/SidePanel";
import { StatusBar } from "./workbench/StatusBar";
import { useWorkspaceSearch } from "./workbench/useWorkspaceSearch";
import {
  activateTab,
  closeTab,
  clampHistoryWidth,
  defaultWorkbenchState,
  GRAPH_TAB_PATH,
  HISTORY_TAB_PATH,
  historyDiffTabPath,
  isGraphTabPath,
  isHistoryDiffTabPath,
  isHistoryTabPath,
  isVirtualTabPath,
  moveTab,
  openTab,
  parseHistoryDiffTabPath,
  parseUiState,
  recordRecentFile,
  remapWorkbenchPaths,
  serializeUiState,
  setFolderExpanded,
  setHistoryWidth,
  setSidebarWidth,
  setView,
  toggleFolderExpanded,
  toggleHistory,
  togglePinned,
  toggleSidebar,
  VIEW_IDS,
  type WorkbenchState,
} from "./workbench/workbenchState";

export type Workspace = WorkspaceSummary;

const LazyShareDialog = lazy(() =>
  import("./ShareDialog").then((mod) => ({ default: mod.ShareDialog })),
);
const LazyImportExportDialog = lazy(() =>
  import("./ImportExportDialog").then((mod) => ({
    default: mod.ImportExportDialog,
  })),
);
const LazyWorkspaceManagementDialog = lazy(() =>
  import("./WorkspaceManagementDialog").then((mod) => ({
    default: mod.WorkspaceManagementDialog,
  })),
);

const MARKDOWN_PRELOAD_IDLE_DELAY_MS = 150;

function scheduleMarkdownEditorPreload(): () => void {
  let idleHandle: number | null = null;
  let fired = false;
  const timerHandle = globalThis.setTimeout(() => {
    fired = true;
    if (typeof globalThis.requestIdleCallback === "function") {
      idleHandle = globalThis.requestIdleCallback(preloadMarkdownEditor, {
        timeout: 1_000,
      });
      return;
    }
    preloadMarkdownEditor();
  }, MARKDOWN_PRELOAD_IDLE_DELAY_MS);

  return () => {
    if (!fired) globalThis.clearTimeout(timerHandle);
    if (
      idleHandle !== null &&
      typeof globalThis.cancelIdleCallback === "function"
    ) {
      globalThis.cancelIdleCallback(idleHandle);
    }
  };
}
const LazySearchView = lazy(() =>
  import("./workbench/SearchView").then((mod) => ({ default: mod.SearchView })),
);
const LazyGraphView = lazy(() =>
  import("./workbench/GraphView").then((mod) => ({ default: mod.GraphView })),
);
const LazyAppsView = lazy(() =>
  import("./workbench/AppsView").then((mod) => ({ default: mod.AppsView })),
);
const LazyAgentPanelView = lazy(() =>
  import("./AgentPanelView").then((mod) => ({ default: mod.AgentPanelView })),
);

// Every folder above a path — expanded when a create/open must REVEAL it.
function ancestorDirs(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
}

function uniqueUntitledTextPath(
  files: WorkspaceFileEntry[],
  folders: string[],
): string {
  const occupied = new Set([...files.map((file) => file.path), ...folders]);
  if (!occupied.has("Untitled.txt")) return "Untitled.txt";
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `Untitled ${index}.txt`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `Untitled ${Date.now()}.txt`;
}

type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

type UnifiedDiffLine = {
  kind: DiffLine["kind"] | "note";
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
};

type HistoryAuthorFilter = "all" | "user" | "agent";

const HISTORY_LCS_DIFF_CELL_LIMIT = 250_000;

function splitDiffLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length === 0) return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildContiguousDiff(before: string[], after: string[]): DiffLine[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix + prefix < before.length &&
    suffix + prefix < after.length &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const out: DiffLine[] = [];
  const contextBefore = before.slice(Math.max(0, prefix - 2), prefix);
  for (const line of contextBefore) out.push({ kind: "context", text: line });

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  for (const line of removed) out.push({ kind: "removed", text: line });
  for (const line of added) out.push({ kind: "added", text: line });

  const contextAfter = after.slice(after.length - suffix, after.length - suffix + 2);
  for (const line of contextAfter) out.push({ kind: "context", text: line });
  return out;
}

function buildLineDiff(before: string[], after: string[]): DiffLine[] {
  if (before.length === 0) {
    return after.map((text) => ({ kind: "added", text }));
  }
  if (after.length === 0) {
    return before.map((text) => ({ kind: "removed", text }));
  }

  const cellCount = (before.length + 1) * (after.length + 1);
  if (cellCount > HISTORY_LCS_DIFF_CELL_LIMIT) {
    return buildContiguousDiff(before, after);
  }

  const columnCount = after.length + 1;
  const table = new Uint32Array(cellCount);
  const at = (beforeIndex: number, afterIndex: number) =>
    beforeIndex * columnCount + afterIndex;

  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      if (before[beforeIndex] === after[afterIndex]) {
        table[at(beforeIndex, afterIndex)] =
          table[at(beforeIndex + 1, afterIndex + 1)] + 1;
      } else {
        table[at(beforeIndex, afterIndex)] = Math.max(
          table[at(beforeIndex + 1, afterIndex)],
          table[at(beforeIndex, afterIndex + 1)],
        );
      }
    }
  }

  const out: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      out.push({ kind: "context", text: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      table[at(beforeIndex + 1, afterIndex)] >=
      table[at(beforeIndex, afterIndex + 1)]
    ) {
      out.push({ kind: "removed", text: before[beforeIndex] });
      beforeIndex += 1;
    } else {
      out.push({ kind: "added", text: after[afterIndex] });
      afterIndex += 1;
    }
  }

  while (beforeIndex < before.length) {
    out.push({ kind: "removed", text: before[beforeIndex] });
    beforeIndex += 1;
  }
  while (afterIndex < after.length) {
    out.push({ kind: "added", text: after[afterIndex] });
    afterIndex += 1;
  }
  return out;
}

function compactUnifiedDiffLines(
  lines: UnifiedDiffLine[],
  contextRadius = 2,
  limit = 80,
): UnifiedDiffLine[] {
  const changedIndexes = lines.flatMap((line, index) =>
    line.kind === "added" || line.kind === "removed" ? [index] : [],
  );
  if (changedIndexes.length === 0) {
    return [
      {
        kind: "note",
        text: "No text changes",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ];
  }

  const keep = new Set<number>();
  for (const changedIndex of changedIndexes) {
    for (
      let index = Math.max(0, changedIndex - contextRadius);
      index <= Math.min(lines.length - 1, changedIndex + contextRadius);
      index += 1
    ) {
      keep.add(index);
    }
  }

  const out: UnifiedDiffLine[] = [];
  let hiddenCount = 0;
  const flushHidden = () => {
    if (hiddenCount === 0) return;
    out.push({
      kind: "note",
      text: `${hiddenCount} unchanged line${hiddenCount === 1 ? "" : "s"} hidden`,
      oldLineNumber: null,
      newLineNumber: null,
    });
    hiddenCount = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.kind === "context" && !keep.has(index)) {
      hiddenCount += 1;
      continue;
    }
    flushHidden();
    out.push(line);
  }
  flushHidden();

  if (out.length <= limit) return out;
  return [
    ...out.slice(0, limit),
    {
      kind: "note",
      text: `${out.length - limit} more diff line${
        out.length - limit === 1 ? "" : "s"
      } hidden`,
      oldLineNumber: null,
      newLineNumber: null,
    },
  ];
}

function buildUnifiedDiffLines(
  beforeText: string | undefined,
  afterText: string | undefined,
  limit = 600,
): UnifiedDiffLine[] {
  const before = splitDiffLines(beforeText ?? "");
  const after = splitDiffLines(afterText ?? "");
  if (beforeText === afterText) {
    return [
      {
        kind: "note",
        text: "No text changes",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ];
  }

  let oldLineNumber = 1;
  let newLineNumber = 1;
  const numbered = buildLineDiff(before, after).map<UnifiedDiffLine>((line) => {
    if (line.kind === "added") {
      const out = {
        ...line,
        oldLineNumber: null,
        newLineNumber,
      };
      newLineNumber += 1;
      return out;
    }
    if (line.kind === "removed") {
      const out = {
        ...line,
        oldLineNumber,
        newLineNumber: null,
      };
      oldLineNumber += 1;
      return out;
    }
    const out = {
      ...line,
      oldLineNumber,
      newLineNumber,
    };
    oldLineNumber += 1;
    newLineNumber += 1;
    return out;
  });
  return compactUnifiedDiffLines(numbered, 3, limit);
}

function changedLineCounts(
  beforeText: string | undefined,
  afterText: string | undefined,
): { added: number; removed: number } | null {
  if (beforeText === undefined && afterText === undefined) return null;
  const before = splitDiffLines(beforeText ?? "");
  const after = splitDiffLines(afterText ?? "");
  if (beforeText === afterText) return { added: 0, removed: 0 };
  return buildLineDiff(before, after).reduce(
    (counts, line) => {
      if (line.kind === "added") counts.added += 1;
      if (line.kind === "removed") counts.removed += 1;
      return counts;
    },
    { added: 0, removed: 0 },
  );
}

function fileOperationLabel(
  file: Pick<ChangeSetFileRecord, "operation"> &
    Partial<Pick<ChangeSetFileRecord, "before" | "after">>,
): string {
  if (file.operation === "delete") return "Deleted";
  if (file.operation === "rename") return "Renamed";
  if (!file.before && file.after) return "Created";
  return "Changed";
}

function historyLineStatsText(stats: ChangeSetRecord["lineStats"]): string | null {
  if (!stats) return null;
  const parts: string[] = [];
  if (stats.added > 0 || stats.removed > 0 || stats.changedFileCount > 0) {
    parts.push(`+${stats.added} -${stats.removed}`);
  }
  if (stats.unavailableFileCount > 0) {
    parts.push(`${stats.unavailableFileCount} not diffed`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function snapshotUnavailable(snapshot: FileChangeSnapshot | null | undefined): string | null {
  const reason = snapshot?.unavailableReason;
  if (!reason) return null;
  if (reason === "binary") return "Binary or structured file";
  if (reason === "too-large") return "Text snapshot is too large for inline history";
  if (reason === "missing") return "File was missing";
  return "Snapshot unavailable";
}

function historyAuthorLabel(author: ChangeSetRecord["author"]): string {
  if (author.kind === "agent") return `${author.agentId} for ${author.onBehalfOf}`;
  return author.userId;
}

function historyKindLabel(kind: ChangeSetRecord["kind"]): string {
  if (kind === "agent-run") return "Agent run";
  if (kind === "app-build") return "App build";
  if (kind === "user-edit") return "User edit";
  return kind[0].toUpperCase() + kind.slice(1);
}

function historyBoundaryLabel(
  boundary: NonNullable<ChangeSetRecord["boundaryCrossingPreview"]>[number],
): string {
  if (boundary === "public-share") return "Public share";
  if (boundary === "external-export") return "External export";
  if (boundary === "permission-change") return "Permission change";
  if (boundary === "bulk-delete") return "Bulk delete";
  if (boundary === "app-trust") return "App trust";
  if (boundary === "private-to-shared") return "Private to shared";
  if (boundary === "unmergeable-overwrite") return "Overwrite conflict";
  return boundary;
}

function historyBoundaryLabels(
  boundaries: ChangeSetRecord["boundaryCrossingPreview"] | undefined,
): string[] {
  return boundaries?.map(historyBoundaryLabel) ?? [];
}

function historySearchText(change: ChangeSetRecord): string {
  return [
    change.humanSummary,
    change.summary,
    historyAuthorLabel(change.author),
    historyKindLabel(change.kind),
    ...(change.filePreview?.map((file) => file.path) ?? []),
    ...historyBoundaryLabels(change.boundaryCrossingPreview),
    change.reviewRequired ? "needs review review required boundary" : "",
  ]
    .join("\n")
    .toLowerCase();
}

function formatHistoryRecordedAt(recordedAtMs: number): {
  label: string;
  iso: string;
} {
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

function historyDayKey(recordedAtMs: number): string {
  const recordedAt = new Date(recordedAtMs);
  const month = String(recordedAt.getMonth() + 1).padStart(2, "0");
  const day = String(recordedAt.getDate()).padStart(2, "0");
  return `${recordedAt.getFullYear()}-${month}-${day}`;
}

function formatHistoryDay(recordedAtMs: number): {
  label: string;
  dateTime: string;
} {
  const recordedAt = new Date(recordedAtMs);
  return {
    label: recordedAt.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    dateTime: historyDayKey(recordedAtMs),
  };
}

function HistoryLineStats({
  stats,
}: {
  stats: NonNullable<ChangeSetRecord["lineStats"]>;
}) {
  const hasKnownLines =
    stats.added > 0 || stats.removed > 0 || stats.changedFileCount > 0;
  return (
    <span data-testid="history-line-stats" className="font-mono">
      {hasKnownLines ? (
        <>
          <span data-testid="history-line-stats-added" className="text-success">
            +{stats.added}
          </span>
          {" "}
          <span data-testid="history-line-stats-removed" className="text-danger">
            -{stats.removed}
          </span>
        </>
      ) : null}
      {stats.unavailableFileCount > 0 ? (
        <>
          {hasKnownLines ? <span className="text-subtle"> · </span> : null}
          <span className="text-subtle">
            {stats.unavailableFileCount} not diffed
          </span>
        </>
      ) : null}
    </span>
  );
}

function HistoryDiffPage({
  workspaceId,
  tabPath,
  onOpenFile,
}: {
  workspaceId: string;
  tabPath: string;
  onOpenFile: (path: string) => void;
}) {
  const parsed = useMemo(() => parseHistoryDiffTabPath(tabPath), [tabPath]);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; changeSet: ChangeSetDetailRecord | null }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!parsed) {
      setState({ status: "error" });
      return;
    }
    setState({ status: "loading" });
    void bridge()
      .readChangeSet({ workspaceId, changeSetId: parsed.changeSetId })
      .then((result) => {
        if (!cancelled) {
          setState({ status: "ready", changeSet: result.changeSet });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [parsed, workspaceId]);

  if (!parsed || state.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-danger">
        Could not load this history diff.
      </div>
    );
  }
  if (state.status === "loading") {
    return <PanelLoading label="history diff" />;
  }
  const file =
    state.changeSet?.files.find((entry) => entry.path === parsed.filePath) ?? null;
  if (!state.changeSet || !file) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-subtle">
        This changed file is no longer in the history record.
      </div>
    );
  }

  const before = file.before?.text;
  const after = file.after?.text;
  const counts = changedLineCounts(before, after);
  const unavailable =
    before === undefined && after === undefined
      ? snapshotUnavailable(file.before) ?? snapshotUnavailable(file.after)
      : null;
  const diffLines: UnifiedDiffLine[] = unavailable
    ? [
        {
          kind: "note",
          text: unavailable,
          oldLineNumber: null,
          newLineNumber: null,
        },
      ]
    : buildUnifiedDiffLines(before, after, 800);

  return (
    <section
      data-testid="history-diff-page"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-line bg-panel px-4 py-3">
        <div className="min-w-0 flex-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
            History diff
          </span>
          <h2
            id="history-diff-title"
            className="mb-0 mt-0.5 truncate text-[15px] font-semibold text-ink"
          >
            {file.path}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span>{fileOperationLabel(file)}</span>
            {counts ? (
              <span className="font-mono" data-testid="history-diff-counts">
                +{counts.added} -{counts.removed}
              </span>
            ) : null}
            {file.mediaType ? <span>{file.mediaType}</span> : null}
          </div>
          <p className="mb-0 mt-1 truncate text-[11px] text-subtle">
            {state.changeSet.humanSummary}
          </p>
        </div>
        {file.operation !== "delete" ? (
          <button
            type="button"
            data-testid="history-diff-open-file"
            onClick={() => onOpenFile(file.path)}
            className="flex h-7 shrink-0 items-center gap-1 rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink"
          >
            <ExternalLink size={12} aria-hidden />
            Open file
          </button>
        ) : null}
      </header>
      <div className="min-h-0 overflow-auto overflow-x-hidden p-4">
        <section className="overflow-hidden rounded border border-line bg-bg shadow-sm">
          <div className="flex min-h-9 items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
            <FileText size={13} aria-hidden className="shrink-0 text-subtle" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
              {file.path}
            </span>
            {counts ? (
              <span className="shrink-0 font-mono text-[11px] text-subtle">
                +{counts.added} -{counts.removed}
              </span>
            ) : null}
          </div>
          <div
            data-testid="history-diff-lines"
            className="overflow-x-hidden py-1 font-mono text-[12px] leading-5"
          >
            {diffLines.map((line, index) => (
              line.kind === "note" ? (
                <div
                  key={`${index}:${line.text}`}
                  data-kind={line.kind}
                  className="border-y border-line/70 bg-panel px-3 py-1.5 text-center text-[11px] text-subtle"
                >
                  {line.text}
                </div>
              ) : (
                <div
                  key={`${index}:${line.kind}:${line.text}`}
                  data-kind={line.kind}
                  className={`grid min-w-0 grid-cols-[44px_44px_24px_minmax(0,1fr)] ${
                    line.kind === "added"
                      ? "bg-success/10 text-success"
                      : line.kind === "removed"
                        ? "bg-danger/10 text-danger"
                        : "text-muted"
                  }`}
                >
                  <span
                    aria-hidden
                    className="select-none border-r border-line/60 px-2 text-right text-[11px] text-subtle"
                  >
                    {line.oldLineNumber ?? ""}
                  </span>
                  <span
                    aria-hidden
                    className="select-none border-r border-line/60 px-2 text-right text-[11px] text-subtle"
                  >
                    {line.newLineNumber ?? ""}
                  </span>
                  <span aria-hidden className="select-none text-center">
                    {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : ""}
                  </span>
                  <code className="min-w-0 whitespace-pre-wrap break-words pr-3 font-inherit text-inherit">
                    {line.text.length > 0 ? line.text : " "}
                  </code>
                </div>
              )
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

// The timeline body, shared by the right history rail and the side panel's
// History view (both render the same root-owned changeSets — never a second
// subscription). The pinned history-timeline testid stays on the RAIL only.
function HistoryList({
  changeSets,
  onOpenDiff,
  emptyLabel = "No changes yet",
  emptyDescription = "Edits — yours or your agent's — show up here as a timeline you can review.",
}: {
  changeSets: ChangeSetRecord[];
  onOpenDiff: (changeSetId: string, filePath: string) => void;
  emptyLabel?: string;
  emptyDescription?: string;
}) {
  if (changeSets.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
        <span className="text-xs text-muted">{emptyLabel}</span>
        <span className="text-[11px] text-subtle">{emptyDescription}</span>
      </div>
    );
  }
  return (
    <>
      <ul
        data-testid="history-list"
        className="m-0 min-h-0 flex-1 list-none overflow-y-auto overflow-x-hidden p-0"
      >
        {changeSets.map((change, index) => {
          const recordedAt = formatHistoryRecordedAt(change.recordedAtMs);
          const day = formatHistoryDay(change.recordedAtMs);
          const lineStatsLabel = historyLineStatsText(change.lineStats);
          const boundaryLabels = historyBoundaryLabels(change.boundaryCrossingPreview);
          const primaryFile = change.filePreview?.[0] ?? null;
          const previousDayKey =
            index > 0 ? historyDayKey(changeSets[index - 1].recordedAtMs) : null;
          const showDayHeading = previousDayKey !== day.dateTime;
          const itemContent = (
            <span className="flex min-w-0 items-start gap-2">
              {change.author.kind === "agent" ? (
                <Bot size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
              ) : (
                <User size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                    {change.humanSummary}
                  </span>
                  {change.reviewRequired ? (
                    <span
                      data-testid="history-review-badge"
                      className="shrink-0 rounded border border-danger/30 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                      title={
                        boundaryLabels.length > 0
                          ? boundaryLabels.join(", ")
                          : `${change.boundaryCrossingCount ?? 1} review boundary${
                              (change.boundaryCrossingCount ?? 1) === 1
                                ? ""
                                : "ies"
                            }`
                      }
                    >
                      Needs review
                    </span>
                  ) : null}
                </span>
                <span className="block text-[10px] text-subtle">
                  {historyAuthorLabel(change.author)}
                  {" · "}
                  <time
                    data-testid="history-recorded-at"
                    dateTime={recordedAt.iso}
                    title={recordedAt.iso}
                  >
                    {recordedAt.label}
                  </time>
                  {" · "}
                  {change.fileCount} file{change.fileCount === 1 ? "" : "s"}
                  {lineStatsLabel && change.lineStats ? (
                    <>
                      {" · "}
                      <HistoryLineStats stats={change.lineStats} />
                    </>
                  ) : null}
                </span>
              </span>
            </span>
          );
          return (
            <Fragment key={change.id}>
              {showDayHeading ? (
                <li className="sticky top-0 z-[1] border-b border-line bg-panel-2 px-3 py-1">
                  <time
                    data-testid="history-day-heading"
                    dateTime={day.dateTime}
                    className="text-[10px] font-semibold uppercase tracking-wide text-subtle"
                  >
                    {day.label}
                  </time>
                </li>
              ) : null}
              <li
                data-testid="change-set"
                className="border-b border-line"
              >
                {primaryFile ? (
                  <button
                    type="button"
                    data-testid="history-change-open"
                    title={`Open diff for ${primaryFile.path}`}
                    aria-label={`Open diff for ${primaryFile.path}`}
                    onClick={() => onOpenDiff(change.id, primaryFile.path)}
                    className="block w-full px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    {itemContent}
                  </button>
                ) : (
                  <div className="px-3 py-2">{itemContent}</div>
                )}
              </li>
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}

function HistoryView(props: {
  changeSets: ChangeSetRecord[];
  onOpenDiff: (changeSetId: string, filePath: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [authorFilter, setAuthorFilter] = useState<HistoryAuthorFilter>("all");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredChangeSets = useMemo(
    () =>
      props.changeSets.filter((change) => {
        if (reviewOnly && !change.reviewRequired) return false;
        if (authorFilter !== "all" && change.author.kind !== authorFilter) {
          return false;
        }
        if (!normalizedQuery) return true;
        return historySearchText(change).includes(normalizedQuery);
      }),
    [authorFilter, normalizedQuery, props.changeSets, reviewOnly],
  );
  const filterActive =
    normalizedQuery.length > 0 || reviewOnly || authorFilter !== "all";
  return (
    <>
      {props.changeSets.length > 0 ? (
        <>
          <div
            data-testid="history-filter-bar"
            className="shrink-0 border-b border-line bg-panel-2 px-2 py-2"
          >
            <label className="flex h-7 min-w-0 items-center gap-1.5 rounded border border-line bg-bg px-2 text-[11px] text-muted">
              <Search size={12} aria-hidden className="shrink-0 text-subtle" />
              <input
                type="search"
                data-testid="history-search-input"
                aria-label="Search history"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search history"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-subtle"
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  data-testid="history-search-clear"
                  aria-label="Clear history search"
                  title="Clear history search"
                  onClick={() => setQuery("")}
                  className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <X size={12} aria-hidden />
                </button>
              ) : null}
            </label>
            <div
              data-testid="history-author-filter"
              className="mt-1.5 grid grid-cols-3 rounded border border-line bg-bg p-0.5"
            >
              {(
                [
                  ["all", "All"],
                  ["user", "People"],
                  ["agent", "Agents"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`history-author-filter-${value}`}
                  aria-pressed={authorFilter === value}
                  onClick={() => setAuthorFilter(value)}
                  className={`h-6 rounded text-[10px] ${
                    authorFilter === value
                      ? "bg-ink text-bg"
                      : "text-muted hover:bg-line/50 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
              <button
                type="button"
                data-testid="history-review-filter"
                aria-pressed={reviewOnly}
                onClick={() => setReviewOnly((current) => !current)}
                className={`h-6 rounded border px-2 text-[11px] ${
                  reviewOnly
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : "border-line text-muted hover:bg-line/50 hover:text-ink"
                }`}
              >
                Needs review
              </button>
              <span
                data-testid="history-filter-count"
                className="shrink-0 text-[10px] text-subtle"
              >
                {filteredChangeSets.length}/{props.changeSets.length}
              </span>
            </div>
          </div>
        </>
      ) : null}
      <HistoryList
        changeSets={filteredChangeSets}
        onOpenDiff={props.onOpenDiff}
        emptyLabel={filterActive ? "No matching changes" : undefined}
        emptyDescription={
          filterActive
            ? "Adjust the search or review filter to see more history."
            : undefined
        }
      />
    </>
  );
}

function HistoryRail(props: {
  width: number;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  children: ReactNode;
}) {
  const railRef = useRef<HTMLElement>(null);
  const dragRight = useRef<number | null>(null);

  return (
    <aside
      ref={railRef}
      data-testid="history-timeline"
      aria-label="History"
      className="relative flex shrink-0 flex-col border-l border-line bg-panel-2"
      style={{ width: props.width }}
    >
      <div
        data-testid="history-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize history"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragRight.current =
            railRef.current?.getBoundingClientRect().right ?? window.innerWidth;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragRight.current === null) return;
          if ((event.buttons & 1) === 0) {
            dragRight.current = null;
            return;
          }
          props.onWidthChange(clampHistoryWidth(dragRight.current - event.clientX));
        }}
        onPointerUp={() => {
          dragRight.current = null;
        }}
        onPointerCancel={() => {
          dragRight.current = null;
        }}
        onLostPointerCapture={() => {
          dragRight.current = null;
        }}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80"
      />
      {/* Same header grammar + h-9 band as the side panel: the two
          peer chrome surfaces speak one language and their hairlines
          meet the tab strip's on the same pixel row. */}
      <header className="flex h-9 shrink-0 items-center border-b border-line px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          History
        </span>
        <button
          type="button"
          data-testid="history-collapse"
          aria-label="Collapse history"
          title="Collapse history"
          onClick={props.onCollapse}
          className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <PanelRight size={13} aria-hidden />
        </button>
      </header>
      {props.children}
    </aside>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
      Loading {label}...
    </div>
  );
}

function readSelectedText(): string {
  const active = document.activeElement;
  if (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && active.type === "text")
  ) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    return start === end ? "" : active.value.slice(start, end);
  }
  return window.getSelection()?.toString() ?? "";
}

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspace: Workspace) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [changeSets, setChangeSets] = useState<ChangeSetRecord[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResult | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const [agentPanelRefreshKey, setAgentPanelRefreshKey] = useState(0);
  const [appsRefreshKey, setAppsRefreshKey] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [importExportPath, setImportExportPath] = useState<string | null>(null);
  const [importExportSelectionText, setImportExportSelectionText] = useState("");
  const [workspaceManagementOpen, setWorkspaceManagementOpen] = useState(false);
  // Inline-create requests routed INTO the explorer (palette/menu/header).
  const [createRequest, setCreateRequest] = useState<{
    kind: "file" | "folder";
    id: number;
  } | null>(null);
  const [wb, setWb] = useState<WorkbenchState>(defaultWorkbenchState);

  // Runtime-only dirty flag for the ACTIVE tab (the one mounted inspector
  // reports its markdown save state) — never persisted.
  const [activeTabDirty, setActiveTabDirty] = useState(false);
  const onSaveStateChange = useCallback(
    (state: "saved" | "saving" | "error") => setActiveTabDirty(state !== "saved"),
    [],
  );
  useEffect(() => {
    setActiveTabDirty(false);
  }, [wb.activeTab]);
  const onSettingsAgentActiveChange = useCallback((active: boolean) => {
    setAgentActive(active);
    setAgentPanelRefreshKey((key) => key + 1);
  }, []);

  // Imperative flush for the active editor's unsaved draft (registered by
  // the mounted MarkdownView). Explorer ops await it BEFORE their disk ops:
  // a rename of the open file otherwise remounts the keyed inspector after
  // the path moved, and its unmount flush writes to the renamed-away OLD
  // path — ENOENT, swallowed, keystrokes inside the autosave window lost.
  const draftFlushRef = useRef<(() => Promise<void>) | null>(null);
  const registerDraftFlush = useCallback(
    (flush: (() => Promise<void>) | null) => {
      draftFlushRef.current = flush;
    },
    [],
  );
  const flushActiveDraft = useCallback(async () => {
    await draftFlushRef.current?.();
  }, []);

  const workspaceId = props.workspace.workspaceId;
  useEffect(() => {
    return scheduleMarkdownEditorPreload();
  }, [workspaceId]);
  const markdownWikilinkFiles = useMemo<WikilinkFile[]>(
    () =>
      files
        .filter((file) => file.kind === "file" && /\.(md|markdown)$/i.test(file.path))
        .map((file) => {
          const pathNoExt = file.path.replace(/\.(md|markdown)$/i, "");
          return {
            path: file.path,
            title: pathNoExt.split("/").pop() ?? file.path,
            fileId: null,
          };
        }),
    [files],
  );
  const conflictSummaries = useMemo(
    () =>
      files
        .filter((file) => file.kind === "file" && file.path.endsWith(".conflict"))
        .slice(0, 5)
        .map((file) =>
          `${file.path.replace(/\.conflict$/, "")} has a sync conflict (${file.path})`,
        ),
    [files],
  );

  // Content search (Phase E5.0). The model lives HERE, not in the Search
  // view, so results — and the activity-bar count badge — survive switching
  // views while the panel unmounts.
  const search = useWorkspaceSearch(workspaceId);
  const graphRefreshKey = useMemo(
    () =>
      [
        changeSets[0]?.id ?? "none",
        String(changeSets.length),
        String(files.length),
        files.map((file) => file.path).join("\0"),
      ].join("\0"),
    [changeSets, files],
  );
  const activeDocumentPath = isVirtualTabPath(wb.activeTab) ? null : wb.activeTab;

  // A clicked search result: open the file AND land at the line. The target
  // is consumed (cleared) by the inspector once a mounted view applied it.
  const [searchScrollTarget, setSearchScrollTarget] = useState<ScrollTarget | null>(
    null,
  );
  const scrollNonce = useRef(0);
  const consumeScrollTarget = useCallback(() => setSearchScrollTarget(null), []);

  // Restore per-workspace workbench state from .dohc/ui-state.json. Defaults
  // render immediately (launch budgets key off shell visibility); the stored
  // state MERGES when the IPC resolves: it applies only if the user touched
  // NOTHING in the meantime — a pre-load user action wins (and gets an
  // immediate write, since wb may never change again to arm the debounced
  // one). The touched flag is a ref set SYNCHRONOUSLY inside every workbench
  // mutation (mutateWb below): comparing committed state against defaults
  // would race React's commit — a queued-but-uncommitted user action would
  // read as "untouched" and the stored state would clobber it. Writes stay
  // off until the load settles so a default-state write can never clobber
  // the stored one.
  const uiStateLoaded = useRef(false);
  const userTouchedWb = useRef(false);
  const wbRef = useRef(wb);

  // THE one mutation seam for workbench state: every user-driven transition
  // routes through here so the touched flag is set before React even queues
  // the update. Loading stored state is the only setWb that bypasses this.
  const mutateWb = useCallback(
    (updater: (state: WorkbenchState) => WorkbenchState) => {
      userTouchedWb.current = true;
      setWb(updater);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void bridge()
      .getWorkspaceUiState({ workspaceId })
      .then((stored) => {
        if (cancelled) return;
        if (stored && !userTouchedWb.current) {
          const parsed = parseUiState(stored);
          // Order matters: wbRef first, THEN setWb, THEN enable flushes — a
          // beforeunload between "loaded" and the restored state's commit
          // must flush the restored state, never the stale default.
          wbRef.current = parsed;
          setWb(parsed);
        }
        uiStateLoaded.current = true;
        if (userTouchedWb.current) {
          void bridge()
            .setWorkspaceUiState({ workspaceId, state: serializeUiState(wbRef.current) })
            .catch(() => undefined);
        }
      })
      .catch(() => {
        uiStateLoaded.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Debounced persist (500ms): tabs, view, panel visibility/width, rail.
  useEffect(() => {
    wbRef.current = wb;
    if (!uiStateLoaded.current) return;
    const timer = setTimeout(() => {
      void bridge()
        .setWorkspaceUiState({ workspaceId, state: serializeUiState(wb) })
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [wb, workspaceId]);

  // Durability at the edges: the debounce above silently drops changes made
  // within 500ms of quitting or switching workspaces — flush the latest state
  // fire-and-forget on beforeunload and on unmount (workspace switch remounts
  // the shell via key={workspaceId}). Gated on the load having resolved so a
  // default snapshot can never clobber stored state.
  useEffect(() => {
    const flush = () => {
      if (!uiStateLoaded.current) return;
      void bridge()
        .setWorkspaceUiState({ workspaceId, state: serializeUiState(wbRef.current) })
        .catch(() => undefined);
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [workspaceId]);

  const refreshFiles = useCallback(async () => {
    const result = await bridge().listWorkspaceFiles({ workspaceId });
    setFiles(result.files);
    setFolders(result.folders ?? []);
  }, [workspaceId]);

  const refreshApps = useCallback(() => {
    setAppsRefreshKey((key) => key + 1);
    void refreshFiles();
  }, [refreshFiles]);

  const refreshHistory = useCallback(async () => {
    const [history, status, agent] = await Promise.all([
      bridge().listChangeSets({ workspaceId }),
      bridge().getSyncStatus({ workspaceId }),
      bridge().getAgentRunStatus({ workspaceId }),
    ]);
    setChangeSets(history.changeSets);
    setSyncStatus(status);
    setAgentActive(agent.activeRun !== null);
  }, [workspaceId]);

  // One import seam for the dialog flow AND the OS drag-in flow (the latter
  // passes the preload-resolved absolute paths; see the trust-delta note on
  // ImportWorkspaceFilesPayload).
  const importFiles = useCallback(
    async (droppedPaths?: string[]) => {
      await bridge().importWorkspaceFiles({
        workspaceId,
        ...(droppedPaths ? { droppedPaths } : {}),
      });
      await refreshFiles();
    },
    [workspaceId, refreshFiles],
  );

  // THE one way a file opens (tree click, quick-open, tab activation): marks
  // file-open-start — file views measure open latency from here — then opens
  // or re-activates the tab. The inspector mounts keyed by the active tab, so
  // every activation is a fresh read + measure. Mark ONLY when the open
  // actually changes something (activeTab moves or a tab is added): a no-op
  // click on the already-active row/tab/overflow item triggers no remount, so
  // marking would leave a stale file-open-start that corrupts the NEXT
  // measure. The transition is computed from wbRef (synced post-commit) and
  // the mark fires once, OUTSIDE the functional updater — updaters must stay
  // side-effect-free (StrictMode/concurrent replays would re-fire them).
  const openFile = useCallback(
    (path: string) => {
      if (/\.(md|markdown)$/i.test(path)) preloadMarkdownEditor();
      if (openTab(wbRef.current, path) !== wbRef.current) {
        rendererMarks.mark("file-open-start");
      }
      // Every open also records recency (quick-open ranking, Phase E5.0).
      mutateWb((state) => recordRecentFile(openTab(state, path), path));
    },
    [mutateWb],
  );
  const openGraphTab = useCallback(() => {
    mutateWb((state) => openTab(state, GRAPH_TAB_PATH));
  }, [mutateWb]);
  const openHistoryTab = useCallback(() => {
    mutateWb((state) => openTab(state, HISTORY_TAB_PATH));
  }, [mutateWb]);
  const openHistoryDiffTab = useCallback(
    (changeSetId: string, filePath: string) => {
      mutateWb((state) => openTab(state, historyDiffTabPath(changeSetId, filePath)));
    },
    [mutateWb],
  );
  const activateEditorTab = useCallback(
    (path: string) => {
      if (isVirtualTabPath(path)) {
        mutateWb((state) => activateTab(state, path));
        return;
      }
      openFile(path);
    },
    [mutateWb, openFile],
  );

  // Search-result click: open + land at the line (source mode this phase).
  const openSearchResult = useCallback(
    (path: string, line: number) => {
      setSearchScrollTarget({ path, line, nonce: ++scrollNonce.current });
      openFile(path);
    },
    [openFile],
  );

  // Stable handlers (Tab/FileRow memo contract: a fresh closure here would
  // re-render the whole strip on every shell render, incl. each 800ms dirty
  // flip while typing). Closing the ACTIVE tab activates its neighbor, which
  // remounts the keyed inspector — that is an OPEN, so re-mark
  // file-open-start or the view's mount measure would bracket the stale mark
  // the last explicit open left (garbage open-latency telemetry). Like
  // openFile, the transition is read from wbRef and marked before setState.
  const closeFileTab = useCallback(
    (path: string) => {
      const current = wbRef.current;
      const next = closeTab(current, path);
      if (
        next.activeTab !== current.activeTab &&
        next.activeTab !== null &&
        !isVirtualTabPath(next.activeTab)
      ) {
        rendererMarks.mark("file-open-start");
      }
      mutateWb((state) => closeTab(state, path));
    },
    [mutateWb],
  );

  const closeActiveTab = useCallback(() => {
    const current = wbRef.current;
    if (!current.activeTab) return;
    const next = closeTab(current, current.activeTab);
    if (next.activeTab !== null && !isVirtualTabPath(next.activeTab)) {
      rendererMarks.mark("file-open-start");
    }
    mutateWb((state) => (state.activeTab ? closeTab(state, state.activeTab) : state));
  }, [mutateWb]);

  const closeAllTabs = useCallback(() => {
    mutateWb((state) =>
      state.tabs.length === 0 && state.activeTab === null
        ? state
        : { ...state, tabs: [], activeTab: null },
    );
  }, [mutateWb]);

  const closeOtherTabs = useCallback(
    (path: string) => {
      const current = wbRef.current;
      if (!current.tabs.some((tab) => tab.path === path)) return;
      if (current.activeTab !== path && !isVirtualTabPath(path)) {
        rendererMarks.mark("file-open-start");
      }
      mutateWb((state) => {
        if (!state.tabs.some((tab) => tab.path === path)) return state;
        if (state.tabs.length === 1 && state.activeTab === path) return state;
        return { ...state, tabs: [{ path }], activeTab: path };
      });
    },
    [mutateWb],
  );

  const moveFileTab = useCallback(
    (path: string, toIndex: number) => {
      mutateWb((state) =>
        moveTab(
          state,
          state.tabs.findIndex((tab) => tab.path === path),
          toIndex,
        ),
      );
    },
    [mutateWb],
  );

  const showPathInExplorer = useCallback(
    (path: string) => {
      mutateWb((state) =>
        ancestorDirs(path).reduce<WorkbenchState>(
          (acc, dir) => setFolderExpanded(acc, dir, true),
          { ...state, activeView: "explorer", sidebarVisible: true },
        ),
      );
    },
    [mutateWb],
  );

  // Successful explorer moves/deletes re-project every path-keyed slice
  // (tabs, activeTab, pins, expansion) BEFORE the watcher refresh lands, so
  // a rename never leaves a dead tab pointing at the old path. If the remap
  // changes which inspector is mounted, that is an open — re-mark
  // file-open-start (closeFileTab idiom) so the next measure stays honest.
  const onExplorerPathsChanged = useCallback(
    (changes: PendingTreeChange[]) => {
      const current = wbRef.current;
      const next = remapWorkbenchPaths(current, (path) =>
        projectTreePath(path, changes),
      );
      if (next.activeTab !== current.activeTab && next.activeTab !== null) {
        rendererMarks.mark("file-open-start");
      }
      mutateWb((state) =>
        remapWorkbenchPaths(state, (path) => projectTreePath(path, changes)),
      );
    },
    [mutateWb],
  );

  // Reveal-then-create: the inline editbox lives in the explorer view, so
  // make that view visible first (never setView — re-selecting the active
  // view TOGGLES the panel).
  const requestExplorerCreate = useCallback(
    (kind: "file" | "folder") => {
      mutateWb((state) => ({ ...state, activeView: "explorer", sidebarVisible: true }));
      setCreateRequest((current) => ({ kind, id: (current?.id ?? 0) + 1 }));
    },
    [mutateWb],
  );

  const setExplorerFolderExpanded = useCallback(
    (path: string, expanded: boolean) =>
      mutateWb((state) => setFolderExpanded(state, path, expanded)),
    [mutateWb],
  );
  const toggleExplorerFolder = useCallback(
    (path: string) => mutateWb((state) => toggleFolderExpanded(state, path)),
    [mutateWb],
  );
  const toggleExplorerPin = useCallback(
    (path: string) => mutateWb((state) => togglePinned(state, path)),
    [mutateWb],
  );
  const collapseExplorerFolders = useCallback(() => {
    mutateWb((state) =>
      state.expandedFolders.length === 0
        ? state
        : { ...state, expandedFolders: [] },
    );
  }, [mutateWb]);
  const createUntitledTextFile = useCallback(async () => {
    const result = await bridge().createWorkspaceFile({
      workspaceId,
      relativePath: uniqueUntitledTextPath(files, folders),
    });
    await refreshFiles();
    openFile(result.path);
  }, [files, folders, openFile, refreshFiles, workspaceId]);
  const openHistoryView = useCallback(() => {
    mutateWb((state) => ({
      ...setView(state, "history"),
      sidebarVisible: true,
      historyVisible: true,
    }));
  }, [mutateWb]);
  const openAgentView = useCallback(() => {
    mutateWb((state) => ({ ...setView(state, "agent"), sidebarVisible: true }));
  }, [mutateWb]);
  const openImportExportDialog = useCallback((path?: string | null) => {
    const targetPath = path === undefined ? activeDocumentPath : path;
    const canUseSelection =
      targetPath !== null &&
      activeDocumentPath !== null &&
      targetPath === activeDocumentPath;
    setImportExportPath(targetPath && !isVirtualTabPath(targetPath) ? targetPath : null);
    setImportExportSelectionText(canUseSelection ? readSelectedText() : "");
    setImportExportOpen(true);
  }, [activeDocumentPath]);

  const runWorkbenchMenuCommand = useCallback(
    (command: WorkbenchMenuCommand, path?: string) => {
      if (command === "close-tab" && path) {
        closeFileTab(path);
      } else if (command === "close-other-tabs" && path) {
        closeOtherTabs(path);
      } else if (command === "copy-path" && path && !isVirtualTabPath(path)) {
        void navigator.clipboard?.writeText(path);
      } else if (command === "show-in-explorer" && path && !isVirtualTabPath(path)) {
        showPathInExplorer(path);
      } else if (command === "import-export") {
        openImportExportDialog(
          path && !isVirtualTabPath(path) ? path : activeDocumentPath,
        );
      } else if (command === "open-agent") {
        openAgentView();
      } else if (command === "open-history") {
        openHistoryView();
      } else if (command === "connect-cloud") {
        setCloudOpen(true);
      } else if (command === "settings") {
        setSettingsOpen(true);
      } else if (command === "toggle-theme") {
        toggleTheme();
      }
    },
    [
      activeDocumentPath,
      closeFileTab,
      closeOtherTabs,
      openAgentView,
      openHistoryView,
      openImportExportDialog,
      showPathInExplorer,
    ],
  );

  const showWorkbenchMenu = useCallback(
    async (context: "tab" | "editor" | "status", path?: string) => {
      const command = await bridge().showWorkbenchMenu({
        workspaceId,
        context,
        ...(path ? { path } : {}),
      });
      if (command) runWorkbenchMenuCommand(command, path);
    },
    [runWorkbenchMenuCommand, workspaceId],
  );

  // Performance marks (post-commit, so the rendered surface is included):
  // file tree populated, and shell interactive once status/history landed.
  // These live in the workbench ROOT — a view may unmount, this must not.
  useEffect(() => {
    if (files.length > 0) rendererMarks.markOnce("file-tree-loaded");
  }, [files]);
  useEffect(() => {
    if (!files.some((file) => /\.(md|markdown)$/i.test(file.path))) return;
    return scheduleMarkdownEditorPreload();
  }, [files]);
  useEffect(() => {
    if (syncStatus) rendererMarks.markOnce("workspace-shell-interactive");
  }, [syncStatus]);

  // Open the workspace (starts the file watcher in main), load the initial
  // file tree + history, and refresh everything whenever a settled batch is
  // recorded — the timeline and status stay live without polling.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await bridge().openWorkspace({ workspaceId });
      if (!cancelled) setSyncStatus(status);
      await refreshFiles();
      await refreshHistory();
    })();
    const unsubscribe = bridge().onWorkspaceActivity(() => {
      void refreshFiles();
      void refreshHistory();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspaceId, refreshFiles, refreshHistory]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      // The application menu DISPLAYS these accelerators but does not
      // register them (registerAccelerator: false) — this handler is the one
      // owner of the keystrokes. Shift+P is "P" (uppercase) in event.key.
      if (event.key === "n") {
        event.preventDefault();
        setNewFileOpen(true);
      } else if (event.key === "k" || (event.shiftKey && event.key === "P")) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "p") {
        event.preventDefault();
        setQuickOpenOpen((open) => !open);
      } else if (event.key === "b") {
        event.preventDefault();
        mutateWb(toggleSidebar);
      } else if (event.key === "w") {
        // Ctrl+W closes the TAB (the menu's Close Window moved to
        // Ctrl+Shift+W so the close role can't swallow this keystroke).
        event.preventDefault();
        closeActiveTab();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeActiveTab, mutateWb]);

  const openWorkspaceFolder = useCallback(async () => {
    const picked = await bridge().pickWorkspaceRoot();
    if (!picked) return;
    const attached = await bridge().attachWorkspaceFolder({ rootPath: picked });
    props.onSwitchWorkspace(attached);
  }, [props.onSwitchWorkspace]);

  // THE command registry: the palette renders it and the application menu
  // routes through it (onMenuCommand below) — one definition per action.
  const commands = useMemo<Command[]>(
    () => [
      {
        id: "new-file",
        label: "New file",
        run: () => setNewFileOpen(true),
      },
      {
        id: "new-folder",
        label: "New folder",
        run: () => requestExplorerCreate("folder"),
      },
      {
        id: "quick-open",
        label: "Go to file",
        run: () => setQuickOpenOpen(true),
      },
      {
        id: "open-workspace",
        label: "Open workspace folder…",
        run: () => void openWorkspaceFolder(),
      },
      {
        id: "import-export",
        label: "Data fragments",
        run: openImportExportDialog,
      },
      {
        id: "import-files",
        label: "Import files",
        run: () => void importFiles(),
      },
      {
        id: "export-workspace",
        label: "Export workspace as zip",
        run: () => void bridge().exportWorkspaceZip({ workspaceId }),
      },
      {
        id: "toggle-sidebar",
        label: "Toggle sidebar",
        run: () => mutateWb(toggleSidebar),
      },
      {
        id: "close-tab",
        label: "Close tab",
        run: closeActiveTab,
      },
      {
        id: "toggle-history",
        label: "Toggle history rail",
        run: () => mutateWb(toggleHistory),
      },
      ...VIEW_IDS.map((view) => ({
        id: `show-${view}`,
        label: `View: ${activityViewLabel(view)}`,
        run: () => mutateWb((state) => setView(state, view)),
      })),
      {
        id: "connect-cloud",
        label: "Connect dohc Cloud",
        run: () => setCloudOpen(true),
      },
      {
        id: "manage-workspace",
        label: "Manage workspace members",
        run: () => setWorkspaceManagementOpen(true),
      },
      {
        id: "settings",
        label: "Settings: Agents & MCP",
        run: () => setSettingsOpen(true),
      },
      {
        id: "toggle-theme",
        label: "Toggle light/dark theme",
        run: toggleTheme,
      },
    ],
    [
      openWorkspaceFolder,
      closeActiveTab,
      importFiles,
      mutateWb,
      requestExplorerCreate,
      openImportExportDialog,
      workspaceId,
    ],
  );

  useEffect(() => {
    return bridge().onMenuCommand((command) => {
      if (command === "command-palette") setPaletteOpen(true);
      else commands.find((entry) => entry.id === command)?.run();
    });
  }, [commands]);

  const explorerView = (
    <>
      <Explorer
        workspaceId={workspaceId}
        files={files}
        folders={folders}
        activeTab={wb.activeTab}
        openTabs={wb.tabs}
        dirtyTab={activeTabDirty ? wb.activeTab : null}
        expandedFolders={wb.expandedFolders}
        pinned={wb.pinned}
        createRequest={createRequest}
        onOpenFile={openFile}
        onActivateTab={activateEditorTab}
        onCloseTab={closeFileTab}
        onCloseAllTabs={closeAllTabs}
        onNewUntitledTextFile={() => void createUntitledTextFile()}
        onCollapseFolders={collapseExplorerFolders}
        onSetFolderExpanded={setExplorerFolderExpanded}
        onToggleFolder={toggleExplorerFolder}
        onTogglePin={toggleExplorerPin}
        onBeforeChanges={flushActiveDraft}
        onPathsChanged={onExplorerPathsChanged}
        onImportFiles={(droppedPaths) => void importFiles(droppedPaths)}
        onImportExport={openImportExportDialog}
        onRefresh={() => void refreshFiles()}
        onNewFileDialog={() => setNewFileOpen(true)}
      />

      <footer className="flex flex-col border-t border-line px-1 py-1">
        <button
          type="button"
          data-testid="import-export-open"
          onMouseDown={(event) => {
            event.preventDefault();
            openImportExportDialog();
          }}
          onClick={() => openImportExportDialog()}
          className="flex h-7 w-full items-center gap-1.5 rounded px-2 text-xs text-muted hover:bg-line/50 hover:text-ink"
        >
          <Cloud size={13} aria-hidden />
          Data fragments
        </button>
      </footer>
    </>
  );

  return (
    <div
      data-testid="workspace-shell"
      // Flips to "true" only once openWorkspace has resolved — which in main
      // awaits the file watcher's initial scan (workspaceActivity.open races
      // handle.ready). The shell element itself mounts immediately, so a test
      // that writes a file right after the shell appears would otherwise race
      // chokidar's ignoreInitial scan and have the write silently swallowed.
      // Waiting on this attribute is the deterministic "watcher is live" gate.
      data-ready={syncStatus ? "true" : "false"}
      className="app-chrome flex h-screen flex-col bg-bg text-ink"
    >
      <Titlebar
        workspace={props.workspace}
        workspaces={props.workspaces}
        onSwitchWorkspace={props.onSwitchWorkspace}
        onQuickOpen={() => setQuickOpenOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <ActivityBar
          activeView={wb.activeView}
          sidebarVisible={wb.sidebarVisible}
          hasConflict={syncStatus?.state === "conflict"}
          agentActive={agentActive}
          searchResultCount={
            search.model.totalMatches > 0 ? search.model.totalMatches : undefined
          }
          onSelectView={(view) => mutateWb((state) => setView(state, view))}
          onOpenCloud={() => setCloudOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* Side panel (Ctrl+B / activity bar toggle; hidden ⇒ unmounted) */}
        {wb.sidebarVisible ? (
          <SidePanel
            title={activityViewLabel(wb.activeView)}
            width={wb.sidebarWidth}
            onWidthChange={(width) => mutateWb((state) => setSidebarWidth(state, width))}
            actions={
              wb.activeView === "history" ? (
                <>
                  <button
                    type="button"
                    data-testid="history-open-tab"
                    aria-label="Open history in tab"
                    title="Open history in tab"
                    onClick={openHistoryTab}
                    className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                  >
                    <Maximize2 size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    data-testid="history-rail-toggle"
                    aria-label="Toggle history rail"
                    title="Toggle history rail"
                    onClick={() => mutateWb(toggleHistory)}
                    className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                  >
                    <PanelRight size={13} aria-hidden />
                  </button>
                </>
              ) : wb.activeView === "graph" ? (
                <button
                  type="button"
                  data-testid="graph-open-tab"
                  aria-label="Open graph in tab"
                  title="Open graph in tab"
                  onClick={openGraphTab}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <Maximize2 size={13} aria-hidden />
                </button>
              ) : wb.activeView === "apps" ? (
                <button
                  type="button"
                  data-testid="apps-refresh"
                  aria-label="Refresh apps"
                  title="Refresh apps"
                  onClick={refreshApps}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <RefreshCw size={13} aria-hidden />
                </button>
              ) : undefined
            }
          >
            {wb.activeView === "explorer" ? (
              explorerView
            ) : wb.activeView === "search" ? (
              <Suspense fallback={<PanelLoading label="search" />}>
                <LazySearchView search={search} onOpenResult={openSearchResult} />
              </Suspense>
            ) : wb.activeView === "graph" ? (
              <Suspense fallback={<PanelLoading label="graph" />}>
                <LazyGraphView
                  workspaceId={workspaceId}
                  activePath={activeDocumentPath}
                  refreshKey={graphRefreshKey}
                  onOpenPath={openFile}
                  variant="panel"
                />
              </Suspense>
            ) : wb.activeView === "apps" ? (
              <Suspense fallback={<PanelLoading label="apps" />}>
                <LazyAppsView
                  workspaceId={workspaceId}
                  files={files}
                  refreshKey={appsRefreshKey}
                  onOpenPath={openFile}
                />
              </Suspense>
            ) : wb.activeView === "history" ? (
              <HistoryView
                changeSets={changeSets}
                onOpenDiff={openHistoryDiffTab}
              />
            ) : wb.activeView === "agent" ? (
              <Suspense fallback={<PanelLoading label="agent" />}>
                <LazyAgentPanelView
                  workspaceId={workspaceId}
                  refreshKey={agentPanelRefreshKey}
                  onAgentActiveChange={setAgentActive}
                />
              </Suspense>
            ) : null}
          </SidePanel>
        ) : null}

        {/* Editor area: tab strip + the active tab's inspector */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <EditorTabs
            tabs={wb.tabs}
            activeTab={wb.activeTab}
            activeTabDirty={activeTabDirty}
            onActivate={activateEditorTab}
            onClose={closeFileTab}
            onContextMenu={(path) => void showWorkbenchMenu("tab", path)}
            onMove={moveFileTab}
          />
          <div
            className="flex min-h-0 flex-1 flex-col"
            onContextMenu={(event) => {
              event.preventDefault();
              void showWorkbenchMenu("editor");
            }}
          >
            {isGraphTabPath(wb.activeTab) ? (
              <Suspense fallback={<PanelLoading label="graph" />}>
                <LazyGraphView
                  workspaceId={workspaceId}
                  activePath={activeDocumentPath}
                  refreshKey={graphRefreshKey}
                  onOpenPath={openFile}
                  variant="page"
                />
              </Suspense>
            ) : isHistoryTabPath(wb.activeTab) ? (
              <div
                data-testid="history-page"
                className="flex min-h-0 flex-1 flex-col bg-bg"
              >
                <HistoryView
                  changeSets={changeSets}
                  onOpenDiff={openHistoryDiffTab}
                />
              </div>
            ) : isHistoryDiffTabPath(wb.activeTab) ? (
              <HistoryDiffPage
                workspaceId={workspaceId}
                tabPath={wb.activeTab ?? ""}
                onOpenFile={openFile}
              />
            ) : wb.activeTab ? (
              <FileInspector
                key={wb.activeTab}
                workspaceId={workspaceId}
                path={wb.activeTab}
                refreshKey={changeSets.length}
                onOpenPath={openFile}
                scrollTarget={searchScrollTarget ?? undefined}
                onScrollConsumed={consumeScrollTarget}
                onSaveStateChange={onSaveStateChange}
                registerDraftFlush={registerDraftFlush}
                knownMarkdownFiles={markdownWikilinkFiles}
                onSharePath={setSharePath}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <span className="text-sm text-muted">
                  Select a file, or create one
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setNewFileOpen(true)}
                    className="font-mono text-xs text-subtle hover:text-ink"
                  >
                    Ctrl N · new file
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaletteOpen(true)}
                    className="font-mono text-xs text-subtle hover:text-ink"
                  >
                    Ctrl K · commands
                  </button>
                  <button
                    type="button"
                    data-testid="empty-import-export"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      openImportExportDialog();
                    }}
                    onClick={() => openImportExportDialog()}
                    className="font-mono text-xs text-subtle hover:text-ink"
                  >
                    data fragments
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickOpenOpen(true)}
                    className="font-mono text-xs text-subtle hover:text-ink"
                  >
                    Ctrl P · go to file
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>

        {/* History timeline — the "git log for everyday people". Every
            settled change (yours or your agent's) lands here, newest first.
            Default-visible right rail (specs assert it with zero clicks);
            toggleable via the toggle-history command. */}
        {wb.historyVisible ? (
          <HistoryRail
            width={wb.historyWidth}
            onWidthChange={(width) => mutateWb((state) => setHistoryWidth(state, width))}
            onCollapse={() => mutateWb(toggleHistory)}
          >
            <HistoryView
              changeSets={changeSets}
              onOpenDiff={openHistoryDiffTab}
            />
          </HistoryRail>
        ) : (
          <aside
            aria-label="History collapsed"
            className="flex w-9 shrink-0 justify-center border-l border-line bg-panel-2 pt-2"
          >
            <button
              type="button"
              data-testid="history-restore"
              aria-label="Restore history"
              title="Restore history"
              onClick={() => mutateWb(toggleHistory)}
              className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
            >
              <History size={13} aria-hidden />
            </button>
          </aside>
        )}
      </div>

      <StatusBar
        workspaceName={workspaceName(props.workspace)}
        syncStatus={syncStatus}
        agentActive={agentActive}
        conflictSummaries={conflictSummaries}
        onConnectCloud={() => setCloudOpen(true)}
        onOpenAgent={openAgentView}
        onOpenHistory={openHistoryView}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
        onContextMenu={() => void showWorkbenchMenu("status")}
      />

      {paletteOpen ? (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {quickOpenOpen ? (
        <CommandPalette
          testId="quick-open"
          placeholder="Go to file…"
          ariaLabel="File"
          commands={files.map((file) => ({
            id: file.path,
            label: file.path,
            run: () => openFile(file.path),
          }))}
          // Quick-open ranking (E5.0): prefix > word-boundary > substring >
          // fuzzy; recent files boosted; pinned first. Pure function — the
          // command ids ARE the paths.
          rank={(query, commands) => {
            const byPath = new Map(commands.map((command) => [command.id, command]));
            return rankQuickOpenPaths(query, [...byPath.keys()], {
              recent: wb.recentFiles,
              pinned: wb.pinned,
            }).map((path) => byPath.get(path)!);
          }}
          onClose={() => setQuickOpenOpen(false)}
        />
      ) : null}
      {newFileOpen ? (
        <NewFileDialog
          workspaceId={props.workspace.workspaceId}
          onClose={() => setNewFileOpen(false)}
          onCreated={(path) => {
            setNewFileOpen(false);
            // Reveal the new file in the nested tree (expand its ancestors)
            // and open it — a file created into a collapsed folder must
            // never be invisible.
            mutateWb((state) =>
              ancestorDirs(path).reduce(
                (acc, dir) => setFolderExpanded(acc, dir, true),
                state,
              ),
            );
            openFile(path);
            void refreshFiles();
          }}
        />
      ) : null}
      {cloudOpen ? (
        <Overlay onClose={() => setCloudOpen(false)}>
          <CloudLogin
            workspaceId={workspaceId}
            onManageWorkspace={() => {
              setCloudOpen(false);
              setWorkspaceManagementOpen(true);
            }}
          />
        </Overlay>
      ) : null}
      {settingsOpen ? (
        <Overlay onClose={() => setSettingsOpen(false)}>
          <DesktopSettings
            workspaceId={workspaceId}
            workspacePath={props.workspace.rootPath}
            onClose={() => setSettingsOpen(false)}
            onAgentActiveChange={onSettingsAgentActiveChange}
          />
        </Overlay>
      ) : null}
      {sharePath ? (
        <Overlay onClose={() => setSharePath(null)}>
          <Suspense
            fallback={
              <div className="rounded-md border border-line bg-panel px-4 py-3 text-xs text-subtle shadow-lg">
                Loading share dialog...
              </div>
            }
          >
            <LazyShareDialog
              workspaceId={workspaceId}
              path={sharePath}
              onClose={() => setSharePath(null)}
            />
          </Suspense>
        </Overlay>
      ) : null}
      {importExportOpen ? (
        <Overlay onClose={() => setImportExportOpen(false)}>
          <Suspense
            fallback={
              <div className="rounded-md border border-line bg-panel px-4 py-3 text-xs text-subtle shadow-lg">
                Loading import/export panel...
              </div>
            }
          >
            <LazyImportExportDialog
              workspaceId={workspaceId}
              activePath={importExportPath}
              selectedText={importExportSelectionText}
              onImported={() => void refreshFiles()}
              onClose={() => setImportExportOpen(false)}
            />
          </Suspense>
        </Overlay>
      ) : null}
      {workspaceManagementOpen ? (
        <Overlay onClose={() => setWorkspaceManagementOpen(false)}>
          <Suspense
            fallback={
              <div className="rounded-md border border-line bg-panel px-4 py-3 text-xs text-subtle shadow-lg">
                Loading workspace members...
              </div>
            }
          >
            <LazyWorkspaceManagementDialog
              workspaceId={workspaceId}
              onClose={() => setWorkspaceManagementOpen(false)}
            />
          </Suspense>
        </Overlay>
      ) : null}
    </div>
  );
}
