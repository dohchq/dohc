import { useCallback, useEffect, useRef, useState } from "react";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { DatasetCopyStatus } from "@dohc/cli/dataset";
import { CollectionTableViewsControl } from "./CollectionTableViewsControl";
import type { CollectionTableView } from "./collectionTableViews";
import { bridge } from "./bridge";
import { TransactionalCollectionPage, type TransactionalInvoke } from "./TransactionalCollectionPage";
import { CollectionActionDialog } from "./CollectionActionDialog";
import { CollectionPermissionsDialog } from "./CollectionPermissionsDialog";
import { CollectionRecoveryExportDialog } from "./CollectionRecoveryExportDialog";
import { CollectionPendingResponsesDialog } from "./CollectionPendingResponsesDialog";
import { SecondaryButton } from "./ui/controls";
import { CreateDatasetFormDialog } from "./CreateDatasetFormDialog";
import { DeleteCollectionRecordDialog } from "./DeleteCollectionRecordDialog";
import { CollectionMigrationReviewDialog } from "./CollectionMigrationReviewDialog";
import type { MigrationDataPreviewProps } from "./CollectionMigrationDataPreview";
import { DatasetTransferDialog } from "./DatasetTransferDialog";
import { CollectionHistoryDialog } from "./CollectionHistoryDialog";
import { CollectionFieldsDialog } from "./CollectionFieldsDialog";
import { CollectionArchiveDialog } from "./CollectionArchiveDialog";
import { CollectionDeleteDialog } from "./CollectionDeleteDialog";
import { display, parsePage, type TransactionalRow } from "./transactionalCollectionModel";

