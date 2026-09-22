import { useCallback, useEffect, useRef, useState } from "react";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { bridge } from "./bridge";
import { TransactionalCollectionPage } from "./TransactionalCollectionPage";
import { SecondaryButton } from "./ui/controls";
import { CreateDatasetFormDialog } from "./CreateDatasetFormDialog";

export interface ConnectedTransactionalCollectionProps {
  workspaceId: string;
  datasetId: string;
  tableId: string;
  onError(fallback: string, error: unknown, retry?: (() => void) | null): void;
  onFormCreated(appRoot: string): void;
}
export function ConnectedTransactionalCollection(props: ConnectedTransactionalCollectionProps) {
  return <ScopedCollection key={`${props.workspaceId}:${props.datasetId}:${props.tableId}`} {...props} />;
}
function ScopedCollection({ workspaceId, datasetId, tableId, onError, onFormCreated }: ConnectedTransactionalCollectionProps) {
  const [dataset, setDataset] = useState<DatasetDescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingForm, setCreatingForm] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true);
    try {
      const result = await bridge().dataset({ workspaceId, datasetId, action: "describe" });
      if (sequence !== request.current) return;
      if (result.kind !== "description") throw Error("dohc could not read this Collection. Try again.");
      setDataset(result.dataset);
    } catch (error) {
      if (sequence !== request.current) return;
      setDataset(null);
      onError("Could not open this Collection.", error, () => { void refresh(); });
    } finally { if (sequence === request.current) setLoading(false); }
  }, [workspaceId, datasetId, onError]);
  useEffect(() => { void refresh(); return () => { request.current++; }; }, [refresh]);
  if (!dataset) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
    <span className="text-sm text-muted">{loading ? "Opening collection…" : "Open this collection to see its records."}</span>
    {!loading && <SecondaryButton onClick={() => { void refresh(); }}>Try again</SecondaryButton>}
  </div>;
  return <><TransactionalCollectionPage workspaceId={workspaceId} dataset={dataset} tableId={tableId} onError={onError}
    onCreateForm={() => setCreatingForm(true)}
    invoke={async (input, signal) => {
      signal.throwIfAborted();
      const result = await bridge().dataset({ ...input, action: "invoke" });
      signal.throwIfAborted();
      if (result.kind !== "invoked") throw Error("dohc could not confirm the Collection action. Try again.");
      return result;
    }} />
    {creatingForm && <CreateDatasetFormDialog workspaceId={workspaceId} dataset={dataset} tableId={tableId}
      onClose={() => setCreatingForm(false)} onError={onError}
      onCreate={async (input, signal) => {
        signal.throwIfAborted();
        const sequence = request.current;
        const result = await bridge().dataset({ ...input, action: "createForm", workspaceId });
        signal.throwIfAborted();
        if (sequence !== request.current) return;
        if (result.kind !== "form-created") throw Error("dohc could not confirm the form files. Try again.");
        setCreatingForm(false);
        onFormCreated(result.appRoot);
      }} />}
  </>;
}
