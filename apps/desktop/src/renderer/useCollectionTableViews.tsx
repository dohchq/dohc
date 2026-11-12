import { useEffect, useRef, useState, type ReactNode } from "react";
import { datasetColumnFields, type DatasetDescription } from "@dohc/security-contract/dataset";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass, selectClass } from "./collections/FieldForm";
import { CollectionTableView, readTableViews, validateTableView, writeTableViews, type TableViewsSnapshot } from "./collectionTableViews";
import type { NewCollectionView } from "./collections/CollectionFrame";
import { withErrorWords } from "../ipc/errorWords";
import { isGeneratedRecordIdField, supportsSort, type TransactionalField } from "./transactionalCollectionModel";

function FilterValue({field,value,disabled,onChange}:{field?:TransactionalField;value:CollectionTableView["filters"][number]["value"];disabled:boolean;onChange(value:CollectionTableView["filters"][number]["value"]):void}) {
  if(field?.type==="checkbox"||field?.type==="select")return <select aria-label="Filter value" className={selectClass} disabled={disabled} value={value===null?"":String(value)} onChange={event=>onChange(event.target.value===""?null:field.type==="checkbox"?event.target.value==="true":event.target.value)}><option value="">Empty</option>{field.type==="checkbox"?<><option value="true">Yes</option><option value="false">No</option></>:field.options?.map(option=><option key={option} value={option}>{option}</option>)}</select>;
  return <input aria-label="Filter value" className={inputClass} disabled={disabled} type={field?.type==="number"?"number":field?.type==="date"?"date":"text"} placeholder="Empty" value={value===null?"":typeof value==="object"?JSON.stringify(value):String(value)} onChange={event=>onChange(event.target.value===""?null:field?.type==="number"?Number(event.target.value):event.target.value)}/>;
}

/** A table's saved views: the tabs a person who can save views gets, and what each tab's controls do. */
export interface CollectionTableViewsState {
  /** The saved views, in the order their file lists them. */
  list: readonly CollectionTableView[];
  /** The open saved view, or null for All records. */
  active: CollectionTableView | null;
  /** The views file is being read or written. */
  busy: boolean;
  select(viewId: string | null): void;
  /** Saves a new view and opens it. Answers what went wrong as a sentence, or null. */
  create(view: NewCollectionView): Promise<string | null>;
  rename(viewId: string, name: string): Promise<string | null>;
  /** Deletes a view, and offers Undo. */
  remove(viewId: string): void;
  /** Saves the field a board groups by, or the date field a calendar uses. */
  setField(viewId: string, field: { groupBy: string } | { dateField: string }): void;
  /** Opens the editor on a view's name, layout, search, sort and filters. */
  edit(viewId: string): void;
  /** Opens the list of views. */
  manage(): void;
  /** The list of views and the view editor, while open. */
  dialog: ReactNode;
}

const VIEW_LIMIT = 50;
const NOT_READ = "dohc could not read this Collection's views. Try again.";

/**
 * Reads and writes a Data Collection table's saved views, in
 * `collection-views/<datasetId>/<tableId>.json`. Every write names the
 * content hash it read, so a file changed elsewhere is never overwritten.
 * Which view is open is kept on this computer. Null until the Collection is
 * read, and for someone who cannot save views.
 */
