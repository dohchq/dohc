import {EventEmitter} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
import {waitForIdleWorkers} from './benchmark-idle.mjs';

afterEach(()=>vi.useRealTimers());
function observer(){
  const events=new EventEmitter(),value={workers:1,sampleWorkers:1,sampleSequence:1,closedAtSample:0};
  return{events,value,state:()=>({...value}),timeoutMs:1000};
}
it('requires both actual closure and a later zero-worker sample',async()=>{
  const input=observer(),waiting=waitForIdleWorkers(input);let resolved=false;void waiting.then(()=>{resolved=true;});
  Object.assign(input.value,{workers:0,closedAtSample:1});input.events.emit('change');await Promise.resolve();expect(resolved).toBe(false);
  input.value.sampleSequence=2;input.events.emit('change');await Promise.resolve();expect(resolved).toBe(false);
  Object.assign(input.value,{sampleSequence:3,sampleWorkers:0});input.events.emit('change');await waiting;
  expect(input.events.listenerCount('change')).toBe(0);
});
it('checks state after subscription so a close event cannot be missed',async()=>{
  const input=observer();input.events.on('newListener',()=>Object.assign(input.value,{workers:0,sampleWorkers:0,sampleSequence:2,closedAtSample:1}));
  await waitForIdleWorkers(input);expect(input.events.listenerCount('change')).toBe(0);
});
it('fails if closure or the post-close sample never arrives',async()=>{
  vi.useFakeTimers();
  for(const workers of [1,0]){
    const input=observer();Object.assign(input.value,{workers,sampleWorkers:0,closedAtSample:1});
    const waiting=expect(waitForIdleWorkers(input)).rejects.toThrow('idle deadline');
    await vi.advanceTimersByTimeAsync(1000);await waiting;expect(input.events.listenerCount('change')).toBe(0);
  }
});
