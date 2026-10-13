import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { Code, Database, LoaderCircle, Plus, Table, Trash2 } from "lucide-react";
import { EmptyState, IconButton, SecondaryButton } from "./ui/controls";
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ImportToDatabaseResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import type { ReportButtonError } from "./collections/useAutomationButtons";
import { ViewActions } from "./fileInspectorUi";
import { extensionOf } from "./path";
import type { SharedLocalDocument } from "./sharedLocalDocument";
import {
  DataGrid,
  DataGridCell,
  DataGridColumnAction,
  DataGridColumnWidths,
  DataGridGutter,
  type DataGridColumnText,
  DataGridGutterHeader,
  DataGridHeaderCell,
  DataGridRow,
} from "./ui/DataGrid";
import { SegmentedControl, type SegmentedOption } from "./ui/SegmentedControl";
import { StateMark } from "./ui/StateMark";
import {
  useAutosavedTextDraft,
  type DraftFlush,
} from "./useAutosavedTextDraft";

// Derives where a CSV/JSON import materializes: a sibling .sqlite, table named
// after the file. Keeps the import one click and the result next to its source.
function deriveImportTarget(sourcePath: string): { dbPath: string; tableName: string } {
  const slash = sourcePath.lastIndexOf("/");
  const dir = slash === -1 ? "" : sourcePath.slice(0, slash + 1);
  const base = sourcePath.slice(slash + 1).replace(/\.[^.]+$/, "");
  const tableName = base.replace(/[^a-zA-Z0-9_]/g, "_") || "imported";
  return { dbPath: `${dir}${base}.sqlite`, tableName };
}

import { MAX_CSV_PREVIEW_ROWS, detectCsvBound, type CsvBoundOffer } from "./offers/csvBound";

// Imports running now, by workspace and file, so a header click and a stored
// Try again never import one file twice at once, and every view of the file
// shows the import until it ends.
const runningImports = new Map<string, Promise<ImportToDatabaseResult>>();
const importListeners = new Set<() => void>();
const importKey = (workspaceId: string, path: string) => `${workspaceId}\u0000${path}`;
const subscribeImports = (listener: () => void) => {
  importListeners.add(listener);
  return () => {
    importListeners.delete(listener);
  };
};

function useImportRunning(workspaceId: string, path: string): boolean {
  const key = importKey(workspaceId, path);
  return useSyncExternalStore(subscribeImports, () => runningImports.has(key));
}

const notifyImports = () => {
  for (const listener of importListeners) listener();
};

// Imports a CSV into a SQLite file beside it. While an import of the same
// file runs, a header click starts nothing and answers null, and a retry
// (`join`) waits for that import and answers with its result.
function importCsv(workspaceId: string, path: string, join = false): Promise<ImportToDatabaseResult | null> {
  const key = importKey(workspaceId, path);
  const running = runningImports.get(key);
  if (running) return join ? running : Promise.resolve(null);
  const { dbPath, tableName } = deriveImportTarget(path);
  // Started on the next tick, so the import is listed before it can end.
  const started = Promise.resolve()
    .then(() =>
      bridge().importToDatabase({
        workspaceId,
        sourceRelativePath: path,
        databaseRelativePath: dbPath,
        tableName,
      }),
    )
    .finally(() => {
      runningImports.delete(key);
      notifyImports();
    });
  runningImports.set(key, started);
  notifyImports();
  return started;
}

// What failed, naming the database the import makes; the error's words say
// why and what to do next (ipc/errorWords.ts).
const importFailed = (path: string) =>
  `dohc could not import this file to ${deriveImportTarget(path).dbPath}.`;

// Try again on a failed import's Notices row. The person asked for it, so it
// answers through the shell's own hooks whether or not the CSV is still open:
// success opens the database, and a failure files a new row. An import of the
// file already running answers it. The shell remounts for each workspace
// (DesktopRoot), so its hooks never reach another.
function retryImport(
  workspaceId: string,
  path: string,
  onOpenPath: ((path: string) => void) | undefined,
  onError: ReportButtonError | undefined,
): () => void {
  const run = async () => {
    try {
      const result = await importCsv(workspaceId, path, true);
      if (result) onOpenPath?.(result.path);
    } catch (cause) {
      onError?.(importFailed(path), cause, () => void run());
    }
  };
  return () => void run();
}

export type CsvMode = "table" | "raw";

