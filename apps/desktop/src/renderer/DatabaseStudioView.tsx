import { Database } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DatabaseSnapshotResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";

type Snapshot = DatabaseSnapshotResult;
type Table = Snapshot["tables"][number];

// The primary key column — what a row edit keys on. Prefer the declared PK,
// then a conventional "id", then the first column.
function pkColumnOf(table: Table): string | null {
  return (
    table.columns.find((c) => c.primaryKey)?.name ??
    table.columns.find((c) => c.name.toLowerCase() === "id")?.name ??
    table.columns[0]?.name ??
    null
  );
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
  const [editing, setEditing] = useState<{ rowId: string; column: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);

  const { workspaceId, path, refreshKey } = props;

  const load = useCallback(async () => {
    setError(false);
    try {
      const result = await bridge().readWorkspaceDatabase({ workspaceId, relativePath: path });
      setSnapshot(result);
    } catch {
      setError(true);
    }
  }, [workspaceId, path]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const active =
    snapshot?.tables.find((t) => t.name === activeName) ?? snapshot?.tables[0] ?? null;

  async function commitEdit(table: Table) {
    if (!editing) return;
    const pk = pkColumnOf(table);
    const current = editing;
    setEditing(null);
    if (!pk || current.column === pk) return; // never edit the key cell
    try {
      const result = await bridge().applyDatabaseEdit({
        workspaceId,
        relativePath: path,
        edit: {
          table: table.name,
          op: "update",
          pkColumn: pk,
          rowId: current.rowId,
          payload: { [current.column]: draft },
        },
      });
      setSnapshot(result);
    } catch {
      setError(true);
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
          {active ? (
            <>
              <div className="mb-3 flex flex-wrap gap-1.5 text-[11px] text-subtle">
                {active.columns.map((column) => (
                  <span key={column.name} className="rounded border border-line px-1.5 py-0.5">
                    {column.name}
                    <span className="ml-1 text-muted">{column.type}</span>
                    {column.primaryKey ? <span className="ml-1 text-accent">pk</span> : null}
                  </span>
                ))}
              </div>
              <DatabaseGrid
                table={active}
                editing={editing}
                draft={draft}
                onDraft={setDraft}
                onBeginEdit={(rowId, column) => {
                  setDraft(displayValue(active, rowId, column));
                  setEditing({ rowId, column });
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

function displayValue(table: Table, rowId: string, column: string): string {
  const pk = pkColumnOf(table);
  const row = table.rows.find((r) => String(r[pk ?? ""]) === rowId);
  return row ? String(row[column] ?? "") : "";
}

function DatabaseGrid(props: {
  table: Table;
  editing: { rowId: string; column: string } | null;
  draft: string;
  onDraft: (value: string) => void;
  onBeginEdit: (rowId: string, column: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { table } = props;
  const pk = pkColumnOf(table);
  return (
    <div className="overflow-auto rounded border border-line" data-testid="db-table">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th
                key={column.name}
                className="border-b border-line bg-panel-2 px-2 py-1 font-medium text-ink"
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => {
            const rowId = pk ? String(row[pk]) : String(index);
            return (
              <tr key={rowId}>
                {table.columns.map((column) => {
                  const isEditing =
                    props.editing?.rowId === rowId && props.editing.column === column.name;
                  const editable = pk !== null && column.name !== pk;
                  return (
                    <td
                      key={column.name}
                      data-testid={`db-cell-${column.name}-${rowId}`}
                      onClick={() => editable && props.onBeginEdit(rowId, column.name)}
                      className={`border-b border-line px-2 py-1 text-ink ${editable ? "cursor-text" : "text-muted"}`}
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
