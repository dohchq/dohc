import { Plus, Table, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { extensionOf } from "./path";
import type { SharedLocalDocument } from "./sharedLocalDocument";
import {
  useAutosavedTextDraft,
  type DraftFlush,
  type SaveState,
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

const MAX_CSV_PREVIEW_ROWS = 500;

const CsvTableHeader = memo(function CsvTableHeader({
  header,
  columnCount,
  truncated,
  onUpdateCell,
  onDeleteColumn,
}: {
  header: string[];
  columnCount: number;
  truncated?: boolean;
  onUpdateCell: (rowIndex: number, cellIndex: number, value: string) => void;
  onDeleteColumn: (cellIndex: number) => void;
}) {
  return (
    <thead>
      <tr>
        {!truncated ? (
          <th aria-label="Row actions" className="w-9 bg-panel px-1 py-1.5" />
        ) : null}
        {Array.from({ length: columnCount }, (_, index) => (
          <th
            key={index}
            className={`bg-panel px-2.5 py-1.5 text-left text-[12px] font-semibold text-muted ${
              index > 0 || !truncated ? "border-l border-line" : ""
            }`}
          >
            <div className="flex items-center gap-1">
              <input
                data-testid="csv-cell"
                aria-label={`Header column ${index + 1}`}
                value={header[index] ?? ""}
                readOnly={truncated}
                onChange={(event) => onUpdateCell(0, index, event.target.value)}
                className="dohc-csv-cell min-w-24 flex-1 bg-transparent text-ink outline-none read-only:text-muted"
              />
              {!truncated ? (
                <button
                  type="button"
                  data-testid="csv-delete-column"
                  aria-label={`Delete column ${index + 1}`}
                  title="Delete column"
                  onClick={() => onDeleteColumn(index)}
                  className="grid size-5 shrink-0 place-items-center rounded text-subtle transition-colors hover:bg-line/60 hover:text-danger"
                >
                  <Trash2 size={11} aria-hidden />
                </button>
              ) : null}
            </div>
          </th>
        ))}
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
  onDeleteRow,
}: {
  row: string[];
  rowIndex: number;
  columnCount: number;
  truncated?: boolean;
  onUpdateCell: (rowIndex: number, cellIndex: number, value: string) => void;
  onDeleteRow: (rowIndex: number) => void;
}) {
  return (
    <tr className="group transition-colors hover:bg-panel-2/60">
      {!truncated ? (
        <td className="border-t border-line px-1 py-1 text-center">
          <button
            type="button"
            data-testid="csv-delete-row"
            aria-label={`Delete row ${rowIndex}`}
            title="Delete row"
            onClick={() => onDeleteRow(rowIndex)}
            className="grid size-5 place-items-center rounded text-subtle opacity-0 transition-colors hover:bg-line/60 hover:text-danger focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 size={11} aria-hidden />
          </button>
        </td>
      ) : null}
      {Array.from({ length: columnCount }, (_, cellIndex) => (
        <td
          key={cellIndex}
          className={`border-t border-line px-2.5 py-1.5 ${
            cellIndex > 0 || !truncated ? "border-l" : ""
          }`}
        >
          <input
            data-testid="csv-cell"
            aria-label={`Row ${rowIndex} column ${cellIndex + 1}`}
            value={row[cellIndex] ?? ""}
            readOnly={truncated}
            onChange={(event) =>
              onUpdateCell(rowIndex, cellIndex, event.target.value)
            }
            className="dohc-csv-cell w-full min-w-24 bg-transparent text-ink outline-none read-only:text-muted"
          />
        </td>
      ))}
    </tr>
  );
});

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
  reopenKey,
  switchReadPending,
  switchUnresyncedRef,
  onSaveStateChange,
  registerDraftFlush,
  localBuffer,
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
  truncated?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  registerDraftFlush?: (flush: DraftFlush | null) => void;
  localBuffer: SharedLocalDocument;
}) {
  const [raw, setRaw] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const draft = useAutosavedTextDraft({
    body,
    contentHash,
    contentRequestId,
    contentReadTicket,
    latestContentRequestId,
    refreshAfterConflict,
    workspaceId,
    path,
    disabled: truncated,
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
  const [rows, setRowsState] = useState(() =>
    delimitedTextCodec.parse(draft.draft, delimiter),
  );
  const rowsRef = useRef(rows);
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
    rowsRef.current = nextRows;
    setRowsState(nextRows);
  }, [delimiter, draft.draft, raw]);

  const header = rows[0];
  const dataRowCount = Math.max(0, rows.length - 1);
  // Bounded preview: an unbounded <table> over 10,000+ rows
  // freezes the renderer for tens of seconds. The first rows are enough to
  // inspect and edit common CSVs; working with all of them is what Import to
  // SQLite or raw mode is for.
  const previewRows = rows.slice(1, MAX_CSV_PREVIEW_ROWS + 1);
  const columnCount = Math.max(
    header?.length ?? 0,
    ...previewRows.map((row) => row.length),
  );

  const columnName = useCallback(function columnName(index: number): string {
    return index === 0 ? "column" : `column_${index + 1}`;
  }, []);

  const columnCountFor = useCallback(function columnCountFor(
    nextRows: string[][],
  ): number {
    return Math.max(
      nextRows[0]?.length ?? 0,
      ...nextRows
        .slice(1, MAX_CSV_PREVIEW_ROWS + 1)
        .map((row) => row.length),
      0,
    );
  }, []);

  const setRows = useCallback(
    (nextRows: string[][], changedRowIndex?: number) => {
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
      rowsRef.current = nextRows;
      setRowsState(nextRows);
      draftRef.current.setDraft(nextDraft);
    },
    [delimiter],
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
      setRows(nextRows, narrowed ? undefined : rowIndex);
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
  }, [columnCountFor, setRows]);

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
  }, [columnCountFor, columnName, setRows]);

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

  const toggleRaw = useCallback(() => {
    if (!raw) {
      setRaw(true);
      return;
    }
    const text = draftRef.current.getDraft();
    const nextRows = delimitedTextCodec.parse(text, delimiter);
    tableDraftIdentity.current = { text, delimiter };
    rowsRef.current = nextRows;
    setRowsState(nextRows);
    setRaw(false);
  }, [delimiter, raw]);

  async function importToSqlite() {
    if (importing || truncated) return;
    setImporting(true);
    setImportError(null);
    try {
      const { dbPath, tableName } = deriveImportTarget(path);
      const result = await bridge().importToDatabase({
        workspaceId,
        sourceRelativePath: path,
        databaseRelativePath: dbPath,
        tableName,
      });
      onOpenPath?.(result.path);
    } catch (cause) {
      // Most common: the target database already exists (import never
      // overwrites a canonical file). Tell the user instead of failing mute.
      const message = cause instanceof Error ? cause.message : String(cause);
      setImportError(/already exists/i.test(message) ? "Database already exists" : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="view-csv">
      <div className="flex items-center justify-end gap-1 border-b border-line px-3 py-1">
        <span
          data-testid="csv-save-state"
          data-state={draft.saveState}
          className={`mr-auto font-mono text-[11px] ${draft.saveState === "error" ? "text-danger" : "text-subtle"}`}
        >
          {truncated
            ? "Read-only"
            : draft.saveState === "saved"
              ? "Saved"
              : draft.saveState === "saving"
                ? "Saving..."
                : "Couldn't save"}
        </span>
        {importError ? (
          <span data-testid="csv-import-error" className="px-1 text-[11px] text-danger">
            {importError}
          </span>
        ) : null}
        {!raw && !truncated ? (
          <>
            <button
              type="button"
              onClick={addRow}
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink"
              data-testid="csv-add-row"
            >
              <Plus size={12} aria-hidden />
              Row
            </button>
            <button
              type="button"
              onClick={addColumn}
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink"
              data-testid="csv-add-column"
            >
              <Plus size={12} aria-hidden />
              Column
            </button>
          </>
        ) : null}
        {onOpenPath ? (
          <button
            type="button"
            onClick={() => void importToSqlite()}
            disabled={importing || truncated}
            className="rounded px-2 py-0.5 text-[11px] text-subtle hover:text-ink disabled:opacity-50"
            data-testid="csv-import-sqlite"
          >
            {importing ? "Importing…" : "Import to SQLite"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={toggleRaw}
          className="rounded px-2 py-0.5 text-[11px] text-subtle hover:text-ink"
          data-testid="csv-raw-toggle"
        >
          {raw ? "Table" : "Raw"}
        </button>
      </div>
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
          readOnly={truncated}
          spellCheck={false}
          className="dohc-csv-raw-editor min-h-0 flex-1 resize-none bg-bg p-4 font-mono text-[13px] leading-relaxed text-ink outline-none read-only:text-muted"
        />
      ) : !header ? (
        <div
          data-testid="csv-empty-table"
          className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        >
          <Table size={22} aria-hidden className="text-subtle" />
          <div className="flex flex-col gap-1">
            <span className="text-sm text-ink">Empty table</span>
            <span className="text-xs text-subtle">No rows or columns</span>
          </div>
          {!truncated ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addRow}
                className="inline-flex h-7 items-center gap-1 rounded border border-line px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink"
                data-testid="csv-empty-add-row"
              >
                <Plus size={12} aria-hidden />
                Row
              </button>
              <button
                type="button"
                onClick={addColumn}
                className="inline-flex h-7 items-center gap-1 rounded border border-line px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink"
                data-testid="csv-empty-add-column"
              >
                <Plus size={12} aria-hidden />
                Column
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* Same table voice as the document editor: rounded frame, tinted
              header band, quiet inner hairlines, whisper row hover. */}
          <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-line text-[13px]">
            <CsvTableHeader
              header={header}
              columnCount={columnCount}
              truncated={truncated}
              onUpdateCell={updateCell}
              onDeleteColumn={deleteColumn}
            />
            <tbody>
              {previewRows.map((row, r) => (
                <CsvTableRow
                  key={r}
                  row={row}
                  rowIndex={r + 1}
                  columnCount={columnCount}
                  truncated={truncated}
                  onUpdateCell={updateCell}
                  onDeleteRow={deleteRow}
                />
              ))}
            </tbody>
          </table>
          {dataRowCount > previewRows.length ? (
            <p
              data-testid="csv-preview-bound"
              className="mb-0 mt-2 text-[11px] text-subtle"
            >
              Showing the first {MAX_CSV_PREVIEW_ROWS} of {dataRowCount} rows —
              import to SQLite to work with all of them.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
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
