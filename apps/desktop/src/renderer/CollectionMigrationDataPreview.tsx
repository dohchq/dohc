import { useLayoutEffect, useRef, useState } from "react";
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
    <div className="overflow-x-auto"><table className="w-full text-left text-[12px]"><thead className="text-muted"><tr><th scope="col">Table</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Changed</th></tr></thead><tbody>{props.preview.tables.map(table => <tr key={table.table}><th scope="row" className="py-1 text-ink">{tableLabel(table.table)}</th><td className="font-mono">{table.beforeRows} records</td><td className="font-mono">{table.afterRows} records</td><td className="font-mono">{table.changedRows} records</td></tr>)}</tbody></table></div>
    {page.changes.length === 0 ? <p className="m-0 text-[12px] text-muted">No record values change. Review the fields and actions before approving.</p> : page.changes.map((change, index) => {
      const columns = [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])];
      return <div key={`${history.length}:${index}`} className="border-t border-line pt-3">
        <div className="flex flex-wrap items-baseline gap-2 text-[12px]"><strong className="text-ink">{tableLabel(change.table)}</strong><span className={change.kind === "delete" ? "text-danger" : change.kind === "insert" ? "text-success" : "text-muted"}>{change.kind === "delete" ? "Record removed" : change.kind === "insert" ? "Record added" : "Record changed"}</span></div>
        <dl className="my-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">{Object.entries(change.key).map(([key, value]) => <div key={key} className="flex gap-1"><dt>{fieldLabel(change.table, key)}:</dt><dd className="m-0"><Value value={value} /></dd></div>)}</dl>
        <div className="overflow-x-auto"><table className="w-full table-fixed text-left text-[12px]"><thead className="text-muted"><tr><th scope="col" className="w-1/4">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>{columns.map(column => <tr key={column} className="border-t border-line"><th scope="row" className="py-2 pr-2 align-top font-medium text-ink">{fieldLabel(change.table, column)}</th><td className="p-2 align-top text-ink"><Value value={change.before?.[column]} /></td><td className="p-2 align-top text-ink"><Value value={change.after?.[column]} /></td></tr>)}</tbody></table></div>
      </div>;
    })}
    <div className="flex items-center justify-between gap-3"><span className="text-[11px] text-muted">{busy ? "Loading changes…" : `Page ${history.length + 1}`}</span><div className="flex gap-2"><SecondaryButton disabled={busy || history.length === 0} onClick={() => void load(history.at(-1), history.slice(0, -1))}>Previous changes</SecondaryButton><SecondaryButton disabled={busy || !page.nextCursor} onClick={() => { if (page.nextCursor) void load(page.nextCursor, [...history, cursor]); }}>More changes</SecondaryButton></div></div>
  </section>;
}
