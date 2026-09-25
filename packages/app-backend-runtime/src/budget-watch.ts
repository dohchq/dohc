// The CPU budget of a dataset worker's steps, shared between its main thread
// and its budget watch thread as a BigInt64Array of BUDGET_STATE_SLOTS:
// 0. the section: odd while a budgeted step runs, even between steps, and
//    CONDEMNED once the watch has decided to end the worker;
// 1. the step's budget kind: 1 for the app's code, 2 for a dataset check;
// 2. the process CPU time at which the step's charge is zero;
// 3. the step's budget. Times are in microseconds.
export const BUDGET_STATE_SLOTS=4;
export const CONDEMNED=-1n;

/** Starts a budgeted step and returns its section. */
export function armBudget(state:BigInt64Array, kind:bigint, origin:bigint, budget:bigint):bigint {
  Atomics.store(state,1,kind);Atomics.store(state,2,origin);Atomics.store(state,3,budget);
  return Atomics.add(state,0,1n)+1n;
}
/** Ends a step within budget. Otherwise it stays armed until the watch ends the worker. */
export function disarmBudget(state:BigInt64Array, section:bigint, cpuMicros:bigint):boolean {
  if(cpuMicros-Atomics.load(state,2)>Atomics.load(state,3)) return false;
  return Atomics.compareExchange(state,0,section,section+1n)===section;
}

/**
 * Runs on the watch thread, which keeps running while SQLite blocks the main
 * thread. It condemns a step over its budget, then ends the worker. The marker
 * that tells the host why is best effort: the kill waits for it at most
 * `graceMs`, so a stalled disk cannot keep app code running. This function is
 * sent to the thread as source text, so it uses only its parameters and globals.
 */
export function watchBudget(state:BigInt64Array, cpuMicros:()=>bigint, writeMarker:(reason:string)=>Promise<unknown>,
  kill:()=>void, pollMs:number, graceMs:number):()=>void {
  const timer=setInterval(()=>{
    const section=Atomics.load(state,0);
    if(section%2n!==1n) return;
    const kind=Atomics.load(state,1), budget=Atomics.load(state,3);
    if(cpuMicros()-Atomics.load(state,2)<=budget) return;
    // The next step stores its budget only after this one ends, so while the
    // section is unchanged the values read above are this step's.
    if(Atomics.compareExchange(state,0,section,-1n)!==section) return;
    clearInterval(timer);
    const end=setTimeout(kill,graceMs);
    const finish=()=>{clearTimeout(end);kill();};
    writeMarker((kind===1n ? "app " : "checks ")+String(budget/1000n)).then(finish,finish);
  },pollMs);
  return ()=>clearInterval(timer);
}
