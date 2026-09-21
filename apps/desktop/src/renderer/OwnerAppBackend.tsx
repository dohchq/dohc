import { useEffect, useRef, useState } from "react";
import type { AppBackendCapability, AppBackendJson, AppBackendTable } from "@dohc/security-contract/app-backend";
import { OwnerAppBackendDescribe, OwnerAppBackendInvoke, OwnerAppBackendExport } from "@dohc/cli/app-backend";
import { bridge } from "./bridge";
import { Pill, SecondaryButton } from "./ui/controls";

export const APP_BACKEND_PAGE_SIZE = 50;

/** Same shape as the shell's reportShellError, so root can pass it straight through. */
export type ReportError = (fallback: string, error: unknown, retry: (() => void) | null) => void;

type Scalar = string | number | boolean | null;
type Row = Record<string, AppBackendJson>;
type Page = { rows: Row[]; total: number | null; offset: number; search: string };
// expectedVersion is captured when the edit opens, so a retry sends what the owner saw, not a reloaded row.
type Edit = { rowId: Scalar; field: string; kind: "text" | "number" | "boolean"; value: string; key: string; expectedVersion?: number };

const isScalar = (value: AppBackendJson | undefined): value is Scalar => value === null || (typeof value !== "object" && value !== undefined);
const isRow = (value: AppBackendJson | undefined): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const cell = (value: AppBackendJson | undefined) => value === undefined ? "" : value === null ? "null" : typeof value === "object" ? "…" : String(value);
const kindOf = (value: AppBackendJson | undefined): Edit["kind"] => typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text";

/** Read operations answer `{ rows, total? }`. Anything else is the app's bug, not the owner's. */
function parsePage(value: AppBackendJson): Pick<Page, "rows" | "total"> {
  if (!isRow(value) || !Array.isArray(value.rows) || !value.rows.every(isRow)) throw new Error("The app's read operation did not return rows.");
  const total = value.total;
  return { rows: value.rows, total: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null };
}

type Props = { workspaceId: string; publicationId: string; capability: AppBackendCapability; local?: boolean; disabled?: boolean; onError: ReportError };

export function OwnerAppBackend(props: Props) {
  return <BackendPanel key={`${props.workspaceId}\0${props.publicationId}`} {...props} />;
}