export interface ConnectedTransactionalCollectionProps {
  owner?: boolean;
  workspaceId: string;
  datasetId: string;
  tableId: string;
  onError(fallback: string, error: unknown, retry?: (() => void) | null): void;
  onFormCreated(appRoot: string): void;
  onLifecycleChanged?(): void;
  onNotice?(message: string): void;
}
export function ConnectedTransactionalCollection(props: ConnectedTransactionalCollectionProps) {
  return <ScopedCollection key={`${props.workspaceId}:${props.datasetId}:${props.tableId}`} {...props} />;
}
function ScopedCollection({ workspaceId, datasetId, tableId, onError, onFormCreated, onLifecycleChanged, onNotice, owner = true }: ConnectedTransactionalCollectionProps) {
  const [dataset, setDataset] = useState<DatasetDescription | null>(null);
  const [activeView, setActiveView] = useState<CollectionTableView | null>(null);
  const [copy, setCopy] = useState<DatasetCopyStatus | undefined>();
  const [loading, setLoading] = useState(true);
  const [creatingForm, setCreatingForm] = useState(false);
  const [reviewingSchema, setReviewingSchema] = useState(false);
  const [transferringCsv, setTransferringCsv] = useState(false);
  const [viewingHistory, setViewingHistory] = useState(false);
  const [viewingPending, setViewingPending] = useState(false);
  const [editingFields, setEditingFields] = useState(false);
  const [customAction, setCustomAction] = useState<string | null>(null);
  const [managingAccess, setManagingAccess] = useState(false);
  const [exportingRecovery, setExportingRecovery] = useState(false);
  const [archiving, setArchiving] = useState(false), [restoring, setRestoring] = useState(false);
  const [deletingCollection, setDeletingCollection] = useState(false), [deleted, setDeleted] = useState(false);
  const restoreLock = useRef(false);
  const [recordsVersion, setRecordsVersion] = useState(0);
  const [deletion, setDeletion] = useState<TransactionalRow | null>(null);
  const deleteResult = useRef<((confirmed: boolean) => void) | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true);
    try {
      const result = await bridge().dataset({ workspaceId, datasetId, action: "describe", ...(owner ? { includeArchived: true } : {}) });
      if (sequence !== request.current) return;
      if (result.kind !== "description") throw Error("dohc could not read this Collection. Try again.");
      setDataset(result.dataset);
      setCopy(result.copy);
      setRecordsVersion(value => value + 1);
    } catch (error) {
      if (sequence !== request.current) return;
      setRecordsVersion(value => value + 1);
      onError("Could not open this Collection.", error, () => { void refresh(); });
    } finally { if (sequence === request.current) setLoading(false); }
  }, [workspaceId, datasetId, onError, owner]);
  useEffect(() => { void refresh(); return () => { request.current++; deleteResult.current?.(false); deleteResult.current = null; }; }, [refresh]);
  const loadMigrationPreview: MigrationDataPreviewProps["onLoad"] = async (input, signal) => {
    signal.throwIfAborted();
    const result = await bridge().dataset({ ...input, action: "migrationPreviewPage" });
    signal.throwIfAborted();
    if (result.kind !== "migration-preview-page") throw Error("dohc could not read the data preview. Prepare this review again.");
    const { kind: _, ...page } = result;
    return page;
  };
  const invoke = async (input: TransactionalInvoke, signal: AbortSignal) => {
    const sequence = request.current;
    signal.throwIfAborted();
    const result = await bridge().dataset({ ...input, action: "invoke" });
    signal.throwIfAborted();
    if (result.kind === "refused") throw Object.assign(new Error(result.message), { code: "operation_refused", refusal: { code: result.code, message: result.message } });
    if (result.kind !== "invoked") throw Error("dohc could not confirm the Collection action. Try again.");
    if (sequence === request.current) setCopy(result.copy);
    return result;
  };
  async function exportRecovery(signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await bridge().dataset({ action: "export", workspaceId, datasetId });
    signal.throwIfAborted();
    if (result.kind !== "exported") throw Error("dohc could not save this recovery file. Try again.");
    return result.savedPath;
  }
  if (deleted) return <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">Collection deleted</div>;
  if (!dataset) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
    <span className="text-sm text-muted">{loading ? "Opening collection…" : "Open this collection to see its records."}</span>
    {!loading && <SecondaryButton onClick={() => { void refresh(); }}>Try again</SecondaryButton>}
  </div>;
  async function restore() {
    if (restoreLock.current || !owner || copy?.offline) return;
    restoreLock.current = true; const sequence = request.current; setRestoring(true);
    try {
      const result = await bridge().dataset({ workspaceId, datasetId, action: "restore" });
      if (sequence !== request.current) return;
      if (result.kind !== "lifecycle-updated" || result.archived) throw Error("dohc could not confirm the restore. Refresh the Collection.");
      setRestoring(false); onLifecycleChanged?.(); await refresh();
    } catch (error) { if (sequence === request.current) onError("Could not restore this Collection.", error, () => { void restore(); }); }
    finally { restoreLock.current = false; if (sequence === request.current) setRestoring(false); }
  }
  if (dataset.archived) return <><div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
    <h2 className="m-0 text-sm font-semibold text-ink">{dataset.name} is archived</h2>
    <p className="m-0 text-sm text-muted">Records and files are saved. Restore the Collection to use them.</p>
    {copy?.offline && <p role="status" className="m-0 text-[12px] text-muted">Offline copy · Connect to restore this Collection.</p>}
    {owner && <SecondaryButton disabled={restoring || copy?.offline} onClick={() => void restore()}>{restoring ? "Restoring…" : "Restore Collection"}</SecondaryButton>}
    <SecondaryButton disabled={loading || restoring} onClick={() => void refresh()}>Refresh</SecondaryButton>
    {owner && !copy?.offline && <SecondaryButton className="text-danger" disabled={loading || restoring} onClick={() => setDeletingCollection(true)}>Delete permanently…</SecondaryButton>}
  </div>{deletingCollection && owner && !copy?.offline && <CollectionDeleteDialog workspaceId={workspaceId} datasetId={datasetId} name={dataset.name}
    onClose={() => setDeletingCollection(false)} onError={onError} onExport={exportRecovery} onSaved={path => onNotice?.(`Saved recovery file: ${path}`)}
    onDeleted={() => { request.current++; setDeletingCollection(false); setDeleted(true); onLifecycleChanged?.(); onNotice?.("Collection deleted"); }}
    onLoad={async (input, signal) => {
      signal.throwIfAborted();
      const result = await bridge().dataset({ ...input, action: "deletePreview" });
      signal.throwIfAborted();
      if (result.kind !== "delete-preview") throw Error("dohc could not read the deletion preview. Try again.");
      return result;
    }} onDelete={async (input, signal) => {
      signal.throwIfAborted();
      const result = await bridge().dataset({ ...input, action: "delete" });
      signal.throwIfAborted();
      if (result.kind !== "deleted") throw Error("dohc could not confirm deletion. Refresh the Collection.");
      return result;
    }} />}</>;
  return <><TransactionalCollectionPage recordsVersion={recordsVersion} workspaceId={workspaceId} dataset={dataset} tableId={tableId} onError={onError} onNotice={onNotice}
    activeView={owner ? activeView : null}
    viewControls={owner ? disabled => <CollectionTableViewsControl disabled={disabled} workspaceId={workspaceId} dataset={dataset} tableId={tableId} onSelect={setActiveView} onError={onError} /> : undefined}
    copy={copy}
    onRefresh={() => { void refresh(); }}
    onArchive={owner && !copy?.offline ? () => setArchiving(true) : undefined}
    onCreateForm={owner && !copy?.offline ? () => setCreatingForm(true) : undefined}
    onTransferCsv={owner && !copy?.offline ? () => setTransferringCsv(true) : undefined}
    onHistory={owner && !copy?.offline ? () => setViewingHistory(true) : undefined}
    onPendingResponses={owner && !copy?.offline ? () => setViewingPending(true) : undefined}
    onReviewSchema={owner && !copy?.offline ? () => setEditingFields(true) : undefined}
    onManageAccess={owner && !copy?.offline ? () => setManagingAccess(true) : undefined}
    onExportRecovery={owner && !copy?.offline ? () => setExportingRecovery(true) : undefined}
    onCustomAction={setCustomAction}
    confirmDelete={row => new Promise(resolve => { deleteResult.current?.(false); deleteResult.current = resolve; setDeletion(row); })}
    uploadFile={async ({ file, ...input }, signal) => {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal.throwIfAborted();
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
      const result = await bridge().dataset({ ...input, action: "upload", name: file.name, contentType: file.type, bytesBase64: btoa(binary) });
      signal.throwIfAborted();
      if (result.kind !== "uploaded") throw Error("dohc could not confirm the file upload. Try again.");
      return result.file;
    }}
    readFile={async (input, signal) => {
      signal.throwIfAborted();
      const result = await bridge().dataset({ ...input, action: "file" });
      signal.throwIfAborted();
      if (result.kind !== "file") throw Error("dohc could not read the file. Try again.");
      return result;
    }}
    resolveRelation={async (input, signal) => {
      signal.throwIfAborted();
      const relation = dataset.tables.flatMap(table => table.fields).find(field => field.fieldId === input.fieldId)?.relation;
      if (!relation || relation.datasetId !== datasetId) throw Error("This related Collection is unavailable.");
      const target = dataset.tables.find(table => table.tableId === relation.tableId);
      const read = dataset.operations.find(operation => operation.tableId === relation.tableId && operation.kind === "read" && operation.readOnly && operation.fieldIds.includes(relation.fieldId));
      if (!target || !read) throw Error("This related Collection has no permitted read action.");
      const response = await bridge().dataset({ action: "invoke", workspaceId, datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256,
        operationId: read.operationId, input: { limit: 20, search: input.search }, idempotencyKey: crypto.randomUUID() });
      signal.throwIfAborted();
      if (response.kind !== "invoked") throw Error("dohc could not read related records. Try again.");
      const page = parsePage(response.result, read.fieldIds);
      const label = target.fields.find(field => read.fieldIds.includes(field.fieldId) && field.fieldId !== relation.fieldId && field.type === "text");
      return { options: page.rows.map(row => {
        const value = row.values[relation.fieldId];
        if (!(typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value))) throw Error("The related Collection returned an invalid identity.");
        return { value, label: display(label ? row.values[label.fieldId] : value) || String(value) };
      }), hasMore: page.nextCursor !== null };
    }}
    invoke={invoke} />
    {viewingPending && owner && !copy?.offline && <CollectionPendingResponsesDialog workspaceId={workspaceId} datasetId={datasetId} name={dataset.name} onError={onError}
      onClose={() => setViewingPending(false)} onLoad={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "pendingAttempts" });
        signal.throwIfAborted();
        if (result.kind !== "pending-attempts") throw Error("dohc could not read pending responses. Try again.");
        const { kind: _, ...page } = result;
        return page;
      }} onReconcile={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "reconcileAttempt" });
        signal.throwIfAborted();
        if (result.kind !== "attempt-reconciled") throw Error("dohc could not confirm the cleared retry. Refresh pending responses.");
        onNotice?.("Cleared the saved response's retry");
        return result;
      }} onCancel={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "cancelAttempt" });
        signal.throwIfAborted();
        if (result.kind !== "attempt-cancelled") throw Error("dohc could not confirm cancellation. Refresh pending responses.");
        onNotice?.("Cancelled the pending response");
        return result;
      }} />}
    {archiving && <CollectionArchiveDialog workspaceId={workspaceId} datasetId={datasetId} name={dataset.name} onError={onError}
      onClose={() => setArchiving(false)} onChanged={() => { onLifecycleChanged?.(); void refresh(); }} />}
    {viewingHistory && owner && !copy?.offline && <CollectionHistoryDialog workspaceId={workspaceId} datasetId={datasetId} name={dataset.name} onError={onError}
      onUndo={invoke} onChanged={() => { setRecordsVersion(value => value + 1); onNotice?.("Reversed the edit"); }}
      onClose={() => setViewingHistory(false)} onLoad={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "history" });
        signal.throwIfAborted();
        if (result.kind !== "history") throw Error("dohc could not read this Collection's history. Try again.");
        return result;
      }} />}
    {transferringCsv && <DatasetTransferDialog workspaceId={workspaceId} dataset={dataset} tableId={tableId} invoke={invoke} onError={onError}
      onClose={() => setTransferringCsv(false)} onImported={() => setRecordsVersion(value => value + 1)}
      onSave={async (file, signal) => {
        signal.throwIfAborted();
        if (new TextEncoder().encode(file.content).byteLength > 10 * 1024 * 1024) throw Error("This file is larger than the workspace text limit. Export a smaller Collection view.");
        const sequence = request.current;
        const dot = file.name.lastIndexOf(".");
        const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
        const extension = dot > 0 ? file.name.slice(dot) : ".txt";
        const relativePath = `${stem}-${crypto.randomUUID()}${extension}`;
        const result = await bridge().createWorkspaceFile({ workspaceId, relativePath, initialText: file.content });
        signal.throwIfAborted();
        if (sequence !== request.current) throw Error("The workspace changed while saving this file.");
        return result;
      }} />}
    {managingAccess && <CollectionPermissionsDialog workspaceId={workspaceId} dataset={dataset} onClose={() => setManagingAccess(false)} onError={onError} />}
    {exportingRecovery && owner && !copy?.offline && <CollectionRecoveryExportDialog collectionName={dataset.name} onClose={() => setExportingRecovery(false)} onError={onError}
      onSaved={path => onNotice?.(`Saved recovery file: ${path}`)}
      onExport={exportRecovery} />}
    {customAction && <CollectionActionDialog workspaceId={workspaceId} dataset={dataset} operationId={customAction} invoke={invoke}
      onError={onError} onClose={() => setCustomAction(null)} onCompleted={() => setRecordsVersion(value => value + 1)} />}
    {editingFields && <CollectionFieldsDialog workspaceId={workspaceId} dataset={dataset} tableId={tableId} onError={onError}
      onLoadPreview={loadMigrationPreview}
      onClose={() => setEditingFields(false)} onReviewSource={() => { setEditingFields(false); setReviewingSchema(true); }}
      onPrepare={async (change, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ action: "prepareSchemaChange", workspaceId, datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256, change });
        signal.throwIfAborted();
        if (result.kind !== "migration-prepared") throw Error("dohc could not prepare this field change. Try again.");
        return result;
      }}
      onApprove={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "approveMigration" });
        signal.throwIfAborted();
        if (result.kind !== "migrated") throw Error("dohc could not confirm this change. Refresh the Collection.");
        await refresh();
      }}
      onDiscard={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "discardMigration" });
        signal.throwIfAborted();
        if (result.kind !== "migration-discarded") throw Error("dohc could not discard this review. Try again.");
      }} />}
    {reviewingSchema && <CollectionMigrationReviewDialog workspaceId={workspaceId} datasetId={datasetId} onError={onError}
      onLoadPreview={loadMigrationPreview}
      onClose={() => setReviewingSchema(false)}
      onPrepare={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "prepareMigration" });
        signal.throwIfAborted();
        if (result.kind !== "migration-prepared") throw Error("dohc could not prepare this change. Try again.");
        return result;
      }}
      onApprove={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "approveMigration" });
        signal.throwIfAborted();
        if (result.kind !== "migrated") throw Error("dohc could not confirm this change. Refresh the Collection.");
        await refresh();
      }}
      onDiscard={async (input, signal) => {
        signal.throwIfAborted();
        const result = await bridge().dataset({ ...input, action: "discardMigration" });
        signal.throwIfAborted();
        if (result.kind !== "migration-discarded") throw Error("dohc could not discard this review. Try again.");
      }} />}
    {deletion && <DeleteCollectionRecordDialog collectionName={dataset.tables.find(table => table.tableId === tableId)?.name ?? dataset.name} recordId={deletion.id}
      onCancel={() => { deleteResult.current?.(false); deleteResult.current = null; setDeletion(null); }}
      onConfirm={() => { deleteResult.current?.(true); deleteResult.current = null; setDeletion(null); }} />}
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
