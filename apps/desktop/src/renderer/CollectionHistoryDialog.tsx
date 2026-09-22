import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DatasetHistoryPage } from "@dohc/cli/dataset";
import { Overlay } from "./Overlay";
import { SecondaryButton } from "./ui/controls";

export interface CollectionHistoryDialogProps {
  workspaceId: string;
  datasetId: string;
  name: string;
  onLoad(input: { workspaceId: string; datasetId: string; beforeRevision?: number; limit: number }, signal: AbortSignal): Promise<DatasetHistoryPage>;
  onClose(): void;
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
    } catch (error) { if (alive.current && !controller.signal.aborted) props.onError("dohc could not load Collection history.", error, () => { void load(beforeRevision); }); }
    finally { if (alive.current && !controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <Overlay onClose={props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Collection history", className: "dohc-elevated dohc-pop-in flex max-h-[85vh] w-[min(720px,92vw)] flex-col gap-4 rounded-xl border border-line bg-panel p-5 text-ink" }}>
    <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-sm font-semibold">History · {props.name}</h2><SecondaryButton onClick={props.onClose}>Close</SecondaryButton></div>
    <p className="m-0 text-[12px] text-muted">Saved operations, newest first. Reads, refused requests, and schema changes do not appear here.</p>
    <p className="m-0 text-[12px] text-muted">Caller references identify the same caller and app. Names and record contents are not stored in this history view.</p>
    {busy && <p role="status" className="m-0 text-[12px] text-muted">Loading history…</p>}
    {page && !page.entries.length && <p className="m-0 text-[13px] text-muted">No saved operations on this page. Refresh to check for changes.</p>}
    <div className="min-h-0 overflow-auto">{page?.entries.map(entry => <details key={entry.revision} className="border-b border-line py-3"><summary className="flex cursor-pointer flex-wrap items-baseline gap-3 text-[13px]"><span className="font-mono text-[12px] text-muted">{entry.revision}</span><span>{entry.operation}</span><time className="ml-auto text-[12px] text-muted" dateTime={new Date(entry.recordedAtMs).toISOString()}>{new Date(entry.recordedAtMs).toLocaleString()}</time></summary><dl className="mb-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]"><dt className="text-muted">Caller reference</dt><dd className="m-0 break-all font-mono">{entry.callerReference}</dd><dt className="text-muted">Approved rules</dt><dd className="m-0 break-all font-mono">{entry.approvedRevisionHash}</dd><dt className="text-muted">Change size</dt><dd className="m-0">{entry.changesetBytes.toLocaleString()} bytes</dd><dt className="text-muted">Attached files</dt><dd className="m-0">{entry.attachmentCount}</dd></dl></details>)}</div>
    <div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={() => void load()}>Refresh</SecondaryButton><SecondaryButton disabled={busy || !page?.nextBeforeRevision} onClick={() => { if (page?.nextBeforeRevision) void load(page.nextBeforeRevision); }}>Older operations</SecondaryButton></div>
  </Overlay>;
}