export function useCollectionTableViews(props:{enabled:boolean;workspaceId:string;dataset:DatasetDescription|null;tableId:string;onError(message:string,error:unknown,retry?:()=>void):void;onNotice?(message:string,undo?:()=>void):void}):CollectionTableViewsState|null {
  const {workspaceId,tableId,onError}=props,dataset=props.enabled?props.dataset:null;
  const [snapshot,setSnapshot]=useState<TableViewsSnapshot|null>(null),[active,setActive]=useState<CollectionTableView|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false);
  const [draft,setDraft]=useState<CollectionTableView|null>(null),[problem,setProblem]=useState<string|null>(null),[undo,setUndo]=useState<CollectionTableView|null>(null);
  const current=useRef(0),controller=useRef(new AbortController()),saving=useRef(false);
  // What the file held at its last read, for a save that starts after this render, as an Undo does.
  const held=useRef<TableViewsSnapshot|null>(null);
  const selected=active?.viewId??"";
  const selectionKey=JSON.stringify(["dohc-collection-view",workspaceId,dataset?.datasetId,tableId]);
  const table=dataset?.tables.find(table=>table.tableId===tableId),read=dataset?.operations.find(operation=>operation.tableId===tableId&&operation.kind==="read"&&operation.readOnly);
  const fields=table?datasetColumnFields(table).filter(field=>read?.fieldIds.includes(field.fieldId)&&!isGeneratedRecordIdField(field)):[];
  const filterFields=fields.filter(field=>!["relation","attachment","multi-select"].includes(field.type));
  function keep(next:TableViewsSnapshot|null) {held.current=next;setSnapshot(next);}
  function select(view:CollectionTableView|null) {
    if(!dataset)return;
    try {if(view)validateTableView(view,dataset,tableId);setActive(view);localStorage.setItem(selectionKey,view?.viewId??"");}
    catch(error){setActive(null);onError("Could not open this saved view.",error);}
  }
  async function refresh() {
    if(!dataset)return;
    const request=++current.current;setBusy(true);
    try {
      const loaded=await readTableViews(workspaceId,dataset.datasetId,tableId,controller.current.signal);
      if(request!==current.current)return;keep(loaded);
      const prior=localStorage.getItem(selectionKey),view=loaded.document.views.find(view=>view.viewId===prior)??null;
      select(view);
    }catch(error){if(request===current.current&&!controller.current.signal.aborted)onError("Could not read saved views.",error,()=>{void refresh();});}
    finally{if(request===current.current)setBusy(false);}
  }
  useEffect(()=>{
    if(!dataset)return;
    controller.current=new AbortController();void refresh();return()=>{current.current++;controller.current.abort();};
  },[workspaceId,dataset?.datasetId,dataset?.revisionSha256,tableId]);
  /** Writes the views and opens `selection`. Answers what went wrong, or null. A caller that shows the answer in place passes `report: false`. */
  async function save(views:CollectionTableView[],selection:CollectionTableView|null,after?:()=>void,report=true):Promise<string|null> {
    const previous=held.current;
    if(!previous){void refresh();return NOT_READ;}
    if(saving.current)return "dohc is saving another change to these views. Try again.";
    saving.current=true;setBusy(true);const request=current.current;
    try {
      const next=await writeTableViews(workspaceId,previous,{...previous.document,views},controller.current.signal);
      if(request!==current.current)return null;keep(next);select(next.document.views.find(view=>view.viewId===selection?.viewId)??null);after?.();
      return null;
    }catch(error){
      if(request!==current.current||controller.current.signal.aborted)return null;
      if(report)onError("Could not save Collection views.",error,()=>{void refresh();});
      return withErrorWords("dohc could not save this view.",error);
    }
    finally{saving.current=false;if(request===current.current)setBusy(false);}
  }
  /** The view as its file takes it, or an error whose message says what to fix. */
  function checked(view:CollectionTableView):CollectionTableView {
    if(!dataset)throw Error(NOT_READ);
    if(!view.name.trim())throw Error("Give the view a name.");
    const parsed=CollectionTableView.parse(view);validateTableView(parsed,dataset,tableId);
    // Saving a calendar needs a date field. A saved one whose field is gone still opens, and asks for one.
    if(parsed.kind==="calendar"&&!fields.some(field=>field.fieldId===parsed.dateField&&field.type==="date"))throw Error("Choose a readable date field for this calendar.");
    if(held.current?.document.views.some(view=>view.viewId!==parsed.viewId&&view.name===parsed.name))throw Error("A view already has this name. Choose another name.");
    return parsed;
  }
  /** Saves one view, new or changed, and opens it. What is wrong with the view is answered, never reported. */
  async function put(view:CollectionTableView,report:boolean,after?:()=>void):Promise<string|null> {
    const saved=held.current?.document.views;
    if(!saved){void refresh();return NOT_READ;}
    let parsed:CollectionTableView;
    try {parsed=checked(view);}
    catch(error){return error instanceof Error?error.message:"Check this view's fields.";}
    const exists=saved.some(view=>view.viewId===parsed.viewId);
    if(!exists&&saved.length>=VIEW_LIMIT)return `A Collection holds ${VIEW_LIMIT} views. Delete one, then add this one.`;
    return save(exists?saved.map(view=>view.viewId===parsed.viewId?parsed:view):[...saved,parsed],parsed,after,report);
  }
  function saveDraft() {
    if(!draft||!snapshot)return;
    try {
      const parsed=checked(draft);
      const exists=snapshot.document.views.some(view=>view.viewId===parsed.viewId),views=exists?snapshot.document.views.map(view=>view.viewId===parsed.viewId?parsed:view):[...snapshot.document.views,parsed];
      void save(views,parsed,()=>{setDraft(null);setProblem(null);});
    }catch(error){setProblem(error instanceof Error?error.message:"Check this view's fields.");}
  }
  const views=snapshot?.document.views??[];
  if(!dataset)return null;
  const find=(viewId:string)=>held.current?.document.views.find(view=>view.viewId===viewId);
  /**
   * Puts back a view its notice's Undo names. The notice outlives this page, so the
   * write reads the file itself, and names the hash it read. An open page then shows the view.
   */
  const restoreDeleted=async(view:CollectionTableView)=>{
    const signal=new AbortController().signal;
    try {
      const now=await readTableViews(workspaceId,dataset.datasetId,tableId,signal);
      await writeTableViews(workspaceId,now,{...now.document,views:[...now.document.views,view]},signal);
    }catch(error){onError("dohc could not put this view back.",error);return;}
    if(controller.current.signal.aborted)return;
    localStorage.setItem(selectionKey,view.viewId);void refresh();
  };
  const dialog=<>
    {open&&<Overlay onClose={busy?undefined:()=>{setOpen(false);setDraft(null);setProblem(null);}}><section aria-label="Collection views" className="dohc-elevated flex max-h-[85vh] w-130 max-w-[85vw] flex-col gap-3 overflow-auto rounded-xl border border-line bg-panel p-5">
      <header className="flex items-center justify-between"><h2 className="m-0 text-base font-semibold text-ink">Views</h2><SecondaryButton disabled={busy} onClick={()=>{void refresh();}}>Refresh views</SecondaryButton></header>
      {views.length===0&&<p className="m-0 text-sm text-muted">No saved views yet. Create a view for the records you need.</p>}
      {views.map(view=><div key={view.viewId} className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13px] text-ink">{view.name}</span>
        <SecondaryButton aria-label={`Edit view ${view.name}`} disabled={busy} onClick={()=>{setDraft(structuredClone(view));setProblem(null);}}>Edit</SecondaryButton>
        <SecondaryButton aria-label={`Delete view ${view.name}`} disabled={busy} onClick={()=>{void save(views.filter(item=>item.viewId!==view.viewId),selected===view.viewId?null:views.find(item=>item.viewId===selected)??null,()=>setUndo(view));}}>Delete</SecondaryButton></div>)}
      {undo&&<SecondaryButton disabled={busy} onClick={()=>{void save([...views,undo],undo,()=>setUndo(null));}}>Undo view deletion</SecondaryButton>}
      {!draft?<SecondaryButton disabled={busy||!snapshot||views.length>=50} onClick={()=>{setDraft({viewId:crypto.randomUUID(),name:"",kind:"table",search:"",filters:[],sort:null});setProblem(null);}}>Create view</SecondaryButton>:<form className="flex flex-col gap-3 border-t border-line pt-3" onSubmit={event=>{event.preventDefault();saveDraft();}}>
        <label className="text-[13px] text-muted">View name<input aria-label="View name" autoFocus className={inputClass} maxLength={100} disabled={busy} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
        <label className="text-[13px] text-muted">Layout<select aria-label="View layout" className={selectClass} disabled={busy} value={draft.kind} onChange={event=>setDraft({...draft,kind:event.target.value as CollectionTableView["kind"],groupBy:undefined,dateField:undefined})}><option value="table">Table</option><option value="board">Board</option><option value="calendar">Calendar</option></select></label>
        {draft.kind==="board"&&<label className="text-[13px] text-muted">Group by<select aria-label="Board group field" className={selectClass} disabled={busy} value={draft.groupBy??""} onChange={event=>setDraft({...draft,groupBy:event.target.value||undefined})}><option value="">Choose a field</option>{fields.filter(supportsSort).map(field=><option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select></label>}
        {draft.kind==="calendar"&&<label className="text-[13px] text-muted">Date<select aria-label="Calendar date field" className={selectClass} disabled={busy} value={draft.dateField??""} onChange={event=>setDraft({...draft,dateField:event.target.value||undefined})}><option value="">Choose a date field</option>{fields.filter(field=>field.type==="date").map(field=><option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select></label>}
        <label className="text-[13px] text-muted">Search<input aria-label="View search" className={inputClass} maxLength={200} disabled={busy} value={draft.search} onChange={event=>setDraft({...draft,search:event.target.value})}/></label>
        <div className="flex gap-2"><select aria-label="Sort view by" className={selectClass} disabled={busy} value={draft.sort?.fieldId??""} onChange={event=>setDraft({...draft,sort:event.target.value?{fieldId:event.target.value,direction:draft.sort?.direction??"asc"}:null})}><option value="">Record order</option>{fields.filter(supportsSort).map(field=><option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select>
          {draft.sort&&<select aria-label="View sort direction" className={selectClass} disabled={busy} value={draft.sort.direction} onChange={event=>setDraft({...draft,sort:{...draft.sort!,direction:event.target.value as "asc"|"desc"}})}><option value="asc">Ascending</option><option value="desc">Descending</option></select>}</div>
        {draft.filters.map((filter,index)=>{const field=fields.find(field=>field.fieldId===filter.fieldId);return <div key={index} className="flex items-center gap-2">
          <select aria-label={`Filter ${index+1} field`} disabled={busy} className={selectClass} value={filter.fieldId} onChange={event=>setDraft({...draft,filters:draft.filters.map((item,i)=>i===index?{fieldId:event.target.value,value:null}:item)})}>{!filterFields.some(field=>field.fieldId===filter.fieldId)&&<option value={filter.fieldId}>Choose another field</option>}{filterFields.map(field=><option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select><span className="text-[12px] text-muted">is</span>
          <FilterValue field={field} value={filter.value} disabled={busy} onChange={value=>setDraft({...draft,filters:draft.filters.map((item,i)=>i===index?{...item,value}:item)})}/>
          <SecondaryButton aria-label={`Remove filter ${index+1}`} disabled={busy} onClick={()=>setDraft({...draft,filters:draft.filters.filter((_,i)=>i!==index)})}>Remove</SecondaryButton></div>;})}
        <SecondaryButton disabled={busy||draft.filters.length>=20||filterFields.length===0} onClick={()=>setDraft({...draft,filters:[...draft.filters,{fieldId:filterFields[0]!.fieldId,value:null}]})}>Add filter</SecondaryButton>
        {problem&&<p role="alert" className="m-0 text-sm text-danger">{problem}</p>}
        <div className="flex gap-2"><PrimaryButton type="submit" disabled={busy}>Save view</PrimaryButton><SecondaryButton disabled={busy} onClick={()=>{setDraft(null);setProblem(null);}}>Cancel</SecondaryButton></div>
      </form>}
      <SecondaryButton disabled={busy} onClick={()=>{setOpen(false);setDraft(null);}}>Done</SecondaryButton>
    </section></Overlay>}
  </>;
  return {
    list:views,active,busy,dialog,
    select:viewId=>select(viewId===null?null:find(viewId)??null),
    create:view=>put({viewId:crypto.randomUUID(),name:view.name,kind:view.kind,search:"",filters:[],sort:null,...(view.groupBy?{groupBy:view.groupBy}:{}),...(view.dateField?{dateField:view.dateField}:{})},false),
    rename:async(viewId,name)=>{const view=find(viewId);return view?put({...view,name},false):NOT_READ;},
    remove:viewId=>{
      const view=find(viewId);
      if(!view)return;
      const {onNotice}=props;
      // The notice holds the Undo. Without a notice, the list of views opens, where Undo view deletion is.
      void save((held.current?.document.views??[]).filter(item=>item.viewId!==viewId),active?.viewId===viewId?null:active,()=>{
        if(onNotice)onNotice(`Deleted the view ${view.name}`,()=>{void restoreDeleted(view);});
        else{setUndo(view);setOpen(true);}
      });
    },
    setField:(viewId,field)=>{const view=find(viewId);if(view)void put({...view,...field},false).then(failure=>{if(failure!==null)onError(failure,new Error(failure));});},
    edit:viewId=>{const view=find(viewId);if(!view)return;setDraft(structuredClone(view));setProblem(null);setOpen(true);},
    manage:()=>setOpen(true),
  };
}
