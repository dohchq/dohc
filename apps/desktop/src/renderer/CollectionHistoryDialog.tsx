import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
    <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-sm font-semibold">History · {props.name}</h2><SecondaryButton onClick={props.onClose}>Close</SecondaryButton></div>
    <p className="m-0 text-[12px] text-muted">Saved changes, newest first. Reads and refused requests do not appear here.</p>
    <p className="m-0 text-[12px] text-muted">Undo restores the shown values only if the record has not changed since that edit.</p>
    {props.pendingUndo && <div className="flex items-center gap-2 text-[12px] text-muted"><span>{props.undoBusy ? "Reversing edit…" : "Undo not confirmed"}</span>{!props.undoBusy && <SecondaryButton onClick={() => props.onUndo?.(props.pendingUndo!)}>Try again</SecondaryButton>}</div>}
    {busy && <p role="status" className="m-0 text-[12px] text-muted">Loading history…</p>}
    {page && !page.entries.length && <p className="m-0 text-[13px] text-muted">No saved operations on this page. Refresh to check for changes.</p>}
    <div className="min-h-0 overflow-auto">{page?.entries.map(entry => <details key={entry.revision} className="border-b border-line py-3"><summary className="flex cursor-pointer flex-wrap items-baseline gap-3 text-[13px]"><span className="font-mono text-[12px] text-muted">{entry.revision}</span><span>{entry.operation}</span>{entry.recordedAtMs !== null && <time className="ml-auto text-[12px] text-muted" dateTime={new Date(entry.recordedAtMs).toISOString()}>{new Date(entry.recordedAtMs).toLocaleString()}</time>}</summary><dl className="mb-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]"><dt className="text-muted">Caller reference</dt><dd className="m-0 break-all font-mono">{entry.callerReference ?? "Not recorded"}</dd><dt className="text-muted">Approved rules</dt><dd className="m-0 break-all font-mono">{entry.approvedRevisionHash}</dd><dt className="text-muted">Change size</dt><dd className="m-0">{entry.changesetBytes.toLocaleString()} bytes</dd><dt className="text-muted">Attached files</dt><dd className="m-0">{entry.attachmentCount}</dd></dl>
      {entry.schema && <CollectionHistoryRevisionDetails beforeHash={entry.schema.previousRevisionHash} afterHash={entry.schema.revisionHash}
        onEditFields={props.onEditFields} onLoadRevision={props.onLoadRevision} onRestoreRevision={props.onRestoreRevision} onReviewSource={props.onReviewSource} onOpenSource={props.onOpenSource} onError={props.onError} />}
      {entry.undo && props.onUndo && <div className="mt-3 space-y-2 text-[12px]"><p className="m-0 text-muted">Previous values · Record {entry.undo.recordId}</p><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">{entry.undo.fields.map(field => <div key={field.fieldId} className="contents"><dt>{field.name}</dt><dd className="m-0 whitespace-pre-wrap break-all font-mono">{JSON.stringify(field.value)}</dd></div>)}</dl><SecondaryButton disabled={busy || props.undoBusy || props.pendingUndo != null} onClick={() => {
        const reverse = entry.undo!;
        props.onUndo?.({ workspaceId: props.workspaceId, datasetId: props.datasetId, revision: reverse.revision, revisionSha256: reverse.revisionSha256,
          operationId: reverse.operationId, idempotencyKey: crypto.randomUUID(), input: { id: reverse.recordId, expectedVersion: reverse.expectedVersion, values: Object.fromEntries(reverse.fields.map(field => [field.fieldId, field.value])) } });
      }}>Undo edit</SecondaryButton></div>}
    </details>)}</div>
    <div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={() => void load()}>Refresh</SecondaryButton><SecondaryButton disabled={busy || !page?.nextBeforeRevision} onClick={() => { if (page?.nextBeforeRevision) void load(page.nextBeforeRevision); }}>Older operations</SecondaryButton></div>
  </Overlay>;
}
