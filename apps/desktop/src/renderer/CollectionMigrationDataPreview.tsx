import { useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Minus, Pencil, Plus } from "lucide-react";
import type { DatasetRevision } from "@dohc/security-contract/dataset";
import { DatasetMigrationPreviewPage, type DatasetMigrationCandidate } from "@dohc/cli/dataset";
import { SecondaryButton } from "./ui/controls";

export type MigrationPreviewPage = DatasetMigrationPreviewPage;
type MigrationPreviewValue = DatasetMigrationPreviewPage["changes"][number]["key"][string];
export interface MigrationDataPreviewProps {
  workspaceId: string;
  preparationId: string;
  previousRevision: DatasetRevision;
  revision: DatasetRevision;
  preview: DatasetMigrationCandidate["preview"];
  onLoad(input: { workspaceId: string; preparationId: string; after?: string; limit: number }, signal: AbortSignal): Promise<MigrationPreviewPage>;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}

function Value({ value }: { value: MigrationPreviewValue | undefined }) {
  if (value === undefined) return <span className="text-muted">Field absent</span>;
  if (value === null) return <span className="text-muted">Empty</span>;
  if (typeof value === "object" && value.type === "blob") return <details><summary className="cursor-pointer text-muted">Binary value</summary><pre className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{value.base64}</pre></details>;
  const text = typeof value === "object" ? value.value : typeof value === "boolean" ? value ? "true" : "false" : typeof value === "string" ? JSON.stringify(value) : String(value);
  return <span className="whitespace-pre-wrap break-all font-mono">{text}</span>;
}

