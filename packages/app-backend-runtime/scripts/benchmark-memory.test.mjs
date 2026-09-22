import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {startMemorySampler} from './benchmark-memory.mjs';

it.skipIf(process.platform!=='win32')('samples task PIDs and stops without retaining its process',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dataset-memory-sampler-'));
  try{
    const samples=[],path=join(root,'memory.jsonl');
    const sampler=await startMemorySampler({path,pids:[process.pid],onSample:value=>samples.push(value),intervalMs:100});
    const stopped=await sampler.stop();expect(stopped.samples).toBeGreaterThan(0);
    expect(()=>process.kill(sampler.pid,0)).toThrow();
    const observed=samples.flatMap(sample=>sample.processes).find(item=>item.pid===process.pid);
    expect(observed.workingSetBytes).toBeGreaterThan(0);expect(observed.peakWorkingSetBytes).toBeGreaterThanOrEqual(observed.workingSetBytes);
    expect((await readFile(path,'utf8')).trim().split('\n')).toHaveLength(stopped.samples);
  }finally{await rm(root,{recursive:true,force:true});}
});
