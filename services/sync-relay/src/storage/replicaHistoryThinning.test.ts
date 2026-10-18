import {expect,it} from "vitest";
import {replicaHistoryPinsToDrop} from "./replicaHistoryThinning";

it("repeatedly drops a closest interior neighbor, retaining endpoints until necessary",()=>{
  // Include gaps above 32 bits so both halves of the radix key are exercised.
  const rows=Array.from({length:200},(_,i)=>({pin_id:i,pinned_at_ms:Math.floor(i**3.7)*1_000_000,reason:"quiet",bytes:10}));
  const live=[...rows];
  for(const drop of replicaHistoryPinsToDrop(rows,{maxBytes:10_000,maxCount:2})) {
    const index=live.findIndex(row=>row.pin_id===drop.pin_id);
    const gap=(i:number)=>Math.min(live[i]!.pinned_at_ms-live[i-1]!.pinned_at_ms,live[i+1]!.pinned_at_ms-live[i]!.pinned_at_ms);
    expect(index).toBeGreaterThan(0); expect(index).toBeLessThan(live.length-1);
    expect(gap(index)).toBe(Math.min(...live.slice(1,-1).map((_,i)=>gap(i+1))));
    live.splice(index,1);
  }
  expect(live.map(row=>row.pin_id)).toEqual([0,199]);
});

it("thins 20,000 equal-time pins within both budgets and prefers structural pins",()=>{
  const rows=Array.from({length:20_000},(_,i)=>({pin_id:i,pinned_at_ms:100,reason:i%10?"quiet":"rename",bytes:i%2?300:700}));
  const removed=new Set(replicaHistoryPinsToDrop(rows,{maxBytes:10_000,maxCount:30}).map(row=>row.pin_id));
  const retained=rows.filter(row=>!removed.has(row.pin_id));
  expect(retained.length).toBeLessThanOrEqual(30);
  expect(retained.reduce((n,row)=>n+row.bytes,0)).toBeLessThanOrEqual(10_000);
  expect(retained.every(row=>row.reason==="rename")).toBe(true);
  expect(replicaHistoryPinsToDrop(rows,{maxBytes:0,maxCount:0})).toHaveLength(20_000);
});