export function CollectionMigrationDataPreview(props: MigrationDataPreviewProps) {
  return <ScopedPreview key={`${props.workspaceId}:${props.preparationId}`} {...props} />;
}
function ScopedPreview(props: MigrationDataPreviewProps) {
  const [page, setPage] = useState(props.preview.firstPage), [history, setHistory] = useState<Array<string | undefined>>([]);
  const [cursor, setCursor] = useState<string | undefined>(), [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null), alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  async function load(after: string | undefined, nextHistory: Array<string | undefined>) {
    if (!alive.current || busy) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const result = DatasetMigrationPreviewPage.parse(after === undefined ? props.preview.firstPage : await props.onLoad({ workspaceId: props.workspaceId, preparationId: props.preparationId, after, limit: 50 }, controller.signal));
      if (controller.signal.aborted || !alive.current) return;
      if (result.nextCursor && (result.nextCursor === after || nextHistory.includes(result.nextCursor)) || result.changes.length === 0 && result.nextCursor) throw Error("The Collection returned an invalid change page. Prepare this review again.");
      setPage(result); setCursor(after); setHistory(nextHistory);
    } catch (error) { if (alive.current && !controller.signal.aborted) props.onError("dohc could not load these record changes.", error, () => { void load(after, nextHistory); }); }
    finally { if (alive.current && !controller.signal.aborted) setBusy(false); }
  }
  function tableLabel(sqlName: string) { return props.revision.definition.tables.find(table => table.sqlName === sqlName)?.name ?? props.previousRevision.definition.tables.find(table => table.sqlName === sqlName)?.name ?? sqlName; }
  function fieldLabel(tableName: string, column: string) { return props.revision.definition.tables.find(table => table.sqlName === tableName)?.fields.find(field => field.sqlColumn === column)?.name ?? props.previousRevision.definition.tables.find(table => table.sqlName === tableName)?.fields.find(field => field.sqlColumn === column)?.name ?? column; }
  return <section aria-label="Record changes" className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3" aria-busy={busy}>
    <h3 className="m-0 text-[12px] font-semibold text-ink">Record changes</h3>
    <div className="overflow-x-auto rounded-md border border-line"><table className="w-full text-left text-[12px]"><thead className="bg-panel-2 text-muted"><tr><th scope="col" className="px-3 py-2 font-medium">Table</th><th scope="col" className="px-3 py-2 font-medium">Before</th><th scope="col" className="px-3 py-2 font-medium">After</th><th scope="col" className="px-3 py-2 font-medium">Changed</th></tr></thead><tbody>{props.preview.tables.map(table => <tr key={table.table} className="border-t border-line"><th scope="row" className="px-3 py-2 font-medium text-ink">{tableLabel(table.table)}</th><td className="px-3 py-2 font-mono text-muted">{table.beforeRows} {table.beforeRows === 1 ? "record" : "records"}</td><td className="px-3 py-2 font-mono text-ink">{table.afterRows} {table.afterRows === 1 ? "record" : "records"}</td><td className="px-3 py-2 font-mono"><span className={table.changedRows ? "rounded bg-panel-2 px-1.5 py-0.5 text-ink" : "text-muted"}>{table.changedRows} {table.changedRows === 1 ? "record" : "records"}</span></td></tr>)}</tbody></table></div>
    {page.changes.length === 0 ? <p className="m-0 text-[12px] text-muted">No record values change. Review the fields and actions before approving.</p> : page.changes.map((change, index) => {
      const columns = [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])];
      const unchanged = columns.filter(column => JSON.stringify(change.before?.[column]) === JSON.stringify(change.after?.[column]));
      const ChangeIcon = change.kind === "delete" ? Minus : change.kind === "insert" ? Plus : Pencil;
      return <div key={`${history.length}:${index}`} className="border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px]"><strong className="text-ink">{tableLabel(change.table)}</strong><span className={`inline-flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 ${change.kind === "delete" ? "text-danger" : change.kind === "insert" ? "text-success" : "text-muted"}`}><ChangeIcon size={12} strokeWidth={1.9} aria-hidden />{change.kind === "delete" ? "Record removed" : change.kind === "insert" ? "Record added" : "Record changed"}</span></div>
        <dl className="my-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">{Object.entries(change.key).map(([key, value]) => <div key={key} className="flex gap-1"><dt>{fieldLabel(change.table, key)}:</dt><dd className="m-0"><Value value={value} /></dd></div>)}</dl>
        <div className="overflow-x-auto"><table className="w-full table-fixed text-left text-[12px]"><thead className="text-muted"><tr><th scope="col" className="w-1/4 py-2 font-medium">Field</th><th scope="col" className="px-2 font-medium">Before</th><th scope="col" className="px-2 font-medium"><span className="flex items-center gap-1.5"><ArrowRight size={12} strokeWidth={1.9} aria-hidden />After</span></th></tr></thead><tbody>{columns.filter(column => !unchanged.includes(column)).map(column => {
          const changed = JSON.stringify(change.before?.[column]) !== JSON.stringify(change.after?.[column]);
          return <tr key={column} className={`border-t border-line ${changed ? "bg-bg" : "text-muted"}`}><th scope="row" className={`py-2 pr-2 align-top font-medium ${changed ? "text-ink" : "text-muted"}`}>{fieldLabel(change.table, column)}</th><td className="p-2 align-top text-muted"><Value value={change.before?.[column]} /></td><td className={`p-2 align-top ${changed ? "text-ink" : "text-muted"}`}><Value value={change.after?.[column]} /></td></tr>;
        })}</tbody></table></div>
        {unchanged.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-[11px] text-muted">{unchanged.length} unchanged {unchanged.length === 1 ? "field" : "fields"}</summary><dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 text-[12px] text-muted">{unchanged.map(column => <div key={column} className="contents"><dt>{fieldLabel(change.table, column)}</dt><dd className="m-0"><Value value={change.before?.[column]} /></dd></div>)}</dl></details>}
      </div>;
    })}
    <div className="flex items-center justify-between gap-3"><span className="text-[11px] text-muted">{busy ? "Loading changes…" : `Page ${history.length + 1}`}</span><div className="flex gap-2"><SecondaryButton disabled={busy || history.length === 0} onClick={() => void load(history.at(-1), history.slice(0, -1))}>Previous changes</SecondaryButton><SecondaryButton disabled={busy || !page.nextCursor} onClick={() => { if (page.nextCursor) void load(page.nextCursor, [...history, cursor]); }}>More changes</SecondaryButton></div></div>
  </section>;
}
