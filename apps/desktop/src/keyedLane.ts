// Calls queue without coalescing; different keys stay concurrent.
export async function runInKeyedLane<T, Key = string>(
  lanes: Map<Key, Promise<void>>,
  key: Key,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = lanes.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  lanes.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (lanes.get(key) === queued) lanes.delete(key);
  }
}