const CSV_MODES: ReadonlyArray<SegmentedOption<CsvMode>> = [
  { value: "table", label: "Table", icon: Table },
  { value: "raw", label: "Raw", icon: Code },
];

// A CSV's controls, right of Share: Table or Raw, and Import to SQLite where
// the view can open the database it makes. A CSV still opening, or one that
// could not be read, draws them disabled in the same places. A running import
// keeps its button, and the focus on it, marks it busy, and says so.
export function CsvControls(props: {
  mode: CsvMode;
  onModeChange?: (mode: CsvMode) => void;
  importable: boolean;
  importing?: boolean;
  onImport?: () => void;
  disabled?: boolean;
  importDisabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <SegmentedControl
        testId="csv-raw-toggle"
        label="Show as"
        value={props.mode}
        options={CSV_MODES}
        onChange={props.onModeChange ?? noop}
        disabled={props.disabled}
      />
      {props.importable ? (
        <IconButton
          data-testid="csv-import-sqlite"
          aria-label="Import to SQLite"
          aria-busy={props.importing || undefined}
          title="Import to SQLite"
          disabled={props.disabled || props.importDisabled}
          onClick={props.onImport}
        >
          {props.importing ? (
            <LoaderCircle data-testid="csv-import-sqlite-pending" size={14} aria-hidden className="motion-safe:animate-spin" />
          ) : (
            <Database size={14} aria-hidden />
          )}
        </IconButton>
      ) : null}
      {/* As the chat composer says a slow send: the button keeps its name,
          and a polite status says the import started. */}
      {props.importable ? (
        <span role="status" aria-live="polite" className="sr-only">
          {props.importing ? "Importing to SQLite…" : ""}
        </span>
      ) : null}
    </div>
  );
}

const noop = () => undefined;

// A CSV's actions in its tab row: the save state, Share, then its controls.
export function CsvViewActions(props: {
  onShare?: () => void;
  saveState: SaveState;
  truncated?: boolean;
  readOnly?: boolean;
  mode: CsvMode;
  onModeChange: (mode: CsvMode) => void;
  importing?: boolean;
  onImport?: () => void;
}) {
  const locked = Boolean(props.truncated || props.readOnly);
  return (
    <ViewActions
      onShare={props.onShare}
      status={
        <StateMark
          testId="csv-save-state"
          truncate
          quietWhenCalm
          state={props.saveState}
          shown={props.readOnly ? "read-only" : props.truncated ? "too-large" : props.saveState}
        />
      }
      actions={
        <CsvControls
          mode={props.mode}
          onModeChange={props.onModeChange}
          importable={props.onImport !== undefined}
          importing={props.importing}
          onImport={props.onImport}
          importDisabled={locked}
        />
      }
    />
  );
}

// An input fills its column and adds no width of its own (`size={1}`): the
// grid sets the width from the column's text. The grid's cell draws the
// focus outline, so the input drops its own ring.
const CELL_INPUT = "dohc-csv-cell w-full bg-transparent outline-none [text-align:inherit]";
const DELETE_BUTTON =
  "grid size-5 place-items-center rounded text-subtle transition-colors hover:bg-hover hover:text-danger";

const CsvTableHeader = memo(function CsvTableHeader({
  header,
  columnCount,
  numeric,
  truncated,
  onUpdateCell,
  onEndEdit,
  onDeleteColumn,
  onAddColumn,
}: {
  header: string[];
  columnCount: number;
  numeric: boolean[];
  truncated?: boolean;
  onUpdateCell: (rowIndex: number, cellIndex: number, value: string) => void;
  onEndEdit: (cellIndex: number) => void;
  onDeleteColumn: (cellIndex: number) => void;
  onAddColumn: () => void;
}) {
  return (
    <thead>
      <tr>
        <DataGridGutterHeader aria-label="Row" />
        {Array.from({ length: columnCount }, (_, index) => (
          <DataGridHeaderCell key={index} column={index}>
            {/* A number column's name ends at its numbers' edge, so its
                Delete column sits on the left. */}
            <div className={`flex items-center gap-1 ${numeric[index] ? "flex-row-reverse" : ""}`}>
              <input
                data-testid="csv-cell"
                aria-label={`Header column ${index + 1}`}
                size={1}
                value={header[index] ?? ""}
                readOnly={truncated}
                onChange={(event) => onUpdateCell(0, index, event.target.value)}
                onBlur={() => onEndEdit(index)}
                className={CELL_INPUT}
              />
              {!truncated ? (
                <DataGridColumnAction>
                  <button
                    type="button"
                    data-testid="csv-delete-column"
                    aria-label={`Delete column ${index + 1}`}
                    title="Delete column"
                    onClick={() => onDeleteColumn(index)}
                    className={DELETE_BUTTON}
                  >
                    <Trash2 size={11} aria-hidden />
                  </button>
                </DataGridColumnAction>
              ) : null}
            </div>
          </DataGridHeaderCell>
        ))}
        {!truncated ? (
          <th className="w-8 border-l border-line bg-panel-2 p-0">
            <IconButton
              data-testid="csv-add-column"
              aria-label="Add column"
              title="Add column"
              onClick={onAddColumn}
              className="mx-auto"
            >
              <Plus size={12} aria-hidden />
            </IconButton>
          </th>
        ) : null}
      </tr>
    </thead>
  );
});

