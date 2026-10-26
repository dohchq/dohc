import { ViewActions } from "./fileInspectorUi";
import { isComposingKey } from "./ui/keys";
import { EmptyState, SectionLabel } from "./ui/controls";
import { EMPTY_ART } from "./workbench/EmptyArt";
import { SkeletonRows } from "./ui/SkeletonRows";
import { ArrowDown, ArrowUp, Binary, Database, Hash, Search, TriangleAlert, Type, type LucideIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import type {
  DatabaseEditResult,
  DatabaseSnapshotResult,
} from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { bridge } from "./bridge";
import type { ReportButtonError } from "./collections/useAutomationButtons";
import {
  cellMeasure,
  DataGrid,
  DataGridCell,
  type DataGridColumn,
  DataGridColumnAction,
  DataGridGutter,
  DataGridGutterHeader,
  DataGridHeaderCell,
  DataGridRow,
} from "./ui/DataGrid";
import { StateMark } from "./ui/StateMark";

type Snapshot = DatabaseSnapshotResult;
type Table = Snapshot["tables"][number];
type Column = Table["columns"][number];
type Row = Record<string, unknown>;
type SortState = { column: string; direction: "asc" | "desc" } | null;
type EditKey = { pkColumn: string; rowId: string | number };

// Identity a row edit keys on. SQLite rowid (carried by the snapshot as
// __dohc_rowid) is always unique; a guessed "id" column may not be — editing
// one visible row must never update several. Without rowid tables fall back to
// a single-column declared primary key; with neither, edits are disabled.
function editKeyFor(table: Table, row: Row): EditKey | null {
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

export interface EditingCell {
  rowKey: string;
  column: string;
  key: EditKey;
  // The cell's value when the edit began.
  value: unknown;
}

// The edit a cell takes, or null where it takes none: a row without a unique
// key, and the key column itself (when it's a real column, not rowid).
export function editOf(table: Table, row: Row, column: string): EditingCell | null {
  const key = editKeyFor(table, row);
  if (!key || column === key.pkColumn) return null;
  return { rowKey: editIdentity(key), column, key, value: row[column] };
}

// One cell's new value, and the load it was written over.
interface CellWrite {
  workspaceId: string;
  path: string;
  loadId: number;
  table: string;
  key: EditKey;
  column: string;
  to: string;
}

function editIdentity(key: EditKey): string {
  return `${key.pkColumn}\0${String(key.rowId)}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// The text an edit starts from: a NULL cell starts empty.
function editText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function isNumericColumn(column: Column): boolean {
  return /int|real|num|floa|doub|dec/.test(column.type.toLowerCase());
}

// A column's type as an icon: numbers, text, or bytes. An untyped column has
// none.
function typeIcon(column: Column): LucideIcon | null {
  if (isNumericColumn(column)) return Hash;
  const type = column.type.toLowerCase();
  if (/char|clob|text/.test(type)) return Type;
  if (type.includes("blob")) return Binary;
  return null;
}

// What the header's icon cannot say: the full SQL type, and whether the
// column is the primary key or required.
function columnDetails(column: Column): string {
  return [
    column.type || "No type",
    column.primaryKey ? "primary key" : null,
    column.nullable === false ? "required" : null,
  ]
    .filter(Boolean)
    .join(" · ");
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

function mergeEditPage(
  snapshot: Snapshot,
  result: DatabaseEditResult,
): Snapshot {
  if (result.path !== snapshot.path || result.page.offset !== 0) return snapshot;
  let changed = false;
  const tables = snapshot.tables.map((table) => {
    if (table.name !== result.table) return table;
    changed = true;
    return {
      ...table,
      rows: result.page.rows,
      nextOffset: result.page.nextOffset,
    };
  });
  return changed ? { ...snapshot, tables } : snapshot;
}

// The snapshot with a pending write's value in its cell.
function withWrite(snapshot: Snapshot, write: CellWrite): Snapshot {
  const identity = editIdentity(write.key);
  const tables = snapshot.tables.map((table) =>
    table.name !== write.table
      ? table
      : {
          ...table,
          rows: table.rows.map((row) => {
            const key = editKeyFor(table, row);
            return key && editIdentity(key) === identity ? { ...row, [write.column]: write.to } : row;
          }),
        },
  );
  return { ...snapshot, tables };
}

// Visible SQLite studio: browse tables, see schema, and edit a cell. An edit
// writes through to the on-disk file (canonical) and is recorded in the
// inspectable operation log; the studio merges the returned first page.
export function DatabaseStudioView(props: {
  workspaceId: string;
  path: string;
  fileOpenStartMark?: string;
  refreshKey?: number;
  onSharePath?: (path: string) => void;
  // Mounted shares (and other read-only surfaces): cells never enter edit
  // mode — main refuses the write anyway, but the grid must not offer an
  // edit that can only fail on commit.
  readOnly?: boolean;
  // The shell's error hook: a failed write is a toast and a Notices row.
  onError?: ReportButtonError;
}) {
  // What the database last said, from a load or a write's answer, and the
  // writes it has not answered yet, which show over it.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState<CellWrite[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const draftRef = useRef("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [error, setError] = useState(false);

  const { workspaceId, path, refreshKey, onError } = props;
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
        // Writes over an older load leave with it.
        setSnapshot(result);
        setPending((writes) => writes.filter((write) => write.loadId === loadId));
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
      rendererMarks.measureSince(
        "sqlite-first-page",
        props.fileOpenStartMark ?? "file-open-start",
      );
      // Last-wins: readers poll this epoch for freshness (see FileInspector).
      rendererMarks.mark("sqlite-first-page-rendered");
    }
  }, [props.fileOpenStartMark, snapshot]);

  // A write shows only in the database it was written to, while it is open.
  const shown = useMemo(
    () =>
      snapshot &&
      pending.reduce(
        (rows, write) => (write.workspaceId === workspaceId && write.path === path ? withWrite(rows, write) : rows),
        snapshot,
      ),
    [snapshot, pending, workspaceId, path],
  );
  const active =
    shown?.tables.find((t) => t.name === activeName) ??
    shown?.tables[0] ??
    null;
  const visibleRows = useMemo(() => {
    if (!active) return [];
    const needle = query.trim().toLowerCase();
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
    const sortColumn = active.columns.find((column) => column.name === sort.column);
    const numeric = sortColumn ? isNumericColumn(sortColumn) : false;
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
      const compared = compareCells(leftValue, rightValue, numeric);
      return compared === 0
        ? left.sourceIndex - right.sourceIndex
        : compared * factor;
    });
  }, [active, query, sort]);

  // Why no cell takes an edit, said by the tab row's read-only mark.
  const keyless = useMemo(
    () => active !== null && active.rows.length > 0 && !active.rows.some((row) => editKeyFor(active, row)),
    [active],
  );
  const readOnlyReason = props.readOnly
    ? "This database is shared with you to read."
    : keyless
      ? "This table has no unique row key, so dohc can't change its rows."
      : null;

  function selectTable(name: string) {
    setActiveName(name);
    setEditing(null);
    setQuery("");
    setSort(null);
  }

  // The last write out or waiting for each table, so its writes go one at a
  // time and their answers come in order.
  const tableWrites = useRef(new Map<string, Promise<void>>());

  // Writes one cell. The new value shows at once, in its own database and
  // over the load it was written on. Its answer replaces the shown rows only
  // while that load is the current one. A failed write stops showing its
  // value, and reports through the shell's error hook with Try again. The
  // report names the column and table, and its identity keeps one Notice per
  // cell: a cell that fails again replaces its own, whatever the words.
  const writeCell = useCallback(
    function write(cell: Omit<CellWrite, "loadId">) {
      const pendingWrite: CellWrite = { ...cell, loadId: currentSnapshotRef.current.loadId };
      const current = () => {
        const shown = currentSnapshotRef.current;
        return (
          shown.workspaceId === cell.workspaceId &&
          shown.path === cell.path &&
          shown.loadId === pendingWrite.loadId
        );
      };
      setPending((writes) => [...writes, pendingWrite]);
      const id = [cell.workspaceId, cell.path, cell.table].join("\0");
      let queued: Promise<void> | null = null;
      const send = async () => {
        try {
          const result = await bridge().applyDatabaseEdit({
            workspaceId: cell.workspaceId,
            relativePath: cell.path,
            edit: {
              table: cell.table,
              op: "update",
              pkColumn: cell.key.pkColumn,
              rowId: cell.key.rowId,
              payload: { [cell.column]: cell.to },
            },
          });
          if (current() && result.path === cell.path) {
            setSnapshot((snapshot) => snapshot && mergeEditPage(snapshot, result));
          }
        } catch (cause) {
          // A row is named only by a key column the grid shows; a rowid is
          // SQLite's own number, which no column or row number shows.
          const row = cell.key.pkColumn === "rowid" ? "" : ` for ${cell.key.pkColumn} ${String(cell.key.rowId)}`;
          onError?.(
            `dohc could not save the change to the ${cell.column} column${row} in the ${cell.table} table.`,
            cause,
            () => write(cell),
            ["database-cell", cell.workspaceId, cell.path, cell.table, editIdentity(cell.key), cell.column].join("\0"),
          );
        }
        setPending((writes) => writes.filter((write) => write !== pendingWrite));
        if (tableWrites.current.get(id) === queued) tableWrites.current.delete(id);
      };
      // An idle table sends at once.
      const previous = tableWrites.current.get(id);
      queued = previous ? previous.then(send) : send();
      tableWrites.current.set(id, queued);
    },
    [onError],
  );

  // An unchanged draft writes nothing.
  function commitEdit(table: Table, draft: string) {
    if (!editing) return;
    setEditing(null);
    if (draft === editText(editing.value)) return;
    writeCell({
      workspaceId,
      path,
      table: table.name,
      key: editing.key,
      column: editing.column,
      to: draft,
    });
  }

  if (!snapshot) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col bg-bg"
        data-testid="file-inspector"
      >
        <DatabaseViewActions onShare={onShare} readOnlyReason={readOnlyReason} />
        {error ? (
          <EmptyState
            data-testid="view-database"
            icon={TriangleAlert}
            tone="danger"
            title="Couldn't read this database."
          />
        ) : (
          <SkeletonRows inSlot layout="panel" testId="view-database" label="Loading database…" />
        )}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-bg"
      data-testid="file-inspector"
    >
      <DatabaseViewActions onShare={onShare} readOnlyReason={readOnlyReason} />
      <div
        className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]"
        data-testid="view-database"
      >
        <aside
          className="flex min-h-0 flex-col border-r border-line bg-panel"
          data-testid="db-table-list"
        >
          <div className="border-b border-line px-3 py-2.5">
            <SectionLabel as="div" >
              Tables
            </SectionLabel>
            <div className="mt-0.5 text-[12px] text-muted">
              {snapshot.tables.length} table
              {snapshot.tables.length === 1 ? "" : "s"} loaded
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1">
            {snapshot.tables.length === 0 ? (
              <span className="px-2 text-[12px] text-subtle">No tables</span>
            ) : (
              snapshot.tables.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  data-testid="db-table-tab"
                  onClick={() => selectTable(table.name)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-75 ${
                    active?.name === table.name
                      ? "bg-selected text-ink"
                      : "text-muted hover:bg-hover hover:text-ink"
                  }`}
                >
                  <Database
                    size={13}
                    aria-hidden
                    className={`shrink-0 ${
                      active?.name === table.name ? "text-ink" : "text-subtle"
                    }`}
                  />
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

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden px-4 py-3">
          {active ? (
            <>
              <label className="mb-2.5 flex h-7 w-[260px] max-w-full shrink-0 items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 text-subtle transition-colors focus-within:border-ink">
                <Search size={13} aria-hidden className="shrink-0" />
                <span className="sr-only">Search loaded rows</span>
                <input
                  spellCheck={false}
                  data-testid="db-filter-input"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search loaded rows"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
                />
              </label>
              <DatabaseGrid
                key={active.name}
                table={active}
                rows={visibleRows}
                readOnly={readOnlyReason !== null}
                editing={editing}
                draftRef={draftRef}
                sort={sort}
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
                onBeginEdit={(cell) => {
                  if (props.readOnly) return;
                  draftRef.current = editText(cell.value);
                  setEditing(cell);
                }}
                onCommit={(value) => commitEdit(active, value)}
                onCancel={() => setEditing(null)}
              />
            </>
          ) : (
            <EmptyState picture={EMPTY_ART.table} title="No tables in this database." />
          )}
        </main>
      </div>
    </div>
  );
}

