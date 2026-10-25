// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BoardViewProps, CalendarViewProps } from "@dohc/collection-views";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { deferred } from "../testing/deferred";
import { TransactionalCollectionPage, type TransactionalInvoke, type TransactionalDatasetDescription } from "./TransactionalCollectionPage";
import type { CollectionTableView } from "./collectionTableViews";
vi.mock("@dohc/collection-views",()=>({
  BoardView: (props:BoardViewProps)=><div>{props.groups.map((group,index)=><section key={index} aria-label={String(group.value)}>{group.records.map(record=><div key={record.id}>{record.values.find(value=>value.field==="name")?.value as string}<button disabled={!props.onCellChange} onClick={()=>props.onCellChange?.({recordId:record.id,recordPath:"",field:props.groupBy,value:"Done"})}>Move {record.id}</button><button onClick={()=>props.onOpenRecord?.(record)}>Show {record.id}</button></div>)}{props.groupFooter?.(group,index)}</section>)}</div>,
  CalendarView: (props:CalendarViewProps)=><div><button onClick={()=>props.onNavigate?.(new Date(2027,0,1))}>January</button>{props.nearbyDates?.length ? <span>Nearby {props.nearbyDates.join(" ")}</span> : null}{props.records.map(record=><span key={record.id}>{record.id}<button onClick={()=>props.onOpenRecord?.(record)}>Show {record.id}</button></span>)}</div>,
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
  const props={workspaceId:"w",dataset,tableId:"table",invoke,onError:vi.fn(),onSettled:vi.fn(),onNotice:vi.fn(),activeView:view};
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
it("shows a board's failed read in the page under the table's Notices row, and drops both when the board loads",async()=>{
  const waiting=new Error("Error invoking remote method 'desktop:dataset': DatasetReopenWaitError [dataset_reopen_wait] [retryAfterMs=5000]: This Collection is waiting to reopen. Try again in 5 seconds.");
  let open=false;
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    if(!open)throw waiting;
    const group=(request.input as Record<string,AppBackendJson>).group as {fieldId:string;value:string};
    return {result:{...empty,group,rows:group.value==="Todo"?[{id:4,version:7,values:{name:"Task",status:"Todo"}}]:[]}};
  });
  const result=setup(invoke);
  expect(await screen.findByText("This Collection is waiting to reopen. Try again in 5 seconds.")).toBeTruthy();
  expect(result.props.onError).toHaveBeenCalledWith("dohc could not open this view.",waiting,expect.any(Function),"collection-load:dataset:table");
  expect(result.props.onSettled).not.toHaveBeenCalled();
  open=true;
  fireEvent.click(screen.getByRole("button",{name:"Try again"}));
  expect(await screen.findByText("Task")).toBeTruthy();
  expect(screen.queryByText(/waiting to reopen/)).toBeNull();
  expect(result.props.onSettled).toHaveBeenCalledWith("collection-load:dataset:table");
});
it("keeps a board's failure when a table read from before the switch answers late",async()=>{
  const table:CollectionTableView={viewId:"table",name:"Table",kind:"table",search:"",filters:[],sort:null};
  const late=deferred<{result:AppBackendJson}>();
  const tableReads:Array<()=>Promise<{result:AppBackendJson}>>=[async()=>({result:{...empty,rows:[{id:4,version:7,values:{name:"Task",status:"Todo"}}]}}),()=>late.promise];
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    if((request.input as Record<string,AppBackendJson>).group)throw Error("The board read failed.");
    return tableReads.shift()!();
  });
  const result=setup(invoke,table);
  await screen.findByText("Task");
  // An automation run starts a read in place, which is still out when the page switches to Board.
  result.rerender(<TransactionalCollectionPage {...result.props} recordsChanged={1}/>);
  await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(2));
  result.rerender(<TransactionalCollectionPage {...result.props} recordsChanged={1} activeView={board}/>);
  expect(await screen.findByText("dohc could not open this view.")).toBeTruthy();
  const settled=result.props.onSettled.mock.calls.length;
  await act(async()=>late.resolve({result:{...empty,rows:[{id:4,version:7,values:{name:"Task",status:"Todo"}}]}}));
  expect(screen.getByText("dohc could not open this view.")).toBeTruthy();
  expect(screen.getByRole("button",{name:"Try again"})).toBeTruthy();
  expect(result.props.onSettled).toHaveBeenCalledTimes(settled);
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
  await waitFor(()=>expect(invoke.mock.calls.some(([request])=>JSON.stringify(request.input)===JSON.stringify({limit:50,range:{fieldId:"date",start:"2026-12-27",end:"2027-02-07"}}))).toBe(true));
});
it("reads the nearest record on each side of an empty month for the calendar to offer",async()=>{
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    const input=request.input as Record<string,AppBackendJson>,range=input.range as {fieldId:string;start:string;end:string};
    if(input.limit!==1)return {result:{...empty,range}};
    return {result:{range,rows:range.start==="0001-01-01"?[]:[{id:7,version:1,values:{date:"2027-03-04"}}],nextCursor:null}};
  });
  setup(invoke,calendar);
  await screen.findByText("Nearby 2027-03-04");
  const outside=invoke.mock.calls.map(([request])=>request.input as Record<string,AppBackendJson>).filter(input=>input.limit===1);
  expect(outside.map(input=>[input.range,input.sort])).toEqual([
    [{fieldId:"date",start:"0001-01-01",end:expect.any(String)},{fieldId:"date",direction:"desc"}],
    [{fieldId:"date",start:expect.any(String),end:"9999-12-31"},{fieldId:"date",direction:"asc"}],
  ]);
});
it("leaves the offer out when only one side's read fails, since that side might be closer",async()=>{
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    const input=request.input as Record<string,AppBackendJson>,range=input.range as {fieldId:string;start:string;end:string};
    if(input.limit!==1)return {result:{...empty,range}};
    if(range.start==="0001-01-01")throw Error("The earlier read failed.");
    return {result:{range,rows:[{id:7,version:1,values:{date:"2027-03-04"}}],nextCursor:null}};
  });
  const result=setup(invoke,calendar);
  await screen.findByRole("button",{name:"January"});
  await waitFor(()=>expect(invoke.mock.calls.filter(([request])=>(request.input as Record<string,AppBackendJson>).limit===1)).toHaveLength(2));
  await act(async()=>{});
  expect(screen.queryByText(/^Nearby/)).toBeNull();
  expect(result.props.onError).not.toHaveBeenCalled();
});
it("leaves the offer out when the read action cannot find records outside the month",async()=>{
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    const input=request.input as Record<string,AppBackendJson>;
    if(input.limit===1)throw Error("This read action does not sort by date.");
    return {result:{...empty,range:input.range!}};
  });
  const result=setup(invoke,calendar);
  await screen.findByRole("button",{name:"January"});
  await waitFor(()=>expect(invoke.mock.calls.filter(([request])=>(request.input as Record<string,AppBackendJson>).limit===1)).toHaveLength(2));
  expect(screen.queryByText(/^Nearby/)).toBeNull();
  expect(result.props.onError).not.toHaveBeenCalled();
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
it("shows board records an automation changed in place, keeping the board on screen while it reads",async()=>{
  let name="First task",gate:Promise<void>|null=null;
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    await gate;
    const group=(request.input as Record<string,AppBackendJson>).group as {fieldId:string;value:string};
    return {result:{...empty,group,rows:group.value==="Todo"?[{id:4,version:7,values:{name,status:"Todo"}}]:[]}};
  });
  const result=setup(invoke);
  await screen.findByText("First task");
  const before=invoke.mock.calls.length,held=deferred();
  gate=held.promise;name="Changed task";
  result.rerender(<TransactionalCollectionPage {...result.props} recordsChanged={1}/>);
  await waitFor(()=>expect(invoke.mock.calls.length).toBeGreaterThan(before));
  expect(screen.queryByText("Loading view…")).toBeNull();
  expect(screen.getByText("First task")).toBeTruthy();
  expect((screen.getByRole("button",{name:"Move 4"}) as HTMLButtonElement).disabled).toBe(false);
  await act(async()=>held.resolve());
  await screen.findByText("Changed task");
  expect(result.props.onError).not.toHaveBeenCalled();
});
it("finishes a board read and a read in place asked for in one render, and shows an open record's new values",async()=>{
  let name="First task",gate:Promise<void>|null=null;
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    await gate;
    const group=(request.input as Record<string,AppBackendJson>).group as {fieldId:string;value:string};
    return {result:{...empty,group,rows:group.value==="Todo"?[{id:4,version:7,values:{name,status:"Todo"}}]:[]}};
  });
  const result=setup(invoke);
  fireEvent.click(await screen.findByRole("button",{name:"Show 4"}));
  expect(screen.getByRole("dialog",{name:"Record details"}).textContent).toContain("First task");
  fireEvent.click(screen.getByRole("button",{name:"Close"}));
  const held=deferred();gate=held.promise;name="Second task";
  result.rerender(<TransactionalCollectionPage {...result.props} recordsVersion={1} recordsChanged={1}/>);
  expect(await screen.findByText("Loading view…")).toBeTruthy();
  await act(async()=>held.resolve());
  await screen.findByText("Second task");
  // Neither read is left holding the view.
  await waitFor(()=>expect((screen.getByRole("button",{name:"Move 4"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Show 4"}));
  name="Third task";
  result.rerender(<TransactionalCollectionPage {...result.props} recordsVersion={1} recordsChanged={2}/>);
  await waitFor(()=>expect(screen.getByRole("dialog",{name:"Record details"}).textContent).toContain("Third task"));
  expect(screen.queryByText("Loading view…")).toBeNull();
  expect(result.props.onError).not.toHaveBeenCalled();
});
it("reads an open Calendar record by its id once an automation moves it out of the shown month, and says when it is gone",async()=>{
  const table=dataset.tables[0]!;
  const keyed:TransactionalDatasetDescription={...dataset,tables:[{...table,primaryKeyFieldId:"key",fields:[{fieldId:"key",name:"Record ID",type:"text",required:true,unique:true,generated:"record-id"},...table.fields]}],
    operations:dataset.operations.map(operation=>operation.kind==="read"?{...operation,fieldIds:["key",...operation.fieldIds]}:operation)};
  const day=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const now=new Date(),inMonth=day(new Date(now.getFullYear(),now.getMonth(),15)),later=day(new Date(now.getFullYear(),now.getMonth()+3,15));
  let date:string|null=inMonth;
  const invoke=vi.fn(async(request:TransactionalInvoke):Promise<{result:AppBackendJson}>=>{
    const input=request.input as Record<string,AppBackendJson>;
    const row={id:7,version:date===inMonth?1:2,values:{key:"7",name:"Pay rent",status:"Todo",date}};
    if(input.filters)return {result:{rows:date===null?[]:[row],nextCursor:null}};
    const range=input.range as {start:string;end:string};
    return {result:{range:input.range!,rows:date!==null&&date>=range.start&&date<range.end?[row]:[],nextCursor:null}};
  });
  const props={workspaceId:"w",dataset:keyed,tableId:"table",invoke,onError:vi.fn(),onNotice:vi.fn(),activeView:calendar};
  const {rerender}=render(<TransactionalCollectionPage {...props}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Show 7"}));
  const details=()=>screen.getByRole("dialog",{name:"Record details"});
  expect(details().textContent).toContain(inMonth);
  date=later;
  rerender(<TransactionalCollectionPage {...props} recordsChanged={1}/>);
  await waitFor(()=>expect(details().textContent).toContain(later));
  expect(details().textContent).toContain("Version 2");
  expect(invoke.mock.calls.some(([request])=>JSON.stringify((request.input as Record<string,AppBackendJson>).filters)===JSON.stringify([{fieldId:"key",value:7}]))).toBe(true);
  date=null;
  rerender(<TransactionalCollectionPage {...props} recordsChanged={2}/>);
  await waitFor(()=>expect(details().textContent).toContain("This record is no longer in this Collection."));
  expect(details().textContent).not.toContain(later);
  expect(props.onError).not.toHaveBeenCalled();
});
it("drops a by-id read of an open Calendar record once a newer read finds it back in the month",async()=>{
  const table=dataset.tables[0]!;
  const keyed:TransactionalDatasetDescription={...dataset,tables:[{...table,primaryKeyFieldId:"key",fields:[{fieldId:"key",name:"Record ID",type:"text",required:true,unique:true,generated:"record-id"},...table.fields]}],
    operations:dataset.operations.map(operation=>operation.kind==="read"?{...operation,fieldIds:["key",...operation.fieldIds]}:operation)};
  const day=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const now=new Date(),first=day(new Date(now.getFullYear(),now.getMonth(),10)),later=day(new Date(now.getFullYear(),now.getMonth()+3,15)),back=day(new Date(now.getFullYear(),now.getMonth(),20));
  let date=first,version=1;
  const byId=deferred<{result:AppBackendJson}>();
  const row=()=>({id:7,version,values:{key:"7",name:"Pay rent",status:"Todo",date}});
  const invoke=vi.fn(async(request:TransactionalInvoke,_signal:AbortSignal):Promise<{result:AppBackendJson}>=>{
    const input=request.input as Record<string,AppBackendJson>;
    if(input.filters)return byId.promise;
    const range=input.range as {start:string;end:string};
    return {result:{range:input.range!,rows:date>=range.start&&date<range.end?[row()]:[],nextCursor:null}};
  });
  const props={workspaceId:"w",dataset:keyed,tableId:"table",invoke,onError:vi.fn(),onNotice:vi.fn(),activeView:calendar};
  const {rerender}=render(<TransactionalCollectionPage {...props}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Show 7"}));
  const details=()=>screen.getByRole("dialog",{name:"Record details"});
  // Out of the month: the page reads the record by its id, and that read waits.
  date=later;version=2;
  rerender(<TransactionalCollectionPage {...props} recordsChanged={1}/>);
  await waitFor(()=>expect(invoke.mock.calls.some(([request])=>(request.input as Record<string,AppBackendJson>).filters!==undefined)).toBe(true));
  // Back in the month before it answers: the newer read in place shows the record.
  date=back;version=3;
  rerender(<TransactionalCollectionPage {...props} recordsChanged={2}/>);
  await waitFor(()=>expect(details().textContent).toContain("Version 3"));
  const signal=invoke.mock.calls.find(([request])=>(request.input as Record<string,AppBackendJson>).filters!==undefined)![1];
  expect(signal.aborted).toBe(true);
  // The late answer, from while it was out of the month, changes nothing; nor would one saying it was gone.
  await act(async()=>byId.resolve({result:{rows:[{id:7,version:2,values:{key:"7",name:"Pay rent",status:"Todo",date:later}}],nextCursor:null}}));
  expect(details().textContent).toContain("Version 3");
  expect(details().textContent).toContain(back);
  expect(details().textContent).not.toContain(later);
  expect(details().textContent).not.toContain("no longer");
});
