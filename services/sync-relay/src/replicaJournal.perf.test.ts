import {afterEach, it} from "vitest";
import {writeFile} from "node:fs/promises";
import {cleanupLiveDeliveryFixtures} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {binary, fixture} from "./testing/replicaJournalNative";

afterEach(cleanupLiveDeliveryFixtures);
it.skipIf(binary.missing || process.platform !== "linux" || process.env.DOHC_REPLICA_MEASURE!=="1")("measures release driver time from one and 500 commits through an on-demand projection",async()=>{
  const results=[];
  for(const size of [1,500]) {
    const samples:number[]=[];
    const f=await fixture();try {
      await f.child.pull();for(let i=0;i<size;i++)f.commit(`measurement-${i}`);
      for(let sample=0;sample<21;sample++) {
        if(sample)await f.resetToBaseline();
        const start=performance.now();await f.child.pull();f.project();samples.push(performance.now()-start);
        if(process.env.DOHC_REPLICA_MEASURE_OUT)await writeFile(`${process.env.DOHC_REPLICA_MEASURE_OUT}.progress`,JSON.stringify({rows:size,samples}));
      }
    }finally{await f.close();}
    samples.sort((a,b)=>a-b);results.push({rows:size,median:samples[10],p95:samples[19],samples});
    if(process.env.DOHC_REPLICA_MEASURE_OUT)await writeFile(process.env.DOHC_REPLICA_MEASURE_OUT,JSON.stringify(results));
    console.log(`DRIVER_MS rows=${size} median=${samples[10]} p95=${samples[19]} samples=21`);
  }
},600_000);
