/** Observe child closure and a later zero-worker sample without changing the idle timer. */
export function waitForIdleWorkers({events,state,timeoutMs}) {
  return new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);events.off('change',check);};
    const check=()=>{
      const current=state();
      if(current.workers===0&&current.sampleWorkers===0&&current.sampleSequence>current.closedAtSample){cleanup();resolve(current);}
    };
    timer=setTimeout(()=>{cleanup();reject(new Error('Workers did not close and produce a later zero-worker memory sample within the idle deadline.'));},Math.max(0,timeoutMs));
    events.on('change',check);check();
  });
}
