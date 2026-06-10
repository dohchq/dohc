import { Database } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DatabaseSnapshotResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";

type Snapshot = DatabaseSnapshotResult;
type Table = Snapshot["tables"][number];
type Row = Record<string, unknown>;

// Identity a row EDIT keys on. SQLite rowid (carried by the snapshot as
// __dohc_rowid) is always unique; a guessed "id" column may not be — editing
// one visible row must never update several. WITHOUT ROWID tables fall back to
// a single-column declared primary key; with neither, edits are disabled.
function editKeyFor(table: Table, row: Row): { pkColumn: string; rowId: string | number } | null {
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
  rowLabel: string;
  column: string;
  key: { pkColumn: string; rowId: string | number };
}

// Visible SQLite studio: browse tables, see schema, and edit a cell. An edit
// writes through to the on-disk file (canonical) and is recorded in the
// inspectable operation log; the studio re-renders from the fresh snapshot.
export function DatabaseStudioView(props: {
  workspaceId: string;
  path: string;
  refreshKey?: number;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);

  const { workspaceId, path, refreshKey } = props;
  const currentPathRef = useRef(path);

  // One effect handles both path switches and activity refreshes. Switching
  // paths blanks the view immediately — stale rows from the previous database
  // must never stay visible (or editable) under the new header. A failed
  // (re)load also clears the snapshot for the same reason. The cancelled flag
  // drops slow responses that arrive after another switch.
  useEffect(() => {
    let cancelled = false;
    if (currentPathRef.current !== path) {
      currentPathRef.current = path;
      setSnapshot(null);
      setError(false);
      setActiveName(null);
      setEditing(null);
    }
    bridge()
      .readWorkspaceDatabase({ workspaceId, relativePath: path })
      .then((result) => {
        if (cancelled) return;
        setSnapshot(result);
        setError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSnapshot(null);
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path, refreshKey]);

  const active =
    snapshot?.tables.find((t) => t.name === activeName) ?? snapshot?.tables[0] ?? null;

  async function commitEdit(table: Table) {
    if (!editing) return;
    const current = editing;
    setEditing(null);
    try {
      const result = await bridge().applyDatabaseEdit({
        workspaceId,
        relativePath: path,
        edit: {
          table: table.name,
          op: "update",
          pkColumn: current.key.pkColumn,
          rowId: current.key.rowId,
          payload: { [current.column]: draft },
        },
      });
      // Drop the response if the user switched databases mid-flight.
      if (currentPathRef.current === path) setSnapshot(result);
    } catch {
      if (currentPathRef.current === path) setError(true);
    }
  }

  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <Header path={path} />
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
    <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
      <Header path={path} />
      <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr]" data-testid="view-database">
        <aside className="overflow-y-auto border-r border-line bg-panel-2 p-2" data-testid="db-table-list">
          {snapshot.tables.length === 0 ? (
            <span className="px-1 text-[12px] text-subtle">No tables</span>
          ) : (
            snapshot.tables.map((table) => (
              <button
                key={table.name}
                type="button"
                data-testid="db-table-tab"
                onClick={() => setActiveName(table.name)}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] ${
                  active?.name === table.name ? "bg-panel text-ink" : "text-muted hover:text-ink"
                }`}
              >
                <Database size={12} aria-hidden />
                <span className="truncate">{table.name}</span>
              </button>
            ))
          )}
        </aside>

        <main className="min-w-0 overflow-auto p-3">
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
              <div className="mb-3 flex flex-wrap gap-1.5 text-[11px]">
                {active.columns.map((column) => (
                  <span key={column.name} className="rounded border border-line px-1.5 py-0.5">
                    <span className="text-ink">{column.name}</span>
                    <span className="ml-1 text-subtle">{column.type}</span>
                    {column.primaryKey ? <span className="ml-1 text-accent">pk</span> : null}
                  </span>
                ))}
              </div>
              <DatabaseGrid
                table={active}
                editing={editing}
                draft={draft}
                onDraft={setDraft}
                onBeginEdit={(cell, value) => {
                  setDraft(value);
                  setEditing(cell);
                }}
                onCommit={() => void commitEdit(active)}
                onCancel={() => setEditing(null)}
              />
            </>
          ) : (
            <p className="text-[13px] text-subtle">No tables in this database.</p>
          )}
        </main>
      </div>
    </div>
  );
}

function Header({ path }: { path: string }) {
  return (
    <header className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[13px]">
      <Database size={13} aria-hidden />
      <span className="font-mono text-ink">{path}</span>
      <span className="ml-auto text-[11px] uppercase tracking-wide text-subtle">database</span>
    </header>
  );
}

function DatabaseGrid(props: {
  table: Table;
  editing: EditingCell | null;
  draft: string;
  onDraft: (value: string) => void;
  onBeginEdit: (cell: EditingCell, currentValue: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { table } = props;
  const numeric = new Set(
    table.columns
      .filter((c) => /int|real|num|floa|doub/.test(c.type))
      .map((c) => c.name),
  );
  return (
    <div className="overflow-auto rounded border border-line" data-testid="db-table">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th
                key={column.name}
                className={`border-b border-line bg-panel-2 px-2 py-1 font-medium text-ink ${
                  numeric.has(column.name) ? "text-right" : ""
                }`}
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0">
          {table.rows.map((row, index) => {
            const rowLabel = rowLabelOf(table, row, index);
            const editKey = editKeyFor(table, row);
            return (
              <tr key={String(row.__dohc_rowid ?? `${rowLabel}-${index}`)}>
                {table.columns.map((column) => {
                  const isEditing =
                    props.editing?.rowLabel === rowLabel &&
                    props.editing.column === column.name;
                  // Editable only with a unique key; the key column itself
                  // stays read-only (when it's a real column, not rowid).
                  const editable = editKey !== null && column.name !== editKey.pkColumn;
                  return (
                    <td
                      key={column.name}
                      data-testid={`db-cell-${column.name}-${rowLabel}`}
                      onClick={() =>
                        editable &&
                        props.onBeginEdit(
                          { rowLabel, column: column.name, key: editKey },
                          String(row[column.name] ?? ""),
                        )
                      }
                      className={`border-b border-line px-2 py-1 ${
                        numeric.has(column.name) ? "text-right tabular-nums" : ""
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
                        String(row[column.name] ?? "")
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
