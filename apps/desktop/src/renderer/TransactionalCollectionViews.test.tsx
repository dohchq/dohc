// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BoardViewProps, CalendarViewProps } from "@dohc/collection-views";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { deferred } from "../testing/deferred";
import { TransactionalCollectionPage, type TransactionalInvoke, type TransactionalDatasetDescription } from "./TransactionalCollectionPage";
import type { CollectionTableView } from "./collectionTableViews";
vi.mock("@dohc/collection-views",()=>({
  BoardView: (props:BoardViewProps)=><div>{props.groups.map((group,index)=><section key={index} aria-label={String(group.value)}>{group.records.map(record=><div key={record.id}>{record.values.find(value=>value.field==="name")?.value as string}<button disabled={!props.onCellChange} onClick={()=>props.onCellChange?.({recordId:record.id,recordPath:"",field:props.groupBy,value:"Done"})}>Move {record.id}</button></div>)}{props.groupFooter?.(group,index)}</section>)}</div>,
  CalendarView: (props:CalendarViewProps)=><div><button onClick={()=>props.onNavigate?.(new Date(2027,0,1))}>January</button>{props.records.map(record=><span key={record.id}>{record.id}</span>)}</div>,
}));
const dataset:TransactionalDatasetDescription={datasetId:"dataset",name:"Work",revision:1,revisionSha256:"a".repeat(64),tables:[{tableId:"table",name:"Tasks",fields:[
  {fieldId:"name",name:"Name",type:"text",required:true,unique:false},
  {fieldId:"status",name:"Status",type:"select",options:["Todo","Done"],required:true,unique:false},
  {fieldId:"date",name:"Date",type:"date",required:false,unique:false},
]}],operations:[
  {operationId:"read",name:"read",label:"Read",kind:"read",tableId:"table",readOnly:true,access:"owner",fieldIds:["name","status","date"]},
  {operationId:"edit",name:"edit",label:"Edit",kind:"edit",tableId:"table",readOnly:false,reversible:true,access:"owner",fieldIds:["status","date"]},
]};
const board:CollectionTableView={viewId:"board",name:"Board",kind:"board",groupBy:"status",search:"",filters:[],sort:null};
const calendar:CollectionTableView={...board,viewId:"calendar",name:"Calendar",kind:"calendar",dateField:"date"};
const empty={rows:[],nextCursor:null};
function setup(invoke:(request:TransactionalInvoke,signal:AbortSignal)=>Promise<{result:AppBackendJson}>,view=board) {
  const props={workspaceId:"w",dataset,tableId:"table",invoke,onError:vi.fn(),onNotice:vi.fn(),activeView:view};
  return {...render(<TransactionalCollectionPage {...props}/>),props};
}
afterEach(cleanup);
it("queries every board group beyond the first table page and pages each independently",async()=>{
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    const input=request.input as Record<string,AppBackendJson>,group=input.group as {fieldId:string;value:string};
    if(!group)throw Error("A board must not request the first table page");
    const next=input.after ? null : {id:50,value:50};
    return {result:{group,rows:group.value==="Todo"?[{id:input.after?51:1,version:7,values:{name:input.after?"Later task":"First task",status:"Todo"}}]:[{id:99,version:1,values:{name:"Other group",status:"Done"}}],nextCursor:group.value==="Todo"?next:null}};
  });
  const result=setup(invoke);
  await screen.findByText("Other group");
  fireEvent.click(screen.getByRole("button",{name:"Next records in Todo"}));
  await screen.findByText("Later task");
  expect(invoke.mock.calls.some(([request])=>(request.input as Record<string,AppBackendJson>).after!==undefined)).toBe(true);
  expect(result.props.onError).not.toHaveBeenCalled();
});
it("routes board moves through approved edits with the real version, then offers Undo",async()=>{
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    if(request.operationId==="edit")return {result:{id:4,version:8,priorValues:{status:"Todo"}}};
    const group=(request.input as Record<string,AppBackendJson>).group as {fieldId:string;value:string};
    return {result:{...empty,group,rows:group.value==="Todo"?[{id:4,version:7,values:{name:"Task",status:"Todo"}}]:[]}};
  });
  setup(invoke);
  fireEvent.click(await screen.findByRole("button",{name:"Move 4"}));
  await screen.findByRole("button",{name:"Undo last edit"});
  expect(invoke.mock.calls.find(([request])=>request.operationId==="edit")?.[0]).toMatchObject({workspaceId:"w",datasetId:"dataset",revision:1,operationId:"edit",input:{id:4,expectedVersion:7,values:{status:"Done"}}});
});
it("does not move offline records and refuses an authored read that ignores board filtering",async()=>{
  const invoke=vi.fn(async()=>({result:{...empty,rows:[{id:4,version:7,values:{name:"Task",status:"Todo"}}]}}));
  const result=setup(invoke);
  await waitFor(()=>expect(result.props.onError).toHaveBeenCalled());
  expect(screen.queryByText("Task")).toBeNull();
  invoke.mockImplementation(async(request?:TransactionalInvoke)=>({result:{...empty,group:(request!.input as Record<string,AppBackendJson>).group!,rows:[{id:4,version:7,values:{name:"Task",status:"Todo"}}]}}));
  result.rerender(<TransactionalCollectionPage {...result.props} dataset={{...dataset,tables:[{...dataset.tables[0]!,fields:dataset.tables[0]!.fields.map(field=>field.fieldId==="status"?{...field,options:["Todo"]}:field)}]}} copy={{offline:true,savedAtMs:1}}/>);
  expect((await screen.findByRole("button",{name:"Move 4"})).hasAttribute("disabled")).toBe(true);
});
it("loads the visible calendar range and changes range on navigation",async()=>{
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{const input=request.input as Record<string,AppBackendJson>;return {result:{...empty,range:input.range!}};});
  setup(invoke,calendar);
  fireEvent.click(await screen.findByRole("button",{name:"January"}));
  await waitFor(()=>expect(invoke.mock.calls.at(-1)?.[0].input).toMatchObject({range:{fieldId:"date",start:"2026-12-27",end:"2027-02-07"},limit:50}));
});
it("offers layout changes to readers without owner view-source controls",async()=>{
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{const input=request.input as Record<string,AppBackendJson>;return {result:{...empty,...(input.range?{range:input.range}:{}),...(input.group?{group:input.group}:{})}};});
  setup(invoke,{...board,kind:"table"});
  await waitFor(()=>expect(screen.getByLabelText("Collection layout").hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText("Collection layout"),{target:{value:"calendar"}});
  await screen.findByRole("button",{name:"January"});
  expect(screen.queryByRole("button",{name:"Views"})).toBeNull();
  expect((screen.getByLabelText("Calendar date") as HTMLSelectElement).value).toBe("date");
});
it("paginates calendar results without implying the first 50 events cover the month",async()=>{
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    const input=request.input as Record<string,AppBackendJson>,range=input.range as {fieldId:string;start:string;end:string};
    return {result:{range,rows:[{id:input.after?51:1,version:1,values:{date:range.start}}],nextCursor:input.after?null:{id:1,value:1}}};
  });
  setup(invoke,calendar);
  await screen.findByText("1 on this page · More records");
  fireEvent.click(screen.getByRole("button",{name:"Next records in this calendar"}));
  await screen.findByText("51");
  expect(invoke.mock.calls.at(-1)?.[0].input).toMatchObject({after:{id:1,value:1}});
});
it("ignores reads from a previous workspace",async()=>{
  const pending=deferred<{result:AppBackendJson}>();
  const invoke=vi.fn(async(request:TransactionalInvoke)=>request.workspaceId==="w"?pending.promise:{result:{...empty,range:(request.input as Record<string,AppBackendJson>).range!}});
  const result=setup(invoke,calendar);
  await waitFor(()=>expect(invoke).toHaveBeenCalled());
  result.rerender(<TransactionalCollectionPage {...result.props} workspaceId="next"/>);
  await screen.findByRole("button",{name:"January"});
  await act(async()=>pending.resolve({result:{rows:[{id:"private",version:1,values:{name:"Private"}}],nextCursor:null}}));
  expect(result.props.onError).not.toHaveBeenCalled();expect(screen.queryByText("private")).toBeNull();
});
