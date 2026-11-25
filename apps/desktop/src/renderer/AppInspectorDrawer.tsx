import { Database, Play, RefreshCcw, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DatasetResult } from "@dohc/cli/dataset";
import { collectionsRefusalError } from "../ipc/errorWords";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { EmptyState, IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "./workspace/workspaceSession";

type ListedDataset = Extract<DatasetResult, { kind: "list" }>["datasets"][number];
type SqlReply = Extract<DatasetResult, { kind: "sql" }>;
type TraceReply = Extract<DatasetResult, { kind: "trace" }>;

const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / (1024 * 1024)).toFixed(1)} MiB`;

export function AppInspectorDrawer({
  workspaceId,
  onClose,
  reportError,
}: {
  workspaceId: string;
  onClose: () => void;
  reportError?: (fallback: string, error: unknown, retry: (() => void) | null) => void;
}) {
  const session = useWorkspaceSession();
  const [tab, setTab] = useState<"trace" | "sql">("trace");
  const [selectedPath, setSelectedPath] = useState("");
  const [sql, setSql] = useState("");
  const pendingSql = useRef<{ sql: string; explain: boolean } | null>(null);

  const datasetsQuery = useWorkspaceQuery(session, {
    key: `app-inspector-datasets:${workspaceId}`,
    load: async () => {
      const result = await bridge().dataset({ action: "list", workspaceId, limit: 100 });
      if (result.kind === "collections-refused") throw collectionsRefusalError(result.refusal);
      return result.kind === "list" ? result.datasets : [];
    },
  });
  const datasets: ListedDataset[] = (datasetsQuery.value ?? []).filter((d) =>
    Boolean(d.datasetPath),
  );
  const activePath =
    datasets.find((d) => d.datasetPath === selectedPath)?.datasetPath ??
    datasets[0]?.datasetPath ??
    "";
  useEffect(() => {
    if (activePath && activePath !== selectedPath) setSelectedPath(activePath);
    pendingSql.current = null;
  }, [activePath, selectedPath]);

  const traceQuery = useWorkspaceQuery<TraceReply | null>(session, {
    key: `app-inspector-trace:${workspaceId}:${activePath}`,
    load: async () => {
      if (!activePath) return null;
      const result = await bridge().dataset({
        action: "trace",
        workspaceId,
        datasetPath: activePath,
        limit: 50,
      });
      return result.kind === "trace" ? result : null;
    },
  });
  const sqlQuery = useWorkspaceQuery<SqlReply | null>(session, {
    key: `app-inspector-sql:${workspaceId}:${activePath}`,
    manual: true,
    load: async () => {
      const req = pendingSql.current;
      if (!req || !activePath) return null;
      const result = await bridge().dataset({
        action: "sql",
        workspaceId,
        datasetPath: activePath,
        sql: req.sql,
        explain: req.explain,
      });
      return result.kind === "sql" ? result : null;
    },
  });

  const datasetsFailure = datasetsQuery.error;
  const retryDatasets = datasetsQuery.retry;
  useEffect(() => {
    if (datasetsFailure)
      reportError?.(
        "dohc could not load Collections.",
        datasetsFailure,
        () => void retryDatasets(),
      );
  }, [datasetsFailure, retryDatasets, reportError]);
  const traceFailure = traceQuery.error;
  const retryTrace = traceQuery.retry;
  useEffect(() => {
    if (traceFailure)
      reportError?.(
        "dohc could not load recent operations.",
        traceFailure,
        () => void retryTrace(),
      );
  }, [traceFailure, retryTrace, reportError]);

  const runSql = (explain: boolean) => {
    const trimmed = sql.trim();
    if (!trimmed || !activePath) return;
    pendingSql.current = { sql: trimmed, explain };
    void sqlQuery.retry();
  };

  const traceEntries = traceQuery.value?.entries ?? [];
  const sqlResult = sqlQuery.value ?? null;
  const datasetsError = datasetsQuery.error
    ? ipcErrorMessage(datasetsQuery.error, "dohc could not load Collections.")
    : null;
  const sqlError = sqlQuery.error
    ? ipcErrorMessage(sqlQuery.error, "dohc could not run this SQL query.")
    : null;
  const traceError = traceQuery.error
    ? ipcErrorMessage(traceQuery.error, "dohc could not load recent operations.")
    : null;

  return (
    <section
      data-testid="app-inspector-drawer"
      aria-label="Data inspector"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="flex h-72 shrink-0 flex-col border-t border-line bg-panel"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <div
          role="tablist"
          aria-label="Inspector views"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setTab((cur) => (cur === "trace" ? "sql" : "trace"));
            }
          }}
          className="flex rounded-lg border border-line bg-panel-2 p-0.5"
        >
          {(["trace", "sql"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              tabIndex={tab === id ? 0 : -1}
              data-testid={`app-inspector-tab-${id}`}
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors motion-reduce:transition-none ${tab === id ? "bg-bg text-ink shadow-sm" : "text-muted hover:text-ink"}`}
            >
              {id === "trace" ? "Trace" : "SQL"}
            </button>
          ))}
        </div>
        {datasets.length > 0 ? (
          <select
            data-testid="app-inspector-dataset"
            aria-label="Collection"
            value={activePath}
            onChange={(e) => setSelectedPath(e.target.value)}
            className="h-7 max-w-56 rounded-md border border-line bg-bg px-2 text-[12px] text-ink focus:border-ink"
          >
            {datasets.map((d) => (
              <option key={d.datasetId} value={d.datasetPath ?? ""}>
                {d.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {tab === "trace" && activePath ? (
            <IconButton
              data-testid="app-inspector-refresh"
              aria-label="Refresh trace"
              title="Refresh trace"
              onClick={() => void traceQuery.retry()}
            >
              <RefreshCcw size={13} aria-hidden />
            </IconButton>
          ) : null}
          <IconButton
            data-testid="app-inspector-close"
            aria-label="Close inspector"
            title="Close inspector"
            onClick={onClose}
          >
            <X size={13} aria-hidden />
          </IconButton>
        </div>
      </div>

      {datasetsError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-bg">
          <EmptyState icon={Database} tone="danger" title={datasetsError} />
        </div>
      ) : datasets.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-bg">
          <EmptyState
            icon={Database}
            title={
              datasetsQuery.pending
                ? "Loading Collections…"
                : "No Collections in this workspace yet."
            }
          />
        </div>
      ) : tab === "trace" ? (
        <div
          role="tabpanel"
          data-testid="app-inspector-trace-panel"
          className="min-h-0 flex-1 overflow-auto bg-bg"
        >
          {traceError ? (
            <p className="m-0 px-3 py-2 text-[12px] text-danger">{traceError}</p>
          ) : traceEntries.length === 0 ? (
            <EmptyState icon={Terminal} title="No operations recorded yet." />
          ) : (
            <table className="w-full border-collapse text-left text-[12px]">
              <thead className="sticky top-0 border-b border-line bg-panel text-muted">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Operation</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 text-right font-medium">Time</th>
                  <th className="px-2 py-1.5 text-right font-medium">SQL</th>
                  <th className="px-2 py-1.5 text-right font-medium">Rows</th>
                  <th className="px-2 py-1.5 text-right font-medium">Changeset</th>
                  <th className="px-2 py-1.5 font-medium">Caller</th>
                  <th className="px-3 py-1.5 text-right font-medium">Rev</th>
                </tr>
              </thead>
              <tbody>
                {traceEntries.map((entry, index) => (
                  <tr
                    key={`${entry.atMs}-${entry.operation}-${index}`}
                    data-testid="app-inspector-trace-row"
                    className="border-b border-line/60 hover:bg-hover"
                  >
                    <td className="px-3 py-1 font-mono text-ink">{entry.operation}</td>
                    <td
                      className={`px-2 py-1 ${entry.status === "ok" ? "text-success" : "text-danger"}`}
                    >
                      {entry.refusalCode ? `${entry.status} (${entry.refusalCode})` : entry.status}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted">
                      {entry.durationMs} ms
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted">
                      {entry.statementCount}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted">
                      {entry.rowsRead}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted">
                      {formatBytes(entry.changesetBytes)}
                    </td>
                    <td className="px-2 py-1 text-muted">{entry.callerKind}</td>
                    <td className="px-3 py-1 text-right tabular-nums text-subtle">
                      {entry.revision === null ? "-" : `r${entry.revision}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div
          role="tabpanel"
          data-testid="app-inspector-sql-panel"
          className="flex min-h-0 flex-1 flex-col gap-2 bg-bg p-3"
        >
          <div className="flex shrink-0 items-start gap-2">
            <textarea
              data-testid="app-inspector-sql-input"
              aria-label="Read-only SQL query"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  runSql(e.shiftKey);
                }
              }}
              rows={2}
              placeholder="SELECT * FROM ..."
              className="min-h-14 flex-1 resize-none rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink"
            />
            <div className="flex shrink-0 flex-col gap-1">
              <PrimaryButton
                size="compact"
                data-testid="app-inspector-sql-run"
                disabled={sqlQuery.pending || !sql.trim()}
                onClick={() => runSql(false)}
                className="inline-flex items-center justify-center gap-1"
              >
                <Play size={12} aria-hidden />
                {sqlQuery.pending ? "Running…" : "Run"}
              </PrimaryButton>
              <SecondaryButton
                size="compact"
                data-testid="app-inspector-sql-explain"
                disabled={sqlQuery.pending || !sql.trim()}
                onClick={() => runSql(true)}
              >
                Explain
              </SecondaryButton>
            </div>
          </div>
          {sqlError ? (
            <p
              data-testid="app-inspector-sql-error"
              role="alert"
              className="m-0 text-[12px] text-danger"
            >
              {sqlError}
            </p>
          ) : null}
          {sqlResult ? (
            <div className="flex min-h-0 flex-1 flex-col gap-1">
              <div
                data-testid="app-inspector-sql-meta"
                className="flex shrink-0 items-center gap-3 text-[12px] tabular-nums text-subtle"
              >
                <span>
                  {sqlResult.explain
                    ? "Query plan"
                    : `${sqlResult.rows.length} ${sqlResult.rows.length === 1 ? "row" : "rows"}`}
                  {sqlResult.truncated ? " (truncated)" : ""}
                </span>
                <span>{sqlResult.durationMs} ms</span>
                <span>r{sqlResult.revision}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line">
                <table className="w-full border-collapse text-left text-[12px]">
                  <thead className="sticky top-0 border-b border-line bg-panel text-muted">
                    <tr>
                      {sqlResult.columns.map((c, i) => (
                        <th key={`${c}-${i}`} className="px-2 py-1 font-mono font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sqlResult.rows.map((row, r) => (
                      <tr
                        key={r}
                        data-testid="app-inspector-sql-row"
                        className="border-b border-line/60 hover:bg-hover"
                      >
                        {row.map((value, i) => {
                          const cell = value === null ? "NULL" : String(value);
                          return (
                            <td
                              key={i}
                              className="max-w-72 truncate px-2 py-1 font-mono text-ink"
                              title={cell}
                            >
                              {cell}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
