import { useEffect, useRef, useState } from "react";
import type { DatasetRecoveryPreparation } from "@dohc/cli/dataset";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";

export function CollectionRecoveryRestoreDialog(props: {
  onPrepare(signal: AbortSignal): Promise<DatasetRecoveryPreparation | null>;
  onRestore(recovery: DatasetRecoveryPreparation, signal: AbortSignal): Promise<void>;
  onDiscard(transferId: string): Promise<void>;
  onRestored(recovery: DatasetRecoveryPreparation): void;
  onClose(): void;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}) {
  const [busy,setBusy] = useState(false), [recovery,setRecovery] = useState<DatasetRecoveryPreparation | null>(null), [stopped,setStopped] = useState(false);
  const lifetime = useRef(new AbortController()), pending = useRef<DatasetRecoveryPreparation | null>(null);
  const discard = useRef(props.onDiscard); discard.current = props.onDiscard;
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => { controller.abort(); const value=pending.current; if(value) void discard.current(value.transferId).catch(() => {}); }; },[]);
  async function choose() {
    const signal=lifetime.current.signal; if(busy||signal.aborted)return; setBusy(true);
    try { const value=await props.onPrepare(signal); if(signal.aborted) { if(value) await props.onDiscard(value.transferId); return; } pending.current=value; setRecovery(value); }
    catch(error) { if(!signal.aborted)props.onError("Could not open this recovery file.",error,() => { void choose(); }); }
    finally { if(!signal.aborted)setBusy(false); }
  }
  async function restore() {
    const signal=lifetime.current.signal; if(busy||!recovery||!stopped||signal.aborted)return; setBusy(true);
    try { await props.onRestore(recovery,signal); pending.current=null; if(!signal.aborted) { props.onRestored(recovery); props.onClose(); } }
    catch(error) { if(!signal.aborted)props.onError("Could not restore this Collection.",error,() => { void restore(); }); }
    finally { if(!signal.aborted)setBusy(false); }
  }
  async function cancel() {
    if(busy)return;
    setBusy(true);
    try { if(pending.current) await props.onDiscard(pending.current.transferId); pending.current=null; if(!lifetime.current.signal.aborted)props.onClose(); }
    catch(error) { if(!lifetime.current.signal.aborted)props.onError("Could not cancel this recovery.",error,() => { void cancel(); }); }
    finally { if(!lifetime.current.signal.aborted)setBusy(false); }
  }
  return <Overlay onClose={busy?undefined:() => { void cancel(); }} panelProps={{role:"dialog","aria-modal":true,"aria-labelledby":"collection-recovery-restore-title"}}>
    <div className="dohc-elevated w-110 max-w-[85vw] rounded-xl border border-line bg-panel p-5">
      <h2 id="collection-recovery-restore-title" className="m-0 text-sm font-semibold text-ink">Restore a Collection</h2>
      {recovery ? <>
        <p className="text-[13px] text-ink">{recovery.revision.definition.name}</p>
        <p className="text-[13px] text-muted">This restores records, uploaded files, rules, and history on this computer. Existing Collections stay unchanged.</p>
        <p className="text-[13px] text-muted">Sharing stays off. Review access before publishing apps or inviting people again.</p>
        <label className="my-4 flex items-start gap-2 text-[13px] text-ink"><input type="checkbox" checked={stopped} disabled={busy} onChange={event => setStopped(event.target.checked)} />I stopped the old host and will not restart it for this Collection.</label>
      </> : <p className="text-[13px] text-muted">Choose a private .dohc-recovery file for this workspace. Review it before restoring the Collection.</p>}
      <div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={() => { void cancel(); }}>Cancel</SecondaryButton>
        {recovery ? <PrimaryButton disabled={busy||!stopped} onClick={() => { void restore(); }}>{busy?"Restoring…":"Restore Collection"}</PrimaryButton> : <PrimaryButton disabled={busy} onClick={() => { void choose(); }}>{busy?"Checking recovery…":"Choose recovery file"}</PrimaryButton>}
      </div>
    </div>
  </Overlay>;
}
