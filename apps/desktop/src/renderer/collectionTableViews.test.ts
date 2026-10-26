import { beforeEach,expect,it,vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { parseTableViews,readTableViews,writeTableViews,validateTableView,type CollectionTableView } from "./collectionTableViews";
const backend=vi.hoisted(()=>({readWorkspaceText:vi.fn(),listWorkspaceFiles:vi.fn(),createWorkspaceFile:vi.fn(),writeWorkspaceText:vi.fn()}));
vi.mock("./bridge",()=>({bridge:()=>backend}));
beforeEach(() => { for (const mock of Object.values(backend)) mock.mockReset(); });
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const document={formatVersion:1 as const,datasetId:id(1),tableId:id(2),views:[]};
it("rejects source files for another Collection and duplicate view identities",()=>{
  expect(()=>parseTableViews(JSON.stringify(document),id(3),id(2))).toThrow(/do not match/);
  const view={viewId:id(5),name:"Pending",kind:"table",search:"",filters:[],sort:null};
  expect(()=>parseTableViews(JSON.stringify({...document,views:[view,view]}),id(1),id(2))).toThrow(/do not match/);
});
it("checks stable field references against the approved read action, not source labels",()=>{
  const dataset:DatasetDescription={datasetId:id(1),name:"Entries",revision:1,revisionSha256:"a".repeat(64),tables:[{tableId:id(2),name:"Entries",fields:[{fieldId:id(3),name:"Renamed status",type:"text",required:true,unique:false}]}],operations:[{operationId:id(4),name:"read",label:"Read",kind:"read",tableId:id(2),readOnly:true,access:"owner",fieldIds:[id(3)]}]};
  const view:CollectionTableView={viewId:id(5),name:"Pending",kind:"table",search:"",filters:[{fieldId:id(3),value:"Pending"}],sort:{fieldId:id(3),direction:"asc"}};
  expect(()=>validateTableView(view,dataset,id(2))).not.toThrow();
  expect(()=>validateTableView({...view,filters:[{fieldId:id(9),value:"private"}]},dataset,id(2))).toThrow(/cannot read/);
  expect(()=>validateTableView({...view,kind:"board",groupBy:id(3)},dataset,id(2))).not.toThrow();
  expect(()=>validateTableView({...view,kind:"board",groupBy:id(9)},dataset,id(2))).toThrow(/readable field/);
  expect(()=>validateTableView({...view,kind:"calendar",dateField:id(3)},dataset,id(2))).not.toThrow();
});
it("reads a missing view file without creating it and never overwrites a changed source",async()=>{
  backend.readWorkspaceText.mockRejectedValueOnce(Error("missing"));backend.listWorkspaceFiles.mockResolvedValueOnce({files:[]});
  const signal=new AbortController().signal,snapshot=await readTableViews("w",id(1),id(2),signal);
  expect(snapshot).toEqual({document,contentHash:null});expect(backend.createWorkspaceFile).not.toHaveBeenCalled();
  backend.writeWorkspaceText.mockResolvedValueOnce({status:"conflict",currentContentHash:"b".repeat(64)});
  await expect(writeTableViews("w",{...snapshot,contentHash:"a".repeat(64)},document,signal)).rejects.toThrow(/changed elsewhere/);
  expect(backend.writeWorkspaceText).toHaveBeenCalledWith(expect.objectContaining({expectedContentHash:"a".repeat(64)}));
});

it.each([
  { name: "present file", files: [{ path: `collection-views/${id(1)}/${id(2)}.json` }], absent: false },
  { name: "folder", files: [], absent: true },
  { name: "missing", files: [], absent: true },
])("checks only the saved-view path after a failed read: $name", async ({ files, absent }) => {
  const error = Error("read failed");
  backend.readWorkspaceText.mockRejectedValueOnce(error);
  backend.listWorkspaceFiles.mockResolvedValueOnce({ files, folders: [`collection-views/${id(1)}/${id(2)}.json`] });
  const pending = readTableViews("w", id(1), id(2), new AbortController().signal);
  if (absent) expect(await pending).toEqual({ document, contentHash: null });
  else await expect(pending).rejects.toBe(error);
  expect(backend.listWorkspaceFiles).toHaveBeenCalledExactlyOnceWith({ workspaceId: "w", filePath: `collection-views/${id(1)}/${id(2)}.json` });
});
it("loads present saved views without an existence lookup", async () => {
  backend.readWorkspaceText.mockResolvedValueOnce({ text: JSON.stringify(document), contentHash: "hash", truncated: false });
  expect(await readTableViews("w", id(1), id(2), new AbortController().signal)).toEqual({ document, contentHash: "hash" });
  expect(backend.listWorkspaceFiles).not.toHaveBeenCalled();
});
it("does not check absence after cancellation", async () => {
  const controller = new AbortController();
  backend.readWorkspaceText.mockImplementationOnce(async () => { controller.abort(); throw Error("read failed"); });
  await expect(readTableViews("w", id(1), id(2), controller.signal)).rejects.toThrow();
  expect(backend.listWorkspaceFiles).not.toHaveBeenCalled();
});