// A database's actions in its tab row: Share, and the read-only mark, whose
// tooltip says why no cell takes an edit.
export function DatabaseViewActions(props: { onShare?: () => void; readOnlyReason: string | null }) {
  return (
    <ViewActions
      onShare={props.onShare}
      status={
        props.readOnlyReason ? (
          <StateMark
            testId="db-read-only"
            state="read-only"
            shown="read-only"
            title={props.readOnlyReason}
            truncate
          />
        ) : undefined
      }
    />
  );
}

// Each column's alignment and the text that sets its width. A load finds
// every column; a change to the loaded rows, such as an edit, finds again
// only the columns whose values changed.
function useGridColumns(table: Table): DataGridColumn[] {
  const last = useRef<{ table: Table; columns: DataGridColumn[] } | null>(null);
  return useMemo(() => {
    const previous = last.current?.table.columns === table.columns ? last.current : null;
    const columns = table.columns.map((column, index) => {
      const kept = previous?.columns[index];
      return kept && !columnChanged(previous.table.rows, table.rows, column.name)
        ? kept
        : gridColumn(table.rows, column);
    });
    last.current = { table, columns };
    return columns;
  }, [table]);
}

function columnChanged(before: Row[], after: Row[], name: string): boolean {
  return before.length !== after.length || before.some((row, index) => !Object.is(row[name], after[index]![name]));
}