const CsvTableRow = memo(function CsvTableRow({
  row,
  rowIndex,
  columnCount,
  truncated,
  onUpdateCell,
  onEndEdit,
  onDeleteRow,
}: {
  row: string[];
  rowIndex: number;
  columnCount: number;
  truncated?: boolean;
  onUpdateCell: (rowIndex: number, cellIndex: number, value: string) => void;
  onEndEdit: (cellIndex: number) => void;
  onDeleteRow: (rowIndex: number) => void;
}) {
  return (
    <DataGridRow>
      <DataGridGutter
        number={rowIndex}
        action={
          !truncated ? (
            <button
              type="button"
              data-testid="csv-delete-row"
              aria-label={`Delete row ${rowIndex}`}
              title="Delete row"
              onClick={() => onDeleteRow(rowIndex)}
              className={DELETE_BUTTON}
            >
              <Trash2 size={11} aria-hidden />
            </button>
          ) : undefined
        }
      />
      {Array.from({ length: columnCount }, (_, cellIndex) => (
        <DataGridCell key={cellIndex} column={cellIndex}>
          <input
            data-testid="csv-cell"
            aria-label={`Row ${rowIndex} column ${cellIndex + 1}`}
            size={1}
            value={row[cellIndex] ?? ""}
            readOnly={truncated}
            onChange={(event) =>
              onUpdateCell(rowIndex, cellIndex, event.target.value)
            }
            onBlur={() => onEndEdit(cellIndex)}
            className={`${CELL_INPUT} text-ink read-only:text-muted`}
          />
        </DataGridCell>
      ))}
      {/* Under Add column, so the row's hairline runs to the table's edge. */}
      {!truncated ? <td aria-hidden className="border-t border-line" /> : null}
    </DataGridRow>
  );
});

// The table's quiet last row: Add row in the gutter, under the row numbers.
function CsvAddRow(props: { columnCount: number; onAddRow: () => void }) {
  return (
    <tr>
      <td className="h-7 border-t border-line pr-2 text-right">
        <button
          type="button"
          data-testid="csv-add-row"
          aria-label="Add row"
          title="Add row"
          onClick={props.onAddRow}
          className="ml-auto grid size-5 place-items-center rounded text-subtle transition-colors hover:bg-hover hover:text-ink"
        >
          <Plus size={12} aria-hidden />
        </button>
      </td>
      <td colSpan={props.columnCount + 1} className="border-t border-line" />
    </tr>
  );
}

