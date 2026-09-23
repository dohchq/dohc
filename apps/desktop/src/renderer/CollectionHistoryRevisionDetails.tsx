import { useLayoutEffect, useRef, useState } from "react";
import type { DatasetHistoryRevision } from "@dohc/cli/dataset";
import { SecondaryButton } from "./ui/controls";
import { FieldTypeIcon } from "./collections/FieldTypeIcon";

export interface HistoryRevisionControls {
  onLoadRevision?(hash: string, signal: AbortSignal): Promise<DatasetHistoryRevision>;
  onRestoreRevision?(hash: string, changedHash: string, signal: AbortSignal): Promise<void>;
  onReviewSource?(): void;
  onEditFields?(): void;
  onOpenSource?(path: string): void;
}
export function CollectionHistoryRevisionDetails(props: HistoryRevisionControls & {
  beforeHash: string; afterHash: string;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}) {
  const [versions, setVersions] = useState<DatasetHistoryRevision[] | null>(null), [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null), alive = useRef(true), locked = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  async function run(restore: boolean) {
    if (!alive.current || locked.current) return;
    locked.current = true; setBusy(true); active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    try {
      if (restore) await props.onRestoreRevision?.(props.beforeHash, props.afterHash, controller.signal);
      else if (props.onLoadRevision) {
        const result = await Promise.all([props.onLoadRevision(props.beforeHash, controller.signal), props.onLoadRevision(props.afterHash, controller.signal)]);
        if (result[0]!.revision.revisionSha256 !== props.beforeHash || result[1]!.revision.revisionSha256 !== props.afterHash) throw new Error("These saved rules do not match this change.");
        if (alive.current && !controller.signal.aborted) setVersions(result);
      }
    } catch (error) {
      if (alive.current && !controller.signal.aborted) props.onError(restore ? "dohc could not prepare this reversal." : "dohc could not load the saved rules.", error, () => { void run(restore); });
    } finally { locked.current = false; if (alive.current && !controller.signal.aborted) setBusy(false); }
  }
  return <section aria-label="Fields and rules history" className="mt-3 space-y-3 text-[12px]">
    <p className="m-0 text-muted">Compare saved fields and rules. Restoring them creates a reviewed change against the current records.</p>
    <div className="flex flex-wrap gap-2"><SecondaryButton disabled={busy || !props.onLoadRevision} onClick={() => void run(false)}>{busy ? "Preparing…" : "Compare change"}</SecondaryButton>
      {versions && props.onRestoreRevision && <SecondaryButton disabled={busy} onClick={() => void run(true)}>Review reversal</SecondaryButton>}
      {props.onEditFields && <SecondaryButton disabled={busy} onClick={props.onEditFields}>Fields and names</SecondaryButton>}
      {props.onReviewSource && <SecondaryButton disabled={busy} onClick={props.onReviewSource}>Review source migration</SecondaryButton>}</div>
    {versions && <><p className="m-0 text-muted">Current records and access stay intact. Conflicting changes need a source migration. Restoring a source file does not activate rules.</p>
      <div className="grid gap-3 sm:grid-cols-2">{versions.map((version, index) => <section key={version.revision.revisionSha256} aria-label={index ? "After change" : "Before change"} className="min-w-0 space-y-2 rounded-lg border border-line p-3">
        <h3 className="m-0 flex items-center justify-between gap-2 text-[12px] font-semibold">{index ? "After" : "Before"}<span className="font-mono text-[11px] font-normal text-muted">Revision {version.revision.revision}</span></h3>
        <div>{version.revision.definition.tables.map(table => <section key={table.tableId}><h4 className="my-2 font-medium">{table.name}</h4><ul className="m-0 list-none space-y-2 p-0">{table.fields.map(field => <li key={field.fieldId} className="flex items-center gap-2"><FieldTypeIcon type={field.type} className="shrink-0 text-muted" /><span className="min-w-0 break-words">{field.name}</span><span className="ml-auto text-[11px] text-muted">{field.type}</span>{field.required ? <span title="Required" className="text-muted"><span aria-hidden="true">*</span><span className="sr-only">Required</span></span> : null}</li>)}</ul></section>)}</div>
        <details><summary className="cursor-pointer">Field and action definitions</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(version.revision.definition, null, 2)}</pre></details>
        {([{ label: "Rules", path: version.revision.definition.operationsPath, hash: version.revision.operationsSha256, content: version.operationSource },
          { label: "Schema", path: version.revision.definition.schemaPath, hash: version.revision.schemaSha256, content: version.schemaSql }]).map(source => <details key={source.label}>
          <summary className="cursor-pointer">{source.label}</summary><p className="break-all font-mono">{source.path}</p>
          <p className="break-all text-muted">Saved SHA-256: {source.hash}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{source.content}</pre>
          {props.onOpenSource && <SecondaryButton onClick={() => props.onOpenSource?.(source.path)}>Open current {source.label.toLowerCase()} file</SecondaryButton>}
        </details>)}
      </section>)}</div></>}
  </section>;
}
