import { useLayoutEffect, useRef, useState } from "react";
import { CircleSlash, LoaderCircle } from "lucide-react";
import { parseAppBackendJson, APP_BACKEND_INPUT_BYTES, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";
import { Overlay } from "./Overlay";
import { inputClass } from "./collections/FieldForm";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { ipcErrorMessage } from "./ipcError";

export interface CollectionActionDialogProps {
  workspaceId: string;
  dataset: DatasetDescription;
  operationId: string;
  invoke(input: TransactionalInvoke, signal: AbortSignal): Promise<{ result: AppBackendJson }>;
  onClose(): void;
  onSettled?(): void;
}
export function CollectionActionDialog(props: CollectionActionDialogProps) {
  return <ScopedAction key={JSON.stringify([props.workspaceId, props.dataset, props.operationId])} {...props} />;
}
function ScopedAction(props: CollectionActionDialogProps) {
  const operation = props.dataset.operations.find(candidate => candidate.operationId === props.operationId && candidate.kind === "action");
  const [input, setInput] = useState("{}"), [invalid, setInvalid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<TransactionalInvoke | null>(null), [result, setResult] = useState<{ result: AppBackendJson } | null>(null);
  const [cancelled, setCancelled] = useState(false), [cancelling, setCancelling] = useState(false), [completedAfterCancel, setCompletedAfterCancel] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const alive = useRef(true), locked = useRef(false), active = useRef<AbortController | null>(null), uncertain = useRef<TransactionalInvoke | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  async function execute(request: TransactionalInvoke): Promise<void> {
    if (!alive.current || locked.current || (uncertain.current && uncertain.current !== request)) return;
    locked.current = true; uncertain.current = request; setPending(request); setBusy(true); setInvalid(null); setRefusal(null); setCancelled(false); setCancelling(false);
    const abort = new AbortController(); active.current = abort;
    try {
      const response = await props.invoke(request, abort.signal); if (!alive.current) return;
      const json = parseAppBackendJson(response.result); uncertain.current = null; setPending(null); setCompletedAfterCancel(abort.signal.aborted); setResult({ result: json });
    } catch (cause) {
      if (!alive.current) return;
      const refused = cause !== null && typeof cause === "object" && "code" in cause && cause.code === "operation_refused";
      if (refused) { uncertain.current = null; setPending(null); setRefusal(ipcErrorMessage(cause, "The Collection refused this action.")); }
      else if (abort.signal.aborted) setCancelled(true);
    } finally { if (alive.current) { active.current = null; locked.current = false; setBusy(false); setCancelling(false); props.onSettled?.(); } }
  }
  function cancelOrClose(): void {
    if (locked.current) { setCancelling(true); active.current?.abort(); }
    else props.onClose();
  }
  function submit(): void {
    if (!operation || locked.current || uncertain.current) return;
    let json: AppBackendJson;
    try { json = parseAppBackendJson(JSON.parse(input), APP_BACKEND_INPUT_BYTES); }
    catch { setInvalid("Enter valid JSON up to 64 KB."); return; }
    void execute({ workspaceId: props.workspaceId, datasetId: props.dataset.datasetId, revision: props.dataset.revision, revisionSha256: props.dataset.revisionSha256, operationId: operation.operationId, input: json, idempotencyKey: crypto.randomUUID() });
  }
  const disabled = busy || pending !== null;
  return <Overlay onClose={cancelOrClose}><form onSubmit={event => { event.preventDefault(); submit(); }} role="dialog" aria-modal="true" aria-labelledby="collection-action-title" className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-130 max-w-[85vw] flex-col gap-3 overflow-auto rounded-xl border border-line bg-panel p-5">
    <h2 id="collection-action-title" className="m-0 text-base font-semibold text-ink">{operation?.label ?? "Collection action"}</h2>
    {!operation ? <p className="m-0 text-[13px] text-muted">This action is unavailable. Close this dialog and refresh the Collection.</p> : result ? <><p role="status" className="m-0 text-[13px] text-ink">{completedAfterCancel ? "Action completed before cancellation" : "Action completed"}</p><pre aria-label="Action result" className="max-h-64 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[12px] text-ink">{JSON.stringify(result.result, null, 2)}</pre></> : <>
      <label className="text-[12px] text-muted">Advanced JSON input<textarea aria-label="Advanced JSON input" value={input} disabled={disabled} rows={9} className={`${inputClass} mt-1 font-mono`} onChange={event => { setInput(event.target.value); setInvalid(null); }} /></label>
      <p className="m-0 text-[12px] text-muted">Use the input expected by this authored action.</p>
      {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}
      {refusal ? <div role="alert" className="flex flex-col gap-2 text-[12px] text-danger"><p className="m-0">The Collection refused this action.</p><p className="m-0">{refusal}</p></div> : null}
      {pending && !busy ? <div className="flex flex-col gap-2 text-[12px] text-muted"><p role="status" className="m-0 flex items-center gap-2 text-ink">{cancelled ? <CircleSlash size={16} aria-hidden /> : null}{cancelled ? "Action cancelled" : "Action not confirmed"}</p><p className="m-0">dohc could not confirm whether it finished. It may have changed records. Check this Collection's records or History.</p></div> : null}
    </>}
    <div className="flex justify-end gap-2"><SecondaryButton disabled={cancelling} onClick={cancelOrClose}>{result || !operation || (pending && !busy) ? "Close" : "Cancel"}</SecondaryButton>{operation && !result ? pending && !busy ? <PrimaryButton onClick={() => void execute(pending)}>Try again</PrimaryButton> : <PrimaryButton type="submit" disabled={disabled} className="flex items-center gap-2">{busy ? <LoaderCircle size={16} aria-hidden className="animate-spin" /> : null}{cancelling ? "Cancelling…" : busy ? "Running…" : "Run action"}</PrimaryButton> : null}</div>
  </form></Overlay>;
}
