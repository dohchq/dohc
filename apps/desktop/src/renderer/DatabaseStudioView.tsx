import { ArrowDownAZ, ArrowUpAZ, Database, Search, Share2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DatabaseSnapshotResult } from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { bridge } from "./bridge";

type Snapshot = DatabaseSnapshotResult;
type Table = Snapshot["tables"][number];
type Row = Record<string, unknown>;
type SortState = { column: string; direction: "asc" | "desc" } | null;

// Identity a row EDIT keys on. SQLite rowid (carried by the snapshot as
// __dohc_rowid) is always unique; a guessed "id" column may not be — editing
// one visible row must never update several. WITHOUT ROWID tables fall back to
// a single-column declared primary key; with neither, edits are disabled.
function editKeyFor(
  table: Table,
  row: Row,
): { pkColumn: string; rowId: string | number } | null {
  const rowid = row.__dohc_rowid;
  if (typeof rowid === "number" || typeof rowid === "bigint") {
    return { pkColumn: "rowid", rowId: Number(rowid) };
  }
  const declared = table.columns.filter((c) => c.primaryKey);
  if (declared.length === 1) {
    return { pkColumn: declared[0].name, rowId: String(row[declared[0].name]) };
  }
  return null;
}

// Human-meaningful row label for testids/keys only — never used for edits.
function rowLabelOf(table: Table, row: Row, index: number): string {
  const display =
    table.columns.find((c) => c.primaryKey)?.name ??
    table.columns.find((c) => c.name.toLowerCase() === "id")?.name;
  return display ? String(row[display]) : String(row.__dohc_rowid ?? index);
}

interface EditingCell {
  rowKey: string;
  column: string;
  key: { pkColumn: string; rowId: string | number };
}

