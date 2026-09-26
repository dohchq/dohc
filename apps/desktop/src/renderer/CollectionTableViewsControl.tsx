import { useEffect, useRef, useState } from "react";
import { datasetColumnFields, type DatasetDescription } from "@dohc/security-contract/dataset";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass, selectClass } from "./collections/FieldForm";
import { CollectionTableView, readTableViews, validateTableView, writeTableViews, type TableViewsSnapshot } from "./collectionTableViews";
import { isGeneratedRecordIdField, supportsSort, type TransactionalField } from "./transactionalCollectionModel";

function FilterValue({field,value,disabled,onChange}:{field?:TransactionalField;value:CollectionTableView["filters"][number]["value"];disabled:boolean;onChange(value:CollectionTableView["filters"][number]["value"]):void}) {
  if(field?.type==="checkbox"||field?.type==="select")return <select aria-label="Filter value" className={selectClass} disabled={disabled} value={value===null?"":String(value)} onChange={event=>onChange(event.target.value===""?null:field.type==="checkbox"?event.target.value==="true":event.target.value)}><option value="">Empty</option>{field.type==="checkbox"?<><option value="true">Yes</option><option value="false">No</option></>:field.options?.map(option=><option key={option} value={option}>{option}</option>)}</select>;
  return <input aria-label="Filter value" className={inputClass} disabled={disabled} type={field?.type==="number"?"number":field?.type==="date"?"date":"text"} placeholder="Empty" value={value===null?"":typeof value==="object"?JSON.stringify(value):String(value)} onChange={event=>onChange(event.target.value===""?null:field?.type==="number"?Number(event.target.value):event.target.value)}/>;
}

export function CollectionTableViewsControl(props:{disabled?:boolean;workspaceId:string;dataset:DatasetDescription;tableId:string;onSelect(view:CollectionTableView|null):void;onError(message:string,error:unknown,retry?:()=>void):void}) {
  const {workspaceId,dataset,tableId,onError}=props;
  const [snapshot,setSnapshot]=useState<TableViewsSnapshot|null>(null),[selected,setSelected]=useState(""),[open,setOpen]=useState(false),[busy,setBusy]=useState(false);
  const [draft,setDraft]=useState<CollectionTableView|null>(null),[problem,setProblem]=useState<string|null>(null),[undo,setUndo]=useState<CollectionTableView|null>(null);
  const current=useRef(0),controller=useRef(new AbortController()),saving=useRef(false);
  const selectionKey=JSON.stringify(["dohc-collection-view",workspaceId,dataset.datasetId,tableId]);
  const table=dataset.tables.find(table=>table.tableId===tableId),read=dataset.operations.find(operation=>operation.tableId===tableId&&operation.kind==="read"&&operation.readOnly);
  const fields=table?datasetColumnFields(table).filter(field=>read?.fieldIds.includes(field.fieldId)&&!isGeneratedRecordIdField(field)):[];
  const filterFields=fields.filter(field=>!["relation","attachment","multi-select"].includes(field.type));
  function select(view:CollectionTableView|null) {
    try {if(view)validateTableView(view,dataset,tableId);setSelected(view?.viewId??"");props.onSelect(view);localStorage.setItem(selectionKey,view?.viewId??"");}
    catch(error){setSelected("");props.onSelect(null);onError("Could not open this saved view.",error);}
  }
  async function refresh() {
    const request=++current.current;setBusy(true);
    try {
      const loaded=await readTableViews(workspaceId,dataset.datasetId,tableId,controller.current.signal);
      if(request!==current.current)return;setSnapshot(loaded);
      const prior=localStorage.getItem(selectionKey),view=loaded.document.views.find(view=>view.viewId===prior)??null;
      select(view);
    }catch(error){if(request===current.current&&!controller.current.signal.aborted)onError("Could not read saved views.",error,()=>{void refresh();});}
    finally{if(request===current.current)setBusy(false);}
  }
  useEffect(()=>{controller.current=new AbortController();void refresh();return()=>{current.current++;controller.current.abort();};},[workspaceId,dataset.datasetId,dataset.revisionSha256,tableId]);
  async function save(views:CollectionTableView[],selection:CollectionTableView|null,after?:()=>void) {
    if(!snapshot||saving.current)return;saving.current=true;setBusy(true);const request=current.current;
    try {
      const next=await writeTableViews(workspaceId,snapshot,{...snapshot.document,views},controller.current.signal);
      if(request!==current.current)return;setSnapshot(next);select(next.document.views.find(view=>view.viewId===selection?.viewId)??null);after?.();
    }catch(error){if(request===current.current&&!controller.current.signal.aborted)onError("Could not save Collection views.",error,()=>{void refresh();});}
    finally{saving.current=false;if(request===current.current)setBusy(false);}
  }
  function saveDraft() {
    if(!draft||!snapshot)return;
    try {
      if(!draft.name.trim())throw Error("Give the view a name.");
      const parsed=CollectionTableView.parse(draft);validateTableView(parsed,dataset,tableId);
      if(snapshot.document.views.some(view=>view.viewId!==parsed.viewId&&view.name===parsed.name))throw Error("A view already has this name. Choose another name.");
      const exists=snapshot.document.views.some(view=>view.viewId===parsed.viewId),views=exists?snapshot.document.views.map(view=>view.viewId===parsed.viewId?parsed:view):[...snapshot.document.views,parsed];
      void save(views,parsed,()=>{setDraft(null);setProblem(null);});
    }catch(error){setProblem(error instanceof Error?error.message:"Check this view's fields.");}
  }
  const views=snapshot?.document.views??[];
  return <>
    <select aria-label="Saved Collection view" className={`${selectClass.replace("w-full", "w-auto")} max-w-60`} disabled={busy||props.disabled} value={selected} onChange={event=>select(views.find(view=>view.viewId===event.target.value)??null)}>
      <option value="">All records</option>{views.map(view=><option key={view.viewId} value={view.viewId}>{view.name}</option>)}
    </select>
    <SecondaryButton disabled={busy||props.disabled} onClick={()=>setOpen(true)}>Views</SecondaryButton>
    {open&&<Overlay onClose={busy?undefined:()=>{setOpen(false);setDraft(null);setProblem(null);}}><section aria-label="Collection views" className="dohc-elevated flex max-h-[85vh] w-130 max-w-[85vw] flex-col gap-3 overflow-auto rounded-xl border border-line bg-panel p-5">
      <header className="flex items-center justify-between"><h2 className="m-0 text-sm font-semibold text-ink">Views</h2><SecondaryButton disabled={busy} onClick={()=>{void refresh();}}>Refresh views</SecondaryButton></header>
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
}
