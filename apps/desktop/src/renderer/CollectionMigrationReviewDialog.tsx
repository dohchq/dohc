import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Minus, Pencil, Plus } from "lucide-react";
import { datasetRevisionsPreserveAccess, type DatasetRevision, type DatasetField } from "@dohc/security-contract/dataset";
import { DatasetMigrationCandidate, type DatasetMigrationPreparation } from "@dohc/cli/dataset";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass } from "./collections/FieldForm";
import { CollectionMigrationDataPreview, type MigrationDataPreviewProps } from "./CollectionMigrationDataPreview";

export type { DatasetMigrationPreparation } from "@dohc/cli/dataset";
export interface CollectionMigrationReviewDialogProps {
  workspaceId: string;
  datasetId: string;
  descriptorPath?: string;
  migrationPath?: string;
  initialPreparation?: DatasetMigrationPreparation;
  /** Native field controls prepare generated changes without asking for source paths. */
  generatedChange?: boolean;
  onClose(): void;
  onPrepare(input: { workspaceId: string; datasetId: string; descriptorPath: string; migrationPath: string }, signal: AbortSignal): Promise<DatasetMigrationPreparation>;
  onApprove(input: { workspaceId: string; preparationId: string; revisionSha256: string; approvalDigest: string }, signal: AbortSignal): Promise<void>;
  onDiscard(input: { workspaceId: string; preparationId: string }, signal: AbortSignal): Promise<void>;
  onLoadPreview: MigrationDataPreviewProps["onLoad"];
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}
type Change = { kind: "added" | "removed" | "changed"; table: string; field: string; detail: string; before?: string; after?: string };
function fieldSummary(field: DatasetField): string {
  return [field.name, field.type, field.required ? "required" : "optional", ...(field.unique ? ["unique"] : []),
    ...(Object.hasOwn(field, "default") ? [`default: ${JSON.stringify(field.default)}`] : []), ...(field.options ? [`options: ${field.options.join(", ")}`] : []),
    ...(field.relation ? [`related field: ${field.relation.fieldId}${field.relation.many ? " (many)" : ""}`] : [])].join(" · ");
}
function changedFieldSummary(before: DatasetField, after: DatasetField): { before: string; after: string } {
  const attributes = ["name", "type", "required", "unique", "default", "options", "relation", "sqlColumn"] as const;
  const labels = { name: "Name", type: "Type", required: "Required", unique: "Unique", default: "Default", options: "Options", relation: "Relation", sqlColumn: "Column" };
  const changed = attributes.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const summary = (field: DatasetField) => changed.map(key => {
    const value = field[key];
    const text = value === undefined ? "Not set" : typeof value === "boolean" ? value ? "Yes" : "No" : typeof value === "string" ? value : JSON.stringify(value);
    return `${labels[key]}: ${text}`;
  }).join("\n");
  return { before: summary(before), after: summary(after) };
}
function validPath(path: string): boolean { return isShareablePath(path) && /^[A-Za-z0-9_@./-]+$/.test(path) && path.length <= 1024; }
function matchingCandidate(preparation: DatasetMigrationPreparation, workspaceId: string, datasetId: string): boolean {
  const parsed = DatasetMigrationCandidate.safeParse(preparation.candidate);
  if (!parsed.success) return false;
  const candidate = parsed.data;
  return candidate.expected.workspaceId === workspaceId && candidate.expected.datasetId === datasetId
    && candidate.approvedRevisionHash === preparation.revision.revisionSha256
    && (Object.keys(preparation.expected) as Array<keyof typeof preparation.expected>).every(key => candidate.expected[key] === preparation.expected[key]);
}
function changes(before: DatasetRevision, after: DatasetRevision): Change[] {
  const output: Change[] = [], beforeTables = new Map(before.definition.tables.map(table => [table.tableId, table])), afterTables = new Map(after.definition.tables.map(table => [table.tableId, table]));
  if (before.definition.name !== after.definition.name) output.push({ kind: "changed", table: after.definition.name, field: "", detail: "Collection name changed", before: before.definition.name, after: after.definition.name });
  for (const table of after.definition.tables) {
    const old = beforeTables.get(table.tableId);
    if (!old) { output.push({ kind: "added", table: table.name, field: "", detail: "Table added" }); for (const field of table.fields) output.push({ kind: "added", table: table.name, field: field.name, detail: "Field added", after: fieldSummary(field) }); continue; }
    if (old.name !== table.name || old.sqlName !== table.sqlName || old.primaryKey !== table.primaryKey) output.push({ kind: "changed", table: table.name, field: "", detail: "Table definition changed", before: `${old.name} · ${old.sqlName} · key: ${old.primaryKey}`, after: `${table.name} · ${table.sqlName} · key: ${table.primaryKey}` });
    const oldFields = new Map(old.fields.map(field => [field.fieldId, field]));
    for (const field of table.fields) {
      const prior = oldFields.get(field.fieldId);
      if (!prior) { output.push({ kind: "added", table: table.name, field: field.name, detail: "Field added", after: fieldSummary(field) }); continue; }
      const changed = prior.name !== field.name || prior.sqlColumn !== field.sqlColumn || prior.type !== field.type || prior.required !== field.required || prior.unique !== field.unique || JSON.stringify(prior.default) !== JSON.stringify(field.default) || JSON.stringify(prior.options) !== JSON.stringify(field.options) || JSON.stringify(prior.relation) !== JSON.stringify(field.relation);
      if (changed) output.push({ kind: "changed", table: table.name, field: field.name, detail: "Field definition changed", ...changedFieldSummary(prior, field) });
      oldFields.delete(field.fieldId);
    }
    for (const field of oldFields.values()) output.push({ kind: "removed", table: table.name, field: field.name, detail: "Field removed", before: fieldSummary(field) });
  }
  for (const table of before.definition.tables) if (!afterTables.has(table.tableId)) output.push({ kind: "removed", table: table.name, field: "", detail: "Table removed" });
  return output;
}

