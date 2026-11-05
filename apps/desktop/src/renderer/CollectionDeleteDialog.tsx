import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { DatasetCursor } from "@dohc/app-backend-runtime/journal";
import { Overlay } from "./Overlay";
import { DangerButton, GhostButton, SecondaryButton } from "./ui/controls";
import { CollectionAffectedApps } from "./CollectionAffectedApps";
import { CollectionRecoveryExportDialog } from "./CollectionRecoveryExportDialog";

export interface CollectionDeletePreview {
  cursor: DatasetCursor;
  reviewToken: string;
  name: string;
  archived: boolean;
  generation: number;
  reason: string;
  apps: Array<{ appId: string; binding: { operationIds: string[] } }>;
  nextCursor: string | null;
  irreversible: true;
}
export interface CollectionDeleteDialogProps {
  workspaceId: string; datasetId: string; name: string;
  /** The Collection's folder from the workspace root, or "" at the root. Delete keeps its files. */
  folder: string;
  onLoad(input: { workspaceId: string; datasetId: string; after?: string; limit: number }, signal: AbortSignal): Promise<CollectionDeletePreview>;
  onDelete(input: { workspaceId: string; datasetId: string; expected: DatasetCursor; reviewToken: string; acknowledge: true }, signal: AbortSignal): Promise<{ deleted: true; datasetId: string }>;
  onExport?(signal: AbortSignal): Promise<string | null>;
  onSaved?(path: string): void;
  onClose(): void;
  onDeleted(): void;
  onError(message: string, error: unknown, retry?: (() => void) | null): void;
}

export function CollectionDeleteDialog(props: CollectionDeleteDialogProps) {
  return <Delete key={`${props.workspaceId}:${props.datasetId}`} {...props} />;
}
function Delete(props: CollectionDeleteDialogProps) {
  const [page, setPage] = useState<CollectionDeletePreview | null>(null), [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false), [exported, setExported] = useState(false), [exporting,setExporting] = useState(false);
  const [failed, setFailed] = useState<{ after?: string } | null>(null), [details, setDetails] = useState(false), detailsId = useId();
  const alive = useRef(true), request = useRef(0), lock = useRef(false), lifetime = useRef(new AbortController());
  const scope = { workspaceId: props.workspaceId, datasetId: props.datasetId };
  async function load(after?: string) {
    if (!alive.current || lock.current) return;
    const token = ++request.current; setBusy(true);
    try {
      const result = await props.onLoad({ ...scope, after, limit: 50 }, lifetime.current.signal);
      if (!alive.current || request.current !== token) return;
      if (!result.irreversible || !/^[a-f0-9]{64}$/.test(result.reviewToken) || result.cursor.datasetId !== props.datasetId || result.cursor.workspaceId !== props.workspaceId || result.name !== props.name) throw Error("dohc returned a different Collection. Refresh it.");
      // Delete sends the first page's cursor and review token, so a later page from another state starts the review again.
      if (after && (!page || !sameCursor(result.cursor, page.cursor) || result.reviewToken !== page.reviewToken)) {
        setPage(null); setFailed(null); setAcknowledged(false);
        props.onError("This Collection changed. Check its apps again.", null, null);
        void load(); return;
      }
      setPage(result); setFailed(null); setAcknowledged(false);
    } catch (error) { if (alive.current && request.current === token && !lifetime.current.signal.aborted) {setFailed({ after });setAcknowledged(false);props.onError("Could not read the deletion preview.", error, () => { void load(after); });} }
    finally { if (alive.current && request.current === token) setBusy(false); }
  }
  useEffect(() => { alive.current = true; lifetime.current = new AbortController(); void load(); return () => { alive.current = false; request.current++; lifetime.current.abort(); }; }, []);
  async function deleteCollection() {
    if (!alive.current || lock.current || busy || exporting || !page || failed || !acknowledged) return;
    lock.current = true; const token = ++request.current; setBusy(true);
    try {
      const result = await props.onDelete({ ...scope, expected: page.cursor, reviewToken: page.reviewToken, acknowledge: true }, lifetime.current.signal);
      if (!alive.current || request.current !== token) return;
      if (!result.deleted || result.datasetId !== props.datasetId) throw Error("dohc could not confirm deletion. Refresh the Collection.");
      props.onDeleted();
    } catch (error) { if (alive.current && request.current === token && !lifetime.current.signal.aborted) {setAcknowledged(false);props.onError("Could not delete this Collection.", error, () => { void load(); });} }
    finally { lock.current = false; if (alive.current && request.current === token) setBusy(false); }
  }
  return <><Overlay appearance="warning" onClose={busy || exporting ? undefined : props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-labelledby": "delete-collection-title" }}>
    <section className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-120 max-w-[90vw] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5 text-ink">
      <h2 id="delete-collection-title" className="m-0 text-base font-semibold">Delete {props.name} permanently?</h2>
      <p className="m-0 text-[13px] text-muted">This deletes every table, record, upload, history entry, and app grant in this Collection. {props.folder ? <>The <span className="wrap-anywhere">{props.folder}</span> folder and its files stay.</> : "Its files stay."} Find them in Files.</p>
      <p className="m-0 text-[13px] text-danger">This cannot be undone on this host, even with a recovery file.</p>
      <div>
        <GhostButton className="-ml-2" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(open => !open)}>
          {details ? "Hide details" : "Details"}<ChevronDown size={12} aria-hidden className={`transition-transform ${details ? "rotate-180" : ""}`} />
        </GhostButton>
        <p id={detailsId} hidden={!details} className="m-0 mt-1 text-[13px] text-muted">Save a recovery file first to preserve a separate copy. Recovery requires another clean host with this workspace's identity. That host must never have stored or deleted this Collection.</p>
      </div>
      <CollectionAffectedApps page={page} failed={failed !== null} busy={busy} loadingLabel="Loading affected apps…" retryTestId="collection-delete-apps-retry"
        onRetry={() => void load(failed?.after)} onMore={after => void load(after)} />
      {exported&&<p className="m-0 text-[12px] text-muted">Recovery file saved</p>}
      <label className="flex items-start gap-2 text-[13px] text-ink"><input type="checkbox" checked={acknowledged} disabled={busy || !page || failed !== null} onChange={event => setAcknowledged(event.target.checked)} />I understand that dohc cannot undo this deletion.</label>
      <div className="flex items-center gap-2">
        {props.onExport && <SecondaryButton disabled={busy} onClick={() => setExporting(true)}>{exported ? "Save another recovery file" : "Save recovery file first"}</SecondaryButton>}
        <div className="ml-auto flex gap-2"><SecondaryButton disabled={busy} onClick={props.onClose}>Cancel</SecondaryButton><DangerButton disabled={busy || !page || failed !== null || !acknowledged} onClick={() => void deleteCollection()}>{lock.current ? "Deleting…" : "Delete permanently"}</DangerButton></div>
      </div>
    </section>
  </Overlay>{exporting&&props.onExport&&<CollectionRecoveryExportDialog collectionName={props.name} onExport={props.onExport} onClose={()=>setExporting(false)} onError={props.onError} onSaved={path=>{if(!alive.current)return;setExported(true);props.onSaved?.(path);}}/>}</>;
}
function sameCursor(left: DatasetCursor, right: DatasetCursor) {
  return left.workspaceId === right.workspaceId && left.datasetId === right.datasetId && left.hostEpoch === right.hostEpoch
    && left.approvedRevisionHash === right.approvedRevisionHash && left.revision === right.revision && left.digest === right.digest;
}
