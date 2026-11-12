// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { useCollectionTableViews, type CollectionTableViewsState } from "./useCollectionTableViews";
import { deferred } from "../testing/deferred";
const backend=vi.hoisted(()=>({readWorkspaceText:vi.fn(),listWorkspaceFiles:vi.fn(),createWorkspaceFile:vi.fn(),writeWorkspaceText:vi.fn()}));
vi.mock("./bridge",()=>({bridge:()=>backend}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const dataset:DatasetDescription={datasetId:id(1),name:"Entries",revision:1,revisionSha256:"a".repeat(64),tables:[{tableId:id(2),name:"Entries",fields:[{fieldId:id(3),name:"Status",type:"select",options:["Pending","Paid"],required:true,unique:false}]}],operations:[{operationId:id(4),name:"read",label:"Read",kind:"read",tableId:id(2),readOnly:true,access:"owner",fieldIds:[id(3)]}]};
afterEach(()=>{cleanup();vi.clearAllMocks();localStorage.clear();latest=null;});

// What the hook last gave its page: the tabs' data, and what the tabs' controls call.
let latest:CollectionTableViewsState|null=null;
type HarnessProps={workspaceId:string;dataset:DatasetDescription|null;tableId:string;onError(message:string,error:unknown,retry?:()=>void):void;onNotice?(message:string,undo?:()=>void):void;enabled?:boolean};
/** A page that shows the hook's views as the frame's tabs would: the saved names, the open one, and the Views command. */
function Views(props:HarnessProps) {
  const views=useCollectionTableViews({...props,enabled:props.enabled??true});
  latest=views;
  if(!views)return <p>No saved views</p>;
  return <>
    <output aria-label="Open view">{views.active?.viewId??""}</output>
    <ul aria-label="Saved views">{views.list.map(view=><li key={view.viewId}>{view.name}</li>)}</ul>
    <button disabled={views.busy} onClick={views.manage}>Views</button>
    {views.dialog}
  </>;
}
const ready=()=>waitFor(()=>expect((screen.getByRole("button",{name:"Views"}) as HTMLButtonElement).disabled).toBe(false));
const openView=()=>screen.getByLabelText("Open view").textContent;
const savedNames=()=>within(screen.getByRole("list",{name:"Saved views"})).queryAllByRole("listitem").map(item=>item.textContent);
/** The views file as the workspace holds it. A write must name the hash of what it replaces. */
function viewsFile() {
  const file={text:null as string|null,version:0,hash:()=>String(file.version).padStart(64,"0"),views:()=>JSON.parse(file.text!).views as Array<Record<string,unknown>>};
  backend.readWorkspaceText.mockImplementation(async()=>{if(file.text===null)throw Error("missing");return {text:file.text,contentHash:file.hash(),truncated:false};});
  backend.listWorkspaceFiles.mockResolvedValue({files:[]});
  backend.createWorkspaceFile.mockImplementation(async input=>{file.text=input.initialText;file.version++;return {path:input.relativePath};});
  backend.writeWorkspaceText.mockImplementation(async input=>{
    if(input.expectedContentHash!==file.hash())return {status:"conflict"};
    file.text=input.text;file.version++;return {status:"written",contentHash:file.hash()};
  });
  return file;
}

it.each([{ primaryName: "Record ID", generated: true }, { primaryName: "Renamed identity", generated: true }, { primaryName: "Membership number", generated: false }])("shows only user-supplied keys in view controls ($primaryName)", async ({ primaryName, generated }) => {
  const description = structuredClone(dataset);
  const table = description.tables[0]!;
  table.primaryKeyFieldId = id(5);
  table.fields.push({ fieldId: id(5), name: primaryName, type: "text", required: true, unique: true, ...(generated ? { generated: "record-id" as const } : {}) },
    { fieldId: id(6), name: "Visible field", type: "text", required: true, unique: false });
  description.operations[0]!.fieldIds.push(id(5), id(6));
  backend.readWorkspaceText.mockRejectedValue(Error("missing"));
  backend.listWorkspaceFiles.mockResolvedValue({ files: [] });
  render(<Views workspaceId="w" dataset={description} tableId={table.tableId} onError={vi.fn()}/>);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.click(screen.getByRole("button", { name: "Create view" }));
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.change(screen.getByLabelText("View layout"), { target: { value: "board" } });
  for (const label of ["Sort view by", "Filter 1 field", "Board group field"]) {
    const control = within(screen.getByLabelText(label));
    if (generated) expect(control.queryByRole("option", { name: primaryName })).toBeNull();
    else expect(control.getByRole("option", { name: primaryName })).toBeTruthy();
    expect(control.getByRole("option", { name: "Visible field" })).toBeTruthy();
  }
});
it("creates, reloads, renames, deletes and restores a source-backed filtered view",async()=>{
  const file=viewsFile();
  const hashes:Array<string|undefined>=[];
  const write=backend.writeWorkspaceText.getMockImplementation()!;
  backend.writeWorkspaceText.mockImplementation(async input=>{hashes.push(input.expectedContentHash);expect(input.expectedContentHash).toBe(file.hash());return write(input);});
  const props={workspaceId:"w",dataset,tableId:id(2),onError:vi.fn()},first=render(<Views {...props}/>);
  await ready();
  fireEvent.click(screen.getByRole("button",{name:"Views"}));fireEvent.click(screen.getByRole("button",{name:"Create view"}));
  fireEvent.change(screen.getByLabelText("View name"),{target:{value:"Unpaid"}});fireEvent.change(screen.getByLabelText("Sort view by"),{target:{value:id(3)}});
  fireEvent.click(screen.getByRole("button",{name:"Add filter"}));fireEvent.change(screen.getByLabelText("Filter value"),{target:{value:"Pending"}});
  fireEvent.click(screen.getByRole("button",{name:"Save view"}));await screen.findByRole("button",{name:"Edit view Unpaid"});
  expect(file.views()[0]).toMatchObject({name:"Unpaid",filters:[{fieldId:id(3),value:"Pending"}],sort:{fieldId:id(3),direction:"asc"}});
  expect(backend.createWorkspaceFile.mock.calls[0]![0].relativePath).toBe(`collection-views/${id(1)}/${id(2)}.json`);
  first.unmount();render(<Views {...props}/>);
  // The view that was open opens again, from what this computer kept.
  await waitFor(()=>expect(openView()).toBe(file.views()[0]!.viewId));
  fireEvent.click(screen.getByRole("button",{name:"Views"}));fireEvent.click(screen.getByRole("button",{name:"Edit view Unpaid"}));
  fireEvent.change(screen.getByLabelText("View name"),{target:{value:"Needs payment"}});fireEvent.click(screen.getByRole("button",{name:"Save view"}));
  fireEvent.click(await screen.findByRole("button",{name:"Delete view Needs payment"}));
  fireEvent.click(await screen.findByRole("button",{name:"Undo view deletion"}));
  await screen.findByRole("button",{name:"Edit view Needs payment"});expect(props.onError).not.toHaveBeenCalled();
  // The rename, the deletion and its Undo each named the hash they read.
  expect(hashes).toHaveLength(3);
});
it("ignores a source response after leaving the workspace",async()=>{
  const pending=deferred<{text:string;contentHash:string;truncated:false}>();backend.readWorkspaceText.mockReturnValueOnce(pending.promise);
  const onError=vi.fn(),mounted=render(<Views workspaceId="old" dataset={dataset} tableId={id(2)} onError={onError}/>);
  const before=latest;
  mounted.unmount();await act(async()=>pending.resolve({text:JSON.stringify({formatVersion:1,datasetId:id(1),tableId:id(2),views:[{viewId:id(7),name:"Late",kind:"table",search:"",filters:[],sort:null}]}),contentHash:"a".repeat(64),truncated:false}));
  // Nothing the page was given changed, and nothing was reported or kept.
  expect(latest).toBe(before);expect(latest?.list).toEqual([]);expect(onError).not.toHaveBeenCalled();
});
it("opens a saved calendar whose date field is gone, but saves a calendar only with a date field",async()=>{
  const view={viewId:id(7),name:"Visits",kind:"calendar" as const,search:"",filters:[],sort:null,dateField:id(8)};
  backend.readWorkspaceText.mockResolvedValue({text:JSON.stringify({formatVersion:1,datasetId:id(1),tableId:id(2),views:[view]}),contentHash:"a".repeat(64),truncated:false});
  localStorage.setItem(JSON.stringify(["dohc-collection-view","w",id(1),id(2)]),id(7));
  const onError=vi.fn();
  render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={onError}/>);
  await ready();
  expect(latest!.active).toEqual(view);expect(openView()).toBe(id(7));
  fireEvent.click(screen.getByRole("button",{name:"Views"}));fireEvent.click(screen.getByRole("button",{name:"Create view"}));
  fireEvent.change(screen.getByLabelText("View name"),{target:{value:"Days"}});fireEvent.change(screen.getByLabelText("View layout"),{target:{value:"calendar"}});
  fireEvent.click(screen.getByRole("button",{name:"Save view"}));
  expect((await screen.findByRole("alert")).textContent).toBe("Choose a readable date field for this calendar.");
  expect(backend.writeWorkspaceText).not.toHaveBeenCalled();expect(onError).not.toHaveBeenCalled();
  // The same holds for a calendar added from the tabs, which answers in words.
  let answer:string|null=null;
  await act(async()=>{answer=await latest!.create({name:"Days",kind:"calendar",dateField:id(8)});});
  expect(answer).toBe("Choose a readable date field for this calendar.");
  expect(backend.writeWorkspaceText).not.toHaveBeenCalled();expect(onError).not.toHaveBeenCalled();
});

it("adds a view from the tabs, opens it, and names the hash it read on every later write",async()=>{
  const file=viewsFile(),onError=vi.fn();
  render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={onError}/>);
  await ready();
  expect(savedNames()).toEqual([]);expect(openView()).toBe("");
  let answer:string|null="unset";
  await act(async()=>{answer=await latest!.create({name:"By status",kind:"board",groupBy:id(3)});});
  expect(answer).toBeNull();
  // No file yet, so the first view creates it.
  expect(backend.createWorkspaceFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({workspaceId:"w",relativePath:`collection-views/${id(1)}/${id(2)}.json`}));
  expect(file.views()).toEqual([{viewId:expect.any(String),name:"By status",kind:"board",search:"",filters:[],sort:null,groupBy:id(3)}]);
  const board=file.views()[0]!.viewId as string;
  expect(savedNames()).toEqual(["By status"]);expect(openView()).toBe(board);
  expect(localStorage.getItem(JSON.stringify(["dohc-collection-view","w",id(1),id(2)]))).toBe(board);
  const read=file.hash();
  await act(async()=>{answer=await latest!.create({name:"Everything",kind:"table"});});
  expect(answer).toBeNull();
  expect(backend.writeWorkspaceText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({relativePath:`collection-views/${id(1)}/${id(2)}.json`,expectedContentHash:read}));
  expect(savedNames()).toEqual(["By status","Everything"]);expect(openView()).toBe(file.views()[1]!.viewId);
  // All records opens no saved view, and this computer keeps that too.
  act(()=>latest!.select(null));
  expect(openView()).toBe("");expect(localStorage.getItem(JSON.stringify(["dohc-collection-view","w",id(1),id(2)]))).toBe("");
  act(()=>latest!.select(board));
  expect(openView()).toBe(board);
  expect(onError).not.toHaveBeenCalled();
});
it("answers in words when the file changed elsewhere, and never writes over it",async()=>{
  const file=viewsFile(),onError=vi.fn();
  render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={onError}/>);
  await ready();
  await act(async()=>{await latest!.create({name:"Mine",kind:"table"});});
  // Another computer changes the file after this page read it.
  const theirs=JSON.stringify({formatVersion:1,datasetId:id(1),tableId:id(2),views:[{viewId:id(9),name:"Theirs",kind:"table",search:"",filters:[],sort:null}]});
  file.text=theirs;file.version++;
  let answer:string|null=null;
  await act(async()=>{answer=await latest!.create({name:"Second",kind:"table"});});
  expect(answer).toBe("dohc could not save this view. The saved views changed elsewhere. Try again.");
  expect(file.text).toBe(theirs);
  // The popover shows the answer, so no toast repeats it.
  expect(onError).not.toHaveBeenCalled();
  // The hook read the file again, so the tabs show it and the next change names its hash.
  expect(savedNames()).toEqual(["Theirs"]);expect(openView()).toBe("");
  await act(async()=>{answer=await latest!.create({name:"Second",kind:"table"});});
  expect(answer).toBeNull();
  expect(file.views().map(view=>view.name)).toEqual(["Theirs","Second"]);
  await act(async()=>{answer=await latest!.rename(id(9),"Renamed");});
  expect(answer).toBeNull();
  expect(file.views().map(view=>view.name)).toEqual(["Renamed","Second"]);
  expect(onError).not.toHaveBeenCalled();
});
it("reads the file again after a write that failed, so the next change saves",async()=>{
  const file=viewsFile(),onError=vi.fn();
  render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={onError}/>);
  await ready();
  await act(async()=>{await latest!.create({name:"Mine",kind:"table"});});
  const mine=file.views()[0]!.viewId as string,reads=backend.readWorkspaceText.mock.calls.length;
  backend.writeWorkspaceText.mockRejectedValueOnce(Error("The disk is full."));
  let answer:string|null=null;
  await act(async()=>{answer=await latest!.rename(mine,"Ours");});
  expect(answer).toBe("dohc could not save this view. The disk is full.");
  expect(backend.readWorkspaceText.mock.calls.length).toBe(reads+1);
  // The page is not left busy, and the open view stays open.
  expect((screen.getByRole("button",{name:"Views"}) as HTMLButtonElement).disabled).toBe(false);expect(openView()).toBe(mine);
  await act(async()=>{answer=await latest!.rename(mine,"Ours");});
  expect(answer).toBeNull();
  expect(file.views().map(view=>view.name)).toEqual(["Ours"]);
  expect(onError).not.toHaveBeenCalled();
});
it("reports nothing of a failed save once its table closed while the views were read again",async()=>{
  const file=viewsFile(),onError=vi.fn();
  const mounted=render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={onError}/>);
  await ready();
  await act(async()=>{await latest!.create({name:"Board",kind:"board",groupBy:id(3)});});
  const board=file.views()[0]!.viewId as string;
  backend.writeWorkspaceText.mockRejectedValueOnce(Error("The disk is full."));
  const again=deferred<{text:string;contentHash:string;truncated:false}>();
  backend.readWorkspaceText.mockReturnValueOnce(again.promise);
  // The field's save fails, and the table closes before the views are read again.
  await act(async()=>{latest!.setField(board,{groupBy:id(3)});});
  mounted.unmount();
  await act(async()=>{again.resolve({text:JSON.stringify({formatVersion:1,datasetId:id(1),tableId:id(2),views:[]}),contentHash:"b".repeat(64),truncated:false});});
  expect(onError).not.toHaveBeenCalled();
});
it("renames a view, refuses a name another view has, and saves the field a board groups by",async()=>{
  const file=viewsFile(),onError=vi.fn();
  render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={onError}/>);
  await ready();
  await act(async()=>{await latest!.create({name:"Pending",kind:"table"});});
  await act(async()=>{await latest!.create({name:"Board",kind:"board",groupBy:id(3)});});
  const [pending,board]=file.views().map(view=>view.viewId as string);
  let answer:string|null="unset";
  const writes=backend.writeWorkspaceText.mock.calls.length;
  await act(async()=>{answer=await latest!.rename(pending!,"Board");});
  expect(answer).toBe("A view already has this name. Choose another name.");
  await act(async()=>{answer=await latest!.rename(pending!,"  ");});
  expect(answer).toBe("Give the view a name.");
  expect(backend.writeWorkspaceText.mock.calls.length).toBe(writes);
  await act(async()=>{answer=await latest!.rename(pending!,"Waiting");});
  expect(answer).toBeNull();
  expect(file.views().map(view=>view.name)).toEqual(["Waiting","Board"]);
  // Board was open, and a rename of another view leaves it open.
  expect(openView()).toBe(board);
  // The open view stays open under its new name.
  await act(async()=>{answer=await latest!.rename(board!,"Columns");});
  expect(answer).toBeNull();
  expect(openView()).toBe(board);expect(latest!.active).toMatchObject({name:"Columns"});
  // With All records open, a rename opens nothing.
  act(()=>latest!.select(null));
  await act(async()=>{answer=await latest!.rename(pending!,"Queue");});
  expect(answer).toBeNull();
  expect(openView()).toBe("");
  expect(file.views().map(view=>view.name)).toEqual(["Queue","Columns"]);
  // A field the table cannot group by is refused, and reported, since no popover shows it.
  await act(async()=>{latest!.setField(board!,{groupBy:id(8)});});
  await waitFor(()=>expect(onError).toHaveBeenCalledExactlyOnceWith("Choose a readable field to group this board.",expect.any(Error)));
  expect(file.views()[1]).toMatchObject({groupBy:id(3)});
});
it("deletes a view with an Undo in its notice, which puts the view back after the page has closed",async()=>{
  const file=viewsFile(),onError=vi.fn(),onNotice=vi.fn();
  const page=render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={onError} onNotice={onNotice}/>);
  await ready();
  await act(async()=>{await latest!.create({name:"Keep",kind:"table"});});
  await act(async()=>{await latest!.create({name:"Unpaid",kind:"table"});});
  const unpaid=file.views()[1]!;
  await act(async()=>{latest!.remove(unpaid.viewId as string);});
  await waitFor(()=>expect(onNotice).toHaveBeenCalledExactlyOnceWith("Deleted the view Unpaid",expect.any(Function)));
  expect(file.views().map(view=>view.name)).toEqual(["Keep"]);
  // The open view was the deleted one, so All records shows.
  expect(openView()).toBe("");expect(savedNames()).toEqual(["Keep"]);
  page.unmount();
  const read=file.hash();
  await act(async()=>{(onNotice.mock.calls[0]![1] as ()=>void)();});
  await waitFor(()=>expect(file.views()).toEqual([expect.objectContaining({name:"Keep"}),unpaid]));
  expect(backend.writeWorkspaceText).toHaveBeenLastCalledWith(expect.objectContaining({expectedContentHash:read}));
  expect(onError).not.toHaveBeenCalled();
});
it("opens the list of views with Undo view deletion when the page has no notices",async()=>{
  const file=viewsFile();
  render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={vi.fn()}/>);
  await ready();
  await act(async()=>{await latest!.create({name:"Unpaid",kind:"table"});});
  await act(async()=>{latest!.remove(file.views()[0]!.viewId as string);});
  fireEvent.click(await within(await screen.findByRole("region",{name:"Collection views"})).findByRole("button",{name:"Undo view deletion"}));
  await waitFor(()=>expect(savedNames()).toEqual(["Unpaid"]));
});
it("opens the editor on the view a tab's Edit view… names",async()=>{
  const file=viewsFile();
  render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={vi.fn()}/>);
  await ready();
  await act(async()=>{await latest!.create({name:"Unpaid",kind:"table"});});
  expect(screen.queryByRole("region",{name:"Collection views"})).toBeNull();
  act(()=>latest!.edit(file.views()[0]!.viewId as string));
  const editor=within(screen.getByRole("region",{name:"Collection views"}));
  expect(editor.getByLabelText<HTMLInputElement>("View name").value).toBe("Unpaid");
  fireEvent.change(editor.getByLabelText("View search"),{target:{value:"camera"}});
  fireEvent.click(editor.getByRole("button",{name:"Save view"}));
  await waitFor(()=>expect(file.views()[0]).toMatchObject({name:"Unpaid",search:"camera"}));
});
it("holds 50 views and says so for one more",async()=>{
  const file=viewsFile();
  file.text=JSON.stringify({formatVersion:1,datasetId:id(1),tableId:id(2),views:Array.from({length:50},(_,index)=>({viewId:id(100+index),name:`View ${index}`,kind:"table",search:"",filters:[],sort:null}))});
  render(<Views workspaceId="w" dataset={dataset} tableId={id(2)} onError={vi.fn()}/>);
  await ready();
  let answer:string|null=null;
  await act(async()=>{answer=await latest!.create({name:"One more",kind:"table"});});
  expect(answer).toBe("A Collection holds 50 views. Delete one, then add this one.");
  expect(backend.writeWorkspaceText).not.toHaveBeenCalled();
});
it("gives nothing and reads no file for someone who cannot save views, or before the Collection is read",async()=>{
  viewsFile();
  const reader=render(<Views enabled={false} workspaceId="w" dataset={dataset} tableId={id(2)} onError={vi.fn()}/>);
  expect(screen.getByText("No saved views")).toBeTruthy();expect(latest).toBeNull();
  reader.unmount();
  render(<Views workspaceId="w" dataset={null} tableId={id(2)} onError={vi.fn()}/>);
  expect(latest).toBeNull();
  expect(backend.readWorkspaceText).not.toHaveBeenCalled();
});
