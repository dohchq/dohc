import { useEffect, useRef, useState } from "react";
import { Archive as ArchiveIcon } from "lucide-react";
import type { DatasetLifecyclePage } from "@dohc/cli/dataset";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { ConfirmActions, ConfirmationCard, ConfirmationHead, FOCUS_RING, onDialogKeyDown } from "./ui/ConfirmDialog";
import { CollectionAffectedApps } from "./CollectionAffectedApps";

interface Props {
  workspaceId: string; datasetId: string; datasetPath: string; name: string;
  onClose(): void;
  onChanged(): void;
  onError(message: string, error: unknown, retry?: (() => void) | null): void;
}
export function CollectionArchiveDialog(props: Props) {
  return <Archive key={`${props.workspaceId}:${props.datasetId}`} {...props} />;
}
function Archive(props: Props) {
  const [page, setPage] = useState<DatasetLifecyclePage | null>(null), [busy, setBusy] = useState(false), [failed, setFailed] = useState<{ after?: string } | null>(null);
  const alive = useRef(true), request = useRef(0), locked = useRef(false);
  const scope = { workspaceId: props.workspaceId, datasetPath: props.datasetPath, expectedDatasetId: props.datasetId };
  async function load(after?: string) {
    if (!alive.current || locked.current) return;
    const token = ++request.current; setBusy(true);
    try {
      const result = await bridge().dataset({ ...scope, action: "lifecycle", after, limit: 50 });
      if (!alive.current || request.current !== token) return;
      if (result.kind !== "lifecycle") throw Error("dohc could not read the affected apps. Try again.");
      setPage(result); setFailed(null);
    } catch (error) { if (alive.current && request.current === token) { setPage(null); setFailed({ after }); props.onError("Could not read the affected apps.", error, () => { void load(after); }); } }
    finally { if (alive.current && request.current === token) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; request.current++; }; }, []);
  async function archive() {
    if (!alive.current || locked.current || !page) return;
    locked.current = true; const token = ++request.current; setBusy(true);
    try {
      const result = await bridge().dataset({ ...scope, action: "archive" });
      if (!alive.current || request.current !== token) return;
      if (result.kind !== "lifecycle-updated" || !result.archived) throw Error("dohc could not confirm the archive. Refresh the Collection.");
      props.onChanged(); props.onClose();
    } catch (error) { if (alive.current && request.current === token) props.onError("Could not archive this Collection.", error, () => { void archive(); }); }
    finally { locked.current = false; if (alive.current && request.current === token) setBusy(false); }
  }
  const archiving = busy && locked.current;
  return <Overlay onClose={archiving ? undefined : props.onClose} panelProps={{ onKeyDown: onDialogKeyDown }}>
    <ConfirmationCard icon={ArchiveIcon} labelledBy="archive-collection-title" describedBy="archive-collection-body">
      {/* The apps continue the first sentence, so they sit closer than the other parts. */}
      <div className="flex flex-col gap-3">
        <ConfirmationHead titleId="archive-collection-title" bodyId="archive-collection-body" title={`Archive ${props.name}?`}>
          <p>Apps will stop reading and changing this Collection. Records and files stay saved. Restore it from archived Collections to use it again.</p>
        </ConfirmationHead>
        <CollectionAffectedApps page={page} failed={failed !== null} busy={busy} loadingLabel="Loading apps…" retryTestId="collection-archive-apps-retry"
          onRetry={() => void load(failed?.after)} onMore={after => void load(after)} />
      </div>
      <ConfirmActions>
        <SecondaryButton className={FOCUS_RING} disabled={archiving} onClick={props.onClose}>Cancel</SecondaryButton>
        <PrimaryButton className={FOCUS_RING} disabled={busy || !page} onClick={() => void archive()}>{archiving ? "Archiving…" : "Archive"}</PrimaryButton>
      </ConfirmActions>
    </ConfirmationCard>
  </Overlay>;
}
