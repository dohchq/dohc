import { z } from "zod";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { inputProblem, supportsSort } from "./transactionalCollectionModel";
import { bridge } from "./bridge";

const id = z.string().uuid();
const scalar = z.union([z.string().max(4096),z.number().finite(),z.boolean(),z.null()]);
export const CollectionTableView = z.object({
  viewId:id, name:z.string().trim().min(1).max(100), kind:z.enum(["table","board","calendar"]), search:z.string().max(200),
  groupBy:id.optional(), dateField:id.optional(),
  filters:z.array(z.object({fieldId:id,value:z.union([scalar,z.array(scalar).max(100)])}).strict()).max(20),
  sort:z.object({fieldId:id,direction:z.enum(["asc","desc"])}).strict().nullable(),
}).strict();
export type CollectionTableView = z.infer<typeof CollectionTableView>;
export const CollectionTableViews = z.object({formatVersion:z.literal(1),datasetId:id,tableId:id,views:z.array(CollectionTableView).max(50)}).strict();
export type CollectionTableViews = z.infer<typeof CollectionTableViews>;
export type TableViewsSnapshot = {document:CollectionTableViews;contentHash:string|null};
export const tableViewsPath = (datasetId:string,tableId:string) => `collection-views/${id.parse(datasetId)}/${id.parse(tableId)}.json`;
export function parseTableViews(text:string,datasetId:string,tableId:string):CollectionTableViews {
  if(new TextEncoder().encode(text).byteLength>256*1024)throw Error("The saved views file is too large. Keep it below 256 KB.");
  const value=CollectionTableViews.parse(JSON.parse(text));
  if(value.datasetId!==datasetId||value.tableId!==tableId||new Set(value.views.map(view=>view.viewId)).size!==value.views.length||new Set(value.views.map(view=>view.name)).size!==value.views.length)throw Error("The saved views do not match this Collection. Check their source file.");
  return value;
}
export function validateTableView(view:CollectionTableView,dataset:DatasetDescription,tableId:string) {
  const table=dataset.tables.find(table=>table.tableId===tableId), read=dataset.operations.find(operation=>operation.tableId===tableId&&operation.kind==="read"&&operation.readOnly);
  if(!table||!read)throw Error("This Collection has no permitted read action.");
  const fields=table.fields.filter(field=>read.fieldIds.includes(field.fieldId));
  if(view.kind==="board") {
    const field=fields.find(field=>field.fieldId===view.groupBy);
    if(!field||!supportsSort(field))throw Error("Choose a readable field to group this board.");
  }
  if(view.kind==="calendar"&&!fields.some(field=>field.fieldId===view.dateField&&field.type==="date"))throw Error("Choose a readable date field for this calendar.");
  for(const filter of view.filters) {
    const field=fields.find(field=>field.fieldId===filter.fieldId);
    if(!field)throw Error("This view uses a field you cannot read. Edit the view before opening it.");
    const value=filter.value;
    if(value!==null && (inputProblem(field,value)||field.type==="checkbox"&&typeof value!=="boolean"||
      ["text","url","date","select","attachment"].includes(field.type)&&typeof value!=="string"||
      field.type==="select"&&!field.options?.includes(String(value))||field.type==="multi-select"&&(!Array.isArray(value)||value.some(value=>typeof value!=="string"||!field.options?.includes(value))))) throw Error(`Choose a valid filter for ${field.name}.`);
  }
  if(view.sort) {const field=fields.find(field=>field.fieldId===view.sort!.fieldId);if(!field||!supportsSort(field))throw Error("This view sorts a field you cannot use. Edit the view before opening it.");}
}
export async function readTableViews(workspaceId:string,datasetId:string,tableId:string,signal:AbortSignal):Promise<TableViewsSnapshot> {
  const relativePath=tableViewsPath(datasetId,tableId);signal.throwIfAborted();
  let read;
  try {read=await bridge().readWorkspaceText({workspaceId,relativePath});}
  catch(error) {
    signal.throwIfAborted();
    // A complete workspace listing distinguishes an absent source from a failed read.
    const listing=await bridge().listWorkspaceFiles({workspaceId});signal.throwIfAborted();
    if(listing.cached||listing.files.some(file=>file.path===relativePath))throw error;
    return {document:{formatVersion:1,datasetId,tableId,views:[]},contentHash:null};
  }
  signal.throwIfAborted();if(read.truncated)throw Error("The saved views file is too large. Keep it below 256 KB.");
  return {document:parseTableViews(read.text,datasetId,tableId),contentHash:read.contentHash};
}
export async function writeTableViews(workspaceId:string,previous:TableViewsSnapshot,document:CollectionTableViews,signal:AbortSignal):Promise<TableViewsSnapshot> {
  const relativePath=tableViewsPath(document.datasetId,document.tableId), text=JSON.stringify(document,null,2)+"\n";
  parseTableViews(text,previous.document.datasetId,previous.document.tableId);signal.throwIfAborted();
  if(previous.contentHash===null)await bridge().createWorkspaceFile({workspaceId,relativePath,initialText:text});
  else {
    const result=await bridge().writeWorkspaceText({workspaceId,relativePath,text,expectedContentHash:previous.contentHash});
    if(result.status!=="written")throw Error("The saved views changed elsewhere. Refresh before editing them again.");
  }
  signal.throwIfAborted();return readTableViews(workspaceId,document.datasetId,document.tableId,signal);
}
