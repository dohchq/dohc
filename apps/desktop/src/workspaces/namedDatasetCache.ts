import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const savedPage = z.object({ key: digest, value: z.unknown(), savedAtMs: z.number().int().nonnegative() }).strict();
const savedScope = z.object({ key: digest, localAuthority: digest, fingerprint: digest, pages: z.array(savedPage).max(512) }).strict();
const savedFile = z.object({ version: z.literal(1), owner: digest, scopes: z.array(savedScope).max(128) }).strict();
type Saved = z.infer<typeof savedFile>;
type Scope = Saved["scopes"][number];
type Page = Scope["pages"][number];
export type NamedDatasetPageCache = {
  begin(): Promise<number>;
  accept(fingerprint: string, epoch: number): Promise<void>;
  read(key: unknown): Promise<z.infer<typeof savedPage> | null>;
  put(key: unknown, value: unknown, fingerprint: string): Promise<number | null>;
  clear(): Promise<void>;
};

/** Recipient responses only. This file never contains a database, executable rules, or owner history. */
export function createNamedDatasetCacheRegistry(options: { directory(): string; maxBytes?: number; nowMs?: () => number }) {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const nowMs = options.nowMs ?? Date.now;
  let owner: string | null = null, state: Saved | null = null, loaded = false, closed = false, closing = false;
  let pending: Promise<unknown> = Promise.resolve();
  let durable: Saved | null = null, dirty = false, saving: Promise<void> | null = null;
  const sizes = new WeakMap<object, number>();
  const pageIds = new WeakMap<Page, number>();
  let nextPageId = 0;
  const pageBytes = (page: Page) => {
    let bytes = sizes.get(page);
    if (bytes === undefined) { bytes = Buffer.byteLength(JSON.stringify(page)); sizes.set(page, bytes); }
    return bytes;
  };
  const scopeBytes = (scope: Scope) => {
    let bytes = sizes.get(scope);
    if (bytes === undefined) {
      bytes = Buffer.byteLength(JSON.stringify({ ...scope, pages: [] })) +
        scope.pages.reduce((total, page) => total + pageBytes(page), 0) + Math.max(0, scope.pages.length - 1);
      sizes.set(scope, bytes);
    }
    return bytes;
  };
  const stateBytes = () => state ? Buffer.byteLength(JSON.stringify({ ...state, scopes: [] })) +
    state.scopes.reduce((total, scope) => total + scopeBytes(scope), 0) + Math.max(0, state.scopes.length - 1) : 0;
  const replaceScope = (key: string, scope?: Scope) => {
    if (state) state = { ...state, scopes: state.scopes.filter(value => value.key !== key).concat(scope ? [scope] : []) };
  };
  function trim() {
    let bytes = stateBytes();
    if (bytes <= maxBytes || !state) return;
    const oldest = state.scopes.flatMap(scope => scope.pages.map(page => ({ scope, page })))
      .sort((a, b) => a.page.savedAtMs - b.page.savedAtMs);
    const removed = new Map<Scope, Set<Page>>();
    for (const { scope, page } of oldest) {
      if (bytes <= maxBytes) break;
      const pages = removed.get(scope) ?? new Set<Page>();
      bytes -= pageBytes(page) + (scope.pages.length - pages.size > 1 ? 1 : 0);
      pages.add(page);
      removed.set(scope, pages);
    }
    for (const [scope, pages] of removed) replaceScope(scope.key, { ...scope, pages: scope.pages.filter(page => !pages.has(page)) });
    // Metadata alone can exceed a deliberately small quota. Never write past the bound.
    while (state.scopes.length && bytes > maxBytes) {
      const selected = state.scopes[0]!;
      bytes -= scopeBytes(selected) + (state.scopes.length > 1 ? 1 : 0);
      replaceScope(selected.key);
    }
  }
  const epochs = new Map<string, number>();
  const enqueue = <T>(work: () => Promise<T>) => { const result = pending.then(work, work); pending = result.catch(() => undefined); return result; };
  const path = async () => {
    const directory = resolve(options.directory());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(directory)) !== directory) throw Error("Saved Collection pages must remain in this device's profile.");
    // The queue owns all writes. A matching temporary file is left by an interrupted prior process.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (/^pages\.json\.[0-9a-f-]{36}$/.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw Error("Saved Collection page storage changed. Reconnect to the sharing server.");
        await rm(join(directory, entry.name));
      }
    }
    return join(directory, "pages.json");
  };
  async function persist(snapshot: Saved | null) {
    const target = await path();
    if (!snapshot || !snapshot.scopes.length) { await rm(target, { force: true }); return; }
    const temporary = `${target}.${randomUUID()}`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(snapshot)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  // New pages coalesce into the next write instead of retaining one snapshot per queued save.
  function flush() {
    dirty = true;
    saving ??= (async () => {
      try {
        while (dirty) {
          dirty = false;
          const snapshot = state;
          try {
            await persist(snapshot);
            durable = snapshot;
          } catch (error) {
            // A failed older save must not discard a queued revocation or account purge.
            if (!dirty) throw error;
          }
        }
      } finally { saving = null; }
    })();
    return saving;
  }
  async function load() {
    if (loaded) return;
    const target = await path(), info = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw Error("Saved Collection pages are unavailable. Reconnect to the sharing server.");
      try { if (info.size <= maxBytes) state = savedFile.parse(JSON.parse(await readFile(target, "utf8"))); } catch { state = null; }
      if (!state || state.owner !== owner) { state = null; await rm(target, { force: true }); }
    }
    durable = state;
    loaded = true;
  }
  return {
    credentialsChanged(next: string | null) {
      if (closing) return Promise.reject(Error("Saved Collection pages are closing."));
      if (owner === next && (next !== null || loaded)) return pending.then(() => undefined);
      const hadOwner = owner !== null;
      owner = next;
      for (const key of epochs.keys()) epochs.set(key, epochs.get(key)! + 1);
      return enqueue(async () => {
        if (hadOwner || loaded || next === null) { state = null; loaded = true; await flush(); }
      });
    },
    scope(input: { owner: string; binding: unknown; localAuthority?: unknown; assertCurrent(): void }): NamedDatasetPageCache {
      const key = hash(input.binding), localAuthority = hash(input.localAuthority ?? null);
      const current = () => { input.assertCurrent(); if (closed || owner !== input.owner) throw Error("Your server account changed. Reopen the shared workspace."); };
      const run = <T>(work: () => Promise<T>) => closing ? Promise.reject<T>(Error("Saved Collection pages are closing.")) : enqueue(async () => {
        current(); await load(); current();
        if (scope() && scope()!.localAuthority !== localAuthority) {
          epochs.set(key, epoch() + 1);
          replaceScope(key);
          await flush();
        }
        const result = await work(); current(); return result;
      });
      const epoch = () => epochs.get(key) ?? 0;
      const scope = () => state?.scopes.find(value => value.key === key);
      return {
        begin: () => run(async () => epoch()),
        accept: (fingerprint, started) => run(async () => {
          digest.parse(fingerprint);
          const existing = scope();
          if (existing?.fingerprint === fingerprint) return;
          if (started !== epoch()) throw Error("Collection access changed while loading. Refresh this view.");
          epochs.set(key, epoch() + 1);
          state ??= { version: 1, owner: input.owner, scopes: [] };
          replaceScope(key);
          if (state.scopes.length === 128) state = { ...state, scopes: state.scopes.slice(1) };
          replaceScope(key, { key, localAuthority, fingerprint, pages: [] });
          trim();
          await flush();
        }),
        read: request => run(async () => {
          const saved = durable?.scopes.find(value => value.key === key && value.localAuthority === localAuthority && value.fingerprint === scope()?.fingerprint);
          const entry = saved?.pages.find(page => page.key === hash(request));
          return entry ? structuredClone(entry) : null;
        }),
        put: (request, value, fingerprint) => {
          const started = epoch();
          return run(async () => {
            const selected = scope();
            if (!selected || selected.fingerprint !== fingerprint || started !== epoch()) throw Error("Collection access changed while saving. Refresh this view.");
            const page = { key: hash(request), value: structuredClone(value), savedAtMs: nowMs() };
            if (pageBytes(page) > maxBytes / 2) return null;
            const pages = selected.pages.filter(value => value.key !== page.key).concat(page).slice(-512);
            replaceScope(key, { ...selected, pages });
            trim();
            const pageId = ++nextPageId;
            pageIds.set(page, pageId);
            return { pageKey: page.key, pageId, savedAtMs: page.savedAtMs, saved: flush() };
          }).then(async result => {
            if (!result) return null;
            await result.saved;
            current();
            const saved = durable?.scopes.find(value => value.key === key && value.fingerprint === fingerprint);
            const page = saved?.pages.find(page => page.key === result.pageKey);
            return started === epoch() && page && pageIds.get(page) === result.pageId ? result.savedAtMs : null;
          });
        },
        clear: () => run(async () => {
          epochs.set(key, epoch() + 1);
          replaceScope(key);
          await flush();
        }),
      };
    },
    async close() { closing = true; await pending; if (saving) await saving; closed = true; },
  };
}
