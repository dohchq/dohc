import { useLayoutEffect, useRef, useState } from "react";
import { parseAppBackendJson, APP_BACKEND_INPUT_BYTES, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";
import { Overlay } from "./Overlay";
import { inputClass } from "./collections/FieldForm";
import { PrimaryButton, SecondaryButton } from "./ui/controls";

export interface CollectionActionDialogProps {
  workspaceId: string;
  dataset: DatasetDescription;
  operationId: string;
  invoke(input: TransactionalInvoke, signal: AbortSignal): Promise<{ result: AppBackendJson }>;
  onClose(): void;
  onCompleted?(): void;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}
export function CollectionActionDialog(props: CollectionActionDialogProps) {
  return <ScopedAction key={JSON.stringify([props.workspaceId, props.dataset, props.operationId])} {...props} />;
}
function ScopedAction(props: CollectionActionDialogProps) {
  const operation = props.dataset.operations.find(candidate => candidate.operationId === props.operationId && candidate.kind === "action");
  const [input, setInput] = useState("{}"), [invalid, setInvalid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<TransactionalInvoke | null>(null), [result, setResult] = useState<{ result: AppBackendJson } | null>(null);
  const alive = useRef(true), locked = useRef(false), active = useRef<AbortController | null>(null), uncertain = useRef<TransactionalInvoke | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  async function execute(request: TransactionalInvoke): Promise<void> {
    if (!alive.current || locked.current || (uncertain.current && uncertain.current !== request)) return;
    locked.current = true; uncertain.current = request; setPending(request); setBusy(true); setInvalid(null);
    const abort = new AbortController(); active.current = abort;
    try {
      const response = await props.invoke(request, abort.signal); if (!alive.current || abort.signal.aborted) return;
      const json = parseAppBackendJson(response.result); uncertain.current = null; setPending(null); setResult({ result: json }); props.onCompleted?.();
    } catch (cause) {
      if (!alive.current || abort.signal.aborted) return;
      const refused = cause !== null && typeof cause === "object" && "code" in cause && cause.code === "operation_refused";
      if (refused) { uncertain.current = null; setPending(null); }
      props.onError(refused ? "The Collection refused this action." : "dohc could not confirm this action.", cause, refused ? null : () => { if (alive.current) void execute(request); });
    } finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  function submit(): void {
    if (!operation || locked.current || uncertain.current) return;
    let json: AppBackendJson;
    try { json = parseAppBackendJson(JSON.parse(input), APP_BACKEND_INPUT_BYTES); }
    catch { setInvalid("Enter valid JSON up to 64 KB."); return; }
    void execute({ workspaceId: props.workspaceId, datasetId: props.dataset.datasetId, revision: props.dataset.revision, revisionSha256: props.dataset.revisionSha256, operationId: operation.operationId, input: json, idempotencyKey: crypto.randomUUID() });
  }
  const disabled = busy || pending !== null;
  return <Overlay onClose={disabled ? undefined : props.onClose}><form onSubmit={event => { event.preventDefault(); submit(); }} role="dialog" aria-modal="true" aria-labelledby="collection-action-title" className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-130 max-w-[85vw] flex-col gap-3 overflow-auto rounded-xl border border-line bg-panel p-5">
    <h2 id="collection-action-title" className="m-0 text-sm font-semibold text-ink">{operation?.label ?? "Collection action"}</h2>
    {!operation ? <p className="m-0 text-[13px] text-muted">This action is unavailable. Close this dialog and refresh the Collection.</p> : result ? <><p role="status" className="m-0 text-[13px] text-ink">Action completed</p><pre aria-label="Action result" className="max-h-64 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[12px] text-ink">{JSON.stringify(result.result, null, 2)}</pre></> : <>
      <label className="text-[12px] text-muted">Advanced JSON input<textarea aria-label="Advanced JSON input" value={input} disabled={disabled} rows={9} className={`${inputClass} mt-1 font-mono`} onChange={event => { setInput(event.target.value); setInvalid(null); }} /></label>
      <p className="m-0 text-[12px] text-muted">Use the input expected by this authored action.</p>
      {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}
      {pending && !busy ? <div className="flex items-center gap-2 text-[12px] text-muted"><span>Action not confirmed</span><SecondaryButton onClick={() => void execute(pending)}>Try again</SecondaryButton></div> : null}
    </>}
    <div className="flex justify-end gap-2"><SecondaryButton disabled={disabled} onClick={props.onClose}>{result || !operation ? "Close" : "Cancel"}</SecondaryButton>{operation && !result ? <PrimaryButton type="submit" disabled={disabled}>{busy ? "Running…" : "Run action"}</PrimaryButton> : null}</div>
  </form></Overlay>;
}
