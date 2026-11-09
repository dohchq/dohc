import {afterEach, expect, it} from "vitest";
import {writeFileSync} from "node:fs";
import {closeTestStorages, tempRoot} from "./testing";
import {createReplicaSupervisor, type ReplicaChildInput} from "./replicaSupervisor";
import {registered, cleanupLiveDeliveryFixtures} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";

afterEach(closeTestStorages);
const emptyCurrentView=(input: ReplicaChildInput)=>async()=>({workspaceId:input.lease.workspaceId,revision:0,logCursor:0,journalCursor:0,files:[],texts:[],delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]});

it.skipIf(process.env.DOHC_REPLICA_MEASURE!=="1")("measures the owner's journal commit path with an active replica observer", async () => {
  const samples:number[]=[];
  for(let sample=0;sample<21;sample++) {
    const f=registered({deployment:true});
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"epoch",streamIdentity:"stream"});
    const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("journal-push-measure"),
      startChild:async input=>({currentView: emptyCurrentView(input), pull:async()=>{},close:async()=>{}})});
    try {
      await supervisor.activate("workspace");let elapsed=0;
      for(let i=0;i<100;i++) {
        const input=f.capture(f.update("counter",String(i)),`measure-${i}`), start=performance.now();
        expect(f.storage.commitLiveUpdateJournal(input).result.kind).toBe("accepted");elapsed+=performance.now()-start;
      }
      samples.push(elapsed/100);
    }finally{await supervisor.close();f.close();cleanupLiveDeliveryFixtures();}
  }
  samples.sort((a,b)=>a-b);
  const result={median:samples[10],p95:samples[19],samples,rows:100};
  if(process.env.DOHC_REPLICA_MEASURE_OUT)writeFileSync(process.env.DOHC_REPLICA_MEASURE_OUT,JSON.stringify(result));
  console.log(`OWNER_COMMIT_MS_PER_ROW median=${result.median} p95=${result.p95} samples=21 rows=100`);
},120_000);
