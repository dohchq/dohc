import {expect,it} from "vitest";
import {appendValidatedLiveJournal} from "./liveUpdateJournal";

it.each(["updateBytes","checkpointBytes"] as const)("refuses unreadable %s before touching storage",field=>{
  const input={updateBytes:new Uint8Array([0]),checkpointBytes:new Uint8Array([0]),[field]:new Uint8Array(20_971_521)};
  const storage=new Proxy({}, {get(){throw Error("storage touched before byte bounds");}});
  expect(()=>appendValidatedLiveJournal(storage as never,input as never)).toThrow("Invalid journal bytes.");
});
