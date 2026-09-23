import { useLayoutEffect, useRef, useState } from "react";
import type { DatabaseSnapshotResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { DatasetCsvTransferDialog, type DatasetCsvTransferDialogProps } from "./DatasetCsvTransferDialog";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { selectClass } from "./collections/FieldForm";
import { readDatabaseTableToCsv, readDocumentCollectionToCsv } from "./datasetSourceImport";

type Source = { kind: "documents" | "sqlite"; path: string };

export function DatasetTransferDialog(props: DatasetCsvTransferDialogProps) {
  return <ScopedTransfer key={JSON.stringify([props.workspaceId, props.dataset, props.tableId])} {...props} />;
}

function ScopedTransfer(props: DatasetCsvTransferDialogProps) {
  const [csv, setCsv] = useState(false);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<DatabaseSnapshotResult | null>(null);
  const [tableName, setTableName] = useState("");
  const [preview, setPreview] = useState<DatasetCsvTransferDialogProps["initialSource"]>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), locked = useRef(false), active = useRef<AbortController | null>(null);
  const contextVersion = useRef(0);

  async function task(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (!alive.current || locked.current) return;
    const controller = new AbortController();
    const version = contextVersion.current;
    active.current = controller; locked.current = true; setBusy(true);
    try { await action(controller.signal); }
    catch (error) {
      if (alive.current && !controller.signal.aborted && active.current === controller) props.onError(fallback, error, () => { if (version === contextVersion.current) void task(action, fallback); });
    } finally {
      if (alive.current && active.current === controller) { locked.current = false; setBusy(false); }
    }
  }

  useLayoutEffect(() => {
    alive.current = true;
    void task(async signal => {
      const api = bridge();
      const [collections, files] = await Promise.all([api.listCollections({ workspaceId: props.workspaceId }), api.listWorkspaceFiles({ workspaceId: props.workspaceId })]);
      signal.throwIfAborted();
      if (!alive.current) return;
      setSources([
        ...collections.collections.map(collection => ({ kind: "documents" as const, path: collection.path })),
        ...files.files.filter(file => file.kind === "database").map(file => ({ kind: "sqlite" as const, path: file.path })),
      ]);
    }, "dohc could not list import sources.");
    return () => { alive.current = false; active.current?.abort(); locked.current = false; };
  }, []);

  if (csv || preview) return <DatasetCsvTransferDialog {...props} initialSource={preview} />;
  const source = sources?.[Number(selected)];

  async function loadSource(signal: AbortSignal) {
    if (!source || selected === "") return;
    if (source.kind === "documents") {
      const table = await readDocumentCollectionToCsv(bridge(), props.workspaceId, source.path, signal);
      signal.throwIfAborted();
      if (alive.current) setPreview({ name: source.path, table, notice: "This copies document properties. Documents stay unchanged; their bodies and relations are not imported. Pause source edits while reading." });
    } else {
      const result = await bridge().readWorkspaceDatabase({ workspaceId: props.workspaceId, relativePath: source.path });
      signal.throwIfAborted();
      if (alive.current) { setSnapshot(result); setTableName(result.tables[0]?.name ?? ""); }
    }
  }

  async function loadTable(signal: AbortSignal) {
    const selectedTable = snapshot?.tables.find(table => table.name === tableName);
    if (!source || !selectedTable) return;
    const table = await readDatabaseTableToCsv(selectedTable, async (name, offset, pageSignal) => {
      pageSignal.throwIfAborted();
      const page = await bridge().readWorkspaceDatabasePage({ workspaceId: props.workspaceId, relativePath: source.path, table: name, offset });
      pageSignal.throwIfAborted();
      if (page.table !== name || page.offset !== offset) throw Error("The SQLite source returned a different page. Start again.");
      return { name: page.table, columns: selectedTable.columns, rows: page.rows, nextOffset: page.nextOffset };
    }, signal);
    signal.throwIfAborted();
    if (alive.current) setPreview({ name: `${source.path} · ${selectedTable.name}`, table, notice: "This copies one table. The source stays unchanged. Pause source edits while reading. Binary and truncated values require a lossless export." });
  }

  return <Overlay onClose={busy ? undefined : props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Import or export Collection", className: "dohc-elevated dohc-pop-in flex max-h-[90vh] w-[min(560px,92vw)] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5 text-ink" }}>
    <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-sm font-semibold">Import or export Collection</h2><SecondaryButton disabled={busy} onClick={props.onClose}>Close</SecondaryButton></div>
    <SecondaryButton disabled={busy} onClick={() => { contextVersion.current++; setCsv(true); }}>CSV or saved import report</SecondaryButton>
    <label className="grid gap-1 text-[12px] text-muted">Copy from this workspace<select className={selectClass} disabled={busy || !sources?.length} value={selected} onChange={event => { contextVersion.current++; setSelected(event.target.value); setSnapshot(null); setTableName(""); }}>
      <option value="">Choose a source</option>
      {sources?.map((source, index) => <option key={`${source.kind}:${source.path}`} value={index}>{source.path} · {source.kind === "documents" ? "Document Collection" : "SQLite"}</option>)}
    </select></label>
    {sources?.length === 0 && <p className="m-0 text-[12px] text-muted">No document Collections or SQLite files. Add one to this workspace, or choose CSV.</p>}
    {!snapshot && <PrimaryButton disabled={busy || selected === ""} onClick={() => void task(loadSource, "dohc could not read this import source.")}>{busy ? "Reading…" : source?.kind === "sqlite" ? "Choose table" : "Preview properties"}</PrimaryButton>}
    {snapshot && <><label className="grid gap-1 text-[12px] text-muted">SQLite table<select className={selectClass} disabled={busy} value={tableName} onChange={event => { contextVersion.current++; setTableName(event.target.value); }}>{snapshot.tables.map(table => <option key={table.name} value={table.name}>{table.name}</option>)}</select></label>
      {snapshot.tables.length === 0 && <p className="m-0 text-[12px] text-muted">This database has no readable tables. Choose another source.</p>}
      <PrimaryButton disabled={busy || !tableName} onClick={() => void task(loadTable, "dohc could not read this SQLite table.")}>{busy ? "Reading…" : "Preview table"}</PrimaryButton></>}
    <p className="m-0 text-[12px] text-muted">Choose fields in the preview before importing. Each row saves through the Collection’s create action.</p>
  </Overlay>;
}
