import { useCallback, useEffect, useRef, useState } from "react";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { bridge } from "./bridge";
import { TransactionalCollectionPage } from "./TransactionalCollectionPage";
import { SecondaryButton } from "./ui/controls";
import { CreateDatasetFormDialog } from "./CreateDatasetFormDialog";
import { DeleteCollectionRecordDialog } from "./DeleteCollectionRecordDialog";
import { CollectionMigrationReviewDialog } from "./CollectionMigrationReviewDialog";
import { display, parsePage, type TransactionalRow } from "./transactionalCollectionModel";

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
  const [reviewingSchema, setReviewingSchema] = useState(false);
  const [deletion, setDeletion] = useState<TransactionalRow | null>(null);
  const deleteResult = useRef<((confirmed: boolean) => void) | null>(null);
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
  useEffect(() => { void refresh(); return () => { request.current++; deleteResult.current?.(false); deleteResult.current = null; }; }, [refresh]);
  if (!dataset) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
    <span className="text-sm text-muted">{loading ? "Opening collection…" : "Open this collection to see its records."}</span>
    {!loading && <SecondaryButton onClick={() => { void refresh(); }}>Try again</SecondaryButton>}
  </div>;
  return <><TransactionalCollectionPage workspaceId={workspaceId} dataset={dataset} tableId={tableId} onError={onError}
    onCreateForm={() => setCreatingForm(true)}
    onReviewSchema={() => setReviewingSchema(true)}
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
    invoke={async (input, signal) => {
      signal.throwIfAborted();
      const result = await bridge().dataset({ ...input, action: "invoke" });
      signal.throwIfAborted();
      if (result.kind === "refused") throw Object.assign(new Error(result.message), { code: "operation_refused", refusal: { code: result.code, message: result.message } });
      if (result.kind !== "invoked") throw Error("dohc could not confirm the Collection action. Try again.");
      return result;
    }} />
    {reviewingSchema && <CollectionMigrationReviewDialog workspaceId={workspaceId} datasetId={datasetId} onError={onError}
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
