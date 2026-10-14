import { buildQueueStatus, acquireExclusiveSlot, resolveBuildBudget } from '../rust-engine-program/build-slot.mjs';

export function profilingHostContext(env = process.env) {
  const budget = resolveBuildBudget(env);
  const roots = budget ? [...new Set([budget.root, env.DOHC_VERIFICATION_SLOT_ROOT].filter(Boolean))] : [];
  const lanes = roots.flatMap(root => [
    buildQueueStatus({ root, slots: 2, kind: 'verification-slot' }),
    buildQueueStatus({ root, slots: 1, kind: 'verification-light-slot' }),
    ...(root === budget.root ? [buildQueueStatus({ root, slots: budget.slots, kind: 'build-slot' })] : []),
  ]);
  return { at: new Date().toISOString(), lanes };
}

function hostBusy(context) {
  return context.lanes.some(lane => lane.owners.length || lane.waiters.length);
}

function busyError(context) {
  const kinds = context.lanes.filter(lane => lane.owners.length || lane.waiters.length).map(lane => lane.kind);
  return new Error(`Profiling deferred for registered host work: ${[...new Set(kinds)].join(', ')}. Rerun after gates and builds finish.`);
}

/** A benchmark never queues behind, or occupies, a PR verification lane. */
export function acquireProfilingSlot(env = process.env, {
  metadata,
  pollMs = 1000,
  observe = () => profilingHostContext(env),
  schedule = callback => setInterval(callback, pollMs),
  unschedule = clearInterval,
} = {}) {
  const budget = resolveBuildBudget(env);
  const controller = new AbortController();
  const evidence = {
    scope: 'Registered gate and Cargo lanes sampled before admission, during execution, and at completion. This does not certify an idle host.',
    pollMs,
    coordinated: Boolean(budget),
    observations: [],
    samples: 0,
  };
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const context = observe();
    evidence.samples += 1;
    evidence.latest = context;
    if (!evidence.observations.length || hostBusy(context)) evidence.observations.push(context);
    if (hostBusy(context)) throw busyError(context);
    return context;
  };
  let lane, timer;
  try {
    check();
    // No background identity lookup: it would start a PowerShell process during the measurement.
    if (budget) lane = acquireExclusiveSlot({ root: budget.root, kind: 'profiling-slot', metadata, identityDelayMs: null });
    check();
    timer = schedule(() => {
      try { check(); }
      catch (error) { controller.abort(error); unschedule(timer); }
    });
    timer?.unref?.();
  } catch (error) {
    lane?.release();
    error.hostContext = evidence;
    throw error;
  }
  return {
    name: lane?.name ?? null,
    signal: controller.signal,
    evidence,
    check,
    update: fields => lane?.update(fields),
    release() { unschedule(timer); lane?.release(); },
  };
}
