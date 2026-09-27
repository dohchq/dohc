// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { CollectionTableViewsControl } from "./CollectionTableViewsControl";
import { deferred } from "../testing/deferred";
const backend=vi.hoisted(()=>({readWorkspaceText:vi.fn(),listWorkspaceFiles:vi.fn(),createWorkspaceFile:vi.fn(),writeWorkspaceText:vi.fn()}));
vi.mock("./bridge",()=>({bridge:()=>backend}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const dataset:DatasetDescription={datasetId:id(1),name:"Entries",revision:1,revisionSha256:"a".repeat(64),tables:[{tableId:id(2),name:"Entries",fields:[{fieldId:id(3),name:"Status",type:"select",options:["Pending","Paid"],required:true,unique:false}]}],operations:[{operationId:id(4),name:"read",label:"Read",kind:"read",tableId:id(2),readOnly:true,access:"owner",fieldIds:[id(3)]}]};
afterEach(()=>{cleanup();vi.clearAllMocks();localStorage.clear();});
it.each([{ primaryName: "Record ID", generated: true }, { primaryName: "Renamed identity", generated: true }, { primaryName: "Membership number", generated: false }])("shows only user-supplied keys in view controls ($primaryName)", async ({ primaryName, generated }) => {
  const description = structuredClone(dataset);
  const table = description.tables[0]!;
  table.primaryKeyFieldId = id(5);
  table.fields.push({ fieldId: id(5), name: primaryName, type: "text", required: true, unique: true, ...(generated ? { generated: "record-id" as const } : {}) },
    { fieldId: id(6), name: "Visible field", type: "text", required: true, unique: false });
  description.operations[0]!.fieldIds.push(id(5), id(6));
  backend.readWorkspaceText.mockRejectedValue(Error("missing"));
  backend.listWorkspaceFiles.mockResolvedValue({ files: [] });
  render(<CollectionTableViewsControl workspaceId="w" dataset={description} tableId={table.tableId} onSelect={vi.fn()} onError={vi.fn()}/>);
  await waitFor(() => expect((screen.getByRole("button", { name: "Views" }) as HTMLButtonElement).disabled).toBe(false));
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
it("ignores a source response after leaving the workspace",async()=>{
  const pending=deferred<{text:string;contentHash:string;truncated:false}>();backend.readWorkspaceText.mockReturnValueOnce(pending.promise);
  const onSelect=vi.fn(),onError=vi.fn(),mounted=render(<CollectionTableViewsControl workspaceId="old" dataset={dataset} tableId={id(2)} onSelect={onSelect} onError={onError}/>);
  mounted.unmount();await act(async()=>pending.resolve({text:JSON.stringify({formatVersion:1,datasetId:id(1),tableId:id(2),views:[]}),contentHash:"a".repeat(64),truncated:false}));
  expect(onSelect).not.toHaveBeenCalled();expect(onError).not.toHaveBeenCalled();
});
