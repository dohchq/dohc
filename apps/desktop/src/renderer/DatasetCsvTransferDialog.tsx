import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass, selectClass } from "./collections/FieldForm";
import type { TransactionalDatasetDescription } from "./transactionalCollectionModel";
import { createCsvImportPlan, exportDatasetCsv, parseCsvImportReport, parseDatasetCsv, previewDatasetCsv, runCsvImport,
  type CsvImportPlan, type CsvInvoke, type CsvPreview, type CsvTable } from "./datasetCsv";

export interface DatasetCsvTransferDialogProps {
  workspaceId: string;
  dataset: TransactionalDatasetDescription;
  tableId: string;
  invoke: CsvInvoke;
  /** Must finish saving before resolving. The retry report is saved before any import writes. */
  onSave(file: { name: string; content: string; contentType: string }, signal: AbortSignal): Promise<void>;
  onClose(): void;
  onImported?(): void;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}
export function DatasetCsvTransferDialog(props: DatasetCsvTransferDialogProps) {
  return <ScopedTransfer key={JSON.stringify([props.workspaceId, props.dataset, props.tableId])} {...props} />;
}
function ScopedTransfer(props: DatasetCsvTransferDialogProps) {
  const table = props.dataset.tables.find(table => table.tableId === props.tableId);
  const creates = props.dataset.operations.filter(operation => operation.tableId === props.tableId && operation.kind === "create" && !operation.readOnly);
  const reads = props.dataset.operations.filter(operation => operation.tableId === props.tableId && operation.kind === "read" && operation.readOnly);
  const [mode, setMode] = useState<"import" | "export">("import"), [createId, setCreateId] = useState(creates[0]?.operationId ?? ""), [readId, setReadId] = useState(reads[0]?.operationId ?? "");
  const [csv, setCsv] = useState<CsvTable | null>(null), [mapping, setMapping] = useState<Array<string | null>>([]), [draft, setDraft] = useState("");
  const [plan, setPlan] = useState<CsvImportPlan | null>(null), [busy, setBusy] = useState(false), [invalid, setInvalid] = useState<string | null>(null), [raw, setRaw] = useState(false);
  const [exported, setExported] = useState<number | null>(null);
  const importPlan = useRef<CsvImportPlan | null>(null);
  const alive = useRef(true), locked = useRef(false), active = useRef<AbortController | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  const create = creates.find(operation => operation.operationId === createId), read = reads.find(operation => operation.operationId === readId);
  const scope = (operationId: string) => ({ workspaceId: props.workspaceId, datasetId: props.dataset.datasetId, revision: props.dataset.revision, revisionSha256: props.dataset.revisionSha256, operationId });
  const preview = useMemo<{ value: CsvPreview | null; problem: string | null }>(() => {
    if (!csv || !create || !table) return { value: null, problem: null };
    try { return { value: previewDatasetCsv(csv, table.fields, create, mapping), problem: null }; }
    catch (error) { return { value: null, problem: error instanceof Error ? error.message : "Check the field mapping." }; }
  }, [csv, create, table, mapping]);
  const rows = plan?.rows ?? preview.value?.rows ?? [];
  const counts = plan ? Object.fromEntries(["accepted", "refused", "uncertain", "pending", "invalid"].map(state => [state, plan.rows.filter(row => row.outcome === state).length])) : null;
  const baseName = (table?.name ?? "Collection").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100) || "Collection";
  function parse(text: string) {
    try {
      const parsed = parseDatasetCsv(text); setCsv(parsed); setInvalid(null); setPlan(null); importPlan.current = null;
      const used = new Set<string>();
      setMapping(parsed.headers.map(header => { const field = table?.fields.find(field => create?.fieldIds.includes(field.fieldId) && (field.fieldId === header || field.name === header) && !used.has(field.fieldId)); if (field) used.add(field.fieldId); return field?.fieldId ?? null; }));
    } catch (error) { setInvalid(error instanceof Error ? error.message : "Check the CSV file."); setCsv(null); }
  }
  async function task(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (locked.current || !alive.current) return;
    locked.current = true; setBusy(true); setInvalid(null); const controller = new AbortController(); active.current = controller;
    try { await action(controller.signal); }
    catch (error) { if (alive.current && !controller.signal.aborted) props.onError(fallback, error, () => { void task(action, fallback); }); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  const saveReport = (captured: CsvImportPlan, signal: AbortSignal) => props.onSave({ name: `${baseName}-import.json`, content: JSON.stringify(captured, null, 2), contentType: "application/json" }, signal);
  async function importRows(signal: AbortSignal) {
    if (!create || !preview.value && !plan) return;
    const captured = importPlan.current ?? plan ?? createCsvImportPlan(scope(create.operationId), preview.value!);
    if (!importPlan.current && !plan) { await saveReport(captured, signal); signal.throwIfAborted(); if (!alive.current) return; setPlan(captured); }
    importPlan.current = captured;
    const result = await runCsvImport(captured, props.invoke, signal, checkpoint => { if (alive.current && !signal.aborted) { importPlan.current = checkpoint; setPlan(checkpoint); } });
    if (!alive.current || signal.aborted) return;
    importPlan.current = result; setPlan(result); props.onImported?.();
  }
  const pending = plan?.rows.some(row => row.outcome === "pending" || row.outcome === "uncertain");
  return <Overlay onClose={busy ? undefined : props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Import or export Collection", className: "dohc-elevated dohc-pop-in flex max-h-[90vh] w-[min(760px,92vw)] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5 text-ink" }}>
    <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-sm font-semibold">Import or export {table?.name ?? "Collection"}</h2><SecondaryButton disabled={busy} onClick={props.onClose}>Close</SecondaryButton></div>
    <div className="flex gap-2"><SecondaryButton disabled={busy || !!plan} aria-pressed={mode === "import"} onClick={() => setMode("import")}>Import CSV</SecondaryButton><SecondaryButton disabled={busy || !!plan} aria-pressed={mode === "export"} onClick={() => setMode("export")}>Export CSV</SecondaryButton></div>
    {mode === "import" ? <>
      {!creates.length ? <p className="m-0 text-[13px] text-muted">This Collection has no permitted create action.</p> : <>
        <label className="grid gap-1 text-[12px] text-muted">Create action<select className={selectClass} value={createId} disabled={busy || !!plan} onChange={event => { setCreateId(event.target.value); setMapping(csv?.headers.map(() => null) ?? []); }}>
          {creates.map(operation => <option key={operation.operationId} value={operation.operationId}>{operation.label}</option>)}</select></label>
        {!plan && <><label className="grid gap-1 text-[12px] text-muted">CSV file or saved import report<input type="file" accept=".csv,.json,text/csv,application/json" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]; if (!file) return;
          void task(async signal => { if (file.size > 16 * 1024 * 1024) throw Error("Choose a file smaller than 16 MB."); const text = await file.text(); signal.throwIfAborted(); if (!alive.current) return;
            if (file.name.toLowerCase().endsWith(".json")) { if (!create || !table) return; setPlan(parseCsvImportReport(text, scope(create.operationId), table.fields, create)); }
            else parse(text);
          }, "dohc could not read this import file.");
        }} /></label><details><summary className="cursor-pointer text-[12px] text-muted">Paste CSV</summary><textarea aria-label="CSV text" className={`${inputClass} mt-2 min-h-28 font-mono`} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} /><SecondaryButton disabled={busy} onClick={() => parse(draft)}>Preview CSV</SecondaryButton></details></>}
        {csv && !plan && <div className="grid gap-2">{csv.headers.map((header, index) => <label key={index} className="grid grid-cols-2 items-center gap-3 text-[12px] text-muted"><span className="truncate">{header || `Column ${index + 1}`}</span><select aria-label={`Field for column ${index + 1}`} className={selectClass} disabled={busy} value={mapping[index] ?? ""} onChange={event => setMapping(current => current.map((field, position) => position === index ? event.target.value || null : field))}><option value="">Skip column</option>{table?.fields.filter(field => create?.fieldIds.includes(field.fieldId)).map(field => <option key={field.fieldId} value={field.fieldId}>{field.name} · {field.type}</option>)}</select></label>)}</div>}
        {preview.problem && !plan ? <p role="alert" className="m-0 text-[12px] text-danger">{preview.problem}</p> : null}
        {rows.length > 0 && <><p className="m-0 text-[12px] text-muted">{rows.length} rows · {rows.filter(row => row.errors.length).length} rows with input errors</p><div className="max-h-56 overflow-auto rounded-lg border border-line"><table className="w-full border-collapse text-left text-[12px]"><thead><tr className="bg-panel-2"><th className="p-2">Row</th><th className="p-2">Preview</th><th className="p-2">Result</th></tr></thead><tbody>{rows.slice(0, 100).map(row => <tr key={row.row} className="border-t border-line"><td className="p-2 font-mono">{row.row}</td><td className="max-w-72 truncate p-2">{Object.values(row.values).map(value => typeof value === "object" ? JSON.stringify(value) : String(value)).join(" · ")}</td><td className="p-2">{row.errors.join(" ") || ("outcome" in row ? `${row.outcome}${"message" in row && row.message ? `: ${row.message}` : ""}` : "Ready")}</td></tr>)}</tbody></table></div>{rows.length > 100 && <p className="m-0 text-[12px] text-muted">Showing the first 100 rows. The saved report includes every row.</p>}</>}
        <p className="m-0 text-[12px] text-muted">Each row saves separately through this create action. A failed row does not undo earlier rows.</p>
        {!plan && <p className="m-0 text-[12px] text-muted">Empty cells use the field default, or stay empty. Use JSON arrays for multiple options and JSON keys for relations.</p>}
        {!plan && <p className="m-0 text-[12px] text-muted">Save the retry report before importing. Open that report to resume without creating duplicates.</p>}
        {counts && <p role="status" className="m-0 text-[12px] text-ink">{counts.accepted} accepted · {counts.refused} refused · {counts.uncertain} uncertain · {counts.pending} pending · {counts.invalid} invalid</p>}
        {counts?.uncertain ? <p className="m-0 text-[12px] text-warning">An uncertain row may already be saved. Retry this import with the same report to check its result.</p> : null}
        <div className="flex flex-wrap justify-end gap-2">{plan && <SecondaryButton disabled={busy} onClick={() => void task(signal => saveReport(plan, signal), "dohc could not save the import report.")}>Save updated report</SecondaryButton>}<PrimaryButton disabled={busy || (plan ? !pending : !preview.value?.rows.some(row => !row.errors.length))} onClick={() => void task(importRows, "dohc could not start this import.")}>{busy ? "Importing…" : plan ? "Resume import" : "Save retry report and import"}</PrimaryButton></div>
      </>}
    </> : <>
      {!reads.length ? <p className="m-0 text-[13px] text-muted">This Collection has no permitted read action.</p> : <>
        <label className="grid gap-1 text-[12px] text-muted">Read action<select className={selectClass} value={readId} disabled={busy} onChange={event => setReadId(event.target.value)}>{reads.map(operation => <option key={operation.operationId} value={operation.operationId}>{operation.label}</option>)}</select></label>
        <p className="m-0 text-[12px] text-muted">Export includes only fields this read action exposes. Changes during export may appear on different pages.</p>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={raw} disabled={busy} onChange={event => setRaw(event.target.checked)} />Export raw cell values</label>
        <p className="m-0 text-[12px] text-muted">{raw ? "Raw text may run as spreadsheet formulas. Choose raw values only for tools that treat cells as data." : "Spreadsheet-safe export prefixes formula-like text with an apostrophe. This changes those exported text values."}</p>
        {exported !== null && <p role="status" className="m-0 text-[12px] text-ink">Exported {exported} rows</p>}
        <div className="flex justify-end"><PrimaryButton disabled={busy || !read} onClick={() => void task(async signal => { if (!read || !table) return; const result = await exportDatasetCsv({ scope: scope(read.operationId), operation: read, fields: table.fields, invoke: props.invoke, signal, spreadsheetSafe: !raw }); signal.throwIfAborted(); await props.onSave({ name: `${baseName}.csv`, content: result.content, contentType: "text/csv;charset=utf-8" }, signal); if (alive.current && !signal.aborted) setExported(result.rows); }, "dohc could not export this Collection.")}>{busy ? "Exporting…" : "Export CSV"}</PrimaryButton></div>
      </>}
    </>}
    {invalid && <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p>}
  </Overlay>;
}
