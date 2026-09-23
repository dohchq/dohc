import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { APP_BACKEND_UPLOAD_BYTES, parseAppBackendFile, type AppBackendFile, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { TransactionalField } from "./transactionalCollectionModel";
import { inputClass } from "./collections/FieldForm";
import { SecondaryButton } from "./ui/controls";
import { downloadCollectionFile, type CollectionResourceScope, type CollectionResources, type CollectionResourceError, type CollectionRelationOption, type CollectionUploadRequest } from "./transactionalCollectionResources";

interface InputProps {
  scope: CollectionResourceScope;
  field: TransactionalField;
  value: AppBackendJson;
  disabled: boolean;
  onChange(value: AppBackendJson): void;
  onError: CollectionResourceError;
}

export function CollectionAttachmentInput(props: InputProps & { upload: NonNullable<CollectionResources["uploadFile"]>; onBusy(busy: boolean): void }) {
  const [file, setFile] = useState<AppBackendFile | null>(null), [pending, setPending] = useState(false), [invalid, setInvalid] = useState<string | null>(null);
  const alive = useRef(true), locked = useRef(false), active = useRef<AbortController | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  async function upload(request: CollectionUploadRequest): Promise<void> {
    if (!alive.current || locked.current) return;
    locked.current = true; const abort = new AbortController(); active.current = abort;
    setPending(true); props.onBusy(true); setInvalid(null);
    try {
      const uploaded = parseAppBackendFile(await props.upload(request, abort.signal));
      if (!alive.current || abort.signal.aborted) return;
      if (uploaded.name !== request.file.name || uploaded.byteLength !== request.file.size) throw new Error("The collection returned a different file.");
      setFile(uploaded); props.onChange(uploaded.fileId);
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) props.onError(`dohc could not upload ${request.file.name}.`, cause, () => { if (alive.current) void upload(request); });
    } finally { if (alive.current) { locked.current = false; setPending(false); props.onBusy(false); } }
  }
  return <div className="flex flex-col gap-2">
    <input type="file" aria-label={props.field.name} disabled={props.disabled || pending} className={inputClass} onChange={event => {
      const selected = event.target.files?.[0]; event.target.value = ""; if (!selected) return;
      if (selected.size < 1 || selected.size > APP_BACKEND_UPLOAD_BYTES) { setInvalid("Choose a nonempty file up to 5 MB."); return; }
      void upload({ ...props.scope, fieldId: props.field.fieldId, file: selected, idempotencyKey: crypto.randomUUID() });
    }} />
    {pending ? <span role="status" className="text-[12px] text-muted">Uploading…</span> : props.value ? <div className="flex items-center gap-2"><span className="text-[12px] text-muted">{file?.fileId === props.value ? `${file.name} · ${file.byteLength} bytes · Save to attach` : "Attached file"}</span><SecondaryButton disabled={props.disabled} onClick={() => { setFile(null); props.onChange(null); }}>Remove file</SecondaryButton></div> : <span className="text-[11px] text-subtle">Up to 5 MB</span>}
    {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}
  </div>;
}

export function CollectionAttachmentCell(props: { scope: CollectionResourceScope; fieldName: string; fileId: string; disabled: boolean; read: NonNullable<CollectionResources["readFile"]>; onError: CollectionResourceError }) {
  const [pending, setPending] = useState(false);
  const alive = useRef(true), active = useRef<AbortController | null>(null), locked = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  async function download(): Promise<void> {
    if (!alive.current || locked.current) return;
    locked.current = true; setPending(true); const abort = new AbortController(); active.current = abort;
    try { const response = await props.read({ ...props.scope, fileId: props.fileId }, abort.signal); if (alive.current && !abort.signal.aborted) downloadCollectionFile(props.fileId, response); }
    catch (cause) { if (alive.current && !abort.signal.aborted) props.onError(`dohc could not download ${props.fieldName}.`, cause, () => { if (alive.current) void download(); }); }
    finally { if (alive.current) { locked.current = false; setPending(false); } }
  }
  return <SecondaryButton disabled={props.disabled || pending} onClick={() => void download()}>{pending ? "Downloading…" : `Download ${props.fieldName}`}</SecondaryButton>;
}

export function CollectionRelationInput(props: InputProps & { resolve: NonNullable<CollectionResources["resolveRelation"]> }) {
  const [search, setSearch] = useState(""), [options, setOptions] = useState<CollectionRelationOption[]>([]), [pending, setPending] = useState(false), [hasMore, setHasMore] = useState(false), [invalid, setInvalid] = useState<string | null>(null);
  const alive = useRef(true), active = useRef<AbortController | null>(null), sequence = useRef(0);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  const values = props.value === null ? [] : Array.isArray(props.value) ? props.value : [props.value];
  async function load(term: string): Promise<void> {
    if (!alive.current) return;
    active.current?.abort(); const abort = new AbortController(); active.current = abort; const mine = ++sequence.current; setPending(true);
    try {
      const response = await props.resolve({ ...props.scope, fieldId: props.field.fieldId, search: term, limit: 20 }, abort.signal);
      if (!alive.current || abort.signal.aborted || sequence.current !== mine) return;
      if (!Array.isArray(response.options) || response.options.length > 20 || typeof response.hasMore !== "boolean" || response.options.some(option => !((typeof option.value === "string" && option.value.length > 0 && option.value.length <= 1024) || (typeof option.value === "number" && Number.isSafeInteger(option.value))) || typeof option.label !== "string" || option.label.length > 2000) || new Set(response.options.map(option => JSON.stringify(option.value))).size !== response.options.length) throw new Error("The collection returned invalid related records.");
      setOptions(response.options); setHasMore(response.hasMore);
    } catch (cause) { if (alive.current && !abort.signal.aborted && sequence.current === mine) props.onError(`dohc could not find records for ${props.field.name}.`, cause, () => { if (alive.current) void load(term); }); }
    finally { if (alive.current && sequence.current === mine) setPending(false); }
  }
  useEffect(() => { void load(""); }, []);
  return <fieldset aria-label={props.field.name} disabled={props.disabled} className="m-0 flex flex-col gap-2 border-0 p-0">
    <div className="flex gap-2"><input aria-label={`Search ${props.field.name}`} type="search" maxLength={200} value={search} className={inputClass} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void load(search); } }} /><SecondaryButton onClick={() => void load(search)}>Find records</SecondaryButton></div>
    {values.map(value => <div key={JSON.stringify(value)} className="flex items-center gap-2 text-[12px] text-ink"><span>{options.find(option => option.value === value)?.label ?? String(value)}</span><SecondaryButton aria-label={`Remove ${String(value)} from ${props.field.name}`} onClick={() => { setInvalid(null); props.onChange(props.field.relation?.many ? values.filter(entry => entry !== value) : null); }}>Remove</SecondaryButton></div>)}
    {pending ? <span role="status" className="text-[12px] text-muted">Finding records…</span> : <div className="flex max-h-40 flex-col gap-1 overflow-auto">{options.filter(option => !values.includes(option.value)).map(option => <SecondaryButton key={JSON.stringify(option.value)} onClick={() => {
      if (props.field.relation?.many && values.length >= 100) { setInvalid("Choose up to 100 related records."); return; }
      setInvalid(null); props.onChange(props.field.relation?.many ? [...values, option.value] : option.value);
    }}>{option.label}</SecondaryButton>)}{options.length === 0 ? <span className="text-[12px] text-muted">No records match. Try another search.</span> : null}{hasMore ? <span className="text-[12px] text-muted">More records match. Narrow your search.</span> : null}</div>}
    {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}
  </fieldset>;
}
