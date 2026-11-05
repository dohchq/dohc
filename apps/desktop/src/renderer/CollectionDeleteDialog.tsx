import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, FileDown, Trash2 } from "lucide-react";
import type { DatasetCursor } from "@dohc/app-backend-runtime/journal";
import { Overlay } from "./Overlay";
import { modalFocusableElements } from "./modalFocus";
import { DangerButton, GhostButton, SecondaryButton } from "./ui/controls";
import { ConfirmActions, ConfirmationCard, ConfirmationHead, ConfirmEscape, FOCUS_RING, onDialogKeyDown, useOpeningFocus } from "./ui/ConfirmDialog";
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
  const [acknowledged, setAcknowledged] = useState(false), [exporting, setExporting] = useState(false);
  const [failed, setFailed] = useState<{ after?: string } | null>(null), [details, setDetails] = useState(false), detailsId = useId();
  const alive = useRef(true), request = useRef(0), lock = useRef(false), lifetime = useRef(new AbortController()), panelRef = useRef<HTMLDivElement>(null);
  // The first control: Save recovery file, which works while the apps load, or else Cancel.
  useOpeningFocus(() => panelRef.current && modalFocusableElements(panelRef.current)[0]);
  const scope = { workspaceId: props.workspaceId, datasetId: props.datasetId };
  async function load(after?: string) {
    if (!alive.current || lock.current) return;
    const token = ++request.current; setBusy(true);
    try {
      const result = await props.onLoad({ ...scope, after, limit: 50 }, lifetime.current.signal);
      if (!alive.current || request.current !== token) return;
      if (!result.irreversible || !/^[a-f0-9]{64}$/.test(result.reviewToken) || result.cursor.datasetId !== props.datasetId || result.cursor.workspaceId !== props.workspaceId || result.name !== props.name) throw Error("dohc returned a different Collection. Try again.");
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
  // Only the delete itself locks the dialog. Saving a recovery file and
  // closing both work while the apps load.
  const deleting = busy && lock.current;
  return <><Overlay onClose={deleting || exporting ? undefined : props.onClose} panelRef={panelRef} panelProps={{ onKeyDown: onDialogKeyDown }}>
    <ConfirmationCard icon={Trash2} intent="danger" labelledBy="delete-collection-title" describedBy="delete-collection-body">
      <ConfirmationHead titleId="delete-collection-title" bodyId="delete-collection-body" title={`Delete ${props.name} permanently?`}>
        <p>This deletes every table, record, upload, history entry, and app grant in this Collection. {props.folder ? <>The <span className="wrap-anywhere">{props.folder}</span> folder and its files stay.</> : "Its files stay."} Find them in Files.</p>
        <p className="text-danger">This cannot be undone on this host.</p>
      </ConfirmationHead>
      {props.onExport && <div className="flex flex-col gap-1">
        <ConfirmEscape action={<SecondaryButton size="row" className={FOCUS_RING} disabled={deleting} onClick={() => setExporting(true)}><FileDown size={13} aria-hidden />Save recovery file</SecondaryButton>}>
          A recovery file can restore it on another host.
        </ConfirmEscape>
        <div>
          <GhostButton className={`-ml-2 ${FOCUS_RING}`} aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(open => !open)}>
            {details ? "Hide details" : "Details"}<ChevronDown size={12} aria-hidden className={`transition-transform ${details ? "rotate-180" : ""}`} />
          </GhostButton>
          <p id={detailsId} hidden={!details} className="m-0 mt-1 text-[13px] text-muted">The host needs this workspace's identity and must never have stored or deleted this Collection.</p>
        </div>
      </div>}
      <CollectionAffectedApps page={page} failed={failed !== null} busy={busy} loadingLabel="Loading affected apps…" retryTestId="collection-delete-apps-retry"
        onRetry={() => void load(failed?.after)} onMore={after => void load(after)} />
      {/* The box sits close over the buttons, as the thing the confirm waits for. */}
      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-2 text-[13px] text-ink"><input type="checkbox" checked={acknowledged} disabled={busy || !page || failed !== null} onChange={event => setAcknowledged(event.target.checked)} />I understand that dohc cannot undo this deletion.</label>
        <ConfirmActions>
          <SecondaryButton className={FOCUS_RING} disabled={deleting} onClick={props.onClose}>Cancel</SecondaryButton>
          <DangerButton className={FOCUS_RING} disabled={busy || !page || failed !== null || !acknowledged} onClick={() => void deleteCollection()}>{lock.current ? "Deleting…" : "Delete permanently"}</DangerButton>
        </ConfirmActions>
      </div>
    </ConfirmationCard>
  </Overlay>{exporting&&props.onExport&&<CollectionRecoveryExportDialog collectionName={props.name} onExport={props.onExport} onClose={()=>setExporting(false)} onError={props.onError} onSaved={path=>{if(alive.current)props.onSaved?.(path);}}/>}</>;
}
function sameCursor(left: DatasetCursor, right: DatasetCursor) {
  return left.workspaceId === right.workspaceId && left.datasetId === right.datasetId && left.hostEpoch === right.hostEpoch
    && left.approvedRevisionHash === right.approvedRevisionHash && left.revision === right.revision && left.digest === right.digest;
}
