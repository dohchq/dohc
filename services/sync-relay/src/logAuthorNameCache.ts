import type {LogAuthorNameLookup} from "./relayLogInputs";

const TTL_MS = 5_000;
const MAX_ACCOUNTS = 256;

export function cacheLogAuthorNames(lookup: LogAuthorNameLookup, nowMs: () => number): LogAuthorNameLookup {
  const names = new Map<string, {expiresAtMs: number; name: Promise<string | null>}>();
  return userId => {
    const now = nowMs();
    const cached = names.get(userId);
    if (cached && cached.expiresAtMs > now) return cached.name;
    names.delete(userId);
    if (names.size >= MAX_ACCOUNTS) names.delete(names.keys().next().value!);
    const name = Promise.resolve().then(() => lookup(userId)).catch(error => {
      if (names.get(userId)?.name === name) names.delete(userId);
      throw error;
    });
    names.set(userId, {expiresAtMs: now + TTL_MS, name});
    return name;
  };
}