export function CsvView({
  body,
  contentHash,
  contentRequestId,
  contentReadTicket,
  latestContentRequestId,
  refreshAfterConflict,
  workspaceId,
  path,
  onOpenPath,
  truncated,
  readOnly,
  reopenKey,
  switchReadPending,
  switchUnresyncedRef,
  onSaveStateChange,
  registerDraftFlush,
  localBuffer,
  onCsvBoundOffer,
  csvSource,
  onShare,
  onError,
}: {
  reopenKey?: number;
  switchReadPending: boolean;
  switchUnresyncedRef: { current: boolean };
  body: string;
  contentHash: string | null;
  contentRequestId: number;
  contentReadTicket: number;
  latestContentRequestId: number;
  refreshAfterConflict: () => void;
  workspaceId: string;
  path: string;
  onOpenPath?: (path: string) => void;
  // Two reasons the table cannot take edits, kept apart so the chip can
  // name the right one: the bounded read cut the file short, or the share
  // is read-only.
  truncated?: boolean;
  readOnly?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  registerDraftFlush?: (flush: DraftFlush | null) => void;
  localBuffer: SharedLocalDocument;
  onCsvBoundOffer?: (offer: CsvBoundOffer | null) => void;
  csvSource?: "workspace-file" | "received-share" | "dataset";
  onShare?: () => void;
  // The shell's error hook: a failed import is a toast and a Notices row.
  onError?: ReportButtonError;
}) {
  const locked = Boolean(truncated || readOnly);
  const [raw, setRaw] = useState(false);
  const importing = useImportRunning(workspaceId, path);
  // The file the view shows, or null once it closes, so a late import answer
  // never opens or reports into a workspace or file the view has left.
  const target = useRef<{ workspaceId: string; path: string } | null>(null);
  useEffect(() => {
    target.current = { workspaceId, path };
    return () => {
      target.current = null;
    };
  }, [workspaceId, path]);
  const draft = useAutosavedTextDraft({
    body,
    contentHash,
    contentRequestId,
    contentReadTicket,
    latestContentRequestId,
    refreshAfterConflict,
    workspaceId,
    path,
    disabled: locked,
    reopenKey,
    switchReadPending,
    switchUnresyncedRef,
    onSaveStateChange,
    registerDraftFlush,
    localBuffer,
  });
  const delimiter = delimiterForPath(path);
  // Source-of-truth rule: raw mode owns the draft string and never parses its
  // edits; table mode owns the row model, serializes only for persistence, and
  // recognizes that serialized draft identity instead of parsing its own output.
  const [grid, setGrid] = useState(() => {
    const initial = delimitedTextCodec.parse(draft.draft, delimiter);
    return { rows: initial, numeric: numericColumns(initial), widths: columnTexts(initial) };
  });
  const rows = grid.rows;
  const rowsRef = useRef(rows);
  // A cell edit names its column, so only that column's alignment is found
  // again, and the column keeps its width until the edit ends. Any other
  // change finds every column's alignment and width.
  const showRows = useCallback((nextRows: string[][], editedColumn?: number) => {
    rowsRef.current = nextRows;
    setGrid((shown) => {
      const numeric = numericColumns(nextRows, shown.numeric, editedColumn);
      const sameColumns = editedColumn !== undefined && numeric.length === shown.widths.length;
      return { rows: nextRows, numeric, widths: sameColumns ? shown.widths : columnTexts(nextRows) };
    });
  }, []);
  // A cell that loses focus ends its edit, and its column takes the width of
  // its text again.
  const endEdit = useCallback((column: number) => {
    setGrid((shown) => {
      const current = shown.widths[column];
      if (!current) return shown;
      const text = columnText(shown.rows, column);
      if (text.header === current.header && text.cell === current.cell) return shown;
      const widths = [...shown.widths];
      widths[column] = text;
      return { ...shown, widths };
    });
  }, []);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const tableDraftIdentity = useRef<{
    text: string;
    delimiter: "," | "\t";
    rowOffsets?: number[];
  }>({ text: draft.draft, delimiter });

  useEffect(() => {
    if (raw) return;
    // Compare with the newest draft, not this render's. A busy renderer can
    // deliver a cell edit before this effect runs for the render that showed
    // the table, and the edit has already recorded its own text as the table's
    // identity. Reading this render's draft then reparsed the old text, then
    // the edit's own output, and dropped the row offsets.
    const text = draftRef.current.getDraft();
    const identity = tableDraftIdentity.current;
    if (identity.text === text && identity.delimiter === delimiter) return;
    const nextRows = delimitedTextCodec.parse(text, delimiter);
    tableDraftIdentity.current = { text, delimiter };
    showRows(nextRows);
  }, [delimiter, draft.draft, raw, showRows]);

  const dataRowCount = Math.max(0, rows.length - 1);
  useEffect(() => {
    if (rows !== rowsRef.current || switchReadPending || switchUnresyncedRef.current) {
      onCsvBoundOffer?.(null);
      return;
    }
    onCsvBoundOffer?.(raw || !csvSource ? null : detectCsvBound({ workspaceId, path, totalRows: dataRowCount,
      source: csvSource, complete: !truncated,
    }));
  }, [onCsvBoundOffer, csvSource, workspaceId, path, dataRowCount, rows, raw, truncated, switchReadPending, switchUnresyncedRef]);
  useEffect(() => () => onCsvBoundOffer?.(null), [workspaceId, onCsvBoundOffer]);

  const columnName = useCallback(function columnName(index: number): string {
    return index === 0 ? "column" : `column_${index + 1}`;
  }, []);

  const setRows = useCallback(
    (nextRows: string[][], changedRowIndex?: number, editedColumn?: number) => {
      const previous = tableDraftIdentity.current;
      let rowOffsets = previous.rowOffsets;
      let nextDraft: string;
      if (
        changedRowIndex !== undefined &&
        previous.delimiter === delimiter &&
        rowOffsets &&
        changedRowIndex + 1 < rowOffsets.length &&
        nextRows.length === rowsRef.current.length
      ) {
        const start = rowOffsets[changedRowIndex]!;
        const end = rowOffsets[changedRowIndex + 1]! -
          (changedRowIndex < nextRows.length - 1 ? 1 : 0);
        const row = stringifyDelimitedRow(nextRows[changedRowIndex]!, delimiter);
        nextDraft = [previous.text.slice(0, start), row, previous.text.slice(end)].join("");
        const delta = row.length - (end - start);
        for (let index = changedRowIndex + 1; index < rowOffsets.length; index++) {
          rowOffsets[index]! += delta;
        }
      } else {
        rowOffsets = [];
        nextDraft = delimitedTextCodec.serialize(nextRows, delimiter, rowOffsets);
      }
      tableDraftIdentity.current = { text: nextDraft, delimiter, rowOffsets };
      showRows(nextRows, editedColumn);
      draftRef.current.setDraft(nextDraft);
    },
    [delimiter, showRows],
  );

  const updateCell = useCallback(
    (rowIndex: number, cellIndex: number, value: string) => {
      const nextRows = [...rowsRef.current];
      while (nextRows.length <= rowIndex) nextRows.push([]);
      const nextRow = [...nextRows[rowIndex]!];
      // A sliced UTF-16 draft stays wide even after its last wide cell narrows.
      const narrowed = /[^\u0000-\u00ff]/.test(nextRow[cellIndex] ?? "") &&
        !/[^\u0000-\u00ff]/.test(value);
      while (nextRow.length <= cellIndex) nextRow.push("");
      nextRow[cellIndex] = value;
      nextRows[rowIndex] = nextRow;
      setRows(nextRows, narrowed ? undefined : rowIndex, cellIndex);
    },
    [setRows],
  );

  const addRow = useCallback(() => {
    const nextRows = rowsRef.current;
    if (nextRows.length === 0) {
      setRows([["column"], [""]]);
      return;
    }
    const width = Math.max(1, columnCountFor(nextRows));
    setRows([...nextRows, Array.from({ length: width }, () => "")]);
  }, [setRows]);

  const addColumn = useCallback(() => {
    const nextRows = rowsRef.current;
    if (nextRows.length === 0) {
      setRows([["column"]]);
      return;
    }
    const width = columnCountFor(nextRows);
    const next = nextRows.map((row, index) => {
      const cells = [...row];
      while (cells.length < width) cells.push("");
      cells.push(index === 0 ? columnName(width) : "");
      return cells;
    });
    setRows(next);
  }, [columnName, setRows]);

  const deleteRow = useCallback((rowIndex: number) => {
    const next = rowsRef.current.filter((_, index) => index !== rowIndex);
    setRows(next);
  }, [setRows]);

  const deleteColumn = useCallback((cellIndex: number) => {
    const next = rowsRef.current.map((row) =>
      row.filter((_, index) => index !== cellIndex),
    );
    if (next.every((row) => row.length === 0)) {
      setRows([]);
      return;
    }
    setRows(next);
  }, [setRows]);

  const chooseMode = useCallback((mode: CsvMode) => {
    if (mode === (raw ? "raw" : "table")) return;
    if (mode === "raw") {
      setRaw(true);
      return;
    }
    const text = draftRef.current.getDraft();
    const nextRows = delimitedTextCodec.parse(text, delimiter);
    tableDraftIdentity.current = { text, delimiter };
    showRows(nextRows);
    setRaw(false);
  }, [delimiter, raw, showRows]);

  async function importToSqlite() {
    if (locked) return;
    const current = () =>
      target.current?.workspaceId === workspaceId && target.current.path === path;
    try {
      const result = await importCsv(workspaceId, path);
      if (result && current()) onOpenPath?.(result.path);
    } catch (cause) {
      if (current()) onError?.(importFailed(path), cause, retryImport(workspaceId, path, onOpenPath, onError));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="view-csv">
      <CsvViewActions
        onShare={onShare}
        saveState={draft.saveState}
        truncated={truncated}
        readOnly={readOnly}
        mode={raw ? "raw" : "table"}
        onModeChange={chooseMode}
        importing={importing}
        onImport={onOpenPath ? () => void importToSqlite() : undefined}
      />
      {raw ? (
        <textarea
          data-testid="csv-raw-editor"
          value={draft.draft}
          onChange={(event) => draft.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              void draft.saveNow();
            }
          }}
          readOnly={locked}
          spellCheck={false}
          className="dohc-csv-raw-editor min-h-0 flex-1 resize-none bg-bg p-4 font-mono text-[13px] leading-relaxed text-ink outline-none read-only:text-muted"
        />
      ) : (
        <CsvTable
          rows={rows}
          numeric={grid.numeric}
          widths={grid.widths}
          locked={locked}
          onUpdateCell={updateCell}
          onEndEdit={endEdit}
          onDeleteRow={deleteRow}
          onDeleteColumn={deleteColumn}
          onAddRow={addRow}
          onAddColumn={addColumn}
        />
      )}
    </div>
  );
}

