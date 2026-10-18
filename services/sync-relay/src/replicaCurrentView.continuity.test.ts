import {join} from "node:path";
import {copyFileSync, existsSync, renameSync} from "node:fs";
import {createHash} from "node:crypto";
import {DatabaseSync, backup} from "node:sqlite";
import {afterEach, expect, it} from "vitest";
import {initializeRelayDeployment, openRelayDeployment} from "./relayDeployment";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {tempRoot, closeTestStorages} from "./testing";

afterEach(closeTestStorages);
it("changes only view tables and continuity, and refuses a rollback before the view", async () => {
  const root=await tempRoot("replica6a-continuity"), configPath=join(root,"deployment.json"),
    relayPath=join(root,"volume","relay.sqlite"), continuityDirectory=join(root,"continuity"),
    backupPath=join(root,"before-view.sqlite");
  initializeRelayDeployment({configPath,relayPath,continuityDirectory});
  const {storage}=openRelayDeployment(configPath), db=new DatabaseSync(relayPath,{readOnly:true});
  try {
    storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
    storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});
    storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
      grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
    const lease=createReplicaReadPrincipal(storage).issue("w","test");
    storage.bindReplicaCurrentView(lease);
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sync_relay_replica_cut%' AND name<>'sync_relay_continuity' ORDER BY name")
      .all().map(r=>String(r.name));
    const before=new Map(tables.map(table=>[table,JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())]));
    const stamp=Number(db.prepare("SELECT stamp FROM sync_relay_continuity").get()!.stamp);
    await backup(db,backupPath);
    const text="current",sha256=createHash("sha256").update(text).digest("hex");
    storage.storeReplicaCurrentView(lease,{workspaceId:"w",omitted:[],revision:1,logCursor:0,journalCursor:0,
      files:[{versionId:"main",objectId:"a",path:"docs/a.md",contentKind:"text",sha256,byteLength:7,lineageClaimId:null,restoreGeneration:null}],texts:[{sha256,text}]});
    expect(tables.filter(table=>!table.startsWith("sync_relay_history_") && before.get(table)!==JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all()))).toEqual([]);
    expect(Number(db.prepare("SELECT stamp FROM sync_relay_continuity").get()!.stamp)).toBeGreaterThan(stamp);
  } finally {db.close();storage.close();}
  const current=openRelayDeployment(configPath);
  try {expect(current.storage.getWorkspaceBootstrap("w")).toBeDefined();} finally {current.storage.close();}
  for(const suffix of ["","-wal","-shm"]) if(existsSync(relayPath+suffix)) renameSync(relayPath+suffix,relayPath+suffix+".preserved");
  copyFileSync(backupPath,relayPath);
  expect(()=>openRelayDeployment(configPath)).toThrow(/continuity/);
});
