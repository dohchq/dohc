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
  apply(page:ReplicaCurrentView, delta:boolean, removed:ReplicaCurrentViewPage["removed"]) {
    const next=new ReplicaManifest();
    if(delta) {next.rows=this.rows.fork();next.paths=this.paths.fork();next.omissions=this.omissions.fork();next.texts=this.texts.fork();next.refs=this.refs.fork();next.lengths=this.lengths.fork();next.textBytes=this.textBytes;}
    const incoming=[...page.files,...page.omitted], keys=new Set(incoming.map(historyObjectKey));
    if(keys.size!==incoming.length)throw new Error("Duplicate replica object.");
    const touched=delta ? new Set([...keys,...removed.map(historyObjectKey)]) : new Set([...this.rows.keys(),...keys]);
    const before:Row[]=[], observations:Array<{versionId:string;objectId:string}>=[];
    let changed=!this.view, structural=!this.view, predecessor=false;
    const shas=new Set<string>();
    const release=(row:Row)=>{
      next.rows.delete(historyObjectKey(row));next.paths.delete(pathKey(row));
      next.omissions.delete(historyObjectKey(row));
      if("contentKind" in row) {const length=next.lengths.get(row.sha256)!;if(length.count===1)next.lengths.delete(row.sha256);else next.lengths.set(row.sha256,{...length,count:length.count-1});}
      if("contentKind" in row && row.contentKind==="text") {next.refs.set(row.sha256,next.refs.get(row.sha256)!-1);shas.add(row.sha256);}
    };
    for(const key of touched) {
      const old=this.rows.get(key);if(old)before.push(old);
      if(delta && old)release(old);
    }
    const additions=new Map(incoming.map(f=>[historyObjectKey(f),f]));
    for(const key of touched) {
      const old=this.rows.get(key), file=additions.get(key);
      const same=old && file && ("contentKind" in old && "contentKind" in file ? sameHistoryState(old,file) && old.byteLength===file.byteLength : !("contentKind" in old) && !("contentKind" in file) && old.path===file.path && old.sha256===file.sha256 && old.reason===file.reason);
      if(same)continue;
      changed=true;
      if(!old||!file||old.path!==file.path||("contentKind" in old)!==("contentKind" in file)||"contentKind" in old && "contentKind" in file && (old.contentKind!==file.contentKind||old.lineageClaimId!==file.lineageClaimId||old.restoreGeneration!==file.restoreGeneration))structural=true;
      if(old && "contentKind" in old && (!file || "contentKind" in file && historyStructuralReason(old,file)))predecessor=true;
      if(!(file && !("contentKind" in file)))observations.push(file??old!);
    }
    for(const file of incoming) {
      const key=historyObjectKey(file),path=pathKey(file);
      if(next.paths.has(path))throw new Error("Duplicate replica path.");
      next.rows.set(key,file);next.paths.set(path,key);
      if(!("contentKind" in file))next.omissions.set(key,file);
      if("contentKind" in file) {const length=next.lengths.get(file.sha256);if(length && length.bytes!==file.byteLength)throw new Error("Inconsistent replica text length.");next.lengths.set(file.sha256,{bytes:file.byteLength,count:(length?.count??0)+1});}
      if("contentKind" in file && file.contentKind==="text") {
        next.refs.set(file.sha256,(next.refs.get(file.sha256)??0)+1);
        if(!delta && !next.texts.has(file.sha256)) {const text=this.texts.get(file.sha256);if(text!==undefined){next.texts.set(file.sha256,text);next.textBytes+=Buffer.byteLength(text);}}
      }
    }
    for(const text of page.texts) {
      const old=next.texts.get(text.sha256);if(old!==undefined)next.textBytes-=Buffer.byteLength(old);
      next.texts.set(text.sha256,text.text);next.textBytes+=Buffer.byteLength(text.text);shas.add(text.sha256);
    }
    for(const sha of shas)if(!next.refs.get(sha)) {const text=next.texts.get(sha);if(text!==undefined)next.textBytes-=Buffer.byteLength(text);next.texts.delete(sha);next.refs.delete(sha);}
    let files:ReplicaCurrentView["files"]|undefined,omitted:ReplicaCurrentView["omitted"]|undefined,texts:ReplicaCurrentView["texts"]|undefined;
    const view:ReplicaCurrentView={workspaceId:page.workspaceId,revision:page.revision,logCursor:page.logCursor,journalCursor:page.journalCursor,
      get files(){return files??=[...next.rows.values()].filter((f):f is ReplicaCurrentView["files"][number]=>"contentKind" in f);},
      get omitted(){return omitted??=[...next.omissions.values()];},
      get texts(){return texts??=[...next.texts].map(([sha256,text])=>({sha256,text}));}};
    // Full fallback validates every row. A delta validates only its incoming rows.
    publishReplicaCurrentViewIndex(view,delta?this.view:undefined,page,delta?before:[],next.texts);
    next.view=view;
    return {next,view,changed,structural,predecessor,observations};
  }
}