// A column holds numbers by its declared type. Its widest cell is the one
// that draws widest in the column's font.
function gridColumn(rows: Row[], column: Column): DataGridColumn {
  const numeric = isNumericColumn(column);
  const measure = cellMeasure(numeric);
  let cell = "";
  let widest = 0;
  for (const row of rows) {
    const text = cellText(row[column.name]);
    const width = measure(text);
    if (width > widest) {
      cell = text;
      widest = width;
    }
  }
  return { numeric, header: column.name, cell };
}

// Where a cell sits in the grid: its visible row, counted from 0, with -1 for
// the header, and its column.
type GridPlace = { row: number; column: number };

// From any element in a cell, including an icon's SVG.
function placeOf(target: EventTarget): GridPlace | null {
  const cell = target instanceof Element ? target.closest<HTMLElement>("[data-grid-row]") : null;
  if (!cell) return null;
  return { row: Number(cell.dataset.gridRow), column: Number(cell.dataset.gridColumn) };
}

// The table as a grid with one tab stop: the active cell. Arrow keys move it,
// Enter or F2 opens its editor, and Tab leaves the grid. In the header, Enter
// or Space sorts by the column.
export function DatabaseGrid(props: {
  table: Table;
  rows: Array<{ row: Row; sourceIndex: number }>;
  readOnly: boolean;
  editing: EditingCell | null;
  draftRef: { current: string };
  sort: SortState;
  onSort: (column: string) => void;
  onBeginEdit: (cell: EditingCell) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const { table, rows } = props;
  const columns = useGridColumns(table);
  // Each row's label for test ids, and its key: the same through sorts,
  // searches and edits, and through reloads by its rowid.
  const rowIds = useMemo(
    () =>
      rows.map(({ row, sourceIndex }) => {
        const label = rowLabelOf(table, row, sourceIndex);
        return { label, key: String(row.__dohc_rowid ?? `${label}-${sourceIndex}`) };
      }),
    [table, rows],
  );
  // The active cell holds the tab stop. Its row is held by key, so the stop
  // stays on a row that an edit, a sort, a search or a reload moves, and by
  // its last place for when the row is gone. The header's key is null. Until
  // focus first lands in the grid, the stop is the first cell of the first
  // row, or the header while there are no rows, so rows that load after the
  // grid still take it.
  const [chosen, setActive] = useState<{ key: string | null; place: number; column: number } | null>(null);
  const active = chosen ?? { key: rowIds[0]?.key ?? null, place: 0, column: 0 };
  const found = active.key === null ? -1 : rowIds.findIndex((id) => id.key === active.key);
  const activeRow = active.key === null ? -1 : found !== -1 ? found : Math.min(active.place, rows.length - 1);
  const activeColumn = Math.min(active.column, table.columns.length - 1);
  const frame = useRef<HTMLDivElement>(null);
  // Enter and Escape end an edit with focus on its cell, also when the new
  // value moves the cell's row, unless something outside the grid has taken
  // focus since.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !frame.current?.contains(focused)) return;
    frame.current
      ?.querySelector<HTMLElement>(`[data-grid-row="${activeRow}"][data-grid-column="${activeColumn}"]`)
      ?.focus();
  });
  const endEdit = (draft: string | null, fromKeyboard: boolean) => {
    refocus.current = fromKeyboard;
    if (draft === null) props.onCancel();
    else props.onCommit(draft);
  };

  function beginEdit(place: GridPlace) {
    const entry = rows[place.row];
    const column = table.columns[place.column];
    const cell = entry && column ? editOf(table, entry.row, column.name) : null;
    if (cell) props.onBeginEdit(cell);
  }

  function onFocus(event: FocusEvent<HTMLTableElement>) {
    const place = placeOf(event.target);
    if (!place) return;
    const key = place.row === -1 ? null : (rowIds[place.row]?.key ?? null);
    setActive((current) =>
      current?.key === key && current.place === place.row && current.column === place.column
        ? current
        : { key, place: place.row, column: place.column },
    );
  }

  function onClick(event: MouseEvent<HTMLTableElement>) {
    // A click in the editor stays in the editor.
    if (event.target instanceof HTMLInputElement) return;
    const place = placeOf(event.target);
    if (!place) return;
    if (place.row === -1) props.onSort(table.columns[place.column]!.name);
    else beginEdit(place);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    // The editor's keys are its own.
    if (event.target instanceof HTMLInputElement) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const place = placeOf(event.target);
    if (!place) return;
    const move = (row: number, column: number) => {
      event.preventDefault();
      event.currentTarget
        .querySelector<HTMLElement>(`[data-grid-row="${row}"][data-grid-column="${column}"]`)
        ?.focus();
    };
    switch (event.key) {
      case "ArrowUp":
        return move(Math.max(-1, place.row - 1), place.column);
      case "ArrowDown":
        return move(Math.min(rows.length - 1, place.row + 1), place.column);
      case "ArrowLeft":
        return move(place.row, Math.max(0, place.column - 1));
      case "ArrowRight":
        return move(place.row, Math.min(table.columns.length - 1, place.column + 1));
      case "Enter":
      case "F2":
      case " ":
        if (place.row === -1) {
          if (event.key === "F2") return;
          event.preventDefault();
          props.onSort(table.columns[place.column]!.name);
        } else if (event.key !== " ") {
          event.preventDefault();
          beginEdit(place);
        }
    }
  }

  const editor = props.editing;
  return (
    <div ref={frame} className="min-h-0 flex-1 overflow-auto" data-testid="db-table">
      {/* Room for the type icon and the sort arrow, each 12px with a 4px gap. */}
      <DataGrid
        role="grid"
        aria-label={table.name}
        aria-readonly={props.readOnly || undefined}
        columns={columns}
        headerRoom={32}
        onFocus={onFocus}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            <DataGridGutterHeader wide aria-label="Row" />
            {table.columns.map((column, index) => (
              <DatabaseHeader
                key={column.name}
                column={column}
                index={index}
                sort={props.sort?.column === column.name ? props.sort.direction : null}
                active={activeRow === -1 && activeColumn === index}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={table.columns.length + 1}
                className="border-t border-line px-3 py-10 text-center text-[13px] text-muted"
                data-testid="db-empty-rows"
              >
                No loaded rows match the current search.
              </td>
            </tr>
          ) : null}
          {rows.map(({ row }, index) => {
            const editKey = editKeyFor(table, row);
            const editingHere = editor !== null && editKey !== null && editor.rowKey === editIdentity(editKey);
            return (
              <DatabaseRow
                key={rowIds[index]!.key}
                table={table}
                row={row}
                rowLabel={rowIds[index]!.label}
                index={index}
                editable={!props.readOnly}
                activeColumn={activeRow === index ? activeColumn : -1}
                editor={
                  editingHere
                    ? { column: editor.column, draftRef: props.draftRef, onEnd: endEdit }
                    : null
                }
              />
            );
          })}
        </tbody>
      </DataGrid>
    </div>
  );
}

