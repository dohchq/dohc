import { normalizeShareDiscussionDisplayName } from "@dohc/security-contract/share-discussion";
import { chatMentionTokens } from "@dohc/workspace-contracts/chat-mentions";
import type { SyncRelayStorage } from "./storage";
import type { AccountNameLookupToken } from "./storage/accountNames";

export const ACCOUNT_NAME_LOOKUP_DEADLINE_MS = 1_000;
const ACCOUNT_NAME_BATCH_SIZE = 200;
const WORKSPACE_MENTION_ACCOUNT_LIMIT = 2_000;
const SINGLE_LOOKUP_CONCURRENCY = 16;
const BACKFILL_MAX_ACCOUNTS = 50_000;
const LOOKUP_TIMEOUT = Symbol("account-name-lookup-timeout");

export type LookupUserDisplayName = (userId: string) => Promise<string | null> | string | null;
export type LookupUserDisplayNames = (
  userIds: readonly string[],
) => Promise<ReadonlyMap<string, string | null>> | ReadonlyMap<string, string | null>;
export type RefreshMentionAccountNames = (
  workspaceId: string,
  bodies: readonly string[],
) => Promise<void>;

// The account's display name, or null when it has none or the lookup fails
// or runs past its deadline.
export async function accountDisplayName(
  lookupUserDisplayName: LookupUserDisplayName | undefined,
  userId: string,
): Promise<string | null> {
  if (!lookupUserDisplayName) return null;

  let lookup: Promise<string | null>;
  try {
    lookup = Promise.resolve(lookupUserDisplayName(userId));
  } catch {
    return null;
  }

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadlineResult = new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), ACCOUNT_NAME_LOOKUP_DEADLINE_MS);
      deadline.unref();
    });
    const normalized = normalizeShareDiscussionDisplayName(
      await Promise.race([lookup, deadlineResult]),
    );
    return normalized.ok ? normalized.value : null;
  } catch {
    return null;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

export function chatMentionBodies(
  ops: readonly { opKind: string; payloadJson: string }[],
): string[] {
  const bodies: string[] = [];
  for (const op of ops) {
    if (op.opKind !== "chat.message.append") continue;
    try {
      const body = (JSON.parse(op.payloadJson) as { body?: unknown }).body;
      if (typeof body === "string" && chatMentionTokens(body).length > 0) bodies.push(body);
    } catch {}
  }
  return bodies;
}

export async function readAccountDisplayNames(
  userIds: readonly string[],
  options: {
    lookupUserDisplayNames?: LookupUserDisplayNames;
    lookupUserDisplayName?: LookupUserDisplayName;
    deadlineMs?: number;
    beginLookup?: () => AccountNameLookupToken;
    onResolved?: (names: ReadonlyMap<string, string | null>, generation?: number) => void;
  },
): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds)];
  const results = new Map<string, string | null>();
  if (unique.length === 0 || (!options.lookupUserDisplayNames && !options.lookupUserDisplayName))
    return results;
  const deadlineMs = options.deadlineMs ?? ACCOUNT_NAME_LOOKUP_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<typeof LOOKUP_TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(LOOKUP_TIMEOUT);
    }, deadlineMs);
    timer.unref();
  });
  try {
    if (options.lookupUserDisplayNames) {
      for (let start = 0; start < unique.length && !expired; start += ACCOUNT_NAME_BATCH_SIZE) {
        const batch = unique.slice(start, start + ACCOUNT_NAME_BATCH_SIZE);
        const token = options.beginLookup?.();
        try {
          let found: ReadonlyMap<string, string | null> | typeof LOOKUP_TIMEOUT;
          try {
            const query = Promise.resolve().then(() => options.lookupUserDisplayNames!(batch));
            query.catch(() => {});
            found = await Promise.race([query, deadline]);
          } catch {
            break;
          }
          if (found === LOOKUP_TIMEOUT) break;
          const resolved = new Map<string, string | null>();
          for (const [userId, name] of found) {
            const normalized = normalizeShareDiscussionDisplayName(name);
            const value = normalized.ok ? normalized.value : null;
            results.set(userId, value);
            resolved.set(userId, value);
          }
          if (resolved.size > 0) options.onResolved?.(resolved, token?.generation);
        } finally {
          token?.finish();
        }
      }
      return results;
    }
    const lookup = options.lookupUserDisplayName!;
    let next = 0;
    const worker = async () => {
      while (!expired && next < unique.length) {
        const userId = unique[next++]!;
        const token = options.beginLookup?.();
        try {
          const query = Promise.resolve().then(() => lookup(userId));
          query.catch(() => {});
          const raw = await Promise.race([query, deadline]);
          if (raw === LOOKUP_TIMEOUT) return;
          const normalized = normalizeShareDiscussionDisplayName(raw);
          const value = normalized.ok ? normalized.value : null;
          results.set(userId, value);
          options.onResolved?.(new Map([[userId, value]]), token?.generation);
        } catch {
        } finally {
          token?.finish();
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SINGLE_LOOKUP_CONCURRENCY, unique.length) }, worker),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  return results;
}

