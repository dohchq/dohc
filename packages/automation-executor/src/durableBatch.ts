/** Limits the unsaved receipt window without syncing every record or file. */
export const DURABLE_BATCH_ITEMS = 100;

export function durableBatch<T>(save: (items: readonly T[]) => Promise<void>) {
  let items: T[] = [];
  let failed = false;
  const flush = async () => {
    if (failed || items.length === 0) return;
    try { await save(items); }
    catch (error) { failed = true; throw error; }
    items = [];
  };
  return {
    flush,
    add: async (item: T) => {
      items.push(item);
      if (items.length >= DURABLE_BATCH_ITEMS) await flush();
    },
  };
}