// A column's header: its type icon, its name, and its sort arrow. An unsorted
// column shows the arrow only on hover or focus, and in a number column
// before the icon, so the name ends where the numbers do. The full type is
// the header's tooltip and accessible description.
function DatabaseHeader(props: {
  column: Column;
  index: number;
  sort: "asc" | "desc" | null;
  active: boolean;
}) {
  const { column, sort } = props;
  const Icon = typeIcon(column);
  const Arrow = sort === "desc" ? ArrowDown : ArrowUp;
  const numeric = isNumericColumn(column);
  const hidden = sort ? null : (
    <DataGridColumnAction>
      <ArrowUp size={12} aria-hidden className="text-subtle" />
    </DataGridColumnAction>
  );
  return (
    <DataGridHeaderCell
      column={props.index}
      data-testid={`db-sort-${column.name}`}
      data-grid-row={-1}
      data-grid-column={props.index}
      tabIndex={props.active ? 0 : -1}
      aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none"}
      title={columnDetails(column)}
      className="cursor-default select-none"
    >
      <span className="inline-flex max-w-80 items-center gap-1 align-middle">
        {numeric ? hidden : null}
        {Icon ? <Icon size={12} aria-hidden className="shrink-0 text-subtle" /> : null}
        <span className={`truncate ${sort ? "text-ink" : ""}`}>{column.name}</span>
        {sort ? <Arrow size={12} aria-hidden className="shrink-0 text-ink" /> : numeric ? null : hidden}
      </span>
    </DataGridHeaderCell>
  );
}

