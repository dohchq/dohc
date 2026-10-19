import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from "node:crypto";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {visibleSharePath} from "@dohc/security-contract/share-selector";
import type {ReplicaCurrentViewReadInput} from "./replicaCurrentViewReads";
import type {StorageContext} from "./storage/context";
import {replicaStatement as statement} from "./storage/replicaStatements";
import {isReplicaStoredHead} from "./storage/replicaCurrentViews";
import {targetVersionId,type ShareSelector} from "./shareFilter";

const key=randomBytes(32),identities=new WeakMap<ReplicaCurrentView,string>();
const compareReplicaPaths=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
function identity(view:ReplicaCurrentView|null) {
  if(!view)return null;
  let id=identities.get(view);if(!id)identities.set(view,id=randomUUID());return id;
}
function encode(value:unknown) {
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);
  const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString("base64url");
}
function decode(token:string):{binding:string;after:string;expires:number} {
  if(token.length>8192)throw Error("Invalid continuation");
  const bytes=Buffer.from(token,"base64url"),cipher=createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));
  cipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
}
/** Reauthorize every page; a changed/expired snapshot restarts without retaining old manifests. */
export function inventoryPageCursor(storage:StorageContext,input:ReplicaCurrentViewReadInput,selector:ShareSelector,
  view:ReplicaCurrentView,stored:ReplicaCurrentView|null,paging:{limit?:number;cursor?:string}) {
  const limit=paging.limit ?? 256;
  if(!Number.isSafeInteger(limit) || limit<1 || limit>1000)return {status:"updating" as const};
  const binding=createHash("sha256").update(JSON.stringify([input.grantId,input.generation,input.principal,selector,identity(view),identity(stored),
    statement(storage,"PRAGMA data_version").get(),statement(storage,"SELECT total_changes() AS n").get()])).digest("hex");
  let after="",expires=Date.now()+300_000;
  if(paging.cursor)try {
    const cursor=decode(paging.cursor);
    if(cursor.binding!==binding || typeof cursor.after!=="string" || !Number.isFinite(cursor.expires) || cursor.expires<=Date.now())return {status:"updating" as const};
    after=cursor.after;expires=cursor.expires;
  } catch {return {status:"updating" as const};}
  const version=targetVersionId(selector),roots=JSON.stringify(selector.paths);
  const paths=statement(storage,`SELECT path FROM (
    SELECT path FROM sync_relay_replica_cut_files WHERE workspace_id=? AND version_id=? AND path>?
    UNION SELECT path FROM sync_relay_replica_cut_omitted WHERE workspace_id=? AND version_id=? AND path>?
    UNION SELECT current_path AS path FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=?
      AND lineage_state='current' AND restore_fence_generation>1 AND current_path>?) AS inventory
    WHERE (?='[]' OR EXISTS (SELECT 1 FROM json_each(?) root WHERE inventory.path=root.value OR substr(inventory.path,1,length(root.value)+1)=root.value||'/'))
    ORDER BY inventory.path LIMIT ?`).all(view.workspaceId,version,after,view.workspaceId,version,after,view.workspaceId,version,after,roots,roots,limit+1).map(r=>String(r.path));
  if(!isReplicaStoredHead(view)) {
    for(const file of [...view.files,...view.omitted])if(file.versionId===version && compareReplicaPaths(file.path,after)>0 && visibleSharePath(selector,file.path)===file.path)paths.push(file.path);
  }
  const sorted=[...new Set(paths)].sort(compareReplicaPaths).slice(0,limit+1),end=sorted[Math.min(limit,sorted.length)-1] ?? after;
  return {after,end,paths:sorted.slice(0,limit),nextCursor:sorted.length>limit ? encode({binding,after:end,expires}) : undefined};
}
