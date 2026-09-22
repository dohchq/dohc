import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DatasetPendingAttemptsPage } from "@dohc/cli/dataset";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";

type PendingResponseEntry = DatasetPendingAttemptsPage["entries"][number];
export type PendingResponsesPage = DatasetPendingAttemptsPage;
export interface CollectionPendingResponsesDialogProps {
  workspaceId: string; datasetId: string; name: string;
  onLoad(input: { workspaceId: string; datasetId: string; after?: number; limit: number }, signal: AbortSignal): Promise<PendingResponsesPage>;
  onReconcile(input: { workspaceId: string; datasetId: string; reference: string; acknowledge: true }, signal: AbortSignal): Promise<{ cleared: true }>;
  onClose(): void; onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}
export function CollectionPendingResponsesDialog(props: CollectionPendingResponsesDialogProps) { return <Pending key={`${props.workspaceId}:${props.datasetId}`} {...props} />; }
function Pending(props: CollectionPendingResponsesDialogProps) {
  const [page, setPage] = useState<PendingResponsesPage | null>(null), [busy, setBusy] = useState(false), [selected, setSelected] = useState<PendingResponseEntry | null>(null);
  const alive = useRef(true), request = useRef<AbortController | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  async function load(after?: number) {
    if (!alive.current) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const result = DatasetPendingAttemptsPage.parse(await props.onLoad({ workspaceId: props.workspaceId, datasetId: props.datasetId, ...(after === undefined ? {} : { after }), limit: 50 }, controller.signal));
      if (result.datasetId !== props.datasetId || result.nextAfter !== null && result.nextAfter <= (after ?? 0)) throw Error("The Collection returned an invalid pending response page.");
      if (alive.current && !controller.signal.aborted) setPage(result);
    } catch (error) { if (alive.current && !controller.signal.aborted) props.onError("dohc could not load pending responses.", error, () => { void load(after); }); }
    finally { if (alive.current && !controller.signal.aborted) setBusy(false); }
  }
  async function reconcile() {
    if (!selected || selected.outcome !== "committed" || busy || !alive.current) return;
    const entry = selected; request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const result = await props.onReconcile({ workspaceId: props.workspaceId, datasetId: props.datasetId, reference: entry.reference, acknowledge: true }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (result.cleared !== true) throw Error("dohc could not confirm the cleared retry.");
      setSelected(null); await load();
    }
    catch (error) { if (alive.current && !controller.signal.aborted) props.onError("dohc could not clear this pending response.", error, () => { if (alive.current) setSelected(entry); }); }
    finally { if (alive.current && !controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => { void load(); return () => request.current?.abort(); }, []);
  return <Overlay onClose={props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Pending responses", className: "dohc-elevated dohc-pop-in flex max-h-[85vh] w-[min(720px,92vw)] flex-col gap-4 rounded-xl border border-line bg-panel p-5 text-ink" }}>
    <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-sm font-semibold">Pending responses · {props.name}</h2><SecondaryButton onClick={props.onClose}>Close</SecondaryButton></div>
    <p className="m-0 text-[12px] text-muted">These responses may have been saved before the participant lost confirmation. Review each result before clearing its retry.</p>
    {busy && <p role="status" className="m-0 text-[12px] text-muted">{selected ? "Clearing retry…" : "Loading pending responses…"}</p>}
    {page && !page.entries.length && <p className="m-0 text-[13px] text-muted">No pending responses. Refresh to check for changes.</p>}
    <div className="min-h-0 overflow-auto">{page?.entries.map(entry => <div key={entry.reference} className="border-b border-line py-3">
      <div className="flex flex-wrap items-baseline gap-3 text-[13px]"><span>{entry.operation}</span><span className={entry.outcome === "committed" ? "text-success" : "text-warning"}>{entry.outcome === "committed" ? "Saved" : "Unconfirmed"}</span>{entry.recordedAtMs !== null && <time className="ml-auto text-[12px] text-muted" dateTime={new Date(entry.recordedAtMs).toISOString()}>{new Date(entry.recordedAtMs).toLocaleString()}</time>}</div>
      <p className="m-0 mt-1 text-[12px] text-muted">{entry.outcome === "committed" ? `Saved in revision ${entry.revision}.` : "No saved result is confirmed yet."}{entry.attachmentCount ? ` ${entry.attachmentCount} attached file${entry.attachmentCount === 1 ? "" : "s"}.` : ""}</p>
      <div className="mt-2 flex justify-end">{entry.outcome === "committed" ? <SecondaryButton disabled={busy} onClick={() => setSelected(entry)}>Clear retry</SecondaryButton> : <span className="text-[12px] text-muted">Retry in the original app</span>}</div>
    </div>)}</div>
    <div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={() => void load()}>Refresh</SecondaryButton><SecondaryButton disabled={busy || !page?.nextAfter} onClick={() => { if (page?.nextAfter) void load(page.nextAfter); }}>More responses</SecondaryButton></div>
    {selected && <Overlay onClose={() => { if (!busy) setSelected(null); }} panelProps={{ role: "alertdialog", "aria-modal": true, "aria-label": "Clear pending response", className: "dohc-elevated dohc-pop-in flex w-[min(480px,92vw)] flex-col gap-4 rounded-xl border border-line bg-panel p-5 text-ink" }}>
      <h2 className="m-0 text-sm font-semibold">Clear retry for {selected.operation}?</h2><p className="m-0 text-[13px] text-muted">The response is saved. The participant may not have seen its confirmation. Clearing lets them submit again. This cannot be undone.</p>
      <div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={() => setSelected(null)}>Keep retry</SecondaryButton><PrimaryButton disabled={busy} onClick={() => void reconcile()}>Clear retry</PrimaryButton></div>
    </Overlay>}
  </Overlay>;
}
