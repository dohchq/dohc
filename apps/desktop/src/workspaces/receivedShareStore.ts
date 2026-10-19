import { join } from "node:path";
import { z } from "zod";
import { isShareablePath, isValidShareVersionId } from "@dohc/security-contract/share-selector";
import { observationKey, readObservationFile, removeObservationFile, writeObservationFile } from "./shareObservationFile";

const Id = z.string().min(1).max(256);
const Timestamp = z.number().int().nonnegative();
const Paths = z.array(z.string().refine(isShareablePath)).max(100);
const Selector = z.union([
  z.object({ kind: z.never().optional(), paths: Paths, versionId: z.string().refine(isValidShareVersionId).nullable() })
    .refine(value => value.paths.length > 0 || value.versionId !== null),
  z.object({ kind: z.literal("group"), channelWireId: Id, paths: Paths.min(1), versionId: z.null() }),
  z.object({ kind: z.literal("chat"), channelWireId: Id }),
]);
const Base = {
  shareId: Id, grantId: Id, granterUserId: Id,
  granterEmail: z.string().max(320).nullable(),
  subjectName: z.string().max(320).nullable().optional(),
  sharerName: z.string().max(320).nullable().optional(),
  generation: z.number().int().positive(), createdAtMs: Timestamp,
  genericChatWritable: z.boolean(),
  fileScope: z.enum(["served", "not-served"]).optional(),
};
const Row = z.union([
  z.object({ ...Base, selector: Selector, access: z.enum(["view", "comment", "edit", "read-only", "read-write"]), damaged: z.never().optional() })
    .refine(row => row.selector.kind === undefined
      ? ["view", "comment", "edit"].includes(row.access)
      : ["read-only", "read-write"].includes(row.access))
    .refine(row => row.selector.kind !== "group" || row.fileScope !== undefined),
  z.object({ ...Base, selector: z.null(), access: z.string().max(64), damaged: z.literal(true) }),
]);
const Removed = z.object({ shareId: Id, grantId: Id, removedAtMs: Timestamp, message: z.string().min(1).max(500) });
const Inventory = z.object({ received: z.array(Row).max(50_000), removed: z.array(Removed).max(50_000) });
const InventoryPage = z.object({ ok: z.literal(true), received: z.array(Row).max(1_000), removed: z.array(Removed).max(1_000),
  nextCursor: z.string().min(1).max(1_024).optional() });
const Persisted = Inventory.extend({ listedAtMs: Timestamp });
export type ReceivedInventory = z.infer<typeof Inventory>;
export type ReceivedScope = { userId: string; relayUrl: string; generation: number };
export type ReceivedObservation = {
  inventory: ReceivedInventory | null; checkedAtMs: number | null; freshness: "fresh" | "stale" | "unknown";
};

export function parseReceivedInventory(body: unknown): ReceivedInventory | null {
  // An unfinished page is not an account inventory.
  if (body === null || typeof body !== "object" || "nextCursor" in body || ("ok" in body && body.ok !== true)) return null;
  const parsed = Inventory.safeParse(body);
  if (!parsed.success) return null;
  const ids = parsed.data.received.map(row => row.shareId);
  if (new Set(ids).size !== ids.length) return null;
  return {
    received: parsed.data.received.sort((a, b) => a.shareId < b.shareId ? -1 : a.shareId > b.shareId ? 1 : 0),
    removed: parsed.data.removed.sort((a, b) => a.shareId < b.shareId ? -1 : a.shareId > b.shareId ? 1 : 0),
  };
}

/** Publish only a complete account acquisition. Page cursors describe an interval, not a snapshot. */
export async function listReceivedInventory(get: (path: string) => Promise<unknown>, assertCurrent: () => void): Promise<ReceivedInventory> {
  const received: ReceivedInventory["received"] = [], removed: ReceivedInventory["removed"] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let lastShareId = "";
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    assertCurrent();
    const page = InventoryPage.parse(await get(`/sync/shares?received=true${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`));
    assertCurrent();
    const ids = [...page.received, ...page.removed].map(row => row.shareId).sort();
    for (const id of ids) {
      if (id <= lastShareId) throw new Error("Received share pages are inconsistent.");
      lastShareId = id;
    }
    received.push(...page.received); removed.push(...page.removed);
    if (received.length + removed.length > 50_000) throw new Error("Received share inventory exceeds its limit.");
    if (page.nextCursor === undefined) {
      const inventory = parseReceivedInventory({ received, removed });
      if (!inventory) throw new Error("Received share inventory is unusable.");
      return inventory;
    }
    if (cursors.has(page.nextCursor)) throw new Error("Received share cursor repeated.");
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new Error("Received share inventory did not finish.");
}