// A row of cells. Only the row holding the tab stop or the editor renders
// again when either moves.
const DatabaseRow = memo(function DatabaseRow(props: {
  table: Table;
  row: Row;
  rowLabel: string;
  index: number;
  editable: boolean;
  activeColumn: number;
  editor: {
    column: string;
    draftRef: { current: string };
    onEnd: (draft: string | null, fromKeyboard: boolean) => void;
  } | null;
}) {
  const { table, row, editor } = props;
  const editKey = props.editable ? editKeyFor(table, row) : null;
  return (
    <DataGridRow data-testid="db-row">
      <DataGridGutter wide number={props.index + 1} />
      {table.columns.map((column, index) => {
        const value = row[column.name];
        const text = cellText(value);
        const editable = editKey !== null && column.name !== editKey.pkColumn;
        return (
          <DataGridCell
            key={column.name}
            column={index}
            role="gridcell"
            data-testid={`db-cell-${column.name}-${props.rowLabel}`}
            data-grid-row={props.index}
            data-grid-column={index}
            tabIndex={props.activeColumn === index ? 0 : -1}
            className={editable ? "cursor-text" : ""}
          >
            {editor?.column === column.name ? (
              <DatabaseCellEditor draftRef={editor.draftRef} onEnd={editor.onEnd} />
            ) : (
              // A NULL is subtle and italic, so it reads apart from the text
              // "NULL" without its colour.
              <span
                className={`block max-w-80 truncate ${value === null || value === undefined ? "italic text-subtle" : "text-ink"}`}
                title={text}
              >
                {text}
              </span>
            )}
          </DataGridCell>
        );
      })}
    </DataGridRow>
  );
});

