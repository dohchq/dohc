// Wall timestamps locate work in a log; the monotonic clock measures its duration.
export function startTiming(record) {
  record.startedAt = new Date().toISOString();
  const started = performance.now();
  return () => {
    record.finishedAt = new Date().toISOString();
    record.seconds = (performance.now() - started) / 1000;
  };
}

export async function timed(record, action, save = () => {}) {
  const finish = startTiming(record);
  record.verdict = "RUNNING";
  save();
  try {
    const result = await action();
    record.verdict = "PASS";
    return result;
  } catch (error) {
    record.verdict = "FAIL";
    record.error = error.message;
    throw error;
  } finally {
    finish();
    save();
  }
}