// A CSV as a table: its header, its first rows, Add row, and the preview's
// bound; or, with no header, the empty state.
export function CsvTable(props: {
  rows: string[][];
  numeric: boolean[];
  widths: readonly DataGridColumnText[];
  locked: boolean;
  onUpdateCell: (rowIndex: number, cellIndex: number, value: string) => void;
  onEndEdit: (cellIndex: number) => void;
  onDeleteRow: (rowIndex: number) => void;
  onDeleteColumn: (cellIndex: number) => void;
  onAddRow: () => void;
  onAddColumn: () => void;
}) {
  const { rows, numeric, locked } = props;
  const header = rows[0];
  if (!header) {
    return (
      <EmptyState
        data-testid="csv-empty-table"
        icon={Table}
        title={locked ? "This table is empty." : "This table is empty. Add a row or a column to start."}
      >
        {!locked ? (
          <div className="flex items-center gap-2">
            <SecondaryButton
              onClick={props.onAddRow}
              className="inline-flex items-center gap-1"
              data-testid="csv-empty-add-row"
            >
              <Plus size={12} aria-hidden />
              Row
            </SecondaryButton>
            <SecondaryButton
              onClick={props.onAddColumn}
              className="inline-flex items-center gap-1"
              data-testid="csv-empty-add-column"
            >
              <Plus size={12} aria-hidden />
              Column
            </SecondaryButton>
          </div>
        ) : null}
      </EmptyState>
    );
  }
  // Bounded preview: an unbounded <table> over 10,000+ rows
  // freezes the renderer for tens of seconds. The first rows are enough to
  // inspect and edit common CSVs; working with all of them is what Import to
  // SQLite or raw mode is for.
  const previewRows = rows.slice(1, MAX_CSV_PREVIEW_ROWS + 1);
  const dataRowCount = rows.length - 1;
  const columnCount = columnCountFor(rows);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <DataGrid numeric={numeric}>
        <CsvTableHeader
          header={header}
          columnCount={columnCount}
          numeric={numeric}
          truncated={locked}
          onUpdateCell={props.onUpdateCell}
          onEndEdit={props.onEndEdit}
          onDeleteColumn={props.onDeleteColumn}
          onAddColumn={props.onAddColumn}
        />
        <tbody>
          {previewRows.map((row, r) => (
            <CsvTableRow
              key={r}
              row={row}
              rowIndex={r + 1}
              columnCount={columnCount}
              truncated={locked}
              onUpdateCell={props.onUpdateCell}
              onEndEdit={props.onEndEdit}
              onDeleteRow={props.onDeleteRow}
            />
          ))}
          {!locked ? <CsvAddRow columnCount={columnCount} onAddRow={props.onAddRow} /> : null}
        </tbody>
        <DataGridColumnWidths columns={props.widths} headerAction={!locked} trailing={!locked} />
      </DataGrid>
      {dataRowCount > previewRows.length ? <CsvPreviewBound rowCount={dataRowCount} /> : null}
    </div>
  );
}