// A cell's editor. It fills the cell, which draws the focus outline, and adds
// no width of its own. It draws the thin underline of a focused text field
// (styles.css), so an editing cell reads apart from the active one. Enter
// commits and Escape cancels, each from the keyboard; leaving the cell
// commits. Each edit ends once, with the draft, or null when cancelled.
function DatabaseCellEditor({
  draftRef,
  onEnd,
}: {
  draftRef: { current: string };
  onEnd: (draft: string | null, fromKeyboard: boolean) => void;
}) {
  const [draft, setDraft] = useState(draftRef.current);
  const ended = useRef(false);
  const end = (value: string | null, fromKeyboard: boolean) => {
    if (ended.current) return;
    ended.current = true;
    onEnd(value, fromKeyboard);
  };
  return (
    <input
      spellCheck={false}
      data-testid="db-cell-input"
      autoFocus
      size={1}
      value={draft}
      onChange={(event) => {
        draftRef.current = event.target.value;
        setDraft(event.target.value);
      }}
      onBlur={() => end(draft, false)}
      onKeyDown={(event) => {
        if (isComposingKey(event)) return;
        if (event.key === "Enter") end(draft, true);
        else if (event.key === "Escape") end(null, true);
      }}
      className="w-full bg-transparent text-ink shadow-[inset_0_-1px_0_var(--dohc-muted)] outline-none [text-align:inherit]"
    />
  );
}
