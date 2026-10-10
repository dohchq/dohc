// runCycle returns only after the mixed workload reaches its settled end state.
export async function runSoakCycles({ minutes, heaps, signal, runCycle, afterCycle,
  now = () => performance.now() }) {
  const deadline = (heaps?.startedAtMs ?? now()) + minutes * 60000;
  let cycle = 0;
  try {
    while (now() < deadline) {
      signal?.throwIfAborted();
      await runCycle(++cycle);
      signal?.throwIfAborted();
      await heaps?.captureDue(cycle);
      await afterCycle?.(cycle);
    }
    await heaps?.finish();
  } catch (error) {
    await heaps?.cancel(error).catch(() => {});
    throw error;
  }
}