export function createMentionAccountNameRefresher(options: {
  storage: Pick<
    SyncRelayStorage,
    "beginAccountNameLookup" | "workspaceAccountIds" | "recordAccountNames"
  >;
  lookupUserDisplayNames?: LookupUserDisplayNames;
  lookupUserDisplayName?: LookupUserDisplayName;
  nowMs?: () => number;
}): RefreshMentionAccountNames | undefined {
  if (!options.lookupUserDisplayNames && !options.lookupUserDisplayName) return undefined;
  const nowMs = options.nowMs ?? Date.now;
  return async (workspaceId, bodies) => {
    if (!bodies.some((body) => chatMentionTokens(body).length > 0)) return;
    try {
      const userIds = options.storage.workspaceAccountIds(
        workspaceId,
        WORKSPACE_MENTION_ACCOUNT_LIMIT,
      );
      if (userIds.length === 0) return;
      await readAccountDisplayNames(userIds, {
        ...options,
        beginLookup: () => options.storage.beginAccountNameLookup(),
        onResolved: (names, generation) =>
          options.storage.recordAccountNames(names, nowMs(), generation),
      });
    } catch {}
  };
}

export async function backfillUnnamedAccounts(options: {
  storage: Pick<
    SyncRelayStorage,
    "beginAccountNameLookup" | "unnamedAccountIds" | "recordAccountNames" | "unavailable"
  >;
  lookupUserDisplayNames: LookupUserDisplayNames;
  nowMs?: () => number;
  batchSize?: number;
  maxAccounts?: number;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}): Promise<number> {
  const nowMs = options.nowMs ?? Date.now;
  const batchSize = options.batchSize ?? ACCOUNT_NAME_BATCH_SIZE;
  const maxAccounts = options.maxAccounts ?? BACKFILL_MAX_ACCOUNTS;
  let cursor = "";
  let scanned = 0;
  try {
    while (
      scanned < maxAccounts &&
      !options.signal?.aborted &&
      !options.storage.unavailable.aborted
    ) {
      const limit = Math.min(batchSize, maxAccounts - scanned);
      const userIds = options.storage.unnamedAccountIds(limit, cursor);
      if (userIds.length === 0) break;
      cursor = userIds[userIds.length - 1]!;
      scanned += userIds.length;
      const token = options.storage.beginAccountNameLookup();
      try {
        const names = await options.lookupUserDisplayNames(userIds);
        if (options.signal?.aborted || options.storage.unavailable.aborted) break;
        if (names.size > 0) options.storage.recordAccountNames(names, nowMs(), token.generation);
      } finally {
        token.finish();
      }
      if (userIds.length < limit) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    if (!options.signal?.aborted) options.onError?.(error);
  }
  return scanned;
}
