// Calls for one key run in order; different keys stay concurrent.
export function createKeyedSerializer<Key = string>(): <T>(
  key: Key,
  run: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<Key, Promise<void>>();
  return (key, run) => {
    const tail = tails.get(key) ?? Promise.resolve();
    const result = tail.then(run);
    // The stored tail always settles resolved so a rejection (surfaced to this
    // caller via `result`) cannot poison later runs.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return result;
  };
}