export function CsvPreviewBound(props: { rowCount: number }) {
  return (
    <p
      data-testid="csv-preview-bound"
      className="mb-0 mt-2 text-[11px] text-subtle"
    >
      Showing the first {MAX_CSV_PREVIEW_ROWS} of {props.rowCount} rows —
      import to SQLite to work with all of them.
    </p>
  );
}

// The widest of the header and the preview's rows.
function columnCountFor(rows: string[][]): number {
  let count = rows[0]?.length ?? 0;
  const end = Math.min(rows.length, MAX_CSV_PREVIEW_ROWS + 1);
  for (let index = 1; index < end; index++) count = Math.max(count, rows[index]!.length);
  return count;
}

// A column holds numbers when every non-empty cell of the preview is a
// finite number, and at least one is. Found for every column once per load;
// after a cell edit, only the edited column is checked again, and an
// unchanged answer keeps the same list. An edit changes the table's width
// only when it writes past the last column.
export function numericColumns(rows: string[][], previous?: boolean[], editedColumn?: number): boolean[] {
  if (editedColumn !== undefined && previous && editedColumn < previous.length) {
    const numeric = holdsNumbers(rows, editedColumn);
    if (previous[editedColumn] === numeric) return previous;
    const next = [...previous];
    next[editedColumn] = numeric;
    return next;
  }
  return Array.from({ length: columnCountFor(rows) }, (_, column) => holdsNumbers(rows, column));
}

