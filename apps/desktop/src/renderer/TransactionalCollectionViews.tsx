import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoardView, CalendarView, type CollectionCellChange } from "@dohc/collection-views";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import type { CollectionRecordGroup } from "@dohc/workspace-contracts";
import type { CollectionTableView } from "./collectionTableViews";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { display, object, parsePage, type TransactionalCursor, type TransactionalField, type TransactionalPage, type TransactionalRow } from "./transactionalCollectionModel";
import { BOARD_GROUP_PAGE_SIZE, calendarRange, parseCalendarPage, parseGroups, visualRecord, visualSchema, type GroupCursor } from "./transactionalVisualQueries";

type Column = { value: AppBackendJson; page: TransactionalPage };
interface Props {
  view: CollectionTableView;
  fields: TransactionalField[];
  search: string;
  refresh: number;
  /** Rises when records changed elsewhere; the view reads them again in place. */
  changed: number;
  /** The records a read in place found, so an open record shows its new values. */
  onReadInPlace(rows: readonly TransactionalRow[]): void;
  disabled: boolean;
  read(input: AppBackendJson, signal: AbortSignal): Promise<{ result: AppBackendJson }>;
  onBusy(busy: boolean): void;
  /** A read failed; the page shows it and offers `retry`. */
  onError(message: string, error: unknown, retry: () => void): void;
  /** A read showed records, so the page drops what a failed read left. */
  onLoaded(): void;
  onOpen(row: TransactionalRow): void;
  onMove(row: TransactionalRow, fieldId: string, value: AppBackendJson): void;
  canMove(fieldId: string): boolean;
}
type Position = { after: TransactionalCursor | null; history: Array<TransactionalCursor | null> };
type Loaded = { columns: Column[]; calendar: TransactionalPage | null; nearby: string[]; moreGroups: boolean; nextGroup: GroupCursor | null };
const beginning = (): Position => ({ after: null, history: [] });

