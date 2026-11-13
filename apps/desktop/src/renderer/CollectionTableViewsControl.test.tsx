// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { CollectionTableViewsControl } from "./CollectionTableViewsControl";
const backend=vi.hoisted(()=>({readWorkspaceText:vi.fn(),listWorkspaceFiles:vi.fn(),createWorkspaceFile:vi.fn(),writeWorkspaceText:vi.fn()}));
vi.mock("./bridge",()=>({bridge:()=>backend}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const dataset:DatasetDescription={datasetId:id(1),name:"Entries",revision:1,revisionSha256:"a".repeat(64),tables:[{tableId:id(2),name:"Entries",fields:[{fieldId:id(3),name:"Status",type:"select",options:["Pending","Paid"],required:true,unique:false}]}],operations:[{operationId:id(4),name:"read",label:"Read",kind:"read",tableId:id(2),readOnly:true,access:"owner",fieldIds:[id(3)]}]};
afterEach(()=>{cleanup();vi.clearAllMocks();localStorage.clear();});
it("creates, reloads, renames, deletes and restores a source-backed filtered view",async()=>{
  let text:string|null=null,version=0;
  backend.readWorkspaceText.mockImplementation(async()=>{if(text===null)throw Error("missing");return {text,contentHash:String(version).padStart(64,"0"),truncated:false};});
  backend.listWorkspaceFiles.mockResolvedValue({files:[]});
  backend.createWorkspaceFile.mockImplementation(async input=>{text=input.initialText;version++;return {path:input.relativePath};});
  backend.writeWorkspaceText.mockImplementation(async input=>{expect(input.expectedContentHash).toBe(String(version).padStart(64,"0"));text=input.text;version++;return {status:"written",contentHash:String(version).padStart(64,"0")};});
  const props={workspaceId:"w",dataset,tableId:id(2),onSelect:vi.fn(),onError:vi.fn()},first=render(<CollectionTableViewsControl {...props}/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"Views"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Views"}));fireEvent.click(screen.getByRole("button",{name:"Create view"}));
  fireEvent.change(screen.getByLabelText("View name"),{target:{value:"Unpaid"}});fireEvent.change(screen.getByLabelText("Sort view by"),{target:{value:id(3)}});
  fireEvent.click(screen.getByRole("button",{name:"Add filter"}));fireEvent.change(screen.getByLabelText("Filter value"),{target:{value:"Pending"}});
  fireEvent.click(screen.getByRole("button",{name:"Save view"}));await screen.findByRole("button",{name:"Edit view Unpaid"});
  expect(JSON.parse(text!).views[0]).toMatchObject({name:"Unpaid",filters:[{fieldId:id(3),value:"Pending"}],sort:{fieldId:id(3),direction:"asc"}});
  expect(backend.createWorkspaceFile.mock.calls[0]![0].relativePath).toBe(`collection-views/${id(1)}/${id(2)}.json`);
  first.unmount();render(<CollectionTableViewsControl {...props}/>);
  await waitFor(()=>expect((screen.getByLabelText("Saved Collection view") as HTMLSelectElement).value).toBe(JSON.parse(text!).views[0].viewId));
  fireEvent.click(screen.getByRole("button",{name:"Views"}));fireEvent.click(screen.getByRole("button",{name:"Edit view Unpaid"}));
  fireEvent.change(screen.getByLabelText("View name"),{target:{value:"Needs payment"}});fireEvent.click(screen.getByRole("button",{name:"Save view"}));
  fireEvent.click(await screen.findByRole("button",{name:"Delete view Needs payment"}));
  fireEvent.click(await screen.findByRole("button",{name:"Undo view deletion"}));
  await screen.findByRole("button",{name:"Edit view Needs payment"});expect(props.onError).not.toHaveBeenCalled();
});

it("opens a saved calendar whose date field is gone, but saves a calendar only with a date field",async()=>{
  const view={viewId:id(7),name:"Visits",kind:"calendar" as const,search:"",filters:[],sort:null,dateField:id(8)};
  backend.readWorkspaceText.mockResolvedValue({text:JSON.stringify({formatVersion:1,datasetId:id(1),tableId:id(2),views:[view]}),contentHash:"a".repeat(64),truncated:false});
  localStorage.setItem(JSON.stringify(["dohc-collection-view","w",id(1),id(2)]),id(7));
  const onSelect=vi.fn(),onError=vi.fn();
  render(<CollectionTableViewsControl workspaceId="w" dataset={dataset} tableId={id(2)} onSelect={onSelect} onError={onError}/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"Views"}) as HTMLButtonElement).disabled).toBe(false));
  expect(onSelect).toHaveBeenLastCalledWith(view);expect((screen.getByLabelText("Saved Collection view") as HTMLSelectElement).value).toBe(id(7));
  fireEvent.click(screen.getByRole("button",{name:"Views"}));fireEvent.click(screen.getByRole("button",{name:"Create view"}));
  fireEvent.change(screen.getByLabelText("View name"),{target:{value:"Days"}});fireEvent.change(screen.getByLabelText("View layout"),{target:{value:"calendar"}});
  fireEvent.click(screen.getByRole("button",{name:"Save view"}));
  expect((await screen.findByRole("alert")).textContent).toBe("Choose a readable date field for this calendar.");
  expect(backend.writeWorkspaceText).not.toHaveBeenCalled();expect(onError).not.toHaveBeenCalled();
});