export function createReceivedShareStore(directory: string) {
  const file = (scope: ReceivedScope) => join(directory, `${observationKey([scope.userId, scope.relayUrl])}.json`);
  const cache = new Map<string, { inventory: ReceivedInventory; listedAtMs: number } | null>();
  function read(scope: ReceivedScope): { inventory: ReceivedInventory; listedAtMs: number } | null {
    const path = file(scope);
    if (cache.has(path)) return cache.get(path) ?? null;
    const parsed = Persisted.safeParse(readObservationFile(path));
    const inventory = parsed.success ? parseReceivedInventory(parsed.data) : null;
    const saved = inventory && parsed.success ? { inventory, listedAtMs: parsed.data.listedAtMs } : null;
    cache.set(path, saved);
    return saved;
  }
  return {
    file,
    read,
    save(scope: ReceivedScope, inventory: ReceivedInventory, listedAtMs: number): void {
      const previous = read(scope);
      if (previous && JSON.stringify(previous.inventory) === JSON.stringify(inventory)) return;
      try { writeObservationFile(file(scope), { ...inventory, listedAtMs }); } catch (error) { cache.delete(file(scope)); throw error; }
      cache.set(file(scope), { inventory, listedAtMs });
    },
    remove(scope: ReceivedScope): void { removeObservationFile(file(scope)); cache.delete(file(scope)); },
  };
}

/** One live acquisition feeds storage and reconciliation; cached observations never call onLive. */
export function createReceivedShareAcquisition(dependencies: {
  store: ReturnType<typeof createReceivedShareStore>;
  scope(): ReceivedScope | null;
  list(scope: ReceivedScope): Promise<unknown>;
  onLive(inventory: ReceivedInventory, scope: ReceivedScope, isCurrent: () => boolean): Promise<void>;
  logError(error: unknown): void;
  nowMs?: () => number;
  wallNowMs?: () => number;
}) {
  const nowMs = dependencies.nowMs ?? (() => performance.now());
  const wallNowMs = dependencies.wallNowMs ?? Date.now;
  let pending: { scope: ReceivedScope; token: symbol; promise: Promise<void> } | null = null;
  let attempt: { scope: ReceivedScope; atMs: number } | null = null;
  let live: { scope: ReceivedScope; inventory: ReceivedInventory; checkedAtMs: number; invalidation: number } | null = null;
  let invalidation = 0;
  let failed = false;
  let lifetime = 0;
  let credentialScope = dependencies.scope();
  const same = (a: ReceivedScope | null, b: ReceivedScope) =>
    a?.userId === b.userId && a.relayUrl === b.relayUrl && a.generation === b.generation;

  function retire(): void { lifetime += 1; live = null; attempt = null; pending = null; failed = false; }
  return {
    invalidate(): void { invalidation += 1; },
    retire,
    credentialsChanged(current: ReceivedScope | null, settled = true): void {
      retire();
      if (!settled) return;
      const previous = credentialScope;
      credentialScope = current;
      if (!previous || previous.userId === current?.userId && previous.relayUrl === current.relayUrl) return;
      try { dependencies.store.remove(previous); } catch (error) { dependencies.logError(error); }
    },
    observation(): ReceivedObservation {
      const scope = dependencies.scope();
      if (!scope) return { inventory: null, checkedAtMs: null, freshness: "unknown" };
      if (live && same(scope, live.scope)) {
        const age = wallNowMs() - live.checkedAtMs;
        return { inventory: live.inventory, checkedAtMs: live.checkedAtMs,
          freshness: failed || live.invalidation !== invalidation || age < 0 || age >= 600_000 ? "stale" : "fresh" };
      }
      const saved = dependencies.store.read(scope);
      return { inventory: saved?.inventory ?? null, checkedAtMs: saved?.listedAtMs ?? null,
        freshness: saved ? "stale" : "unknown" };
    },
    refresh(): Promise<import("@dohc/workspace-contracts/access").AccessRefreshResult["status"]> {
      const scope = dependencies.scope();
      if (!scope) return Promise.resolve("unavailable");
      if (pending && same(scope, pending.scope)) return pending.promise.then(() => "joined");
      if (attempt && same(scope, attempt.scope) && nowMs() - attempt.atMs < 60_000) return Promise.resolve("paced");
      attempt = { scope, atMs: nowMs() };
      const checkedAtMs = wallNowMs();
      const capturedInvalidation = invalidation;
      const capturedLifetime = lifetime;
      const isCurrent = () => capturedLifetime === lifetime && same(dependencies.scope(), scope);
      const token = Symbol("received acquisition");
      const promise = (async () => {
        try {
          const body = await dependencies.list(scope);
          if (!isCurrent()) return;
          const inventory = parseReceivedInventory(body);
          if (!inventory) { failed = true; return; }
          live = { scope, inventory, checkedAtMs, invalidation: capturedInvalidation };
          failed = false;
          try { dependencies.store.save(scope, inventory, checkedAtMs); } catch (error) { dependencies.logError(error); }
          // A local mutation supersedes the listing for reconciliation as well as freshness.
          if (capturedInvalidation === invalidation) {
            await dependencies.onLive(inventory, scope, () => isCurrent() && capturedInvalidation === invalidation);
          }
        } catch (error) {
          if (isCurrent()) { failed = true; dependencies.logError(error); }
        } finally {
          if (pending?.token === token) pending = null;
        }
      })();
      pending = { scope, token, promise };
      return promise.then(() => "requested");
    },
  };
}
