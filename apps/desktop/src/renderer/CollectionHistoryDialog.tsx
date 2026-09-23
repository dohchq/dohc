import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, History as HistoryIcon, Paperclip, Undo2 } from "lucide-react";
import { DatasetHistoryPage } from "@dohc/cli/dataset";
import { CollectionHistoryRevisionDetails, type HistoryRevisionControls } from "./CollectionHistoryRevisionDetails";
import { Overlay } from "./Overlay";
import { SecondaryButton } from "./ui/controls";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";

export interface CollectionHistoryDialogProps extends HistoryRevisionControls {
  workspaceId: string;
  datasetId: string;
  name: string;
  onLoad(input: { workspaceId: string; datasetId: string; beforeRevision?: number; limit: number }, signal: AbortSignal): Promise<DatasetHistoryPage>;
  onClose(): void;
  onUndo?(input: TransactionalInvoke): void;
  pendingUndo?: TransactionalInvoke | null;
  undoBusy?: boolean;
  refreshVersion?: number;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}
export function CollectionHistoryDialog(props: CollectionHistoryDialogProps) {
  return <History key={`${props.workspaceId}:${props.datasetId}`} {...props} />;
}
function History(props: CollectionHistoryDialogProps) {
  const [page, setPage] = useState<DatasetHistoryPage | null>(null), [busy, setBusy] = useState(false);
  const alive = useRef(true), request = useRef<AbortController | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  async function load(beforeRevision?: number) {
    if (!alive.current) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const result = DatasetHistoryPage.parse(await props.onLoad({ workspaceId: props.workspaceId, datasetId: props.datasetId, beforeRevision, limit: 50 }, controller.signal));
      if (result.datasetId !== props.datasetId || result.entries.some((row, index) => row.revision >= (index ? result.entries[index - 1]!.revision : beforeRevision ?? Number.MAX_SAFE_INTEGER)) || result.nextBeforeRevision !== null && result.nextBeforeRevision !== result.entries.at(-1)?.revision) throw Error("The Collection returned an invalid history page.");
      if (alive.current && !controller.signal.aborted) setPage(result);
    } catch (error) { if (alive.current && !controller.signal.aborted) { setPage(null); props.onError("dohc could not load Collection history.", error, () => { void load(beforeRevision); }); } }
    finally { if (alive.current && !controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => { void load(); }, [props.refreshVersion]);
  return <Overlay onClose={props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Collection history", className: "dohc-elevated dohc-pop-in flex max-h-[85vh] w-[min(720px,92vw)] flex-col gap-4 rounded-xl border border-line bg-panel p-5 text-ink" }}>
    <div className="flex items-center justify-between gap-3"><h2 className="m-0 flex min-w-0 items-center gap-2 text-sm font-semibold"><HistoryIcon size={16} strokeWidth={1.9} aria-hidden /><span className="truncate">History · {props.name}</span></h2><SecondaryButton onClick={props.onClose}>Close</SecondaryButton></div>
    <div className="flex items-center justify-between text-[12px] text-muted"><span>Saved changes</span><span>Newest first</span></div>
    <p className="m-0 text-[11px] text-muted">Reads and refused requests do not appear here.</p>
    {props.pendingUndo && <div className="flex items-center gap-2 text-[12px] text-muted"><span>{props.undoBusy ? "Reversing edit…" : "Undo not confirmed"}</span>{!props.undoBusy && <SecondaryButton onClick={() => props.onUndo?.(props.pendingUndo!)}>Try again</SecondaryButton>}</div>}
    {busy && <p role="status" className="m-0 text-[12px] text-muted">Loading history…</p>}
    {page && !page.entries.length && <p className="m-0 text-[13px] text-muted">No saved operations on this page. Refresh to check for changes.</p>}
    <div className="min-h-0 overflow-auto">{page?.entries.map(entry => <details key={entry.revision} className="group/entry border-b border-line py-3"><summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 rounded-md text-[13px] [&::-webkit-details-marker]:hidden"><ChevronRight size={14} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted group-open/entry:rotate-90" /><span className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted" title="Revision">{entry.revision}</span><span className="font-medium">{entry.operation}</span>{entry.attachmentCount > 0 && <span className="flex items-center gap-1 font-mono text-[11px] text-muted" title="Attached files"><Paperclip size={12} strokeWidth={1.9} aria-hidden />{entry.attachmentCount}</span>}{entry.recordedAtMs !== null && <time className="ml-auto text-[12px] text-muted" dateTime={new Date(entry.recordedAtMs).toISOString()}>{new Date(entry.recordedAtMs).toLocaleString()}</time>}</summary>
      {entry.schema && <CollectionHistoryRevisionDetails beforeHash={entry.schema.previousRevisionHash} afterHash={entry.schema.revisionHash}
        onEditFields={props.onEditFields} onLoadRevision={props.onLoadRevision} onRestoreRevision={props.onRestoreRevision} onReviewSource={props.onReviewSource} onOpenSource={props.onOpenSource} onError={props.onError} />}
      {entry.undo && props.onUndo && <div className="my-3 rounded-lg border border-line bg-bg p-3 text-[12px]"><p className="m-0 text-muted">Previous values · Record {entry.undo.recordId}</p><dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2">{entry.undo.fields.map(field => <div key={field.fieldId} className="contents"><dt className="text-muted">{field.name}</dt><dd className="m-0 whitespace-pre-wrap break-all font-mono">{JSON.stringify(field.value)}</dd></div>)}</dl><div className="flex flex-wrap items-center justify-between gap-3"><span className="max-w-80 text-muted">Undo restores the shown values only if the record has not changed since that edit.</span><SecondaryButton className="flex items-center gap-1.5" disabled={busy || props.undoBusy || props.pendingUndo != null} onClick={() => {
        const reverse = entry.undo!;
        props.onUndo?.({ workspaceId: props.workspaceId, datasetId: props.datasetId, revision: reverse.revision, revisionSha256: reverse.revisionSha256,
          operationId: reverse.operationId, idempotencyKey: crypto.randomUUID(), input: { id: reverse.recordId, expectedVersion: reverse.expectedVersion, values: Object.fromEntries(reverse.fields.map(field => [field.fieldId, field.value])) } });
      }}><Undo2 size={14} strokeWidth={1.9} aria-hidden />Undo edit</SecondaryButton></div></div>}
      <details className="mt-3"><summary className="cursor-pointer text-[12px] text-muted">Technical details</summary><dl className="mb-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]"><dt className="text-muted">Caller reference</dt><dd className="m-0 break-all font-mono">{entry.callerReference ?? "Not recorded"}</dd><dt className="text-muted">Approved rules</dt><dd className="m-0 break-all font-mono">{entry.approvedRevisionHash}</dd><dt className="text-muted">Change size</dt><dd className="m-0">{entry.changesetBytes.toLocaleString()} bytes</dd><dt className="text-muted">Attached files</dt><dd className="m-0">{entry.attachmentCount}</dd></dl></details>
    </details>)}</div>
    <div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={() => void load()}>Refresh</SecondaryButton><SecondaryButton disabled={busy || !page?.nextBeforeRevision} onClick={() => { if (page?.nextBeforeRevision) void load(page.nextBeforeRevision); }}>Older operations</SecondaryButton></div>
  </Overlay>;
}