/** A board requests each visible group; a calendar requests its visible date range. Neither reuses a table page. */
export function TransactionalCollectionViews(props: Props) {
  const [month, setMonth] = useState(() => new Date());
  const [offset, setOffset] = useState(0), [groupAfter, setGroupAfter] = useState<GroupCursor | null>(null);
  const [groupHistory, setGroupHistory] = useState<Array<GroupCursor | null>>([]);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [calendarPosition, setCalendarPosition] = useState<Position>(beginning);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const latest = useRef(props); latest.current = props;
  const current = useRef(0);
  // Whether a read that shows "Loading view…" is in flight. A ref, so a read in place started in the same
  // commit sees it, and never supersedes it, which would leave the view loading.
  const reading = useRef(false);
  const fieldKey = JSON.stringify(props.fields);
  const schema = useMemo(() => visualSchema(props.fields), [fieldKey]);
  const queryKey = JSON.stringify([props.view,props.search,props.refresh,offset,groupAfter,positions,calendarPosition,month.getFullYear(),month.getMonth(),attempt]);
  useLayoutEffect(() => () => { current.current++; }, []);
  /** Reads what the view shows now, at this render's months, groups, and pages. */
  async function readView(signal: AbortSignal): Promise<Loaded> {
    const { view, fields, read } = latest.current;
    const base: Record<string, AppBackendJson> = {};
    if (props.search) base.search = props.search;
    if (view.filters.length) base.filters = view.filters;
    const readPage = async (input: Record<string, AppBackendJson>) => {
      signal.throwIfAborted();
      const response = await read(input,signal);
      signal.throwIfAborted();
      return response.result;
    };
    let columns: Column[] = [], calendar: TransactionalPage | null = null, nearby: string[] = [], moreGroups = false, nextGroup: GroupCursor | null = null;
    if (view.kind === "calendar") {
      const range = calendarRange(view.dateField!,month);
      const result = await readPage({ ...base, limit: 50, range, ...(view.sort ? {sort:view.sort} : {}), ...(calendarPosition.after ? {after:{...calendarPosition.after}} : {}) });
      calendar = parseCalendarPage(result,fields.map(field=>field.fieldId),range);
      // An empty month reads the nearest record on each side, so the calendar can offer to go there.
      // If either read fails, the offer is left out, because that side might hold the closer record.
      const nearest = async (start: string, end: string, direction: "asc" | "desc") => {
        const outside = { fieldId: range.fieldId, start, end };
        const value = parseCalendarPage(await readPage({ ...base, limit: 1, range: outside, sort: { fieldId: range.fieldId, direction } }),fields.map(field=>field.fieldId),outside).rows[0]?.values[range.fieldId];
        return typeof value === "string" ? [value] : [];
      };
      if (!calendar.rows.length && !calendarPosition.after) {
        try { nearby = (await Promise.all([nearest("0001-01-01",range.start,"desc"), nearest(range.end,"9999-12-31","asc")])).flat(); }
        catch { signal.throwIfAborted(); }
      }
    } else {
      const field = fields.find(field=>field.fieldId===view.groupBy);
      if (!field) throw Error("Choose a readable field for this board.");
      let values: AppBackendJson[];
      if (field.type === "select" || field.type === "checkbox") {
        const all: AppBackendJson[] = [...(field.required ? [] : [null]), ...(field.type === "select" ? field.options ?? [] : [false,true])];
        values = all.slice(offset,offset+BOARD_GROUP_PAGE_SIZE); moreGroups = offset+values.length < all.length;
      } else {
        const result = parseGroups(await readPage({ ...base, limit: BOARD_GROUP_PAGE_SIZE, groupBy: field.fieldId, ...(groupAfter ? {groupAfter} : {}) }),field.fieldId);
        values = result.values; nextGroup = result.next; moreGroups = nextGroup !== null;
      }
      const ids = new Set<string>();
      // Sequential reads bound both host admission and renderer memory: at most 8 columns × 50 records.
      for (const value of values) {
        const position = positions[JSON.stringify(value)] ?? beginning();
        const group = {fieldId:field.fieldId,value};
        const result = await readPage({ ...base, limit:50, group, ...(view.sort ? {sort:view.sort} : {}), ...(position.after ? {after:{...position.after}} : {}) });
        const rawGroup = object(result).group, acknowledged = rawGroup && object(rawGroup);
        if (!acknowledged || acknowledged.fieldId!==field.fieldId || JSON.stringify(acknowledged.value)!==JSON.stringify(value)) throw Error("This Collection's read action does not support boards. Update its rules, then try again.");
        const page = parsePage(result,fields.map(field=>field.fieldId));
        for (const row of page.rows) {
          const id = JSON.stringify(row.id);
          if (JSON.stringify(row.values[field.fieldId] ?? null)!==JSON.stringify(value)) throw Error("This Collection's read action did not filter the board. Update its rules, then try again.");
          if (ids.has(id)) throw Error("Records changed while loading this board. Refresh to try again.");
          ids.add(id);
        }
        columns.push({value,page});
      }
    }
    return {columns,calendar,nearby,moreGroups,nextGroup};
  }
  const readLatest = useRef(readView); readLatest.current = readView;
  useEffect(() => {
    const request = ++current.current, abort = new AbortController();
    const { onError, onBusy } = latest.current;
    setLoaded(null); setBusy(true); onBusy(true); reading.current = true;
    void readView(abort.signal).then(next => {
      if (request===current.current&&!abort.signal.aborted) { setLoaded(next); latest.current.onLoaded(); }
    }).catch(error => {
      if(request===current.current&&!abort.signal.aborted) onError("dohc could not open this view.",error,()=>{if(request===current.current)setAttempt(value=>value+1);});
    }).finally(()=>{if(request===current.current&&!abort.signal.aborted){reading.current=false;setBusy(false);onBusy(false);}});
    return ()=>{abort.abort(); current.current++; onBusy(false);};
  },[queryKey]);
  // A change elsewhere waits for a read in flight, then replaces what shows without a loading state.
  // One that fails keeps what the view shows, which Refresh reads again.
  const changedSeen = useRef(props.changed);
  useEffect(() => {
    if (changedSeen.current === props.changed || busy || reading.current) return;
    changedSeen.current = props.changed;
    const request = ++current.current, abort = new AbortController();
    void readLatest.current(abort.signal).then(next => {
      if (request!==current.current||abort.signal.aborted) return;
      setLoaded(next);
      latest.current.onLoaded();
      latest.current.onReadInPlace(next.calendar?.rows ?? next.columns.flatMap(column=>column.page.rows));
    }, () => undefined);
    return () => abort.abort();
  },[props.changed, busy]);

  const disabled = props.disabled || busy;
  const rows = loaded?.calendar?.rows ?? loaded?.columns.flatMap(column=>column.page.rows) ?? [];
  const indexed = new Map(rows.map(row=>[JSON.stringify(row.id),row]));
  const move = (change: CollectionCellChange) => {
    if (disabled || !props.canMove(change.field)) return;
    const row = indexed.get(change.recordId);
    if (row) props.onMove(row,change.field,change.value as AppBackendJson);
  };
  const groups: CollectionRecordGroup[] = loaded?.columns.map(column=>({value:column.value,records:column.page.rows.map(row=>visualRecord(row,props.fields))}))??[];
  function pageControls(position: Position, page: TransactionalPage, onChange: (next:Position)=>void, label: string, showCount = true) {
    const count = `${page.rows.length} on this page${page.nextCursor ? " · More records" : ""}`;
    return <div className="flex items-center justify-end gap-1 pt-2 text-[12px] text-muted">
      <span className={showCount ? "mr-auto text-[12px]" : "sr-only"}>{count}</span>
      <IconButton aria-label={`Previous records in ${label}`} title={`Previous records in ${label}`} disabled={disabled||!position.history.length} onClick={()=>onChange({after:position.history.at(-1)??null,history:position.history.slice(0,-1)})}><ChevronLeft size={14} strokeWidth={1.9} aria-hidden /></IconButton>
      <IconButton aria-label={`Next records in ${label}`} title={`Next records in ${label}`} disabled={disabled||!page.nextCursor} onClick={()=>onChange({after:page.nextCursor,history:[...position.history,position.after]})}><ChevronRight size={14} strokeWidth={1.9} aria-hidden /></IconButton></div>;
  }
  // A view that could not open shows nothing; the page says why and offers Try again.
  if(!loaded) return busy ? <SkeletonRows label="Loading view…" /> : null;
  const visibleFields = [...props.fields.filter(field=>field.type==="text"),...props.fields.filter(field=>field.type!=="text")].map(field=>field.fieldId);
  return <div className="flex min-h-0 flex-1 flex-col gap-2" aria-busy={busy}>
    {props.view.kind==="board" ? <>
      <div className="min-h-0 flex-1"><BoardView schema={schema} groups={groups} groupBy={props.view.groupBy!} visibleFields={visibleFields.length > 1 ? visibleFields.filter(fieldId=>fieldId!==props.view.groupBy) : visibleFields}
        onCellChange={!disabled&&props.canMove(props.view.groupBy!)?move:undefined} onOpenRecord={record=>{const row=indexed.get(record.id);if(row&&!disabled)props.onOpen(row);}}
        groupCount={(_group,index)=>`${loaded.columns[index]!.page.rows.length}${loaded.columns[index]!.page.nextCursor ? "+" : ""}`}
        groupFooter={(_group,index)=>{const column=loaded.columns[index]!,key=JSON.stringify(column.value);return pageControls(positions[key]??beginning(),column.page,next=>setPositions({...positions,[key]:next}),display(column.value)||"No value",false);}} /></div>
      {groups.length===0&&<p className="m-0 text-sm text-muted">No records match this board. Change the filters or add a record.</p>}
      <footer className="flex items-center gap-2 text-[12px] text-muted"><span className="mr-auto">{groups.length} groups · Card counts are for this page{loaded.moreGroups?" · More groups":""}</span>
        <IconButton aria-label="Previous groups" title="Previous groups" disabled={disabled||!groupHistory.length} onClick={()=>{setOffset(Math.max(0,offset-BOARD_GROUP_PAGE_SIZE));setGroupAfter(groupHistory.at(-1)??null);setGroupHistory(groupHistory.slice(0,-1));setPositions({});}}><ChevronLeft size={16} strokeWidth={1.9} aria-hidden /></IconButton>
        <IconButton aria-label="Next groups" title="Next groups" disabled={disabled||!loaded.moreGroups} onClick={()=>{setOffset(offset+BOARD_GROUP_PAGE_SIZE);setGroupAfter(loaded.nextGroup);setGroupHistory([...groupHistory,groupAfter]);setPositions({});}}><ChevronRight size={16} strokeWidth={1.9} aria-hidden /></IconButton></footer>
    </> : <>
      <div className="min-h-80 flex-1"><CalendarView schema={schema} records={rows.map(row=>visualRecord(row,props.fields))} dateField={props.view.dateField!} visibleFields={visibleFields}
        date={month} nearbyDates={loaded.nearby} onNavigate={date=>{if(!disabled){setMonth(date);setCalendarPosition(beginning());}}}
        onCellChange={!disabled&&props.canMove(props.view.dateField!)?move:undefined} onOpenRecord={record=>{const row=indexed.get(record.id);if(row&&!disabled)props.onOpen(row);}} /></div>
      <span className="text-[12px] text-muted">Records without a date appear in the table.</span>
      {pageControls(calendarPosition,loaded.calendar!,setCalendarPosition,"this calendar")}
    </>}
  </div>;
}
