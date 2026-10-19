import {expect,it} from "vitest";
import {ReplicaMap} from "./replicaMap";
it("keeps bulk-loaded entries and prior views through later delta rotations",()=>{
  const entries=Array.from({length:513},(_,i)=>[String(512-i),i] as const),expected=new Map<string,number>(entries);
  const map=new ReplicaMap<number>([...entries,["9",999]]);expected.set("9",999);
  const prior=map.fork();
  for(let i=0;i<800;i++) {const key=String(i);if(i%3){map.set(key,i);expected.set(key,i);}else{map.delete(key);expected.delete(key);}}
  expect([...map]).toEqual([...expected].sort(([a],[b])=>a<b?-1:a>b?1:0));
  expect(map.size).toBe(expected.size);expect(prior.size).toBe(513);expect(prior.get("9")).toBe(999);
  expect([...prior]).toEqual([...new Map([...entries,["9",999] as const])].sort(([a],[b])=>a<b?-1:a>b?1:0));
});
it("retains prior roots through insertion, replacement, and deletion rotations",()=>{
  const map=new ReplicaMap<number>(),expected=new Map<string,number>();let seed=17;
  const snapshots:Array<{map:ReplicaMap<number>;expected:Map<string,number>}>=[];
  for(let i=0;i<4_000;i++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;const key=String(seed%257);
    if(i%3===0){map.delete(key);expected.delete(key);}else{map.set(key,i);expected.set(key,i);}
    if(i%200===0)snapshots.push({map:map.fork(),expected:new Map(expected)});
    expect(map.size).toBe(expected.size);expect(map.get(key)).toBe(expected.get(key));
  }
  for(const saved of [...snapshots,{map,expected}])expect([...saved.map]).toEqual([...saved.expected].sort(([a],[b])=>a<b?-1:a>b?1:0));
});