// Each column's header and its widest preview cell, which set its width.
export function columnTexts(rows: string[][]): DataGridColumnText[] {
  return Array.from({ length: columnCountFor(rows) }, (_, column) => columnText(rows, column));
}

// A wide character, such as a CJK one, takes about two narrow ones' room.
const WIDE_CHARACTERS = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g;
const textWidth = (text: string) => text.length + (text.match(WIDE_CHARACTERS)?.length ?? 0);

function columnText(rows: string[][], column: number): DataGridColumnText {
  let cell = "";
  let widest = 0;
  const end = Math.min(rows.length, MAX_CSV_PREVIEW_ROWS + 1);
  for (let index = 1; index < end; index++) {
    const text = rows[index]![column] ?? "";
    const width = textWidth(text);
    if (width > widest) {
      cell = text;
      widest = width;
    }
  }
  return { header: rows[0]?.[column] ?? "", cell };
}

function holdsNumbers(rows: string[][], column: number): boolean {
  let found = false;
  const end = Math.min(rows.length, MAX_CSV_PREVIEW_ROWS + 1);
  for (let index = 1; index < end; index++) {
    const cell = rows[index]![column]?.trim();
    if (!cell) continue;
    if (!Number.isFinite(Number(cell))) return false;
    found = true;
  }
  return found;
}

function delimiterForPath(path: string): "," | "\t" {
  const ext = extensionOf(path);
  return ext === "tsv" || ext === "tab" ? "\t" : ",";
}

function parseDelimitedRows(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        cellStarted = true;
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
        cellStarted = true;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      cellStarted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
      cellStarted = false;
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      cellStarted = false;
    } else if (char !== "\r") {
      cell += char;
      cellStarted = true;
    }
  }

  if (cellStarted || cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function stringifyDelimitedRow(row: string[], delimiter: "," | "\t"): string {
  return row
    .map((cell) =>
      (cell === "" && row.length === 1) ||
      cell.includes(delimiter) ||
      /["\r\n]/.test(cell)
        ? `"${cell.replace(/"/g, '""')}"`
        : cell,
    )
    .join(delimiter);
}

function stringifyDelimitedRows(
  rows: string[][],
  delimiter: "," | "\t",
  rowOffsets?: number[],
): string {
  let position = 0;
  return rows
    .map((row, index) => {
      const serialized = stringifyDelimitedRow(row, delimiter);
      if (rowOffsets && index <= MAX_CSV_PREVIEW_ROWS) {
        rowOffsets[index] = position;
        position += serialized.length + (index < rows.length - 1 ? 1 : 0);
        rowOffsets[index + 1] = position;
      }
      return serialized;
    })
    .join("\n");
}

export const delimitedTextCodec = {
  parse: parseDelimitedRows,
  serialize: stringifyDelimitedRows,
};