function editIdentity(key: EditingCell["key"]): string {
  return `${key.pkColumn}\0${String(key.rowId)}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function isNumericColumn(column: Table["columns"][number]): boolean {
  return /int|real|num|floa|doub|dec/.test(column.type.toLowerCase());
}

function compareCells(a: unknown, b: unknown, numeric: boolean): number {
  if (a === null || a === undefined)
    return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (numeric) {
    const left = Number(a);
    const right = Number(b);
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  }
  return cellText(a).localeCompare(cellText(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

// Visible SQLite studio: browse tables, see schema, and edit a cell. An edit
// writes through to the on-disk file (canonical) and is recorded in the
// inspectable operation log; the studio re-renders from the fresh snapshot.
export function DatabaseStudioView(props: {
  workspaceId: string;
  path: string;
  refreshKey?: number;
  onSharePath?: (path: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [error, setError] = useState(false);

  const { workspaceId, path, refreshKey } = props;
  const currentSnapshotRef = useRef({ workspaceId, path, loadId: 0 });
  const onShare = props.onSharePath
    ? () => props.onSharePath?.(path)
    : undefined;

  // One effect handles both path switches and activity refreshes. Switching
  // paths blanks the view immediately — stale rows from the previous database
  // must never stay visible (or editable) under the new header. A failed
  // (re)load also clears the snapshot for the same reason. The cancelled flag
  // drops slow responses that arrive after another switch.
  useEffect(() => {
    const switched =
      currentSnapshotRef.current.workspaceId !== workspaceId ||
      currentSnapshotRef.current.path !== path;
    const loadId = currentSnapshotRef.current.loadId + 1;
    currentSnapshotRef.current = { workspaceId, path, loadId };
    if (switched) {
      setSnapshot(null);
      setError(false);
      setActiveName(null);
      setEditing(null);
      setQuery("");
      setSort(null);
    }
    bridge()
      .readWorkspaceDatabase({ workspaceId, relativePath: path })
      .then((result) => {
        const current = currentSnapshotRef.current;
        if (
          current.workspaceId !== workspaceId ||
          current.path !== path ||
          current.loadId !== loadId
        ) {
          return;
        }
        setSnapshot(result);
        setError(false);
      })
      .catch(() => {
        const current = currentSnapshotRef.current;
        if (
          current.workspaceId !== workspaceId ||
          current.path !== path ||
          current.loadId !== loadId
        ) {
          return;
        }
        setSnapshot(null);
        setError(true);
      });
  }, [workspaceId, path, refreshKey]);

  // Performance measure (post-commit, snapshot rendered): click → read-only
  // snapshot read → first page of rows on screen.
  useEffect(() => {
    if (snapshot) {
      rendererMarks.measureSince("sqlite-first-page", "file-open-start");
      // Last-wins: readers poll this epoch for freshness (see FileInspector).
      rendererMarks.mark("sqlite-first-page-rendered");
    }
  }, [snapshot]);

  const active =
    snapshot?.tables.find((t) => t.name === activeName) ??
    snapshot?.tables[0] ??
    null;
  const activeColumns = active?.columns ?? [];
  const activeRows = active?.rows ?? [];
  const visibleRows = useMemo(() => {
    if (!active) return [];
    const needle = query.trim().toLowerCase();
    const numericByName = new Map(
      active.columns.map((column) => [column.name, isNumericColumn(column)]),
    );
    const indexed = active.rows
      .map((row, sourceIndex) => ({ row, sourceIndex }))
      .filter(({ row }) => {
        if (!needle) return true;
        return active.columns.some((column) =>
          cellText(row[column.name]).toLowerCase().includes(needle),
        );
      });
    if (!sort) return indexed;
    const factor = sort.direction === "asc" ? 1 : -1;
    return indexed.sort((left, right) => {
      const leftValue = left.row[sort.column];
      const rightValue = right.row[sort.column];
      const leftMissing = leftValue === null || leftValue === undefined;
      const rightMissing = rightValue === null || rightValue === undefined;
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing)
          return left.sourceIndex - right.sourceIndex;
        return leftMissing ? 1 : -1;
      }
      const compared = compareCells(
        leftValue,
        rightValue,
        numericByName.get(sort.column) ?? false,
      );
      return compared === 0
        ? left.sourceIndex - right.sourceIndex
        : compared * factor;
    });
  }, [active, query, sort]);

  const editableRowCount = useMemo(() => {
    if (!active) return 0;
    return active.rows.reduce(
      (count, row) => count + (editKeyFor(active, row) ? 1 : 0),
      0,
    );
  }, [active]);

  function selectTable(name: string) {
    setActiveName(name);
    setEditing(null);
    setQuery("");
    setSort(null);
  }

  async function commitEdit(table: Table) {
    if (!editing) return;
    const current = editing;
    const targetWorkspaceId = workspaceId;
    const targetPath = path;
    setEditing(null);
    try {
      const result = await bridge().applyDatabaseEdit({
        workspaceId: targetWorkspaceId,
        relativePath: targetPath,
        edit: {
          table: table.name,
          op: "update",
          pkColumn: current.key.pkColumn,
          rowId: current.key.rowId,
          payload: { [current.column]: draft },
        },
      });
      // Drop the response if the user switched databases mid-flight.
      const currentSnapshot = currentSnapshotRef.current;
      if (
        currentSnapshot.workspaceId === targetWorkspaceId &&
        currentSnapshot.path === targetPath
      ) {
        setSnapshot(result);
      }
    } catch {
      const currentSnapshot = currentSnapshotRef.current;
      if (
        currentSnapshot.workspaceId === targetWorkspaceId &&
        currentSnapshot.path === targetPath
      ) {
        setError(true);
      }
    }
  }

  if (!snapshot) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col bg-bg"
        data-testid="file-inspector"
      >
        <Header path={path} onShare={onShare} />
        <div
          data-testid="view-database"
          className="flex flex-1 items-center justify-center text-sm text-subtle"
        >
          {error ? "Couldn't read this database." : "Loading database…"}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-bg"
      data-testid="file-inspector"
    >
      <Header path={path} onShare={onShare} />
      <div
        className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]"
        data-testid="view-database"
      >
        <aside
          className="flex min-h-0 flex-col border-r border-line bg-panel-2"
          data-testid="db-table-list"
        >
          <div className="border-b border-line px-3 py-2">
            <div className="text-[11px] uppercase text-subtle">Tables</div>
            <div className="mt-0.5 text-[12px] text-muted">
              {snapshot.tables.length} table
              {snapshot.tables.length === 1 ? "" : "s"} loaded
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {snapshot.tables.length === 0 ? (
              <span className="px-1 text-[12px] text-subtle">No tables</span>
            ) : (
              snapshot.tables.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  data-testid="db-table-tab"
                  onClick={() => selectTable(table.name)}
                  className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left ${
                    active?.name === table.name
                      ? "border-line bg-panel text-ink"
                      : "border-transparent text-muted hover:border-line hover:bg-panel/60 hover:text-ink"
                  }`}
                >
                  <Database size={13} aria-hidden className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      {table.name}
                    </span>
                    <span className="block truncate text-[11px] text-subtle">
                      {table.rows.length} row
                      {table.rows.length === 1 ? "" : "s"} ·{" "}
                      {table.columns.length} column
                      {table.columns.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden p-3">
          {error ? (
            <p
              data-testid="db-edit-error"
              className="mb-2 mt-0 rounded border border-line bg-panel-2 px-2 py-1 text-[12px] text-danger"
            >
              Couldn't apply the last change.
            </p>
          ) : null}
          {active ? (
            <>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-[15px] font-semibold text-ink">
                      {active.name}
                    </h2>
                    <span
                      data-testid="db-visible-row-count"
                      className="rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted"
                    >
                      {visibleRows.length} of {activeRows.length} loaded rows
                    </span>
                  </div>
                  <div className="mt-1 text-[12px] text-subtle">
                    {editableRowCount === 0
                      ? "Read-only: no unique row key in this snapshot"
                      : `${editableRowCount} editable row${editableRowCount === 1 ? "" : "s"} by row key`}
                  </div>
                </div>
                <label className="flex w-full max-w-[320px] items-center gap-1.5 rounded border border-line bg-panel px-2 py-1 text-[12px] text-subtle focus-within:ring-1 focus-within:ring-accent">
                  <Search size={13} aria-hidden />
                  <span className="sr-only">Search loaded rows</span>
                  <input
                    data-testid="db-filter-input"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search loaded rows"
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-subtle"
                  />
                </label>
              </div>

              <div
                className="mb-3 flex flex-wrap gap-1.5 text-[11px]"
                data-testid="db-schema-strip"
              >
                {activeColumns.map((column) => (
                  <span
                    key={column.name}
                    className="rounded border border-line bg-panel px-1.5 py-0.5"
                  >
                    <span className="text-ink">{column.name}</span>
                    <span className="ml-1 text-subtle">
                      {column.type || "value"}
                    </span>
                    {column.primaryKey ? (
                      <span className="ml-1 text-accent">pk</span>
                    ) : null}
                    {column.nullable === false ? (
                      <span className="ml-1 text-subtle">required</span>
                    ) : null}
                  </span>
                ))}
              </div>
              <DatabaseGrid
                table={active}
                rows={visibleRows}
                editing={editing}
                draft={draft}
                sort={sort}
                onDraft={setDraft}
                onSort={(column) =>
                  setSort((current) => {
                    if (current?.column !== column)
                      return { column, direction: "asc" };
                    return {
                      column,
                      direction: current.direction === "asc" ? "desc" : "asc",
                    };
                  })
                }
                onBeginEdit={(cell, value) => {
                  setDraft(value);
                  setEditing(cell);
                }}
                onCommit={() => void commitEdit(active)}
                onCancel={() => setEditing(null)}
              />
            </>
          ) : (
            <p className="text-[13px] text-subtle">
              No tables in this database.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}

function Header({ path, onShare }: { path: string; onShare?: () => void }) {
  return (
    <header className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[13px]">
      <Database size={13} aria-hidden />
      <span className="font-mono text-ink">{path}</span>
      <span className="ml-auto text-[11px] uppercase tracking-wide text-subtle">
        database
      </span>
      {onShare ? (
        <button
          type="button"
          data-testid="file-share"
          aria-label="Share file"
          title="Share file"
          onClick={onShare}
          className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <Share2 size={13} aria-hidden />
        </button>
      ) : null}
    </header>
  );
}

function DatabaseGrid(props: {
  table: Table;
  rows: Array<{ row: Row; sourceIndex: number }>;
  editing: EditingCell | null;
  draft: string;
  sort: SortState;
  onDraft: (value: string) => void;
  onSort: (column: string) => void;
  onBeginEdit: (cell: EditingCell, currentValue: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { table } = props;
  const numeric = new Set(
    table.columns
      .filter((column) => isNumericColumn(column))
      .map((column) => column.name),
  );
  return (
    <div
      className="min-h-0 flex-1 overflow-auto rounded border border-line"
      data-testid="db-table"
    >
      <table className="w-full min-w-[640px] border-collapse text-left text-[12px]">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 w-12 border-b border-r border-line bg-panel-2 px-2 py-1 text-right font-medium text-subtle">
              #
            </th>
            {table.columns.map((column) => (
              <th
                key={column.name}
                aria-sort={
                  props.sort?.column === column.name
                    ? props.sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className={`sticky top-0 z-10 border-b border-line bg-panel-2 px-2 py-1 font-medium text-ink ${
                  numeric.has(column.name) ? "text-right" : ""
                }`}
              >
                <button
                  type="button"
                  data-testid={`db-sort-${column.name}`}
                  onClick={() => props.onSort(column.name)}
                  className={`inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 hover:bg-line/50 ${
                    numeric.has(column.name) ? "ml-auto" : ""
                  }`}
                >
                  <span className="truncate">{column.name}</span>
                  {props.sort?.column === column.name &&
                  props.sort.direction === "desc" ? (
                    <ArrowDownAZ
                      size={12}
                      aria-hidden
                      className="shrink-0 text-accent"
                    />
                  ) : (
                    <ArrowUpAZ
                      size={12}
                      aria-hidden
                      className={`shrink-0 ${
                        props.sort?.column === column.name
                          ? "text-accent"
                          : "text-subtle"
                      }`}
                    />
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0">
          {props.rows.length === 0 ? (
            <tr>
              <td
                colSpan={table.columns.length + 1}
                className="px-3 py-8 text-center text-[12px] text-subtle"
                data-testid="db-empty-rows"
              >
                No loaded rows match the current search.
              </td>
            </tr>
          ) : null}
          {props.rows.map(({ row, sourceIndex }, visibleIndex) => {
            const rowLabel = rowLabelOf(table, row, sourceIndex);
            const editKey = editKeyFor(table, row);
            const rowEditKey = editKey ? editIdentity(editKey) : null;
            return (
              <tr
                key={String(row.__dohc_rowid ?? `${rowLabel}-${sourceIndex}`)}
                data-testid="db-row"
                className="odd:bg-bg even:bg-panel/30"
              >
                <td className="sticky left-0 z-10 border-b border-r border-line bg-inherit px-2 py-1 text-right tabular-nums text-subtle">
                  {visibleIndex + 1}
                </td>
                {table.columns.map((column) => {
                  const isEditing =
                    props.editing?.rowKey === rowEditKey &&
                    props.editing.column === column.name;
                  // Editable only with a unique key; the key column itself
                  // stays read-only (when it's a real column, not rowid).
                  const editable =
                    editKey !== null && column.name !== editKey.pkColumn;
                  return (
                    <td
                      key={column.name}
                      data-testid={`db-cell-${column.name}-${rowLabel}`}
                      onClick={() => {
                        if (!editable || !editKey) return;
                        props.onBeginEdit(
                          {
                            rowKey: editIdentity(editKey),
                            column: column.name,
                            key: editKey,
                          },
                          row[column.name] === null ||
                            row[column.name] === undefined
                            ? ""
                            : String(row[column.name]),
                        );
                      }}
                      className={`max-w-[280px] border-b border-line px-2 py-1 align-top ${
                        numeric.has(column.name)
                          ? "text-right tabular-nums"
                          : ""
                      } ${editable ? "cursor-text text-ink hover:bg-panel-2" : "text-muted"}`}
                    >
                      {isEditing ? (
                        <input
                          data-testid="db-cell-input"
                          autoFocus
                          value={props.draft}
                          onChange={(e) => props.onDraft(e.target.value)}
                          onBlur={props.onCommit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") props.onCommit();
                            else if (e.key === "Escape") props.onCancel();
                          }}
                          className="w-full bg-panel px-1 py-0.5 text-[12px] text-ink outline-none ring-1 ring-accent"
                        />
                      ) : (
                        <span
                          className={`block truncate ${
                            row[column.name] === null ||
                            row[column.name] === undefined
                              ? "text-subtle"
                              : ""
                          }`}
                          title={cellText(row[column.name])}
                        >
                          {cellText(row[column.name])}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
