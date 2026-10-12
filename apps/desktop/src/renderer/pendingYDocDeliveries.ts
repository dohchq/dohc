type Delivery = {pending: () => boolean; flush: () => Promise<void>};
const deliveries = new Set<Delivery>();
export function registerYDocDelivery(delivery: Delivery): () => void {
  deliveries.add(delivery);
  return () => deliveries.delete(delivery);
}
export function hasPendingYDocDeliveries(): boolean { return [...deliveries].some(d => d.pending()); }
export async function settleYDocDeliveries(): Promise<boolean> {
  try {
    do { await Promise.all([...deliveries].filter(d => d.pending()).map(d => d.flush())); }
    while (hasPendingYDocDeliveries());
    return true;
  } catch { return false; }
}