function BackendPanel({ workspaceId, publicationId, capability, local, disabled, onError }: Props) {
  const api = useRef(bridge()).current;
  const alive = useRef(true);
  const request = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const [tableName, setTableName] = useState(capability.tables[0]?.name ?? "");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "export" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);

  const table: AppBackendTable | undefined = capability.tables.find(row => row.name === tableName);
  const stale = (mine: number) => !alive.current || request.current !== mine;
  const target = { workspaceId, publicationId };

  // Inactive data has no rows to show: the host refuses reads and edits until the app is initialized or restored.
  async function fetchPage(read: AppBackendTable, offset: number, query: string, mine: number): Promise<Page | null> {
    const info = OwnerAppBackendDescribe.parse(await api.appBackend({ ...target, action: "describe" }));
    if (stale(mine)) return null;
    setOnline(info.online);
    if (!info.online) { setPage(null); return null; }
    const result = OwnerAppBackendInvoke.parse(await api.appBackend({ ...target, action: "invoke", operation: read.readOperation, idempotencyKey: crypto.randomUUID(),
      input: { offset, limit: APP_BACKEND_PAGE_SIZE, search: query } }));
    if (stale(mine)) return null;
    return { ...parsePage(result.result), offset, search: query };
  }

  async function load(offset: number, query: string, read = table) {
    if (busy || disabled || !read) return;
    const mine = ++request.current;
    setBusy("load"); setStatus(null); setEdit(null);
    try {
      const next = await fetchPage(read, offset, query, mine);
      if (next) setPage(next);
    } catch (cause) {
      if (!stale(mine)) { setPage(null); onError(`dohc could not load ${read.name}.`, cause, () => void load(offset, query, read)); }
    } finally { if (!stale(mine)) setBusy(null); }
  }

  async function save(pending = edit) {
    if (busy || disabled || !table?.writeOperation || !page || !pending) return;
    const value: Scalar = pending.kind === "number" ? Number(pending.value) : pending.kind === "boolean" ? pending.value === "true" : pending.value;
    if (typeof value === "number" && !Number.isFinite(value)) { setInvalid("Enter a number."); return; }
    setInvalid(null);
    const mine = ++request.current;
    const { offset, search: query } = page;
    let saved = false;
    setBusy("save"); setStatus(null);
    try {
      await api.appBackend({ ...target, action: "invoke", operation: table.writeOperation, idempotencyKey: pending.key,
        input: { rowId: pending.rowId, field: pending.field, value, ...(pending.expectedVersion === undefined ? {} : { expectedVersion: pending.expectedVersion }) } });
      if (stale(mine)) return;
      saved = true;
      setEdit(null);
      setStatus(`Saved ${pending.field} for row ${cell(pending.rowId)}.`);
      heading.current?.focus();
      const next = await fetchPage(table, offset, query, mine);
      if (next) setPage(next);
    } catch (cause) {
      if (stale(mine)) return;
      if (saved) onError(`dohc could not reload ${table.name} after saving.`, cause, () => void load(offset, query, table));
      else onError(`dohc could not save ${pending.field} for row ${cell(pending.rowId)}.`, cause, () => void save(pending));
    } finally { if (!stale(mine)) setBusy(null); }
  }

  async function exportData() {
    if (busy || disabled || online === false) return;
    const mine = ++request.current;
    setBusy("export"); setStatus(null);
    try {
      const result = OwnerAppBackendExport.parse(await api.appBackend({ ...target, action: "export" }));
      if (stale(mine)) return;
      if (result.savedPath) setStatus(`Exported data to ${result.savedPath}.`);
    } catch (cause) {
      if (!stale(mine)) onError("dohc could not export this app's data.", cause, () => void exportData());
    } finally { if (!stale(mine)) setBusy(null); }
  }

  const changeTable = (name: string) => {
    const next = capability.tables.find(row => row.name === name);
    setTableName(name); setPage(null); setEdit(null); setStatus(null);
    if (page && next) void load(0, search, next);
  };
  const startEdit = (row: Row, field: string, trigger: HTMLButtonElement) => {
    editTrigger.current = trigger;
    setInvalid(null);
    const version = row.version;
    setEdit({ rowId: row[table!.primaryKey] as Scalar, field, kind: kindOf(row[field]), value: cell(row[field]), key: crypto.randomUUID(),
      ...(typeof version === "number" && Number.isSafeInteger(version) ? { expectedVersion: version } : {}) });
  };
  const cancelEdit = () => { setEdit(null); setInvalid(null); editTrigger.current?.focus(); };

  const columns = page && table ? [table.primaryKey, ...page.rows.flatMap(row => Object.keys(row).filter(key => key !== table.primaryKey && isScalar(row[key])))]
    .filter((key, index, keys) => keys.indexOf(key) === index) : [];
  const editable = columns.filter(key => key !== table?.primaryKey);
  const editRow = edit && page ? page.rows.find(row => row[table!.primaryKey] === edit.rowId) : undefined;
  const hasNext = !!page && (page.total !== null ? page.offset + page.rows.length < page.total : page.rows.length === APP_BACKEND_PAGE_SIZE);
  const locked = !!busy || !!disabled;

  return <section aria-label="App data" className="border-t border-line pt-3">
    <div className="flex items-center justify-between gap-2">
      <h3 ref={heading} tabIndex={-1} className="m-0 text-[13px] font-medium text-ink">App data</h3>
      <div className="flex items-center gap-2">
        {online !== null ? <Pill className={online ? "text-success" : "text-warning"}>{online ? "Data active" : "No active data"}</Pill> : null}
        <SecondaryButton disabled={locked || online === false} onClick={() => void exportData()}>{busy === "export" ? "Exporting…" : "Export data"}</SecondaryButton>
      </div>
    </div>
    <p className="mt-2 text-[12px] text-muted">{local ? "Stored on this device in " : "Stored in "}<span className="break-all font-mono">{capability.dataPath}</span>. {local ? "Not published on any link. " : ""}Every edit runs one of the app's own operations.</p>
    {online === false ? <p role="status" className="text-[12px] text-warning">This app has no active data here. dohc cannot load rows or save edits.{local ? " If you moved its data to a share link, open that publication." : " Initialize or restore its data first."}</p> : null}
    {capability.tables.length === 0 ? <p className="text-[12px] text-muted">This app declares no tables. Export its data to inspect it.</p> :
      <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void load(0, search); }}>
        <label className="text-[12px] text-muted">Table
          <select aria-label="App data table" disabled={locked} value={tableName} onChange={event => changeTable(event.target.value)}
            className="mt-1 block rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:border-ink">
            {capability.tables.map(row => <option key={row.name} value={row.name}>{row.name}</option>)}
          </select></label>
        <label className="min-w-40 flex-1 text-[12px] text-muted">Search
          <input aria-label="Search app data" type="search" disabled={locked} value={search} onChange={event => setSearch(event.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink" /></label>
        <SecondaryButton type="submit" disabled={locked}>{page ? "Reload table" : "Load table"}</SecondaryButton>
      </form>}
    {table && !table.writeOperation ? <p className="mt-2 text-[12px] text-muted">The app allows no edits to {table.name}.</p> : null}
    {busy === "load" ? <p role="status" className="text-[12px] text-muted">Loading {table?.name}…</p> : null}
    {status ? <p role="status" className="text-[12px] text-ink">{status}</p> : null}
    {page && table ? page.rows.length === 0 ? <p className="text-[12px] text-muted">{page.search ? `No rows in ${table.name} match "${page.search}". Try a shorter search.` : `No rows in ${table.name} yet.`}</p> : <>
      <div className="mt-2 overflow-x-auto rounded-md border border-line">
        <table className="w-full border-collapse text-[12px]">
          <thead><tr>{columns.map(key => <th key={key} scope="col" className="border-b border-line px-2 py-1 text-left font-mono font-medium text-muted">{key}</th>)}
            {table.writeOperation ? <th scope="col" className="border-b border-line px-2 py-1"><span className="sr-only">Actions</span></th> : null}</tr></thead>
          <tbody>{page.rows.map((row, index) => <tr key={`${cell(row[table.primaryKey])}\0${index}`}>
            {columns.map(key => <td key={key} title={cell(row[key])} className="max-w-56 truncate border-b border-line px-2 py-1 text-ink">{cell(row[key])}</td>)}
            {table.writeOperation ? <td className="border-b border-line px-2 py-1 text-right">
              {isScalar(row[table.primaryKey]) && editable.length > 0 ? <SecondaryButton size="compact" disabled={locked} aria-label={`Edit row ${cell(row[table.primaryKey])}`}
                onClick={event => startEdit(row, editable[0]!, event.currentTarget)}>Edit</SecondaryButton> : null}
            </td> : null}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-muted">
        <p className="m-0 font-mono">Rows {page.offset + 1}–{page.offset + page.rows.length}{page.total !== null ? ` of ${page.total}` : ""}</p>
        <div className="flex gap-2">
          <SecondaryButton size="compact" disabled={locked || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - APP_BACKEND_PAGE_SIZE), page.search)}>Previous</SecondaryButton>
          <SecondaryButton size="compact" disabled={locked || !hasNext} onClick={() => void load(page.offset + APP_BACKEND_PAGE_SIZE, page.search)}>Next</SecondaryButton>
        </div>
      </div>
    </> : null}
    {edit && editRow && table?.writeOperation ? <form aria-label="Edit row" className="mt-3 space-y-2 rounded-md border border-line p-2" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="m-0 text-[12px] text-ink">Row <span className="font-mono">{cell(edit.rowId)}</span> in {table.name}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[12px] text-muted">Field
          <select aria-label="Edit field" disabled={locked} value={edit.field} className="mt-1 block rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink focus:border-ink"
            onChange={event => { const field = event.target.value; setInvalid(null); setEdit({ ...edit, field, kind: kindOf(editRow[field]), value: cell(editRow[field]), key: crypto.randomUUID() }); }}>
            {editable.map(key => <option key={key} value={key}>{key}</option>)}
          </select></label>
        <label className="min-w-40 flex-1 text-[12px] text-muted">Value
          {edit.kind === "boolean" ? <select aria-label="Edit value" disabled={locked} value={edit.value} className="mt-1 block rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:border-ink"
            onChange={event => setEdit({ ...edit, value: event.target.value, key: crypto.randomUUID() })}><option value="true">true</option><option value="false">false</option></select> :
            <input aria-label="Edit value" type={edit.kind === "number" ? "number" : "text"} step="any" disabled={locked} value={edit.value}
              className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:border-ink"
              onChange={event => { setInvalid(null); setEdit({ ...edit, value: event.target.value, key: crypto.randomUUID() }); }} />}</label>
      </div>
      {invalid ? <p className="m-0 text-[12px] text-danger">{invalid}</p> : null}
      <p className="m-0 text-[12px] text-muted">Runs <span className="font-mono">{table.writeOperation}</span>. The app decides whether to accept the change.</p>
      <div className="flex gap-2">
        <SecondaryButton type="submit" size="compact" disabled={locked}>{busy === "save" ? "Saving…" : "Save"}</SecondaryButton>
        <SecondaryButton type="button" size="compact" disabled={locked} onClick={cancelEdit}>Cancel</SecondaryButton>
      </div>
    </form> : null}
  </section>;
}
