import { afterEach, expect, it, vi } from "vitest";
import type { EngineClient } from "../../workspace-engine-client/src/daemon/engineClient.js";
import { registered, host, hash, cleanupLiveDeliveryFixtures } from "./liveCommittedDeliveryTestSupport.js";
import { LiveCommittedDelivery, createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/liveCommittedDelivery.js";

afterEach(cleanupLiveDeliveryFixtures);

function fixture(bootstrap = true) {
  const f=registered(), history=createLiveJournalHistoryAuthority({namespace:"settlement-test",reconciled:true});
  if (bootstrap) {
    const store=f.storage.createLiveCommittedDeliveryStore(history), drain=store.open({host,document:f.input.evidence.document});
    const b=drain.baseline;
    store.acknowledgeBootstrap(drain,{bootstrapId:b.bootstrapId,bootstrapMomentId:b.bootstrapMomentId,baselineDigest:b.baselineDigest,baselineMomentRelaySequence:b.baselineMomentRelaySequence,localYDocSequence:0,bootstrapReplayed:false});
    store.close(drain);
  }
  const settlement={settlementId:"audit",previousCursor:0,terminalCursor:0,applicationCount:0,localYDocSequence:0,momentId:"moment",markdownDigest:hash(new Uint8Array()),materialized:true};
  const sendRequest=vi.fn(async (request:{method:string})=>({result:request.method==="liveApplication.register"?{registrationId:1}:{status:"settled",settlement}}));
  let id=0;
  const consumer=new LiveCommittedDelivery(f.storage,history,{client:{sendRequest} as unknown as EngineClient,workspace:"workspace-handle",host,deadlineMs:1000,nextRequestId:()=>++id});
  return {f,consumer,sendRequest,settlement,document:f.input.evidence.document};
}

it("settles acknowledged progress without advancing delivery edges",async()=>{
  const t=fixture();try {
    const before=t.f.raw.prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_edges").get()!.n;
    expect(await t.consumer.settle(t.document)).toEqual(t.settlement);
    expect(t.sendRequest.mock.calls.map(([r])=>r.method)).toEqual(["liveApplication.register","liveApplication.settle"]);
    expect(t.sendRequest.mock.calls[1]![0]).toMatchObject({params:{registrationId:1,terminalReceipt:null}});
    expect(t.f.raw.prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_edges").get()!.n).toBe(before);
  } finally {t.f.close();}
});

it("refuses settlement before durable bootstrap acknowledgement",async()=>{
  const t=fixture(false);try {await expect(t.consumer.settle(t.document)).rejects.toThrow("finish before settlement");expect(t.sendRequest).not.toHaveBeenCalled();} finally {t.f.close();}
});

it("rechecks cancellation after registration and excludes concurrent document operations",async()=>{
  const t=fixture(), controller=new AbortController();let release!:()=>void;
  const entered=new Promise<void>(resolve=>{t.sendRequest.mockImplementationOnce(async()=>{resolve();await new Promise<void>(r=>{release=r;});return {result:{registrationId:1}};});});
  try {
    const settling=t.consumer.settle(t.document,controller.signal);await entered;
    await expect(t.consumer.drain(t.document)).rejects.toThrow("already owns");
    controller.abort(new Error("caller stopped"));release();await expect(settling).rejects.toThrow("caller stopped");expect(t.sendRequest).toHaveBeenCalledTimes(1);
  } finally {release?.();t.f.close();}
});

it("refuses a native result for another terminal cursor",async()=>{
  const t=fixture();try {t.settlement.terminalCursor=1;await expect(t.consumer.settle(t.document)).rejects.toThrow("coverage mismatch");} finally {t.f.close();}
});

it("rechecks retained authority after native settlement before reporting success",async()=>{
  const t=fixture();try {
    t.sendRequest.mockImplementation(async request=> {
      if(request.method==="liveApplication.register")return {result:{registrationId:1}};
      t.f.raw.prepare("UPDATE sync_relay_live_documents SET current_path='other.md'").run();
      return {result:{status:"settled",settlement:t.settlement}};
    });
    await expect(t.consumer.settle(t.document)).rejects.toThrow();
  } finally {t.f.close();}
});
