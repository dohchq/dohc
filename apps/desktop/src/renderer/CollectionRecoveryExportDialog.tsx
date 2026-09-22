import { useEffect, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";

export function CollectionRecoveryExportDialog(props: {
  collectionName: string;
  onExport(signal: AbortSignal): Promise<string | null>;
  onSaved(path: string): void;
  onClose(): void;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}) {
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  async function save() {
    const signal = lifetime.current.signal;
    if (busy || signal.aborted) return;
    setBusy(true);
    try {
      const path = await props.onExport(signal);
      if (signal.aborted) return;
      if (path) { props.onSaved(path); props.onClose(); }
    } catch (error) {
      if (!signal.aborted) props.onError("Could not export this Collection.", error, () => { void save(); });
    } finally { if (!signal.aborted) setBusy(false); }
  }
  return <Overlay onClose={busy ? undefined : props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-labelledby": "collection-recovery-export-title" }}>
    <div className="dohc-elevated w-110 max-w-[85vw] rounded-xl border border-line bg-panel p-5">
      <h2 id="collection-recovery-export-title" className="m-0 text-sm font-semibold text-ink">Export {props.collectionName}?</h2>
      <p className="text-[13px] text-muted">This recovery file includes every table, private records, uploads, source, history, and retry credentials. Store it privately.</p>
      <p className="text-[13px] text-muted">Choose a location outside shared folders.</p>
      <div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={props.onClose}>Cancel</SecondaryButton><PrimaryButton disabled={busy} onClick={() => { void save(); }}>{busy ? "Exporting…" : "Save recovery file"}</PrimaryButton></div>
    </div>
  </Overlay>;
}