export function CollectionMigrationReviewDialog(props: CollectionMigrationReviewDialogProps) {
  return <ScopedMigrationReview key={JSON.stringify([props.workspaceId, props.datasetId])} {...props} />;
}
function ScopedMigrationReview(props: CollectionMigrationReviewDialogProps) {
  const [descriptorPath, setDescriptorPath] = useState(props.descriptorPath ?? "dataset.json");
  const [migrationPath, setMigrationPath] = useState(props.migrationPath ?? "");
  const [preparation, setPreparation] = useState<DatasetMigrationPreparation | null>(props.initialPreparation ?? null);
  const [invalid, setInvalid] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const active = useRef<AbortController | null>(null), alive = useRef(true), locked = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  const diff = useMemo(() => preparation ? changes(preparation.previousRevision, preparation.revision) : [], [preparation]);
  const candidateMatches = !!preparation && matchingCandidate(preparation, props.workspaceId, props.datasetId);
  const preservesAccess = !!preparation && datasetRevisionsPreserveAccess(preparation.previousRevision,preparation.revision);
  const namesOnly = !!props.generatedChange && candidateMatches && preservesAccess
    && preparation!.candidate.preview.tables.every(table => table.beforeRows === table.afterRows && table.changedRows === 0);
  async function run(kind: "prepare" | "approve"): Promise<void> {
    if (!alive.current || locked.current) return;
    if (kind === "prepare" && !props.generatedChange) {
      if (!validPath(descriptorPath.trim()) || !validPath(migrationPath.trim()) || descriptorPath.trim() === migrationPath.trim() || descriptorPath.trim().endsWith("/dataset.json") === false && descriptorPath.trim() !== "dataset.json") { setInvalid("Choose separate Collection source files in this workspace."); return; }
    }
    if (kind === "approve" && (!preparation || (!confirmed && !namesOnly) || !candidateMatches)) return;
    if (kind === "approve" && Math.min(preparation!.expiresAtMs, preparation!.candidate.expiresAtMs) <= Date.now()) { setPreparation(null); setConfirmed(false); setInvalid("This review expired. Prepare the change again."); return; }
    locked.current = true; setBusy(true); setInvalid(null); active.current?.abort(); const abort = new AbortController(); active.current = abort;
    try {
      if (kind === "prepare") {
        const captured = await props.onPrepare({ workspaceId: props.workspaceId, datasetId: props.datasetId, descriptorPath: descriptorPath.trim(), migrationPath: migrationPath.trim() }, abort.signal);
        if (!alive.current || abort.signal.aborted) return;
        if (captured.previousRevision.datasetId !== props.datasetId || captured.revision.datasetId !== props.datasetId || captured.expected.workspaceId !== props.workspaceId || captured.expected.datasetId !== props.datasetId
          || !matchingCandidate(captured, props.workspaceId, props.datasetId)) throw new Error("The captured change belongs to another Collection or preview. Prepare it again.");
        setPreparation(captured); setConfirmed(false);
      }
      else if (preparation) await props.onApprove({ workspaceId: props.workspaceId, preparationId: preparation.preparationId, revisionSha256: preparation.revision.revisionSha256, approvalDigest: preparation.approvalDigest }, abort.signal);
      if (alive.current && !abort.signal.aborted && kind === "approve") props.onClose();
    } catch (cause) { if (alive.current && !abort.signal.aborted) {
      if (kind === "approve") { setPreparation(null); setConfirmed(false); }
      props.onError(kind === "prepare" ? "dohc could not prepare this Collection change." : "dohc could not confirm this change. Prepare it again before another approval.", cause, () => { if (alive.current) void run("prepare"); });
    } }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  async function discard(close = true): Promise<void> {
    if (locked.current) return;
    const captured = preparation;
    setPreparation(null); setConfirmed(false); setInvalid(null);
    if (close) props.onClose();
    if (!captured) return;
    // Dismissal does not wait for remote cleanup. The host also expires every candidate.
    void Promise.resolve().then(() => props.onDiscard({ workspaceId: props.workspaceId, preparationId: captured.preparationId }, AbortSignal.timeout(10_000))).catch(() => {});
  }
  return <Overlay onClose={busy ? undefined : () => void discard()}><div role="dialog" aria-modal="true" aria-labelledby="collection-migration-title" className="dohc-elevated dohc-pop-in flex max-h-[88vh] w-[min(720px,calc(100vw-32px))] max-w-[calc(100vw-32px)] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-5">
    <div><h2 id="collection-migration-title" className="m-0 text-sm font-semibold text-ink">Review Collection change</h2><p className="m-0 text-[12px] text-muted">{props.generatedChange ? "Review the fields before applying this change." : "Review the captured source before applying it. dohc will not edit the authored operations for you."}</p></div>
    {!preparation ? <form onSubmit={event => { event.preventDefault(); void run("prepare"); }} className="flex flex-col gap-3">
      {!props.generatedChange ? <><label className="text-[12px] text-muted">Collection definition<input aria-label="Collection definition" value={descriptorPath} disabled={busy} className={`${inputClass} mt-1 font-mono`} onChange={event => setDescriptorPath(event.target.value)} /></label>
      <label className="text-[12px] text-muted">Migration file<input aria-label="Migration file" value={migrationPath} disabled={busy} className={`${inputClass} mt-1 font-mono`} onChange={event => setMigrationPath(event.target.value)} /></label></> : <p className="m-0 text-[12px] text-muted">Prepare a fresh review before applying these field changes.</p>}
      {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}<div className="flex justify-end gap-2"><SecondaryButton type="button" disabled={busy} onClick={props.onClose}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={busy}>{busy ? "Preparing…" : "Review change"}</PrimaryButton></div>
    </form> : <>
      {!namesOnly && <div className="flex items-center gap-3 border-b border-line pb-3 text-[12px] text-muted"><span>Current revision <strong className="ml-1 font-mono text-ink">{preparation.previousRevision.revision}</strong></span><ArrowRight size={14} strokeWidth={1.9} aria-hidden /><span>New revision <strong className="ml-1 font-mono text-ink">{preparation.revision.revision}</strong></span></div>}
      <section aria-label="Field changes"><h3 className="m-0 text-[12px] font-semibold text-ink">Fields</h3>{diff.length ? <ul className="m-0 mt-2 flex list-none flex-col gap-3 p-0">{diff.map((change, index) => {
        const ChangeIcon = change.kind === "removed" ? Minus : change.kind === "added" ? Plus : Pencil;
        return <li key={`${change.table}:${change.field}:${index}`} className="rounded-lg border border-line text-[12px]"><div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel-2 px-3 py-2"><span className={`inline-flex items-center gap-1 ${change.kind === "removed" ? "text-danger" : change.kind === "added" ? "text-success" : "text-ink"}`}><ChangeIcon size={12} strokeWidth={1.9} aria-hidden />{change.kind === "removed" ? "Removed" : change.kind === "added" ? "Added" : "Changed"}</span><span className="font-medium text-ink">{change.table}{change.field ? ` · ${change.field}` : ""}</span><span className="ml-auto text-[11px] text-muted">{change.detail}</span></div><div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3 p-3"><div className="min-w-0"><span className="text-[11px] text-muted">Before</span><p className="m-0 mt-1 whitespace-pre-wrap break-words text-muted">{change.before ?? "—"}</p></div><ArrowRight size={14} strokeWidth={1.9} aria-hidden className="mt-6 text-muted" /><div className="min-w-0"><span className="text-[11px] text-muted">After</span><p className="m-0 mt-1 whitespace-pre-wrap break-words text-ink">{change.after ?? "—"}</p></div></div></li>;
      })}</ul> : <p className="m-0 mt-2 text-[12px] text-muted">No field changes in this revision.</p>}</section>
      {!namesOnly && (candidateMatches ? <CollectionMigrationDataPreview workspaceId={props.workspaceId} preparationId={preparation.preparationId}
        previousRevision={preparation.previousRevision} revision={preparation.revision} preview={preparation.candidate.preview}
        onLoad={props.onLoadPreview} onError={props.onError} /> : <p className="m-0 text-[12px] text-muted">This review has no matching data preview. Prepare the change again.</p>)}
      {JSON.stringify(preparation.previousRevision.definition.operations) !== JSON.stringify(preparation.revision.definition.operations) ? <details><summary className="cursor-pointer text-[12px] text-warning">Actions or permissions changed</summary><div className="grid grid-cols-2 gap-3"><div><p className="text-[12px] text-muted">Before</p><pre className="max-h-48 overflow-auto bg-bg p-3 font-mono text-[11px] text-ink">{JSON.stringify(preparation.previousRevision.definition.operations, null, 2)}</pre></div><div><p className="text-[12px] text-muted">After</p><pre className="max-h-48 overflow-auto bg-bg p-3 font-mono text-[11px] text-ink">{JSON.stringify(preparation.revision.definition.operations, null, 2)}</pre></div></div></details> : null}
      {!namesOnly && <><details><summary className="cursor-pointer text-[12px] text-muted">Show migration SQL</summary><pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] text-ink">{preparation.migrationSql}</pre></details>
      <details><summary className="cursor-pointer text-[12px] text-muted">Show new schema</summary><pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] text-ink">{preparation.schemaSql}</pre></details>
      <details><summary className="cursor-pointer text-[12px] text-muted">Show new operation source</summary><pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] text-ink">{preparation.operationSource}</pre></details></>}
      <p className="m-0 text-[12px] text-muted">This preview used a saved copy. Approval applies this exact result if the Collection has not changed.</p>
      <p className={namesOnly ? "m-0 text-[12px] text-muted" : "m-0 rounded-lg border border-warning/50 bg-panel-2 p-3 text-[12px] text-warning"}>{preservesAccess
        ? "Only names or source locations changed. Existing shared apps keep working. Access stays unchanged."
        : "Review changed values before approval. Changed rules require renewed app and collaborator approval."} History can help reverse changes; later edits may need conflict resolution.</p>
      {!namesOnly && <label className="flex items-center gap-2 text-[12px] text-ink"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I reviewed this change and its effect on existing data</label>}
      {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}<div className="flex flex-wrap justify-end gap-2"><SecondaryButton disabled={busy} onClick={() => void discard(false)}>Review another change</SecondaryButton><SecondaryButton disabled={busy} onClick={() => void discard()}>Discard review</SecondaryButton><PrimaryButton disabled={busy || (!confirmed && !namesOnly) || !candidateMatches} onClick={() => void run("approve")}>{busy ? "Applying…" : "Approve change"}</PrimaryButton></div>
    </>}
  </div></Overlay>;
}
