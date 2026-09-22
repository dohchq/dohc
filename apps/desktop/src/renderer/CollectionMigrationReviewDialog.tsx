import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DatasetRevision, DatasetField } from "@dohc/security-contract/dataset";
import type { DatasetMigrationPreparation } from "@dohc/cli/dataset";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass } from "./collections/FieldForm";

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
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}
type Change = { kind: "added" | "removed" | "changed"; table: string; field: string; detail: string; before?: string; after?: string };
function fieldSummary(field: DatasetField): string {
  return [field.name, field.type, field.required ? "required" : "optional", ...(field.unique ? ["unique"] : []),
    ...(Object.hasOwn(field, "default") ? [`default: ${JSON.stringify(field.default)}`] : []), ...(field.options ? [`options: ${field.options.join(", ")}`] : []),
    ...(field.relation ? [`related field: ${field.relation.fieldId}${field.relation.many ? " (many)" : ""}`] : [])].join(" · ");
}
function validPath(path: string): boolean { return isShareablePath(path) && /^[A-Za-z0-9_@./-]+$/.test(path) && path.length <= 1024; }
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
      if (changed) output.push({ kind: "changed", table: table.name, field: field.name, detail: "Field definition changed", before: `${fieldSummary(prior)} · column: ${prior.sqlColumn}`, after: `${fieldSummary(field)} · column: ${field.sqlColumn}` });
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
  async function run(kind: "prepare" | "approve"): Promise<void> {
    if (!alive.current || locked.current) return;
    if (kind === "prepare" && !props.generatedChange) {
      if (!validPath(descriptorPath.trim()) || !validPath(migrationPath.trim()) || descriptorPath.trim() === migrationPath.trim() || descriptorPath.trim().endsWith("/dataset.json") === false && descriptorPath.trim() !== "dataset.json") { setInvalid("Choose separate Collection source files in this workspace."); return; }
    }
    if (kind === "approve" && (!preparation || !confirmed)) return;
    if (kind === "approve" && preparation!.expiresAtMs <= Date.now()) { setPreparation(null); setConfirmed(false); setInvalid("This review expired. Prepare the change again."); return; }
    locked.current = true; setBusy(true); setInvalid(null); active.current?.abort(); const abort = new AbortController(); active.current = abort;
    try {
      if (kind === "prepare") {
        const captured = await props.onPrepare({ workspaceId: props.workspaceId, datasetId: props.datasetId, descriptorPath: descriptorPath.trim(), migrationPath: migrationPath.trim() }, abort.signal);
        if (!alive.current || abort.signal.aborted) return;
        if (captured.previousRevision.datasetId !== props.datasetId || captured.revision.datasetId !== props.datasetId || captured.expected.workspaceId !== props.workspaceId || captured.expected.datasetId !== props.datasetId) throw new Error("The captured change belongs to another Collection.");
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
    if (!preparation) { if (close) props.onClose(); return; }
    locked.current = true; setBusy(true); const abort = new AbortController(); active.current = abort;
    try { await props.onDiscard({ workspaceId: props.workspaceId, preparationId: preparation.preparationId }, abort.signal); if (alive.current && !abort.signal.aborted) { setPreparation(null); setConfirmed(false); if (close) props.onClose(); } }
    catch (cause) { if (alive.current && !abort.signal.aborted) props.onError("dohc could not discard this Collection review.", cause, () => { if (alive.current) void discard(close); }); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  return <Overlay onClose={busy ? undefined : () => void discard()}><div role="dialog" aria-modal="true" aria-labelledby="collection-migration-title" className="dohc-elevated dohc-pop-in flex max-h-[88vh] w-[min(720px,calc(100vw-32px))] max-w-[calc(100vw-32px)] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-5">
    <div><h2 id="collection-migration-title" className="m-0 text-sm font-semibold text-ink">Review Collection change</h2><p className="m-0 text-[12px] text-muted">{props.generatedChange ? "Review the fields before applying this change." : "Review the captured source before applying it. dohc will not edit the authored operations for you."}</p></div>
    {!preparation ? <form onSubmit={event => { event.preventDefault(); void run("prepare"); }} className="flex flex-col gap-3">
      {!props.generatedChange ? <><label className="text-[12px] text-muted">Collection definition<input aria-label="Collection definition" value={descriptorPath} disabled={busy} className={`${inputClass} mt-1 font-mono`} onChange={event => setDescriptorPath(event.target.value)} /></label>
      <label className="text-[12px] text-muted">Migration file<input aria-label="Migration file" value={migrationPath} disabled={busy} className={`${inputClass} mt-1 font-mono`} onChange={event => setMigrationPath(event.target.value)} /></label></> : <p className="m-0 text-[12px] text-muted">Prepare a fresh review before applying these field changes.</p>}
      {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}<div className="flex justify-end gap-2"><SecondaryButton type="button" disabled={busy} onClick={props.onClose}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={busy}>{busy ? "Preparing…" : "Review change"}</PrimaryButton></div>
    </form> : <>
      <div className="grid grid-cols-2 gap-3 text-[12px]"><div className="rounded-lg border border-line bg-panel-2 p-3"><span className="text-muted">Current revision</span><strong className="mt-1 block font-mono text-ink">{preparation.previousRevision.revision}</strong></div><div className="rounded-lg border border-line bg-panel-2 p-3"><span className="text-muted">New revision</span><strong className="mt-1 block font-mono text-ink">{preparation.revision.revision}</strong></div></div>
      <section aria-label="Field changes" className="rounded-lg border border-line bg-panel p-3"><h3 className="m-0 text-[12px] font-semibold text-ink">Fields</h3>{diff.length ? <ul className="m-0 mt-2 flex list-none flex-col gap-3 p-0">{diff.map((change, index) => <li key={`${change.table}:${change.field}:${index}`} className="text-[12px]"><div className="flex items-baseline gap-2"><span className={change.kind === "removed" ? "text-danger" : change.kind === "added" ? "text-success" : "text-ink"}>{change.kind === "removed" ? "Removed" : change.kind === "added" ? "Added" : "Changed"}</span><span className="text-ink">{change.table}{change.field ? ` · ${change.field}` : ""}</span><span className="text-muted">{change.detail}</span></div><div className="mt-1 grid grid-cols-2 gap-3 break-words text-muted"><div><span className="font-medium">Before</span><p className="m-0">{change.before ?? "—"}</p></div><div><span className="font-medium">After</span><p className="m-0">{change.after ?? "—"}</p></div></div></li>)}</ul> : <p className="m-0 mt-2 text-[12px] text-muted">No field changes in this revision.</p>}</section>
      {JSON.stringify(preparation.previousRevision.definition.operations) !== JSON.stringify(preparation.revision.definition.operations) ? <details><summary className="cursor-pointer text-[12px] text-warning">Actions or permissions changed</summary><div className="grid grid-cols-2 gap-3"><div><p className="text-[12px] text-muted">Before</p><pre className="max-h-48 overflow-auto bg-bg p-3 font-mono text-[11px] text-ink">{JSON.stringify(preparation.previousRevision.definition.operations, null, 2)}</pre></div><div><p className="text-[12px] text-muted">After</p><pre className="max-h-48 overflow-auto bg-bg p-3 font-mono text-[11px] text-ink">{JSON.stringify(preparation.revision.definition.operations, null, 2)}</pre></div></div></details> : null}
      <details><summary className="cursor-pointer text-[12px] text-muted">Show migration SQL</summary><pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] text-ink">{preparation.migrationSql}</pre></details>
      <details><summary className="cursor-pointer text-[12px] text-muted">Show new schema</summary><pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] text-ink">{preparation.schemaSql}</pre></details>
      <details><summary className="cursor-pointer text-[12px] text-muted">Show new operation source</summary><pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] text-ink">{preparation.operationSource}</pre></details>
      <p className="m-0 rounded-lg border border-warning/50 bg-panel-2 p-3 text-[12px] text-warning">{props.generatedChange ? "Existing records will stay. Shared apps and helpers need approval for this revision before they can use it." : "This change can replace or delete data. dohc has no undo for this change. Review the captured SQL and operations."}</p>
      <label className="flex items-center gap-2 text-[12px] text-ink"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I reviewed this change and its effect on existing data</label>
      {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}<div className="flex flex-wrap justify-end gap-2"><SecondaryButton disabled={busy} onClick={() => void discard(false)}>Review another change</SecondaryButton><SecondaryButton disabled={busy} onClick={() => void discard()}>Discard review</SecondaryButton><PrimaryButton disabled={busy || !confirmed} onClick={() => void run("approve")}>{busy ? "Applying…" : "Approve change"}</PrimaryButton></div>
    </>}
  </div></Overlay>;
}
