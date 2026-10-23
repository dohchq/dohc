import type {ReplicaCurrentView,ReplicaCurrentViewPage} from "@dohc/workspace-engine-client/daemon";
import {historyObjectKey,historyStructuralReason,sameHistoryState} from "./storage/replicaHistoryPins";
import {publishReplicaCurrentViewIndex} from "./replicaCurrentViewReads";
import {ReplicaMap} from "./replicaMap";

type Row=ReplicaCurrentView["files"][number]|ReplicaCurrentView["omitted"][number];
const pathKey=(f:Row)=>JSON.stringify([f.versionId,f.path]);
export class ReplicaManifest {
  rows=new ReplicaMap<Row>();
  paths=new ReplicaMap<string>();
  private omissions=new ReplicaMap<ReplicaCurrentView["omitted"][number]>();
  texts=new ReplicaMap<string>();
  private refs=new ReplicaMap<number>();
  private lengths=new ReplicaMap<{bytes:number;count:number}>();
  textBytes=0;
  view?:ReplicaCurrentView;
  private stored?:ReplicaCurrentView;
  /** Compare stored rows directly before building the retained maps once. */
  static fromStored(view:ReplicaCurrentView) {
    const manifest=new ReplicaManifest();manifest.stored=view;manifest.view=view;
    return manifest;
  }
  apply(page:ReplicaCurrentView, delta:boolean, removed:ReplicaCurrentViewPage["removed"]) {
    const next=new ReplicaManifest();
    if(delta && this.stored)throw new Error("Stored replica manifest requires a full collection.");
    next.rows=this.rows.fork();next.paths=this.paths.fork();next.omissions=this.omissions.fork();next.texts=this.texts.fork();next.refs=this.refs.fork();next.lengths=this.lengths.fork();next.textBytes=this.textBytes;
    const incoming=[...page.files,...page.omitted], entries=incoming.map(f=>[historyObjectKey(f),f] as const), additions=new Map(entries);
    if(additions.size!==incoming.length)throw new Error("Duplicate replica object.");
    const before:Row[]=[], observations:Array<{versionId:string;objectId:string}>=[];
    let changed=!this.view, structural=!this.view, predecessor=false, changeCount=0;
    const shas=new Set<string>();
    const release=(row:Row)=>{
      next.rows.delete(historyObjectKey(row));next.paths.delete(pathKey(row));
      next.omissions.delete(historyObjectKey(row));
      if("contentKind" in row) {const length=next.lengths.get(row.sha256)!;if(length.count===1)next.lengths.delete(row.sha256);else next.lengths.set(row.sha256,{...length,count:length.count-1});}
      if("contentKind" in row && row.contentKind==="text") {next.refs.set(row.sha256,next.refs.get(row.sha256)!-1);shas.add(row.sha256);}
    };
    const changedRows:Row[]=[];
    const compare=(old:Row|undefined,file:Row|undefined)=>{
      const same=old && file && ("contentKind" in old && "contentKind" in file ? sameHistoryState(old,file) && old.byteLength===file.byteLength : !("contentKind" in old) && !("contentKind" in file) && old.path===file.path && old.sha256===file.sha256 && old.reason===file.reason);
      if(same)return;
      changeCount++;
      if(old)before.push(old);
      if(file)changedRows.push(file);
      changed=true;
      if(!old||!file||old.path!==file.path||("contentKind" in old)!==("contentKind" in file)||"contentKind" in old && "contentKind" in file && (old.contentKind!==file.contentKind||old.lineageClaimId!==file.lineageClaimId||old.restoreGeneration!==file.restoreGeneration))structural=true;
      if(old && "contentKind" in old && (!file || "contentKind" in file && historyStructuralReason(old,file)))predecessor=true;
      if(file && "contentKind" in file || !file && old && "contentKind" in old)observations.push(file??old!);
    };
    if(delta)for(const key of new Set([...additions.keys(),...removed.map(historyObjectKey)]))compare(this.rows.get(key),additions.get(key));
    else {
      if(this.stored)for(const old of [...this.stored.files,...this.stored.omitted]) {const key=historyObjectKey(old);compare(old,additions.get(key));additions.delete(key);}
      else for(const [key,old] of this.rows) {compare(old,additions.get(key));additions.delete(key);}
      for(const file of additions.values())compare(undefined,file);
    }
    const oldSize=this.stored ? this.stored.files.length+this.stored.omitted.length : this.rows.size;
    const smallChange=changeCount<=Math.max(oldSize,delta ? oldSize-before.length+changedRows.length : incoming.length)/2;
    const bulk=!delta && (!this.rows.size || !smallChange);
    const rows=bulk ? new Map(entries) : next.rows, paths=bulk ? new Map<string,string>() : next.paths;
    const omissions=bulk ? new Map<string,ReplicaCurrentView["omitted"][number]>() : next.omissions;
    const lengths=bulk ? new Map<string,{bytes:number;count:number}>() : next.lengths, refs=bulk ? new Map<string,number>() : next.refs;
    if(!bulk)for(const old of before)release(old);
    for(const [key,file] of bulk ? entries : changedRows.map(f=>[historyObjectKey(f),f] as const)) {
      const path=pathKey(file);
      if(paths.has(path))throw new Error("Duplicate replica path.");
      if(!bulk)rows.set(key,file);paths.set(path,key);
      if(!("contentKind" in file))omissions.set(key,file);
      if("contentKind" in file) {const length=lengths.get(file.sha256);if(length && length.bytes!==file.byteLength)throw new Error("Inconsistent replica text length.");lengths.set(file.sha256,{bytes:file.byteLength,count:(length?.count??0)+1});}
      if("contentKind" in file && file.contentKind==="text") {
        refs.set(file.sha256,(refs.get(file.sha256)??0)+1);
      }
    }
    if(bulk) {next.rows=new ReplicaMap(rows);next.paths=new ReplicaMap(paths);next.omissions=new ReplicaMap(omissions);next.lengths=new ReplicaMap(lengths);next.refs=new ReplicaMap(refs);}
    for(const text of page.texts) {
      const old=next.texts.get(text.sha256);if(old!==undefined)next.textBytes-=Buffer.byteLength(old);
      next.texts.set(text.sha256,text.text);next.textBytes+=Buffer.byteLength(text.text);shas.add(text.sha256);
    }
    if(!delta)for(const sha of next.texts.keys())shas.add(sha);
    for(const sha of shas)if(!next.refs.get(sha)) {const text=next.texts.get(sha);if(text!==undefined)next.textBytes-=Buffer.byteLength(text);next.texts.delete(sha);next.refs.delete(sha);}
    let files:ReplicaCurrentView["files"]|undefined,omitted:ReplicaCurrentView["omitted"]|undefined,texts:ReplicaCurrentView["texts"]|undefined;
    const view:ReplicaCurrentView={workspaceId:page.workspaceId,revision:page.revision,logCursor:page.logCursor,journalCursor:page.journalCursor,
      get files(){return files??=[...next.rows.values()].filter((f):f is ReplicaCurrentView["files"][number]=>"contentKind" in f);},
      get omitted(){return omitted??=[...next.omissions.values()];},
      get texts(){return texts??=[...next.texts].map(([sha256,text])=>({sha256,text}));}};
    publishReplicaCurrentViewIndex(view,this.view,{...page,
      files:changedRows.filter((f):f is ReplicaCurrentView["files"][number]=>"contentKind" in f),
      omitted:changedRows.filter((f):f is ReplicaCurrentView["omitted"][number]=>!("contentKind" in f))},before,next.texts,smallChange);
    next.view=view;
    return {next,view,changed,structural,predecessor,observations,readChanges:[...before,...changedRows]};
  }
}
